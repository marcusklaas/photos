/**
 * Generates a throwaway media set in ./fixture so the stream page can be built,
 * styled and perf-tested with no network and no GitHub. Procedural images, so
 * there is nothing real to leak. Run: node scripts/make-fixture.mjs
 */
import encode, { init as initAvif } from '@jsquash/avif/encode.js';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Node's fetch cannot load file:// URLs, so emscripten's own wasm fetch fails.
// Compile it here and hand the module to init() instead.
const wasmPath = new URL('../node_modules/@jsquash/avif/codec/enc/avif_enc.wasm', import.meta.url);
await initAvif(await WebAssembly.compile(await readFile(wasmPath)));

const WIDTHS = [800];
// Fixtures are throwaway; don't spend real encode time on them.
const OPTS = { quality: 55, speed: 8, subsample: 1 };

/** Deterministic PRNG so re-running produces identical fixtures. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Procedural portrait image: soft gradient plus a few blurred blobs. */
function generate(seed, w, h) {
  const r = rng(seed);
  const hueA = r() * 360, hueB = hueA + 60 + r() * 120;
  const blobs = Array.from({ length: 4 }, () => ({
    x: r() * w, y: r() * h, rad: (0.2 + r() * 0.35) * Math.min(w, h),
    h: r() * 360, a: 0.25 + r() * 0.4,
  }));

  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x / w) * 0.35 + (y / h) * 0.65;
      let [rr, gg, bb] = hsl(hueA + (hueB - hueA) * t, 0.45, 0.35 + t * 0.3);
      for (const b of blobs) {
        const d = Math.hypot(x - b.x, y - b.y) / b.rad;
        if (d < 1) {
          const k = (1 - d) ** 2 * b.a;
          const [br, bg, bl] = hsl(b.h, 0.55, 0.6);
          rr += (br - rr) * k; gg += (bg - gg) * k; bb += (bl - bb) * k;
        }
      }
      const i = (y * w + x) * 4;
      data[i] = rr; data[i + 1] = gg; data[i + 2] = bb; data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

function hsl(hDeg, s, l) {
  const h = ((hDeg % 360) + 360) % 360 / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (tc) => {
    let t = tc; if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/** Box downscale by an integer-ish factor. Good enough for fixtures. */
function resize(img, tw) {
  const th = Math.round((img.height / img.width) * tw);
  const out = new Uint8ClampedArray(tw * th * 4);
  const sx = img.width / tw, sy = img.height / th;
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.min(img.height, Math.ceil((y + 1) * sy));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.min(img.width, Math.ceil((x + 1) * sx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = (yy * img.width + xx) * 4;
        r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
      }
      const o = (y * tw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { data: out, width: tw, height: th };
}

function dominant(img) {
  let r = 0, g = 0, b = 0;
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) { r += img.data[i * 4]; g += img.data[i * 4 + 1]; b += img.data[i * 4 + 2]; }
  const hex = (v) => Math.round(v / n).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// Varied metadata, deliberately including a photo with no metadata at all so
// the no-caption path gets exercised.
const META = [
  { t: '2026-08-14T18:22:10', g: [38.7223, -9.1393], d: 'Late light on the way down from the castle.' },
  { t: '2026-08-02T09:05:00', g: [52.3676, 4.9041] },
  { t: '2026-07-19T14:48:33', d: 'Timestamp kept, location stripped.' },
  { t: '2026-06-30T20:15:00', g: [46.5197, 6.6323] },
  { t: '2026-05-25T16:40:00', d: 'No location, description only.' },
  { t: '2026-05-11T11:00:00' },
];

// Portrait-leaning shapes, plus one landscape to check the layout holds.
const SHAPES = [[3, 4], [3, 4], [4, 3], [2, 3], [3, 4], [1, 1]];

await rm('fixture', { recursive: true, force: true });
await mkdir('fixture/p', { recursive: true });
await mkdir('fixture/m', { recursive: true });

const photos = [];
for (let i = 0; i < META.length; i++) {
  const [aw, ah] = SHAPES[i];
  const full = generate(i * 7919 + 13, 800, Math.round((800 * ah) / aw));
  const variants = {};
  for (const w of WIDTHS) variants[w] = w === 800 ? full : resize(full, w);

  const encoded = {};
  for (const w of WIDTHS) {
    encoded[w] = Buffer.from(await encode(variants[w], OPTS));
    process.stdout.write(`  ${i + 1}/${META.length} @${w}w -> ${(encoded[w].length / 1024).toFixed(1)}kB\n`);
  }

  const id = createHash('sha256').update(encoded[800]).digest('hex').slice(0, 16);
  for (const w of WIDTHS) await writeFile(`fixture/p/${id}-${w}.avif`, encoded[w]);

  photos.push({
    id, w: full.width, h: full.height, v: WIDTHS,
    c: dominant(variants[800]), ...META[i],
  });
}

// Shards are ordered oldest-first BY TIMESTAMP, which is what the stream reads.
photos.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
await writeFile('fixture/m/0000.json', JSON.stringify(photos));
await writeFile('fixture/index.json', JSON.stringify({
  version: 1, shardSize: 100, total: photos.length,
  shards: [{ file: '0000.json', count: photos.length }],
}, null, 2));
await writeFile('fixture/.nojekyll', '');
console.log(`\nfixture: ${photos.length} photos`);
