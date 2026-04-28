// Service worker: aggregates log entries from content scripts and broadcasts
// them to the side-panel viewer. State is mirrored into chrome.storage.session
// so it survives worker restarts within a browser session.

const STORAGE_KEY = 'logs';
const FLUSH_DEBOUNCE_MS = 500;

let logs = [];
let flushTimer = null;
const ports = new Set();

(async function bootstrap() {
  try {
    const data = await chrome.storage.session.get(STORAGE_KEY);
    if (Array.isArray(data[STORAGE_KEY])) logs = data[STORAGE_KEY];
  } catch (e) {
    // session storage unavailable in some contexts; ignore
  }
})();

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    try {
      await chrome.storage.session.set({ [STORAGE_KEY]: logs });
    } catch {}
  }, FLUSH_DEBOUNCE_MS);
}

function broadcast(msg) {
  for (const p of ports) {
    try { p.postMessage(msg); } catch {}
  }
}

function upsert(entry) {
  const idx = logs.findIndex((e) => e.id === entry.id);
  if (idx >= 0) {
    logs[idx] = { ...logs[idx], ...entry };
    return logs[idx];
  }
  const created = {
    createdAt: entry.timestamp || new Date().toISOString(),
    ...entry,
  };
  logs.push(created);
  return created;
}

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'viewer') return;
  ports.add(port);
  port.postMessage({ type: 'snapshot', entries: logs });
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(async (msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'clear') {
      logs = [];
      try { await chrome.storage.session.set({ [STORAGE_KEY]: logs }); } catch {}
      broadcast({ type: 'clear' });
    } else if (msg.type === 'request-snapshot') {
      port.postMessage({ type: 'snapshot', entries: logs });
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) {
    sendResponse?.({ ok: false });
    return false;
  }

  if (msg.type === 'log:create' || msg.type === 'log:update') {
    const entry = msg.entry || {};
    if (sender?.tab?.id != null) entry.tabId = sender.tab.id;
    if (sender?.tab?.url) entry.tabUrl = sender.tab.url;
    const stored = upsert(entry);
    broadcast({ type: msg.type, entry: stored });
    scheduleFlush();
  } else if (msg.type === 'log:raw') {
    // Forward raw network captures without persisting to the main logs list.
    broadcast({ type: 'log:raw', entry: msg.entry });
  } else if (msg.type === 'log:diag') {
    const tabId = sender?.tab?.id;
    broadcast({ type: 'log:diag', entry: { ...msg.entry, tabId } });
  }

  sendResponse?.({ ok: true });
  return false;
});
