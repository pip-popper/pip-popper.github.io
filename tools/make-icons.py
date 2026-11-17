"""Make the browser / bookmark icons (favicons) for the official site and PIP POPPER PRIVATE.

    python tools/make-icons.py

Large icons (home screen, Safari favourites: 180-512 px) reuse the existing logo pip-popper.ico as is.
Small icons (tabs, bookmarks: 16-48 px) are a simple mark in the site's header style, because the detailed
logo cannot be recognised at 16 px:
  official: black square, white "PP" with the red bar of the wordmark
  PRIVATE:  red square with a white padlock (large: the logo with a red padlock badge)
Output: src/icons/ (copied to docs/ by build.mjs) and private/worker/public/ (served by the Worker).
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE_OUT = os.path.join(ROOT, 'src', 'icons')
PRIV_OUT = os.path.join(ROOT, 'private', 'worker', 'public')
RED = (240, 68, 75, 255)
INK = (244, 240, 234, 255)
BLACK = (6, 7, 8, 255)
FONT = 'C:/Windows/Fonts/impact.ttf'    # condensed bold, close to the site's Anton wordmark
S = 512                                  # drawn large, then reduced (sharp at every size)


def logo(size):
    """The existing logo (badge), from pip-popper.ico at its largest size."""
    ico = Image.open(os.path.join(ROOT, 'pip-popper.ico'))
    ico.size = (256, 256)
    ico.load()
    return ico.convert('RGBA').resize((size, size), Image.LANCZOS)


def rounded(color, radius=0.18):
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(im).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * radius), fill=color)
    return im


def official_mark():
    """Black square, white "P P" separated by the red bar (as in the header wordmark "PIP | POPPER")."""
    im = rounded(BLACK)
    d = ImageDraw.Draw(im)
    font = ImageFont.truetype(FONT, int(S * 0.78))
    for x, letter in ((0.07, 'P'), (0.55, 'P')):
        box = d.textbbox((0, 0), letter, font=font)
        w, h = box[2] - box[0], box[3] - box[1]
        d.text((S * x + (S * 0.38 - w) / 2 - box[0], (S - h) / 2 - box[1]), letter, font=font, fill=INK)
    d.rectangle((S * 0.475, S * 0.16, S * 0.525, S * 0.84), fill=RED)
    return im


def padlock(draw, cx, cy, w, color, hole):
    """A padlock centred on (cx, cy), w = body width."""
    body_h = w * 0.78
    top = cy - body_h * 0.18
    shackle_w, thick = w * 0.62, w * 0.16
    draw.rounded_rectangle((cx - shackle_w / 2, top - w * 0.62, cx + shackle_w / 2, top + w * 0.25),
                           radius=shackle_w / 2, outline=color, width=int(thick))
    draw.rounded_rectangle((cx - w / 2, top, cx + w / 2, top + body_h), radius=w * 0.12, fill=color)
    r = w * 0.11
    draw.ellipse((cx - r, top + body_h * 0.32, cx + r, top + body_h * 0.32 + 2 * r), fill=hole)
    draw.rectangle((cx - r * 0.45, top + body_h * 0.32 + r, cx + r * 0.45, top + body_h * 0.75), fill=hole)


def private_mark():
    """Red square with a white padlock."""
    im = rounded(RED)
    padlock(ImageDraw.Draw(im), S * 0.5, S * 0.56, S * 0.56, INK, RED)
    return im


def private_logo(size):
    """The existing logo with a red padlock badge at the lower right."""
    im = logo(S)
    d = ImageDraw.Draw(im)
    r = S * 0.2
    cx, cy = S - r - S * 0.02, S - r - S * 0.02
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=RED, outline=INK, width=int(S * 0.025))
    padlock(d, cx, cy + r * 0.12, r * 0.95, INK, RED)
    return im.resize((size, size), Image.LANCZOS)


def write(out, mark, big):
    os.makedirs(os.path.join(out, 'assets'), exist_ok=True)
    small = {n: mark.resize((n, n), Image.LANCZOS) for n in (16, 32, 48)}
    mark.resize((256, 256), Image.LANCZOS).save(os.path.join(out, 'favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48)])
    small[32].save(os.path.join(out, 'assets', 'favicon-32.png'))
    big(180).convert('RGB').save(os.path.join(out, 'assets', 'apple-touch-icon.png'))   # iOS: no transparency
    big(192).save(os.path.join(out, 'assets', 'icon-192.png'))
    big(512).save(os.path.join(out, 'assets', 'icon-512.png'))


def apple(im_fn):
    """Apple icons are shown on a square; put the round logo on the site's black."""
    def make(size):
        bg = Image.new('RGBA', (size, size), BLACK)
        bg.alpha_composite(im_fn(size))
        return bg
    return make


write(SITE_OUT, official_mark(), apple(logo))
write(PRIV_OUT, private_mark(), apple(private_logo))
print('icons written:', SITE_OUT, PRIV_OUT)
