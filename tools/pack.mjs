// Zips extension/ for the Chrome Web Store.
//
// This is only for publishing. For everyday work, load extension/ unpacked and
// hit Reload on the extension card — there is no build step to run.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'extension');
const distDir = path.join(root, 'dist');

const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
const out = path.join(distDir, `dual-tasks-${manifest.version}.zip`);

fs.mkdirSync(distDir, { recursive: true });
fs.rmSync(out, { force: true });

// bsdtar ships with Windows 10+ and macOS, so packing needs no dependencies.
// Not Compress-Archive: Windows PowerShell 5.1 writes entry names with
// backslashes, which the zip format forbids. The Windows path is spelled out
// because Git Bash puts GNU tar first on PATH, and GNU tar cannot write zips.
const tar =
  process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
execFileSync(tar, ['--format=zip', '-cf', out, '-C', source, ...fs.readdirSync(source)], {
  stdio: 'inherit',
});

const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(path.relative(source, full).split(path.sep).join('/'));
  }
};
walk(source);

const kb = (fs.statSync(out).size / 1024).toFixed(0);
console.log(`\nPacked ${files.length} files (${kb} KB) into ${path.relative(root, out)}`);
console.log('Contents:');
for (const f of files.sort()) console.log('  ' + f);
