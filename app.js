/**
 * 4TheWild – Silent Place Finder
 *
 * Fetches road data from the OpenStreetMap Overpass API and computes a
 * noise-weighted heatmap. Each road type gets a weight reflecting its
 * typical traffic noise. The grid-based score for a point is:
 *
 *   noiseScore(p) = max over all segments s { weight(s) * 1000 / dist(p, s) }
 *                  + tripCount(p) * TRIP_NOISE_PENALTY
 *
 * tripCount(p) is the number of active anonymous trip plans whose bounding
 * box contains p. Each planned trip reduces the silence score of the area,
 * signalling to other users that it will be less quiet when they arrive.
 *
 * High score → noisy / crowded (avoid).
 * Low score  → quiet / uncrowded (ideal).
 */

/* ── App version & build ─────────────────────────────────────────── */
const APP_VERSION = '1.0.0';
const APP_BUILD   = 1;

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

/* Colours for the terrain accessibility overlay */
const TERRAIN_COLORS = {
  rough_track:     '#f59e0b', /* grade4/grade5 tracks */
  demanding_trail: '#ef4444', /* mountain/alpine hiking */
};

/* ── Road type noise weights (higher = louder) ──────────────────── */
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
  living_street:     1,
  unclassified:      1,
  service:           0.8,
  track:             0.4,
  path:              0.2,
  cycleway:          0.2,
  footway:           0.15,
  pedestrian:        0.25,
  steps:             0.1,
};

/* Road type groups shown in the sidebar (label → list of highway values) */
const WEIGHT_UI_GROUPS = [
  { label: '🛣 Motorway',    keys: ['motorway', 'motorway_link'],   default: 10 },
  { label: '🛤 Trunk',       keys: ['trunk', 'trunk_link'],          default: 8  },
  { label: '🚗 Primary',     keys: ['primary', 'primary_link'],      default: 5  },
  { label: '🚙 Secondary',   keys: ['secondary', 'secondary_link'],  default: 3  },
  { label: '🛣 Tertiary',    keys: ['tertiary', 'tertiary_link'],    default: 2  },
  { label: '🏘 Residential', keys: ['residential', 'living_street'], default: 1.5},
  { label: '🌲 Track/Path',  keys: ['track', 'path', 'footway', 'cycleway', 'pedestrian', 'steps'], default: 0.2 },
];

/* ── State ───────────────────────────────────────────────────────── */
let roadWeights     = { ...DEFAULT_ROAD_WEIGHTS };
let heatLayer       = null;
let quietMarkers    = [];
let tripRects       = []; /* Leaflet rectangles for planned trip areas */
let analyzing       = false;
let locationMarker  = null; /* current-position marker */
let locationCircle  = null; /* accuracy circle around current position */
let vegetationLayer = null; /* optional vegetation polygon overlay */
let terrainLayer    = null; /* optional terrain difficulty overlay */

/* ── Map initialisation ──────────────────────────────────────────── */
const map = L.map('map', { zoomControl: true }).setView([47.7728, 9.0883], 13);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);

/* Try to center on the user's location */
if (navigator.geolocation) {
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => map.setView([coords.latitude, coords.longitude], 12),
    () => { /* keep default */ }
  );
}

/* ── GPS Locate control ──────────────────────────────────────────── */
const LocateControl = L.Control.extend({
  onAdd() {
    const btn = L.DomUtil.create('button', 'locate-btn');
    btn.type      = 'button';
    btn.innerHTML = '📍';
    btn.title     = 'Center map on my location';
    btn.setAttribute('aria-label', 'Center map on my location');
    L.DomEvent.disableClickPropagation(btn).on(btn, 'click', locateMe);
    return btn;
  },
});
new LocateControl({ position: 'bottomright' }).addTo(map);

/**
 * Request the device's current GPS position, pan the map to it, and place
 * a pulsing marker with an accuracy circle.
 */
