/**
 * mic-probe.js — measures what the microphone actually delivers.
 *
 * Used to verify the level pipeline end to end:
 *   electron scripts/mic-probe.js [--use-fake-device-for-media-stream]
 *                   [--use-file-for-fake-audio-capture=<file.wav>]
 *
 * Prints the RMS of the incoming samples so a silent input device can be
 * told apart from a broken level calculation.
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');

const SAMPLE_RATE = 16000;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      permissions: ['media'],
    },
  });

  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => cb(true));

  await win.loadFile(path.join(__dirname, 'mic-probe.html'));

  const result = await win.webContents.executeJavaScript(`(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false,
                sampleRate: ${SAMPLE_RATE}, channelCount: 1 },
    });
    const ctx = new AudioContext({ sampleRate: ${SAMPLE_RATE} });
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let sum = 0, count = 0, peak = 0;
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      for (let i = 0; i < buf.length; i++) {
        sum += buf[i] * buf[i];
        peak = Math.max(peak, Math.abs(buf[i]));
        count++;
      }
    }, 50);
    await new Promise(r => setTimeout(r, 4000));
    clearInterval(timer);
    const rms = count ? Math.sqrt(sum / count) : 0;
    return { samples: count, rms, peak };
  })()`);

  console.log(`samples: ${result.samples}`);
  console.log(`rms:     ${result.rms.toFixed(5)}`);
  console.log(`peak:    ${result.peak.toFixed(5)}`);
  console.log(result.rms > 0.0005 ? 'MIC IS LIVE' : 'MIC IS SILENT');
  app.exit(0);
});
