const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOST = '0.0.0.0';
const DEFAULT_PORT = 8000;

// Absolute path to web root
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function sendNoCacheHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function safeResolve(requestPath) {
  const resolvedPath = path.normalize(path.join(PUBLIC_DIR, requestPath));
  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    return null; // path traversal attempt
  }
  return resolvedPath;
}
function serveFile(res, filePath) {
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.statusCode = 404;
      return res.end('File not found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Last-Modified', stats.mtime.toUTCString);

    sendNoCacheHeaders(res);

    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const rawPath = decodeURIComponent(req.url.split('?')[0]);

  const requestPath =
    rawPath === '/' ? '/index.html' : rawPath;

  const fullPath = safeResolve(requestPath);

  if (!fullPath) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  serveFile(res, fullPath);

  console.log(
    `${req.socket.remoteAddress} - ${new Date().toISOString()} ${req.method} ${rawPath}`
  );
});

const port = process.argv[2]
  ? parseInt(process.argv[2], 10)
  : DEFAULT_PORT;

function getLocalIP() {
  const interfaces = os.networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }

  return '127.0.0.1';
}
server.listen(port, HOST, () => {
  const ip = getLocalIP();

  console.log(`Serving locally: http://localhost:${port}/`);
  console.log(`Serving on LAN:  http://${ip}:${port}/`);
  console.log(`Web root: ${PUBLIC_DIR}`);
});
