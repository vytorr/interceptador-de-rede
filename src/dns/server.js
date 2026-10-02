'use strict';

const dgram = require('node:dgram');
const { parseQuery, buildBlockedResponse, buildIpResponse, buildNxdomainResponse, buildServfail } = require('./packet');
const { udpExchange } = require('./udp');
const { classify, isIgnored } = require('../classify/classifier');
const { decideBlock } = require('../block');

const DOH_CANARY_DOMAINS = new Set([
  'use-application-dns.net',
  'mask.icloud.com',
  'mask-h2.icloud.com',
  'mask-api.icloud.com',
]);

const DOH_DOT_BOOTSTRAP_DOMAINS = new Set([
  'dns.google',
  'dns64.dns.google',
  'cloudflare-dns.com',
  '1dot1dot1dot1.cloudflare-dns.com',
  'one.one.one.one',
  'dns.quad9.net',
  'doh.cleanbrowsing.org',
  'doh.opendns.com',
  'dns.adguard.com',
]);

const GOOGLE_RE = /^(?:www\.)?google\.(?:com|com\.br|net|org|co\.[a-z]{2}|[a-z]{2})$/i;
const YOUTUBE_DOMAINS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtubei.googleapis.com',
  'youtube.googleapis.com',
  'www.youtube-nocookie.com',
]);
const BING_DOMAINS = new Set(['bing.com', 'www.bing.com']);
const DUCK_DOMAINS = new Set(['duckduckgo.com', 'www.duckduckgo.com']);

const GOOGLE_SAFE_IPV4 = '216.239.38.120';
const GOOGLE_SAFE_IPV6 = Buffer.from([0x20, 0x01, 0x48, 0x60, 0x48, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x78]);
const BING_SAFE_IPV4 = '204.79.197.220';
const DUCK_SAFE_IPV4 = '52.142.124.215';

function getSafeSearchTarget(domain) {
  const d = domain.toLowerCase();
  if (YOUTUBE_DOMAINS.has(d) || GOOGLE_RE.test(d)) {
    return { ipv4: GOOGLE_SAFE_IPV4, ipv6: GOOGLE_SAFE_IPV6 };
  }
  if (BING_DOMAINS.has(d)) {
    return { ipv4: BING_SAFE_IPV4 };
  }
  if (DUCK_DOMAINS.has(d)) {
    return { ipv4: DUCK_SAFE_IPV4 };
  }
  return null;
}

const UPSTREAM_TIMEOUT_MS = 2000;
// Celulares pedem A, AAAA e HTTPS para o mesmo nome quase ao mesmo tempo;
// registramos só a primeira dessas consultas dentro desta janela.
const DEDUPE_WINDOW_MS = 3000;
// Após uma falha na verificação online, espera antes de tentar o mesmo site.
const PROBE_RETRY_MS = 10 * 60_000;

class DnsServer {
  /**
   * @param {object} opts
   * @param {import('../db').Store} opts.store
   * @param {import('../config').Config} opts.config
   * @param {import('../classify/familyFilter').ProbeQueue} [opts.probeQueue]
   * @param {Function} [opts.exchange] troca de mensagens com o upstream (injetável para testes)
   */
  constructor({ store, config, probeQueue, exchange = udpExchange }) {
    this.store = store;
    this.config = config;
    this.probeQueue = probeQueue;
    this.exchange = exchange;
    this.socket = null;
    this.recentKeys = new Map();
    this.probeAttempts = new Map();
    this.cache = new Map(); // cacheKey -> { response, expiresAt }
    this.stats = { startedAt: null, received: 0, queries: 0, blocked: 0, upstreamFailures: 0, lastQueryAt: null, lastFrom: null };
  }

