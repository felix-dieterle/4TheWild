# 4TheWild

An Android application for wildlife enthusiasts.

## Debug APK Signing

This project uses a **maintainable debug keystore** that is committed to the repository
(`keystore/debug.keystore`). This ensures:

- All developers sign debug builds with the **same key** — no per-machine setup needed.
- Services that require a consistent SHA-1 / SHA-256 fingerprint (e.g. Firebase, Google Maps,
  Android App Links) work reliably in debug builds across the whole team and in CI/CD.

### Keystore details

| Property       | Value                      |
|----------------|----------------------------|
| File           | `keystore/debug.keystore`  |
| Store password | `android`                  |
| Key alias      | `androiddebugkey`          |
| Key password   | `android`                  |

These credentials are also stored in `keystore.properties` and are read automatically by
`app/build.gradle` during the build.

### Getting the SHA fingerprint

```bash
keytool -list -v \
  -keystore keystore/debug.keystore \
  -storepass android
```

### Security note

The debug keystore is intentionally **not secret** — it is only used to sign debug builds
and must never be used for production/release APKs. A separate release keystore should be
stored securely outside the repository and injected via CI/CD secrets.

## Building

```bash
./gradlew assembleDebug
```

The signed debug APK will be generated at `app/build/outputs/apk/debug/app-debug.apk`.
