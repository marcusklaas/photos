/**
 * Measures AVIF size and encode time across encoder settings, on YOUR photos.
 *
 *   node scripts/bench.mjs photo.jpg [more.jpg ...]
 *   node scripts/bench.mjs --sweep speed   photo.jpg
 *   node scripts/bench.mjs --sweep quality photo.jpg
 *
 * With no --sweep it runs the real quality ladder, rung by rung, exactly as the
 * uploader does -- so it answers the two questions worth asking about
 * QUALITY_LADDER and BUDGET_BYTES_PER_MPX: what does a photo cost, and does the
 * budget bite often enough (or too often) on the photos you actually publish.
 *
 * Synthetic test images are useless for this: fine grain dominates the bitrate
 * and behaves nothing like real detail. Point it at photos you would actually
 * publish, at the size we actually publish (default 800px wide).
 */
import encodeAvif, { init as initAvif } from '@jsquash/avif/encode.js';
import decodeJpeg, { init as initJpeg } from '@jsquash/jpeg/decode.js';
import decodePng, { init as initPng } from '@jsquash/png/decode.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ENCODE,
  WIDTHS,
  QUALITY_LADDER,
  budgetFor,
  encodeWithinBudget,
} from '../src/encode-settings.ts';

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
  return { buf, bytes: buf.byteLength, ms: Date.now() - t };
}

const SWEEPS = {
  speed: [0, 2, 4, 5, 6, 8],
  quality: [35, 45, 55, 62, 68, 75, 85],
};

/** Which rung photos settle on -- i.e. how often the budget actually bites. */
const landed = new Map();
let totalBytes = 0;
let totalMs = 0;
let count = 0;

for (const file of files) {
  const { source, img } = await load(file);
  console.log(`\n${path.basename(file)}  ${img.width}x${img.height}  (source ${kB(source).trim()})`);

  if (!sweep) {
    const budget = budgetFor(img.width, img.height);
    console.log(
      `  ladder ${QUALITY_LADDER.join(' -> ')} at speed ${ENCODE.speed}, budget ${kB(budget).trim()}`,
    );

    const started = Date.now();
    let kept = 0;
    const { quality } = await encodeWithinBudget(img.width, img.height, async (q) => {
      const r = await measure(img, { ...ENCODE, quality: q });
      kept = r.bytes;
      const over = ((r.bytes / budget - 1) * 100).toFixed(0);
      const verdict = r.bytes <= budget ? 'fits' : `over budget by ${over}%`;
      console.log(`    quality ${String(q).padStart(3)}  ${kB(r.bytes)}  ${secs(r.ms)}   ${verdict}`);
      return r.buf;
    });

    const ms = Date.now() - started;
    const pct = ((kept / source) * 100).toFixed(1);
    console.log(`  published at quality ${quality}: ${kB(kept).trim()} in ${secs(ms).trim()}  (${pct}% of source)`);
    landed.set(quality, (landed.get(quality) ?? 0) + 1);
    totalBytes += kept;
    totalMs += ms;
    count++;
    continue;
  }

  const values = SWEEPS[sweep];
  if (!values) {
    console.error(`unknown sweep "${sweep}" (use: ${Object.keys(SWEEPS).join(', ')})`);
    process.exit(1);
  }
  console.log(`  ${sweep} sweep, top rung (quality ${QUALITY_LADDER[0]}) unless swept:`);
  let best = null;
  for (const v of values) {
    const r = await measure(img, { ...ENCODE, quality: QUALITY_LADDER[0], [sweep]: v });
    if (!best || r.bytes < best.bytes) best = { v, ...r };
    console.log(`    ${sweep}=${String(v).padStart(3)}  ${kB(r.bytes)}  ${secs(r.ms)}`);
  }
  console.log(`  smallest: ${sweep}=${best.v} at ${kB(best.bytes).trim()}`);
}

if (!sweep && count) {
  const rungs = [...landed.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([q, n]) => `${n} at quality ${q}`)
    .join(', ');
  console.log(`\n${count} photo${count === 1 ? '' : 's'}: ${rungs}`);
  console.log(
    `average ${kB(totalBytes / count).trim()} in ${secs(totalMs / count).trim()} each.` +
    `\nIf nothing ever leaves the top rung the budget is too loose; if most photos` +
    `\nfall to the floor it is too tight and you are paying for encodes you throw away.`,
  );
}

console.log(
  '\nSize is only half the answer -- decode the results and look at them before' +
  '\ntrusting a number. Encode time here is Node; the browser is single-threaded' +
  '\nwasm on GitHub Pages, so treat these as a lower bound.',
);
