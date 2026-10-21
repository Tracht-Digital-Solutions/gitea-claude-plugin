// Renders the plugin icon (512x512 PNG): a teacup-green rounded square with a white "G".
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const S = 512;
const px = Buffer.alloc(S * S * 4);
const set = (x, y, [r, g, b, a]) => {
  const i = (y * S + x) * 4;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
  px[i + 3] = a;
};
const green = [96, 153, 38, 255];
const white = [255, 255, 255, 255];
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const r = 96; // corner radius
    const cx = Math.min(Math.max(x, r), S - 1 - r);
    const cy = Math.min(Math.max(y, r), S - 1 - r);
    const inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
    if (!inside) {
      set(x, y, [0, 0, 0, 0]);
      continue;
    }
    set(x, y, green);
    const dx = x - 256,
      dy = y - 256;
    const d = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx); // 0 = right, positive = down
    const ring = d >= 120 && d <= 170 && !(angle < 0 && angle > -Math.PI / 4);
    const bar = y >= 236 && y <= 280 && x >= 262 && x <= 420 && d <= 170;
    if (ring || bar) set(x, y, white);
  }
}
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;
ihdr[9] = 6;
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync('plugin/.claude-plugin/icon.png', png);
console.log(`wrote plugin/.claude-plugin/icon.png (${png.length} bytes)`);
