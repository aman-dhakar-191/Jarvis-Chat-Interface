'use strict';

/* ------------------------------------------------------------------ *
 * Jarvis web client
 * Speaks the gateway event protocol over a single WebSocket and keeps
 * the transcript on the device so a reload or reconnect loses nothing.
 * ------------------------------------------------------------------ */

const KEYS = { url: 'jarvis.url', token: 'jarvis.token', session: 'jarvis.session' };
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

const el = {
  transcript: document.getElementById('transcript'),
  empty: document.getElementById('empty'),
  banner: document.getElementById('banner'),
  form: document.getElementById('composer'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  status: document.getElementById('status'),
  statusText: document.getElementById('status-text'),
  settings: document.getElementById('settings'),
  fUrl: document.getElementById('f-url'),
  fToken: document.getElementById('f-token'),
  fSession: document.getElementById('f-session'),
  mConn: document.getElementById('m-conn'),
  mUser: document.getElementById('m-user'),
  mMode: document.getElementById('m-mode'),
};

const store = {
  get: (key, fallback = '') => {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  },
  set: (key, value) => {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
  },
  remove: (key) => {
    try { localStorage.removeItem(key); } catch { /* private mode */ }
  },
};

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const state = {
  ws: null,
  status: 'closed',
  attempt: 0,
  retryTimer: null,
  messages: [],
  pending: new Map(),   // messageId -> message object
  thinking: 0,
  progress: '',
  // Empty until the gateway tells us its stable session id, unless this device
  // already has one pinned. The id must stay identical across reloads,
  // reconnects and devices so Jarvis keeps a single memory thread.
  sessionId: store.get(KEYS.session),
  connectionId: null,
  userId: null,
  mode: null,
  manualClose: false,
};

/* ---------------- transcript persistence ---------------- */

const transcriptKey = () => `jarvis.transcript.${state.sessionId || 'unassigned'}`;

function loadTranscript() {
  try {
    const raw = store.get(transcriptKey());
    state.messages = raw ? JSON.parse(raw) : [];
  } catch {
    state.messages = [];
  }
  // A message left "pending" from a previous run can never be resolved now.
  for (const message of state.messages) {
    if (message.state === 'pending') message.state = 'failed';
    // Approvals are deliberately left open: the gateway keeps them for the
    // session, so one usually survives a reload. If it did not, answering
    // returns APPROVAL_NOT_FOUND and it is marked expired then.
  }
}

function saveTranscript() {
  try {
    // Cap the stored history so localStorage cannot grow without bound.
    store.set(transcriptKey(), JSON.stringify(state.messages.slice(-300)));
  } catch { /* quota */ }
}

/* ---------------- rendering ---------------- */

function nearBottom() {
  const { scrollTop, scrollHeight, clientHeight } = el.transcript;
  return scrollHeight - scrollTop - clientHeight < 120;
}

function scrollToBottom(smooth) {
  el.transcript.scrollTo({ top: el.transcript.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function render() {
  const stick = nearBottom();
  el.transcript.querySelectorAll('.row, .thinking-row').forEach((node) => node.remove());
  el.empty.hidden = state.messages.length > 0;
  el.transcript.classList.toggle('has-messages', state.messages.length > 0);

  for (const message of state.messages) {
    el.transcript.append(renderRow(message));
  }
  if (state.thinking > 0) {
    const row = document.createElement('div');
    row.className = 'row assistant thinking-row';
    row.innerHTML = '<div class="bubble thinking"><i></i><i></i><i></i></div>';
    if (state.progress) {
      const note = document.createElement('div');
      note.className = 'progress-note';
      note.textContent = state.progress;
      row.append(note);
    }
    el.transcript.append(row);
  }
  if (stick) scrollToBottom();
}

function renderRow(message) {
  if (message.role === 'approval') return renderApproval(message);

  const row = document.createElement('div');
  row.className = `row ${message.role}${message.state ? ` ${message.state}` : ''}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = message.content;
  row.append(bubble);

  if (message.role === 'user' && (message.state === 'pending' || message.state === 'failed')) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.append(document.createTextNode(message.state === 'pending' ? 'sending…' : 'not delivered'));
    if (message.state === 'failed') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'retry';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => retryMessage(message));
      meta.append(retry);
    }
    row.append(meta);
  }
  return row;
}

/** A human-in-the-loop prompt: Jarvis is parked until this is answered. */
function renderApproval(message) {
  const row = document.createElement('div');
  row.className = 'row approval';

  const card = document.createElement('div');
  card.className = `approval-card ${message.state}`;

  const label = document.createElement('div');
  label.className = 'approval-label';
  label.textContent = message.state === 'open' ? 'Needs your approval' : 'Approval';
  card.append(label);

  const text = document.createElement('div');
  text.className = 'approval-text';
  text.textContent = message.content;
  card.append(text);

  if (message.state === 'open') {
    const actions = document.createElement('div');
    actions.className = 'approval-actions';
    for (const choice of message.choices) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `approval-btn${choice.value === 'approve' ? ' primary' : ''}`;
      button.textContent = choice.label || choice.value;
      button.addEventListener('click', () => respondToApproval(message, choice.value));
      actions.append(button);
    }
    card.append(actions);
  } else {
    const outcome = document.createElement('div');
    outcome.className = 'approval-outcome';
    const chosen = message.choices.find((c) => c.value === message.choice);
    outcome.textContent = message.state === 'expired'
      ? 'Expired without an answer'
      : `You chose: ${chosen ? chosen.label || chosen.value : message.choice}`;
    card.append(outcome);
  }

  row.append(card);
  return row;
}

function respondToApproval(message, choice) {
  if (message.state !== 'open') return;
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    systemNote('Not connected — could not send your answer.');
    return;
  }
  message.state = 'answered';
  message.choice = choice;
  saveTranscript();
  render();
  state.ws.send(JSON.stringify({
    id: `evt_${uuid()}`,
    type: 'event',
    event: 'approval.respond',
    sessionId: state.sessionId,
    data: { approvalId: message.approvalId, choice },
  }));
}

function findApproval(approvalId) {
  return state.messages.find((m) => m.role === 'approval' && m.approvalId === approvalId);
}

function addMessage(message) {
  state.messages.push(message);
  saveTranscript();
  render();
  scrollToBottom(true);
  return message;
}

function systemNote(text) {
  addMessage({ id: uuid(), role: 'system', content: text, ts: Date.now() });
}

function setBanner(text) {
  el.banner.textContent = text || '';
  el.banner.hidden = !text;
}

function setStatus(status, label) {
  state.status = status;
  el.status.dataset.state = status;
  el.statusText.textContent = label || status;
  el.send.disabled = status !== 'open';
}

/* ---------------- connection ---------------- */

function gatewayUrl() {
  const configured = store.get(KEYS.url).trim();
  if (!configured) {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${location.host}`;
  }
  return configured.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:').replace(/\/+$/, '');
}

function connect() {
  clearTimeout(state.retryTimer);
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;

  const token = store.get(KEYS.token).trim();
  setStatus('connecting', state.attempt > 0 ? 'reconnecting' : 'connecting');

  let socket;
  try {
    // The token rides as a subprotocol so it never lands in a URL or access log.
    socket = token ? new WebSocket(gatewayUrl(), ['bearer', token]) : new WebSocket(gatewayUrl());
  } catch (err) {
    setStatus('closed', 'bad URL');
    setBanner(`Could not open ${gatewayUrl()} — check the gateway URL in settings.`);
    return;
  }
  state.ws = socket;

  socket.addEventListener('open', () => {
    state.attempt = 0;
    setStatus('open', 'connected');
    setBanner('');
    // The join is sent once connection.ready has settled the session id.
    if (state.sessionId) joinSession();
  });

  socket.addEventListener('message', (frame) => {
    let event;
    try {
      event = JSON.parse(frame.data);
    } catch {
      return;
    }
    handleEvent(event);
  });

  socket.addEventListener('close', (event) => {
    state.ws = null;
    failPending('Connection lost before Jarvis replied.');
    if (state.manualClose) {
      state.manualClose = false;
      return connect();
    }
    // 1008/4401-style rejections mean the token is wrong; retrying will not help.
    if (event.code === 1006 && state.attempt === 0) {
      setBanner('Handshake refused. If the gateway needs a token, add it in settings.');
    }
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    /* the close handler owns recovery */
  });
}

function scheduleReconnect() {
  const delay = BACKOFF_MS[Math.min(state.attempt, BACKOFF_MS.length - 1)];
  state.attempt += 1;
  const jitter = Math.round(delay * 0.2 * Math.random());
  setStatus('closed', `retrying in ${Math.round((delay + jitter) / 1000)}s`);
  state.retryTimer = setTimeout(connect, delay + jitter);
}

function reconnectNow() {
  state.attempt = 0;
  clearTimeout(state.retryTimer);
  if (state.ws) {
    state.manualClose = true;
    state.ws.close();
  } else {
    connect();
  }
}

function joinSession() {
  if (!state.sessionId || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({
    id: `evt_${uuid()}`,
    type: 'event',
    event: 'session.join',
    sessionId: state.sessionId,
  }));
}

/* ---------------- inbound events ---------------- */

function handleEvent(event) {
  if (event.type === 'ack') {
    const message = state.pending.get(event.messageId);
    if (message) {
      message.state = 'sent';
      saveTranscript();
      render();
    }
    return;
  }

  switch (event.event) {
    case 'connection.ready': {
      state.connectionId = event.data.connectionId;
      state.userId = event.data.userId;
      state.mode = event.data.responseMode;
      const preferred = event.data.defaultSessionId;
      if (preferred && !state.sessionId) {
        // First run on this device: adopt the gateway's stable conversation key.
        state.sessionId = preferred;
        store.set(KEYS.session, preferred);
        loadTranscript();
        render();
      }
      joinSession();
      updateMeta();
      if (event.data.authEnabled === false) setBanner('Gateway is running without authentication.');
      break;
    }

    case 'session.joined':
      break;

    case 'execution.started':
      state.thinking += 1;
      render();
      break;

    case 'assistant.message':
    case 'notification': {
      settle(event.data.replyTo, 'sent');
      addMessage({ id: uuid(), role: 'assistant', content: event.data.content ?? '', ts: Date.now() });
      break;
    }

    case 'execution.completed':
      state.progress = '';
      settle(event.data.messageId, 'sent');
      break;

    // Anything n8n pushes mid-run: which tool is running, what it found.
    case 'tool.started':
    case 'tool.progress':
    case 'tool.finished':
    case 'execution.progress':
      state.progress = event.data.content || '';
      render();
      break;

    case 'approval.request':
      addMessage({
        id: uuid(),
        role: 'approval',
        approvalId: event.data.approvalId,
        content: event.data.content || 'Jarvis needs your approval to continue.',
        choices: Array.isArray(event.data.choices) && event.data.choices.length
          ? event.data.choices
          : [{ value: 'approve', label: 'Approve' }, { value: 'reject', label: 'Reject' }],
        state: 'open',
        ts: Date.now(),
      });
      break;

    case 'approval.resolved': {
      // Also fires for an answer given on another device.
      const approval = findApproval(event.data.approvalId);
      if (approval) {
        approval.state = 'answered';
        approval.choice = event.data.choice;
        saveTranscript();
        render();
      }
      break;
    }

    case 'approval.expired': {
      const approval = findApproval(event.data.approvalId);
      if (approval && approval.state === 'open') {
        approval.state = 'expired';
        saveTranscript();
        render();
      }
      break;
    }

    case 'execution.failed':
      state.progress = '';
      settle(event.data.messageId, 'failed');
      break;

    case 'error': {
      const { code, message, messageId, approvalId } = event.data || {};
      if (code === 'APPROVAL_NOT_FOUND' && approvalId) {
        const approval = findApproval(approvalId);
        if (approval) {
          approval.state = 'expired';
          saveTranscript();
          render();
        }
        return;
      }
      if (code === 'APPROVAL_FAILED' && approvalId) {
        // The resume call failed - let them try again.
        const approval = findApproval(approvalId);
        if (approval) {
          approval.state = 'open';
          saveTranscript();
          render();
        }
      }
      if (messageId) settle(messageId, 'failed');
      else if (state.thinking > 0) state.thinking -= 1;
      systemNote(`${code || 'ERROR'}: ${message || 'Something went wrong.'}`);
      break;
    }

    case 'connection.pong':
      break;

    default:
      break;
  }
}

/** Resolve a tracked user message and retire one thinking indicator. */
function settle(messageId, outcome) {
  if (state.thinking > 0) state.thinking -= 1;
  if (!messageId) return render();
  const message = state.pending.get(messageId);
  if (message) {
    message.state = outcome;
    state.pending.delete(messageId);
    saveTranscript();
  }
  render();
}

function failPending(note) {
  if (state.pending.size === 0) return;
  for (const message of state.pending.values()) message.state = 'failed';
  state.pending.clear();
  state.thinking = 0;
  saveTranscript();
  render();
  if (note) systemNote(note);
}

/* ---------------- outbound ---------------- */

function sendMessage(content) {
  const messageId = `msg_${uuid()}`;
  const message = addMessage({
    id: uuid(),
    role: 'user',
    content,
    messageId,
    state: 'pending',
    ts: Date.now(),
  });

  if (!state.sessionId || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
    message.state = 'failed';
    saveTranscript();
    render();
    systemNote('Not connected to the gateway — your message was not sent.');
    return;
  }

  state.pending.set(messageId, message);
  state.ws.send(JSON.stringify({
    id: `evt_${uuid()}`,
    type: 'event',
    event: 'user.message',
    timestamp: new Date().toISOString(),
    sessionId: state.sessionId,
    data: { messageId, content },
  }));
}

function retryMessage(message) {
  const index = state.messages.indexOf(message);
  if (index !== -1) state.messages.splice(index, 1);
  saveTranscript();
  sendMessage(message.content);
}

/* ---------------- composer ---------------- */

function autoGrow() {
  el.input.style.height = 'auto';
  el.input.style.height = `${el.input.scrollHeight}px`;
}

el.input.addEventListener('input', autoGrow);

el.input.addEventListener('keydown', (event) => {
  // Enter sends on a physical keyboard; Shift+Enter makes a new line.
  // Touch keyboards get an explicit send button instead.
  if (event.key === 'Enter' && !event.shiftKey && !matchMedia('(pointer: coarse)').matches) {
    event.preventDefault();
    el.form.requestSubmit();
  }
});

el.form.addEventListener('submit', (event) => {
  event.preventDefault();
  const content = el.input.value.trim();
  if (!content) return;
  sendMessage(content);
  el.input.value = '';
  autoGrow();
});

/* ---------------- settings ---------------- */

function updateMeta() {
  el.mConn.textContent = state.connectionId || '—';
  el.mUser.textContent = state.userId || '—';
  el.mMode.textContent = state.mode || '—';
}

function openSettings() {
  el.fUrl.value = store.get(KEYS.url);
  el.fToken.value = store.get(KEYS.token);
  el.fSession.value = state.sessionId;
  updateMeta();
  el.settings.showModal();
}

el.settings.addEventListener('close', () => {
  const action = el.settings.returnValue;
  if (action === 'clear') {
    state.messages = [];
    state.pending.clear();
    state.thinking = 0;
    saveTranscript();
    render();
    return;
  }
  if (action !== 'save') return;

  store.set(KEYS.url, el.fUrl.value.trim());
  store.set(KEYS.token, el.fToken.value.trim());

  const nextSession = el.fSession.value.trim() || state.sessionId;
  if (nextSession !== state.sessionId) {
    state.sessionId = nextSession;
    store.set(KEYS.session, nextSession);
    state.pending.clear();
    loadTranscript();
  }
  render();
  reconnectNow();
});

document.getElementById('open-settings').addEventListener('click', openSettings);
el.status.addEventListener('click', reconnectNow);

// Clears what this device shows. It deliberately does NOT change the session id -
// Jarvis keeps its own memory for the conversation, and the id stays stable.
document.getElementById('new-session').addEventListener('click', () => {
  state.messages = [];
  state.pending.clear();
  state.thinking = 0;
  saveTranscript();
  render();
});

/* ---------------- lifecycle ---------------- */

// Mobile browsers freeze sockets in the background; recheck as soon as we return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.status !== 'open') reconnectNow();
});
window.addEventListener('online', reconnectNow);
window.addEventListener('offline', () => setBanner('You are offline.'));

loadTranscript();
render();
setStatus('closed', 'connecting');
connect();
autoGrow();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* offline shell is optional */ });
  });
}
