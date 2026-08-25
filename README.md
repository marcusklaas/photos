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
  p/<id>-800.avif           # one variant; the column is capped at 800px too
```

Shards are ordered **oldest-first by capture time**, not upload time, and the
stream reads the last shard first and walks backwards. Publishing recent photos
therefore touches only the tail shard; backfilling an old photo rewrites the
shard it lands in, and the uploader rewrites nothing else. `<id>` is the SHA-256
of the AVIF, truncated — content-addressed, so re-uploading the same photo is
idempotent.

There is a single 800px variant, and the stream lays each photo out at **one
image pixel per device pixel** — 800 CSS px at `devicePixelRatio` 1, 400 at 2 —
so nothing is ever resampled.

This is worth understanding before changing it. CSS pixels are not device
pixels: an 800px image at its natural size is 800 *CSS* px, which on a 2x display
is 1600 *device* px, so the browser upscales it and it looks soft. There is no
"render natively" mode that avoids this — the only fixes are a higher-resolution
variant or a smaller displayed size. We chose the latter: sharp everywhere at
87 kB/photo, where a 2x variant measured 285 kB. (Both measured at quality 55;
[the default](#tuning-compression) is higher than that now, which moves both
numbers but not the ratio.)

The tradeoff is physical size — a photo is half as wide on a retina screen as on
a 1x one, and leaves margins on high-DPI phones. If that ever grates, add
`COLUMN_PX * 2` back to `WIDTHS`; the stream's srcset already handles multiple
widths.

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
   then encoded to AVIF at 800px wide by a WASM encoder in a worker, at
   [whatever quality and speed this browser is set to](#tuning-compression).
   Narrower sources are never upscaled — they publish and display at their own
   width. Expect seconds per photo, not milliseconds, at the default speed.
4. Blobs, a tree and a commit go up through the Git Data API as **one atomic
   commit**. If the branch moved meanwhile, it re-reads the manifest and retries
   rather than force-pushing over whatever landed.

**The original file never leaves your machine.** No full-resolution copy and no
EXIF blob is ever published — which does more for privacy than any amount of
history rewriting.

**Capture time is required** — the stream is ordered by it. It is prefilled from
EXIF (or the file's own mtime, flagged as a guess) and is editable per photo, but
publishing is blocked until every queued photo has one.

Location defaults to *kept*, at full EXIF precision, with a per-photo toggle to
strip it, plus an optional description. Stripped fields are **omitted from the
JSON, never nulled**, so the wire format carries no trace that they existed.

### Not supported: HEIC

Chrome and Firefox cannot decode HEIC at all, so iPhone-native HEIC files are
rejected with a clear message. JPEG, PNG, WebP and AVIF work. Adding
`libheif-wasm` to the worker is a self-contained change if this becomes annoying.

## Tuning compression

The encoder is **libavif v1.0.1** compiled to WASM, via `@jsquash/avif` (a
repackaging of Squoosh's codec). It runs single-threaded: the multithreaded build
needs `SharedArrayBuffer`, which needs COOP/COEP headers, which Pages cannot set.

The knobs live in the upload page, under **Encoding**, and are stored in this
browser's localStorage next to the token — so you can retune per machine, or for
one awkward batch, without a deploy. `ENCODE_DEFAULTS` in
`src/encode-settings.ts` is what you get with nothing stored:

| Setting | Default | Range | What it does |
|---|---|---|---|
| Quality | 68 | 1–100 | Higher is better. **Not** libavif's cq-level; its own default is 50. |
| Speed | 5 | 0–10 | Lower is slower and denser. Library default is 6. |
| Sharp YUV | on | — | libwebp's sharp RGB→YUV for the 4:2:0 chroma downsample. |

Settings apply to the next photo you add, and each queued job carries its own
copy — so editing them mid-queue never changes an encode already running.

Anything stored is run through `coerceEncodeSettings` on the way in: every field
falls back to its default independently, and out-of-range numbers clamp rather
than fall back. One bad value in localStorage cannot break the page or reach the
encoder.

### What the defaults are worth

Quality 68 against libavif's own 50, because these are viewed at one image pixel
per device pixel — there is no resampling to hide quantization behind, so it is
as visible as it will ever get.

Lowering `speed` below its default of 6 was measured as a trap on a 1600x2000
image:

| speed | size | time |
|---|---|---|
| 0 | 352 kB | 262 s |
| 3 | 334 kB | 65 s |
| 6 | 325 kB | 3.0 s |
| 8 | 311 kB | 0.6 s |

That still holds for 0–3: there is no reading of it where they earn their 100x
time cost, and there is a cliff between 4 and 6 where libaom changes algorithm.
Speed 5 sits inside that cliff and was never in the table. Measured since, at our
actual 800px publish size, it comes out **5–10% smaller than speed 6 at the same
quality, for 4–10x the time** (3–5 s per encode against 0.4–1.3 s), and no worse
than speed 4 while being ~50% quicker.

Full 4:4:4 chroma (`subsample: 3`) measured at +27% to +70% bytes and is not
exposed. `enableSharpYUV` gets some of the same benefit — cleaner colour on
saturated edges — for ~0–4%.

**Caveat worth knowing:** the speed-5 and chroma numbers above came from
synthetic images, because that is what was to hand. Synthetic images are useless
for absolute sizes — fine grain dominates the bitrate and behaves nothing like
real detail — so treat them as directional and re-measure on photos you would
actually publish:

```sh
npm run bench -- photo.jpg                 # what a photo costs at the defaults
npm run bench -- --compare 55,68 photo.jpg # can you actually see the difference?
npm run bench -- --sweep quality photo.jpg
npm run bench -- --sweep speed   photo.jpg
```

`--compare` is the one that settles an argument about quality. It encodes at each
quality given, decodes them back, prints PSNR and SSIM against the source pixels,
and writes the decoded results to `bench-out/` as PNG. Open them at 100% and flip
between them. If you cannot tell which is which, the higher quality is not
earning its bytes on photos like yours, and the honest move is to turn Quality
down rather than pay for it.

## Development

```sh
npm install
node scripts/make-fixture.mjs   # procedural photos in ./fixture
npm run dev                     # builds to dist/, copies fixture to dist/media
npx serve dist                  # or any static server
npm run check                   # typecheck
npm test                        # sharding + the quality ladder
npm run bench -- photo.jpg      # encoder size/time on a real photo
npm run bench -- --compare a.jpg # two qualities, decoded to bench-out/
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
