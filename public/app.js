'use strict';

// Painel do Monitor Infantil. Tudo que vem da rede (nomes de domínio) é
// inserido como texto, nunca como HTML.

const state = {
  tab: 'overview',
  categories: {},
  devices: [],
  addresses: [],
  livePage: 1,
};

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// Notificação transitória (feedback de ações).
function toast(msg, type = 'ok') {
  const box = document.getElementById('toasts');
  if (!box) return;
  const t = el('div', { class: 'toast ' + type, role: 'status' }, msg);
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, 3200);
}

function svgIcon(id) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'icon');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', '#' + id);
  svg.appendChild(use);
  return svg;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json', 'X-Monitor': '1' } : { 'X-Monitor': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------- formatação ----------

const fmtTime = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
// Tempo relativo curto ("agora", "há 3 min", "há 2 h") para dar sensação de "ao vivo".
function fmtAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return 'agora';
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `há ${h} h`;
  return fmtTime(ts);
}
function fmtWhen(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? 'hoje ' + fmtTime(ts)
    : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + fmtTime(ts);
}
function fmtMinutes(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
const catLabel = (c) => (state.categories[c] ? state.categories[c].label : c);
const isAlert = (c) => !!(state.categories[c] && state.categories[c].alert);
function deviceName(ip) {
  const d = state.devices.find((x) => x.ip === ip);
  return d && d.name ? d.name : ip;
}

function categoryTag(category) {
  // Ponto colorido (via CSS .cat-<id>) + rótulo: identidade nunca só pela cor.
  return el('span', { class: 'tag cat cat-' + category }, catLabel(category));
}

function filterQuery() {
  const p = new URLSearchParams({ period: $('#f-period').value });
  if ($('#f-device').value) p.set('device', $('#f-device').value);
  if ($('#f-ads').checked) p.set('ads', '1');
  return p.toString();
}

// ---------- ações ----------

async function setBlocked(site, blocked) {
  const verb = blocked ? 'Bloquear' : 'Desbloquear';
  if (!confirm(`${verb} "${site}" nos aparelhos monitorados?`)) return;
  await api('/api/sites', { method: 'PATCH', body: { site, blocked } });
  toast(blocked ? `"${site}" bloqueado` : `"${site}" desbloqueado`, blocked ? 'danger' : 'ok');
  refresh();
}

async function setCategory(site, category) {
  await api('/api/sites', { method: 'PATCH', body: { site, category } });
  toast('Categoria atualizada');
  refresh();
}

function blockButton(row) {
  return row.blocked
    ? el('button', { class: 'btn', onclick: () => setBlocked(row.site, false) }, 'Desbloquear')
    : el('button', { class: 'btn danger', onclick: () => setBlocked(row.site, true) }, 'Bloquear');
}

function categorySelect(row) {
  const select = el(
    'select',
    { 'aria-label': `Categoria de ${row.site}`, onchange: (e) => setCategory(row.site, e.target.value) },
    Object.entries(state.categories).map(([id, c]) =>
      el('option', { value: id, selected: id === row.category }, c.label)
    )
  );
  return select;
}

function siteCell(row) {
  const extra = row.sample_domain && row.sample_domain !== row.site ? row.sample_domain : null;
  const name = el('button', {
    type: 'button', class: 'site-link',
    title: 'Ver os acessos a este site no registro ao vivo',
    onclick: () => drillToSite(row.site),
  }, row.site);
  return el('td', { class: 'site' }, name, row.blocked ? [' ', el('span', { class: 'tag blocked' }, 'bloqueado')] : null, extra && el('small', {}, extra));
}

// Monta a visão geral e abre a janela de impressão (serve para salvar em PDF).
function printReport() {
  if (state.tab !== 'overview') showTab('overview');
  const when = $('#print-when');
  if (when) {
    const period = $('#f-period');
    const pTxt = period && period.selectedOptions[0] ? period.selectedOptions[0].textContent : '';
    when.textContent = `· ${pTxt} · gerado em ${new Date().toLocaleString('pt-BR')}`;
  }
  // dá um instante para a aba renderizar antes de abrir a impressão
  setTimeout(() => window.print(), 350);
}

// Abre o registro ao vivo já filtrado por um site (ao clicar no nome dele).
function drillToSite(site) {
  const s = $('#f-search');
  if (s) s.value = site;
  state.livePage = 1;
  showTab('live');
  toast(`Mostrando acessos a "${site}"`);
}

// ---------- visão geral ----------

// Anima um número de onde está até o novo valor (micro-interação suave).
function animateCount(node, to) {
  if (!node) return;
  const from = parseInt(node.textContent, 10);
  to = Number(to) || 0;
  if (!Number.isFinite(from) || from === to) { node.textContent = String(to); return; }
  if (Math.abs(to - from) > 500) { node.textContent = String(to); return; } // salto grande: sem animar
  const dur = 500, t0 = performance.now();
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
    node.textContent = String(Math.round(from + (to - from) * eased));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Texto do período anterior usado nos selos de tendência.
function prevPeriodLabel() {
  const p = $('#f-period') ? $('#f-period').value : 'hoje';
  return p === 'hoje' ? 'ontem' : 'período anterior';
}

// Cria/atualiza o selo ▲/▼ ao lado do valor de um indicador.
// alertDir = 'down': para métricas em que subir é ruim (alertas, bloqueios).
function setTrend(valueId, now, before, alertDir) {
  const valNode = $('#' + valueId);
  if (!valNode) return;
  const body = valNode.parentNode;
  let badge = body.querySelector('.tile-trend');
  if (!badge) {
    badge = el('span', { class: 'tile-trend' });
    const hint = body.querySelector('.tile-hint');
    body.insertBefore(badge, hint);
  }
  now = Number(now) || 0;
  before = Number(before) || 0;
  if (before === 0 && now === 0) { badge.hidden = true; return; }
  badge.hidden = false;
  const prevLbl = prevPeriodLabel();
  // Sem base de comparação: mostra "novo" em vez de uma porcentagem enganosa.
  if (before === 0) {
    const bad = alertDir === 'down';
    badge.className = 'tile-trend ' + (bad ? 'bad' : 'good');
    badge.textContent = '▲ novo';
    badge.title = `Não havia registros em ${prevLbl}`;
    return;
  }
  const up = now >= before;
  const flat = now === before;
  const pct = Math.round(((now - before) / before) * 100);
  const arrow = flat ? '→' : up ? '▲' : '▼';
  const good = flat ? 'flat' : (alertDir === 'down' ? (up ? 'bad' : 'good') : (up ? 'good' : 'bad'));
  badge.className = 'tile-trend ' + good;
  badge.textContent = `${arrow} ${flat ? 'igual' : Math.abs(pct) + '%'}`;
  badge.title = `${flat ? 'Sem mudança' : Math.abs(pct) + '% ' + (up ? 'a mais' : 'a menos')} em relação a ${prevLbl}`;
}

function renderTiles(s, prev) {
  $('#t-minutes').textContent = fmtMinutes(s.activeMinutes);
  animateCount($('#t-sites'), s.sites);
  animateCount($('#t-alerts'), s.alertSites);
  animateCount($('#t-blocked'), s.blocked);
  $('.tile-alert').classList.toggle('has-alerts', s.alertSites > 0);
  if (prev) {
    setTrend('t-minutes', s.activeMinutes, prev.activeMinutes);
    setTrend('t-sites', s.sites, prev.sites);
    setTrend('t-alerts', s.alertSites, prev.alertSites, 'down');
    setTrend('t-blocked', s.blocked, prev.blocked, 'down');
  }
}

// Nome do período em linguagem natural, para a frase-resumo.
function periodPhrase() {
  const p = $('#f-period') ? $('#f-period').value : 'hoje';
  return ({ hoje: 'hoje', ontem: 'ontem', '24h': 'nas últimas 24 horas', '7d': 'nos últimos 7 dias', '30d': 'nos últimos 30 dias' })[p] || 'no período';
}

// Frase-resumo em português simples, para a mãe entender a situação num relance.
function renderInsight(s) {
  const box = $('#day-insight');
  const txt = $('#insight-text');
  const use = $('#insight-icon use');
  if (!box || !txt) return;
  const quando = periodPhrase();
  if (!s || s.sites === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  let tone, icon, message;
  if (s.alertSites > 0) {
    tone = 'danger';
    icon = '#i-alert';
    const n = s.alertSites;
    const bloq = s.blocked > 0 ? ` ${s.blocked} ${s.blocked === 1 ? 'acesso foi barrado' : 'acessos foram barrados'} automaticamente.` : '';
    message = `Atenção: ${quando}, ${n} ${n === 1 ? 'site inadequado foi detectado' : 'sites inadequados foram detectados'} (conteúdo adulto, apostas ou arriscado).${bloq}`;
  } else {
    tone = 'good';
    icon = '#i-shield-check';
    message = `Tudo tranquilo ${quando}: ${s.sites} ${s.sites === 1 ? 'site visitado' : 'sites visitados'} em ${fmtMinutes(s.activeMinutes)} de navegação, sem conteúdo inadequado.`;
  }
  box.className = 'insight ' + tone;
  if (use) use.setAttribute('href', icon);
  txt.textContent = message;
}

function searchFilter(text) {
  const q = ($('#f-search') ? $('#f-search').value : '').trim().toLowerCase();
  if (!q) return true;
  return String(text).toLowerCase().includes(q);
}

function renderAlerts(rows) {
  const table = $('#alerts-table');
  const filtered = rows.filter((r) =>
    searchFilter(r.site) ||
    searchFilter(r.sample_domain) ||
    searchFilter(catLabel(r.category)) ||
    r.devices.some((ip) => searchFilter(deviceName(ip)))
  );
  $('#alerts-card').classList.toggle('has-alerts', rows.length > 0);
  $('#alerts-empty').hidden = rows.length > 0;
  table.hidden = filtered.length === 0;
  table.tBodies[0].replaceChildren(
    ...filtered.map((r) =>
      el('tr', { class: 'is-alert' },
        siteCell(r),
        el('td', {}, categoryTag(r.category)),
        el('td', { class: 'priv' }, r.devices.map(deviceName).join(', ')),
        el('td', { class: 'num' }, r.minutes),
        el('td', {}, fmtWhen(r.first_seen)),
        el('td', {}, fmtWhen(r.last_seen)),
        el('td', {}, blockButton(r))
      )
    )
  );
}

function showTooltip(e, text) {
  const tip = $('#tooltip');
  tip.textContent = text;
  tip.hidden = false;
  const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = x + 'px';
  tip.style.top = e.clientY - 34 + 'px';
}
const hideTooltip = () => ($('#tooltip').hidden = true);

function renderTimeline(t) {
  const box = $('#timeline');
  const byHour = t.unit === 'hora';
  const titleEl = $('#timeline-title');
  if (titleEl) titleEl.textContent = byHour ? 'Horários de maior atividade' : 'Atividade por dia';
  const buckets = t.buckets || [];
  const label = (b) => byHour ? b.bucket.slice(11) + 'h' : (() => { const [, m, d] = b.bucket.split('-'); return `${d}/${m}`; })();
  if (!buckets.length) { box.innerHTML = '<p class="muted">Sem dados neste período.</p>'; return; }

  const n = buckets.length;
  const W = Math.max(320, Math.round(box.clientWidth || 760));
  const H = 210, padT = 12, padB = 26, padX = 8;
  const max = Math.max(1, ...buckets.map((b) => b.minutes));
  const xat = (i) => padX + (W - padX * 2) * (n <= 1 ? 0.5 : i / (n - 1));
  const yat = (v) => padT + (H - padT - padB) * (1 - v / max);
  const base = (H - padB).toFixed(1);
  const pts = buckets.map((b, i) => [xat(i), yat(b.minutes)]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = `M${pts[0][0].toFixed(1)} ${base} ` + pts.map((p) => 'L' + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ') + ` L${pts[n - 1][0].toFixed(1)} ${base} Z`;

  let grid = '';
  for (let g = 0; g <= 2; g++) { const yy = (padT + (H - padT - padB) * g / 2).toFixed(1); grid += `<line class="tl-grid" x1="${padX}" y1="${yy}" x2="${W - padX}" y2="${yy}"/>`; }
  const idxs = [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
  let axis = '';
  for (const i of idxs) { const a = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'; axis += `<text x="${xat(i).toFixed(1)}" y="${H - 7}" text-anchor="${a}">${label(buckets[i])}</text>`; }

  box.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Gráfico de atividade por ${byHour ? 'hora' : 'dia'}" style="width:100%;height:${H}px">
      <defs><linearGradient id="tlgrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="currentColor" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="currentColor" stop-opacity="0"/>
      </linearGradient></defs>
      ${grid}
      <path class="tl-area" d="${area}" fill="url(#tlgrad)"/>
      <path class="tl-line" d="${line}"/>
      ${axis}
      <circle class="tl-dot" r="4" style="display:none"/>
      <rect class="tl-hit" x="0" y="0" width="${W}" height="${H}"/>
    </svg>`;

  const svg = box.querySelector('svg');
  const dot = box.querySelector('.tl-dot');
  const hit = box.querySelector('.tl-hit');
  hit.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const relX = (e.clientX - r.left) / r.width * W;
    let i = n <= 1 ? 0 : Math.round((relX - padX) / ((W - padX * 2) / (n - 1)));
    i = Math.max(0, Math.min(n - 1, i));
    dot.setAttribute('cx', pts[i][0].toFixed(1));
    dot.setAttribute('cy', pts[i][1].toFixed(1));
    dot.style.display = '';
    showTooltip(e, `${label(buckets[i])}: ${fmtMinutes(buckets[i].minutes)}`);
  });
  hit.addEventListener('mouseleave', () => { dot.style.display = 'none'; hideTooltip(); });
}

function renderCategories(rows) {
  const box = $('#categories');
  if (!rows.length) {
    box.replaceChildren(el('p', { class: 'muted' }, 'Nenhum acesso neste período.'));
    return;
  }
  const max = Math.max(1, ...rows.map((r) => r.minutes));
  box.replaceChildren(
    ...rows.map((r) => {
      const text = `${catLabel(r.category)}: ${fmtMinutes(r.minutes)}, ${r.sites} site(s) — clique para filtrar`;
      return el('div', {
        class: 'hbar cat cat-' + r.category + (isAlert(r.category) ? ' alert' : ''),
        title: 'Clique para ver só esta categoria',
        onmousemove: (e) => showTooltip(e, text),
        onmouseleave: hideTooltip,
        onclick: () => filterByText(catLabel(r.category)),
      },
        el('span', { class: 'label', title: catLabel(r.category) }, catLabel(r.category)),
        el('div', { class: 'track' }, el('div', { class: 'fill', style: `width:${(r.minutes / max) * 100}%` })),
        el('span', { class: 'value' }, fmtMinutes(r.minutes))
      );
    })
  );
}

// Aplica um texto na busca e atualiza (usado pelo clique nas categorias).
function filterByText(text) {
  const s = $('#f-search');
  if (!s) return;
  s.value = text;
  state.livePage = 1;
  hideTooltip();
  refresh();
  toast(`Filtrando por "${text}"`);
}

function renderSites(rows) {
  const tbody = $('#sites-table').tBodies[0];
  const filtered = rows.filter((r) =>
    searchFilter(r.site) ||
    searchFilter(r.sample_domain) ||
    searchFilter(catLabel(r.category)) ||
    r.devices.some((ip) => searchFilter(deviceName(ip)))
  );
  state.lastSites = filtered; // usado pela exportação CSV
  if (!filtered.length) {
    tbody.replaceChildren(el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'Nenhum site encontrado para esta busca/período.')));
    return;
  }
  const maxMin = Math.max(1, ...filtered.map((r) => r.minutes));
  tbody.replaceChildren(
    ...filtered.map((r) =>
      el('tr', { class: isAlert(r.category) ? 'is-alert' : null },
        siteCell(r),
        el('td', { class: 'cat-cell cat-' + r.category }, categorySelect(r)),
        el('td', { class: 'priv' }, r.devices.map(deviceName).join(', ')),
        el('td', { class: 'num minutes-cell' },
          el('span', { class: 'min-val' }, r.minutes),
          el('div', { class: 'minbar' }, el('i', { style: `width:${Math.round((r.minutes / maxMin) * 100)}%` }))
        ),
        el('td', {}, fmtWhen(r.last_seen)),
        el('td', {}, blockButton(r))
      )
    )
  );
}

async function loadOverview() {
  const d = await api('/api/dashboard?' + filterQuery());
  renderTiles(d.summary, d.summaryPrev);
  renderInsight(d.summary);
  renderAlerts(d.alerts);
  renderTimeline(d.timeline);
  renderCategories(d.categories);
  renderSites(d.topSites);
}

// ---------- registro ----------

async function loadLive() {
  const search = ($('#f-search')?.value || '').trim();
  const params = filterQuery() + `&page=${state.livePage}` + (search ? `&q=${encodeURIComponent(search)}` : '');
  const data = await api('/api/recent?' + params);

  // O servidor pode ter ajustado a página (ex.: busca com menos resultados).
  if (data.page && data.page !== state.livePage) state.livePage = data.page;

  const tbody = $('#live-table').tBodies[0];
  if (!data.rows.length) {
    tbody.replaceChildren(el('tr', {}, el('td', { colspan: 5, class: 'muted' },
      search ? 'Nenhum acesso encontrado para esta busca.' : 'Nenhum acesso registrado para este filtro.')));
    renderPager(data);
    return;
  }
  // Destaque transitório para logs NOVOS (só na 1ª página, sem busca).
  const prevMax = state.liveMaxTs || 0;
  const firstLoad = prevMax === 0;
  const onLatest = state.livePage === 1 && !search;

  tbody.replaceChildren(
    ...data.rows.map((r) => {
      const isNew = onLatest && !firstLoad && r.ts > prevMax;
      const cls = [isAlert(r.category) ? 'is-alert' : '', isNew ? 'new-row' : ''].filter(Boolean).join(' ');
      return el('tr', { class: cls || null },
        el('td', {}, fmtWhen(r.ts)),
        el('td', { class: 'priv' }, deviceName(r.client_ip)),
        el('td', { class: 'site' }, r.domain),
        el('td', {}, categoryTag(r.category)),
        el('td', {}, r.blocked ? el('span', { class: 'tag blocked' }, 'bloqueado') : el('span', { class: 'tag' }, 'permitido'))
      );
    })
  );
  if (onLatest) {
    const maxInData = Math.max(...data.rows.map((r) => r.ts));
    state.liveMaxTs = Math.max(prevMax, maxInData);
  }
  renderPager(data);
}

// Abas de página estilo Gmail: « 1 2 3 … », com janela ao redor da atual.
function renderPager({ page = 1, pages = 1, total = 0 }) {
  const box = $('#live-pager');
  if (!box) return;
  if (pages <= 1) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  box.hidden = false;
  const go = (p) => {
    state.livePage = Math.min(Math.max(1, p), pages);
    loadLive();
  };
  const btn = (label, p, { active = false, disabled = false } = {}) =>
    el('button', {
      class: 'pager-btn' + (active ? ' active' : ''),
      type: 'button',
      disabled: disabled || null,
      onclick: disabled || active ? null : () => go(p),
    }, label);

  const nums = [];
  const windowSize = 2;
  const from = Math.max(1, page - windowSize);
  const to = Math.min(pages, page + windowSize);
  if (from > 1) { nums.push(1); if (from > 2) nums.push('…'); }
  for (let p = from; p <= to; p++) nums.push(p);
  if (to < pages) { if (to < pages - 1) nums.push('…'); nums.push(pages); }

  box.replaceChildren(
    el('span', { class: 'pager-info' }, `${total} registros`),
    btn('‹', page - 1, { disabled: page <= 1 }),
    ...nums.map((n) => (n === '…' ? el('span', { class: 'pager-gap' }, '…') : btn(String(n), n, { active: n === page }))),
    btn('›', page + 1, { disabled: page >= pages })
  );
}

// ---------- aparelhos ----------

async function loadDevices() {
  state.devices = await api('/api/devices');
  const select = $('#f-device');
  const current = select.value;
  select.replaceChildren(
    el('option', { value: '' }, 'Todos os aparelhos'),
    ...state.devices.map((d) => el('option', { value: d.ip, selected: d.ip === current }, (d.name ? `${d.name} (${d.ip})` : d.ip)))
  );
  $('#no-devices').hidden = state.devices.length > 0;

  if (state.tab !== 'devices') return;
  $('#devices-table').tBodies[0].replaceChildren(
    ...(state.devices.length
      ? state.devices.map((d) => {
          const input = el('input', { type: 'text', value: d.name || '', placeholder: 'Nome para identificar', maxlength: 60 });
          const save = el('button', { class: 'btn', onclick: async () => {
            await api('/api/devices', { method: 'PATCH', body: { ip: d.ip, name: input.value } });
            loadDevices();
          } }, 'Salvar');
          const del = el('button', { class: 'row-del', title: 'Remover este aparelho e seu histórico', 'aria-label': 'Remover aparelho', onclick: () => removeDevice(d) }, svgIcon('i-trash'));
          return el('tr', {},
            el('td', {}, input, ' ', save),
            el('td', { class: 'priv' }, d.ip),
            el('td', { class: 'priv' }, d.mac || '—'),
            el('td', { class: 'num' }, d.queries_24h),
            el('td', {}, fmtWhen(d.last_seen)),
            el('td', {}, del)
          );
        })
      : [el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'Nenhum aparelho usou o monitor ainda.'))])
  );
}

async function removeDevice(d) {
  const nome = d.name || d.ip;
  if (!confirm(`Remover "${nome}" e todo o histórico de acessos deste aparelho?\n\nEsta ação não pode ser desfeita.`)) return;
  await api('/api/devices', { method: 'DELETE', body: { ip: d.ip } });
  loadDevices();
}

// ---------- bloqueios ----------

async function loadBlocked() {
  await loadKeywords();
  const rows = await api('/api/blocked');
  $('#blocked-empty').hidden = rows.length > 0;
  $('#blocked-table').hidden = rows.length === 0;
  $('#blocked-table').tBodies[0].replaceChildren(
    ...rows.map((r) =>
      el('tr', {}, el('td', { class: 'site' }, r.site), el('td', {}, categoryTag(r.category)),
        el('td', {}, el('button', { class: 'btn', onclick: () => setBlocked(r.site, false) }, 'Desbloquear')))
    )
  );
}

// ---------- bloqueio por palavra ----------

let keywords = [];

async function loadKeywords() {
  const c = await api('/api/config');
  keywords = Array.isArray(c.blockKeywords) ? c.blockKeywords : [];
  renderKeywords();
}

function renderKeywords() {
  const box = $('#keyword-list');
  if (!box) return;
  $('#keyword-empty').hidden = keywords.length > 0;
  box.replaceChildren(
    ...keywords.map((k) =>
      el('span', { class: 'kw-chip' }, k,
        el('button', { type: 'button', title: `Remover "${k}"`, 'aria-label': `Remover ${k}`, onclick: () => removeKeyword(k) }, '×'))
    )
  );
}

async function saveKeywords() {
  const c = await api('/api/config', { method: 'PUT', body: { blockKeywords: keywords } });
  keywords = c.blockKeywords || [];
  renderKeywords();
}

async function addKeyword(word) {
  const w = word.trim().toLowerCase();
  if (w.length < 2) return;
  if (keywords.includes(w)) return;
  keywords = [...keywords, w];
  await saveKeywords();
  toast(`Palavra "${w}" adicionada`);
}

async function removeKeyword(word) {
  keywords = keywords.filter((k) => k !== word);
  await saveKeywords();
  toast(`Palavra "${word}" removida`);
}

(function bindKeywordForm() {
  const form = document.getElementById('keyword-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('keyword-input');
    await addKeyword(input.value);
    input.value = '';
    input.focus();
  });
})();

// ---------- configurações ----------

async function loadSettings() {
  const c = await api('/api/config');
  const f = $('#settings-form');
  f.autoBlockAlerts.checked = !!c.autoBlockAlerts;
  f.blockAds.checked = !!c.blockAds;
  f.forceSafeSearch.checked = !!c.forceSafeSearch;
  f.onlineCheck.checked = !!c.onlineCheck;
  f.upstreamDns.value = (c.upstreamDns || []).join(', ');
  f.retentionDays.value = c.retentionDays || 30;
}

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const msg = $('#settings-msg');
  msg.textContent = 'Salvando...';
  try {
    await api('/api/config', {
      method: 'PUT',
      body: {
        autoBlockAlerts: f.autoBlockAlerts.checked,
        blockAds: f.blockAds.checked,
        forceSafeSearch: f.forceSafeSearch.checked,
        onlineCheck: f.onlineCheck.checked,
        upstreamDns: f.upstreamDns.value.split(','),
        retentionDays: Number(f.retentionDays.value),
      },
    });
    await loadSettings();
    msg.textContent = 'Configurações salvas com sucesso.';
    toast('Configurações salvas');
    setTimeout(() => { msg.textContent = ''; }, 4000);
  } catch (err) {
    msg.textContent = 'Erro ao salvar: ' + err.message;
    toast('Erro ao salvar as configurações', 'danger');
  }
});

// Limpar todo o histórico de acessos (ação destrutiva).
document.getElementById('btn-clear-logs')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const msg = document.getElementById('clear-msg');
  if (!confirm('Apagar TODO o histórico de acessos?\n\nOs sites, horários e alertas registrados serão removidos permanentemente. As classificações e os nomes dos aparelhos são mantidos.\n\nEsta ação não pode ser desfeita.')) return;
  btn.disabled = true;
  if (msg) msg.textContent = 'Limpando...';
  try {
    const r = await api('/api/logs', { method: 'DELETE' });
    if (msg) msg.textContent = '';
    toast(`Histórico limpo (${r.cleared || 0} registros)`);
    state.livePage = 1;
    state.liveMaxTs = 0;
    refresh();
  } catch (err) {
    if (msg) msg.textContent = 'Erro: ' + err.message;
    toast('Não foi possível limpar o histórico', 'danger');
  } finally {
    btn.disabled = false;
  }
});

// Exporta a lista de sites atual para CSV (abre no Excel).
document.getElementById('btn-export-sites')?.addEventListener('click', () => {
  const rows = state.lastSites || [];
  if (!rows.length) { toast('Nada para exportar neste período', 'danger'); return; }
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const header = ['Site', 'Categoria', 'Aparelhos', 'Minutos', 'Primeiro acesso', 'Último acesso', 'Bloqueado'];
  const lines = [header.map(esc).join(';')];
  for (const r of rows) {
    lines.push([
      r.site,
      catLabel(r.category),
      (r.devices || []).map(deviceName).join(' / '),
      r.minutes,
      r.first_seen ? new Date(r.first_seen).toLocaleString('pt-BR') : '',
      r.last_seen ? new Date(r.last_seen).toLocaleString('pt-BR') : '',
      r.blocked ? 'Sim' : 'Não',
    ].map(esc).join(';'));
  }
  const csv = '﻿' + lines.join('\r\n'); // BOM p/ acentos no Excel
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `monitor-sites-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Relatório CSV baixado');
});

// Exporta o registro completo do período (servidor) em CSV.
document.getElementById('btn-export-live')?.addEventListener('click', () => {
  const search = ($('#f-search')?.value || '').trim();
  const params = filterQuery() + (search ? `&q=${encodeURIComponent(search)}` : '');
  const a = el('a', { href: '/api/export.csv?' + params, download: '' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('Gerando o CSV do registro...');
});

// ---------- status e navegação ----------

function copyIpToClipboard(ip, btn) {
  if (!ip) return;
  navigator.clipboard.writeText(ip).then(() => {
    const html = btn.innerHTML;
    btn.innerHTML = '<svg class="icon"><use href="#i-shield-check"/></svg> Copiado!';
    setTimeout(() => { btn.innerHTML = html; }, 1800);
  }).catch(() => {
    prompt('Copie o endereço:', ip);
  });
}

async function loadStatus() {
  const pill = $('#dns-status');
  try {
    const s = await api('/api/status');
    state.categories = s.categories;
    state.addresses = s.addresses;

    // Alerta em tempo real: avisa (em qualquer aba) quando surge um NOVO acesso
    // inadequado. Na primeira carga só memoriza, para não notificar o que já existia.
    if (Array.isArray(s.alertSites)) {
      if (!state.seenAlerts) {
        state.seenAlerts = new Set(s.alertSites);
      } else {
        for (const site of s.alertSites) {
          if (!state.seenAlerts.has(site)) {
            state.seenAlerts.add(site);
            toast(`Alerta: acesso inadequado a "${site}"`, 'danger');
          }
        }
      }
    }

    const firstIp = (s.addresses[0] && s.addresses[0].address) || '127.0.0.1';
    
    document.querySelectorAll('.ip-primary').forEach((n) => (n.textContent = firstIp));

    const copyBtn = document.getElementById('btn-copy-ip-top');
    if (copyBtn) copyBtn.onclick = () => copyIpToClipboard(firstIp, copyBtn);

    // Status do monitoramento em tempo real
    const liveBox = document.getElementById('live-connect-status');
    const statusText = document.getElementById('connect-status-text');
    const statusSub = document.getElementById('connect-status-sub');
    if (liveBox && statusText && statusSub) {
      if (state.devices.length > 0) {
        liveBox.className = 'connect-status-box ok';
        const nomes = state.devices.map((d) => d.name || d.ip).join(', ');
        statusText.textContent = `Monitorando (${nomes})`;
        statusSub.textContent = 'O monitoramento está ativo. Acompanhe os acessos na aba "Visão geral".';
      } else {
        liveBox.className = 'connect-status-box waiting';
        statusText.textContent = 'Procurando aparelhos na rede...';
        statusSub.textContent = 'Assim que um aparelho navegar, ele aparece aqui.';
      }
    }

    const lastActivity = Math.max(s.sni?.lastAt || 0, s.dns?.lastQueryAt || 0) || null;
    pill.className = 'pill ok';
    pill.textContent = lastActivity ? `Protegendo · ${fmtAgo(lastActivity)}` : 'Protegendo · aguardando';
    if (lastActivity) pill.title = `Última atividade na rede às ${fmtTime(lastActivity)}`;
  } catch {
    pill.className = 'pill err';
    pill.textContent = 'Monitor desligado';
  }
}

const loaders = { overview: loadOverview, live: loadLive, devices: async () => {}, blocked: loadBlocked, settings: loadSettings, setup: async () => {} };

async function refresh() {
  try {
    await loadDevices();
    await loadStatus();
    await loaders[state.tab]();
  } catch (err) {
    console.error(err);
  }
}

const TAB_TITLES = { overview: 'Visão geral', live: 'Registro ao vivo', devices: 'Aparelhos', blocked: 'Bloqueios', settings: 'Configurações', setup: 'Como funciona' };

function showTab(tab) {
  if (tab === 'live' && state.tab !== 'live') state.livePage = 1; // entra sempre na página 1
  state.tab = tab;
  document.querySelectorAll('.nav-item').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = p.id !== 'tab-' + tab));
  $('#filters').hidden = !['overview', 'live'].includes(tab);
  const pt = document.getElementById('page-title');
  if (pt) pt.textContent = TAB_TITLES[tab] || '';
  closeSidebar();
  refresh();
}

document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// --- menu lateral no celular ---
function closeSidebar() {
  const sb = document.getElementById('sidebar');
  const sc = document.getElementById('sidebar-scrim');
  if (sb) sb.classList.remove('open');
  if (sc) sc.hidden = true;
}
document.getElementById('menu-toggle')?.addEventListener('click', () => {
  if (matchMedia('(max-width: 900px)').matches) {
    // Celular: abre/fecha a gaveta com o fundo escurecido.
    const sb = document.getElementById('sidebar');
    const open = sb.classList.toggle('open');
    const sc = document.getElementById('sidebar-scrim');
    if (sc) sc.hidden = !open;
  } else {
    // Desktop: recolhe/expande a barra lateral.
    document.querySelector('.app')?.classList.toggle('nav-collapsed');
  }
});
document.getElementById('sidebar-scrim')?.addEventListener('click', closeSidebar);

// --- tema claro/escuro ---
function effectiveDark() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t) return t === 'dark';
  return matchMedia('(prefers-color-scheme: dark)').matches;
}
function updateThemeIcon() {
  const use = document.querySelector('#theme-toggle use');
  if (use) use.setAttribute('href', effectiveDark() ? '#i-sun' : '#i-moon');
}
function applyTheme(t) {
  if (t) document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
  updateThemeIcon();
}
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('mi-theme'); } catch {}
  applyTheme(saved === 'dark' || saved === 'light' ? saved : null);
})();
document.getElementById('theme-toggle')?.addEventListener('click', () => {
  const next = effectiveDark() ? 'light' : 'dark';
  try { localStorage.setItem('mi-theme', next); } catch {}
  applyTheme(next);
});

// Rola até um cartão e o destaca por um instante (usado pelos indicadores no topo).
function jumpTo(id) {
  const card = document.getElementById(id);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  card.classList.remove('jump-flash');
  void card.offsetWidth; // reinicia a animação
  card.classList.add('jump-flash');
  setTimeout(() => card.classList.remove('jump-flash'), 1200);
}
document.querySelectorAll('.tile[data-jump]').forEach((tile) => {
  tile.addEventListener('click', () => jumpTo(tile.getAttribute('data-jump')));
});

// --- modo privacidade: borra dados sensíveis (IP etc.) para gravar vídeos ---
function setPrivacy(on) {
  document.documentElement.classList.toggle('privacy', on);
  const btn = document.getElementById('privacy-toggle');
  if (btn) {
    btn.classList.toggle('active', on);
    const use = btn.querySelector('use');
    if (use) use.setAttribute('href', on ? '#i-eye-off' : '#i-eye');
    btn.setAttribute('aria-pressed', String(on));
  }
  try { localStorage.setItem('mi-privacy', on ? '1' : '0'); } catch {}
}
document.getElementById('privacy-toggle')?.addEventListener('click', () => {
  setPrivacy(!document.documentElement.classList.contains('privacy'));
});
(function initPrivacy() {
  let v = '0';
  try { v = localStorage.getItem('mi-privacy') || '0'; } catch {}
  setPrivacy(v === '1');
})();
document.querySelectorAll('[data-goto]').forEach((a) =>
  a.addEventListener('click', (e) => {
    e.preventDefault();
    showTab(a.dataset.goto);
  })
);
// Mudar período/aparelho/anúncios recomeça da página 1.
['#f-period', '#f-device', '#f-ads'].forEach((s) => {
  const node = $(s);
  if (node) node.addEventListener('input', () => { state.livePage = 1; refresh(); });
});
// Busca: recomeça da página 1 e espera a digitação parar (debounce).
let searchTimer = null;
const searchEl = $('#f-search');
if (searchEl) searchEl.addEventListener('input', () => {
  state.livePage = 1;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refresh, 300);
});

