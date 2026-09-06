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

  async list() {
    if (!navigator.mediaDevices?.enumerateDevices) return { inputs: [], outputs: [] };
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    const pick = (kind, fallbackLabel) => devices
      .filter((d) => d.kind === kind)
      .map((d, index) => ({
        deviceId: d.deviceId,
        // A blank label means permission has not been granted yet.
        label: d.label || `${fallbackLabel} ${index + 1}`,
      }));
    return {
      inputs: pick('audioinput', 'Microphone'),
      outputs: this.outputSelectable() ? pick('audiooutput', 'Speaker') : [],
    };
  },

  /**
   * Whether a picker is worth showing at all.
   *
   * On mobile the OS owns audio routing: Android Chrome and iOS Safari expose
   * no audiooutput devices and a single "Default" input, and setSinkId does not
   * exist. A dropdown with one entry is not a choice - it is a dead control
   * implying a feature the platform does not have.
   */
  meaningful(devices) {
    return devices.length > 1;
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
