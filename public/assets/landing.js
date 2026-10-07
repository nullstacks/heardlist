(() => {
  'use strict';

  const BASE = location.protocol.startsWith('http') ? location.origin : 'https://YOUR-HOST';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const nf = new Intl.NumberFormat('en-US');

  // Fill base URL everywhere
  $$('[data-base]').forEach((el) => (el.textContent = BASE));

  // ---------- Tuning dial: needle follows scroll ----------
  const top = $('#top');
  let ticking = false;
  const setNeedle = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    top.style.setProperty('--p', max > 0 ? Math.min(1, scrollY / max).toFixed(4) : 0);
    ticking = false;
  };
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(setNeedle); } }, { passive: true });
  addEventListener('resize', setNeedle);
  setNeedle();

  // ---------- Copy buttons ----------
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      const t = document.createElement('textarea');
      t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      t.remove();
      return ok;
    }
  }
  function flash(btn, msg = 'Copied') {
    const old = btn.dataset.label || btn.textContent;
    btn.dataset.label = old;
    btn.textContent = msg;
    btn.setAttribute('data-done', '');
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.textContent = old; btn.removeAttribute('data-done'); }, 1400);
  }
  $$('[data-copy]').forEach((btn) => btn.addEventListener('click', async () => {
    const src = $(btn.dataset.copy);
    const ok = await copyText(src.textContent.trim());
    flash(btn, ok ? 'Copied' : 'Press Ctrl+C');
  }));

  // ---------- API helper ----------
  async function api(path, { text = false } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(BASE + path, { signal: ctrl.signal, headers: { accept: text ? 'text/plain' : 'application/json' } });
      if (!res.ok) {
        let msg = `Request failed (${res.status})`;
        try { const j = await res.json(); if (j.error && j.error.message) msg = j.error.message; } catch { /* ignore */ }
        const e = new Error(msg); e.status = res.status; throw e;
      }
      return text ? res.text() : res.json();
    } finally { clearTimeout(t); }
  }

  // ---------- Stats: ticker, postmark, source counts ----------
  function ago(min) {
    if (min == null) return 'unknown';
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const h = Math.round(min / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
  }
  async function loadStats() {
    const tk = $('#ticker');
    try {
      const s = await api('/v1/stats');
      if (!s.total) {
        tk.innerHTML = 'The list is empty. The first hourly refresh hasn’t run yet — check back shortly.';
      } else {
        tk.innerHTML =
          `Now on the list: <b>${nf.format(s.verified)}</b> verified stations, <b>${nf.format(s.total)}</b> in total, across <b>${nf.format(s.countries)}</b> countries. ` +
          `Last refreshed <b>${ago(s.age_minutes)}</b>${s.stale ? ' — <b>data is stale</b>, upstream may be down' : ''}.`;
      }
      if (s.updated_at) {
        const d = new Date(s.updated_at);
        $('#pm-day').textContent = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }).toUpperCase();
        $('#pm-time').textContent = d.toISOString().slice(11, 16) + ' UTC';
      }
      for (const [name, n] of Object.entries(s.by_source)) {
        const el = $(`[data-src-count="${name}"]`);
        if (el) el.textContent = nf.format(n);
      }
    } catch (e) {
      tk.textContent = 'Couldn’t load live counts right now. The API itself may still be fine — try a query below.';
      $$('[data-src-count]').forEach((el) => (el.textContent = ''));
    }
  }

  // ---------- Station card ----------
  const card = $('#qsl');
  const F = { proto: $('#q-proto'), station: $('#q-station'), country: $('#q-country'), latency: $('#q-latency'), anon: $('#q-anon'), source: $('#q-source'), msg: $('#q-msg') };
  let current = null;
  let drawing = 0;

  const setState = (s) => { card.dataset.state = s; card.setAttribute('aria-busy', String(s === 'loading')); };
  const SRC = { monosans: 'monosans · verified', proxifly: 'proxifly · unverified', thespeedx: 'TheSpeedX · unverified' };

  function fill(p) {
    F.proto.textContent = p.protocol;
    F.country.textContent = p.country || 'unknown';
    F.latency.textContent = p.latency != null ? `${p.latency.toFixed(2)} s` : 'not measured';
    F.anon.textContent = p.anonymity || 'not stated';
    F.source.textContent = SRC[p.source] || p.source;
  }

  // The station number "tunes in": digits scramble, then settle left to right.
  function tuneIn(finalText) {
    return new Promise((resolve) => {
      if (reduceMotion) { F.station.textContent = finalText; return resolve(); }
      const start = performance.now();
      const dur = 520;
      const step = (now) => {
        const t = Math.min(1, (now - start) / dur);
        const settled = Math.floor(t * finalText.length);
        let out = '';
        for (let i = 0; i < finalText.length; i++) {
          const ch = finalText[i];
          out += i < settled || !/\d/.test(ch) ? ch : String(Math.floor(Math.random() * 10));
        }
        F.station.textContent = out;
        if (t < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  async function draw() {
    const id = ++drawing;
    setState('loading');
    F.msg.hidden = true;
    ['proto', 'station', 'country', 'latency', 'anon', 'source'].forEach((k) => (F[k].textContent = '—'));
    try {
      const j = await api('/v1/random?verified=true');
      if (id !== drawing) return;
      const p = j.data[0];
      if (!p) {
        current = null;
        setState('empty');
        F.station.textContent = 'No stations yet';
        F.msg.textContent = 'The list is empty — the first hourly refresh hasn’t run yet.';
        F.msg.hidden = false;
        return;
      }
      current = p;
      fill(p);
      setState('ready');
      await tuneIn(p.proxy);
    } catch (e) {
      if (id !== drawing) return;
      current = null;
      setState('error');
      F.station.textContent = 'Off the air';
      F.msg.textContent = e.name === 'AbortError' ? 'The API took too long to answer. Try again.' : `Couldn’t draw a station: ${e.message}`;
      F.msg.hidden = false;
    }
  }
  $('#q-again').addEventListener('click', draw);
  $('#q-copy').addEventListener('click', async (ev) => {
    if (!current) return flash(ev.currentTarget, 'Nothing yet');
    flash(ev.currentTarget, (await copyText(current.url)) ? 'Copied' : 'Press Ctrl+C');
  });

  // ---------- Playground ----------
  const form = $('#controls');
  const out = { url: $('#q-url'), open: $('#q-open'), meta: $('#result-meta'), body: $('#result-body'), box: $('#result') };
  let timer = null;
  let seq = 0;

  function buildPath() {
    const p = new URLSearchParams();
    const proto = form.elements.protocol.value;
    if (proto) p.set('protocol', proto);
    const country = $('#f-country').value.replace(/\s+/g, '');
    if (country) p.set('country', country);
    if ($('#f-verified').checked) p.set('verified', 'true');
    const sort = $('#f-sort').value;
    if (sort !== 'quality') p.set('sort', sort);
    const fmt = $('#f-format').value;
    if (fmt !== 'json') p.set('format', fmt);
    p.set('limit', $('#f-limit').value);
    return `/v1/proxies?${p.toString().replace(/%2C/gi, ',')}`;
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function stateBox(title, text) {
    out.body.innerHTML = `<div class="result-state"><b>${esc(title)}</b>${esc(text)}</div>`;
  }

  async function run() {
    const my = ++seq;
    const path = buildPath();
    out.url.textContent = BASE + path;
    out.open.href = BASE + path;
    out.box.setAttribute('aria-busy', 'true');
    const fmt = $('#f-format').value;
    try {
      if (fmt === 'json') {
        const j = await api(path);
        if (my !== seq) return;
        out.meta.textContent = `${nf.format(j.meta.count)} of ${nf.format(j.meta.total)} matching · updated ${j.meta.updated_at ? new Date(j.meta.updated_at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'never'}`;
        if (!j.data.length) {
          stateBox('Nothing heard.', 'No proxies match those filters. Loosen one — try dropping “Verified only” or the country.');
        } else {
          out.body.innerHTML =
            '<table><thead><tr><th>Proxy</th><th>Protocol</th><th>Country</th><th>Response</th><th>Source</th></tr></thead><tbody>' +
            j.data.map((r) =>
              `<tr><td>${esc(r.proxy)}</td><td>${esc(r.protocol)}</td><td>${esc(r.country || '—')}</td><td class="num">${r.latency != null ? r.latency.toFixed(2) + ' s' : '—'}</td><td>${r.verified ? '<span class="tag-v">verified</span>' : '<span class="tag-u">' + esc(r.source) + '</span>'}</td></tr>`
            ).join('') + '</tbody></table>';
        }
      } else {
        const t = await api(path, { text: true });
        if (my !== seq) return;
        const lines = t.trim() ? t.trim().split('\n').length - (fmt === 'csv' ? 1 : 0) : 0;
        out.meta.textContent = `${nf.format(lines)} lines · ${fmt === 'csv' ? 'text/csv' : 'text/plain'}`;
        if (!lines) stateBox('Nothing heard.', 'No proxies match those filters.');
        else out.body.innerHTML = `<pre>${esc(t)}</pre>`;
      }
    } catch (e) {
      if (my !== seq) return;
      out.meta.textContent = 'Request failed';
      stateBox(e.status === 400 ? 'That query isn’t valid.' : 'Couldn’t reach the list.', e.name === 'AbortError' ? 'The API took too long to answer.' : e.message);
    } finally {
      if (my === seq) out.box.setAttribute('aria-busy', 'false');
    }
  }

  const schedule = () => { clearTimeout(timer); out.box.setAttribute('aria-busy', 'true'); timer = setTimeout(run, 280); };
  form.addEventListener('input', schedule);
  form.addEventListener('change', schedule);

  // ---------- go ----------
  loadStats();
  draw();
  run();
})();
