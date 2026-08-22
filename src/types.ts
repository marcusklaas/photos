/**
 * Wire format for the media repo. Shared by the stream and the uploader.
 *
 * Optional fields are OMITTED, never nulled: if you strip a location at
 * upload time, the published JSON carries no trace that it ever existed.
 * Keep it that way.
 */
export type Photo = {
  /** First 16 hex chars of the SHA-256 of the 800px AVIF. Content-addressed. */
  id: string;
  /** Intrinsic dimensions of the largest variant. Used to reserve layout space. */
  w: number;
  h: number;
  /** Widths actually present. Currently always [800]. */
  v: number[];
  /** Dominant colour, "#rrggbb". Rendered as the placeholder background. */
  c: string;
  /**
   * Local wall-clock capture time, "YYYY-MM-DDTHH:mm:ss", no timezone.
   * REQUIRED: the stream is ordered by it. The uploader prefills it from EXIF
   * and lets you edit it, but will not publish without one.
   */
  t: string;
  /** [lat, lon] at full EXIF precision. Absent if stripped. */
  g?: [number, number];
  /** Free-text description. Absent if not written. */
  d?: string;
};

/**
 * Shards are ordered oldest-first BY TIMESTAMP. Appending recent photos only
 * touches the last shard, but backfilling an old photo rewrites the shard it
 * lands in. The stream renders newest-first by walking this array backwards.
 */
export type Index = {
  version: 1;
  shardSize: number;
  total: number;
  shards: { file: string; count: number }[];
};
