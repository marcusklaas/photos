import type { Index, Photo } from '../types.js';
import { SHARD_SIZE } from '../config.js';
import { readExif, type Exif } from './exif.js';
import { emptyIndex, planPublish } from './manifest.js';
import {
  checkAccess,
  commitFiles,
  readJson,
  GitHubError,
  type FileWrite,
  type RepoRef,
} from './github.js';
import type { EncodeRequest, EncodeResponse } from './encode.worker.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const els = {
  owner: $<HTMLInputElement>('owner'),
  repo: $<HTMLInputElement>('repo'),
  branch: $<HTMLInputElement>('branch'),
  token: $<HTMLInputElement>('token'),
  authState: $('authState'),
  settings: $<HTMLDetailsElement>('settings'),
  save: $<HTMLButtonElement>('save'),
  forget: $<HTMLButtonElement>('forget'),
  drop: $('drop'),
  files: $<HTMLInputElement>('files'),
  queue: $<HTMLUListElement>('queue'),
  publish: $<HTMLButtonElement>('publish'),
  pubStatus: $('pubStatus'),
};

const LS_TOKEN = 'photos.token';
const LS_REPO = 'photos.repo';

// ---------------------------------------------------------------- settings

function repoRef(): RepoRef {
  return {
    owner: els.owner.value.trim(),
    repo: els.repo.value.trim(),
    branch: els.branch.value.trim() || 'main',
  };
}

function setAuth(text: string, cls: '' | 'ok' | 'bad'): void {
  els.authState.textContent = text;
  els.authState.className = `pill ${cls}`;
}

function loadSettings(): void {
  els.token.value = localStorage.getItem(LS_TOKEN) ?? '';
  try {
    const saved = JSON.parse(localStorage.getItem(LS_REPO) ?? '{}') as Partial<RepoRef>;
    els.owner.value = saved.owner ?? '';
    els.repo.value = saved.repo ?? '';
    els.branch.value = saved.branch ?? 'main';
  } catch {
    /* first run */
  }
  const configured = Boolean(els.token.value && els.owner.value && els.repo.value);
  if (!configured) els.settings.open = true;
  setAuth(configured ? 'saved, not verified' : 'not configured', configured ? '' : 'bad');
}

els.save.addEventListener('click', () => {
  void (async () => {
    const ref = repoRef();
    const token = els.token.value.trim();
    if (!token || !ref.owner || !ref.repo) {
      setAuth('fill in every field', 'bad');
      return;
    }
    setAuth('checking...', '');
    try {
      await checkAccess(token, ref);
      localStorage.setItem(LS_TOKEN, token);
      localStorage.setItem(LS_REPO, JSON.stringify(ref));
      setAuth('write access confirmed', 'ok');
      els.settings.open = false;
    } catch (err) {
      setAuth(err instanceof Error ? err.message : 'failed', 'bad');
    }
  })();
});

els.forget.addEventListener('click', () => {
  localStorage.removeItem(LS_TOKEN);
  els.token.value = '';
  setAuth('token forgotten', '');
  els.settings.open = true;
});

// ---------------------------------------------------------- encoding pool

type Ready = { w: number; h: number; c: string; q: number; variants: [number, ArrayBuffer][] };

type Item = {
  file: File;
  status: 'pending' | 'working' | 'ready' | 'error';
  error?: string;
  exif: Exif;
  keepG: boolean;
  desc: string;
  ready?: Ready;
  photoId?: string;
  timeValue: string;
  previewUrl?: string;
  row: HTMLLIElement;
  stateEl: HTMLElement;
  thumb: HTMLImageElement;
};

const items: Item[] = [];

const workerUrl = new URL('./encode.worker.js', import.meta.url);
// Leave a core free so the page stays responsive while encoding.
const POOL = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));

type Job = {
  file: File;
  note: (text: string) => void;
  resolve: (r: Ready) => void;
  reject: (e: Error) => void;
};
const waiting: Job[] = [];
const idle: Worker[] = [];
let spawned = 0;
let jobSeq = 1;

