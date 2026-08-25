/**
 * Measures AVIF size and encode time across encoder settings, on YOUR photos.
 *
 *   node scripts/bench.mjs photo.jpg [more.jpg ...]
 *   node scripts/bench.mjs --compare 55,68 photo.jpg   # can you see the difference?
 *   node scripts/bench.mjs --sweep speed   photo.jpg
 *   node scripts/bench.mjs --sweep quality photo.jpg
 *
 * With no flags it encodes at ENCODE_DEFAULTS, which is what the upload page
 * uses until you override it there.
 *
 * --compare answers the question the other modes cannot: can you see it. It
 * encodes at each quality given (default: the old fixed 55 against the current
 * default), decodes them back, prints how far each landed from the source
 * pixels, and writes the decoded results to bench-out/ as PNG so you can flip
 * between them at 1:1. Numbers first, but the numbers are not the verdict --
 * your eyes are.
 *
 * Synthetic test images are useless for this: fine grain dominates the bitrate
 * and behaves nothing like real detail. Point it at photos you would actually
 * publish, at the size we actually publish (default 800px wide).
 */
import encodeAvif, { init as initAvif } from '@jsquash/avif/encode.js';
import decodeAvif, { init as initAvifDec } from '@jsquash/avif/decode.js';
import decodeJpeg, { init as initJpeg } from '@jsquash/jpeg/decode.js';
import decodePng, { init as initPng } from '@jsquash/png/decode.js';
import encodePng, { init as initPngEnc } from '@jsquash/png/encode.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ENCODE_DEFAULTS, ENCODE_BOUNDS, WIDTHS } from '../src/encode-settings.ts';

const args = process.argv.slice(2);
let sweep = null;
let compare = null;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--sweep') sweep = args[++i];
  else if (args[i] === '--compare') {
    // The qualities are optional: "--compare 55,68 a.jpg" or just "--compare a.jpg".
    const next = /^\d+(,\d+)*$/.test(args[i + 1] ?? '') ? args[++i] : '';
    compare = next ? next.split(',').map(Number) : [55, ENCODE_DEFAULTS.quality];
  } else files.push(args[i]);
}

if (!files.length) {
  console.error(
    'usage: node scripts/bench.mjs [--compare [q,q]] [--sweep speed|quality] <image> [...]',
  );
  process.exit(1);
}

const badQuality = (compare ?? []).find(
  (q) => q < ENCODE_BOUNDS.quality.min || q > ENCODE_BOUNDS.quality.max,
);
if (badQuality !== undefined) {
  console.error(
    `quality ${badQuality} is outside ${ENCODE_BOUNDS.quality.min}-${ENCODE_BOUNDS.quality.max}`,
  );
  process.exit(1);
}

const NM = new URL('../node_modules/', import.meta.url);
const compile = async (rel) => WebAssembly.compile(await readFile(new URL(rel, NM)));
await initAvif(await compile('@jsquash/avif/codec/enc/avif_enc.wasm'));
await initJpeg(await compile('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm'));
await initPng(await compile('@jsquash/png/codec/pkg/squoosh_png_bg.wasm'));
if (compare) {
  await initAvifDec(await compile('@jsquash/avif/codec/dec/avif_dec.wasm'));
  await initPngEnc(await compile('@jsquash/png/codec/pkg/squoosh_png_bg.wasm'));
}

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

/**
 * Distortion against the source pixels. PSNR is blunt but comparable across
 * rungs; SSIM tracks structure, which is closer to what "looks worse" means.
 * Neither is a verdict -- --compare writes the decoded PNGs so you can look.
 */
