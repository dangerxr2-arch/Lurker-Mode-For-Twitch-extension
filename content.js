/* Twitch Chat Viewer - content script
 * Muestra el chat de un canal en modo SOLO LECTURA usando una conexión
 * IRC anónima (justinfan), integrada en la columna del chat de Twitch. */
(() => {
  'use strict';

  /* ===== Selectores de Twitch =====
   * Si Twitch cambia su HTML y el icono o el panel no aparecen bien,
   * edita solo este bloque. */
  const SELECTORS = {
    // Cabecera del chat (donde se coloca el icono)
    header: [
      '.stream-chat-header',
      '[data-test-selector="chat-room-header"]',
    ],
    // Zona de mensajes + caja de escribir (lo que cubre nuestro panel)
    container: [
      'section[data-test-selector="chat-room-component-layout"]',
      '.chat-room',
      '.chat-shell',
    ],
  };

  const MAX_MESSAGES = 150;
  const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';
  const RESERVED = new Set([
    'directory', 'videos', 'settings', 'downloads', 'turbo', 'subscriptions',
    'wallet', 'inventory', 'drops', 'friends', 'messages', 'p', 'search',
    'jobs', 'store', 'prime', 'moderator', 'popout', 'embed', 'u', 'login',
    'signup', 'following', 'team', 'broadcast', 'dashboard', 'payments',
  ]);

  /* ===== Estado ===== */
  let channel = null;
  let active = false;
  let ws = null;
  let retries = 0;
  let retryTimer = null;
  let btn = null;
  let overlay = null;
  let listEl = null;
  let resumeEl = null;
  let statusDot = null;
  let statusText = null;
  let pinned = true;

  /* ===== Utilidades ===== */
  const $first = (list) => {
    for (const s of list) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function getChannel() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length !== 1) return null;
    const c = parts[0].toLowerCase();
    if (RESERVED.has(c) || !/^[a-z0-9_]{3,25}$/.test(c)) return null;
    return c;
  }

  const store = {
    async get() {
      try {
        const r = await chrome.storage.local.get('channels');
        return new Set(r.channels || []);
      } catch (_) {
        return new Set();
      }
    },
    async set(s) {
      try {
        await chrome.storage.local.set({ channels: [...s] });
      } catch (_) { /* sin almacenamiento */ }
    },
  };

  /* ===== Parser IRC ===== */
  function unescapeTag(v) {
    return v.replace(/\\(.)/g, (_, c) =>
      ({ ':': ';', s: ' ', r: '\r', n: '\n', '\\': '\\' }[c] ?? c));
  }

  function parseLine(line) {
    const tags = {};
    let rest = line;
    if (rest[0] === '@') {
      const i = rest.indexOf(' ');
      rest.slice(1, i).split(';').forEach((p) => {
        const eq = p.indexOf('=');
        if (eq === -1) tags[p] = '';
        else tags[p.slice(0, eq)] = unescapeTag(p.slice(eq + 1));
      });
      rest = rest.slice(i + 1);
    }
    let prefix = '';
    if (rest[0] === ':') {
      const i = rest.indexOf(' ');
      prefix = rest.slice(1, i);
      rest = rest.slice(i + 1);
    }
    let trailing = null;
    const ci = rest.indexOf(' :');
    if (ci !== -1) {
      trailing = rest.slice(ci + 2);
      rest = rest.slice(0, ci);
    }
    const parts = rest.split(' ');
    return { tags, prefix, command: parts[0], params: parts.slice(1), trailing };
  }

  /* ===== Colores ===== */
  const FALLBACK_COLORS = [
    '#FF4A4A', '#FF7F50', '#9ACD32', '#2E8B57', '#1E90FF',
    '#FF69B4', '#8A2BE2', '#00CED1', '#DAA520', '#D2691E',
  ];

  function userColor(hex, login) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) {
      let h = 0;
      for (const ch of login) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return FALLBACK_COLORS[h % FALLBACK_COLORS.length];
    }
    let r = parseInt(m[1].slice(0, 2), 16);
    let g = parseInt(m[1].slice(2, 4), 16);
    let b = parseInt(m[1].slice(4, 6), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (lum < 0.5) {
      const t = (0.5 - lum) / (1 - lum);
      r = Math.round(r + (255 - r) * t);
      g = Math.round(g + (255 - g) * t);
      b = Math.round(b + (255 - b) * t);
    }
    return `rgb(${r}, ${g}, ${b})`;
  }

  /* ===== Render de mensajes ===== */
  function renderText(text, emotesTag) {
    const frag = document.createDocumentFragment();
    const chars = Array.from(text);
    const ranges = [];
    if (emotesTag) {
      emotesTag.split('/').forEach((g) => {
        const [id, pos] = g.split(':');
        if (!id || !pos) return;
        pos.split(',').forEach((p) => {
          const [s, e] = p.split('-').map(Number);
          if (Number.isFinite(s) && Number.isFinite(e)) ranges.push({ s, e, id });
        });
      });
    }
    ranges.sort((a, b) => a.s - b.s);
    let i = 0;
    for (const r of ranges) {
      if (r.s < i) continue;
      if (r.s > i) frag.append(chars.slice(i, r.s).join(''));
      const name = chars.slice(r.s, r.e + 1).join('');
      const base = `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(r.id)}/default/dark`;
      const img = el('img', 'tcv-emote');
      img.src = `${base}/1.0`;
      img.srcset = `${base}/1.0 1x, ${base}/2.0 2x`;
      img.alt = name;
      img.title = name;
      frag.append(img);
      i = r.e + 1;
    }
    if (i < chars.length) frag.append(chars.slice(i).join(''));
    return frag;
  }

  function push(node) {
    if (!listEl) return;
    listEl.appendChild(node);
    while (listEl.childElementCount > MAX_MESSAGES) listEl.firstElementChild.remove();
    if (pinned) listEl.scrollTop = listEl.scrollHeight;
  }

  function systemLine(text, cls) {
    push(el('div', 'tcv-sys' + (cls ? ' ' + cls : ''), text));
  }

  function chatLine(m, isUsernotice) {
    const login = (m.prefix.split('!')[0] || m.tags.login || '').toLowerCase();
    let text = m.trailing || '';
    let action = false;
    const am = /^\u0001ACTION (.*)\u0001$/.exec(text);
    if (am) {
      action = true;
      text = am[1];
    }
    const color = userColor(m.tags.color, login);
    const row = el('div', 'tcv-msg');
    if (m.tags.id) row.dataset.id = m.tags.id;
    row.dataset.login = login;

    if (isUsernotice && m.tags['system-msg']) {
      row.appendChild(el('div', 'tcv-notice', m.tags['system-msg']));
      if (!text) {
        push(row);
        return;
      }
    }

    const name = el('span', 'tcv-name', m.tags['display-name'] || login);
    name.style.color = color;
    row.appendChild(name);
    row.appendChild(el('span', 'tcv-colon', action ? ' ' : ': '));
    const body = el('span', 'tcv-text');
    if (action) body.style.color = color;
    body.appendChild(renderText(text, m.tags.emotes));
    row.appendChild(body);
    push(row);
  }

  /* ===== Conexión IRC anónima ===== */
  function setStatus(kind) {
    if (!statusDot) return;
    const map = {
      connecting: ['Conectando…', 'tcv-s-wait'],
      connected: ['Conectado de forma anónima · solo lectura', 'tcv-s-ok'],
      reconnecting: ['Reconectando…', 'tcv-s-wait'],
    };
    const [txt, cls] = map[kind];
    statusText.textContent = txt;
    statusDot.className = 'tcv-dot ' + cls;
  }

  function handle(sock, line) {
    const m = parseLine(line);
    switch (m.command) {
      case 'PING':
        sock.send('PONG :tmi.twitch.tv');
        break;
      case '001':
      case 'ROOMSTATE':
        retries = 0;
        setStatus('connected');
        break;
      case 'PRIVMSG':
        chatLine(m, false);
        break;
      case 'USERNOTICE':
        chatLine(m, true);
        break;
      case 'CLEARCHAT':
        if (m.trailing) {
          listEl.querySelectorAll(`.tcv-msg[data-login="${CSS.escape(m.trailing.toLowerCase())}"]`)
            .forEach((r) => r.classList.add('tcv-deleted'));
        } else {
          systemLine('El chat fue limpiado por un moderador.');
        }
        break;
      case 'CLEARMSG': {
        const id = m.tags['target-msg-id'];
        if (id) {
          const r = listEl.querySelector(`.tcv-msg[data-id="${CSS.escape(id)}"]`);
          if (r) r.classList.add('tcv-deleted');
        }
        break;
      }
      case 'NOTICE':
        if (m.trailing) systemLine(m.trailing);
        break;
      case 'RECONNECT':
        sock.close();
        break;
      default:
        break;
    }
  }

  function connect(ch) {
    disconnect();
    setStatus('connecting');
    const sock = new WebSocket(IRC_URL);
    ws = sock;
    sock.onopen = () => {
      sock.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      sock.send('PASS SCHMOOPIIE');
      sock.send('NICK justinfan' + (10000 + Math.floor(Math.random() * 80000)));
      sock.send('JOIN #' + ch);
    };
    sock.onmessage = (e) => {
      if (ws !== sock || typeof e.data !== 'string') return;
      e.data.split('\r\n').filter(Boolean).forEach((l) => handle(sock, l));
    };
    sock.onclose = () => {
      if (ws !== sock || !active) return;
      setStatus('reconnecting');
      const wait = Math.min(30000, 1000 * 2 ** retries++);
      retryTimer = setTimeout(() => {
        if (active && channel === ch) connect(ch);
      }, wait);
    };
    sock.onerror = () => { try { sock.close(); } catch (_) { /* noop */ } };
  }

  function disconnect() {
    clearTimeout(retryTimer);
    retryTimer = null;
    if (ws) {
      const s = ws;
      ws = null;
      try { s.close(); } catch (_) { /* noop */ }
    }
  }

  /* ===== UI: botón y panel ===== */
  const ICON = `
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
         stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>
      <circle cx="12" cy="10.5" r="2.2"/>
      <path d="M7.5 10.5c1-1.8 2.6-2.7 4.5-2.7s3.5.9 4.5 2.7"/>
    </svg>`;

  function buildButton() {
    btn = el('button', 'tcv-btn');
    btn.type = 'button';
    btn.title = 'Mostrar chat (solo lectura)';
    btn.setAttribute('aria-label', 'Mostrar chat de solo lectura');
    btn.innerHTML = ICON; // contenido estático propio, sin datos externos
    btn.addEventListener('click', () => activate(!active, true));
  }

  function buildOverlay() {
    overlay = el('div', 'tcv-overlay');
    listEl = el('div', 'tcv-list');
    resumeEl = el('button', 'tcv-resume', 'Chat pausado · ir al final');
    resumeEl.type = 'button';
    resumeEl.hidden = true;
    const footer = el('div', 'tcv-footer');
    statusDot = el('span', 'tcv-dot tcv-s-wait');
    statusText = el('span', 'tcv-status', 'Conectando…');
    footer.append(statusDot, statusText);

    listEl.addEventListener('scroll', () => {
      pinned = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 40;
      resumeEl.hidden = pinned;
    });
    resumeEl.addEventListener('click', () => {
      pinned = true;
      resumeEl.hidden = true;
      listEl.scrollTop = listEl.scrollHeight;
    });
    overlay.append(listEl, resumeEl, footer);
  }

  function ensureButton() {
    if (!btn) buildButton();
    const header = $first(SELECTORS.header);
    if (header) {
      if (btn.parentElement !== header) header.appendChild(btn);
      btn.classList.remove('tcv-floating');
      if (getComputedStyle(header).position === 'static') header.style.position = 'relative';
    } else if (btn.parentElement !== document.body) {
      document.body.appendChild(btn);
      btn.classList.add('tcv-floating');
    }
    btn.classList.toggle('tcv-on', active);
    btn.setAttribute('aria-pressed', String(active));
  }

  function ensureOverlay() {
    if (!overlay) buildOverlay();
    const container = $first(SELECTORS.container);
    if (container) {
      if (overlay.parentElement !== container) container.appendChild(overlay);
      overlay.classList.remove('tcv-fixed');
      if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
      const header = $first(SELECTORS.header);
      let top = 0;
      if (header && container.contains(header)) {
        top = header.getBoundingClientRect().bottom - container.getBoundingClientRect().top;
      }
      overlay.style.top = Math.max(0, top) + 'px';
    } else if (overlay.parentElement !== document.body) {
      document.body.appendChild(overlay);
      overlay.classList.add('tcv-fixed');
      overlay.style.top = '';
    }
  }

  function render() {
    if (!channel) {
      if (btn) btn.remove();
      if (overlay) overlay.remove();
      return;
    }
    ensureButton();
    if (active) ensureOverlay();
    else if (overlay) overlay.remove();
  }

  async function activate(on, persist) {
    if (on === active) return;
    active = on;
    if (on) {
      pinned = true;
      render();
      if (listEl) listEl.textContent = '';
      connect(channel);
    } else {
      disconnect();
      render();
    }
    if (persist && channel) {
      const set = await store.get();
      if (on) set.add(channel);
      else set.delete(channel);
      store.set(set);
    }
  }

  /* ===== Ciclo: detectar navegación y cambios del DOM ===== */
  function tick() {
    const ch = getChannel();
    if (ch !== channel) {
      disconnect();
      active = false;
      if (listEl) listEl.textContent = '';
      if (overlay) overlay.remove();
      channel = ch;
      if (ch) {
        store.get().then((s) => {
          if (s.has(ch) && channel === ch) activate(true, false);
        });
      }
    }
    render();
  }

  let timer = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      tick();
    }, 300);
  };

  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  setInterval(tick, 1500);
  tick();
})();
