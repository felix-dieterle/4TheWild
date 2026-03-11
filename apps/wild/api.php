<?php
/**
 * 4TheWild – PHP/MySQL Backend
 *
 * Provides the same API surface as the Node.js server.js, but persists data
 * in MySQL so that cached road tiles and trip plans survive server restarts.
 *
 * Routes
 * ──────
 *   GET  /api/roads?south=&west=&north=&east=   → 200 { ways[], cached: bool }
 *   GET  /api/trips?south=&west=&north=&east=   → 200 { count, trips[] }
 *   POST /api/trips                             { south, west, north, east } → 201 { id }
 *
 * Road data is cached in the `road_cache` table for ROAD_CACHE_TTL_MS (24 h),
 * keyed by a tile-quantised bounding box so nearby requests share the same row.
 *
 * Trip plans expire after TRIP_TTL_MS (24 h) and are pruned lazily on every
 * request – no scheduler or cron job is required.
 *
 * Deployment
 * ──────────
 * Place this file (and config.php / db/schema.sql) under a web root served by
 * Apache or Nginx.  When using Apache the included .htaccess rewrites all
 * /api/* requests to this file.  For Nginx add an equivalent try_files rule
 * in your server block.
 *
 * Set DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS as environment variables
 * (never hard-code credentials – see config.php for details).
 *
 * Run apps/wild/db/schema.sql once against your database before first use.
 */

declare(strict_types=1);

require_once __DIR__ . '/config.php';

/* ── Constants ───────────────────────────────────────────────────── */

/** Trips expire after 24 hours (milliseconds). */
const TRIP_TTL_MS = 24 * 60 * 60 * 1000;

/** Road cache expires after 24 hours (milliseconds). */
const ROAD_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Overpass query timeout sent inside the OverpassQL query (seconds). */
const OVERPASS_QUERY_TIMEOUT_S = 25;

/** Socket-level timeout (seconds) – network latency on top of query processing. */
const OVERPASS_TIMEOUT_S = 30;

/** Number of full passes through all mirrors before giving up. */
const OVERPASS_MAX_PASSES = 2;

/** Delay (seconds) before the second pass – lets overloaded mirrors recover. */
const OVERPASS_RETRY_DELAY_S = 3;

/**
 * Public Overpass API mirrors tried in order.
 * On 504 / timeout the next mirror is tried automatically.
 */
const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter',
    'https://overpass.openstreetmap.fr/api/interpreter',
];

/* ── CORS ────────────────────────────────────────────────────────── */

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

/* ── Helpers ─────────────────────────────────────────────────────── */

/**
 * Send a JSON response and exit.
 */
function json_response(int $status, mixed $data, array $extra_headers = []): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    foreach ($extra_headers as $name => $value) {
        header("{$name}: {$value}");
    }
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/**
 * Round bbox coordinates outward to 2 decimal places (~1 km tiles) and
 * return both the stable cache key and the expanded tile bounds.
 *
 * @return array{ key: string, ts: float, tw: float, tn: float, te: float }
 */
function tile_for_bbox(float $s, float $w, float $n, float $e): array
{
    $floor2 = fn(float $v): float => floor($v * 100) / 100;
    $ceil2  = fn(float $v): float => ceil($v  * 100) / 100;

    $ts = $floor2($s);
    $tw = $floor2($w);
    $tn = $ceil2($n);
    $te = $ceil2($e);

    return [
        'key' => "{$ts},{$tw},{$tn},{$te}",
        'ts'  => $ts,
        'tw'  => $tw,
        'tn'  => $tn,
        'te'  => $te,
    ];
}

/**
 * Prune trip records older than TRIP_TTL_MS from the database.
 */
function prune_expired_trips(PDO $pdo): void
{
    $cutoff = (int) (microtime(true) * 1000) - TRIP_TTL_MS;
    $stmt = $pdo->prepare('DELETE FROM trips WHERE created_at < :cutoff');
    $stmt->execute([':cutoff' => $cutoff]);
}

/**
 * Prune road cache rows older than ROAD_CACHE_TTL_MS from the database.
 */
function prune_expired_road_cache(PDO $pdo): void
{
    $cutoff = (int) (microtime(true) * 1000) - ROAD_CACHE_TTL_MS;
    $stmt = $pdo->prepare('DELETE FROM road_cache WHERE cached_at < :cutoff');
    $stmt->execute([':cutoff' => $cutoff]);
}

/**
 * Try to fetch road ways from a single Overpass endpoint.
 * Returns the decoded elements array on success, or throws on failure.
 *
 * @return array<int, mixed>
 * @throws RuntimeException
 */
