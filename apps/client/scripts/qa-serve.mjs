// A static server for `dist/` with an SPA fallback, used by the QA walk.
// The Worker does this in production and `build.mjs --serve` does it in dev;
// this is the same thing without the watcher, so a screenshot run does not
// depend on a rebuild loop.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const port = Number(process.env.QA_PORT ?? 4181);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.svg': 'image/svg+xml' };

http
  .createServer((req, res) => {
    const requested = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = path.join(root, requested);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'text/plain' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, '127.0.0.1', () => console.log(`qa-serve on http://127.0.0.1:${port}`));
