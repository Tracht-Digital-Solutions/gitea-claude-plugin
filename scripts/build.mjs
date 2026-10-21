// Bundles the MCP server into a single self-contained ES module without runtime dependencies,
// so the installed plugin runs without `npm install` or a compile step.
import { build } from 'esbuild';
import { mkdirSync, statSync } from 'node:fs';

const outfile = 'plugin/dist/server.mjs';
mkdirSync('plugin/dist', { recursive: true });

await build({
  entryPoints: ['src/index.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: false,
  sourcemap: false,
  legalComments: 'eof',
  // Some bundled CommonJS dependencies call require(); provide it in the ESM output.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'warning',
});

console.log(`built ${outfile} (${Math.round(statSync(outfile).size / 1024)} KiB)`);
