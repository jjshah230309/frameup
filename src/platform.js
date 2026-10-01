'use strict';
const path = require('path');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const isLinux = process.platform === 'linux';
const exe = (name) => (isWin ? `${name}.exe` : name);

// Folders GUI apps often miss on PATH (macOS launches apps with a minimal PATH).
const extraPath = isMac ? ['/opt/homebrew/bin', '/usr/local/bin'] : isLinux ? ['/usr/local/bin', '/usr/bin', '/snap/bin'] : [];
const searchPath = () => [...(process.env.PATH || '').split(path.delimiter), ...extraPath].filter(Boolean);

module.exports = { isMac, isWin, isLinux, exe, searchPath, arch: process.arch };