  start(port, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      sock.once('error', reject);
      sock.on('message', (msg, rinfo) => {
        // Contamos todo pacote que chega fisicamente na porta 53, antes de
        // qualquer análise, para diagnosticar se o aparelho está mesmo nos usando.
        this.stats.received++;
        this.stats.lastFrom = rinfo.address;
        this.handle(msg, rinfo).catch((err) => console.error('[dns] erro inesperado:', err));
      });
      sock.bind(port, host, () => {
        sock.off('error', reject);
        sock.on('error', (err) => console.error('[dns] erro no socket:', err.message));
        this.socket = sock;
        this.stats.startedAt = Date.now();
        this._cleanupTimer = setInterval(() => this._cleanup(), 60_000).unref();
        resolve(sock.address());
      });
    });
  }

  stop() {
    clearInterval(this._cleanupTimer);
    return new Promise((resolve) => (this.socket ? this.socket.close(resolve) : resolve()));
  }

  async handle(msg, rinfo) {
    let q;
    try {
      q = parseQuery(msg);
    } catch {
      return; // pacote inválido: ignora
    }
    const reply = (buf) => this.socket.send(buf, rinfo.port, rinfo.address);

    if (DOH_CANARY_DOMAINS.has(q.name)) {
      return reply(buildNxdomainResponse(msg, q));
    }
    if (DOH_DOT_BOOTSTRAP_DOMAINS.has(q.name)) {
      return reply(buildBlockedResponse(msg, q));
    }

    if (isIgnored(q.name)) {
      return reply(await this.forward(msg, q));
    }

    const now = Date.now();
    const { site, category, source } = classify(q.name);
    const row = this.store.ensureSite(site, category, source);
    if (row.category === 'desconhecido') this._maybeProbe(site, now);

    const blocked = decideBlock({ name: q.name, siteRow: row }, this.config).blocked;

    const key = `${rinfo.address}|${q.name}|${blocked}`;
    const last = this.recentKeys.get(key);
    if (!last || now - last > DEDUPE_WINDOW_MS) {
      this.recentKeys.set(key, now);
      this.store.logQuery({ ts: now, clientIp: rinfo.address, domain: q.name, site, qtype: q.qtype, blocked });
    }
    this.stats.queries++;
    this.stats.lastQueryAt = now;

    if (blocked) {
      this.stats.blocked++;
      return reply(buildBlockedResponse(msg, q));
    }

    if (this.config.get('forceSafeSearch')) {
      const safe = getSafeSearchTarget(q.name);
      if (safe) {
        return reply(buildIpResponse(msg, q, safe.ipv4, safe.ipv6));
      }
    }

    return reply(await this.forward(msg, q));
  }

  /** Repassa a consulta para os servidores configurados, em ordem. */
  async forward(msg, q) {
    const cacheKey = `${q.name}|${q.qtypeNum}`;
    const cached = this.cache.get(cacheKey);
    const now = Date.now();
    if (cached && now < cached.expiresAt) {
      const res = Buffer.from(cached.response);
      res.writeUInt16BE(q.id, 0); // replica o ID da pergunta atual
      return res;
    }

    for (const server of this.config.get('upstreamDns')) {
      try {
        const res = await this.exchange(server, msg, q.id, UPSTREAM_TIMEOUT_MS);
        if (res && res.length >= 12) {
          this.cache.set(cacheKey, { response: res, expiresAt: now + 30_000 }); // cache de 30s
        }
        return res;
      } catch {
        // tenta o próximo
      }
    }
    this.stats.upstreamFailures++;
    return buildServfail(msg, q);
  }

  _maybeProbe(site, now) {
    if (!this.probeQueue || !this.config.get('onlineCheck')) return;
    const last = this.probeAttempts.get(site);
    if (last && now - last < PROBE_RETRY_MS) return;
    this.probeAttempts.set(site, now);
    this.probeQueue.push(site);
  }

  _cleanup() {
    const now = Date.now();
    for (const [k, t] of this.recentKeys) if (now - t > DEDUPE_WINDOW_MS) this.recentKeys.delete(k);
    for (const [k, t] of this.probeAttempts) if (now - t > PROBE_RETRY_MS) this.probeAttempts.delete(k);
  }
}

module.exports = { DnsServer };
