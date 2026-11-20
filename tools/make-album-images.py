"""HISTORY images (albums/<id>/).

visual.png  : the album's new AI jacket, adopted by the Producer (made with ChatGPT; never generated
              or chosen by Claude). -> visual-web.jpg (max 1400px) and visual-640.jpg.
              While it is missing, the chapter shows its typographic scene instead.
cover.png   : the original CD front, cut out without any other change (sources: handover record).
              Only a small ORIGINAL ARCHIVE item now. -> cover-240.jpg.
Small originals are never enlarged.
"""
from pathlib import Path
from PIL import Image, ImageChops

root = Path(__file__).resolve().parent.parent / 'albums'


def save(im, path, size):
    out = im.copy()
    if max(out.size) > size:
        out.thumbnail((size, size), Image.LANCZOS)
    out.save(path, 'JPEG', quality=86, progressive=True, optimize=True)


for d in sorted(p for p in root.iterdir() if p.is_dir()):
    done = []
    visual = d / 'visual.png'
    if visual.exists():
        im = Image.open(visual).convert('RGB')
        save(im, d / 'visual-web.jpg', 1400)
        save(im, d / 'visual-640.jpg', 640)
        done.append(f'visual {im.size}')
    backdrop = d / 'backdrop.png'   # optional: a text-free part of the adopted design, used blurred behind the chapter
    if backdrop.exists():
        save(Image.open(backdrop).convert('RGB'), d / 'backdrop-web.jpg', 1400)
        done.append('backdrop')
    title = d / 'title.png'   # optional: the adopted design's title lettering, shown as the chapter title
    if title.exists():
        # The lettering sits on a dark background: make that background transparent so the title
        # works on any part of the page (alpha from the brightest channel; the dark ground drops out).
        im = Image.open(title).convert('RGB')
        r, g, b = im.split()
        peak = ImageChops.lighter(ImageChops.lighter(r, g), b)
        alpha = peak.point(lambda v: max(0, min(255, round((v - 70) * 255 / 110))))
        out = im.copy()
        out.putalpha(alpha)
        if max(out.size) > 1400:
            out.thumbnail((1400, 1400), Image.LANCZOS)
        out.save(d / 'title-web.png', optimize=True)
        done.append('title')
    cover = d / 'cover.png'
    if cover.exists():
        save(Image.open(cover).convert('RGB'), d / 'cover-240.jpg', 240)
        done.append('archive')
    print(d.name, ', '.join(done) or '(no images)')
