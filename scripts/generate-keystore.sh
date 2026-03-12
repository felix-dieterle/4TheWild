#!/usr/bin/env bash
# Generate a custom signing keystore and print its base64 encoding.
# Store the output as the KEYSTORE_BASE64 repository secret to override
# the default debug keystore committed at android/app/debug.keystore.
#
# Usage: ./scripts/generate-keystore.sh [output-file]
#   output-file  Path to write the keystore (default: my-release-key.keystore)

set -euo pipefail

OUT="${1:-my-release-key.keystore}"

keytool -genkeypair -v \
  -keystore "$OUT" \
  -alias androiddebugkey \
  -keyalg RSA -keysize 2048 \
  -validity 10000 \
  -storepass android \
  -keypass android \
  -dname "CN=Android Debug,O=Android,C=US"

echo ""
echo "Keystore written to: $OUT"
echo ""
echo "Base64-encode it and store as the KEYSTORE_BASE64 repository secret:"
echo ""
base64 "$OUT" | tr -d '\n'
echo ""
