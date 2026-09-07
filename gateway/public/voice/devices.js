'use strict';

/**
 * Audio device selection.
 *
 * Two quirks drive the shape of this:
 *
 * 1. Device *labels* are hidden until microphone permission has been granted.
 *    Before that, enumerateDevices() returns entries with empty names, so the
 *    list is only worth showing after the first getUserMedia call.
 *
 * 2. Output selection is not universal. AudioContext.setSinkId exists in
 *    Chromium but not everywhere, so speaker choice degrades to "system
 *    default" rather than pretending to work.
 */
const VoiceDevices = {
  KEYS: {
    input: 'jarvis.voice.mic',
    output: 'jarvis.voice.speaker',
    gate: 'jarvis.voice.gate',
  },

  // Default gate. Chosen to sit above room tone and conversation a couple of
  // metres away, but well below close speech. 0 disables it.
  DEFAULT_GATE: 0.02,

  gate() {
    try {
      const stored = localStorage.getItem(this.KEYS.gate);
      return stored === null ? this.DEFAULT_GATE : Number(stored);
    } catch {
      return this.DEFAULT_GATE;
    }
  },

  setGate(value) {
    try {
      localStorage.setItem(this.KEYS.gate, String(value));
    } catch { /* private mode */ }
  },

  get(kind) {
    try {
      return localStorage.getItem(this.KEYS[kind]) || '';
    } catch {
      return '';
    }
  },

  set(kind, deviceId) {
    try {
      if (deviceId) localStorage.setItem(this.KEYS[kind], deviceId);
      else localStorage.removeItem(this.KEYS[kind]);
    } catch { /* private mode */ }
  },

  outputSelectable() {
    return typeof AudioContext !== 'undefined'
      && typeof AudioContext.prototype.setSinkId === 'function';
  },

  /**
   * Every audio device the browser will admit to.
   *
   * Labels are hidden until microphone permission is granted, and some browsers
   * return a single unnamed placeholder before then - hence the temporary
   * permission grab, which is the only way to get a real list without waiting
   * for a voice session to start.
   */
  async list({ prompt = false } = {}) {
    if (!navigator.mediaDevices?.enumerateDevices) return { inputs: [], outputs: [] };

    let devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    const unlabelled = devices.some((d) => (d.kind === 'audioinput' || d.kind === 'audiooutput') && !d.label);

    if (prompt && unlabelled && navigator.mediaDevices.getUserMedia) {
      try {
        // Opened and closed immediately: it exists only to unlock the labels.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const track of stream.getTracks()) track.stop();
        devices = await navigator.mediaDevices.enumerateDevices().catch(() => devices);
      } catch {
        /* permission refused - fall through with whatever we have */
      }
    }

    const pick = (kind, fallbackLabel) => devices
      .filter((d) => d.kind === kind)
      // Some browsers list a synthetic "default"/"communications" entry that
      // duplicates a real device; keeping them is harmless and occasionally
      // the only way to follow the system route.
      .map((d, index) => ({
        deviceId: d.deviceId,
        label: d.label || `${fallbackLabel} ${index + 1}`,
      }));

    return {
      // Outputs are listed even where setSinkId is missing, so the user can see
      // what exists; selecting one then falls back to the system route.
      inputs: pick('audioinput', 'Microphone'),
      outputs: pick('audiooutput', 'Speaker'),
    };
  },

  /**
   * Fill a <select>, keeping the stored choice selected when it still exists.
   * A device that has been unplugged silently falls back to the system default.
   */
  fill(select, devices, stored) {
    if (!select) return;
    const previous = stored || '';
    select.textContent = '';

    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'System default';
    select.appendChild(auto);

    let matched = false;
    for (const device of devices) {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label;
      if (device.deviceId === previous) matched = true;
      select.appendChild(option);
    }
    select.value = matched ? previous : '';
    select.disabled = devices.length === 0;
  },
};
