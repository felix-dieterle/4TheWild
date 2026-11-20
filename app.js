/**
 * 4TheWild – Silent Place Finder
 *
 * Reads roads, railways and landcover from the OpenFreeMap vector tiles
 * (OpenStreetMap data, ODbL) and computes a noise-weighted heatmap.
 * Each road/railway type gets a base
 * weight reflecting its typical traffic noise, further refined by a dynamic
 * per-way factor that accounts for the way's tagged speed limit (maxspeed)
 * and, for roads, the lane count.
 * The grid-based score for a point is:
 *
 *   effectiveWeight(s) = baseWeight(highway|railway) × dynamicNoiseFactor(…)
 *   noiseScore(p)      = max over all segments s { effectiveWeight(s) * 1000 / dist(p, s) }
 *                        + tripCount(p) × TRIP_NOISE_PENALTY
 *
 * dynamicNoiseFactor scales noise up when a road has a higher-than-typical
 * speed limit or more lanes than the default for its type, and down when it
 * has a lower speed limit or fewer lanes. Country-coded maxspeed tags such as
 * "DE:motorway" or "GB:rural" are resolved via COUNTRY_MAXSPEEDS, so the
 * algorithm automatically adapts to country-specific speed regulations.
 *
 * tripCount(p) is the number of active anonymous trip plans whose bounding
 * box contains p. Each planned trip reduces the silence score of the area,
 * signalling to other users that it will be less quiet when they arrive.
 *
 * High score → noisy / crowded (avoid).
 * Low score  → quiet / uncrowded (ideal).
 */

/* ── App version & build ─────────────────────────────────────────── */
const APP_VERSION = '1.4.0';
const APP_BUILD   = 3;

/* ── Vegetation noise-dampening factors (0 = no reduction, 1 = full) */
const VEGETATION_DAMPENING = {
  wood:      0.60, /* dense forest  */
  forest:    0.60,
  scrub:     0.35,
  heath:     0.30,
  wetland:   0.40,
  grassland: 0.15,
  meadow:    0.15,
  grass:     0.10,
  orchard:   0.25,
  vineyard:  0.15,
};

/* ── Built-up / shopping density ─────────────────────────────────────
 * Road noise alone misses the crowd factor: a shopping street, a mall or a
 * dense residential quarter is louder than its roads suggest. The vector
 * tiles carry `landuse` polygons (available from zoom 4) and `poi` points
 * (from zoom 11), so these are used as an activity proxy. The `building`
 * layer of the OpenFreeMap planet build is far too sparse for a density
 * estimate (a few hundred polygons for a whole city), so it is not used.
 * Penalties are additive to the noise index, in the same units as
 * TRIP_NOISE_PENALTY (2 ≈ standing 500 m from a small road).            */
const LANDUSE_NOISE_PENALTY = {
  retail:       4.5, /* shopping street, mall area   */
  commercial:   3.0,
  industrial:   1.4,
  railway:      0.6,
  school:       1.2,
  hospital:     1.2,
  kindergarten: 0.9,
  theme_park:   1.5,
  residential:  0.6,
  suburb:       0.25,
};

/** Per-class activity weight of a POI (shops, gastronomy, offices, ...). */
const POI_NOISE_WEIGHTS = {
  supermarket: 1.2, grocery: 1.0, mall: 1.6, department_store: 1.6,
  marketplace: 1.6, convenience: 0.9, shop: 0.9, clothing_store: 0.8,
  bakery: 0.6, butcher: 0.6, alcohol_shop: 0.6, hairdresser: 0.5,
  restaurant: 0.8, fast_food: 0.9, cafe: 0.7, bar: 0.9, pub: 0.9,
  ice_cream: 0.5, beer: 0.6,
  cinema: 1.4, theatre: 1.1, museum: 0.7, attraction: 0.7,
  stadium: 1.5, sports_centre: 0.8, water_park: 1.5, swimming_pool: 0.6,
  office: 0.5, bank: 0.5, post: 0.4, town_hall: 0.5,
  hotel: 0.5, lodging: 0.5, hostel: 0.5, guest_house: 0.5,
  bus: 0.3, railway: 0.4, fuel: 0.8, parking: 0.15,
  place_of_worship: 0.4, library: 0.4, university: 0.9, college: 0.7,
};

/** Radius (m) in which POIs are summed, and the weight of that sum. */
const POI_NOISE_RADIUS_M = 250;
const POI_NOISE_SCALE    = 0.12;
/** Bucket size (deg) of the POI spatial index (~220 m). */
const POI_INDEX_CELL_DEG = 0.002;

/* Colours for the terrain accessibility overlay */
const TERRAIN_COLORS = {
  rough_track:     '#f59e0b', /* grade4/grade5 tracks */
  demanding_trail: '#ef4444', /* mountain/alpine hiking */
};

/* ── Road type noise weights (higher = louder) ──────────────────────
 * These are the BASE weights for each highway type, reflecting typical
 * traffic volume and road importance.  They are multiplied at runtime
 * by dynamicNoiseFactor() which adjusts for the actual tagged speed
 * limit and lane count of each individual way.
 * ──────────────────────────────────────────────────────────────────── */
const DEFAULT_ROAD_WEIGHTS = {
  motorway:         10,
  motorway_link:     7,
  trunk:             8,
  trunk_link:        6,
  primary:           5,
  primary_link:      4,
  secondary:         3,
  secondary_link:    2.5,
  tertiary:          2,
  tertiary_link:     1.5,
  residential:       1.5,
  living_street:     0.5,  /* pedestrian-priority shared space, ≤10 km/h */
  unclassified:      1,
  service:           0.5,  /* low-traffic access/parking roads */
  track:             0.4,
  path:              0.2,
  cycleway:          0.2,
  footway:           0.15,
  pedestrian:        0.25,
  steps:             0.1,
};

/* ── Railway type noise weights (higher = louder) ───────────────────
 * Base weights for each OSM railway type.  Multiplied at runtime by
 * dynamicRailwayNoiseFactor() which adjusts for tagged maxspeed.
 * ──────────────────────────────────────────────────────────────────── */
const DEFAULT_RAILWAY_WEIGHTS = {
  rail:         8,  /* main-line / intercity heavy rail            */
  narrow_gauge: 5,  /* narrow-gauge regional lines                 */
  light_rail:   4,  /* light rail / Stadtbahn                      */
  subway:       4,  /* metro / U-Bahn (surface sections)           */
  tram:         3,  /* tram / Straßenbahn                          */
  monorail:     3,
  preserved:    4,  /* heritage / museum railway                   */
};

/* ── Country-coded maxspeed defaults (km/h) ─────────────────────────
 * OSM ways may carry a maxspeed tag like "DE:rural" or "GB:motorway"
 * instead of a bare numeric value. The table below maps these codes to
 * their legally defined speed limit in km/h.
 * ──────────────────────────────────────────────────────────────────── */
const COUNTRY_MAXSPEEDS = {
  /* Germany */
  'DE:urban':      50,
  'DE:rural':     100,
  'DE:motorway':  130,  /* Richtgeschwindigkeit – advisory, no hard limit */
  /* Austria */
  'AT:urban':      50,
  'AT:rural':     100,
  'AT:motorway':  130,
  /* Switzerland */
  'CH:urban':      50,
  'CH:rural':      80,
  'CH:motorway':  120,
  /* France */
  'FR:urban':      50,
  'FR:rural':      80,
  'FR:motorway':  130,
  /* Italy */
  'IT:urban':      50,
  'IT:rural':      90,
  'IT:motorway':  130,
  /* Netherlands */
  'NL:urban':      50,
  'NL:rural':      80,
  'NL:motorway':  130,
  /* Belgium */
  'BE:urban':      50,
  'BE:rural':      70,
  'BE:motorway':  120,
  /* Luxembourg */
  'LU:urban':      50,
  'LU:rural':      90,
  'LU:motorway':  130,
  /* Spain */
  'ES:urban':      50,
  'ES:rural':      90,
  'ES:motorway':  120,
  /* Portugal */
  'PT:urban':      50,
  'PT:rural':      90,
  'PT:motorway':  120,
  /* Czech Republic */
  'CZ:urban':      50,
  'CZ:rural':      90,
  'CZ:motorway':  130,
  /* Poland */
  'PL:urban':      50,
  'PL:rural':      90,
  'PL:motorway':  140,
  /* United Kingdom (mph converted to km/h) */
  'GB:urban':      48,  /* 30 mph */
  'GB:rural':      96,  /* 60 mph */
  'GB:nsl_dual':  112,  /* 70 mph national speed limit, dual carriageway */
  'GB:motorway':  112,  /* 70 mph */
  /* Russia */
  'RU:urban':      60,
  'RU:rural':      90,
  'RU:motorway':  110,
  /* United States (mph converted to km/h, representative values) */
  'US:urban':      40,
  'US:rural':      88,  /* 55 mph */
  'US:motorway':  105,  /* 65 mph – varies by state */
};

/* ── Default speed limits (km/h) by road type ───────────────────────
 * Used when a way has no maxspeed tag and no applicable country code.
 * Values represent a conservative estimate for a mixed-country context.
 * ──────────────────────────────────────────────────────────────────── */
const DEFAULT_SPEEDS = {
  motorway:       110,  /* conservative: actual range is 80–unlimited */
  motorway_link:   80,
  trunk:           90,
  trunk_link:      70,
  primary:         70,
  primary_link:    50,
  secondary:       60,
  secondary_link:  50,
  tertiary:        50,
  tertiary_link:   40,
  residential:     30,
  living_street:   10,
  unclassified:    50,
  service:         20,
  track:           15,
  path:             8,
  cycleway:        20,
  footway:          5,
  pedestrian:       5,
  steps:            3,
};

/* ── Default speed limits (km/h) by railway type ────────────────────
 * Used by dynamicRailwayNoiseFactor() when a way has no maxspeed tag.
 * ──────────────────────────────────────────────────────────────────── */
const DEFAULT_RAILWAY_SPEEDS = {
  rail:         120,  /* typical intercity / freight train   */
  narrow_gauge:  80,
  light_rail:    70,
  subway:        60,
  tram:          40,
  monorail:      60,
  preserved:     40,
};

/* ── Default lane counts by road type ───────────────────────────────
 * Used when a way has no lanes tag.  Motorways count total lanes
 * (both directions combined) since OSM lanes tag does the same.
 * ──────────────────────────────────────────────────────────────────── */
const DEFAULT_LANES = {
  motorway:       4,    /* 2 × 2 – typical dual carriageway */
  motorway_link:  2,
  trunk:          2,
  trunk_link:     2,
  primary:        2,
  primary_link:   1,
  secondary:      2,
  secondary_link: 1,
  tertiary:       2,
  tertiary_link:  1,
  residential:    2,
  living_street:  1,
  unclassified:   2,
  service:        1,
  track:          1,
  path:           1,
  cycleway:       1,
  footway:        1,
  pedestrian:     1,
  steps:          1,
};

/* Road type groups shown in the sidebar (label → list of highway values) */
const WEIGHT_UI_GROUPS = [
  { label: '🛣 Motorway',    keys: ['motorway', 'motorway_link'],   default: 10,
    info: 'High-speed motorways (Autobahn/highway): multi-lane divided roads with restricted access. Very high traffic volume and noise levels.' },
  { label: '🛤 Trunk',       keys: ['trunk', 'trunk_link'],          default: 8,
    info: 'Trunk roads: important arterial roads, often dual carriageways with fast traffic. Lower tier than motorways but still high noise.' },
  { label: '🚗 Primary',     keys: ['primary', 'primary_link'],      default: 5,
    info: 'Primary roads: major roads linking cities and towns. Moderate to high traffic volume.' },
  { label: '🚙 Secondary',   keys: ['secondary', 'secondary_link'],  default: 3,
    info: 'Secondary roads: regional roads connecting towns and larger villages. Medium traffic.' },
  { label: '🛣 Tertiary',    keys: ['tertiary', 'tertiary_link'],    default: 2,
    info: 'Tertiary roads: local roads connecting smaller settlements and villages. Lower traffic.' },
  { label: '🏘 Residential', keys: ['residential', 'living_street'], default: 1.5,
    info: 'Residential roads & living streets (Spielstraße): roads in built-up areas with low speed limits. Living streets give pedestrians priority.' },
  { label: '🌲 Track/Path',  keys: ['track', 'path', 'footway', 'cycleway', 'pedestrian', 'steps'], default: 0.2,
    info: 'Unpaved tracks, hiking paths, cycleways, footways, pedestrian zones and steps. Mainly used for walking, cycling and outdoor activities. Very low noise.' },
];

/* Railway type groups shown in the sidebar (label → list of railway values) */
const RAILWAY_UI_GROUPS = [
  { label: '🚆 Heavy Rail',  keys: ['rail', 'narrow_gauge'],                  default: 8,
    info: 'Main railway lines (intercity, freight, regional trains). High speed and significant noise. Also includes narrow-gauge regional railways.' },
  { label: '🚊 Light Rail',  keys: ['light_rail', 'subway', 'monorail'],      default: 4,
    info: 'Urban rail: light rail (Stadtbahn), underground/subway (U-Bahn) and elevated monorail lines. Medium speed, lower noise than heavy rail.' },
  { label: '🚋 Tram',        keys: ['tram', 'preserved'],                     default: 3,
    info: 'Street-running trams (Straßenbahn) sharing road space with other traffic. Also includes heritage/museum railway lines.' },
];

/* ── Transportation modes for reachability analysis ─────────────── *
 * Each mode defines which OSM highway values are accessible, whether  *
 * demanding terrain paths (sac_scale) count as reachable, and whether *
 * waterways should be fetched (for kayaking).                          *
 * ──────────────────────────────────────────────────────────────────── */
const REACHABILITY_DISTANCE_M = 200; /* metres from nearest accessible route */

/**
 * Minimum map zoom for the reachability filter. Below this level the
 * OpenFreeMap/OpenMapTiles tiles only carry motorways, trunk and primary
 * roads, so "within 200 m of an accessible route" would grey out nearly the
 * whole viewport and the travel-time radius would look wrong.
 */
const MIN_REACH_ZOOM = 12;

const TRANSPORT_MODES = [
  {
    id: 'car',
    label: '🚗 Auto (Car)',
    icon:  '🚗',
    description: 'Reachable by car: motorways, main roads and service roads only.',
    navProfile: 'driving',
    accessibleHighways: new Set([
      'motorway', 'motorway_link', 'trunk', 'trunk_link',
      'primary', 'primary_link', 'secondary', 'secondary_link',
      'tertiary', 'tertiary_link', 'residential', 'living_street',
      'unclassified', 'service', 'track',
    ]),
    needsWaterways:    false,
    includeTerrainPaths: false,
  },
  {
    id: 'bike',
    label: '🚲 Fahrrad (Bike)',
    icon:  '🚲',
    description: 'Reachable by bicycle: roads, cycleways, tracks and most paths (pushing a bike included).',
    navProfile: 'cycling',
    accessibleHighways: new Set([
      'primary', 'primary_link', 'secondary', 'secondary_link',
      'tertiary', 'tertiary_link', 'residential', 'living_street',
      'unclassified', 'service', 'track', 'path', 'footway',
      'cycleway', 'pedestrian',
    ]),
    needsWaterways:    false,
    includeTerrainPaths: false,
  },
  {
    id: 'foot',
    label: '🚶 Zu Fuß (On foot)',
    icon:  '🚶',
    description: 'Reachable on foot: roads with footways or roadsides, plus walking paths, footways and steps.',
    navProfile: 'foot',
    accessibleHighways: new Set([
      'primary', 'primary_link', 'secondary', 'secondary_link',
      'tertiary', 'tertiary_link', 'residential', 'living_street',
      'unclassified', 'service', 'track', 'path', 'footway',
      'cycleway', 'pedestrian', 'steps',
    ]),
    needsWaterways:    false,
    includeTerrainPaths: false,
  },
  {
    id: 'climbing',
    label: '🧗 Klettern (Climbing)',
    icon:  '🧗',
    description: 'Reachable by climbing: all walking paths plus demanding rock-climbing routes and difficult terrain.',
    accessibleHighways: new Set([
      'primary', 'secondary', 'tertiary', 'residential', 'living_street',
      'unclassified', 'service', 'track', 'path', 'footway',
      'cycleway', 'pedestrian', 'steps',
    ]),
    needsWaterways:    false,
    includeTerrainPaths: true,
  },
  {
    id: 'mountaineering',
    label: '⛰ Bergsteigen (Mountaineering)',
    icon:  '⛰',
    description: 'Reachable by alpine mountaineering: all paths including extreme high-alpine terrain and remote routes.',
    accessibleHighways: new Set([
      'primary', 'secondary', 'tertiary', 'residential', 'living_street',
      'unclassified', 'service', 'track', 'path', 'footway',
      'cycleway', 'pedestrian', 'steps',
    ]),
    needsWaterways:    false,
    includeTerrainPaths: true,
  },
  {
    id: 'kayak',
    label: '🛶 Kanu fahren (Kayaking)',
    icon:  '🛶',
    description: 'Reachable by canoe/kayak: navigable waterways such as rivers, streams and canals.',
    accessibleHighways: new Set(),
    needsWaterways:    true,
    includeTerrainPaths: false,
  },
];

/* ── Built-in noise weight profiles ───────────────────────────────── *
 * roadGroups    – one weight per WEIGHT_UI_GROUPS entry (index-aligned) *
 * railwayGroups – one weight per RAILWAY_UI_GROUPS entry (index-aligned)*
 * useRailways   – initial state of the railway noise toggle             *
 * ──────────────────────────────────────────────────────────────────── */
const NOISE_PROFILES = [
  {
    id: 'default',
    name: '🌿 Default',
    description: 'Balanced weighting across all road types.',
    roadGroups:    [10, 8, 5, 3, 2, 1.5, 0.2],
    railwayGroups: [8, 4, 3],
    useRailways: true,
  },
  {
    id: 'deep_wilderness',
    name: '🏔 Deep Wilderness',
    description: 'Forest tracks and hiking paths also count as noise — find places truly far from all routes.',
    roadGroups:    [10, 8, 5, 3, 2, 1.5, 3.5],
    railwayGroups: [8, 4, 3],
    useRailways: true,
  },
  {
    id: 'cycling',
    name: '🚲 Cycling Trip',
    description: 'Quiet spots reachable by bike. Tracks, paths and cycleways are not penalised as noise sources.',
    roadGroups:    [10, 8, 5, 3, 2, 1, 0],
    railwayGroups: [6, 3, 2],
    useRailways: true,
  },
  {
    id: 'motor_only',
    name: '🚗 Motor Traffic Only',
    description: 'Only motorised roads count as noise. Footpaths, tracks and railways are ignored.',
    roadGroups:    [10, 8, 5, 3, 1.5, 0.5, 0],
    railwayGroups: [8, 4, 3],
    useRailways: false,
  },
  {
    id: 'absolute_silence',
    name: '🧘 Absolute Silence',
    description: 'Maximum weight on every noise source for the deepest possible quiet.',
    roadGroups:    [10, 9, 7, 5, 3.5, 2.5, 1.5],
    railwayGroups: [10, 7, 5],
    useRailways: true,
  },
];

/* ── State ───────────────────────────────────────────────────────── */
let roadWeights     = { ...DEFAULT_ROAD_WEIGHTS };
let railwayWeights  = { ...DEFAULT_RAILWAY_WEIGHTS };
let heatLayer       = null;
let quietMarkers    = [];
/** True while the "Get me out of here" session owns the result layers. */
let outingModeActive = false;
/** Origin frozen at the start of an outing session (keeps repeat runs stable). */
let outingOrigin    = null;
/** Earlier analysis results, newest first: { markers, rect, depth }. */
let quietHistory    = [];
/** How many earlier runs stay visible (faded) on the map. */
const QUIET_HISTORY_MAX = 2;
/** Bounds of the most recent analysis: { south, west, north, east }. */
let lastAnalysisBounds = null;
/** Incremented per completed analysis (used for unique overlay ids). */
let analysisGeneration = 0;
/** Only one popup may be open at a time. */
let activePopup     = null;
let tripRects       = []; /* Leaflet rectangles for planned trip areas */
let analyzing       = false;
/** Set of selected transport mode IDs (empty = no reachability filtering). */
let selectedTransportModes = new Set();
/** Max travel time in minutes for the reachability filter (0 = off). */
let reachTimeBudgetMin = 0;
/** Segment travel times of the last analysis (for click popups). */
let lastReachCtx = null;
/** Filter settings ("what was actually considered") of the last analysis. */
let lastAnalysisInfo = null;
/** Canvas imageOverlay for greying out unreachable grid cells. */
let unreachableOverlay = null;
/** Dashed circles showing the straight-line travel-time radius per mode. */
let reachRadiusOverlay = null;

/**
 * Average speeds (km/h) per mode and OSM way type. Used for the travel-time
 * budget. Values are rough planning speeds, not routing-grade.
 */
const MODE_SPEEDS_KMH = {
  car: {
    default: 45, motorway: 110, motorway_link: 70, trunk: 90, trunk_link: 70,
    primary: 70, primary_link: 55, secondary: 60, secondary_link: 50,
    tertiary: 50, tertiary_link: 45, residential: 30, living_street: 10,
    service: 20, track: 15, unclassified: 40,
  },
  bike: {
    default: 15, cycleway: 18, primary: 16, primary_link: 14, secondary: 17,
    secondary_link: 15, tertiary: 17, tertiary_link: 14, residential: 15,
    living_street: 10, service: 12, track: 11, path: 9, footway: 6,
    pedestrian: 6, steps: 2, unclassified: 13,
  },
  foot: {
    default: 4.5, steps: 1.5, track: 4, path: 4, footway: 4.5, pedestrian: 4.5,
    cycleway: 4.5, primary: 4.8, secondary: 4.8, tertiary: 4.8, residential: 4.6,
  },
  climbing: { default: 3, steps: 1.2 },
  mountaineering: { default: 2.2, steps: 1 },
  kayak: { default: 5, river: 6, stream: 5, canal: 5, drain: 4 },
};

/**
 * Planning speed for one segment of a given transport mode.
 * @param {string} modeId
 * @param {object} tags  OSM tags of the way
 * @returns {number} km/h
 */
function speedKmhFor(modeId, tags) {
  const table = MODE_SPEEDS_KMH[modeId] || {};
  const key = (tags && (tags.highway || tags.waterway)) || 'default';
  let speed = table[key] || table.default || 4.5;
  if (modeId === 'car' && tags && tags.maxspeed) {
    const tagged = parseInt(String(tags.maxspeed), 10);
    if (Number.isFinite(tagged) && tagged > 0) speed = Math.min(130, Math.max(5, tagged));
  }
  return speed;
}

/** Origin for the travel-time budget: current position, else map centre.
 *  During an outing session the origin is frozen, so repeated runs search the
 *  same circle instead of re-centring on wherever the last route left the map. */
function getReachOrigin() {
  if (outingOrigin) return outingOrigin;
  if (locationMarker) {
    const ll = locationMarker.getLatLng();
    return { lat: ll.lat, lng: ll.lng, label: 'from your location' };
  }
  const c = map.getCenter();
  return { lat: c.lat, lng: c.lng, label: 'from the map centre' };
}

/** Tiny binary min-heap for Dijkstra. */
function createMinHeap() {
  const items = [];
  return {
    size: () => items.length,
    push(value, key) {
      items.push({ value, key });
      let i = items.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (items[p].key <= items[i].key) break;
        const tmp = items[p]; items[p] = items[i]; items[i] = tmp;
        i = p;
      }
    },
    pop() {
      const top = items[0];
      const last = items.pop();
      if (items.length) {
        items[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < items.length && items[l].key < items[m].key) m = l;
          if (r < items.length && items[r].key < items[m].key) m = r;
          if (m === i) break;
          const tmp = items[i]; items[i] = items[m]; items[m] = tmp;
          i = m;
        }
      }
      return top;
    },
  };
}

/**
 * Estimate per-segment travel times from the origin for the selected modes
 * (Dijkstra over the OSM ways that are already loaded). Returns the fastest
 * arrival time per segment in seconds; Infinity means not reachable in time.
 *
 * @param {Array} segs       reachability segments (meters + lat/lng + tags)
 * @param {Iterable<string>} modeIds
 * @param {{lat:number,lng:number}} origin
 * @param {number} budgetMin
 * @returns {Float64Array}
 */
/** True when a way may be used by the given transportation mode. */
function modeAllows(mode, tags) {
  if (!tags) return false;
  if (mode.needsWaterways) return !!tags.waterway;
  if (!tags.highway) return false;
  return mode.accessibleHighways.has(tags.highway);
}

