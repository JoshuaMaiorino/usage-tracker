/**
 * Generate committed PNG home-screen icons: node scripts/make-icons.mjs
 * Claude's build contributed the dependency-free PNG writer; the mark matches
 * public/icon.svg, preserving the original dashboard's three vertical bars.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[n] = value >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

function inside(x, y, left, top, width, height, radius) {
  if (x < left || x > left + width || y < top || y > top + height) return false;
  const dx = Math.max(left + radius - x, 0, x - (left + width - radius));
  const dy = Math.max(top + radius - y, 0, y - (top + height - radius));
  return dx * dx + dy * dy <= radius * radius;
}

function mark(x, y) {
  if (!inside(x, y, 0, 0, 192, 192, 38)) return null;
  if (!inside(x, y, 39, 39, 114, 114, 25)) return [0x10, 0x13, 0x13];
  if (inside(x, y, 59, 92, 16, 40, 5) || inside(x, y, 88, 61, 16, 71, 5) || inside(x, y, 117, 78, 16, 54, 5)) return [0x26, 0x36, 0x26];
  return [0xc5, 0xed, 0xa0];
}

function png(size) {
  const stride = size * 4 + 1;
  const pixels = Buffer.alloc(stride * size);
  // Four samples per axis keep rounded corners smooth at every target size.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const total = [0, 0, 0];
      let opaque = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const color = mark((x + (sx + 0.5) / 4) * 192 / size, (y + (sy + 0.5) / 4) * 192 / size);
        if (!color) continue;
        opaque++;
        for (let channel = 0; channel < 3; channel++) total[channel] += color[channel];
      }
      const at = y * stride + 1 + x * 4;
      if (opaque) for (let channel = 0; channel < 3; channel++) pixels[at + channel] = Math.round(total[channel] / opaque);
      pixels[at + 3] = Math.round(opaque / 16 * 255);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = new URL('../public/icons/', import.meta.url);
mkdirSync(out, { recursive: true });
for (const size of [180, 192, 512]) {
  writeFileSync(new URL(`icon-${size}.png`, out), png(size));
  console.log(`Generated public/icons/icon-${size}.png`);
}
