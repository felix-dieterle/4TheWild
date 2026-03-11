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

The app is packaged as a native Android application using Kotlin and the Android
WebView API. The web assets (HTML/CSS/JS) are bundled inside the APK and served
via `WebViewAssetLoader`; native Kotlin code handles GPS permissions through
the Fused Location Provider API without any third-party framework.

### Prerequisites

- [Android Studio](https://developer.android.com/studio) with JDK 21 and Android SDK 34
  (recommended for local development)
- **OR** the Gradle CLI (≥ 8.7) and Android SDK for command-line builds

### Build steps

```bash
# 1. Copy web assets into the Android project
#    (creates android/app/src/main/assets/www/)
npm run prepare:android

# 2. Write the Android SDK path (replace with your actual SDK location)
echo "sdk.dir=$ANDROID_SDK_ROOT" > android/local.properties

# 3a. Open in Android Studio and build / run from there
#     (File → Open → select the android/ folder)

# 3b. OR build a debug APK from the command line
cd android
gradle wrapper --gradle-version=8.7   # one-time setup
./gradlew assembleDebug
# → APK is at android/app/build/outputs/apk/debug/app-debug.apk
```

### CI / automated build

A GitHub Actions workflow (`.github/workflows/android-build.yml`) builds a debug
APK on every push to `main` and on pull requests. The APK is uploaded as a
workflow artifact (retained for 30 days).

#### Making the APK updatable (no uninstall required)

Android requires that every APK update is signed with the **same key**. Because
the CI runner is ephemeral, a new debug keystore would be generated on every run —
meaning each build produces a differently-signed APK that cannot update an
already-installed version.

To fix this, store a persistent keystore as a repository secret:

1. Generate a keystore once on your local machine (standard Android debug credentials):
   ```bash
   keytool -genkeypair -v \
     -keystore debug.keystore \
     -alias androiddebugkey \
     -keyalg RSA -keysize 2048 \
     -validity 10000 \
     -storepass android \
     -keypass android \
     -dname "CN=Android Debug,O=Android,C=US"
   ```
2. Base64-encode the file:
   ```bash
   base64 -w 0 debug.keystore   # Linux
   base64 debug.keystore        # macOS
   ```
3. Add the output as a repository secret named **`KEYSTORE_BASE64`**:  
   *GitHub → Repository → Settings → Secrets and variables → Actions → New repository secret*

The workflow will automatically restore this keystore before every build, ensuring
all APKs share the same signing key and can be installed as updates without
uninstalling first. The `versionCode` is set to the workflow run number so Android
always sees each new build as a newer version.

## Tech stack

- [Leaflet.js 1.9](https://leafletjs.com/) – map rendering
- [Leaflet.heat](https://github.com/Leaflet/Leaflet.heat) – heatmap layer
- [OpenStreetMap Overpass API](https://overpass-api.de/) – road data
- [Android WebView](https://developer.android.com/reference/android/webkit/WebView) + Kotlin – native Android packaging
- [Fused Location Provider](https://developers.google.com/location-context/fused-location-provider) – native GPS on Android

No framework, no build step, no back-end required.