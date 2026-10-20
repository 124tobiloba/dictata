// Status window preload — exposes IPC bridge to the pill renderer
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vf', {
  // Recorder: renderer → main
  sendChunk: (ab) => ipcRenderer.send('rec:chunk', ab),
  sendDone: () => ipcRenderer.send('rec:done'),
  sendError: (msg) => ipcRenderer.send('rec:error', msg),

  // Status: main → renderer
  onStatus: (cb) => ipcRenderer.on('vf:status', (_e, d) => cb(d)),

  // Recorder control: main → renderer
  onRecStart: (cb) => ipcRenderer.on('rec:start', cb),
  onRecStop: (cb) => ipcRenderer.on('rec:stop', cb),
  onRecCancel: (cb) => ipcRenderer.on('rec:cancel', cb),
});
