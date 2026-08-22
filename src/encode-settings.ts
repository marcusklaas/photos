/**
 * Pure constants, deliberately free of build-time defines so that Node scripts
 * (scripts/bench.mjs) and the browser bundle share one source of truth.
 */

/**
 * The only width we publish. The stream column is capped at the same 800px, so
 * a photo is never displayed larger than it was encoded.
 */
export const WIDTHS = [800] as const;

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
