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

## Tech stack

- [Leaflet.js 1.9](https://leafletjs.com/) – map rendering
- [Leaflet.heat](https://github.com/Leaflet/Leaflet.heat) – heatmap layer
- [OpenStreetMap Overpass API](https://overpass-api.de/) – road data

No framework, no build step, no back-end required.