function locateMe() {
  if (!navigator.geolocation) {
    showStatus('⚠️ Geolocation is not supported by your browser.', 'error');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      const { latitude: lat, longitude: lng, accuracy } = coords;
      map.setView([lat, lng], 14);
      if (locationMarker) { map.removeLayer(locationMarker); locationMarker = null; }
      if (locationCircle) { map.removeLayer(locationCircle); locationCircle = null; }
      locationCircle = L.circle([lat, lng], {
        radius: accuracy, color: '#60a5fa', fillColor: '#60a5fa', fillOpacity: 0.10, weight: 1,
      }).addTo(map);
      locationMarker = L.marker([lat, lng], {
        icon: L.divIcon({
          className: '', html: '<div class="location-dot"></div>',
          iconSize: [16, 16], iconAnchor: [8, 8],
        }),
      }).bindPopup('📍 Your current location').addTo(map);
    },
    (err) => {
      console.warn('Geolocation error:', err.message);
      showStatus('⚠️ Location unavailable. Please allow location access.', 'error');
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

/* ── DOM refs ────────────────────────────────────────────────────── */
const analyzeBtn      = document.getElementById('analyzeBtn');
const statusEl        = document.getElementById('status');
const opacitySlider   = document.getElementById('opacitySlider');
const opacityVal      = document.getElementById('opacityVal');
const blurSlider      = document.getElementById('blurSlider');
const blurVal         = document.getElementById('blurVal');
const weightControls  = document.getElementById('weightControls');
const resultsCard     = document.getElementById('resultsCard');
const resultsList     = document.getElementById('resultsList');
const planTripBtn     = document.getElementById('planTripBtn');
const tripStatusEl    = document.getElementById('tripStatus');
const sidebarEl       = document.getElementById('sidebar');
const sidebarToggleBtn= document.getElementById('sidebarToggle');
const sidebarCloseBtn = document.getElementById('sidebarClose');
const sidebarOverlay  = document.getElementById('sidebarOverlay');
const vegDampeningCb  = document.getElementById('vegDampening');
const showTerrainCb   = document.getElementById('showTerrain');
const terrainLegendEl = document.getElementById('terrainLegend');

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

/* ── Trip planning ───────────────────────────────────────────────── */

/**
 * Base URL for the trip-planning backend.
 * Change this to the deployed server URL in production.
 */
const TRIP_API_BASE = 'http://localhost:3000';

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
 * Build a deterministic localStorage key for the given map bounds.
 * Coordinates are rounded to 4 decimal places (~11 m) so that
 * re-analysing the identical view always produces a cache hit.
 * @param {L.LatLngBounds} bounds
 * @returns {string}
 */
function roadCacheKey(bounds) {
  const s = bounds.getSouth().toFixed(4);
  const w = bounds.getWest().toFixed(4);
  const n = bounds.getNorth().toFixed(4);
  const e = bounds.getEast().toFixed(4);
  return `${ROAD_CACHE_PREFIX}${s},${w},${n},${e}`;
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
  const s = bounds.getSouth().toFixed(4), w = bounds.getWest().toFixed(4);
  const n = bounds.getNorth().toFixed(4), e = bounds.getEast().toFixed(4);
  return `${VEG_CACHE_PREFIX}${s},${w},${n},${e}`;
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
  const s = bounds.getSouth().toFixed(4), w = bounds.getWest().toFixed(4);
  const n = bounds.getNorth().toFixed(4), e = bounds.getEast().toFixed(4);
  return `${TERRAIN_CACHE_PREFIX}${s},${w},${n},${e}`;
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

/**
 * Register the current map view as an anonymous planned trip.
 * Failures are surfaced to the user but do not block other functionality.
 */
async function planTrip() {
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
WEIGHT_UI_GROUPS.forEach(group => {
  const row = document.createElement('div');
  row.className = 'weight-row';

  const lbl = document.createElement('label');
  lbl.textContent = group.label;
  lbl.title = group.keys.join(', ');

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
    group.keys.forEach(k => { roadWeights[k] = v; });
  });

  row.appendChild(lbl);
  row.appendChild(slider);
  row.appendChild(valSpan);
  weightControls.appendChild(row);
});

/* ── Heatmap display controls ────────────────────────────────────── */
opacitySlider.addEventListener('input', () => {
  opacityVal.textContent = Math.round(opacitySlider.value * 100) + '%';
  if (heatLayer) heatLayer.setOptions({ opacity: parseFloat(opacitySlider.value) });
});

blurSlider.addEventListener('input', () => {
  blurVal.textContent = blurSlider.value;
  if (heatLayer) heatLayer.setOptions({ blur: parseInt(blurSlider.value, 10) });
});

/* ── Analyze button ──────────────────────────────────────────────── */
analyzeBtn.addEventListener('click', runAnalysis);

async function runAnalysis() {
  if (analyzing) return;
  analyzing = true;
  analyzeBtn.disabled = true;
  /* On mobile, close the sidebar so the map is fully visible */
  if (window.matchMedia('(max-width: 480px)').matches) {
    closeSidebar();
  }
  showStatus('⏳ Fetching road data…', 'info');

  try {
    const bounds = map.getBounds();
    const useVeg     = vegDampeningCb.checked;
    const useTerrain = showTerrainCb.checked;
    const [ways, plannedTrips, vegetation, terrainWays] = await Promise.all([
      fetchRoads(bounds),
      fetchPlannedTrips(bounds),
      useVeg     ? fetchVegetation(bounds) : Promise.resolve([]),
      useTerrain ? fetchTerrain(bounds)    : Promise.resolve([]),
    ]);

    if (!ways.length) {
      showStatus('⚠️ No road data found in this area. Try zooming in or panning.', 'error');
      return;
    }

    const tripNote = plannedTrips.length
      ? ` (${plannedTrips.length} trip${plannedTrips.length > 1 ? 's' : ''} planned here – silence score adjusted)`
      : '';
    const vegNote = (useVeg && vegetation.length)
      ? `, ${vegetation.length} vegetation area(s) dampening noise`
      : '';
    showStatus(`🧮 Calculating noise scores for ${ways.length} roads…${tripNote}${vegNote}`, 'info');

    /* Yield to the browser before heavy computation */
    await sleep(30);

    const { heatPoints, quietestPoints } = computeHeatmap(ways, bounds, plannedTrips, vegetation);

    renderHeatmap(heatPoints);
    renderTripRects(plannedTrips);
    renderVegetationLayer(useVeg ? vegetation : []);
    renderTerrainLayer(useTerrain ? terrainWays : []);
    if (useTerrain && terrainWays.length) {
      terrainLegendEl.classList.remove('hidden');
    } else {
      terrainLegendEl.classList.add('hidden');
    }
    renderResults(quietestPoints);

    showStatus(
      `✅ Done — ${ways.length} roads analysed, grid ${GRID_SIZE}×${GRID_SIZE}.` +
      (plannedTrips.length ? ` ${plannedTrips.length} planned trip(s) factored in.` : '') +
      (useVeg && vegetation.length ? ` Vegetation dampening applied (${vegetation.length} areas).` : ''),
      'success'
    );
  } catch (err) {
    console.error(err);
    if (err.name === 'AbortError') {
      showStatus('❌ Request timed out. Try a smaller area.', 'error');
    } else {
      showStatus(`❌ Error: ${err.message}`, 'error');
    }
  } finally {
    analyzing = false;
    analyzeBtn.disabled = false;
  }
}

/* ── Overpass API ────────────────────────────────────────────────── */

/**
 * Fetch road ways for the given bounds using a three-tier strategy:
 *  1. On-device localStorage cache (instant, survives app restarts)
 *  2. Backend road cache  (shared across users, only calls Overpass on miss)
 *  3. Direct Overpass API (fallback when backend is unreachable)
 *
 * Successful responses from tier 2 or 3 are stored in localStorage
 * so the next request in the same session is served from tier 1.
 *
 * @param {L.LatLngBounds} bounds
 * @returns {Promise<Array>} Overpass way elements
 */
async function fetchRoads(bounds) {
  /* ── Tier 1: on-device cache ──────────────────────────────────── */
  const cached = getCachedRoads(bounds);
  if (cached) return cached;

  /* ── Tier 2: backend road cache ───────────────────────────────── */
  const params = new URLSearchParams({
    south: bounds.getSouth().toFixed(6),
    west:  bounds.getWest().toFixed(6),
    north: bounds.getNorth().toFixed(6),
    east:  bounds.getEast().toFixed(6),
  });
  try {
    const resp = await fetch(`${TRIP_API_BASE}/api/roads?${params}`);
    if (resp.ok) {
      const data = await resp.json();
      const ways = data.ways || [];
      setCachedRoads(bounds, ways);
      return ways;
    }
  } catch {
    /* Backend unavailable – fall through to direct Overpass */
  }

  /* ── Tier 3: direct Overpass API ──────────────────────────────── */
  const s = bounds.getSouth().toFixed(6);
  const w = bounds.getWest().toFixed(6);
  const n = bounds.getNorth().toFixed(6);
  const e = bounds.getEast().toFixed(6);
  const bbox = `${s},${w},${n},${e}`;

  const query = `[out:json][timeout:${OVERPASS_TIMEOUT_S}];way["highway"](${bbox});out geom;`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OVERPASS_ABORT_MS);

  const resp = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
    signal: controller.signal,
  });
  clearTimeout(timer);

  if (!resp.ok) throw new Error(`Overpass returned HTTP ${resp.status}`);
  const data = await resp.json();
  const ways = data.elements || [];
  setCachedRoads(bounds, ways);
  return ways;
}

