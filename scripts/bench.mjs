/**
 * Measures AVIF size and encode time across encoder settings, on YOUR photos.
 *
 *   node scripts/bench.mjs photo.jpg [more.jpg ...]
 *   node scripts/bench.mjs --sweep speed   photo.jpg
 *   node scripts/bench.mjs --sweep quality photo.jpg
 *
 * Synthetic test images are useless for this: fine grain dominates the bitrate
 * and behaves nothing like real detail. Point it at photos you would actually
 * publish, at the size we actually publish (default 1600px wide).
 */
import encodeAvif, { init as initAvif } from '@jsquash/avif/encode.js';
import decodeJpeg, { init as initJpeg } from '@jsquash/jpeg/decode.js';
import decodePng, { init as initPng } from '@jsquash/png/decode.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ENCODE, WIDTHS } from '../src/encode-settings.ts';

const args = process.argv.slice(2);
let sweep = null;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--sweep') sweep = args[++i];
  else files.push(args[i]);
}

if (!files.length) {
  console.error('usage: node scripts/bench.mjs [--sweep speed|quality] <image> [...]');
  process.exit(1);
}

const NM = new URL('../node_modules/', import.meta.url);
const compile = async (rel) => WebAssembly.compile(await readFile(new URL(rel, NM)));
await initAvif(await compile('@jsquash/avif/codec/enc/avif_enc.wasm'));
await initJpeg(await compile('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm'));
await initPng(await compile('@jsquash/png/codec/pkg/squoosh_png_bg.wasm'));

const TARGET = Number(process.env.BENCH_WIDTH ?? WIDTHS[WIDTHS.length - 1]);

/** Box downscale, matching the shape of what the worker does in the browser. */
function resize(img, tw) {
  if (img.width <= tw) return img;
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

async function load(file) {
  const bytes = new Uint8Array(await readFile(file));
  const ext = path.extname(file).toLowerCase();
  const raw = ext === '.png' ? await decodePng(bytes) : await decodeJpeg(bytes);
  return { source: bytes.length, img: resize(raw, TARGET) };
}

const kB = (n) => `${(n / 1024).toFixed(0).padStart(5)} kB`;
const secs = (ms) => `${(ms / 1000).toFixed(1).padStart(6)}s`;

async function measure(img, opts) {
  const t = Date.now();
  const buf = await encodeAvif(img, opts);
  return { bytes: buf.byteLength, ms: Date.now() - t };
}

const SWEEPS = {
  speed: [0, 2, 4, 6, 8, 10],
  quality: [35, 45, 55, 65, 75, 85],
};

for (const file of files) {
  const { source, img } = await load(file);
  console.log(`\n${path.basename(file)}  ${img.width}x${img.height}  (source ${kB(source).trim()})`);

  if (!sweep) {
    const r = await measure(img, ENCODE);
    const pct = ((r.bytes / source) * 100).toFixed(1);
    console.log(`  current settings (quality ${ENCODE.quality}, speed ${ENCODE.speed})`);
    console.log(`  ${kB(r.bytes)}  ${secs(r.ms)}   ${pct}% of source`);
    continue;
  }

  const values = SWEEPS[sweep];
  if (!values) {
    console.error(`unknown sweep "${sweep}" (use: ${Object.keys(SWEEPS).join(', ')})`);
    process.exit(1);
  }
  console.log(`  ${sweep} sweep, everything else at current settings:`);
  let best = null;
  for (const v of values) {
    const r = await measure(img, { ...ENCODE, [sweep]: v });
    if (!best || r.bytes < best.bytes) best = { v, ...r };
    console.log(`    ${sweep}=${String(v).padStart(3)}  ${kB(r.bytes)}  ${secs(r.ms)}`);
  }
  console.log(`  smallest: ${sweep}=${best.v} at ${kB(best.bytes).trim()}`);
}

console.log(
  '\nSize is only half the answer -- decode the results and look at them before' +
  '\ntrusting a number. Encode time here is Node; the browser is single-threaded' +
  '\nwasm on GitHub Pages, so treat these as a lower bound.',
);
