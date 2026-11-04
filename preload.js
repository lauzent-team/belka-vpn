const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('belka', {
  minimize: () => ipcRenderer.invoke('window:minimize'),
  close: () => ipcRenderer.invoke('window:close'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (cfg) => ipcRenderer.invoke('config:set', cfg),
  connect: (opts) => ipcRenderer.invoke('vpn:connect', opts),
  disconnect: () => ipcRenderer.invoke('vpn:disconnect'),
  onEvent: (cb) => ipcRenderer.on('vpn:event', (_e, data) => cb(data))
});
