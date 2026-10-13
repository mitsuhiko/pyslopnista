#!/bin/bash
# Run the UI toolkit playground inside the pyodide-worker host app.
#   ./run.sh              launch the playground (interactive)
#   ./run.sh --selftest   run the scripted checks and print JSON
set -euo pipefail
cd "$(dirname "$0")"
export EXTRA_WEB="$PWD/web:ui"
export PAGE="ui/index.html"
exec ../pyodide-worker/run.sh "$@"
