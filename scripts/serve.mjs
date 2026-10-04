// Petit serveur statique pour le développement et la prévisualisation (pas pour la production).
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

export function serve(dir, port) {
  const base = resolve(dir);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let file = normalize(join(base, decodeURIComponent(url.pathname)));
    if (!file.startsWith(base)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(base, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  server.listen(port, () => console.log(`http://localhost:${port}`));
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  serve(process.argv[2] ?? 'dist', Number(process.env.PORT) || 4173);
}
