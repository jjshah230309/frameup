'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const { Tools } = require('./src/tools');
const { Pipeline } = require('./src/pipeline');
const U = require('./src/util');

const dataDir = process.env.FRAMEUP_DATA || app.getPath('userData');
const resourcesDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'native');
const tools = new Tools({ dataDir, resourcesDir });
const settingsFile = path.join(dataDir, 'settings.json');

let win = null;
let current = null;      // active Pipeline
let blocker = null;

const readSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; } };
const writeSettings = (s) => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2)); };
const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };

function createWindow() {
  win = new BrowserWindow({
    width: 980, height: 820, minWidth: 760, minHeight: 640, show: false,
    title: 'FrameUp', backgroundColor: nativeTheme.shouldUseDarkColors ? '#14161a' : '#f6f7f9',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu?.();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

app.whenReady().then(() => {
  createWindow();
  if (process.env.FRAMEUP_SCREENSHOTS) require('./scripts/screenshots')(win, process.env.FRAMEUP_SCREENSHOTS);
  if (process.env.FRAMEUP_E2E) require('./scripts/e2e')(win);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (current) current.cancel(); app.quit(); });

// ---------- IPC ----------
ipcMain.handle('settings:get', () => ({ defaultTemp: path.join(dataDir, 'work'), ...readSettings() }));
ipcMain.handle('settings:set', (_e, patch) => { const s = { ...readSettings(), ...patch }; writeSettings(s); return s; });
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
  blocker = powerSaveBlocker.start('prevent-app-suspension');
  current.on('progress', (p) => { send('run:progress', p); win && !win.isDestroyed() && win.setProgressBar(p.overallPct / 100); });
  current.on('log', (l) => send('run:log', l));
  try {
    const r = await current.run();
    send('run:done', r);
    return r;
  } catch (e) {
    send('run:failed', { message: e.message, cancelled: e.message === 'Cancelled' });
    return null;
  } finally {
    if (blocker !== null) powerSaveBlocker.stop(blocker);
    blocker = null; current = null;
    if (win && !win.isDestroyed()) win.setProgressBar(-1);
  }
});
ipcMain.handle('cancel', () => { if (current) current.cancel(); });
ipcMain.handle('reveal', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('open', (_e, p) => shell.openPath(p));
ipcMain.handle('open-external', (_e, url) => { if (/^https:\/\/github\.com\//.test(url)) return shell.openExternal(url); });
