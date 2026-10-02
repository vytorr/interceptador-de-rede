'use strict';

const { classify, isIgnored } = require('../classify/classifier');
const { decideBlock } = require('../block');

// Celulares abrem dezenas de conexões para o mesmo site em segundos (imagens,
// APIs, CDNs). Registramos no máximo uma linha por (aparelho, site) nesta janela.
const DEDUPE_WINDOW_MS = 5000;

/**
 * Recebe eventos de SNI do sniffer, classifica o site e grava no banco —
 * a mesma estrutura usada pelo DNS, então painel, alertas e verificação
 * online continuam funcionando sem mudanças.
 */
class SNICollector {
  constructor({ store, config, probeQueue, onBlock = null }) {
    this.store = store;
    this.config = config;
    this.probeQueue = probeQueue;
    this.onBlock = onBlock; // chamado quando um acesso deve ser cortado (motor de bloqueio)
    this.recent = new Map();
    this.stats = { received: 0, logged: 0, blockedHits: 0, lastAt: null, lastFrom: null };
    this._timer = setInterval(() => this._cleanup(), 60_000).unref();
  }

  handle({ srcIp, sni, dstIp = null }) {
    this.stats.received++;
    this.stats.lastAt = Date.now();
    this.stats.lastFrom = srcIp;

    if (process.env.MONITOR_DEBUG) {
      const ver = srcIp && srcIp.includes(':') ? 'v6' : 'v4';
      const ign = isIgnored(sni) ? ' [IGNORADO]' : '';
      console.log(`  [sni-debug ${ver}] ${srcIp} -> ${sni} (dst ${dstIp || '?'})${ign}`);
    }

    if (isIgnored(sni)) return;

    const now = Date.now();
    const { site, category, source } = classify(sni);
    const row = this.store.ensureSite(site, category, source);
    if (row.category === 'desconhecido' && this.probeQueue && this.config.get('onlineCheck')) {
      this.probeQueue.push(site);
    }

    const key = `${srcIp}|${site}`;
    const last = this.recent.get(key);
    if (last && now - last < DEDUPE_WINDOW_MS) return;
    this.recent.set(key, now);

    // Decide o bloqueio (manual, categoria ou palavra-chave). O corte efetivo
    // da conexão depende do motor de bloqueio (WinDivert); aqui registramos a
    // decisão para o painel e para o motor agir.
    const decision = decideBlock({ name: sni, siteRow: row }, this.config);
    if (decision.blocked) this.stats.blockedHits++;

    this.store.logQuery({ ts: now, clientIp: srcIp, domain: sni, site, qtype: 'HTTPS', blocked: decision.blocked });
    this.stats.logged++;

    if (decision.blocked && this.onBlock) this.onBlock({ srcIp, sni, site, dstIp, ...decision });
  }

  _cleanup() {
    const now = Date.now();
    for (const [k, t] of this.recent) if (now - t > DEDUPE_WINDOW_MS) this.recent.delete(k);
  }

  stop() {
    clearInterval(this._timer);
  }
}

module.exports = { SNICollector };
