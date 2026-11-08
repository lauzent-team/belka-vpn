'use strict';

/**
 * The only bridge between the UI and the main process. Private keys and
 * plaintext never cross into the renderer's world.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sleephy', {
  connect: (url) => ipcRenderer.invoke('sleephy:connect', url),
  status: () => ipcRenderer.invoke('sleephy:status'),
  register: (payload) => ipcRenderer.invoke('sleephy:register', payload),
  login: (payload) => ipcRenderer.invoke('sleephy:login', payload),
  unlock: (password) => ipcRenderer.invoke('sleephy:unlock', password),
  logout: () => ipcRenderer.invoke('sleephy:logout'),
  send: (payload) => ipcRenderer.invoke('sleephy:send', payload),
  history: (payload) => ipcRenderer.invoke('sleephy:history', payload),
  directory: (username) => ipcRenderer.invoke('sleephy:directory', username),
  onEvent: (handler) => {
    const listener = (_e, evt) => handler(evt);
    ipcRenderer.on('sleephy:event', listener);
    return () => ipcRenderer.removeListener('sleephy:event', listener);
  }
});
