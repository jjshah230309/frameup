'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');
const extract = require('extract-zip');
const { isMac } = require('./platform');

async function download(url, dest, { onProgress, signal } = {}) {
  const res = await fetch(url, { signal, redirect: 'follow', headers: { 'User-Agent': 'FrameUp' } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  let done = 0;
  const src = Readable.fromWeb(res.body);
  src.on('data', (c) => { done += c.length; if (onProgress) onProgress(done, total); });
  await pipeline(src, fs.createWriteStream(tmp));
  await fsp.rename(tmp, dest);
  return dest;
}

async function gunzip(src, dest) {
  await pipeline(fs.createReadStream(src), zlib.createGunzip(), fs.createWriteStream(dest));
}

// macOS: ditto keeps symlinks/permissions inside .app bundles; elsewhere extract-zip.
async function unzip(zip, dir) {
  await fsp.mkdir(dir, { recursive: true });
  if (isMac) {
    await new Promise((res, rej) => execFile('ditto', ['-x', '-k', zip, dir], (e) => (e ? rej(e) : res())));
  } else {
    await extract(zip, { dir: path.resolve(dir) });
  }
}

module.exports = { download, gunzip, unzip };