/**
 * Travel times (seconds) per segment from the origin, fastest over all
 * selected modes. Infinity = not reachable within the budget.
 *
 * Nodes are keyed by (way, vertex), so vertices of the same way never
 * collapse. Only way *endpoints* may join a vertex of a different way within
 * SNAP_M metres: that connects junctions and tile-clipped ends without
 * merging parallel roads into a single point.
 */
/** Effective planning speed per mode (km/h, includes stops and detours). */
const MODE_EFFECTIVE_KMH = {
  car: 45, bike: 15, foot: 4.5, climbing: 3, mountaineering: 2.2, kayak: 5,
};

/** Extra distance factor for real routes vs. straight lines. */
const REACH_DETOUR_FACTOR = 1.3;

/** Spatial grid index (CELL_M) over a set of segments. */
function buildSegmentIndex(segments, cellM) {
  const index = new Map();
  for (const s of segments) {
    const bx0 = Math.floor(Math.min(s.ax, s.bx) / cellM);
    const bx1 = Math.floor(Math.max(s.ax, s.bx) / cellM);
    const by0 = Math.floor(Math.min(s.ay, s.by) / cellM);
    const by1 = Math.floor(Math.max(s.ay, s.by) / cellM);
    for (let bx = bx0; bx <= bx1; bx++) {
      for (let by = by0; by <= by1; by++) {
        const key = `${bx},${by}`;
        let list = index.get(key);
        if (!list) { list = []; index.set(key, list); }
        list.push(s);
      }
    }
  }
  return index;
}

/**
 * Build the travel-time context for the reachability filter.
 *
 * Two independent parts:
 *  1. Time budget = straight-line radius per mode (effective speed x budget /
 *     detour factor). Pure geometry, so it works at every zoom level.
 *  2. Route rule = point must be within REACHABILITY_DISTANCE_M of a way the
 *     mode can use. Needs detailed tiles, so it only runs when
 *     `routeRuleActive` is true (zoom >= MIN_REACH_ZOOM).
 *
 * The radius is deliberately a circle and not a road graph: tile geometry has
 * no reliable topology, and a coordinate-based graph fragments into hundreds
 * of isolated pieces, which made the radius look wrong.
 *
 * @param {L.LatLngBounds} bounds
 * @param {Array} segs               route segments (only used when routeRuleActive)
 * @param {Iterable<string>} modeIds
 * @param {{lat:number,lng:number,label:string}} origin
 * @param {number} budgetMin         0 = no time limit
 * @param {boolean} routeRuleActive
 */
function buildReachContext(bounds, segs, modeIds, origin, budgetMin, routeRuleActive) {
  const mLat = 111320;
  const mLng = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  const CELL_M = 300;
  const perMode = [];

  for (const id of modeIds) {
    const mode = TRANSPORT_MODES.find((m) => m.id === id);
    if (!mode) continue;

    /* budgetMin = 0 means "no time limit": the radius is unbounded. */
    const speed = MODE_EFFECTIVE_KMH[mode.id] || 4.5;
    const radiusM = budgetMin > 0
      ? (speed * 1000 / 60) * budgetMin / REACH_DETOUR_FACTOR
      : Infinity;

    /* Only build the route index when the route rule is in play. */
    let index = null;
    if (routeRuleActive) {
      const usable = segs.filter((s) => modeAllows(mode, s.tags));
      if (usable.length) index = buildSegmentIndex(usable, CELL_M);
    }

    perMode.push({ mode, index, radiusM });
  }

  return {
    bounds,
    origin,
    mLat,
    mLng,
    cellM: CELL_M,
    minutes: budgetMin,
    routeRuleActive: !!routeRuleActive,
    modesLabel: perMode.length
      ? perMode.map((p) => p.mode.label).join(' / ')
      : [...modeIds].join(', '),
    originLabel: origin.label,
    perMode,
  };
}

/**
 * True when the point is reachable. Modes are OR-combined:
 *  - inside the mode's time radius, AND
 *  - (only when the route rule is active) close to a route that mode may use.
 */
function reachContextAllows(ctx, lat, lng) {
  if (!ctx) return true;
  if (!ctx.perMode.length) return true;
  const px = lng * ctx.mLng;
  const py = lat * ctx.mLat;
  const ox = ctx.origin.lng * ctx.mLng;
  const oy = ctx.origin.lat * ctx.mLat;

  for (const entry of ctx.perMode) {
    const dx = px - ox;
    const dy = py - oy;
    if (dx * dx + dy * dy > entry.radiusM * entry.radiusM) continue;

    /* Radius-only filtering (route rule paused, or no usable route data for
     * this mode): being inside the radius is all we can check. */
    if (!ctx.routeRuleActive || !entry.index) return true;

    const bx = Math.floor(px / ctx.cellM);
    const by = Math.floor(py / ctx.cellM);
    let near = false;
    for (let gx = -1; gx <= 1 && !near; gx++) {
      for (let gy = -1; gy <= 1 && !near; gy++) {
        const list = entry.index.get(`${bx + gx},${by + gy}`);
        if (!list) continue;
        for (const s of list) {
          if (ptSegDist(px, py, s.ax, s.ay, s.bx, s.by) <= REACHABILITY_DISTANCE_M) {
            near = true;
            break;
          }
        }
      }
    }
    if (near) return true;
  }
  return false;
}

/**
 * Reachability verdict for an arbitrary map point after an analysis with a
 * time budget. Empty string when no budget analysis is available.
 */
function describeReachabilityAt(lat, lng) {
  if (!lastReachCtx) return '';
  const ok = reachContextAllows(lastReachCtx, lat, lng);
  const minutes = lastReachCtx.minutes;
  const modesLabel = lastReachCtx.modesLabel;
  const rule = lastReachCtx.routeRuleActive
    ? ` and within ${REACHABILITY_DISTANCE_M} m of an accessible route`
    : '';
  const where = `within a ${minutes} min straight-line radius${rule}`;
  return ok
    ? `⏱️ Reachable ${where} (${modesLabel})`
    : `⛔ Not reachable ${where} (${modesLabel})`;
}
/** Selected transport modes with the speed that drives their time radius. */
function selectedModeSpeeds() {
  return [...selectedTransportModes].map((id) => {
    const mode = TRANSPORT_MODES.find((m) => m.id === id);
    return {
      id,
      label: mode ? mode.label : id,
      speedKmh: MODE_EFFECTIVE_KMH[id] || 4.5,
    };
  });
}

/** Straight-line radius in metres per selected mode for the current budget. */
function reachRadiiM() {
  if (!(reachTimeBudgetMin > 0)) return [];
  return selectedModeSpeeds().map((m) =>
    (m.speedKmh * 1000 / 60) * reachTimeBudgetMin / REACH_DETOUR_FACTOR);
}

/** Hard upper bound (km) for an analysis box expanded beyond the view. */
const MAX_ANALYSIS_SPAN_KM = 60;

/** Bounding box {south, north, west, east} of a circle around `origin`. */
function circleBoundingBox(origin, radiusM) {
  const dLat = radiusM / 111320;
  const cos = Math.cos((origin.lat * Math.PI) / 180) || 1e-6;
  const dLng = radiusM / (111320 * cos);
  return {
    south: origin.lat - dLat,
    north: origin.lat + dLat,
    west:  origin.lng - dLng,
    east:  origin.lng + dLng,
  };
}

/** Convert a plain box into a MapLibre LngLatBounds. */
function boxToBounds(box) {
  return new maplibregl.LngLatBounds([box.west, box.south], [box.east, box.north]);
}

/** Longest side of a box in kilometres. */
function boxSpanKm(box) {
  const midLat = (box.south + box.north) / 2;
  const latKm = (box.north - box.south) * 111.32;
  const lngKm = (box.east - box.west) * 111.32 * Math.cos(midLat * Math.PI / 180);
  return Math.max(latKm, lngKm);
}

/**
 * Zoom at which the vector tiles for `bounds` are read.
 *
 * Independent of the current camera, so the same origin + radius + mode always
 * reads the same tile detail. Capped at the source's maximum zoom (14); larger
 * boxes naturally yield coarser data, which is honest because the tiles really
 * do not contain more.
 *
 * @param {object} bounds  MapLibre LngLatBounds or {south,west,north,east}
 * @returns {number}
 */
function canonicalDataZoom(bounds) {
  let z = map.getZoom();
  try {
    const b = bounds instanceof maplibregl.LngLatBounds
      ? bounds
      : new maplibregl.LngLatBounds(
          [bounds.west, bounds.south], [bounds.east, bounds.north]);
    const cam = map.cameraForBounds(b, { padding: 0 });
    if (cam && Number.isFinite(cam.zoom)) z = cam.zoom;
  } catch { /* keep the current zoom */ }
  return Math.max(0, Math.min(DATA_MAX_ZOOM, z));
}

/**
 * Area that an analysis has to cover.
 *
 * Without a travel-time budget the current view is analysed. With a budget the
 * full travel-time circle around the origin is analysed, so the viewport is no
 * longer the limit (previously a radius larger than the view had "no effect").
 * The view is included when it overlaps/neighbours the circle so the heatmap
 * still covers what the user is looking at; `originOnly` skips that for the
 * "Get me out of here" shortcut.
 *
 * @param {{originOnly?: boolean}} [opts]
 * @returns {{bounds: object, box: object|null, expanded: boolean,
 *            origin: object, radiusM: number, minutes: number}}
 */
function getAnalysisPlan(opts = {}) {
  const view = map.getBounds();
  const origin = getReachOrigin();
  const timeActive = reachTimeBudgetMin > 0 && selectedTransportModes.size > 0;
  const viewBox = {
    south: view.getSouth(), west: view.getWest(),
    north: view.getNorth(), east: view.getEast(),
  };

  if (!timeActive) {
    return { bounds: view, box: viewBox, expanded: false, origin, radiusM: 0, minutes: 0 };
  }
  const radiusM = Math.max(...reachRadiiM());
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    return { bounds: view, box: viewBox, expanded: false, origin, radiusM: 0, minutes: 0 };
  }

  const circle = circleBoundingBox(origin, radiusM * 1.02);
  let box = circle;
  if (!opts.originOnly) {
    box = {
      south: Math.min(circle.south, viewBox.south),
      north: Math.max(circle.north, viewBox.north),
      west:  Math.min(circle.west,  viewBox.west),
      east:  Math.max(circle.east,  viewBox.east),
    };
    /* A far-away view must not blow up the tile download: fall back to the
     * radius box itself, which is what the budget is about. */
    if (boxSpanKm(box) > MAX_ANALYSIS_SPAN_KM) box = circle;
  }

  const expanded = boxSpanKm(box) > boxSpanKm(viewBox) * 1.03;
  return {
    bounds: boxToBounds(box),
    box,
    expanded,
    origin,
    radiusM,
    minutes: reachTimeBudgetMin,
  };
}

/** Farthest distance (m) from `origin` to a corner of the map view. */
function maxViewCornerDistanceM(origin, bounds) {
  const b = bounds || map.getBounds();
  const corners = [
    [b.getSouth(), b.getWest()], [b.getSouth(), b.getEast()],
    [b.getNorth(), b.getWest()], [b.getNorth(), b.getEast()],
  ];
  let max = 0;
  for (const [lat, lng] of corners) {
    max = Math.max(max, haversineDistanceM(origin.lat, origin.lng, lat, lng));
  }
  return max;
}

/**
 * State of the travel-time radius: off | no-mode | active.
 * The radius is plain geometry, so it does not depend on the tile zoom level.
 * `coversView` tells whether the radius is larger than the visible map - the
 * analysis then expands beyond the view instead of being limited by it.
 */
function getTimeFilterState() {
  const modeSpeeds = selectedModeSpeeds();
  const origin = getReachOrigin();
  const routeRuleActive = selectedTransportModes.size > 0 && map.getZoom() >= MIN_REACH_ZOOM;
  const base = { origin, routeRuleActive, modeSpeeds };

  if (!(reachTimeBudgetMin > 0)) {
    return Object.assign(base, { state: 'off', radiusM: 0, maxCornerM: 0, coversView: false });
  }
  if (!modeSpeeds.length) {
    return Object.assign(base, { state: 'no-mode', radiusM: 0, maxCornerM: 0, coversView: false });
  }

  const radiusM = Math.max(...reachRadiiM());
  const maxCornerM = maxViewCornerDistanceM(origin);
  return Object.assign(base, {
    state: 'active',
    radiusM,
    maxCornerM,
    coversView: radiusM >= maxCornerM,
  });
}

/** Short distance label, e.g. "5.8 km" / "580 m". */
function formatRadiusM(m, decimals = 1) {
  if (!Number.isFinite(m)) return '∞';
  return m >= 1000 ? `${(m / 1000).toFixed(decimals)} km` : `${Math.round(m / 10) * 10} m`;
}

/** Human label for the filtered modes, e.g. "🚗 Auto / 🚲 Fahrrad". */
function modesLabelText(ids) {
  return ids.map((id) => {
    const m = TRANSPORT_MODES.find((x) => x.id === id);
    return m ? m.label : id;
  }).join(' / ');
}

/**
 * Reflect the current filter state in the slider, the state badge and the
 * radius circle. Called on every input, on map moves and on GPS updates, so
 * the UI never claims a filter is working when it is not.
 */
function updateTimeFilterUI() {
  const st = getTimeFilterState();
  const stateEl = document.getElementById('timeFilterState');
  const labelEl = document.getElementById('reachTimeLabel');

  if (reachTimeVal) {
    reachTimeVal.textContent = reachTimeBudgetMin > 0 ? `${reachTimeBudgetMin} min` : 'off';
  }
  if (reachTimeSlider) {
    /* Without a transport mode there is no speed, so the slider cannot work. */
    reachTimeSlider.disabled = selectedTransportModes.size === 0;
  }
  if (labelEl) {
    labelEl.classList.toggle('is-inactive', selectedTransportModes.size === 0);
  }
  if (!stateEl) return;

  stateEl.className = 'filter-state';
  let text = '';
  if (st.state === 'off') {
    stateEl.classList.add('off');
    text = selectedTransportModes.size
      ? 'Time filter off – no travel-time limit applied.'
      : 'Reachability filter off – select at least one transport mode.';
  } else if (st.state === 'no-mode') {
    stateEl.classList.add('off');
    text = 'Time filter disabled – select a transport mode first (it defines the speed).';
  } else {
    const radius = formatRadiusM(st.radiusM);
    const origin = st.origin.label;
    stateEl.classList.add('active');
    if (st.coversView) {
      text = `Time filter active – ${reachTimeBudgetMin} min ≈ ${radius} straight-line radius ` +
        `${origin}. The radius is larger than this view: Analyze (and Get me out of here) ` +
        'covers the full radius automatically.';
    } else {
      text = `Time filter active – ${reachTimeBudgetMin} min ≈ ${radius} straight-line radius ` +
        `${origin}. Everything outside is greyed out.`;
    }
    if (st.origin.label.indexOf('map centre') !== -1) {
      text += ' The origin is the map centre and follows the map – enable location for a fixed origin.';
    }
  }
  if (selectedTransportModes.size > 0 && !st.routeRuleActive) {
    text += ` The 200 m route rule is paused below zoom ${MIN_REACH_ZOOM}.`;
  }
  stateEl.textContent = text;
}

/** Comparable key of an analysis configuration (for the stale check). */
function analysisSignature(info) {
  const b = info.bounds;
  return JSON.stringify({
    modes: [...info.modes].sort(),
    budget: info.budgetMin,
    routeRule: info.routeRuleActive,
    origin: info.originLabel,
    bounds: [b.south.toFixed(3), b.west.toFixed(3), b.north.toFixed(3), b.east.toFixed(3)],
  });
}

/** Zoom level a fresh analysis would actually run at (the canonical data zoom
 *  for the analysis box, independent of the current view). */
function plannedAnalysisZoom(plan) {
  if (!plan) return map.getZoom();
  return canonicalDataZoom(plan.bounds);
}

/** Signature of what a fresh analysis would use right now. */
function currentAnalysisSignature() {
  /* Use the same (possibly radius-expanded) box that runAnalysis would use so
   * an expanded analysis does not look "stale" right after it finished. */
  const plan = getAnalysisPlan();
  const b = plan.box || {
    south: map.getBounds().getSouth(), west: map.getBounds().getWest(),
    north: map.getBounds().getNorth(), east: map.getBounds().getEast(),
  };
  return analysisSignature({
    modes: [...selectedTransportModes],
    budgetMin: reachTimeBudgetMin > 0 && selectedTransportModes.size ? reachTimeBudgetMin : 0,
    routeRuleActive: selectedTransportModes.size > 0 &&
      plannedAnalysisZoom(plan) >= MIN_REACH_ZOOM,
    originLabel: getReachOrigin().label,
    bounds: b,
  });
}

/** Describe the filter settings of the LAST analysis and flag stale results. */
function updateFilterSummary() {
  const el = document.getElementById('filterSummary');
  if (!el) return;
  if (!lastAnalysisInfo) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }

  const a = lastAnalysisInfo;
  const parts = [];
  if (a.modes.length) {
    parts.push(`reachability ${modesLabelText(a.modes)}`);
    parts.push(a.routeRuleActive
      ? `within ${REACHABILITY_DISTANCE_M} m of an accessible route`
      : `200 m route rule paused (zoom < ${MIN_REACH_ZOOM})`);
  } else {
    parts.push('no reachability filter (no transport mode selected)');
  }
  if (a.budgetMin > 0) {
    parts.push(`${a.budgetMin} min ≈ ${formatRadiusM(a.radiusM)} straight-line radius ${a.originLabel}` +
      (a.expanded ? ' (analysis covered the full radius, beyond the view)' : ''));
  } else {
    parts.push('time filter off');
  }

  let text = `Last analysis: ${parts.join(' · ')}.`;
  if (a.modes.length) text += ' Grey areas are outside this filter.';

  const stale = analysisSignature(a) !== currentAnalysisSignature();
  el.classList.toggle('stale', stale);
  if (stale) text += ' ⚠️ Settings or view changed – click Analyze again.';
  el.textContent = text;
  el.classList.remove('hidden');
}
/** In-memory log of HTTP/API errors recorded during the session. */
const errorLog      = [];
let locationMarker  = null; /* current-position marker */
let locationCircle  = null; /* accuracy circle around current position */
let locationWatchId = null; /* watchPosition handle (string on Android/Capacitor, number in browser) */
let hasCenteredOnUser = false; /* true once the map has been auto-panned to the user */
let vegetationLayer = null; /* optional vegetation polygon overlay */
let terrainLayer    = null; /* optional terrain difficulty overlay */
/* Noise context saved by computeHeatmap() so individual points can be
 * scored on demand (e.g. when the user taps the map).               */
let lastNoiseCtx   = null;  /* {segments, mPerLat, mPerLng, vegetation, plannedTrips, builtUp} */
/* Temporary marker placed when the user taps the map */
let mapClickMarker = null;

/* ── Native platform helpers ────────────────────────────────────── */

/** Returns true when running inside the native Android WebView app. */
const isNativeAndroid = () => typeof window.Android !== 'undefined';

/** Returns true when running inside any native app context. */
const isNative = () =>
  isNativeAndroid() ||
  (typeof window.Capacitor !== 'undefined' &&
   typeof window.Capacitor.isNativePlatform === 'function' &&
   window.Capacitor.isNativePlatform());

/* ── Android geolocation bridge ─────────────────────────────────── */
/* Maps callback IDs to pending Promise handlers or ongoing watch    */
/* subscriptions.  Persistent entries (watchPosition) survive until  */
/* clearWatch() is called.                                           */
const _androidGeoCallbacks = {};
let   _androidCallbackSeq  = 0;

/**
 * Invoked by the native Android layer to deliver a geolocation response.
 * err and result are JS objects embedded directly in the evaluateJavascript
 * call, so no JSON.parse() is needed on this side.
 * @param {string}      id         Callback ID passed to Android.xxx()
 * @param {object|null} err        Error object {code, message}, or null
 * @param {object|null} result     Result payload, or null
 * @param {boolean}     persistent If true, the entry is NOT removed (watch)
 */
window._androidGeoCallback = (id, err, result, persistent) => {
  const entry = _androidGeoCallbacks[id];
  if (!entry) return;
  if (!persistent) delete _androidGeoCallbacks[id];
  if (err) {
    const e = Object.assign(new Error(err.message || 'Location error'), { code: err.code });
    if (entry.reject)  entry.reject(e);
    if (entry.onError) entry.onError(e);
  } else {
    if (entry.resolve)   entry.resolve(result);
    if (entry.onSuccess) entry.onSuccess(result);
  }
};

/** Generate a unique, JS-safe callback ID. */
function _androidGenId() {
  return `a${Date.now()}x${(++_androidCallbackSeq).toString(36)}`;
}

/** Call an Android bridge method and return a one-shot Promise. */
function _androidCall(method, ...args) {
  return new Promise((resolve, reject) => {
    const id = _androidGenId();
    _androidGeoCallbacks[id] = { resolve, reject, persistent: false };
    window.Android[method](id, ...args);
  });
}

/**
 * Shim that wraps the Android JavaScript bridge to present the same
 * Promise-based API as the Capacitor Geolocation plugin, so the rest of
 * the app code can remain unchanged.
 */
const AndroidGeolocation = isNativeAndroid() ? {
  getCurrentPosition: opts =>
    _androidCall('getCurrentPosition', !!(opts && opts.enableHighAccuracy)),

  checkPermissions: () =>
    _androidCall('checkPermissions')
      .then(r => ({ location: r.state, coarseLocation: r.state })),

  requestPermissions: () =>
    _androidCall('requestPermissions')
      .then(r => ({ location: r.state, coarseLocation: r.state })),

  watchPosition: (opts, callback) => {
    const id = _androidGenId();
    _androidGeoCallbacks[id] = { onSuccess: callback, onError: e => console.debug('watchPosition error:', e), persistent: true };
    window.Android.watchPosition(id, !!(opts && opts.enableHighAccuracy));
    return Promise.resolve(id);
  },

  clearWatch: ({ id }) => {
    delete _androidGeoCallbacks[id];
    window.Android.clearWatch(id);
  },
} : null;

/**
 * Returns the active native Geolocation plugin, or null in a plain browser
 * context where navigator.geolocation is used directly.
 */
const NativeGeolocation = () => {
  if (isNativeAndroid()) return AndroidGeolocation;
  if (typeof window.Capacitor !== 'undefined' && window.Capacitor?.Plugins?.Geolocation)
    return window.Capacitor.Plugins.Geolocation;
  return null;
};

/**
 * Resolve the device's current position.
 * Uses the native Android bridge or Capacitor Geolocation plugin when in a
 * native context so that Android shows the runtime permission dialog; falls
 * back to navigator.geolocation in the browser.
 * @param {PositionOptions} [opts]
 * @returns {Promise<GeolocationPosition>}
 */
function fetchCurrentPosition(opts) {
  const geo = NativeGeolocation();
  if (geo) return geo.getCurrentPosition(opts);
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, opts);
  });
}

/* ── Map initialisation ──────────────────────────────────────────── */
/* OpenFreeMap public vector tiles: free for any use (including commercial),
 * no API key, no registration. Attribution is required and shown below. */
const OPENFREEMAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const VECTOR_SOURCE_ID  = 'openmaptiles';

const map = new maplibregl.Map({
  container: 'map',
  style: OPENFREEMAP_STYLE,
  center: [9.0883, 47.7728],
  zoom: 13,
  attributionControl: false,
  maplibreLogo: false,
  dragRotate: false,
  pitchWithRotate: false,
});

map.addControl(new maplibregl.AttributionControl({
  compact: true,
  customAttribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}), 'bottom-right');
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

/* ------------------------------------------------------------------ *
 * Minimal Leaflet-compatible helpers on top of MapLibre GL.
 * Keeps the rendering code below compact and easy to read.
 * ------------------------------------------------------------------ */
const nativeRemoveLayer  = map.removeLayer.bind(map);
const nativeRemoveSource = map.removeSource.bind(map);
const nativeFitBounds    = map.fitBounds.bind(map);

map.setView = (latlng, zoom) => map.jumpTo({ center: [latlng[1], latlng[0]], zoom });
map.fitBounds = (bounds, opts) =>
  nativeFitBounds(bounds && bounds.__bounds ? bounds.__bounds : bounds, opts);
map.removeLayer = (obj) => {
  if (!obj) return;
  if (typeof obj.__remove === 'function') { obj.__remove(); return; }
  const id = typeof obj === 'string' ? obj : obj.id;
  if (!id) return;
  try { if (map.getLayer(id)) nativeRemoveLayer(id); } catch { /* ignore */ }
  try { if (map.getSource(id)) nativeRemoveSource(id); } catch { /* ignore */ }
};

let __overlaySeq = 0;

