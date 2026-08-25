/** The quality ladder decides what every photo costs. Run: node scripts/test-encode.mjs */
import { QUALITY_LADDER, budgetFor, encodeWithinBudget } from '../src/encode-settings.ts';

let ok = true;
const eq = (label, a, b) => {
  const pass = JSON.stringify(a) === JSON.stringify(b);
  if (!pass) {
    ok = false;
    console.log(`FAIL ${label}\n  got  ${JSON.stringify(a)}\n  want ${JSON.stringify(b)}`);
  } else console.log(`ok   ${label}`);
};

const W = 800;
const H = 1000;
const BUDGET = budgetFor(W, H);

/** Stand-in encoder: `sizes` maps a quality rung to the bytes it would produce. */
const fake = (sizes) => {
  const tried = [];
  const encode = (q) => {
    tried.push(q);
    return Promise.resolve(new ArrayBuffer(sizes[q]));
  };
  return { tried, encode };
};

const [top, mid, floor] = QUALITY_LADDER;

// --- a photo that fits at the top rung costs exactly one encode
let f = fake({ [top]: BUDGET - 1, [mid]: 1, [floor]: 1 });
let r = await encodeWithinBudget(W, H, f.encode);
eq('fits at top: one encode', f.tried, [top]);
eq('fits at top: quality', r.quality, top);
eq('fits at top: returns that buffer', r.buf.byteLength, BUDGET - 1);

// --- exactly on budget is not over budget
f = fake({ [top]: BUDGET, [mid]: 1, [floor]: 1 });
r = await encodeWithinBudget(W, H, f.encode);
eq('exactly on budget: no retry', f.tried, [top]);

// --- over budget steps down, and stops at the first rung that fits
f = fake({ [top]: BUDGET * 2, [mid]: BUDGET - 1, [floor]: 1 });
r = await encodeWithinBudget(W, H, f.encode);
eq('over budget: steps down once', f.tried, [top, mid]);
eq('over budget: keeps the rung that fit', r.quality, mid);

// --- a photo that blows every rung publishes at the floor rather than failing
f = fake(Object.fromEntries(QUALITY_LADDER.map((q) => [q, BUDGET * 3])));
r = await encodeWithinBudget(W, H, f.encode);
eq('never fits: whole ladder tried', f.tried, [...QUALITY_LADDER]);
eq('never fits: floor is published anyway', r.quality, floor);
eq('never fits: buffer is the floor encode', r.buf.byteLength, BUDGET * 3);

// --- attempts are reported before each encode, for the queue's status line
f = fake({ [top]: BUDGET * 2, [mid]: 1, [floor]: 1 });
const seen = [];
await encodeWithinBudget(W, H, f.encode, (q, attempt) => seen.push([q, attempt]));
eq('reports every attempt', seen, [[top, 0], [mid, 1]]);

// --- budget follows pixel count, so a tall photo is not punished for being tall
eq('budget scales with area', budgetFor(800, 2000), budgetFor(800, 1000) * 2);
eq('budget is per megapixel', budgetFor(800, 1000) > 0, true);

// --- the invariant that makes this safe to ship: nothing is published worse
// than the flat quality 55 every existing photo in the media repo got.
eq('ladder descends', [...QUALITY_LADDER].sort((a, b) => b - a), [...QUALITY_LADDER]);
eq('floor never drops below the old flat quality', floor >= 55, true);

console.log(ok ? '\nALL PASS' : '\nFAILURES');
process.exit(ok ? 0 : 1);
