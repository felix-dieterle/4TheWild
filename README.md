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

## PHP/MySQL backend (apps/wild)

A self-contained PHP backend lives under `apps/wild/` and provides **persistent
caching** of Overpass road responses and trip plans in MySQL/MariaDB.  It
mirrors the same API as the Node.js `server.js` and can replace it in
shared-hosting environments where Node.js is unavailable.

### Files

| Path | Purpose |
|------|---------|
| `apps/wild/api.php` | Main router – handles all `/api/*` requests |
| `apps/wild/config.php` | PDO connection factory (reads DB credentials from env vars) |
| `apps/wild/.htaccess` | Apache mod_rewrite rules to route `/api/*` → `api.php` |
| `apps/wild/db/schema.sql` | MySQL schema (`road_cache` + `trips` tables) |

### Database schema

```
road_cache   cache_key PK, ways_json LONGTEXT, cached_at BIGINT
trips        id CHAR(36) PK, south/west/north/east DOUBLE, created_at BIGINT
```

### Setup

**1. Create the database and apply the schema**

```bash
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS \`4thewild\` CHARACTER SET utf8mb4;"
mysql -u root -p 4thewild < apps/wild/db/schema.sql
```

**2. Set environment variables** (never commit credentials)

```bash
export DB_HOST=localhost
export DB_PORT=3306
export DB_NAME=4thewild
export DB_USER=your_db_user
export DB_PASS=your_db_password
```

Apache example (`/etc/apache2/sites-available/4thewild.conf`):

```apache
<VirtualHost *:80>
    DocumentRoot /var/www/4thewild/apps/wild
    ServerName example.com

    SetEnv DB_HOST localhost
    SetEnv DB_PORT 3306
    SetEnv DB_NAME 4thewild
    SetEnv DB_USER your_db_user
    SetEnv DB_PASS your_db_password

    <Directory /var/www/4thewild/apps/wild>
        AllowOverride All
        Require all granted
    </Directory>
</VirtualHost>
```

**3. Enable mod_rewrite** (Apache)

```bash
sudo a2enmod rewrite
sudo systemctl reload apache2
```

**4. Test the endpoints**

```bash
# Road cache (first call hits Overpass; subsequent calls return cached data)
curl "http://example.com/api/roads?south=48.1&west=11.5&north=48.2&east=11.6"

# Submit an anonymous trip plan
curl -X POST http://example.com/api/trips \
     -H "Content-Type: application/json" \
     -d '{"south":48.1,"west":11.5,"north":48.2,"east":11.6}'

# Query overlapping trip plans
curl "http://example.com/api/trips?south=48.1&west=11.5&north=48.2&east=11.6"
```

### API reference

| Method | Path | Body / Query params | Response |
|--------|------|---------------------|----------|
| `GET` | `/api/roads` | `south`, `west`, `north`, `east` (float) | `{ ways[], cached: bool }` |
| `GET` | `/api/trips` | `south`, `west`, `north`, `east` (float) | `{ count, trips[] }` |
| `POST` | `/api/trips` | JSON `{ south, west, north, east }` | `201 { id }` |

Road tiles are cached for **24 hours** keyed by a 0.01° (~1 km) tile-quantised
bounding box.  Trip plans expire after **24 hours** and are pruned lazily on
every request.

## Tech stack

- [Leaflet.js 1.9](https://leafletjs.com/) – map rendering
- [Leaflet.heat](https://github.com/Leaflet/Leaflet.heat) – heatmap layer
- [OpenStreetMap Overpass API](https://overpass-api.de/) – road data
- [Android WebView](https://developer.android.com/reference/android/webkit/WebView) + Kotlin – native Android packaging
- [Fused Location Provider](https://developers.google.com/location-context/fused-location-provider) – native GPS on Android
- PHP 8.0+ / MySQL 5.7+ (optional persistent backend – `apps/wild/`)

No framework, no build step required for the front-end.  
The PHP backend requires PHP ≥ 8.0 with PDO + pdo_mysql, and MySQL ≥ 5.7 or MariaDB ≥ 10.3.