'use strict';

/* ------------------------------------------------------------------ *
 * Jarvis web client
 * Speaks the gateway event protocol over a single WebSocket and keeps
 * the transcript on the device so a reload or reconnect loses nothing.
 * ------------------------------------------------------------------ */

const KEYS = {
  url: 'jarvis.url',
  token: 'jarvis.token',
  session: 'jarvis.session',
  testMode: 'jarvis.testMode',
};
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
  fTest: document.getElementById('f-test'),
  testRow: document.getElementById('test-row'),
  testBadge: document.getElementById('test-badge'),
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

// A WebSocket subprotocol must be an RFC 7230 token, so ':' and '=' are illegal
// and make the WebSocket constructor throw. Pasting the whole
// `AUTH_TOKENS=<token>:<userId>` line is an easy slip, so unwrap it rather than
// failing with an opaque error.
const TOKEN_PATTERN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

function sanitizeToken(raw) {
  let token = String(raw || '').trim();
  token = token.replace(/^AUTH_TOKENS\s*=\s*/i, '');
  const separator = token.indexOf(':');
  if (separator !== -1) token = token.slice(0, separator);
  return token.trim();
}

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
  testMode: store.get(KEYS.testMode) === '1',
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

/*
 * Workflows format messages with the small HTML subset Telegram accepts -
 * <b>, <pre>, and friends - so rendering them as plain text shows the tags.
 *
 * The text is LLM-written and arrives from whatever pushed it, so it is never
 * handed to innerHTML. Instead it is tokenised and rebuilt as DOM nodes from a
 * fixed allowlist: an allowed tag becomes an element, and anything else -
 * <script>, <img onerror>, a stray angle bracket - stays literal text, because
 * every text run goes through createTextNode.
 */
const RICH_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'code', 'pre']);
const TAG_PATTERN = /<\s*(\/?)\s*([a-zA-Z]+)\s*\/?\s*>/g;

function appendText(parent, text) {
  if (text) parent.append(document.createTextNode(text));
}

/** Renders `text` into `target`, honouring the allowlisted tags only. */
function renderRichText(target, text) {
  const source = String(text ?? '');
  const stack = [target];
  let cursor = 0;
  let match;

  TAG_PATTERN.lastIndex = 0;

  while ((match = TAG_PATTERN.exec(source)) !== null) {
    const [raw, closing, rawName] = match;
    const name = rawName.toLowerCase();

    // Not allowlisted: leave it in the pending text run so it renders as the
    // literal characters the sender wrote.
    if (name !== 'br' && !RICH_TAGS.has(name)) continue;

    appendText(stack[stack.length - 1], source.slice(cursor, match.index));
    cursor = match.index + raw.length;

    if (name === 'br') {
      stack[stack.length - 1].append(document.createElement('br'));
      continue;
    }

    if (closing) {
      // Ignore a close with no matching open rather than unwinding past it.
      if (stack.length > 1 && stack[stack.length - 1].localName === name) stack.pop();
      continue;
    }

    const element = document.createElement(name);
    stack[stack.length - 1].append(element);
    stack.push(element);
  }

  appendText(stack[stack.length - 1], source.slice(cursor));
}

