'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { keywordHit, decideBlock } = require('../src/block');

const cfg = (vals) => ({ get: (k) => vals[k] });

test('keywordHit casa por substring, sem diferenciar maiúsculas', () => {
  assert.equal(keywordHit('pt.pornhub.com', ['porn']), 'porn');
  assert.equal(keywordHit('PORN-CDN.net', ['porn']), 'porn');
  assert.equal(keywordHit('www.google.com', ['porn', 'xxx']), null);
  assert.equal(keywordHit('algo.com', []), null);
  assert.equal(keywordHit('algo.com', null), null);
});

test('decideBlock: bloqueio manual tem prioridade', () => {
  const d = decideBlock({ name: 'roblox.com', siteRow: { blocked: 1, category: 'jogos' } }, cfg({ blockKeywords: [] }));
  assert.deepEqual(d, { blocked: true, reason: 'manual' });
});

test('decideBlock: palavra-chave bloqueia mesmo site desconhecido', () => {
  const d = decideBlock(
    { name: 'sitenovo-pornzao.com', siteRow: { blocked: 0, category: 'desconhecido' } },
    cfg({ blockKeywords: ['porn'], autoBlockAlerts: false })
  );
  assert.equal(d.blocked, true);
  assert.equal(d.reason, 'palavra');
  assert.equal(d.keyword, 'porn');
});

test('decideBlock: categoria de alerta bloqueia só com autoBlockAlerts ligado', () => {
  const row = { blocked: 0, category: 'apostas' };
  assert.equal(decideBlock({ name: 'bet365.com', siteRow: row }, cfg({ blockKeywords: [], autoBlockAlerts: true })).blocked, true);
  assert.equal(decideBlock({ name: 'bet365.com', siteRow: row }, cfg({ blockKeywords: [], autoBlockAlerts: false })).blocked, false);
});

test('decideBlock: site comum não é bloqueado', () => {
  const d = decideBlock({ name: 'wikipedia.org', siteRow: { blocked: 0, category: 'educacao' } }, cfg({ blockKeywords: ['porn'], autoBlockAlerts: true, blockAds: true }));
  assert.deepEqual(d, { blocked: false, reason: null });
});

test('decideBlock: anúncio bloqueia só com blockAds ligado', () => {
  const row = { blocked: 0, category: 'anuncios' };
  assert.equal(decideBlock({ name: 'ads.openx.net', siteRow: row }, cfg({ blockKeywords: [], blockAds: true })).reason, 'anuncio');
  assert.equal(decideBlock({ name: 'ads.openx.net', siteRow: row }, cfg({ blockKeywords: [], blockAds: false })).blocked, false);
});
