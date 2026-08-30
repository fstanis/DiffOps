#!/usr/bin/env bun
// Generates the standalone PWA's install icons (dist/pwa/icons). Dependency-
// free: RGBA rasters are drawn with 4x supersampling and encoded as PNG via
// node:zlib. The motif — red minus over green plus — fits the maskable safe
// zone, so one design serves "any" and "maskable" purposes.
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { resolve } from 'node:path';

const outDir = resolve(process.argv[2] ?? 'dist/pwa/icons');

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data) => {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
};

const encodePng = (width, height, rgba) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.subarray(y * width * 4, (y + 1) * width * 4).forEach((byte, index) => {
      raw[y * (width * 4 + 1) + 1 + index] = byte;
    });
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
};

const BACKGROUND = [13, 17, 23]; // #0d1117, the app shell background
const RED = [248, 81, 73]; // additions/deletions palette from the viewer
const GREEN = [63, 185, 80];

// Signed distance to a horizontal capsule centered at (cx, cy).
const capsuleSignedDistance = (x, y, cx, cy, halfLength, radius) => {
  const dx = Math.abs(x - cx) - halfLength;
  const dy = y - cy;
  return Math.hypot(Math.max(dx, 0), dy) - radius;
};

const drawIcon = (size) => {
  const supersample = 4;
  const rgba = new Uint8ClampedArray(size * size * 4);
  // Motif geometry in normalized [0, 1] coordinates; the outermost point
  // (plus bottom, y ≈ 0.883) stays within the maskable 80% safe circle.
  const minus = { cx: 0.5, cy: 0.35, halfLength: 0.185, radius: 0.048 };
  const plus = { cx: 0.5, cy: 0.65, halfLength: 0.185, radius: 0.048 };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let redCoverage = 0;
      let greenCoverage = 0;
      for (let subY = 0; subY < supersample; subY += 1) {
        for (let subX = 0; subX < supersample; subX += 1) {
          const nx = (x + (subX + 0.5) / supersample) / size;
          const ny = (y + (subY + 0.5) / supersample) / size;
          if (
            capsuleSignedDistance(nx, ny, minus.cx, minus.cy, minus.halfLength, minus.radius) <= 0
          ) {
            redCoverage += 1;
          }
          if (
            capsuleSignedDistance(nx, ny, plus.cx, plus.cy, plus.halfLength, plus.radius) <= 0 ||
            capsuleSignedDistance(ny, nx, plus.cy, plus.cx, plus.halfLength, plus.radius) <= 0
          ) {
            greenCoverage += 1;
          }
        }
      }
      const total = supersample * supersample;
      const red = redCoverage / total;
      const green = greenCoverage / total;
      const offset = (y * size + x) * 4;
      // Green (drawn second) wins where the shapes would overlap; they are
      // disjoint by construction, so simple alpha compositing suffices.
      for (let channel = 0; channel < 3; channel += 1) {
        const bg = BACKGROUND[channel];
        const withRed = bg + (RED[channel] - bg) * red;
        const withGreen = withRed + (GREEN[channel] - withRed) * green;
        rgba[offset + channel] = withGreen;
      }
      rgba[offset + 3] = 255;
    }
  }
  return rgba;
};

const SIZES = [192, 512];

await mkdir(outDir, { recursive: true });
for (const size of SIZES) {
  const png = encodePng(size, size, drawIcon(size));
  await writeFile(resolve(outDir, `icon-${size}.png`), png);
  console.log(`built icon-${size}.png (${png.length} bytes)`);
}