/* isStyleLoaded() turns false again while a newly added source is loading,
 * so track the one-time initial load event instead. */
let mapReady = false;
map.on('load', () => { mapReady = true; });

/** Run a source/layer creation callback once the map has initially loaded. */
function whenStyleReady(fn) {
  if (mapReady) fn();
  else map.once('load', fn);
}

function divIcon(opts) { return opts || {}; }

/**
 * Enforce a single-popup policy: opening a popup closes whichever popup was
 * open before, so clicking a quiet spot never stacks two popups.
 * @param {maplibregl.Popup} pp
 * @returns {maplibregl.Popup}
 */
function activatePopup(pp) {
  if (activePopup && activePopup !== pp) {
    try { activePopup.remove(); } catch { /* already gone */ }
  }
  activePopup = pp;
  return pp;
}

/**
 * Like activatePopup(), but additionally clears the global reference when the
 * popup is closed by the user. Call once per popup instance.
 * @param {maplibregl.Popup} pp
 */
function registerPopup(pp) {
  pp.on('close', () => { if (activePopup === pp) activePopup = null; });
  return activatePopup(pp);
}

function latLngBounds(points) {
  const b = new maplibregl.LngLatBounds();
  points.forEach(([lat, lng]) => b.extend([lng, lat]));
  return b;
}

/**
 * Leaflet-style marker on top of MapLibre, including popup support.
 * @param {[number, number]|{lat:number,lng:number}} latlng
 * @param {{icon?: {html?: string, className?: string, iconSize?: number[]}}} [opts]
 */
function makeMarker(latlng, opts = {}) {
  const lat = Array.isArray(latlng) ? latlng[0] : latlng.lat;
  const lng = Array.isArray(latlng) ? latlng[1] : latlng.lng;
  const icon = opts.icon || {};
  const el = document.createElement('div');
  el.className = icon.className || '';
  el.innerHTML = icon.html || '';
  if (icon.iconSize) {
    el.style.width  = icon.iconSize[0] + 'px';
    el.style.height = icon.iconSize[1] + 'px';
  }
  const ml = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([lng, lat]);

  const api = {
    _ml: ml,
    _lat: lat,
    _lng: lng,
    _popup: null,
    _popupHtml: null,
    _popupOpts: null,
    _onPopupOpen: null,
    bindPopup(html, o) {
      api._popupHtml = html;
      api._popupOpts = o || {};
      el.style.cursor = 'pointer';
      el.addEventListener('click', (ev) => { ev.stopPropagation(); api.openPopup(); });
      return api;
    },
    bindTooltip(text) { return api.bindPopup(String(text)); },
    openPopup() {
      if (!api._popupHtml) return api;
      api.closePopup();
      const pp = registerPopup(new maplibregl.Popup({
        maxWidth: ((api._popupOpts && api._popupOpts.maxWidth) || 300) + 'px',
        offset: 12,
        closeButton: true,
      }).setLngLat([api._lng, api._lat]).setHTML(api._popupHtml).addTo(map));
      api._popup = pp;
      if (api._onPopupOpen) {
        try { api._onPopupOpen({ popup: { getElement: () => pp.getElement() } }); }
        catch (e) { console.warn('popupopen handler failed:', e); }
      }
      return api;
    },
    closePopup() {
      if (api._popup) {
        if (activePopup === api._popup) activePopup = null;
        api._popup.remove();
        api._popup = null;
      }
      return api;
    },
    getLatLng() { return { lat: api._lat, lng: api._lng }; },
    on(ev, fn) { if (ev === 'popupopen') api._onPopupOpen = fn; return api; },
    addTo(target) {
      if (!target || target === map) ml.addTo(map);
      else if (typeof target._add === 'function') target._add(api);
      return api;
    },
    _attach() { ml.addTo(map); },
    _detach() { ml.remove(); api.closePopup(); },
    __remove() { api._detach(); },
  };
  return api;
}

function makeLayerGroup() {
  const items = [];
  const group = {
    _items: items,
    _onMap: false,
    _add(item) {
      items.push(item);
      if (group._onMap && item._attach) item._attach();
      return group;
    },
    addTo(target) {
      if (target === map) {
        group._onMap = true;
        items.forEach((i) => { if (i._attach) i._attach(); });
      }
      return group;
    },
    __remove() {
      items.forEach((i) => {
        if (i._detach) i._detach();
        else if (i.__remove) i.__remove();
      });
    },
  };
  return group;
}

/**
 * Add a GeoJSON overlay (source + one or more layers) immediately.
 * @param {Array<object>} features  GeoJSON features
 * @param {Array<object>} layerSpecs  MapLibre layer specs ({id,type,paint,layout})
 * @param {{tooltip?: string}} [options]
 */
function makeGeoOverlay(features, layerSpecs, options = {}) {
  const id = 'ov-' + (++__overlaySeq);
  const layerIds = layerSpecs.map((spec, idx) => `${id}-${spec.id || idx}`);
  let removed = false;

  whenStyleReady(() => {
    if (removed) return;
    map.addSource(id, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features },
    });
    layerSpecs.forEach((spec, idx) => {
      const layer = Object.assign({}, spec, { id: layerIds[idx], source: id });
      map.addLayer(layer);
    });
  });

  const overlay = {
    id,
    addTo(target) {
      if (target && typeof target._add === 'function') target._add(overlay);
      return overlay;
    },
    bindTooltip(text) {
      const popup = registerPopup(new maplibregl.Popup({ closeButton: true, offset: 8 }));
      layerIds.forEach((lid) => {
        map.on('click', lid, (ev) => {
          activatePopup(popup);
          popup.setLngLat(ev.lngLat).setText(String(text)).addTo(map);
        });
        map.on('mouseenter', lid, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', lid, () => { map.getCanvas().style.cursor = ''; });
      });
      return overlay;
    },
    __remove() {
      removed = true;
      layerIds.forEach((lid) => {
        try { if (map.getLayer(lid)) nativeRemoveLayer(lid); } catch { /* ignore */ }
      });
      try { if (map.getSource(id)) nativeRemoveSource(id); } catch { /* ignore */ }
    },
  };

  if (options.tooltip) overlay.bindTooltip(options.tooltip);
  return overlay;
}

function makeHeatLayer(points, opts = {}) {
  const id = 'heat-' + (++__overlaySeq);
  const features = points.map(([lat, lng, weight]) => {
    const w = Number(weight) || 0;
    /* Square-root boosts mid-range noise so secondary roads remain visible
     * next to very loud motorways, without changing the underlying scores. */
    return {
      type: 'Feature',
      properties: { w: Math.sqrt(w) },
      geometry: { type: 'Point', coordinates: [lng, lat] },
    };
  });
  let removed = false;
  whenStyleReady(() => {
    if (removed) return;
    map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features } });
    map.addLayer({
    id,
    type: 'heatmap',
    source: id,
    paint: {
      'heatmap-weight': ['get', 'w'],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 1.0, 13, 2.0, 18, 2.8],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 7, 13, 24, 18, 38],
      'heatmap-opacity': opts.opacity != null ? opts.opacity : 0.65,
      'heatmap-color': [
        'interpolate', ['linear'], ['heatmap-density'],
        0.00, 'rgba(96,165,250,0)',
        0.25, 'rgba(96,165,250,0.65)',
        0.45, 'rgba(52,211,153,0.75)',
        0.60, 'rgba(250,204,21,0.85)',
        0.80, 'rgba(251,146,60,0.90)',
        1.00, 'rgba(248,113,113,0.95)',
      ],
    },
    });
  });

  return {
    id,
    addTo() { return this; },
    setOptions(o) {
      if (o.opacity != null) map.setPaintProperty(id, 'heatmap-opacity', o.opacity);
      if (o.blur != null) {
        map.setPaintProperty(id, 'heatmap-radius', Math.max(6, o.blur + 5));
      }
    },
    __remove() {
      removed = true;
      try { if (map.getLayer(id)) nativeRemoveLayer(id); } catch { /* ignore */ }
      try { if (map.getSource(id)) nativeRemoveSource(id); } catch { /* ignore */ }
    },
  };
}

function circlePolygon(lat, lng, radiusM, steps = 64) {
  const pts = [];
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    pts.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return pts;
}

/* Small Leaflet-compatible surface used by the rest of the file. */
const L = {
  divIcon,
  marker: makeMarker,
  layerGroup: makeLayerGroup,
  heatLayer: makeHeatLayer,
  latLngBounds,
};

/* ── Map loading overlay ─────────────────────────────────────────── */
/* Created programmatically so it lives inside the Leaflet container  */
/* (which already has position:relative) and stacks above all panes.  */
const mapLoadingEl = (() => {
  const el = document.createElement('div');
  el.id = 'mapLoading';
  el.className = 'hidden';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = '<div class="map-spinner"></div><span class="map-loading-text"></span>';
  document.getElementById('map').appendChild(el);
  return el;
})();
const mapLoadingText = mapLoadingEl.querySelector('.map-loading-text');

/**
 * Place (or replace) the pulsing location dot and accuracy circle on the map.
 * @param {number} lat
 * @param {number} lng
 * @param {number} accuracy  Accuracy radius in metres.
 */
function placeLocationMarker(lat, lng, accuracy) {
  if (locationMarker) { map.removeLayer(locationMarker); locationMarker = null; }
  if (locationCircle) { map.removeLayer(locationCircle); locationCircle = null; }
  locationCircle = makeGeoOverlay([{
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [circlePolygon(lat, lng, accuracy || 25)] },
  }], [{
    id: 'accuracy-fill',
    type: 'fill',
    paint: { 'fill-color': '#60a5fa', 'fill-opacity': 0.10 },
  }, {
    id: 'accuracy-line',
    type: 'line',
    paint: { 'line-color': '#60a5fa', 'line-width': 1, 'line-opacity': 0.6 },
  }]).addTo(map);
  locationMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      className: '', html: '<div class="location-dot"></div>',
      iconSize: [16, 16], iconAnchor: [8, 8],
    }),
  }).bindPopup('?? Your current location').addTo(map);

  /* The radius origin just changed from "map centre" to "your location". */
  updateTimeFilterUI();
  updateFilterSummary();
  updateOutingPanelState();
}

/**
 * Start a continuous position watch that keeps the location dot updated as
 * the device moves.  The very first fix automatically pans the map to the
 * user's position (unless the map has already been centred via locateMe).
 * Safe to call multiple times – an existing watch is stopped first.
 */
function startLocationWatch() {
  stopLocationWatch();

  const opts = { enableHighAccuracy: true, timeout: 30_000 };

  function onPosition({ coords }) {
    const { latitude: lat, longitude: lng, accuracy } = coords;
    if (!hasCenteredOnUser) {
      hasCenteredOnUser = true;
      map.setView([lat, lng], 12);
    }
    placeLocationMarker(lat, lng, accuracy);
    updateLocationStatus();
    /* Mini navigation follows the user and updates the remaining distance. */
    if (navSession) updateNavProgress(lat, lng);
  }

  const geo = NativeGeolocation();
  if (geo) {
    geo.watchPosition(opts, onPosition)
      .then(id  => { locationWatchId = id; })
      .catch(e  => console.debug('watchPosition failed:', e));
  } else if (navigator.geolocation) {
    locationWatchId = navigator.geolocation.watchPosition(
      onPosition,
      e => console.debug('watchPosition error:', e),
      opts,
    );
  }
}

/**
 * Stop the active position watch, if any.
 */
function stopLocationWatch() {
  if (locationWatchId === null) return;
  const id = locationWatchId;
  locationWatchId = null;
  const geo = NativeGeolocation();
  if (geo) {
    try { geo.clearWatch({ id }); } catch { /* ignore */ }
  } else if (navigator.geolocation) {
    navigator.geolocation.clearWatch(id);
  }
}

window.addEventListener('beforeunload', stopLocationWatch);

/**
 * Check the current geolocation permission state and update the Location
 * card in the sidebar.  Supports the native Android bridge, the Capacitor
 * Geolocation plugin, and the browser Permissions API.
 */
async function updateLocationStatus() {
  const permStatusEl = document.getElementById('locationPermStatus');
  const enableBtn    = document.getElementById('enableLocationBtn');
  if (!permStatusEl || !enableBtn) return;

  let state = 'unavailable'; /* 'granted' | 'denied' | 'prompt' | 'unavailable' */

  const geo = NativeGeolocation();
  if (geo) {
    try {
      const perm = await geo.checkPermissions();
      if (perm.location === 'granted' || perm.coarseLocation === 'granted') {
        state = 'granted';
      } else if (perm.location === 'denied' || perm.coarseLocation === 'denied') {
        state = 'denied';
      } else {
        state = 'prompt';
      }
    } catch { state = 'unavailable'; }
  } else if (navigator.permissions) {
    try {
      const perm = await navigator.permissions.query({ name: 'geolocation' });
      state = perm.state; /* 'granted' | 'denied' | 'prompt' */
    } catch { state = navigator.geolocation ? 'prompt' : 'unavailable'; }
  } else {
    state = navigator.geolocation ? 'prompt' : 'unavailable';
  }

  permStatusEl.classList.remove('hidden');
  switch (state) {
    case 'granted':
      permStatusEl.textContent = '✅ Location enabled';
      permStatusEl.className   = 'status success';
      enableBtn.classList.add('hidden');
      break;
    case 'denied':
      if (isNative()) {
        /* On Android the "denied" state from checkPermissions() may appear
         * before any permission dialog has ever been shown (some OEM builds),
         * or after the first denial without "Don't ask again".  Always offer
         * the retry button so requestPermissions() can be attempted again;
         * locateMe() will direct the user to Settings if the system can no
         * longer display the dialog.                                          */
        permStatusEl.textContent = '❌ Location access denied. Tap the button to retry or enable in device Settings.';
        permStatusEl.className   = 'status error';
        enableBtn.textContent    = '⚙️ Enable Location / Open Settings';
        enableBtn.classList.remove('hidden');
      } else {
        permStatusEl.textContent = '❌ Location access denied – please enable in device Settings.';
        permStatusEl.className   = 'status error';
        enableBtn.classList.add('hidden');
      }
      break;
    case 'prompt':
      permStatusEl.textContent = '⚠️ Location not yet enabled.';
      permStatusEl.className   = 'status';
      enableBtn.textContent    = '📍 Enable Location Access';
      enableBtn.classList.remove('hidden');
      break;
    default:
      permStatusEl.textContent = '❌ Location not available on this device.';
      permStatusEl.className   = 'status error';
      enableBtn.classList.add('hidden');
      break;
  }
}

/* Try to center on the user's location, requesting permission if needed */
(async () => {
  /* Show the current permission state in the Location card right away so   */
  /* the user sees the "Enable Location Access" button (or status) as soon  */
  /* as the app loads, before the actual permission dialog appears.          */
  await updateLocationStatus();

  /* In a native context, request location permission first.           */
  /* Use a separate try-catch so a failed requestPermissions() call   */
  /* never prevents the position watch below from running.            */
  const geo = NativeGeolocation();
  if (geo) {
    try {
      await geo.requestPermissions();
    } catch (e) { console.debug('requestPermissions failed on startup:', e); }
  }
  /* Start the continuous watch; the first fix will pan the map and place  */
  /* the location dot.  Subsequent fixes keep the dot in sync as the user  */
  /* moves without re-panning the map.                                     */
  startLocationWatch();
  updateLocationStatus();
})();

/* ── GPS Locate control ──────────────────────────────────────────── */
class LocateControl {
  onAdd() {
    const wrap = document.createElement('div');
    wrap.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    const btn = document.createElement('button');
    btn.type      = 'button';
    btn.className = 'locate-btn';
    btn.innerHTML = '&#9678;';
    btn.title     = 'Center map on my location';
    btn.setAttribute('aria-label', 'Center map on my location');
    btn.addEventListener('click', (ev) => { ev.stopPropagation(); locateMe(); });
    wrap.appendChild(btn);
    return wrap;
  }
  onRemove() {}
}
map.addControl(new LocateControl(), 'bottom-right');

/**
 * Request the device's current GPS position, pan the map to it, and place
 * a pulsing marker with an accuracy circle.
 * On Android this first requests the runtime location permission so the OS
 * permission dialog is shown to the user if needed.
 */
async function locateMe() {
  /* Write a message directly into the Location card so the user always gets
   * feedback in the section they are looking at, not the Analyze section.   */
  function setLocationMsg(msg, cls) {
    const el = document.getElementById('locationPermStatus');
    if (!el) return;
    el.textContent = msg;
    el.className   = `status ${cls}`;
    el.classList.remove('hidden');
  }

  /* Give immediate visual feedback on every click, even when repeating the
   * request in a permanently-denied state where no OS dialog will appear.   */
  setLocationMsg('⏳ Requesting location…', '');

  if (!navigator.geolocation && !isNative()) {
    setLocationMsg('❌ Geolocation is not supported by your browser.', 'error');
    const btn = document.getElementById('enableLocationBtn');
    if (btn) btn.classList.add('hidden');
    return;
  }
  try {
    const geo = NativeGeolocation();
    if (geo) {
      const perm = await geo.requestPermissions();
      if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
        /* The system could not show the permission dialog (permanently denied).
         * Direct the user to the device Settings so they can grant the
         * permission manually.  Show the message directly in the Location card
         * so it is visible even if the Analyze section is out of view.        */
        setLocationMsg(
          '❌ Location access permanently denied. ' +
          'Please open Settings → Apps → 4TheWild → Permissions → Location.',
          'error',
        );
        const btn = document.getElementById('enableLocationBtn');
        if (btn) btn.classList.remove('hidden');
        return;
      }
    } else if (isNative() && !navigator.geolocation) {
      /* Native context without a geolocation bridge and no browser API. */
      setLocationMsg('❌ Geolocation is not supported on this device.', 'error');
      const btn = document.getElementById('enableLocationBtn');
      if (btn) btn.classList.add('hidden');
      return;
    }
    const { coords } = await fetchCurrentPosition({ enableHighAccuracy: true, timeout: 30_000 });
    const { latitude: lat, longitude: lng, accuracy } = coords;
    hasCenteredOnUser = true; /* prevent watchPosition from re-panning */
    map.setView([lat, lng], 14);
    placeLocationMarker(lat, lng, accuracy);
    /* Ensure the continuous watch is (re-)started so the dot stays live. */
    if (locationWatchId === null) startLocationWatch();
  } catch (err) {
    console.warn('Geolocation error:', err?.message || err);
    if (err?.code === 1) {
      /* PERMISSION_DENIED – show an explicit message so the user knows to go
       * to Settings.  We must not rely on updateLocationStatus() here because
       * browsers without the Permissions API (e.g. older Safari) always fall
       * back to the 'prompt' state and would incorrectly re-show the
       * "not yet enabled" button instead of the denied message.               */
      setLocationMsg(
        isNative()
          ? '❌ Location access denied. Please enable in device Settings.'
          : '❌ Location access denied – please enable in your browser or device Settings.',
        'error',
      );
      const btn = document.getElementById('enableLocationBtn');
      if (btn) btn.classList.add('hidden');
      return;
    }
    /* For other errors (timeout, GPS unavailable) keep the button visible so
     * the user can retry without having to go to the device Settings.         */
    setLocationMsg('⚠️ Could not determine your location. Please try again.', 'error');
    const btn = document.getElementById('enableLocationBtn');
    if (btn) btn.classList.remove('hidden');
    return;
  }
  updateLocationStatus();
}

/* ── DOM refs ────────────────────────────────────────────────────── */
const analyzeBtn      = document.getElementById('analyzeBtn');
const statusEl        = document.getElementById('status');
const opacitySlider   = document.getElementById('opacitySlider');
const opacityVal      = document.getElementById('opacityVal');
const reachTimeSlider = document.getElementById('reachTimeSlider');
const reachTimeVal    = document.getElementById('reachTimeVal');
const blurSlider      = document.getElementById('blurSlider');
const blurVal         = document.getElementById('blurVal');
const weightControls  = document.getElementById('weightControls');
const resultsCard     = document.getElementById('resultsCard');
const resultsTitle    = document.getElementById('resultsTitle');
const resultsList     = document.getElementById('resultsList');
const resultsHistoryHint = document.getElementById('resultsHistoryHint');
const clearResultsBtn = document.getElementById('clearResultsBtn');
const planTripBtn     = document.getElementById('planTripBtn');
const tripStatusEl    = document.getElementById('tripStatus');
const sidebarEl       = document.getElementById('sidebar');
const sidebarToggleBtn= document.getElementById('sidebarToggle');
const sidebarCloseBtn = document.getElementById('sidebarClose');
const sidebarOverlay  = document.getElementById('sidebarOverlay');
const vegDampeningCb  = document.getElementById('vegDampening');
const showTerrainCb   = document.getElementById('showTerrain');
const useRailwaysCb   = document.getElementById('useRailways');
const useBuiltUpCb    = document.getElementById('useBuiltUp');
const terrainLegendEl  = document.getElementById('terrainLegend');
const errorLogCard     = document.getElementById('errorLogCard');
const errorLogList     = document.getElementById('errorLogList');
const errorLogBadge    = document.getElementById('errorLogBadge');
const errorLogToggle   = document.getElementById('errorLogToggle');
const errorLogClearBtn = document.getElementById('errorLogClearBtn');
const errorLogBody     = document.getElementById('errorLogBody');

document.getElementById('enableLocationBtn')?.addEventListener('click', locateMe);

/* Refresh location status when the user returns to the app (e.g. after
 * enabling the permission manually in device Settings).               */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) updateLocationStatus();
});

/* ── Navigation ──────────────────────────────────────────────────── */

/**
 * Base URLs for geocoding and routing.
 * Nominatim is used for address → coordinates lookup.
 * OSRM provides free turn-by-turn routing based on OpenStreetMap data.
 */
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const OSRM_BASE      = 'https://router.project-osrm.org';

/** Polyline colour for each OSRM travel profile. */
const NAV_MODE_COLORS = {
  driving: '#60a5fa', /* blue  – matches --accent2 */
  cycling: '#4ade80', /* green – matches --accent  */
  foot:    '#f59e0b', /* amber */
};

/** Leaflet layer group holding the active route polyline and markers. */
let routeLayer = null;

/** Travel mode currently selected: 'driving' | 'cycling' | 'foot' */
let navMode = 'driving';

/* Wire up travel-mode toggle buttons */
document.querySelectorAll('.nav-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    navMode = btn.dataset.mode;
    /* Keep the reachability filter in sync: one routing mode = one filter mode. */
    const transportId = NAV_TO_TRANSPORT[navMode];
    if (transportId) {
      selectedTransportModes = new Set([transportId]);
      syncTransportCheckboxes();
      if (unreachableOverlay) { map.removeLayer(unreachableOverlay); unreachableOverlay = null; }
      if (reachRadiusOverlay) { map.removeLayer(reachRadiusOverlay); reachRadiusOverlay = null; }
      lastReachCtx = null;
      updateTimeFilterUI();
      updateFilterSummary();
    }
  });
});

/** Map an OSRM routing profile to the matching transportation filter id. */
const NAV_TO_TRANSPORT = { driving: 'car', cycling: 'bike', foot: 'foot' };
/** Map a transportation filter id to its OSRM routing profile. */
const TRANSPORT_TO_NAV = { car: 'driving', bike: 'cycling', foot: 'foot' };

/** Reflect `selectedTransportModes` in the checkbox UI. */
function syncTransportCheckboxes() {
  document.querySelectorAll('#transportModes input[type="checkbox"]').forEach((cb) => {
    cb.checked = selectedTransportModes.has(cb.value);
  });
}

/** Reflect the routing mode in the nav buttons (no click handlers fired). */
function syncNavButtons() {
  document.querySelectorAll('.nav-mode-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === navMode);
  });
}

/**
 * Display a message in the navigation status area.
 * @param {string} msg
 * @param {'info'|'success'|'error'} type
 */
function showNavStatus(msg, type = 'info') {
  const el = document.getElementById('navStatus');
  if (!el) return;
  el.textContent = msg;
  el.className   = `status ${type}`;
  el.classList.remove('hidden');
}

/** Hide the navigation status area. */
function hideNavStatus() {
  const el = document.getElementById('navStatus');
  if (el) el.classList.add('hidden');
}

/**
 * Geocode a free-text address using the Nominatim API.
 * Returns { lat, lon, displayName } on success, or null if not found.
 * @param {string} query
 * @returns {Promise<{lat:number,lon:number,displayName:string}|null>}
 */
