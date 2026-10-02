'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SNISniffer } = require('../src/sni/sniffer');
const { SNICollector } = require('../src/sni/collector');

test('sniffer: extrai SNI e prefere IPv4, cai para IPv6', () => {
  const got = [];
  const s = new SNISniffer(1, (ev) => got.push(ev), () => {});
  s._handleLine('192.168.137.5|2001:db8::1|www.youtube.com|142.250.1.1|'); // com IP de destino
  s._handleLine('|2001:db8::abcd|instagram.com'); // sem IPv4 -> usa IPv6; sem destino
  s._handleLine('192.168.137.9||WWW.Roblox.COM'); // normaliza para minúsculas
  s._handleLine(''); // linha vazia é ignorada
  s._handleLine('192.168.137.9||'); // sem SNI é ignorada
  assert.deepEqual(got, [
    { srcIp: '192.168.137.5', sni: 'www.youtube.com', dstIp: '142.250.1.1' },
    { srcIp: '2001:db8::abcd', sni: 'instagram.com', dstIp: null },
    { srcIp: '192.168.137.9', sni: 'www.roblox.com', dstIp: null },
  ]);
});

test('sniffer: divide corretamente pedaços de linha parciais', () => {
  const got = [];
  const s = new SNISniffer(1, (ev) => got.push(ev), () => {});
  // Simula o stdout chegando em pedaços quebrados no meio da linha
  s.buffer = '192.168.137.5||exe';
  s._handleLine('192.168.137.5||example.com');
  assert.equal(got.length, 1);
  assert.equal(got[0].sni, 'example.com');
});

function fakeStore() {
  const sites = new Map();
  const logs = [];
  return {
    logs,
    ensureSite(site, category) {
      if (!sites.has(site)) sites.set(site, { site, category, blocked: 0 });
      return sites.get(site);
    },
    logQuery(row) {
      logs.push(row);
    },
  };
}
const fakeConfig = (vals) => ({ get: (k) => vals[k] });

test('collector: classifica, grava e deduplica por (aparelho, site)', () => {
  const store = fakeStore();
  const config = fakeConfig({ onlineCheck: false, autoBlockAlerts: false });
  const c = new SNICollector({ store, config, probeQueue: null });

  c.handle({ srcIp: '192.168.137.5', sni: 'www.bet365.com' });
  c.handle({ srcIp: '192.168.137.5', sni: 'www.bet365.com' }); // duplicata na janela -> não grava
  c.handle({ srcIp: '192.168.137.9', sni: 'www.bet365.com' }); // outro aparelho -> grava
  c.stop();

  assert.equal(store.logs.length, 2);
  assert.equal(store.logs[0].site, 'bet365.com');
  assert.equal(store.logs[0].qtype, 'HTTPS');
  assert.equal(store.logs[0].clientIp, '192.168.137.5');
  assert.equal(c.stats.received, 3);
  assert.equal(c.stats.logged, 2);
});

test('collector: ignora nomes locais/reversos', () => {
  const store = fakeStore();
  const c = new SNICollector({ store, config: fakeConfig({ onlineCheck: false, autoBlockAlerts: false }), probeQueue: null });
  c.handle({ srcIp: '192.168.137.5', sni: 'wpad' });
  c.handle({ srcIp: '192.168.137.5', sni: 'algo.local' });
  c.stop();
  assert.equal(store.logs.length, 0);
});

test('collector: envia sites desconhecidos para a fila de verificação', () => {
  const store = fakeStore();
  const pushed = [];
  const probeQueue = { push: (s) => pushed.push(s) };
  const c = new SNICollector({ store, config: fakeConfig({ onlineCheck: true, autoBlockAlerts: false }), probeQueue });
  c.handle({ srcIp: '192.168.137.5', sni: 'cdn.site-desconhecido-xyz.com' });
  c.stop();
  assert.deepEqual(pushed, ['site-desconhecido-xyz.com']);
});
