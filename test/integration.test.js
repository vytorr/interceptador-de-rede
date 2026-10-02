'use strict';

process.removeAllListeners('warning'); // silencia o aviso experimental do node:sqlite

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Config } = require('../src/config');
const { Store } = require('../src/db');
const { DnsServer } = require('../src/dns/server');
const { ProbeQueue } = require('../src/classify/familyFilter');
const { createWebServer } = require('../src/web/server');
const { buildQuery, parseResponse } = require('../src/dns/packet');
const { udpExchange } = require('../src/dns/udp');

const WEB_PORT = 38931;

// "Upstream" falso: responde qualquer consulta com 93.184.216.34.
async function fakeExchange(server, msg) {
  const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 93, 184, 216, 34]);
  const out = Buffer.concat([msg, answer]);
  out.writeUInt16BE(0x8180, 2);
  out.writeUInt16BE(1, 6);
  return out;
}

test('fluxo completo: DNS registra, classifica, bloqueia e o painel mostra', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-test-'));
  const config = new Config(dir);
  config.update({ autoBlockAlerts: false, forceSafeSearch: false, blockKeywords: [] });
  const store = new Store(path.join(dir, 'test.db'));
  const probed = [];
  const probeQueue = new ProbeQueue((site, cat) => store.applyProbeResult(site, cat), {
    probeFn: async (site) => {
      probed.push(site);
      return site === 'site-suspeito.com' ? 'adulto' : 'outros';
    },
  });
  const dns = new DnsServer({ store, config, probeQueue, exchange: fakeExchange });
  const { port } = await dns.start(0, '127.0.0.1');
  const web = createWebServer({ store, config, dnsServer: dns, dnsPort: port, webPort: WEB_PORT });
  await web.listen();
  t.after(async () => {
    await dns.stop();
    await web.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let nextId = 1;
  const ask = async (name, type = 1) => {
    const id = nextId++;
    return parseResponse(await udpExchange('127.0.0.1', buildQuery(name, type, id), id, 2000, port));
  };
  const firstIPv4 = (res) => [...res.answers[0].data].join('.');

  // 1. Consulta normal é repassada e registrada.
  assert.equal(firstIPv4(await ask('www.roblox.com')), '93.184.216.34');

  // 2. SafeSearch ativo intercepta buscas do Google e YouTube.
  config.update({ forceSafeSearch: true });
  assert.equal(firstIPv4(await ask('www.google.com')), '216.239.38.120');
  assert.equal(firstIPv4(await ask('www.youtube.com')), '216.239.38.120');

  // 3. Bloqueio manual.
  store.setBlocked('roblox.com', true);
  assert.equal(firstIPv4(await ask('www.roblox.com')), '0.0.0.0');

  // 4. Bloqueio automático de categorias de alerta.
  assert.equal(firstIPv4(await ask('pt.pornhub.com')), '93.184.216.34');
  config.update({ autoBlockAlerts: true });
  assert.equal(firstIPv4(await ask('www.pornhub.com')), '0.0.0.0');

  // 5. Site desconhecido é verificado online e reclassificado.
  await ask('www.site-suspeito.com');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(probed, ['site-suspeito.com']);
  assert.equal(store.getSite('site-suspeito.com').category, 'adulto');

  // 6. Tráfego de sistema (sempre oculto) e de anúncios (oculto por padrão).
  await ask('connectivitycheck.gstatic.com');
  await ask('ad.doubleclick.net');

  // 6. Painel.
  const get = (p) => fetch(`http://127.0.0.1:${WEB_PORT}${p}`).then((r) => r.json());
  const dash = await get('/api/dashboard?period=hoje');
  const sites = dash.topSites.map((s) => s.site);
  assert.ok(sites.includes('roblox.com'));
  assert.ok(!sites.includes('gstatic.com')); // sistema oculto
  assert.ok(!sites.includes('doubleclick.net')); // anúncio oculto por padrão
  assert.deepEqual(dash.alerts.map((a) => a.site).sort(), ['pornhub.com', 'site-suspeito.com']);
  assert.equal(dash.summary.alertSites, 2);
  assert.ok(dash.summary.blocked >= 2);
  assert.equal(dash.timeline.unit, 'hora');

  // "Mostrar log de anúncios": revela anúncios, mas sistema continua oculto.
  const withAds = await get('/api/dashboard?period=hoje&ads=1');
  assert.ok(withAds.topSites.some((s) => s.site === 'doubleclick.net'));
  assert.ok(!withAds.topSites.some((s) => s.site === 'gstatic.com'));

  const devices = await get('/api/devices');
  assert.equal(devices.length, 1);
  assert.equal(devices[0].ip, '127.0.0.1');

  // 6b. Registro paginado + busca no servidor (varre todos os logs).
  const live = await get('/api/recent?period=hoje');
  assert.equal(live.pageSize, 100);
  assert.ok(Array.isArray(live.rows));
  assert.ok(live.total >= 1);
  const found = await get('/api/recent?period=hoje&q=roblox');
  assert.ok(found.rows.length >= 1);
  assert.ok(found.rows.every((r) => (r.domain + r.site).includes('roblox')));
  const none = await get('/api/recent?period=hoje&q=zzz-nao-existe-zzz');
  assert.equal(none.total, 0);

  // 7. Alterações exigem o cabeçalho X-Monitor.
  const denied = await fetch(`http://127.0.0.1:${WEB_PORT}/api/sites`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ site: 'roblox.com', blocked: false }),
  });
  assert.equal(denied.status, 403);

  const ok = await fetch(`http://127.0.0.1:${WEB_PORT}/api/sites`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Monitor': '1' },
    body: JSON.stringify({ site: 'roblox.com', blocked: false, category: 'infantil' }),
  });
  assert.equal(ok.status, 200);
  const row = await ok.json();
  assert.equal(row.blocked, 0);
  assert.equal(row.category, 'infantil');
  assert.equal(row.source, 'manual');

  // 8. Host estranho é recusado (proteção contra DNS rebinding).
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: WEB_PORT, path: '/api/status', headers: { Host: 'evil.com' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
  });
  assert.equal(status, 403);

  // 9. Página do painel é servida.
  const html = await fetch(`http://127.0.0.1:${WEB_PORT}/`).then((r) => r.text());
  assert.match(html, /Monitor de Rede/);

  // 9b. Exportação CSV do registro.
  const csvRes = await fetch(`http://127.0.0.1:${WEB_PORT}/api/export.csv?period=hoje`);
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers.get('content-type') || '', /text\/csv/);
  assert.match(csvRes.headers.get('content-disposition') || '', /attachment/);
  const csvText = await csvRes.text();
  assert.match(csvText, /Data\/Hora/); // cabeçalho
  assert.match(csvText, /Aparelho/);
  assert.match(csvText, /roblox\.com/); // um site acessado

  // 10. Limpar histórico esvazia o registro (e exige o cabeçalho X-Monitor).
  const clrDenied = await fetch(`http://127.0.0.1:${WEB_PORT}/api/logs`, { method: 'DELETE' });
  assert.equal(clrDenied.status, 403);
  const clr = await fetch(`http://127.0.0.1:${WEB_PORT}/api/logs`, { method: 'DELETE', headers: { 'X-Monitor': '1' } });
  assert.equal(clr.status, 200);
  assert.ok((await clr.json()).cleared >= 1);
  const afterClear = await get('/api/recent?period=hoje');
  assert.equal(afterClear.total, 0);
});
