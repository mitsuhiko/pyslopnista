"""Export a ui-toolkit app as a static site (D5).

    uv run export.py web/examples/todo.py dist/todo [--title Todos] [--no-jspi]

The output is plain static files: the app's code, ui.py, the renderer and the
worker runtime. Pyodide is loaded from the jsDelivr CDN at the pinned version.
It works on hosts without cross-origin isolation headers (no SharedArrayBuffer:
no input(), no Stop; neither is needed by UI apps).
"""

import argparse
import json
import pathlib
import shutil

HERE = pathlib.Path(__file__).parent
RUNTIME = HERE.parent / "pyodide-worker" / "web"
PYODIDE_VERSION = "314.0.7"

INDEX_HTML = """<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="{title}">
<title>{title}</title>
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon.svg">
<link rel="apple-touch-icon" href="icon.svg">
<link rel="stylesheet" href="ui.css">
<style>
  html, body {{ margin: 0; min-height: 100%; }}
  body {{ padding-top: env(safe-area-inset-top); }}
  #splash {{ position: fixed; inset: 0; display: grid; place-items: center; font: 15px -apple-system, system-ui; color: #888; }}
  #error {{ white-space: pre-wrap; font: 12px ui-monospace, monospace; color: #ff3b30; padding: 16px; }}
</style>
<body class="ui-root">
<div id="splash">Loading {title}…</div>
<div id="app"></div>
<pre id="error" hidden></pre>
<script type="module" src="standalone.js"></script>
</body>
</html>
"""

ICON_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180">
<rect width="180" height="180" rx="40" fill="#0a84ff"/>
<text x="90" y="118" font-size="96" text-anchor="middle" fill="#fff" font-family="-apple-system, system-ui, sans-serif" font-weight="700">{letter}</text>
</svg>
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("app", type=pathlib.Path)
    parser.add_argument("out", type=pathlib.Path)
    parser.add_argument("--title")
    parser.add_argument("--no-jspi", action="store_true", help="hide JSPI and keep the JS call trampoline")
    args = parser.parse_args()

    title = args.title or args.app.stem.replace("_", " ").title()
    out = args.out
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    shutil.copy(args.app, out / "app.py")
    for name in ("ui.py", "ui.css", "ui-renderer.js", "standalone.js"):
        shutil.copy(HERE / "web" / name, out / name)
    for name in ("runtime.js", "py-worker.js", "sab-polyfill.js"):
        shutil.copy(RUNTIME / name, out / name)

    cdn = f"https://cdn.jsdelivr.net/pyodide/v{PYODIDE_VERSION}/full/"
    config = {"title": title, "pyodide": cdn, "jspi": not args.no_jspi}
    (out / "app.json").write_text(json.dumps(config, indent=2) + "\n")
    (out / "index.html").write_text(INDEX_HTML.format(title=title))
    (out / "icon.svg").write_text(ICON_SVG.format(letter=title[:1].upper()))
    manifest = {
        "name": title,
        "short_name": title,
        "start_url": ".",
        "display": "standalone",
        "background_color": "#f2f2f7",
        "theme_color": "#f2f2f7",
        "icons": [{"src": "icon.svg", "sizes": "any", "type": "image/svg+xml"}],
    }
    (out / "manifest.webmanifest").write_text(json.dumps(manifest, indent=2) + "\n")

    size = sum(f.stat().st_size for f in out.iterdir())
    print(f"exported {args.app} -> {out} ({len(list(out.iterdir()))} files, {size / 1024:.0f} KiB + Pyodide from CDN)")


if __name__ == "__main__":
    main()
