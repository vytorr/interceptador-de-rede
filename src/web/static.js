'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Arquivos do painel. No executável eles vêm embutidos como "assets" do
// Node SEA; rodando pelo código-fonte, vêm da pasta public/.
const FILES = {
  '/': { name: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { name: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { name: 'style.css', type: 'text/css; charset=utf-8' },
};

function loadAsset(name) {
  let sea = null;
  try {
    sea = require('node:sea');
  } catch {
    // Node sem suporte a SEA
  }
  if (sea && sea.isSea()) return Buffer.from(sea.getAsset(name));
  return fs.readFileSync(path.join(__dirname, '..', '..', 'public', name));
}

function getStatic(urlPath) {
  const entry = FILES[urlPath];
  if (!entry) return null;
  return { body: loadAsset(entry.name), type: entry.type };
}

module.exports = { getStatic };
