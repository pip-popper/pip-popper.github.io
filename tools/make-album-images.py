"""HISTORY album jackets: albums/<id>/cover.png -> cover-web.jpg (max 1000px) and cover-480.jpg.

cover.png is the front panel of the original CD jacket, cut out without any other change
(the original jacket files stay in their own folders; see the handover record for sources).
Small originals are never enlarged.
"""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent / 'albums'
for d in sorted(p for p in root.iterdir() if p.is_dir()):
    src = d / 'cover.png'
    if not src.exists():
        raise SystemExit(f'cover.png がありません: {d}')
    im = Image.open(src).convert('RGB')
    for name, size in (('cover-web.jpg', 1000), ('cover-480.jpg', 480)):
        out = im.copy()
        if max(out.size) > size:
            out.thumbnail((size, size), Image.LANCZOS)
        out.save(d / name, 'JPEG', quality=86, progressive=True, optimize=True)
    print(d.name, im.size)