function pump(): void {
  while (waiting.length && (idle.length || spawned < POOL)) {
    const job = waiting.shift();
    if (!job) return;
    let worker = idle.pop();
    if (!worker) {
      worker = new Worker(workerUrl, { type: 'module' });
      spawned++;
    }
    const w = worker;
    const jobId = jobSeq++;

    const release = (): void => {
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
      idle.push(w);
      pump();
    };
    const onMessage = (ev: MessageEvent<EncodeResponse>): void => {
      if (ev.data.jobId !== jobId) return;
      // Progress note: the worker is still on this job, so hold the worker.
      if ('note' in ev.data) {
        job.note(ev.data.note);
        return;
      }
      release();
      if (ev.data.ok) job.resolve(ev.data);
      else job.reject(new Error(ev.data.error));
    };
    const onError = (ev: ErrorEvent): void => {
      release();
      job.reject(new Error(ev.message || 'worker crashed'));
    };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    const req: EncodeRequest = { jobId, file: job.file };
    w.postMessage(req);
  }
}

const encodeInWorker = (file: File, note: (text: string) => void): Promise<Ready> =>
  new Promise<Ready>((resolve, reject) => {
    waiting.push({ file, note, resolve, reject });
    pump();
  });

// ---------------------------------------------------------------- queue UI

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setState(item: Item, text: string, cls: '' | 'err' | 'ok' = ''): void {
  item.stateEl.textContent = text;
  item.stateEl.className = `state ${cls}`;
}

function buildRow(item: Item): void {
  const row = item.row;
  item.thumb.className = 'thumb';
  item.thumb.alt = '';
  row.append(item.thumb);

  const meta = el('div');
  const name = el('div', 'name');
  name.append(item.file.name, item.stateEl);
  meta.append(name);

  const keeps = el('div', 'keeps');

  // --- timestamp: REQUIRED, because the stream is ordered by it
  const tWrap = el('label', 'keep');
  const tInput = el('input');
  tInput.type = 'datetime-local';
  tInput.required = true;
  tInput.value = item.timeValue;
  tWrap.append(el('span', undefined, 'Time'), tInput);
  const tHint = el('span', 'val', item.exif.t ? '' : 'not in file - check this');
  tWrap.append(tHint);
  const syncTime = () => {
    item.timeValue = tInput.value;
    tWrap.classList.toggle('missing', !tInput.value);
    tHint.textContent = tInput.value ? (item.exif.t ? '' : 'guessed') : 'required';
    refreshPublish();
  };
  tInput.addEventListener('change', syncTime);
  tInput.addEventListener('input', syncTime);
  tWrap.classList.toggle('missing', !item.timeValue);
  keeps.append(tWrap);

  // --- location: full EXIF precision, no rounding, no third-party lookup
  const gWrap = el('label', 'keep');
  const gBox = el('input');
  gBox.type = 'checkbox';
  gBox.checked = item.keepG;
  gBox.disabled = !item.exif.g;
  const gVal = el(
    'span',
    'val',
    item.exif.g ? `${item.exif.g[0].toFixed(5)}, ${item.exif.g[1].toFixed(5)}` : 'none in file',
  );
  gWrap.append(gBox, el('span', undefined, 'Location'), gVal);
  gWrap.classList.toggle('off', !item.keepG);
  gBox.addEventListener('change', () => {
    item.keepG = gBox.checked;
    gWrap.classList.toggle('off', !gBox.checked);
  });
  keeps.append(gWrap);
  meta.append(keeps);

  const desc = el('input', 'desc');
  desc.type = 'text';
  desc.placeholder = 'Description (optional)';
  desc.addEventListener('input', () => {
    item.desc = desc.value;
  });
  meta.append(desc);
  row.append(meta);

  const remove = el('button', 'ghost remove', 'Remove');
  remove.addEventListener('click', () => {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    row.remove();
    const at = items.indexOf(item);
    if (at >= 0) items.splice(at, 1);
    refreshPublish();
  });
  row.append(remove);
}