function fetch_overpass_once(string $url, string $query): array
{
    $context = stream_context_create([
        'http' => [
            'method'        => 'POST',
            'header'        => "Content-Type: application/x-www-form-urlencoded\r\n",
            'content'       => 'data=' . rawurlencode($query),
            'timeout'       => OVERPASS_TIMEOUT_S,
            'ignore_errors' => true,
        ],
        'ssl'  => [
            'verify_peer'      => true,
            'verify_peer_name' => true,
        ],
    ]);

    $raw = @file_get_contents($url, false, $context);

    /* Parse HTTP status from response headers */
    $status = 200;
    if (isset($http_response_header) && is_array($http_response_header)) {
        foreach ($http_response_header as $header) {
            if (preg_match('#^HTTP/\S+ (\d+)#', $header, $m)) {
                $status = (int) $m[1];
            }
        }
    }

    if ($raw === false || $status !== 200) {
        throw new RuntimeException("Overpass returned HTTP {$status}", $status);
    }

    $data = json_decode($raw, true);
    if (!is_array($data)) {
        throw new RuntimeException('Overpass returned invalid JSON');
    }

    return $data['elements'] ?? [];
}

/**
 * Fetch road ways from the Overpass API for the given bbox.
 * Tries each mirror in OVERPASS_ENDPOINTS in order, with OVERPASS_MAX_PASSES
 * passes total so transient failures on one mirror are automatically retried.
 *
 * @return array<int, mixed>
 * @throws RuntimeException when all mirrors fail on all passes
 */
function fetch_overpass_roads(float $s, float $w, float $n, float $e): array
{
    $bbox  = "{$s},{$w},{$n},{$e}";
    $query = '[out:json][timeout:' . OVERPASS_QUERY_TIMEOUT_S . '];'
           . "way[\"highway\"]({$bbox});out geom;";

    $lastError = null;
    for ($pass = 0; $pass < OVERPASS_MAX_PASSES; $pass++) {
        foreach (OVERPASS_ENDPOINTS as $url) {
            try {
                return fetch_overpass_once($url, $query);
            } catch (RuntimeException $e) {
                $lastError = $e;
                $retryable = in_array($e->getCode(), [502, 504, 429, 0], true)
                          || str_contains($e->getMessage(), 'timed out');
                if (!$retryable) {
                    throw $e;
                }
                error_log("4TheWild: Overpass mirror {$url} failed ({$e->getMessage()}), trying next…");
            }
        }
        /* Pause between passes to give overloaded mirrors time to recover */
        if ($pass + 1 < OVERPASS_MAX_PASSES) {
            sleep(OVERPASS_RETRY_DELAY_S * ($pass + 1));
        }
    }

    throw $lastError ?? new RuntimeException('All Overpass mirrors failed');
}

/* ── Routing ─────────────────────────────────────────────────────── */

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

/* Derive the request path, stripping any /api prefix that may or may not
 * be present depending on how the web server forwards the request. */
$uri  = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';

/* Normalise: allow the file to be reached as both
 *   http://example.com/api/roads   (via .htaccess rewrite)
 *   http://example.com/apps/wild/api/roads
 * by stripping everything up to and including the last recognised segment. */
if (preg_match('#(/api/roads|/api/trips)$#', $uri, $m)) {
    $path = $m[1];
} else {
    $path = $uri;
}

