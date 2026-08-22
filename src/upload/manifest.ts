import type { Index, Photo } from '../types.js';

export type ShardWrite = { path: string; photos: Photo[] };

export type Plan = {
  /** Only the shards whose contents actually changed. */
  shards: ShardWrite[];
  index: Index;
};

const shardName = (i: number): string => `${String(i).padStart(4, '0')}.json`;

export const emptyIndex = (shardSize: number): Index => ({
  version: 1,
  shardSize,
  total: 0,
  shards: [],
});

/** Oldest first, with a stable tiebreak so equal timestamps never reshuffle. */
export function byTime(a: Photo, b: Photo): number {
  if (a.t !== b.t) return a.t < b.t ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Merges `additions` into the existing photos and re-chunks into shards.
 *
 * The stream is ordered by capture time, not upload time, so a backfilled old
 * photo has to land in an old shard -- shards cannot be strictly append-only.
 * To keep that cheap, this compares each resulting chunk against what is
 * already on disk and returns ONLY the shards that genuinely changed. Uploading
 * recent photos still touches nothing but the tail.
 *
 * `existing` is the current contents of every shard, in index order. The caller
 * reads it from the GitHub API rather than the Pages CDN, which can be stale.
 */
export function planPublish(index: Index, existing: Photo[][], additions: Photo[]): Plan {
  const size = index.shardSize || 100;

  const merged = [...existing.flat(), ...additions].sort(byTime);

  const chunks: Photo[][] = [];
  for (let i = 0; i < merged.length; i += size) chunks.push(merged.slice(i, i + size));
  if (!chunks.length) chunks.push([]);

  const shards: ShardWrite[] = [];
  chunks.forEach((photos, i) => {
    // Exact comparison against what is published, so an unchanged shard is not
    // rewritten and stays cached.
    const before = existing[i];
    if (before && JSON.stringify(before) === JSON.stringify(photos)) return;
    shards.push({ path: `m/${shardName(i)}`, photos });
  });

  return {
    shards,
    index: {
      version: 1,
      shardSize: size,
      total: merged.length,
      shards: chunks.map((c, i) => ({ file: shardName(i), count: c.length })),
    },
  };
}
