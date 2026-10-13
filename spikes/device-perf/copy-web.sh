#!/bin/sh
# Xcode build phase: copy the web runtime, the UI toolkit, the JSPI tests and
# the Pyodide core into the app bundle (web/ is served under app://app/).
set -e
SPIKES="${PROJECT_DIR}/.."
VENDOR="$SPIKES/pyodide-worker/vendor/pyodide-314.0.7"
DEST="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/web"

if [ ! -d "$VENDOR" ]; then
  echo "error: $VENDOR missing; run spikes/pyodide-worker/run.sh once to download Pyodide" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST/pyodide"
cp -R "$SPIKES/pyodide-worker/web/." "$DEST/"
cp -R "$SPIKES/ui-toolkit/web" "$DEST/ui"
cp -R "$SPIKES/jspi-repro/web" "$DEST/jspi"
cp -R "${PROJECT_DIR}/web/." "$DEST/"
for f in pyodide.mjs pyodide.asm.mjs pyodide.asm.wasm python_stdlib.zip pyodide-lock.json; do
  cp "$VENDOR/$f" "$DEST/pyodide/"
done
