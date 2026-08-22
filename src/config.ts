declare const __MEDIA_BASE_URL__: string;
declare const __DEV__: boolean;

/** Origin (or relative path) the media repo is served from. Set at build time. */
export const MEDIA_BASE_URL: string = __MEDIA_BASE_URL__.replace(/\/$/, '');

export const DEV: boolean = __DEV__;

/** Widths emitted per photo. 1600 covers 2x DPR at full column width. */
export const WIDTHS = [400, 800, 1600] as const;

/** Longest edge we will ever publish. Caps encode time and file size. */
export const MAX_EDGE = 1600;

/** Photos per manifest shard. */
export const SHARD_SIZE = 100;

/**
 * AVIF encoder knobs, matching @jsquash/avif's option names.
 *
 * quality:   0-100, HIGHER is better (this is not libavif's cq-level).
 * speed:     0-10, LOWER is slower and compresses better.
 * subsample: 0=YUV400, 1=YUV420, 2=YUV422, 3=YUV444.
 *
 * These are the "spend compute for quality" dials. Tune with scripts/bench.mjs
 * against real photos before treating them as settled.
 */
export const ENCODE = {
  quality: 55,
  speed: 3,
  subsample: 1,
  chromaDeltaQ: true,
  enableSharpYUV: true,
};

export const mediaUrl = (path: string): string => `${MEDIA_BASE_URL}/${path}`;
export const variantUrl = (id: string, width: number): string => mediaUrl(`p/${id}-${width}.avif`);
