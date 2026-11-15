"""Build the all-clear reward cuts (sprites/reward/<id>.png) from the existing Monk art.

No new character art: each cut places a Monk pose (sprites/monk-actions, monk-idle)
on a pixel-art background drawn here, plus light / steam / sweat effects.
Usage: python3 tools/make_reward_cuts.py [tier]   (tier = 1/10/20/30/40, default 30)
"""
import math, random, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
W, H, S = 180, 240, 4          # background drawn at 180x240, scaled x4 → 720x960
OUT = ROOT / "sprites" / "reward"

def frame(kind, idx, tier):
    sheet = Image.open(ROOT / "sprites" / f"monk-{kind}" / f"lv{tier}.webp").convert("RGBA")
    fw = sheet.width // (3 if kind == "actions" else 2)
    f = sheet.crop((fw * idx, 0, fw * (idx + 1), sheet.height))
    return f.crop(f.getbbox())

def grad(top, bottom, h=H):
    im = Image.new("RGBA", (W, h))
    d = ImageDraw.Draw(im)
    for y in range(h):
        t = y / (h - 1)
        d.line([(0, y), (W, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,))
    return im

def up(im): return im.resize((im.width * S, im.height * S), Image.NEAREST)

def sparkle(d, x, y, c, r=2):
    d.point((x, y), fill=c)
    for i in range(1, r + 1):
        a = c[:3] + (max(60, 255 - i * 80),)
        for p in ((x + i, y), (x - i, y), (x, y + i), (x, y - i)): d.point(p, fill=a)

def place(bg, spr, cx, bottom, scale=2):
    big = spr.resize((spr.width * scale, spr.height * scale), Image.NEAREST)
    x, y = int(cx - big.width / 2), int(bottom - big.height)
    bg.alpha_composite(big, (x, y))
    return (x, y, big.width, big.height)

def glow(size, color, radius):
    g = Image.new("RGBA", size, (0, 0, 0, 0))
    ImageDraw.Draw(g).ellipse((size[0] / 2 - radius, size[1] / 2 - radius, size[0] / 2 + radius, size[1] / 2 + radius), fill=color)
    return g.filter(ImageFilter.GaussianBlur(radius / 2))

def tint(spr, color, amount):
    over = Image.new("RGBA", spr.size, color + (0,))
    a = spr.getchannel("A").point(lambda v: int(v * amount))
    over.putalpha(a)
    out = spr.copy(); out.alpha_composite(over); return out

def sweat(img, box, rel):
    """rel = (fx, fy) inside the placed sprite (0..1), e.g. chest ≈ (0.5, 0.42)"""
    d = ImageDraw.Draw(img)
    for fx, fy in rel:
        x, y = box[0] + box[2] * fx, box[1] + box[3] * fy
        d.ellipse((x - 5, y - 8, x + 5, y + 6), fill=(200, 236, 255, 210))
        d.ellipse((x - 2, y - 4, x + 1, y - 1), fill=(255, 255, 255, 240))

def vignette(img, strength=150):
    v = Image.new("L", img.size, 0)
    ImageDraw.Draw(v).ellipse((-img.width * .25, -img.height * .15, img.width * 1.25, img.height * 1.15), fill=255)
    v = v.filter(ImageFilter.GaussianBlur(90))
    dark = Image.new("RGBA", img.size, (0, 0, 0, strength))
    dark.putalpha(v.point(lambda p: int(strength * (1 - p / 255))))
    img.alpha_composite(dark)

# ── scenes ──────────────────────────────────────────────────────────────────
def pump(tier):
    bg = grad((44, 30, 12), (12, 8, 4)); d = ImageDraw.Draw(bg)
    for i in range(14):  # gold rays
        a = i / 14 * math.tau
        d.polygon([(90, 120), (90 + 200 * math.cos(a), 120 + 200 * math.sin(a)), (90 + 200 * math.cos(a + .12), 120 + 200 * math.sin(a + .12))], fill=(255, 196, 90, 34))
    d.rectangle((0, 196, W, H), fill=(28, 22, 16, 255))
    for x in range(0, W, 12): d.line([(x, 196), (x, H)], fill=(36, 28, 20, 255))
    d.rectangle((12, 150, 40, 196), fill=(40, 40, 46, 255)); d.rectangle((16, 160, 36, 164), fill=(90, 90, 100, 255))  # dumbbell rack
    for y in (170, 182): d.rectangle((14, y, 38, y + 5), fill=(70, 70, 78, 255))
    img = up(bg); img.alpha_composite(glow(img.size, (255, 200, 110, 150), 260))
    spr = tint(frame("actions", 2, tier), (255, 200, 120), .12)
    box = place(img, spr, 360, 900)
    sweat(img, box, [(.36, .36), (.62, .44), (.47, .52)])
    d2 = ImageDraw.Draw(img); random.seed(1)
    for _ in range(26): sparkle(d2, random.randint(40, 680), random.randint(60, 760), (255, 226, 150, 255), random.choice((4, 6, 9)))
    vignette(img); return img

def bath(tier):
    bg = grad((70, 46, 30), (34, 22, 16)); d = ImageDraw.Draw(bg)
    for x in range(0, W, 9): d.line([(x, 0), (x, 170)], fill=(58, 38, 26, 255))  # wooden wall
    d.rectangle((0, 170, W, H), fill=(52, 70, 78, 255))  # water
    for y in range(176, H, 7): d.line([(random.randint(0, 40), y), (random.randint(120, 180), y)], fill=(80, 110, 120, 255))
    d.rectangle((136, 40, 156, 74), fill=(250, 214, 150, 255)); d.rectangle((134, 38, 158, 42), fill=(40, 26, 18, 255)); d.rectangle((134, 72, 158, 76), fill=(40, 26, 18, 255))  # lantern
    img = up(bg); img.alpha_composite(glow(img.size, (255, 190, 120, 90), 300))
    spr = tint(frame("idle", 0, tier), (255, 120, 110), .14)  # 湯上がりの火照り
    box = place(img, spr, 340, 960)
    steam = Image.new("RGBA", img.size, (0, 0, 0, 0)); ds = ImageDraw.Draw(steam); random.seed(4)
    for _ in range(46):  # steam covers the waist down
        x, y, r = random.randint(-40, 760), random.randint(560, 1000), random.randint(50, 120)
        ds.ellipse((x - r, y - r, x + r, y + r), fill=(245, 240, 236, random.randint(70, 130)))
    for _ in range(14):
        x, y, r = random.randint(0, 720), random.randint(80, 560), random.randint(30, 70)
        ds.ellipse((x - r, y - r, x + r, y + r), fill=(245, 240, 236, 40))
    img.alpha_composite(steam.filter(ImageFilter.GaussianBlur(24)))
    sweat(img, box, [(.40, .38), (.60, .42), (.30, .30)])
    vignette(img, 120); return img

def jazz(tier):
    bg = grad((22, 12, 26), (8, 6, 12)); d = ImageDraw.Draw(bg)
    for y in range(0, 190, 8):  # brick wall
        off = 0 if (y // 8) % 2 else 8
        for x in range(-off, W, 16): d.rectangle((x + 1, y + 1, x + 14, y + 6), fill=(40, 20, 26, 255))
    d.rectangle((0, 190, W, H), fill=(30, 14, 12, 255)); d.line([(0, 190), (W, 190)], fill=(90, 50, 30, 255))
    d.text((18, 28), "JAZZ", fill=(255, 90, 170, 255))
    img = up(bg)
    bokeh = Image.new("RGBA", img.size, (0, 0, 0, 0)); db = ImageDraw.Draw(bokeh); random.seed(7)
    for _ in range(20):
        x, y, r = random.randint(0, 720), random.randint(0, 520), random.randint(10, 26)
        db.ellipse((x - r, y - r, x + r, y + r), fill=random.choice([(255, 170, 80, 90), (255, 90, 170, 80), (120, 160, 255, 80)]))
    img.alpha_composite(bokeh.filter(ImageFilter.GaussianBlur(6)))
    cone = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(cone).polygon([(320, 0), (400, 0), (620, 960), (100, 960)], fill=(255, 220, 160, 70))
    img.alpha_composite(cone.filter(ImageFilter.GaussianBlur(30)))
    spr = tint(frame("idle", 1, tier), (190, 110, 255), .10)
    place(img, spr, 360, 940)
    vignette(img, 170); return img

def dawn(tier):
    bg = grad((250, 170, 110), (90, 60, 110)); d = ImageDraw.Draw(bg)
    d.ellipse((60, 120, 120, 180), fill=(255, 226, 150, 255))
    random.seed(3)
    x = 0
    while x < W:  # city silhouette
        w, h = random.randint(8, 18), random.randint(20, 70)
        d.rectangle((x, 180 - h, x + w, 180), fill=(56, 40, 76, 255)); x += w + 1
    d.rectangle((0, 180, W, H), fill=(44, 34, 56, 255))
    for y in (196, 214, 232): d.line([(0, y), (W, y)], fill=(70, 54, 80, 255))
    img = up(bg); img.alpha_composite(glow(img.size, (255, 210, 150, 120), 280))
    box = place(img, frame("actions", 1, tier), 380, 930)
    sweat(img, box, [(.52, .40), (.66, .46), (.58, .30)])
    vignette(img, 90); return img

def festival(tier):
    bg = grad((16, 18, 48), (6, 6, 18)); d = ImageDraw.Draw(bg); random.seed(9)
    for cx, cy, c in ((40, 40, (255, 120, 160)), (140, 30, (255, 210, 110)), (100, 70, (130, 200, 255))):  # fireworks
        for i in range(24):
            a = i / 24 * math.tau
            for r in (10, 16, 22): d.point((cx + r * math.cos(a), cy + r * math.sin(a)), fill=c + (255 if r < 22 else 150,))
    for x in range(-4, W, 22):  # lanterns
        d.ellipse((x, 118, x + 12, 132), fill=(255, 120, 60, 255)); d.line([(x + 6, 112), (x + 6, 118)], fill=(60, 40, 30, 255))
    d.line([(0, 112), (W, 112)], fill=(60, 40, 30, 255))
    d.rectangle((0, 196, W, H), fill=(24, 18, 22, 255))
    img = up(bg); img.alpha_composite(glow(img.size, (255, 140, 80, 80), 300))
    place(img, frame("idle", 0, tier), 360, 940)
    vignette(img, 140); return img

def beach(tier):
    bg = grad((250, 150, 100), (150, 70, 110), 150); full = Image.new("RGBA", (W, H)); full.alpha_composite(bg)
    d = ImageDraw.Draw(full)
    d.ellipse((110, 112, 150, 152), fill=(255, 210, 120, 255))
    d.rectangle((0, 140, W, 196), fill=(60, 80, 140, 255))
    for y in range(146, 196, 6): d.line([(random.randint(0, 60), y), (random.randint(100, 180), y)], fill=(255, 180, 130, 160))
    d.rectangle((0, 196, W, H), fill=(214, 170, 120, 255))
    for x in range(0, W, 7): d.point((x, 210 + (x % 3) * 9), fill=(190, 150, 100, 255))
    img = up(full); img.alpha_composite(glow(img.size, (255, 180, 120, 90), 300))
    spr = tint(frame("idle", 1, tier), (255, 150, 90), .12)
    box = place(img, spr, 330, 940)
    sweat(img, box, [(.42, .42), (.58, .37)])
    vignette(img, 110); return img

SCENES = {"pump": pump, "bath": bath, "jazz": jazz, "dawn": dawn, "festival": festival, "beach": beach}

if __name__ == "__main__":
    tier = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    OUT.mkdir(parents=True, exist_ok=True)
    for name, fn in SCENES.items():
        random.seed(name)
        fn(tier).convert("RGB").save(OUT / f"{name}.png", optimize=True)
        print("wrote", OUT / f"{name}.png")
