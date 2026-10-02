'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { pythonPath } = require('./arp');
const { KNOWN } = require('../classify/categories');

const BLOCKER_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'blocker.py');

// Sites/IPs aprendidos por decisão (categoria/palavra/QUIC) expiram se não
// forem revistos — assim desbloquear ou mudar config tem efeito.
const TTL_MS = 15 * 60_000;

/**
 * Motor de bloqueio: fala com o blocker.py (WinDivert) via stdin.
 *
 * - keywords: vêm da config (casam por substring, no ato).
 * - sites: bloqueios manuais (do banco) + sites decididos como bloqueados.
 * - ips: destinos aprendidos (corta QUIC e TCP mesmo sem ler o SNI).
 */
class Blocker {
  constructor({ store, config, onStatus = null }) {
    this.store = store;
    this.config = config;
    this.onStatus = onStatus;
    this.process = null;
    this.stopped = false;
    this.buffer = '';
    this.autoSites = new Map(); // site -> expiry
    this.ips = new Map(); // ip -> expiry
    this._timer = null;
  }

  start() {
    if (!fs.existsSync(BLOCKER_SCRIPT)) {
      console.log('  [!] Motor de bloqueio ausente: ' + BLOCKER_SCRIPT);
      return false;
    }
    const py = pythonPath();
    this.process = spawn(py, [BLOCKER_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    this.process.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';
      for (const line of lines) this._handleLine(line.trim());
    });
    let stderr = '';
    this.process.stderr.on('data', (c) => (stderr += c.toString('utf8')));
    this.process.on('error', (err) =>
      console.log('  [!] Falha no motor de bloqueio: ' + err.message)
    );
    this.process.on('exit', (code) => {
      if (this.stopped) return;
      console.log(`  [!] Motor de bloqueio encerrou (código ${code}). ${stderr.trim().split('\n').pop() || ''}`);
    });

    this.push();
    this._timer = setInterval(() => this.push(), 5000);
    this._timer.unref();
    return true;
  }

  _handleLine(line) {
    if (!line) return;
    const [kind, ...parts] = line.split('|');
    const debug = process.env.MONITOR_DEBUG;
    if (kind === 'READY') {
      console.log(`  [OK] Motor de bloqueio ATIVO (WinDivert, camada ${parts[0] || '?'}).`);
    } else if (kind === 'ERROR') {
      console.log('  [!] Bloqueio: ' + parts.join(' '));
    } else if (kind === 'BLOCK' && debug) {
      console.log(`  [BLOQUEADO] ${parts.join(' ')}`);
    } else if (kind === 'STATS' && debug) {
      console.log('  [bloqueio] ' + parts.join(' '));
    }
    if (this.onStatus) this.onStatus(kind, parts);
  }

  /** Chamado pelo collector quando um acesso deve ser cortado. */
  onBlocked({ site, dstIp }) {
    const now = Date.now();
    let changed = false;
    if (site) {
      this.autoSites.set(site, now + TTL_MS);
      changed = true;
    }
    if (dstIp) {
      this.ips.set(dstIp, now + TTL_MS);
      changed = true;
    }
    if (changed) this.push();
  }

  _expire() {
    const now = Date.now();
    for (const [k, t] of this.autoSites) if (t < now) this.autoSites.delete(k);
    for (const [k, t] of this.ips) if (t < now) this.ips.delete(k);
  }

  _buildPayload() {
    this._expire();
    const keywords = this.config.get('blockKeywords') || [];
    const manual = this.store.blockedSites().map((r) => r.site);
    // Com "bloquear anúncios" ligado, pré-carrega as redes de anúncio conhecidas
    // para barrar já no primeiro acesso (proativo), sem depender de aprender o IP.
    const ads = this.config.get('blockAds') ? KNOWN.anuncios : [];
    const sites = [...new Set([...manual, ...this.autoSites.keys(), ...ads])];
    const ips = [...this.ips.keys()];
    return { keywords, sites, ips };
  }

  push() {
    if (!this.process || this.process.killed) return;
    try {
      this.process.stdin.write(JSON.stringify(this._buildPayload()) + '\n');
    } catch {
      // stdin pode ter fechado; ignorar.
    }
  }

  stop() {
    this.stopped = true;
    if (this._timer) clearInterval(this._timer);
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    return Promise.resolve();
  }
}

module.exports = { Blocker };
