#!/bin/bash
# Download the pinned Pyodide core into app/vendor (gitignored).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=314.0.7
DEST=vendor/pyodide-$VERSION
[ -d "$DEST" ] && exit 0
mkdir -p vendor
TMP=$(mktemp -d)
(cd "$TMP" && npm pack "pyodide@$VERSION" >/dev/null && tar xzf "pyodide-$VERSION.tgz")
mv "$TMP/package" "$DEST"
rm -rf "$TMP"
echo "fetched Pyodide $VERSION into $DEST"
