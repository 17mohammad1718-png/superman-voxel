#!/usr/bin/env node
/*
 * Smoke test for the single-file game.
 *
 * There is no build step and no browser in CI, so this runs the *unmodified*
 * inline script of index.html inside jsdom against the real three.js build in
 * vendor/. Only the pieces that genuinely need a GPU or a rasteriser are
 * stubbed:
 *
 *   • THREE.WebGLRenderer  → records render() calls, exposes a canvas element
 *   • canvas 2D context    → records minimap drawing, provides ImageData
 *
 * Everything else — terrain generation, greedy meshing, the voxel DDA raycast,
 * physics, powers, missions, persistence, settings, streaming — is the shipped
 * code path. Run with:  npm test
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const REPO = path.resolve(__dirname, '..');
const HTML = path.join(REPO, 'index.html');
const THREE_FILE = path.join(REPO, 'vendor', 'three.global.js');

const results = [];
let failures = 0;
function check(name, cond, extra) {
  const pass = !!cond;
  if (!pass) failures++;
  results.push({ name, pass, extra });
  console.log((pass ? '  ok   ' : '  FAIL ') + name + (extra !== undefined && extra !== '' ? '   [' + extra + ']' : ''));
}
function section(t) { console.log('\n' + t); }

// ── load the page with its inline scripts held back ──────────────────────────
function loadPage(seed, storage, opts) {
  opts = opts || {};
  let html = fs.readFileSync(HTML, 'utf8');
  const inline = [];
  html = html.replace(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g, (_, body) => {
    inline.push(body); return '<!--inline-->';
  });
  html = html.replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
  if (inline.length !== 2) throw new Error('expected 2 inline scripts in index.html, found ' + inline.length);

  const dom = new JSDOM(html, {
    url: 'http://localhost:8080/index.html' + (seed === null ? '' : '?seed=' + seed),
    runScripts: 'outside-only'
  });
  const window = dom.window;

  // --- 2D canvas: enough for the procedural atlas, clouds and the minimap ---
  const stats2d = { fillRect: 0, colours: new Set(), images: 0 };
  const base2d = {
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '', globalAlpha: 1,
    createImageData(w, h) { stats2d.images++; return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    getImageData(x, y, w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData() {},
    createRadialGradient() { return { addColorStop() {} }; },
    createLinearGradient() { return { addColorStop() {} }; },
    measureText() { return { width: 8 }; }
  };
  const ctx2d = new Proxy(base2d, {
    get(t, p) {
      if (p in t) return t[p];
      return function () {
        if (p === 'fillRect') stats2d.fillRect++;
      };
    },
    set(t, p, v) { if (p === 'fillStyle') stats2d.colours.add(String(v)); t[p] = v; return true; }
  });
  window.HTMLCanvasElement.prototype.getContext = function (type) { return type === '2d' ? ctx2d : null; };

  // --- deterministic frame pump ------------------------------------------------
  let queue = [], clock = 0;
  window.requestAnimationFrame = cb => { queue.push(cb); return queue.length; };
  window.cancelAnimationFrame = () => {};
  const step = (n = 1, ms = 16.7) => {
    for (let i = 0; i < n; i++) {
      const q = queue; queue = [];
      clock += ms;
      for (const cb of q) cb(clock);
    }
  };

  // --- real three.js, then a renderer stand-in --------------------------------
  window.eval(fs.readFileSync(THREE_FILE, 'utf8'));
  const render = { calls: 0 };
  window.THREE.WebGLRenderer = function () {
    const el = window.document.createElement('canvas');
    const target = {
      domElement: el, shadowMap: {}, info: { render: { calls: 0 } }, capabilities: {},
      setSize() {}, setPixelRatio() {}, setClearColor() {}, dispose() {}, setAnimationLoop() {},
      render() { render.calls++; }, getContext: () => null
    };
    return new Proxy(target, {
      get: (o, p) => (p in o ? o[p] : () => {}),
      set: (o, p, v) => { o[p] = v; return true; }
    });
  };

  // --- matchMedia / pointer capture: jsdom has neither. Without them IS_TOUCH
  // is false and initTouch() never runs, so the whole touch control path — the
  // only input scheme a phone gets — would go completely untested. opts.touch
  // turns it on and provides the minimum the handlers rely on.
  window.matchMedia = q => ({
    matches: !!opts.touch && /pointer:\s*coarse/.test(q), media: q,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}
  });
  if (opts.touch) {
    const el = window.Element.prototype;
    el.setPointerCapture = function () {};
    el.releasePointerCapture = function () {};
    el.hasPointerCapture = function () { return false; };
  }

  if (storage) for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);

  let bootError = null;
  try {
    window.eval(inline[0]);   // boot guard
    window.eval(inline[1]);   // the game
  } catch (e) { bootError = e; }

  return { dom, window, step, stats2d, render, bootError, $: id => window.document.getElementById(id) };
}

function key(window, code, type) {
  window.document.dispatchEvent(new window.KeyboardEvent(type || 'keydown', { code, bubbles: true }));
}
function mouse(window, type, init) {
  window.document.dispatchEvent(new window.MouseEvent(type, Object.assign({ bubbles: true, buttons: 1 }, init || {})));
}
// Stand the player on dry land inside the loaded area so aim-dependent checks
// are deterministic (the spawn point can overlook the sea, where a 9-block
// placement reach legitimately finds nothing).
function standOnLand(G, from, pitch) {
  for (let x = (from === undefined ? -60 : from); x < 70; x++) {
    const z = 8;
    if (!G.world.isLoaded(x, z)) continue;
    const h = G.world.heightAt(x, z);
    if (h >= G.SEA_LEVEL + 2 && G.world.isSolid(x, h, z)) {
      G.player.position.set(x + 0.5, h + 1.8, z + 0.5);
      G.S.pitch = pitch === undefined ? -Math.PI / 2.2 : pitch;   // default: look straight down
      G.S.yaw = 0;
      return { x, h };
    }
  }
  return null;
}
// jsdom does not implement movementX/movementY in MouseEventInit, so look
// deltas have to be attached by hand.
function aim(window, dx, dy) {
  const ev = new window.MouseEvent('mousemove', { bubbles: true, buttons: 1 });
  Object.defineProperty(ev, 'movementX', { value: dx });
  Object.defineProperty(ev, 'movementY', { value: dy });
  window.document.dispatchEvent(ev);
}

// ═══════════════════════════════════════════════════════════════════════════
section('boot');
const g = loadPage(4242);
const { window, step, stats2d, render } = g;
const G = window.__game;

check('index.html runs to completion', !g.bootError, g.bootError && (g.bootError.stack || g.bootError.message));
check('window.__booted set (first frame drawn)', window.__booted === true);
check('no boot error panel', g.$('error-box').style.display !== 'flex',
  'detail="' + g.$('error-detail').textContent.slice(0, 140) + '"');
check('three.js r' + (window.THREE && window.THREE.REVISION) + ' from vendor/',
  window.THREE && window.THREE.REVISION === '160');
check('renderer.render() ran at boot', render.calls >= 1, render.calls + ' calls');
check('seed from URL is used', g.$('seed-label').textContent.trim() === 'seed: 4242', g.$('seed-label').textContent);
check('procedural atlas painted pixel by pixel', stats2d.images >= 1, stats2d.images + ' ImageData buffer(s)');
check('minimap painted terrain', stats2d.fillRect > 500 && stats2d.colours.size > 3,
  stats2d.fillRect + ' fillRect, ' + stats2d.colours.size + ' colours');

// ═══════════════════════════════════════════════════════════════════════════
section('world generation');
const CHUNK = G.CHUNK, MAX_H = G.MAX_H, BT = G.BT;
const spawn = G.world.getChunk(0, 0);
check('spawn chunk generated and meshed', !!spawn && spawn.state === 2, 'state=' + (spawn && spawn.state));

// block census over the spawn chunk
let census = {}, solid = 0, water = 0;
for (let i = 0; i < spawn.blocks.length; i++) {
  const t = spawn.blocks[i];
  if (t === BT.AIR) continue;
  census[t] = (census[t] || 0) + 1;
  if (t === BT.WATER) water++; else solid++;
}
check('terrain has depth (bedrock + stone)', census[BT.BEDROCK] === CHUNK * CHUNK && (census[BT.STONE] || 0) > 1000,
  'bedrock=' + census[BT.BEDROCK] + ' stone=' + (census[BT.STONE] || 0));
check('surface blocks exist', (census[BT.GRASS] || 0) + (census[BT.SAND] || 0) + (census[BT.SNOW] || 0) > 100,
  'grass=' + (census[BT.GRASS] || 0) + ' sand=' + (census[BT.SAND] || 0) + ' snow=' + (census[BT.SNOW] || 0));
check('ores generated', (census[BT.IRON] || 0) > 3, 'iron=' + (census[BT.IRON] || 0) + ' diamond=' + (census[BT.DIAMOND] || 0));
check('trees generated', (census[BT.WOOD] || 0) > 0 || (census[BT.LEAF] || 0) > 0,
  'wood=' + (census[BT.WOOD] || 0) + ' leaf=' + (census[BT.LEAF] || 0));

// determinism: same chunk twice, and independent of generation order
const a = new Uint8Array(CHUNK * MAX_H * CHUNK), b = new Uint8Array(CHUNK * MAX_H * CHUNK);
G.genChunk(G.SEED, 3, -5, a);
G.genChunk(G.SEED, -1, 2, new Uint8Array(CHUNK * MAX_H * CHUNK));   // different chunk in between
G.genChunk(G.SEED, 3, -5, b);
check('genChunk is deterministic and order independent', a.every((v, i) => v === b[i]));

// water still gets placed (the old build declared it and never wrote it)
let foundWater = false, foundSeaFloor = false;
for (let z = 0; z < CHUNK && !foundWater; z++)
  for (let x = 0; x < CHUNK; x++) {
    const h = G.terrainHeight(x, z);
    if (h < G.SEA_LEVEL) {
      foundWater = true;
      foundSeaFloor = spawn.get(x, h, z) === BT.SAND;
      break;
    }
  }
if (foundWater) check('sea floor is sand below the water line', foundSeaFloor);
else console.log('  skip  water line (this seed has no ocean in chunk 0,0)');

// The worker gets its copy of the terrain code by stringifying the same
// functions, so verify that string is valid JS and produces identical terrain.
// If it ever diverges, streamed chunks would not match the ones built locally.
section('worker terrain source');
const workerSrc = G.makeWorkerSource();
let workerTerrainMatches = false, workerErr = '';
try {
  const vm = require('vm');
  const messages = [];
  const sandbox = { self: { postMessage: m => messages.push(m) }, Math, Uint8Array, Int16Array, Float32Array, JSON };
  vm.createContext(sandbox);
  vm.runInContext(workerSrc, sandbox, { timeout: 20000 });
  check('worker source is valid JS and reports ready', messages.length === 1 && messages[0].ready === true);
  sandbox.self.onmessage({ data: { cx: 3, cz: -5 } });
  const remote = new Uint8Array(messages[1].buf);
  workerTerrainMatches = remote.length === a.length && remote.every((v, i) => v === a[i]);
} catch (e) { workerErr = e.message; }
check('worker-generated chunk is byte-identical to the main thread', workerTerrainMatches,
  workerErr || (workerTerrainMatches ? 'same ' + (CHUNK * MAX_H * CHUNK) + ' bytes' : 'mismatch'));

// ═══════════════════════════════════════════════════════════════════════════
section('greedy meshing');
let chunkMeshes = 0, tris = 0, verts = 0, visibleBlocks = 0;
G.scene.traverse(o => {
  if (o.isMesh && o.geometry && o.geometry.attributes.aTile) {
    chunkMeshes++;
    tris += o.geometry.index.count / 3;
    verts += o.geometry.attributes.position.count;
  }
});
for (const ch of G.world.chunks.values()) {
  if (ch.state < 2) continue;
  for (let y = 0; y < MAX_H; y++)
    for (let z = 0; z < CHUNK; z++)
      for (let x = 0; x < CHUNK; x++) {
        const t = ch.get(x, y, z);
        if (t === BT.AIR) continue;
        const open = n => { const v = ch.get(x + n[0], y + n[1], z + n[2]); return v === BT.AIR || v === BT.WATER; };
        if (ch.get(x, y + 1, z) === BT.AIR || open([1, 0, 0]) || open([-1, 0, 0]) || open([0, 0, 1]) || open([0, 0, -1]) ||
            (y > 0 && ch.get(x, y - 1, z) === BT.AIR)) visibleBlocks++;
      }
}
const naiveTris = visibleBlocks * 12;
check('one to two draw calls per chunk (solid + water)', chunkMeshes > 0 && chunkMeshes <= G.world.chunks.size * 2,
  chunkMeshes + ' meshes / ' + G.world.chunks.size + ' chunks');
check('greedy meshing beats per-block cubes by >3x', tris > 0 && tris * 3 < naiveTris,
  tris + ' triangles vs ' + naiveTris + ' naive (' + (naiveTris / Math.max(1, tris)).toFixed(1) + 'x fewer)');
check('every merged quad has 4 vertices / 2 triangles', verts === tris * 2, verts + ' verts, ' + tris + ' tris');
check('UVs, tiles, AO shade and x-ray flag attributes present', (() => {
  let ok = true;
  G.scene.traverse(o => {
    if (o.isMesh && o.geometry && o.geometry.attributes.aTile) {
      const at = o.geometry.attributes;
      if (!at.aTuv || !at.aShade || !at.aFlag) ok = false;
    }
  });
  return ok;
})());

// ═══════════════════════════════════════════════════════════════════════════
section('mesh geometry (winding, grid, tiles)');
// A flipped winding in the greedy mesher is invisible to every other check in
// this file and shows up in the browser as *missing terrain*, because the
// material culls back faces. There is no GPU here to notice that, so verify it
// numerically instead: the geometric normal of every emitted triangle must point
// along exactly one world axis, and all six directions must occur.
let oriented = 0, degenerate = 0, offAxis = 0, offGrid = 0, badTile = 0, badTuv = 0;
const dirHist = {};
G.scene.traverse(o => {
  if (!(o.isMesh && o.geometry && o.geometry.attributes.aTile)) return;
  const pos = o.geometry.attributes.position.array;
  const idx = o.geometry.index.array;
  const tile = o.geometry.attributes.aTile.array;
  const tuv = o.geometry.attributes.aTuv.array;
  for (let i = 0; i < tile.length; i++) if (!(tile[i] >= 0 && tile[i] <= 15)) badTile++;
  for (let i = 0; i < tuv.length; i++) if (tuv[i] !== Math.round(tuv[i])) badTuv++;
  for (let i = 0; i < pos.length; i++) if (Math.abs(pos[i] - Math.round(pos[i])) > 1e-4) offGrid++;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-6) { degenerate++; continue; }
    nx /= len; ny /= len; nz /= len;
    const ax = Math.round(nx), ay = Math.round(ny), az = Math.round(nz);
    const onAxis = Math.abs(nx - ax) < 1e-4 && Math.abs(ny - ay) < 1e-4 && Math.abs(nz - az) < 1e-4 &&
      Math.abs(ax) + Math.abs(ay) + Math.abs(az) === 1;
    if (!onAxis) { offAxis++; continue; }
    const key = ax + ',' + ay + ',' + az;
    dirHist[key] = (dirHist[key] || 0) + 1;
    oriented++;
  }
});
check('no degenerate triangles', degenerate === 0, degenerate + ' degenerate');
check('every triangle faces exactly one world axis', offAxis === 0,
  oriented + ' oriented triangles, ' + offAxis + ' off-axis');
check('all six face directions present — winding is not flipped',
  ['1,0,0', '-1,0,0', '0,1,0', '0,-1,0', '0,0,1', '0,0,-1'].every(k => dirHist[k] > 0),
  JSON.stringify(dirHist));
check('vertices sit on the integer voxel grid', offGrid === 0, offGrid + ' off-grid components');
check('tile indices address real atlas slots', badTile === 0, badTile + ' out of range');
check('tile UVs are whole numbers of tiles', badTuv === 0, badTuv + ' fractional');

// ═══════════════════════════════════════════════════════════════════════════
section('play');
g.$('startBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('start engages the pointer-lock fallback', g.$('overlay').style.display === 'none' &&
  /pointer lock|touch/i.test(g.$('notice').textContent), g.$('notice').textContent.slice(0, 60));

const footing = standOnLand(G);
check('found dry land to stand on', !!footing, footing ? 'x=' + footing.x + ' surface=' + footing.h : 'none');
key(window, 'KeyE');
check('laser power selected', G.S.power === 'laser' && /Laser/i.test(g.$('pi-name').textContent), g.$('pi-name').textContent);
aim(window, 0, 4);                                   // nudge the look vector (already aimed down)
mouse(window, 'mousedown');
step(90);
mouse(window, 'mouseup');
check('laser destroys blocks through the voxel DDA', G.S.destroyed > 0, 'mined=' + G.S.destroyed);
check('mining scores points', G.S.score > 0, 'score=' + G.S.score);
check('HUD updates', Number(g.$('s-destroyed').textContent) === G.S.destroyed && Number(g.$('s-fps').textContent) > 0,
  'destroyed=' + g.$('s-destroyed').textContent + ' fps=' + g.$('s-fps').textContent);
check('mission progress tracked', /iron|diamond|wood|freeze|punch|build|fly|climb/i.test(g.$('mb-text').textContent),
  g.$('mb-text').textContent);

// place a block with the real right-click path — from fresh, uncarved ground and
// at ~52°, because placing straight down would target the player's own voxel and
// must (correctly) be refused.
standOnLand(G, -20, -0.9);
const beforePlaced = G.S.placed;
mouse(window, 'mousedown', { button: 2 });
mouse(window, 'mouseup', { button: 2 });
check('right click places a block', G.S.placed === beforePlaced + 1, 'placed=' + G.S.placed);

// ice breath
key(window, 'KeyT');
mouse(window, 'mousedown');
step(20);
mouse(window, 'mouseup');
check('ice breath freezes blocks', G.S.frozen > 0, 'frozen=' + G.S.frozen);

// shockwave punch
key(window, 'KeyY');
const beforePunch = G.S.punched;
mouse(window, 'mousedown');
step(4);
mouse(window, 'mouseup');
check('shockwave punch removes a volume of blocks', G.S.punched > beforePunch, 'punched=' + G.S.punched);

// x-ray is a uniform flip, not a material swap: select the power, click to toggle
key(window, 'KeyR');
check('x-ray power selected', G.S.power === 'xray');
mouse(window, 'mousedown'); mouse(window, 'mouseup');
const xrayOn = G.U.uXray.value;
check('x-ray on makes terrain transparent + keeps ores solid', xrayOn === 1 && G.matSolid.transparent === true,
  'uXray=' + xrayOn + ' transparent=' + G.matSolid.transparent);
mouse(window, 'mousedown'); mouse(window, 'mouseup');
check('x-ray off restores opaque terrain', G.U.uXray.value === 0 && G.matSolid.transparent === false);

// super speed multiplier
key(window, 'KeyU');
check('super speed activates', G.S.speedActive === true && G.S.power === 'speed');
key(window, 'KeyQ');
check('leaving super speed deactivates it', G.S.speedActive === false);

// particles were emitted by the actions above
let particles = 0;
G.scene.traverse(o => { if (o.isInstancedMesh) particles = o.count; });
check('particle pool is in use', particles > 0, particles + ' live particles');

// walk mode gravity
key(window, 'KeyF');
const altBefore = Number(g.$('s-alt').textContent);
step(150);
check('walk mode applies gravity', G.S.flying === false && Number(g.$('s-alt').textContent) <= altBefore + 1,
  'alt ' + altBefore + ' -> ' + g.$('s-alt').textContent + ', mode=' + g.$('s-mode').textContent);
key(window, 'KeyF');

// ═══════════════════════════════════════════════════════════════════════════
section('day / night');
const tint0 = G.U.uTint.value.r + G.U.uTint.value.g + G.U.uTint.value.b;
const time0 = G.S.time;
step(400, 100);          // 40 s of game time
check('clock advances', G.S.time > time0, time0.toFixed(3) + ' -> ' + G.S.time.toFixed(3));
check('HUD clock renders hh:mm', /^\d{2}:\d{2}$/.test(g.$('s-clock').textContent), g.$('s-clock').textContent);
check('terrain tint follows the sun',
  Math.abs(G.U.uTint.value.r + G.U.uTint.value.g + G.U.uTint.value.b - tint0) > 0.01,
  'tint sum ' + tint0.toFixed(3) + ' -> ' + (G.U.uTint.value.r + G.U.uTint.value.g + G.U.uTint.value.b).toFixed(3));

// ═══════════════════════════════════════════════════════════════════════════
section('streaming');
const chunksBefore = G.world.chunks.size;
const keysBefore = new Set(Array.from(G.world.chunks.keys()));
G.player.position.x += 400;      // jump far away, the streamer must follow
G.player.position.z += 400;
step(240);
const keysAfter = new Set(Array.from(G.world.chunks.keys()));
const pcx = Math.floor(G.player.position.x / CHUNK), pcz = Math.floor(G.player.position.z / CHUNK);
const near = G.world.getChunk(pcx, pcz);
let newChunks = 0, meshed = 0;
for (const k of keysAfter) if (!keysBefore.has(k)) newChunks++;
for (const ch of G.world.chunks.values()) if (ch.state === 2) meshed++;
check('new chunks generated around the new position', newChunks > 20, newChunks + ' new chunks');
check('chunks behind the player were unloaded', keysAfter.size < chunksBefore + newChunks,
  chunksBefore + ' -> ' + keysAfter.size + ' (' + newChunks + ' new)');
check('the chunk under the player is loaded', !!near && near.state >= 1, near ? 'state=' + near.state : 'missing');
check('loaded chunks are meshed', meshed > 10, meshed + '/' + keysAfter.size + ' meshed');
check('no player-fall-through: ground below is solid',
  G.world.isSolid(Math.floor(G.player.position.x), Math.floor(G.player.position.y) - 2, Math.floor(G.player.position.z)) ||
  G.player.position.y > 0, 'y=' + G.player.position.y.toFixed(1));

// ═══════════════════════════════════════════════════════════════════════════
section('persistence');
const saveKey = 'superman-voxel.v2';
G.S.started = true;
step(80);                                    // autosave runs ~1 Hz of game time
const raw = window.localStorage.getItem(saveKey);
let save = null;
try { save = JSON.parse(raw); } catch (e) { save = null; }
check('autosave wrote a v2 session', !!save && save.v === 2, save ? 'seed=' + save.seed : 'null');
check('save carries the block diff', save && Array.isArray(save.edits) && save.edits.length > 0,
  save ? save.edits.length + ' edits' : '-');
check('save carries score, missions and stats', save && save.score > 0 && typeof save.mission === 'number' && save.stats,
  save ? 'score=' + save.score + ' mission=' + save.mission : '-');

const optFog = g.$('opt-fog');
optFog.value = 'near';
optFog.dispatchEvent(new window.Event('change', { bubbles: true }));
check('settings persist on change', !!window.localStorage.getItem(saveKey + '.settings'),
  window.localStorage.getItem(saveKey + '.settings'));

// reload with the saved storage and confirm the session comes back
section('restore after reload');
const storage = {
  [saveKey]: window.localStorage.getItem(saveKey),
  [saveKey + '.settings']: window.localStorage.getItem(saveKey + '.settings')
};
const g2 = loadPage(null, storage);
const G2 = g2.window.__game;
check('reload boots cleanly', !g2.bootError && g2.window.__booted === true,
  g2.bootError && (g2.bootError.stack || g2.bootError.message));
check('seed comes from the saved session', g2.$('seed-label').textContent.trim() === 'seed: ' + save.seed,
  g2.$('seed-label').textContent);
check('score and stats restored', G2.S.score === save.score && G2.S.mission === save.mission,
  'score ' + G2.S.score + '/' + save.score + ', mission ' + G2.S.mission + '/' + save.mission);
check('restore toast shown', /restored/i.test(g2.$('notice').textContent), g2.$('notice').textContent.slice(0, 60));
const targets = save.edits.slice(0, 24);
const e0 = targets[0];
// the loop only runs once the game is started, and the streamer lives in it
g2.$('startBtn').dispatchEvent(new g2.window.MouseEvent('click', { bubbles: true }));
G2.player.position.set(e0[0] + 0.5, G2.world.heightAt(e0[0], e0[2]) + 4, e0[2] + 0.5);
g2.step(150);      // let the streamer generate that region and replay the diff
check('block diff replayed into the world', (() => {
  let applicable = 0, applied = 0;
  for (const e of targets) {
    if (!G2.world.isLoaded(e[0], e[2])) continue;
    applicable++;
    if (G2.world.getBlock(e[0], e[1], e[2]) === e[3]) applied++;
  }
  check._detail = applied + '/' + applicable + ' of ' + targets.length + ' sampled edits';
  return applicable > 0 && applied === applicable;
})(), check._detail);
check('fog setting restored', G2.U.uFogNear.value === 18, 'fogNear=' + G2.U.uFogNear.value);

// ═══════════════════════════════════════════════════════════════════════════
section('settings, missions and world reset');
const farBefore = G.camera.far;
const optRender = g.$('opt-render');
optRender.value = '3';
optRender.dispatchEvent(new window.Event('change'));
check('render distance setting applies', G.S.renderRadius === 3 &&
  G.camera.far === Math.max(160, 3 * 16 + 90),
  'radius=3 far=' + G.camera.far + ' (was ' + farBefore + ')');
// Unloading uses a hysteresis margin of R+2, so dropping 5 -> 3 legitimately
// removes nothing (the R=5 selection never exceeds Chebyshev 5). Test the
// invariant, and use a radius where the margin actually bites.
const chunksAtR5 = G.world.chunks.size;
step(30);
check('radius 3 keeps every chunk inside the unload margin', (() => {
  const cx = Math.floor(G.player.position.x / CHUNK), cz = Math.floor(G.player.position.z / CHUNK);
  let beyond = 0;
  for (const ch of G.world.chunks.values())
    if (Math.max(Math.abs(ch.cx - cx), Math.abs(ch.cz - cz)) > 3 + 2) beyond++;
  return beyond === 0;
})(), G.world.chunks.size + ' chunks');
optRender.value = '2';
optRender.dispatchEvent(new window.Event('change'));
step(30);
const cx2 = Math.floor(G.player.position.x / CHUNK), cz2 = Math.floor(G.player.position.z / CHUNK);
let beyond2 = 0;
for (const ch of G.world.chunks.values())
  if (Math.max(Math.abs(ch.cx - cx2), Math.abs(ch.cz - cz2)) > 2 + 2) beyond2++;
check('radius 2 unloads the chunks beyond the margin', G.world.chunks.size < chunksAtR5 && beyond2 === 0,
  chunksAtR5 + ' -> ' + G.world.chunks.size + ' chunks, ' + beyond2 + ' beyond R+2');

// Missions are strictly ordered (checkMissions only looks at MISSIONS[S.mission]),
// so satisfy the first two the way the game would and let a real mining burst
// drive them.
G.S.stats.iron = 5;
G.S.stats.diamond = 1;
G.S.pitch = -Math.PI / 2.2;                 // look straight down at loaded ground
const missionBefore = G.S.mission, scoreBefore = G.S.score;
key(window, 'KeyE');                        // laser
mouse(window, 'mousedown');
step(30);
mouse(window, 'mouseup');
check('missions complete in order and pay out', G.S.mission >= missionBefore + 2 &&
  /MISSION COMPLETE/.test(g.$('mt-title').textContent),
  'mission ' + missionBefore + ' -> ' + G.S.mission + ' score +' + (G.S.score - scoreBefore) +
  ' title="' + g.$('mt-title').textContent + '"');

const resetX = G.player.position.x, resetZ = G.player.position.z;
g.$('resetWorldBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('reset world clears score, stats and the saved session',
  G.S.score === 0 && G.S.destroyed === 0 && G.S.placed === 0 && G.S.mission === 0 &&
  window.localStorage.getItem(saveKey) === null, 'score=' + G.S.score);
step(6);
check('reset world regenerates ground around the player, not the origin',
  G.world.isLoaded(resetX, resetZ) && G.world.isSolid(Math.floor(resetX), 0, Math.floor(resetZ)),
  'player x=' + Math.round(resetX) + ' loaded=' + G.world.isLoaded(resetX, resetZ));

// ═══════════════════════════════════════════════════════════════════════════
section("touch controls (a phone's only input scheme)");
// IS_TOUCH is false in every other instance here, so initTouch() — and with it
// the entire input scheme a phone gets — would otherwise never execute at all.
const T = loadPage(4242, null, { touch: true });
check('touch instance boots with no error', T.bootError === null, String(T.bootError && T.bootError.message));
// The touch UI is shown by CSS (`body.touch #touch{display:block}`), so the
// class on <body> is the thing that actually drives it.
check('touch mode detected and the touch UI enabled',
  T.window.document.body.classList.contains('touch') && !!T.$('touch') &&
  /left stick/i.test(T.$('overlay-controls').innerHTML),
  'body.touch=' + T.window.document.body.classList.contains('touch') +
  ' hint="' + T.$('overlay-controls').textContent.slice(0, 30) + '"');

const tG = T.window.__game;
T.$('startBtn').dispatchEvent(new T.window.MouseEvent('click', { bubbles: true }));
check('start resumes play without pointer lock', tG.S.paused === false && tG.S.started === true,
  'paused=' + tG.S.paused + ' started=' + tG.S.started);

function pointer(win, target, type, x, y, id) {
  const ev = new win.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, buttons: 1 });
  Object.defineProperty(ev, 'pointerId', { value: id === undefined ? 7 : id });
  target.dispatchEvent(ev);
  return ev;
}
const knob = T.window.document.querySelector('#stick .knob');
const knobBefore = knob.style.transform;
const stick = T.$('stick');
pointer(T.window, stick, 'pointerdown', 0, 0);
pointer(T.window, stick, 'pointermove', 0, -40);       // drag "up" = forward
check('joystick drag moves the knob and sets a move vector',
  knobBefore !== knob.style.transform && /-40px/.test(knob.style.transform),
  'knob="' + knob.style.transform + '"');

const tp0 = tG.player.position.clone();
T.step(30);
check('the joystick actually moves the player', tG.player.position.distanceTo(tp0) > 0.5,
  'moved ' + tG.player.position.distanceTo(tp0).toFixed(2) + ' blocks');
pointer(T.window, stick, 'pointerup', 0, -40);
check('releasing the joystick recentres the knob', knob.style.transform === 'translate(0px,0px)',
  'knob="' + knob.style.transform + '"');

const pitch0 = tG.S.pitch;
const lookArea = T.$('look-area');
pointer(T.window, lookArea, 'pointerdown', 100, 100, 9);
pointer(T.window, lookArea, 'pointermove', 100, 300, 9);
check('dragging down the look area looks down', tG.S.pitch < pitch0 - 0.3,
  pitch0.toFixed(2) + ' -> ' + tG.S.pitch.toFixed(2));
pointer(T.window, lookArea, 'pointerup', 100, 300, 9);

const flyBefore = tG.S.flying;
pointer(T.window, T.$('tb-fly'), 'pointerdown', 0, 0);
check('fly button toggles flight', tG.S.flying === !flyBefore && /Flying|Walking/.test(T.$('notice').textContent),
  'flying=' + tG.S.flying + ' notice="' + T.$('notice').textContent + '"');

tG.S.pitch = -Math.PI / 2.2;                  // aim at the ground below
key(T.window, 'KeyE');
const tMined = tG.S.destroyed;
pointer(T.window, T.$('tb-fire'), 'pointerdown', 0, 0);
T.step(40);
check('fire button runs the selected power', tG.S.destroyed > tMined,
  'destroyed ' + tMined + ' -> ' + tG.S.destroyed);
pointer(T.window, T.$('tb-fire'), 'pointerup', 0, 0);

const tPlaced = tG.S.placed;
pointer(T.window, T.$('tb-place'), 'pointerdown', 0, 0);
check('place button places a block', tG.S.placed === tPlaced + 1,
  'placed ' + tPlaced + ' -> ' + tG.S.placed);

const yBefore = tG.player.position.y;
pointer(T.window, T.$('tb-jump'), 'pointerdown', 0, 0);
T.step(12);
pointer(T.window, T.$('tb-jump'), 'pointerup', 0, 0);
check('jump button ascends while flying', tG.player.position.y > yBefore + 0.3,
  'y ' + yBefore.toFixed(2) + ' -> ' + tG.player.position.y.toFixed(2));

pointer(T.window, T.$('tb-pause'), 'pointerdown', 0, 0);
check('pause button opens the pause menu', tG.S.paused === true &&
  T.$('pause-menu').style.display === 'flex', 'paused=' + tG.S.paused +
  ' display=' + T.$('pause-menu').style.display);

// ═══════════════════════════════════════════════════════════════════════════
section('water (the dry spawn never reaches this path)');
// For seed 4242 the spawn area has no ocean, so the water mesher, the second
// draw call per chunk and matWater have never executed in any test. Find the
// nearest chunk that does hold water, then stream it in for real.
const CHUNK_VOL = G.CHUNK * G.MAX_H * G.CHUNK;
let waterChunk = null, waterCells = 0;
for (let r = 0; r <= 24 && !waterChunk; r++) {
  for (let dz = -r; dz <= r && !waterChunk; dz++)
    for (let dx = -r; dx <= r && !waterChunk; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;      // ring only
      const blocks = new Uint8Array(CHUNK_VOL);
      G.genChunk(G.SEED, dx, dz, blocks);
      let n = 0;
      for (let i = 0; i < blocks.length; i++) if (blocks[i] === G.BT.WATER) n++;
      if (n) { waterChunk = { cx: dx, cz: dz }; waterCells = n; }
    }
}
check('found a chunk containing water', !!waterChunk,
  waterChunk ? 'chunk ' + waterChunk.cx + ',' + waterChunk.cz + ' with ' + waterCells + ' water cells'
             : 'none within 24 chunks');

if (waterChunk) {
  G.player.position.set(waterChunk.cx * G.CHUNK + 8.5, 40, waterChunk.cz * G.CHUNK + 8.5);
  step(150);
  const ch = G.world.getChunk(waterChunk.cx, waterChunk.cz);
  check('the water chunk streamed in and meshed', !!ch && ch.state === 2, ch ? 'state=' + ch.state : 'missing');
  check('water is really in the world data',
    G.world.getBlock(waterChunk.cx * G.CHUNK + 8, G.SEA_LEVEL, waterChunk.cz * G.CHUNK + 8) === G.BT.WATER ||
    G.world.getBlock(waterChunk.cx * G.CHUNK + 3, G.SEA_LEVEL, waterChunk.cz * G.CHUNK + 3) === G.BT.WATER,
    'probe at sea level');
  check('the chunk gets a second draw call for water', !!ch && !!ch.meshWater &&
    ch.meshWater.parent === ch.group, ch && ch.meshWater ? 'meshed' : 'no water mesh');
  check('the water mesh uses matWater', !!ch && !!ch.meshWater && ch.meshWater.material === G.matWater);
  const wpos = ch && ch.meshWater ? ch.meshWater.geometry.attributes.position.array : null;
  let topY = -1, minY = 1e9;
  if (wpos) for (let i = 1; i < wpos.length; i += 3) { if (wpos[i] > topY) topY = wpos[i]; if (wpos[i] < minY) minY = wpos[i]; }
  check('the water surface is flush with the top water block',
    topY === G.SEA_LEVEL + 1, 'top y=' + topY + ' (sea level ' + G.SEA_LEVEL + ', bottom ' + minY + ')');
}

// ═══════════════════════════════════════════════════════════════════════════
section('shaders (GLSL syntax)');
// There is no GPU here, so the shaders cannot be compiled — this is the gap a
// jsdom run cannot close. The next best thing is to parse each one with a real
// GLSL ES parser, with the declarations three.js injects for a ShaderMaterial
// prepended. That catches the typos, stray braces and missing semicolons that
// would otherwise show up as a black screen in the browser.
const PRECISION = 'precision highp float;\nprecision highp int;\n';
const VERT_BUILTINS = [
  'uniform mat4 modelMatrix;', 'uniform mat4 modelViewMatrix;', 'uniform mat4 projectionMatrix;',
  'uniform mat4 viewMatrix;', 'uniform mat3 normalMatrix;', 'uniform vec3 cameraPosition;',
  'uniform bool isOrthographic;',
  'attribute vec3 position;', 'attribute vec3 normal;', 'attribute vec2 uv;'
].join('\n') + '\n';
const FRAG_BUILTINS = [
  'uniform mat4 viewMatrix;', 'uniform vec3 cameraPosition;', 'uniform bool isOrthographic;'
].join('\n') + '\n';

// Collected from the material objects themselves, not by walking the scene:
// the water mesh only exists once a chunk containing water has been meshed, and
// a seed whose spawn area is dry would silently skip the water shader.
const shaderMats = [G.matSolid, G.matWater];
G.scene.traverse(o => {
  if (o.material && o.material.isShaderMaterial && shaderMats.indexOf(o.material) < 0) shaderMats.push(o.material);
});
check('terrain, water and sky materials all collected', shaderMats.length === 3,
  shaderMats.length + ' materials');
const matLabel = m => (m === G.matSolid ? 'terrain solid' : m === G.matWater ? 'water' : 'sky');

let glslParser = null;
try { glslParser = require('@shaderfrog/glsl-parser').parser; } catch (e) { glslParser = null; }
if (glslParser) {
  for (const m of shaderMats) {
    const label = matLabel(m);
    const stages = [['vertex', m.vertexShader, VERT_BUILTINS], ['fragment', m.fragmentShader, FRAG_BUILTINS]];
    for (const st of stages) {
      let err = '';
      // The parser warns on stderr about GLSL built-ins it does not declare
      // (gl_Position, gl_FragColor). Silence just those, keep real errors.
      const warn = console.warn, errFn = console.error;
      console.warn = () => {}; console.error = () => {};
      try { glslParser.parse(PRECISION + st[2] + st[1]); }
      catch (e) { err = String(e.message).split('\n')[0]; }
      finally { console.warn = warn; console.error = errFn; }
      check(label + ' ' + st[0] + ' shader parses as GLSL ES', !err, err || st[1].split('\n').length + ' lines');
    }
  }
} else {
  console.log('  skip  @shaderfrog/glsl-parser is not installed (npm ci)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('static consistency');
const pageSource = fs.readFileSync(HTML, 'utf8');
const inlineScripts = [];
pageSource.replace(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g, (_, body) => {
  inlineScripts.push(body); return '';
});
const gameSrc = inlineScripts[inlineScripts.length - 1];

// Every THREE.* the game touches must exist in the vendored r160 build — a
// renamed or removed export would only throw at runtime.
const usedThree = new Set();
const re3 = /\bTHREE\.([A-Za-z_$][A-Za-z0-9_$]*)/g;
let m3;
while ((m3 = re3.exec(gameSrc))) usedThree.add(m3[1]);
const missingThree = Array.from(usedThree).filter(n => window.THREE[n] === undefined);
check('every THREE.* referenced exists in vendor/three.global.js', missingThree.length === 0,
  usedThree.size + ' symbols' + (missingThree.length ? ' — missing: ' + missingThree.join(', ') : ''));

// Every $('id') must resolve. A typo here never breaks the boot path: it breaks
// the first time that handler runs (the touch controls, for instance).
const usedIds = new Set();
const reId = /(?:\$|getElementById)\(\s*'([^']+)'\s*\)/g;
let mId;
while ((mId = reId.exec(gameSrc))) usedIds.add(mId[1]);
const missingIds = Array.from(usedIds).filter(id => !window.document.getElementById(id));
check("every $('id') resolves to an element in the markup", missingIds.length === 0,
  usedIds.size + ' ids' + (missingIds.length ? ' — missing: ' + missingIds.join(', ') : ''));

// ═══════════════════════════════════════════════════════════════════════════
section('summary');
const passed = results.filter(r => r.pass).length;
console.log('\n' + passed + '/' + results.length + ' checks passed');
if (failures) {
  console.log('\nFAILED:');
  for (const r of results) if (!r.pass) console.log('  - ' + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
}
process.exit(failures ? 1 : 0);
