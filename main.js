'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker, nativeTheme, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const { Tools } = require('./src/tools');
const { Pipeline } = require('./src/pipeline');
const { Awake } = require('./src/awake');
const U = require('./src/util');

const dataDir = process.env.FRAMEUP_DATA || app.getPath('userData');
const resourcesDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'native');
const tools = new Tools({ dataDir, resourcesDir });
const settingsFile = path.join(dataDir, 'settings.json');

let win = null;
let current = null;      // active Pipeline
let blocker = null;
let screenOffTimer = null;
let awakeLeftover = {};   // sleep settings a previous run left changed (see Awake.leftovers)

const readSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; } };
const writeSettings = (s) => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2)); };
const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };
const awake = new Awake({ dataDir, log: (l) => send('run:log', l) });

function createWindow() {
  nativeTheme.themeSource = U.normTheme(readSettings().theme);
  win = new BrowserWindow({
    width: 980, height: 820, minWidth: 760, minHeight: 640, show: false,
    title: 'FrameUp', backgroundColor: nativeTheme.shouldUseDarkColors ? '#100904' : '#fbf1e1',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu?.();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function buildMenu() {
  // macOS keeps one app-wide menu, so give it the standard "Settings…" (Cmd+,) entry. Elsewhere the renderer handles Ctrl+,.
  if (process.platform !== 'darwin') return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: 'Settings…', accelerator: 'Command+,', click: () => send('settings:open') },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  awake.leftovers().then((r) => { awakeLeftover = r; if (r.macNeedsRestore) send('awake:leftover', r); }).catch(() => {});
  if (process.env.FRAMEUP_SCREENSHOTS) require('./scripts/screenshots')(win, process.env.FRAMEUP_SCREENSHOTS);
  if (process.env.FRAMEUP_E2E) require('./scripts/e2e')(win);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', () => { awake.stop().catch(() => {}); });
app.on('window-all-closed', () => { if (current) current.cancel(); app.quit(); });

// ---------- IPC ----------
ipcMain.handle('settings:get', () => ({ defaultTemp: path.join(dataDir, 'work'), ...readSettings() }));
ipcMain.handle('settings:set', (_e, patch) => { const s = { ...readSettings(), ...patch }; writeSettings(s); return s; });
ipcMain.on('settings:theme', (e) => { e.returnValue = U.normTheme(readSettings().theme); });   // read synchronously by the preload to avoid a flash
ipcMain.handle('awake:status', () => awakeLeftover);
ipcMain.handle('awake:restore', async () => { const ok = await awake.macRestore(); if (ok) awakeLeftover = {}; return ok; });
ipcMain.handle('theme:set', (_e, t) => { nativeTheme.themeSource = U.normTheme(t); });
ipcMain.handle('tools:status', () => tools.status());
ipcMain.handle('tools:install', async (_e, name) => {
  await tools.install(name, (done, total, label) => send('tools:progress', { name, done, total, label }));
  return tools.status();
});

ipcMain.handle('dialog:video', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a video', properties: ['openFile'],
    filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg', 'ts'] }, { name: 'All files', extensions: ['*'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:folder', async (_e, title) => {
  const r = await dialog.showOpenDialog(win, { title: title || 'Choose a folder', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// Describe a chosen/dropped path: video file or frames folder.
ipcMain.handle('probe', async (_e, p) => {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    const files = fs.readdirSync(p).filter(U.isImage).sort(U.naturalSort);
    if (files.length < 2) throw new Error('That folder needs at least 2 image frames (png / jpg / webp).');
    return { kind: 'frames', path: p, name: path.basename(p), frames: files.length, sample: path.join(p, files[0]) };
  }
  const ff = tools.ffmpeg();
  if (!ff) return { kind: 'video', path: p, name: path.parse(p).name, unknown: true };
  const pl = new Pipeline({}, tools);
  const info = await pl._probe(p);
  return { kind: 'video', path: p, name: path.parse(p).name, ...info };
});
ipcMain.handle('frames:size', async (_e, sample) => {
  if (!tools.ffmpeg()) return null;
  const pl = new Pipeline({}, tools);
  const { width, height } = await pl._probe(sample);
  return { width, height };
});
ipcMain.handle('free-space', async (_e, dir) => {
  try { fs.mkdirSync(dir, { recursive: true }); const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
});

ipcMain.handle('run', async (_e, opts) => {
  if (current) throw new Error('A job is already running.');
  const settings = readSettings();
  const workRoot = opts.workRoot || settings.workRoot || path.join(dataDir, 'work');
  fs.mkdirSync(workRoot, { recursive: true });
  current = new Pipeline({ ...opts, workRoot }, tools);
  const awakeMode = U.normAwake(settings.awake), awakeLid = !!settings.awakeLid;
  if (awakeMode !== 'off' || awakeLid) blocker = powerSaveBlocker.start(awakeMode === 'display' ? 'prevent-display-sleep' : 'prevent-app-suspension');
  current.on('progress', (p) => { send('run:progress', p); win && !win.isDestroyed() && win.setProgressBar(p.overallPct / 100); });
  current.on('log', (l) => send('run:log', l));
  try {
    for (const w of await awake.start({ mode: awakeMode, lid: awakeLid })) send('run:log', `Warning: ${w}`);
    if (settings.screenOff && awakeMode !== 'display') {      // let the user see the run start, then turn the screen off
      screenOffTimer = setTimeout(() => awake.displayOff().then((w) => w && send('run:log', `Warning: ${w}`)).catch(() => {}), 5000);
    }
    const r = await current.run();
    send('run:done', r);
    return r;
  } catch (e) {
    send('run:failed', { message: e.message, cancelled: e.message === 'Cancelled' });
    return null;
  } finally {
    clearTimeout(screenOffTimer); screenOffTimer = null;
    if (blocker !== null) powerSaveBlocker.stop(blocker);
    await awake.stop();
    blocker = null; current = null;
    if (win && !win.isDestroyed()) win.setProgressBar(-1);
  }
});
ipcMain.handle('cancel', () => { if (current) current.cancel(); });
ipcMain.handle('reveal', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('open', (_e, p) => shell.openPath(p));
ipcMain.handle('open-external', (_e, url) => { if (/^https:\/\/github\.com\//.test(url)) return shell.openExternal(url); });
