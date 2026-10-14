'use strict';
// Dev helper: FRAMEUP_SCREENSHOTS=<dir> npx electron .   -> captures the main UI states as PNGs, then quits.
const fs = require('fs');
const path = require('path');
const { app, nativeTheme } = require('electron');

module.exports = (win, outDir) => {
  fs.mkdirSync(outDir, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const exec = (js) => win.webContents.executeJavaScript(js);
  const shot = async (name) => {
    await sleep(500);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
    console.log('captured', name);
  };
  const stages = (states) => ['Get tools', 'Extract', 'Upscale', 'Interpolate', 'Encode'].map((n, i) => ({ id: n, name: n, state: states[i] }));

  win.webContents.once('did-finish-load', async () => {
    try {
      const theme = process.env.FRAMEUP_THEME || 'dark';
      nativeTheme.themeSource = theme;
      await sleep(1200);
      win.setSize(980, 1280);
      await sleep(400);
      await exec(`window.__frameup.view('setup')`);
      await shot(`${theme}-0-empty`);
      if (process.env.FRAMEUP_DEMO_VIDEO) {
        await exec(`window.__frameup.setSource(${JSON.stringify(process.env.FRAMEUP_DEMO_VIDEO)})`);
        await sleep(1500);
      }
      await shot(`${theme}-1-setup`);
      win.setSize(980, 640);
      await sleep(300);
      await exec(`window.__frameup.onProgress(${JSON.stringify({
        stages: stages(['done', 'done', 'active', 'pending', 'pending']), index: 2, stageName: 'Upscale', note: 'Upscayl · upscayl-standard-4x · 2x', unit: 'frames',
        done: 1380, total: 2940, queued: 1560, rate: 3.2, eta: 487, stagePct: 47, overallPct: 31, elapsed: 842 })}); window.__frameup.view('run')`);
      await shot(`${theme}-2-running`);
      await exec(`window.__frameup.showDone(${JSON.stringify({ output: '/Users/you/Movies/The Special One Upscayl 2x RIFE 60fps.mp4', width: 3840, height: 2160, fps: 60, frames: 7056, elapsed: 4710 })})`);
      await shot(`${theme}-3-done`);
      await exec(`window.__frameup.showFailed(${JSON.stringify({ message: 'Not enough disk space for RIFE: needs about 31.2 GB in the temp folder, only 22.4 GB free. Choose another temp folder, free some space, or use Apple ML.', cancelled: false })})`);
      await shot(`${theme}-4-error`);
      await exec(`window.__frameup.view('setup'); document.getElementById('toolsBtn').click()`);
      await shot(`${theme}-5-tools`);
    } catch (e) { console.error('screenshot failed', e); }
    app.quit();
  });
};
