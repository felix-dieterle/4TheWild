-- 4TheWild – MySQL schema
-- Run once against your MySQL/MariaDB database to set up the tables.
--
-- Usage:
--   mysql -u <user> -p <database> < apps/wild/db/schema.sql

-- ---------------------------------------------------------------------------
-- OSM roads import
-- Stores pre-imported OpenStreetMap road and railway geometries from a
-- filtered OSM dump (e.g. germany-latest.osm.pbf from Geofabrik).
-- Enables fast spatial bbox queries without hitting the Overpass API.
--
-- Data licence: OpenStreetMap contributors, ODbL 1.0
--   https://www.openstreetmap.org/copyright
-- Attribution must be displayed in the application UI.
--
-- See apps/wild/db/import_osm.php for the import procedure.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roads (
    osm_id    BIGINT           NOT NULL COMMENT 'OSM way ID',
    highway   VARCHAR(32)      NULL     COMMENT 'OSM highway tag value',
    railway   VARCHAR(32)      NULL     COMMENT 'OSM railway tag value',
    maxspeed  VARCHAR(32)      NULL     COMMENT 'Raw OSM maxspeed tag (e.g. "50", "DE:rural")',
    lanes     TINYINT UNSIGNED NULL     COMMENT 'Number of lanes',
    name      VARCHAR(255)     NULL     COMMENT 'OSM name tag',
    geometry  LINESTRING       NOT NULL COMMENT 'Way geometry, WGS-84 (SRID 0, X=lon Y=lat)',
    PRIMARY KEY (osm_id),
    SPATIAL INDEX idx_roads_geom (geometry)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Road cache
-- Stores Overpass API responses keyed by a tile-quantised bounding box so
-- that repeated map requests for the same area skip the external API call.
-- Used as a fallback when the `roads` table contains no data for an area.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS road_cache (
    cache_key  VARCHAR(64)  NOT NULL,
    ways_json  LONGTEXT     NOT NULL,
    cached_at  BIGINT       NOT NULL COMMENT 'Unix timestamp in milliseconds',
    PRIMARY KEY (cache_key),
    INDEX idx_cached_at (cached_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Trip plans
-- Anonymous bounding-box plans submitted by users so that multiple visitors
-- heading to the same quiet spot can mutually offset each other's silence
-- score, preventing unintended overcrowding.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trips (
    id         CHAR(36)     NOT NULL,
    south      DOUBLE       NOT NULL,
    west       DOUBLE       NOT NULL,
    north      DOUBLE       NOT NULL,
    east       DOUBLE       NOT NULL,
    created_at BIGINT       NOT NULL COMMENT 'Unix timestamp in milliseconds',
    PRIMARY KEY (id),
    INDEX idx_created_at (created_at),
    INDEX idx_bbox (south, north, west, east)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
