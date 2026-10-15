#!/usr/bin/env node
'use strict';
// Headless FrameUp:  node src/cli.js <video|frames-folder> [options]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Tools } = require('./tools');
const { Pipeline } = require('./pipeline');
const U = require('./util');

function usage() {
  console.log(`Usage: frameup-cli <video-or-frames-folder> [options]
  --upscale <model>     Upscayl model name (e.g. upscayl-standard-4x)   [default: none]
  --scale <2|3|4>       Upscale factor                                  [default: 2]
  --fps <n>             Target frame rate (interpolates)                [default: keep]
  --engine <rife|apple> Interpolation engine                            [default: rife]
  --src-fps <n>         Frame rate of a frames folder                   [default: 25]
  --out <dir>           Output folder                                   [default: next to input]
  --temp <dir>          Temp folder for frames                          [default: system temp]
  --upscale-device <d>  auto | cpu | gpu | <GPU number>                  [default: auto]
  --interp-device <d>   auto | cpu | gpu | <GPU number>  (RIFE)          [default: auto]
  --encoder <m>         auto | gpu | cpu  (HEVC hardware vs x265/x264)   [default: auto]
  --upscale-tta         Upscayl TTA mode (slower, slightly cleaner)
  --interp-tta          RIFE spatial TTA mode (slower, a little smoother)
  --device <d>          shortcut: gpu or cpu for all three stages above
  --list-models         Show installed Upscayl models and exit`);
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const dataDir = process.env.FRAMEUP_DATA || path.join(os.homedir(), '.frameup');
  const tools = new Tools({ dataDir, resourcesDir: path.join(__dirname, '..', 'native') });

  if (argv.includes('--list-models')) {
    const up = tools.upscayl();
    console.log(up ? up.models.join('\n') : 'Upscayl not found (it is downloaded automatically on first use).');
    return;
  }
  const input = argv.find((a, i) => !a.startsWith('--') && !(argv[i - 1] || '').startsWith('--'));
  if (!input || argv.includes('-h') || argv.includes('--help')) { usage(); process.exit(input ? 0 : 2); }

  const isDir = fs.statSync(input).isDirectory();
  const model = get('--upscale', null);
  const fps = get('--fps', null);
  const all = get('--device', 'auto');
  const dev = all, encAll = all;
  const opts = {
    kind: isDir ? 'frames' : 'video', input: path.resolve(input), srcFps: Number(get('--src-fps', 25)),
    upscale: model ? { model, scale: Number(get('--scale', 2)) } : null,
    targetFps: fps ? Number(fps) : null, engine: get('--engine', 'rife'),
    tta: { upscale: argv.includes('--upscale-tta'), interpolate: argv.includes('--interp-tta') },
    devices: { upscale: get('--upscale-device', dev), interpolate: get('--interp-device', dev), encode: get('--encoder', encAll) },
    outDir: path.resolve(get('--out', path.dirname(path.resolve(input)))), workRoot: get('--temp', os.tmpdir()),
  };

  let p;
  try { p = new Pipeline(opts, tools); } catch (e) { console.error(e.message); process.exit(2); }
  let last = '';
  p.on('progress', (s) => {
    const line = `[${s.index + 1}/${s.stages.length}] ${s.stageName}  ${s.stagePct}%  ${s.done}/${s.total} ${s.unit}  overall ${s.overallPct}%  ` +
      `${s.rate ? s.rate.toFixed(1) + '/s' : '--'}  ETA ${s.eta != null ? U.fmtTime(s.eta) : '--'}`;
    if (line !== last) { process.stdout.write(`\r${line}   `); last = line; }
  });
  p.on('log', (l) => { if (process.env.FRAMEUP_VERBOSE) console.error(`\n${l}`); });
  process.on('SIGINT', () => p.cancel());
  try {
    const r = await p.run();
    console.log(`\nDone: ${r.output}\n${r.frames ?? '?'} frames, ${r.width}x${r.height}, ${r.fps} fps, ${U.fmtTime(r.elapsed)}`);
  } catch (e) {
    console.error(`\n${e.message}`);
    process.exit(1);
  }
}
main();
