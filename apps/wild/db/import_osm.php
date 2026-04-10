#!/usr/bin/env php
<?php
/**
 * 4TheWild – OSM Roads Import Script
 *
 * Reads a GeoJSON Sequence (.geojsonseq) file produced by `osmium export` and
 * bulk-inserts road and railway features into the `roads` table.
 *
 * Data licence
 * ────────────
 * OpenStreetMap data is © OpenStreetMap contributors, licensed under the
 * Open Database Licence (ODbL) 1.0.
 * You must display "© OpenStreetMap contributors" in the application UI.
 * Full licence: https://www.openstreetmap.org/copyright
 *
 * Preparation
 * ───────────
 * Install osmium-tool (https://osmcode.org/osmium-tool/):
 *   apt install osmium-tool          # Debian/Ubuntu
 *   brew install osmium-tool         # macOS
 *
 * Step 1 – Download a regional extract (Germany ~4 GB):
 *   wget https://download.geofabrik.de/europe/germany-latest.osm.pbf
 *
 * Step 2 – Filter to highway/railway ways only (~200–400 MB):
 *   osmium tags-filter germany-latest.osm.pbf w/highway w/railway \
 *     --add-referenced-nodes -o germany-roads.osm.pbf
 *
 * Step 3 – Export as line-delimited GeoJSON with resolved geometry:
 *   osmium export germany-roads.osm.pbf \
 *     --geometry-types=linestring \
 *     -f geojsonseq -o germany-roads.geojsonseq
 *
 * Step 4 – Run this script (set DB credentials via environment variables):
 *   export DB_HOST=localhost DB_PORT=3306 DB_NAME=4thewild \
 *          DB_USER=your_user DB_PASS=your_pass
 *   php apps/wild/db/import_osm.php germany-roads.geojsonseq
 *
 * Options
 * ───────
 *   --truncate   Empty the `roads` table before importing (default: skip
 *                rows whose osm_id already exists)
 *   --batch=N    Insert N rows per transaction (default: 500)
 *
 * The script uses REPLACE INTO so re-running it with the same file is safe
 * and will update changed geometries/tags.  Use --truncate for a clean
 * full re-import that also removes ways deleted from the OSM dump.
 *
 * Usage:
 *   php import_osm.php [--truncate] [--batch=500] <file.geojsonseq>
 */

declare(strict_types=1);

/* ── CLI argument parsing ────────────────────────────────────────── */

$opts     = getopt('', ['truncate', 'batch:']);
$truncate = isset($opts['truncate']);
$batch    = max(1, (int) ($opts['batch'] ?? 500));

/* Find the positional file argument (the one not starting with --) */
$inputFile = null;
foreach (array_slice($argv, 1) as $arg) {
    if (!str_starts_with($arg, '--')) {
        $inputFile = $arg;
        break;
    }
}

if ($inputFile === null) {
    fwrite(STDERR, "Usage: php import_osm.php [--truncate] [--batch=500] <file.geojsonseq>\n");
    exit(1);
}

if (!is_file($inputFile) || !is_readable($inputFile)) {
    fwrite(STDERR, "Error: cannot read file: {$inputFile}\n");
    exit(1);
}

/* ── Database connection ─────────────────────────────────────────── */

require_once __DIR__ . '/../config.php';

$pdo = db_connect();

/* Verify that the `roads` table exists */
try {
    $pdo->query('SELECT 1 FROM roads LIMIT 0');
} catch (PDOException $e) {
    fwrite(STDERR,
        "Error: `roads` table not found. Run apps/wild/db/schema.sql first.\n"
    );
    exit(1);
}

if ($truncate) {
    echo "Truncating `roads` table…\n";
    $pdo->exec('TRUNCATE TABLE roads');
}

/* ── Import loop ─────────────────────────────────────────────────── */

$fh = fopen($inputFile, 'r');
if ($fh === false) {
    fwrite(STDERR, "Error: failed to open {$inputFile}\n");
    exit(1);
}

echo "Importing from {$inputFile} (batch size: {$batch})\n";

$inserted  = 0;
$skipped   = 0;
$lineNo    = 0;
$batchRows = [];

