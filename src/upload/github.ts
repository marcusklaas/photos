export type RepoRef = { owner: string; repo: string; branch: string };

export type FileWrite = {
  path: string;
  /** Text content, or raw bytes for the AVIFs. */
  content: string | ArrayBuffer;
};

const API = 'https://api.github.com';

class GitHubError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'GitHubError';
  }
}

async function gh<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) detail = body.message;
    } catch {
      /* keep statusText */
    }
    throw new GitHubError(res.status, `${path.split('?')[0]}: ${detail}`);
  }
  return (await res.json()) as T;
}

/** Chunked, because String.fromCharCode(...bytes) blows the stack on real photos. */
function toBase64(data: string | ArrayBuffer): string {
  if (typeof data === 'string') {
    // TextEncoder first, so non-ASCII descriptions survive the round trip.
    const bytes = new TextEncoder().encode(data);
    return toBase64(bytes.buffer as ArrayBuffer);
  }
  const bytes = new Uint8Array(data);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Verifies the token and that the repo is writable, before any encoding work. */
export async function checkAccess(token: string, ref: RepoRef): Promise<void> {
  const repo = await gh<{ permissions?: { push?: boolean }; default_branch: string }>(
    token,
    `/repos/${ref.owner}/${ref.repo}`,
  );
  if (!repo.permissions?.push) {
    throw new Error('Token cannot write to this repository (needs Contents: read and write).');
  }
}

/**
 * Reads a file at the branch HEAD. Deliberately via the API, not the Pages URL:
 * the Pages CDN can be minutes stale, and appending to a stale manifest would
 * silently drop photos.
 */
export async function readJson<T>(token: string, ref: RepoRef, path: string): Promise<T | null> {
  try {
    const res = await gh<{ content: string; encoding: string }>(
      token,
      `/repos/${ref.owner}/${ref.repo}/contents/${path}?ref=${encodeURIComponent(ref.branch)}`,
    );
    if (res.encoding !== 'base64') throw new Error(`unexpected encoding ${res.encoding}`);
    const binary = atob(res.content.replace(/\n/g, ''));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (err) {
    // A missing file is the normal first-upload case, not an error.
    if (err instanceof GitHubError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Writes every file in ONE commit via the Git Data API.
 *
 * The Contents API would need a commit per file (five per photo). This builds
 * blobs, a tree and a commit, then moves the ref — so a failure part-way leaves
 * the branch untouched rather than half-published.
 */
export async function commitFiles(
  token: string,
  ref: RepoRef,
  files: FileWrite[],
  message: string,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const base = `/repos/${ref.owner}/${ref.repo}/git`;

  const head = await gh<{ object: { sha: string } }>(
    token,
    `${base}/ref/heads/${encodeURIComponent(ref.branch)}`,
  );
  const parent = head.object.sha;
  const parentCommit = await gh<{ tree: { sha: string } }>(token, `${base}/commits/${parent}`);

  // Blobs are independent; upload them a few at a time rather than serially.
  const shas: string[] = new Array(files.length);
  let done = 0;
  const LANES = 4;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(LANES, files.length) }, async () => {
      for (let i = next++; i < files.length; i = next++) {
        const file = files[i];
        if (!file) continue;
        const blob = await gh<{ sha: string }>(token, `${base}/blobs`, {
          method: 'POST',
          body: JSON.stringify({ content: toBase64(file.content), encoding: 'base64' }),
        });
        shas[i] = blob.sha;
        onProgress?.(++done, files.length);
      }
    }),
  );

  const tree = await gh<{ sha: string }>(token, `${base}/trees`, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: parentCommit.tree.sha,
      tree: files.map((f, i) => ({
        path: f.path,
        mode: '100644',
        type: 'blob',
        sha: shas[i],
      })),
    }),
  });

  const commit = await gh<{ sha: string }>(token, `${base}/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: tree.sha, parents: [parent] }),
  });

  // force:false — if someone else committed meanwhile this rejects rather than
  // clobbering, and the caller retries against fresh manifest state.
  await gh(token, `${base}/refs/heads/${encodeURIComponent(ref.branch)}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });

  return commit.sha;
}

export { GitHubError };
