#!/usr/bin/env bash
# Copy the ui module into the app (the app's copies are generated; edit them here).
set -euo pipefail
cd "$(dirname "$0")/.."
APP=../app/web
cp python/ui.py "$APP/public/runtime/python/ui.py"
cp web/renderer.js "$APP/src/uiRenderer.js"
cp web/ui.css "$APP/src/ui-toolkit.css"
cp "examples/Todo App.py" "$APP/public/examples/Todo App.py"
echo "installed ui.py, uiRenderer.js, ui-toolkit.css and Todo App.py into app/web"
