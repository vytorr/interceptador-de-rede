'use strict';

const { DatabaseSync } = require('node:sqlite');
const { CATEGORIES } = require('./classify/categories');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const ALERT_CATEGORIES = Object.keys(CATEGORIES).filter((c) => CATEGORIES[c].alert);
const HIDDEN_CATEGORIES = Object.keys(CATEGORIES).filter((c) => CATEGORIES[c].hidden);
const sqlList = (arr) => arr.map((c) => `'${c}'`).join(',');

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS sites (
    site       TEXT PRIMARY KEY,
    category   TEXT NOT NULL,
    source     TEXT NOT NULL,          -- lista | palavra | online | manual | nenhum
    blocked    INTEGER NOT NULL DEFAULT 0,
    checked_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS queries (
    id        INTEGER PRIMARY KEY,
    ts        INTEGER NOT NULL,        -- epoch em ms
    client_ip TEXT NOT NULL,
    domain    TEXT NOT NULL,
    site      TEXT NOT NULL REFERENCES sites(site),
    qtype     TEXT NOT NULL,
    blocked   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_queries_ts ON queries(ts);
  CREATE INDEX IF NOT EXISTS idx_queries_site_ts ON queries(site, ts);
  CREATE INDEX IF NOT EXISTS idx_queries_client_ts ON queries(client_ip, ts);

  CREATE TABLE IF NOT EXISTS devices (
    ip         TEXT PRIMARY KEY,
    mac        TEXT,
    name       TEXT,
    first_seen INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL
  );
`;

class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    this.siteCache = new Map();
    const p = (sql) => this.db.prepare(sql);
    this.stmt = {
      getSite: p('SELECT site, category, source, blocked, checked_at FROM sites WHERE site = ?'),
      insertSite: p('INSERT OR IGNORE INTO sites (site, category, source, checked_at) VALUES (?, ?, ?, ?)'),
      setProbe: p(`UPDATE sites SET category = ?, source = 'online', checked_at = ?
                   WHERE site = ? AND source NOT IN ('manual', 'lista', 'palavra')`),
      setCategory: p(`UPDATE sites SET category = ?, source = 'manual' WHERE site = ?`),
      setBlocked: p('UPDATE sites SET blocked = ? WHERE site = ?'),
      insertQuery: p('INSERT INTO queries (ts, client_ip, domain, site, qtype, blocked) VALUES (?, ?, ?, ?, ?, ?)'),
      touchDevice: p(`INSERT INTO devices (ip, first_seen, last_seen) VALUES (?, ?, ?)
                      ON CONFLICT(ip) DO UPDATE SET last_seen = excluded.last_seen`),
      setDeviceMac: p('UPDATE devices SET mac = ? WHERE ip = ? AND (mac IS NULL OR mac <> ?)'),
      renameDevice: p('UPDATE devices SET name = ? WHERE ip = ?'),
      deleteDeviceRow: p('DELETE FROM devices WHERE ip = ?'),
      deleteDeviceQueries: p('DELETE FROM queries WHERE client_ip = ?'),
      purge: p('DELETE FROM queries WHERE ts < ?'),
      unknownSites: p(`SELECT site FROM sites WHERE category = 'desconhecido' ORDER BY checked_at DESC LIMIT ?`),
    };
  }

  close() {
    this.db.close();
  }

  // ---- sites ----------------------------------------------------------------

  /** Garante que o site exista e retorna sua linha (com cache em memória). */
  ensureSite(site, category, source) {
    let row = this.siteCache.get(site);
    if (row) return row;
    this.stmt.insertSite.run(site, category, source, Date.now());
    row = { ...this.stmt.getSite.get(site) };
    this.siteCache.set(site, row);
    return row;
  }

  getSite(site) {
    const row = this.stmt.getSite.get(site);
    return row ? { ...row } : null;
  }

  _refresh(site) {
    const row = this.getSite(site);
    if (row) this.siteCache.set(site, row);
    else this.siteCache.delete(site);
    return row;
  }

  applyProbeResult(site, category) {
    this.stmt.setProbe.run(category, Date.now(), site);
    return this._refresh(site);
  }

  setCategory(site, category) {
    if (!CATEGORIES[category]) throw new Error('categoria inválida');
    this.stmt.setCategory.run(category, site);
    return this._refresh(site);
  }

  setBlocked(site, blocked) {
    this.stmt.setBlocked.run(blocked ? 1 : 0, site);
    return this._refresh(site);
  }

  unknownSites(limit = 500) {
    return this.stmt.unknownSites.all(limit).map((r) => r.site);
  }

  // ---- registro ---------------------------------------------------------------

  logQuery({ ts, clientIp, domain, site, qtype, blocked }) {
    this.stmt.insertQuery.run(ts, clientIp, domain, site, qtype, blocked ? 1 : 0);
    this.stmt.touchDevice.run(clientIp, ts, ts);
  }

  setDeviceMac(ip, mac) {
    this.stmt.setDeviceMac.run(mac, ip, mac);
  }

  renameDevice(ip, name) {
    this.stmt.renameDevice.run(name || null, ip);
  }

  /** Remove um aparelho e todo o histórico de acessos vindo dele. */
  deleteDevice(ip) {
    this.stmt.deleteDeviceQueries.run(ip);
    this.stmt.deleteDeviceRow.run(ip);
  }

  purgeOlderThan(days) {
    return Number(this.stmt.purge.run(Date.now() - days * DAY).changes);
  }

  /** Apaga TODO o histórico de acessos (mantém classificações e nomes). */
  clearHistory() {
    const n = Number(this.db.prepare('DELETE FROM queries').run().changes);
    // Zera a contagem/última atividade derivada; mantém os aparelhos nomeados.
    this.db.prepare("UPDATE devices SET last_seen = first_seen").run();
    return n;
  }

  // ---- consultas do painel ------------------------------------------------------

  /** Sites em categoria de alerta acessados no intervalo (para notificações). */
  alertSiteNames(from, to) {
    return this.db
      .prepare(
        `SELECT DISTINCT q.site FROM queries q JOIN sites s ON s.site = q.site
         WHERE q.ts >= ? AND q.ts < ? AND s.category IN (${sqlList(ALERT_CATEGORIES)})`
      )
      .all(from, to)
      .map((r) => r.site);
  }

  /** Monta o WHERE comum a todas as consultas do painel. */
  _where({ from, to, device, includeAds }, { onlyAlerts = false } = {}) {
    const clauses = ['q.ts >= ?', 'q.ts < ?'];
    const params = [from, to];
    if (device) {
      clauses.push('q.client_ip = ?');
      params.push(device);
    }
    if (onlyAlerts) {
      clauses.push(`s.category IN (${sqlList(ALERT_CATEGORIES)})`);
    } else {
      // 'sistema' é sempre oculto (ruído do próprio celular). 'anuncios' só
      // aparece quando a mãe marca "Mostrar log de anúncios".
      const hide = includeAds ? ['sistema'] : ['sistema', 'anuncios'];
      clauses.push(`s.category NOT IN (${sqlList(hide)})`);
    }
    return { sql: 'WHERE ' + clauses.join(' AND '), params };
  }

  summary(f) {
    const w = this._where(f);
    const main = this.db
      .prepare(
        `SELECT COUNT(*) AS queries,
                COUNT(DISTINCT q.site) AS sites,
                COUNT(DISTINCT q.ts / ${MINUTE}) AS minutes,
                SUM(q.blocked) AS blocked
         FROM queries q JOIN sites s ON s.site = q.site ${w.sql}`
      )
      .get(...w.params);
    const a = this._where(f, { onlyAlerts: true });
    const alerts = this.db
      .prepare(`SELECT COUNT(DISTINCT q.site) AS n FROM queries q JOIN sites s ON s.site = q.site ${a.sql}`)
      .get(...a.params);
    return {
      queries: main.queries,
      sites: main.sites,
      activeMinutes: main.minutes,
      blocked: main.blocked || 0,
      alertSites: alerts.n,
    };
  }

  categories(f) {
    const w = this._where(f);
    return this.db
      .prepare(
        `SELECT s.category AS category,
                COUNT(DISTINCT q.site) AS sites,
                COUNT(DISTINCT q.ts / ${MINUTE}) AS minutes,
                COUNT(*) AS queries
         FROM queries q JOIN sites s ON s.site = q.site ${w.sql}
         GROUP BY s.category ORDER BY minutes DESC`
      )
      .all(...w.params);
  }

  _siteRows(w, limit) {
    return this.db
      .prepare(
        `SELECT q.site AS site, s.category AS category, s.source AS source, s.blocked AS blocked,
                COUNT(*) AS queries,
                COUNT(DISTINCT q.ts / ${MINUTE}) AS minutes,
                MIN(q.ts) AS first_seen, MAX(q.ts) AS last_seen,
                GROUP_CONCAT(DISTINCT q.client_ip) AS devices,
                (SELECT domain FROM queries q2 WHERE q2.site = q.site ORDER BY q2.ts DESC LIMIT 1) AS sample_domain
         FROM queries q JOIN sites s ON s.site = q.site ${w.sql}
         GROUP BY q.site ORDER BY minutes DESC, queries DESC LIMIT ?`
      )
      .all(...w.params, limit)
      .map((r) => ({ ...r, blocked: !!r.blocked, devices: r.devices ? r.devices.split(',') : [] }));
  }

  topSites(f, limit = 100) {
    return this._siteRows(this._where(f), limit);
  }

  alerts(f, limit = 100) {
    return this._siteRows(this._where(f, { onlyAlerts: true }), limit);
  }

  /** Minutos com atividade por hora (períodos curtos) ou por dia (longos). */
  timeline(f) {
    const byHour = f.to - f.from <= 36 * HOUR;
    const fmt = byHour ? '%Y-%m-%d %H' : '%Y-%m-%d';
    const w = this._where(f);
    const rows = this.db
      .prepare(
        `SELECT strftime('${fmt}', q.ts / 1000, 'unixepoch', 'localtime') AS bucket,
                COUNT(DISTINCT q.ts / ${MINUTE}) AS minutes
         FROM queries q JOIN sites s ON s.site = q.site ${w.sql}
         GROUP BY bucket`
      )
      .all(...w.params);
    const byBucket = new Map(rows.map((r) => [r.bucket, r.minutes]));
    const buckets = [];
    const cursor = new Date(f.from);
    if (byHour) cursor.setMinutes(0, 0, 0);
    else cursor.setHours(0, 0, 0, 0);
    while (cursor.getTime() < f.to) {
      const key = byHour ? localKey(cursor, true) : localKey(cursor, false);
      buckets.push({ bucket: key, minutes: byBucket.get(key) || 0 });
      if (byHour) cursor.setHours(cursor.getHours() + 1);
      else cursor.setDate(cursor.getDate() + 1);
    }
    return { unit: byHour ? 'hora' : 'dia', buckets };
  }

  /**
   * Registro paginado. A busca (`search`) roda no banco inteiro (todos os
   * logs do período), não só na página atual. Retorna { rows, total }.
   */
  recent(f, { limit = 100, offset = 0, search = '' } = {}) {
    const w = this._where(f);
    let sql = w.sql;
    const params = [...w.params];
    const term = String(search || '').trim();
    if (term) {
      const like = '%' + term.replace(/[%_\\]/g, (c) => '\\' + c) + '%';
      sql += " AND (q.domain LIKE ? ESCAPE '\\' OR q.site LIKE ? ESCAPE '\\')";
      params.push(like, like);
    }
    const total = this.db
      .prepare(`SELECT COUNT(*) AS c FROM queries q JOIN sites s ON s.site = q.site ${sql}`)
      .get(...params).c;
    const rows = this.db
      .prepare(
        `SELECT q.ts, q.client_ip, q.domain, q.site, q.qtype, q.blocked, s.category
         FROM queries q JOIN sites s ON s.site = q.site ${sql}
         ORDER BY q.ts DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset)
      .map((r) => ({ ...r, blocked: !!r.blocked }));
    return { rows, total };
  }

  devices() {
    return this.db
      .prepare(
        `SELECT d.ip, d.mac, d.name, d.first_seen, d.last_seen,
                (SELECT COUNT(*) FROM queries q WHERE q.client_ip = d.ip AND q.ts >= ?) AS queries_24h
         FROM devices d ORDER BY d.last_seen DESC`
      )
      .all(Date.now() - DAY);
  }

  blockedSites() {
    return this.db.prepare('SELECT site, category FROM sites WHERE blocked = 1 ORDER BY site').all();
  }
}

function localKey(d, withHour) {
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withHour ? `${day} ${pad(d.getHours())}` : day;
}

module.exports = { Store, ALERT_CATEGORIES, HIDDEN_CATEGORIES, MINUTE, HOUR, DAY };
