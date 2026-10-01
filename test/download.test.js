'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { download, gunzip, unzip } = require('../src/download');
const { findFile } = require('../src/tools');

function serve(routes) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const r = routes[req.url];
      if (!r) { res.writeHead(404); return res.end(); }
      if (r.redirect) { res.writeHead(302, { Location: r.redirect }); return res.end(); }
      res.writeHead(200, { 'Content-Length': r.body.length });
      res.end(r.body);
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('download follows redirects, reports progress and leaves no .part file', async () => {
  const body = Buffer.alloc(300_000, 7);
  const srv = await serve({ '/a': { redirect: '/b' }, '/b': { body } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-dl-'));
  try {
    const seen = [];
    const dest = path.join(dir, 'x', 'file.bin');
    await download(`http://127.0.0.1:${srv.address().port}/a`, dest, { onProgress: (d, t) => seen.push([d, t]) });
    assert.equal(fs.statSync(dest).size, body.length);
    assert.ok(!fs.existsSync(dest + '.part'));
    assert.deepEqual(seen.at(-1), [body.length, body.length]);
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('download rejects on HTTP errors', async () => {
  const srv = await serve({});
  try {
    await assert.rejects(download(`http://127.0.0.1:${srv.address().port}/missing`, path.join(os.tmpdir(), 'fu-never')), /404/);
  } finally { srv.close(); }
});

test('gunzip restores the original bytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-gz-'));
  try {
    const src = path.join(dir, 'a.gz'), out = path.join(dir, 'a');
    fs.writeFileSync(src, zlib.gzipSync(Buffer.from('hello frameup')));
    await gunzip(src, out);
    assert.equal(fs.readFileSync(out, 'utf8'), 'hello frameup');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unzip extracts nested files and findFile locates them', async (t) => {
  let hasZip = true;
  try { execFileSync('zip', ['-v'], { stdio: 'ignore' }); } catch { hasZip = false; }
  if (!hasZip) return t.skip('zip not installed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-zip-'));
  try {
    fs.mkdirSync(path.join(dir, 'src', 'app', 'resources', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'app', 'resources', 'bin', 'upscayl-bin'), '#!/bin/sh\n');
    execFileSync('zip', ['-qr', path.join(dir, 'a.zip'), 'app'], { cwd: path.join(dir, 'src') });
    await unzip(path.join(dir, 'a.zip'), path.join(dir, 'out'));
    const found = findFile(path.join(dir, 'out'), 'upscayl-bin', 6);
    assert.ok(found && found.endsWith(path.join('resources', 'bin', 'upscayl-bin')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
