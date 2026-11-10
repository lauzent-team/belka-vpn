'use strict';

/**
 * The only bridge between the UI and the main process. Private keys and
 * plaintext never cross into the renderer's world.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Electron wraps a rejection from ipcMain.handle in its own text:
//   "Error invoking remote method 'sleephy:verifyCode': Error: Wrong code"
// The user should read the reason, not the plumbing. Unwrap it once here so no
// call site has to.
const invoke = (channel, ...args) =>
  ipcRenderer.invoke(channel, ...args).catch((err) => {
    const raw = err && err.message ? err.message : String(err);
    const message = raw
      .replace(/^Error invoking remote method '[^']*':\s*/, '')
      .replace(/^\w*Error:\s*/, '');
    throw new Error(message);
  });

contextBridge.exposeInMainWorld('sleephy', {
  connect: (url) => invoke('sleephy:connect', url),
  status: () => invoke('sleephy:status'),
  register: (payload) => invoke('sleephy:register', payload),
  login: (payload) => invoke('sleephy:login', payload),
  requestCode: (phone) => invoke('sleephy:requestCode', phone),
  verifyCode: (payload) => invoke('sleephy:verifyCode', payload),
  setPassword: (password) => invoke('sleephy:setPassword', password),
  unlock: (password) => invoke('sleephy:unlock', password),
  logout: () => invoke('sleephy:logout'),
  send: (payload) => invoke('sleephy:send', payload),
  history: (payload) => invoke('sleephy:history', payload),
  directory: (username) => invoke('sleephy:directory', username),
  edit: (payload) => invoke('sleephy:edit', payload),
  remove: (id) => invoke('sleephy:delete', id),
  react: (payload) => invoke('sleephy:react', payload),
  typing: (payload) => invoke('sleephy:typing', payload),
  profile: (username) => invoke('sleephy:profile', username),
  streak: () => invoke('sleephy:streak'),
  saveProfile: (payload) => invoke('sleephy:saveProfile', payload),
  changeUsername: (username) => invoke('sleephy:changeUsername', username),
  searchUsers: (query) => invoke('sleephy:searchUsers', query),
  listChats: () => invoke('sleephy:listChats'),
  chatSettings: (payload) => invoke('sleephy:chatSettings', payload),
  markRead: (peer) => invoke('sleephy:markRead', peer),
  clearChat: (peer) => invoke('sleephy:clearChat', peer),
  deleteChat: (peer) => invoke('sleephy:deleteChat', peer),
  openAttachment: (payload) => invoke('sleephy:openAttachment', payload),
  pinMessage: (payload) => invoke('sleephy:pinMessage', payload),
  pinnedMessages: (peer) => invoke('sleephy:pinnedMessages', peer),
  searchMessages: (payload) => invoke('sleephy:searchMessages', payload),
  getSettings: () => invoke('sleephy:getSettings'),
  saveSettings: (settings) => invoke('sleephy:saveSettings', settings),
  createGroup: (payload) => invoke('sleephy:createGroup', payload),
  listGroups: () => invoke('sleephy:listGroups'),
  addGroupMember: (payload) => invoke('sleephy:addGroupMember', payload),
  leaveGroup: (payload) => invoke('sleephy:leaveGroup', payload),
  groupMembers: (payload) => invoke('sleephy:groupMembers', payload),
  sendGroup: (payload) => invoke('sleephy:sendGroup', payload),
  groupHistory: (payload) => invoke('sleephy:groupHistory', payload),
  editGroupMessage: (payload) => invoke('sleephy:editGroupMessage', payload),
  deleteGroupMessage: (payload) => invoke('sleephy:deleteGroupMessage', payload),
  openGroupAttachment: (payload) => invoke('sleephy:openGroupAttachment', payload),
  createChannel: (payload) => invoke('sleephy:createChannel', payload),
  listChannels: () => invoke('sleephy:listChannels'),
  discoverChannels: () => invoke('sleephy:discoverChannels'),
  channelInfo: (payload) => invoke('sleephy:channelInfo', payload),
  joinChannel: (payload) => invoke('sleephy:joinChannel', payload),
  leaveChannel: (payload) => invoke('sleephy:leaveChannel', payload),
  editChannel: (payload) => invoke('sleephy:editChannel', payload),
  deleteChannel: (payload) => invoke('sleephy:deleteChannel', payload),
  sendChannelPost: (payload) => invoke('sleephy:sendChannelPost', payload),
  channelHistory: (payload) => invoke('sleephy:channelHistory', payload),
  editChannelMessage: (payload) => invoke('sleephy:editChannelMessage', payload),
  deleteChannelMessage: (payload) => invoke('sleephy:deleteChannelMessage', payload),
  openChannelAttachment: (payload) => invoke('sleephy:openChannelAttachment', payload),
  adminOverview: () => invoke('sleephy:adminOverview'),
  adminUsers: () => invoke('sleephy:adminUsers'),
  adminChannels: () => invoke('sleephy:adminChannels'),
  adminAction: (payload) => invoke('sleephy:adminAction', payload),
  listAccounts: () => invoke('sleephy:listAccounts'),
  switchAccount: (username) => invoke('sleephy:switchAccount', username),
  forgetAccount: (username) => invoke('sleephy:forgetAccount', username),
  forgetAllAccounts: () => invoke('sleephy:forgetAllAccounts'),
  onEvent: (handler) => {
    const listener = (_e, evt) => handler(evt);
    ipcRenderer.on('sleephy:event', listener);
    return () => ipcRenderer.removeListener('sleephy:event', listener);
  }
});
