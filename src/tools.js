'use strict';
// Locates (and on demand downloads) the external tools FrameUp drives:
//   ffmpeg/ffprobe, RIFE (rife-ncnn-vulkan), Upscayl CLI, and (macOS) the Apple ML helper.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const P = require('./platform');
const { download, gunzip, unzip } = require('./download');

const FFMPEG_TAG = 'b6.1.1';   // github.com/eugeneware/ffmpeg-static
const RIFE_TAG = '20221029';    // github.com/nihui/rife-ncnn-vulkan
const RIFE_MODEL = 'rife-v4.6';

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function which(name) {
  const exts = P.isWin ? (process.env.PATHEXT || '.EXE;.CMD').split(';') : [''];
  for (const dir of P.searchPath()) {
    for (const ext of exts) {
      const p = path.join(dir, P.isWin && !name.includes('.') ? name + ext.toLowerCase() : name);
      if (isFile(p)) return p;
    }
  }
  return null;
}

// Breadth-limited search for a file by name.
function findFile(root, fileName, depth = 5) {
  if (!isDir(root) || depth < 0) return null;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) if (e.isFile() && e.name === fileName) return path.join(root, e.name);
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'node_modules') continue;
    const r = findFile(path.join(root, e.name), fileName, depth - 1);
    if (r) return r;
  }
  return null;
}

function run(cmd, args, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) }));
  });
}

