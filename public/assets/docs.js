(() => {
  'use strict';
  const BASE = location.protocol.startsWith('http') ? location.origin : 'https://YOUR-HOST';
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // Fill the base URL everywhere
  $$('[data-base]').forEach((el) => (el.textContent = BASE));

  // Dial needle follows scroll
  const top = document.getElementById('top');
  let tick = false;
  const needle = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    top.style.setProperty('--p', max > 0 ? Math.min(1, scrollY / max).toFixed(4) : 0);
    tick = false;
  };
  addEventListener('scroll', () => { if (!tick) { tick = true; requestAnimationFrame(needle); } }, { passive: true });
  addEventListener('resize', needle);
  needle();

  // Contents: open on desktop, collapsed on narrow screens; close after choosing a link
  const rail = document.getElementById('rail');
  const mq = matchMedia('(max-width: 900px)');
  const syncRail = () => { rail.open = !mq.matches; };
  syncRail();
  mq.addEventListener('change', syncRail);
  rail.addEventListener('click', (e) => { if (mq.matches && e.target.closest('a')) rail.open = false; });

  // Copy buttons on code blocks
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      const t = document.createElement('textarea');
      t.value = text; t.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(t); t.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      t.remove(); return ok;
    }
  }
  $$('.prose pre').forEach((pre) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'code-copy'; b.textContent = 'Copy';
    b.setAttribute('aria-label', 'Copy code');
    b.addEventListener('click', async () => {
      const ok = await copy(pre.querySelector('code').textContent);
      b.textContent = ok ? 'Copied' : 'Ctrl+C'; b.setAttribute('data-done', '');
      clearTimeout(b._t);
      b._t = setTimeout(() => { b.textContent = 'Copy'; b.removeAttribute('data-done'); }, 1400);
    });
    pre.appendChild(b);
  });

  // Rail highlights the section you're reading
  const links = new Map($$('.rail-nav a').map((a) => [a.getAttribute('href').slice(1), a]));
  const sections = [...links.keys()].map((id) => document.getElementById(id)).filter(Boolean);
  let activeId = null;
  function setActive(id) {
    if (id === activeId) return;
    activeId = id;
    links.forEach((a, k) => (k === id ? a.setAttribute('aria-current', 'true') : a.removeAttribute('aria-current')));
    const a = links.get(id);
    if (a && !mq.matches) {
      const box = rail.getBoundingClientRect();
      const r = a.getBoundingClientRect();
      if (r.top < box.top + 40 || r.bottom > box.bottom - 40) a.scrollIntoView({ block: 'nearest' });
    }
  }
  function pick() {
    let cur = sections[0];
    for (const s of sections) { if (s.getBoundingClientRect().top <= 140) cur = s; else break; }
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) cur = sections[sections.length - 1];
    if (cur) setActive(cur.id);
  }
  let t2 = false;
  addEventListener('scroll', () => { if (!t2) { t2 = true; requestAnimationFrame(() => { pick(); t2 = false; }); } }, { passive: true });
  pick();
})();
