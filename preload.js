'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('frameup', {
  theme: ipcRenderer.sendSync('settings:theme'),
  setTheme: (t) => ipcRenderer.invoke('theme:set', t),
  onOpenSettings: on('settings:open'),
  awakeStatus: () => ipcRenderer.invoke('awake:status'),
  awakeRestore: () => ipcRenderer.invoke('awake:restore'),
  onAwakeLeftover: on('awake:leftover'),
  settings: { get: () => ipcRenderer.invoke('settings:get'), set: (p) => ipcRenderer.invoke('settings:set', p) },
  toolsStatus: () => ipcRenderer.invoke('tools:status'),
  installTool: (name) => ipcRenderer.invoke('tools:install', name),
  onToolsProgress: on('tools:progress'),
  chooseVideo: () => ipcRenderer.invoke('dialog:video'),
  chooseFolder: (title) => ipcRenderer.invoke('dialog:folder', title),
  pathFor: (file) => webUtils.getPathForFile(file),
  probe: (p) => ipcRenderer.invoke('probe', p),
  framesSize: (sample) => ipcRenderer.invoke('frames:size', sample),
  freeSpace: (dir) => ipcRenderer.invoke('free-space', dir),
  run: (opts) => ipcRenderer.invoke('run', opts),
  cancel: () => ipcRenderer.invoke('cancel'),
  onProgress: on('run:progress'),
  onLog: on('run:log'),
  onDone: on('run:done'),
  onFailed: on('run:failed'),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  open: (p) => ipcRenderer.invoke('open', p),
  openExternal: (u) => ipcRenderer.invoke('open-external', u),
  platform: process.platform,
});