async function githubJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'FrameUp', Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub request failed (${res.status})`);
  return res.json();
}

// Video encoders to try, best first. Hardware encoders are verified with a 1-frame test encode.
function encoderCandidates() {
  const hw = (name, label, extra = []) => ({
    name, label, hardware: true, pixFmt: 'p010le',
    args: (br) => ['-c:v', name, '-profile:v', 'main10', ...extra, '-b:v', String(br), '-tag:v', 'hvc1'],
  });
  const x265 = {
    name: 'libx265', label: 'x265 (CPU)', hardware: false, pixFmt: 'yuv420p10le',
    args: () => ['-c:v', 'libx265', '-profile:v', 'main10', '-crf', '14', '-preset', 'medium', '-tag:v', 'hvc1'],
  };
  const x264 = {
    name: 'libx264', label: 'x264 (CPU, 8-bit)', hardware: false, pixFmt: 'yuv420p',
    args: () => ['-c:v', 'libx264', '-crf', '12', '-preset', 'slow'],
  };
  if (P.isMac) return [hw('hevc_videotoolbox', 'Apple VideoToolbox HEVC'), x265, x264];
  if (P.isWin) return [hw('hevc_nvenc', 'NVIDIA NVENC HEVC'), hw('hevc_amf', 'AMD AMF HEVC'), hw('hevc_qsv', 'Intel QuickSync HEVC'), x265, x264];
  return [hw('hevc_nvenc', 'NVIDIA NVENC HEVC'), hw('hevc_qsv', 'Intel QuickSync HEVC'), x265, x264];
}

class Tools {
  constructor({ dataDir, resourcesDir }) {
    this.dir = path.join(dataDir, 'tools');
    this.resourcesDir = resourcesDir;
    this._encoders = {};
  }

  // ---------- locating ----------
  ffmpeg() {
    const own = (n) => path.join(this.dir, 'ffmpeg', P.exe(n));
    const env = process.env.FRAMEUP_FFMPEG_DIR;
    const find = (n) => (env && isFile(path.join(env, P.exe(n))) && path.join(env, P.exe(n))) || which(n) || (isFile(own(n)) ? own(n) : null);
    const ffmpeg = find('ffmpeg'), ffprobe = find('ffprobe');
    if (!ffmpeg || !ffprobe) return null;
    return { ffmpeg, ffprobe, source: ffmpeg.startsWith(this.dir) ? 'downloaded' : 'system' };
  }

  rife() {
    const roots = [process.env.FRAMEUP_RIFE_DIR, path.join(this.dir, 'rife')].filter(Boolean);
    for (const r of roots) {
      const bin = findFile(r, P.exe('rife-ncnn-vulkan'), 3);
      if (!bin) continue;
      const modelDir = path.join(path.dirname(bin), RIFE_MODEL);
      if (isDir(modelDir)) return { bin, modelDir, source: r.startsWith(this.dir) ? 'downloaded' : 'system' };
    }
    return null;
  }

  upscayl() {
    const roots = [];
    if (process.env.FRAMEUP_UPSCAYL_DIR) roots.push(process.env.FRAMEUP_UPSCAYL_DIR);
    if (P.isMac) roots.push('/Applications/Upscayl.app/Contents/Resources', path.join(os.homedir(), 'Applications/Upscayl.app/Contents/Resources'));
    if (P.isWin) {
      for (const base of [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'), process.env.ProgramFiles].filter(Boolean)) {
        roots.push(path.join(base, 'Upscayl', 'resources'), path.join(base, 'upscayl', 'resources'));
      }
    }
    if (P.isLinux) roots.push('/opt/Upscayl/resources', '/usr/lib/upscayl/resources', '/opt/upscayl/resources');
    const binName = P.exe('upscayl-bin');
    for (const r of roots) {
      const bin = path.join(r, 'bin', binName), models = path.join(r, 'models');
      if (isFile(bin) && isDir(models)) return this._upscaylInfo(bin, models, 'system');
    }
    const own = findFile(path.join(this.dir, 'upscayl'), binName, 7);
    if (own) {
      const models = path.join(path.dirname(path.dirname(own)), 'models');
      if (isDir(models)) return this._upscaylInfo(own, models, 'downloaded');
    }
    return null;
  }

  _upscaylInfo(bin, modelsDir, source) {
    const models = fs.readdirSync(modelsDir).filter((f) => f.endsWith('.param')).map((f) => f.slice(0, -6)).sort();
    return { bin, modelsDir, models, source };
  }

  async apple() {
    if (!P.isMac) return { supported: false, reason: 'Apple ML is only available on macOS.' };
    const candidates = [path.join(this.resourcesDir, 'apple', 'frc'), path.join(this.dir, 'apple', 'frc')];
    const bin = candidates.find(isFile) || null;
    const swiftc = which('swiftc');
    const src = [path.join(this.resourcesDir, 'apple', 'frc.swift')].find(isFile) || null;
    return { supported: true, bin, canCompile: !!(swiftc && src), swiftc, src };
  }

  async status() {
    const ff = this.ffmpeg(), rife = this.rife(), up = this.upscayl(), apple = await this.apple();
    return {
      platform: process.platform, arch: process.arch,
      ffmpeg: ff ? { found: true, ...ff } : { found: false },
      rife: rife ? { found: true, ...rife } : { found: false },
      upscayl: up ? { found: true, ...up } : { found: false },
      apple: { ...apple, ready: !!(apple.bin || apple.canCompile) },
    };
  }

  // ---------- encoder ----------
  // mode: 'auto' (hardware first, software fallback) | 'gpu' (hardware only) | 'cpu' (software only)
  async pickEncoder(ffmpegPath, mode = 'auto') {
    if (this._encoders[mode]) return this._encoders[mode];
    const cands = encoderCandidates().filter((e) => mode === 'auto' || (mode === 'gpu') === e.hardware);
    for (const enc of cands) {
      const r = await run(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.2:r=25',
        '-vf', `format=${enc.pixFmt}`, ...enc.args(4_000_000), '-frames:v', '2', '-an', '-f', 'null', '-'], { timeout: 20000 });
      if (r.ok) { this._encoders[mode] = enc; return enc; }
    }
    if (mode === 'gpu') throw new Error('No working GPU video encoder was found (tried ' + cands.map((e) => e.name).join(', ') + '). Set the encoder to Auto or CPU.');
    throw new Error('ffmpeg has no usable video encoder (tried ' + cands.map((e) => e.name).join(', ') + ').');
  }

  // ---------- installing ----------
  async installFfmpeg(onProgress) {
    const plat = { darwin: 'darwin', win32: 'win32', linux: 'linux' }[process.platform];
    const arch = process.arch;
    if (!plat || !['x64', 'arm64'].includes(arch) || (plat === 'win32' && arch !== 'x64')) {
      throw new Error(`No prebuilt ffmpeg for ${process.platform}-${arch}. Install ffmpeg and ffprobe yourself and put them on PATH.`);
    }
    const dir = path.join(this.dir, 'ffmpeg');
    await fsp.mkdir(dir, { recursive: true });
    const names = ['ffmpeg', 'ffprobe'];
    const prog = [0, 0], tot = [0, 0];
    for (let i = 0; i < names.length; i++) {
      const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_TAG}/${names[i]}-${plat}-${arch}.gz`;
      const gz = path.join(dir, `${names[i]}.gz`), out = path.join(dir, P.exe(names[i]));
      await download(url, gz, { onProgress: (d, t) => { prog[i] = d; tot[i] = t; onProgress && onProgress(prog[0] + prog[1], (tot[0] || 30e6) + (tot[1] || 30e6), 'ffmpeg'); } });
      await gunzip(gz, out);
      await fsp.rm(gz, { force: true });
      if (!P.isWin) await fsp.chmod(out, 0o755);
    }
  }

  rifeUrl() {
    const osName = { darwin: 'macos', win32: 'windows', linux: 'ubuntu' }[process.platform];
    return `https://github.com/nihui/rife-ncnn-vulkan/releases/download/${RIFE_TAG}/rife-ncnn-vulkan-${RIFE_TAG}-${osName}.zip`;
  }

  async upscaylAsset() {
    const re = { darwin: /-mac\.zip$/, win32: /-win\.zip$/, linux: /-linux\.zip$/ }[process.platform];
    const rel = await githubJson('https://api.github.com/repos/upscayl/upscayl/releases/latest');
    const asset = (rel.assets || []).find((a) => re.test(a.name));
    if (!asset) throw new Error('Could not find an Upscayl download for this system.');
    return asset;
  }

  async installRife(onProgress) {
    const dir = path.join(this.dir, 'rife');
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    const zip = path.join(dir, 'rife.zip');
    await download(this.rifeUrl(), zip,
      { onProgress: (d, t) => onProgress && onProgress(d, t, 'RIFE') });
    await unzip(zip, dir);
    await fsp.rm(zip, { force: true });
    const bin = findFile(dir, P.exe('rife-ncnn-vulkan'), 3);
    if (!bin) throw new Error('RIFE archive did not contain rife-ncnn-vulkan.');
    if (!P.isWin) await fsp.chmod(bin, 0o755);
    // keep only the model we use (the archive ships ~15 models, hundreds of MB)
    const base = path.dirname(bin);
    for (const e of await fsp.readdir(base, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== RIFE_MODEL) await fsp.rm(path.join(base, e.name), { recursive: true, force: true });
    }
    if (!isDir(path.join(base, RIFE_MODEL))) throw new Error(`RIFE archive is missing ${RIFE_MODEL}.`);
  }

  async installUpscayl(onProgress) {
    const asset = await this.upscaylAsset();
    const dir = path.join(this.dir, 'upscayl');
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    const zip = path.join(dir, 'upscayl.zip');
    await download(asset.browser_download_url, zip, { onProgress: (d, t) => onProgress && onProgress(d, t || asset.size, 'Upscayl') });
    await unzip(zip, dir);
    await fsp.rm(zip, { force: true });
    const bin = findFile(dir, P.exe('upscayl-bin'), 7);
    if (!bin) throw new Error('Upscayl archive did not contain upscayl-bin.');
    if (!P.isWin) await fsp.chmod(bin, 0o755);
  }

  async installApple() {
    const a = await this.apple();
    if (!a.supported) throw new Error(a.reason);
    if (a.bin) return;
    if (!a.canCompile) throw new Error('The Apple ML helper is not built and swiftc was not found. Run: xcode-select --install');
    const out = path.join(this.dir, 'apple', 'frc');
    await fsp.mkdir(path.dirname(out), { recursive: true });
    const r = await run(a.swiftc, ['-O', a.src, '-o', out], { timeout: 300000 });
    if (!r.ok) throw new Error(`Could not compile the Apple ML helper: ${r.stderr.split('\n').slice(0, 5).join('\n')}`);
  }

  async install(name, onProgress) {
    if (name === 'ffmpeg') return this.installFfmpeg(onProgress);
    if (name === 'rife') return this.installRife(onProgress);
    if (name === 'upscayl') return this.installUpscayl(onProgress);
    if (name === 'apple') return this.installApple();
    throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = { Tools, which, findFile, encoderCandidates, RIFE_MODEL };