function renderRow(message) {
  if (message.role === 'approval') return renderApproval(message);

  const row = document.createElement('div');
  row.className = `row ${message.role}${message.state ? ` ${message.state}` : ''}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  renderRichText(bubble, message.content);

  // A bubble shrinks to its longest line, which is right for prose but cramps
  // command output into a narrow column. Let a message carrying a block widen
  // to the row instead. Marked here rather than with :has() so it does not
  // depend on selector support.
  if (bubble.querySelector('pre')) bubble.classList.add('with-block');

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
  label.textContent = message.inputType === 'text'
    ? (message.state === 'open' ? 'Jarvis needs an answer' : 'Question')
    : (message.state === 'open' ? 'Needs your approval' : 'Approval');
  card.append(label);

  const text = document.createElement('div');
  text.className = 'approval-text';
  renderRichText(text, message.content);
  card.append(text);

  if (message.state === 'open' && message.inputType === 'text') {
    // A question: collect free text, with its own field so it is unambiguous
    // which prompt an answer belongs to.
    const form = document.createElement('form');
    form.className = 'approval-answer';

    const field = document.createElement('input');
    field.type = 'text';
    field.placeholder = message.placeholder || 'Your answer…';
    field.autocomplete = 'off';
    form.append(field);

    const send = document.createElement('button');
    send.type = 'submit';
    send.className = 'approval-btn primary';
    send.textContent = 'Send';
    form.append(send);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const answer = field.value.trim();
      if (answer) respondToApproval(message, null, answer);
    });
    card.append(form);
  } else if (message.state === 'open') {
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

    if (message.state === 'submitting') {
      outcome.textContent = 'Sending your response…';
    } else if (message.state === 'expired') {
      outcome.textContent = 'Expired without an answer';
    } else if (message.inputType === 'text') {
      outcome.textContent = `You answered: ${message.answer || ''}`;
    } else {
      const chosen = (message.choices || []).find(
        (c) => c.value === message.choice
      );

      outcome.textContent =
        `You chose: ${chosen ? chosen.label || chosen.value : message.choice}`;
    }

    card.append(outcome);
  }

  row.append(card);
  return row;
}

function respondToApproval(message, choice, text) {
  if (message.state !== 'open') return;

  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    systemNote('Not connected — could not send your answer.');
    return;
  }

  message.state = 'submitting';
  message.choice = choice || 'answered';

  if (text) {
    message.answer = text;
  }

  saveTranscript();
  render();

  const data = {
    approvalId: message.approvalId,
  };

  if (choice) {
    data.choice = choice;
  }

  if (text) {
    data.text = text;
  }

  state.ws.send(
    JSON.stringify({
      id: `evt_${uuid()}`,
      type: 'event',
      event: 'approval.respond',
      sessionId: state.sessionId,
      data,
    }),
  );
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

  const token = sanitizeToken(store.get(KEYS.token));
  if (token && !TOKEN_PATTERN.test(token)) {
    // Retrying cannot help, so stop rather than burning a backoff loop.
    setStatus('closed', 'bad token');
    setBanner('That access token contains characters that cannot be sent. Paste only the token itself — not the `AUTH_TOKENS=` line and not the `:userId` suffix.');
    return;
  }
  setStatus('connecting', state.attempt > 0 ? 'reconnecting' : 'connecting');

  let socket;
  try {
    // The token rides as a subprotocol so it never lands in a URL or access log.
    socket = token ? new WebSocket(gatewayUrl(), ['bearer', token]) : new WebSocket(gatewayUrl());
  } catch (err) {
    setStatus('closed', 'bad URL');
    setBanner(`Could not open ${gatewayUrl()} — check the gateway URL and access token in settings.`);
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
      el.testRow.hidden = event.data.testWebhookAvailable === false;
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

    case 'assistant.message': {
      settle(event.data.replyTo, 'sent');
      addMessage({ id: uuid(), role: 'assistant', content: event.data.content ?? '', ts: Date.now() });
      break;
    }

    case 'notification': {
      // Only a notification that answers the tracked execution - n8n pushed it
      // with a messageId, so the gateway set replyTo - ends the turn. A mid-run
      // one must NOT retire the thinking indicator: progress is rendered as a
      // caption on that indicator, so settling here makes every later
      // tool.started/progress/finished arrive and draw nothing.
      if (event.data.replyTo) settle(event.data.replyTo, 'sent');
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
    case 'execution.progress':
      state.progress = event.data.content || '';
      render();
      break;

    // The step is over, so the status line describing it should go rather than
    // sit there stale until the next update. Anything worth keeping after the
    // step ends belongs in a notification, which writes a real message.
    case 'tool.finished':
      state.progress = '';
      render();
      break;

    case 'approval.request':
      addMessage({
        id: uuid(),
        role: 'approval',
        approvalId: event.data.approvalId,
        content: event.data.content || 'Jarvis needs your approval to continue.',
        inputType: event.data.inputType === 'text' ? 'text' : 'choice',
        placeholder: event.data.placeholder || '',
        choices: Array.isArray(event.data.choices) && event.data.choices.length
          ? event.data.choices
          : [{ value: 'approve', label: 'Approve' }, { value: 'reject', label: 'Reject' }],
        state: 'open',
        ts: Date.now(),
      });
      break;

    case 'approval.resolved': {
  const approval = findApproval(event.data.approvalId);

  if (approval) {
    approval.state = 'answered';
    approval.choice = event.data.choice;

    if (event.data.answer) {
      approval.answer = event.data.answer;
    }

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
      if (approvalId) {
  const approval = findApproval(approvalId);

  if (approval && approval.state === 'submitting') {
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
    data: { messageId, content, useTestWebhook: state.testMode },
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

/** Keep the header badge honest: test mode is easy to leave on by accident. */
function applyTestMode() {
  el.testBadge.hidden = !state.testMode;
}

function openSettings() {
  el.fTest.checked = state.testMode;
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
  store.set(KEYS.token, sanitizeToken(el.fToken.value));
  state.testMode = el.fTest.checked;
  store.set(KEYS.testMode, state.testMode ? '1' : '');
  applyTestMode();

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
applyTestMode();
render();
setStatus('closed', 'connecting');
connect();
autoGrow();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* offline shell is optional */ });
  });
}
