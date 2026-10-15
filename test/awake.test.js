'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Awake, holderCommand, parseLidIndexes, parseSleepDisabled, macLidCommand, osascriptAdmin } = require('../src/awake');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fu-awake-'));
const fakeSpawn = (calls) => (cmd, args) => { const c = new EventEmitter(); c.kill = () => { c.killed = true; }; c.unref = () => {}; calls.push({ cmd, args, c }); return c; };
const fakeExec = (calls, replies = {}) => async (cmd, args) => {
  calls.push([cmd, ...args].join(' '));
  for (const [needle, reply] of Object.entries(replies)) if (calls.at(-1).includes(needle)) return { code: 0, stdout: '', stderr: '', ...reply };
  return { code: 0, stdout: '', stderr: '' };
};

test('holder commands per platform', () => {
  const mac = holderCommand('darwin', { mode: 'system', pid: 42 });
  assert.equal(mac.cmd, '/usr/bin/caffeinate');
  assert.deepEqual(mac.args, ['-i', '-m', '-s', '-w', '42']);
  assert.ok(holderCommand('darwin', { mode: 'display', pid: 42 }).args.includes('-d'));
  assert.equal(holderCommand('darwin', { mode: 'off', pid: 42 }), null);

  const win = holderCommand('win32', { mode: 'display', pid: 7 });
  assert.equal(win.cmd, 'powershell.exe');
  assert.match(win.args.at(-1), /SetThreadExecutionState\(2147483651\); Wait-Process -Id 7$/);
  assert.match(holderCommand('win32', { mode: 'system', pid: 7 }).args.at(-1), /SetThreadExecutionState\(2147483649\)/);

  assert.deepEqual(holderCommand('linux', { mode: 'system', pid: 9 }).args.slice(0, 1), ['--what=sleep']);
  assert.equal(holderCommand('linux', { mode: 'display', lid: true, pid: 9 }).args[0], '--what=sleep:idle:handle-lid-switch');
  assert.equal(holderCommand('linux', { mode: 'off', lid: true, pid: 9 }).args[0], '--what=sleep:handle-lid-switch');
  assert.equal(holderCommand('linux', { mode: 'off', pid: 9 }), null);
});

test('powercfg and pmset output parsing', () => {
  const en = `Power Scheme GUID: 381b4222\n  Setting GUID: 5ca83367\n    Possible Setting Index: 000\n    Minimum Possible Setting: 0x00000000\n    Maximum Possible Setting: 0x00000003\n    Current AC Power Setting Index: 0x00000001\n    Current DC Power Setting Index: 0x00000002\n`;
  assert.deepEqual(parseLidIndexes(en), { ac: 1, dc: 2 });
  const de = en.replace('Current AC Power Setting Index', 'Aktueller Wechselstromeinstellungsindex').replace('Current DC Power Setting Index', 'Aktueller Gleichstromeinstellungsindex');
  assert.deepEqual(parseLidIndexes(de), { ac: 1, dc: 2 });
  assert.equal(parseLidIndexes('nothing here'), null);
  assert.equal(parseSleepDisabled(' SleepDisabled\t\t1\n'), 1);
  assert.equal(parseSleepDisabled(' sleep 10\n'), 0);
});

test('macOS lid command is built safely', () => {
  const cmd = macLidCommand(123, '/Users/a b/Library/Application Support/FrameUp/awake-lid.flag');
  assert.match(cmd, /^\/usr\/bin\/pmset -a disablesleep 1; \( while \/bin\/kill -0 123 /);
  assert.match(cmd, /disablesleep 0 \) >\/dev\/null 2>&1 &$/);
  assert.throws(() => macLidCommand(123, "/tmp/x'; rm -rf ~; '"));
  assert.throws(() => macLidCommand('1; reboot', '/tmp/ok.flag'));
  const [e, script] = osascriptAdmin('echo "hi" \\ x', 'Say "hi"');
  assert.equal(e, '-e');
  assert.equal(script, 'do shell script "echo \\"hi\\" \\\\ x" with prompt "Say \\"hi\\"" with administrator privileges');
});

