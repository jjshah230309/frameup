'use strict';
// Builds the Apple ML helper (macOS only). Run before packaging: npm run build:apple
const { execFileSync } = require('child_process');
const path = require('path');
if (process.platform !== 'darwin') { console.log('Skipping Apple ML helper (not macOS).'); process.exit(0); }
const dir = path.join(__dirname, '..', 'native', 'apple');
execFileSync('swiftc', ['-O', path.join(dir, 'frc.swift'), '-o', path.join(dir, 'frc')], { stdio: 'inherit' });
console.log('Built', path.join(dir, 'frc'));
