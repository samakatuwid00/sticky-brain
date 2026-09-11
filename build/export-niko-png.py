#!/usr/bin/env python3
"""Render Niko sprite grid JSON -> clear PNGs (transparent + avatar)."""
import json, sys
from PIL import Image

PAL = {'b': (198, 113, 57), 'a': (224, 149, 92), 'd': (141, 131, 117)}  # dark theme: accent, accent-hi, text-dim
GROUND = (15, 14, 12)  # --ground #0f0e0c, shows through carved eyes on the board

data = json.load(open(sys.argv[1]))
grid = data['grid']
W = data['W']

# expand half-block cells to a 13x12 pixel grid; track bbox
px = []
rmin = cmin = 99
rmax = cmax = -1
for ri, row in enumerate(grid):
    for ci, cell in enumerate(row):
        if not cell or cell['ch'] == ' ':
            continue
        ch, k = cell['ch'], cell['k']
        color = PAL.get(k, PAL['b'])
        for y in (ri * 2, ri * 2 + 1):
            for x in (ci,):
                if (ch == '█') or (ch == '▀' and y % 2 == 0) or (ch == '▄' and y % 2 == 1):
                    px.append((x, y, color))
                    rmin, cmin = min(rmin, y), min(cmin, x)
                    rmax, cmax = max(rmax, y), max(cmax, x)

ph = rmax - rmin + 1  # 12
pw = cmax - cmin + 1  # 13

def draw(scale, bg=None):
    img = Image.new('RGBA', (pw * scale, ph * scale), bg or (0, 0, 0, 0))
    for (x, y, c) in px:
        for dy in range(scale):
            for dx in range(scale):
                img.putpixel(((x - cmin) * scale + dx, (y - rmin) * scale + dy), (*c, 255))
    return img

# 1) transparent sprite, square pixels (HD)
draw(80).save(sys.argv[2])  # 1040x640

# 2) 1024x1024 avatar, dark ground bg, centered
av = Image.new('RGBA', (1024, 1024), (*GROUND, 255))
s = draw(76)  # 988x608, fits 1024 with margin
av.paste(s, ((1024 - s.width) // 2, (1024 - s.height) // 2), s)
av.save(sys.argv[3])
print(f'sprite {pw}x{ph}px -> {sys.argv[2]}, avatar -> {sys.argv[3]}')
