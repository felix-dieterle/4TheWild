-- 4TheWild – MySQL schema
-- Run once against your MySQL/MariaDB database to set up the tables.
--
-- Usage:
--   mysql -u <user> -p <database> < apps/wild/db/schema.sql

-- ---------------------------------------------------------------------------
-- Road cache
-- Stores Overpass API responses keyed by a tile-quantised bounding box so
-- that repeated map requests for the same area skip the external API call.
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
