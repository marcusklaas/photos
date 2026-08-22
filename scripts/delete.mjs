/**
 * Removes photos from a LOCAL CLONE of the media repo.
 *
 *   node scripts/delete.mjs ../photos-media <id> [<id> ...]
 *
 * Deliberately does not commit or push. It edits files and prints the git
 * commands, so you get to look at the diff before anything becomes public --
 * and so the history purge below stays an explicit decision.
 */
import { readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const [repo, ...ids] = process.argv.slice(2);

if (!repo || !ids.length) {
  console.error('usage: node scripts/delete.mjs <media-repo-path> <photoId> [...]');
  process.exit(1);
}
if (!existsSync(path.join(repo, 'index.json'))) {
  console.error(`No index.json in ${repo} -- is that the media repo?`);
  process.exit(1);
}

const indexPath = path.join(repo, 'index.json');
const index = JSON.parse(await readFile(indexPath, 'utf8'));
const wanted = new Set(ids);
const removed = [];
const touched = new Set();

for (const entry of index.shards) {
  const shardPath = path.join(repo, 'm', entry.file);
  const photos = JSON.parse(await readFile(shardPath, 'utf8'));
  const kept = photos.filter((p) => {
    if (!wanted.has(p.id)) return true;
    removed.push(p);
    return false;
  });
  if (kept.length !== photos.length) {
    await writeFile(shardPath, JSON.stringify(kept));
    entry.count = kept.length;
    touched.add(entry.file);
  }
}

if (!removed.length) {
  console.error(`No photo matched: ${ids.join(', ')}`);
  process.exit(1);
}

// Delete every variant on disk, not just the widths the manifest claimed --
// an interrupted upload can leave extras behind.
const files = await readdir(path.join(repo, 'p'));
let deleted = 0;
for (const p of removed) {
  for (const f of files) {
    if (f.startsWith(`${p.id}-`)) {
      await rm(path.join(repo, 'p', f));
      deleted++;
    }
  }
}

index.total = index.shards.reduce((n, s) => n + s.count, 0);
await writeFile(indexPath, JSON.stringify(index));

console.log(`Removed ${removed.length} photo(s), ${deleted} file(s).`);
console.log(`Rewrote: ${[...touched].join(', ')} and index.json\n`);
console.log('Review, then publish:');
console.log(`  cd ${repo} && git add -A && git diff --cached --stat`);
console.log(`  git commit -m "Remove ${removed.length} photo(s)" && git push\n`);
console.log('The bytes still exist in git history. To purge them completely --');
console.log('safe here precisely because this repo holds no code:');
console.log(`  cd ${repo}`);
console.log('  git checkout --orphan purge && git add -A');
console.log('  git commit -m "Photos" && git branch -M purge main');
console.log('  git push --force origin main');
