# 4TheWild – Silent Place Finder

A Google Maps-like single-page web app that helps you find the **most silent spots** in any area: places that are as far as possible from roads, weighted by how big and busy each road type is.

## Features

| Feature | Details |
|---------|---------|
| 🗺 Interactive map | OpenStreetMap / Leaflet.js |
| 🌡 Noise heatmap | Blue = quiet, Red = noisy |
| 🏆 Quietest spots | Top 5 ranked markers on the map |
| ⚖️ Adjustable road weights | Tune how much each road type contributes to noise |
| 🎚 Heatmap controls | Opacity and blur radius sliders |

## How it works

1. The app queries the [OpenStreetMap Overpass API](https://overpass-api.de/) for all highway features inside the current map view.
2. A 50×50 grid of sample points is laid over the view.
3. For every grid point the **noise score** is computed as:

   ```
   noiseScore(P) = max over all road segments S { weight(S) × 1000 / dist(P, S) }
   ```

   where `dist` is the shortest distance from the point to the segment (in metres) and `weight` reflects the road type (motorway = 10, path = 0.2, etc.).

4. Scores are normalised and rendered as a colour heatmap (Leaflet.heat).
5. The five grid points with the **lowest** noise score are shown as ranked markers.

## Road noise weights (defaults)

| Road type | Weight |
|-----------|--------|
| Motorway | 10 |
| Trunk | 8 |
| Primary | 5 |
| Secondary | 3 |
| Tertiary | 2 |
| Residential / living street | 1–1.5 |
| Track / path / footway | 0.1–0.4 |

Weights can be adjusted live using the sidebar sliders.

## Usage

Open `index.html` in any modern browser (no build step required).  
Pan & zoom the map to your area of interest, then click **Analyze Current View**.

> **Tip:** Use a zoom level of 10–13 for best results.  
> Very large areas may time out due to Overpass API limits.

## Android APK build

The app is wrapped with [Capacitor](https://capacitorjs.com/) to produce a native Android APK.

### Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18
- [Android Studio](https://developer.android.com/studio) (includes the Android SDK and JDK 17)

### Build steps

```bash
# 1. Install Capacitor dependencies
npm install

# 2. Create the Android native project (only needed once)
npx cap add android

# 3. Copy web assets into the Android project
npx cap sync android

# 4a. Open in Android Studio and build / run from there
npx cap open android

# 4b. OR build the debug APK from the command line
cd android && ./gradlew assembleDebug
# → APK is at android/app/build/outputs/apk/debug/app-debug.apk
```

### CI / automated build

A GitHub Actions workflow (`.github/workflows/android-build.yml`) builds a debug APK on every push to `main` and on pull requests. The APK is uploaded as a workflow artifact (retained for 30 days).

## Tech stack

- [Leaflet.js 1.9](https://leafletjs.com/) – map rendering
- [Leaflet.heat](https://github.com/Leaflet/Leaflet.heat) – heatmap layer
- [OpenStreetMap Overpass API](https://overpass-api.de/) – road data

No framework, no build step, no back-end required.