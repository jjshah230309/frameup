'use strict';
// Builds the Apple ML helper (macOS only) as a universal (arm64 + x86_64) binary, so the same file can sit in
// both halves of a universal app. Run before packaging: npm run build:apple
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
if (process.platform !== 'darwin') { console.log('Skipping Apple ML helper (not macOS).'); process.exit(0); }
const dir = path.join(__dirname, '..', 'native', 'apple');
const src = path.join(dir, 'frc.swift'), out = path.join(dir, 'frc');
const slices = ['arm64', 'x86_64'].map((arch) => ({ arch, file: `${out}-${arch}` }));
try {
  for (const s of slices) execFileSync('swiftc', ['-O', '-target', `${s.arch}-apple-macos15.4`, src, '-o', s.file], { stdio: 'inherit' });
  execFileSync('lipo', ['-create', '-output', out, ...slices.map((s) => s.file)], { stdio: 'inherit' });
} finally {
  for (const s of slices) fs.rmSync(s.file, { force: true });
}
console.log('Built', out, '(universal)');
