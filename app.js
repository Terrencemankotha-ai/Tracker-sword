/* Abraham Tracker Sword - phone app */
(() => {
  'use strict';
  // Web build reads data next to the page; the phone apps read it from the published site (set in config.js).
  const BUNDLED = 'data/inflation.json';
  const DATA_URL = window.ATS_DATA_URL || BUNDLED;
  const CAP = window.Capacitor;
  const NATIVE = !!(CAP && CAP.isNativePlatform && CAP.isNativePlatform());
  const LN = NATIVE && CAP.Plugins ? CAP.Plugins.LocalNotifications : null;
  if (NATIVE) document.documentElement.classList.add('native');
  const POLL_MS = 60 * 1000;          // check every minute while the app is open
  const STALE_MIN = 90;               // updater runs every 30 min; warn if quiet for longer
  const CODES = ['USD', 'EUR', 'JPY', 'GBP', 'AUD'];
  const COLORS = { USD: 'var(--c1)', EUR: 'var(--c2)', JPY: 'var(--c3)', GBP: 'var(--c4)', AUD: 'var(--c5)' };
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  let doc = store.get('ats:doc', null);
  let lastOk = 0;
  let hidden = new Set(store.get('ats:hidden', []));
  let timer = null;

  // ---------- formatting
  const pct = (v) => (v === null || v === undefined || isNaN(v)) ? '—' : (+v).toFixed(1) + '%';
  const pts = (v) => Math.abs(v).toFixed(1) + ' pts';
  const pm = (s) => { const [y, m] = s.split('-').map(Number); return { y, m }; };
  const fMonth = (s) => { const { y, m } = pm(s); return MON[m - 1] + ' ' + y; };
  const fMonthShort = (s) => { const { y, m } = pm(s); return MON[m - 1] + " '" + String(y).slice(2); };
  const fDate = (s) => { const d = new Date(s + 'T00:00:00Z'); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); };
  const daysTo = (s) => {
    const t = Date.parse(s + 'T00:00:00Z'); if (isNaN(t)) return null;
    const n = new Date(); const today = Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
    return Math.round((t - today) / 864e5);
  };
  const when = (s) => { const n = daysTo(s); if (n === null) return ''; if (n < 0) return 'due, checking'; if (n === 0) return 'today'; if (n === 1) return 'tomorrow'; return 'in ' + n + ' days'; };
  const ago = (iso) => {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

  // ---------- data
  async function load(manual) {
    const btn = $('refresh');
    if (manual) btn.classList.add('spin');
    try {
      const r = await fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const next = await r.json();
      const fresh = diff(doc, next);
      doc = next; lastOk = Date.now();
      store.set('ats:doc', doc);
      render(fresh);
      if (fresh.length) announce(fresh);
      else if (manual) toast('Up to date. No new releases.');
    } catch (e) {
      lastOk = 0;
      // First launch with no connection: fall back to the figures bundled inside the app.
      if (!doc && DATA_URL !== BUNDLED) {
        try {
          const b = await fetch(BUNDLED, { cache: 'no-store' });
          if (b.ok) { doc = await b.json(); store.set('ats:doc', doc); }
        } catch { /* nothing bundled */ }
      }
      if (doc) render([]);
      if (manual) toast('Offline. Showing saved figures.');
    } finally {
      btn.classList.remove('spin');
      status();
    }
  }

  function diff(prev, next) {
    if (!prev) return [];
    const seen = store.get('ats:seen', {});
    const out = [];
    for (const r of next.latest) {
      const key = r.period + '|' + r.headline;
      const old = seen[r.code] || (prev.latest.find((x) => x.code === r.code) || {});
      const oldKey = typeof old === 'string' ? old : old.period + '|' + old.headline;
      if (oldKey && oldKey !== key) out.push(r);
    }
    return out;
  }

  function markSeen() {
    if (!doc) return;
    const seen = {};
    doc.latest.forEach((r) => { seen[r.code] = r.period + '|' + r.headline; });
    store.set('ats:seen', seen);
  }

  function announce(rows) {
    const msg = rows.map((r) => `${r.code} ${fMonth(r.period)}: ${pct(r.headline)}`).join(' · ');
    toast('New CPI ▸ ' + msg);
    if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
    if (LN) {
      LN.schedule({ notifications: [{ id: Date.now() % 2147483647, title: 'New inflation figure', body: msg }] }).catch(() => {});
    } else if ('Notification' in window && Notification.permission === 'granted' && navigator.serviceWorker) {
      navigator.serviceWorker.ready.then((reg) => reg.showNotification('New inflation figure', {
        body: msg, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: 'cpi', renotify: true,
      })).catch(() => {});
    }
    markSeen();
  }

  function status() {
    const live = $('live'), txt = $('live-text');
    live.className = 'live';
    if (!doc) { live.classList.add('off'); txt.textContent = 'No connection yet. Pull figures when online.'; return; }
    const quietMin = (Date.now() - Date.parse(doc.checked_at)) / 6e4;
    if (!lastOk) { live.classList.add('off'); txt.textContent = 'Offline · saved figures, checked ' + ago(doc.checked_at); return; }
    if (quietMin > STALE_MIN) { live.classList.add('stale'); txt.textContent = 'Live · sources last checked ' + ago(doc.checked_at) + ' (updater may be paused)'; return; }
    live.classList.add('ok');
    txt.textContent = 'Live · sources checked ' + ago(doc.checked_at) + ' · last new figure ' + ago(doc.updated_at);
  }

  // ---------- render
  function render(fresh) {
    if (!doc) return;
    const rows = CODES.map((c) => doc.latest.find((r) => r.code === c)).filter(Boolean);
    const freshCodes = new Set(fresh.map((r) => r.code));
    renderTake(rows);
    renderCards(rows, freshCodes);
    renderLegend();
    renderChart();
    renderCalendar(rows);
    renderLog();
    const notes = $('notes'); notes.replaceChildren();
    rows.filter((r) => r.note).forEach((r) => notes.append(el('li', '', r.code + ': ' + r.note)));
  }

  function renderTake(rows) {
    const hot = rows.reduce((a, b) => (b.headline > a.headline ? b : a));
    const cool = rows.reduce((a, b) => (b.headline < a.headline ? b : a));
    const above = rows.filter((r) => r.headline > r.target_high).length;
    const rising = rows.filter((r) => r.previous != null && r.headline > r.previous).length;
    const p = $('take-text'); p.replaceChildren();
    const b = (t) => el('b', '', t);
    p.append(b(hot.code), ' is running hottest at ', b(pct(hot.headline)), ' and ', b(cool.code), ' coolest at ', b(pct(cool.headline)), '. ',
      b(String(above)), ` of the ${rows.length} are above their central bank's target, and `, b(String(rising)), ' rose in their latest release.');
  }

  function renderCards(rows, freshCodes) {
    const wrap = $('cards'); wrap.replaceChildren();
    for (const r of rows) {
      const c = el('article', 'card' + (freshCodes.has(r.code) ? ' fresh' : '')); c.id = 'card-' + r.code.toLowerCase();
      if (freshCodes.has(r.code)) c.append(el('span', 'badge', 'NEW'));
      const top = el('div', 'card-top'); top.append(el('span', 'code', r.code), el('span', 'econ', r.economy)); c.append(top);
      c.append(el('div', 'big', pct(r.headline)));
      if (r.previous != null) {
        const ch = Math.round((r.headline - r.previous) * 10) / 10;
        const { y, m } = pm(r.period); const prevM = MON[(m + 10) % 12];
        const d = el('div', 'delta ' + (ch > 0 ? 'up' : ch < 0 ? 'down' : 'flat'), (ch > 0 ? '▲ ' : ch < 0 ? '▼ ' : '■ ') + pts(ch) + ' vs ' + prevM + ' (' + pct(r.previous) + ')');
        c.append(d);
      }
      const over = Math.round((r.headline - r.target_high) * 10) / 10;
      let gapTxt, gapCls = 'gap';
      if (over > 0) { gapTxt = over.toFixed(1) + ' pts above target · ' + r.target_note; gapCls += ' over'; }
      else if (r.headline >= r.target_low) gapTxt = 'At target · ' + r.target_note;
      else gapTxt = (r.target_low - r.headline).toFixed(1) + ' pts below target · ' + r.target_note;
      c.append(el('div', gapCls, gapTxt));
      const dl = el('dl');
      const per = el('dd', '', fMonth(r.period));
      if (r.status && r.status !== 'Final') per.append(el('span', 'flash', ' · ' + r.status.toLowerCase()));
      const core = el('dd', '', pct(r.core)); core.title = r.core_label || '';
      const nx = el('dd', '', r.next_release ? fDate(r.next_release) : '—');
      dl.append(el('dt', '', 'Month'), per, el('dt', '', 'Core'), core, el('dt', '', 'Next'), nx);
      c.append(dl);
      wrap.append(c);
    }
  }

  function renderLegend() {
    const lg = $('legend'); lg.replaceChildren();
    for (const c of CODES) {
      const b = el('button'); b.type = 'button'; b.setAttribute('aria-pressed', String(!hidden.has(c)));
      const sw = el('i'); sw.style.background = COLORS[c]; b.append(sw, c);
      b.onclick = () => { hidden.has(c) ? hidden.delete(c) : hidden.add(c); if (hidden.size === CODES.length) hidden.delete(c); store.set('ats:hidden', [...hidden]); renderLegend(); renderChart(); };
      lg.append(b);
    }
  }

  const NS = 'http://www.w3.org/2000/svg';
  const s = (tag, attrs, parent) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); if (parent) parent.append(n); return n; };

  function renderChart() {
    const box = $('chart'); box.replaceChildren();
    const series = CODES.filter((c) => !hidden.has(c) && doc.history[c]).map((c) => ({
      code: c, color: COLORS[c], pts: Object.entries(doc.history[c]).map(([m, v]) => ({ m, v: +v })).sort((a, b) => a.m.localeCompare(b.m)),
    })).filter((x) => x.pts.length);
    if (!series.length) { box.textContent = '—'; return; }
    const months = [...new Set(series.flatMap((x) => x.pts.map((p) => p.m)))].sort();
    const W = Math.max(300, box.clientWidth || 600), H = W < 500 ? 260 : 320;
    const mt = 12, mb = 26, ml = 34, mr = 70;
    const all = series.flatMap((x) => x.pts.map((p) => p.v));
    const lo = Math.min(0, Math.floor(Math.min(...all))), hi = Math.ceil(Math.max(2, ...all) + 0.4);
    const xi = (m) => ml + (months.length < 2 ? 0 : months.indexOf(m) / (months.length - 1)) * (W - ml - mr);
    const y = (v) => mt + (1 - (v - lo) / (hi - lo)) * (H - mt - mb);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Headline inflation, last 12 months' }, box);
    const stepY = hi - lo > 6 ? 2 : 1;
    for (let t = lo; t <= hi; t += stepY) {
      s('line', { x1: ml, x2: W - mr, y1: y(t), y2: y(t), stroke: 'var(--line)' }, svg);
      s('text', { x: ml - 6, y: y(t), dy: '0.32em', 'text-anchor': 'end', 'font-size': 11, fill: 'var(--muted)' }, svg).textContent = t + '%';
    }
    const step = W < 520 ? 3 : 2;
    months.forEach((m, i) => { if ((months.length - 1 - i) % step === 0) s('text', { x: xi(m), y: H - 7, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--muted)' }, svg).textContent = fMonthShort(m); });
    s('line', { x1: ml, x2: W - mr, y1: y(2), y2: y(2), stroke: 'var(--muted)', 'stroke-dasharray': '4 4', opacity: 0.7 }, svg);
    for (const x of series) {
      // break the line where a month is missing (e.g. US Oct 2025)
      let d = '', prevIdx = -2;
      x.pts.forEach((p) => { const i = months.indexOf(p.m); d += (i === prevIdx + 1 ? 'L' : 'M') + xi(p.m).toFixed(1) + ',' + y(p.v).toFixed(1); prevIdx = i; });
      s('path', { d, fill: 'none', stroke: x.color, 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg);
      const last = x.pts[x.pts.length - 1];
      s('circle', { cx: xi(last.m), cy: y(last.v), r: 3, fill: x.color }, svg);
    }
    const labs = series.map((x) => { const l = x.pts[x.pts.length - 1]; return { x, l, yy: y(l.v) }; }).sort((a, b) => a.yy - b.yy);
    for (let i = 1; i < labs.length; i++) if (labs[i].yy - labs[i - 1].yy < 14) labs[i].yy = labs[i - 1].yy + 14;
    const over = labs.length ? labs[labs.length - 1].yy - (H - mb) : 0;
    if (over > 0) labs.forEach((d) => { d.yy -= over; });
    labs.forEach((d) => { s('text', { x: xi(d.l.m) + 7, y: d.yy, dy: '0.32em', 'font-size': 11.5, 'font-weight': 650, fill: d.x.color }, svg).textContent = d.x.code + ' ' + pct(d.l.v); });

    const rule = s('line', { y1: mt, y2: H - mb, stroke: 'var(--muted)', display: 'none' }, svg);
    const dots = s('g', {}, svg);
    const tip = el('div', 'tip'); tip.hidden = true; box.append(tip);
    const hit = s('rect', { x: ml, y: mt, width: W - mr - ml, height: H - mb - mt, fill: 'transparent' }, svg);
    const show = (ev) => {
      const rect = svg.getBoundingClientRect(); const scale = rect.width / W;
      const px = (ev.clientX - rect.left) / scale;
      const m = months.reduce((a, b) => (Math.abs(xi(b) - px) < Math.abs(xi(a) - px) ? b : a));
      rule.setAttribute('x1', xi(m)); rule.setAttribute('x2', xi(m)); rule.removeAttribute('display');
      dots.replaceChildren(); tip.replaceChildren(el('div', 't', fMonth(m)));
      for (const x of series) {
        const p = x.pts.find((q) => q.m === m);
        const row = el('div', 'r'); const sw = el('i'); sw.style.background = x.color; row.append(sw, x.code + '  ' + (p ? pct(p.v) : 'n/a')); tip.append(row);
        if (p) s('circle', { cx: xi(m), cy: y(p.v), r: 4, fill: x.color }, dots);
      }
      tip.hidden = false;
      let left = xi(m) * scale + 12; const tw = tip.offsetWidth;
      if (left + tw > rect.width) left = xi(m) * scale - tw - 12;
      tip.style.left = Math.max(0, left) + 'px';
    };
    const hide = () => { rule.setAttribute('display', 'none'); dots.replaceChildren(); tip.hidden = true; };
    hit.addEventListener('pointerdown', show); hit.addEventListener('pointermove', show);
    hit.addEventListener('pointerleave', hide); hit.addEventListener('pointercancel', hide);
  }

  function renderCalendar(rows) {
    const tb = $('cal'); tb.replaceChildren();
    [...rows].sort((a, b) => (a.next_release || '').localeCompare(b.next_release || '')).forEach((r) => {
      const tr = el('tr');
      tr.append(el('td', '', r.code));
      const d = el('td', '', r.next_release ? fDate(r.next_release) : '—');
      if (r.next_release_estimated) d.append(el('span', 'est', 'est.'));
      const n = daysTo(r.next_release); if (n !== null && n <= 3) d.append(el('span', 'soon', when(r.next_release)));
      tr.append(d, el('td', '', r.next_period ? fMonth(r.next_period) : '—'), el('td', 'wide', r.agency));
      tb.append(tr);
    });
  }

  function renderLog() {
    const ul = $('log'); ul.replaceChildren();
    const items = (doc.log || []).slice(-8).reverse();
    if (!items.length) { ul.append(el('li', 'empty', 'No new releases picked up yet. New figures appear here as they land.')); return; }
    for (const it of items) {
      const li = el('li'); li.append(el('span', '', `${it.code} ${fMonth(it.period)}: ${pct(it.headline)}`));
      const t = el('time', '', ago(it.at)); t.dateTime = it.at; li.append(t); ul.append(li);
    }
  }

  // ---------- ui bits
  let toastT;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 6000); }

  function setupNotify() {
    const btn = $('notify'), note = $('notify-note');
    if (LN) {
      const on = () => { btn.disabled = true; btn.textContent = 'Alerts are on'; note.textContent = 'You will be notified when a new CPI figure lands when you open the app or switch back to it.'; };
      const off = () => { btn.disabled = true; btn.textContent = 'Alerts blocked'; note.textContent = 'Allow notifications for Abraham Tracker Sword in your phone settings to turn alerts on.'; };
      const sync = (st) => { if (st.display === 'granted') on(); else if (st.display === 'denied') off(); };
      LN.checkPermissions().then(sync).catch(() => {});
      btn.onclick = () => LN.requestPermissions().then(sync).catch(() => {});
      return;
    }
    const sync = () => {
      if (!('Notification' in window)) { btn.disabled = true; btn.textContent = 'Alerts not supported here'; note.textContent = 'On iPhone, add the app to your Home Screen first, then open it from there to turn on alerts.'; return; }
      if (Notification.permission === 'granted') { btn.disabled = true; btn.textContent = 'Alerts are on'; note.textContent = 'You will be notified when a new CPI figure lands while the app is open or recently used. Android can also check in the background.'; }
      else if (Notification.permission === 'denied') { btn.disabled = true; btn.textContent = 'Alerts blocked'; note.textContent = 'Allow notifications for this app in your phone settings to turn alerts on.'; }
    };
    btn.onclick = async () => { try { await Notification.requestPermission(); } catch { } sync(); registerBackground(); };
    sync();
  }

  async function registerBackground() {
    try {
      const reg = await navigator.serviceWorker.ready;
      if ('periodicSync' in reg) {
        const st = await navigator.permissions.query({ name: 'periodic-background-sync' });
        if (st.state === 'granted') await reg.periodicSync.register('cpi-check', { minInterval: 60 * 60 * 1000 });
      }
    } catch { /* unsupported */ }
  }

  function setupInstall() {
    if (NATIVE) return;
    let ev = null; const btn = $('install');
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); ev = e; btn.hidden = false; });
    btn.onclick = async () => { if (!ev) return; ev.prompt(); await ev.userChoice; ev = null; btn.hidden = true; };
    window.addEventListener('appinstalled', () => { btn.hidden = true; toast('Installed. Open it from your home screen.'); });
  }

  function startPolling() {
    clearInterval(timer);
    timer = setInterval(() => { if (document.visibilityState === 'visible') load(false); else status(); }, POLL_MS);
  }

  // ---------- boot
  if (doc) { render([]); }
  status();
  $('refresh').onclick = () => load(true);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { load(false); markSeenLater(); } });
  window.addEventListener('online', () => load(false));
  window.addEventListener('offline', () => { lastOk = 0; status(); });
  let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => doc && renderChart(), 150); });
  function markSeenLater() { setTimeout(markSeen, 4000); }
  setupNotify(); setupInstall();
  if (!NATIVE && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(registerBackground).catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'data-updated') load(false); });
  }
  load(false).then(() => { if (!store.get('ats:seen', null)) markSeen(); });
  startPolling();
  setInterval(status, 30 * 1000);
})();