async function geocodeAddress(query) {
  const url = `${NOMINATIM_BASE}/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const lang = navigator.language || 'en';
  const resp = await fetch(url, { headers: { 'Accept-Language': lang } });
  if (!resp.ok) throw new Error(`Geocoding request failed (HTTP ${resp.status})`);
  const results = await resp.json();
  if (!results.length) return null;
  const { lat, lon, display_name: displayName } = results[0];
  return { lat: parseFloat(lat), lon: parseFloat(lon), displayName };
}

/**
 * Fetch a route from OSRM between two coordinate pairs.
 * @param {number} fromLat  Start latitude
 * @param {number} fromLon  Start longitude
 * @param {number} toLat    End latitude
 * @param {number} toLon    End longitude
 * @param {string} profile  OSRM profile: 'driving' | 'cycling' | 'foot'
 * @returns {Promise<{coordinates:Array,distance:number,duration:number}>}
 */
async function fetchRoute(fromLat, fromLon, toLat, toLon, profile) {
  const coords = `${fromLon},${fromLat};${toLon},${toLat}`;
  const url = `${OSRM_BASE}/route/v1/${profile}/${coords}?overview=full&geometries=geojson&steps=true`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Routing request failed (HTTP ${resp.status})`);
  const data = await resp.json();
  if (data.code !== 'Ok' || !data.routes || !data.routes.length) {
    throw new Error('No route found for the given locations.');
  }
  const route = data.routes[0];

  /* A zero-length route means the router snapped both points onto the same
   * place (e.g. an area missing from the routing dataset). Do not enter
   * "arrived" navigation for that. */
  if (!(route.distance > 0) || !route.geometry || !route.geometry.coordinates ||
      route.geometry.coordinates.length < 2) {
    throw new Error('No usable route found for these points.');
  }

  /* Flatten the turn-by-turn steps of all legs for the mini navigation bar. */
  const steps = [];
  (route.legs || []).forEach((leg) => {
    (leg.steps || []).forEach((st) => {
      steps.push({
        distance: st.distance || 0,
        duration: st.duration || 0,
        type:     (st.maneuver && st.maneuver.type) || '',
        modifier: (st.maneuver && st.maneuver.modifier) || '',
        name:     st.name || '',
      });
    });
  });

  return {
    coordinates: route.geometry.coordinates, /* [lon, lat] pairs */
    distance:    route.distance,             /* metres            */
    duration:    route.duration,             /* seconds           */
    steps,
  };
}

/**
 * Format a distance in metres to a human-readable string.
 * @param {number} metres
 * @returns {string}
 */
function formatDistance(metres) {
  if (metres >= 1000) return `${(metres / 1000).toFixed(1)} km`;
  return `${Math.round(metres)} m`;
}

/**
 * Format a duration in seconds to a human-readable string.
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return `${h} h ${m} min`;
  if (m < 1) return '< 1 min';
  return `${m} min`;
}

/**
 * Remove the currently displayed route from the map.
 * @param {{keepOuting?: boolean}} [opts]  `keepOuting` keeps an active outing
 *   session (used internally when switching between its spots).
 */
function clearRoute(opts = {}) {
  if (routeLayer) {
    map.removeLayer(routeLayer);
    routeLayer = null;
  }
  stopNavSession();
  document.getElementById('navInfo').classList.add('hidden');
  document.getElementById('clearRouteBtn').classList.add('hidden');
  hideNavStatus();
  if (!opts.keepOuting) resetOutingCandidates();
}

/* ── Mini navigation mode ─────────────────────────────────────────── */
/* After a route is calculated the app switches to a compact navigation bar
 * on the map: the route is already active, no second "Navigate" click is
 * needed. With a GPS fix the bar follows the user and shows the next turn. */

let navSession = null;

/* Quiet spots found by the last "Get me out of here" run (best first).
 * The user can cycle through them without starting a new analysis. */
let outingCandidates = [];
let outingIndex = 0;

/** Arrows for the common OSRM maneuver modifiers. */
const MANEUVER_ARROWS = {
  left: '←', right: '→', 'slight left': '↖', 'slight right': '↗',
  'sharp left': '↰', 'sharp right': '↱', straight: '↑', uturn: '↩',
};

function stepArrow(step) {
  if (step.type === 'arrive') return '🏁';
  if (step.type === 'depart') return '↑';
  if (step.type === 'roundabout' || step.type === 'rotary') return '↻';
  if (step.type === 'merge') return '⤵';
  return MANEUVER_ARROWS[step.modifier] || '↑';
}

function maneuverText(step) {
  const road = step.name ? ` onto ${step.name}` : '';
  const mod = step.modifier ? ` ${step.modifier}` : '';
  switch (step.type) {
    case 'depart':
      return `Head out${step.name ? ` on ${step.name}` : ''}`;
    case 'arrive':
      return 'Arrive at your destination';
    case 'roundabout':
    case 'rotary':
      return `Take the roundabout${road}`;
    case 'merge':
      return `Merge${mod}${road}`;
    case 'fork':
      return `Keep ${step.modifier || 'straight'}${road}`;
    case 'end of road':
      return `Turn${mod} at the end of the road${road}`;
    case '':
      return `Continue${road}`;
    default:
      return `${step.type.charAt(0).toUpperCase()}${step.type.slice(1)}${mod}${road}`;
  }
}

/**
 * Project a coordinate onto the route polyline. Returns the distance travelled
 * along the route (metres) and the perpendicular distance to it, so GPS jumps
 * and detours do not fake forward progress.
 */
function projectOnPolyline(lat, lng, polyline, cum) {
  const mPerLat = 111320;
  const mPerLng = 111320 * Math.cos(lat * Math.PI / 180) || 1;
  const px = lng * mPerLng;
  const py = lat * mPerLat;
  let best = { alongM: 0, distanceM: Infinity };
  for (let i = 1; i < polyline.length; i++) {
    const aLat = polyline[i - 1][0], aLng = polyline[i - 1][1];
    const bLat = polyline[i][0],     bLng = polyline[i][1];
    const ax = aLng * mPerLng, ay = aLat * mPerLat;
    const bx = bLng * mPerLng, by = bLat * mPerLat;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 0) t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (d < best.distanceM) {
      const segLen = Math.sqrt(lenSq) || haversineDistanceM(aLat, aLng, bLat, bLng);
      best = { alongM: cum[i - 1] + t * segLen, distanceM: d };
    }
  }
  return best;
}

function nextStepIndex(session) {
  for (let i = 0; i < session.steps.length; i++) {
    if (session.stepEnds[i] > session.progressM + 5) return i;
  }
  return null;
}

/** Fill the compact bar with the current state of `navSession`. */
function renderNavBar() {
  const bar = document.getElementById('routeBar');
  if (!bar) return;
  if (!navSession) {
    bar.classList.add('hidden');
    bar.classList.remove('arrived');
    return;
  }
  const s = navSession;
  const arrived = s.remainingM < 25;

  bar.classList.remove('hidden');
  bar.classList.toggle('arrived', arrived);

  document.getElementById('rbBadge').textContent =
    arrived ? 'ARRIVED' : (s.follow ? '🧭 MINI NAV' : 'ROUTE READY');
  document.getElementById('rbDest').textContent = s.label || 'Destination';

  const nextEl = document.getElementById('rbNext');
  if (arrived) {
    nextEl.innerHTML = '<span class="rb-arrow">🏁</span> You have arrived';
    nextEl.classList.remove('hidden');
  } else {
    const idx = nextStepIndex(s);
    if (idx == null) {
      nextEl.classList.add('hidden');
    } else {
      const step = s.steps[idx];
      const dist = Math.max(0, s.stepEnds[idx] - s.progressM);
      nextEl.innerHTML =
        `<span class="rb-arrow">${stepArrow(step)}</span> ${maneuverText(step)}` +
        (dist > 15 ? ` <b>in ${formatDistanceM(dist)}</b>` : '');
      nextEl.classList.remove('hidden');
    }
  }

  document.getElementById('rbStats').textContent =
    `${formatDistance(s.remainingM)} · ${formatDuration(s.remainingS)} remaining` +
    (s.follow ? '' : ' · tap Follow for live guidance');

  const followBtn = document.getElementById('rbFollow');
  followBtn.textContent = s.follow ? '⏸ Pause' : '🧭 Follow';
  followBtn.classList.toggle('active', s.follow);

  /* Offer the other quiet spots found by the last outing analysis. */
  const otherBtn = document.getElementById('rbNextSpot');
  if (otherBtn) {
    const hasOthers = outingCandidates.length > 1;
    otherBtn.classList.toggle('hidden', !hasOthers);
    if (hasOthers) {
      otherBtn.textContent = `🔀 Spot ${outingIndex + 1}/${outingCandidates.length}`;
    }
  }
}

/** Render the full turn list (toggle with the "Steps" button). */
function renderStepList() {
  const list = document.getElementById('rbStepList');
  if (!list) return;
  list.innerHTML = '';
  if (!navSession || !navSession.steps.length) {
    list.classList.add('hidden');
    return;
  }
  navSession.steps.forEach((step) => {
    const li = document.createElement('li');
    const arrow = document.createElement('span');
    arrow.className = 'rs-arrow';
    arrow.textContent = stepArrow(step);
    const text = document.createElement('span');
    text.textContent = maneuverText(step);
    const dist = document.createElement('span');
    dist.className = 'rs-dist';
    dist.textContent = formatDistanceM(step.distance || 0);
    li.append(arrow, text, dist);
    list.appendChild(li);
  });
}

/**
 * Enter mini navigation for a freshly calculated route.
 * @param {{route: object, label: string, destLat: number, destLng: number,
 *          follow: boolean}} cfg
 */
function startNavSession(cfg) {
  const route = cfg.route;
  const polyline = route.coordinates.map(([lon, lat]) => [lat, lon]);
  const cum = [0];
  for (let i = 1; i < polyline.length; i++) {
    cum.push(cum[i - 1] + haversineDistanceM(
      polyline[i - 1][0], polyline[i - 1][1], polyline[i][0], polyline[i][1]));
  }
  const stepEnds = [];
  let acc = 0;
  (route.steps || []).forEach((step) => { acc += step.distance || 0; stepEnds.push(acc); });

  navSession = {
    route,
    label: cfg.label || 'Destination',
    polyline,
    cum,
    totalM: cum[cum.length - 1] || route.distance,
    steps: route.steps || [],
    stepEnds,
    destLat: cfg.destLat,
    destLng: cfg.destLng,
    follow: !!cfg.follow,
    progressM: 0,
    remainingM: route.distance,
    remainingS: route.duration,
  };

  if (locationMarker) {
    const ll = locationMarker.getLatLng();
    updateNavProgress(ll.lat, ll.lng, { recenter: false });
  }
  renderStepList();
  renderNavBar();

  if (cfg.follow && locationMarker) {
    const ll = locationMarker.getLatLng();
    map.easeTo({ center: [ll.lng, ll.lat], zoom: Math.max(map.getZoom(), 14), duration: 800 });
  }
}

/** Recompute remaining distance/time from a new GPS fix. */
function updateNavProgress(lat, lng, opts = {}) {
  if (!navSession) return;
  const s = navSession;
  const p = projectOnPolyline(lat, lng, s.polyline, s.cum);
  /* Progress never goes backwards - a noisy fix or a detour must not rewind. */
  s.progressM = Math.max(s.progressM, Math.min(p.alongM, s.totalM));
  s.remainingM = Math.max(0, s.totalM - s.progressM);
  const ratio = s.totalM > 0 ? s.remainingM / s.totalM : 0;
  s.remainingS = s.route.duration * ratio;
  renderNavBar();
  if (s.follow && opts.recenter !== false) {
    map.easeTo({ center: [lng, lat], duration: 900, zoom: Math.max(map.getZoom(), 14) });
  }
}

/** Leave mini navigation mode and hide the route bar. */
function stopNavSession() {
  navSession = null;
  const bar = document.getElementById('routeBar');
  if (bar) {
    bar.classList.add('hidden');
    bar.classList.remove('arrived');
  }
  const list = document.getElementById('rbStepList');
  if (list) list.classList.add('hidden');
}

/* Route bar controls (created once - the elements exist in index.html). */
(function wireRouteBar() {
  const bar = document.getElementById('routeBar');
  if (!bar) return;

  document.getElementById('rbEnd').addEventListener('click', clearRoute);

  document.getElementById('rbSteps').addEventListener('click', () => {
    const list = document.getElementById('rbStepList');
    if (!list) return;
    if (!list.children.length) renderStepList();
    list.classList.toggle('hidden');
  });

  document.getElementById('rbFollow').addEventListener('click', () => {
    if (!navSession) return;
    navSession.follow = !navSession.follow;
    if (navSession.follow) {
      if (locationMarker) {
        const ll = locationMarker.getLatLng();
        map.easeTo({ center: [ll.lng, ll.lat], duration: 700, zoom: Math.max(map.getZoom(), 14) });
      } else {
        showNavStatus('📍 Enable location access for live guidance.', 'info');
      }
    }
    renderNavBar();
  });

  document.getElementById('rbNextSpot')?.addEventListener('click', () => { showNextQuietSpot(); });

  /* Panning the map pauses the automatic camera follow, but keeps the route. */
  map.on('dragstart', () => {
    if (navSession && navSession.follow) {
      navSession.follow = false;
      renderNavBar();
    }
  });
})();

/**
 * Geocode the destination, calculate the route from the user's current
 * position (or the map centre) and render it on the map.
 */
async function calculateRoute() {
  const destInput = document.getElementById('navDestInput');
  const query = destInput ? destInput.value.trim() : '';
  if (!query) {
    showNavStatus('⚠️ Please enter a destination.', 'error');
    return;
  }

  /* A new geocoded destination is not part of the outing list. */
  resetOutingCandidates();

  const calcBtn = document.getElementById('calcRouteBtn');
  calcBtn.disabled = true;
  showNavStatus('⏳ Looking up destination…', 'info');

  try {
    /* 1. Geocode the destination */
    const dest = await geocodeAddress(query);
    if (!dest) {
      showNavStatus('❌ Destination not found. Please try a different search term.', 'error');
      return;
    }

    showNavStatus('⏳ Calculating route…', 'info');

    /* 2. Determine origin: prefer the live location marker; fall back to the
     *    current map centre so the feature works even without GPS.            */
    let fromLat, fromLon;
    if (locationMarker) {
      const ll = locationMarker.getLatLng();
      fromLat = ll.lat;
      fromLon = ll.lng;
    } else {
      const centre = map.getCenter();
      fromLat = centre.lat;
      fromLon = centre.lng;
    }

    /* 3. Fetch the route from OSRM */
    const route = await fetchRoute(fromLat, fromLon, dest.lat, dest.lon, navMode);

    /* 4. Render the route on the map */
    clearRoute();
    routeLayer = L.layerGroup();

    /* Route polyline – GeoJSON coordinates are [lon, lat] */
    const latLngs = route.coordinates.map(([lon, lat]) => [lat, lon]);
    const modeColors = NAV_MODE_COLORS;
    const lineColor  = modeColors[navMode] || NAV_MODE_COLORS.driving;

    makeGeoOverlay([{
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: route.coordinates },
    }], [{
      id: 'route',
      type: 'line',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': lineColor, 'line-width': 5, 'line-opacity': 0.85 },
    }]).addTo(routeLayer);

    /* Origin marker */
    L.marker([fromLat, fromLon], {
      icon: L.divIcon({
        className: '',
        html: '<div class="route-pin route-pin-start">A</div>',
        iconSize:   [26, 26],
        iconAnchor: [13, 13],
      }),
    }).bindPopup('📍 Start').addTo(routeLayer);

    /* Destination marker */
    L.marker([dest.lat, dest.lon], {
      icon: L.divIcon({
        className: '',
        html: '<div class="route-pin route-pin-end">B</div>',
        iconSize:   [26, 26],
        iconAnchor: [13, 13],
      }),
    }).bindPopup(`📌 ${dest.displayName}`).addTo(routeLayer);

    routeLayer.addTo(map);

    /* Fit the map to the route bounds */
    map.fitBounds(L.latLngBounds(latLngs), { padding: [40, 40] });

    /* 5. Show route info */
    document.getElementById('navDistance').textContent =
      `📏 ${formatDistance(route.distance)}`;
    document.getElementById('navDuration').textContent =
      `⏱ ${formatDuration(route.duration)}`;
    document.getElementById('navInfo').classList.remove('hidden');
    document.getElementById('clearRouteBtn').classList.remove('hidden');

    /* No second "Navigate" click: the route is active and mini navigation
     * starts right away (turn list + live progress when GPS is available). */
    startNavSession({
      route,
      label: dest.displayName,
      destLat: dest.lat,
      destLng: dest.lon,
      follow: !!locationMarker,
    });
    showNavStatus('✅ Route active – mini navigation is running on the map.', 'success');

  } catch (err) {
    console.warn('Navigation error:', err.message);
    showNavStatus(`❌ ${err.message}`, 'error');
  } finally {
    calcBtn.disabled = false;
  }
}

/**
 * Calculate and display a route to the given coordinates, bypassing the
 * geocoding step.  Uses the same travel mode, origin logic, and rendering
 * as calculateRoute() but accepts a lat/lng pair directly – useful when
 * the user taps the map or selects a quiet-spot result.
 * @param {number} lat    Destination latitude
 * @param {number} lng    Destination longitude
 * @param {string} label  Human-readable name shown in the destination popup
 * @param {{keepOuting?: boolean}} [opts]  `keepOuting` keeps the quiet-spot
 *   candidate list of the last "Get me out of here" run intact.
 */
async function navigateToCoords(lat, lng, label, opts = {}) {
  if (!opts.keepOuting) resetOutingCandidates();
  const calcBtn = document.getElementById('calcRouteBtn');
  if (calcBtn) calcBtn.disabled = true;
  showNavStatus('⏳ Calculating route…', 'info');

  /* Scroll the nav card into view so the user sees the progress/result */
  document.getElementById('navCard')?.scrollIntoView({ behavior: 'smooth' });

  try {
    /* Prefer the live location marker; fall back to the (session-frozen)
     * analysis origin. Using the map centre here would make the second spot
     * of an outing start at the first destination. */
    let fromLat, fromLon;
    const origin = getReachOrigin();
    fromLat = origin.lat;
    fromLon = origin.lng;

    const route = await fetchRoute(fromLat, fromLon, lat, lng, navMode);
    clearRoute({ keepOuting: !!opts.keepOuting });
    routeLayer = L.layerGroup();

    /* Route polyline */
    const latLngs  = route.coordinates.map(([lon, rlat]) => [rlat, lon]);
    const lineColor = NAV_MODE_COLORS[navMode] || NAV_MODE_COLORS.driving;
    makeGeoOverlay([{
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: route.coordinates },
    }], [{
      id: 'route',
      type: 'line',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': lineColor, 'line-width': 5, 'line-opacity': 0.85 },
    }]).addTo(routeLayer);

    /* Origin marker */
    L.marker([fromLat, fromLon], {
      icon: L.divIcon({
        className: '',
        html: '<div class="route-pin route-pin-start">A</div>',
        iconSize: [26, 26], iconAnchor: [13, 13],
      }),
    }).bindPopup('📍 Start').addTo(routeLayer);

    /* Destination marker */
    L.marker([lat, lng], {
      icon: L.divIcon({
        className: '',
        html: '<div class="route-pin route-pin-end">B</div>',
        iconSize: [26, 26], iconAnchor: [13, 13],
      }),
    }).bindPopup(`📌 ${label}`).addTo(routeLayer);

    routeLayer.addTo(map);
    map.fitBounds(L.latLngBounds(latLngs), { padding: [40, 40] });

    document.getElementById('navDistance').textContent = `📏 ${formatDistance(route.distance)}`;
    document.getElementById('navDuration').textContent = `⏱ ${formatDuration(route.duration)}`;
    document.getElementById('navInfo').classList.remove('hidden');
    document.getElementById('clearRouteBtn').classList.remove('hidden');

    startNavSession({
      route,
      label,
      destLat: lat,
      destLng: lng,
      follow: !!locationMarker,
    });
    showNavStatus('✅ Route active – mini navigation is running on the map.', 'success');

  } catch (err) {
    console.warn('Navigation error:', err.message);
    showNavStatus(`❌ ${err.message}`, 'error');
  } finally {
    if (calcBtn) calcBtn.disabled = false;
  }
}

document.getElementById('calcRouteBtn').addEventListener('click', calculateRoute);
document.getElementById('clearRouteBtn').addEventListener('click', clearRoute);

/* Allow pressing Enter in the destination field to trigger the calculation */
document.getElementById('navDestInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') calculateRoute();
});

/* ── Mobile sidebar toggle ───────────────────────────────────────── */
function openSidebar() {
  sidebarEl.classList.remove('hidden-mobile');
  sidebarOverlay.classList.remove('hidden');
  sidebarToggleBtn.setAttribute('aria-expanded', 'true');
}

function closeSidebar() {
  sidebarEl.classList.add('hidden-mobile');
  sidebarOverlay.classList.add('hidden');
  sidebarToggleBtn.setAttribute('aria-expanded', 'false');
}

sidebarToggleBtn.addEventListener('click', openSidebar);
sidebarCloseBtn.addEventListener('click', closeSidebar);
sidebarOverlay.addEventListener('click', closeSidebar);

/* On mobile viewports, start with the sidebar closed so the map is front-and-center */
if (window.matchMedia('(max-width: 480px)').matches) {
  closeSidebar();
}

/* ── Map click – point selection, noise info & navigation ─────────── */

/**
 * Wire up the "Navigate here" button inside a Leaflet popup.
 * Uses popupopen so the button element is guaranteed to be in the DOM.
 * @param {L.Marker} marker   The marker whose popup contains the button
 * @param {number}   lat      Destination latitude
 * @param {number}   lng      Destination longitude
 * @param {string}   label    Human-readable destination label
 */
function bindPopupNavBtn(marker, lat, lng, label) {
  marker.on('popupopen', function(ev) {
    const btn = ev.popup.getElement()?.querySelector('.popup-nav-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      navigateToCoords(lat, lng, label);
      /* On mobile, open the sidebar so the user can see the nav result */
      if (window.matchMedia('(max-width: 480px)').matches) openSidebar();
    });
  });
}

map.on('click', function onMapClick(e) {
  const lat = e.lngLat ? e.lngLat.lat : e.latlng.lat;
  const lng = e.lngLat ? e.lngLat.lng : e.latlng.lng;

  /* Remove any existing click marker */
  if (mapClickMarker) {
    map.removeLayer(mapClickMarker);
    mapClickMarker = null;
  }

  /* Noise score at the clicked point (requires a completed analysis) */
  const noiseScore = computeNoiseAtPoint(lat, lng);
  const noiseStr = noiseScore !== null
    ? `🔊 Noise index: <b>${noiseScore.toFixed(2)}</b>`
    : '🔊 Noise index: <i>n/a – run analysis first</i>';

  /* Straight-line distance from the user's known location */
  let accessStr = '';
  if (locationMarker) {
    const ll   = locationMarker.getLatLng();
    const dist = haversineDistanceM(ll.lat, ll.lng, lat, lng);
    accessStr  = `📏 ${formatDistance(dist)} from your location`;
  }

  const label    = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  const reachStr = describeReachabilityAt(lat, lng);
  const popupHtml =
    `<div class="map-click-popup">` +
    `<b>📍 Selected location</b><br>` +
    `<span class="mcp-coords">${label}</span><br>` +
    `${noiseStr}<br>` +
    (reachStr ? `${reachStr}<br>` : '') +
    (accessStr ? `${accessStr}<br>` : '') +
    `<button class="popup-nav-btn">🧭 Navigate here</button>` +
    `</div>`;

  mapClickMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      className:   '',
      html:        '<div class="map-click-marker"></div>',
      iconSize:    [18, 18],
      iconAnchor:  [9, 9],
      popupAnchor: [0, -12],
    }),
  })
    .bindPopup(popupHtml, { maxWidth: 260 })
    .addTo(map);

  bindPopupNavBtn(mapClickMarker, lat, lng, label);
  /* Defer so overlay tooltips (e.g. planned-trip areas) open first and are
   * then replaced by this more informative selection popup - one popup only. */
  const clickedMarker = mapClickMarker;
  setTimeout(() => { if (clickedMarker === mapClickMarker) clickedMarker.openPopup(); }, 0);
});

/* ── Trip planning ───────────────────────────────────────────────── */

/**
 * Base URL for the trip-planning backend.
 *
 * Resolves to the directory the web app is served from (e.g.
 * http://192.168.178.37/apps/wild), where api.php lives - no configuration
 * needed. `null` means trip planning is unavailable: inside the Android
 * WebView the assets are served by WebViewAssetLoader, which has no PHP
 * backend.
 */
const TRIP_API_BASE = (() => {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return null;
  if (location.hostname === 'appassets.androidplatform.net') return null;
  return new URL('.', location.href).href.replace(/\/$/, '');
})();

