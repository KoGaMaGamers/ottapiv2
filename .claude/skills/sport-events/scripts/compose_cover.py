#!/home/ottapi/.venv/bin/python
"""Side-by-side composite cover for a sport event.

Used by ingest.py as the cover-image fallback: when Claude couldn't
find a single high-quality cover image but did find both teams' logos,
we synthesise a 1600x900 hero with the two logos and a "VS" between.

Args via CLI (not stdin — called once per event):
    --home-logo-url URL
    --away-logo-url URL
    --slug         FILENAME-SAFE-SLUG     (e.g. real-madrid-vs-barcelona-20260512)
    --out-dir      /path/to/static/sport-events/

On success, prints a JSON line like:
    {"public_url": "/static/sport-events/<slug>.jpg",
     "disk_path":  "/path/<slug>.jpg"}

On failure, prints {"error": "..."} and exits non-zero.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sys
from typing import Tuple

import requests
from PIL import Image, ImageDraw, ImageFont, ImageOps

CANVAS_W = 1600
CANVAS_H = 900
LOGO_BOX = 512        # max longest-edge of each logo after scaling
LOGO_TIMEOUT = 8      # seconds per logo download
JPEG_QUALITY = 85

# Two-stop gradient palettes — picked deterministically per slug so
# repeated runs of the same event keep the same cover.
_GRADIENTS: list[Tuple[Tuple[int, int, int], Tuple[int, int, int]]] = [
    ((10, 24, 56),  (88, 18, 40)),     # navy → maroon
    ((6, 38, 28),   (78, 8, 64)),      # forest → magenta
    ((38, 12, 58),  (10, 60, 88)),     # purple → teal
    ((52, 16, 14),  (92, 64, 8)),      # rust → amber
    ((8, 36, 64),   (56, 12, 80)),     # deep blue → indigo
    ((24, 6, 22),   (120, 20, 30)),    # plum → crimson
    ((4, 42, 50),   (16, 16, 78)),     # cyan-shadow → midnight
    ((50, 10, 20),  (10, 50, 30)),     # blood → bottle
]


def _pick_gradient(slug: str) -> Tuple[Tuple[int, int, int], Tuple[int, int, int]]:
    h = int(hashlib.sha256(slug.encode("utf-8")).hexdigest()[:8], 16)
    return _GRADIENTS[h % len(_GRADIENTS)]


def _gradient_canvas(slug: str) -> Image.Image:
    top, bottom = _pick_gradient(slug)
    base = Image.new("RGB", (CANVAS_W, CANVAS_H))
    px = base.load()
    for y in range(CANVAS_H):
        t = y / max(1, CANVAS_H - 1)
        r = int(top[0] * (1 - t) + bottom[0] * t)
        g = int(top[1] * (1 - t) + bottom[1] * t)
        b = int(top[2] * (1 - t) + bottom[2] * t)
        for x in range(CANVAS_W):
            px[x, y] = (r, g, b)
    return base


_HTTP_HEADERS = {
    # Wikimedia / many CDNs reject default python-requests UA.
    "User-Agent":
        "ottapi-sport-events/1.0 (https://github.com/appelungeek/ottapi)",
    "Accept": "image/*,*/*;q=0.8",
}


def _download_logo(url: str) -> Image.Image:
    resp = requests.get(url, timeout=LOGO_TIMEOUT, stream=True, headers=_HTTP_HEADERS)
    resp.raise_for_status()
    img = Image.open(io.BytesIO(resp.content))
    img = ImageOps.exif_transpose(img)
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    bbox = img.getbbox()
    if bbox:
        img = img.crop(bbox)
    img.thumbnail((LOGO_BOX, LOGO_BOX), Image.Resampling.LANCZOS)
    return img


def _paste_centered(canvas: Image.Image, logo: Image.Image, cx: int, cy: int) -> None:
    x = cx - logo.width // 2
    y = cy - logo.height // 2
    canvas.paste(logo, (x, y), logo)


def _draw_vs(canvas: Image.Image) -> None:
    draw = ImageDraw.Draw(canvas)
    label = "VS"
    # Try a heavy system font; fall back to PIL's default if unavailable.
    font = None
    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    ):
        if os.path.exists(path):
            try:
                font = ImageFont.truetype(path, size=140)
                break
            except OSError:
                continue
    if font is None:
        font = ImageFont.load_default()

    bbox = draw.textbbox((0, 0), label, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    cx = CANVAS_W // 2
    cy = CANVAS_H // 2
    # Soft drop shadow.
    for ox, oy, alpha in ((4, 4, 160), (2, 2, 200)):
        draw.text(
            (cx - tw // 2 + ox, cy - th // 2 + oy),
            label, font=font, fill=(0, 0, 0, alpha),
        )
    draw.text((cx - tw // 2, cy - th // 2), label, font=font, fill="white")


def compose(
    home_logo_url: str,
    away_logo_url: str,
    slug: str,
    out_dir: str,
) -> Tuple[str, str]:
    os.makedirs(out_dir, exist_ok=True)
    home = _download_logo(home_logo_url)
    away = _download_logo(away_logo_url)

    canvas = _gradient_canvas(slug)
    _paste_centered(canvas, home, int(CANVAS_W * 0.30), CANVAS_H // 2)
    _paste_centered(canvas, away, int(CANVAS_W * 0.70), CANVAS_H // 2)
    _draw_vs(canvas)

    disk_path = os.path.join(out_dir, f"{slug}.jpg")
    canvas.save(disk_path, format="JPEG", quality=JPEG_QUALITY, optimize=True)

    # Public path served by the FastAPI app's StaticFiles mount.
    public_url = f"/static/sport-events/{slug}.jpg"
    return public_url, disk_path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--home-logo-url", required=True)
    ap.add_argument("--away-logo-url", required=True)
    ap.add_argument("--slug",          required=True)
    ap.add_argument("--out-dir",       required=True)
    args = ap.parse_args()

    try:
        public_url, disk_path = compose(
            args.home_logo_url, args.away_logo_url, args.slug, args.out_dir,
        )
    except Exception as e:
        json.dump({"error": str(e)}, sys.stdout)
        sys.stdout.write("\n")
        return 1

    json.dump({"public_url": public_url, "disk_path": disk_path}, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
