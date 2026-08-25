/** Encode at two qualities, decode both, measure how far each is from the source. */
import encodeAvif, { init as initEnc } from '@jsquash/avif/encode.js';
import decodeAvif, { init as initDec } from '@jsquash/avif/decode.js';
import encodeJpeg, { init as initJpegEnc } from '@jsquash/jpeg/encode.js';
import decodeJpeg, { init as initJpegDec } from '@jsquash/jpeg/decode.js';
import { readFile, writeFile } from 'node:fs/promises';
import { ENCODE } from './src/encode-settings.ts';

const NM = new URL('./node_modules/', import.meta.url);
const c = async (p) => WebAssembly.compile(await readFile(new URL(p, NM)));
await initEnc(await c('@jsquash/avif/codec/enc/avif_enc.wasm'));
await initDec(await c('@jsquash/avif/codec/dec/avif_dec.wasm'));
await initJpegEnc(await c('@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm'));
await initJpegDec(await c('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm'));

const W = 800, H = 1000;
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function fractal(seed, octaves, persistence) {
  const r = rng(seed); const layers = [];
  for (let o = 0; o < octaves; o++) {
    const n = 2 << o, grid = new Float64Array((n + 1) * (n + 1));
    for (let i = 0; i < grid.length; i++) grid[i] = r();
    layers.push({ n, grid, amp: persistence ** o });
  }
  const out = new Float64Array(W * H); let norm = 0;
  for (const { n, grid, amp } of layers) {
    norm += amp;
    for (let y = 0; y < H; y++) {
      const fy = (y / H) * n, y0 = Math.floor(fy), ty = fy - y0;
      for (let x = 0; x < W; x++) {
        const fx = (x / W) * n, x0 = Math.floor(fx), tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const a = grid[y0 * (n + 1) + x0], b = grid[y0 * (n + 1) + x0 + 1];
        const d0 = grid[(y0 + 1) * (n + 1) + x0], d1 = grid[(y0 + 1) * (n + 1) + x0 + 1];
        const top = a + (b - a) * sx, bot = d0 + (d1 - d0) * sx;
        out[y * W + x] += amp * (top + (bot - top) * sy);
      }
    }
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}
function toImage(fn) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, b] = fn(x, y); const i = (y * W + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  return { data, width: W, height: H };
}
const lowA = fractal(1, 2, 0.5);
const low = toImage((x, y) => { const t = (x / W) * 0.3 + (y / H) * 0.7, n = lowA[y * W + x];
  return [60 + t * 120 + n * 30, 90 + t * 110 + n * 25, 140 + t * 80 + n * 20]; });
const mA = fractal(2, 6, 0.55), mB = fractal(3, 6, 0.55);
const mid = toImage((x, y) => { const a = mA[y * W + x], b = mB[y * W + x];
  return [40 + a * 200, 50 + b * 190, 70 + (a + b) * 80]; });
const bA = fractal(4, 9, 0.72), bB = fractal(5, 9, 0.72), bC = fractal(6, 9, 0.72);
const busy = toImage((x, y) => { const i = y * W + x;
  return [30 + bA[i] * 220, 30 + bB[i] * 220, 30 + bC[i] * 220]; });

const lum = (img) => {
  const g = new Float64Array(img.width * img.height);
  for (let i = 0; i < g.length; i++)
    g[i] = 0.2126 * img.data[i * 4] + 0.7152 * img.data[i * 4 + 1] + 0.0722 * img.data[i * 4 + 2];
  return g;
};

function psnr(a, b) {
  let se = 0;
  for (let i = 0; i < a.data.length; i++) if (i % 4 !== 3) se += (a.data[i] - b.data[i]) ** 2;
  const mse = se / ((a.data.length / 4) * 3);
  return 10 * Math.log10(255 * 255 / mse);
}

/** Global SSIM over 8x8 windows on luma. */
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

const QUALS = [55, 62, 68];
console.log('image  quality      size     PSNR      SSIM   (vs the source pixels)');
for (const [name, img] of [['low', low], ['mid', mid], ['busy', busy]]) {
  const srcLum = lum(img);
  for (const q of QUALS) {
    const buf = await encodeAvif(img, { ...ENCODE, quality: q });
    const dec = await decodeAvif(buf);
    const p = psnr(img, dec);
    const s = ssim(srcLum, lum(dec), W, H);
    console.log(`${name.padEnd(5)} ${String(q).padStart(8)} ${(buf.byteLength / 1024).toFixed(1).padStart(8)} kB ${p.toFixed(2).padStart(7)} dB  ${s.toFixed(5)}`);
  }
}
