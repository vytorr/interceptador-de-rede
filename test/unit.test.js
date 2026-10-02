'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseQuery, parseResponse, buildQuery, buildBlockedResponse, buildIpResponse, buildNxdomainResponse, buildServfail } = require('../src/dns/packet');
const { classify, baseDomain, isIgnored } = require('../src/classify/classifier');
const { ProbeQueue } = require('../src/classify/familyFilter');
const { parseArp } = require('../src/network');
const { periodRange } = require('../src/web/server');

test('lê a pergunta de uma consulta DNS', () => {
  const q = parseQuery(buildQuery('WWW.YouTube.com', 28, 0x1234));
  assert.equal(q.id, 0x1234);
  assert.equal(q.name, 'www.youtube.com');
  assert.equal(q.qtype, 'AAAA');
});

test('rejeita pacotes inválidos', () => {
  assert.throws(() => parseQuery(Buffer.alloc(5)));
  const resp = buildBlockedResponse(buildQuery('a.com', 1, 1), parseQuery(buildQuery('a.com', 1, 1)));
  assert.throws(() => parseQuery(resp), /não é uma consulta/);
  const loop = Buffer.concat([buildQuery('a.com', 1, 1).subarray(0, 12), Buffer.from([0xc0, 12, 0, 1, 0, 1])]);
  assert.throws(() => parseQuery(loop));
});

test('resposta de bloqueio devolve 0.0.0.0 para A e :: para AAAA', () => {
  for (const [type, len] of [[1, 4], [28, 16]]) {
    const query = buildQuery('bad.example', type, 77);
    const res = parseResponse(buildBlockedResponse(query, parseQuery(query)));
    assert.equal(res.id, 77);
    assert.equal(res.answers.length, 1);
    assert.equal(res.answers[0].type, type);
    assert.equal(res.answers[0].data.length, len);
    assert.ok(res.answers[0].data.every((b) => b === 0));
  }
  const https = buildQuery('bad.example', 65, 5);
  assert.equal(parseResponse(buildBlockedResponse(https, parseQuery(https))).answers.length, 0);
});

test('resposta de IP customizado (SafeSearch) devolve IP fornecido', () => {
  const query = buildQuery('forcesafesearch.google.com', 1, 88);
  const res = parseResponse(buildIpResponse(query, parseQuery(query), '216.239.38.120'));
  assert.equal(res.id, 88);
  assert.equal(res.answers.length, 1);
  assert.equal(res.answers[0].type, 1);
  assert.equal([...res.answers[0].data].join('.'), '216.239.38.120');
});

test('NXDOMAIN mantém o ID e o código de erro 3', () => {
  const q = buildQuery('use-application-dns.net', 1, 42);
  const res = parseResponse(buildNxdomainResponse(q, parseQuery(q)));
  assert.equal(res.id, 42);
  assert.equal(res.rcode, 3);
});

test('SERVFAIL mantém o ID e o código de erro 2', () => {
  const q = buildQuery('x.com', 1, 9);
  const res = parseResponse(buildServfail(q, parseQuery(q)));
  assert.equal(res.id, 9);
  assert.equal(res.rcode, 2);
});

test('domínio registrável', () => {
  assert.equal(baseDomain('m.youtube.com'), 'youtube.com');
  assert.equal(baseDomain('a.b.uol.com.br'), 'uol.com.br');
  assert.equal(baseDomain('youtube.com'), 'youtube.com');
  assert.equal(baseDomain('x.estrelabet.bet.br'), 'estrelabet.bet.br');
});

test('classificação por lista, TLD e palavra-chave', () => {
  assert.deepEqual(classify('www.roblox.com'), { site: 'roblox.com', category: 'jogos', source: 'lista' });
  assert.equal(classify('rr3---sn-abc.googlevideo.com').category, 'video');
  assert.equal(classify('gemini.google.com').category, 'ia');
  assert.equal(classify('gemini.google.com').site, 'gemini.google.com');
  assert.equal(classify('www.google.com').category, 'busca');
  assert.equal(classify('pt.pornhub.com').category, 'adulto');
  assert.equal(classify('algo.xxx').category, 'adulto');
  assert.equal(classify('www.jogodotigrinho.com').category, 'apostas');
  assert.equal(classify('estrelabet.bet.br').category, 'apostas');
  assert.equal(classify('connectivitycheck.gstatic.com').category, 'sistema');
  assert.equal(classify('essex.ac.uk').category, 'desconhecido'); // sem falso positivo
  assert.deepEqual(classify('cdn.exemplo-qualquer.com.br'), { site: 'exemplo-qualquer.com.br', category: 'desconhecido', source: 'nenhum' });
});

test('ignora nomes locais e reversos', () => {
  assert.ok(isIgnored('1.0.168.192.in-addr.arpa'));
  assert.ok(isIgnored('impressora.local'));
  assert.ok(isIgnored('wpad'));
  assert.ok(!isIgnored('youtube.com'));
});

test('fila de verificação não duplica e respeita a concorrência', async () => {
  let running = 0;
  let peak = 0;
  const calls = [];
  const results = [];
  let resolveAll;
  const done = new Promise((r) => (resolveAll = r));
  const q = new ProbeQueue(
    (site, cat) => {
      results.push([site, cat]);
      if (results.length === 3) resolveAll();
    },
    {
      concurrency: 2,
      probeFn: async (site) => {
        calls.push(site);
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 10));
        running--;
        return 'outros';
      },
    }
  );
  ['a.com', 'a.com', 'b.com', 'c.com'].forEach((s) => q.push(s));
  await done;
  assert.deepEqual(calls.sort(), ['a.com', 'b.com', 'c.com']);
  assert.equal(peak, 2);
});

test('lê a tabela ARP do Windows', () => {
  const out = `
Interface: 192.168.0.10 --- 0x7
  Endereço IP           Endereço físico       Tipo
  192.168.0.1           a4-2b-b0-11-22-33     dinâmico
  192.168.0.23          5e-aa-bb-cc-dd-ee     dinâmico
  192.168.0.255         ff-ff-ff-ff-ff-ff     estático
  224.0.0.22            01-00-5e-00-00-16     estático`;
  const m = parseArp(out);
  assert.equal(m.get('192.168.0.23'), '5e:aa:bb:cc:dd:ee');
  assert.equal(m.size, 2);
});

test('período "hoje" começa à meia-noite local', () => {
  const now = new Date(2026, 8, 28, 15, 30).getTime();
  const { from, to } = periodRange('hoje', now);
  assert.equal(from, new Date(2026, 8, 28).getTime());
  assert.ok(to > now);
  const ontem = periodRange('ontem', now);
  assert.equal(ontem.to, from);
});