/** Flush $batchRows into the DB and reset the buffer. */
$flush = static function () use ($pdo, &$batchRows, &$inserted): void {
    if (!$batchRows) {
        return;
    }

    /* Build a multi-row REPLACE INTO statement */
    $sql    = 'REPLACE INTO roads (osm_id, highway, railway, maxspeed, lanes, name, geometry) VALUES ';
    $params = [];
    $parts  = [];

    foreach ($batchRows as $i => $row) {
        $parts[] = "(:osm_id_{$i}, :highway_{$i}, :railway_{$i}, :maxspeed_{$i}, :lanes_{$i}, :name_{$i}, ST_GeomFromText(:geom_{$i}))";
        $params[":osm_id_{$i}"]   = $row['osm_id'];
        $params[":highway_{$i}"]  = $row['highway'];
        $params[":railway_{$i}"]  = $row['railway'];
        $params[":maxspeed_{$i}"] = $row['maxspeed'];
        $params[":lanes_{$i}"]    = $row['lanes'];
        $params[":name_{$i}"]     = $row['name'];
        $params[":geom_{$i}"]     = $row['geom'];
    }

    $stmt = $pdo->prepare($sql . implode(', ', $parts));
    $stmt->execute($params);
    $inserted += count($batchRows);
    $batchRows = [];
};

$pdo->beginTransaction();

while (($line = fgets($fh)) !== false) {
    $lineNo++;
    $line = trim($line);
    if ($line === '') {
        continue;
    }

    $feature = json_decode($line, true);
    if (!is_array($feature)
        || ($feature['type'] ?? '') !== 'Feature'
        || ($feature['geometry']['type'] ?? '') !== 'LineString'
    ) {
        $skipped++;
        continue;
    }

    $props   = $feature['properties'] ?? [];
    $coords  = $feature['geometry']['coordinates'] ?? [];

    /* Require at least 2 coordinate pairs for a valid LineString */
    if (count($coords) < 2) {
        $skipped++;
        continue;
    }

    /* Extract OSM way ID from the @id property (e.g. "way/12345") */
    $osmIdRaw = $props['@id'] ?? '';
    $osmId    = (int) preg_replace('/^way\//', '', (string) $osmIdRaw);
    if ($osmId <= 0) {
        $skipped++;
        continue;
    }

    /* Only import ways that carry a highway or railway tag */
    $highway = isset($props['highway']) ? substr((string) $props['highway'], 0, 32) : null;
    $railway = isset($props['railway']) ? substr((string) $props['railway'], 0, 32) : null;
    if ($highway === null && $railway === null) {
        $skipped++;
        continue;
    }

    $maxspeed = isset($props['maxspeed']) ? substr((string) $props['maxspeed'], 0, 32) : null;

    /* lanes tag is usually a small integer; discard non-numeric values */
    $lanesRaw = $props['lanes'] ?? null;
    $lanes    = null;
    if ($lanesRaw !== null) {
        $lanesInt = (int) $lanesRaw;
        if ($lanesInt >= 1 && $lanesInt <= 127) {
            $lanes = $lanesInt;
        }
    }

    $name = isset($props['name']) ? mb_substr((string) $props['name'], 0, 255) : null;

    /* Build WKT LINESTRING: X=longitude, Y=latitude */
    $wktParts = [];
    foreach ($coords as $c) {
        $wktParts[] = sprintf('%.7f %.7f', (float) $c[0], (float) $c[1]);
    }
    $geomWkt = 'LINESTRING(' . implode(', ', $wktParts) . ')';

    $batchRows[] = [
        'osm_id'   => $osmId,
        'highway'  => $highway,
        'railway'  => $railway,
        'maxspeed' => $maxspeed,
        'lanes'    => $lanes,
        'name'     => $name,
        'geom'     => $geomWkt,
    ];

    if (count($batchRows) >= $batch) {
        $flush();
        $pdo->commit();
        $pdo->beginTransaction();
        echo "\r  {$inserted} rows inserted, {$skipped} skipped (line {$lineNo})…";
    }
}

/* Flush any remaining rows */
$flush();
$pdo->commit();

fclose($fh);

echo "\r  {$inserted} rows inserted, {$skipped} skipped (total {$lineNo} lines). Done.\n";
