'use strict';

/**
 * Voice mode UI.
 *
 * A full-screen layer rather than a strip above the composer: while you are
 * talking to Jarvis, that is the whole interface. The orb is the only status
 * display - it shows who is speaking, and how loudly, without any text to read
 * while you are mid-sentence.
 */
(function initVoiceUI() {
  const bridge = window.Jarvis;
  if (!bridge) return;

  const el = {
    toggle: document.getElementById('voice-toggle'),
    overlay: document.getElementById('voice-overlay'),
    close: document.getElementById('voice-close'),
    min: document.getElementById('voice-min'),
    orb: document.getElementById('voice-orb'),
    state: document.getElementById('voice-state'),
    caption: document.getElementById('voice-transcript'),
    hint: document.getElementById('voice-hint'),
    mode: document.getElementById('voice-mode'),
    mic: document.getElementById('voice-mic'),
    speaker: document.getElementById('voice-speaker'),
    talk: document.getElementById('voice-talk'),
    talkLabel: document.getElementById('voice-talk-label'),
    end: document.getElementById('voice-end'),
    routing: document.getElementById('voice-routing'),
    gate: document.getElementById('voice-gate'),
    gateValue: document.getElementById('voice-gate-value'),
  };
  if (!el.toggle || !el.overlay || !el.orb) return;

  const HINTS = {
    idle: 'Tap the microphone to start.',
    starting: 'Connecting…',
    ready: 'Hold the button or the space bar to talk.',
    talking: 'Listening…',
    listening: 'Speak any time — you can interrupt mid-sentence.',
    speaking: 'Jarvis is speaking. Start talking to interrupt.',
  };

  // Levels arrive far faster than the screen refreshes - roughly every 20 ms
  // from capture and every 10 ms from playback. Writing the CSS variable on a
  // rAF instead of per message keeps style recalculation off the audio path.
  let gateFlash = null;
  let targetLevel = 0;
  let shownLevel = 0;
  let rafId = null;

  function paintLevels() {
    // Ease toward the target so the orb glides rather than jitters.
    shownLevel += (targetLevel - shownLevel) * 0.25;
    if (shownLevel < 0.001) shownLevel = 0;
    el.orb.style.setProperty('--level', shownLevel.toFixed(3));
    rafId = requestAnimationFrame(paintLevels);
  }

  function startPainting() {
    if (rafId === null) rafId = requestAnimationFrame(paintLevels);
  }

  function stopPainting() {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    targetLevel = 0;
    shownLevel = 0;
    el.orb.style.setProperty('--level', '0');
  }

  const session = new VoiceSession({
    bridge,
    onState: (state) => {
      el.orb.dataset.state = state;
      el.state.textContent = state;
      el.hint.textContent = HINTS[state] || '';

      const live = state !== 'idle' && state !== 'starting';
      el.toggle.setAttribute('aria-pressed', String(live));
      // Hold-to-talk is meaningless while the engine listens on its own.
      el.talk.hidden = session.mode === 'open';
      el.talk.disabled = !(state === 'ready' || state === 'talking');
      el.talk.dataset.live = String(state === 'talking');
      el.talkLabel.textContent = state === 'talking' ? 'Release to send' : 'Hold to talk';
      // The mode stays switchable while live - changing it restarts the
      // session underneath, which is the gateway's problem, not the user's.
      if (el.mode) el.mode.disabled = state === 'starting';

      if (state === 'idle') stopPainting();
      else startPainting();
    },
    // The user's microphone drives the orb while they speak…
    onLevel: (level) => {
      if (session.state === 'speaking') return;
      targetLevel = Math.min(1, level * 2.4);
    },
    // …and Jarvis's output drives it while Jarvis speaks.
    onOutputLevel: (level) => {
      if (session.state !== 'speaking') return;
      targetLevel = Math.min(1, level * 1.6);
    },
    // Gated audio is not silence - show it, or a threshold set too high looks
    // like a broken microphone rather than a closed gate.
    onGated: () => {
      el.orb.dataset.gated = 'true';
      clearTimeout(gateFlash);
      gateFlash = setTimeout(() => { el.orb.dataset.gated = 'false'; }, 250);
    },
    onTranscript: ({ role, text }) => {
      if (!text) return;
      el.caption.dataset.role = role;
      el.caption.textContent = text;
    },
    // Notes belong in the chat transcript, not over the orb: they are for
    // afterwards, and reading them mid-conversation is not the point.
    onNote: (text) => bridge.note(text),
  });

  bridge.onVoiceEvent((event) => session.onEvent(event));
  bridge.onVoiceAudio((buffer) => session.onAudio(buffer));

  /* ---------------- devices ---------------- */

  // Device labels stay blank until microphone permission has been granted, so
  // the lists are refreshed after the first session opens as well as on hotplug.
  // Both pickers always list everything the browser reports. `prompt` asks for
  // microphone permission when labels are still hidden, which is the only way
  // to get real device names before a session has started.
  async function refreshDevices({ prompt = false } = {}) {
    const { inputs, outputs } = await VoiceDevices.list({ prompt });
    VoiceDevices.fill(el.mic, inputs, VoiceDevices.get('input'));
    VoiceDevices.fill(el.speaker, outputs, VoiceDevices.get('output'));

    if (!el.routing) return;
    // Only say something when a choice cannot actually take effect. On mobile
    // there are no outputs to list and setSinkId does not exist; on desktop
    // this stays quiet.
    if (outputs.length === 0) {
      el.routing.hidden = false;
      el.routing.textContent = 'Your device chooses the speaker — connect a headset and it switches automatically.';
    } else if (!VoiceDevices.outputSelectable()) {
      el.routing.hidden = false;
      el.routing.textContent = 'This browser cannot switch speakers; audio follows the system default.';
    } else {
      el.routing.hidden = true;
    }
  }

  refreshDevices();
  navigator.mediaDevices?.addEventListener?.('devicechange', () => refreshDevices());

  // Re-enumerate as the list is opened: devices get plugged in mid-session, and
  // devicechange is not fired by every browser.
  for (const select of [el.mic, el.speaker]) {
    select?.addEventListener('pointerdown', () => refreshDevices({ prompt: true }));
    select?.addEventListener('focus', () => refreshDevices({ prompt: true }));
  }
  /* ---------------- microphone gate ---------------- */

  // Browser noise suppression is built to preserve speech, so it treats other
  // people talking as signal. What separates you from them is distance - a
  // mouth 20 cm away is far louder than someone across the room - so a
  // threshold cuts them without touching you. It needs tuning against the
  // actual room, which is why it is a control and not a constant.
  function showGate(value) {
    if (!el.gateValue) return;
    el.gateValue.textContent = value > 0 ? Number(value).toFixed(3) : 'off';
  }

  if (el.gate) {
    el.gate.value = String(VoiceDevices.gate());
    showGate(VoiceDevices.gate());
    el.gate.addEventListener('input', () => {
      const value = Number(el.gate.value);
      showGate(value);
      session.setGate(value);
    });
  }

  el.mic?.addEventListener('change', () => session.useInput(el.mic.value));
  el.speaker?.addEventListener('change', () => session.useOutput(el.speaker.value));

  if (el.mode) {
    el.mode.addEventListener('change', () => session.setMode(el.mode.value));
    session.mode = el.mode.value === 'open' ? 'open' : 'ptt';
  }

  /* ---------------- open / close ---------------- */

  // Minimising is not closing. The session, the socket and the audio graph all
  // keep running - the overlay just shrinks to a corner so the transcript
  // underneath is readable and tappable. This is what makes it possible to
  // answer an approval without hanging up on Jarvis.
  let minimised = false;
  // Only auto-restore what we auto-minimised: a user who minimised on purpose
  // should not be yanked back to full screen.
  let minimisedForApproval = false;

  function showOverlay(show) {
    el.overlay.hidden = !show;
    el.overlay.setAttribute('aria-hidden', String(!show));
    applyChrome();
  }

  function applyChrome() {
    const full = !el.overlay.hidden && !minimised;
    el.overlay.dataset.minimised = String(minimised);
    // Scroll is only locked while voice covers the page; minimised, the user
    // needs to scroll the transcript to reach the approval.
    document.body.style.overflow = full ? 'hidden' : '';
  }

  function setMinimised(value) {
    minimised = value;
    if (!value) minimisedForApproval = false;
    applyChrome();
  }

  async function openVoice() {
    setMinimised(false);
    showOverlay(true);
    el.caption.textContent = '';
    // Populate the pickers with real names before the session starts, so the
    // user can pick a device rather than discovering the list afterwards.
    refreshDevices({ prompt: true });
    if (session.state === 'idle') {
      await session.start();
      // Permission has now been asked for, so real device names exist.
      refreshDevices();
    }
  }

  async function closeVoice() {
    showOverlay(false);
    if (session.state !== 'idle') await session.stop();
  }

  el.toggle.addEventListener('click', () => {
    if (el.overlay.hidden) openVoice();
    else closeVoice();
  });
  el.close.addEventListener('click', closeVoice);
  el.end.addEventListener('click', closeVoice);
  el.min?.addEventListener('click', () => setMinimised(true));

  // Tapping the minimised pill brings voice back.
  el.overlay.addEventListener('click', (event) => {
    if (!minimised) return;
    if (event.target.closest('#voice-close')) return;
    setMinimised(false);
  });

  // An approval needs the chat, so get out of its way rather than making the
  // user work out that voice has to be dismissed first. Restore afterwards,
  // but only if this was our doing.
  bridge.onApproval((event) => {
    if (el.overlay.hidden) return;
    if (event.event === 'approval.request' && !minimised) {
      minimisedForApproval = true;
      setMinimised(true);
      return;
    }
    if (minimisedForApproval && event.event !== 'approval.request') setMinimised(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || el.overlay.hidden) return;
    // Escape from minimised should not hang up on Jarvis.
    if (minimised) setMinimised(false);
    else closeVoice();
  });

  /* ---------------- push to talk ---------------- */

  // Pointer capture matters: without it, dragging off the button loses the
  // pointerup and the microphone stays open.
  const press = (event) => {
    if (el.talk.disabled) return;
    el.talk.setPointerCapture?.(event.pointerId);
    session.setTransmitting(true);
  };
  const release = () => session.setTransmitting(false);

  el.talk.addEventListener('pointerdown', press);
  el.talk.addEventListener('pointerup', release);
  el.talk.addEventListener('pointercancel', release);
  el.talk.addEventListener('lostpointercapture', release);

  document.addEventListener('keydown', (event) => {
    if (event.code !== 'Space' || event.repeat || el.overlay.hidden || el.talk.disabled) return;
    // Space belongs to the message box when the user is typing.
    const tag = document.activeElement?.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
    event.preventDefault();
    session.setTransmitting(true);
  });
  document.addEventListener('keyup', (event) => {
    if (event.code !== 'Space') return;
    session.setTransmitting(false);
  });

  // A dropped socket cannot carry audio; fail visibly rather than looking live.
  bridge.onDisconnect(() => {
    if (session.state !== 'idle') session.teardown();
  });
})();
