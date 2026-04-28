// Side-panel viewer: connects to the background service worker over a long-lived
// port, renders log entries incrementally, and exposes Clear / Export actions.

const STREAMING_IDLE_MS = 1500;

const els = {
  log: document.getElementById('log'),
  raw: document.getElementById('raw'),
  rawContent: document.getElementById('raw-content'),
  status: document.getElementById('status'),
  clear: document.getElementById('clear'),
  export: document.getElementById('export'),
  autoScroll: document.getElementById('auto-scroll'),
  showRaw: document.getElementById('show-raw'),
};

const entries = new Map(); // id -> { data, node, contentNode, idleTimer }
let port = null;
let entryCount = 0;

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour12: false });
}

function setStatus(text) {
  els.status.textContent = text;
}

function isAtBottom() {
  const el = els.log;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

function scrollToBottom(force = false) {
  if (!force && !els.autoScroll.checked) return;
  els.log.scrollTop = els.log.scrollHeight;
}

function buildEntryNode(entry) {
  const wrapper = document.createElement('article');
  wrapper.className = `entry role-${entry.role || 'unknown'}`;
  wrapper.dataset.id = entry.id;

  const header = document.createElement('header');
  const role = document.createElement('span');
  role.className = 'role';
  role.textContent = entry.role || 'unknown';
  const model = document.createElement('span');
  model.className = 'model';
  model.textContent = entry.model || '';
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = fmtTime(entry.timestamp || entry.createdAt);
  header.append(role, model, time);

  const content = document.createElement('div');
  content.className = 'content';
  content.textContent = entry.content || '';

  wrapper.append(header, content);
  return { wrapper, contentNode: content, modelNode: model, timeNode: time };
}

function clearStreamingMark(record) {
  if (record.idleTimer) {
    clearTimeout(record.idleTimer);
    record.idleTimer = null;
  }
  record.node.classList.remove('streaming');
}

function markStreaming(record) {
  record.node.classList.add('streaming');
  if (record.idleTimer) clearTimeout(record.idleTimer);
  record.idleTimer = setTimeout(() => {
    record.idleTimer = null;
    record.node.classList.remove('streaming');
  }, STREAMING_IDLE_MS);
}

function renderEntry(entry) {
  const wasAtBottom = isAtBottom();
  let record = entries.get(entry.id);

  if (!record) {
    const built = buildEntryNode(entry);
    record = {
      data: { ...entry },
      node: built.wrapper,
      contentNode: built.contentNode,
      modelNode: built.modelNode,
      timeNode: built.timeNode,
      idleTimer: null,
    };
    entries.set(entry.id, record);
    els.log.appendChild(built.wrapper);
    entryCount++;
  } else {
    record.data = { ...record.data, ...entry };
    if (entry.role) record.node.className = `entry role-${entry.role}`;
    if (entry.model && record.modelNode) record.modelNode.textContent = entry.model;
    if (entry.timestamp && record.timeNode)
      record.timeNode.textContent = fmtTime(entry.timestamp);
  }

  if (typeof entry.content === 'string') {
    if (record.contentNode.textContent !== entry.content) {
      record.contentNode.textContent = entry.content;
    }
  }

  if (record.data.role === 'assistant') {
    markStreaming(record);
  } else {
    clearStreamingMark(record);
  }

  setStatus(`${entryCount} message${entryCount === 1 ? '' : 's'} captured.`);
  if (wasAtBottom) scrollToBottom();
}

function clearAll() {
  entries.clear();
  entryCount = 0;
  els.log.textContent = '';
  els.rawContent.textContent = '';
  setStatus('Cleared.');
}

function appendRaw(entry) {
  if (!entry) return;
  const stamp = fmtTime(entry.timestamp);
  const head = `[${stamp}] ${entry.kind} ${entry.url || ''}`;
  let body = '';
  if (entry.data) {
    if (entry.kind === 'request') body = entry.data.body || '';
    else if (entry.kind === 'stream-chunk') body = entry.data.chunk || '';
    else body = JSON.stringify(entry.data);
  }
  els.rawContent.textContent += `${head}\n${body}\n\n`;
  if (els.rawContent.parentElement.scrollHeight > 0) {
    els.rawContent.parentElement.scrollTop = els.rawContent.parentElement.scrollHeight;
  }
}

const diagByTab = new Map();

function renderDiag(d) {
  if (!d) return;
  diagByTab.set(d.tabId ?? d.site, d);
  const parts = [];
  for (const v of diagByTab.values()) {
    parts.push(
      `${v.site}: hook=${v.hookInstalled ? 'OK' : 'NO'} reqs=${v.requests || 0} chunks=${v.chunks || 0}`
    );
  }
  setStatus(`${entryCount} msg · ${parts.join(' | ')}`);
}

function applySnapshot(snapshot) {
  clearAll();
  if (!Array.isArray(snapshot)) return;
  for (const entry of snapshot) renderEntry(entry);
  scrollToBottom(true);
  if (snapshot.length === 0) setStatus('Waiting for messages…');
}

function connect() {
  port = chrome.runtime.connect({ name: 'viewer' });
  setStatus('Connected. Waiting for messages…');

  port.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'snapshot':
        applySnapshot(msg.entries);
        break;
      case 'log:create':
      case 'log:update':
        renderEntry(msg.entry);
        break;
      case 'log:raw':
        if (els.showRaw.checked) appendRaw(msg.entry);
        break;
      case 'log:diag':
        renderDiag(msg.entry);
        break;
      case 'clear':
        clearAll();
        setStatus('Cleared.');
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    port = null;
    setStatus('Disconnected — reconnecting…');
    setTimeout(connect, 500);
  });
}

els.clear.addEventListener('click', () => {
  if (!port) return;
  port.postMessage({ type: 'clear' });
});

els.export.addEventListener('click', () => {
  const data = Array.from(entries.values()).map((r) => r.data);
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ai-chat-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

els.showRaw.addEventListener('change', () => {
  els.raw.hidden = !els.showRaw.checked;
});

connect();