/**
 * Noise penalty added per planned trip that overlaps a grid point.
 * Using the formula  noise = weight × 1000 / dist  with weight = 1
 * (unclassified road), a penalty of 2 is equivalent to standing ~500 m
 * from that road type.  This makes heavily-planned areas noticeably less
 * "silent" without overwhelming the road-noise contribution.
 */
const TRIP_NOISE_PENALTY = 2;

/* ── Road data cache (localStorage) ─────────────────────────────── */

/** localStorage key prefix for cached road data. */
const ROAD_CACHE_PREFIX  = '4w_roads_';
/** Time-to-live for cached road data: 24 hours. */
const ROAD_CACHE_TTL_MS  = 24 * 60 * 60 * 1000;

/**
 * Zoom level whose tile detail the current fetch reads. The vector source
 * carries its finest data at zoom 14 and is over-zoomed above that.
 */
const DATA_MAX_ZOOM = 14;

/** Zoom bucket that a cache entry belongs to (tile detail differs per zoom). */
function dataZoomBucket() {
  return String(Math.max(0, Math.min(DATA_MAX_ZOOM, Math.round(map.getZoom()))));
}

/**
 * Build a deterministic localStorage key for the given map bounds and the
 * current data zoom. Coordinates are rounded to 4 decimal places (~11 m) so
 * that re-analysing the identical view always produces a cache hit; the zoom
 * is part of the key because coarse tiles must never be reused for a detailed
 * analysis (that produced different quiet spots depending on run order).
 * @param {string} prefix
 * @param {L.LatLngBounds} bounds
 * @returns {string}
 */
function boundsCacheKey(prefix, bounds) {
  const s = bounds.getSouth().toFixed(4);
  const w = bounds.getWest().toFixed(4);
  const n = bounds.getNorth().toFixed(4);
  const e = bounds.getEast().toFixed(4);
  return `${prefix}${s},${w},${n},${e}|z${dataZoomBucket()}`;
}

/**
 * Build a deterministic localStorage key for the given map bounds.
 * @param {L.LatLngBounds} bounds
 * @returns {string}
 */
function roadCacheKey(bounds) {
  return boundsCacheKey(ROAD_CACHE_PREFIX, bounds);
}

/**
 * Return cached road ways for the given bounds, or null on a miss /
 * expired entry.
 * @param {L.LatLngBounds} bounds
 * @returns {Array|null}
 */
function getCachedRoads(bounds) {
  try {
    const raw = localStorage.getItem(roadCacheKey(bounds));
    if (!raw) return null;
    const { ways, cachedAt } = JSON.parse(raw);
    if (Date.now() - cachedAt > ROAD_CACHE_TTL_MS) {
      localStorage.removeItem(roadCacheKey(bounds));
      return null;
    }
    return ways;
  } catch {
    return null;
  }
}

/**
 * Persist road ways in localStorage for the given bounds.
 * Silently no-ops when storage is unavailable or full.
 * @param {L.LatLngBounds} bounds
 * @param {Array} ways
 */
function setCachedRoads(bounds, ways) {
  try {
    localStorage.setItem(
      roadCacheKey(bounds),
      JSON.stringify({ ways, cachedAt: Date.now() })
    );
  } catch {
    /* Storage quota exceeded or unavailable – fail silently */
  }
}

/* ── Vegetation cache (localStorage) ────────────────────────────── */
const VEG_CACHE_PREFIX = '4w_veg_';

function vegCacheKey(bounds) {
  return boundsCacheKey(VEG_CACHE_PREFIX, bounds);
}
function getCachedVegetation(bounds) {
  try {
    const raw = localStorage.getItem(vegCacheKey(bounds));
    if (!raw) return null;
    const { polys, cachedAt } = JSON.parse(raw);
    if (Date.now() - cachedAt > ROAD_CACHE_TTL_MS) { localStorage.removeItem(vegCacheKey(bounds)); return null; }
    return polys;
  } catch { return null; }
}
function setCachedVegetation(bounds, polys) {
  try { localStorage.setItem(vegCacheKey(bounds), JSON.stringify({ polys, cachedAt: Date.now() })); }
  catch { /* quota exceeded */ }
}

/* ── Terrain cache (localStorage) ───────────────────────────────── */
const TERRAIN_CACHE_PREFIX = '4w_terrain_';

function terrainCacheKey(bounds) {
  return boundsCacheKey(TERRAIN_CACHE_PREFIX, bounds);
}
function getCachedTerrain(bounds) {
  try {
    const raw = localStorage.getItem(terrainCacheKey(bounds));
    if (!raw) return null;
    const { ways, cachedAt } = JSON.parse(raw);
    if (Date.now() - cachedAt > ROAD_CACHE_TTL_MS) { localStorage.removeItem(terrainCacheKey(bounds)); return null; }
    return ways;
  } catch { return null; }
}
function setCachedTerrain(bounds, ways) {
  try { localStorage.setItem(terrainCacheKey(bounds), JSON.stringify({ ways, cachedAt: Date.now() })); }
  catch { /* quota exceeded */ }
}

/* ── Railway cache (localStorage) ───────────────────────────────── */
const RAILWAY_CACHE_PREFIX = '4w_railway_';

function railwayCacheKey(bounds) {
  return boundsCacheKey(RAILWAY_CACHE_PREFIX, bounds);
}
function getCachedRailways(bounds) {
  try {
    const raw = localStorage.getItem(railwayCacheKey(bounds));
    if (!raw) return null;
    const { ways, cachedAt } = JSON.parse(raw);
    if (Date.now() - cachedAt > ROAD_CACHE_TTL_MS) { localStorage.removeItem(railwayCacheKey(bounds)); return null; }
    return ways;
  } catch { return null; }
}
function setCachedRailways(bounds, ways) {
  try { localStorage.setItem(railwayCacheKey(bounds), JSON.stringify({ ways, cachedAt: Date.now() })); }
  catch { /* quota exceeded */ }
}

/* ── Waterway cache (localStorage) ──────────────────────────────── */
const WATERWAY_CACHE_PREFIX = '4w_waterway_';

function waterwayCacheKey(bounds) {
  return boundsCacheKey(WATERWAY_CACHE_PREFIX, bounds);
}
function getCachedWaterways(bounds) {
  try {
    const raw = localStorage.getItem(waterwayCacheKey(bounds));
    if (!raw) return null;
    const { ways, cachedAt } = JSON.parse(raw);
    if (Date.now() - cachedAt > ROAD_CACHE_TTL_MS) { localStorage.removeItem(waterwayCacheKey(bounds)); return null; }
    return ways;
  } catch { return null; }
}
function setCachedWaterways(bounds, ways) {
  try { localStorage.setItem(waterwayCacheKey(bounds), JSON.stringify({ ways, cachedAt: Date.now() })); }
  catch { /* quota exceeded */ }
}

/**
 * Register the current map view as an anonymous planned trip.
 * Failures are surfaced to the user but do not block other functionality.
 */
