'use strict';
// video / frames -> [Upscayl] -> [RIFE | Apple ML interpolation] -> HEVC video
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');
const P = require('./platform');
const U = require('./util');

const PNG_EXT = '.png';

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (P.isWin) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

async function freeBytes(dir) {
  try { const s = await fsp.statfs(dir); return Number(s.bavail) * Number(s.bsize); } catch { return Infinity; }
}

class Pipeline extends EventEmitter {
  /**
   * opts: {
   *   kind: 'video' | 'frames', input, srcFps (frames only),
   *   upscale: { model, scale } | null,
   *   targetFps: number | null (null/equal => no interpolation), engine: 'rife' | 'apple',
   *   outDir, workRoot,
   *   devices: { upscale, interpolate: 'auto'|'cpu'|'gpu'|<gpu index>, encode: 'auto'|'gpu'|'cpu' } (all optional)
   * }
   */
  constructor(opts, tools) {
    super();
    this.opts = opts;
    const d = opts.devices || {};
    this.dev = { upscale: U.normDevice(d.upscale), interpolate: U.normDevice(d.interpolate), encode: U.normEncoderMode(d.encode) };
    this.tools = tools;
    this.cancelled = false;
    this.child = null;
    this.stages = [];
    this.idx = 0;
    this.t0 = Date.now();
    this.stageT0 = Date.now();
    this.total = 0;
    this.note = '';
    this.work = null;
  }

  log(line) { this.emit('log', line); }

  cancel() {
    this.cancelled = true;
    killTree(this.child);
  }

  _devNote(d) { return d === 'cpu' ? ' · CPU' : /^\d+$/.test(d) ? ` · GPU ${d}` : ''; }

  _check() { if (this.cancelled) throw new Error('Cancelled'); }

  // ---------- progress ----------
  _begin(i, note, total) {
    this._check();
    this.idx = i; this.note = note; this.total = total; this.stageT0 = Date.now();
    this._progress(0);
  }

  _progress(done) {
    const st = this.stages[this.idx];
    const now = Date.now(), el = (now - this.stageT0) / 1000;
    const total = Math.max(this.total, 1);
    done = Math.min(done, total);
    let rate = null, eta = null;
    if (el > 2 && done > 0) { rate = done / el; eta = ((total - done) / done) * el; }
    this.emit('progress', {
      stages: this.stages.map((s, i) => ({ id: s.id, name: s.name, state: i < this.idx ? 'done' : i === this.idx ? (done >= total ? 'done' : 'active') : 'pending' })),
      index: this.idx, stageName: st.name, note: this.note, unit: st.unit,
      done, total, queued: Math.max(0, total - done), rate, eta,
      stagePct: Math.round((done * 100) / total),
      overallPct: U.overallPercent(this.stages, this.idx, done / total),
      elapsed: (now - this.t0) / 1000,
    });
  }

  async _countDir(dir) { try { return (await fsp.readdir(dir)).length; } catch { return 0; } }

  // Poll `counter` while `promise` runs.
  async _watch(promise, counter) {
    const timer = setInterval(async () => { try { this._progress(await counter()); } catch { /* ignore */ } }, 500);
    try { return await promise; } finally { clearInterval(timer); }
  }

