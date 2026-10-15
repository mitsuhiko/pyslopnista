#!/bin/sh
# Xcode build phase: copy the built web app, the Pyodide cores and the Python
# docs (one of each per runtime in runtimes.json, D37) into the bundle (web/
# is served under app://app/). Run `npm run build` in app/web,
# scripts/fetch-pyodide.sh and scripts/build-docs.py first (run.sh does).
set -e
APP_DIR="${PROJECT_DIR}/.."
DIST="$APP_DIR/web/dist"
RUNTIMES="$APP_DIR/runtimes.json"
DEST="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/web"
[ -f "$DIST/engine.html" ] || { echo "error: $DIST missing; run npm run build in app/web" >&2; exit 1; }
rm -rf "$DEST"
mkdir -p "$DEST/pyodide" "$DEST/docs"
cp -R "$DIST/." "$DEST/"
find "$DEST" -name "*.map" -delete
cp "$RUNTIMES" "$DEST/runtimes.json"
COUNT=$(plutil -extract runtimes raw -o - "$RUNTIMES")
i=0
while [ "$i" -lt "$COUNT" ]; do
  PYTHON=$(plutil -extract "runtimes.$i.python" raw -o - "$RUNTIMES")
  PYODIDE=$(plutil -extract "runtimes.$i.pyodide" raw -o - "$RUNTIMES")
  VENDOR="$APP_DIR/vendor/pyodide-$PYODIDE"
  DOCS="$APP_DIR/vendor/docs-$PYTHON"
  [ -d "$VENDOR" ] || { echo "error: $VENDOR missing; run app/scripts/fetch-pyodide.sh" >&2; exit 1; }
  [ -f "$DOCS/docs.sqlite" ] || { echo "error: $DOCS missing; run app/scripts/build-docs.py" >&2; exit 1; }
  mkdir -p "$DEST/pyodide/$PYTHON"
  for f in pyodide.mjs pyodide.asm.mjs pyodide.asm.wasm python_stdlib.zip pyodide-lock.json; do
    cp "$VENDOR/$f" "$DEST/pyodide/$PYTHON/"
  done
  # Clones on APFS: the docs are large and this phase runs on every build.
  cp -Rc "$DOCS/html" "$DEST/docs/$PYTHON" 2>/dev/null || cp -R "$DOCS/html" "$DEST/docs/$PYTHON"
  cp -c "$DOCS/docs.sqlite" "$DEST/docs/$PYTHON.sqlite" 2>/dev/null || cp "$DOCS/docs.sqlite" "$DEST/docs/$PYTHON.sqlite"
  i=$((i + 1))
done
