/** Sharding is the one place a bug silently corrupts the whole stream. Run: node scripts/test-manifest.mjs */
import { planPublish, emptyIndex, byTime } from '../src/upload/manifest.ts';

const P = (id, t) => ({ id, w: 800, h: 1067, v: [800], c: '#000000', t });
let ok = true;
const eq = (label, a, b) => {
  const pass = JSON.stringify(a) === JSON.stringify(b);
  if (!pass) {
    ok = false;
    console.log(`FAIL ${label}\n  got  ${JSON.stringify(a)}\n  want ${JSON.stringify(b)}`);
  } else console.log(`ok   ${label}`);
};

const idx = (shardSize, counts) => ({
  version: 1,
  shardSize,
  total: counts.reduce((n, c) => n + c, 0),
  shards: counts.map((count, i) => ({ file: `${String(i).padStart(4, '0')}.json`, count })),
});

// --- first ever upload
let r = planPublish(emptyIndex(3), [], [P('b', '2026-01-02T00:00:00'), P('a', '2026-01-01T00:00:00')]);
eq('first: one shard', r.shards.map((s) => s.path), ['m/0000.json']);
eq('first: sorted oldest-first', r.shards[0].photos.map((p) => p.id), ['a', 'b']);
eq('first: index', [r.index.total, r.index.shards], [2, [{ file: '0000.json', count: 2 }]]);

// --- appending a NEWER photo touches only the tail
const three = [P('a', '2026-01-01T00:00:00'), P('b', '2026-01-02T00:00:00'), P('c', '2026-01-03T00:00:00')];
r = planPublish(idx(3, [3, 1]), [three, [P('d', '2026-01-04T00:00:00')]], [P('e', '2026-01-05T00:00:00')]);
eq('append newest: only tail rewritten', r.shards.map((s) => s.path), ['m/0001.json']);
eq('append newest: tail contents', r.shards[0].photos.map((p) => p.id), ['d', 'e']);
eq('append newest: total', r.index.total, 5);

// --- backfilling an OLD photo rewrites the shard it lands in, and everything after
r = planPublish(idx(3, [3, 1]), [three, [P('d', '2026-01-04T00:00:00')]], [P('z', '2026-01-01T12:00:00')]);
eq('backfill: both shards rewritten', r.shards.map((s) => s.path), ['m/0000.json', 'm/0001.json']);
eq('backfill: shard 0 resorted', r.shards[0].photos.map((p) => p.id), ['a', 'z', 'b']);
eq('backfill: spill into shard 1', r.shards[1].photos.map((p) => p.id), ['c', 'd']);
eq('backfill: total', r.index.total, 5);

// --- a batch spanning a boundary
r = planPublish(idx(3, [3]), [three], [
  P('d', '2026-01-04T00:00:00'),
  P('e', '2026-01-05T00:00:00'),
  P('f', '2026-01-06T00:00:00'),
]);
eq('spanning: new shard only', r.shards.map((s) => s.path), ['m/0001.json']);
eq('spanning: counts', r.index.shards.map((s) => s.count), [3, 3]);

// --- unchanged shards are never rewritten
r = planPublish(idx(3, [3]), [three], []);
eq('no additions: nothing written', r.shards, []);
eq('no additions: index unchanged', r.index.shards.map((s) => s.count), [3]);

// --- equal timestamps sort deterministically by id
const same = '2026-02-02T10:00:00';
eq('tiebreak by id', [P('b', same), P('a', same)].sort(byTime).map((p) => p.id), ['a', 'b']);

console.log(ok ? '\nALL PASS' : '\nFAILURES');
process.exit(ok ? 0 : 1);
