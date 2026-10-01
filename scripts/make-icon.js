'use strict';
// Renders build/icon.png (1024x1024) from the logo. Run: npm run icon
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="1024" height="1024">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c6cff"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
<rect width="64" height="64" rx="14" fill="url(#g)"/>
<rect x="14" y="30" width="26" height="20" rx="4" fill="#fff" fill-opacity=".35"/>
<rect x="19" y="23" width="26" height="20" rx="4" fill="#fff" fill-opacity=".6"/>
<rect x="24" y="16" width="26" height="20" rx="4" fill="#fff"/></svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, useContentSize: true, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;background:transparent">${svg}</body>`));
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage();
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.resize({ width: 1024, height: 1024 }).toPNG());
  console.log('wrote', out, img.getSize());
  app.quit();
});
