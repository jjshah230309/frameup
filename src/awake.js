'use strict';
// Keep the computer awake while a job runs.
//   mode: 'off' | 'system' (no idle sleep) | 'display' (also keep the screen on)
//   lid:  also stay awake when the lid is closed (needs extra privileges, so it is opt-in and always undone afterwards)
//
//   macOS    caffeinate -i -m -s [-d] -w <pid>; lid: `pmset -a disablesleep 1` through an admin prompt, with a small root
//            watcher that puts it back when the run ends, or when this app exits for any reason
//   Windows  SetThreadExecutionState held by a hidden PowerShell that exits with us; lid: powercfg "lid close action" = do
//            nothing for AC and battery, restored afterwards (and on next launch if we crashed)
//   Linux    systemd-inhibit (sleep[:idle][:handle-lid-switch]) holding `tail --pid`, released by the OS when we exit
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const ES_CONTINUOUS_SYSTEM = 2147483649;          // 0x80000001
const ES_CONTINUOUS_SYSTEM_DISPLAY = 2147483651;  // 0x80000003

// What to run to hold the "stay awake" request for as long as `pid` lives. null = nothing to hold.
function holderCommand(platform, { mode, lid = false, pid }) {
  const display = mode === 'display';
  if (platform === 'darwin') {
    if (mode === 'off') return null;
    return { cmd: '/usr/bin/caffeinate', args: ['-i', '-m', '-s', ...(display ? ['-d'] : []), '-w', String(pid)] };
  }
  if (platform === 'win32') {
    if (mode === 'off') return null;
    const flags = display ? ES_CONTINUOUS_SYSTEM_DISPLAY : ES_CONTINUOUS_SYSTEM;
    const script = `Add-Type -Namespace FU -Name P -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; ` +
      `[void][FU.P]::SetThreadExecutionState(${flags}); Wait-Process -Id ${Number(pid)}`;
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script] };
  }
  if (platform === 'linux') {
    const what = [];
    if (mode !== 'off') what.push('sleep');
    if (display) what.push('idle');
    if (lid) { if (!what.length) what.push('sleep'); what.push('handle-lid-switch'); }
    if (!what.length) return null;
    return { cmd: 'systemd-inhibit', args: [`--what=${what.join(':')}`, '--who=FrameUp', '--why=Processing video', '--mode=block', 'tail', `--pid=${pid}`, '-f', '/dev/null'] };
  }
  return null;
}

// `powercfg /query ... LIDACTION` ends with the current AC then DC index (0x........); the labels are localised, the hex isn't.
function parseLidIndexes(text) {
  const hex = String(text).match(/0x[0-9a-fA-F]{8}/g);
  if (!hex || hex.length < 2) return null;
  const [ac, dc] = hex.slice(-2).map((h) => parseInt(h, 16));
  return { ac, dc };
}

// `pmset -g` prints e.g. " SleepDisabled\t\t1"
function parseSleepDisabled(text) {
  const m = /SleepDisabled\s+(\d)/.exec(String(text));
  return m ? Number(m[1]) : 0;
}

// Commands that turn the display off right now while the computer keeps running; tried in order until one works.
function displayOffCommands(platform, env = {}) {
  if (platform === 'darwin') return [{ cmd: '/usr/bin/pmset', args: ['displaysleepnow'] }];
  if (platform === 'win32') {
    // WM_SYSCOMMAND / SC_MONITORPOWER (0xF170) with lParam 2 = monitor off, broadcast to all windows (HWND_BROADCAST = 0xFFFF)
    const script = `Add-Type -Namespace FU -Name M -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int m, IntPtr w, IntPtr l);'; ` +
      `[void][FU.M]::PostMessage([IntPtr]0xFFFF, 0x0112, [IntPtr]0xF170, [IntPtr]2)`;
    return [{ cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script] }];
  }
  if (platform === 'linux') {
    const xset = { cmd: 'xset', args: ['dpms', 'force', 'off'] };
    const gnome = { cmd: 'gdbus', args: ['call', '--session', '--dest', 'org.gnome.Mutter.DisplayConfig', '--object-path', '/org/gnome/Mutter/DisplayConfig',
      '--method', 'org.freedesktop.DBus.Properties.Set', 'org.gnome.Mutter.DisplayConfig', 'PowerSaveMode', '<int32 1>'] };
    const kde = { cmd: 'qdbus', args: ['org.kde.kglobalaccel', '/component/org_kde_powerdevil', 'invokeShortcut', 'Turn Off Screen'] };
    return env.XDG_SESSION_TYPE === 'x11' ? [xset, gnome, kde] : [gnome, kde, xset];
  }
  return [];
}

