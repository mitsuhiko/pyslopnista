#!/bin/sh
# Xcode build phase: copy the built web app and the Pyodide core into the
# bundle (web/ is served under app://app/). Run `npm run build` in app/web first
# (run.sh does).
set -e
APP_DIR="${PROJECT_DIR}/.."
DIST="$APP_DIR/web/dist"
VENDOR="$APP_DIR/vendor/pyodide-314.0.7"
DEST="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/web"
[ -f "$DIST/engine.html" ] || { echo "error: $DIST missing; run npm run build in app/web" >&2; exit 1; }
[ -d "$VENDOR" ] || { echo "error: $VENDOR missing; run app/scripts/fetch-pyodide.sh" >&2; exit 1; }
rm -rf "$DEST"
mkdir -p "$DEST/pyodide"
cp -R "$DIST/." "$DEST/"
find "$DEST" -name "*.map" -delete
for f in pyodide.mjs pyodide.asm.mjs pyodide.asm.wasm python_stdlib.zip pyodide-lock.json; do
  cp "$VENDOR/$f" "$DEST/pyodide/"
done