/* ── GET /api/roads ──────────────────────────────────────────────── */
if ($method === 'GET' && $path === '/api/roads') {

    $s = filter_input(INPUT_GET, 'south', FILTER_VALIDATE_FLOAT);
    $w = filter_input(INPUT_GET, 'west',  FILTER_VALIDATE_FLOAT);
    $n = filter_input(INPUT_GET, 'north', FILTER_VALIDATE_FLOAT);
    $e = filter_input(INPUT_GET, 'east',  FILTER_VALIDATE_FLOAT);

    if ($s === false || $w === false || $n === false || $e === false ||
        $s === null  || $w === null  || $n === null  || $e === null) {
        json_response(400, ['error' => 'Invalid bbox parameters']);
    }

    $pdo = db_connect();
    prune_expired_road_cache($pdo);

    $tile = tile_for_bbox((float) $s, (float) $w, (float) $n, (float) $e);
    $key  = $tile['key'];
    $now  = (int) (microtime(true) * 1000);

    /* Cache lookup */
    $stmt = $pdo->prepare(
        'SELECT ways_json, cached_at FROM road_cache WHERE cache_key = :key LIMIT 1'
    );
    $stmt->execute([':key' => $key]);
    $row = $stmt->fetch();

    if ($row !== false && ($now - (int) $row['cached_at']) < ROAD_CACHE_TTL_MS) {
        $ways = json_decode($row['ways_json'], true) ?? [];
        json_response(200, ['ways' => $ways, 'cached' => true], ['X-Cache' => 'HIT']);
    }

    /* Cache miss – fetch from Overpass */
    try {
        $ways = fetch_overpass_roads(
            $tile['ts'], $tile['tw'], $tile['tn'], $tile['te']
        );
    } catch (RuntimeException $ex) {
        error_log('4TheWild: Overpass fetch failed: ' . $ex->getMessage());
        json_response(502, ['error' => 'Failed to fetch road data from Overpass']);
    }

    /* Persist to cache */
    $waysJson = json_encode($ways, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    $upsert   = $pdo->prepare(
        'INSERT INTO road_cache (cache_key, ways_json, cached_at)
         VALUES (:key, :ways, :ts)
         ON DUPLICATE KEY UPDATE ways_json = VALUES(ways_json), cached_at = VALUES(cached_at)'
    );
    $upsert->execute([':key' => $key, ':ways' => $waysJson, ':ts' => $now]);

    json_response(200, ['ways' => $ways, 'cached' => false], ['X-Cache' => 'MISS']);
}

/* ── GET /api/trips ──────────────────────────────────────────────── */
if ($method === 'GET' && $path === '/api/trips') {

    $s = filter_input(INPUT_GET, 'south', FILTER_VALIDATE_FLOAT);
    $w = filter_input(INPUT_GET, 'west',  FILTER_VALIDATE_FLOAT);
    $n = filter_input(INPUT_GET, 'north', FILTER_VALIDATE_FLOAT);
    $e = filter_input(INPUT_GET, 'east',  FILTER_VALIDATE_FLOAT);

    if ($s === false || $w === false || $n === false || $e === false ||
        $s === null  || $w === null  || $n === null  || $e === null) {
        json_response(400, ['error' => 'Invalid bbox parameters']);
    }

    $pdo = db_connect();
    prune_expired_trips($pdo);

    /* Return trips whose bbox overlaps the requested bbox */
    $stmt = $pdo->prepare(
        'SELECT id, south, west, north, east, created_at
         FROM trips
         WHERE south < :n AND north > :s AND west < :e AND east > :w'
    );
    $stmt->execute([':s' => $s, ':w' => $w, ':n' => $n, ':e' => $e]);
    $rows = $stmt->fetchAll();

    /* Cast numeric strings to floats/ints for correct JSON output */
    $trips = array_map(static function (array $row): array {
        return [
            'id'        => $row['id'],
            'south'     => (float) $row['south'],
            'west'      => (float) $row['west'],
            'north'     => (float) $row['north'],
            'east'      => (float) $row['east'],
            'createdAt' => (int)   $row['created_at'],
        ];
    }, $rows);

    json_response(200, ['count' => count($trips), 'trips' => $trips]);
}

/* ── POST /api/trips ─────────────────────────────────────────────── */
if ($method === 'POST' && $path === '/api/trips') {

    $raw = file_get_contents('php://input');
    $payload = json_decode((string) $raw, true);

    if (!is_array($payload)) {
        json_response(400, ['error' => 'Invalid JSON body']);
    }

    $south = $payload['south'] ?? null;
    $west  = $payload['west']  ?? null;
    $north = $payload['north'] ?? null;
    $east  = $payload['east']  ?? null;

    foreach ([$south, $west, $north, $east] as $v) {
        if (!is_numeric($v)) {
            json_response(400, [
                'error' => 'Body must include numeric fields: south, west, north, east',
            ]);
        }
    }

    $pdo  = db_connect();
    prune_expired_trips($pdo);

    /* Generate a cryptographically secure UUID v4 */
    $bytes    = random_bytes(16);
    $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40); /* version 4 */
    $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80); /* variant 10xx */
    $hex      = bin2hex($bytes);
    $id       = substr($hex, 0, 8) . '-'
              . substr($hex, 8, 4) . '-'
              . substr($hex, 12, 4) . '-'
              . substr($hex, 16, 4) . '-'
              . substr($hex, 20, 12);
    $now  = (int) (microtime(true) * 1000);

    $stmt = $pdo->prepare(
        'INSERT INTO trips (id, south, west, north, east, created_at)
         VALUES (:id, :south, :west, :north, :east, :created_at)'
    );
    $stmt->execute([
        ':id'         => $id,
        ':south'      => (float) $south,
        ':west'       => (float) $west,
        ':north'      => (float) $north,
        ':east'       => (float) $east,
        ':created_at' => $now,
    ]);

    json_response(201, ['id' => $id]);
}

/* ── 404 ─────────────────────────────────────────────────────────── */
json_response(404, ['error' => 'Not found']);
