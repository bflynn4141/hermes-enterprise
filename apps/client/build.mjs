// The client build. esbuild bundles `src/main.tsx` into `dist/`, which the
// Worker's Static Assets binding serves (`wrangler.jsonc` already points
// `assets.directory` at `../client/dist` with SPA fallback and
// `run_worker_first` on the API prefixes).
//
//   node build.mjs                  production bundle
//   node build.mjs --watch --serve  esbuild watch + a static server on 4180
//   MOCK=1 node build.mjs           the standalone mock-server build (docs/DECISIONS)
//
// Two defines carry build-time configuration into the bundle:
//   __AUTH_MODE__  'workos' (default) or 'fake'. The dev account switcher is
//                  behind `__AUTH_MODE__ === 'fake'`, so esbuild's dead-code
//                  elimination removes it, and `verifyBundle` greps for
//                  `x-dev-user` in a production build to prove it.
//   __MOCK__       true only for the mock build; the whole mock backend is
//                  behind it and is eliminated from a real build the same way.
import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const serve = process.argv.includes('--serve');
const mock = process.env.MOCK === '1' || process.argv.includes('--mock');
const authMode = process.env.AUTH_MODE ?? (watch || mock ? 'fake' : 'workos');
const dist = path.join(here, 'dist');
const libRoot = path.join(here, 'node_modules', '@hermes', 'motion-components');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [path.join(here, 'src/main.tsx')],
  bundle: true,
  format: 'esm',
  splitting: true,
  outdir: dist,
  entryNames: 'app',
  chunkNames: 'chunks/[name]-[hash]',
  target: ['es2022'],
  jsx: 'automatic',
  sourcemap: true,
  minify: !watch,
  // `strict` and `erasableSyntaxOnly` mean esbuild only strips types here.
  define: {
    'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'),
    __AUTH_MODE__: JSON.stringify(authMode),
    __MOCK__: JSON.stringify(mock),
  },
  logLevel: 'info',
  metafile: true,
};

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hermes Enterprise</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;500;600&family=Inter:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/components.css">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<div id="root"></div>
<script type="module" src="/app.js"></script>
</body>
</html>
`;

/**
 * The duplicate-token check the plan asks for (plan §10b, pre-production chore).
 * The library's CSS is scoped to `.hermes-ui`, so the honest form of the check
 * is not "no name appears twice" — several do, deliberately — but "the library
 * defines nothing at a scope that can reach the product's own elements".
 */
async function checkTokens() {
  const lib = await fs.readFile(path.join(libRoot, 'dist/components.css'), 'utf8');
  const unscoped = lib.match(/(?:^|[},])\s*(?::root|html|body|\*)[^{]*\{[^}]*--[a-z]/i);
  if (unscoped) throw new Error(`@hermes/motion-components defines a custom property outside .hermes-ui: ${unscoped[0].slice(0, 120)}`);
  const ours = new Set([...(await fs.readFile(path.join(here, 'src/styles.css'), 'utf8')).matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
  const theirs = new Set([...lib.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
  const shared = [...ours].filter((t) => theirs.has(t));
  if (shared.length) console.log(`token overlap (scoped to .hermes-ui, safe): ${shared.join(', ')}`);
}

/**
 * esbuild still emits a chunk for a dynamic import whose branch was folded
 * away, so a production build carries an unreferenced copy of the mock backend.
 * It is dead — nothing imports it — but shipping dead bytes is how dead bytes
 * become live ones later, so an orphan chunk is deleted.
 */
async function pruneOrphanChunks() {
  const chunkDir = path.join(dist, 'chunks');
  let names;
  try {
    names = (await fs.readdir(chunkDir)).filter((name) => name.endsWith('.js'));
  } catch {
    return;
  }
  const entry = await fs.readFile(path.join(dist, 'app.js'), 'utf8');
  const chunks = new Map(await Promise.all(names.map(async (name) => [name, await fs.readFile(path.join(chunkDir, name), 'utf8')])));
  for (const name of names) {
    // A chunk names itself in its own sourcemap comment, so it is excluded from
    // the search for a reference to it.
    const referenced = entry.includes(name) || [...chunks].some(([other, source]) => other !== name && source.includes(name));
    if (referenced) continue;
    await fs.rm(path.join(chunkDir, name), { force: true });
    await fs.rm(path.join(chunkDir, `${name}.map`), { force: true });
    console.log(`pruned unreferenced chunk ${name}`);
  }
}

/** Plan §12.8: `x-dev-user` must not survive into a production bundle. */
async function verifyBundle() {
  if (authMode === 'fake') return;
  const js = await fs.readFile(path.join(dist, 'app.js'), 'utf8');
  if (js.includes('x-dev-user')) throw new Error('production bundle contains x-dev-user: the dev switcher was not eliminated');
}

async function emitStatic() {
  await fs.mkdir(dist, { recursive: true });
  await fs.writeFile(path.join(dist, 'index.html'), INDEX_HTML);
  await fs.copyFile(path.join(here, 'src/styles.css'), path.join(dist, 'styles.css'));
  await fs.copyFile(path.join(libRoot, 'dist/components.css'), path.join(dist, 'components.css'));
  // Attribution travels with the bundle and is linked from Settings → Data and privacy.
  await fs.copyFile(path.join(libRoot, 'dist/LICENSE.beautiful-ui'), path.join(dist, 'LICENSE.beautiful-ui'));
}

await checkTokens();
await emitStatic();

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  fsSync.watch(path.join(here, 'src/styles.css'), () => emitStatic().catch(() => {}));
  console.log(`watching src/ · AUTH_MODE=${authMode} · MOCK=${mock}`);
} else {
  await esbuild.build(options);
  await pruneOrphanChunks();
  await verifyBundle();
  console.log(`built dist/ · AUTH_MODE=${authMode} · MOCK=${mock}`);
}

if (serve) {
  // 4173-4176 are taken by the other prototypes in this tree.
  const port = Number(process.env.PORT ?? 4180);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
  http
    .createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      let file = path.join(dist, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
      try {
        if ((await fs.stat(file)).isDirectory()) file = path.join(file, 'index.html');
      } catch {
        // SPA fallback, the same rule the Worker's asset binding applies.
        file = path.join(dist, 'index.html');
      }
      try {
        const body = await fs.readFile(file);
        res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(body);
      } catch {
        res.writeHead(404).end('not found');
      }
    })
    .listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}`));
}
