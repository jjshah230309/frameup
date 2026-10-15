#!/usr/bin/env node
'use strict';
// Headless FrameUp:  node src/cli.js <video|frames-folder> [options]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Tools } = require('./tools');
const { Pipeline } = require('./pipeline');
const U = require('./util');
const { Awake } = require('./awake');

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
  --keep-awake [m]      keep the computer awake while working: system | display | off  [default: off]
  --screen-off          turn the screen off a few seconds after the run starts (the job keeps running)
  --stay-awake-lid      also stay awake with the lid closed (asks for admin rights on macOS)
  --device <d>          shortcut: gpu or cpu for all three stages above
  --list-models         Show installed Upscayl models and exit`);
}

// Flags that take a value; everything else starting with -- is a switch, so the next argument can still be the input.
const VALUE_FLAGS = new Set(['--upscale', '--scale', '--fps', '--engine', '--src-fps', '--out', '--temp', '--upscale-device', '--interp-device', '--encoder', '--device']);
function findInput(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('-')) return a;
    if (VALUE_FLAGS.has(a)) i++;
    else if (a === '--keep-awake' && ['system', 'display', 'off'].includes(argv[i + 1])) i++;
  }
  return undefined;
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
  const input = findInput(argv);
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
  const ka = argv.indexOf('--keep-awake');
  const awakeMode = ka < 0 ? 'off' : (['system', 'display', 'off'].includes(argv[ka + 1]) ? argv[ka + 1] : 'system');
  const awake = new Awake({ dataDir, log: (l) => { if (process.env.FRAMEUP_VERBOSE) console.error(`\n${l}`); } });
  try {
    for (const w of await awake.start({ mode: awakeMode, lid: argv.includes('--stay-awake-lid') })) console.error(`Warning: ${w}`);
    let screenTimer = null;
    if (argv.includes('--screen-off') && awakeMode !== 'display') screenTimer = setTimeout(() => awake.displayOff().then((w) => w && console.error(`Warning: ${w}`)).catch(() => {}), 5000);
    let r;
    try { r = await p.run(); } finally { clearTimeout(screenTimer); }
    console.log(`\nDone: ${r.output}\n${r.frames ?? '?'} frames, ${r.width}x${r.height}, ${r.fps} fps, ${U.fmtTime(r.elapsed)}`);
  } catch (e) {
    console.error(`\n${e.message}`);
    await awake.stop();
    process.exit(1);
  }
  await awake.stop();
}
main();
