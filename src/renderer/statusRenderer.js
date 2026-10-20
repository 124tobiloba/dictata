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
    subtext.textContent = '';
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
      }, 2200);
    }
  }
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

window.vf.onStatus(applyState);

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

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: SAMPLE_RATE,
      channelCount: 1,
    },
  });

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
    }
  };
  console.log('[rec] mic ready, ctx', audioCtx.state, audioCtx.sampleRate);

  sourceNode = audioCtx.createMediaStreamSource(stream);
  sourceNode.connect(workletNode);
}
