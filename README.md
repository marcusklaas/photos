# photos

A personal photo stream served entirely from GitHub. Guests get an infinitely
scrolling column of photos with time and location; there is an unlisted upload
page that commits straight to the media repo using a token you hold.

No framework. The stream page is ~2.5 kB of hand-written JS with **zero runtime
dependencies**.

## Two repositories

| Repo | Holds | Written by |
|---|---|---|
| `photos` (this one) | App source, build, Pages workflow | you, via git |
| `photos-media` | AVIF variants and manifest shards. No code. | the upload page, via a PAT |

The split is not cosmetic:

- The upload token is scoped to `photos-media` only, so **a leaked token cannot
  modify the site's JavaScript**. Merging the repos throws this away.
- `photos-media` contains nothing worth preserving, so purging its history is a
  safe, boring operation (see [Deleting](#deleting-a-photo)).

Both are public Pages sites, and an upload touches only `photos-media` — so
publishing a photo never rebuilds the app. Here they happen to share an origin
(see [Live](#live)); if they ever did not, public Pages serves
`access-control-allow-origin: *`, so the cross-origin manifest fetch works anyway.

## Media repo layout

```
photos-media/
  .nojekyll
  index.json                # shard table; small, rewritten on every upload
  m/0000.json 0001.json …   # 100 photos each, oldest-first
  p/<id>-400.avif  <id>-800.avif  <id>-1600.avif
```

**Only the last shard is ever mutated.** Earlier shards are immutable and cache
forever. The stream reads the last shard first and walks backwards, so scrolling
only ever hits frozen files. `<id>` is the SHA-256 of the 800px AVIF, truncated —
content-addressed, so re-uploading the same photo is idempotent.

## Live

| | |
|---|---|
| Stream | <https://marcusklaas.nl/photos> |
| Upload | <https://marcusklaas.nl/photos/upload/> (unlisted — bookmark it) |
| Media | <https://marcusklaas.nl/photos-media> |

`marcusklaas.github.io` carries the custom domain `marcusklaas.nl`, so project
sites are served at `marcusklaas.nl/<repo>` automatically. A useful consequence:
the app and the media are **same-origin**, so manifest fetches need no CORS
preflight and no second connection.

Deployment is automatic — a push to `main` runs typecheck, tests and build, then
publishes `dist/` to Pages via `.github/workflows/pages.yml`. Build configuration
lives in repository variables (Settings → Secrets and variables → Actions):

| Variable | Value |
|---|---|
| `PHOTOS_MEDIA_URL` | `https://marcusklaas.nl/photos-media` |
| `PHOTOS_BASE_PATH` | `/photos/` |

### Remaining manual step: the token

The upload page needs a token, which only you can create:

1. <https://github.com/settings/personal-access-tokens/new>
2. Repository access → **Only select repositories** → `photos-media`
3. Repository permissions → **Contents: Read and write** (that is the entire
   scope it needs)
4. Set an expiry date
5. Paste it into <https://marcusklaas.nl/photos/upload/> with owner
   `marcusklaas`, repo `photos-media`, branch `main`, and hit **Save & verify**

Do not grant it access to the `photos` repo. The whole security story rests on
that token being unable to touch code.

## How a photo gets published

Everything happens in your browser before anything is committed:

1. EXIF (capture time, GPS) is read **first**, because step 3 destroys it.
2. `createImageBitmap(..., { imageOrientation: 'from-image' })` decodes and bakes
   in EXIF orientation — we re-encode raw pixels, so skipping this publishes
   sideways photos sideways.
3. Downscaled in halving steps (a single big-ratio `drawImage` aliases badly),
   then encoded to AVIF at 400/800/1600 px wide by a WASM encoder in a worker.
4. Blobs, a tree and a commit go up through the Git Data API as **one atomic
   commit**. If the branch moved meanwhile, it re-reads the manifest and retries
   rather than force-pushing over whatever landed.

**The original file never leaves your machine.** No full-resolution copy and no
EXIF blob is ever published — which does more for privacy than any amount of
history rewriting.

Time and location default to *kept*, with a per-photo toggle to strip either, plus
an optional description. Stripped fields are **omitted from the JSON, never
nulled**, so the wire format carries no trace that they existed.

### Not supported: HEIC

Chrome and Firefox cannot decode HEIC at all, so iPhone-native HEIC files are
rejected with a clear message. JPEG, PNG, WebP and AVIF work. Adding
`libheif-wasm` to the worker is a self-contained change if this becomes annoying.

## Tuning compression

`src/config.ts` holds the encoder knobs, using `@jsquash/avif`'s option names:

```ts
quality: 55,   // 0-100, HIGHER is better (not libavif's cq-level)
speed: 3,      // 0-10, LOWER is slower and compresses better
subsample: 1,  // 0=YUV400 1=YUV420 2=YUV422 3=YUV444
```

These are starting points, not settled values. Tune them against your own photos
— synthetic test images compress nothing like real ones.

## Development

```sh
npm install
node scripts/make-fixture.mjs   # procedural photos in ./fixture
npm run dev                     # builds to dist/, copies fixture to dist/media
npx serve dist                  # or any static server
npm run check                   # typecheck
npm test                        # sharding logic
```

The fixture means the whole stream is testable with no network and no GitHub.

## Deleting a photo

```sh
node scripts/delete.mjs ../photos-media <id>
```

It removes the manifest entry and every variant on disk, then prints the git
commands. It does not commit — you get to see the diff first.

That removes the photo from the site, but **the bytes remain in git history**.
Public git history is permanent; there is no way around it. To purge them, flatten
the media repo to a single commit:

```sh
cd ../photos-media
git checkout --orphan purge && git add -A
git commit -m "Photos" && git branch -M purge main
git push --force origin main
```

This is safe here only because that repo holds no code, no blame and no PRs. Never
do it in a repo you would miss the history of. Rehearse it once on a throwaway
repo before you need it in anger.
