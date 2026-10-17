import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();

test('Phase 1 - HTML App Shell integrity', () => {
  const htmlPath = path.join(rootDir, 'index.html');
  assert.ok(fs.existsSync(htmlPath), 'index.html must exist');
  
  const content = fs.readFileSync(htmlPath, 'utf-8');
  assert.match(content, /<!doctype html>/i, 'Must have HTML5 doctype');
  assert.match(content, /<meta[^>]+viewport[^>]+>/i, 'Must have viewport meta tag');
  assert.match(content, /href=["']\.\/manifest\.webmanifest["']/, 'Manifest link must be relative');
  assert.match(content, /href=["']\.\/style\.css["']/, 'CSS link must be relative');
  assert.match(content, /navigator\.serviceWorker\.register\(['"]\.\/sw\.js['"]/, 'Service worker registration must use relative path');
  assert.match(content, /scope:\s*['"]\.\/['"]/, 'Service worker registration scope must be relative');

  // Safe update UI banner and version indicator
  assert.match(content, /id=["']update-banner["']/, 'Must contain update banner element');
  assert.match(content, /New version available,\s*tap to reload/i, 'Banner must display update notification copy');
  assert.match(content, /id=["']status-version["']/, 'Status panel must contain version number element');
  assert.match(content, /controllerchange/, 'Must listen to controllerchange for reloading upon worker update');
  assert.match(content, /skipWaiting/, 'Must post message to trigger skipWaiting on update tap');
});

test('Phase 1 - CSS Mobile-First and Themes', () => {
  const cssPath = path.join(rootDir, 'style.css');
  assert.ok(fs.existsSync(cssPath), 'style.css must exist');
  
  const content = fs.readFileSync(cssPath, 'utf-8');
  assert.match(content, /prefers-color-scheme:\s*dark/, 'Must support prefers-color-scheme: dark');
  assert.match(content, /min-height:\s*48px/, 'Touch targets must be at least 48px');
  assert.match(content, /min-width:\s*48px/, 'Touch targets must be at least 48px width');
  assert.match(content, /\.update-banner/, 'Must include styles for update banner');
});

test('Phase 1 - Web App Manifest specification', () => {
  const manifestPath = path.join(rootDir, 'manifest.webmanifest');
  assert.ok(fs.existsSync(manifestPath), 'manifest.webmanifest must exist');
  
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  assert.equal(manifest.name, 'EchoMap');
  assert.equal(manifest.short_name, 'EchoMap');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2, 'Must have at least 2 icons');

  for (const icon of manifest.icons) {
    assert.ok(icon.src.startsWith('./'), `Icon path must be relative: ${icon.src}`);
    const resolvedPath = path.join(rootDir, icon.src.replace(/^\.\//, ''));
    assert.ok(fs.existsSync(resolvedPath), `Icon file must exist: ${resolvedPath}`);
  }
});

test('Phase 1 - Icon binary format and dimensions', () => {
  function verifyPng(filePath, expectedWidth, expectedHeight) {
    const buf = fs.readFileSync(filePath);
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    const sig = buf.subarray(0, 8);
    assert.deepEqual(
      Array.from(sig),
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${filePath} must have valid PNG signature`
    );
    // IHDR width at offset 16 (4 bytes, big-endian), height at offset 20
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    assert.equal(width, expectedWidth, `${filePath} width mismatch`);
    assert.equal(height, expectedHeight, `${filePath} height mismatch`);
  }

  verifyPng(path.join(rootDir, 'icons/icon-192.png'), 192, 192);
  verifyPng(path.join(rootDir, 'icons/icon-512.png'), 512, 512);
});

test('Phase 1 - Service Worker structure, safe update flow, and caching strategies', () => {
  const swPath = path.join(rootDir, 'sw.js');
  assert.ok(fs.existsSync(swPath), 'sw.js must exist');
  
  const content = fs.readFileSync(swPath, 'utf-8');
  assert.match(content, /const\s+CACHE_NAME\s*=\s*['"]echomap-v\d+['"]/, 'Must define versioned cache name');
  assert.match(content, /caches\.delete/, 'Must delete stale caches on activate');
  assert.match(content, /self\.clients\.claim\(\)/, 'Must claim clients on activate');

  // Verify that blind skipWaiting is NOT present in install handler
  const installHandlerMatch = content.match(/addEventListener\(['"]install['"],\s*(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>\s*\{([\s\S]*?)\}\s*\);/);
  assert.ok(installHandlerMatch, 'Must have install event listener');
  assert.doesNotMatch(installHandlerMatch[1], /self\.skipWaiting\(\)/, 'Install handler must not call self.skipWaiting() blindly');

  // Verify message-based skipWaiting
  assert.match(content, /addEventListener\(['"]message['"][\s\S]*self\.skipWaiting\(\)/, 'Must trigger skipWaiting in response to message');

  // Verify network-first with timeout for all same-origin GET requests with cache fallback
  assert.match(content, /const\s+NETWORK_TIMEOUT_MS\s*=\s*3000;?/, 'Must configure 3000ms (3s) network timeout');
  assert.match(content, /fetch\(request,\s*\{\s*cache:\s*['"]no-cache['"]\s*\}\)/, 'Must fetch with cache: no-cache to bypass HTTP cache on GitHub Pages');
  assert.match(content, /fetchWithTimeout[\s\S]*caches\.open\(CACHE_NAME\)/, 'Must fetch network-first with timeout and cache successful basic responses');
  assert.match(content, /caches\.match\(event\.request\)/, 'Must fall back to cache upon network timeout or error');
  assert.match(content, /isIndexHtmlRequest/, 'Must have navigation / index.html detection helper');
  assert.match(content, /caches\.match\(['"]\.\/index\.html['"]\)/, 'Must maintain index.html fallback for navigations');

  // Parse precache array
  const match = content.match(/const\s+PRECACHE_ASSETS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(match, 'Must define PRECACHE_ASSETS array');
  const assetPaths = match[1]
    .split(',')
    .map(s => s.trim().replace(/['"]/g, ''))
    .filter(Boolean);

  for (const asset of assetPaths) {
    assert.ok(asset.startsWith('./'), `Precache path must be relative: ${asset}`);
    if (asset === './') continue;
    const resolvedPath = path.join(rootDir, asset.replace(/^\.\//, ''));
    assert.ok(fs.existsSync(resolvedPath), `Precached asset must exist: ${resolvedPath}`);
  }
});

test('Phase 1 - Service Worker asserts NO route is cache-first', () => {
  const swPath = path.join(rootDir, 'sw.js');
  assert.ok(fs.existsSync(swPath), 'sw.js must exist');

  const content = fs.readFileSync(swPath, 'utf-8');

  // Assert no cache-first pattern exists: caches.match(...) must NOT be called before network fetch in fetch listener
  assert.doesNotMatch(
    content,
    /caches\.match\(event\.request\)[\s\S]*fetch\(/,
    'No route should be cache-first (caches.match before fetch is forbidden)'
  );

  // Assert all same-origin GET routes go through network-first fetchWithTimeout
  assert.match(
    content,
    /event\.respondWith\(\s*fetchWithTimeout\(event\.request/,
    'All requests must use network-first strategy via fetchWithTimeout'
  );

  // Assert non-GET and cross-origin requests are excluded from SW handling/caching
  assert.match(content, /event\.request\.method\s*!==\s*['"]GET['"]/, 'Must exclude non-GET requests');
  assert.match(content, /url\.origin\s*!==\s*self\.location\.origin/, 'Must exclude cross-origin requests');
});

test('Phase 1 - Subpath HTTP server integration test', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    let reqPath = req.url.split('?')[0];
    if (reqPath.startsWith('/room-acoustic-analyzer')) {
      reqPath = reqPath.slice('/room-acoustic-analyzer'.length);
    }
    if (reqPath === '' || reqPath === '/') reqPath = '/index.html';
    const filePath = path.join(rootDir, reqPath);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      let contentType = 'text/plain';
      if (filePath.endsWith('.html')) contentType = 'text/html';
      else if (filePath.endsWith('.css')) contentType = 'text/css';
      else if (filePath.endsWith('.js')) contentType = 'application/javascript';
      else if (filePath.endsWith('.webmanifest')) contentType = 'application/manifest+json';
      else if (filePath.endsWith('.png')) contentType = 'image/png';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(fs.readFileSync(filePath));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const testUrls = [
    `http://127.0.0.1:${port}/room-acoustic-analyzer/`,
    `http://127.0.0.1:${port}/room-acoustic-analyzer/index.html`,
    `http://127.0.0.1:${port}/room-acoustic-analyzer/style.css`,
    `http://127.0.0.1:${port}/room-acoustic-analyzer/manifest.webmanifest`,
    `http://127.0.0.1:${port}/room-acoustic-analyzer/sw.js`,
    `http://127.0.0.1:${port}/room-acoustic-analyzer/icons/icon-192.png`,
    `http://127.0.0.1:${port}/room-acoustic-analyzer/icons/icon-512.png`,
    `http://127.0.0.1:${port}/room-acoustic-analyzer/src/ui/coordinates.js`,
    `http://127.0.0.1:${port}/room-acoustic-analyzer/src/ui/session-model.js`,
    `http://127.0.0.1:${port}/room-acoustic-analyzer/src/ui/floorplan.js`,
    `http://127.0.0.1:${port}/room-acoustic-analyzer/src/ui/dimensions.js`,
    `http://127.0.0.1:${port}/room-acoustic-analyzer/src/ui/app.js`,
    `http://127.0.0.1:${port}/room-acoustic-analyzer/src/store/storage.js`,
    `http://127.0.0.1:${port}/room-acoustic-analyzer/src/store/export.js`
  ];

  try {
    for (const url of testUrls) {
      const response = await fetch(url);
      assert.equal(response.status, 200, `Failed to fetch: ${url}`);
      assert.ok(response.headers.get('content-type'), `Missing content-type for ${url}`);
    }
  } finally {
    server.close();
  }
});

