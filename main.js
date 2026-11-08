'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { SleePhyClient } = require('./src/lib/client');

let win = null;
let client = null;

function newClient() {
  return new SleePhyClient({
    userDataDir: app.getPath('userData'),
    onEvent: (evt) => {
      if (win && !win.isDestroyed()) win.webContents.send('sleephy:event', evt);
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 860,
    minHeight: 600,
    show: false,
    backgroundColor: '#0E1116',
    title: 'SleePhy',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // External links open in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  client = newClient();

  ipcMain.handle('sleephy:connect', async (_e, url) => {
    await client.connect(url);
    return client.status();
  });
  ipcMain.handle('sleephy:status', () => client.status());
  ipcMain.handle('sleephy:register', async (_e, payload) => client.register(payload));
  ipcMain.handle('sleephy:login', async (_e, payload) => client.login(payload));
  ipcMain.handle('sleephy:unlock', async (_e, password) => client.unlock(password));
  ipcMain.handle('sleephy:logout', async () => {
    client.disconnect();
    client.clearIdentity();
    client = newClient();
    await client.connect();
    return { ok: true };
  });
  ipcMain.handle('sleephy:send', async (_e, payload) => client.sendMessage(payload));
  ipcMain.handle('sleephy:history', async (_e, payload) => client.history(payload));
  ipcMain.handle('sleephy:directory', async (_e, username) => {
    const publicKey = await client.ensurePeerKey(username);
    return { username, publicKey };
  });

  ipcMain.handle('sleephy:edit', async (_e, payload) => client.editMessage(payload));
  ipcMain.handle('sleephy:delete', async (_e, id) => client.deleteMessage({ id }));
  ipcMain.handle('sleephy:react', async (_e, payload) => client.react(payload));
  ipcMain.handle('sleephy:typing', async (_e, payload) => client.typing(payload));
  ipcMain.handle('sleephy:profile', async (_e, username) => client.getProfile(username));
  ipcMain.handle('sleephy:saveProfile', async (_e, payload) => client.saveProfile(payload));
  ipcMain.handle('sleephy:changeUsername', async (_e, username) => client.changeUsername(username));
  ipcMain.handle('sleephy:searchUsers', async (_e, query) => client.searchUsers(query));
  ipcMain.handle('sleephy:listChats', async () => client.listChats());
  ipcMain.handle('sleephy:chatSettings', async (_e, payload) => client.setChatSettings(payload));
  ipcMain.handle('sleephy:markRead', async (_e, peer) => client.markRead(peer));
  ipcMain.handle('sleephy:clearChat', async (_e, peer) => client.clearChat(peer));
  ipcMain.handle('sleephy:deleteChat', async (_e, peer) => client.deleteChat(peer));
  ipcMain.handle('sleephy:openAttachment', async (_e, payload) => client.openAttachment(payload));
  ipcMain.handle('sleephy:pinMessage', async (_e, payload) => client.pinMessage(payload));
  ipcMain.handle('sleephy:pinnedMessages', async (_e, peer) => client.pinnedMessages({ peer }));
  ipcMain.handle('sleephy:searchMessages', async (_e, payload) => client.searchMessages(payload));
  ipcMain.handle('sleephy:getSettings', async () => client.getSettings());
  ipcMain.handle('sleephy:saveSettings', async (_e, settings) => client.saveSettings(settings));

  createWindow();
  client.connect().catch(() => {});

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (client) client.disconnect();
  if (process.platform !== 'darwin') app.quit();
});
