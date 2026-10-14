'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Tools, encoderCandidates, which } = require('../src/tools');

const mk = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-tools-'));
  return { dir, tools: new Tools({ dataDir: dir, resourcesDir: path.join(dir, 'res') }) };
};

test('encoder candidates always end with a software fallback', () => {
  const c = encoderCandidates();
  assert.ok(c.length >= 3);
  assert.equal(c.at(-1).name, 'libx264');
  assert.ok(c.some((e) => e.name === 'libx265'));
  const args = c[0].args(80_000_000);
  assert.ok(args.includes('-c:v'));
});

test('Upscayl in a custom location is detected and its models listed', () => {
  const { dir, tools } = mk();
  try {
    const res = path.join(dir, 'Upscayl', 'resources');
    fs.mkdirSync(path.join(res, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(res, 'models'), { recursive: true });
    fs.writeFileSync(path.join(res, 'bin', process.platform === 'win32' ? 'upscayl-bin.exe' : 'upscayl-bin'), '');
    for (const m of ['b-4x', 'a-4x']) { fs.writeFileSync(path.join(res, 'models', `${m}.param`), ''); fs.writeFileSync(path.join(res, 'models', `${m}.bin`), ''); }
    process.env.FRAMEUP_UPSCAYL_DIR = res;
    const up = tools.upscayl();
    assert.ok(up);
    assert.deepEqual(up.models, ['a-4x', 'b-4x']);
  } finally { delete process.env.FRAMEUP_UPSCAYL_DIR; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('missing tools report as not found', () => {
  const { dir, tools } = mk();
  const keep = process.env.FRAMEUP_RIFE_DIR;
  try {
    delete process.env.FRAMEUP_RIFE_DIR;
    assert.equal(tools.rife(), null);
  } finally { if (keep) process.env.FRAMEUP_RIFE_DIR = keep; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Apple ML is reported unsupported off macOS', async () => {
  const { dir, tools } = mk();
  try {
    const a = await tools.apple();
    assert.equal(a.supported, process.platform === 'darwin');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pickEncoder finds a working encoder with a real ffmpeg', async (t) => {
  const ff = which(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (!ff) return t.skip('ffmpeg not on PATH');
  const { dir, tools } = mk();
  try {
    const enc = await tools.pickEncoder(ff);
    assert.ok(enc.name && typeof enc.args === 'function');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('encoder modes partition hardware and software candidates', () => {
  const c = encoderCandidates();
  assert.ok(c.filter((e) => e.hardware).length >= 1);
  assert.ok(c.filter((e) => !e.hardware).every((e) => e.name.startsWith('libx26')));
});

test('pickEncoder honours cpu mode with a real ffmpeg', async (t) => {
  const ff = which(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (!ff) return t.skip('ffmpeg not on PATH');
  const { dir, tools } = mk();
  try {
    const enc = await tools.pickEncoder(ff, 'cpu');
    assert.equal(enc.hardware, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
