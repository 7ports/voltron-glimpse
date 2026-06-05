const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

function safeResolve(rootDir, urlPath) {
  // Strip query string and decode
  const noQuery = urlPath.split('?')[0];
  let decoded;
  try {
    decoded = decodeURIComponent(noQuery);
  } catch (_err) {
    return null;
  }
  // Default index for "/" or empty
  const rel = decoded === '' || decoded === '/' ? '/index.html' : decoded;
  // Normalize and resolve relative to rootDir
  const resolved = path.resolve(rootDir, '.' + rel);
  // Prevent traversal: resolved must be inside rootDir (or equal to it)
  const normalizedRoot = path.resolve(rootDir);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    return null;
  }
  return resolved;
}

function createHttpServer(publicDir) {
  if (!publicDir || typeof publicDir !== 'string') {
    throw new Error('createHttpServer: publicDir is required');
  }
  const rootDir = path.resolve(publicDir);

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }
    const filePath = safeResolve(rootDir, req.url || '/');
    if (!filePath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    fs.stat(filePath, (err, stat) => {
      if (err || !stat || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': contentTypeFor(filePath),
        'Content-Length': stat.size,
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => {
        try { res.destroy(); } catch (_e) { /* ignore */ }
      });
      stream.pipe(res);
    });
  });

  return server;
}

module.exports = { createHttpServer };
