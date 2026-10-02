'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const APP_NAME = 'MonitorInfantil';

const DEFAULTS = {
  // Servidores DNS "de verdade" para onde as consultas são repassadas.
  upstreamDns: ['1.1.1.1', '8.8.8.8'],
  // Consulta o filtro familiar da Cloudflare (1.1.1.3 / 1.1.1.2) para descobrir
  // se um domínio desconhecido é adulto ou malicioso.
  onlineCheck: true,
  // Bloqueia automaticamente domínios classificados como adulto/apostas/perigoso.
  autoBlockAlerts: true,
  // Bloqueia redes de anúncios/rastreamento — barra anúncios em apps, jogos e
  // sites (inclusive banners impróprios que aparecem em jogos "grátis").
  blockAds: true,
  // Força Pesquisa Segura no Google/Bing e Modo Restrito no YouTube via DNS.
  forceSafeSearch: true,
  // Palavras que, se aparecerem no nome do site, disparam bloqueio (ex.: "porn").
  blockKeywords: ['porn', 'xxx', 'sexo', 'hentai', 'onlyfans'],
  // Dias de histórico mantidos no banco.
  retentionDays: 30,
  dnsPort: 53,
  webPort: 8484,
};

function dataDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  const dir = path.join(base, APP_NAME);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function parseArgs(argv) {
  const args = { openBrowser: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dns-port') args.dnsPort = Number(argv[++i]);
    else if (a === '--web-port') args.webPort = Number(argv[++i]);
    else if (a === '--data-dir') args.dataDir = argv[++i];
    else if (a === '--no-browser') args.openBrowser = false;
    else if (a === '--victim-ip') args.victimIp = argv[++i];
    else if (a === '--gateway-ip') args.gatewayIp = argv[++i];
  }
  return args;
}

class Config {
  constructor(dir) {
    this.file = path.join(dir, 'config.json');
    this.values = { ...DEFAULTS };
    try {
      Object.assign(this.values, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      // Primeira execução ou arquivo corrompido: fica com os padrões.
    }
  }

  get(key) {
    return this.values[key];
  }

  all() {
    return { ...this.values };
  }

  /** Aplica apenas campos conhecidos e válidos; retorna o estado final. */
  update(patch) {
    const v = this.values;
    if (Array.isArray(patch.upstreamDns)) {
      const ips = patch.upstreamDns.map(String).map((s) => s.trim()).filter(isIPv4);
      if (ips.length) v.upstreamDns = ips;
    }
    if (typeof patch.onlineCheck === 'boolean') v.onlineCheck = patch.onlineCheck;
    if (typeof patch.autoBlockAlerts === 'boolean') v.autoBlockAlerts = patch.autoBlockAlerts;
    if (typeof patch.blockAds === 'boolean') v.blockAds = patch.blockAds;
    if (typeof patch.forceSafeSearch === 'boolean') v.forceSafeSearch = patch.forceSafeSearch;
    if (Array.isArray(patch.blockKeywords)) {
      const seen = new Set();
      v.blockKeywords = patch.blockKeywords
        .map((s) => String(s).trim().toLowerCase())
        .filter((s) => s.length >= 2 && s.length <= 40 && !seen.has(s) && seen.add(s))
        .slice(0, 200);
    }
    if (Number.isInteger(patch.retentionDays) && patch.retentionDays >= 1 && patch.retentionDays <= 365) {
      v.retentionDays = patch.retentionDays;
    }
    fs.writeFileSync(this.file, JSON.stringify(v, null, 2));
    return this.all();
  }
}

function isIPv4(s) {
  const parts = s.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

module.exports = { Config, dataDir, parseArgs, isIPv4, APP_NAME };
