import type { Index, Photo } from '../types.js';
import { COLUMN_PX, WIDTHS, mediaUrl, variantUrl } from '../config.js';

const stream = document.getElementById('stream') as HTMLElement;
const sentinel = document.getElementById('sentinel') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;

/** Index of the next shard to load. We walk backwards: newest shard first. */
let nextShard = -1;
let index: Index | null = null;
let loading = false;

const dateFmt = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

function caption(p: Photo): HTMLElement | null {
  const parts: (Node | string)[] = [];

  const d = new Date(p.t);
  if (!Number.isNaN(d.valueOf())) {
    const time = document.createElement('time');
    time.dateTime = p.t;
    time.textContent = dateFmt.format(d);
    parts.push(time);
  }

  if (p.g) {
    const [lat, lon] = p.g;
    const a = document.createElement('a');
    a.href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=13/${lat}/${lon}`;
    a.rel = 'noopener noreferrer';
    a.target = '_blank';
    a.textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    parts.push(a);
  }

  if (!parts.length && !p.d) return null;

  const cap = document.createElement('figcaption');
  parts.forEach((node, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '·';
      cap.append(sep);
    }
    cap.append(node);
  });

  if (p.d) {
    const desc = document.createElement('span');
    desc.className = 'desc';
    desc.textContent = p.d;
    cap.append(desc);
  }
  return cap;
}

function render(p: Photo): HTMLElement {
  const fig = document.createElement('figure');
  fig.className = 'p';

  // The photo's own pixel width. CSS divides it by --dpr to lay the photo out
  // at exactly one image pixel per device pixel.
  const widths = p.v.length ? p.v : [...WIDTHS];
  const largest = Math.max(...widths);
  fig.style.setProperty('--nat', `${p.w}px`);

  const link = document.createElement('a');
  link.style.setProperty('--c', p.c);
  link.href = variantUrl(p.id, largest);
  link.target = '_blank';
  link.rel = 'noopener';

  const img = document.createElement('img');
  img.src = variantUrl(p.id, largest);
  if (widths.length > 1) {
    img.srcset = widths.map((w) => `${variantUrl(p.id, w)} ${w}w`).join(', ');
    // sizes describes the LAYOUT width, not the variant width. Getting this
    // wrong makes the browser pick by the wrong yardstick -- quoting 1600 here
    // would pull the 2x file down on 1x screens too.
    img.sizes = `(max-width: ${COLUMN_PX}px) 100vw, ${COLUMN_PX}px`;
  }
  img.width = p.w;
  img.height = p.h;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = p.d ?? '';
  // Fade in only for images that were not already in cache.
  if (img.complete) img.classList.add('on');
  else img.addEventListener('load', () => img.classList.add('on'), { once: true });

  link.append(img);
  fig.append(link);

  const cap = caption(p);
  if (cap) fig.append(cap);
  return fig;
}

async function loadNextShard(): Promise<void> {
  if (loading || !index || nextShard < 0) return;
  loading = true;
  const shard = index.shards[nextShard];
  if (!shard) {
    loading = false;
    return;
  }
  try {
    const res = await fetch(mediaUrl(`m/${shard.file}`));
    if (!res.ok) throw new Error(`shard ${shard.file}: ${res.status}`);
    const photos = (await res.json()) as Photo[];

    const frag = document.createDocumentFragment();
    // Shards are stored oldest-first; the stream reads newest-first.
    for (let i = photos.length - 1; i >= 0; i--) {
      const p = photos[i];
      if (p) frag.append(render(p));
    }
    stream.append(frag);

    nextShard--;
    if (nextShard < 0) statusEl.textContent = '';
  } catch (err) {
    statusEl.textContent = 'Could not load more photos.';
    console.error(err);
    nextShard = -1;
  } finally {
    loading = false;
  }
}

/**
 * Publishes devicePixelRatio to CSS, where .p divides the photo's intrinsic
 * width by it. Re-arms after every change: dpr is not fixed -- it moves when
 * the window is dragged to another monitor and when the user zooms.
 */
function trackDpr(): void {
  const apply = (): void => {
    document.documentElement.style.setProperty('--dpr', String(window.devicePixelRatio || 1));
    window
      .matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      .addEventListener('change', apply, { once: true });
  };
  apply();
}

async function main(): Promise<void> {
  try {
    const res = await fetch(mediaUrl('index.json'));
    if (!res.ok) throw new Error(`index: ${res.status}`);
    index = (await res.json()) as Index;
  } catch (err) {
    statusEl.textContent = 'Could not load photos.';
    console.error(err);
    return;
  }

  if (!index.shards.length || index.total === 0) {
    statusEl.textContent = 'No photos yet.';
    return;
  }

  nextShard = index.shards.length - 1;
  await loadNextShard();

  // One observer, on a bottom sentinel. Images lazy-load natively, so this is
  // the only scroll-driven work the page does.
  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadNextShard();
    },
    { rootMargin: '1500px 0px' },
  );
  io.observe(sentinel);
}

trackDpr();
void main();
