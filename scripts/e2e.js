'use strict';
// Dev helper: drives the real UI (pick source -> options -> Start) and waits for the result.
//   FRAMEUP_E2E=<video> [FRAMEUP_E2E_ENGINE=rife|apple] [FRAMEUP_E2E_OUT=<dir>] npx electron .
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

module.exports = (win) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const exec = (js) => win.webContents.executeJavaScript(js);
  const out = process.env.FRAMEUP_E2E_OUT || path.dirname(process.env.FRAMEUP_E2E);
  win.webContents.once('did-finish-load', async () => {
    let code = 1;
    try {
      await sleep(1500);
      await exec(`window.__frameup.setSource(${JSON.stringify(process.env.FRAMEUP_E2E)})`);
      await sleep(1500);
      await exec(`(() => { const S = window.__frameup.S; S.outDir = ${JSON.stringify(out)}; S.upModel = 'upscayl-lite-4x';
        document.querySelector('#fpsMode button[data-v="60"]').click();
        document.querySelector('#engine button[data-v="${process.env.FRAMEUP_E2E_ENGINE || 'rife'}"]').click();
        window.__frameup.update(); document.getElementById('start').click(); })()`);
      const shots = process.env.FRAMEUP_E2E_SHOTS;
      let n = 0, state = '';
      for (let i = 0; i < 600; i++) {   // up to ~10 min
        await sleep(1000);
        state = await exec(`!document.getElementById('view-done').classList.contains('hidden') ? 'done' : 'run'`);
        if (shots && i % 6 === 5 && state === 'run') {
          fs.mkdirSync(shots, { recursive: true });
          fs.writeFileSync(path.join(shots, `run-${++n}.png`), (await win.webContents.capturePage()).toPNG());
        }
        if (state === 'done') break;
      }
      const res = await exec(`({ title: document.getElementById('doneTitle').textContent, text: document.getElementById('doneText').textContent, path: document.getElementById('donePath').textContent, err: document.getElementById('doneLog').textContent })`);
      console.log('E2E RESULT', JSON.stringify(res));
      code = res.title === 'All done' && fs.existsSync(res.path) ? 0 : 1;
    } catch (e) { console.error('E2E failed', e); }
    app.exit(code);
  });
};