async function planTrip() {
  if (TRIP_API_BASE === null) {
    showTripStatus('⚠️ Trip planning is available in the web version only.', 'error');
    return;
  }

  const bounds = map.getBounds();
  const payload = {
    south: bounds.getSouth(),
    west:  bounds.getWest(),
    north: bounds.getNorth(),
    east:  bounds.getEast(),
  };

  planTripBtn.disabled = true;
  showTripStatus('⏳ Registering trip…', 'info');

  try {
    const resp = await fetch(`${TRIP_API_BASE}/api/trips`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error(`Server returned HTTP ${resp.status}`);
    showTripStatus('✅ Trip planned! Others in this area will see an adjusted silence score.', 'success');
  } catch (err) {
    console.warn('Trip planning unavailable:', err.message);
    showTripStatus('⚠️ Trip server unavailable. Your plan was not saved.', 'error');
  } finally {
    planTripBtn.disabled = false;
  }
}

/**
 * Fetch planned trips that overlap the given bounds from the backend.
 * Returns an empty array when the server is unreachable so that the rest
 * of the analysis can proceed unaffected.
 * @param {L.LatLngBounds} bounds
 * @returns {Promise<Array<{south:number,west:number,north:number,east:number}>>}
 */
async function fetchPlannedTrips(bounds) {
  if (TRIP_API_BASE === null) return [];

  const params = new URLSearchParams({
    south: bounds.getSouth(),
    west:  bounds.getWest(),
    north: bounds.getNorth(),
    east:  bounds.getEast(),
  });
  try {
    const resp = await fetch(`${TRIP_API_BASE}/api/trips?${params}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return data.trips || [];
  } catch (err) {
    console.warn('Could not fetch planned trips:', err.message);
    return [];
  }
}

planTripBtn.addEventListener('click', planTrip);

/* Hide terrain layer immediately when the toggle is switched off */
showTerrainCb.addEventListener('change', () => {
  if (!showTerrainCb.checked) {
    if (terrainLayer) { map.removeLayer(terrainLayer); terrainLayer = null; }
    terrainLegendEl.classList.add('hidden');
  }
});

/* ── Build weight sliders ────────────────────────────────────────── */

/* Element references kept so applyProfile() can update sliders later */
const roadSliderElements    = [];  /* { slider, valSpan } per WEIGHT_UI_GROUPS  */
const railwaySliderElements = [];  /* { slider, valSpan } per RAILWAY_UI_GROUPS */

/** Helper: build a weight-row with an optional ℹ info button. */
function buildWeightRow(group, onInput) {
  const container = document.createElement('div');
  container.className = 'weight-group';

  const row = document.createElement('div');
  row.className = 'weight-row';

  const lbl = document.createElement('label');
  lbl.title = group.keys.join(', ');

  const labelText = document.createElement('span');
  labelText.className = 'weight-label-text';
  labelText.textContent = group.label;
  lbl.appendChild(labelText);

  const slider = document.createElement('input');
  slider.type  = 'range';
  slider.min   = 0;
  slider.max   = 10;
  slider.step  = 0.1;
  slider.value = group.default;

  const valSpan = document.createElement('span');
  valSpan.className = 'wval';
  valSpan.textContent = group.default;

  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    valSpan.textContent = v;
    onInput(v);
  });

  row.appendChild(lbl);
  row.appendChild(slider);
  row.appendChild(valSpan);

  if (group.info) {
    const infoBtn = document.createElement('button');
    infoBtn.type      = 'button';
    infoBtn.className = 'info-btn';
    infoBtn.textContent = 'ℹ';
    infoBtn.setAttribute('aria-label', `Info: ${group.label}`);

    const infoBox = document.createElement('div');
    infoBox.className = 'weight-info-box hidden';
    infoBox.textContent = group.info;

    infoBtn.addEventListener('click', e => {
      e.preventDefault();
      infoBox.classList.toggle('hidden');
    });

    row.appendChild(infoBtn);
    container.appendChild(row);
    container.appendChild(infoBox);
  } else {
    container.appendChild(row);
  }

  return { container, slider, valSpan };
}

WEIGHT_UI_GROUPS.forEach(group => {
  const { container, slider, valSpan } = buildWeightRow(group, v => {
    group.keys.forEach(k => { roadWeights[k] = v; });
  });
  weightControls.appendChild(container);
  roadSliderElements.push({ slider, valSpan });
});

/* ── Build railway weight sliders ────────────────────────────────── */
const railwayWeightControls = document.getElementById('railwayWeightControls');
RAILWAY_UI_GROUPS.forEach(group => {
  const { container, slider, valSpan } = buildWeightRow(group, v => {
    group.keys.forEach(k => { railwayWeights[k] = v; });
  });
  railwayWeightControls.appendChild(container);
  railwaySliderElements.push({ slider, valSpan });
});

/* ── Noise weight profile management ────────────────────────────── */

/** localStorage key for user-saved noise weight profiles. */
const CUSTOM_PROFILES_KEY = '4tw_custom_profiles';

/** Read user-saved profiles from localStorage (returns [] on failure). */
function loadCustomProfiles() {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_PROFILES_KEY) || '[]');
  } catch (e) {
    console.warn('Could not parse saved profiles from localStorage:', e);
    return [];
  }
}

/**
 * Persist user-saved profiles to localStorage.
 * @returns {boolean} true on success, false if storage is unavailable or full.
 */
function persistCustomProfiles(profiles) {
  try {
    localStorage.setItem(CUSTOM_PROFILES_KEY, JSON.stringify(profiles));
    return true;
  } catch (e) {
    console.warn('Could not save profiles to localStorage:', e);
    return false;
  }
}

/**
 * Apply a profile object to the weight sliders, roadWeights,
 * railwayWeights and the railway toggle.
 * @param {{ roadGroups: number[], railwayGroups: number[], useRailways: boolean }} profile
 */
function applyProfile(profile) {
  profile.roadGroups.forEach((val, i) => {
    if (i >= roadSliderElements.length) return;
    const { slider, valSpan } = roadSliderElements[i];
    slider.value = val;
    valSpan.textContent = val;
    WEIGHT_UI_GROUPS[i].keys.forEach(k => { roadWeights[k] = val; });
  });
  profile.railwayGroups.forEach((val, i) => {
    if (i >= railwaySliderElements.length) return;
    const { slider, valSpan } = railwaySliderElements[i];
    slider.value = val;
    valSpan.textContent = val;
    RAILWAY_UI_GROUPS[i].keys.forEach(k => { railwayWeights[k] = val; });
  });
  if (typeof profile.useRailways === 'boolean') {
    useRailwaysCb.checked = profile.useRailways;
  }
  if (typeof profile.useBuiltUp === 'boolean' && useBuiltUpCb) {
    useBuiltUpCb.checked = profile.useBuiltUp;
  }
}

/**
 * Capture the current slider values as a profile snapshot.
 * @returns {{ roadGroups: number[], railwayGroups: number[], useRailways: boolean }}
 */
function snapshotCurrentProfile() {
  return {
    roadGroups:    roadSliderElements.map(e => parseFloat(e.slider.value)),
    railwayGroups: railwaySliderElements.map(e => parseFloat(e.slider.value)),
    useRailways:   useRailwaysCb.checked,
    useBuiltUp:    useBuiltUpCb ? useBuiltUpCb.checked : true,
  };
}

/**
 * Render the profile selector bar directly above the weight sliders.
 * Inserts: [profile <select>] [💾 save] [🗑 delete] + description line.
 */
function buildProfileUI() {
  const weightsCard = document.getElementById('weightsCard');

  /* ── Description paragraph (shown for built-in profiles) ── */
  const descEl = document.createElement('p');
  descEl.className = 'profile-desc hint';
  descEl.textContent = NOISE_PROFILES[0].description;

  /* ── Row: select + buttons ─────────────────────────────── */
  const row = document.createElement('div');
  row.className = 'profile-row';

  const select = document.createElement('select');
  select.id        = 'profileSelect';
  select.className = 'profile-select';
  select.setAttribute('aria-label', 'Noise weight profile');

  /** Rebuild all <option> / <optgroup> elements inside the select. */
  function refreshOptions() {
    select.innerHTML = '';

    const builtinGrp = document.createElement('optgroup');
    builtinGrp.label = 'Built-in profiles';
    NOISE_PROFILES.forEach(p => {
      const opt = document.createElement('option');
      opt.value       = p.id;
      opt.textContent = p.name;
      opt.title       = p.description;
      builtinGrp.appendChild(opt);
    });
    select.appendChild(builtinGrp);

    const custom = loadCustomProfiles();
    if (custom.length > 0) {
      const customGrp = document.createElement('optgroup');
      customGrp.label = 'Saved profiles';
      custom.forEach(p => {
        const opt = document.createElement('option');
        opt.value       = `custom_${p.id}`;
        opt.textContent = p.name;
        customGrp.appendChild(opt);
      });
      select.appendChild(customGrp);
    }
  }

  refreshOptions();

  /* ── Save button ──────────────────────────────────────── */
  const saveBtn = document.createElement('button');
  saveBtn.className = 'profile-btn';
  saveBtn.title     = 'Save current settings as a new profile';
  saveBtn.textContent = '💾';

  saveBtn.addEventListener('click', () => {
    const name = prompt('Profile name:', '');
    if (!name || !name.trim()) return;
    const profiles = loadCustomProfiles();
    const id = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `u${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    profiles.push({ id, name: name.trim(), ...snapshotCurrentProfile() });
    if (!persistCustomProfiles(profiles)) {
      alert('Could not save profile – storage may be full.');
      return;
    }
    refreshOptions();
    select.value = `custom_${id}`;
    updateDeleteBtn();
  });

  /* ── Delete button ────────────────────────────────────── */
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'profile-btn secondary';
  deleteBtn.title     = 'Delete the selected saved profile';
  deleteBtn.textContent = '🗑';

  function updateDeleteBtn() {
    deleteBtn.disabled = !select.value.startsWith('custom_');
  }
  updateDeleteBtn();

  deleteBtn.addEventListener('click', () => {
    if (!select.value.startsWith('custom_')) return;
    if (!confirm('Delete this saved profile?')) return;
    const id = select.value.slice(7);
    const profiles = loadCustomProfiles().filter(p => p.id !== id);
    persistCustomProfiles(profiles);
    refreshOptions();
    select.value = 'default';
    applyProfile(NOISE_PROFILES[0]);
    descEl.textContent = NOISE_PROFILES[0].description;
    updateDeleteBtn();
  });

  /* ── Selection handler ────────────────────────────────── */
  select.addEventListener('change', () => {
    const val = select.value;
    if (val.startsWith('custom_')) {
      const cid    = val.slice(7);
      const custom = loadCustomProfiles().find(p => p.id === cid);
      if (custom) applyProfile(custom);
      descEl.textContent = '';
    } else {
      const builtin = NOISE_PROFILES.find(p => p.id === val);
      if (builtin) {
        applyProfile(builtin);
        descEl.textContent = builtin.description;
      }
    }
    updateDeleteBtn();
  });

  row.appendChild(select);
  row.appendChild(saveBtn);
  row.appendChild(deleteBtn);

  /* Insert profile row and description before the slider container */
  weightsCard.insertBefore(row, weightControls);
  weightsCard.insertBefore(descEl, weightControls);
}

buildProfileUI();

/* ── Transport mode selector ─────────────────────────────────────── */

/**
 * Inject transport-mode checkboxes into the #transportModes container.
 * Checking/unchecking updates the `selectedTransportModes` Set.
 */
function buildTransportUI() {
  const container = document.getElementById('transportModes');
  if (!container) return;

  TRANSPORT_MODES.forEach(mode => {
    const item = document.createElement('label');
    item.className = 'transport-mode-item';
    item.title = mode.description;

    const cb = document.createElement('input');
    cb.type  = 'checkbox';
    cb.value = mode.id;
    cb.addEventListener('change', () => {
      if (cb.checked) {
        selectedTransportModes.add(mode.id);
      } else {
        selectedTransportModes.delete(mode.id);
      }
      /* A single selected mode also sets the navigation profile. */
      if (selectedTransportModes.size === 1 && mode.navProfile) {
        navMode = mode.navProfile;
        syncNavButtons();
      }
      /* Clear the unreachable overlay immediately when modes change so it
       * does not stay stale until the next analysis run.               */
      if (unreachableOverlay) {
        map.removeLayer(unreachableOverlay);
        unreachableOverlay = null;
      }
      if (reachRadiusOverlay) {
        map.removeLayer(reachRadiusOverlay);
        reachRadiusOverlay = null;
      }
      lastReachCtx = null;
      updateTimeFilterUI();
      updateFilterSummary();
      updateOutingPanelState();
    });

    const icon = document.createElement('span');
    icon.className = 'transport-mode-icon';
    icon.textContent = mode.icon;  /* explicit icon property, no fragile string-split */

    const text = document.createElement('span');
    text.className = 'transport-mode-label';
    /* Strip the leading icon character + space to get just the name */
    text.textContent = mode.label.replace(/^\S+\s/, '');

    item.appendChild(cb);
    item.appendChild(icon);
    item.appendChild(text);
    container.appendChild(item);
  });
}

buildTransportUI();
syncTransportCheckboxes();
syncNavButtons();
updateTimeFilterUI();

opacitySlider.addEventListener('input', () => {
  opacityVal.textContent = Math.round(opacitySlider.value * 100) + '%';
  if (heatLayer) heatLayer.setOptions({ opacity: parseFloat(opacitySlider.value) });
});

blurSlider.addEventListener('input', () => {
  blurVal.textContent = blurSlider.value;
  if (heatLayer) heatLayer.setOptions({ blur: parseInt(blurSlider.value, 10) });
});

/* Travel-time budget slider (0 = off) */
if (reachTimeSlider) {
  reachTimeSlider.addEventListener('input', () => {
    reachTimeBudgetMin = parseInt(reachTimeSlider.value, 10) || 0;
    /* Existing overlay is stale until the next analysis. */
    if (unreachableOverlay) { map.removeLayer(unreachableOverlay); unreachableOverlay = null; }
    if (reachRadiusOverlay) { map.removeLayer(reachRadiusOverlay); reachRadiusOverlay = null; }
    lastReachCtx = null;
    updateTimeFilterUI();
    updateFilterSummary();
    if (reachTimeBudgetMin > 0) outingMinutes = reachTimeBudgetMin;
    updateOutingPanelState();
  });
}

/* Keep the "is the radius doing anything here?" state in sync with the view. */
let moveUiTimer = null;
map.on('moveend', () => {
  if (moveUiTimer) clearTimeout(moveUiTimer);
  moveUiTimer = setTimeout(() => {
    updateTimeFilterUI();
    updateFilterSummary();
    updateOutingPanelState();
  }, 200);
});

/* ── "Get me out of here" shortcut ───────────────────────────────────
 * Lives on the map (outside the sidebar): pick minutes, find the quietest
 * reachable spot in that radius and start mini navigation immediately. */
let outingMinutes = 15;

function updateOutingPanelState() {
  const modeEl = document.getElementById('outingMode');
  if (modeEl) {
    const ids = [...selectedTransportModes];
    const modeText = ids.length ? modesLabelText(ids) : 'walk (default)';
    modeEl.textContent = `${modeText} · ${getReachOrigin().label}`;
  }
  document.querySelectorAll('.op-min').forEach((btn) => {
    btn.classList.toggle('active', parseInt(btn.dataset.min, 10) === outingMinutes);
  });
}

async function getMeOutOfHere() {
  const goBtn = document.getElementById('outingGo');
  if (!goBtn || goBtn.disabled || analyzing) return;
  goBtn.disabled = true;
  try {
    /* The time radius needs a speed: default to walking when none is selected. */
    if (!selectedTransportModes.size) {
      selectedTransportModes = new Set(['foot']);
      syncTransportCheckboxes();
    }
    if (selectedTransportModes.size === 1) {
      const profile = TRANSPORT_TO_NAV[[...selectedTransportModes][0]];
      if (profile) {
        navMode = profile;
        syncNavButtons();
      }
    }

    reachTimeBudgetMin = outingMinutes;
    if (reachTimeSlider) reachTimeSlider.value = String(outingMinutes);
    updateTimeFilterUI();
    updateFilterSummary();
    updateOutingPanelState();

    /* Start (or continue) an outing session. The origin is frozen for the
     * whole session: after the first route the map centre sits at the
     * destination, and re-centring the search there made every repeat run
     * return different spots. */
    if (!outingModeActive) outingOrigin = getReachOrigin();
    outingModeActive = true;

    showStatus(`🌿 Searching the quietest reachable spot within ${outingMinutes} min…`, 'info');
    const res = await runAnalysis({ originOnly: true });
    if (!res) return;

    const points = res.quietestPoints || [];
    if (!points.length) {
      showStatus('❌ No reachable quiet spot found in that radius. Try more minutes or move the map to a mapped area.', 'error');
      return;
    }

    /* Keep the best five spots so the user can switch between them. */
    outingCandidates = points.slice(0, 5);
    outingIndex = 0;

    if (!locationMarker) {
      showStatus(`⚠️ No GPS fix – the radius and the route start ${getReachOrigin().label}.`, 'info');
    }
    await navigateToOutingCandidate(0);
    showStatus(`🌿 Quietest spot within ${outingMinutes} min selected – mini navigation active.`, 'success');
  } finally {
    goBtn.disabled = false;
  }
}

/**
 * Label for one quiet spot of the current outing run.
 * @param {object} p
 * @param {number} idx
 */
function outingSpotLabel(p, idx) {
  const score = Number.isFinite(p.noiseScore) ? p.noiseScore.toFixed(2) : '?';
  return `Quiet spot #${idx + 1} (${outingMinutes} min · noise index ${score})`;
}

/**
 * Route to candidate `idx` of the current outing list.
 * @param {number} idx
 */
async function navigateToOutingCandidate(idx) {
  const p = outingCandidates[idx];
  if (!p) return;
  outingIndex = idx;
  /* This mode shows exactly one spot at a time: drop the previous markers so
   * every "Navigate" / "Other spot" leaves only the new route on the map. */
  clearQuietSpots();
  await navigateToCoords(p.lat, p.lng, outingSpotLabel(p, idx), { keepOuting: true });
  renderNavBar();
}

/** Route to the next quiet spot of the last outing run (wraps around). */
async function showNextQuietSpot() {
  if (outingCandidates.length < 2) return;
  const next = (outingIndex + 1) % outingCandidates.length;
  const btn = document.getElementById('rbNextSpot');
  if (btn) btn.disabled = true;
  try {
    await navigateToOutingCandidate(next);
    showStatus(`🌿 Switched to quiet spot #${next + 1} of ${outingCandidates.length}.`, 'success');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** Hide the route bar and forget the quiet-spot candidates. */
function resetOutingCandidates() {
  outingCandidates = [];
  outingIndex = 0;
  outingModeActive = false;
  outingOrigin = null;
  const btn = document.getElementById('rbNextSpot');
  if (btn) btn.classList.add('hidden');
}

document.getElementById('outingGo')?.addEventListener('click', getMeOutOfHere);
document.getElementById('outingCollapse')?.addEventListener('click', () => {
  const panel = document.getElementById('outingPanel');
  if (!panel) return;
  const collapsed = panel.classList.toggle('collapsed');
  const btn = document.getElementById('outingCollapse');
  if (btn) btn.textContent = collapsed ? '+' : '−';
});
document.querySelectorAll('.op-min').forEach((btn) => {
  btn.addEventListener('click', () => {
    outingMinutes = parseInt(btn.dataset.min, 10) || 15;
    updateOutingPanelState();
  });
});
updateOutingPanelState();

/* ── Analyze button ──────────────────────────────────────────────── */
analyzeBtn.addEventListener('click', () => { runAnalysis(); });
if (clearResultsBtn) clearResultsBtn.addEventListener('click', clearResults);

/** Quietest points of the last completed analysis (best first). */
let lastQuietestPoints = [];

/**
 * Analyse the map data and render the result.
 *
 * @param {{originOnly?: boolean}} [opts]  `originOnly` analyses the travel-time
 *   circle only instead of also including the current view.
 * @returns {Promise<{quietestPoints:Array, coarseData:boolean}|null>}
 */
async function runAnalysis(opts = {}) {
  if (analyzing) return null;
  analyzing = true;
  analyzeBtn.disabled = true;
  /* On mobile, close the sidebar so the map is fully visible */
  if (window.matchMedia('(max-width: 480px)').matches) {
    closeSidebar();
  }
  showStatus('⏳ Fetching road data…', 'info');
  mapLoadingText.textContent = 'Fetching road data…';
  mapLoadingEl.classList.remove('hidden');

  /* Camera to restore after loading tiles outside the current view. */
  let restoreCamera = null;

  try {
    /* The analysis area is derived from the travel-time radius, not from the
     * viewport: a 15 min radius stays 15 min even when the map is zoomed in. */
    const plan = getAnalysisPlan(opts);
    const bounds = plan.bounds;
    const useVeg      = vegDampeningCb.checked;
    const useTerrain  = showTerrainCb.checked;
    const useRailways = useRailwaysCb.checked;
    const useBuiltUp  = useBuiltUpCb ? useBuiltUpCb.checked : true;

    /* ── One canonical data zoom per analysis box ────────────────────── *
     * querySourceFeatures() only returns the tiles currently loaded, and    *
     * their detail depends on the map zoom (low zoom = only major roads).  *
     * Reading the same box at a different zoom therefore produced a        *
     * different "quietest spot". So the box is always loaded at the zoom   *
     * the source can actually deliver (max 14), whatever the user views.   */
    const dataZoom = canonicalDataZoom(bounds);
    const view = map.getBounds();
    const box = plan.box || {
      south: view.getSouth(), west: view.getWest(),
      north: view.getNorth(), east: view.getEast(),
    };
    const boxInsideView = box.south >= view.getSouth() && box.north <= view.getNorth() &&
                          box.west >= view.getWest() && box.east <= view.getEast();
    const needsDataView = !boxInsideView || Math.abs(map.getZoom() - dataZoom) > 0.6;

    if (needsDataView) {
      restoreCamera = {
        center: map.getCenter(),
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      };
      showStatus(
        plan.expanded
          ? `🗺️ Radius is larger than the view – loading map data for the full ` +
            `${plan.minutes} min radius (${formatRadiusM(plan.radiusM)})…`
          : `🗺️ Loading map data for the analysis area at zoom ${dataZoom.toFixed(1)}…`,
        'info',
      );
      mapLoadingText.textContent = plan.expanded
        ? 'Loading data for the full radius…'
        : 'Loading map data for the analysis area…';
      /* Temporarily fit the map to the analysis box so MapLibre loads the
       * vector tiles for all of it at one zoom. The view is restored below. */
      try {
        const cam = map.cameraForBounds(bounds, { padding: 0 });
        if (cam) map.jumpTo(cam);
      } catch {
        map.fitBounds(bounds, { linear: true, duration: 0, padding: 0 });
      }
      await sleep(120);
      await waitForVectorData();
      await sleep(120);
    }

    /* Determine extra data needed for reachability filtering */
    const needsWaterways = [...selectedTransportModes].some(id => {
      const m = TRANSPORT_MODES.find(m => m.id === id);
      return m?.needsWaterways;
    });
    const needsTerrainForReach = [...selectedTransportModes].some(id => {
      const m = TRANSPORT_MODES.find(m => m.id === id);
      return m?.includeTerrainPaths;
    });

    const [ways, plannedTrips, vegetation, terrainWays, railwayWays, waterwayWays, landuse, pois] = await Promise.all([
      fetchRoads(bounds),
      fetchPlannedTrips(bounds),
      useVeg                              ? fetchVegetation(bounds) : Promise.resolve([]),
      (useTerrain || needsTerrainForReach)? fetchTerrain(bounds)    : Promise.resolve([]),
      useRailways                         ? fetchRailways(bounds)   : Promise.resolve([]),
      needsWaterways                      ? fetchWaterways(bounds)  : Promise.resolve([]),
      useBuiltUp                          ? fetchLanduse(bounds)    : Promise.resolve([]),
      useBuiltUp                          ? fetchPois(bounds)       : Promise.resolve([]),
    ]);
    const builtUp = useBuiltUp ? buildBuiltUpContext(landuse, pois) : null;

    if (!ways.length) {
      showStatus('?? No roads in the loaded map data for this view. Zoom in a little or pan to a mapped area, then try again.', 'error');
      return null;
    }

    const tripNote = plannedTrips.length
      ? ` (${plannedTrips.length} trip${plannedTrips.length > 1 ? 's' : ''} planned here – silence score adjusted)`
      : '';
    const vegNote = (useVeg && vegetation.length)
      ? `, ${vegetation.length} vegetation area(s) dampening noise`
      : '';
    const railwayNote = (useRailways && railwayWays.length)
      ? `, ${railwayWays.length} railway way(s) included`
      : '';
    const builtUpNote = (useBuiltUp && builtUp)
      ? `, ${landuse.length} land-use area(s) and ${builtUp.poiCount} POI(s) as crowd proxy`
      : '';
    showStatus(`🧮 Calculating noise scores for ${ways.length} roads${railwayNote}${builtUpNote}…${tripNote}${vegNote}`, 'info');
    mapLoadingText.textContent = 'Calculating noise scores…';

    /* Yield to the browser before heavy computation */
    await sleep(30);

    const { heatPoints, quietestPoints, unreachablePoints, coarseData } = computeHeatmap(
      ways, bounds, plannedTrips, vegetation, railwayWays, waterwayWays, terrainWays, builtUp,
    );

    /* Record whether the analysis went beyond the visible view. */
    if (lastAnalysisInfo) lastAnalysisInfo.expanded = !!plan.expanded;

    /* Back to the user's view before drawing - the result stays visible and
     * the camera does not jump around while the overlays appear. */
    if (restoreCamera) {
      map.jumpTo(restoreCamera);
      restoreCamera = null;
      await sleep(80);
    }

    /* Vegetation and terrain sit below the heatmap so they never tint it. */
    renderVegetationLayer(useVeg ? vegetation : []);
    renderTerrainLayer(useTerrain ? terrainWays : []);
    renderHeatmap(heatPoints);
    renderTripRects(plannedTrips);
    renderUnreachableOverlay(unreachablePoints, bounds);
    renderReachRadius(lastReachCtx);
    if (useTerrain && terrainWays.length) {
      terrainLegendEl.classList.remove('hidden');
    } else {
      terrainLegendEl.classList.add('hidden');
    }
    renderResults(quietestPoints, bounds, coarseData);
    lastQuietestPoints = quietestPoints;
    updateFilterSummary();

    const radiusNote = plan.expanded
      ? ` Analysis covered the full ${plan.minutes} min radius (${formatRadiusM(plan.radiusM)}).`
      : '';
    const reachNote = selectedTransportModes.size > 0 && unreachablePoints.length
      ? ` ${unreachablePoints.length} area(s) greyed out (unreachable).`
      : '';
    const zoomNote = map.getZoom() < MIN_REACH_ZOOM
      ? (selectedTransportModes.size > 0
          ? ` 200 m route rule paused below zoom ${MIN_REACH_ZOOM} (only major roads loaded here)` +
            (lastReachCtx ? ' – the travel-time radius still applies.' : '.')
          : ` Coarse map data at this zoom: only major roads are included. Zoom in for local streets.`)
      : '';
    showStatus(
      `✅ Done — ${ways.length} roads analysed, grid ${GRID_SIZE}×${GRID_SIZE}.` +
      radiusNote +
      (plannedTrips.length ? ` ${plannedTrips.length} planned trip(s) factored in.` : '') +
      (useVeg && vegetation.length ? ` Vegetation dampening applied (${vegetation.length} areas).` : '') +
      (useRailways && railwayWays.length ? ` ${railwayWays.length} railway way(s) included.` : '') +
      (useBuiltUp && builtUp ? ` Built-up/POI density applied (${builtUp.poiCount} POIs).` : '') +
      reachNote + zoomNote,
      'success'
    );

    return { quietestPoints, coarseData, expanded: !!plan.expanded };
  } catch (err) {
    console.error(err);
    logError('Analysis', err.message, err.status);
    if (err.name === 'AbortError') {
      showStatus('? Request timed out. Try a smaller area or retry in a moment.', 'error');
    } else {
      showStatus(`? Error: ${err.message}`, 'error');
    }
    return null;
  } finally {
    if (restoreCamera) {
      try { map.jumpTo(restoreCamera); } catch { /* ignore */ }
      restoreCamera = null;
    }
    analyzing = false;
    analyzeBtn.disabled = false;
    mapLoadingEl.classList.add('hidden');
  }
}

/* -- OpenFreeMap vector data ----------------------------------------
 * Roads, railways, vegetation, waterways and terrain are read directly
 * from the same OpenFreeMap vector tiles that render the map.  The data
 * is ODbL licensed, OpenFreeMap's public instance is free for any use
 * (no API key, no registration) and no Overpass API is involved.
 * ------------------------------------------------------------------ */

/** Wait until the style and all visible tiles have finished loading. */
function waitForVectorData() {
  return new Promise((resolve) => {
    if (map.isStyleLoaded() && map.areTilesLoaded()) { resolve(); return; }
    const done = () => { map.off('idle', done); resolve(); };
    map.on('idle', done);
  });
}

/** Deduplicate vector-tile features that repeat across tile borders. */
function vectorFeatureKey(feature, props) {
  const geom = feature.geometry;
  let anchor = '';
  if (geom && geom.type === 'LineString' && geom.coordinates.length) {
    anchor = geom.coordinates[0].join(',');
  } else if (geom && geom.type === 'Polygon' && geom.coordinates[0] && geom.coordinates[0].length) {
    anchor = geom.coordinates[0][0].join(',');
  } else if (geom && geom.type === 'MultiPolygon' && geom.coordinates[0] && geom.coordinates[0][0]) {
    anchor = geom.coordinates[0][0][0].join(',');
  }
  return `${props.class || ''}|${props.subclass || ''}|${props.brunnel || ''}|${anchor}`;
}

/** Collect line features from a vector source layer. */
function queryLineFeatures(sourceLayer) {
  const raw = map.querySourceFeatures(VECTOR_SOURCE_ID, { sourceLayer });
  const seen = new Set();
  const out = [];
  for (const f of raw) {
    const g = f.geometry;
    if (!g) continue;
    const props = f.properties || {};
    const key = vectorFeatureKey(f, props);
    if (seen.has(key)) continue;
    seen.add(key);
    const lines = g.type === 'LineString' ? [g.coordinates]
      : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const coords of lines) {
      if (!coords || coords.length < 2) continue;
      out.push({ props, coords });
    }
  }
  return out;
}

/** Collect polygon rings from a vector source layer. */
function queryPolygonFeatures(sourceLayer) {
  const raw = map.querySourceFeatures(VECTOR_SOURCE_ID, { sourceLayer });
  const seen = new Set();
  const out = [];
  for (const f of raw) {
    const g = f.geometry;
    if (!g) continue;
    const props = f.properties || {};
    const key = vectorFeatureKey(f, props);
    if (seen.has(key)) continue;
    seen.add(key);
    const rings = [];
    if (g.type === 'Polygon') {
      if (g.coordinates[0]) rings.push(g.coordinates[0]);
    } else if (g.type === 'MultiPolygon') {
      g.coordinates.forEach((poly) => { if (poly[0]) rings.push(poly[0]); });
    }
    for (const ring of rings) {
      if (ring && ring.length >= 4) out.push({ props, ring });
    }
  }
  return out;
}

function coordsToGeometry(coords) {
  return coords.map(([lon, lat]) => ({ lat, lon }));
}

/** Collect point features from a vector source layer. */
function queryPointFeatures(sourceLayer) {
  const raw = map.querySourceFeatures(VECTOR_SOURCE_ID, { sourceLayer });
  const seen = new Set();
  const out = [];
  for (const f of raw) {
    const g = f.geometry;
    if (!g || g.type !== 'Point') continue;
    const props = f.properties || {};
    const [lng, lat] = g.coordinates;
    const key = `${props.class || ''}|${lat.toFixed(5)}|${lng.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ props, lat, lng });
  }
  return out;
}

/** Map OpenMapTiles road classes onto OSM highway tags. */
function highwayTagFor(props) {
  const cls = props.class || '';
  const sub = props.subclass || '';
  const isLink = props.ramp === 1 || props.ramp === true;
  switch (cls) {
    case 'motorway':  return isLink ? 'motorway_link' : 'motorway';
    case 'trunk':     return isLink ? 'trunk_link' : 'trunk';
    case 'primary':   return isLink ? 'primary_link' : 'primary';
    case 'secondary': return isLink ? 'secondary_link' : 'secondary';
    case 'tertiary':  return isLink ? 'tertiary_link' : 'tertiary';
    case 'minor':     return 'residential';
    case 'street':
    case 'street_limited': return 'unclassified';
    case 'service':   return 'service';
    case 'track':     return 'track';
    case 'path':
      if (sub === 'cycleway') return 'cycleway';
      if (sub === 'footway') return 'footway';
      if (sub === 'pedestrian') return 'pedestrian';
      if (sub === 'steps') return 'steps';
      return 'path';
    case 'pedestrian': return 'pedestrian';
    default: return null;
  }
}

/** Map OpenMapTiles railway classes onto OSM railway tags. */
function railwayTagFor(props) {
  if (props.class === 'rail') return 'rail';
  if (props.class === 'transit') {
    const sub = props.subclass || 'tram';
    return DEFAULT_RAILWAY_WEIGHTS[sub] ? sub : 'tram';
  }
  return null;
}

/** Map OpenMapTiles landcover classes onto vegetation keys. */
function vegetationTypeFor(props) {
  const cls = props.class || '';
  const sub = props.subclass || '';
  if (cls === 'wood' || sub === 'wood' || sub === 'forest') return 'wood';
  if (cls === 'grass' || cls === 'grassland') return 'grass';
  if (cls === 'wetland') return 'wetland';
  if (cls === 'farmland') return 'meadow';
  if (cls === 'scrub') return 'scrub';
  if (cls === 'heath') return 'heath';
  return null;
}

/**
 * Road ways for the given bounds, read from the loaded OpenFreeMap tiles.
 * @param {L.LatLngBounds} bounds
 * @returns {Promise<Array>} way elements with OSM-style tags
 */
async function fetchRoads(bounds) {
  const cached = getCachedRoads(bounds);
  if (cached) return cached;

  await waitForVectorData();
  const ways = [];
  for (const { props, coords } of queryLineFeatures('transportation')) {
    const highway = highwayTagFor(props);
    if (!highway) continue;
    ways.push({ tags: { highway }, geometry: coordsToGeometry(coords) });
  }
  setCachedRoads(bounds, ways);
  return ways;
}

/**
 * Vegetation polygons (forests, grassland, wetlands, farmland).
 * @param {L.LatLngBounds} bounds
 * @returns {Promise<Array>} Pre-processed polygon objects with bounding boxes
 */
async function fetchVegetation(bounds) {
  const cached = getCachedVegetation(bounds);
  if (cached) return cached;

  await waitForVectorData();
  const polys = [];
  for (const { props, ring } of queryPolygonFeatures('landcover')) {
    const type = vegetationTypeFor(props);
    if (!type) continue;
    const geometry = coordsToGeometry(ring);
    polys.push({
      type,
      geometry,
      minLat: Math.min(...geometry.map((p) => p.lat)),
      maxLat: Math.max(...geometry.map((p) => p.lat)),
      minLon: Math.min(...geometry.map((p) => p.lon)),
      maxLon: Math.max(...geometry.map((p) => p.lon)),
    });
  }
  setCachedVegetation(bounds, polys);
  return polys;
}

/**
 * Rough terrain tracks from the vector tiles.
 * OpenMapTiles does not carry sac_scale/tracktype, so every track is
 * treated as a rough track (grade 4/5) for the accessibility layer.
 * @param {L.LatLngBounds} bounds
 * @returns {Promise<Array>} way elements
 */
async function fetchTerrain(bounds) {
  const cached = getCachedTerrain(bounds);
  if (cached) return cached;

  await waitForVectorData();
  const ways = [];
  for (const { props, coords } of queryLineFeatures('transportation')) {
    if (props.class !== 'track') continue;
    ways.push({
      tags: { highway: 'track', tracktype: 'grade4' },
      geometry: coordsToGeometry(coords),
    });
  }
  setCachedTerrain(bounds, ways);
  return ways;
}

/**
 * Railway ways (rail, tram, subway, light rail, ...).
 * @param {L.LatLngBounds} bounds
 * @returns {Promise<Array>} way elements
 */
async function fetchRailways(bounds) {
  const cached = getCachedRailways(bounds);
  if (cached) return cached;

  await waitForVectorData();
  const ways = [];
  for (const { props, coords } of queryLineFeatures('transportation')) {
    const railway = railwayTagFor(props);
    if (!railway) continue;
    ways.push({ tags: { railway }, geometry: coordsToGeometry(coords) });
  }
  setCachedRailways(bounds, ways);
  return ways;
}

/**
 * Navigable waterway ways (rivers, streams, canals, ...).
 * Used for kayaking/canoeing reachability analysis.
 * @param {L.LatLngBounds} bounds
 * @returns {Promise<Array>} way elements
 */
async function fetchWaterways(bounds) {
  const cached = getCachedWaterways(bounds);
  if (cached) return cached;

  await waitForVectorData();
  const allowed = new Set(['river', 'stream', 'canal', 'drain', 'ditch']);
  const ways = [];
  for (const { props, coords } of queryLineFeatures('waterway')) {
    if (!allowed.has(props.class)) continue;
    ways.push({ tags: { waterway: props.class }, geometry: coordsToGeometry(coords) });
  }
  setCachedWaterways(bounds, ways);
  return ways;
}

/**
 * Build the reachability/activity context used by the noise score.
 * @param {Array} landuse  polygons with class/minLat/maxLat/minLon/maxLon/geometry
 * @param {Array} pois     points with class/lat/lng
 * @returns {{landuse:Array, poiIndex:object, poiCount:number}|null}
 */
function buildBuiltUpContext(landuse, pois) {
  const usable = (pois || []).filter((p) => POI_NOISE_WEIGHTS[p.class] > 0);
  if (!landuse.length && !usable.length) return null;
  return { landuse, poiIndex: buildSpatialIndex(usable, POI_INDEX_CELL_DEG), poiCount: usable.length };
}

/** Uniform lat/lng bucket index for fast radius queries. */
function buildSpatialIndex(items, cellDeg) {
  const buckets = new Map();
  for (const it of items) {
    const k = `${Math.floor(it.lat / cellDeg)}:${Math.floor(it.lng / cellDeg)}`;
    let arr = buckets.get(k);
    if (!arr) { arr = []; buckets.set(k, arr); }
    arr.push(it);
  }
  return { cellDeg, buckets };
}

/** Items of the index within `radiusM` of (lat,lng). */
function nearbyItems(index, lat, lng, radiusM) {
  if (!index) return [];
  const dLat = radiusM / 111320;
  const cos = Math.cos((lat * Math.PI) / 180) || 1e-6;
  const dLng = radiusM / (111320 * cos);
  const c = index.cellDeg;
  const i0 = Math.floor((lat - dLat) / c), i1 = Math.floor((lat + dLat) / c);
  const j0 = Math.floor((lng - dLng) / c), j1 = Math.floor((lng + dLng) / c);
  const out = [];
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const arr = index.buckets.get(`${i}:${j}`);
      if (!arr) continue;
      for (const it of arr) {
        const d = haversineDistanceM(lat, lng, it.lat, it.lng);
        if (d <= radiusM) out.push({ item: it, dist: d });
      }
    }
  }
  return out;
}

/**
 * Activity penalty for living/shopping density at a point.
 *
 * This is what road distance alone cannot see: a residential quarter, a
 * shopping street or a mall is crowded even if no big road is close. Land-use
 * polygons give the area character (retail/commercial/residential), POI
 * density gives the number of shops, restaurants and offices nearby.
 *
 * @returns {number} additive penalty in noise-index units
 */
function builtUpPenaltyAt(lat, lng, builtUp) {
  if (!builtUp) return 0;
  let penalty = 0;

  /* Max (not sum) of overlapping land-use classes, so residential+suburb does
     not stack into something louder than a shopping street. */
  let luPenalty = 0;
  for (const lu of builtUp.landuse) {
    if (lat < lu.minLat || lat > lu.maxLat || lng < lu.minLon || lng > lu.maxLon) continue;
    const p = LANDUSE_NOISE_PENALTY[lu.class] || 0;
    if (p <= luPenalty) continue;
    if (pointInPolygon(lat, lng, lu.geometry)) luPenalty = p;
  }
  penalty += luPenalty;

  /* Weighted POI sum, linearly fading to zero at the radius. */
  let poiSum = 0;
  for (const { item, dist } of nearbyItems(builtUp.poiIndex, lat, lng, POI_NOISE_RADIUS_M)) {
    poiSum += (POI_NOISE_WEIGHTS[item.class] || 0) * (1 - dist / POI_NOISE_RADIUS_M);
  }
  penalty += poiSum * POI_NOISE_SCALE;

  return penalty;
}

/**
 * Capitalised land-use polygons (retail/commercial/residential/...) for the
 * given bounds. Not cached: the payload is small and the tile data is already
 * in memory.
 * @param {L.LatLngBounds} bounds
 */
async function fetchLanduse(bounds) {
  await waitForVectorData();
  const out = [];
  const seen = new Set();
  for (const { props, ring } of queryPolygonFeatures('landuse')) {
    const cls = props.class || '';
    if (!LANDUSE_NOISE_PENALTY[cls]) continue;
    const anchor = `${cls}|${ring[0].join(',')}`;
    if (seen.has(anchor)) continue;
    seen.add(anchor);
    const geometry = coordsToGeometry(ring);
    out.push({
      class: cls,
      geometry,
      minLat: Math.min(...geometry.map((p) => p.lat)),
      maxLat: Math.max(...geometry.map((p) => p.lat)),
      minLon: Math.min(...geometry.map((p) => p.lon)),
      maxLon: Math.max(...geometry.map((p) => p.lon)),
    });
  }
  return out;
}

/**
 * Activity POIs (shops, gastronomy, offices, ...) for the given bounds.
 * @param {L.LatLngBounds} bounds
 */
async function fetchPois(bounds) {
  await waitForVectorData();
  const out = [];
  const seen = new Set();
  for (const { props, lat, lng } of queryPointFeatures('poi')) {
    const cls = props.class || '';
    if (!POI_NOISE_WEIGHTS[cls]) continue;
    const key = `${cls}|${lat.toFixed(5)}|${lng.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ class: cls, lat, lng });
  }
  return out;
}

const GRID_SIZE = 50; /* points per axis - 50x50 = 2 500 sample points */
/** Minimum distance (m) to avoid division by zero and cap extreme noise near road centrelines. */
const MIN_DISTANCE_METERS  = 10;

/**
 * Coarse-data threshold. Below this zoom level the OpenFreeMap/OpenMapTiles
 * tiles only carry major road classes. The absolute noise index then only
 * measures the distance to motorways/trunk roads and is systematically worse
 * than an analysis at detail zoom, so it must not be compared across zooms.
 */
const COARSE_DATA_ZOOM = 12;

/**
 * Sub-cell refinement of the quiet candidates. A 50x50 grid can only place a
 * sample within half a cell of the true quietest point; when zoomed out that
 * cell is kilometres wide and inflates the best score. The most promising
 * cells are therefore re-sampled on a finer sub-grid.
 */
const REFINE_CELLS      = 12; /* seed cells re-sampled */
const REFINE_DIV        = 7;  /* sub-samples per axis (7x7 per cell) */
const REFINE_MIN_CELL_M = 60; /* refinement is pointless below this cell size */
/* Speed plausibility bounds for dynamicNoiseFactor().
 * Speeds below MIN_PLAUSIBLE_SPEED_KMH (e.g. a mapped "5" on a cycle path)
 * or above MAX_PLAUSIBLE_SPEED_KMH are clamped to prevent extreme factors
 * from distorting the heatmap due to data-entry errors or special cases. */
const MIN_PLAUSIBLE_SPEED_KMH = 5;   /* slowest meaningful motorised movement */
const MAX_PLAUSIBLE_SPEED_KMH = 200; /* no production vehicle legally exceeds this */

/* Bounds on the combined speed × lanes noise multiplier.
 * MIN_DYNAMIC_NOISE_FACTOR ensures even a very slow single-lane road
 * still contributes a small amount of noise.
 * MAX_DYNAMIC_NOISE_FACTOR prevents a single tagged outlier (e.g. a
 * 10-lane motorway) from completely dominating the heatmap. */
const MIN_DYNAMIC_NOISE_FACTOR = 0.25;
const MAX_DYNAMIC_NOISE_FACTOR = 4.0;

/**
 * Parse an OSM maxspeed tag value and return the speed in km/h.
 *
 * Handled formats:
 *   • Bare integer/decimal:        "50", "100", "13.5"
 *   • Value with mph unit:         "30 mph", "70mph"
 *   • Country-coded default:       "DE:rural", "GB:motorway", "AT:urban"  ← resolved via COUNTRY_MAXSPEEDS
 *   • Special words:               "none" / "unlimited" → 150 km/h
 *                                    (realistic 85th-percentile speed on limit-free roads such as
 *                                     German autobahns; higher than Germany's advisory 130 km/h)
 *                                   "walk"              →   5 km/h
 *                                   "signals"           →   0 (ignored; caller keeps road-type default)
 *
 * Returns 0 when the tag cannot be interpreted so callers fall back to DEFAULT_SPEEDS.
 *
 * @param {string|undefined} tag - Raw OSM maxspeed tag value
 * @returns {number} Speed in km/h, or 0 if unknown
 */
function parseMaxspeed(tag) {
  if (!tag) return 0;
  const s = String(tag).trim();
  const lower = s.toLowerCase();

  if (lower === 'none' || lower === 'unlimited') return 150; /* realistic speed on limit-free roads */
  if (lower === 'walk')    return 5;
  if (lower === 'signals') return 0;

  /* Country-coded value (e.g. "DE:rural", "GB:motorway") – try both case variants */
  if (COUNTRY_MAXSPEEDS[s]     !== undefined) return COUNTRY_MAXSPEEDS[s];
  if (COUNTRY_MAXSPEEDS[lower] !== undefined) return COUNTRY_MAXSPEEDS[lower];

  /* "30 mph" or "30mph" */
  const mphMatch = lower.match(/^(\d+(?:\.\d+)?)\s*mph$/);
  if (mphMatch) return Math.round(parseFloat(mphMatch[1]) * 1.60934);

  /* Bare numeric value (km/h) */
  const numMatch = s.match(/^(\d+(?:\.\d+)?)/);
  if (numMatch) return Math.round(parseFloat(numMatch[1]));

  return 0;
}

/**
 * Compute a dynamic noise-level multiplier for a road way based on its
 * OSM tags (maxspeed and lanes), relative to the road-type defaults.
 *
 * Speed model
 * ───────────
 * Traffic noise increases roughly as speed^0.5 for aggregate mixed traffic
 * (each doubling of speed adds ~3 dB(A)).  The factor is computed relative
 * to DEFAULT_SPEEDS[highway] so that an untagged road of this type produces
 * exactly 1.0.  Example: a primary road tagged maxspeed=120 (vs default 70)
 * yields √(120/70) ≈ 1.31 → 31 % louder than an untagged primary.
 *
 * Lanes model
 * ───────────
 * Each additional lane carries proportional traffic volume; noise grows as
 * √(lanes).  Factor is relative to DEFAULT_LANES[highway].  Example: a
 * motorway with 6 lanes (vs default 4) yields √(6/4) ≈ 1.22.
 *
 * The combined factor is clamped to [MIN_DYNAMIC_NOISE_FACTOR, MAX_DYNAMIC_NOISE_FACTOR]
 * to prevent extreme outliers (e.g. an implausibly tagged maxspeed=999 or a
 * data-entry error in the lanes tag) from distorting the heatmap.
 *
 * @param {string}      highway - OSM highway value
 * @param {object|null} tags    - Full OSM tag set for the way
 * @returns {number} Multiplicative noise factor (1.0 = no adjustment)
 */
function dynamicNoiseFactor(highway, tags) {
  let speedFactor = 1.0;
  let lanesFactor = 1.0;

  const defaultSpeed = DEFAULT_SPEEDS[highway] || 50;
  const speed = parseMaxspeed(tags && tags.maxspeed);
  if (speed > 0) {
    const clampedSpeed = Math.min(MAX_PLAUSIBLE_SPEED_KMH, Math.max(MIN_PLAUSIBLE_SPEED_KMH, speed));
    speedFactor = Math.sqrt(clampedSpeed / defaultSpeed);
  }

  const defaultLanes = DEFAULT_LANES[highway] || 2;
  const lanes = tags && tags.lanes ? parseInt(tags.lanes, 10) : 0;
  if (lanes >= 1) {
    lanesFactor = Math.sqrt(lanes / defaultLanes);
  }

  return Math.min(MAX_DYNAMIC_NOISE_FACTOR, Math.max(MIN_DYNAMIC_NOISE_FACTOR, speedFactor * lanesFactor));
}

/**
 * Compute a dynamic noise-level multiplier for a railway way based on its
 * OSM maxspeed tag, relative to the railway-type default speed.
 *
 * Railway noise scales with speed^0.5 (same physical model as roads).
 * High-speed trains (ICE/TGV at 300+ km/h) are substantially louder than
 * slow trams; the speed cap is raised to 350 km/h to accommodate them.
 * Track count (OSM "tracks" tag) is not factored in because it primarily
 * affects frequency rather than peak noise level.
 *
 * @param {string}      railway - OSM railway value
 * @param {object|null} tags    - Full OSM tag set for the way
 * @returns {number} Multiplicative noise factor (1.0 = no adjustment)
 */
function dynamicRailwayNoiseFactor(railway, tags) {
  const MAX_TRAIN_SPEED_KMH = 350; /* ICE/TGV/Shinkansen can reach 300+ km/h */
  const defaultSpeed = DEFAULT_RAILWAY_SPEEDS[railway] || 80;
  const speed = parseMaxspeed(tags && tags.maxspeed);
  if (speed <= 0) return 1.0;
  const clampedSpeed = Math.min(MAX_TRAIN_SPEED_KMH, Math.max(MIN_PLAUSIBLE_SPEED_KMH, speed));
  const factor = Math.sqrt(clampedSpeed / defaultSpeed);
  return Math.min(MAX_DYNAMIC_NOISE_FACTOR, Math.max(MIN_DYNAMIC_NOISE_FACTOR, factor));
}

/**
 * Noise score for a single point.
 *
 * noiseScore = max over all segments { weight * 1 000 / distance }
 *              (* vegetation dampening, + planned-trip penalty)
 *
 * The dominant source distance is returned as well, so the UI can explain
 * where a score comes from (a score of 6 means "the loudest source is X m
 * away", which is only comparable when the same road classes are loaded).
 *
 * @param {number} lat
 * @param {number} lng
 * @param {Array<{ax:number,ay:number,bx:number,by:number,weight:number}>} segments
 * @param {Array} vegetation  polygons with minLat/maxLat/minLon/maxLon/type/geometry
 * @param {Array<{south:number,north:number,west:number,east:number}>} plannedTrips
 * @param {number} mPerLat
 * @param {number} mPerLng
 * @param {object|null} [builtUp]  land-use + POI density context
 * @returns {{noiseScore:number, sourceM:number}} sourceM is Infinity when no segment exists
 */
function scoreNoiseAt(lat, lng, segments, vegetation, plannedTrips, mPerLat, mPerLng, builtUp = null) {
  const px = lng * mPerLng;
  const py = lat * mPerLat;
  let noiseScore = 0;
  let sourceM    = Infinity;

  for (const seg of segments) {
    const dist  = Math.max(MIN_DISTANCE_METERS, ptSegDist(px, py, seg.ax, seg.ay, seg.bx, seg.by));
    const noise = seg.weight * 1000 / dist;
    if (noise > noiseScore) {
      noiseScore = noise;
      sourceM    = dist;
    }
  }

  /* Apply vegetation dampening: points inside a vegetation polygon
     receive a noise reduction proportional to the vegetation density.
     The maximum dampening factor across all overlapping polygons is used. */
  if (vegetation.length && noiseScore > 0) {
    let maxDamp = 0;
    for (const vp of vegetation) {
      if (lat < vp.minLat || lat > vp.maxLat || lng < vp.minLon || lng > vp.maxLon) continue;
      if (pointInPolygon(lat, lng, vp.geometry)) {
        const d = VEGETATION_DAMPENING[vp.type] || 0;
        if (d > maxDamp) maxDamp = d;
      }
    }
    if (maxDamp > 0) noiseScore *= (1 - maxDamp);
  }

  /* Add a penalty for each planned trip whose bbox covers this point.
     This reduces the effective silence score of areas that are already
     planned by other users. */
  let tripCount = 0;
  for (const t of plannedTrips) {
    if (lat >= t.south && lat <= t.north && lng >= t.west && lng <= t.east) tripCount++;
  }
  noiseScore += tripCount * TRIP_NOISE_PENALTY;

  /* Crowd/built-up penalty: land-use character + nearby POI density. */
  noiseScore += builtUpPenaltyAt(lat, lng, builtUp);

  return { noiseScore, sourceM };
}

function computeHeatmap(ways, bounds, plannedTrips = [], vegetation = [], railways = [], waterwayWays = [], reachTerrainWays = [], builtUp = null) {
  const latMin = bounds.getSouth();
  const latMax = bounds.getNorth();
  const lngMin = bounds.getWest();
  const lngMax = bounds.getEast();
  const latStep = (latMax - latMin) / GRID_SIZE;
  const lngStep = (lngMax - lngMin) / GRID_SIZE;

  /* Convert degrees to metres using a flat-earth approximation centred on the view */
  const midLat  = (latMin + latMax) / 2;
  const mPerLat = 111_320;
  const mPerLng = 111_320 * Math.cos(midLat * Math.PI / 180);

  /* Build array of road segments in metre-space */
  const segments = [];
  for (const way of ways) {
    const highway   = way.tags && way.tags.highway;
    const baseWeight = roadWeights[highway] !== undefined
                        ? roadWeights[highway]
                        : DEFAULT_ROAD_WEIGHTS[highway] ?? 0;
    if (baseWeight <= 0) continue;
    /* Apply per-way dynamic factor: adjusts for actual maxspeed tag and
       lane count so that, e.g., a 6-lane autobahn at 130 km/h scores
       higher than an untagged 2-lane motorway at the default 110 km/h. */
    const weight = baseWeight * dynamicNoiseFactor(highway, way.tags);
    const geom = way.geometry;
    if (!geom || geom.length < 2) continue;
    for (let i = 0; i < geom.length - 1; i++) {
      segments.push({
        ax: geom[i].lon   * mPerLng,
        ay: geom[i].lat   * mPerLat,
        bx: geom[i + 1].lon * mPerLng,
        by: geom[i + 1].lat * mPerLat,
        weight,
      });
    }
  }

  /* Build railway segments and add them to the shared segments array */
  for (const way of railways) {
    const railway = way.tags && way.tags.railway;
    const baseWeight = railwayWeights[railway] !== undefined
                        ? railwayWeights[railway]
                        : DEFAULT_RAILWAY_WEIGHTS[railway] ?? 0;
    if (baseWeight <= 0) continue;
    /* Adjust for actual train speed tagged on the way */
    const weight = baseWeight * dynamicRailwayNoiseFactor(railway, way.tags);
    const geom = way.geometry;
    if (!geom || geom.length < 2) continue;
    for (let i = 0; i < geom.length - 1; i++) {
      segments.push({
        ax: geom[i].lon   * mPerLng,
        ay: geom[i].lat   * mPerLat,
        bx: geom[i + 1].lon * mPerLng,
        by: geom[i + 1].lat * mPerLat,
        weight,
      });
    }
  }

  /* Save context so computeNoiseAtPoint() can score arbitrary clicks */
  lastNoiseCtx = { segments, mPerLat, mPerLng, vegetation, plannedTrips, builtUp };

  if (!segments.length) {
    return { heatPoints: [], quietestPoints: [], unreachablePoints: [] };
  }

  /* ── What the filter actually consists of ───────────────────────── *
   * The route rule needs detailed tiles, so it is paused below         *
   * MIN_REACH_ZOOM. The travel-time radius is plain geometry and keeps  *
   * working at every zoom level - as long as a transport mode defines   *
   * the speed.                                                          *
   * ──────────────────────────────────────────────────────────────────── */
  const routeRuleActive = selectedTransportModes.size > 0 && map.getZoom() >= MIN_REACH_ZOOM;
  const timeFilterActive = reachTimeBudgetMin > 0 && selectedTransportModes.size > 0;
  const filterByReachability = routeRuleActive || timeFilterActive;
  const reachSegments = [];

  if (routeRuleActive) {
    const accessibleHighways = new Set();
    let includeTerrainPaths = false;
    let includeWaterways    = false;

    for (const modeId of selectedTransportModes) {
      const mode = TRANSPORT_MODES.find(m => m.id === modeId);
      if (!mode) continue;
      mode.accessibleHighways.forEach(h => accessibleHighways.add(h));
      if (mode.includeTerrainPaths) includeTerrainPaths = true;
      if (mode.needsWaterways)      includeWaterways    = true;
    }

    let reachWaySeq = 0;

    /* Road segments accessible by the selected modes */
    for (const way of ways) {
      const w = ++reachWaySeq;
      const highway = way.tags && way.tags.highway;
      if (!highway || !accessibleHighways.has(highway)) continue;
      const geom = way.geometry;
      if (!geom || geom.length < 2) continue;
      for (let i = 0; i < geom.length - 1; i++) {
        reachSegments.push({
          ax: geom[i].lon   * mPerLng,
          ay: geom[i].lat   * mPerLat,
          bx: geom[i+1].lon * mPerLng,
          by: geom[i+1].lat * mPerLat,
          w, k: i, aLat: geom[i].lat, aLng: geom[i].lon,
          bLat: geom[i+1].lat, bLng: geom[i+1].lon,
          tags: way.tags || {},
        });
      }
    }

    /* Terrain paths for climbing / mountaineering */
    if (includeTerrainPaths) {
      for (const way of reachTerrainWays) {
        const w = ++reachWaySeq;
        const geom = way.geometry;
        if (!geom || geom.length < 2) continue;
        for (let i = 0; i < geom.length - 1; i++) {
          reachSegments.push({
            ax: geom[i].lon   * mPerLng,
            ay: geom[i].lat   * mPerLat,
            bx: geom[i+1].lon * mPerLng,
            by: geom[i+1].lat * mPerLat,
            w, k: i, aLat: geom[i].lat, aLng: geom[i].lon,
            bLat: geom[i+1].lat, bLng: geom[i+1].lon,
            tags: Object.assign({ highway: 'path' }, way.tags || {}),
          });
        }
      }
    }

    /* Waterways for kayaking / canoeing */
    if (includeWaterways) {
      for (const way of waterwayWays) {
        const w = ++reachWaySeq;
        const geom = way.geometry;
        if (!geom || geom.length < 2) continue;
        for (let i = 0; i < geom.length - 1; i++) {
          reachSegments.push({
            ax: geom[i].lon   * mPerLng,
            ay: geom[i].lat   * mPerLat,
            bx: geom[i+1].lon * mPerLng,
            by: geom[i+1].lat * mPerLat,
            w, k: i, aLat: geom[i].lat, aLng: geom[i].lon,
            bLat: geom[i+1].lat, bLng: geom[i+1].lon,
            tags: way.tags || {},
          });
      }
    }
  }
  }

  /* Reachability context: applies the 200 m route rule and the optional
   * travel-time radius. It also carries a coarse segment index, which keeps the
   * per-point check cheap (an unindexed loop was O(grid points x segments)).
   * `lastReachCtx` is only set when a time budget is active, because only then
   * a reachable/not-reachable verdict makes sense in the click popup. */
  const reachOrigin = getReachOrigin();
  const reachCtx = filterByReachability
    ? buildReachContext(bounds, reachSegments, selectedTransportModes, reachOrigin,
                        reachTimeBudgetMin, routeRuleActive)
    : null;
  lastReachCtx = (reachCtx && timeFilterActive) ? reachCtx : null;

  /* Snapshot of what this analysis actually considered (for the honest
   * summary and the "settings changed" check). */
  const radii = timeFilterActive ? reachRadiiM() : [];
  const radiusM = radii.length ? Math.max(...radii) : 0;
  lastAnalysisInfo = {
    modes: [...selectedTransportModes],
    budgetMin: timeFilterActive ? reachTimeBudgetMin : 0,
    routeRuleActive,
    originLabel: reachOrigin.label,
    radiusM,
    radiusEffective: radiusM > 0,
    expanded: false,
    bounds: {
      south: bounds.getSouth(), west: bounds.getWest(),
      north: bounds.getNorth(), east: bounds.getEast(),
    },
  };

  /* Score every grid point */
  const gridScores      = [];
  const unreachablePoints = [];
  let maxNoise = 0;

  for (let i = 0; i <= GRID_SIZE; i++) {
    for (let j = 0; j <= GRID_SIZE; j++) {
      const lat = latMin + i * latStep;
      const lng = lngMin + j * lngStep;

      /* ── Reachability check ─────────────────────────────────────── *
       * Skip (grey out) this point if the nearest accessible route is  *
       * further than REACHABILITY_DISTANCE_M metres away.              *
       * ──────────────────────────────────────────────────────────────── */
      if (filterByReachability && !reachContextAllows(reachCtx, lat, lng)) {
        unreachablePoints.push({ lat, lng });
        continue;
      }

      const { noiseScore, sourceM } = scoreNoiseAt(
        lat, lng, segments, vegetation, plannedTrips, mPerLat, mPerLng, builtUp,
      );
      if (noiseScore > maxNoise) maxNoise = noiseScore;
      gridScores.push({ lat, lng, noiseScore, sourceM });
    }
  }

  /* ── Sub-cell refinement of the quietest candidates ───────────────── *
   * A node of the 50x50 grid can be up to half a cell away from the     *
   * real quietest point. Zoomed out a cell is kilometres wide, so the   *
   * coarse grid alone reports a much worse "best" score than a detailed *
   * analysis. Re-sample the most promising cells on a finer sub-grid.   *
   * ──────────────────────────────────────────────────────────────────── */
  const cellM = Math.max(latStep * mPerLat, lngStep * mPerLng);
  const refined = [];
  if (gridScores.length && cellM > REFINE_MIN_CELL_M) {
    const seeds = [...gridScores]
      .sort((a, b) => a.noiseScore - b.noiseScore)
      .slice(0, REFINE_CELLS);
    for (const seed of seeds) {
      for (let a = 0; a < REFINE_DIV; a++) {
        for (let b = 0; b < REFINE_DIV; b++) {
          /* Offsets span -0.5 .. +0.5 cell around the seed node. */
          const lat = seed.lat + ((a / (REFINE_DIV - 1)) - 0.5) * latStep;
          const lng = seed.lng + ((b / (REFINE_DIV - 1)) - 0.5) * lngStep;
          if (lat < latMin || lat > latMax || lng < lngMin || lng > lngMax) continue;
          if (filterByReachability && !reachContextAllows(reachCtx, lat, lng)) continue;
          const { noiseScore, sourceM } = scoreNoiseAt(
            lat, lng, segments, vegetation, plannedTrips, mPerLat, mPerLng, builtUp,
          );
          refined.push({ lat, lng, noiseScore, sourceM });
        }
      }
    }
  }

  /* Normalise 0-1 for Leaflet.heat (grid nodes only - refinement would only
   * sharpen the peak and is irrelevant for the colour ramp). */
  const heatPoints = gridScores.map(({ lat, lng, noiseScore }) => [
    lat, lng, maxNoise > 0 ? noiseScore / maxNoise : 0,
  ]);

  /* Top 5 quietest points (lowest noise score, reachable only). Refined
   * points are spread out so the list does not fill up with five samples of
   * the same tiny spot. */
  const minSepM = Math.max(80, Math.min(cellM, 1000) * 0.5);
  const sorted = gridScores.concat(refined).sort((a, b) => a.noiseScore - b.noiseScore);
  const quietestPoints = [];
  for (const p of sorted) {
    if (quietestPoints.length >= 5) break;
    const tooClose = quietestPoints.some(q =>
      haversineDistanceM(p.lat, p.lng, q.lat, q.lng) < minSepM);
    if (!tooClose) quietestPoints.push(p);
  }

  const coarseData = map.getZoom() < COARSE_DATA_ZOOM;

  return { heatPoints, quietestPoints, maxNoise, unreachablePoints, coarseData };
}

/**
 * Compute the noise score at a single lat/lng using the segments cached
 * by the last computeHeatmap() run.  Returns null if no analysis has
 * been run yet (so the caller can display "n/a").
 * @param {number} lat
 * @param {number} lng
 * @returns {number|null}
 */
function computeNoiseAtPoint(lat, lng) {
  if (!lastNoiseCtx) return null;
  const { segments, mPerLat, mPerLng, vegetation, plannedTrips, builtUp } = lastNoiseCtx;
  if (!segments.length) return 0;
  return scoreNoiseAt(lat, lng, segments, vegetation, plannedTrips, mPerLat, mPerLng, builtUp).noiseScore;
}

/**
 * Short human-readable distance, e.g. "45 m", "1.4 km".
 * @param {number} m
 * @returns {string}
 */
function formatDistanceM(m) {
  if (!Number.isFinite(m)) return 'n/a';
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 5) * 5} m`;
}

/**
 * Straight-line (Haversine) distance in metres between two coordinates.
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number} Distance in metres
 */
function haversineDistanceM(lat1, lng1, lat2, lng2) {
  const R  = 6_371_000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a  = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Shortest distance from point (px, py) to segment (ax,ay)–(bx,by).
 * All coordinates in the same unit (metres).
 */
function ptSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    return Math.hypot(px - ax, py - ay);
  }
  const t  = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * Ray-casting point-in-polygon test.
 * @param {number} lat - Point latitude
 * @param {number} lng - Point longitude
 * @param {Array<{lat:number,lon:number}>} polygon - Polygon vertices from Overpass geometry
 * @returns {boolean}
 */
function pointInPolygon(lat, lng, polygon) {
  let inside = false;
  const n = polygon.length;
  let j = n - 1;
  for (let i = 0; i < n; i++) {
    const xi = polygon[i].lon, yi = polygon[i].lat;
    const xj = polygon[j].lon, yj = polygon[j].lat;
    if (((yi > lat) !== (yj > lat)) &&
        (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
    j = i;
  }
  return inside;
}

/* ── Heatmap rendering ───────────────────────────────────────────── */

/* Gradient: cool (quiet) → hot (noisy) */
const HEAT_GRADIENT = {
  0.0: '#60a5fa', /* blue  – very quiet */
  0.3: '#34d399', /* green */
  0.5: '#facc15', /* yellow */
  0.7: '#fb923c', /* orange */
  1.0: '#f87171', /* red   – very noisy */
};

function renderHeatmap(heatPoints) {
  if (heatLayer) {
    map.removeLayer(heatLayer);
    heatLayer = null;
  }
  heatLayer = L.heatLayer(heatPoints, {
    radius:   25,
    blur:     parseInt(blurSlider.value, 10),
    maxZoom:  map.getZoom(),
    opacity:  parseFloat(opacitySlider.value),
    gradient: HEAT_GRADIENT,
  }).addTo(map);
}

/* ── Results panel ───────────────────────────────────────────────── */

/** Sequential id for per-run dashed outlines. */
let quietHistorySeq = 0;
/** Dashed outline of the current run (hidden until hover). */
let currentGenRect = null;

/** Marker opacity per generation: current = 1, older runs get fainter. */
function generationOpacity(depth) {
  return depth === 0 ? 1 : (depth === 1 ? 0.55 : 0.32);
}

/**
 * Build a hidden, dashed outline for the analysed bounding box of one run.
 * It is only shown while the pointer hovers one of that run's markers.
 * @param {{south:number, west:number, north:number, east:number}} b
 */
function makeGenerationRect(b) {
  const srcId = `qgen-${++quietHistorySeq}`;
  const layId = `${srcId}-line`;
  let removed = false;
  const ring = [
    [b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south],
  ];

  whenStyleReady(() => {
    if (removed || map.getSource(srcId)) return;
    map.addSource(srcId, {
      type: 'geojson',
      data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } },
    });
    map.addLayer({
      id: layId,
      type: 'line',
      source: srcId,
      layout: { visibility: 'none' },
      paint: { 'line-color': '#7dd3fc', 'line-width': 1.5, 'line-dasharray': [3, 3], 'line-opacity': 0.9 },
    });
  });

  return {
    show() {
      whenStyleReady(() => { if (map.getLayer(layId)) map.setLayoutProperty(layId, 'visibility', 'visible'); });
    },
    hide() {
      try { if (map.getLayer(layId)) map.setLayoutProperty(layId, 'visibility', 'none'); } catch { /* style gone */ }
    },
    setOpacity(op) {
      try { if (map.getLayer(layId)) map.setPaintProperty(layId, 'line-opacity', op); } catch { /* style gone */ }
    },
    remove() {
      removed = true;
      try { if (map.getLayer(layId)) map.removeLayer(layId); } catch { /* ignore */ }
      try { if (map.getSource(srcId)) map.removeSource(srcId); } catch { /* ignore */ }
    },
  };
}

/** Apply the faded look (and a tooltip) to markers of one generation. */
function fadeMarkers(markers, depth) {
  const op = generationOpacity(depth);
  markers.forEach((m) => {
    const el = m._ml && m._ml.getElement ? m._ml.getElement() : null;
    if (!el) return;
    el.dataset.baseOpacity = String(op);
    setMarkerOpacity(m, op);
    el.title = depth > 0
      ? `Result of an earlier analysis - hover to see the analysed area it came from`
      : '';
  });
}

/**
 * MapLibre keeps its own opacity value and re-applies it on every pan/zoom,
 * so marker opacity must go through Marker#setOpacity() - writing
 * element.style.opacity directly gets overwritten on the next map update.
 * @param {object} marker  Leaflet-style marker api from makeMarker()
 * @param {number} op
 */
function setMarkerOpacity(marker, op) {
  if (marker._ml && typeof marker._ml.setOpacity === 'function') {
    marker._ml.setOpacity(op);
    return;
  }
  const el = marker._ml && marker._ml.getElement ? marker._ml.getElement() : null;
  if (el) el.style.opacity = String(op);
}

/** Show the run's dashed area while one of its markers is hovered. */
function bindGenerationHover(markers, rect) {
  if (!rect) return;
  markers.forEach((m) => {
    const el = m._ml && m._ml.getElement ? m._ml.getElement() : null;
    if (!el) return;
    el.addEventListener('mouseenter', () => {
      rect.show();
      const base = parseFloat(el.dataset.baseOpacity || '1');
      if (base < 1) setMarkerOpacity(m, 1);
    });
    el.addEventListener('mouseleave', () => {
      rect.hide();
      setMarkerOpacity(m, parseFloat(el.dataset.baseOpacity || '1'));
    });
  });
}

/** Keep at most QUIET_HISTORY_MAX earlier runs on the map. */
function pruneQuietHistory() {
  while (quietHistory.length > QUIET_HISTORY_MAX) {
    const old = quietHistory.pop();
    old.markers.forEach((m) => map.removeLayer(m));
    if (old.rect) old.rect.remove();
  }
}

function updateHistoryHint() {
  if (!resultsHistoryHint) return;
  if (!quietHistory.length) {
    resultsHistoryHint.classList.add('hidden');
    resultsHistoryHint.textContent = '';
    return;
  }
  const n = quietHistory.length;
  resultsHistoryHint.classList.remove('hidden');
  resultsHistoryHint.textContent =
    `${n} earlier run${n > 1 ? 's' : ''} shown faded - hover a marker to see the area it came from.`;
}

/**
 * Remove the quiet-spot markers (current run and faded history) without
 * touching the heatmap or the other overlays.
 */
function clearQuietSpots() {
  quietMarkers.forEach((m) => map.removeLayer(m));
  quietMarkers = [];
  quietHistory.forEach((e) => {
    e.markers.forEach((m) => map.removeLayer(m));
    if (e.rect) e.rect.remove();
  });
  quietHistory = [];
  if (currentGenRect) { currentGenRect.remove(); currentGenRect = null; }
  updateHistoryHint();
}

/**
 * Render the top quiet spots and demote the previous run(s) to faded history.
 * In outing mode the previous run is removed instead (one spot at a time).
 * @param {Array<{lat:number,lng:number,noiseScore:number,sourceM:number}>} points
 * @param {L.LatLngBounds} [bounds]  analysed view of this run
 * @param {boolean} [coarseData]     true when only major roads were available
 */
function renderResults(points, bounds, coarseData = false) {
  if (outingModeActive) {
    /* Exclusive view: a new outing run replaces the old spots entirely. */
    clearQuietSpots();
  } else if (quietMarkers.length && lastAnalysisBounds) {
    /* Demote the current markers to history and fade them one step. */
    const entry = { markers: quietMarkers, rect: makeGenerationRect(lastAnalysisBounds) };
    quietHistory.unshift(entry);
    quietMarkers = [];
    pruneQuietHistory();
    bindGenerationHover(entry.markers, entry.rect);
  }
  quietHistory.forEach((e, i) => {
    fadeMarkers(e.markers, i + 1);
    e.rect.setOpacity(generationOpacity(i + 1));
  });

  if (bounds) {
    lastAnalysisBounds = {
      south: bounds.getSouth(), west: bounds.getWest(),
      north: bounds.getNorth(), east: bounds.getEast(),
    };
  }

  quietMarkers = [];
  resultsList.innerHTML = '';

  if (resultsTitle) {
    resultsTitle.textContent = coarseData
      ? '🏆 Quietest Spots (coarse data)'
      : '🏆 Quietest Spots';
  }

  if (!points.length) {
    updateHistoryHint();
    if (!quietHistory.length) {
      resultsCard.classList.add('hidden');
      return;
    }
    resultsCard.classList.remove('hidden');
    const empty = document.createElement('li');
    empty.className = 'result-empty-hint';
    empty.textContent = 'No quiet spots in this view - earlier results are shown faded on the map.';
    resultsList.appendChild(empty);
    return;
  }

  resultsCard.classList.remove('hidden');

  if (coarseData) {
    const hint = document.createElement('li');
    hint.className = 'result-coarse-hint';
    hint.textContent =
      'Coarse map data at this zoom level: the tiles only contain motorways and ' +
      'major roads. The noise index therefore only measures the distance to those ' +
      'roads and cannot be compared with a detailed analysis. Zoom in to level ' +
      `${COARSE_DATA_ZOOM}+ for a meaningful ranking.`;
    resultsList.appendChild(hint);
  }

  const scorePrefix = coarseData ? '~' : '';
  points.forEach((p, idx) => {
    /* Map marker */
    const rank = idx + 1;
    const icon = L.divIcon({
      className:   '',
      html:        `<div class="quiet-marker">${rank}</div>`,
      iconSize:    [28, 28],
      iconAnchor:  [14, 14],
      popupAnchor: [0, -16],
    });

    const label = `Quiet spot #${rank}`;
    const sourceNote = Number.isFinite(p.sourceM)
      ? ` (loudest source ${formatDistanceM(p.sourceM)} away)`
      : '';
    const marker = L.marker([p.lat, p.lng], { icon })
      .bindPopup(
        `<div class="map-click-popup">` +
        `<b>${label}</b><br>` +
        `<span class="mcp-coords">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</span><br>` +
        `🔊 Noise index: <b>${scorePrefix}${p.noiseScore.toFixed(2)}</b>${sourceNote}<br>` +
        `<button class="popup-nav-btn">🧭 Navigate here</button>` +
        `</div>`,
        { maxWidth: 240 }
      )
      .addTo(map);

    bindPopupNavBtn(marker, p.lat, p.lng, label);
    quietMarkers.push(marker);

    /* Sidebar result item */
    const li = document.createElement('li');
    li.className = 'result-item';
    li.innerHTML =
      `<span class="ri-rank">#${rank}</span>` +
      `<span class="ri-score">Noise index: ${scorePrefix}${p.noiseScore.toFixed(2)}` +
      (Number.isFinite(p.sourceM) ? ` · nearest source ${formatDistanceM(p.sourceM)}` : '') +
      `</span>` +
      `<span class="ri-coords">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</span>`;
    li.addEventListener('click', () => {
      map.setView([p.lat, p.lng], Math.max(map.getZoom(), 13));
      marker.openPopup();
    });

    /* Navigate button inside the result item */
    const navBtn = document.createElement('button');
    navBtn.className = 'ri-nav-btn';
    navBtn.textContent = '🧭 Navigate';
    navBtn.title = `Calculate route to ${label}`;
    navBtn.addEventListener('click', e => {
      e.stopPropagation(); /* don't also trigger the li click */
      navigateToCoords(p.lat, p.lng, label);
      document.getElementById('navCard')?.scrollIntoView({ behavior: 'smooth' });
    });
    li.appendChild(navBtn);

    resultsList.appendChild(li);
  });

  /* Dashed area of the current run, shown on marker hover. */
  fadeMarkers(quietMarkers, 0);
  if (currentGenRect) { currentGenRect.remove(); currentGenRect = null; }
  if (lastAnalysisBounds) {
    currentGenRect = makeGenerationRect(lastAnalysisBounds);
    bindGenerationHover(quietMarkers, currentGenRect);
  }

  updateHistoryHint();
}

