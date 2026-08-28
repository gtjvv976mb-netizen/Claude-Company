#!/usr/bin/env python3
"""
Claude Company ($CLAUDECO) — the CEO's head.

The mark is the head of the CEO who sits on floor 50: a blocky three-quarter box in the
same voxel idiom as everyone else on the trading floors, but with Claude's spark where a
face would be. Every other figure in the building has eyes. This one has the mark.

Designed inside a circle-safe square: Phantom, Jupiter and DexScreener mask token images
to a circle, so nothing important goes near a corner.

Drawn at 4x and downsampled — Pillow does not antialias primitives.
"""
import math
from PIL import Image, ImageDraw

SS = 4

CREAM      = (0xf0, 0xe4, 0xc7)
CREAM_TOP  = (0xfa, 0xf1, 0xdd)
CREAM_SIDE = (0xcf, 0xbf, 0x9d)
CORAL      = (0xd9, 0x77, 0x57)
CORAL_DEEP = (0xb8, 0x5f, 0x42)
BRASS_LITE = (0xf0, 0xc9, 0x84)
AQUA       = (0x73, 0xc9, 0xd2)
AQUA_DEEP  = (0x3f, 0x9d, 0xa8)
CHARCOAL   = (0x30, 0x45, 0x4a)


def shade(c, f):
    return tuple(max(0, min(255, round(v * f))) for v in c)


def spark(d, sx, sy, r_out, rays=11, colour=CORAL, hub_colour=BRASS_LITE, rot=0.0):
    """Claude's mark: eleven distinct spokes with clear gaps between them.

    The gap is the whole design, and it is a geometry constraint, not taste: at radius r
    the arc available to each of 11 rays is 2*pi*r/11 = 0.571r, so a ray's half-width must
    stay under 0.285r or neighbouring rays fuse and the mark collapses into a solid star.
    A first pass used half-width 0.185*r_out at r0 = 0.16*r_out — three times over budget,
    and it read as a cartoon sunburst."""
    r0 = r_out * 0.22
    # Thin spokes disappeared at 32px. The budget binds at the hub (0.285*0.22 = 0.063)
    # and is loose at the tip (0.285), so the ray is a wedge: as heavy as it can be
    # where there is room, still gapped where there is not.
    hw0, hw1 = r_out * 0.058, r_out * 0.115
    for i in range(rays):
        th = (i / rays) * math.tau - math.pi / 2 + rot
        c, s = math.cos(th), math.sin(th)
        pts = [(r0, -hw0), (r_out, -hw1), (r_out, hw1), (r0, hw0)]
        d.polygon([(sx + x * c - y * s, sy + x * s + y * c) for x, y in pts], fill=colour)
        tx, ty = sx + c * r_out, sy + s * r_out
        d.ellipse((tx - hw1, ty - hw1, tx + hw1, ty + hw1), fill=colour)   # soften the tip
    hub = r_out * 0.185
    d.ellipse((sx - hub, sy - hub, sx + hub, sy + hub), fill=colour)
    d.ellipse((sx - hub * 0.46, sy - hub * 0.46, sx + hub * 0.46, sy + hub * 0.46), fill=hub_colour)


