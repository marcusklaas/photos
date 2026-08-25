/**
 * Pure constants, deliberately free of build-time defines so that Node scripts
 * (scripts/bench.mjs) and the browser bundle share one source of truth.
 */

/**
 * Widest the stream column ever gets, in CSS pixels.
 * MUST match `--column` in src/stream/stream.css.
 */
export const COLUMN_PX = 800;

/**
 * The only width we publish.
 *
 * Rather than shipping a 2x variant for high-DPI screens, the stream lays each
 * photo out at its own pixel count -- 800 CSS px at dpr 1, 400 at dpr 2 -- so
 * one image pixel maps to exactly one device pixel and nothing is ever
 * resampled. Sharp everywhere, at a third of the bytes a 2x variant costs
 * (measured: 87 kB vs 285 kB average on real photos, both at the flat quality 55
 * that predates QUALITY_LADDER -- the ratio between them is unaffected).
 *
 * The tradeoff is physical size: a photo is half as wide on a dpr 2 display as
 * on a dpr 1 one. If that ever feels too small, the fix is adding COLUMN_PX * 2
 * back here -- the stream's srcset handles more than one width already.
 */
export const WIDTHS = [COLUMN_PX] as const;

/** Photos per manifest shard. */
export const SHARD_SIZE = 100;

/**
 * AVIF encoder options for @jsquash/avif, minus quality (see QUALITY_LADDER).
 *
 * `speed` 5 is one step below the library default of 6, and it is a real cost:
 * measured at our publish size, speed 5 takes 3-5 s per encode against 0.4-1.3 s
 * at speed 6, and the browser's single-threaded wasm is slower still. What it
 * buys is 5-10% fewer bytes at the same quality, which is what pays for the
 * higher quality we now ask for. Going further down is not worth it -- speed 4
 * measured no smaller than 5 while taking ~50% longer, and README's table shows
 * speeds 0-3 losing outright on a real photo.
 *
 * `enableSharpYUV` uses libwebp's sharp RGB->YUV conversion when chroma is
 * downsampled to 4:2:0, which is the cheapest quality win available here: it
 * cleans up colour fringing on saturated edges for ~0-4% more bytes. Full 4:4:4
 * chroma (`subsample: 3`) was measured at +27% to +70% and did not look like
 * "not going overboard".
 *
 * Encoding is single-threaded on GitHub Pages regardless: the multithreaded
 * wasm needs SharedArrayBuffer, which needs COOP/COEP headers, which Pages
 * cannot set.
 *
 * Re-measure with `node scripts/bench.mjs <your-photos>` before changing this.
 */
export const ENCODE = { speed: 5, enableSharpYUV: true };

/**
 * Quality rungs, best first. quality is 0-100 and HIGHER is better (it is NOT
 * libavif's cq-level); the library default is 50.
 *
 * A photo is encoded at the first rung, and only steps down if the result blew
 * the byte budget below. Most photos never leave 68. The floor is 55, which is
 * what every photo used to get unconditionally -- so nothing published from
 * here on is encoded worse than what is already in the media repo, and the
 * busiest photos are the only ones that end up anywhere near it.
 */
export const QUALITY_LADDER = [68, 62, 55];

/**
 * The "don't go overboard" knob: bytes a photo may spend per megapixel before
 * it drops a rung. Per megapixel rather than flat, so a tall portrait is not
 * punished for being taller than a landscape.
 *
 * At 800x1067 (the common portrait shape) this is a ~170 kB ceiling, against a
 * ~87 kB average at the old flat quality 55. It is deliberately set above what
 * an ordinary photo costs at quality 68, so it clips the tail rather than
 * clawing back the quality bump from everything: raise it to let busy photos
 * keep the top rung, lower it to hold the line harder.
 *
 * `npm run bench -- <your-photos>` prints the rung each photo lands on.
 */
export const BUDGET_BYTES_PER_MPX = 200 * 1024;

/** Byte budget for one variant, from its pixel count. */
export function budgetFor(width: number, height: number): number {
  return Math.round(((width * height) / 1e6) * BUDGET_BYTES_PER_MPX);
}

/**
 * Walk QUALITY_LADDER until the encoded result fits budgetFor(), or the ladder
 * runs out. `encode` is injected because the browser and Node reach the same
 * wasm encoder by different routes; `onAttempt` fires just before each encode,
 * since at these speeds a rung is seconds of silence worth reporting.
 *
 * Low-complexity photos cost exactly one encode -- they fit at the top rung and
 * never see the rest of the ladder. Only genuinely busy photos pay for the
 * extra passes, which is the only place the extra time is worth anything.
 */
export async function encodeWithinBudget(
  width: number,
  height: number,
  encode: (quality: number) => Promise<ArrayBuffer>,
  onAttempt?: (quality: number, attempt: number) => void,
): Promise<{ buf: ArrayBuffer; quality: number }> {
  const budget = budgetFor(width, height);
  let result: { buf: ArrayBuffer; quality: number } | null = null;

  for (const [attempt, quality] of QUALITY_LADDER.entries()) {
    onAttempt?.(quality, attempt);
    const buf = await encode(quality);
    result = { buf, quality };
    if (buf.byteLength <= budget) break;
  }

  if (!result) throw new Error('QUALITY_LADDER is empty');
  return result;
}
