/// <reference lib="webworker" />
import encode, { init as initAvif } from '@jsquash/avif/encode.js';
import wasmUrl from '@jsquash/avif/codec/enc/avif_enc.wasm';
import { WIDTHS, type EncodeSettings } from '../config.js';

// Settings ride along with the file: they live in localStorage, which a worker
// cannot read, so the page has to hand them over with the job.
export type EncodeRequest = { jobId: number; file: File; encode: EncodeSettings };
export type EncodeResponse =
  | { jobId: number; ok: true; w: number; h: number; c: string; variants: [number, ArrayBuffer][] }
  | { jobId: number; ok: false; error: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// Emscripten would otherwise fetch the wasm from a path it guesses at runtime.
// Compile it ourselves from the URL esbuild gave us, so the bundle is honest
// about its own assets. threads() is false on GitHub Pages anyway (no COOP/COEP
// means no SharedArrayBuffer), so this is the single-threaded build regardless.
let ready: Promise<unknown> | null = null;
const ensureReady = (): Promise<unknown> =>
  (ready ??= WebAssembly.compileStreaming(fetch(wasmUrl)).then((m) => initAvif(m)));

function ctxOf(c: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const g = c.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!g) throw new Error('no 2d context');
  return g as OffscreenCanvasRenderingContext2D;
}

/**
 * Downscale in halving steps. A single big-ratio drawImage aliases badly no
 * matter what imageSmoothingQuality claims; halving repeatedly is effectively a
 * box filter chain and looks dramatically better on fine detail.
 */
function scaleTo(src: CanvasImageSource, sw: number, sh: number, tw: number): OffscreenCanvas {
  const th = Math.max(1, Math.round((sh / sw) * tw));
  let cur = src;
  let cw = sw;
  let ch = sh;

  while (cw > tw * 2) {
    const nw = Math.max(tw, Math.round(cw / 2));
    const nh = Math.max(th, Math.round(ch / 2));
    const step = new OffscreenCanvas(nw, nh);
    const g = ctxOf(step);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, nw, nh);
    cur = step;
    cw = nw;
    ch = nh;
  }

  const out = new OffscreenCanvas(tw, th);
  const g = ctxOf(out);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(cur, 0, 0, tw, th);
  return out;
}

/** Average colour, via a 1x1 downscale. Used as the placeholder background. */
function dominant(src: CanvasImageSource, sw: number, sh: number): string {
  const c = new OffscreenCanvas(1, 1);
  const g = ctxOf(c);
  g.drawImage(src, 0, 0, sw, sh, 0, 0, 1, 1);
  const d = g.getImageData(0, 0, 1, 1).data;
  const hex = (v: number) => v.toString(16).padStart(2, '0');
  return `#${hex(d[0] ?? 0)}${hex(d[1] ?? 0)}${hex(d[2] ?? 0)}`;
}

type Done = { w: number; h: number; c: string; variants: [number, ArrayBuffer][] };

async function run(file: File, settings: EncodeSettings): Promise<Done> {
  await ensureReady();

  // 'from-image' applies EXIF orientation during decode. We re-encode raw
  // pixels, so if this is skipped, sideways photos publish sideways.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });

  try {
    // Never upscale: a small source just gets fewer variants.
    const targets: number[] = WIDTHS.filter((w) => w <= bitmap.width);
    if (!targets.length) targets.push(bitmap.width);

    const c = dominant(bitmap, bitmap.width, bitmap.height);

    // Widest first, then each smaller variant is derived from the previous one.
    // 1600 -> 800 -> 400 are exact halvings, which is the best case for quality.
    const descending = [...targets].sort((a, b) => b - a);
    const variants: [number, ArrayBuffer][] = [];
    let source: CanvasImageSource = bitmap;
    let sw = bitmap.width;
    let sh = bitmap.height;
    let widest = { w: 0, h: 0 };

    for (const target of descending) {
      const canvas = scaleTo(source, sw, sh, target);
      const pixels = ctxOf(canvas).getImageData(0, 0, canvas.width, canvas.height);
      const buf = await encode(pixels, settings);
      variants.push([target, buf]);
      if (!widest.w) widest = { w: canvas.width, h: canvas.height };
      source = canvas;
      sw = canvas.width;
      sh = canvas.height;
    }

    variants.sort((a, b) => a[0] - b[0]);
    return { w: widest.w, h: widest.h, c, variants };
  } finally {
    bitmap.close();
  }
}

ctx.addEventListener('message', (ev: MessageEvent<EncodeRequest>) => {
  const { jobId, file, encode: settings } = ev.data;
  void run(file, settings).then(
    (res) => {
      const msg: EncodeResponse = { jobId, ok: true, ...res };
      ctx.postMessage(msg, res.variants.map(([, b]) => b));
    },
    (err: unknown) => {
      const msg: EncodeResponse = {
        jobId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      ctx.postMessage(msg);
    },
  );
});
