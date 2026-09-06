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
  if (!toggle || !talk || !panel) return;

  const session = new VoiceSession({
    bridge,
    onState: (state) => {
      label.textContent = state;
      panel.dataset.state = state;
      talk.disabled = state !== 'ready' && state !== 'talking';
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

  toggle.addEventListener('click', async () => {
    panel.hidden = false;
    if (session.state === 'idle') await session.start();
    else await session.stop();
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
