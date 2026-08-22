/** Sharding is the one place a bug silently corrupts the whole stream. Run: node scripts/test-manifest.mjs */
import { planAppend, emptyIndex } from '../src/upload/manifest.ts';
const P = (n) => ({ id: `x${n}`, w: 1600, h: 2133, v: [400,800,1600], c: '#000000' });
let ok = true;
const eq = (label, a, b) => { const p = JSON.stringify(a) === JSON.stringify(b); if(!p){ok=false;console.log(`FAIL ${label}\n  got ${JSON.stringify(a)}\n  want ${JSON.stringify(b)}`);} else console.log(`ok   ${label}`); };

// first ever upload
let r = planAppend(emptyIndex(3), [], [P(1), P(2)]);
eq('first: one shard', r.shards.map(s=>s.path), ['m/0000.json']);
eq('first: index', [r.index.total, r.index.shards], [2, [{file:'0000.json',count:2}]]);

// append into a partial tail
r = planAppend(r.index, r.shards[0].photos, [P(3)]);
eq('partial tail: rewrites 0000', r.shards.map(s=>s.path), ['m/0000.json']);
eq('partial tail: count 3', r.index.shards, [{file:'0000.json',count:3}]);

// tail is now full (size 3) -> must NOT rewrite it
const full = r.index, tail = r.shards[0].photos;
r = planAppend(full, tail, [P(4)]);
eq('full tail: only new shard written', r.shards.map(s=>s.path), ['m/0001.json']);
eq('full tail: index', [r.index.total, r.index.shards], [4, [{file:'0000.json',count:3},{file:'0001.json',count:1}]]);

// batch that spans a boundary
r = planAppend(full, tail, [P(4),P(5),P(6),P(7)]);
eq('spanning: two new shards', r.shards.map(s=>s.path), ['m/0001.json','m/0002.json']);
eq('spanning: counts', r.index.shards.map(s=>s.count), [3,3,1]);
eq('spanning: total', r.index.total, 7);

// partial tail that overflows
r = planAppend({version:1,shardSize:3,total:2,shards:[{file:'0000.json',count:2}]}, [P(1),P(2)], [P(3),P(4)]);
eq('overflow: rewrites tail + adds', r.shards.map(s=>s.path), ['m/0000.json','m/0001.json']);
eq('overflow: counts', r.index.shards.map(s=>s.count), [3,1]);

console.log(ok ? '\nALL PASS' : '\nFAILURES');
process.exit(ok?0:1);
