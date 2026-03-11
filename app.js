/**
 * 4TheWild – Silent Place Finder
 *
 * Fetches road and railway data from the OpenStreetMap Overpass API and
 * computes a noise-weighted heatmap. Each road/railway type gets a base
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
  { label: '🛣 Motorway',    keys: ['motorway', 'motorway_link'],   default: 10 },
  { label: '🛤 Trunk',       keys: ['trunk', 'trunk_link'],          default: 8  },
  { label: '🚗 Primary',     keys: ['primary', 'primary_link'],      default: 5  },
  { label: '🚙 Secondary',   keys: ['secondary', 'secondary_link'],  default: 3  },
  { label: '🛣 Tertiary',    keys: ['tertiary', 'tertiary_link'],    default: 2  },
  { label: '🏘 Residential', keys: ['residential', 'living_street'], default: 1.5},
  { label: '🌲 Track/Path',  keys: ['track', 'path', 'footway', 'cycleway', 'pedestrian', 'steps'], default: 0.2 },
];

/* Railway type groups shown in the sidebar (label → list of railway values) */
const RAILWAY_UI_GROUPS = [
  { label: '🚆 Heavy Rail',  keys: ['rail', 'narrow_gauge'],                  default: 8 },
  { label: '🚊 Light Rail',  keys: ['light_rail', 'subway', 'monorail'],      default: 4 },
  { label: '🚋 Tram',        keys: ['tram', 'preserved'],                     default: 3 },
];

