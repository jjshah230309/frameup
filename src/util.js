'use strict';
const fs = require('fs');
const path = require('path');

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const naturalSort = (a, b) => collator.compare(a, b);

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(s).padStart(2, '0')}s`;
}

// "25/1", "30000/1001" or "23.976" -> number
function parseFps(v) {
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (s.includes('/')) { const [a, b] = s.split('/').map(Number); return b ? a / b : NaN; }
  return Number(s);
}

const isWhole = (n) => Math.abs(n - Math.round(n)) < 1e-3;
const targetFrames = (n, src, dst) => Math.round((n * dst) / src);

// ~80 Mbps at 4K60, scaled by pixel count and (softly) by frame rate.
function bitrateFor(w, h, fps) {
  const b = 80e6 * ((w * h) / (3840 * 2160)) * Math.pow(fps / 60, 0.6);
  return Math.max(8e6, Math.round(b));
}

// Stage plan. `opts`: { kind, upscale, interpolate, engine, needTools }
function planStages(opts) {
  const stages = [];
  if (opts.needTools) stages.push({ id: 'tools', name: 'Get tools', weight: 6, unit: '%' });
  stages.push(opts.kind === 'video'
    ? { id: 'extract', name: 'Extract', weight: 5, unit: 'frames' }
    : { id: 'load', name: 'Load', weight: 2, unit: 'frames' });
  if (opts.upscale) stages.push({ id: 'upscale', name: 'Upscale', weight: 45, unit: 'frames' });
  if (opts.interpolate && opts.engine === 'apple') {
    stages.push({ id: 'interpolate', name: 'Interpolate + Encode', weight: 40, unit: 'frames' });
  } else {
    if (opts.interpolate) stages.push({ id: 'interpolate', name: 'Interpolate', weight: 40, unit: 'frames' });
    stages.push({ id: 'encode', name: 'Encode', weight: 10, unit: 'frames' });
  }
  return stages;
}

function overallPercent(stages, idx, frac) {
  const total = stages.reduce((a, s) => a + s.weight, 0);
  const before = stages.slice(0, idx).reduce((a, s) => a + s.weight, 0);
  return Math.min(100, Math.round(((before + stages[idx].weight * Math.min(1, Math.max(0, frac))) * 100) / total));
}

function outputBaseName({ name, upscale, interpolate, engine, fps }) {
  let s = name;
  if (upscale) s += ` Upscayl ${upscale.scale}x`;
  if (interpolate) s += ` ${engine === 'apple' ? 'Apple ML' : 'RIFE'} ${fps}fps`;
  else s += ` ${fps}fps`;
  return s;
}

function uniquePath(dir, base, ext) {
  let p = path.join(dir, base + ext), n = 2;
  while (fs.existsSync(p)) p = path.join(dir, `${base} (${n++})${ext}`);
  return p;
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const isImage = (f) => IMAGE_EXT.has(path.extname(f).toLowerCase()) && !path.basename(f).startsWith('._');

module.exports = { naturalSort, fmtTime, parseFps, isWhole, targetFrames, bitrateFor, planStages, overallPercent, outputBaseName, uniquePath, isImage };
