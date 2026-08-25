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
 * (measured: 87 kB vs 285 kB average on real photos, both at a flat quality 55
 * -- whatever quality you settle on moves both numbers, not the ratio).
 *
 * The tradeoff is physical size: a photo is half as wide on a dpr 2 display as
 * on a dpr 1 one. If that ever feels too small, the fix is adding COLUMN_PX * 2
 * back here -- the stream's srcset handles more than one width already.
 */
export const WIDTHS = [COLUMN_PX] as const;

/** Photos per manifest shard. */
export const SHARD_SIZE = 100;

/**
 * The encoder knobs the upload page exposes, in libavif's own vocabulary so a
 * stored settings object can be handed to @jsquash/avif unchanged.
 */
export type EncodeSettings = {
  /** 0-100, and HIGHER is better -- this is NOT libavif's cq-level. */
  quality: number;
  /** 0-10. Lower is slower and denser. The library default is 6. */
  speed: number;
  /** libwebp's sharp RGB->YUV conversion for the 4:2:0 chroma downsample. */
  enableSharpYUV: boolean;
};

/**
 * What you get with nothing stored. Overridable per browser from the upload
 * page; these are the values that survived measurement, not house style.
 *
 * `quality` 68 against the library default of 50. `speed` 5 is one step below
 * the library default of 6, and it is a real cost: measured at our publish
 * size, speed 5 takes 3-5 s per encode against 0.4-1.3 s at speed 6, and the
 * browser's single-threaded wasm is slower still. What it buys is 5-10% fewer
 * bytes at the same quality. Going further down is not worth it -- speed 4
 * measured no smaller while taking ~50% longer, and the README's table shows
 * speeds 0-3 losing outright on a real photo.
 *
 * `enableSharpYUV` is the cheapest quality win available here: it cleans up
 * colour fringing on saturated edges for ~0-4% more bytes. Full 4:4:4 chroma
 * (`subsample: 3`) measured at +27% to +70% and is not exposed.
 *
 * Encoding is single-threaded on GitHub Pages regardless: the multithreaded
 * wasm needs SharedArrayBuffer, which needs COOP/COEP headers, which Pages
 * cannot set.
 *
 * Re-measure with `node scripts/bench.mjs <your-photos>` before changing these.
 */
export const ENCODE_DEFAULTS: EncodeSettings = {
  quality: 68,
  speed: 5,
  enableSharpYUV: true,
};

/**
 * Accepted ranges, shared by the page's number inputs and coerceEncodeSettings
 * so the form and the parser can never disagree. quality stops at 1 rather than
 * libavif's 0 -- quality 0 produces something that reads as a bug, not a photo.
 */
export const ENCODE_BOUNDS = {
  quality: { min: 1, max: 100 },
  speed: { min: 0, max: 10 },
} as const;

const clamp = (value: unknown, bounds: { min: number; max: number }, fallback: number): number => {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(n)));
};

/**
 * Settings from anything at all -- localStorage holds whatever a past version
 * of this page wrote, or whatever someone typed into devtools. Every field
 * falls back to its default independently, so one bad value cannot cost you the
 * other two, and the result is always safe to hand to the encoder.
 */
export function coerceEncodeSettings(raw: unknown): EncodeSettings {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    quality: clamp(o.quality, ENCODE_BOUNDS.quality, ENCODE_DEFAULTS.quality),
    speed: clamp(o.speed, ENCODE_BOUNDS.speed, ENCODE_DEFAULTS.speed),
    enableSharpYUV:
      typeof o.enableSharpYUV === 'boolean' ? o.enableSharpYUV : ENCODE_DEFAULTS.enableSharpYUV,
  };
}

/** Whether settings differ from the defaults, for the "customised" pill. */
export const isDefaultEncodeSettings = (s: EncodeSettings): boolean =>
  (Object.keys(ENCODE_DEFAULTS) as (keyof EncodeSettings)[]).every(
    (k) => s[k] === ENCODE_DEFAULTS[k],
  );
