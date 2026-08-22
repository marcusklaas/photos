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
 * (measured: 87 kB vs 285 kB average on real photos).
 *
 * The tradeoff is physical size: a photo is half as wide on a dpr 2 display as
 * on a dpr 1 one. If that ever feels too small, the fix is adding COLUMN_PX * 2
 * back here -- the stream's srcset handles more than one width already.
 */
export const WIDTHS = [COLUMN_PX] as const;

/** Photos per manifest shard. */
export const SHARD_SIZE = 100;

/**
 * AVIF encoder options for @jsquash/avif. Library defaults, except quality.
 *
 * quality is 0-100 and HIGHER is better (it is NOT libavif's cq-level); the
 * default is 50. Everything else is left alone deliberately: measured on real
 * images, lowering `speed` below the default 6 costs enormous time for nothing
 * -- speed 0 took 66s to save ~5 kB over speed 6's 1.2s, and on a grainier
 * image it produced a LARGER file than speed 8 did in 0.6s.
 *
 * Encoding is single-threaded on GitHub Pages regardless: the multithreaded
 * wasm needs SharedArrayBuffer, which needs COOP/COEP headers, which Pages
 * cannot set.
 *
 * Re-measure with `node scripts/bench.mjs <your-photos>` before changing this.
 */
export const ENCODE = { quality: 55 };