function psnr(a, b) {
  let se = 0;
  for (let i = 0; i < a.data.length; i++) if (i % 4 !== 3) se += (a.data[i] - b.data[i]) ** 2;
  const mse = se / ((a.data.length / 4) * 3);
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

const luma = (img) => {
  const g = new Float64Array(img.width * img.height);
  for (let i = 0; i < g.length; i++)
    g[i] = 0.2126 * img.data[i * 4] + 0.7152 * img.data[i * 4 + 1] + 0.0722 * img.data[i * 4 + 2];
  return g;
};

/** Mean SSIM over 8x8 luma windows, stepped by 4. */
function ssim(a, b, w, h) {
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  let total = 0, n = 0;
  for (let by = 0; by + 8 <= h; by += 4) {
    for (let bx = 0; bx + 8 <= w; bx += 4) {
      let ma = 0, mb = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        ma += a[(by + y) * w + bx + x]; mb += b[(by + y) * w + bx + x];
      }
      ma /= 64; mb /= 64;
      let va = 0, vb = 0, cov = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const da = a[(by + y) * w + bx + x] - ma, db = b[(by + y) * w + bx + x] - mb;
        va += da * da; vb += db * db; cov += da * db;
      }
      va /= 63; vb /= 63; cov /= 63;
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      n++;
    }
  }
  return total / n;
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

let totalBytes = 0;
let totalMs = 0;
let count = 0;

if (compare) await mkdir('bench-out', { recursive: true });

for (const file of files) {
  const { source, img } = await load(file);
  console.log(`\n${path.basename(file)}  ${img.width}x${img.height}  (source ${kB(source).trim()})`);

  if (compare) {
    const srcLuma = luma(img);
    const stem = path.basename(file, path.extname(file));
    let ref = null;

    for (const q of compare) {
      const r = await measure(img, { ...ENCODE_DEFAULTS, quality: q });
      const back = await decodeAvif(r.buf);
      const db = psnr(img, back);
      const ss = ssim(srcLuma, luma(back), img.width, img.height);
      const out = `bench-out/${stem}-q${q}.png`;
      await writeFile(out, Buffer.from(await encodePng(back)));

      const delta = ref
        ? `  ${db - ref.db >= 0 ? '+' : ''}${(db - ref.db).toFixed(2)} dB, ${(((r.bytes / ref.bytes) - 1) * 100).toFixed(0)}% bytes vs quality ${compare[0]}`
        : '  (the reference)';
      console.log(
        `  quality ${String(q).padStart(3)}  ${kB(r.bytes)}  ${db.toFixed(2).padStart(6)} dB  SSIM ${ss.toFixed(5)}${delta}`,
      );
      console.log(`            wrote ${out}`);
      ref ??= { db, bytes: r.bytes };
    }
    console.log('  Open them at 100% and flip between them. If you cannot tell which is');
    console.log('  which, the higher quality is not earning its bytes on photos like this.');
    continue;
  }

  if (!sweep) {
    const r = await measure(img, ENCODE_DEFAULTS);
    const pct = ((r.bytes / source) * 100).toFixed(1);
    console.log(
      `  defaults (quality ${ENCODE_DEFAULTS.quality}, speed ${ENCODE_DEFAULTS.speed}` +
      `${ENCODE_DEFAULTS.enableSharpYUV ? ', sharp YUV' : ''})`,
    );
    console.log(`  ${kB(r.bytes)}  ${secs(r.ms)}   ${pct}% of source`);
    totalBytes += r.bytes;
    totalMs += r.ms;
    count++;
    continue;
  }

  const values = SWEEPS[sweep];
  if (!values) {
    console.error(`unknown sweep "${sweep}" (use: ${Object.keys(SWEEPS).join(', ')})`);
    process.exit(1);
  }
  console.log(`  ${sweep} sweep, other settings left at the defaults:`);
  let best = null;
  for (const v of values) {
    const r = await measure(img, { ...ENCODE_DEFAULTS, [sweep]: v });
    if (!best || r.bytes < best.bytes) best = { v, ...r };
    console.log(`    ${sweep}=${String(v).padStart(3)}  ${kB(r.bytes)}  ${secs(r.ms)}`);
  }
  console.log(`  smallest: ${sweep}=${best.v} at ${kB(best.bytes).trim()}`);
}

if (!sweep && !compare && count) {
  console.log(
    `\n${count} photo${count === 1 ? '' : 's'}: average ${kB(totalBytes / count).trim()}` +
    ` in ${secs(totalMs / count).trim()} each`,
  );
}

console.log(
  '\nSize is only half the answer -- decode the results and look at them before' +
  '\ntrusting a number. Encode time here is Node; the browser is single-threaded' +
  '\nwasm on GitHub Pages, so treat these as a lower bound.',
);