/**
 * Fetch vegetation polygons (forests, scrubland, wetlands, etc.) for the
 * given bounds via Overpass, caching the result in localStorage.
 * @param {L.LatLngBounds} bounds
 * @returns {Promise<Array>} Pre-processed polygon objects with bounding boxes
 */
async function fetchVegetation(bounds) {
  const cached = getCachedVegetation(bounds);
  if (cached) return cached;

  const s = bounds.getSouth().toFixed(6), w = bounds.getWest().toFixed(6);
  const n = bounds.getNorth().toFixed(6), e = bounds.getEast().toFixed(6);
  const bbox = `${s},${w},${n},${e}`;
  const query =
    `[out:json][timeout:${OVERPASS_TIMEOUT_S}];` +
    `(way["natural"~"^(wood|scrub|heath|wetland|grassland)$"](${bbox});` +
    `way["landuse"~"^(forest|meadow|grass|orchard|vineyard)$"](${bbox}););` +
    `out geom;`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OVERPASS_ABORT_MS);
    const resp = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:   `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const polys = (data.elements || [])
      .filter(el => el.geometry && el.geometry.length >= 3)
      .map(el => ({
        type:    el.tags.natural || el.tags.landuse || '',
        geometry: el.geometry,
        minLat:  Math.min(...el.geometry.map(p => p.lat)),
        maxLat:  Math.max(...el.geometry.map(p => p.lat)),
        minLon:  Math.min(...el.geometry.map(p => p.lon)),
        maxLon:  Math.max(...el.geometry.map(p => p.lon)),
      }));
    setCachedVegetation(bounds, polys);
    return polys;
  } catch (err) {
    console.warn('Vegetation fetch failed:', err.message);
    return [];
  }
}

/**
 * Fetch difficult terrain paths (sac_scale hiking routes, rough tracks)
 * for the given bounds via Overpass, caching the result in localStorage.
 * @param {L.LatLngBounds} bounds
 * @returns {Promise<Array>} Overpass way elements
 */
async function fetchTerrain(bounds) {
  const cached = getCachedTerrain(bounds);
  if (cached) return cached;

  const s = bounds.getSouth().toFixed(6), w = bounds.getWest().toFixed(6);
  const n = bounds.getNorth().toFixed(6), e = bounds.getEast().toFixed(6);
  const bbox = `${s},${w},${n},${e}`;
  const query =
    `[out:json][timeout:${OVERPASS_TIMEOUT_S}];` +
    `(way["highway"]["sac_scale"](${bbox});` +
    `way["highway"="track"]["tracktype"~"^(grade4|grade5)$"](${bbox}););` +
    `out geom;`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OVERPASS_ABORT_MS);
    const resp = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:   `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const ways = (data.elements || []).filter(el => el.geometry && el.geometry.length >= 2);
    setCachedTerrain(bounds, ways);
    return ways;
  } catch (err) {
    console.warn('Terrain fetch failed:', err.message);
    return [];
  }
}

