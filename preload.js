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
  edit: (payload) => ipcRenderer.invoke('sleephy:edit', payload),
  remove: (id) => ipcRenderer.invoke('sleephy:delete', id),
  react: (payload) => ipcRenderer.invoke('sleephy:react', payload),
  typing: (payload) => ipcRenderer.invoke('sleephy:typing', payload),
  profile: (username) => ipcRenderer.invoke('sleephy:profile', username),
  saveProfile: (payload) => ipcRenderer.invoke('sleephy:saveProfile', payload),
  changeUsername: (username) => ipcRenderer.invoke('sleephy:changeUsername', username),
  searchUsers: (query) => ipcRenderer.invoke('sleephy:searchUsers', query),
  listChats: () => ipcRenderer.invoke('sleephy:listChats'),
  chatSettings: (payload) => ipcRenderer.invoke('sleephy:chatSettings', payload),
  markRead: (peer) => ipcRenderer.invoke('sleephy:markRead', peer),
  clearChat: (peer) => ipcRenderer.invoke('sleephy:clearChat', peer),
  deleteChat: (peer) => ipcRenderer.invoke('sleephy:deleteChat', peer),
  openAttachment: (payload) => ipcRenderer.invoke('sleephy:openAttachment', payload),
  pinMessage: (payload) => ipcRenderer.invoke('sleephy:pinMessage', payload),
  pinnedMessages: (peer) => ipcRenderer.invoke('sleephy:pinnedMessages', peer),
  searchMessages: (payload) => ipcRenderer.invoke('sleephy:searchMessages', payload),
  getSettings: () => ipcRenderer.invoke('sleephy:getSettings'),
  saveSettings: (settings) => ipcRenderer.invoke('sleephy:saveSettings', settings),
  onEvent: (handler) => {
    const listener = (_e, evt) => handler(evt);
    ipcRenderer.on('sleephy:event', listener);
    return () => ipcRenderer.removeListener('sleephy:event', listener);
  }
});
