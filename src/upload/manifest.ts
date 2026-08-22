import type { Index, Photo } from '../types.js';

export type ShardWrite = { path: string; photos: Photo[] };

export type Plan = {
  /** Shard files to write, keyed by media-repo path. */
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

/**
 * Works out which shard files need rewriting to append `additions`.
 *
 * Shards are oldest-first and only the LAST one is ever mutated, so every
 * earlier shard stays byte-identical forever and can be cached indefinitely.
 * `tailPhotos` must be the current contents of the last shard (empty if there
 * is none) — the caller reads it from the GitHub API rather than the Pages CDN,
 * which can be stale.
 */
export function planAppend(index: Index, tailPhotos: Photo[], additions: Photo[]): Plan {
  const size = index.shardSize || 100;
  const shards: ShardWrite[] = [];

  // Start from the existing tail shard, or open a fresh one if there is none.
  let cursor = Math.max(0, index.shards.length - 1);
  let current: Photo[] = index.shards.length ? [...tailPhotos] : [];
  let dirty = index.shards.length === 0;

  const flush = () => {
    if (dirty) shards.push({ path: `m/${shardName(cursor)}`, photos: [...current] });
  };

  for (const p of additions) {
    if (current.length >= size) {
      // Tail was already full: leave it untouched and open the next shard.
      flush();
      cursor++;
      current = [];
      dirty = true;
    }
    current.push(p);
    dirty = true;
  }
  flush();

  // Rebuild the shard table: untouched entries keep their counts, the shards we
  // just wrote take theirs from the plan.
  const table = index.shards.map((s) => ({ ...s }));
  for (const w of shards) {
    const file = w.path.slice('m/'.length);
    const at = table.findIndex((s) => s.file === file);
    if (at >= 0) table[at] = { file, count: w.photos.length };
    else table.push({ file, count: w.photos.length });
  }

  return {
    shards,
    index: {
      version: 1,
      shardSize: size,
      total: table.reduce((n, s) => n + s.count, 0),
      shards: table,
    },
  };
}