/* ── Noise computation ───────────────────────────────────────────── */
const GRID_SIZE = 50; /* points per axis → 50×50 = 2 500 sample points */
const OVERPASS_TIMEOUT_S   = 25;   /* server-side timeout in seconds */
const OVERPASS_ABORT_MS    = (OVERPASS_TIMEOUT_S + 3) * 1000; /* client abort with grace period */
/** Minimum distance (m) to avoid division by zero and cap extreme noise near road centrelines. */
const MIN_DISTANCE_METERS  = 10;

function computeHeatmap(ways, bounds, plannedTrips = [], vegetation = []) {
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
    const highway = way.tags && way.tags.highway;
    const weight  = roadWeights[highway] !== undefined
                      ? roadWeights[highway]
                      : DEFAULT_ROAD_WEIGHTS[highway] ?? 0;
    if (weight <= 0) continue;
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

  if (!segments.length) {
    return { heatPoints: [], quietestPoints: [] };
  }

  /* Score every grid point */
  const gridScores = [];
  let maxNoise = 0;

  for (let i = 0; i <= GRID_SIZE; i++) {
    for (let j = 0; j <= GRID_SIZE; j++) {
      const lat = latMin + i * latStep;
      const lng = lngMin + j * lngStep;
      const px  = lng * mPerLng;
      const py  = lat * mPerLat;

      let noiseScore = 0;
      for (const seg of segments) {
        const dist  = Math.max(MIN_DISTANCE_METERS, ptSegDist(px, py, seg.ax, seg.ay, seg.bx, seg.by));
        /* noise contribution: weight scaled by a characteristic distance of 1 000 m */
        const noise = seg.weight * 1000 / dist;
        if (noise > noiseScore) noiseScore = noise;
      }

      /* Apply vegetation dampening: points inside a vegetation polygon
         receive a noise reduction proportional to the vegetation density.
         The maximum dampening factor across all overlapping polygons is used. */
      if (vegetation.length) {
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
      const tripCount = plannedTrips.filter(t =>
        lat >= t.south && lat <= t.north && lng >= t.west && lng <= t.east
      ).length;
      noiseScore += tripCount * TRIP_NOISE_PENALTY;

      if (noiseScore > maxNoise) maxNoise = noiseScore;
      gridScores.push({ lat, lng, noiseScore });
    }
  }

  /* Normalise 0-1 for Leaflet.heat */
  const heatPoints = gridScores.map(({ lat, lng, noiseScore }) => [
    lat, lng, noiseScore / maxNoise,
  ]);

  /* Top 5 quietest points (lowest noise score) */
  const sorted = [...gridScores].sort((a, b) => a.noiseScore - b.noiseScore);
  const quietestPoints = sorted.slice(0, 5);

  return { heatPoints, quietestPoints, maxNoise };
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
function renderResults(points) {
  /* Remove old markers */
  quietMarkers.forEach(m => map.removeLayer(m));
  quietMarkers = [];
  resultsList.innerHTML = '';

  if (!points.length) {
    resultsCard.classList.add('hidden');
    return;
  }

  resultsCard.classList.remove('hidden');

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

    const marker = L.marker([p.lat, p.lng], { icon })
      .bindPopup(
        `<b>Quiet spot #${rank}</b><br>` +
        `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`
      )
      .addTo(map);

    quietMarkers.push(marker);

    /* Sidebar result item */
    const li   = document.createElement('li');
    li.className = 'result-item';
    li.innerHTML =
      `<span class="ri-rank">#${rank}</span>` +
      `<span class="ri-score">Noise index: ${p.noiseScore.toFixed(2)}</span>` +
      `<span class="ri-coords">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</span>`;
    li.addEventListener('click', () => {
      map.setView([p.lat, p.lng], Math.max(map.getZoom(), 13));
      marker.openPopup();
    });
    resultsList.appendChild(li);
  });
}

