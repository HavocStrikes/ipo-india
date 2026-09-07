/* IPO India — client-side app (list + detail pages). Zero dependencies. */
(() => {
  'use strict';

  /* Deployment knobs — set by config.js and the base-path snippet in index.html.
   * API_BASE: '' → same origin (npm start / wrangler dev / Worker-served site);
   *           'https://…workers.dev' when this frontend is hosted on GitHub Pages.
   * SITE_BASE: '/' for root hosting, '/<repo>/' for a GitHub Pages project site. */
  const API_BASE = (window.IPO_CONFIG && window.IPO_CONFIG.apiBase) || '';
  const SITE_BASE = window.IPO_BASE || '/';
  const appPath = () => {
    let p = location.pathname;
    if (SITE_BASE !== '/' && p.startsWith(SITE_BASE)) p = p.slice(SITE_BASE.length);
    return p.startsWith('/') ? p : `/${p}`;
  };

  const $ = (sel) => document.querySelector(sel);
  const app = $('#app');

  /* ---------------- formatting helpers ---------------- */
  const numFmt = (v, d = 0) =>
    v === null || v === undefined ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: d });
  const cr = (v) => (v === null || v === undefined ? '—' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })} Cr`);
  const inr = (v) => (v === null || v === undefined ? '—' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`);
  const x = (v) => (v === null || v === undefined ? '—' : `${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}×`);
  const pct = (v, sign = false) => {
    if (v === null || v === undefined) return '—';
    const n = Number(v);
    return `${sign && n > 0 ? '+' : ''}${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`;
  };
  const toDate = (v) => {
    if (!v) return null;
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return new Date(`${v}T00:00:00`);
    const d = new Date(String(v).replace(/^[A-Za-z]{3},?\s*/, '').replace(/,\s*/g, ' '));
    return isNaN(d.getTime()) ? null : d;
  };
  const dateS = (v) => {
    const d = toDate(v);
    return d ? d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  };
  const rel = (v) => {
    const d = toDate(v);
    if (!d) return '—';
    const diff = Math.ceil((d - new Date()) / 86400000);
    if (diff === 0) return 'today';
    if (diff === 1) return 'tomorrow';
    if (diff === -1) return 'yesterday';
    return diff > 1 ? `in ${diff} days` : `${-diff} days ago`;
  };
  const esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const TONES = { great: 'var(--great)', good: 'var(--good)', neutral: 'var(--neutral)', weak: 'var(--weak)', bad: 'var(--bad)' };
  const toneColor = (t) => TONES[t || 'neutral'] || TONES.neutral;
  const STATUS_META = {
    upcoming: { label: 'Upcoming', cls: 'status-upcoming', hint: 'opens' },
    open: { label: 'Open now', cls: 'status-open', hint: 'closes' },
    closed: { label: 'Closed', cls: 'status-closed', hint: 'closed on' },
    listed: { label: 'Listed', cls: 'status-listed', hint: 'listed on' },
  };

  /* ---------------- state + router ---------------- */
  const state = { tab: 'upcoming', category: 'all', q: '', sort: 'recent', all: false, meta: null, shown: 12 };

  function go(url) {
    history.pushState({}, '', SITE_BASE === '/' ? url : SITE_BASE.replace(/\/$/, '') + url);
    route();
    window.scrollTo(0, 0);
  }

  function route() {
    const m = appPath().match(/^\/ipo\/(\d+)(\/|$)/);
    if (m) renderDetail(Number(m[1]));
    else renderList();
  }
  window.addEventListener('popstate', route);

  function scores() {
    document.title = 'IPO India — Live Upcoming & Listed IPOs with Scores';
    app.innerHTML = '<div class="page-loading"><div class="spinner"></div></div>';
  }

  /* ---------------- SVG icon set ---------------- */
  const ICONS = {
    arrow: '<path d="M19 12H5m7-7-7 7 7 7"/>',
    tag: '<path d="M20.6 13.4 11 3.8A2 2 0 0 0 9.6 3H5a2 2 0 0 0-2 2v4.6c0 .5.2 1 .6 1.4l9.6 9.6a2 2 0 0 0 2.8 0l4.6-4.6a2 2 0 0 0 0-2.8Z"/><circle cx="7.5" cy="7.5" r=".6" fill="currentColor"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
    chart: '<path d="M3 3v18h18"/><path d="m7 15 4-5 3 3 5-7"/>',
    fire: '<path d="M12 2c1 3-1 4-1 6 0 1 .7 2 2 2s2-1 2-2c0-.5-.2-.9-.5-1.2C15.8 8.5 18 11 18 14a6 6 0 0 1-12 0c0-4 2.5-7 4-10Z"/>',
    coin: '<circle cx="12" cy="12" r="9"/><path d="M9 9h6M9 15h6M9 12h6"/>',
    scale: '<path d="M12 3v18M8 21h8M4 7l-2 4.5a3 3 0 0 0 4 0L4 7Zm16 0-2 4.5a3 3 0 0 0 4 0L20 7ZM12 6V3Z"/>',
    spark: '<path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3ZM19 15.5V16M19 19h.01"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 8a3 3 0 1 1 0 6M21 20a5 5 0 0 0-4-5"/>',
    bank: '<path d="M3 9 12 3l9 6M5 9v10M10 9v10M14 9v10M19 9v10M3 21h18"/>',
    star: '<path d="m12 3 2.7 5.6 6.3.9-4.5 4.4 1 6.1L12 17.9 6.5 20l1-6.1L3 9.5l6.3-.9L12 3Z"/>',
    building: '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7L11.8 5.2"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    check: '<path d="m5 12 5 5L20 7"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  };
  const icon = (name, cls = '') =>
    `<svg class="ic-svg ${cls}" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.tag}</svg>`;

  /* ---------------- score ring ---------------- */
  let _ringUid = 0;
  function scoreRing(score, tone, size = 46) {
    const uid = `rg${++_ringUid}`;
    const stroke = size * 0.075;
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const pct = Math.max(0, Math.min(100, score));
    const col = toneColor(tone);
    const glow =
      tone === 'great' ? '#34d399' : tone === 'good' ? '#4ade80' : tone === 'neutral' ? '#fbbf24' : tone === 'weak' ? '#fb923c' : tone === 'bad' ? '#f87171' : col;
    const cx = size / 2;
    const cy = size / 2;
    let ticks = '';
    const n = 36;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const rad1 = r - stroke * 0.55;
      const rad2 = r - stroke * 0.12;
      const on = (k / n) * 100 <= pct;
      ticks += `<line x1="${(cx + Math.cos(a) * rad1).toFixed(2)}" y1="${(cy + Math.sin(a) * rad1).toFixed(2)}" x2="${(cx + Math.cos(a) * rad2).toFixed(2)}" y2="${(cy + Math.sin(a) * rad2).toFixed(2)}" stroke="${on ? col : 'var(--track)'}" stroke-width="${Math.max(1, stroke * 0.13)}" stroke-linecap="round" opacity="${on ? 1 : 0.5}"/>`;
    }
    return `
      <div class="score-ring ring-${tone}" style="width:${size}px;height:${size}px">
        <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
          <defs>
            <linearGradient id="${uid}" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="${col}"/><stop offset="100%" stop-color="${glow}"/>
            </linearGradient>
          </defs>
          <circle cx="${cx}" cy="${cy}" r="${r - stroke * 0.55}" fill="none" stroke="var(--track)" stroke-width="${stroke * 0.55}" opacity="0.6"/>
          ${ticks}
          <circle class="ring-arc" cx="${cx}" cy="${cy}" r="${r - stroke * 0.55}" fill="none" stroke="url(#${uid})" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct / 100)}"/>
        </svg>
        <span class="val" style="font-size:${size * 0.32}px">${pct.toFixed(0)}</span>
      </div>`;
  }

  /* ---------------- API ---------------- */
  async function api(url) {
    const res = await fetch(API_BASE + url);
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
  }

  function fetchList() {
    const p = new URLSearchParams();
    p.set('status', state.tab);
    if (state.category && state.category !== 'all') p.set('category', state.category);
    if (state.q) p.set('q', state.q);
    if (state.all) p.set('all', '1');
    return api(`/api/ipos?${p.toString()}`);
  }

  function setLive(fetchedAt, err) {
    const pill = $('#livePill');
    const txt = $('#liveText');
    if (err) {
      pill.classList.add('err');
      txt.textContent = `data error — retrying`;
      return;
    }
    pill.classList.remove('err');
    txt.textContent = fetchedAt
      ? `live · updated ${new Date(fetchedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`
      : 'live';
  }

  function loadMeta() {
    api('/api/meta')
      .then((m) => {
        state.meta = m;
        setLive(m.fetchedAt);
        if (!appPath().startsWith('/ipo/')) renderList({ keep: true });
      })
      .catch((e) => setLive(null, e));
  }

  /* ---------------- list view ---------------- */
  function renderList({ keep = false } = {}) {
    document.title = 'IPO India — Live Upcoming & Listed IPOs with Scores';
    if (keep && app.dataset.view === 'list' && state.meta) return;
    app.dataset.view = 'list';
    const m = state.meta || { counts: {}, windowDays: 31, total: 0 };
    const winDays = m.windowDays || 31;

    app.innerHTML = `
      <section class="hero">
        <h1>India&rsquo;s IPOs, <span class="grad">decoded</span></h1>
        <p class="hero-sub">Upcoming, open &amp; recently listed IPOs with full details — subscription, fundamentals,
          valuation and a transparent 0–100 investability score.</p>
        <div class="chips">
          <button class="chip" data-tab="upcoming"><span class="n">${m.counts.upcoming ?? 0}</span><span class="l">Upcoming · 31 days</span></button>
          <button class="chip" data-tab="open"><span class="n">${m.counts.open ?? 0}</span><span class="l">Open now</span></button>
          <button class="chip" data-tab="listed"><span class="n">${m.counts.listed ?? 0}</span><span class="l">Listed · last 31 days</span></button>
        </div>
      </section>

      <div class="toolbar">
        <div class="tabs">
          ${['upcoming', 'open', 'closed', 'listed']
            .map(
              (t) =>
                `<button class="tab ${state.tab === t ? 'active' : ''}" data-tab="${t}">${STATUS_META[t].label}` +
                `<span class="cnt">${state.all ? 'all' : (m.counts[t] ?? 0)}</span></button>`
            )
            .join('')}
        </div>
        <div class="filters">
          <span class="search-wrap">${icon('search')}<input id="q" type="search" placeholder="Search IPOs…" value="${esc(state.q)}" /></span>
          <select id="cat">
            <option value="all">All</option>
            <option value="mainboard" ${state.category === 'mainboard' ? 'selected' : ''}>Mainboard</option>
            <option value="sme" ${state.category === 'sme' ? 'selected' : ''}>SME</option>
          </select>
          <select id="sort">
            <option value="recent" ${state.sort === 'recent' ? 'selected' : ''}>Most recent</option>
            <option value="score" ${state.sort === 'score' ? 'selected' : ''}>Top score</option>
            <option value="subscription" ${state.sort === 'subscription' ? 'selected' : ''}>Most subscribed</option>
            <option value="amount" ${state.sort === 'amount' ? 'selected' : ''}>Largest issue</option>
          </select>
        </div>
      </div>

      ${state.all ? '' : `<p class="window-note">Showing your 31-day window — next ${winDays} days from today.
        <a href="#" id="showAll">View full archive (${m.total} IPOs)</a></p>`}
      <p class="window-note" id="backToRecentNote" style="${state.all ? '' : 'display:none'}">
        Showing the full archive. <a href="#" id="showRecent">Back to recent (next ${winDays} days)</a></p>

      <div class="cards" id="cards">
        ${Array.from({ length: 6 }, () => '<div class="skeleton"></div>').join('')}
      </div>
      <div class="load-more" id="loadMoreWrap" style="display:none">
        <button class="btn" id="loadMore">Load more</button>
      </div>

      ${subscribeHTML()}
    `;

    bindListControls();
    bindSubscribe();
    renderCards();
  }

  function bindListControls() {
    app.querySelectorAll('.chip, .tab').forEach((el) =>
      el.addEventListener('click', () => {
        state.tab = el.dataset.tab;
        state.shown = 12;
        renderList();
      })
    );
    const q = $('#q');
    let timer;
    q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.q = q.value.trim();
        state.shown = 12;
        renderList();
      }, 300);
    });
    $('#cat').addEventListener('change', (e) => {
      state.category = e.target.value;
      state.shown = 12;
      renderList();
    });
    $('#sort').addEventListener('change', (e) => {
      state.sort = e.target.value;
      state.shown = 12;
      renderList();
    });
    const showAll = $('#showAll');
    if (showAll)
      showAll.addEventListener('click', (e) => {
        e.preventDefault();
        state.all = true;
        state.shown = 12;
        renderList();
      });
    const showRecent = $('#showRecent');
    if (showRecent)
      showRecent.addEventListener('click', (e) => {
        e.preventDefault();
        state.all = false;
        state.shown = 12;
        renderList();
      });
    $('#loadMore').addEventListener('click', () => {
      state.shown += 12;
      renderCards();
    });
  }

  function renderCards() {
    fetchList()
      .then((d) => {
        setLive(d.fetchedAt);
        const rows = d.ipos.slice();
        const sortFns = {
          recent: (a, b) => (b.openDate || '0000').localeCompare(a.openDate || '0000'),
          score: (a, b) => (b.score ? b.score.score : 0) - (a.score ? a.score.score : 0),
          subscription: (a, b) => (b.subscriptionX ?? -1) - (a.subscriptionX ?? -1),
          amount: (a, b) => (b.issueAmountCr ?? -1) - (a.issueAmountCr ?? -1),
        };
        rows.sort(sortFns[state.sort] || sortFns.recent);
        const slice = rows.slice(0, state.shown);
        const wrap = $('#cards');
        if (!slice.length) {
          wrap.innerHTML = `<div class="empty">No IPOs match your filters. Try clearing the search or switching tabs.</div>`;
        } else {
          wrap.innerHTML = slice.map((o, idx) => cardHtml(o, idx)).join('');
        }
        const lm = $('#loadMoreWrap');
        lm.style.display = rows.length > slice.length ? 'flex' : 'none';
      })
      .catch((e) => {
        $('#cards').innerHTML = `<div class="empty">Couldn&rsquo;t load IPOs — ${esc(e.message)}. Retrying…</div>`;
        setTimeout(renderCards, 8000);
      });
  }

  function cardHtml(i, idx = 0) {
    const sm = STATUS_META[i.status] || STATUS_META.listed;
    const sc = (i.score && i.score.score) != null ? i.score.score : null;
    const tone = i.score ? i.score.tone : 'neutral';
    let keyDate;
    if (i.status === 'upcoming') keyDate = ['Opens', dateS(i.openDate), rel(i.openDate)];
    else if (i.status === 'open') keyDate = ['Closes', dateS(i.closeDate), rel(i.closeDate)];
    else if (i.status === 'closed') keyDate = ['Closed on', dateS(i.closeDate), ''];
    else keyDate = ['Listed on', dateS(i.listingDate), i.listingGainPct != null ? pct(i.listingGainPct, true) : ''];
    const gain = i.listingGainPct;
    const dateCell =
      gain != null && (i.status === 'listed' || i.status === 'closed')
        ? `<span class="chip-gain gain-${gain >= 0 ? 'pos' : 'neg'}">${pct(gain, true)}</span>`
        : keyDate[2] && keyDate[2] !== '—'
          ? `${keyDate[1]} · ${keyDate[2]}`
          : keyDate[1];

    return `
      <article class="card" data-id="${i.id}" tabindex="0" style="--d:${Math.min(idx, 11) * 45}ms">
        <span class="card-glow" aria-hidden="true"></span>
        <div class="card-top">
          <div style="min-width:0">
            <div class="card-name">${esc(i.name)}</div>
            <div class="badges">
              <span class="badge ${sm.cls}">● ${sm.label}</span>
              <span class="badge ${i.category === 'SME' ? 'sme' : ''}">${esc(i.category || '—')}</span>
            </div>
          </div>
          ${scoreRing(sc ?? 0, tone, 52)}
        </div>
        <div class="kv">
          <div><span class="k">Price</span><span class="v">${i.issuePrice != null ? inr(i.issuePrice) : '—'}</span></div>
          <div><span class="k">Issue size</span><span class="v">${cr(i.issueAmountCr)}</span></div>
          <div><span class="k">Subscription</span><span class="v">${x(i.subscriptionX)}</span></div>
          <div><span class="k">${keyDate[0]}</span><span class="v">${dateCell}</span></div>
        </div>
        <div class="card-foot">
          <span class="details-link">View details ${icon('arrow', 'dl-arrow')}</span>
          <span class="verdict" style="color:${toneColor(tone)}">${esc(i.score ? i.score.verdict : '—')}</span>
        </div>
      </article>`;
  }

  /* ---------------- card click delegation ---------------- */
  app.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (card) go(`/ipo/${card.dataset.id}`);
  });
  app.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const card = e.target.closest('.card');
      if (card) go(`/ipo/${card.dataset.id}`);
    }
  });

  /* ---------------- detail page ---------------- */
  function timelineItems(i) {
    const t = (i.detail && i.detail.timetable) || {};
    const D = (iso, disp) => (iso ? toDate(iso) : toDate(disp));
    const items = [
      { label: 'Bid opens', date: D(i.openDate, t.open) },
      { label: 'Bid closes', date: D(i.closeDate, t.close) },
      { label: 'Allotment', date: D(i.allotmentDate, t.allotment) },
      { label: 'Refunds', date: D(null, t.refund) },
      { label: 'Shares credited', date: D(null, t.credit) },
      { label: 'Listing', date: D(i.listingDate, t.listing) },
    ].filter((it) => it.date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let nextMarked = false;
    return items.map((it) => {
      const dd = new Date(it.date);
      dd.setHours(0, 0, 0, 0);
      const isToday = +dd === +today;
      const done = dd < today;
      let cls = 'done';
      if (isToday) cls = 'today';
      else if (!done && !nextMarked) {
        cls = 'next';
        nextMarked = true;
      } else if (!done) cls = 'upcoming';
      return { ...it, cls, dateStr: dateS(it.date), hint: rel(it.date) };
    });
  }

  function timelineHTML(items) {
    return `<div class="timeline">${items
      .map(
        (it) => `
        <div class="tl-item ${it.cls}">
          <span class="tl-dot"></span>
          <div class="tl-body">
            <div class="tl-label">${it.label}</div>
            <div class="tl-date">${esc(it.dateStr)}</div>
            <div class="tl-hint">${esc(it.hint)}</div>
          </div>
        </div>`
      )
      .join('')}</div>`;
  }

  const panel = (ic, title, body, full = '') =>
    `<section class="panel ${full}">
      <h2 class="panel-title"><span class="ic">${ic}</span>${title}</h2>${body}
    </section>`;

  const detailKV = (rows) =>
    `<div class="kv single">${rows
      .map(
        ([k, v]) =>
          `<div><span class="k">${esc(k)}</span><span class="v ${/^\d|₹/.test(String(v).trim()) ? 'bold' : ''}">${esc(v)}</span></div>`
      )
      .join('')}</div>`;

  /* ---------------- company charts (zero-dependency SVG) ---------------- */
  let _chartUid = 0;

  const chartCard = (title, sub, body) => `
    <div class="chart-card">
      <div class="chart-head"><h3>${title}</h3>${sub ? `<span class="chart-sub">${sub}</span>` : ''}</div>
      ${body}
    </div>`;

  const compactNum = (v) => {
    if (v == null) return '—';
    if (v >= 1e7) return `${(v / 1e7).toFixed(v >= 1e9 ? 0 : 1)} Cr`;
    if (v >= 1e5) return `${(v / 1e5).toFixed(1)} L`;
    return numFmt(v);
  };

  /** Vertical bar chart. items = [{ label, value, color }] — values in ₹ Cr. */
  function barsChart(items) {
    const W = 470, H = 232, padT = 26, padB = 34, padX = 8;
    const plotW = W - padX * 2;
    const plotH = H - padT - padB;
    const max = Math.max(...items.map((d) => d.value));
    const steps = 4;
    let grid = '';
    for (let s = 0; s <= steps; s++) {
      const y = padT + plotH * (1 - s / steps);
      grid += `<line x1="${padX}" y1="${y.toFixed(1)}" x2="${W - padX}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width="1"${s ? ' stroke-dasharray="3 4"' : ''}/>`;
      if (s < steps) grid += `<text x="${padX + 2}" y="${(y - 4).toFixed(1)}" class="axis-txt">${numFmt((max / steps) * s)}</text>`;
    }
    const slot = plotW / items.length;
    const bw = Math.min(58, slot * 0.56);
    const bars = items
      .map((d, idx) => {
        const h = Math.max(3, (d.value / max) * plotH);
        const bx = padX + slot * idx + (slot - bw) / 2;
        const by = padT + plotH - h;
        return `<g class="vbar"><title>${esc(d.label)}: ₹${numFmt(d.value)} Cr</title>
          <rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="6" fill="${d.color}"/>
          <text x="${(bx + bw / 2).toFixed(1)}" y="${(by - 7).toFixed(1)}" class="val-txt" text-anchor="middle">${numFmt(d.value)}</text>
          <text x="${(bx + bw / 2).toFixed(1)}" y="${H - 13}" class="cat-txt" text-anchor="middle">${esc(d.label)}</text></g>`;
      })
      .join('');
    const label = items.map((d) => `${d.label} ₹${numFmt(d.value)} Cr`).join(', ');
    return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart: ${esc(label)}">${grid}${bars}</svg>`;
  }

  /** Line/area chart. points = [{ label, value }], band = { low, high } (52-week range). */
  function lineChart(points, band) {
    const W = 470, H = 232, padT = 26, padB = 34, padL = 12, padR = 12;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const vals = points
      .map((pt) => pt.value)
      .concat(band ? [band.low, band.high] : [])
      .filter((v) => v != null && Number.isFinite(v));
    if (vals.length < 2 || points.length < 2) return '';
    let min = Math.min(...vals);
    let max = Math.max(...vals);
    const span = max - min || Math.abs(max) * 0.1 || 1;
    min -= span * 0.14;
    max += span * 0.14;
    const yFor = (v) => padT + plotH * (1 - (v - min) / (max - min));
    const xFor = (i) => padL + (plotW * i) / (points.length - 1);
    const pts = points.map((pt, i) => ({ ...pt, x: xFor(i), y: yFor(pt.value) }));
    const lineD = pts.map((pt, i) => `${i ? 'L' : 'M'}${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`).join(' ');
    const areaD = `${lineD} L${pts[pts.length - 1].x.toFixed(1)} ${(padT + plotH).toFixed(1)} L${pts[0].x.toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;
    const uid = `lc${++_chartUid}`;
    let bandSvg = '';
    if (band && band.low != null && band.high != null && band.high > band.low) {
      const yHi = yFor(band.high);
      const yLo = yFor(band.low);
      bandSvg = `
        <rect x="${padL}" y="${yHi.toFixed(1)}" width="${plotW}" height="${Math.max(2, yLo - yHi).toFixed(1)}" fill="var(--brand)" opacity="0.08"/>
        <line x1="${padL}" y1="${yHi.toFixed(1)}" x2="${W - padR}" y2="${yHi.toFixed(1)}" stroke="var(--brand)" stroke-dasharray="4 4" opacity="0.4"/>
        <line x1="${padL}" y1="${yLo.toFixed(1)}" x2="${W - padR}" y2="${yLo.toFixed(1)}" stroke="var(--brand)" stroke-dasharray="4 4" opacity="0.4"/>
        <text x="${W - padR}" y="${(yHi - 5).toFixed(1)}" class="axis-txt" text-anchor="end">52w high ${inr(band.high)}</text>
        <text x="${W - padR}" y="${(yLo + 13).toFixed(1)}" class="axis-txt" text-anchor="end">52w low ${inr(band.low)}</text>`;
    }
    const dots = pts
      .map((pt, i) => {
        const anchor = i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle';
        return `<g><title>${esc(pt.label)}: ${inr(pt.value)}</title>
          <circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="4.5" fill="var(--surface)" stroke="${pt.color || 'var(--brand)'}" stroke-width="2.5"/>
          <text x="${pt.x.toFixed(1)}" y="${(pt.y - 11).toFixed(1)}" class="val-txt" text-anchor="${anchor}">${inr(pt.value)}</text>
          <text x="${pt.x.toFixed(1)}" y="${H - 13}" class="cat-txt" text-anchor="${anchor}">${esc(pt.label)}</text></g>`;
      })
      .join('');
    return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Price journey chart from issue price to the current price">
      <defs><linearGradient id="${uid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--brand)" stop-opacity="0.26"/>
        <stop offset="100%" stop-color="var(--brand)" stop-opacity="0.02"/>
      </linearGradient></defs>
      ${bandSvg}
      <path d="${areaD}" fill="url(#${uid})"/>
      <path d="${lineD}" fill="none" stroke="var(--brand)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      ${dots}</svg>`;
  }

  /** Donut chart. segs = [{ label, value, color }] — at least two segments. */
  function donutChart(segs, centerTitle, centerSub) {
    const total = segs.reduce((s, d) => s + d.value, 0);
    if (!(total > 0) || segs.length < 2) return '';
    const size = 156, stroke = 22, r = (size - stroke) / 2 - 3, c = 2 * Math.PI * r;
    let acc = 0;
    const arcs = segs
      .map((d) => {
        const frac = d.value / total;
        const len = Math.max(0.8, frac * c);
        const offset = -acc * c;
        acc += frac;
        return `<circle class="donut-seg" cx="${size / 2}" cy="${size / 2}" r="${r.toFixed(1)}" fill="none" stroke="${d.color}" stroke-width="${stroke}" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"><title>${esc(d.label)}: ${numFmt(d.value)} shares (${(frac * 100).toFixed(1)}%)</title></circle>`;
      })
      .join('');
    const legend = segs
      .map(
        (d) =>
          `<span class="donut-leg"><i style="background:${d.color}"></i><span class="dl">${esc(d.label)}</span><b>${numFmt(d.value)}</b><em>${((d.value / total) * 100).toFixed(1)}%</em></span>`
      )
      .join('');
    return `<div class="donut-wrap">
      <svg class="donut" viewBox="0 0 ${size} ${size}" role="img" aria-label="Donut chart: ${esc(centerTitle)} ${esc(centerSub)}">
        <circle cx="${size / 2}" cy="${size / 2}" r="${r.toFixed(1)}" fill="none" stroke="var(--track)" stroke-width="${stroke}" opacity="0.55"/>
        ${arcs}
        <text x="${size / 2}" y="${size / 2 - 1}" text-anchor="middle" class="donut-num">${esc(centerTitle)}</text>
        <text x="${size / 2}" y="${size / 2 + 16}" text-anchor="middle" class="donut-lbl">${esc(centerSub)}</text>
      </svg>
      <div class="donut-legend">${legend}</div>
    </div>`;
  }

  /* ---------------- "Company in charts" section ---------------- */
  function metersHTML(rows) {
    return `<div class="meters">${rows
      .map((m0) => {
        const val = Number(m0.value);
        const color = val >= m0.good ? 'var(--great)' : val >= m0.ok ? 'var(--brand)' : val > 0 ? 'var(--neutral)' : 'var(--bad)';
        const w = Math.max(2, Math.min(100, val));
        return `<div class="meter">
          <div class="meter-top"><span class="l">${esc(m0.label)}</span><span class="v" style="color:${color}">${pct(val)}</span></div>
          <div class="meter-track"><div class="meter-fill" style="width:${w.toFixed(1)}%;background:${color}"></div></div>
        </div>`;
      })
      .join('')}</div>`;
  }

  /** Horizontal bars for the top use-of-funds objects (₹ Cr). */
  function fundsHTML(objs) {
    const max = Math.max(...objs.map((o) => o.amountCr));
    return `<div class="funds">${objs
      .map(
        (o) => `<div class="fund-row">
          <div class="fund-head"><span class="l" title="${esc(o.object)}">${esc(o.object)}</span><span class="v">${cr(o.amountCr)}</span></div>
          <div class="fund-track"><div class="fund-fill" style="width:${((o.amountCr / max) * 100).toFixed(1)}%"></div></div>
        </div>`
      )
      .join('')}</div>`;
  }

  function chartsHTML(i) {
    const d = i.detail || {};
    const f = i.financials || {};
    const k = i.kpi || {};
    const cards = [];

    // 1 — Financials at a glance (vertical bars, ₹ Cr)
    const finItems = [
      { label: 'Revenue', value: f.revenueCr, color: 'var(--brand)' },
      { label: 'EBITDA', value: f.ebitdaCr, color: 'var(--brand-2)' },
      { label: 'Profit', value: f.patCr, color: 'var(--great)' },
      { label: 'Net worth', value: f.netWorthCr, color: '#38bdf8' },
      { label: 'Borrowings', value: f.borrowingsCr, color: 'var(--weak)' },
    ].filter((it) => it.value != null && it.value > 0);
    if (finItems.length >= 2)
      cards.push(chartCard('Financials at a glance', f.period ? `period ended ${dateS(f.period)}` : '₹ crore', barsChart(finItems)));

    // 2 — Profitability & returns (meter bars)
    const meters = [
      { label: 'PAT margin', value: k.patMargin, good: 12, ok: 6 },
      { label: 'EBITDA margin', value: k.ebitdaMargin, good: 18, ok: 9 },
      { label: 'Return on net worth', value: k.ronw != null ? k.ronw : k.roe, good: 16, ok: 9 },
      { label: 'ROCE', value: k.roce, good: 15, ok: 9 },
    ].filter((m0) => m0.value != null);
    if (meters.length) cards.push(chartCard('Profitability &amp; returns', 'higher is better', metersHTML(meters)));

    // 3 — Price journey line chart (listed) or price band (upcoming)
    const lg = i.listing || {};
    const mk = i.market || {};
    const ldt = d.listingDayTrading || {};
    const pricePts = [
      { label: 'Issue', value: i.issuePrice },
      { label: 'List open', value: lg.openPrice != null ? lg.openPrice : ldt.open },
      { label: 'List close', value: lg.closePrice != null ? lg.closePrice : ldt.lastTrade },
      { label: 'Now', value: mk.price },
    ].filter((pt) => pt.value != null && pt.value > 0);
    const band52 =
      mk.week52High != null && mk.week52Low != null && mk.week52High > mk.week52Low
        ? { low: mk.week52Low, high: mk.week52High }
        : null;
    const lineSvg = pricePts.length >= 2 ? lineChart(pricePts, band52) : '';
    if (lineSvg)
      cards.push(chartCard('Price journey', band52 ? 'issue → listing → today · shaded = 52-week range' : 'issue → listing → today', lineSvg));

    // 4 — Issue structure donut (fresh vs OFS), or use-of-funds bars
    const segs = [];
    if (d.freshIssueShares != null && d.freshIssueShares > 0)
      segs.push({ label: 'Fresh issue', value: d.freshIssueShares, color: 'var(--brand)' });
    if (d.ofsShares != null && d.ofsShares > 0)
      segs.push({ label: 'Offer for sale', value: d.ofsShares, color: 'var(--brand-2)' });
    const knownShares = segs.reduce((s, x) => s + x.value, 0);
    if (d.totalIssueShares != null && d.totalIssueShares - knownShares > 0)
      segs.push({ label: 'Other / unspecified', value: d.totalIssueShares - knownShares, color: '#64748b' });
    const centerTotal = d.totalIssueShares != null ? d.totalIssueShares : knownShares;
    const donutSvg = segs.length >= 2 && centerTotal > 0 ? donutChart(segs, compactNum(centerTotal), 'total shares') : '';
    if (donutSvg) cards.push(chartCard('Issue structure', 'fresh money vs exiting holders', donutSvg));
    else if (d.objects && d.objects.filter((o) => o.amountCr > 0).length >= 2) {
      const objs = d.objects
        .filter((o) => o.amountCr > 0)
        .sort((a, b) => b.amountCr - a.amountCr)
        .slice(0, 5);
      cards.push(chartCard('Use of funds', 'objects of the issue · ₹ crore', fundsHTML(objs)));
    }

    if (!cards.length) return '';
    return `<section class="charts" aria-label="Company charts">
      <div class="charts-title-row">
        <h2 class="charts-h">${icon('chart')}Company in charts</h2>
        <span class="charts-note">the same numbers, easier to read</span>
      </div>
      <div class="charts-grid">${cards.join('')}</div>
    </section>`;
  }

  function renderDetail(id) {
    app.dataset.view = 'detail';
    app.innerHTML = `<button class="back" id="backBtn">${icon('arrow')} Back to tracker</button>
      <div class="page-loading"><div class="spinner"></div></div>`;
    $('#backBtn').addEventListener('click', () => go('/'));
    document.title = 'IPO India — loading…';

    api(`/api/ipos/${id}`)
      .then((d) => {
        setLive(d.fetchedAt);
        renderDetailBody(d.ipo);
        document.title = `${d.ipo.name} — IPO details & score | IPO India`;
      })
      .catch((e) => {
        app.innerHTML = `<button class="back" id="backBtn">${icon('arrow')} Back to tracker</button>
          <div class="empty">Couldn&rsquo;t load this IPO — ${esc(e.message || e)}</div>`;
        $('#backBtn').addEventListener('click', () => go('/'));
      });
  }

  function scoreBreakdown(sc) {
    const defs = [
      ['demand', 'Demand & subscription', 25],
      ['fundamentals', 'Fundamentals', 25],
      ['valuation', 'Valuation', 20],
      ['performance', 'Performance / anchors', 15],
      ['sentiment', 'Sentiment & reviews', 15],
    ];
    const pillars = sc.pillars || {};
    const bars = defs
      .map(([key, name, max]) => {
        const p = pillars[key] || { pts: 0, note: 'no data' };
        const ratio = max > 0 ? Math.max(0, Math.min(1, p.pts / max)) : 0;
        const color = ratio >= 0.7 ? 'var(--great)' : ratio >= 0.45 ? 'var(--brand)' : ratio >= 0.25 ? 'var(--neutral)' : 'var(--neg)';
        return `
        <div class="pillar">
          <div class="pillar-top">
            <span class="pillar-name">${name}</span>
            <span class="pillar-pts">${Math.round(p.pts * 10) / 10}/${max}</span>
          </div>
          <div class="pillar-track"><div class="pillar-fill" style="width:${ratio * 100}%;background:${color}"></div></div>
          <div class="pillar-note">${esc(p.note || '')}</div>
        </div>`;
      })
      .join('');
    return `<div style="margin-bottom:12px;font-size:13px;color:var(--ink-2)">
        A transparent 0–100 investability score built from five weighted pillars.</div>${bars}`;
  }

  function subHTML(rows, subMax) {
    return `${rows
      .map(
        ([label, val, cls]) => `
        <div class="sub-row">
          <div class="sub-head"><span class="l">${label}</span><span class="v">${x(val)}</span></div>
          <div class="sub-bar"><div class="sub-fill ${cls}" style="width:${Math.min(100, (Number(val) / subMax) * 100)}%"></div></div>
        </div>`
      )
      .join('')}`;
  }

  function objectsHTML(objects) {
    const list = objects.slice(0, 8);
    const more = objects.length > 8 ? `<li style="opacity:.7">…and ${objects.length - 8} more</li>` : '';
    return `<ul class="obj-list">${list
      .map(
        (o) =>
          `<li><span>${esc(o.object)}</span><span class="amt">${o.amountCr != null ? cr(o.amountCr) : ''}</span></li>`
      )
      .join('')}${more}</ul>`;
  }

  function perfHTML(i, ldt) {
    const mk = i.market || {};
    const lg = i.listing || {};
    const cells = [];
    if (lg.gainPct != null) cells.push(['Listing gain', pct(lg.gainPct, true)]);
    if (lg.openPrice != null) cells.push(['Open on listing', inr(lg.openPrice)]);
    if (lg.closePrice != null) cells.push(['Close on listing', inr(lg.closePrice)]);
    if (ldt.high != null) cells.push(['Day high', inr(ldt.high)]);
    if (ldt.low != null) cells.push(['Day low', inr(ldt.low)]);
    if (mk.price != null) cells.push(['Current price', inr(mk.price)]);
    if (mk.week52High != null) cells.push(['52w high', inr(mk.week52High)]);
    if (mk.week52Low != null) cells.push(['52w low', inr(mk.week52Low)]);
    if (!cells.length) return '<div class="empty" style="padding:12px">No trading data yet.</div>';
    return `<div class="ldt-grid">${cells
      .map(([l, v]) => `<div class="ldt-cell"><div class="l">${l}</div><div class="v">${v}</div></div>`)
      .join('')}</div>`;
  }

  function promotersHTML(p) {
    const rows = [];
    if (p.preIssuePct != null) rows.push(['Pre-issue holding', pct(p.preIssuePct)]);
    if (p.postIssuePct != null) rows.push(['Post-issue holding', pct(p.postIssuePct)]);
    if (p.dilution != null) rows.push(['Dilution', pct(p.dilution)]);
    const names = p.names ? `<div style="font-size:13px;color:var(--ink-2);margin-top:10px">${esc(p.names)}</div>` : '';
    return `${detailKV(rows)}${names}`;
  }

  function anchorsHTML(i) {
    const a = i.anchors || {};
    if (a.shares == null && a.amountCr == null && !a.pctOfIssue) return null;
    return detailKV(
      [
        ['Allotment date', dateS(a.allotmentDate)],
        ['Shares allotted', a.shares != null ? numFmt(a.shares) : '—'],
        ['Invested amount', cr(a.amountCr)],
        ['% of issue', a.pctOfIssue != null ? pct(a.pctOfIssue) : '—'],
      ]
    );
  }

  function reviewsHTML(rev, total) {
    const pctOf = (n) => Math.round((n / total) * 100);
    return `
      <div class="rev-bar">
        <span class="seg rev-seg-sub" style="width:${pctOf(rev.subscribe)}%"></span>
        <span class="seg rev-seg-neu" style="width:${pctOf(rev.neutral)}%"></span>
        <span class="seg rev-seg-avoid" style="width:${pctOf(rev.avoid)}%"></span>
      </div>
      <div class="rev-legend">
        <span class="sub">● <b>${rev.subscribe}</b> apply</span>
        <span class="neu">● <b>${rev.neutral}</b> neutral</span>
        <span class="avoid">● <b>${rev.avoid}</b> avoid</span>
        <span>${total} total votes</span>
      </div>`;
  }

  function peopleHTML(d, detailUrl) {
    const rows = [];
    if (d.registrar) rows.push(['Registrar', d.registrar]);
    if (d.leadManagers && d.leadManagers.length) rows.push(['Lead managers', d.leadManagers.join(', ')]);
    const link = detailUrl
      ? `<a class="src-link" href="${esc(detailUrl)}" target="_blank" rel="noopener" style="margin-top:10px;display:inline-block">View source page ↗</a>`
      : '';
    if (!rows.length) return `${link || '<span class="empty" style="padding:8px">Not available.</span>'}`;
    return `${detailKV(rows)}${link}`;
  }

  function renderDetailBody(i) {
    const d = i.detail || {};
    const sm = STATUS_META[i.status] || STATUS_META.listed;
    const sc = i.score || {};
    const listed = i.status === 'listed';

    const overviewRows = [
      ['Price band', i.issuePrice != null && d.priceBandLow != null ? `${inr(d.priceBandLow)} – ${inr(d.priceBandHigh)}` : i.issuePrice != null ? inr(i.issuePrice) : '—'],
      ['Issue price', i.issuePrice != null ? `${inr(i.issuePrice)} per share` : '—'],
      ['Lot size', d.lotSize != null ? `${numFmt(d.lotSize)} shares` : '—'],
      ['Face value', d.faceValue != null ? inr(d.faceValue) : '—'],
      ['Total issue size', i.issueAmountCr != null ? `${cr(i.issueAmountCr)}${d.totalIssueShares ? ` · ${numFmt(d.totalIssueShares)} shares` : ''}` : '—'],
      ['Fresh issue', d.freshIssueShares != null ? `${numFmt(d.freshIssueShares)} shares` : '—'],
      ['Offer for sale', d.ofsShares != null ? `${numFmt(d.ofsShares)} shares` : '—'],
      ['Sale type', d.saleType || '—'],
      ['Issued as', d.issueType || '—'],
      ['Listing at', i.exchange || d.listingAt || '—'],
      ['BSE code', i.bseCode || '—'],
      ['NSE symbol', i.nseSymbol || '—'],
      ['ISIN', i.isin || '—'],
    ];

    const subs = i.subscription || {};
    const subRows = [
      ['Total', subs.total, ''],
      ['QIB', subs.qib, ''],
      ['NII (HNI)', subs.nii, 'nii'],
      ['Retail', subs.retail, 'retail'],
      ['Employees', subs.employees, ''],
      ['Existing shareholders', subs.shareholders, ''],
      ['Others', subs.others, 'others'],
    ].filter((r) => r[1] != null);
    const subMax = Math.max(1, ...subRows.map((r) => Number(r[1]) || 0));

    const k = i.kpi || {};
    const f = i.financials || {};
    const finRows = [
      ['Period ended', f.period || k.date || '—'],
      ['Revenue', cr(f.revenueCr)],
      ['Profit after tax', cr(f.patCr)],
      ['EBITDA', cr(f.ebitdaCr)],
      ['Net worth', cr(f.netWorthCr)],
      ['Total borrowings', cr(f.borrowingsCr)],
      ['Total assets', cr(f.assetsCr)],
    ];
    const valRows = [
      ['RoNW', k.ronw != null ? pct(k.ronw) : '—'],
      ['ROE', k.roe != null ? pct(k.roe) : '—'],
      ['ROCE', k.roce != null ? pct(k.roce) : '—'],
      ['PAT margin', k.patMargin != null ? pct(k.patMargin) : '—'],
      ['EBITDA margin', k.ebitdaMargin != null ? pct(k.ebitdaMargin) : '—'],
      ['P/E pre-issue', k.pePre != null ? `${numFmt(k.pePre)}×` : '—'],
      ['P/E post-issue', k.pePost != null ? `${numFmt(k.pePost)}×` : '—'],
      ['Price / book', k.priceToBook != null ? `${numFmt(k.priceToBook)}×` : '—'],
      ['EPS pre-issue', k.epsPre != null ? inr(k.epsPre) : '—'],
      ['EPS post-issue', k.epsPost != null ? inr(k.epsPost) : '—'],
    ];

    const rev = i.reviews || { subscribe: 0, neutral: 0, avoid: 0 };
    const revTotal = Math.max(1, rev.subscribe + rev.neutral + rev.avoid);
    const promo = d.promoters ? promotersHTML(d.promoters) : '' ;

    app.innerHTML = `
      <button class="back" id="backBtn">${icon('arrow')} Back to tracker</button>

      <section class="detail-hero">
        <div style="min-width:0;flex:1">
          <div class="hero-title-row">
            <h1>${esc(i.name)}</h1>
            <button class="icon-btn" id="copyLink" type="button" title="Copy link to this page" aria-label="Copy link">${icon('link')}</button>
          </div>
          <div class="meta">
            <span class="badge ${sm.cls}">● ${sm.label}</span>
            <span class="badge ${i.category === 'SME' ? 'sme' : ''}">${esc(i.category || '—')}</span>
            <span class="badge ${i.nseSymbol ? '' : 'muted'}">${esc(i.nseSymbol || i.exchange || '—')}</span>
          </div>
          <div class="qf-grid">
            <div class="qf"><span class="qf-l">Bids open</span><span class="qf-v">${dateS(i.openDate)}</span></div>
            <div class="qf"><span class="qf-l">Bids close</span><span class="qf-v">${dateS(i.closeDate)}</span></div>
            <div class="qf"><span class="qf-l">${listed ? 'Listed on' : 'Expected listing'}</span><span class="qf-v">${dateS(i.listingDate)}</span></div>
            <div class="qf"><span class="qf-l">Lot size</span><span class="qf-v">${d.lotSize != null ? `${numFmt(d.lotSize)} sh` : '—'}</span></div>
            <div class="qf"><span class="qf-l">Issue size</span><span class="qf-v">${i.issueAmountCr != null ? `₹${numFmt(i.issueAmountCr, 0)} Cr` : '—'}</span></div>
            <div class="qf"><span class="qf-l">Subscription</span><span class="qf-v">${x(i.subscriptionX)}</span></div>
          </div>
        </div>
        <div class="hero-score">
          ${scoreRing(sc.score || 0, sc.tone || 'neutral', 84)}
          <div class="hero-side">
            <div class="verdict-big" style="color:${toneColor(sc.tone || 'neutral')}">${esc(sc.verdict || '—')}</div>
            <div class="verdict-meta">${sc.score || 0} / 100 investability</div>
            <span class="conf-pill">${esc(sc.confidence || 'low')} confidence</span>
          </div>
        </div>
      </section>

      ${chartsHTML(i)}

      <div class="detail-grid">
        ${panel(icon('tag'), 'Issue details', detailKV(overviewRows))}
        ${panel(icon('calendar'), 'IPO timeline', timelineHTML(timelineItems(i)))}
        ${panel(icon('chart'), 'Why this score', scoreBreakdown(sc), 'full')}
        ${panel(icon('fire'), 'Subscription demand', subHTML(subRows, subMax), i.subscriptionX != null ? '' : 'full')}
        ${panel(icon('coin'), 'Financials', detailKV(finRows))}
        ${panel(icon('scale'), 'Valuation & ratios', detailKV(valRows))}
        ${listed || (i.market && i.market.price != null) ? panel(icon('spark'), 'Market & listing performance', perfHTML(i, d.listingDayTrading || {}), 'full') : ''}
        ${d.objects && d.objects.length ? panel(icon('target'), `Issue objects (${d.objects.length})`, objectsHTML(d.objects)) : ''}
        ${promo ? panel(icon('users'), 'Promoters', promo) : ''}
        ${anchorsHTML(i) ? panel(icon('bank'), 'Anchor investors', anchorsHTML(i)) : ''}
        ${panel(icon('star'), 'Community & analyst reviews', reviewsHTML(rev, revTotal))}
        ${panel(icon('building'), 'Registrar & lead managers', peopleHTML(d, i.detailUrl))}
      </div>

      <p class="disclaimer">Score = Demand (25) + Fundamentals (25) + Valuation (20) + Performance (15) + Sentiment (15)${
        i.category === 'SME' ? ', with a 12% risk haircut for SME issues' : ''
      }. Scores are a rule-based heuristic over public data — <b>not investment advice</b>. Always read the RHP before applying.</p>

      ${subscribeHTML()}
    `;

    $('#backBtn').addEventListener('click', () => go('/'));
    bindSubscribe();
    const copyBtn = $('#copyLink');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        navigator.clipboard
          .writeText(location.href)
          .then(() => {
            copyBtn.innerHTML = icon('check');
            copyBtn.classList.add('ok');
            setTimeout(() => {
              copyBtn.innerHTML = icon('link');
              copyBtn.classList.remove('ok');
            }, 1400);
          })
          .catch(() => {});
      });
    }
  }

  /* ---------------- subscribe section ---------------- */
  function subscribeHTML() {
    return `<section class="subscribe" aria-label="Subscribe for IPO updates">
      <div class="sub-card">
        <div class="sub-glow" aria-hidden="true"></div>
        <div class="sub-copy">
          <h2>Never miss an IPO</h2>
          <p>Get upcoming IPO alerts, listing-day results and our weekly scorecard digest in your inbox — free, no spam, unsubscribe anytime.</p>
          <p class="sub-count" id="subCount" hidden><b>0</b> investors already track IPOs with us</p>
        </div>
        <div class="sub-form-wrap">
          <form id="subForm" class="sub-form" novalidate>
            <div class="sub-field">
              <input id="subEmail" name="email" type="email" placeholder="you@example.com" autocomplete="email" required aria-label="Email address" />
              <button class="btn primary sub-btn" type="submit">${icon('bell')}<span>Subscribe</span></button>
            </div>
            <div class="sub-prefs" role="group" aria-label="Email preferences">
              <label class="pref"><input type="checkbox" name="upcoming" checked /><span>Upcoming IPO alerts</span></label>
              <label class="pref"><input type="checkbox" name="weeklyDigest" checked /><span>Weekly digest</span></label>
              <label class="pref"><input type="checkbox" name="analysis" checked /><span>Deep-dive analysis</span></label>
            </div>
            <p class="sub-msg" id="subMsg" role="status" aria-live="polite"></p>
          </form>
          <div class="sub-done" id="subDone" hidden>
            <span class="sub-done-ic">${icon('check')}</span>
            <div>
              <b>You&rsquo;re on the list!</b>
              <p id="subDoneText">IPO alerts are on the way.</p>
              <button class="sub-again" id="subAgain" type="button">Use a different email</button>
            </div>
          </div>
        </div>
      </div>
    </section>`;
  }

  function bindSubscribe() {
    const form = $('#subForm');
    if (!form) return;
    const msg = $('#subMsg');
    const done = $('#subDone');
    const doneText = $('#subDoneText');
    const emailInput = $('#subEmail');
    const showDone = (email, already, confirmationSent) => {
      form.hidden = true;
      done.hidden = false;
      doneText.textContent = already
        ? `${email} was already subscribed — you're all set.`
        : confirmationSent
          ? `A confirmation email is on its way to ${email}.`
          : `You're saved, ${email} — email delivery isn't configured on this server yet.`;
    };
    let saved = null;
    try { saved = localStorage.getItem('ipo-sub-email'); } catch (e) {}
    if (saved) showDone(saved, true);
    $('#subAgain').addEventListener('click', () => {
      done.hidden = true;
      form.hidden = false;
      emailInput.focus();
    });
    api('/api/subscribers/count')
      .then((c) => {
        const el = $('#subCount');
        if (el && c && c.count > 0) {
          el.hidden = false;
          el.querySelector('b').textContent = numFmt(c.count);
        }
      })
      .catch(() => {});
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const email = emailInput.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        msg.textContent = 'Please enter a valid email address.';
        msg.className = 'sub-msg err';
        emailInput.focus();
        return;
      }
      const btn = form.querySelector('.sub-btn');
      btn.disabled = true;
      msg.textContent = 'Subscribing…';
      msg.className = 'sub-msg';
      const preferences = {};
      form.querySelectorAll('.pref input').forEach((cb) => {
        preferences[cb.name] = cb.checked;
      });
      fetch(API_BASE + '/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, preferences }),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
          try { localStorage.setItem('ipo-sub-email', email); } catch (err) {}
          showDone(email, !!data.already, !!data.confirmationSent);
        })
        .catch((err) => {
          const m = String((err && err.message) || err);
          msg.textContent = /failed to fetch|networkerror/i.test(m) ? 'Network error — please try again.' : m;
          msg.className = 'sub-msg err';
        })
        .finally(() => {
          btn.disabled = false;
        });
    });
  }

  /* ---------------- theme toggle ---------------- */
  function setThemeIcon() {
    const btn = $('#themeBtn');
    if (!btn) return;
    const dark = document.documentElement.dataset.theme === 'dark';
    btn.innerHTML = dark ? icon('moon') : icon('sun');
    btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  }
  function initTheme() {
    const btn = $('#themeBtn');
    setThemeIcon();
    if (!btn) return;
    btn.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('ipo-theme', next); } catch (e) {}
      setThemeIcon();
    });
  }

  /* ---------------- boot ---------------- */
  // The brand link is authored as "/" for root hosting — rebase it for Pages subpaths.
  const brand = document.querySelector('a.brand');
  if (brand && SITE_BASE !== '/') brand.setAttribute('href', SITE_BASE);
  initTheme();
  route();
  loadMeta();
  // auto-refresh data freshness every 5 min
  setInterval(loadMeta, 5 * 60 * 1000);
})();