/** Remove every analysis result: heatmap, quiet spots, history, overlays. */
function clearResults() {
  if (activePopup) { try { activePopup.remove(); } catch { /* ignore */ } activePopup = null; }

  quietMarkers.forEach((m) => map.removeLayer(m));
  quietMarkers = [];
  quietHistory.forEach((e) => {
    e.markers.forEach((m) => map.removeLayer(m));
    if (e.rect) e.rect.remove();
  });
  quietHistory = [];
  if (currentGenRect) { currentGenRect.remove(); currentGenRect = null; }

  if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
  if (unreachableOverlay) { map.removeLayer(unreachableOverlay); unreachableOverlay = null; }
  if (reachRadiusOverlay) { map.removeLayer(reachRadiusOverlay); reachRadiusOverlay = null; }
  if (vegetationLayer) { map.removeLayer(vegetationLayer); vegetationLayer = null; }
  if (terrainLayer) { map.removeLayer(terrainLayer); terrainLayer = null; }
  tripRects.forEach((r) => map.removeLayer(r));
  tripRects = [];
  if (mapClickMarker) { map.removeLayer(mapClickMarker); mapClickMarker = null; }

  lastAnalysisBounds = null;
  lastReachCtx = null;
  lastAnalysisInfo = null;
  lastQuietestPoints = [];
  outingModeActive = false;
  outingOrigin = null;
  resultsList.innerHTML = '';
  resultsCard.classList.add('hidden');
  terrainLegendEl.classList.add('hidden');
  const statusEl = document.getElementById('status');
  if (statusEl) statusEl.classList.add('hidden');
  updateFilterSummary();
  /* No results on screen - the filter summary would be misleading. */
  const filterEl = document.getElementById('filterSummary');
  if (filterEl) { filterEl.classList.add('hidden'); filterEl.textContent = ''; }
  updateHistoryHint();
}

