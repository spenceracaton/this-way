import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = process.env.STATIC_ROOT ? path.resolve(process.env.STATIC_ROOT)
  : path.resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = Number((portIndex >= 0 ? args[portIndex + 1] : process.env.PORT) || 5173);
const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': (types[path.extname(file)] || 'text/plain') + '; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(content);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(port, '0.0.0.0', () => console.log(`Local: http://localhost:${server.address().port}`));
