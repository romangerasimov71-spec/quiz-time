#!/usr/bin/env python3
"""Android app icons from the VK icon of the app (release/vk/icons/icon-576.png).
Run: python3 android/tools/make_icons.py   (needs Pillow). Writes android/app/src/main/res/mipmap-*/
and release/rustore/icon-512.png."""
import os
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
RES = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res')
ART = Image.open(os.path.join(ROOT, 'release', 'vk', 'icons', 'icon-576.png')).convert('RGB')
DENS = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}


def save(img, *parts):
    p = os.path.join(*parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    img.save(p, optimize=True)


def adaptive(px):
    """108dp layer: the art at 90dp in the middle, the edges filled with the blurred art (no hard border)."""
    bg = ART.resize((px, px), Image.LANCZOS).filter(ImageFilter.GaussianBlur(px / 24))
    sz = round(px * 90 / 108)
    bg.paste(ART.resize((sz, sz), Image.LANCZOS), ((px - sz) // 2, (px - sz) // 2))
    return bg


for name, k in DENS.items():
    d = os.path.join(RES, 'mipmap-' + name)
    legacy = round(48 * k)
    sq = ART.resize((legacy, legacy), Image.LANCZOS)
    save(sq, d, 'ic_launcher.png')
    mask = Image.new('L', (legacy * 4, legacy * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, legacy * 4 - 1, legacy * 4 - 1), fill=255)
    rnd = Image.new('RGBA', (legacy, legacy), (0, 0, 0, 0))
    rnd.paste(sq, (0, 0), mask.resize((legacy, legacy), Image.LANCZOS))
    save(rnd, d, 'ic_launcher_round.png')
    save(adaptive(round(108 * k)), d, 'ic_launcher_background.png')

save(ART.resize((512, 512), Image.LANCZOS), ROOT, 'release', 'rustore', 'icon-512.png')
print('icons ok')
