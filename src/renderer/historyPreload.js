// History window preload
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vf', {
  getStore: () => ipcRenderer.invoke('vf:get-store'),
  deleteHistory: (id) => ipcRenderer.invoke('vf:delete-history', id),
  clearHistory: () => ipcRenderer.invoke('vf:clear-history'),
  pasteEntry: (text) => ipcRenderer.invoke('vf:paste-entry', text),
  onHistoryUpdated: (cb) => ipcRenderer.on('vf:history-updated', (_e, d) => cb(d)),
  openSettings: () => ipcRenderer.send('vf:open-settings'),
});