/* ── State ───────────────────────────────────────────────────────── */
let roadWeights     = { ...DEFAULT_ROAD_WEIGHTS };
let railwayWeights  = { ...DEFAULT_RAILWAY_WEIGHTS };
let heatLayer       = null;
let quietMarkers    = [];
let tripRects       = []; /* Leaflet rectangles for planned trip areas */
let analyzing       = false;
/** In-memory log of HTTP/API errors recorded during the session. */
const errorLog      = [];
let locationMarker  = null; /* current-position marker */
let locationCircle  = null; /* accuracy circle around current position */
let locationWatchId = null; /* watchPosition handle (string on Android/Capacitor, number in browser) */
let hasCenteredOnUser = false; /* true once the map has been auto-panned to the user */
let vegetationLayer = null; /* optional vegetation polygon overlay */
let terrainLayer    = null; /* optional terrain difficulty overlay */

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
/* tap:false disables Leaflet's custom tap emulation so that the     */
/* Android WebView can rely on native touch-to-click conversion.     */
/* Without this, marker popups are not triggered by touch on Android.*/
const map = L.map('map', { zoomControl: true, tap: false }).setView([47.7728, 9.0883], 13);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);

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
  locationCircle = L.circle([lat, lng], {
    radius: accuracy, color: '#60a5fa', fillColor: '#60a5fa', fillOpacity: 0.10, weight: 1,
  }).addTo(map);
  locationMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      className: '', html: '<div class="location-dot"></div>',
      iconSize: [16, 16], iconAnchor: [8, 8],
    }),
  }).bindPopup('📍 Your current location').addTo(map);
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
const useRailwaysCb   = document.getElementById('useRailways');
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
  });
});

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
  const url = `${OSRM_BASE}/route/v1/${profile}/${coords}?overview=full&geometries=geojson`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Routing request failed (HTTP ${resp.status})`);
  const data = await resp.json();
  if (data.code !== 'Ok' || !data.routes || !data.routes.length) {
    throw new Error('No route found for the given locations.');
  }
  const route = data.routes[0];
  return {
    coordinates: route.geometry.coordinates, /* [lon, lat] pairs */
    distance:    route.distance,             /* metres            */
    duration:    route.duration,             /* seconds           */
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

/** Remove the currently displayed route from the map. */
function clearRoute() {
  if (routeLayer) {
    map.removeLayer(routeLayer);
    routeLayer = null;
  }
  document.getElementById('navInfo').classList.add('hidden');
  document.getElementById('clearRouteBtn').classList.add('hidden');
  hideNavStatus();
}

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

    L.polyline(latLngs, { color: lineColor, weight: 5, opacity: 0.85 }).addTo(routeLayer);

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
    hideNavStatus();

  } catch (err) {
    console.warn('Navigation error:', err.message);
    showNavStatus(`❌ ${err.message}`, 'error');
  } finally {
    calcBtn.disabled = false;
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

/* ── Railway cache (localStorage) ───────────────────────────────── */
const RAILWAY_CACHE_PREFIX = '4w_railway_';

function railwayCacheKey(bounds) {
  const s = bounds.getSouth().toFixed(4), w = bounds.getWest().toFixed(4);
  const n = bounds.getNorth().toFixed(4), e = bounds.getEast().toFixed(4);
  return `${RAILWAY_CACHE_PREFIX}${s},${w},${n},${e}`;
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

/* ── Build railway weight sliders ────────────────────────────────── */
const railwayWeightControls = document.getElementById('railwayWeightControls');
RAILWAY_UI_GROUPS.forEach(group => {
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
    group.keys.forEach(k => { railwayWeights[k] = v; });
  });

  row.appendChild(lbl);
  row.appendChild(slider);
  row.appendChild(valSpan);
  railwayWeightControls.appendChild(row);
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
  mapLoadingText.textContent = 'Fetching road data…';
  mapLoadingEl.classList.remove('hidden');

  try {
    const bounds = map.getBounds();
    const useVeg      = vegDampeningCb.checked;
    const useTerrain  = showTerrainCb.checked;
    const useRailways = useRailwaysCb.checked;
    const [ways, plannedTrips, vegetation, terrainWays, railwayWays] = await Promise.all([
      fetchRoads(bounds),
      fetchPlannedTrips(bounds),
      useVeg      ? fetchVegetation(bounds) : Promise.resolve([]),
      useTerrain  ? fetchTerrain(bounds)    : Promise.resolve([]),
      useRailways ? fetchRailways(bounds)   : Promise.resolve([]),
    ]);

    if (!ways.length) {
      showStatus('⚠️ No road data found. The Overpass API may be temporarily unavailable — try again in a moment, or pan to an area with cached data.', 'error');
      return;
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
    showStatus(`🧮 Calculating noise scores for ${ways.length} roads${railwayNote}…${tripNote}${vegNote}`, 'info');
    mapLoadingText.textContent = 'Calculating noise scores…';

    /* Yield to the browser before heavy computation */
    await sleep(30);

    const { heatPoints, quietestPoints } = computeHeatmap(ways, bounds, plannedTrips, vegetation, railwayWays);

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
      (useVeg && vegetation.length ? ` Vegetation dampening applied (${vegetation.length} areas).` : '') +
      (useRailways && railwayWays.length ? ` ${railwayWays.length} railway way(s) included.` : ''),
      'success'
    );
  } catch (err) {
    console.error(err);
    logError('Analysis', err.message, err.status);
    if (err.name === 'AbortError') {
      showStatus('❌ Request timed out. Try a smaller area or retry in a moment.', 'error');
    } else if (err.status === 429) {
      showStatus('⚠️ Overpass API rate limit reached. Please wait a moment and try again.', 'error');
    } else {
      showStatus(`❌ Error: ${err.message}`, 'error');
    }
  } finally {
    analyzing = false;
    analyzeBtn.disabled = false;
    mapLoadingEl.classList.add('hidden');
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

  try {
    const elements = await fetchFromOverpass(query);
    setCachedRoads(bounds, elements);
    return elements;
  } catch (err) {
    console.warn('Road fetch from Overpass failed:', err.message);
    logError('Roads', `Overpass unavailable: ${err.message}`, err.status);
    return [];
  }
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
    const elements = await fetchFromOverpass(query);
    const polys = elements
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
    const elements = await fetchFromOverpass(query);
    const ways = elements.filter(el => el.geometry && el.geometry.length >= 2);
    setCachedTerrain(bounds, ways);
    return ways;
  } catch (err) {
    console.warn('Terrain fetch failed:', err.message);
    return [];
  }
}

/**
 * Fetch railway ways (rail, tram, subway, etc.) for the given bounds via
 * Overpass, caching the result in localStorage.
 * @param {L.LatLngBounds} bounds
 * @returns {Promise<Array>} Overpass way elements
 */
async function fetchRailways(bounds) {
  const cached = getCachedRailways(bounds);
  if (cached) return cached;

  const s = bounds.getSouth().toFixed(6), w = bounds.getWest().toFixed(6);
  const n = bounds.getNorth().toFixed(6), e = bounds.getEast().toFixed(6);
  const bbox = `${s},${w},${n},${e}`;
  const query =
    `[out:json][timeout:${OVERPASS_TIMEOUT_S}];` +
    `way["railway"~"^(rail|tram|subway|light_rail|narrow_gauge|monorail|preserved)$"](${bbox});` +
    `out geom;`;
  try {
    const elements = await fetchFromOverpass(query);
    const ways = elements.filter(el => el.geometry && el.geometry.length >= 2);
    setCachedRailways(bounds, ways);
    return ways;
  } catch (err) {
    console.warn('Railway fetch failed:', err.message);
    return [];
  }
}

/* ── Noise computation ───────────────────────────────────────────── */
const GRID_SIZE = 50; /* points per axis → 50×50 = 2 500 sample points */
const OVERPASS_TIMEOUT_S   = 25;   /* server-side timeout in seconds */
const OVERPASS_ABORT_MS    = (OVERPASS_TIMEOUT_S + 3) * 1000; /* client abort with grace period */
/** Minimum distance (m) to avoid division by zero and cap extreme noise near road centrelines. */
const MIN_DISTANCE_METERS  = 10;
/**
 * Public Overpass API mirrors tried in order.  If the primary returns 504 or
 * times out the next mirror is tried automatically so a single overloaded
 * instance does not cause a total failure.
 */
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
];
/** Number of full passes through all mirrors before giving up. */
const OVERPASS_MAX_PASSES = 2;
/** Base delay (ms) before the second pass – gives overloaded mirrors time to recover. */
const OVERPASS_RETRY_DELAY_MS = 3000;

/**
 * Post a query to Overpass, automatically retrying against each mirror in
 * turn.  If every mirror fails on a pass the function waits
 * OVERPASS_RETRY_DELAY_MS before starting a second pass, giving overloaded
 * servers a chance to recover before it throws for good.
 * @param {string} query  OverpassQL query string
 * @returns {Promise<Array>} Overpass elements array
 */
async function fetchFromOverpass(query) {
  const body = `data=${encodeURIComponent(query)}`;
  let lastErr;
  for (let pass = 0; pass < OVERPASS_MAX_PASSES; pass++) {
    if (pass > 0) {
      /* Brief pause before the second pass so transiently overloaded mirrors
       * have a moment to recover. */
      await sleep(OVERPASS_RETRY_DELAY_MS * pass);
    }
    for (const url of OVERPASS_ENDPOINTS) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), OVERPASS_ABORT_MS);
        let resp;
        try {
          resp = await fetch(url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
            signal:  controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (resp.status === 504 || resp.status === 502 || resp.status === 429) {
          const err = new Error(`HTTP ${resp.status}`);
          err.status = resp.status;
          throw err;
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        return data.elements || [];
      } catch (err) {
        lastErr = err;
        const retryable = err.name === 'AbortError' ||
                          err.status === 504 || err.status === 502 || err.status === 429 ||
                          err.name === 'TypeError'; /* network-level failure */
        if (!retryable) throw err;
        logError('Overpass', `Mirror ${url} failed: ${err.message}`, err.status);
        console.warn(`Overpass mirror ${url} failed (${err.message}), trying next…`);
      }
    }
  }
  throw lastErr;
}

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

function computeHeatmap(ways, bounds, plannedTrips = [], vegetation = [], railways = []) {
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
