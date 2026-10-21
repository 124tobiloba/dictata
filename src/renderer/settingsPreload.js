// Settings window preload
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vf', {
  getStore: () => ipcRenderer.invoke('vf:get-store'),
  updateSettings: (patch) => ipcRenderer.invoke('vf:update-settings', patch),
  testKey: (key) => ipcRenderer.invoke('vf:test-key', key),
  setDictionary: (list) => ipcRenderer.invoke('vf:set-dictionary', list),
  setReplacements: (list) => ipcRenderer.invoke('vf:set-replacements', list),
  openExternal: (url) => ipcRenderer.invoke('vf:open-external', url),
  dashboardUrl: () => ipcRenderer.invoke('vf:dashboard-url'),
  openDashboard: () => ipcRenderer.invoke('vf:open-dashboard'),
  dashboardTest: () => ipcRenderer.invoke('vf:dashboard-test'),
});
