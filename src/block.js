'use strict';

const { ALERT_CATEGORIES } = require('./db');

/**
 * Palavra da lista que aparece no nome do site, ou null.
 * A comparação é por substring simples: "porn" casa com "pornhub.com",
 * "pt.pornhub.com" e "porn-cdn.net".
 */
function keywordHit(name, keywords) {
  if (!keywords || !keywords.length) return null;
  const n = name.toLowerCase();
  for (const k of keywords) if (k && n.includes(k)) return k;
  return null;
}

/**
 * Decide se um acesso deve ser bloqueado e por quê.
 * @returns {{ blocked: boolean, reason: null|'manual'|'categoria'|'palavra', keyword?: string }}
 */
function decideBlock({ name, siteRow }, config) {
  if (siteRow && siteRow.blocked) return { blocked: true, reason: 'manual' };

  const kw = keywordHit(name, config.get('blockKeywords'));
  if (kw) return { blocked: true, reason: 'palavra', keyword: kw };

  if (config.get('autoBlockAlerts') && siteRow && ALERT_CATEGORIES.includes(siteRow.category)) {
    return { blocked: true, reason: 'categoria' };
  }
  if (config.get('blockAds') && siteRow && siteRow.category === 'anuncios') {
    return { blocked: true, reason: 'anuncio' };
  }
  return { blocked: false, reason: null };
}

module.exports = { keywordHit, decideBlock };
