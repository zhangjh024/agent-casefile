import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Casefile } from './types.js';
import { PACKAGE_ROOT } from './io.js';
export async function startInspector(c: Casefile | undefined, port = 4317): Promise<Server> {
  const staticFiles = new Map<string, { path: string; type: string }>([
    ['/', { path: 'public/index.html', type: 'text/html; charset=utf-8' }],
    ['/app.js', { path: 'public/app.js', type: 'text/javascript; charset=utf-8' }],
    ['/style.css', { path: 'public/style.css', type: 'text/css; charset=utf-8' }],
    ...['index', 'types', 'validation', 'privacy', 'replay', 'recorder'].map(
      (name) =>
        [
          `/lib/${name}.js`,
          { path: `dist/${name}.js`, type: 'text/javascript; charset=utf-8' },
        ] as [string, { path: string; type: string }],
    ),
    ...['tool-timeout', 'tool-timeout-fixed', 'error-shape', 'incomplete'].map(
      (name) =>
        [
          `/examples/${name}.casefile.json`,
          { path: `examples/${name}.casefile.json`, type: 'application/json; charset=utf-8' },
        ] as [string, { path: string; type: string }],
    ),
  ]);
  const server = createServer(async (req, res) => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    const host = req.headers.host;
    const allowedHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
    const origin = req.headers.origin;
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const send = (code: number, content: string | Buffer, type = 'text/plain; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(req.method === 'HEAD' ? undefined : content);
    };
    if (
      !host ||
      !allowedHosts.includes(host) ||
      (origin && !allowedHosts.map((h) => 'http://' + h).includes(origin))
    ) {
      send(403, 'Local requests only.');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(405, 'Read-only inspector.');
      return;
    }
    const path = (req.url ?? '/').split('?')[0]!;
    if (path === '/casefile.json') {
      if (!c) send(404, 'No startup casefile.');
      else send(200, JSON.stringify(c), 'application/json; charset=utf-8');
      return;
    }
    const asset = staticFiles.get(path);
    if (!asset) {
      send(404, 'Not found.');
      return;
    }
    try {
      send(200, await readFile(join(PACKAGE_ROOT, asset.path)), asset.type);
    } catch {
      send(500, 'Inspector asset unavailable. Build the project first.');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}
