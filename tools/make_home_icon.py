"""週クエのホーム画面アイコンを作る（主人公の顔のドット絵）。

  python3 tools/make_home_icon.py
  -> icons/avatar/<file>[_lv<tier>].png  各ジョブ×レベル帯の顔（180px, apple-touch-icon用）
     icon-quest-192.png / icon-quest-512.png  manifest用（みならいの顔）
tracker.html は今のジョブに合う顔を apple-touch-icon に指定する。iPhoneは
ホーム画面に追加した瞬間の画像を使うので、追加した時点のアバターがアイコンになる。
ジムアプリは従来の icon-*.png（星）のまま。
"""
import glob, os, re
from PIL import Image, ImageDraw

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NAVY = (15, 17, 36); NAVY2 = (28, 32, 66)

def first_frame(path):
    im = Image.open(path).convert('RGBA')
    if path.endswith('x2.png'):  # 2-frame idle sheet, frames side by side
        im = im.crop((0, 0, im.width // 2, im.height))
    return im.crop(im.getbbox())

# share of the body height the square crop covers; the chibi chef is 2 heads tall
CROP = {'chef': .85}

def face(sprite, ratio=.52):
    """Square crop around the head: the top ~half of the body, centred on the
    widest opaque run in the skull band (10–20% of the height)."""
    w, h = sprite.size
    a = sprite.getchannel('A')
    xs = [x for y in range(int(h * .10), int(h * .20)) for x in range(w) if a.getpixel((x, y)) > 128]
    cx = (min(xs) + max(xs)) / 2 if xs else w / 2
    side = int(h * ratio)
    pad = int(side * .06)
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.alpha_composite(sprite, (int(side / 2 - cx), pad))
    return canvas

def icon(sprite, size, ratio=.52):
    f = face(sprite, ratio)
    s = f.width
    bg = Image.new('RGBA', (s, s), NAVY + (255,))
    ImageDraw.Draw(bg).ellipse((s * .08, s * .12, s * .92, s * .96), fill=NAVY2 + (255,))
    bg.alpha_composite(f)
    # pixel art: integer upscale with nearest-neighbour, then fit to the target size
    k = max(1, -(-size // s))
    return bg.convert('RGB').resize((s * k, s * k), Image.NEAREST).resize((size, size), Image.LANCZOS if k == 1 else Image.NEAREST)

def main():
    out = os.path.join(REPO, 'icons', 'avatar'); os.makedirs(out, exist_ok=True)
    names = []
    for p in sorted(glob.glob(os.path.join(REPO, 'sprites', '*.png'))):
        m = re.fullmatch(r'(\w+?)(?:_lv(\d+))?(x2)?\.png', os.path.basename(p))
        if not m: continue
        name = m.group(1) + (f'_lv{m.group(2)}' if m.group(2) else '')
        if name in names: continue  # x2 sheet and still of the same tier
        im = icon(first_frame(p), 180, CROP.get(m.group(1), .52))
        im.quantize(128, dither=Image.Dither.NONE).save(os.path.join(out, name + '.png'), optimize=True)
        names.append(name)
    nov = first_frame(os.path.join(REPO, 'sprites', 'novice.png'))
    for s in (192, 512):
        icon(nov, s).save(os.path.join(REPO, f'icon-quest-{s}.png'), optimize=True)
    print(' '.join(names))

if __name__ == '__main__':
    main()
