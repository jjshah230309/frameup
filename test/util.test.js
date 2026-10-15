'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('../src/util');

test('parseFps handles fractions, decimals and numbers', () => {
  assert.equal(U.parseFps('25/1'), 25);
  assert.ok(Math.abs(U.parseFps('30000/1001') - 29.97) < 0.001);
  assert.equal(U.parseFps('23.976'), 23.976);
  assert.equal(U.parseFps(60), 60);
  assert.ok(Number.isNaN(U.parseFps('1/0')));
});

test('naturalSort orders numbered frames numerically', () => {
  const files = ['f10.png', 'f2.png', 'f1.png', 'f100.png'];
  assert.deepEqual(files.sort(U.naturalSort), ['f1.png', 'f2.png', 'f10.png', 'f100.png']);
});

test('targetFrames matches the 25 -> 60 fps ratio', () => {
  assert.equal(U.targetFrames(2940, 25, 60), 7056);
  assert.equal(U.targetFrames(20, 25, 60), 48);
});

test('bitrate scales with resolution and fps and has a floor', () => {
  assert.equal(U.bitrateFor(3840, 2160, 60), 80_000_000);
  assert.ok(U.bitrateFor(3840, 2160, 120) > 100_000_000);
  assert.equal(U.bitrateFor(320, 240, 24), 8_000_000);
});

test('planStages covers every path', () => {
  const ids = (o) => U.planStages(o).map((s) => s.id);
  assert.deepEqual(ids({ kind: 'video', upscale: true, interpolate: true, engine: 'rife' }), ['extract', 'upscale', 'interpolate', 'encode']);
  assert.deepEqual(ids({ kind: 'video', upscale: true, interpolate: true, engine: 'apple' }), ['extract', 'upscale', 'interpolate']);
  assert.deepEqual(ids({ kind: 'frames', upscale: false, interpolate: true, engine: 'rife', needTools: true }), ['tools', 'load', 'interpolate', 'encode']);
  assert.deepEqual(ids({ kind: 'frames', upscale: true, interpolate: false }), ['load', 'upscale', 'encode']);
});

test('overallPercent is weighted and clamped', () => {
  const stages = [{ weight: 10 }, { weight: 30 }, { weight: 60 }];
  assert.equal(U.overallPercent(stages, 0, 0), 0);
  assert.equal(U.overallPercent(stages, 1, 0), 10);
  assert.equal(U.overallPercent(stages, 1, 0.5), 25);
  assert.equal(U.overallPercent(stages, 2, 1), 100);
  assert.equal(U.overallPercent(stages, 2, 5), 100);
});

test('output names describe what was done and never overwrite', () => {
  assert.equal(U.outputBaseName({ name: 'clip', upscale: { scale: 2 }, interpolate: true, engine: 'rife', fps: 60 }), 'clip Upscayl 2x RIFE 60fps');
  assert.equal(U.outputBaseName({ name: 'clip', upscale: null, interpolate: true, engine: 'apple', fps: 120 }), 'clip Apple ML 120fps');
  assert.equal(U.outputBaseName({ name: 'clip', upscale: { scale: 4 }, interpolate: false, fps: 25 }), 'clip Upscayl 4x 25fps');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-test-'));
  try {
    assert.equal(path.basename(U.uniquePath(dir, 'a', '.mp4')), 'a.mp4');
    fs.writeFileSync(path.join(dir, 'a.mp4'), '');
    assert.equal(path.basename(U.uniquePath(dir, 'a', '.mp4')), 'a (2).mp4');
    fs.writeFileSync(path.join(dir, 'a (2).mp4'), '');
    assert.equal(path.basename(U.uniquePath(dir, 'a', '.mp4')), 'a (3).mp4');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('isImage accepts frames and ignores macOS resource forks', () => {
  assert.ok(U.isImage('x/0001.PNG'));
  assert.ok(U.isImage('frame.jpeg'));
  assert.ok(!U.isImage('._0001.png'));
  assert.ok(!U.isImage('notes.txt'));
});

test('device helpers map choices to ncnn flags and validate input', () => {
  const U2 = require('../src/util');
  assert.deepEqual(U2.ncnnDeviceArgs('auto'), []);
  assert.deepEqual(U2.ncnnDeviceArgs(undefined), []);
  assert.deepEqual(U2.ncnnDeviceArgs('gpu'), []);
  assert.deepEqual(U2.ncnnDeviceArgs('CPU'), ['-g', '-1']);
  assert.deepEqual(U2.ncnnDeviceArgs('1'), ['-g', '1']);
  assert.throws(() => U2.normDevice('banana'));
  assert.equal(U2.normEncoderMode('GPU'), 'gpu');
  assert.throws(() => U2.normEncoderMode('1'));
});

test('theme names are validated and default to dark', () => {
  const U2 = require('../src/util');
  assert.equal(U2.normTheme('light'), 'light');
  assert.equal(U2.normTheme('system'), 'system');
  assert.equal(U2.normTheme('dark'), 'dark');
  assert.equal(U2.normTheme(undefined), 'dark');
  assert.equal(U2.normTheme('sepia'), 'dark');
});

test('TTA maps to the -x flag only when enabled', () => {
  const U2 = require('../src/util');
  assert.deepEqual(U2.ttaArgs(true), ['-x']);
  assert.deepEqual(U2.ttaArgs(false), []);
  assert.deepEqual(U2.ttaArgs(undefined), []);
});
