'use strict';
// CI smoke test: proves the first-run downloads work on this OS.
//   - ffmpeg: really downloaded, unpacked, executed, and an encoder is picked
//   - RIFE / Upscayl: the release assets must exist (HEAD / API lookup; the big archives are not fetched)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Tools } = require('../src/tools');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frameup-smoke-'));
  const tools = new Tools({ dataDir, resourcesDir: path.join(__dirname, '..', 'native') });
  await tools.installFfmpeg((d, t) => { if (d === t) process.stdout.write('.'); });
  const exe = (n) => path.join(dataDir, 'tools', 'ffmpeg', process.platform === 'win32' ? `${n}.exe` : n);
  if (!fs.existsSync(exe('ffmpeg')) || !fs.existsSync(exe('ffprobe'))) throw new Error('ffmpeg was not installed');
  const ff = { ffmpeg: exe('ffmpeg'), ffprobe: exe('ffprobe') };
  console.log('\nffmpeg:', execFileSync(ff.ffmpeg, ['-version'], { encoding: 'utf8' }).split('\n')[0]);
  console.log('ffprobe:', execFileSync(ff.ffprobe, ['-version'], { encoding: 'utf8' }).split('\n')[0]);
  const enc = await tools.pickEncoder(ff.ffmpeg);
  console.log('encoder:', enc.label);

  const res = await fetch(tools.rifeUrl(), { method: 'HEAD', redirect: 'follow' });
  if (!res.ok) throw new Error(`RIFE asset not found (${res.status}): ${tools.rifeUrl()}`);
  console.log('RIFE asset OK:', tools.rifeUrl().split('/').pop(), `${(Number(res.headers.get('content-length')) / 1048576).toFixed(0)} MB`);
  const up = await tools.upscaylAsset();
  console.log('Upscayl asset OK:', up.name, `${(up.size / 1048576).toFixed(0)} MB`);
  fs.rmSync(dataDir, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