/* ── Trip rect rendering ─────────────────────────────────────────── */

/**
 * Draw semi-transparent rectangles on the map for each planned trip area,
 * so users can see which regions are already targeted by others.
 * @param {Array<{south:number,west:number,north:number,east:number,id:string}>} trips
 */
function renderTripRects(trips) {
  tripRects.forEach(r => map.removeLayer(r));
  tripRects = [];
  if (!trips.length) return;

  const features = trips.map(t => ({
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [t.west, t.south], [t.east, t.south],
        [t.east, t.north], [t.west, t.north], [t.west, t.south],
      ]],
    },
  }));

  tripRects.push(makeGeoOverlay(features, [{
    id: 'trips',
    type: 'fill',
    paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.12 },
  }, {
    id: 'trips-line',
    type: 'line',
    paint: { 'line-color': '#f59e0b', 'line-width': 1.5, 'line-dasharray': [4, 4] },
  }], { tooltip: 'Planned trip area - silence score adjusted' }).addTo(map));
}

function renderVegetationLayer(polys) {
  if (vegetationLayer) { map.removeLayer(vegetationLayer); vegetationLayer = null; }
  if (!polys.length) return;

  const features = polys.map(vp => {
    const ring = vp.geometry.map(p => [p.lon, p.lat]);
    ring.push([vp.geometry[0].lon, vp.geometry[0].lat]);
    return {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [ring] },
    };
  });

  vegetationLayer = makeGeoOverlay(features, [{
    id: 'veg',
    type: 'fill',
    paint: { 'fill-color': '#4ade80', 'fill-opacity': 0.08 },
  }, {
    id: 'veg-line',
    type: 'line',
    paint: { 'line-color': '#4ade80', 'line-width': 0.6, 'line-opacity': 0.25 },
  }], { tooltip: 'Vegetation - noise dampening applied' }).addTo(map);
}

function renderTerrainLayer(ways) {
  if (terrainLayer) { map.removeLayer(terrainLayer); terrainLayer = null; }
  if (!ways.length) return;

  const features = ways.map(way => ({
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'LineString',
      coordinates: way.geometry.map(p => [p.lon, p.lat]),
    },
  }));

  terrainLayer = makeGeoOverlay(features, [{
    id: 'terrain',
    type: 'line',
    paint: {
      'line-color': TERRAIN_COLORS.rough_track,
      'line-width': 2.5,
      'line-opacity': 0.85,
    },
  }], { tooltip: 'Rough track - limited accessibility' }).addTo(map);
}

function renderUnreachableOverlay(unreachablePoints, bounds) {
  if (unreachableOverlay) {
    map.removeLayer(unreachableOverlay);
    unreachableOverlay = null;
  }
  if (!unreachablePoints || !unreachablePoints.length) return;

  const latMin = bounds.getSouth();
  const latMax = bounds.getNorth();
  const lngMin = bounds.getWest();
  const lngMax = bounds.getEast();

  /* Half a grid cell in degrees - cells touch, so they render as one area. */
  const halfLat = (latMax - latMin) / GRID_SIZE / 2;
  const halfLng = (lngMax - lngMin) / GRID_SIZE / 2;

  /* GeoJSON cells instead of a bitmap overlay: MapLibre's canvas source
   * ignores the alpha channel (renders black) and image sources need the
   * image API, which is fragile across style reloads. */
  const features = unreachablePoints.map(({ lat, lng }) => ({
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [lng - halfLng, lat - halfLat],
        [lng + halfLng, lat - halfLat],
        [lng + halfLng, lat + halfLat],
        [lng - halfLng, lat + halfLat],
        [lng - halfLng, lat - halfLat],
      ]],
    },
  }));

  unreachableOverlay = makeGeoOverlay(features, [{
    id: 'unreachable',
    type: 'fill',
    paint: {
      'fill-color': '#505050',
      'fill-opacity': 0.6,
      'fill-antialias': false,
    },
  }]).addTo(map);
}
/**
 * Draw the straight-line travel-time radius per selected mode as a dashed
 * circle plus the origin marker, so the applied time/radius filter is visible
 * on the map instead of only affecting the grey mask. The colour encodes the
 * state: orange = the radius actually cuts the view, grey = it does not.
 * @param {object|null} ctx  Reachability context of the last analysis.
 */
function renderReachRadius(ctx) {
  if (reachRadiusOverlay) {
    map.removeLayer(reachRadiusOverlay);
    reachRadiusOverlay = null;
  }
  if (!ctx || !ctx.perMode || !ctx.perMode.length) return;

  const features = [];
  const seenRadii = new Set();
  for (const entry of ctx.perMode) {
    if (!Number.isFinite(entry.radiusM)) continue;
    const key = Math.round(entry.radiusM);
    if (seenRadii.has(key)) continue;
    seenRadii.add(key);
    features.push({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [circlePolygon(ctx.origin.lat, ctx.origin.lng, entry.radiusM, 96)],
      },
    });
  }
  if (!features.length) return;

  features.push({
    type: 'Feature',
    properties: {},
    geometry: { type: 'Point', coordinates: [ctx.origin.lng, ctx.origin.lat] },
  });

  const st = getTimeFilterState();
  const color = '#f59e0b';

  reachRadiusOverlay = makeGeoOverlay(features, [{
    id: 'radius-line',
    type: 'line',
    paint: {
      'line-color': color,
      'line-width': 1.5,
      'line-opacity': 0.85,
      'line-dasharray': [3, 2],
    },
  }, {
    id: 'radius-origin',
    type: 'circle',
    paint: {
      'circle-radius': 4,
      'circle-color': color,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1.5,
    },
  }], {
    tooltip: st.coversView
      ? 'Travel-time radius - larger than this view; the analysis covers the full radius'
      : 'Travel-time radius - areas outside are greyed out',
  }).addTo(map);
}

function showStatus(msg, type = 'info') {
  statusEl.textContent = msg;
  statusEl.className = `status ${type}`;
  statusEl.classList.remove('hidden');
}

function showTripStatus(msg, type = 'info') {
  tripStatusEl.textContent = msg;
  tripStatusEl.className = `status ${type}`;
  tripStatusEl.classList.remove('hidden');
}

/**
 * Record an error to the in-memory error log and update the error log card.
 * @param {string} source   Short label identifying the failing operation (e.g. 'Overpass').
 * @param {string} message  Human-readable error description.
 * @param {number|undefined} status  HTTP status code, if applicable.
 */
function logError(source, message, status) {
  errorLog.push({ ts: Date.now(), source, message, status });
  renderErrorLog();
}

/**
 * Refresh the error log card to reflect the current contents of `errorLog`.
 * Shows the card when there are entries and hides it when the log is cleared.
 */
function renderErrorLog() {
  if (!errorLogCard) return;
  if (errorLog.length === 0) {
    errorLogCard.classList.add('hidden');
    return;
  }
  errorLogCard.classList.remove('hidden');
  if (errorLogBadge) errorLogBadge.textContent = errorLog.length;

  if (!errorLogList) return;
  errorLogList.innerHTML = '';
  /* Show newest entries first */
  for (let i = errorLog.length - 1; i >= 0; i--) {
    const { ts, source, message, status } = errorLog[i];
    const li  = document.createElement('li');
    li.className = 'error-log-entry';
    const time = document.createElement('span');
    time.className = 'error-log-time';
    time.textContent = new Date(ts).toLocaleTimeString();
    const tag = document.createElement('span');
    tag.className = 'error-log-source';
    tag.textContent = status ? `${source} ${status}` : source;
    const msg = document.createElement('span');
    msg.className = 'error-log-msg';
    msg.textContent = message;
    li.append(time, tag, msg);
    errorLogList.appendChild(li);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ── Error log event listeners ───────────────────────────────────── */
if (errorLogToggle && errorLogBody) {
  errorLogToggle.addEventListener('click', () => {
    const collapsed = errorLogBody.classList.toggle('hidden');
    errorLogToggle.textContent = collapsed ? '▶' : '▼';
  });
}
if (errorLogClearBtn) {
  errorLogClearBtn.addEventListener('click', () => {
    errorLog.length = 0;
    renderErrorLog();
  });
}

/* ── Start screen: two ways into the app ───────────────────────────
 * On launch the user only chooses between "Get me out of here" (pick a
 * time + travel mode, then navigate straight to the quietest reachable
 * spot) and the normal full app. */
const START_MODE_TO_TRANSPORT = { foot: 'foot', cycling: 'bike', driving: 'car' };
let startMinutes = 15;
let startProfile = 'foot';

function openStartScreen() {
  const el = document.getElementById('startScreen');
  if (!el) return;
  el.classList.remove('hidden');
  document.getElementById('startChoices')?.classList.remove('hidden');
  document.getElementById('startOutingConfig')?.classList.add('hidden');
  syncStartScreenUI();
}

function closeStartScreen() {
  document.getElementById('startScreen')?.classList.add('hidden');
}

/** Reflect the current time/mode choice in the start screen controls. */
function syncStartScreenUI() {
  document.querySelectorAll('.ss-min').forEach((btn) => {
    btn.classList.toggle('active', parseInt(btn.dataset.min, 10) === startMinutes);
  });
  const custom = document.getElementById('startCustomMin');
  if (custom && custom.value && parseInt(custom.value, 10) !== startMinutes) {
    custom.value = '';
  }
  document.querySelectorAll('.ss-mode').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.profile === startProfile);
  });
}

/** Clamp a minute value to a sensible range. */
function clampStartMinutes(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return 15;
  return Math.max(1, Math.min(240, n));
}

document.getElementById('startOutingBtn')?.addEventListener('click', () => {
  document.getElementById('startChoices')?.classList.add('hidden');
  document.getElementById('startOutingConfig')?.classList.remove('hidden');
});

document.getElementById('startNormalBtn')?.addEventListener('click', closeStartScreen);

document.getElementById('startOutingBack')?.addEventListener('click', () => {
  document.getElementById('startOutingConfig')?.classList.add('hidden');
  document.getElementById('startChoices')?.classList.remove('hidden');
});

document.querySelectorAll('.ss-min').forEach((btn) => {
  btn.addEventListener('click', () => {
    startMinutes = clampStartMinutes(btn.dataset.min);
    const custom = document.getElementById('startCustomMin');
    if (custom) custom.value = '';
    syncStartScreenUI();
  });
});

document.getElementById('startCustomMin')?.addEventListener('input', (e) => {
  const raw = e.target.value.trim();
  if (!raw) return;
  startMinutes = clampStartMinutes(raw);
  syncStartScreenUI();
});

document.querySelectorAll('.ss-mode').forEach((btn) => {
  btn.addEventListener('click', () => {
    startProfile = btn.dataset.profile || 'foot';
    syncStartScreenUI();
  });
});

/** Apply the start-screen choices and navigate to the best quiet spot. */
async function startOutingFromStartScreen() {
  const goBtn = document.getElementById('startOutingGo');
  if (goBtn) goBtn.disabled = true;

  outingMinutes = startMinutes;
  const transport = START_MODE_TO_TRANSPORT[startProfile] || 'foot';
  selectedTransportModes = new Set([transport]);
  navMode = startProfile;
  syncTransportCheckboxes();
  syncNavButtons();
  if (reachTimeSlider) reachTimeSlider.value = String(Math.min(60, outingMinutes));
  updateTimeFilterUI();
  updateFilterSummary();
  updateOutingPanelState();

  /* Ask for GPS if needed, but never make the user wait long for it. */
  if (!locationMarker) {
    if (goBtn) goBtn.textContent = '📍 Getting your location…';
    try { locateMe(); } catch { /* ignore – falls back to map centre */ }
    const t0 = Date.now();
    while (!locationMarker && Date.now() - t0 < 8000) await sleep(150);
    if (goBtn) goBtn.textContent = 'Weiter →';
  }
  closeStartScreen();

  try {
    await getMeOutOfHere();
  } finally {
    if (goBtn) goBtn.disabled = false;
  }
}

document.getElementById('startOutingGo')?.addEventListener('click', () => {
  startOutingFromStartScreen();
});

/* Show the start screen once the version splash is fading out. */
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(openStartScreen, 2000);
});

/* ── Startup version splash ──────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function showVersionSplash() {
  const splash = document.getElementById('versionSplash');
  if (!splash) return;
  splash.querySelector('.splash-version').textContent =
    `v${APP_VERSION}  ·  build ${APP_BUILD}`;
  splash.classList.remove('hidden');
  setTimeout(() => splash.classList.add('splash-fade-out'), 1800);
  setTimeout(() => splash.remove(), 2500);
});