  _spawn(cmd, args, { onLine } = {}) {
    return new Promise((resolve, reject) => {
      this._check();
      this.log(`$ ${path.basename(cmd)} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
      const child = spawn(cmd, args, { windowsHide: true, detached: !P.isWin, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      let tail = '';
      const feed = (buf) => {
        const s = buf.toString();
        tail = (tail + s).slice(-3000);
        if (onLine) for (const line of s.split(/\r?\n|\r/)) if (line) onLine(line);
      };
      child.stdout.on('data', feed);
      child.stderr.on('data', feed);
      child.on('error', reject);
      child.on('close', (code) => { this.child = null; resolve({ code, tail }); });
    });
  }

  async _probe(file) {
    const ffprobe = this.tools.ffmpeg().ffprobe;
    const out = await new Promise((resolve, reject) => execFile(ffprobe,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,nb_frames:format=duration', '-of', 'json', file],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, so) => (e ? reject(e) : resolve(so))));
    const j = JSON.parse(out), s = (j.streams || [])[0];
    if (!s) throw new Error('No video stream found.');
    const fps = U.parseFps(s.r_frame_rate);
    const dur = Number(j.format && j.format.duration) || 0;
    const nb = /^\d+$/.test(s.nb_frames || '') ? Number(s.nb_frames) : Math.round(dur * fps);
    return { width: s.width, height: s.height, fps, frames: nb, duration: dur };
  }

  async _needSpace(bytes, what) {
    const free = await freeBytes(this.work);
    if (bytes * 1.05 > free) {
      const gb = (n) => (n / 1073741824).toFixed(1);
      throw new Error(`Not enough disk space for ${what}: needs about ${gb(bytes)} GB in the temp folder, only ${gb(free)} GB free. Choose another temp folder, free some space${this.opts.engine === 'rife' ? ', or use Apple ML' : ''}.`);
    }
  }

  // ---------- run ----------
  async run() {
    const o = this.opts;
    const t = this.tools;
    try {
      const ff = t.ffmpeg();
      const interpolate = !!o.targetFps;
      const needs = [];
      if (!ff) needs.push('ffmpeg');
      if (o.upscale && !t.upscayl()) needs.push('upscayl');
      if (interpolate && o.engine === 'rife' && !t.rife()) needs.push('rife');
      if (interpolate && o.engine === 'apple') { const a = await t.apple(); if (!a.supported) throw new Error(a.reason); if (!a.bin) needs.push('apple'); }

      this.stages = U.planStages({ kind: o.kind, upscale: !!o.upscale, interpolate, engine: o.engine, needTools: needs.length > 0 });
      let si = 0;

      this.work = await fsp.mkdtemp(path.join(o.workRoot || os.tmpdir(), 'frameup-'));
      const IN = path.join(this.work, 'in'), UP = path.join(this.work, 'up'), OUTF = path.join(this.work, 'out');
      await fsp.mkdir(IN, { recursive: true });
      this.log(`Work folder: ${this.work}`);

      // ----- stage: tools -----
      if (needs.length) {
        this._begin(si, `Downloading ${needs.join(', ')}`, 1000);
        for (let k = 0; k < needs.length; k++) {
          this._check();
          const name = needs[k];
          await t.install(name, (d, tot, label) => {
            const frac = (k + (tot ? Math.min(1, d / tot) : 0)) / needs.length;
            this.note = `Downloading ${label || name} (${k + 1}/${needs.length}) · ${(d / 1048576).toFixed(0)}${tot ? ' / ' + (tot / 1048576).toFixed(0) : ''} MB`;
            this._progress(Math.round(frac * 1000));
          });
          this.log(`Installed ${name}`);
        }
        si++;
      }
      const FF = t.ffmpeg();
      if (!FF) throw new Error('ffmpeg is still missing after installation.');

      // ----- stage: extract / load -----
      let srcFps, name, N;
      if (o.kind === 'video') {
        const info = await this._probe(o.input);
        srcFps = info.fps;
        name = path.parse(o.input).name;
        this._begin(si, 'Extracting frames from the video with ffmpeg', info.frames);
        const stats = { frame: 0 };
        const job = this._spawn(FF.ffmpeg, ['-v', 'error', '-nostats', '-progress', 'pipe:1', '-i', o.input, '-fps_mode', 'passthrough',
          '-compression_level', '1', path.join(IN, `%08d${PNG_EXT}`)], { onLine: (l) => { const m = /^frame=(\d+)/.exec(l); if (m) stats.frame = Number(m[1]); } });
        const r = await this._watch(job, async () => stats.frame);
        this._check();
        if (r.code !== 0) throw new Error(`Frame extraction failed:\n${r.tail}`);
      } else {
        srcFps = Number(o.srcFps);
        name = path.basename(o.input);
        const files = (await fsp.readdir(o.input)).filter(U.isImage).sort(U.naturalSort);
        if (files.length < 2) throw new Error('The folder needs at least 2 image frames (png/jpg/webp).');
        this._begin(si, 'Loading frames (copy-on-write where supported)', files.length);
        let i = 0;
        for (const f of files) {
          this._check();
          i++;
          await fsp.copyFile(path.join(o.input, f), path.join(IN, String(i).padStart(8, '0') + path.extname(f).toLowerCase()), fs.constants.COPYFILE_FICLONE);
          if (i % 25 === 0) this._progress(i);
        }
      }
      this._progress(this.total);
      N = await this._countDir(IN);
      if (N < 2) throw new Error(`Need at least 2 frames (found ${N}).`);
      si++;
      let CUR = IN;

      // ----- stage: upscale -----
      if (o.upscale) {
        const up = t.upscayl();
        const first = (await fsp.readdir(IN))[0];
        const fb = (await fsp.stat(path.join(IN, first))).size;
        await this._needSpace(fb * N * o.upscale.scale * o.upscale.scale * 0.8, 'upscaling');
        await fsp.mkdir(UP, { recursive: true });
        const native = (/(\d)x/.exec(o.upscale.model) || [null, '4'])[1];
        this._begin(si, `Upscayl · ${o.upscale.model} · ${o.upscale.scale}x${this._devNote(this.dev.upscale)}`, N);
        const job = this._spawn(up.bin, ['-i', IN, '-o', UP, '-m', up.modelsDir, '-n', o.upscale.model, '-z', native, '-s', String(o.upscale.scale), '-f', 'png', ...U.ncnnDeviceArgs(this.dev.upscale)]);
        const r = await this._watch(job, () => this._countDir(UP));
        this._check();
        if (r.code !== 0) throw new Error(`Upscayl failed:\n${r.tail}`);
        const made = await this._countDir(UP);
        if (made < N) throw new Error(`Upscayl produced ${made} of ${N} frames.\n${r.tail}`);
        this._progress(this.total);
        await fsp.rm(IN, { recursive: true, force: true });
        CUR = UP; si++;
      }

      // ----- frame size / naming / bitrate -----
      const firstName = (await fsp.readdir(CUR)).sort(U.naturalSort)[0];
      const dim = await this._probe(path.join(CUR, firstName));
      const W = dim.width, H = dim.height;
      const fb = (await fsp.stat(path.join(CUR, firstName))).size;
      const outFps = interpolate ? o.targetFps : srcFps;
      const M = interpolate ? U.targetFrames(N, srcFps, outFps) : N;
      const br = U.bitrateFor(W, H, outFps);
      await fsp.mkdir(o.outDir, { recursive: true });
      const out = U.uniquePath(o.outDir, U.outputBaseName({ name, upscale: o.upscale, interpolate, engine: o.engine, fps: Number.isInteger(outFps) ? outFps : outFps.toFixed(3) }), '.mp4');

      const encode = async (dir, count) => {
        const enc = await t.pickEncoder(FF.ffmpeg, this.dev.encode);
        this._begin(si, `${enc.label} · ${(br / 1e6).toFixed(0)} Mbps · ${outFps} fps`, count);
        const stats = { frame: 0 };
        const job = this._spawn(FF.ffmpeg, ['-v', 'error', '-nostats', '-progress', 'pipe:1', '-framerate', String(outFps), '-i', path.join(dir, `%08d${PNG_EXT}`),
          '-vf', `scale=out_color_matrix=bt709:flags=lanczos+accurate_rnd+full_chroma_int,format=${enc.pixFmt}`,
          ...enc.args(br), '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-movflags', '+faststart', '-an', '-y', out],
        { onLine: (l) => { const m = /^frame=(\d+)/.exec(l); if (m) stats.frame = Number(m[1]); } });
        const r = await this._watch(job, async () => stats.frame);
        this._check();
        if (r.code !== 0) { await fsp.rm(out, { force: true }); throw new Error(`Encoding failed:\n${r.tail}`); }
        this._progress(this.total);
      };

      // ----- stage: interpolate (+ encode) -----
      if (!interpolate) {
        await encode(CUR, N);
      } else if (o.engine === 'apple') {
        const a = await t.apple();
        const bin = a.bin || path.join(t.dir, 'apple', 'frc');
        const srcI = Math.round(srcFps), dstI = Math.round(outFps);
        this._begin(si, `Apple ML · ${srcI}→${dstI} fps · ${W}×${H} · ${(br / 1e6).toFixed(0)} Mbps HEVC 10-bit`, M);
        const stats = { done: 0 };
        const job = this._spawn(bin, [CUR, out, String(srcI), String(dstI), String(br)], { onLine: (l) => { const m = /^PROGRESS (\d+)/.exec(l); if (m) stats.done = Number(m[1]); } });
        const r = await this._watch(job, async () => stats.done);
        this._check();
        if (r.code !== 0) { await fsp.rm(out, { force: true }); throw new Error(`Apple ML interpolation failed:\n${r.tail}`); }
        this._progress(this.total);
      } else {
        const rife = t.rife();
        await this._needSpace(fb * M * 1.1, 'RIFE');
        await fsp.mkdir(OUTF, { recursive: true });
        this._begin(si, `RIFE · ${srcFps} → ${outFps} fps · ${W}×${H}${this._devNote(this.dev.interpolate)}`, M);
        const args = ['-i', CUR, '-o', OUTF, '-m', rife.modelDir, '-n', String(M), '-f', '%08d.png'];
        if (W >= 2560) args.push('-u');
        args.push(...U.ncnnDeviceArgs(this.dev.interpolate));
        const job = this._spawn(rife.bin, args);
        const r = await this._watch(job, () => this._countDir(OUTF));
        this._check();
        if (r.code !== 0) throw new Error(`RIFE failed:\n${r.tail}`);
        const made = await this._countDir(OUTF);
        if (made < M) throw new Error(`RIFE produced ${made} of ${M} frames.\n${r.tail}`);
        this._progress(this.total);
        await fsp.rm(CUR, { recursive: true, force: true });
        si++;
        await encode(OUTF, M);
      }

      let frames = null;
      try { frames = (await this._probe(out)).frames; } catch { /* best effort */ }
      const result = { output: out, width: W, height: H, fps: outFps, frames, elapsed: (Date.now() - this.t0) / 1000 };
      this.emit('done', result);
      return result;
    } catch (err) {
      const e = this.cancelled ? new Error('Cancelled') : err;
      this.emit('failed', { message: e.message, cancelled: this.cancelled });
      throw e;
    } finally {
      killTree(this.child);
      if (this.work) await fsp.rm(this.work, { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = { Pipeline };
