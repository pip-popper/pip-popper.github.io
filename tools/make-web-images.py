"""Make lightweight display images for the site. Originals are never modified.

For every tracks/<id>/: reads the jacket original (track.json "artwork" in the track folder, or the
published docs/assets/covers/<id>.png for songs whose original lives elsewhere) and writes
  tracks/<id>/cover-web.jpg  (full 1254px, for song pages)
  tracks/<id>/cover-640.jpg  (640px, for the works list and background glow)
Also writes src/stage.jpg from the crown-free stage image when it is given as an argument.
Run: python tools/make-web-images.py [path/to/stage-no-crown.png]
"""
import json, os, sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def save_jpeg(img, path, size, quality):
    im = img.convert('RGB')
    if size and im.width != size:
        im = im.resize((size, round(im.height * size / im.width)), Image.LANCZOS)
    im.save(path, 'JPEG', quality=quality, optimize=True, progressive=True)
    return os.path.getsize(path)

tracks = os.path.join(ROOT, 'tracks')
for tid in sorted(os.listdir(tracks)):
    folder = os.path.join(tracks, tid)
    meta = os.path.join(folder, 'track.json')
    if not os.path.isfile(meta):
        continue
    artwork = json.load(open(meta, encoding='utf-8'))['artwork']
    src = os.path.join(folder, artwork)
    if not os.path.isfile(src):
        src = os.path.join(ROOT, 'docs', 'assets', 'covers', f'{tid}.png')
    if not os.path.isfile(src):
        sys.exit(f'jacket original not found: {tid}')
    img = Image.open(src)
    full = save_jpeg(img, os.path.join(folder, 'cover-web.jpg'), None, 86)
    small = save_jpeg(img, os.path.join(folder, 'cover-640.jpg'), 640, 84)
    print(f'{tid}: {os.path.getsize(src)//1024}KB {img.size} -> web {full//1024}KB / 640 {small//1024}KB  (source: {os.path.relpath(src, ROOT)})')

if len(sys.argv) > 1:
    size = save_jpeg(Image.open(sys.argv[1]), os.path.join(ROOT, 'src', 'stage.jpg'), None, 82)
    print(f'stage: {os.path.getsize(sys.argv[1])//1024}KB -> src/stage.jpg {size//1024}KB')
