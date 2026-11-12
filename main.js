'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, Menu, Tray, nativeImage, Notification } = require('electron');
const { SleePhyClient } = require('./src/lib/client');

let win = null;
let client = null;
let tray = null;
// Set once the user really quits (tray menu, app.quit(), OS shutdown). Until
// then the window's close button only hides it, so the app keeps receiving
// messages and the tray icon stays reachable.
let isQuitting = false;

// A crash in the main process closes every window with a raw stack trace, which
// tells the user nothing and loses the messenger. Log and keep running: a stray
// error from a socket or a notification must not take the app down. Errors that
// really are fatal still surface in the log.
process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection:', reason);
});

/**
 * Media shipped inside the app (read-only). Under electron-builder these land
 * in resources/; running from the repo they sit next to main.js in build/.
 */
function bundledMediaDir(kind) {
  const candidates = [
    path.join(process.resourcesPath || '', kind),
    path.join(__dirname, 'build', kind)
  ];
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } })
    || path.join(__dirname, 'build', kind);
}

/** The app icon, as packaged. */
function appIconPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'icon.png'),
    path.join(__dirname, 'build', 'icon.png')
  ];
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

/** Bring the window back from the tray, recreating it if it was really closed. */
function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Templates seeded into the user's writable media folder on first use.
const FM_TEMPLATE = {
  _comment: 'Бурмалда FM плейлист. Положите аудиофайлы в эту папку и перечислите их здесь. '
    + 'Поддерживаются mp3, ogg, wav, m4a, flac. Можно писать просто имена файлов '
    + 'или объекты { file, title, artist, cover }.',
  tracks: []
};
const RINGTONES_TEMPLATE = {
  _comment: 'Рингтоны. Положите файлы в эту папку и укажите их здесь: incoming — входящий '
    + 'звонок, outgoing — исходящий, default — для всего остального. '
    + 'Если файла нет, играет встроенный сигнал.',
  ringtones: {}
};

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
    icon: appIconPath() || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Closing the window puts the app in the tray instead of quitting, so
  // messages keep arriving and notifications keep firing. With no tray to
  // restore from, hiding would strand the app invisible, so it quits instead.
  win.on('close', (event) => {
    if (isQuitting || !tray) return;
    event.preventDefault();
    win.hide();
  });

  // Calls need the microphone and camera. Electron denies both by default, so
  // grant only these two to our own window and nothing else — a page that is
  // not ours never reaches here (external links open in the system browser).
  const ses = win.webContents.session;
  const MEDIA = new Set(['media', 'audioCapture', 'videoCapture']);
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(MEDIA.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => MEDIA.has(permission));

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

/**
 * A tray icon, so the app keeps running (and keeps notifying) after the window
 * is closed. Creation is best-effort: a desktop without a system tray must not
 * stop the messenger from starting.
 */
