# 4TheWild - Projektregeln

Silent-Place-Finder: Web-App (MapLibre + OpenFreeMap-Tiles) und Android-APK (WebView-Huelle),
Backend PHP/MariaDB lokal auf XAMPP.

## Pfade

- Quelle (Source of Truth): `F:\oc-projects\4TheWild`
- Deployment (generiert, nie hier editieren): `F:\CascadeProjects\mama-razzi\public\apps\wild`
  -> http://192.168.178.37/apps/wild/
- DB: MariaDB `4thewild`, User `wild4` (XAMPP, `F:\prg\xampp`)

## Workflow

1. Aendern in `F:\oc-projects\4TheWild` (nur hier).
2. Deploy: `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy-local.ps1`
3. DB/Schema: `.\scripts\setup-db.ps1` (idempotent; legt nichts doppelt an)
4. APK: `.\scripts\build-apk.ps1` -> `android\app\build\outputs\apk\debug\app-debug.apk`
   - versionCode = 1000 + git commit count (muss steigen, sonst kein Update)
   - Debug-Signatur: `F:\.android\.android\debug.keystore` -> nur auf diesem PC bauen
   - Versand per `F:\prg\trello-bot-questions\scripts\send-telegram-file.js` (auf der DS)

## Nicht anfassen / Regeln

- `apps\wild\config.local.php` (Deploy-Verzeichnis) enthaelt DB-Zugangsdaten: NO-TOUCH, nie committen.
- Keine Overpass-Aufrufe: Der Rechtsansatz ist "Daten aus den ohnehin geladenen
  OpenFreeMap-Tiles" (ODbL, Attribution Pflicht). Nicht wieder einfuehren.
- Nominatim/OSRM-Demoserver nur fuer leichte interaktive Nutzung; fuer oeffentlichen
  Betrieb selbst hosten.
- PHP-Backend nicht oeffentlich exponieren (nur LAN).

## Test

- Web: Seite oeffnen, Karte laden, "Plan Trip Here" -> Erfolgsmeldung (POST /api/trips).
- API: `Invoke-WebRequest http://127.0.0.1/apps/wild/api/trips?...`
