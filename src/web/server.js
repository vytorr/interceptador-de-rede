'use strict';

const http = require('node:http');
const { getStatic } = require('./static');
const { CATEGORIES } = require('../classify/categories');
const { localAddresses } = require('../network');
const { HOUR } = require('../db');

const MAX_BODY = 64 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Converte o período escolhido no painel em intervalo [from, to) em ms. */
function periodRange(period, now = Date.now()) {
  const startOfDay = (daysAgo) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - daysAgo);
    return d.getTime();
  };
  const to = now + 60_000;
  switch (period) {
    case '24h':
      return { from: now - 24 * HOUR, to };
    case '7d':
      return { from: startOfDay(6), to };
    case '30d':
      return { from: startOfDay(29), to };
    case 'ontem':
      return { from: startOfDay(1), to: startOfDay(0) };
    case 'hoje':
    default:
      return { from: startOfDay(0), to };
  }
}

function filtersFrom(url) {
  const p = url.searchParams;
  return {
    ...periodRange(p.get('period') || 'hoje'),
    device: p.get('device') || null,
    includeAds: p.get('ads') === '1',
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'corpo grande demais'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Painel web + API. Escuta apenas em 127.0.0.1: só quem está no computador
 * da mãe consegue abrir — os celulares da rede não.
 */
function createWebServer({ store, config, dnsServer, dnsPort, webPort, sniStatus }) {
  const allowedHosts = new Set([`127.0.0.1:${webPort}`, `localhost:${webPort}`]);

  const routes = {
    'GET /api/status': () => {
      const today = periodRange('hoje');
      return {
        dns: { port: dnsPort, ...dnsServer.stats },
        sni: sniStatus ? sniStatus() : null,
        addresses: localAddresses(),
        config: config.all(),
        categories: CATEGORIES,
        alertSites: store.alertSiteNames(today.from, today.to),
      };
    },

    'GET /api/dashboard': (url) => {
      const f = filtersFrom(url);
      // Período anterior de mesma duração, para mostrar a tendência (▲/▼).
      const dur = f.to - f.from;
      const prev = { ...f, from: f.from - dur, to: f.from };
      return {
        range: { from: f.from, to: f.to },
        summary: store.summary(f),
        summaryPrev: store.summary(prev),
        categories: store.categories(f),
        timeline: store.timeline(f),
        alerts: store.alerts(f),
        topSites: store.topSites(f),
      };
    },

    'GET /api/recent': (url) => {
      const p = url.searchParams;
      const PAGE_SIZE = 100;
      const page = Math.max(1, parseInt(p.get('page'), 10) || 1);
      const search = (p.get('q') || '').slice(0, 100);
      const { rows, total } = store.recent(filtersFrom(url), {
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
        search,
      });
      return { rows, total, page, pageSize: PAGE_SIZE, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
    },

    'GET /api/devices': () => store.devices(),

    'PATCH /api/devices': async (url, req) => {
      const body = await readJson(req);
      if (typeof body.ip !== 'string') throw new HttpError(400, 'ip obrigatório');
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
      store.renameDevice(body.ip, name);
      return store.devices();
    },

    'DELETE /api/devices': async (url, req) => {
      const body = await readJson(req);
      if (typeof body.ip !== 'string') throw new HttpError(400, 'ip obrigatório');
      store.deleteDevice(body.ip);
      return store.devices();
    },

    'PATCH /api/sites': async (url, req) => {
      const body = await readJson(req);
      if (typeof body.site !== 'string' || !store.getSite(body.site)) throw new HttpError(404, 'site não encontrado');
      let row = store.getSite(body.site);
      if (typeof body.blocked === 'boolean') row = store.setBlocked(body.site, body.blocked);
      if (typeof body.category === 'string') {
        if (!CATEGORIES[body.category]) throw new HttpError(400, 'categoria inválida');
        row = store.setCategory(body.site, body.category);
      }
      return row;
    },

    'GET /api/blocked': () => store.blockedSites(),

    'GET /api/config': () => config.all(),

    'PUT /api/config': async (url, req) => config.update(await readJson(req)),

    'DELETE /api/logs': () => ({ cleared: store.clearHistory() }),

    'GET /api/export.csv': (url) => {
      const p = url.searchParams;
      const search = (p.get('q') || '').slice(0, 100);
      const { rows } = store.recent(filtersFrom(url), { limit: 50000, offset: 0, search });
      const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
      const header = ['Data/Hora', 'Aparelho', 'Endereço acessado', 'Site', 'Categoria', 'Status'];
      const lines = [header.map(esc).join(';')];
      for (const r of rows) {
        lines.push([
          new Date(r.ts).toLocaleString('pt-BR'),
          r.client_ip,
          r.domain,
          r.site,
          (CATEGORIES[r.category] && CATEGORIES[r.category].label) || r.category,
          r.blocked ? 'Bloqueado' : 'Permitido',
        ].map(esc).join(';'));
      }
      return { __csv: true, filename: `monitor-registro-${new Date().toISOString().slice(0, 10)}.csv`, body: lines.join('\r\n') };
    },
  };

  const server = http.createServer(async (req, res) => {
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
      });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };

    try {
      // Protege contra "DNS rebinding": só aceita o painel acessado pelo nome local.
      if (!allowedHosts.has(req.headers.host)) throw new HttpError(403, 'host não permitido');
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method !== 'GET') {
        // Cabeçalho próprio obriga o navegador a fazer "preflight" CORS, que não
        // respondemos — assim nenhum site externo consegue alterar a configuração.
        if (req.headers['x-monitor'] !== '1') throw new HttpError(403, 'requisição recusada');
      }

      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const file = getStatic(url.pathname);
        if (!file) throw new HttpError(404, 'não encontrado');
        return send(200, file.body, file.type);
      }

      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) throw new HttpError(404, 'rota não encontrada');
      const result = await handler(url, req);
      if (result && result.__csv) {
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${result.filename}"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end('﻿' + result.body);
      }
      send(200, result);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error('[web]', err);
      send(status, { error: err.message });
    }
  });

  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(webPort, '127.0.0.1', () => resolve(server.address()));
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

module.exports = { createWebServer, periodRange };
