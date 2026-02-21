/**
 * 4TheWild – Trip Planning Backend
 *
 * Stores anonymous trip plans so that multiple users planning trips to the
 * same silent area can mutually offset each other's silence score, preventing
 * unintended overcrowding of quiet spots.
 *
 * Also acts as a caching proxy for Overpass road data so that repeated
 * requests for the same area do not hit the external API.
 *
 * Routes
 * ──────
 *   POST /api/trips                              { south, west, north, east }  → 201 { id }
 *   GET  /api/trips?south=&west=&north=&east=                                  → 200 { count, trips[] }
 *   GET  /api/roads?south=&west=&north=&east=   → 200 { ways[], cached: bool }
 *
 * Trips expire automatically after TRIP_TTL_MS (24 h) and are pruned lazily
 * on every request – no scheduler required.
 * Road data is cached in memory for ROAD_CACHE_TTL_MS (24 h) keyed by a
 * tile-quantised bounding box so nearby requests share cached results.
 *
 * Usage:  node server.js          (listens on PORT env-var or 3000)
 */

'use strict';

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');

const PORT             = parseInt(process.env.PORT || '3000', 10);
const TRIP_TTL_MS      = 24 * 60 * 60 * 1000; /* trips expire after 24 hours */
const ROAD_CACHE_TTL_MS = 24 * 60 * 60 * 1000; /* road cache expires after 24 hours */
/** Server-side Overpass query timeout (seconds) – sent inside the OverpassQL query. */
const OVERPASS_QUERY_TIMEOUT_S = 25;
/** Socket-level abort timeout (ms) – includes network latency on top of query processing. */
const OVERPASS_TIMEOUT_MS = (OVERPASS_QUERY_TIMEOUT_S + 5) * 1000;

/**
 * In-memory trip store.
 * Each entry: { id, south, west, north, east, createdAt }
 * Kept sorted by createdAt so pruning is O(k) where k = expired count.
 * @type {{ id: string, south: number, west: number, north: number, east: number, createdAt: number }[]}
 */
const trips = [];

/**
 * In-memory road cache.
 * Keyed by tile-quantised bbox string; value: { ways: Array, cachedAt: number }
 * @type {Map<string, { ways: Array, cachedAt: number }>}
 */
const roadCache = new Map();

/* ── Helpers ─────────────────────────────────────────────────────── */

function pruneExpired() {
  const cutoff = Date.now() - TRIP_TTL_MS;
  let i = 0;
  while (i < trips.length && trips[i].createdAt < cutoff) i++;
  if (i > 0) trips.splice(0, i);
}

function pruneRoadCache() {
  const cutoff = Date.now() - ROAD_CACHE_TTL_MS;
  for (const [key, entry] of roadCache) {
    if (entry.cachedAt < cutoff) roadCache.delete(key);
  }
}

/**
 * Create a stable cache key by rounding bbox coordinates outward to
 * 2 decimal places (~1 km tiles). The expanded tile bounds are also
 * returned so Overpass is queried for the full tile, not just the
 * requested sub-area.
 * @returns {{ key: string, ts: number, tw: number, tn: number, te: number }}
 */
function tileForBbox(s, w, n, e) {
  const floor2 = v => Math.floor(v * 100) / 100;
  const ceil2  = v => Math.ceil(v  * 100) / 100;
  const ts = floor2(s);
  const tw = floor2(w);
  const tn = ceil2(n);
  const te = ceil2(e);
  return { key: `${ts},${tw},${tn},${te}`, ts, tw, tn, te };
}

/**
 * Fetch road ways from the Overpass API for the given bbox.
 * Returns a Promise that resolves with the elements array.
 */
function fetchOverpassRoads(s, w, n, e) {
  return new Promise((resolve, reject) => {
    const bbox  = `${s},${w},${n},${e}`;
    const query = `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT_S}];way["highway"](${bbox});out geom;`;
    const body  = `data=${encodeURIComponent(query)}`;

    const options = {
      hostname: 'overpass-api.de',
      path:     '/api/interpreter',
      method:   'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (incoming) => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('end', () => {
        if (incoming.statusCode !== 200) {
          return reject(new Error(`Overpass returned HTTP ${incoming.statusCode}`));
        }
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(data.elements || []);
        } catch (err) {
          reject(err);
        }
      });
    });

    req.setTimeout(OVERPASS_TIMEOUT_MS, () => {
      req.destroy(new Error('Overpass request timed out'));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
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

  /* GET /api/roads?south=&west=&north=&east= */
  if (req.method === 'GET' && url.pathname === '/api/roads') {
    pruneRoadCache();

    const s = parseFloat(url.searchParams.get('south'));
    const w = parseFloat(url.searchParams.get('west'));
    const n = parseFloat(url.searchParams.get('north'));
    const e = parseFloat(url.searchParams.get('east'));

    if ([s, w, n, e].some(v => isNaN(v))) {
      return jsonResponse(res, 400, { error: 'Invalid bbox parameters' });
    }

    const { key, ts, tw, tn, te } = tileForBbox(s, w, n, e);
    const cached = roadCache.get(key);

    if (cached && Date.now() - cached.cachedAt < ROAD_CACHE_TTL_MS) {
      res.setHeader('X-Cache', 'HIT');
      return jsonResponse(res, 200, { ways: cached.ways, cached: true });
    }

    try {
      /* Fetch the full tile from Overpass so the cache covers nearby requests */
      const ways = await fetchOverpassRoads(ts, tw, tn, te);
      roadCache.set(key, { ways, cachedAt: Date.now() });
      res.setHeader('X-Cache', 'MISS');
      return jsonResponse(res, 200, { ways, cached: false });
    } catch (err) {
      console.error('Overpass fetch failed:', err.message);
      return jsonResponse(res, 502, { error: 'Failed to fetch road data from Overpass' });
    }
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