// The path goes inside single quotes in a root shell command: only a quote (or a control character) can break out of that.
const UNSAFE_PATH = /['\u0000-\u001f\u007f]/;

// Root shell snippet: disable sleep, then (in the background) restore it once `pid` is gone or the flag file is deleted.
function macLidCommand(pid, flagFile) {
  if (!flagFile || UNSAFE_PATH.test(flagFile)) throw new Error('Unsafe path for the sleep flag file.');
  const p = Number(pid);
  if (!Number.isInteger(p) || p <= 0) throw new Error('Bad process id.');
  return `/usr/bin/pmset -a disablesleep 1; ( while /bin/kill -0 ${p} 2>/dev/null && [ -e '${flagFile}' ]; do /bin/sleep 2; done; /usr/bin/pmset -a disablesleep 0 ) >/dev/null 2>&1 &`;
}

const appleScriptString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
function osascriptAdmin(shell, prompt) {
  return ['-e', `do shell script ${appleScriptString(shell)} with prompt ${appleScriptString(prompt)} with administrator privileges`];
}

const defaultExec = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { windowsHide: true, timeout: opts.timeout || 120000 }, (err, stdout, stderr) =>
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

class Awake {
  constructor({ dataDir, platform = process.platform, pid = process.pid, log = () => {}, exec = defaultExec, spawnImpl = spawn, holdWaitMs } = {}) {
    this.dataDir = dataDir;
    this.platform = platform;
    this.pid = pid;
    this.log = log;
    this.exec = exec;
    this.spawn = spawnImpl;
    this.holdWaitMs = holdWaitMs;
    this.child = null;
    this.lid = null;                                   // what to undo on stop()
    this.flagFile = path.join(dataDir, 'awake-lid.flag');
    this.restoreFile = path.join(dataDir, 'awake-restore.json');
  }

  // Never throws; returns a list of human-readable warnings for things that could not be set up.
  async start({ mode = 'system', lid = false } = {}) {
    const warnings = [];
    await this.stop();
    if (lid && mode === 'off') mode = 'system';
    const hold = holderCommand(this.platform, { mode, lid, pid: this.pid });
    if (hold) {
      const ok = await this._hold(hold);
      if (ok) this.log(`Keeping the computer awake (${this.platform === 'darwin' ? 'caffeinate' : this.platform === 'win32' ? 'power request' : 'systemd-inhibit'}).`);
      else warnings.push(this.platform === 'linux' && lid
        ? "Couldn't block sleep and lid-close handling (systemd-inhibit refused or is missing). The lid may still suspend the computer."
        : "Couldn't start the keep-awake helper; the computer may sleep during the run.");
    }
    if (lid && this.platform === 'darwin') { const w = await this._macLidOn(); if (w) warnings.push(w); }
    if (lid && this.platform === 'win32') { const w = await this._winLidOn(); if (w) warnings.push(w); }
    return warnings;
  }

  async stop() {
    if (this.child) { try { this.child.kill(); } catch { /* already gone */ } this.child = null; }
    const undo = this.lid; this.lid = null;
    if (undo === 'darwin') { fs.rmSync(this.flagFile, { force: true }); this.log('Lid-closed sleep will be restored in a moment.'); }
    if (undo && undo.win) await this._winRestore(undo.win);
  }

  _hold(h) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      let child;
      try { child = this.spawn(h.cmd, h.args, { stdio: 'ignore', windowsHide: true }); } catch { return done(false); }
      child.on('error', () => done(false));
      child.on('exit', () => { if (this.child === child) this.child = null; done(false); });   // an early exit means it was refused
      if (child.unref) child.unref();
      this.child = child;
      setTimeout(() => done(true), this.holdWaitMs ?? (this.platform === 'win32' ? 1500 : 500));
    });
  }

  async _macLidOn() {
    const cur = await this.exec('/usr/bin/pmset', ['-g']);
    if (parseSleepDisabled(cur.stdout) === 1) return 'Sleep with the lid closed was already disabled on this Mac; leaving it as it is.';
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.flagFile, String(this.pid));
    let shell;
    try { shell = macLidCommand(this.pid, this.flagFile); } catch (e) { fs.rmSync(this.flagFile, { force: true }); return `Lid-closed mode skipped: ${e.message}`; }
    const r = await this.exec('/usr/bin/osascript', osascriptAdmin(shell, 'FrameUp wants to keep your Mac awake with the lid closed while it works. It puts the setting back when it finishes.'));
    if (r.code !== 0) {
      fs.rmSync(this.flagFile, { force: true });
      return /-128|cancel/i.test(r.stderr) ? 'Lid-closed mode skipped (the password prompt was cancelled).' : `Lid-closed mode skipped: ${r.stderr.trim().split('\n')[0] || 'could not get administrator rights'}.`;
    }
    this.lid = 'darwin';
    this.log('Mac will stay awake with the lid closed (pmset disablesleep) until this run ends.');
    return null;
  }

  async _winLidOn() {
    const q = await this.exec('powercfg', ['/query', 'SCHEME_CURRENT', 'SUB_BUTTONS', 'LIDACTION']);
    const prev = q.code === 0 ? parseLidIndexes(q.stdout) : null;
    if (!prev) return "Lid-closed mode skipped: couldn't read the current lid-close setting.";
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.restoreFile, JSON.stringify(prev));       // so a crash can be undone on the next launch
    const a = await this.exec('powercfg', ['/setacvalueindex', 'SCHEME_CURRENT', 'SUB_BUTTONS', 'LIDACTION', '0']);
    const d = await this.exec('powercfg', ['/setdcvalueindex', 'SCHEME_CURRENT', 'SUB_BUTTONS', 'LIDACTION', '0']);
    const s = await this.exec('powercfg', ['/setactive', 'SCHEME_CURRENT']);
    if (a.code || d.code || s.code) { await this._winRestore(prev); return "Lid-closed mode skipped: Windows wouldn't let FrameUp change the lid-close setting."; }
    this.lid = { win: prev };
    this.log('Closing the lid will do nothing until this run ends.');
    return null;
  }

  async _winRestore(prev) {
    await this.exec('powercfg', ['/setacvalueindex', 'SCHEME_CURRENT', 'SUB_BUTTONS', 'LIDACTION', String(prev.ac)]);
    await this.exec('powercfg', ['/setdcvalueindex', 'SCHEME_CURRENT', 'SUB_BUTTONS', 'LIDACTION', String(prev.dc)]);
    await this.exec('powercfg', ['/setactive', 'SCHEME_CURRENT']);
    fs.rmSync(this.restoreFile, { force: true });
    this.log('Lid-close setting restored.');
  }

  // Turn the display off now (the job keeps running). Returns a warning string, or null when it worked.
  async displayOff(env = process.env) {
    const tries = displayOffCommands(this.platform, env);
    for (const t of tries) {
      const r = await this.exec(t.cmd, t.args, { timeout: 15000 });
      if (r.code === 0) { this.log('Screen turned off; the job keeps running.'); return null; }
    }
    return tries.length ? "Couldn't turn the screen off on this system; it will stay on until it times out." : 'Turning the screen off is not supported here.';
  }

  // Call once at launch. Windows: undo a lid change left behind by a crash. macOS: report one (it needs a password to undo).
  async leftovers() {
    if (this.platform === 'win32' && fs.existsSync(this.restoreFile)) {
      try { await this._winRestore(JSON.parse(fs.readFileSync(this.restoreFile, 'utf8'))); } catch { fs.rmSync(this.restoreFile, { force: true }); }
      return { restored: true };
    }
    if (this.platform === 'darwin' && fs.existsSync(this.flagFile)) {
      const cur = await this.exec('/usr/bin/pmset', ['-g']);
      if (parseSleepDisabled(cur.stdout) === 1) return { macNeedsRestore: true };
      fs.rmSync(this.flagFile, { force: true });
    }
    return {};
  }

  // macOS: user-confirmed restore of `disablesleep` after a crash/reboot mid-run.
  async macRestore() {
    const r = await this.exec('/usr/bin/osascript', osascriptAdmin('/usr/bin/pmset -a disablesleep 0', 'FrameUp wants to turn normal sleep back on.'));
    if (r.code === 0) fs.rmSync(this.flagFile, { force: true });
    return r.code === 0;
  }
}

module.exports = { Awake, displayOffCommands, holderCommand, parseLidIndexes, parseSleepDisabled, macLidCommand, osascriptAdmin };
