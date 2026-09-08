import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import qrcode from 'qrcode-generator';
import { ConfigStore, PROVIDER_IDS, validateSettings } from './lib/config.js';
import { discoverAccounts } from './lib/discover.js';
import { createProviders } from './lib/providers/index.js';
import { UsageCache } from './lib/cache.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/settings', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/favicon.ico', ['icon.svg', 'image/svg+xml']],
]);

export function localAddresses(interfaces = networkInterfaces()) {
  return [...new Set(Object.values(interfaces).flat().filter(item => item && !item.internal && item.family === 'IPv4').map(item => item.address))];
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    throw Object.assign(new Error('Use application/json.'), { status: 415 });
  }
  if (Number(request.headers['content-length']) > 8192) {
    throw Object.assign(new Error('Request is too large.'), { status: 413 });
  }
  let length = 0;
  const chunks = [];
  // Keep the socket alive long enough to send 413 when a chunked body exceeds the cap.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 8192) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

export async function createApplication({
  homeDir = homedir(),
  configPath = join(ROOT, 'data', 'config.json'),
  port = 3140,
  providers,
  discovery = discoverAccounts,
  addresses = localAddresses(),
  now = Date.now,
  autoStart = true,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
  const store = new ConfigStore(configPath);
  let accounts = await discovery({ homeDir });
  let settings = await store.load(accounts);
  const boundLan = settings.lanEnabled;
  const csrfToken = randomBytes(32).toString('hex');
  const cache = new UsageCache({ providers: providers || createProviders({ homeDir }), intervalMs: settings.refreshIntervalMs, now });
  cache.setEnabled(PROVIDER_IDS.filter(id => settings.enabled[id]));
  let settingsQueue = Promise.resolve();
  let actualPort = port;
  let closed = false;

  const meta = () => ({
    port: actualPort,
    bindMode: boundLan ? 'lan' : 'local',
    localUrl: `http://127.0.0.1:${actualPort}`,
    lanUrl: boundLan && addresses.length ? `http://${addresses[0]}:${actualPort}` : null,
    refreshIntervalMs: settings.refreshIntervalMs,
    restartRequired: boundLan !== settings.lanEnabled,
    configuredLanEnabled: settings.lanEnabled,
  });
  const usage = () => ({ providers: cache.snapshot(), nextRefreshAt: cache.nextRefreshAt, serverTime: new Date(now()).toISOString() });
  const accountResponse = () => ({
    accounts: accounts.map(({ id, name, found, status, plan, email, loginCommand, message }) => ({
      id, name, found, status, plan, email, loginCommand, message, enabled: settings.enabled[id] === true,
    })),
    settings: structuredClone(settings),
    csrfToken,
  });

  function validHost(host) {
    const hosts = ['127.0.0.1', 'localhost'];
    if (boundLan) hosts.push(...addresses);
    return hosts.some(address => host?.toLowerCase() === `${address}:${actualPort}` || (actualPort === 80 && host?.toLowerCase() === address));
  }

  function validMutation(request) {
    if (request.headers['sec-fetch-site'] === 'cross-site') return false;
    const origin = request.headers.origin;
    if (origin && origin !== `http://${request.headers.host}`) return false;
    const token = request.headers['x-usage-token'];
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(csrfToken));
  }

  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      if (!validHost(request.headers.host)) return sendJson(response, 403, { error: 'Unrecognized host.' });
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (!['GET', 'HEAD', 'POST'].includes(request.method)) return sendJson(response, 405, { error: 'Method not allowed.' });
      if (request.method === 'POST' && !validMutation(request)) return sendJson(response, 403, { error: 'Request must come from this dashboard. Reload the page and try again.' });
      if (request.method === 'GET' && url.pathname === '/api/accounts') {
        accounts = await discovery({ homeDir });
        return sendJson(response, 200, accountResponse());
      }
      if (request.method === 'POST' && url.pathname === '/api/accounts') {
        const input = await readJson(request);
        const update = settingsQueue.catch(() => {}).then(async () => {
          let next;
          try { next = validateSettings(input, settings); }
          catch (error) { throw Object.assign(error, { status: 400 }); }
          accounts = await discovery({ homeDir });
          if (input.enableAll) next.enabled = Object.fromEntries(PROVIDER_IDS.map(id => [id, accounts.some(account => account.id === id && account.found)]));
          await store.save(next);
          settings = next;
          cache.setInterval(settings.refreshIntervalMs);
          cache.setEnabled(PROVIDER_IDS.filter(id => settings.enabled[id]));
        });
        settingsQueue = update;
        await update;
        if (autoStart) void cache.refresh().catch(() => {});
        return sendJson(response, 200, { ...accountResponse(), meta: meta() });
      }
      if (request.method === 'GET' && url.pathname === '/api/usage') return sendJson(response, 200, usage());
      if (request.method === 'POST' && url.pathname === '/api/usage/refresh') {
        const input = await readJson(request);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) return sendJson(response, 400, { error: 'Refresh expects an empty JSON object.' });
        const result = await cache.refresh({ force: true });
        return sendJson(response, 200, { ...usage(), ...result });
      }
      if (request.method === 'GET' && url.pathname === '/api/meta') return sendJson(response, 200, meta());
      if (request.method === 'GET' && url.pathname === '/api/qr.svg') {
        const { lanUrl } = meta();
        if (!lanUrl) return sendJson(response, 404, { error: 'Phone access is not active.' });
        const qr = qrcode(0, 'M');
        qr.addData(lanUrl);
        qr.make();
        response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        return response.end(qr.createSvgTag({ cellSize: 5, margin: 20, scalable: true }));
      }
      if (['GET', 'HEAD'].includes(request.method) && STATIC_FILES.has(url.pathname)) {
        const [file, type] = STATIC_FILES.get(url.pathname);
        const content = await readFile(join(ROOT, 'public', file));
        response.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length });
        return response.end(request.method === 'HEAD' ? undefined : content);
      }
      return sendJson(response, 404, { error: 'Not found.' });
    } catch (error) {
      // Provider bodies, filesystem paths, and tokens must never become HTTP errors or logs.
      if (!response.headersSent && !response.destroyed) {
        if (error.status === 413) response.setHeader('Connection', 'close');
        sendJson(response, error.status || 500, { error: error.status ? error.message : 'The local server could not complete this request.' });
      }
      else response.destroy();
    }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;

  return {
    server, cache, meta,
    async listen() {
      await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(port, boundLan ? '0.0.0.0' : '127.0.0.1', () => {
          server.removeListener('error', rejectListen);
          actualPort = server.address().port;
          resolveListen();
        });
      });
      if (autoStart) cache.start();
      return meta();
    },
    async close() {
      if (closed) return;
      closed = true;
      cache.stop();
      if (server.listening) await new Promise(resolveClose => { server.close(resolveClose); server.closeIdleConnections(); });
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let app;
  try {
    const port = process.env.PORT === undefined ? 3140 : Number(process.env.PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
    app = await createApplication({ port });
    const info = await app.listen();
    console.log(`Usage Tracker running at ${info.localUrl}`);
    if (info.lanUrl) console.log(`Phone view: ${info.lanUrl} (available to this network)`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
  } catch (error) {
    if (error.code === 'EADDRINUSE') console.error('Usage Tracker could not start: this port is already in use. Close the other instance or set PORT to another number.');
    else if (/^(PORT |data\/config.json |Could not read data\/config.json)/.test(error.message || '')) console.error(error.message);
    else console.error('Usage Tracker could not start. Check the port and local file permissions.');
    await app?.close();
    process.exitCode = 1;
  }
}