// Atualiza sozinho nas telas de acompanhamento, mas não enquanto o usuário
// está digitando/selecionando, nem quando está navegando em páginas antigas
// ou buscando (para não bagunçar a leitura).
setInterval(() => {
  const active = document.activeElement;
  const busy = active && (active.closest('main') || active.closest('#filters')) && ['SELECT', 'INPUT'].includes(active.tagName);
  if (busy) return;
  if (state.tab === 'live') {
    const searching = ($('#f-search')?.value || '').trim();
    if (state.livePage === 1 && !searching) refresh();
  } else if (state.tab === 'overview' || state.tab === 'setup') {
    refresh();
  }
}, 4000);

// Atalho de teclado: "/" foca a busca; Esc limpa a busca.
document.addEventListener('keydown', (e) => {
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  const search = document.getElementById('f-search');
  const filters = document.getElementById('filters');
  if (e.key === '/' && !typing && search && filters && !filters.hidden) {
    e.preventDefault();
    search.focus();
  } else if (e.key === 'Escape' && document.activeElement === search && search.value) {
    search.value = '';
    state.livePage = 1;
    refresh();
  } else if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && /^[1-6]$/.test(e.key)) {
    // Teclas 1–6: pula direto para cada aba (navegação rápida pelo teclado).
    const order = ['overview', 'live', 'devices', 'blocked', 'settings', 'setup'];
    const tab = order[parseInt(e.key, 10) - 1];
    if (tab) { e.preventDefault(); showTab(tab); }
  }
});

