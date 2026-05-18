#!/usr/bin/env bash
# generate-keystore.sh
#
# One-time helper: creates a persistent debug keystore and prints the
# base64-encoded value that must be stored as the KEYSTORE_BASE64
# repository secret so that every CI build is signed with the same key.
#
# Usage:
#   bash scripts/generate-keystore.sh
#
# After running this script:
#   1. Copy the printed base64 string.
#   2. Go to GitHub → Repository → Settings → Secrets and variables → Actions
#   3. Create a new repository secret named KEYSTORE_BASE64 and paste the value.
#
# The keystore file itself (debug.keystore) is only needed locally for this
# one-time setup step.  Do NOT commit it to the repository.

set -euo pipefail

KEYSTORE_FILE="debug.keystore"
ALIAS="androiddebugkey"
STOREPASS="android"
KEYPASS="android"
DNAME="CN=Android Debug,O=Android,C=US"

echo "Generating $KEYSTORE_FILE ..."
keytool -genkeypair -v \
  -keystore "$KEYSTORE_FILE" \
  -alias "$ALIAS" \
  -keyalg RSA -keysize 2048 \
  -validity 10000 \
  -storepass "$STOREPASS" \
  -keypass "$KEYPASS" \
  -dname "$DNAME"

echo ""
echo "========================================================================"
echo "  KEYSTORE_BASE64 secret value (copy everything between the lines):"
echo "========================================================================"
if [[ "$(uname)" == "Darwin" ]]; then
  base64 "$KEYSTORE_FILE"
else
  base64 -w 0 "$KEYSTORE_FILE"
fi
echo ""
echo "========================================================================"
echo ""
echo "Next steps:"
echo "  1. Copy the base64 string printed above."
echo "  2. GitHub → Repo → Settings → Secrets and variables → Actions"
echo "  3. New repository secret  →  Name: KEYSTORE_BASE64  →  paste value."
echo ""
echo "You can delete $KEYSTORE_FILE afterwards; it is no longer needed."
