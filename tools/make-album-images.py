"""HISTORY images (albums/<id>/).

visual.png  : the album's new AI jacket, adopted by the Producer (made with ChatGPT; never generated
              or chosen by Claude). -> visual-web.jpg (max 1400px) and visual-640.jpg.
              While it is missing, the chapter shows its typographic scene instead.
cover.png   : the original CD front, cut out without any other change (sources: handover record).
              Only a small ORIGINAL ARCHIVE item now. -> cover-240.jpg.
Small originals are never enlarged.
"""
from pathlib import Path
from PIL import Image

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
    cover = d / 'cover.png'
    if cover.exists():
        save(Image.open(cover).convert('RGB'), d / 'cover-240.jpg', 240)
        done.append('archive')
    print(d.name, ', '.join(done) or '(no images)')
