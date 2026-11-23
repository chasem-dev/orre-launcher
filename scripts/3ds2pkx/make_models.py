"""Nintendo 3DS Pokémon models for the launcher: directly from the player's decrypted .3ds ROM.

usage: make_models.py ROM_3DS WORK NUMBER...

ROM_3DS is the player's own decrypted Pokémon Ultra Sun, Ultra Moon, Sun, or Moon .3ds ROM.
WORK is the launcher's folder for it, where this keeps:
  addon/     StarsMmd's Blender-Addon-Gamecube-Models at the commit downloads.json pins
             (reused from GAMECUBE_ADDON or sibling ../battle-revolution/addon when already present)
  models/N/  each Pokémon's pokemon.json, model.pkx, model-shiny.pkx, icons and cry.wav
"""
import hashlib
import json
import os
import shutil
import sys
import tarfile
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import rom3ds  # noqa: E402


def say(text):
    print(text, flush=True)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def download(url, digest, out):
    if os.path.exists(out) and sha256(out) == digest:
        return
    say('Downloading the model tools: %s' % url)
    part = out + '.part'
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'colosseum-launcher-3ds2pkx'}), timeout=60) as response, open(part, 'wb') as f:
        shutil.copyfileobj(response, f)
    if sha256(part) != digest:
        os.remove(part)
        raise SystemExit("%s isn't the file it should be (its SHA-256 differs). Try again later, or report it." % url)
    os.replace(part, out)


def addon(pins, work):
    pin = pins['addon']
    # Reuse an existing addon checkout if already provided via env or sibling Battle Revolution work dir
    for candidate in (
        os.environ.get('GAMECUBE_ADDON'),
        os.path.join(work, 'addon'),
        os.path.join(os.path.dirname(os.path.abspath(work)), 'battle-revolution', 'addon'),
    ):
        if not candidate:
            continue
        stamp = os.path.join(candidate, '.commit')
        if os.path.exists(stamp) and open(stamp).read().strip() == pin['commit']:
            return candidate
        if os.path.exists(os.path.join(candidate, 'exporter', 'phases', 'compose', 'compose.py')):
            return candidate

    target = os.path.join(work, 'addon')
    archive = os.path.join(work, 'addon.tar.gz')
    download(pin['url'], pin['sha256'], archive)
    say("Preparing the model tools: StarsMmd's Blender-Addon-Gamecube-Models")
    if os.path.exists(target):
        shutil.rmtree(target)
    unpack = target + '.part'
    if os.path.exists(unpack):
        shutil.rmtree(unpack)
    with tarfile.open(archive) as tar:
        members = [m for m in tar.getmembers() if m.isfile() or m.isdir()]
        for m in members:
            parts = m.name.split('/', 1)
            if len(parts) < 2 or not parts[1] or parts[1].startswith('/') or '..' in parts[1].split('/'):
                continue
            m.name = parts[1]
            tar.extract(m, unpack)
    os.replace(unpack, target)
    with open(os.path.join(target, '.commit'), 'w') as f:
        f.write(pin['commit'])
    os.remove(archive)
    return target


def main():
    if len(sys.argv) < 4:
        raise SystemExit(__doc__)
    rom_path, work, numbers = sys.argv[1], sys.argv[2], [int(n) for n in sys.argv[3:]]
    os.makedirs(work, exist_ok=True)
    pins = json.load(open(os.path.join(HERE, 'downloads.json')))
    os.environ['GAMECUBE_ADDON'] = addon(pins, work)
    say('Reading your 3DS Pokémon ROM')
    with rom3ds.Rom3DS(rom_path) as rom:
        if rom.product_code not in rom3ds.PRODUCT_CODES:
            raise SystemExit("That 3DS ROM (%s) isn't Pokémon Ultra Sun, Ultra Moon, Sun, or Moon." % rom.product_code)
    say('Making models for %d Pokémon' % len(numbers))
    sys.argv = [sys.argv[0], '--by-number', '--keep', rom_path, os.path.join(work, 'models'), 'Ultra Sun / Ultra Moon'] + [str(n) for n in numbers]
    import make_pack
    make_pack.main()
    say('Done')


if __name__ == '__main__':
    main()
