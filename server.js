/**
 * 4TheWild – Trip Planning Backend
 *
 * Stores anonymous trip plans so that multiple users planning trips to the
 * same silent area can mutually offset each other's silence score, preventing
 * unintended overcrowding of quiet spots.
 *
 * Routes
 * ──────
 *   POST /api/trips   { south, west, north, east }  → 201 { id }
 *   GET  /api/trips?south=&west=&north=&east=        → 200 { count, trips[] }
 *
 * Trips expire automatically after TRIP_TTL_MS (24 h) and are pruned lazily
 * on every request – no scheduler required.
 *
 * Usage:  node server.js          (listens on PORT env-var or 3000)
 */

'use strict';

const http   = require('http');
const crypto = require('crypto');

const PORT        = parseInt(process.env.PORT || '3000', 10);
const TRIP_TTL_MS = 24 * 60 * 60 * 1000; /* trips expire after 24 hours */

/**
 * In-memory trip store.
 * Each entry: { id, south, west, north, east, createdAt }
 * Kept sorted by createdAt so pruning is O(k) where k = expired count.
 * @type {{ id: string, south: number, west: number, north: number, east: number, createdAt: number }[]}
 */
const trips = [];

/* ── Helpers ─────────────────────────────────────────────────────── */

function pruneExpired() {
  const cutoff = Date.now() - TRIP_TTL_MS;
  let i = 0;
  while (i < trips.length && trips[i].createdAt < cutoff) i++;
  if (i > 0) trips.splice(0, i);
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function jsonResponse(res, status, data) {
  setCorsHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ── Request handler ─────────────────────────────────────────────── */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  /* Pre-flight */
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  /* GET /api/trips?south=&west=&north=&east= */
  if (req.method === 'GET' && url.pathname === '/api/trips') {
    pruneExpired();

    const s = parseFloat(url.searchParams.get('south'));
    const w = parseFloat(url.searchParams.get('west'));
    const n = parseFloat(url.searchParams.get('north'));
    const e = parseFloat(url.searchParams.get('east'));

    if ([s, w, n, e].some(v => isNaN(v))) {
      return jsonResponse(res, 400, { error: 'Invalid bbox parameters' });
    }

    /* Return trips whose bbox overlaps the requested bbox */
    const overlapping = trips.filter(t =>
      t.south < n && t.north > s && t.west < e && t.east > w
    );

    return jsonResponse(res, 200, { count: overlapping.length, trips: overlapping });
  }

  /* POST /api/trips  { south, west, north, east } */
  if (req.method === 'POST' && url.pathname === '/api/trips') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return jsonResponse(res, 400, { error: 'Invalid JSON body' });
    }

    const { south, west, north, east } = payload;
    if ([south, west, north, east].some(v => typeof v !== 'number' || isNaN(v))) {
      return jsonResponse(res, 400, {
        error: 'Body must include numeric fields: south, west, north, east',
      });
    }

    pruneExpired();

    const trip = {
      id:        crypto.randomUUID(),
      south, west, north, east,
      createdAt: Date.now(),
    };
    trips.push(trip);

    return jsonResponse(res, 201, { id: trip.id });
  }

  jsonResponse(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`4TheWild trip-planning server running on http://localhost:${PORT}`);
});
