#!/bin/bash
# Download the pinned Pyodide cores listed in runtimes.json into app/vendor
# (gitignored): vendor/pyodide-<pyodide version>.
set -euo pipefail
cd "$(dirname "$0")/.."
for spec in $(node -e 'for (const r of require("./runtimes.json").runtimes) console.log(`${r.pyodide}:${r.version}`)'); do
  VERSION=${spec%%:*}
  PYTHON=${spec#*:}
  DEST=vendor/pyodide-$VERSION
  [ -d "$DEST" ] && continue
  mkdir -p vendor
  TMP=$(mktemp -d)
  (cd "$TMP" && npm pack --loglevel=error "pyodide@$VERSION" >/dev/null && tar xzf "pyodide-$VERSION.tgz")
  # runtimes.json states the Python version; it must be the one the core has.
  HAS=$(node -e "console.log(require('$TMP/package/pyodide-lock.json').info.python)")
  [ "$HAS" = "$PYTHON" ] || { echo "error: Pyodide $VERSION has Python $HAS, runtimes.json says $PYTHON" >&2; exit 1; }
  mv "$TMP/package" "$DEST"
  rm -rf "$TMP"
  echo "fetched Pyodide $VERSION (Python $PYTHON) into $DEST"
done
