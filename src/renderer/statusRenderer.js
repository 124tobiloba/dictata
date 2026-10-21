/**
 * statusRenderer.js — Status-pill renderer logic
 * Handles the recorder pipeline (getUserMedia → AudioWorklet → IPC)
 * and updates the pill UI based on state from main.
 */

const SAMPLE_RATE = 16000;

let audioCtx = null;
let stream = null;
let sourceNode = null;
let workletNode = null;
let recording = false;
let cancelled = false;

let settings = { sounds: true, microphoneId: 'default' };

// ── Pill UI ───────────────────────────────────────────────────────────────────
const pill    = document.getElementById('pill');
const label   = document.getElementById('label');
const subtext = document.getElementById('subtext');

const STATES = {
  idle:       { cls: 'idle',       text: '' },
  listening:  { cls: 'listening',  text: 'Listening…' },
  processing: { cls: 'processing', text: 'Processing…' },
  done:       { cls: 'done',       text: 'Pasted ✓' },
  error:      { cls: 'error',      text: 'Error' },
};

let hideTimer = null;

function applyState({ state, text, subtext: sub, message, handsFree }) {
  const cfg = STATES[state] || STATES.idle;
  pill.className = cfg.cls + (handsFree ? ' handsfree' : '');

  if (state === 'done' && text) {
    label.textContent = truncate(text, 30);
    subtext.textContent = message ? truncate(message, 40) : '';
  } else if (state === 'error' && message) {
    label.textContent = message.slice(0, 40);
    subtext.textContent = '';
  } else if (state === 'processing' && sub) {
    label.textContent = cfg.text;
    subtext.textContent = truncate(sub, 36);
  } else {
    label.textContent = cfg.text;
    subtext.textContent = '';
  }

  clearTimeout(hideTimer);

  if (state === 'idle') {
    pill.classList.remove('visible');
  } else {
    pill.classList.add('visible');
    if (state === 'done' || state === 'error') {
      hideTimer = setTimeout(() => {
        pill.classList.remove('visible');
      }, state === 'error' ? 6000 : 2200);
    }
  }

  if (state === 'done') beep('ok');
  if (state === 'error') beep('error');
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

window.vf.onStatus(applyState);

// ── Settings ──────────────────────────────────────────────────────────────────
window.vf.onSettings((next) => { settings = { ...settings, ...next }; });
window.vf.getSettings().then((s) => { settings = { ...settings, ...s }; }).catch(() => {});

// ── Sounds ───────────────────────────────────────────────────────────────────
let beepCtx = null;

/** Short feedback tone. Silently ignored when sounds are turned off. */
function beep(kind) {
  if (!settings.sounds) return;
  try {
    beepCtx = beepCtx || new AudioContext();
    if (beepCtx.state === 'suspended') beepCtx.resume();
    const osc = beepCtx.createOscillator();
    const gain = beepCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = kind === 'error' ? 320 : 660;
    const now = beepCtx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (kind === 'error' ? 0.35 : 0.14));
    osc.connect(gain).connect(beepCtx.destination);
    osc.start(now);
    osc.stop(now + (kind === 'error' ? 0.4 : 0.16));
  } catch { /* audio is optional */ }
}

// ── Audio capture ─────────────────────────────────────────────────────────────
window.vf.onRecStart(async () => {
  try {
    await ensureContext();
    if (audioCtx.state !== 'running') await audioCtx.resume();
    recording = true;
    cancelled = false;
    workletNode.port.postMessage('start');
  } catch (e) {
    console.error('[rec] start failed', e);
    window.vf.sendError('Microphone error: ' + e.message);
  }
});

// NOTE: keep `recording` true until the worklet answers 'done' —
// otherwise the final chunk and the 'done' message are discarded and
// main stays in "Processing" forever (the original bug).
window.vf.onRecStop(() => {
  if (!recording || !workletNode) return window.vf.sendDone();
  workletNode.port.postMessage('stop');
});

window.vf.onRecCancel(() => {
  cancelled = true;
  workletNode?.port.postMessage('stop');
});

async function ensureContext() {
  if (audioCtx && audioCtx.state === 'running' && workletNode) return;

  // Tear down any stale context
  await audioCtx?.close().catch(() => {});
  await stream?.getTracks().forEach((t) => t.stop()).catch(() => {});

  const constraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    sampleRate: SAMPLE_RATE,
    channelCount: 1,
  };

  const deviceId = await resolveDeviceId();
  if (deviceId) constraints.deviceId = { exact: deviceId };

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
  } catch (e) {
    // A stale device id (device unplugged / changed) must not break dictation.
    if (deviceId) {
      console.warn('[rec] selected microphone unavailable, falling back to default:', e.message);
      delete constraints.deviceId;
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    } else {
      throw e;
    }
  }

  audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });

  // Load worklet via fetch→blob so it works on file:// in Electron
  const resp = await fetch('recorderWorklet.js');
  const src  = await resp.text();
  const blob = new Blob([src], { type: 'application/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  await audioCtx.audioWorklet.addModule(blobUrl);
  URL.revokeObjectURL(blobUrl);

  workletNode = new AudioWorkletNode(audioCtx, 'recorder-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
  });

  workletNode.port.onmessage = (e) => {
    if (e.data === 'done') {
      const wasCancelled = cancelled;
      recording = false;
      cancelled = false;
      if (!wasCancelled) window.vf.sendDone();
    } else if (e.data?.pcm && recording && !cancelled) {
      window.vf.sendChunk(e.data.pcm);
      if (typeof e.data.level === 'number') window.vf.sendLevel(e.data.level);
    }
  };
  console.log('[rec] mic ready, ctx', audioCtx.state, audioCtx.sampleRate);

  sourceNode = audioCtx.createMediaStreamSource(stream);
  sourceNode.connect(workletNode);
}

/**
 * Map the configured microphone (device id or label) to a device id.
 * Device labels are only visible once the microphone permission was granted,
 * so an unknown value is passed through and validated by getUserMedia.
 */
async function resolveDeviceId() {
  const want = settings.microphoneId;
  if (!want || want === 'default') return null;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput');
    const byId = mics.find((d) => d.deviceId === want);
    if (byId) return byId.deviceId;
    const byLabel = mics.find((d) => d.label === want);
    if (byLabel) return byLabel.deviceId;
  } catch { /* enumeration can fail before permission */ }
  return want;
}
