#!/usr/bin/env python3
"""スプライトのプロポーション検査 (SPRITE_GUIDE.md の数値ゲート).

使い方: python3 tools/check_sprite.py sprites/monk_lv1x2.png [...]
2コマシート(x2)はフレーム1(左半分)を計測する。
基準: 頭蓋幅/身長=0.298±0.010(10-20%帯), 肩幅/身長=0.316±0.015(34-42%帯), 最大幅/身長<=0.43
※帯は鉢巻のリボン等の装飾を拾わない骨格位置で採る
"""
import sys
from collections import deque
from PIL import Image

HEAD, HEAD_TOL = 0.298, 0.010
SHOULDER, SHOULDER_TOL = 0.316, 0.015
MAXW_LIMIT = 0.43

def analyze(path):
    im = Image.open(path).convert("RGBA")
    if path.endswith("x2.png"):
        im = im.crop((0, 0, im.width // 2, im.height))
    px = im.load(); w, h = im.size
    # 最大連結成分(本体)のみを計測対象にする(光の粒などの浮遊装飾を無視)
    label = [[0] * w for _ in range(h)]
    comps = []; cur = 0
    for y0 in range(h):
        for x0 in range(w):
            if px[x0, y0][3] > 0 and label[y0][x0] == 0:
                cur += 1; size = 0
                q = deque([(x0, y0)]); label[y0][x0] = cur
                while q:
                    x, y = q.popleft(); size += 1
                    for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
                        nx, ny = x+dx, y+dy
                        if 0 <= nx < w and 0 <= ny < h and px[nx,ny][3] > 0 and label[ny][nx] == 0:
                            label[ny][nx] = cur; q.append((nx, ny))
                comps.append((size, cur))
    main = max(comps)[1]
    rows = []
    for y in range(h):
        xs = [x for x in range(w) if label[y][x] == main]
        rows.append((min(xs), max(xs)) if xs else None)
    ys = [y for y, r in enumerate(rows) if r]
    top, bot = min(ys), max(ys)
    height = bot - top + 1

    def band_width(a, b):
        seg = [rows[y] for y in range(top + int(height * a), top + int(height * b)) if rows[y]]
        return max(r[1] - r[0] + 1 for r in seg)

    head = band_width(0.10, 0.20) / height
    shoulder = band_width(0.34, 0.42) / height
    maxw = max(r[1] - r[0] + 1 for r in rows if r) / height

    ok_head = abs(head - HEAD) <= HEAD_TOL
    ok_sh = abs(shoulder - SHOULDER) <= SHOULDER_TOL
    limit = 0.46 if "_lv40" in path else MAXW_LIMIT   # Lv40のみ儀礼装束の裾例外
    ok_w = maxw <= limit
    verdict = "PASS" if (ok_head and ok_sh and ok_w) else "FAIL"
    print(f"{path}")
    print(f"  頭蓋幅/身長 {head:.3f}  (基準 {HEAD}±{HEAD_TOL})  {'OK' if ok_head else 'NG'}")
    print(f"  肩幅/身長   {shoulder:.3f}  (基準 {SHOULDER}±{SHOULDER_TOL})  {'OK' if ok_sh else 'NG'}")
    print(f"  最大幅/身長 {maxw:.3f}  (上限 {limit})  {'OK' if ok_w else 'NG'}")
    print(f"  → {verdict}")
    return verdict == "PASS"

if __name__ == "__main__":
    paths = sys.argv[1:] or ["sprites/monk_lv1x2.png"]
    results = [analyze(p) for p in paths]
    sys.exit(0 if all(results) else 1)
