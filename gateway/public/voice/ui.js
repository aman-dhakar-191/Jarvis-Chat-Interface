'use strict';

/**
 * Voice controls. Push-to-talk for now: it is honest about when the microphone
 * is live, and on a metered engine it does not burn session time on silence.
 * Always-on listening becomes a toggle here once the engine lands.
 */
(function initVoiceUI() {
  const bridge = window.Jarvis;
  if (!bridge) return;

  const toggle = document.getElementById('voice-toggle');
  const talk = document.getElementById('voice-talk');
  const panel = document.getElementById('voice-panel');
  const label = document.getElementById('voice-state');
  const meter = document.getElementById('voice-meter');
  const transcript = document.getElementById('voice-transcript');
  const modeSelect = document.getElementById('voice-mode');
  const micSelect = document.getElementById('voice-mic');
  const outSelect = document.getElementById('voice-speaker');
  if (!toggle || !talk || !panel) return;

  const session = new VoiceSession({
    bridge,
    onState: (state) => {
      label.textContent = state;
      panel.dataset.state = state;
      // Hold-to-talk is meaningless while the engine is listening on its own.
      talk.hidden = session.mode === 'open';
      talk.disabled = state !== 'ready' && state !== 'talking';
      // The mode is fixed for the life of a session: switching it means a
      // different engine configuration, so it is chosen before starting.
      if (modeSelect) modeSelect.disabled = state !== 'idle';
      toggle.setAttribute('aria-pressed', String(state !== 'idle'));
    },
    onLevel: (level) => {
      meter.style.setProperty('--level', String(Math.min(1, level * 2.2)));
    },
    onNote: (text) => bridge.note(text),
    onTranscript: ({ role, text }) => {
      if (!text) return;
      // Partials, so replace the line rather than appending a new one per token.
      label.dataset.role = role;
      transcript.textContent = text;
    },
  });

  bridge.onVoiceEvent((event) => session.onEvent(event));
  bridge.onVoiceAudio((buffer) => session.onAudio(buffer));

  // Labels stay blank until microphone permission is granted, so refresh the
  // lists after the first session opens as well as on hotplug.
  async function refreshDevices() {
    const { inputs, outputs } = await VoiceDevices.list();
    VoiceDevices.fill(micSelect, inputs, VoiceDevices.get('input'));
    VoiceDevices.fill(outSelect, outputs, VoiceDevices.get('output'));
    if (outSelect && !VoiceDevices.outputSelectable()) {
      outSelect.disabled = true;
      outSelect.title = 'This browser cannot choose an output device; using the system default.';
    }
  }

  refreshDevices();
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);

  micSelect?.addEventListener('change', () => session.useInput(micSelect.value));
  outSelect?.addEventListener('change', () => session.useOutput(outSelect.value));

  if (modeSelect) {
    modeSelect.addEventListener('change', () => session.setMode(modeSelect.value));
    session.setMode(modeSelect.value);
  }

  toggle.addEventListener('click', async () => {
    panel.hidden = false;
    if (session.state === 'idle') {
      await session.start();
      // Permission has now been asked for, so real device names are available.
      refreshDevices();
    } else {
      await session.stop();
    }
  });

  // Hold to talk, by pointer or by space. Pointer capture matters: without it,
  // dragging off the button loses the pointerup and the microphone stays open.
  const press = (event) => {
    if (talk.disabled) return;
    talk.setPointerCapture?.(event.pointerId);
    session.setTransmitting(true);
  };
  const release = () => session.setTransmitting(false);

  talk.addEventListener('pointerdown', press);
  talk.addEventListener('pointerup', release);
  talk.addEventListener('pointercancel', release);
  talk.addEventListener('lostpointercapture', release);

  document.addEventListener('keydown', (event) => {
    if (event.code !== 'Space' || event.repeat || talk.disabled) return;
    // Space belongs to the message box when the user is typing.
    if (document.activeElement?.tagName === 'TEXTAREA' || document.activeElement?.tagName === 'INPUT') return;
    event.preventDefault();
    session.setTransmitting(true);
  });
  document.addEventListener('keyup', (event) => {
    if (event.code !== 'Space') return;
    session.setTransmitting(false);
  });

  // A dropped socket cannot carry audio; fail loudly rather than looking live.
  bridge.onDisconnect(() => {
    if (session.state !== 'idle') session.teardown();
  });
})();