/** "YYYY-MM-DDTHH:mm:ss" in local time, matching how EXIF records wall clock. */
function localIsoFromMs(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** datetime-local gives minute precision; the wire format wants seconds. */
function normaliseTime(value: string): string {
  return value.length === 16 ? `${value}:00` : value;
}

const hasTime = (i: Item): boolean => Boolean(i.timeValue);

async function sha256Short(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

async function addFile(file: File): Promise<void> {
  const item: Item = {
    file,
    status: 'pending',
    exif: {},
    keepG: true,
    desc: '',
    timeValue: '',
    row: el('li', 'item'),
    stateEl: el('span', 'state'),
    thumb: el('img'),
  };
  items.push(item);
  els.queue.append(item.row);

  if (!ACCEPTED.includes(file.type)) {
    const heic = /hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
    item.status = 'error';
    item.error = heic
      ? 'HEIC cannot be decoded by this browser. Export as JPEG first.'
      : `Unsupported type "${file.type || 'unknown'}".`;
    buildRow(item);
    item.row.classList.add('error');
    setState(item, item.error, 'err');
    refreshPublish();
    return;
  }

  item.previewUrl = URL.createObjectURL(file);
  item.thumb.src = item.previewUrl;

  // EXIF first: re-encoding destroys it, so anything not read here is gone.
  item.exif = await readExif(file);
  item.keepG = Boolean(item.exif.g);
  // Always prefill something: a blank required field is a dead end. EXIF if we
  // have it, otherwise the file's own timestamp, flagged in the UI as a guess.
  item.timeValue = (item.exif.t ?? localIsoFromMs(file.lastModified)).slice(0, 16);

  buildRow(item);
  item.status = 'working';
  setState(item, 'encoding...');
  refreshPublish();

  try {
    const ready = await encodeInWorker(file, (text) => setState(item, text));
    const main =
      ready.variants.find(([w]) => w === 800) ?? ready.variants[ready.variants.length - 1];
    if (!main) throw new Error('encoder produced no output');

    item.photoId = await sha256Short(main[1]);
    item.ready = ready;
    item.status = 'ready';

    const total = ready.variants.reduce((n, [, b]) => n + b.byteLength, 0);
    // Quality is worth showing: it is the same for most photos, so a lower one
    // is the visible sign that this photo hit the byte budget and stepped down.
    setState(
      item,
      `${ready.w}x${ready.h} · ${(total / 1024).toFixed(0)} kB · quality ${ready.q}`,
      'ok',
    );

    // Swap the preview to the encoded result: what you see is what publishes.
    const small = ready.variants[0];
    if (small) {
      const url = URL.createObjectURL(new Blob([small[1]], { type: 'image/avif' }));
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      item.previewUrl = url;
      item.thumb.src = url;
    }
  } catch (err) {
    item.status = 'error';
    item.error = err instanceof Error ? err.message : String(err);
    item.row.classList.add('error');
    setState(item, item.error, 'err');
  }
  refreshPublish();
}

function refreshPublish(): void {
  const ready = items.filter((i) => i.status === 'ready');
  const busy = items.some((i) => i.status === 'working' || i.status === 'pending');
  const undated = ready.filter((i) => !hasTime(i)).length;

  els.publish.disabled = ready.length === 0 || busy || undated > 0;
  els.publish.textContent = ready.length
    ? `Publish ${ready.length} photo${ready.length === 1 ? '' : 's'}`
    : 'Publish';

  if (busy) els.pubStatus.textContent = 'encoding...';
  else if (undated) {
    els.pubStatus.textContent = `${undated} photo${undated === 1 ? ' needs a' : 's need a'} time before publishing.`;
  } else if (
    els.pubStatus.textContent === 'encoding...' ||
    els.pubStatus.textContent.endsWith('before publishing.')
  ) {
    els.pubStatus.textContent = '';
  }
}

// ------------------------------------------------------------------ input

els.files.addEventListener('change', () => {
  for (const f of Array.from(els.files.files ?? [])) void addFile(f);
  els.files.value = '';
});

for (const type of ['dragenter', 'dragover'] as const) {
  els.drop.addEventListener(type, (e) => {
    e.preventDefault();
    els.drop.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop'] as const) {
  els.drop.addEventListener(type, () => els.drop.classList.remove('over'));
}
els.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  for (const f of Array.from(e.dataTransfer?.files ?? [])) void addFile(f);
});

// ---------------------------------------------------------------- publish

function toPhoto(item: Item): Photo {
  const ready = item.ready;
  if (!ready || !item.photoId) throw new Error('not encoded');

  const photo: Photo = {
    id: item.photoId,
    w: ready.w,
    h: ready.h,
    v: ready.variants.map(([w]) => w),
    c: ready.c,
    t: normaliseTime(item.timeValue),
  };

  if (item.keepG && item.exif.g) photo.g = item.exif.g;
  const desc = item.desc.trim();
  if (desc) photo.d = desc;

  return photo;
}

async function publish(): Promise<void> {
  const token = els.token.value.trim();
  const ref = repoRef();
  const ready = items.filter((i) => i.status === 'ready');
  if (!ready.length) return;

  if (!token || !ref.owner || !ref.repo) {
    els.pubStatus.textContent = 'Configure the repository and token first.';
    els.pubStatus.className = 'err';
    els.settings.open = true;
    return;
  }

  els.publish.disabled = true;
  els.pubStatus.className = '';

  const photos = ready.map(toPhoto);

  // Image blobs do not depend on manifest state, so build them once and reuse
  // across retries.
  const imageFiles: FileWrite[] = [];
  for (const item of ready) {
    for (const [w, buf] of item.ready?.variants ?? []) {
      imageFiles.push({ path: `p/${item.photoId}-${w}.avif`, content: buf });
    }
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      els.pubStatus.textContent = 'reading manifest...';
      const index = (await readJson<Index>(token, ref, 'index.json')) ?? emptyIndex(SHARD_SIZE);
      // Ordering is by capture time, so an addition can land in any shard --
      // we need all of them, not just the tail.
      const existing: Photo[][] = [];
      for (const entry of index.shards) {
        existing.push((await readJson<Photo[]>(token, ref, `m/${entry.file}`)) ?? []);
      }

      const plan = planPublish(index, existing, photos);
      const files: FileWrite[] = [
        ...imageFiles,
        ...plan.shards.map((sh) => ({ path: sh.path, content: JSON.stringify(sh.photos) })),
        { path: 'index.json', content: JSON.stringify(plan.index) },
      ];

      const sha = await commitFiles(
        token,
        ref,
        files,
        `Add ${photos.length} photo${photos.length === 1 ? '' : 's'}`,
        (done, total) => {
          els.pubStatus.textContent = `uploading ${done}/${total}...`;
        },
      );

      // Published items leave the queue; anything that errored stays put.
      for (const item of ready) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        item.row.remove();
        const at = items.indexOf(item);
        if (at >= 0) items.splice(at, 1);
      }

      els.pubStatus.replaceChildren();
      const link = el('a', undefined, sha.slice(0, 7));
      link.href = `https://github.com/${ref.owner}/${ref.repo}/commit/${sha}`;
      link.target = '_blank';
      link.rel = 'noopener';
      els.pubStatus.append('Published as ', link, '. Pages redeploys within a minute or so.');
      refreshPublish();
      return;
    } catch (err) {
      // 422 means the ref moved under us: re-read the manifest and rebuild the
      // plan rather than force-pushing over whatever landed.
      const conflict = err instanceof GitHubError && (err.status === 422 || err.status === 409);
      if (conflict && attempt < 3) {
        els.pubStatus.textContent = 'branch moved, retrying...';
        continue;
      }
      els.pubStatus.textContent = err instanceof Error ? err.message : String(err);
      els.pubStatus.className = 'err';
      refreshPublish();
      return;
    }
  }
}

els.publish.addEventListener('click', () => void publish());

loadSettings();