function createTray() {
  if (tray) return;
  const iconPath = appIconPath();
  let image = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (!image.isEmpty()) image = image.resize({ width: 16, height: 16 });
  try {
    tray = new Tray(image);
  } catch {
    tray = null;
    return;
  }
  tray.setToolTip('SleePhy');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть SleePhy', click: showWindow },
    { type: 'separator' },
    { label: 'Выйти', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

/**
 * Show a message alert through the OS. Going through the main process (rather
 * than the renderer's HTML5 Notification) is what makes the toast carry the
 * app's own name and icon instead of the generic "Electron" identity.
 */
function showNativeNotification(title, body) {
  if (!Notification.isSupported()) return;
  const iconPath = appIconPath();
  try {
    const note = new Notification({
      title: String(title || 'SleePhy'),
      body: String(body || ''),
      icon: iconPath || undefined
    });
    note.on('click', showWindow);
    note.show();
  } catch { /* a desktop without a notification service just stays silent */ }
}

app.whenReady().then(async () => {
  // Windows attributes a toast to the app whose AppUserModelID matches the
  // installed Start Menu shortcut. Without it the toast is titled "Electron
  // App"; the value here is the same appId electron-builder puts on the
  // shortcut, so the two line up.
  if (process.platform === 'win32') app.setAppUserModelId('ru.sleephy.desktop');
  installHiddenMenu();
  client = newClient();
  createTray();

  ipcMain.handle('sleephy:notify', (_e, payload) => {
    showNativeNotification(payload && payload.title, payload && payload.body);
    return true;
  });

  ipcMain.handle('sleephy:connect', async (_e, url) => {
    await client.connect(url);
    return client.status();
  });
  ipcMain.handle('sleephy:status', () => client.status());
  ipcMain.handle('sleephy:version', () => app.getVersion());
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
  ipcMain.handle('sleephy:checkNickname', async (_e, nickname) => client.checkNickname(nickname));
  ipcMain.handle('sleephy:streak', async () => client.getStreak());
  ipcMain.handle('sleephy:saveProfile', async (_e, payload) => client.saveProfile(payload));
  ipcMain.handle('sleephy:changeUsername', async (_e, username) => client.changeUsername(username));
  ipcMain.handle('sleephy:searchUsers', async (_e, query) => client.searchUsers(query));
  ipcMain.handle('sleephy:listChats', async () => client.listChats());
  ipcMain.handle('sleephy:chatSettings', async (_e, payload) => client.setChatSettings(payload));
  ipcMain.handle('sleephy:chatTtl', async (_e, payload) => client.setChatTtl(payload));
  ipcMain.handle('sleephy:safetyNumber', async (_e, username) => client.safetyNumberWith(username));
  ipcMain.handle('sleephy:listScheduled', async () => client.listScheduled());
  ipcMain.handle('sleephy:cancelScheduled', async (_e, id) => client.cancelScheduled({ id }));
  ipcMain.handle('sleephy:rescheduleScheduled', async (_e, payload) => client.rescheduleScheduled(payload));
  ipcMain.handle('sleephy:sendScheduledNow', async (_e, id) => client.sendScheduledNow({ id }));
  ipcMain.handle('sleephy:markRead', async (_e, peer) => client.markRead(peer));
  ipcMain.handle('sleephy:clearChat', async (_e, peer) => client.clearChat(peer));
  ipcMain.handle('sleephy:deleteChat', async (_e, peer) => client.deleteChat(peer));
  ipcMain.handle('sleephy:openAttachment', async (_e, payload) => client.openAttachment(payload));
  ipcMain.handle('sleephy:pinMessage', async (_e, payload) => client.pinMessage(payload));
  ipcMain.handle('sleephy:pinnedMessages', async (_e, peer) => client.pinnedMessages({ peer }));
  ipcMain.handle('sleephy:searchMessages', async (_e, payload) => client.searchMessages(payload));
  ipcMain.handle('sleephy:searchGlobal', async (_e, payload) => client.searchGlobal(payload));
  ipcMain.handle('sleephy:getSettings', async () => client.getSettings());
  ipcMain.handle('sleephy:saveSettings', async (_e, settings) => client.saveSettings(settings));
  ipcMain.handle('sleephy:setPrivacy', async (_e, privacy) => client.setPrivacy(privacy));

  // Calls (signaling only; media flows peer-to-peer)
  ipcMain.handle('sleephy:callInvite', async (_e, payload) => client.callInvite(payload));
  ipcMain.handle('sleephy:callAnswer', async (_e, payload) => client.callAnswer(payload));
  ipcMain.handle('sleephy:callSignal', async (_e, payload) => client.callSignal(payload));
  ipcMain.handle('sleephy:callDecline', async (_e, payload) => client.callDecline(payload));
  ipcMain.handle('sleephy:callHangup', async (_e, payload) => client.callHangup(payload));

  // Rockets and Premium. The relay settles the money; these only carry the call.
  ipcMain.handle('sleephy:wallet', async () => client.wallet());
  ipcMain.handle('sleephy:payCreate', async (_e, payload) => client.payCreate(payload));
  ipcMain.handle('sleephy:payClaim', async (_e, payload) => client.payClaim(payload));
  ipcMain.handle('sleephy:payCancel', async (_e, payload) => client.payCancel(payload));
  ipcMain.handle('sleephy:giftSend', async (_e, payload) => client.giftSend(payload));
  ipcMain.handle('sleephy:giftPremium', async (_e, payload) => client.giftPremium(payload));
  ipcMain.handle('sleephy:giftInventory', async () => client.giftInventory());
  ipcMain.handle('sleephy:giftEquip', async (_e, payload) => client.giftEquip(payload));
  ipcMain.handle('sleephy:giftSell', async (_e, payload) => client.giftSell(payload));

  // Open a checkout link in the system browser. Only http(s) is allowed, so a
  // provider response can never ask the shell to run a local file or a custom
  // protocol handler.
  ipcMain.handle('sleephy:openExternal', async (_e, url) => {
    if (typeof url !== 'string') return false;
    let parsed;
    try { parsed = new URL(url); } catch { return false; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    await shell.openExternal(url);
    return true;
  });

  // Local media assets: the FM playlist and the ringtone list. These live in a
  // writable folder under userData, so a user can drop in their own music and
  // ringtones after the app is installed; the folder is seeded from a template
  // on first use so it is discoverable.
  ipcMain.handle('sleephy:readMediaManifest', async (_e, kind) => {
    const spec = kind === 'ringtones'
      ? { dir: 'ringtones', file: 'manifest.json', template: RINGTONES_TEMPLATE }
      : { dir: 'fm', file: 'playlist.json', template: FM_TEMPLATE };
    const userDir = path.join(app.getPath('userData'), 'media', spec.dir);
    const userFile = path.join(userDir, spec.file);
    if (!fs.existsSync(userFile)) {
      try {
        fs.mkdirSync(userDir, { recursive: true });
        fs.writeFileSync(userFile, JSON.stringify(spec.template, null, 2));
      } catch { /* a read-only profile just has no media */ }
    }
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(userFile, 'utf8')); } catch { manifest = null; }
    // The user's own folder wins. When it is empty, fall back to the station
    // shipped inside the app, so Бурмалда FM is never silent out of the box.
    const mine = manifest && Array.isArray(manifest.tracks) && manifest.tracks.length > 0;
    if (kind !== 'ringtones' && !mine) {
      const bundled = bundledMediaDir('fm');
      try {
        const bm = JSON.parse(fs.readFileSync(path.join(bundled, spec.file), 'utf8'));
        if (bm && Array.isArray(bm.tracks) && bm.tracks.length) {
          return { dir: bundled, manifest: bm, bundled: true };
        }
      } catch { /* not packaged — the station stays empty */ }
    }
    return { dir: userDir, manifest };
  });

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

  // Channels
  ipcMain.handle('sleephy:createChannel', async (_e, payload) => client.createChannel(payload));
  ipcMain.handle('sleephy:listChannels', async () => client.listChannels());
  ipcMain.handle('sleephy:discoverChannels', async () => client.discoverChannels());
  ipcMain.handle('sleephy:channelInfo', async (_e, payload) => client.channelInfo(payload));
  ipcMain.handle('sleephy:joinChannel', async (_e, payload) => client.joinChannel(payload));
  ipcMain.handle('sleephy:leaveChannel', async (_e, payload) => client.leaveChannel(payload));
  ipcMain.handle('sleephy:editChannel', async (_e, payload) => client.editChannel(payload));
  ipcMain.handle('sleephy:deleteChannel', async (_e, payload) => client.deleteChannel(payload));
  ipcMain.handle('sleephy:sendChannelPost', async (_e, payload) => client.sendChannelPost(payload));
  ipcMain.handle('sleephy:channelHistory', async (_e, payload) => client.channelHistory(payload));
  ipcMain.handle('sleephy:editChannelMessage', async (_e, payload) => client.editChannelMessage(payload));
  ipcMain.handle('sleephy:deleteChannelMessage', async (_e, payload) => client.deleteChannelMessage(payload));
  ipcMain.handle('sleephy:openChannelAttachment', async (_e, payload) => client.openChannelAttachment(payload));
  ipcMain.handle('sleephy:storyAudience', async () => client.storyAudience());
  ipcMain.handle('sleephy:postStory', async (_e, payload) => client.postStory(payload));
  ipcMain.handle('sleephy:listStories', async () => client.listStories());
  ipcMain.handle('sleephy:viewStory', async (_e, payload) => client.viewStory(payload));
  ipcMain.handle('sleephy:openStoryAttachment', async (_e, payload) => client.openStoryAttachment(payload));
  ipcMain.handle('sleephy:storyViewers', async (_e, payload) => client.storyViewers(payload));
  ipcMain.handle('sleephy:deleteStory', async (_e, payload) => client.deleteStory(payload));
  ipcMain.handle('sleephy:adminOverview', async () => client.adminOverview());
  ipcMain.handle('sleephy:adminUsers', async () => client.adminUsers());
  ipcMain.handle('sleephy:adminDevices', async () => client.adminDevices());
  ipcMain.handle('sleephy:adminChannels', async () => client.adminChannels());
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

app.on('before-quit', () => { isQuitting = true; });

app.on('will-quit', () => {
  if (tray) { tray.destroy(); tray = null; }
});

app.on('window-all-closed', () => {
  if (!isQuitting) return;
  if (client) client.disconnect();
  if (process.platform !== 'darwin') app.quit();
});
