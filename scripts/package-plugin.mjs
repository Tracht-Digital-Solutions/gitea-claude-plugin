#!/usr/bin/env node
// Packages the built plugin into a reproducible zip (sorted entries, fixed timestamps and
// permissions) and writes SHA-256 checksums. Usage: node scripts/package-plugin.mjs [outDir]
//
// Output (default ./release):
//   gitea-plugin-<version>.zip   installable plugin (top-level folder "gitea/")
//   SHA256SUMS                   checksums of all files in outDir
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const outDir = process.argv[2] ?? 'release';
const pluginDir = 'plugin';
const manifest = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
const version = manifest.version;
if (!existsSync(join(pluginDir, 'dist', 'server.mjs'))) {
  console.error('plugin/dist/server.mjs is missing: run `npm run build` first.');
  process.exit(1);
}

// Fixed DOS timestamp (1980-01-01 00:00) keeps the archive byte-identical across builds.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(pluginDir)
  .map((f) => ({ full: f, name: `gitea/${relative(pluginDir, f).split(sep).join('/')}` }))
  .sort((a, b) => (a.name < b.name ? -1 : 1));

const locals = [];
const centrals = [];
let offset = 0;
for (const f of files) {
  const data = readFileSync(f.full);
  const compressed = deflateRawSync(data, { level: 9 });
  const name = Buffer.from(f.name, 'utf8');
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  locals.push(local, name, compressed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);
  offset += local.length + name.length + compressed.length;
}
const centralBuf = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...locals, centralBuf, end]);

mkdirSync(outDir, { recursive: true });
const zipName = `gitea-plugin-${version}.zip`;
writeFileSync(join(outDir, zipName), zip);

const sums = readdirSync(outDir)
  .filter((f) => f !== 'SHA256SUMS')
  .sort()
  .map(
    (f) =>
      `${createHash('sha256')
        .update(readFileSync(join(outDir, f)))
        .digest('hex')}  ${f}`,
  );
writeFileSync(join(outDir, 'SHA256SUMS'), `${sums.join('\n')}\n`);
console.log(`packaged ${files.length} files into ${join(outDir, zipName)} (${zip.length} bytes)`);
console.log(sums.join('\n'));
