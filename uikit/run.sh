#!/usr/bin/env bash
# ui.py workspace.
#   ./run.sh              serve the playground at http://127.0.0.1:18770/playground/
#   ./run.sh --test       Python tests on the host (pytest via uv)
#   ./run.sh --selftest   Python tests, then the browser selftest in headless Chrome (JSON)
#                         (ONLY=<step> for a subset, OFFLINE=1 to skip the CDN-backed plot step)
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-18770}"

test_python() {
  uv run --quiet --python 3.14 --with pytest pytest -q tests
}

case "${1:-}" in
  --test)
    test_python
    ;;
  --selftest)
    test_python
    python3 scripts/serve.py "$PORT" >/dev/null &
    SERVER=$!
    trap 'kill $SERVER 2>/dev/null' EXIT
    sleep 0.5
    HASH="selftest"
    [[ -n "${ONLY:-}" ]] && HASH="$HASH&only=$ONLY"
    [[ -n "${OFFLINE:-}" ]] && HASH="$HASH&offline=1"
    node scripts/selftest.mjs "http://127.0.0.1:$PORT/playground/#$HASH" "${TIMEOUT:-240}"
    ;;
  *)
    exec python3 scripts/serve.py "$PORT"
    ;;
esac
