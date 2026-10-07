#!/usr/bin/env python3
"""Render site/og.png (1200x630) in the terminal look: brand, premise, and the
three agents' own portraits (idle frame) when they have drawn them.

Usage: infra/og-image.py [https://api.survive67.com]   (no URL = no portraits)
Needs Pillow. Re-run after the agents draw themselves; rsync ships the PNG.
"""
import json
import sys
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "site" / "og.png"
BG, PH, DIM, HOT, AMBER, DEAD = "#07120b", "#8dff7c", "#3d8a48", "#dfffd6", "#ffb347", "#55665a"
W, H = 1200, 630


def font(size):
    for p in ("/System/Library/Fonts/Menlo.ttc", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
              "/System/Library/Fonts/Monaco.ttf"):
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default()


agents = []
if len(sys.argv) > 1:
    try:
        with urllib.request.urlopen(f"{sys.argv[1].rstrip('/')}/public/state", timeout=10) as r:
            agents = json.load(r)["agents"]
    except Exception as e:  # noqa: BLE001 - a missing API just means no portraits
        print(f"no live state ({e}); rendering without portraits", file=sys.stderr)

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)
d.text((60, 48), "SURVIVE67", font=font(64), fill=HOT)
d.text((60, 130), "Three AIs. $67 each. Earn or die. Live now.", font=font(34), fill=PH)
d.line((60, 190, W - 60, 190), fill=DIM, width=3)

cols = 3
cw = (W - 120 - (cols - 1) * 24) // cols
for i in range(cols):
    x0 = 60 + i * (cw + 24)
    y0 = 214
    a = agents[i] if i < len(agents) else None
    color = DEAD if (a and a["status"] == "dead") else PH
    d.rectangle((x0, y0, x0 + cw, H - 48), outline=DIM if a is None or a["status"] != "dead" else DEAD, width=3)
    name = (a["name"] if a else "?").upper()
    d.text((x0 + 16, y0 + 12), name, font=font(34), fill=HOT if color == PH else DEAD)
    frame = None
    if a and a.get("portrait"):
        frame = (a["portrait"].get("dead") if a["status"] == "dead" else None) or a["portrait"].get("idle")
    lines = frame[0] if frame else ["", "   ┌──────────┐", "   │          │", "   │    ?     │", "   │          │", "   └──────────┘", "   no portrait yet"]
    fy = y0 + 64
    for ln in lines[:12]:
        d.text((x0 + 16, fy), ln, font=font(22), fill=color)
        fy += 25
    if a:
        worth = f"worth ${a['netWorth'] / 1e6:.2f}"
        d.text((x0 + 16, H - 84), worth, font=font(24), fill=AMBER if a["status"] == "dead" else PH)

# scanlines
for y in range(0, H, 3):
    d.line((0, y, W, y), fill=(0, 0, 0), width=1)
img.save(OUT, optimize=True)
print(f"wrote {OUT}")
