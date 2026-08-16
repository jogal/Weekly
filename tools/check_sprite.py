#!/usr/bin/env python3
"""スプライトのプロポーション検査 (SPRITE_GUIDE.md の数値ゲート).

使い方: python3 tools/check_sprite.py sprites/monk_lv1x2.png [...]
2コマシート(x2)はフレーム1(左半分)を計測する。
基準: 頭幅/身長=0.298±0.010, 肩幅/身長=0.316±0.015, 最大幅/身長<=0.43
"""
import sys
from PIL import Image

HEAD, HEAD_TOL = 0.298, 0.010
SHOULDER, SHOULDER_TOL = 0.316, 0.015
MAXW_LIMIT = 0.43

def analyze(path):
    im = Image.open(path).convert("RGBA")
    if path.endswith("x2.png"):
        im = im.crop((0, 0, im.width // 2, im.height))
    px = im.load()
    rows = []
    for y in range(im.height):
        xs = [x for x in range(im.width) if px[x, y][3] > 0]
        rows.append((min(xs), max(xs)) if xs else None)
    ys = [y for y, r in enumerate(rows) if r]
    top, bot = min(ys), max(ys)
    height = bot - top + 1

    def band_width(a, b):
        seg = [rows[y] for y in range(top + int(height * a), top + int(height * b)) if rows[y]]
        return max(r[1] - r[0] + 1 for r in seg)

    head = band_width(0.05, 0.25) / height
    shoulder = band_width(0.28, 0.42) / height
    maxw = max(r[1] - r[0] + 1 for r in rows if r) / height

    ok_head = abs(head - HEAD) <= HEAD_TOL
    ok_sh = abs(shoulder - SHOULDER) <= SHOULDER_TOL
    ok_w = maxw <= MAXW_LIMIT
    verdict = "PASS" if (ok_head and ok_sh and ok_w) else "FAIL"
    print(f"{path}")
    print(f"  頭幅/身長   {head:.3f}  (基準 {HEAD}±{HEAD_TOL})  {'OK' if ok_head else 'NG'}")
    print(f"  肩幅/身長   {shoulder:.3f}  (基準 {SHOULDER}±{SHOULDER_TOL})  {'OK' if ok_sh else 'NG'}")
    print(f"  最大幅/身長 {maxw:.3f}  (上限 {MAXW_LIMIT})  {'OK' if ok_w else 'NG'}")
    print(f"  → {verdict}")
    return verdict == "PASS"

if __name__ == "__main__":
    paths = sys.argv[1:] or ["sprites/monk_lv1x2.png"]
    results = [analyze(p) for p in paths]
    sys.exit(0 if all(results) else 1)
