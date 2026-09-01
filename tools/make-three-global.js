#!/usr/bin/env node
/**
 * tools/make-three-global.js
 *
 * Turns the vendored ES module build (`vendor/three.module.js`) into a
 * *classic* script build (`vendor/three.global.js`) that assigns the whole
 * namespace to `globalThis.THREE`.
 *
 * Why: index.html has to work when you double-click it (`file://`).
 * Browsers refuse to `import` any sibling file from a `file://` page
 * (opaque origin + CORS), so an import-map + `import * as THREE from 'three'`
 * silently never runs. A plain <script src> has no such restriction, and it
 * keeps the "no build step, no internet" promise.
 *
 * Usage (zero dependencies, from the repo root):
 *
 *     node tools/make-three-global.js            # regenerate vendor/three.global.js
 *     node tools/make-three-global.js --check    # fail if it is out of date
 *
 * Re-run it whenever you replace vendor/three.module.js with a new Three.js
 * release (the file is byte-for-byte the official `three/build/three.module.js`).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'vendor', 'three.module.js');
const OUT = path.join(ROOT, 'vendor', 'three.global.js');

function die(msg) {
  console.error('make-three-global: ' + msg);
  process.exit(1);
}

const code = fs.readFileSync(SRC, 'utf8');
const sha256 = crypto.createHash('sha256').update(code).digest('hex');
const revision = (code.match(/const REVISION = '([^']+)'/) || [])[1] || 'unknown';

// ── sanity checks: the transform below only works for a self-contained module ──
if (/^\s*import[\s{*'"]/m.test(code)) die('source module contains import statements; this transform only handles self-contained bundles');
if (/\bimport\.meta\b/.test(code)) die('source module uses import.meta, which is invalid in a classic script');
if (/\bexport\s+default\b/.test(code)) die('source module has an `export default`; handle it explicitly');

// The official build keeps every symbol in one trailing `export { A, B, ... };`
// statement. Locate it, turn it into a namespace object, and drop it.
const exportStart = code.lastIndexOf('\nexport {');
if (exportStart === -1) die('could not find the trailing `export { ... };` statement');
const exportEnd = code.indexOf('};', exportStart);
if (exportEnd === -1) die('unterminated `export { ... };` statement');

const exportBody = code.slice(exportStart + '\nexport {'.length, exportEnd);
const pairs = exportBody
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((spec) => {
    const m = spec.match(/^([$\w]+)\s+as\s+([$\w]+)$/);
    if (m) return { local: m[1], exported: m[2] };
    if (!/^[$\w]+$/.test(spec)) die('unexpected export specifier: ' + JSON.stringify(spec));
    return { local: spec, exported: spec };
  });
if (pairs.length === 0) die('the `export { ... };` statement is empty');

const head = code.slice(0, exportStart + 1);            // everything before the export
const tail = code.slice(exportEnd + 2).trim();          // usually nothing
if (tail) die('unexpected code after the export statement: ' + JSON.stringify(tail.slice(0, 80)));

const entries = pairs.map((p) => `    ${JSON.stringify(p.exported)}: ${p.local}`);

const out = `/**
 * three.js r${revision} — global (classic-script) build.
 *
 * ⚠️ GENERATED FILE — do not edit by hand.
 *    Source:  vendor/three.module.js (sha256 ${sha256})
 *    Command: node tools/make-three-global.js
 *
 * Identical to the official ES module build, except that its exports are
 * published as \`globalThis.THREE\` instead of \`export { ... }\`. Loading Three.js
 * this way is what lets index.html run from a file:// URL, where browsers
 * block ES-module imports.
 */
(function () {
  'use strict';

${head.trimEnd()}
  const THREE = {
${entries.join(',\n')}
  };
  globalThis.THREE = THREE;
})();
`;

if (process.argv.includes('--check')) {
  if (!fs.existsSync(OUT)) die('vendor/three.global.js is missing — run: node tools/make-three-global.js');
  if (fs.readFileSync(OUT, 'utf8') !== out) die('vendor/three.global.js is stale — run: node tools/make-three-global.js');
  console.log(`make-three-global: vendor/three.global.js is up to date (three r${revision})`);
  process.exit(0);
}

fs.writeFileSync(OUT, out);
const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log(
  `make-three-global: vendor/three.module.js (${kb(code.length)}) → vendor/three.global.js (${kb(out.length)}) · three r${revision} · ${pairs.length} exports`
);