/* ── Trip rect rendering ─────────────────────────────────────────── */

/**
 * Draw semi-transparent rectangles on the map for each planned trip area,
 * so users can see which regions are already targeted by others.
 * @param {Array<{south:number,west:number,north:number,east:number,id:string}>} trips
 */
function renderTripRects(trips) {
  /* Remove previous rectangles */
  tripRects.forEach(r => map.removeLayer(r));
  tripRects = [];

  trips.forEach(t => {
    const rect = L.rectangle(
      [[t.south, t.west], [t.north, t.east]],
      {
        color:     '#f59e0b',
        weight:    1.5,
        fillColor: '#f59e0b',
        fillOpacity: 0.12,
        dashArray: '4 4',
      }
    ).bindTooltip('Planned trip area – silence score adjusted')
     .addTo(map);
    tripRects.push(rect);
  });
}

/* ── Vegetation overlay ──────────────────────────────────────────── */

/**
 * Draw semi-transparent green polygons for vegetation areas so users can
 * see where noise dampening is being applied.
 * @param {Array} polys  Pre-processed polygon objects from fetchVegetation()
 */
function renderVegetationLayer(polys) {
  if (vegetationLayer) { map.removeLayer(vegetationLayer); vegetationLayer = null; }
  if (!polys.length) return;
  vegetationLayer = L.layerGroup();
  polys.forEach(vp => {
    const latLngs = vp.geometry.map(p => [p.lat, p.lon]);
    L.polygon(latLngs, {
      color: '#4ade80', weight: 0.8,
      fillColor: '#4ade80', fillOpacity: 0.15,
    }).bindTooltip(`🌲 Vegetation: ${vp.type.replace(/_/g, ' ')}`)
      .addTo(vegetationLayer);
  });
  vegetationLayer.addTo(map);
}

