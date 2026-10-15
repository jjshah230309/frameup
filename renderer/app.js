'use strict';
const api = window.frameup;
const $ = (id) => document.getElementById(id);
document.body.classList.add(api.platform);

// Upscayl models that ship with the app; shown before Upscayl is installed.
const DEFAULT_MODELS = ['upscayl-standard-4x', 'upscayl-lite-4x', 'high-fidelity-4x', 'remacri-4x', 'ultramix-balanced-4x', 'ultrasharp-4x', 'digital-art-4x'];

const S = {
  source: null,          // { kind, path, name, width, height, fps, frames, duration, sample }
  tools: null,
  settings: {},
  outDir: null,
  workRoot: null,
  upOn: true, upScale: 2, upModel: 'upscayl-standard-4x',
  fpsMode: '60', customFps: 48, engine: 'rife',
  devices: { upscale: 'auto', interpolate: 'auto', encode: 'auto' },
  tta: { upscale: false, interpolate: false },
  awake: 'system', awakeLid: false,
  theme: document.documentElement.dataset.theme || 'dark',
  running: false,
};

// ---------- helpers ----------
const fmtN = (n) => Number(n).toLocaleString();
const fmtGB = (b) => (b / 1073741824).toFixed(1) + ' GB';
const fmtTime = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(x).padStart(2, '0')}s`; };
const isWhole = (n) => Math.abs(n - Math.round(n)) < 1e-3;
const dirname = (p) => { const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i > 0 ? p.slice(0, i) : p; };
const show = (id, on = true) => $(id).classList.toggle('hidden', !on);
const view = (name) => ['setup', 'run', 'done'].forEach((v) => show(`view-${v}`, v === name));
function seg(id, value) { document.querySelectorAll(`#${id} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === String(value))); }

function srcFps() {
  if (!S.source) return null;
  return S.source.kind === 'video' ? S.source.fps : Number($('srcFps').value);
}
function targetFps() {
  if (S.fpsMode === 'keep') return null;
  return S.fpsMode === 'custom' ? Number($('customFps').value) : Number(S.fpsMode);
}
function outSize() {
  if (!S.source || !S.source.width) return null;
  const k = S.upOn ? S.upScale : 1;
  return { w: S.source.width * k, h: S.source.height * k };
}

// ---------- tools ----------
async function refreshTools() {
  S.tools = await api.toolsStatus();
  const t = S.tools;
  const missing = ['ffmpeg', 'rife', 'upscayl'].filter((k) => !t[k].found);
  $('toolsDot').className = 'dot ' + (missing.length ? 'warn' : 'ok');
  $('toolsLabel').textContent = missing.length ? `Tools · ${missing.length} to download` : 'Tools ready';

  const models = t.upscayl.found ? t.upscayl.models : DEFAULT_MODELS;
  const sel = $('upModel');
  sel.innerHTML = '';
  for (const m of models) { const o = document.createElement('option'); o.value = m; o.textContent = m; sel.appendChild(o); }
  if (!models.includes(S.upModel)) S.upModel = models.includes('upscayl-standard-4x') ? 'upscayl-standard-4x' : models[0];
  sel.value = S.upModel;
  $('upHint').textContent = t.upscayl.found
    ? `Using Upscayl found at ${t.upscayl.bin.replace(/[\\/]bin[\\/].*$/, '')}`
    : 'Upscayl is not installed. It will be downloaded automatically (about 300–400 MB) when you start.';

  const apple = $('appleBtn');
  apple.disabled = !t.apple.supported;
  apple.title = t.apple.supported ? '' : 'Apple ML is only available on macOS.';
  if (!t.apple.supported && S.engine === 'apple') S.engine = 'rife';
  seg('engine', S.engine);
  renderToolsDialog();
  update();
}