def ceo_head(d, cx, cy, w, base=CREAM):
    """A three-quarter box head: front face, top face receding up-right, side face right."""
    h = w * 0.94
    dx, dy = w * 0.34, -w * 0.27          # the recede
    x0, x1 = cx - w / 2, cx + w / 2
    y0, y1 = cy - h / 2, cy + h / 2
    # shift left so the whole solid stays centred once the recede is added
    x0 -= dx / 2; x1 -= dx / 2
    y0 -= dy / 2; y1 -= dy / 2

    d.polygon([(x1, y0), (x1 + dx, y0 + dy), (x1 + dx, y1 + dy), (x1, y1)],
              fill=shade(base, 0.80))                      # right face, in shadow
    d.polygon([(x0, y0), (x0 + dx, y0 + dy), (x1 + dx, y0 + dy), (x1, y0)],
              fill=shade(base, 1.05))                      # top face, catching light
    d.polygon([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], fill=base)   # front face
    return (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0


def draw_mark(S, bg=AQUA):
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    grad = Image.new("RGB", (1, S))
    gd = ImageDraw.Draw(grad)
    top, bot = bg, shade(bg, 0.72)
    for y in range(S):
        t = y / (S - 1)
        gd.point((0, y), fill=tuple(round(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    img.paste(grad.resize((S, S)), (0, 0))

    fx, fy, fw = ceo_head(d, S * 0.5, S * 0.52, S * 0.54)
    spark(d, fx, fy, fw * 0.395)
    return img


def build():
    big = draw_mark(1024 * SS)
    for px in (1024, 512, 256, 128, 64, 32):
        big.resize((px, px), Image.LANCZOS).convert("RGB").save(f"token/claudeco-{px}.png")
    # a contact sheet so small-size legibility can actually be judged
    sheet = Image.new("RGB", (1024, 300), CHARCOAL)
    x = 40
    for px in (256, 128, 64, 32):
        im = Image.open(f"token/claudeco-{px}.png")
        sheet.paste(im, (x, 150 - px // 2))
        x += px + 60
    sheet.save("token/claudeco-sizes.png")
    print("wrote token/claudeco-{1024,512,256,128,64,32}.png + claudeco-sizes.png")


if __name__ == "__main__":
    build()


# ─────────────────────────────────────────────────────────────────────────────
# Banners
# ─────────────────────────────────────────────────────────────────────────────
from PIL import ImageFont
import os

FONT_DIR = os.path.join(os.path.dirname(__file__), "fonts")
SERIF = os.path.join(FONT_DIR, "InstrumentSerif-Regular.ttf")   # the site's display face
SANS = os.path.join(FONT_DIR, "Archivo-Bold.ttf")               # the site's UI face
BRASS = (0xe0, 0xad, 0x3d)
STONE = (0xcf, 0xc7, 0xad)
TEAL = (0x26, 0x7f, 0x82)


def _f(path, px):
    return ImageFont.truetype(path, px)


def draw_banner(W, H, tight=False):
    """tight=True centres the composition for a square-ish card; the wide X header keeps
    its text clear of the bottom-left, where the profile picture sits."""
    S = 3
    w, h = W * S, H * S
    img = Image.new("RGB", (w, h), CHARCOAL)
    d = ImageDraw.Draw(img)

    grad = Image.new("RGB", (1, h))
    gd = ImageDraw.Draw(grad)
    top, bot = (0x3a, 0x53, 0x59), (0x18, 0x26, 0x2a)
    for y in range(h):
        t = (y / (h - 1)) ** 1.1
        gd.point((0, y), fill=tuple(round(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    img.paste(grad.resize((w, h)), (0, 0))

    # a faint skyline so the mark has a city to stand in
    base = h * 0.93
    sky = [(0.03, 0.30), (0.09, 0.46), (0.15, 0.24), (0.21, 0.38), (0.72, 0.34),
           (0.79, 0.52), (0.86, 0.28), (0.93, 0.42)]
    for fx, fh in sky:
        bw, bh = w * 0.045, h * fh
        x = w * fx
        d.rectangle((x, base - bh, x + bw, base), fill=(0x27, 0x3b, 0x40))
        for i in range(int(fh * 9)):
            yy = base - bh + h * 0.028 + i * h * 0.048
            if yy < base - h * 0.02:
                d.rectangle((x + bw * 0.22, yy, x + bw * 0.78, yy + h * 0.016), fill=(0x33, 0x4c, 0x52))

    # the mark
    head_w = h * (0.34 if tight else 0.60)
    hx = w * (0.5 if tight else 0.795)
    hy = h * (0.27 if tight else 0.47)
    fx, fy, fw = ceo_head(d, hx, hy, head_w)
    spark(d, fx, fy, fw * 0.395)

    # type
    if tight:
        ts = _f(SERIF, int(h * 0.115))
        tg = _f(SANS, int(h * 0.042))
        tk = _f(SANS, int(h * 0.030))
        cxm = w * 0.5
        y = h * 0.575
        for text, font, fill, gap in [("Claude Company", ts, CREAM, h * 0.115),
                                      ("Lease a floor. Get a trading team.", tg, STONE, h * 0.075)]:
            tw_ = d.textlength(text, font=font)
            d.text((cxm - tw_ / 2, y), text, font=font, fill=fill)
            y += gap
        chip = "50 FLOORS  ·  14 AGENTS EACH  ·  $CLAUDECO"
        tw_ = d.textlength(chip, font=tk)
        d.text((cxm - tw_ / 2, y), chip, font=tk, fill=BRASS)
    else:
        ts = _f(SERIF, int(h * 0.185))
        tg = _f(SANS, int(h * 0.062))
        tk = _f(SANS, int(h * 0.042))
        x = w * 0.075
        d.text((x, h * 0.235), "Claude Company", font=ts, fill=CREAM)
        d.text((x, h * 0.475), "Lease a floor. Get a trading team.", font=tg, fill=STONE)
        chip = "50 FLOORS  ·  14 AGENTS EACH  ·  $CLAUDECO"
        d.text((x, h * 0.605), chip, font=tk, fill=BRASS)

    d.rectangle((0, h - h * 0.022, w, h), fill=BRASS)
    return img.resize((W, H), Image.LANCZOS)


def build_banners():
    draw_banner(1500, 500).save("token/banner-1500x500.png")       # X / Twitter header
    draw_banner(1200, 630, tight=True).save("token/banner-1200x630.png")  # OG / social card
    print("wrote token/banner-1500x500.png and token/banner-1200x630.png")


build_banners()