test('macOS: caffeinate, lid mode through an admin prompt, restored by deleting the flag', async () => {
  const dir = tmp(), spawns = [], execs = [];
  const a = new Awake({ dataDir: dir, platform: 'darwin', pid: 99, spawnImpl: fakeSpawn(spawns), exec: fakeExec(execs, { 'pmset -g': { stdout: ' SleepDisabled\t\t0\n' } }), holdWaitMs: 5 });
  const warnings = await a.start({ mode: 'display', lid: true });
  assert.deepEqual(warnings, []);
  assert.equal(spawns[0].cmd, '/usr/bin/caffeinate');
  assert.ok(execs.some((c) => c.startsWith('/usr/bin/osascript -e do shell script') && c.includes('administrator privileges')));
  assert.ok(fs.existsSync(path.join(dir, 'awake-lid.flag')));
  await a.stop();
  assert.ok(spawns[0].c.killed);
  assert.ok(!fs.existsSync(path.join(dir, 'awake-lid.flag')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('macOS: a cancelled password prompt only skips lid mode', async () => {
  const dir = tmp(), execs = [];
  const exec = async (cmd, args) => { execs.push(cmd); return cmd.endsWith('osascript') ? { code: 1, stdout: '', stderr: 'execution error: User canceled. (-128)' } : { code: 0, stdout: ' SleepDisabled 0', stderr: '' }; };
  const a = new Awake({ dataDir: dir, platform: 'darwin', pid: 1, spawnImpl: fakeSpawn([]), exec, holdWaitMs: 5 });
  const warnings = await a.start({ mode: 'system', lid: true });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /cancelled/);
  assert.ok(!fs.existsSync(path.join(dir, 'awake-lid.flag')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('macOS: leaves an existing disablesleep setting alone', async () => {
  const dir = tmp(), execs = [];
  const a = new Awake({ dataDir: dir, platform: 'darwin', pid: 1, spawnImpl: fakeSpawn([]), exec: fakeExec(execs, { 'pmset -g': { stdout: ' SleepDisabled 1' } }), holdWaitMs: 5 });
  const warnings = await a.start({ mode: 'system', lid: true });
  assert.match(warnings[0], /already disabled/);
  assert.ok(!execs.some((c) => c.includes('osascript')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Windows: lid action set to do-nothing, then restored to the original values', async () => {
  const dir = tmp(), execs = [];
  const q = '    Current AC Power Setting Index: 0x00000001\n    Current DC Power Setting Index: 0x00000002\n';
  const a = new Awake({ dataDir: dir, platform: 'win32', pid: 5, spawnImpl: fakeSpawn([]), exec: fakeExec(execs, { '/query': { stdout: q } }), holdWaitMs: 5 });
  assert.deepEqual(await a.start({ mode: 'system', lid: true }), []);
  assert.ok(execs.includes('powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0'));
  assert.ok(execs.includes('powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0'));
  assert.ok(fs.existsSync(path.join(dir, 'awake-restore.json')));
  await a.stop();
  assert.ok(execs.includes('powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1'));
  assert.ok(execs.includes('powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 2'));
  assert.ok(!fs.existsSync(path.join(dir, 'awake-restore.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Windows: a lid change left by a crash is undone at next launch', async () => {
  const dir = tmp(), execs = [];
  fs.writeFileSync(path.join(dir, 'awake-restore.json'), JSON.stringify({ ac: 3, dc: 1 }));
  const a = new Awake({ dataDir: dir, platform: 'win32', exec: fakeExec(execs) });
  assert.deepEqual(await a.leftovers(), { restored: true });
  assert.ok(execs.includes('powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 3'));
  assert.ok(execs.includes('powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1'));
  assert.ok(!fs.existsSync(path.join(dir, 'awake-restore.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a holder that exits straight away is reported, not fatal', async () => {
  const dir = tmp(), spawns = [];
  const spawnImpl = (cmd, args) => { const c = new EventEmitter(); c.kill = () => {}; c.unref = () => {}; spawns.push(c); setImmediate(() => c.emit('exit', 1)); return c; };
  const a = new Awake({ dataDir: dir, platform: 'linux', pid: 1, spawnImpl, exec: fakeExec([]), holdWaitMs: 50 });
  const warnings = await a.start({ mode: 'system', lid: true });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /systemd-inhibit/);
  const spawnMissing = () => { const c = new EventEmitter(); c.kill = () => {}; c.unref = () => {}; setImmediate(() => c.emit('error', new Error('ENOENT'))); return c; };
  const b = new Awake({ dataDir: dir, platform: 'darwin', pid: 1, spawnImpl: spawnMissing, exec: fakeExec([]), holdWaitMs: 50 });
  assert.equal((await b.start({ mode: 'system' })).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('off means nothing is started', async () => {
  const dir = tmp(), spawns = [], execs = [];
  const a = new Awake({ dataDir: dir, platform: 'darwin', spawnImpl: fakeSpawn(spawns), exec: fakeExec(execs), holdWaitMs: 5 });
  assert.deepEqual(await a.start({ mode: 'off', lid: false }), []);
  assert.equal(spawns.length + execs.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
