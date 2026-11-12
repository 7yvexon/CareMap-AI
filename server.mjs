import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/leaflet.js', ['leaflet.js', 'text/javascript; charset=utf-8']],
  ['/leaflet.css', ['leaflet.css', 'text/css; charset=utf-8']],
  ['/data/ulsan_admin_dong.csv', ['data/ulsan_admin_dong.csv', 'text/csv; charset=utf-8']],
  ['/data/ulsan_care_platforms.csv', ['data/ulsan_care_platforms.csv', 'text/csv; charset=utf-8']],
  ['/data/ulsan_district_summary.csv', ['data/ulsan_district_summary.csv', 'text/csv; charset=utf-8']],
]);

const server = createServer(async (req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }

  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  const entry = files.get(pathname);
  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  try {
    const body = await readFile(join(root, entry[0]));
    res.writeHead(200, {
      'Content-Type': entry[1],
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Unable to read the requested file');
  }
});

const port = Number(process.env.PORT || 8765);
server.listen(port, '127.0.0.1', () => {
  console.log('CareMap AI: http://127.0.0.1:' + port);
});
