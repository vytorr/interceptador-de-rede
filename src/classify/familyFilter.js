'use strict';

// Descobre se um domínio desconhecido é adulto ou malicioso perguntando aos
// resolvedores públicos da Cloudflare:
//   1.1.1.3 bloqueia malware + conteúdo adulto
//   1.1.1.2 bloqueia só malware
// Um domínio bloqueado recebe 0.0.0.0 como resposta.

const { buildQuery, parseResponse } = require('../dns/packet');
const { udpExchange } = require('../dns/udp');

const FAMILY = '1.1.1.3';
const MALWARE_ONLY = '1.1.1.2';

async function isBlockedBy(server, domain) {
  const id = Math.floor(Math.random() * 0xffff);
  const res = parseResponse(await udpExchange(server, buildQuery(domain, 1, id), id));
  return res.answers.some((a) => a.type === 1 && a.data.length === 4 && a.data.readUInt32BE(0) === 0);
}

/** @returns {Promise<'adulto'|'perigoso'|'outros'>} rejeita em caso de falha de rede. */
async function probe(domain) {
  if (!(await isBlockedBy(FAMILY, domain))) return 'outros';
  return (await isBlockedBy(MALWARE_ONLY, domain)) ? 'perigoso' : 'adulto';
}

/** Fila com concorrência limitada e sem duplicatas. */
class ProbeQueue {
  constructor(onResult, { concurrency = 4, probeFn = probe } = {}) {
    this.onResult = onResult;
    this.concurrency = concurrency;
    this.probeFn = probeFn;
    this.pending = [];
    this.queued = new Set();
    this.running = 0;
  }

  push(site) {
    if (this.queued.has(site)) return;
    this.queued.add(site);
    this.pending.push(site);
    this._pump();
  }

  _pump() {
    while (this.running < this.concurrency && this.pending.length) {
      const site = this.pending.shift();
      this.running++;
      this.probeFn(site)
        .then((category) => this.onResult(site, category))
        .catch(() => {}) // falha de rede: continua "desconhecido" e será tentado de novo depois
        .finally(() => {
          this.running--;
          this.queued.delete(site);
          this._pump();
        });
    }
  }
}

module.exports = { probe, ProbeQueue };
