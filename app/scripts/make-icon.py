# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow"]
# ///
"""Render the app icon.

Writes the SVG sources to app/ios/icon/ and renders the 1024px PNGs (light,
dark, tinted) into the asset catalog with resvg (brew install resvg).
Xcode derives every other size from the single 1024px image.

    uv run app/scripts/make-icon.py [--preview]
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

APP = Path(__file__).resolve().parent.parent
SRC = APP / "ios" / "icon"
ICONSET = APP / "ios" / "Sources" / "Assets.xcassets" / "AppIcon.appiconset"

# The artwork is drawn in the coordinates of the original sketch (about
# 1254 x 1254) and scaled into the 1024 x 1024 icon, inside the area the
# iOS squircle mask leaves alone.
ART = """
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{bg_top}"/>
      <stop offset="1" stop-color="{bg_bottom}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.42" cy="0.40" r="0.62">
      <stop offset="0" stop-color="{glow}" stop-opacity="{glow_opacity}"/>
      <stop offset="1" stop-color="{glow}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="blue" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{blue_hi}"/>
      <stop offset="1" stop-color="{blue}"/>
    </linearGradient>
    <linearGradient id="yellow" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{yellow_hi}"/>
      <stop offset="1" stop-color="{yellow}"/>
    </linearGradient>
    <path id="cursor" d="M 862 742 L 1172 922 L 1078 956 L 1128 1072 L 1060 1112 L 992 1004 L 918 1082 Z"/>
    <mask id="gap" maskUnits="userSpaceOnUse" x="0" y="0" width="1254" height="1254">
      <rect width="1254" height="1254" fill="white"/>
      <use href="#cursor" fill="black" stroke="black" stroke-width="{gap}" stroke-linejoin="round"/>
    </mask>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="14"/>
      <feOffset dy="12"/>
      <feComponentTransfer><feFuncA type="linear" slope="{shadow}"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  {background}
  <g transform="translate(512 512) scale({scale}) translate(-632 -628)">
    <g filter="url(#shadow)">
      <g mask="url(#gap)">
        <g transform="translate(632 628) skewY(-6) translate(-632 -628)">
          <!-- window frame with its title bar -->
          <path fill="url(#blue)" fill-rule="evenodd" d="
            M 180 214 H 1084 A 112 112 0 0 1 1196 326 V 948 A 112 112 0 0 1 1084 1060 H 180 A 112 112 0 0 1 68 948 V 326 A 112 112 0 0 1 180 214 Z
            M 216 392 H 1056 A 58 58 0 0 1 1114 450 V 920 A 58 58 0 0 1 1056 978 H 216 A 58 58 0 0 1 158 920 V 450 A 58 58 0 0 1 216 392 Z"/>
          <!-- traffic lights -->
          <rect x="168" y="262" width="96" height="78" rx="36" fill="url(#yellow)"/>
          <rect x="304" y="262" width="96" height="78" rx="36" fill="{blue_dark}"/>
          <rect x="440" y="262" width="96" height="78" rx="36" fill="url(#yellow)"/>
          <!-- { and the code lines -->
          <path fill="none" stroke="{blue}" stroke-width="74" stroke-linecap="round" stroke-linejoin="round"
                d="M 350 496 C 296 500 282 528 288 572 L 296 630 C 302 680 286 702 244 718 C 286 734 302 756 300 806 L 298 864 C 297 902 316 912 354 914"/>
          <g fill="none" stroke-width="80" stroke-linecap="round">
            <path stroke="{yellow}" d="M 470 496 H 796"/>
            <path stroke="{blue}" d="M 436 616 H 616"/>
            <path stroke="{yellow}" d="M 448 736 H 762"/>
            <path stroke="{blue}" d="M 466 856 H 606"/>
          </g>
        </g>
      </g>
    </g>
    <!-- pointer -->
    <g filter="url(#shadow)">
      <use href="#cursor" fill="url(#yellow)" stroke="url(#yellow)" stroke-width="44" stroke-linejoin="round"/>
    </g>
  </g>
"""

PALETTES = {
    "light": dict(
        bg_top="#26324a", bg_bottom="#0c1220", glow="#3f78c4", glow_opacity="0.45",
        blue="#3776ab", blue_hi="#4a8fd0", blue_dark="#1f4f8f",
        yellow="#ffd43b", yellow_hi="#ffe36e", shadow="0.45", gap="108",
    ),
    "dark": dict(
        bg_top="#151a24", bg_bottom="#05070b", glow="#3f78c4", glow_opacity="0.22",
        blue="#3f82c0", blue_hi="#5599dc", blue_dark="#22528f",
        yellow="#ffd43b", yellow_hi="#ffe36e", shadow="0.6", gap="108",
    ),
    # iOS tints a grayscale image: white is full tint, black is background.
    "tinted": dict(
        bg_top="#000000", bg_bottom="#000000", glow="#000000", glow_opacity="0",
        blue="#8a8a8a", blue_hi="#9a9a9a", blue_dark="#4a4a4a",
        yellow="#ffffff", yellow_hi="#ffffff", shadow="0", gap="108",
    ),
}

SCALE = 0.70


def svg(variant: str, *, rounded: bool = False) -> str:
    p = PALETTES[variant]
    bg = '<rect width="1024" height="1024" fill="url(#bg)"/>\n  <rect width="1024" height="1024" fill="url(#glow)"/>'
    if rounded:  # preview only: what the home screen mask leaves
        bg = '<clipPath id="squircle"><rect width="1024" height="1024" rx="229"/></clipPath>\n  <g clip-path="url(#squircle)">' + bg + "</g>"
    body = ART.replace("{background}", bg)
    for k, v in {**p, "scale": SCALE}.items():
        body = body.replace("{" + k + "}", str(v))
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        'width="1024" height="1024" viewBox="0 0 1024 1024">' + body + "</svg>\n"
    )


def render(svg_path: Path, png_path: Path, size: int = 1024) -> None:
    subprocess.run(["resvg", "-w", str(size), "-h", str(size), str(svg_path), str(png_path)], check=True)
    # App Store icons must not have an alpha channel.
    Image.open(png_path).convert("RGB").save(png_path, optimize=True)


def main() -> None:
    if not shutil.which("resvg"):
        sys.exit("resvg not found (brew install resvg)")
    SRC.mkdir(parents=True, exist_ok=True)
    ICONSET.mkdir(parents=True, exist_ok=True)
    images = []
    for variant in PALETTES:
        name = "AppIcon" if variant == "light" else f"AppIcon-{variant}"
        path = SRC / f"{name}.svg"
        path.write_text(svg(variant))
        render(path, ICONSET / f"{name}.png")
        image = {"filename": f"{name}.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"}
        if variant != "light":
            image["appearances"] = [{"appearance": "luminosity", "value": variant}]
        images.append(image)
    (ICONSET / "Contents.json").write_text(
        json.dumps({"images": images, "info": {"author": "xcode", "version": 1}}, indent=2) + "\n"
    )
    (ICONSET.parent / "Contents.json").write_text(
        json.dumps({"info": {"author": "xcode", "version": 1}}, indent=2) + "\n"
    )
    if "--preview" in sys.argv:
        out = APP / "build" / "icon-preview"
        out.mkdir(parents=True, exist_ok=True)
        for variant in PALETTES:
            p = out / f"{variant}.svg"
            p.write_text(svg(variant, rounded=True))
            render(p, out / f"{variant}.png", 512)
            render(p, out / f"{variant}-60.png", 60)
        print(out)


if __name__ == "__main__":
    main()
