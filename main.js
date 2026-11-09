'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
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

  // Hide the menu bar. The application menu stays installed (below) so the
  // standard shortcuts keep working; nothing is drawn on screen.
  win.setMenuBarVisibility(false);

  // External links open in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/**
 * Install an invisible application menu so the menu bar never renders, while
 * the role-based accelerators (copy/paste/select-all/reload/zoom) keep working.
 * Without it, removing the menu also removes Ctrl+C/Ctrl+V.
 */
function installHiddenMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }]
    }
  ]);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(async () => {
  installHiddenMenu();
  client = newClient();

  ipcMain.handle('sleephy:connect', async (_e, url) => {
    await client.connect(url);
    return client.status();
  });
  ipcMain.handle('sleephy:status', () => client.status());
  ipcMain.handle('sleephy:register', async (_e, payload) => client.register(payload));
  ipcMain.handle('sleephy:login', async (_e, payload) => client.login(payload));
  ipcMain.handle('sleephy:requestCode', async (_e, phone) => client.requestCode(phone));
  ipcMain.handle('sleephy:verifyCode', async (_e, payload) => client.verifyCode(payload));
  ipcMain.handle('sleephy:setPassword', async (_e, password) => client.setPassword(password));
  ipcMain.handle('sleephy:unlock', async (_e, password) => client.unlock(password));
  ipcMain.handle('sleephy:logout', async () => {
    client.signOut();
    client = newClient();
    await client.connect();
    return { ok: true };
  });
  ipcMain.handle('sleephy:send', async (_e, payload) => client.sendMessage(payload));
  ipcMain.handle('sleephy:history', async (_e, payload) => client.history(payload));
  ipcMain.handle('sleephy:directory', async (_e, username) => {
    const publicKey = await client.ensurePeerKey(username);
    return {
      username,
      publicKey,
      profile: client.peerProfiles.get(username) || null,
      online: client.peerPresence.get(username) || false
    };
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

  // Groups
  ipcMain.handle('sleephy:createGroup', async (_e, payload) => client.createGroup(payload));
  ipcMain.handle('sleephy:listGroups', async () => client.listGroups());
  ipcMain.handle('sleephy:addGroupMember', async (_e, payload) => client.addGroupMember(payload));
  ipcMain.handle('sleephy:leaveGroup', async (_e, payload) => client.leaveGroup(payload));
  ipcMain.handle('sleephy:groupMembers', async (_e, payload) => client.groupMembers(payload));
  ipcMain.handle('sleephy:sendGroup', async (_e, payload) => client.sendGroupMessage(payload));
  ipcMain.handle('sleephy:groupHistory', async (_e, payload) => client.groupHistory(payload));
  ipcMain.handle('sleephy:editGroupMessage', async (_e, payload) => client.editGroupMessage(payload));
  ipcMain.handle('sleephy:deleteGroupMessage', async (_e, payload) => client.deleteGroupMessage(payload));
  ipcMain.handle('sleephy:openGroupAttachment', async (_e, payload) => client.openGroupAttachment(payload));
  ipcMain.handle('sleephy:adminOverview', async () => client.adminOverview());
  ipcMain.handle('sleephy:adminUsers', async () => client.adminUsers());
  ipcMain.handle('sleephy:adminAction', async (_e, payload) => client.adminAction(payload));

  // Accounts
  ipcMain.handle('sleephy:listAccounts', async () => client.accounts());
  ipcMain.handle('sleephy:switchAccount', async (_e, username) => client.switchAccount(username));
  ipcMain.handle('sleephy:forgetAccount', async (_e, username) => client.forgetAccount(username));
  ipcMain.handle('sleephy:forgetAllAccounts', async () => client.forgetAllAccounts());

  createWindow();
  // Connect before the window reads its state, so the first status() already
  // reflects a resumed session. The renderer's own connect reuses this socket.
  await client.connect().catch(() => {});

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (client) client.disconnect();
  if (process.platform !== 'darwin') app.quit();
});
