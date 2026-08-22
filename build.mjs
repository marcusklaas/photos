import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const dev = process.argv.includes('--dev');

// Where the media repo is served from. In dev we copy ./fixture to dist/media
// so the whole stream is testable with no network and no GitHub.
const MEDIA_BASE_URL =
  process.env.PHOTOS_MEDIA_URL ?? (dev ? './media' : 'https://REPLACE-ME.github.io/photos-media');

// Path the APP is served under. "/" for a user site or custom domain;
// "/photos/" for a project site at user.github.io/photos/.
const BASE = (process.env.PHOTOS_BASE_PATH ?? '/').replace(/\/*$/, '/');

await rm('dist', { recursive: true, force: true });
await mkdir('dist/upload', { recursive: true });

await esbuild.build({
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: !dev,
  sourcemap: dev,
  logLevel: 'info',
  loader: { '.wasm': 'file' },
  assetNames: 'assets/[name]-[hash]',
  // assetNames already contains "assets/", so publicPath is just the base.
  publicPath: BASE,
  define: {
    __MEDIA_BASE_URL__: JSON.stringify(MEDIA_BASE_URL),
    __DEV__: JSON.stringify(dev),
  },
  entryPoints: {
    'stream': 'src/stream/main.ts',
    'upload/upload': 'src/upload/main.ts',
    'upload/encode.worker': 'src/upload/encode.worker.ts',
  },
  outdir: 'dist',
});

/** Copy an HTML file, inlining the stylesheet and resolving %BASE%. */
async function page(htmlPath, cssPath, outPath) {
  const [html, css] = await Promise.all([readFile(htmlPath, 'utf8'), readFile(cssPath, 'utf8')]);
  const min = dev ? css : (await esbuild.transform(css, { loader: 'css', minify: true })).code;
  const out = html
    .replace('<!--INLINE_CSS-->', `<style>${min}</style>`)
    .replaceAll('%BASE%', BASE);
  await writeFile(outPath, out);
}

await page('src/stream/index.html', 'src/stream/stream.css', 'dist/index.html');
await page('src/upload/index.html', 'src/upload/upload.css', 'dist/upload/index.html');

// Pages would otherwise run Jekyll over the output and drop _-prefixed paths.
await writeFile('dist/.nojekyll', '');

if (dev && existsSync('fixture')) {
  await cp('fixture', 'dist/media', { recursive: true });
  console.log('  copied fixture -> dist/media');
}

console.log(`\nbuilt (${dev ? 'dev' : 'prod'})\n  base:  ${BASE}\n  media: ${MEDIA_BASE_URL}`);