function renderToolsDialog() {
  const t = S.tools; if (!t) return;
  const rows = [
    ['ffmpeg', 'ffmpeg + ffprobe', 'Reads and writes video.', t.ffmpeg],
    ['upscayl', 'Upscayl', 'AI upscaling (uses your installed Upscayl if found).', t.upscayl],
    ['rife', 'RIFE', 'AI frame interpolation (Vulkan GPU).', t.rife],
  ];
  if (t.apple.supported) rows.push(['apple', 'Apple ML helper', 'Fast on-device interpolation (macOS 15.4+).', { found: t.apple.ready, source: 'built on first use', bin: t.apple.bin }]);
  $('toolsList').innerHTML = '';
  for (const [key, title, desc, info] of rows) {
    const d = document.createElement('div'); d.className = 'tool';
    const where = info.found ? (info.bin || info.ffmpeg || info.source || 'ready') : desc;
    d.innerHTML = `<div class="info"><div class="t"></div><div class="d"></div><div class="mini hidden"><div></div></div></div><div class="st"></div><button class="btn small"></button>`;
    d.querySelector('.t').textContent = title;
    d.querySelector('.d').textContent = where;
    const st = d.querySelector('.st'); st.textContent = info.found ? 'Ready' : 'Not installed'; st.classList.add(info.found ? 'ok' : 'miss');
    const btn = d.querySelector('button');
    btn.textContent = info.found ? (info.source === 'downloaded' ? 'Reinstall' : 'OK') : 'Download';
    btn.disabled = info.found && info.source !== 'downloaded';
    btn.addEventListener('click', () => installTool(key, d, btn));
    d.dataset.key = key;
    $('toolsList').appendChild(d);
  }
}

async function installTool(key, row, btn) {
  btn.disabled = true; btn.textContent = 'Working…';
  const mini = row.querySelector('.mini'); mini.classList.remove('hidden');
  const off = api.onToolsProgress((p) => {
    if (p.name !== key) return;
    mini.firstElementChild.style.width = (p.total ? Math.min(100, (p.done / p.total) * 100) : 30) + '%';
    row.querySelector('.d').textContent = `${(p.done / 1048576).toFixed(0)}${p.total ? ' / ' + (p.total / 1048576).toFixed(0) : ''} MB`;
  });
  try { await api.installTool(key); } catch (e) { row.querySelector('.d').textContent = `Failed: ${e.message}`; }
  off();
  await refreshTools();
}

// ---------- source ----------
async function setSource(p) {
  try {
    const info = await api.probe(p);
    S.source = info;
    if (info.kind === 'frames') {
      try { const sz = await api.framesSize(info.sample); if (sz) Object.assign(S.source, sz); } catch { /* optional */ }
    }
    S.outDir = dirname(p);
    $('dropTitle').textContent = 'Source selected'; $('dropSub').textContent = 'Drop another to replace it';
    const chips = [];
    if (info.kind === 'video') {
      chips.push('Video');
      if (info.width) chips.push(`${info.width}×${info.height}`, `${(+info.fps.toFixed(3))} fps`, `${fmtN(info.frames)} frames`, fmtTime(info.duration));
      else chips.push('install ffmpeg to read details');
    } else {
      chips.push('Frames folder', `${fmtN(info.frames)} images`);
      if (info.width) chips.push(`${info.width}×${info.height}`);
    }
    $('srcName').textContent = info.name;
    $('srcChips').innerHTML = chips.map((c) => `<span class="chip">${c}</span>`).join('');
    show('srcInfo'); show('srcFpsRow', info.kind === 'frames');
    update();
  } catch (e) {
    flashWarn(e.message || String(e));
  }
}
function flashWarn(msg) { const w = $('warn'); w.textContent = msg; w.classList.remove('hidden'); setTimeout(() => update(), 4000); }

const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) setSource(api.pathFor(f)); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
$('pickVideo').addEventListener('click', async () => { const p = await api.chooseVideo(); if (p) setSource(p); });
$('pickFolder').addEventListener('click', async () => { const p = await api.chooseFolder('Choose the folder of frames'); if (p) setSource(p); });
$('pickOut').addEventListener('click', async () => { const p = await api.chooseFolder('Save the video to…'); if (p) { S.outDir = p; update(); } });
$('pickTmp').addEventListener('click', async () => {
  const p = await api.chooseFolder('Temporary folder for frames');
  if (p) { S.workRoot = p; await api.settings.set({ workRoot: p }); update(); }
});

