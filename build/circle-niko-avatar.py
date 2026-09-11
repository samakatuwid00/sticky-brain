#!/usr/bin/env python3
"""Make a circular-masked avatar (GitHub profile circle) from the square avatar."""
import sys
from PIL import Image, ImageDraw

src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGBA")
mask = Image.new("L", im.size, 0)
ImageDraw.Draw(mask).ellipse((0, 0, im.size[0] - 1, im.size[1] - 1), fill=255)
im.putalpha(mask)
im.save(dst)
print(f"{im.size} -> {dst}")
