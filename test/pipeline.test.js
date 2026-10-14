'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Pipeline } = require('../src/pipeline');
const { which } = require('../src/tools');

test('audio from the source video is copied into the silent output', async (t) => {
  const ffmpeg = which(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const ffprobe = which(process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  if (!ffmpeg || !ffprobe) return t.skip('ffmpeg/ffprobe not on PATH');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-audio-'));
  try {
    const src = path.join(dir, 'src.mp4'), out = path.join(dir, 'out.mp4');
    const ff = (...a) => execFileSync(ffmpeg, ['-v', 'error', '-y', ...a]);
    ff('-f', 'lavfi', '-i', 'testsrc=d=1:s=64x64:r=10', '-f', 'lavfi', '-i', 'sine=d=1', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', src);
    ff('-f', 'lavfi', '-i', 'testsrc=d=1:s=64x64:r=20', '-c:v', 'libx264', '-an', out);
    const p = new Pipeline({}, { ffmpeg: () => ({ ffmpeg, ffprobe }) });
    assert.equal(await p._hasAudio(out), false);
    await p._muxAudio(ffmpeg, src, out);
    assert.equal(await p._hasAudio(out), true);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['out.mp4', 'src.mp4']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a source without audio leaves the output untouched', async (t) => {
  const ffmpeg = which(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const ffprobe = which(process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  if (!ffmpeg || !ffprobe) return t.skip('ffmpeg/ffprobe not on PATH');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-noaudio-'));
  try {
    const f = path.join(dir, 'a.mp4');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=d=1:s=64x64:r=10', '-c:v', 'libx264', f]);
    const before = fs.statSync(f).mtimeMs;
    const p = new Pipeline({}, { ffmpeg: () => ({ ffmpeg, ffprobe }) });
    await p._muxAudio(ffmpeg, f, f);
    assert.equal(fs.statSync(f).mtimeMs, before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
