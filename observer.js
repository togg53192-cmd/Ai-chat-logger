// AI Chat Logger — content script (isolated world).
// DOM-only logging with a per-site selector config and a tiny in-page status
// badge so you can see at a glance that the extension is actually running.

(function () {
  if (window.__AI_CHAT_LOGGER_OBSERVER__) return;
  window.__AI_CHAT_LOGGER_OBSERVER__ = true;

  const TAG = '[ai-chat-logger]';
  console.log(TAG, 'content script booting on', location.hostname, document.readyState);

  // ----- site config -------------------------------------------------------
  // Each site exposes:
  //   findTurns(): returns an array of { node, role } for every chat turn
  //                currently in the DOM.
  //   modelLabel(): a short string identifying the model.
  //
  // findTurns() is the single source of truth — we re-scan on every mutation
  // and on a slow polling interval, then diff against a WeakMap of seen nodes.

  const HOST = location.hostname;
  let SITE = null;

  if (HOST.includes('claude.ai')) {
    SITE = {
      name: 'Claude',
      modelLabel() {
        const el = document.querySelector('[data-testid="model-selector-dropdown"]');
        const t = el && el.textContent && el.textContent.trim();
        return t ? `Claude (${t})` : 'Claude';
      },
      findTurns() {
        const out = [];
        for (const n of document.querySelectorAll('[data-testid="user-message"], div.font-user-message')) {
          out.push({ node: n, role: 'user' });
        }
        for (const n of document.querySelectorAll('div.font-claude-message, [data-testid="assistant-message"]')) {
          out.push({ node: n, role: 'assistant' });
        }
        return out;
      },
    };
  } else if (HOST.includes('chatgpt.com') || HOST.includes('openai.com')) {
    SITE = {
      name: 'ChatGPT',
      modelLabel() {
        const el = document.querySelector('[data-message-model-slug]');
        const slug = el && el.getAttribute('data-message-model-slug');
        return slug ? `ChatGPT (${slug})` : 'ChatGPT';
      },
      findTurns() {
        const out = [];
        for (const n of document.querySelectorAll('[data-message-author-role="user"]')) {
          out.push({ node: n, role: 'user' });
        }
        for (const n of document.querySelectorAll('[data-message-author-role="assistant"]')) {
          out.push({ node: n, role: 'assistant' });
        }
        return out;
      },
    };
  } else if (HOST.includes('gemini.google.com')) {
    SITE = {
      name: 'Gemini',
      modelLabel: () => 'Gemini',
      findTurns() {
        const out = [];
        for (const n of document.querySelectorAll('user-query, .user-query-container')) {
          out.push({ node: n, role: 'user' });
        }
        for (const n of document.querySelectorAll('model-response, message-content.model-response-text')) {
          out.push({ node: n, role: 'assistant' });
        }
        return out;
      },
    };
  } else if (HOST.includes('deepseek.com')) {
    SITE = {
      name: 'DeepSeek',
      modelLabel: () => 'DeepSeek',
      findTurns() {
        // Every chat turn on DeepSeek is rendered as a `.ds-message` element.
        // Assistant turns contain a `.ds-markdown` descendant; user turns
        // don't. This holds across DeepSeek's class-name churn.
        const out = [];
        for (const n of document.querySelectorAll('.ds-message')) {
          const isAssistant = !!n.querySelector('.ds-markdown');
          out.push({ node: n, role: isAssistant ? 'assistant' : 'user' });
        }
        return out;
      },
    };
  }

  if (!SITE) {
    console.log(TAG, 'no site config for', HOST, '— exiting');
    return;
  }

  console.log(TAG, 'site config loaded:', SITE.name);

  // ----- registry ----------------------------------------------------------
  // `seen` maps a live DOM node to its log id. `byKey` maps a stable
  // content key (role + first 200 chars of text) to the same id, so
  // when virtualized lists unmount and remount a turn we don't create
  // a duplicate entry.
  const seen = new WeakMap();
  const byKey = new Map();
  let counter = 0;
  const newId = () =>
    `${Date.now()}-${(++counter).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const keyOf = (role, text) => `${role}|${text.slice(0, 200)}`;

  const stats = { users: 0, assistants: 0, lastUpdate: 0, lastError: null };

  function extractText(el) {
    if (!el) return '';
    // innerText respects layout (better for streaming visibility) but is slow.
    // textContent is fast and good enough for diffing.
    return (el.textContent || '').replace(/ /g, ' ').trim();
  }

  function send(type, entry) {
    try {
      const p = chrome.runtime.sendMessage({ type, entry });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) {
      stats.lastError = String(e);
    }
  }

  function register(node, role) {
    if (seen.has(node)) return seen.get(node).id;
    const text = extractText(node);

    // Re-mount via virtualization: if we already logged a turn with this
    // role and the same text prefix, attach the existing id to this new
    // node instead of creating a duplicate.
    if (text) {
      const k = keyOf(role, text);
      const existingId = byKey.get(k);
      if (existingId) {
        seen.set(node, { id: existingId, lastText: text, role, captured: text });
        node.setAttribute('data-ai-log-id', existingId);
        return existingId;
      }
    }

    const id = newId();
    // `captured` is the append-only transcript. Every novel substring we
    // ever observe in this node is appended; the model rewriting earlier
    // text never erases what we already saw.
    seen.set(node, { id, lastText: text, role, captured: text });
    if (text) byKey.set(keyOf(role, text), id);
    node.setAttribute('data-ai-log-id', id);
    if (role === 'user') stats.users++;
    else stats.assistants++;
    send('log:create', {
      id,
      role,
      model: SITE.modelLabel(),
      timestamp: new Date().toISOString(),
      content: text,
      site: HOST,
      url: location.href,
    });
    stats.lastUpdate = Date.now();
    updateBadge();
    console.log(TAG, 'registered', role, id, text.slice(0, 60));
    return id;
  }

  function updateContent(node) {
    const rec = seen.get(node);
    if (!rec) return;
    const text = extractText(node);
    if (text === rec.lastText) return;
    // Refresh the byKey index with the latest stable prefix so re-mounts
    // during streaming still resolve to the same id.
    if (rec.lastText) byKey.delete(keyOf(rec.role, rec.lastText));
    if (text) byKey.set(keyOf(rec.role, text), rec.id);
    rec.lastText = text;

    // Append-only transcript: figure out what part of `text` is new
    // relative to whatever we've already captured, and append only that.
    // Falls back to logging both branches when the model rewrites prior
    // tokens (so nothing the model ever showed is lost).
    const captured = rec.captured || '';
    let appended = '';
    if (!captured) {
      appended = text;
    } else if (text.startsWith(captured)) {
      appended = text.slice(captured.length);
    } else {
      // Find the longest prefix of `text` that is still inside `captured`,
      // then keep what we already have plus everything after that point in
      // `text`. We also prepend a marker so the rewrite is visible in the
      // log instead of silently overwriting the earlier tokens.
      let i = Math.min(captured.length, text.length);
      while (i > 0 && !captured.includes(text.slice(0, i))) i--;
      const overlap = text.slice(0, i);
      const tail = text.slice(i);
      appended = (overlap ? '' : '\n[~rewrite~] ') + tail;
    }
    if (!appended) return;
    rec.captured = captured + appended;

    send('log:append', {
      id: rec.id,
      append: appended,
      updatedAt: new Date().toISOString(),
    });
    stats.lastUpdate = Date.now();
    updateBadge();
  }

  function scan() {
    let turns;
    try {
      turns = SITE.findTurns();
    } catch (e) {
      stats.lastError = String(e);
      console.warn(TAG, 'findTurns threw', e);
      return;
    }
    for (const { node, role } of turns) {
      if (!seen.has(node)) register(node, role);
      else updateContent(node);
    }
  }

  // ----- observers ---------------------------------------------------------
  // 1. MutationObserver gives us per-mutation reaction time for streaming.
  // 2. A 750 ms polling interval is a safety net for missed mutations
  //    (virtual lists, shadow-root content, frame skips during fast streams).

  const mo = new MutationObserver(() => scan());
  function startObservers() {
    if (!document.body) {
      requestAnimationFrame(startObservers);
      return;
    }
    mo.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    setInterval(scan, 750);
    scan();
    console.log(TAG, 'observers running');
    updateBadge();
  }

  // ----- in-page status badge ---------------------------------------------
  // A small widget so the user can see the extension is alive without opening
  // DevTools or the side panel. Bottom-right, draggable-free, ignores clicks.

  let badgeEl = null;
  function ensureBadge() {
    if (badgeEl) return badgeEl;
    badgeEl = document.createElement('div');
    badgeEl.id = '__ai_chat_logger_badge__';
    Object.assign(badgeEl.style, {
      position: 'fixed',
      bottom: '8px',
      right: '8px',
      zIndex: '2147483647',
      padding: '6px 10px',
      borderRadius: '8px',
      background: 'rgba(15, 23, 42, 0.85)',
      color: '#e2e8f0',
      font: '11px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      pointerEvents: 'none',
      boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
      whiteSpace: 'pre',
      maxWidth: '260px',
    });
    badgeEl.textContent = 'AI logger: starting…';
    (document.body || document.documentElement).appendChild(badgeEl);
    return badgeEl;
  }

  function updateBadge() {
    const el = ensureBadge();
    const ago = stats.lastUpdate
      ? `${Math.round((Date.now() - stats.lastUpdate) / 1000)}s ago`
      : '—';
    el.textContent =
      `AI logger · ${SITE.name}\n` +
      `user: ${stats.users}  assistant: ${stats.assistants}\n` +
      `last update: ${ago}` +
      (stats.lastError ? `\nerr: ${stats.lastError.slice(0, 80)}` : '');
  }

  // Hide / show the badge with Alt+Shift+L for users who find it intrusive.
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && (e.key === 'l' || e.key === 'L')) {
      const el = ensureBadge();
      el.style.display = el.style.display === 'none' ? '' : 'none';
    }
  });

  // ----- page-world fetch hook (best-effort, may not catch Worker-based) ---
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('content/inject.js');
    s.async = false;
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {
    console.warn(TAG, 'inject failed', e);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const msg = e.data;
    if (!msg || msg.__AI_CHAT_LOGGER !== true) return;
    send('log:raw', {
      kind: msg.kind,
      site: HOST,
      url: location.href,
      timestamp: new Date().toISOString(),
      data: msg.data,
    });
  });

  // ----- boot --------------------------------------------------------------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObservers, { once: true });
  } else {
    startObservers();
  }
})();
