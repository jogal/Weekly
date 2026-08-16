#!/usr/bin/env python3
"""art-inbox/ の生成画像を一括でスプライト化する。

使い方:
  1. 生成AIの出力(2コマ横並び・黒背景)を art-inbox/<job>_lv<帯>.png の名前で置く
     例: art-inbox/monk_lv10.png, art-inbox/monk_lv40.png
  2. python3 tools/import_sprites.py
  3. 切り出し→透過→数値ゲート計測→FAILなら頭部拡大の自動補正→
     sprites/<job>_lv<帯>x2.png へ設置。処理済み入力は art-inbox/done/ へ移動

ゲート基準は tools/check_sprite.py と同一(Lv1原器)。
"""
import glob, os, shutil, sys
from collections import deque
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INBOX = os.path.join(ROOT, "art-inbox")
SPRITES = os.path.join(ROOT, "sprites")
HEAD, HEAD_TOL = 0.298, 0.010
SH, SH_TOL = 0.316, 0.015
MAXW = 0.43

def dark(p, t=14): return p[0] <= t and p[1] <= t and p[2] <= t

def cut_frames(path):
    im = Image.open(path).convert("RGB"); px = im.load(); W, H = im.size
    rowhit = [sum(1 for x in range(0, W, 4) if not dark(px[x, y])) for y in range(H)]
    blocks, s = [], None
    for y in range(H):
        if rowhit[y] > 1 and s is None: s = y
        elif rowhit[y] <= 1 and s is not None: blocks.append((s, y)); s = None
    if s is not None: blocks.append((s, H))
    Y0, Y1 = max(blocks, key=lambda b: b[1] - b[0])
    colhit = [sum(1 for y in range(Y0, Y1, 3) if not dark(px[x, y])) for x in range(W)]
    runs, s = [], None
    for x in range(W):
        if colhit[x] > 2 and s is None: s = x
        elif colhit[x] <= 2 and s is not None:
            if x - s > 40: runs.append((s, x))
            s = None
    if s is not None: runs.append((s, W))
    assert len(runs) == 2, f"{path}: 2コマ検出できず ({len(runs)}ブロック)"
    def cut(x0, x1):
        ys = [y for y in range(Y0, Y1) if any(not dark(px[x, y]) for x in range(x0, x1))]
        y0, y1 = max(Y0, min(ys) - 2), min(H, max(ys) + 3)
        crop = im.crop((max(0, x0 - 2), y0, min(W, x1 + 2), y1)).convert("RGBA")
        w, h = crop.size; c = crop.load()
        seen = [[False] * w for _ in range(h)]; q = deque()
        for x in range(w):
            for y in (0, h - 1):
                if dark(c[x, y][:3], 12) and not seen[y][x]: q.append((x, y)); seen[y][x] = True
        for y in range(h):
            for x in (0, w - 1):
                if dark(c[x, y][:3], 12) and not seen[y][x]: q.append((x, y)); seen[y][x] = True
        while q:
            x, y = q.popleft(); c[x, y] = (0, 0, 0, 0)
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h and not seen[ny][nx] and dark(c[nx, ny][:3], 12):
                    seen[ny][nx] = True; q.append((nx, ny))
        return crop.crop(crop.getbbox())
    return cut(*runs[0]), cut(*runs[1])

def rows_of(im):
    px = im.load(); w, h = im.size
    out = []
    for y in range(h):
        xs = [x for x in range(w) if px[x, y][3] > 0]
        out.append((min(xs), max(xs)) if xs else None)
    return out


def body_rows(im):
    """最大連結成分(キャラ本体)だけの行extentを返す。浮遊する光の粒などは無視。"""
    px = im.load(); w, h = im.size
    label = [[0] * w for _ in range(h)]
    from collections import deque as _dq
    comps = []
    cur = 0
    for y0 in range(h):
        for x0 in range(w):
            if px[x0, y0][3] > 0 and label[y0][x0] == 0:
                cur += 1; size = 0
                q = _dq([(x0, y0)]); label[y0][x0] = cur
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
    return rows

def measure(im):
    rows = body_rows(im)
    ys = [y for y, r in enumerate(rows) if r]
    top, bot = min(ys), max(ys); H = bot - top + 1
    def band(a, b):
        seg = [rows[y] for y in range(top + int(H * a), top + int(H * b)) if rows[y]]
        return max(r[1] - r[0] + 1 for r in seg)
    maxw = max(r[1] - r[0] + 1 for r in rows if r)
    return band(.10, .20) / H, band(.34, .42) / H, maxw / H

