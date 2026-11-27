/* Abraham Sword Tracker - phone app */
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
  const COLORS = { USD: 'var(--c1)', EUR: 'var(--c2)', JPY: 'var(--c3)', GBP: 'var(--c4)', AUD: 'var(--c5)', XAU: 'var(--metal)' };
  const GOLD = ['XAU', 'USD'];
  const isGold = (p) => p[0] === 'XAU';
  const tvSymbol = (p) => isGold(p) ? 'OANDA:XAUUSD' : 'FX:' + p[0] + p[1];
  const NEWS_URL = DATA_URL.replace(/inflation\.json$/, 'news.json');
  // Official release times (local wall-clock time of each statistics office).
  const CPI_TIME = { USD: ['08:30', 'America/New_York'], EUR: ['11:00', 'Europe/Brussels'], JPY: ['08:30', 'Asia/Tokyo'],
    GBP: ['07:00', 'Europe/London'], AUD: ['11:30', 'Australia/Sydney'] };
  const BANK = { USD: 'Fed', EUR: 'ECB', JPY: 'BoJ', GBP: 'BoE', AUD: 'RBA' };
  // Market order for naming pairs (EUR/USD, GBP/JPY, AUD/USD…).
  const RANK = { EUR: 0, GBP: 1, AUD: 2, USD: 3, JPY: 4 };
  const PAIRS = [];
  CODES.forEach((a, i) => CODES.slice(i + 1).forEach((b) => PAIRS.push(RANK[a] < RANK[b] ? [a, b] : [b, a])));
  PAIRS.sort((x, y) => (RANK[x[0]] - RANK[y[0]]) || (RANK[x[1]] - RANK[y[1]]));
  PAIRS.unshift(GOLD);
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
  let news = store.get('ats:news', null);
  let pair = store.get('ats:pair', ['EUR', 'USD']);
  if (!PAIRS.some((p) => p[0] === pair[0] && p[1] === pair[1])) pair = ['EUR', 'USD'];
  let newsFilter = store.get('ats:newsFilter', 'all');
  let alertCodes = new Set(store.get('ats:alertCodes', CODES));
  let remindMin = store.get('ats:remind', 0);
  let remindRates = store.get('ats:remindRates', true);
  let tvKey = '';
  const THEMES = [
    { id: 'blade', name: 'Midnight Blade', note: 'Dark steel and gold', sw: ['#0f1115', '#d8b45a', '#6aa9ff', '#4fc28a'], fg: '#d8b45a', bg: '#0f1115' },
    { id: 'forge', name: 'Ember Forge', note: 'Copper on iron, serif', sw: ['#15100d', '#e3823f', '#f0c27a', '#8fc56a'], fg: '#e3823f', bg: '#15100d', serif: true },
    { id: 'signal', name: 'Signal Desk', note: 'Terminal green, mono', sw: ['#050807', '#35e08c', '#ffc23d', '#ff5d73'], fg: '#35e08c', bg: '#050807', mono: true },
    { id: 'ledger', name: 'Ivory Ledger', note: 'Light paper and ink', sw: ['#f3eee3', '#9b2335', '#1f4e8c', '#1d2433'], fg: '#1d2433', bg: '#f3eee3', serif: true, light: true },
    { id: 'aurora', name: 'Aurora Glass', note: 'Night sky, frosted', sw: ['#0b1030', '#5fe3f0', '#b18cff', '#ff7aa8'], fg: '#5fe3f0', bg: '#070b1a' },
  ];
  let theme = store.get('ats:theme', 'blade');
  const isLight = () => theme === 'ledger' || (theme === 'blade' && matchMedia('(prefers-color-scheme: light)').matches);

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
  const sgn = (v) => (v === null || v === undefined || isNaN(v)) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2).replace(/0$/, '') + '%';
  const r1 = (v) => Math.round(v * 10) / 10;
  const pairName = (p) => p[0] + '/' + p[1];
  // Convert a local wall-clock time in a time zone to a UTC timestamp (handles daylight saving).
  const tzOff = (ts, tz) => {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const p = {}; f.formatToParts(new Date(ts)).forEach((x) => { p[x.type] = x.value; });
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ts;
  };
  const zoned = (day, hhmm, tz) => {
    const [y, m, d] = day.split('-').map(Number); const [h, mi] = hhmm.split(':').map(Number);
    const guess = Date.UTC(y, m - 1, d, h, mi);
    try { let t = guess - tzOff(guess, tz); t = guess - tzOff(t, tz); return t; } catch { return guess; }
  };
  const fLocal = (ts) => new Date(ts).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const countdown = (ts) => {
    let s = Math.round((ts - Date.now()) / 1000);
    if (s <= 0) return 'now';
    const d = Math.floor(s / 86400); s -= d * 86400; const h = Math.floor(s / 3600); s -= h * 3600; const m = Math.floor(s / 60); s -= m * 60;
    if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
    if (h > 0) return h + 'h ' + m + 'm ' + String(s).padStart(2, '0') + 's';
    return m + 'm ' + String(s).padStart(2, '0') + 's';
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
      loadNews();
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

  async function loadNews() {
    try {
      const r = await fetch(NEWS_URL + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      news = await r.json(); store.set('ats:news', news);
    } catch {
      if (!news && NEWS_URL !== 'data/news.json') {
        try { const b = await fetch('data/news.json'); if (b.ok) news = await b.json(); } catch { /* none */ }
      }
    }
    renderNews();
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

  function notify(title, body, tag) {
    if (LN) {
      LN.schedule({ notifications: [{ id: Date.now() % 2147483647, title, body }] }).catch(() => {});
    } else if ('Notification' in window && Notification.permission === 'granted' && navigator.serviceWorker) {
      navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, {
        body, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: tag || 'cpi', renotify: true,
      })).catch(() => {});
    }
  }

  function announce(all) {
    const msgAll = all.map((r) => `${r.code} ${fMonth(r.period)}: ${pct(r.headline)}`).join(' · ');
    toast('New CPI ▸ ' + msgAll);
    const rows = all.filter((r) => alertCodes.has(r.code));
    if (!rows.length) { markSeen(); return; }
    const msg = rows.map((r) => `${r.code} ${fMonth(r.period)}: ${pct(r.headline)}`).join(' · ');
    if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
    notify('New inflation figure', msg, 'cpi');
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
    renderPairs();
    renderScore(rows);
    renderReal(rows);
    renderLegend();
    renderChart();
    renderCalendar(rows);
    renderNews();
    renderLog();
    if (view === 'watch') updateWatchContext();
    scheduleReminders();
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
    const rr = rows.map((r) => ({ r, v: realRate(r) })).filter((x) => x.v !== null);
    if (rr.length > 1) {
      const hi = rr.reduce((a, c) => (c.v > a.v ? c : a)), lo = rr.reduce((a, c) => (c.v < a.v ? c : a));
      p.append(' Highest real rate: ', b(hi.r.code + ' ' + sgn(hi.v)), ', lowest: ', b(lo.r.code + ' ' + sgn(lo.v)), '.');
    }
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
      dl.append(el('dt', '', 'Month'), per, el('dt', '', 'Core'), core);
      const po = policy(r.code);
      if (po) {
        const pr = el('dd', '', policyText(po)); pr.title = po.bank + ': ' + po.name;
        const rv = realRate(r); const rd = el('dd', rv > 0 ? 'pos' : rv < 0 ? 'neg' : '', sgn(rv));
        dl.append(el('dt', '', BANK[r.code] + ' rate'), pr, el('dt', '', 'Real rate'), rd);
      }
      dl.append(el('dt', '', 'Next CPI'), nx);
      c.append(dl);
      wrap.append(c);
    }
    wrap.append(goldCard());
  }


  // ---------- policy & real rates
  const policy = (c) => (doc && doc.policy && doc.policy[c]) || null;
  const policyText = (po) => (po.low !== undefined && po.high !== undefined) ? po.low.toFixed(2) + '–' + po.high.toFixed(2) + '%' : (+po.rate).toFixed(2) + '%';
  const realRate = (r) => { const po = policy(r.code); return po && r.headline != null ? Math.round((po.rate - r.headline) * 100) / 100 : null; };
  const row = (c) => doc && doc.latest.find((r) => r.code === c);
  const tgtMid = (r) => (r.target_low + r.target_high) / 2;
  function pressure(r) {
    const head = r.headline - tgtMid(r);
    const core = (r.core != null ? r.core : r.headline) - tgtMid(r);
    const mom = r.previous != null ? r.headline - r.previous : 0;
    return { score: r1(0.5 * head + 0.5 * core + mom), head: r1(head), core: r1(core), mom: r1(mom) };
  }

  // ---------- gold
  let goldKey = '', goldEl = null;
  function goldCard() {
    const key = theme + (isLight() ? 'l' : 'd') + (navigator.onLine ? '1' : '0');
    const us = row('USD'); const rv = us ? realRate(us) : null;
    if (!goldEl) { goldEl = el('article', 'card gold-card'); goldEl.id = 'gold-card'; }
    if (goldKey !== key) {
      goldKey = key; goldEl.replaceChildren();
      const top = el('div', 'card-top'); top.append(el('span', 'code', 'XAU'), el('span', 'econ', 'Gold · live')); goldEl.append(top);
      const q = el('div', 'quote');
      if (navigator.onLine) {
        const w = el('div', 'tradingview-widget-container'); const inner = el('div', 'tradingview-widget-container__widget');
        const sc = document.createElement('script'); sc.async = true;
        sc.src = 'https://s3.tradingview.com/external-embedding/embed-widget-single-quote.js';
        sc.textContent = JSON.stringify({ symbol: 'OANDA:XAUUSD', width: '100%', isTransparent: true, colorTheme: isLight() ? 'light' : 'dark', locale: 'en' });
        w.append(inner, sc); q.append(w);
      } else q.append(el('div', 'note', 'Live gold price needs a connection.'));
      const dl = el('dl'); dl.className = 'gold-dl';
      const btn = el('button', 'btn ghost small', 'Open XAU/USD chart'); btn.type = 'button';
      btn.onclick = () => { pair = GOLD; store.set('ats:pair', pair); if (newsFilter === 'pair') renderNews(); go('markets', 'pairs'); };
      goldEl.append(q, dl, btn);
    }
    const dl = goldEl.querySelector('.gold-dl'); dl.replaceChildren();
    if (us && rv !== null) {
      const rd = el('dd', rv > 0 ? 'pos' : rv < 0 ? 'neg' : '', sgn(rv));
      dl.append(el('dt', '', 'US real rate'), rd, el('dt', '', 'US CPI'), el('dd', '', pct(us.headline)), el('dt', '', 'Fed rate'), el('dd', '', policyText(policy('USD'))));
      const ev = events().find((e) => e.code === 'USD' && e.ts > Date.now());
      if (ev) { const d = el('dd', '', countdown(ev.ts)); d.dataset.ts = ev.ts; dl.append(el('dt', '', ev.kind === 'cpi' ? 'Next US CPI' : 'Next Fed'), d); }
    }
    return goldEl;
  }

  // ---------- pair view
  function renderPairs() {
    const chips = $('pair-chips'); chips.replaceChildren();
    for (const p of PAIRS) {
      const b = el('button', '', pairName(p)); b.type = 'button';
      b.setAttribute('aria-pressed', String(p[0] === pair[0] && p[1] === pair[1]));
      b.onclick = () => { pair = p; store.set('ats:pair', pair); renderPairs(); if (newsFilter === 'pair') renderNews(); };
      chips.append(b);
    }
    const sum = $('pair-sum'); sum.replaceChildren();
    const bb = (t) => el('b', '', t);
    $('pair-two').hidden = isGold(pair);
    if (isGold(pair)) {
      const us = row('USD'); const rv = us ? realRate(us) : null;
      sum.append(bb('XAU/USD'), ': gold priced in US dollars.');
      if (rv !== null) sum.append(' US real rate is ', bb(sgn(rv)), ' (Fed ', bb(policyText(policy('USD'))), ' minus CPI ', bb(pct(us.headline)), '). ',
        rv < 0 ? 'Negative real rates lower the cost of holding gold, which usually supports it.' : 'Positive real rates raise the cost of holding gold, which usually weighs on it.');
      renderTV();
      return;
    }
    const A = row(pair[0]), B = row(pair[1]);
    if (!A || !B) return;
    const d = r1(A.headline - B.headline);
    const ra = realRate(A), rb = realRate(B);
    sum.append(bb(pairName(pair)), ': ', A.code + ' inflation ', bb(pct(A.headline)), ' vs ' + B.code + ' ', bb(pct(B.headline)),
      ' → spread ', bb((d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(d).toFixed(1) + ' pts'), '.');
    if (ra !== null && rb !== null) {
      const g = Math.round((ra - rb) * 100) / 100;
      sum.append(' Real-rate gap ', bb(sgn(g).replace('%', ' pts')), ' (', A.code + ' ' + sgn(ra), ', ', B.code + ' ' + sgn(rb), ').');
    }
    const pa = pressure(A).score, pb = pressure(B).score;
    sum.append(' Inflation pressure is ', bb(pa > pb ? 'higher in ' + A.code : pa < pb ? 'higher in ' + B.code : 'level'), '.');
    renderTV();
    renderPairBars(A, B);
    renderSpread(A, B);
  }

  function renderTV() {
    if (view !== 'markets') return; // built when the Markets tab is opened
    const box = $('tv'); const key = pairName(pair) + theme + (isLight() ? 'l' : 'd');
    if (!navigator.onLine) { box.replaceChildren(el('div', 'tv-off', 'Live chart needs a connection.')); tvKey = ''; return; }
    if (key === tvKey && box.childElementCount) return;
    tvKey = key;
    const wrap = el('div', 'tradingview-widget-container'); wrap.style.height = '100%';
    const inner = el('div', 'tradingview-widget-container__widget'); inner.style.height = '100%';
    const sc = document.createElement('script');
    sc.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js'; sc.async = true;
    sc.textContent = JSON.stringify({
      autosize: true, symbol: tvSymbol(pair), interval: '15',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC',
      theme: key.endsWith('l') ? 'light' : 'dark', style: '1', locale: 'en',
      hide_side_toolbar: true, allow_symbol_change: false, save_image: false, calendar: false,
      backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--panel').trim() || '#171a21',
      support_host: 'https://www.tradingview.com',
    });
    wrap.append(inner, sc); box.replaceChildren(wrap);
  }

  function renderPairBars(A, B) {
    const box = $('pair-bars'); box.replaceChildren();
    const pa = policy(A.code), pb = policy(B.code);
    const groups = [
      ['Headline CPI', A.headline, B.headline],
      ['Core CPI', A.core, B.core],
      ['Policy rate', pa ? pa.rate : null, pb ? pb.rate : null],
      ['Real rate', realRate(A), realRate(B)],
    ];
    const vals = groups.flatMap((g) => [g[1], g[2]]).filter((v) => v !== null && v !== undefined);
    const W = Math.max(300, box.clientWidth || 440), H = 230, mt = 22, mb = 34, ml = 30, mr = 6;
    const lo = Math.min(0, Math.floor(Math.min(...vals))), hi = Math.max(1, Math.ceil(Math.max(...vals) + 0.3));
    const y = (v) => mt + (1 - (v - lo) / (hi - lo)) * (H - mt - mb);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': pairName(pair) + ' comparison' }, box);
    const stepY = hi - lo > 6 ? 2 : 1;
    for (let t = lo; t <= hi; t += stepY) {
      s('line', { x1: ml, x2: W - mr, y1: y(t), y2: y(t), stroke: 'var(--line)' }, svg);
      s('text', { x: ml - 5, y: y(t), dy: '0.32em', 'text-anchor': 'end', 'font-size': 10.5, fill: 'var(--muted)' }, svg).textContent = t + '%';
    }
    s('line', { x1: ml, x2: W - mr, y1: y(0), y2: y(0), stroke: 'var(--muted)' }, svg);
    const gw = (W - ml - mr) / groups.length, bw = Math.min(34, gw * 0.32);
    groups.forEach((g, i) => {
      const cx = ml + gw * i + gw / 2;
      [[g[1], A.code, -1], [g[2], B.code, 1]].forEach(([v, c, side]) => {
        const x = cx + (side < 0 ? -bw - 2 : 2);
        if (v === null || v === undefined) { s('text', { x: x + bw / 2, y: y(0) - 4, 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--muted)' }, svg).textContent = 'n/a'; return; }
        const y0 = y(Math.max(0, v)), h = Math.max(1, Math.abs(y(v) - y(0)));
        s('rect', { x, y: y0, width: bw, height: h, rx: 3, fill: COLORS[c] }, svg);
        s('text', { x: x + bw / 2, y: v >= 0 ? y0 - 4 : y0 + h + 11, 'text-anchor': 'middle', 'font-size': 10.5, 'font-weight': 600, fill: 'var(--fg)' }, svg).textContent = (Math.round(v * 100) / 100).toFixed(Math.abs(v * 10 % 1) > 0.001 ? 2 : 1);
      });
      s('text', { x: cx, y: H - 10, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--muted)' }, svg).textContent = g[0];
    });
    const lg = s('g', {}, svg);
    [A.code, B.code].forEach((c, i) => {
      s('rect', { x: ml + 4 + i * 54, y: 4, width: 9, height: 9, rx: 2, fill: COLORS[c] }, lg);
      s('text', { x: ml + 17 + i * 54, y: 12, 'font-size': 11, fill: 'var(--fg)' }, lg).textContent = c;
    });
  }

  function renderSpread(A, B) {
    const box = $('pair-spread'); box.replaceChildren();
    const ha = doc.history[A.code] || {}, hb = doc.history[B.code] || {};
    const months = Object.keys(ha).filter((m) => hb[m] !== undefined).sort();
    const pts = months.map((m) => ({ m, v: r1(ha[m] - hb[m]) }));
    const note = $('spread-note');
    if (pts.length < 2) { note.textContent = 'Not enough shared months yet.'; return; }
    const first = pts[0], last = pts[pts.length - 1], ch = r1(last.v - first.v);
    note.textContent = `${A.code} minus ${B.code} headline inflation. ${ch > 0 ? 'Widened' : ch < 0 ? 'Narrowed' : 'Unchanged'} by ${Math.abs(ch).toFixed(1)} pts since ${fMonth(first.m)}.`;
    const W = Math.max(300, box.clientWidth || 440), H = 190, mt = 12, mb = 24, ml = 34, mr = 12;
    const vs = pts.map((p) => p.v);
    const lo = Math.floor(Math.min(0, ...vs) - 0.2), hi = Math.ceil(Math.max(0, ...vs) + 0.2);
    const x = (i) => ml + i / (pts.length - 1) * (W - ml - mr);
    const y = (v) => mt + (1 - (v - lo) / (hi - lo || 1)) * (H - mt - mb);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Inflation spread history' }, box);
    const step = hi - lo > 6 ? 2 : hi - lo > 3 ? 1 : 0.5;
    for (let t = lo; t <= hi + 1e-9; t += step) {
      s('line', { x1: ml, x2: W - mr, y1: y(t), y2: y(t), stroke: 'var(--line)' }, svg);
      s('text', { x: ml - 5, y: y(t), dy: '0.32em', 'text-anchor': 'end', 'font-size': 10.5, fill: 'var(--muted)' }, svg).textContent = (Math.round(t * 10) / 10) + '';
    }
    s('line', { x1: ml, x2: W - mr, y1: y(0), y2: y(0), stroke: 'var(--muted)' }, svg);
    pts.forEach((p, i) => { if ((pts.length - 1 - i) % 3 === 0) s('text', { x: x(i), y: H - 6, 'text-anchor': 'middle', 'font-size': 10.5, fill: 'var(--muted)' }, svg).textContent = fMonthShort(p.m); });
    const d = pts.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(p.v).toFixed(1)).join('');
    s('path', { d: d + `L${x(pts.length - 1)},${y(0)}L${x(0)},${y(0)}Z`, fill: 'var(--gold)', opacity: 0.12 }, svg);
    s('path', { d, fill: 'none', stroke: 'var(--gold)', 'stroke-width': 2.2, 'stroke-linejoin': 'round' }, svg);
    pts.forEach((p, i) => s('circle', { cx: x(i), cy: y(p.v), r: i === pts.length - 1 ? 3.5 : 2, fill: 'var(--gold)' }, svg));
    s('text', { x: x(pts.length - 1) - 4, y: y(last.v) - 8, 'text-anchor': 'end', 'font-size': 11.5, 'font-weight': 650, fill: 'var(--gold)' }, svg).textContent = (last.v > 0 ? '+' : '') + last.v.toFixed(1);
  }

  // ---------- pressure scoreboard
  function renderScore(rows) {
    const list = $('score-list'); list.replaceChildren();
    const sc = rows.map((r) => ({ r, p: pressure(r) })).sort((a, b) => b.p.score - a.p.score);
    const max = Math.max(1, ...sc.map((x) => Math.abs(x.p.score)));
    sc.forEach((x, i) => {
      const li = el('li');
      const head = el('div', 'score-head');
      head.append(el('span', 'rank', String(i + 1)), el('b', '', x.r.code), el('span', 'econ', x.r.economy));
      const v = el('span', 'score-v ' + (x.p.score > 0 ? 'hot' : 'cool'), (x.p.score > 0 ? '+' : '') + x.p.score.toFixed(1));
      head.append(v);
      const bar = el('div', 'meter'); const fill = el('i'); fill.style.width = (Math.abs(x.p.score) / max * 100).toFixed(0) + '%';
      fill.style.background = COLORS[x.r.code]; bar.append(fill);
      const why = el('div', 'why',
        `Headline ${x.p.head >= 0 ? '+' : ''}${x.p.head.toFixed(1)} vs target · core ${x.p.core >= 0 ? '+' : ''}${x.p.core.toFixed(1)} · last move ${x.p.mom > 0 ? '▲' : x.p.mom < 0 ? '▼' : '■'} ${Math.abs(x.p.mom).toFixed(1)}`);
      li.append(head, bar, why); list.append(li);
    });
    const w = $('watch'); w.replaceChildren();
    if (sc.length > 1) {
      const top = sc[0].r.code, bot = sc[sc.length - 1].r.code;
      const p = RANK[top] < RANK[bot] ? [top, bot] : [bot, top];
      w.append(el('span', '', 'Widest pressure gap: '), el('b', '', pairName(p)),
        el('span', '', ` (${top} most pressure, ${bot} least).`));
      const btn = el('button', 'btn ghost small', 'Open in pair view'); btn.type = 'button';
      btn.onclick = () => { pair = p; store.set('ats:pair', pair); go('markets', 'pairs'); };
      w.append(btn);
    }
  }

  // ---------- real rates
  function renderReal(rows) {
    const tb = $('real-table'); tb.replaceChildren(); const box = $('real-chart'); box.replaceChildren();
    const rr = rows.map((r) => ({ r, po: policy(r.code), v: realRate(r) })).filter((x) => x.po).sort((a, b) => b.v - a.v);
    if (!rr.length) { box.textContent = 'Policy rates not loaded yet.'; return; }
    if (doc.policy && doc.policy.as_of) $('real-note').textContent = 'Policy rate minus headline inflation. Positive means policy is tight in real terms; negative means it is loose. Rates as of ' + fDate(doc.policy.as_of) + '.';
    const W = Math.max(300, box.clientWidth || 600), rowH = 30, H = rr.length * rowH + 8, ml = 44, lab = 58;
    const ext = Math.max(0.5, ...rr.map((x) => Math.abs(x.v)));
    const half = (W - ml - 2 * lab) / 2, x0 = ml + lab + half, sc = half / ext;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Real interest rates' }, box);
    s('line', { x1: x0, x2: x0, y1: 0, y2: H, stroke: 'var(--muted)' }, svg);
    rr.forEach((x, i) => {
      const yy = 4 + i * rowH;
      s('text', { x: 0, y: yy + rowH / 2 - 2, dy: '0.32em', 'font-size': 12.5, 'font-weight': 650, fill: 'var(--fg)' }, svg).textContent = x.r.code;
      const w = Math.max(2, Math.abs(x.v) * sc);
      s('rect', { x: x.v >= 0 ? x0 : x0 - w, y: yy + 4, width: w, height: rowH - 12, rx: 3, fill: COLORS[x.r.code] }, svg);
      s('text', { x: x.v >= 0 ? x0 + w + 6 : x0 - w - 6, y: yy + rowH / 2 - 2, dy: '0.32em', 'text-anchor': x.v >= 0 ? 'start' : 'end', 'font-size': 12, 'font-weight': 600, fill: 'var(--fg)' }, svg).textContent = sgn(x.v);
      const tr = el('tr');
      const ld = x.po.last_decision ? fDate(x.po.last_decision) + (x.po.last_move ? (x.po.last_move > 0 ? ' · hike ' : ' · cut ') + Math.abs(x.po.last_move * 100).toFixed(0) + 'bp' : ' · hold') : '—';
      const rv = el('td', x.v > 0 ? 'pos' : x.v < 0 ? 'neg' : '', sgn(x.v));
      const pc = el('td', '', policyText(x.po)); pc.title = x.po.bank + ': ' + x.po.name;
      tr.append(el('td', '', x.r.code + ' · ' + BANK[x.r.code]), pc, el('td', '', pct(x.r.headline)), rv, el('td', 'wide', ld));
      tb.append(tr);
    });
  }

  // ---------- events (CPI releases + rate decisions)
  function events() {
    if (!doc) return [];
    const out = [];
    for (const r of doc.latest) {
      if (r.next_release) {
        const [t, tz] = CPI_TIME[r.code] || ['09:00', 'UTC'];
        out.push({ kind: 'cpi', code: r.code, ts: zoned(r.next_release, t, tz), est: !!r.next_release_estimated,
          label: r.code + ' CPI' + (r.next_period ? ' (' + fMonth(r.next_period) + ')' : ''), sub: r.agency });
      }
      const po = policy(r.code);
      if (po && po.next_meeting) {
        out.push({ kind: 'rate', code: r.code, ts: zoned(po.next_meeting, po.time || '12:00', po.tz || 'UTC'), est: false, approx: !!po.time_approx,
          label: BANK[r.code] + ' rate decision', sub: po.bank + ' · now ' + policyText(po) });
      }
    }
    return out.filter((e) => e.ts > Date.now() - 3 * 3600e3).sort((a, b) => a.ts - b.ts);
  }

  function renderCalendar() {
    const tb = $('cal'); tb.replaceChildren();
    const ev = events();
    const nx = $('next-up'); nx.replaceChildren();
    const up = ev.find((e) => e.ts > Date.now());
    if (up) {
      const c = el('div', 'next-card');
      const sw = el('i'); sw.style.background = COLORS[up.code];
      const t = el('div', 'next-t'); t.append(sw, el('span', '', 'Next: ' + up.label));
      const big = el('div', 'next-cd', countdown(up.ts)); big.dataset.ts = up.ts;
      c.append(t, big, el('div', 'next-w', fLocal(up.ts) + (up.est ? ' · est.' : up.approx ? ' · time approx.' : '')));
      nx.append(c);
    }
    for (const e of ev) {
      const tr = el('tr', e.kind === 'rate' ? 'ev-rate' : '');
      const n = el('td'); const sw = el('i', 'sw'); sw.style.background = COLORS[e.code];
      n.append(sw, el('span', '', e.label), el('small', '', e.sub));
      const w = el('td', '', fLocal(e.ts)); if (e.est) w.append(el('span', 'est', 'est.')); if (e.approx) w.append(el('span', 'est', '≈'));
      const cd = el('td', 'cd', countdown(e.ts)); cd.dataset.ts = e.ts;
      if (e.ts - Date.now() < 3 * 864e5) cd.classList.add('soon');
      tr.append(n, w, cd); tb.append(tr);
    }
  }

  function tick() {
    document.querySelectorAll('[data-ts]').forEach((n) => { n.textContent = countdown(+n.dataset.ts); });
    checkWebReminders();
  }

  // ---------- reminders
  const remindNote = () => {
    const n = $('remind-note');
    if (!remindMin) { n.textContent = ''; return; }
    n.textContent = LN ? 'Reminders are scheduled on your phone, so they arrive even when the app is closed.'
      : 'Reminders arrive while the app is open or running in the background. The phone apps can remind you even when closed.';
  };
  async function scheduleReminders() {
    if (!LN) return;
    try {
      const pend = await LN.getPending();
      const ours = (pend.notifications || []).filter((n) => n.id >= 7000 && n.id < 7100).map((n) => ({ id: n.id }));
      if (ours.length) await LN.cancel({ notifications: ours });
      if (!remindMin) return;
      const st = await LN.checkPermissions(); if (st.display !== 'granted') return;
      const list = events().filter((e) => alertCodes.has(e.code) && (e.kind === 'cpi' || remindRates))
        .map((e) => ({ e, at: e.ts - remindMin * 6e4 })).filter((x) => x.at > Date.now() + 3e4).slice(0, 40);
      if (!list.length) return;
      await LN.schedule({ notifications: list.map((x, i) => ({
        id: 7000 + i, title: x.e.label + ' ' + leadText(),
        body: fLocal(x.e.ts) + ' · ' + x.e.sub, schedule: { at: new Date(x.at), allowWhileIdle: true },
      })) });
    } catch { /* plugin unavailable */ }
  }
  const leadText = () => remindMin >= 1440 ? 'tomorrow' : remindMin >= 60 ? 'in 1 hour' : 'in ' + remindMin + ' min';
  function checkWebReminders() {
    if (LN || !remindMin || !doc) return;
    const done = store.get('ats:reminded', {});
    let dirty = false;
    for (const e of events()) {
      if (!alertCodes.has(e.code) || (e.kind === 'rate' && !remindRates)) continue;
      const at = e.ts - remindMin * 6e4, key = e.kind + e.code + e.ts + ':' + remindMin;
      if (Date.now() >= at && Date.now() < e.ts && !done[key]) {
        done[key] = 1; dirty = true;
        toast('⏰ ' + e.label + ' ' + leadText());
        notify(e.label + ' ' + leadText(), fLocal(e.ts) + ' · ' + e.sub, 'remind');
      }
    }
    if (dirty) store.set('ats:reminded', done);
  }

  function setupAlertPrefs() {
    const chips = $('alert-chips');
    const draw = () => {
      chips.replaceChildren();
      for (const c of CODES) {
        const b = el('button'); b.type = 'button'; b.setAttribute('aria-pressed', String(alertCodes.has(c)));
        const sw = el('i'); sw.style.background = COLORS[c]; b.append(sw, c);
        b.onclick = () => { alertCodes.has(c) ? alertCodes.delete(c) : alertCodes.add(c); store.set('ats:alertCodes', [...alertCodes]); draw(); scheduleReminders(); };
        chips.append(b);
      }
    };
    draw();
    const sel = $('remind'); sel.value = String(remindMin);
    sel.onchange = () => { remindMin = +sel.value; store.set('ats:remind', remindMin); remindNote(); scheduleReminders(); };
    const cb = $('remind-cb'); cb.checked = remindRates;
    cb.onchange = () => { remindRates = cb.checked; store.set('ats:remindRates', remindRates); scheduleReminders(); };
    remindNote();
  }

  // ---------- looks
  function applyTheme(id) {
    theme = THEMES.some((t) => t.id === id) ? id : 'blade'; store.set('ats:theme', theme);
    if (theme === 'blade') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
    const t = THEMES.find((x) => x.id === theme);
    const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = t.bg;
    renderLooks();
    if (doc) render([]);
    onShow(view);
  }
  function renderLooks() {
    const box = $('looks'); box.replaceChildren();
    for (const t of THEMES) {
      const b = el('button', 'look'); b.type = 'button'; b.setAttribute('aria-pressed', String(t.id === theme));
      const sw = el('div', 'sw4');
      t.sw.forEach((c, i) => { const i2 = el('i'); i2.style.background = c; if (i === 0) { i2.textContent = '4.0%'; i2.style.color = t.fg; i2.style.fontFamily = t.mono ? 'ui-monospace, Menlo, monospace' : t.serif ? 'Georgia, serif' : 'inherit'; } sw.append(i2); });
      b.append(sw, el('span', '', t.name), el('small', '', t.note));
      b.onclick = () => applyTheme(t.id);
      box.append(b);
    }
  }

  // ---------- news
  function renderNews() {
    const chips = $('news-chips'); chips.replaceChildren();
    const opts = [['all', 'All'], ['pair', pairName(pair)], ...CODES.map((c) => [c, c]), ['XAU', 'Gold']];
    for (const [k, label] of opts) {
      const b = el('button', '', label); b.type = 'button'; b.setAttribute('aria-pressed', String(newsFilter === k));
      b.onclick = () => { newsFilter = k; store.set('ats:newsFilter', k); renderNews(); };
      chips.append(b);
    }
    const ul = $('news-list'); ul.replaceChildren();
    const items = (news && news.items) || [];
    renderHomeNews(items);
    const match = (it) => newsFilter === 'all' ? true : newsFilter === 'pair' ? it.codes.some((c) => pair.includes(c)) : it.codes.includes(newsFilter);
    const shown = items.filter(match).slice(0, 25);
    const note = $('news-note');
    note.textContent = 'Inflation and central-bank headlines from major outlets. Tap a headline to read the full story.' +
      (news && news.checked_at ? ' Checked ' + ago(news.checked_at) + '.' : '');
    if (!shown.length) {
      ul.append(el('li', 'empty', items.length ? 'No recent headlines for this filter.' : 'Headlines appear here after the next update run (every 30 minutes).'));
      return;
    }
    const seenAt = store.get('ats:newsSeen', null);
    for (const it of shown) {
      const li = el('li');
      const a = el('a', '', it.title); a.href = it.link; a.target = '_blank'; a.rel = 'noopener noreferrer';
      const meta = el('div', 'meta');
      if (seenAt && it.published > seenAt) meta.append(el('span', 'tag new', 'NEW'));
      it.codes.forEach((c) => { const t = el('span', 'tag', c === 'XAU' ? 'GOLD' : c); t.style.borderColor = COLORS[c]; t.style.color = COLORS[c]; meta.append(t); });
      meta.append(el('span', '', it.source + ' · ' + ago(it.published)));
      li.append(a, meta);
      if (it.summary) li.append(el('p', '', it.summary));
      ul.append(li);
    }
    clearTimeout(renderNews.t); renderNews.t = setTimeout(() => { if (items[0]) store.set('ats:newsSeen', items[0].published); }, 5000);
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
      const off = () => { btn.disabled = true; btn.textContent = 'Alerts blocked'; note.textContent = 'Allow notifications for Abraham Sword Tracker in your phone settings to turn alerts on.'; };
      const sync = (st) => { if (st.display === 'granted') { on(); scheduleReminders(); } else if (st.display === 'denied') off(); };
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

  // =====================================================================
  // v2.0: tabs (Home · Markets · News · Watchlist · More)
  // =====================================================================
  const VIEWS = ['home', 'markets', 'news', 'watch', 'more'];
  let view = 'home';
  function go(v, target) {
    if (!VIEWS.includes(v)) v = 'home';
    const same = v === view;
    view = v;
    VIEWS.forEach((x) => { $('v-' + x).hidden = x !== v; });
    document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-current', b.dataset.view === v ? 'page' : 'false'));
    try { history.replaceState(null, '', '#' + v); } catch { /* file: urls */ }
    onShow(v);
    if (target && $(target)) requestAnimationFrame(() => $(target).scrollIntoView({ behavior: 'smooth', block: 'start' }));
    else window.scrollTo({ top: 0, behavior: same ? 'smooth' : 'auto' });
  }
  function onShow(v) {
    if (v === 'home') renderTape();
    if (v === 'markets') {
      if (doc) { renderPairs(); renderChart(); renderReal(rows5()); }
      renderMarkets();
    }
    if (v === 'news') renderSeg();
    if (v === 'watch') renderWatch();
  }
  function setupTabs() {
    document.querySelectorAll('#tabs button').forEach((b) => { b.onclick = () => go(b.dataset.view); });
    document.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => go(b.dataset.go); });
    document.querySelectorAll('[data-scroll]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); $(a.dataset.scroll).scrollIntoView({ behavior: 'smooth', block: 'start' }); }; });
    $('brand').onclick = () => go('home');
    $('check-now').onclick = () => load(true);
  }

  // ---------- TradingView widgets (built only when their tab is open)
  const tvTheme = () => (isLight() ? 'light' : 'dark');
  const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC';
  function tvWidget(box, file, cfg) {
    if (!navigator.onLine) { box.replaceChildren(el('div', 'tv-off', 'Live data needs a connection.')); box.dataset.k = ''; return; }
    const k = file + JSON.stringify(cfg);
    if (box.dataset.k === k && box.childElementCount) return;
    box.dataset.k = k;
    const w = el('div', 'tradingview-widget-container'); w.style.height = '100%';
    const inner = el('div', 'tradingview-widget-container__widget'); inner.style.height = '100%';
    const sc = document.createElement('script'); sc.async = true;
    sc.src = 'https://s3.tradingview.com/external-embedding/embed-widget-' + file + '.js';
    sc.textContent = JSON.stringify(cfg);
    w.append(inner, sc); box.replaceChildren(w);
  }

  // ---------- markets
  const MKT = [
    { title: 'Forex', symbols: [['FX:EURUSD', 'EUR/USD'], ['FX:GBPUSD', 'GBP/USD'], ['FX:USDJPY', 'USD/JPY'], ['FX:AUDUSD', 'AUD/USD'], ['FX:USDCAD', 'USD/CAD'], ['FX:USDCHF', 'USD/CHF'], ['FX:GBPJPY', 'GBP/JPY'], ['FX:EURJPY', 'EUR/JPY']] },
    { title: 'Metals & energy', symbols: [['OANDA:XAUUSD', 'Gold'], ['OANDA:XAGUSD', 'Silver'], ['TVC:USOIL', 'WTI oil'], ['TVC:UKOIL', 'Brent oil']] },
    { title: 'Indices', symbols: [['TVC:DXY', 'US dollar index'], ['FOREXCOM:SPXUSD', 'S&P 500'], ['FOREXCOM:NSXUSD', 'Nasdaq 100'], ['FOREXCOM:DJI', 'Dow 30'], ['INDEX:DEU40', 'DAX 40'], ['INDEX:NKY', 'Nikkei 225']] },
    { title: 'Crypto', symbols: [['BITSTAMP:BTCUSD', 'Bitcoin'], ['BITSTAMP:ETHUSD', 'Ether']] },
  ];
  function renderMarkets() {
    tvWidget($('mkt'), 'market-overview', {
      colorTheme: tvTheme(), dateRange: '1D', showChart: true, locale: 'en', width: '100%', height: '100%', isTransparent: true,
      showSymbolLogo: true, showFloatingTooltip: true,
      tabs: MKT.map((t) => ({ title: t.title, originalTitle: t.title, symbols: t.symbols.map(([sy, d]) => ({ s: sy, d })) })),
    });
    tvWidget($('heat'), 'forex-heat-map', {
      width: '100%', height: '100%', currencies: ['EUR', 'USD', 'JPY', 'GBP', 'AUD', 'CAD', 'CHF', 'NZD'],
      isTransparent: true, colorTheme: tvTheme(), locale: 'en',
    });
  }

  // ---------- news sections
  let seg = store.get('ats:newsSeg', 'head');
  function renderSeg() {
    if (!['head', 'wire', 'cal'].includes(seg)) seg = 'head';
    document.querySelectorAll('#news-seg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.seg === seg)));
    ['head', 'wire', 'cal'].forEach((k) => { $('seg-' + k).hidden = k !== seg; });
    if (seg === 'wire') tvWidget($('wire'), 'timeline', { feedMode: 'market', market: 'forex', isTransparent: true, displayMode: 'regular', width: '100%', height: '100%', colorTheme: tvTheme(), locale: 'en' });
    if (seg === 'cal') tvWidget($('evcal'), 'events', { colorTheme: tvTheme(), isTransparent: true, width: '100%', height: '100%', locale: 'en', importanceFilter: '0,1', countryFilter: 'us,eu,jp,gb,au' });
  }
  function setupNewsSeg() {
    document.querySelectorAll('#news-seg button').forEach((b) => { b.onclick = () => { seg = b.dataset.seg; store.set('ats:newsSeg', seg); renderSeg(); }; });
  }
  function renderHomeNews(items) {
    const ul = $('home-news'); if (!ul) return; ul.replaceChildren();
    const top = items.slice(0, 3);
    if (!top.length) { ul.append(el('li', 'empty', 'Headlines appear here after the next update run.')); return; }
    for (const it of top) {
      const li = el('li');
      const a = el('a', '', it.title); a.href = it.link; a.target = '_blank'; a.rel = 'noopener noreferrer';
      const meta = el('div', 'meta');
      it.codes.forEach((c) => { const t = el('span', 'tag', c === 'XAU' ? 'GOLD' : c); t.style.borderColor = COLORS[c]; t.style.color = COLORS[c]; meta.append(t); });
      meta.append(el('span', '', it.source + ' · ' + ago(it.published)));
      li.append(a, meta); ul.append(li);
    }
  }

  // ---------- watchlist
  const CATALOG = [
    ['Forex', [['FX:EURUSD', 'EUR/USD'], ['FX:GBPUSD', 'GBP/USD'], ['FX:USDJPY', 'USD/JPY'], ['FX:AUDUSD', 'AUD/USD'], ['FX:USDCAD', 'USD/CAD'], ['FX:USDCHF', 'USD/CHF'], ['FX:NZDUSD', 'NZD/USD'],
      ['FX:EURJPY', 'EUR/JPY'], ['FX:GBPJPY', 'GBP/JPY'], ['FX:EURGBP', 'EUR/GBP'], ['FX:AUDJPY', 'AUD/JPY'], ['FX:EURAUD', 'EUR/AUD'], ['FX:GBPAUD', 'GBP/AUD']]],
    ['Metals & energy', [['OANDA:XAUUSD', 'Gold'], ['OANDA:XAGUSD', 'Silver'], ['TVC:USOIL', 'WTI oil'], ['TVC:UKOIL', 'Brent oil']]],
    ['Indices', [['TVC:DXY', 'US dollar index'], ['FOREXCOM:SPXUSD', 'S&P 500'], ['FOREXCOM:NSXUSD', 'Nasdaq 100'], ['FOREXCOM:DJI', 'Dow 30'], ['INDEX:DEU40', 'DAX 40'], ['INDEX:NKY', 'Nikkei 225']]],
    ['Crypto', [['BITSTAMP:BTCUSD', 'Bitcoin'], ['BITSTAMP:ETHUSD', 'Ether']]],
  ];
  const catName = (sy) => { for (const [, l] of CATALOG) for (const [x, n] of l) if (x === sy) return n; return null; };
  const DEFAULT_WATCH = ['FX:EURUSD', 'FX:GBPUSD', 'FX:USDJPY', 'OANDA:XAUUSD', 'FX:AUDUSD'].map((sy) => ({ s: sy, n: catName(sy) }));
  let watch = store.get('ats:watch', null);
  if (!Array.isArray(watch) || !watch.every((w) => w && typeof w.s === 'string')) watch = DEFAULT_WATCH.slice();
  let wlEdit = false;
  const wlEls = new Map();
  const saveWatch = () => { store.set('ats:watch', watch); tapeKey = ''; };
  // FX:EURUSD → ['EUR','USD'] when both are tracked currencies; gold → GOLD
  const fxOf = (sy) => {
    const t = sy.split(':').pop().replace('/', '');
    if (/^XAUUSD$/.test(t)) return GOLD;
    const a = t.slice(0, 3), b = t.slice(3, 6);
    return t.length === 6 && CODES.includes(a) && CODES.includes(b) ? [a, b] : null;
  };
  function ctxFor(w) {
    const p = fxOf(w.s); if (!p || !doc) return null;
    const box = el('div', 'wl-ctx'); const bb = (t) => el('b', '', t);
    if (isGold(p)) {
      const us = row('USD'); const rv = us ? realRate(us) : null;
      if (rv === null) return null;
      box.append('US real rate ', bb(sgn(rv)), ' · US CPI ', bb(pct(us.headline)), '.');
      return { box, p };
    }
    const A = row(p[0]), B = row(p[1]); if (!A || !B) return null;
    const d = r1(A.headline - B.headline);
    box.append('Inflation spread ', bb((d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(d).toFixed(1) + ' pts'));
    const ra = realRate(A), rb = realRate(B);
    if (ra !== null && rb !== null) box.append(' · real-rate gap ', bb(sgn(Math.round((ra - rb) * 100) / 100).replace('%', ' pts')));
    const pa = pressure(A).score, pb = pressure(B).score;
    box.append(' · pressure ', bb(pa > pb ? 'higher in ' + A.code : pa < pb ? 'higher in ' + B.code : 'level'), '.');
    return { box, p };
  }
  function wlItem(w) {
    let li = wlEls.get(w.s);
    if (!li) {
      li = el('li', 'wl-item');
      const top = el('div', 'wl-top'); const nm = el('div', 'nm');
      nm.append(el('b', '', w.n || w.s.split(':').pop()), el('small', '', w.s));
      const acts = el('div', 'wl-acts');
      top.append(nm, acts);
      const box = el('div', 'wl-box');
      const ctx = el('div', 'wl-ctxw');
      li.append(top, box, ctx);
      wlEls.set(w.s, li);
    }
    return li;
  }
  function drawActs(li, w, i) {
    const acts = li.querySelector('.wl-acts'); acts.replaceChildren();
    if (wlEdit) {
      const up = el('button', 'mini-btn', '▲'); up.type = 'button'; up.disabled = i === 0; up.setAttribute('aria-label', 'Move up');
      up.onclick = () => { [watch[i - 1], watch[i]] = [watch[i], watch[i - 1]]; saveWatch(); renderWatch(); };
      const dn = el('button', 'mini-btn', '▼'); dn.type = 'button'; dn.disabled = i === watch.length - 1; dn.setAttribute('aria-label', 'Move down');
      dn.onclick = () => { [watch[i + 1], watch[i]] = [watch[i], watch[i + 1]]; saveWatch(); renderWatch(); };
      const rm = el('button', 'mini-btn danger', 'Remove'); rm.type = 'button';
      rm.onclick = () => { watch.splice(i, 1); wlEls.delete(w.s); saveWatch(); renderWatch(); toast('Removed ' + (w.n || w.s)); };
      acts.append(up, dn, rm);
    } else {
      const ch = el('button', 'mini-btn primary', 'Chart'); ch.type = 'button';
      ch.onclick = () => openChart(w.s, w.n || w.s);
      acts.append(ch);
    }
  }
  function updateWatchContext() {
    watch.forEach((w) => {
      const li = wlEls.get(w.s); if (!li) return;
      const wrap = li.querySelector('.wl-ctxw'); wrap.replaceChildren();
      const c = ctxFor(w); if (!c) return;
      const btn = el('button', 'mini-btn', isGold(c.p) ? 'Gold in pair view' : 'Inflation pair view'); btn.type = 'button';
      btn.onclick = () => { pair = c.p; store.set('ats:pair', pair); go('markets', 'pairs'); };
      wrap.append(c.box, btn); wrap.className = 'wl-ctxw';
      wrap.style.display = 'grid'; wrap.style.gap = '6px'; wrap.style.justifyItems = 'start';
    });
  }
  function renderWatch() {
    const ul = $('wl-list');
    $('wl-edit').textContent = wlEdit ? 'Done' : 'Edit';
    if (!watch.length) { ul.replaceChildren(el('li', 'empty', 'Your watchlist is empty. Add symbols below.')); }
    else {
      const items = watch.map((w, i) => { const li = wlItem(w); drawActs(li, w, i); return li; });
      // only re-order the DOM when the order changed (moving a chart reloads it)
      const cur = [...ul.children];
      if (cur.length !== items.length || cur.some((n, i) => n !== items[i])) ul.replaceChildren(...items);
      watch.forEach((w) => {
        tvWidget(wlEls.get(w.s).querySelector('.wl-box'), 'mini-symbol-overview', {
          symbol: w.s, width: '100%', height: '100%', locale: 'en', dateRange: '1D', colorTheme: tvTheme(), isTransparent: true, autosize: true, largeChartUrl: '',
        });
      });
      updateWatchContext();
    }
    renderCats();
  }
  function renderCats() {
    const box = $('wl-cats'); box.replaceChildren();
    const on = new Set(watch.map((w) => w.s));
    for (const [cat, list] of CATALOG) {
      box.append(el('div', 'cat', cat));
      const chips = el('div', 'chips');
      for (const [sy, n] of list) {
        const b = el('button', '', n); b.type = 'button'; b.setAttribute('aria-pressed', String(on.has(sy)));
        b.onclick = () => { on.has(sy) ? removeSym(sy) : addSym(sy, n); };
        chips.append(b);
      }
      box.append(chips);
    }
  }
  function addSym(sy, n) {
    if (watch.some((w) => w.s === sy)) { toast((n || sy) + ' is already on your watchlist'); return false; }
    if (watch.length >= 20) { toast('Watchlist is full (20). Remove one first.'); return false; }
    watch.push({ s: sy, n: n || catName(sy) }); saveWatch(); renderWatch(); toast('Added ' + (n || sy));
    return true;
  }
  function removeSym(sy) {
    const i = watch.findIndex((w) => w.s === sy); if (i < 0) return;
    const w = watch[i]; watch.splice(i, 1); wlEls.delete(sy); saveWatch(); renderWatch(); toast('Removed ' + (w.n || sy));
  }
  function setupWatch() {
    $('wl-edit').onclick = () => { wlEdit = !wlEdit; renderWatch(); };
    $('wl-form').onsubmit = (e) => {
      e.preventDefault();
      const inp = $('wl-input'), msg = $('wl-msg');
      let v = inp.value.trim().toUpperCase().replace(/\s+/g, '');
      if (/^[A-Z]{6}$/.test(v)) v = 'FX:' + v; // EURUSD → FX:EURUSD
      if (!/^[A-Z0-9_.!-]{1,20}:[A-Z0-9_.!\/-]{1,24}$/.test(v)) {
        msg.textContent = 'That does not look like a symbol. Try something like FX:USDCAD, OANDA:XAUUSD or NASDAQ:AAPL.'; msg.className = 'note err'; return;
      }
      msg.textContent = 'Use TradingView’s format: exchange, a colon, then the symbol.'; msg.className = 'note';
      if (addSym(v, catName(v))) inp.value = '';
    };
  }

  // ---------- live ticker on Home (your watchlist)
  let tapeKey = '';
  function renderTape() {
    const box = $('tape');
    if (!watch.length) { box.hidden = true; return; }
    box.hidden = false;
    tvWidget(box, 'ticker-tape', {
      symbols: watch.map((w) => ({ proName: w.s, title: w.n || w.s.split(':').pop() })),
      showSymbolLogo: true, isTransparent: true, displayMode: 'adaptive', colorTheme: tvTheme(), locale: 'en',
    });
  }

  // ---------- full-screen chart
  function openChart(sym, title) {
    $('sheet-title').textContent = title;
    $('sheet').hidden = false; document.body.classList.add('locked');
    tvWidget($('sheet-chart'), 'advanced-chart', {
      autosize: true, symbol: sym, interval: '15', timezone: tz(), theme: tvTheme(), style: '1', locale: 'en',
      allow_symbol_change: true, save_image: false, calendar: false, hide_side_toolbar: false,
      backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0f1115',
      support_host: 'https://www.tradingview.com',
    });
  }
  function closeChart() {
    $('sheet').hidden = true; document.body.classList.remove('locked');
    const b = $('sheet-chart'); b.replaceChildren(); b.dataset.k = '';
  }
  function setupSheet() {
    $('sheet-close').onclick = closeChart;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('sheet').hidden) closeChart(); });
  }

  // ---------- position size calculator
  function setupCalc() {
    const f = { bal: $('ps-bal'), risk: $('ps-risk'), sl: $('ps-sl'), pv: $('ps-pv') };
    const saved = store.get('ats:calc', { bal: '', risk: '1', sl: '', pv: '10' });
    Object.keys(f).forEach((k) => { f[k].value = saved[k] != null ? saved[k] : ''; });
    const out = $('ps-out');
    const calc = () => {
      const v = {}; Object.keys(f).forEach((k) => { v[k] = f[k].value; });
      store.set('ats:calc', v);
      const bal = parseFloat(v.bal), risk = parseFloat(v.risk), sl = parseFloat(v.sl), pv = parseFloat(v.pv);
      out.replaceChildren();
      if (!(bal > 0 && risk > 0 && sl > 0 && pv > 0)) { out.append('Fill in all four boxes to see your lot size.'); return; }
      const cash = bal * risk / 100, lots = cash / (sl * pv);
      const n2 = (x) => x.toLocaleString(undefined, { maximumFractionDigits: 2 });
      out.append(el('span', 'lots', lots.toFixed(2) + ' lots'));
      out.append('Risking ', el('b', '', n2(cash)), ' (' + n2(risk) + '% of ' + n2(bal) + ') over a ' + n2(sl) + '-pip stop. That is ',
        el('b', '', (lots * 10).toFixed(1) + ' mini'), ' or ', el('b', '', Math.round(lots * 100) + ' micro'), ' lots.');
      if (risk > 5) out.append(el('div', 'note', 'Heads up: that is a large share of the account on one trade.'));
    };
    Object.values(f).forEach((i) => { i.oninput = calc; });
    calc();
  }

  // ---------- boot
  if (doc) { render([]); }
  status();
  $('refresh').onclick = () => load(true);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { load(false); markSeenLater(); } });
  window.addEventListener('online', () => load(false));
  window.addEventListener('offline', () => { lastOk = 0; status(); });
  let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (doc) { renderChart(); const A = row(pair[0]), B = row(pair[1]); if (A && B && !isGold(pair)) { renderPairBars(A, B); renderSpread(A, B); } rows5().length && renderReal(rows5()); } }, 150); });
  const rows5 = () => CODES.map((c) => row(c)).filter(Boolean);
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (doc) renderTV(); onShow(view); });
  window.addEventListener('online', () => { if (doc) renderTV(); onShow(view); });
  function markSeenLater() { setTimeout(markSeen, 4000); }
  setupNotify(); setupInstall(); setupAlertPrefs(); renderLooks();
  setupTabs(); setupNewsSeg(); setupWatch(); setupSheet(); setupCalc();
  go(VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home');
  if (news) renderNews();
  if (!NATIVE && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(registerBackground).catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'data-updated') load(false); });
  }
  load(false).then(() => { if (!store.get('ats:seen', null)) markSeen(); });
  startPolling();
  setInterval(status, 30 * 1000);
  setInterval(tick, 1000);
})();