/* ── Terrain accessibility overlay ──────────────────────────────── */

/**
 * Draw polylines for rough/demanding terrain paths so users can assess
 * accessibility.  Colour-coded by difficulty.
 * @param {Array} ways  Overpass way elements from fetchTerrain()
 */
function renderTerrainLayer(ways) {
  if (terrainLayer) { map.removeLayer(terrainLayer); terrainLayer = null; }
  if (!ways.length) return;
  terrainLayer = L.layerGroup();
  ways.forEach(way => {
    const latLngs = way.geometry.map(p => [p.lat, p.lon]);
    const sacScale  = way.tags && way.tags.sac_scale;
    const tracktype = way.tags && way.tags.tracktype;
    const isDemanding = sacScale && sacScale !== 'hiking';
    const color = isDemanding ? TERRAIN_COLORS.demanding_trail : TERRAIN_COLORS.rough_track;
    const label = sacScale
      ? `🥾 Difficulty: ${sacScale.replace(/_/g, ' ')}`
      : `🚧 Rough track (${tracktype})`;
    L.polyline(latLngs, { color, weight: 2.5, opacity: 0.85 })
      .bindTooltip(label)
      .addTo(terrainLayer);
  });
  terrainLayer.addTo(map);
}

/* ── Helpers ─────────────────────────────────────────────────────── */
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
