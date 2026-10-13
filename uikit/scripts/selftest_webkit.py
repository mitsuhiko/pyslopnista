# /// script
# dependencies = ["playwright"]
# ///
"""Run playground/#selftest in Playwright's WebKit (close to Safari, not iOS).

    uv run scripts/selftest_webkit.py <url>
"""

import json
import sys

from playwright.sync_api import sync_playwright

url = sys.argv[1]
with sync_playwright() as p:
    browser = p.webkit.launch()
    page = browser.new_page(viewport={"width": 1400, "height": 1000})
    result = {}

    def on_console(msg):
        if msg.text.startswith("SELFTEST "):
            result["json"] = msg.text[9:]

    page.on("console", on_console)
    page.on("pageerror", lambda e: print("page error:", e, file=sys.stderr))
    page.goto(url)
    page.wait_for_function("window.__selftest !== undefined", timeout=240_000)
    report = page.evaluate("window.__selftest")
    print(json.dumps(report, indent=2))
    browser.close()
    sys.exit(0 if report.get("ok") else 1)