// ---------- paleta de comandos (Ctrl+K) ----------
const cmdk = {
  box: document.getElementById('cmdk'),
  input: document.getElementById('cmdk-input'),
  list: document.getElementById('cmdk-list'),
  items: [],
  sel: 0,
};
function cmdkCommands() {
  return [
    { icon: 'i-grid', label: 'Visão geral', hint: 'Aba', kw: 'overview inicio dashboard resumo', run: () => showTab('overview') },
    { icon: 'i-activity', label: 'Registro ao vivo', hint: 'Aba', kw: 'live logs acessos agora', run: () => showTab('live') },
    { icon: 'i-monitor', label: 'Aparelhos', hint: 'Aba', kw: 'devices dispositivos celulares', run: () => showTab('devices') },
    { icon: 'i-ban', label: 'Bloqueios', hint: 'Aba', kw: 'blocked palavra proibir', run: () => showTab('blocked') },
    { icon: 'i-settings', label: 'Configurações', hint: 'Aba', kw: 'settings opcoes ajustes', run: () => showTab('settings') },
    { icon: 'i-book', label: 'Como funciona', hint: 'Aba', kw: 'ajuda help setup', run: () => showTab('setup') },
    { icon: 'i-moon', label: 'Alternar tema claro/escuro', hint: 'Ação', kw: 'tema theme escuro claro dark light', run: () => document.getElementById('theme-toggle')?.click() },
    { icon: 'i-eye', label: 'Ocultar/mostrar dados sensíveis', hint: 'Ação', kw: 'privacidade privacy ip borrar video', run: () => document.getElementById('privacy-toggle')?.click() },
    { icon: 'i-printer', label: 'Imprimir / salvar relatório (PDF)', hint: 'Ação', kw: 'imprimir print pdf relatorio salvar papel', run: () => printReport() },
    { icon: 'i-trash', label: 'Começar do zero (limpar histórico)', hint: 'Ação', kw: 'limpar apagar historico zerar reset', run: () => { showTab('settings'); setTimeout(() => document.getElementById('btn-clear-logs')?.click(), 200); } },
  ];
}
function cmdkRender() {
  if (!cmdk.list) return;
  const raw = cmdk.input.value.trim();
  const q = raw.toLowerCase();
  let cmds = cmdkCommands();
  if (q) cmds = cmds.filter((c) => (c.label + ' ' + c.kw).toLowerCase().includes(q));
  const items = cmds.slice();
  if (raw) items.push({ icon: 'i-search', label: `Pesquisar "${raw}" no registro`, hint: 'Busca', run: () => { showTab('live'); const s = $('#f-search'); if (s) { s.value = raw; state.livePage = 1; refresh(); } } });
  cmdk.items = items;
  cmdk.sel = 0;
  if (!items.length) { cmdk.list.replaceChildren(el('li', { class: 'cmdk-empty' }, 'Nada encontrado')); return; }
  cmdk.list.replaceChildren(...items.map((c, i) =>
    el('li', { class: 'cmdk-item' + (i === 0 ? ' sel' : ''), role: 'option', onmousemove: () => cmdkSelect(i), onclick: () => cmdkRun(i) },
      svgIcon(c.icon), el('span', { class: 'cmdk-label' }, c.label), el('span', { class: 'cmdk-hint' }, c.hint || ''))
  ));
}
function cmdkSelect(i) {
  cmdk.sel = i;
  [...cmdk.list.children].forEach((li, idx) => li.classList.toggle('sel', idx === i));
}
function cmdkRun(i) {
  const c = cmdk.items[i];
  cmdkClose();
  if (c && c.run) c.run();
}
function cmdkOpen() {
  if (!cmdk.box) return;
  cmdk.box.hidden = false;
  cmdk.input.value = '';
  cmdkRender();
  requestAnimationFrame(() => cmdk.input.focus());
}
function cmdkClose() { if (cmdk.box) cmdk.box.hidden = true; }
if (cmdk.box) {
  cmdk.input.addEventListener('input', cmdkRender);
  cmdk.input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cmdkSelect(Math.min(cmdk.sel + 1, cmdk.items.length - 1)); cmdk.list.children[cmdk.sel]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkSelect(Math.max(cmdk.sel - 1, 0)); cmdk.list.children[cmdk.sel]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') { e.preventDefault(); cmdkRun(cmdk.sel); }
    else if (e.key === 'Escape') { e.preventDefault(); cmdkClose(); }
  });
  cmdk.box.addEventListener('click', (e) => { if (e.target === cmdk.box) cmdkClose(); });
}
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    if (cmdk.box && cmdk.box.hidden) cmdkOpen(); else cmdkClose();
  }
});

const validTabs = ['overview', 'live', 'devices', 'blocked', 'settings', 'setup'];
const initialTab = (location.hash || '').replace('#', '');
showTab(validTabs.includes(initialTab) ? initialTab : 'overview');
