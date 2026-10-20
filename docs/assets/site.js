// VDO.Ninja MCP site behaviour: copy buttons, code highlighting, scroll story, tabs, tool profiles, docs nav.
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ICONS = document.documentElement.dataset.icons || 'assets/icons.svg';

  function icon(name, cls = 'icon-sm') {
    return `<svg class="${cls}" aria-hidden="true"><use href="${ICONS}#${name}"></use></svg>`;
  }

  function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---------- Highlighting ----------
  function highlightJson(text) {
    return escapeHtml(text).replace(
      /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?\b)/g,
      (m, str, colon, lit, num) => {
        if (str) return colon ? `<span class="c-key">${str}</span>${colon}` : `<span class="c-str">${str}</span>`;
        if (lit) return `<span class="c-num">${lit}</span>`;
        if (num) return `<span class="c-num">${num}</span>`;
        return m;
      }
    );
  }

  function highlightShell(text) {
    return text.split('\n').map((line) => {
      if (!line.trim()) return '';
      if (/^\s*#/.test(line)) return `<span class="c-dim">${escapeHtml(line)}</span>`;
      return `<span class="ln-cmd">${escapeHtml(line)}</span>`;
    }).join('\n');
  }

  $$('pre code.lang-json, .term-step .json').forEach((el) => { el.innerHTML = highlightJson(el.textContent); });
  $$('pre code.lang-sh').forEach((el) => {
    el.parentElement.classList.add('lang-sh');
    el.innerHTML = highlightShell(el.textContent.replace(/\n$/, ''));
  });

  // ---------- Copy buttons ----------
  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (err) { /* ignore */ }
      ta.remove();
    }
    const label = btn.querySelector('.label');
    btn.classList.add('done');
    if (label) label.textContent = 'Copied';
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.classList.remove('done'); if (label) label.textContent = 'Copy'; }, 1600);
  }

  $$('pre').forEach((pre) => {
    if (pre.classList.contains('no-copy') || pre.querySelector('.copy')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy';
    btn.setAttribute('aria-label', 'Copy code');
    btn.innerHTML = `${icon('i-copy', 'icon-xs')}<span class="label">Copy</span>`;
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code') || pre;
      const lines = code.textContent.split('\n').filter((l) => !/^\s*#/.test(l) || !pre.classList.contains('lang-sh'));
      copyText(lines.join('\n').trim(), btn);
    });
    pre.appendChild(btn);
  });

  $$('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', () => copyText(btn.dataset.copy, btn));
  });

  // ---------- Live package version (optional; hidden if the registry can't be reached) ----------
  const versionEl = $('[data-npm-version]');
  if (versionEl && window.fetch) {
    fetch('https://registry.npmjs.org/@vdoninja/mcp/latest')
      .then((r) => (r.ok ? r.json() : null))
      .then((pkg) => {
        if (pkg && /^\d+\.\d+\.\d+/.test(pkg.version || '')) {
          versionEl.textContent = ` · v${pkg.version}`;
          versionEl.hidden = false;
        }
      })
      .catch(() => {});
  }

  // ---------- Mobile nav ----------
  const nav = $('.nav');
  const navToggle = $('.nav-toggle');
  if (nav && navToggle) {
    navToggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      navToggle.setAttribute('aria-expanded', String(open));
    });
    $$('.nav-links a').forEach((a) => a.addEventListener('click', () => {
      nav.classList.remove('open');
      navToggle.setAttribute('aria-expanded', 'false');
    }));
  }

  // ---------- Tabs ----------
  $$('[data-tabs]').forEach((root) => {
    const tabs = $$('[role="tab"]', root);
    const select = (tab) => {
      tabs.forEach((t) => {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        const panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.hidden = !on;
      });
    };
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => select(tab));
      tab.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        next.focus(); select(next);
      });
    });
  });

  // ---------- Tool profiles ----------
  const PROFILES = {
    core: { groups: ['session', 'sync'], note: '9 tools: connect, message, and peer sync. Smallest context footprint.' },
    file: { groups: ['session', 'sync', 'file'], note: '15 tools: core plus chunked, resumable file transfer.' },
    state: { groups: ['session', 'sync', 'state'], note: '12 tools: core plus shared room state.' },
    full: { groups: ['session', 'sync', 'file', 'state'], note: 'All 18 tools. The default when no profile is set.' }
  };
  const profileRoot = $('[data-profiles]');
  if (profileRoot) {
    const buttons = $$('button', profileRoot);
    const note = $('.profile-note');
    const apply = (name) => {
      const p = PROFILES[name];
      buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.profile === name)));
      $$('[data-group]').forEach((g) => g.classList.toggle('off', !p.groups.includes(g.dataset.group)));
      if (note) note.innerHTML = `${p.note} <code>--tool-profile ${name}</code>`;
    };
    buttons.forEach((b) => b.addEventListener('click', () => apply(b.dataset.profile)));
    apply('full');
  }

  // ---------- Scroll story ----------
  const story = $('[data-story]');
  if (story) {
    const stage = $('.stage', story);
    const items = $$('.story-steps li', story);
    const pillNum = $('.caption-pill .num', story);
    const pillTxt = $('.caption-pill .txt', story);
    const termSteps = $$('.term-step', story);
    const termTitle = $('.term-title', story);
    const dashes = $('.dashes', story);
    const packets = $('.packets', story);
    const statusA = $('.agent-a .status', story);
    const statusB = $('.agent-b .status', story);
    const STATUS = [
      ['not connected', ''], ['MCP ready', 'ready'], ['in room', 'ready'], ['in room', 'ready'],
      ['connected', 'live'], ['connected', 'live'], ['connected', 'live'], ['connected', 'live'], ['connected', 'live']
    ];
    const STATUS_B = STATUS.map((s, i) => (i === 2 ? ['MCP ready', 'ready'] : s));
    const PACKETS = { 5: ['go-ab', 1, false], 6: ['go-ba', 1, false], 7: ['go-ab', 6, true], 8: ['go-ba', 1, false] };

    items.forEach((li, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', `Step ${i + 1}`);
      b.addEventListener('click', () => {
        const top = li.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.5 + 2;
        window.scrollTo({ top, behavior: reduceMotion ? 'auto' : 'smooth' });
      });
      dashes.appendChild(b);
    });
    const dashButtons = $$('button', dashes);

    const setStatus = (el, [text, cls]) => {
      el.textContent = text;
      el.className = `status ${cls}`.trim();
    };

    let current = -1;
    const setStep = (i) => {
      if (i === current) return;
      current = i;
      stage.dataset.step = String(i);

      $$('[data-steps]', stage).forEach((el) => {
        el.hidden = !el.dataset.steps.split(' ').includes(String(i));
      });
      $$('.agent', stage).forEach((a) => a.classList.toggle('on', i >= 1));
      setStatus(statusA, STATUS[i]);
      setStatus(statusB, STATUS_B[i]);

      $('.node-server', stage).classList.toggle('is-active', i === 2 || i === 3);
      $('.node-server', stage).classList.toggle('is-quiet', i >= 4);
      $('.l-sig-a', stage).setAttribute('class', `l-sig l-sig-a ${i === 2 || i === 3 ? 'on' : i >= 4 ? 'faded' : ''}`);
      $('.l-sig-b', stage).setAttribute('class', `l-sig l-sig-b ${i === 3 ? 'on' : i >= 4 ? 'faded' : ''}`);
      $('.l-p2p', stage).setAttribute('class', `l-p2p ${i >= 4 ? 'on' : ''}`);
      $$('.l-relay', stage).forEach((l) => l.setAttribute('class', `l-relay ${i === 4 ? 'on' : ''}`));
      $('.node-relay', stage).classList.toggle('is-quiet', i !== 4);
      $('.p2p-label', stage).classList.toggle('on', i >= 4);

      packets.className = 'packets';
      packets.innerHTML = '';
      const p = PACKETS[i];
      if (p && !reduceMotion) {
        const [dir, n, chunk] = p;
        for (let k = 0; k < n; k += 1) {
          const dot = document.createElement('i');
          dot.className = chunk ? 'packet chunk' : 'packet';
          dot.style.setProperty('--d', `${k * (chunk ? 0.35 : 0) + 0.2}s`);
          dot.style.setProperty('--n', chunk ? '1' : '2');
          packets.appendChild(dot);
        }
        void packets.offsetWidth;
        packets.classList.add(dir);
      }

      const item = items[i];
      pillNum.textContent = String(i).padStart(2, '0');
      pillTxt.innerHTML = item.innerHTML;
      termSteps.forEach((t) => t.classList.toggle('is-active', t.dataset.step === String(i)));
      const active = termSteps.find((t) => t.dataset.step === String(i));
      if (active && termTitle) termTitle.textContent = active.dataset.title || '';
      dashButtons.forEach((b, k) => b.classList.toggle('on', k <= i));
    };

    let ticking = false;
    const onScroll = () => {
      ticking = false;
      const line = window.innerHeight * 0.55;
      let idx = 0;
      items.forEach((li, k) => { if (li.getBoundingClientRect().top < line) idx = k; });
      setStep(idx);
    };
    window.addEventListener('scroll', () => {
      if (!ticking) { ticking = true; requestAnimationFrame(onScroll); }
    }, { passive: true });
    window.addEventListener('resize', onScroll);
    onScroll();
  }

  // ---------- Docs: sidebar toggle + scrollspy ----------
  const docsToggle = $('.docs-toggle');
  if (docsToggle) {
    const closeSidebar = () => {
      document.body.classList.remove('sidebar-open');
      docsToggle.setAttribute('aria-expanded', 'false');
    };
    docsToggle.setAttribute('aria-expanded', 'false');
    docsToggle.addEventListener('click', () => {
      const expanded = document.body.classList.toggle('sidebar-open');
      docsToggle.setAttribute('aria-expanded', String(expanded));
    });
    $$('.sidebar a').forEach((a) => a.addEventListener('click', closeSidebar));
    document.addEventListener('click', (event) => {
      if (!document.body.classList.contains('sidebar-open')) return;
      if (event.target.closest('.sidebar, .docs-toggle')) return;
      closeSidebar();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && document.body.classList.contains('sidebar-open')) {
        closeSidebar();
        docsToggle.focus();
      }
    });
  }
  const sideLinks = $$('.sidebar a[href^="#"]');
  const sections = $$('.doc-section');
  if (sideLinks.length && sections.length) {
    const map = new Map(sideLinks.map((a) => [a.getAttribute('href').slice(1), a]));
    let spyTicking = false;
    const spy = () => {
      spyTicking = false;
      let current = sections[0];
      sections.forEach((s) => { if (s.getBoundingClientRect().top < 140) current = s; });
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) current = sections[sections.length - 1];
      sideLinks.forEach((a) => a.classList.toggle('active', a === map.get(current.id)));
    };
    window.addEventListener('scroll', () => {
      if (!spyTicking) { spyTicking = true; requestAnimationFrame(spy); }
    }, { passive: true });
    spy();
  }
})();