// ---------- option wiring ----------
$('upOn').addEventListener('change', () => { S.upOn = $('upOn').checked; update(); });
$('upModel').addEventListener('change', () => { S.upModel = $('upModel').value; update(); });
document.querySelectorAll('#upScale button').forEach((b) => b.addEventListener('click', () => { S.upScale = Number(b.dataset.v); seg('upScale', S.upScale); update(); }));
document.querySelectorAll('#fpsMode button').forEach((b) => b.addEventListener('click', () => { S.fpsMode = b.dataset.v; seg('fpsMode', S.fpsMode); update(); }));
document.querySelectorAll('#engine button').forEach((b) => b.addEventListener('click', () => { if (!b.disabled) { S.engine = b.dataset.v; seg('engine', S.engine); update(); } }));
['srcFps', 'customFps'].forEach((id) => $(id).addEventListener('input', update));
document.querySelectorAll('.credits a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); api.openExternal(a.href); }));
$('toolsBtn').addEventListener('click', () => { renderToolsDialog(); $('toolsDlg').showModal(); });
$('toolsClose').addEventListener('click', () => $('toolsDlg').close());

// ---------- processing devices ----------
const DEV_IDS = { upscale: 'devUp', interpolate: 'devInterp', encode: 'devEnc' };
function devPresetOf(d) {
  if (d.upscale === 'auto' && d.interpolate === 'auto' && d.encode === 'auto') return 'auto';
  if (d.upscale === 'gpu' && d.interpolate === 'gpu' && d.encode === 'gpu') return 'gpu';
  if (d.upscale === 'cpu' && d.interpolate === 'cpu' && d.encode === 'cpu') return 'cpu';
  return 'custom';
}
function renderDevices() {
  for (const k in DEV_IDS) $(DEV_IDS[k]).value = S.devices[k];
  $('devPreset').value = devPresetOf(S.devices);
  const apple = S.engine === 'apple';
  $('devInterp').disabled = apple; $('ttaInterp').disabled = apple;
  $('ttaUp').checked = S.tta.upscale; $('ttaInterp').checked = S.tta.interpolate;
  show('rifeOpts', !apple);
  const note = (id, text) => { $(id).textContent = text || ''; show(id, !!text); };
  note('devUpNote', S.devices.upscale === 'cpu' ? 'CPU upscaling can be many times slower than a GPU.' : '');
  note('devInterpNote', S.devices.interpolate === 'cpu' ? 'CPU interpolation can be many times slower than a GPU.' : '');
  note('devEncNote', S.devices.encode === 'cpu' ? 'The CPU encoder is slower, and falls back to 8-bit H.264 if x265 is missing.' : S.devices.encode === 'gpu' ? 'If no GPU hardware encoder works on this computer, the run stops with an error.' : '');
  const cpu = Object.values(S.devices).includes('cpu');
  $('devHint').textContent = (S.engine === 'apple' ? 'Apple ML picks its own hardware, so the Interpolate setting only applies to RIFE. ' : '')
    + (S.devices.upscale === 'cpu' || S.devices.interpolate === 'cpu' ? 'CPU upscaling and RIFE can be many times slower than a GPU. ' : '')
    + (S.devices.encode === 'cpu' ? 'The CPU encoder is slower and may fall back to 8-bit H.264 if x265 is missing. ' : '')
    + (cpu ? '' : 'Applies to the next run.');
}
async function setDevices(d) { S.devices = d; await api.settings.set({ devices: d }); renderDevices(); }
$('devPreset').addEventListener('change', () => {
  const v = $('devPreset').value;
  if (v === 'custom') return;
  setDevices({ upscale: v, interpolate: v, encode: v });
});
async function setTta(k, on) { S.tta = { ...S.tta, [k]: on }; await api.settings.set({ tta: S.tta }); renderDevices(); }
$('ttaUp').addEventListener('change', () => setTta('upscale', $('ttaUp').checked));
$('ttaInterp').addEventListener('change', () => setTta('interpolate', $('ttaInterp').checked));
for (const k in DEV_IDS) $(DEV_IDS[k]).addEventListener('change', () => setDevices({ ...S.devices, [k]: $(DEV_IDS[k]).value }));

// ---------- settings (appearance) ----------
const isMac = api.platform === 'darwin';
function applyTheme(t) {
  S.theme = t;
  document.documentElement.dataset.theme = t;
  seg('themeSeg', t);
}
function openSettings() { if (!$('settingsDlg').open) $('settingsDlg').showModal(); }
document.querySelectorAll('#themeSeg button').forEach((b) => b.addEventListener('click', async () => {
  applyTheme(b.dataset.v);
  await api.settings.set({ theme: b.dataset.v });
  await api.setTheme(b.dataset.v);
}));
$('settingsBtn').addEventListener('click', openSettings);
$('settingsClose').addEventListener('click', () => $('settingsDlg').close());
$('settingsKeys').textContent = isMac ? '⌘,' : 'Ctrl+,';
api.onOpenSettings(openSettings);                       // macOS menu: Settings… (Cmd+,)
window.addEventListener('keydown', (e) => {             // Windows / Linux (and a fallback on macOS)
  if (e.key === ',' && (isMac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey) { e.preventDefault(); openSettings(); }
});
applyTheme(S.theme);

// keep-awake while working
const AWAKE_HINT = {
  darwin: 'Uses caffeinate. Lid-closed mode runs “pmset disablesleep” as an administrator (macOS asks for your password when a run starts) and turns normal sleep back on when the run ends.',
  win32: 'Uses a Windows power request. Lid-closed mode sets “closing the lid” to do nothing while a run is going, then restores your setting.',
  linux: 'Uses systemd-inhibit. Lid-closed mode also blocks the lid switch from suspending the computer.',
};
function renderAwake() {
  $('awakeMode').value = S.awake;
  $('awakeLid').checked = S.awakeLid;
  $('awakeHint').textContent = (AWAKE_HINT[api.platform] || '') + (S.awakeLid ? ' Don’t put the laptop in a bag while this is on: it can get hot.' : '');
}
async function setAwake(patch) { Object.assign(S, patch); await api.settings.set({ awake: S.awake, awakeLid: S.awakeLid }); renderAwake(); }
$('awakeMode').addEventListener('change', () => setAwake({ awake: $('awakeMode').value }));
$('awakeLid').addEventListener('change', () => setAwake({ awakeLid: $('awakeLid').checked }));
$('awakeRestore').addEventListener('click', async () => { if (await api.awakeRestore()) show('awakeLeftover', false); });
api.onAwakeLeftover(() => { show('awakeLeftover'); openSettings(); });
renderAwake();

// ---------- derived UI ----------
let freeCache = {};
async function freeSpace(dir) {
  if (!dir) return null;
  if (!(dir in freeCache)) { freeCache[dir] = null; freeCache[dir] = await api.freeSpace(dir); setTimeout(() => { delete freeCache[dir]; }, 5000); update(); }
  return freeCache[dir];
}

function validate() {
  const issues = [];
  if (!S.source) return ['Choose a video or a folder of frames to begin.'];
  const sf = srcFps(), tf = targetFps();
  if (!(sf > 0)) issues.push('Enter the frame rate of your frames.');
  if (!S.upOn && tf === null) issues.push('Nothing to do: turn on upscaling or pick a higher frame rate.');
  if (tf !== null) {
    if (!(tf > 0)) issues.push('Enter a target frame rate.');
    else if (sf > 0 && tf <= sf + 1e-6) issues.push(`Target (${tf} fps) must be higher than the source (${+sf.toFixed(3)} fps) — or choose “Keep original”.`);
    if (S.engine === 'apple' && sf > 0 && tf > 0 && !(isWhole(sf) && isWhole(tf))) issues.push('Apple ML needs whole-number frame rates. Choose RIFE for fractional rates like 23.976.');
  }
  return issues;
}

function update() {
  $('cardUpscale').classList.toggle('off', !S.upOn);
  $('upOn').checked = S.upOn;
  show('customRow', S.fpsMode === 'custom');
  show('engineBox', S.fpsMode !== 'keep');
  $('engineHint').textContent = S.engine === 'apple'
    ? 'Apple ML: on-device, much faster, no big temporary files. Whole-number frame rates only (macOS 15.4+, Apple silicon).'
    : 'RIFE: AI interpolation on your GPU (Vulkan). Best quality on any system, but slower and it writes every output frame to the temp folder first.';
  renderDevices();
  $('outPath').textContent = S.outDir || '—';
  $('tmpPath').textContent = S.workRoot || S.settings.defaultTemp || '—';

  // summary
  const sf = srcFps(), tf = targetFps(), sz = outSize();
  const sum = $('summary');
  if (S.source && sz && sf > 0) {
    const outFps = tf || sf;
    const outFrames = S.source.frames ? Math.round((S.source.frames * outFps) / sf) : null;
    sum.innerHTML = `<b>${S.source.width}×${S.source.height}</b> → <b>${sz.w}×${sz.h}</b> · <b>${+sf.toFixed(3)}</b> → <b>${+outFps.toFixed(3)} fps</b>` + (outFrames ? ` · ${fmtN(outFrames)} frames` : '');
    show('summary');
  } else show('summary', false);

  // disk hint for RIFE
  const tmp = $('tmpHint'); tmp.textContent = '';
  const work = S.workRoot || S.settings.defaultTemp;
  freeSpace(work).then((free) => { if (free != null) tmp.textContent = `${fmtGB(free)} free here.`; });
  if (S.engine === 'rife' && tf && sz && S.source && S.source.frames) {
    const per = sz.w * sz.h * 0.7;
    const need = per * Math.round((S.source.frames * tf) / sf) * 1.1;
    const free = freeCache[work];
    tmp.textContent += ` RIFE needs about ${fmtGB(need)}.`;
    tmp.style.color = free != null && need > free ? 'var(--warn)' : '';
  }

  const issues = validate();
  const w = $('warn');
  if (issues.length) { w.textContent = issues[0]; w.classList.remove('hidden'); } else w.classList.add('hidden');
  $('start').disabled = issues.length > 0 || S.running;
}

// ---------- run ----------
function buildStepper(stages) {
  $('stepper').innerHTML = stages.map((s) => `<li class="${s.state}" data-id="${s.id}"><span class="mk">${s.state === 'done' ? '✓' : ''}</span>${s.name}</li>`).join('');
}
const unitLabel = (u) => (u === 'frames' ? 'frames' : u === '%' ? '' : u);

function onProgress(p) {
  $('runStage').textContent = `Stage ${p.index + 1} of ${p.stages.length} · ${p.stageName}`;
  $('runNote').textContent = p.note || '';
  $('stageFill').style.width = p.stagePct + '%';
  $('allFill').style.width = p.overallPct + '%';
  if (p.unit === '%') {
    $('statDone').textContent = `${p.stagePct}%`; $('statQueued').textContent = ''; $('statRate').textContent = ''; $('statEta').textContent = '';
  } else {
    $('statDone').textContent = `${fmtN(p.done)} / ${fmtN(p.total)} ${unitLabel(p.unit)}`;
    $('statQueued').textContent = `${fmtN(p.queued)} queued`;
    $('statRate').textContent = p.rate ? `${p.rate.toFixed(1)} fps` : '— fps';
    $('statEta').textContent = p.eta != null ? `ETA ${fmtTime(p.eta)}` : 'ETA —';
  }
  $('allPct').textContent = `${p.overallPct}% overall`;
  $('allElapsed').textContent = `Elapsed ${fmtTime(p.elapsed)}`;
  buildStepper(p.stages);
  document.title = `${p.overallPct}% · FrameUp`;
}
function onLog(line) { const l = $('log'); l.textContent += line + '\n'; l.scrollTop = l.scrollHeight; }

function showDone(r) {
  $('doneIcon').className = 'done-icon ok'; $('doneIcon').textContent = '✓';
  $('doneTitle').textContent = 'All done';
  $('doneText').textContent = `${r.frames ? fmtN(r.frames) + ' frames · ' : ''}${r.width}×${r.height} · ${+Number(r.fps).toFixed(3)} fps · took ${fmtTime(r.elapsed)}`;
  $('donePath').textContent = r.output; $('donePath').dataset.p = r.output;
  show('doneReveal'); show('doneOpen'); show('doneLog', false);
  document.title = 'FrameUp'; view('done');
}
function showFailed({ message, cancelled }) {
  $('doneIcon').className = 'done-icon ' + (cancelled ? 'stop' : 'bad'); $('doneIcon').textContent = cancelled ? '■' : '!';
  $('doneTitle').textContent = cancelled ? 'Cancelled' : 'Something went wrong';
  $('doneText').textContent = cancelled ? 'Nothing was saved and temporary files were removed.' : 'Temporary files were removed.';
  $('donePath').textContent = '';
  show('doneReveal', false); show('doneOpen', false);
  if (!cancelled) { $('doneLog').textContent = message; show('doneLog'); } else show('doneLog', false);
  document.title = 'FrameUp'; view('done');
}

api.onProgress(onProgress);
api.onLog(onLog);
api.onDone((r) => { S.running = false; showDone(r); });
api.onFailed((f) => { S.running = false; showFailed(f); });

$('start').addEventListener('click', async () => {
  if (validate().length) return;
  const tf = targetFps();
  const opts = {
    kind: S.source.kind, input: S.source.path, srcFps: srcFps(),
    upscale: S.upOn ? { model: S.upModel, scale: S.upScale } : null,
    targetFps: tf, engine: S.engine, devices: { ...S.devices }, tta: { upscale: S.upOn && S.tta.upscale, interpolate: S.tta.interpolate }, outDir: S.outDir, workRoot: S.workRoot || undefined,
  };
  S.running = true;
  $('log').textContent = ''; show('log', false); $('logToggle').textContent = 'Show details';
  $('cancel').textContent = 'Cancel'; $('cancel').classList.remove('confirm');
  $('runStage').textContent = 'Starting…'; $('runNote').textContent = ''; $('stepper').innerHTML = '';
  $('stageFill').style.width = '0%'; $('allFill').style.width = '0%';
  view('run');
  api.run(opts).then(() => refreshTools());
});
$('logToggle').addEventListener('click', () => { const hidden = $('log').classList.toggle('hidden'); $('logToggle').textContent = hidden ? 'Show details' : 'Hide details'; });
let cancelTimer = null;
$('cancel').addEventListener('click', () => {
  const b = $('cancel');
  if (!b.classList.contains('confirm')) {
    b.classList.add('confirm'); b.textContent = 'Click again to cancel';
    cancelTimer = setTimeout(() => { b.classList.remove('confirm'); b.textContent = 'Cancel'; }, 3000);
  } else { clearTimeout(cancelTimer); b.textContent = 'Cancelling…'; b.disabled = true; api.cancel(); setTimeout(() => { b.disabled = false; }, 1500); }
});
$('doneReveal').addEventListener('click', () => api.reveal($('donePath').dataset.p));
$('doneOpen').addEventListener('click', () => api.open($('donePath').dataset.p));
$('doneAgain').addEventListener('click', () => { view('setup'); update(); });

// ---------- boot ----------
(async function init() {
  S.settings = await api.settings.get();
  S.workRoot = S.settings.workRoot || null;
  S.devices = { ...S.devices, ...(S.settings.devices || {}) };
  S.tta = { ...S.tta, ...(S.settings.tta || {}) };
  if (['off', 'system', 'display'].includes(S.settings.awake)) S.awake = S.settings.awake;
  S.awakeLid = !!S.settings.awakeLid;
  renderAwake();
  if ((await api.awakeStatus()).macNeedsRestore) show('awakeLeftover');
  await refreshTools();
  update();
  window.__frameup = { S, onProgress, showDone, showFailed, setSource, update, view }; // used by screenshot script
})();
