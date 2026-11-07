#!/usr/bin/env node
/**
 * Aura Gesture Hub: Node.js server
 *
 * - Serves the dashboard from ./public
 * - Talks to the ESP8266 (relay commands + sensor polling) so the browser
 *   never has to deal with CORS or mixed-content rules
 * - Streams live state to the dashboard over Server-Sent Events
 *
 * Hand tracking runs in the browser (MediaPipe), which is where the webcam is.
 *
 * Usage:
 *   node server.js
 *   node server.js --url http://192.168.1.50 --port 3000
 *   ESP_URL=http://server.local PORT=3000 node server.js
 *
 * Requires Node 18 or newer. No npm packages needed.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));

const PORT = Number(args.port || process.env.PORT || 3000);
const HOST = String(args.host || process.env.HOST || '0.0.0.0');
const HTTP_TIMEOUT_MS = 1800; // per request to the ESP8266
const POLL_INTERVAL_MS = 1500; // sensor polling
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Shared state (what the dashboard sees)
// ---------------------------------------------------------------------------
const state = {
  baseUrl: normalizeUrl(args.url || process.env.ESP_URL || 'http://server.local'),
  online: false,
  relay1: null, // true / false / null (unknown)
  relay2: null,
  temp: null,
  hum: null,
  motion: null,
  lastPoll: 0,
};

const clients = new Set(); // open SSE responses

function publicState() {
  return { ...state };
}

function broadcast() {
  const payload = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const res of clients) res.write(payload);
}

// ---------------------------------------------------------------------------
// ESP8266 communication
// ---------------------------------------------------------------------------
async function espGet(route) {
  const res = await fetch(state.baseUrl + route, {
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.text()).trim();
}

const toNumber = (v) => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const toMotion = (v) =>
  ['1', 'true', 'high', 'detected', 'active', 'yes', 'motion'].includes(String(v).toLowerCase());

let activePoll = null;

/** Read everything from the controller. Safe to call often: calls are shared. */
function poll() {
  if (activePoll) return activePoll;

  activePoll = (async () => {
    try {
      // Preferred: one request that also reports real relay state.
      const status = JSON.parse(await espGet('/status'));
      state.relay1 = Boolean(status.relay1);
      state.relay2 = Boolean(status.relay2);
      state.temp = toNumber(status.temp);
      state.hum = toNumber(status.hum);
      state.motion = Boolean(status.motion);
      state.online = true;
    } catch {
      // Fallback for firmware without /status: the three raw endpoints.
      const [temp, hum, motion] = await Promise.allSettled([
        espGet('/temp'),
        espGet('/hum'),
        espGet('/motion'),
      ]);

      if (temp.status === 'fulfilled') state.temp = toNumber(temp.value);
      if (hum.status === 'fulfilled') state.hum = toNumber(hum.value);
      if (motion.status === 'fulfilled') state.motion = toMotion(motion.value);

      state.online = [temp, hum, motion].some((r) => r.status === 'fulfilled');
      if (!state.online) {
        state.relay1 = null;
        state.relay2 = null;
        state.motion = null;
      }
    }

    state.lastPoll = Date.now();
    broadcast();
  })().finally(() => {
    activePoll = null;
  });

  return activePoll;
}

async function setRelay(relay, on) {
  const targets = relay === 'both' ? [1, 2] : [Number(relay)];
  if (!targets.every((n) => n === 1 || n === 2)) {
    throw httpError(400, 'Relay must be 1, 2 or "both".');
  }

  const suffix = on ? 'on' : 'off';
  try {
    await Promise.all(targets.map((n) => espGet(`/relay${n}${suffix}`)));
  } catch {
    throw httpError(
      502,
      `Couldn't reach the controller at ${state.baseUrl}. Check that it's powered on and on the same network.`
    );
  }

  for (const n of targets) state[`relay${n}`] = on;
  state.online = true;
  broadcast();
  setTimeout(poll, 300); // confirm what the controller actually did
  console.log(`[${clock()}] relay ${targets.join('+')} -> ${suffix}`);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(res, url.pathname);
    }
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    sendJson(res, status, { error: err.status ? err.message : 'Something went wrong on the server.' });
  }
});

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const route = `${req.method} ${url.pathname}`;

  switch (route) {
    case 'GET /api/events': {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('retry: 2000\n\n');
      res.write(`data: ${JSON.stringify(publicState())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    case 'GET /api/state':
      return sendJson(res, 200, publicState());

    case 'POST /api/refresh':
      await poll();
      return sendJson(res, 200, publicState());

    case 'POST /api/relay': {
      const body = await readJson(req);
      if (body.state !== 'on' && body.state !== 'off') {
        throw httpError(400, 'State must be "on" or "off".');
      }
      await setRelay(body.relay, body.state === 'on');
      return sendJson(res, 200, publicState());
    }

    case 'POST /api/config': {
      const body = await readJson(req);
      const next = normalizeUrl(body.url);
      try {
        const parsed = new URL(next);
        if (!/^https?:$/.test(parsed.protocol)) throw new Error('protocol');
      } catch {
        throw httpError(400, 'Enter a valid address, like http://server.local or http://192.168.1.50.');
      }
      state.baseUrl = next;
      Object.assign(state, { online: false, relay1: null, relay2: null, temp: null, hum: null, motion: null });
      broadcast();
      console.log(`[${clock()}] controller address -> ${next}`);
      await poll();
      return sendJson(res, 200, publicState());
    }

    default:
      throw httpError(404, 'Not found.');
  }
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));

  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw httpError(403, 'Forbidden.');

  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    throw httpError(404, 'Not found.');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(data);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function readJson(req) {
  // Requiring JSON blocks cross-site form posts from other web pages.
  if (!String(req.headers['content-type'] || '').includes('application/json')) {
    return Promise.reject(httpError(415, 'Send JSON.'));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4096) {
        reject(httpError(413, 'Request too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch {
        reject(httpError(400, 'Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function normalizeUrl(value) {
  let v = String(value || '').trim();
  if (!v) return '';
  if (!/^[a-z]+:\/\//i.test(v)) v = `http://${v}`;
  return v.replace(/\/+$/, '');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const [key, inline] = argv[i].slice(2).split('=');
    const next = argv[i + 1];
    out[key] = inline !== undefined ? inline : next && !next.startsWith('--') ? argv[++i] : true;
  }
  return out;
}

const clock = () => new Date().toLocaleTimeString('en-GB');

function getLocalIps() {
  const nets = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        results.push(net.address);
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(PORT, HOST, () => {
  console.log(`\n  Aura Gesture Hub`);
  console.log(`  Local:        http://localhost:${PORT}`);
  const ips = getLocalIps();
  if (ips.length) {
    for (const ip of ips) {
      console.log(`  Phone URL:    http://${ip}:${PORT}`);
    }
  } else {
    console.log(`  Phone URL:    http://<YOUR-PC-IP>:${PORT}`);
  }
  console.log(`  Controller:   ${state.baseUrl}\n`);
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Try --port 3001.` : err);
  process.exit(1);
});

(function loop() {
  poll().finally(() => setTimeout(loop, POLL_INTERVAL_MS));
})();

// Keep SSE connections alive through proxies and idle timeouts.
setInterval(() => {
  for (const res of clients) res.write(': keep-alive\n\n');
}, 15000).unref();

process.on('SIGINT', () => process.exit(0));
