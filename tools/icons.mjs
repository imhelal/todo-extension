// Draws the extension's icons: the three-bar mark (one bar per stream) at
// every toolbar size, plus a single-colour version per stream that tints
// notifications. Development only — the PNGs it writes are committed, so the
// extension still ships with no build step.
//
//   node tools/icons.mjs
//
// No dependencies: shapes are rasterised with 4×4 supersampling and written
// as PNG by hand (zlib is built into Node).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'extension', 'src', 'icons');

// Top and bottom of each stream's gradient — the same pairs app.css uses.
const STREAMS = {
  business: ['#f7bd55', '#e0861b'],
  freelance: ['#9488fc', '#5b48e8'],
  personal: ['#43d3a4', '#0e9670'],
};

// The mark on a 128-unit canvas: three pills, tallest first, sitting on one baseline.
const BARS = [
  { x: 10, y: 12, w: 30, h: 104 },
  { x: 49, y: 38, w: 30, h: 78 },
  { x: 88, y: 63, w: 30, h: 53 },
];

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

function insidePill(px, py, bar) {
  const r = bar.w / 2;
  if (px < bar.x || px > bar.x + bar.w || py < bar.y || py > bar.y + bar.h) return false;
  const cx = bar.x + r;
  const top = bar.y + r;
  const bottom = bar.y + bar.h - r;
  const cy = Math.min(Math.max(py, top), bottom);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

function draw(size, colours) {
  const s = size / 128;
  const SS = 4;
  const pixels = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hits = 0;
      let rgb = [0, 0, 0];
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = (x + (sx + 0.5) / SS) / s;
          const py = (y + (sy + 0.5) / SS) / s;
          BARS.forEach((bar, i) => {
            if (!insidePill(px, py, bar)) return;
            const [top, bottom] = colours[i];
            const t = Math.min(1, Math.max(0, (py - bar.y) / bar.h));
            const a = hex(top);
            const b = hex(bottom);
            rgb = rgb.map((c, k) => c + a[k] + (b[k] - a[k]) * t);
            hits += 1;
          });
        }
      }
      const o = (y * size + x) * 4;
      if (hits) {
        pixels[o] = Math.round(rgb[0] / hits);
        pixels[o + 1] = Math.round(rgb[1] / hits);
        pixels[o + 2] = Math.round(rgb[2] / hits);
        pixels[o + 3] = Math.round((hits / (SS * SS)) * 255);
      }
    }
  }
  return pixels;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function png(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    rows[y * (size * 4 + 1)] = 0; // no filter
    pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const mark = [STREAMS.business, STREAMS.freelance, STREAMS.personal];
for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), png(size, draw(size, mark)));
}
for (const [name, pair] of Object.entries(STREAMS)) {
  fs.writeFileSync(path.join(outDir, `icon-${name}-128.png`), png(128, draw(128, [pair, pair, pair])));
}
console.log('Icons written to', path.relative(root, outDir));