def gate_ok(m, maxw_limit=MAXW):
    hd, sw, mw = m
    return abs(hd - HEAD) <= HEAD_TOL and abs(sw - SH) <= SH_TOL and mw <= maxw_limit

def fix(frame, s_head, s_bodyx):
    rows = rows_of(frame)
    ys = [y for y, r in enumerate(rows) if r]
    top, bot = min(ys), max(ys); H = bot - top + 1
    zone = range(top + int(H * .22), top + int(H * .34))
    neck = min((y for y in zone if rows[y]), key=lambda y: rows[y][1] - rows[y][0])
    w, h = frame.size; OV = 6
    head = frame.crop((0, 0, w, neck + OV))
    body = frame.crop((0, neck - 1, w, h))
    nr = rows[neck]; cx = (nr[0] + nr[1]) // 2
    head2 = head.resize((int(head.width * s_head), int(head.height * s_head)), Image.LANCZOS)
    body2 = body.resize((int(body.width * s_bodyx), body.height), Image.LANCZOS)
    W2 = max(head2.width, body2.width) + 8
    H2 = head2.height + body2.height - int(OV * s_head)
    cv = Image.new("RGBA", (W2, H2), (0, 0, 0, 0))
    bx = (W2 - body2.width) // 2; by = H2 - body2.height
    cv.alpha_composite(body2, (bx, by))
    cv.alpha_composite(head2, (bx + int(cx * s_bodyx) - int(cx * s_head), 0))
    return cv.crop(cv.getbbox())

def process(path):
    name = os.path.splitext(os.path.basename(path))[0]  # e.g. monk_lv10
    # Lv40(最上位)は儀礼装束の裾広がりのみ0.46まで許容(骨格基準は同一)
    limit = 0.46 if name.endswith("_lv40") else MAXW
    global gate_ok_limit
    f1, f2 = cut_frames(path)
    m = measure(f1)
    applied = None
    if not gate_ok(m, limit):
        # まず全体の横絞り(継ぎ目が出ない)だけで救えるか試す
        for sx in (0.98, 0.97, 0.96, 0.95, 0.94, 0.93):
            c = f1.resize((int(f1.width * sx), f1.height), Image.LANCZOS)
            if gate_ok(measure(c), limit):
                f1 = c
                f2 = f2.resize((int(f2.width * sx), f2.height), Image.LANCZOS)
                m = measure(f1); applied = f"横絞り×{sx}"
                break
    if not gate_ok(m, limit):
        best = None
        for sh_ in (0.86,0.88,0.90,0.92,0.94,0.96,0.98,1.0,1.02,1.04,1.06,1.08,1.10):
            for sb in (1.02,1.0,0.98,0.96,0.94,0.92):
                c = fix(f1, sh_, sb); mm = measure(c)
                if gate_ok(mm, limit):
                    score = abs(mm[0] - HEAD) + abs(mm[1] - SH)
                    if best is None or score < best[0]: best = (score, sh_, sb)
        if best:
            _, sh_, sb = best
            f1, f2 = fix(f1, sh_, sb), fix(f2, sh_, sb)
            m = measure(f1); applied = f"補正 head×{sh_} body×{sb}"
    fw = max(f1.width, f2.width); fh = max(f1.height, f2.height)
    sheet = Image.new("RGBA", (fw * 2, fh), (0, 0, 0, 0))
    for i, f in enumerate((f1, f2)):
        sheet.alpha_composite(f, (i * fw + (fw - f.width) // 2, fh - f.height))
    out = os.path.join(SPRITES, f"{name}x2.png")
    if gate_ok(m, limit) or not os.path.exists(out):
        sheet.save(out)
    else:
        out = os.path.join(INBOX, f"REJECTED_{name}.png")
        sheet.save(out)
    hd, sw, mw = m
    status = "PASS" if gate_ok(m, limit) else "FAIL(要再生成)"
    print(f"{name}: 頭{hd:.3f} 肩{sw:.3f} 幅{mw:.3f} → {status}"
          + (f" [{applied}]" if applied else "") + f" → {out}")
    return gate_ok(m, limit)

if __name__ == "__main__":
    files = sorted(f for f in glob.glob(os.path.join(INBOX, "*.png"))
                   if not os.path.basename(f).startswith("REJECTED_"))
    if not files:
        print(f"art-inbox/ に画像がありません ({INBOX})"); sys.exit(1)
    done = os.path.join(INBOX, "done"); os.makedirs(done, exist_ok=True)
    ok = True
    for p in files:
        try:
            ok &= process(p)
            shutil.move(p, os.path.join(done, os.path.basename(p)))
        except Exception as e:
            print(f"{p}: エラー {e}"); ok = False
    sys.exit(0 if ok else 1)
