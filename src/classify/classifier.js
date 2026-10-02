'use strict';

const { KNOWN, TLD_RULES, KEYWORD_RULES } = require('./categories');

// Sufixos públicos de dois níveis mais comuns. Não é a Public Suffix List
// completa, mas cobre o que aparece numa rede doméstica brasileira.
const MULTI_PART_SUFFIXES = new Set([
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br', 'bet.br', 'art.br', 'blog.br', 'app.br', 'tv.br', 'jus.br',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'com.ar', 'com.mx', 'co.jp', 'co.kr', 'com.cn',
  'com.tw', 'com.hk', 'co.in', 'com.pt', 'co.za', 'com.tr', 'github.io', 'blogspot.com', 'appspot.com',
  'herokuapp.com', 'vercel.app', 'netlify.app', 'web.app', 'firebaseapp.com', 'pages.dev', 'workers.dev',
]);

const KNOWN_INDEX = new Map();
for (const [category, domains] of Object.entries(KNOWN)) {
  for (const d of domains) KNOWN_INDEX.set(d, category);
}

/** Domínio registrável: "m.youtube.com" -> "youtube.com", "a.b.uol.com.br" -> "uol.com.br". */
function baseDomain(domain) {
  const parts = domain.split('.');
  if (parts.length <= 2) return domain;
  const lastTwo = parts.slice(-2).join('.');
  const take = MULTI_PART_SUFFIXES.has(lastTwo) ? 3 : 2;
  return parts.slice(-take).join('.');
}

/** Domínios que não interessam ao painel (resolução reversa, nomes locais). */
function isIgnored(domain) {
  return (
    !domain.includes('.') ||
    domain.endsWith('.arpa') ||
    domain.endsWith('.local') ||
    domain.endsWith('.lan') ||
    domain.endsWith('.home') ||
    domain.endsWith('.localdomain')
  );
}

/**
 * Decide o "site" (chave de agrupamento) e a categoria de um domínio.
 * O site é o sufixo conhecido mais específico (ex.: "gemini.google.com"), ou
 * então o domínio registrável.
 * @returns {{ site: string, category: string, source: 'lista'|'palavra'|'nenhum' }}
 */
function classify(domain) {
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.');
    const category = KNOWN_INDEX.get(candidate);
    if (category) return { site: candidate, category, source: 'lista' };
  }
  const site = baseDomain(domain);
  for (const rule of TLD_RULES) {
    if (domain === rule.suffix || domain.endsWith('.' + rule.suffix)) {
      return { site, category: rule.category, source: 'lista' };
    }
  }
  for (const rule of KEYWORD_RULES) {
    if (rule.re.test(site)) return { site, category: rule.category, source: 'palavra' };
  }
  return { site, category: 'desconhecido', source: 'nenhum' };
}

module.exports = { classify, baseDomain, isIgnored };
