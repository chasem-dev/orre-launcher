"""A Pokémon pack (models/N/ folders for the launcher) directly from a decrypted 3DS Gen 7 ROM.

usage: make_pack.py [--by-number] [--keep] ROM_3DS OUT_DIR PACK_NAME NUMBER...

Each National Pokédex NUMBER becomes a folder (named after the Pokémon, or with --by-number its
number, as the launcher keeps them) with:
  pokemon.json       Stats, types, abilities, level-up moves, TM moves and evolutions
  model.pkx          3DS battle model converted to GameCube PKX (convert.py)
  model-shiny.pkx    Shiny battle model (reusing geometry/skeleton/animations)
  body.png, body-shiny.png, face.png, face-shiny.png   2D menu portraits from /a/2/4/4
  cry.wav            Cry from /a/0/7/3 (cries.py)
  models-version.txt Converter version stamp (remade.json)
"""
import json
import os
import sys

import convert
import cries
import rom3ds
import usumdata

CREDITS = (
    "StarsMmd: the models are written by his Blender-Addon-Gamecube-Models (GPL-3.0). "
    "gdkchan: the 3DS GFModel/GFMotion/PICA200 format reference from SPICA."
)
COLOSSEUM_MOVES = 354
COLOSSEUM_ABILITIES = 76
BASES = {
    'Grass': ['Treecko', 'Grovyle', 'Sceptile'],
    'Fire': ['Torchic', 'Combusken', 'Blaziken'],
    'Water': ['Mudkip', 'Marshtomp', 'Swampert'],
    'Normal': ['Zigzagoon', 'Linoone', 'Linoone'],
    'Electric': ['Electrike', 'Manectric', 'Manectric'],
    'Bug': ['Wurmple', 'Silcoon', 'Beautifly'],
    'Flying': ['Taillow', 'Swellow', 'Swellow'],
    'Psychic': ['Ralts', 'Kirlia', 'Gardevoir'],
    'Rock': ['Aron', 'Lairon', 'Aggron'],
    'Ground': ['Trapinch', 'Vibrava', 'Flygon'],
    'Ghost': ['Shuppet', 'Banette', 'Banette'],
    'Ice': ['Snorunt', 'Glalie', 'Glalie'],
    'Dragon': ['Bagon', 'Shelgon', 'Salamence'],
    'Dark': ['Poochyena', 'Mightyena', 'Mightyena'],
    'Steel': ['Beldum', 'Metang', 'Metagross'],
    'Poison': ['Gulpin', 'Swalot', 'Swalot'],
    'Fighting': ['Makuhita', 'Hariyama', 'Hariyama'],
    'Fairy': ['Ralts', 'Kirlia', 'Gardevoir'],
}

REMADE = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'remade.json'), encoding='utf-8'))
STAMP = 'models-version.txt'
here = {}


def outdated(folder, n):
    try:
        made_by = int(open(os.path.join(folder, STAMP)).read().strip())
    except (OSError, ValueError):
        made_by = 1
    return any(int(version) > made_by and n in numbers for version, numbers in REMADE['remade'].items())


def pokemon_json(game, number, folders):
    s = game.species(number)
    # Stand-in types for standalone pack.json (Fairy falls back to Psychic for base Colosseum)
    types = ['Psychic' if t == 'Fairy' else t for t in s['types']]
    types = list(dict.fromkeys(types)) or ['Normal']
    base = BASES.get(s['types'][0], BASES['Normal'])[game.stage_of(number) - 1]
    gender = s['gender']
    spec = {
        'base': base,
        'name': s['name'][:10],
        'description': 'From Pokémon Ultra Sun / Ultra Moon, National Pokédex #%d.' % number,
        'types': types,
        'stats': s['stats'],
        'evYield': s['evYield'],
        'catchRate': s['catchRate'],
        'baseExp': s['baseExp'],
        'baseFriendship': s['baseFriendship'],
        'growthRate': s['growthRate'],
        'gender': 'genderless' if gender == 255 else 100 if gender == 254 else 0 if gender == 0 else round((gender + 1) / 2.56, 1),
        'height': s['height'],
        'weight': s['weight'],
        'moves': [[lvl, mid] for lvl, mid in s['moves'] if mid <= COLOSSEUM_MOVES][:20] or [[1, 33]],
        'tmMoves': sorted({mid for mid in s['tms'] if mid <= COLOSSEUM_MOVES}),
    }
    abilities = [a for a in s['abilities'] if 0 < a <= COLOSSEUM_ABILITIES]
    if abilities:
        spec['abilities'] = abilities[:2]
    evolutions = []
    for method, param, into, _form, level in s['evolutions']:
        target = folders.get(into, into if into <= 386 else None)
        if target is None:
            continue
        if method == 4 and level:
            evolutions.append({'into': target, 'level': level})
        elif method in (1, 2, 3):
            evolutions.append({'into': target, 'friendship': True})
        elif method == 5:
            evolutions.append({'into': target, 'trade': True})
    if evolutions:
        spec['evolutions'] = evolutions[:5]
    return spec


def start(setup):
    rom_path, out, by_number, keep, numbers, cry_map, pokepic_index = setup
    rom = rom3ds.Rom3DS(rom_path)
    game = usumdata.USUMData(rom)
    game._pokepic_index = pokepic_index
    folders = {n: str(n) if by_number else game.species(n)['name'].lower().replace(' ', '-') for n in numbers}
    here.update(rom=rom, game=game, out=out, keep=keep, folders=folders, cry_map=cry_map)


def make_one(n):
    rom, game, folders = here['rom'], here['game'], here['folders']
    folder = os.path.join(here['out'], folders[n])
    os.makedirs(folder, exist_ok=True)
    spec = pokemon_json(game, n, folders)
    with open(os.path.join(folder, 'pokemon.json'), 'w', encoding='utf-8') as f:
        json.dump(spec, f, indent=2, ensure_ascii=False)
    lines = ['#%d %s: base %s' % (n, spec['name'], spec['base'])]

    # 2D Portraits from /a/2/4/4
    need_icons = not (here['keep'] and all(
        os.path.exists(os.path.join(folder, f)) for f in ('body.png', 'body-shiny.png', 'face.png', 'face-shiny.png')
    ))
    if need_icons:
        body_n, body_s, face_n, face_s = game.icon_pngs(n)
        for fname, blob in (('body.png', body_n), ('body-shiny.png', body_s), ('face.png', face_n), ('face-shiny.png', face_s)):
            if blob:
                p = os.path.join(folder, fname)
                with open(p + '.part', 'wb') as f:
                    f.write(blob)
                os.replace(p + '.part', p)

    # Read 3DS model slot once (needed for both Gen 6 cry dev-ID lookup and 3D model conversion)
    slot_data = None
    cry_path = os.path.join(folder, 'cry.wav')
    need_cry = not (here['keep'] and os.path.exists(cry_path))
    stale = outdated(folder, n)
    model_path = os.path.join(folder, 'model.pkx')
    shiny_path = os.path.join(folder, 'model-shiny.pkx')
    need_normal = not (here['keep'] and os.path.exists(model_path) and not stale)
    need_shiny = not (here['keep'] and os.path.exists(shiny_path) and not stale)

    if need_normal or need_shiny or (need_cry and n > 649):
        slot_data = rom.read_pokemon_slot(n)

    if need_cry:
        cwar_entry = cries.cry_entry_for_species(rom, here['cry_map'], n, slot_data)
        if cwar_entry is not None:
            cwar_data = rom.garc('/a/0/7/3').get_entry(cwar_entry, decomp=False)
            wav_bytes, seconds = cries.cry_wav(cwar_data)
            with open(cry_path + '.part', 'wb') as f:
                f.write(wav_bytes)
            os.replace(cry_path + '.part', cry_path)
            lines.append('  cry.wav: %.2f s' % seconds)

    quiet = lambda *a: None
    made = []
    if need_normal and need_shiny:
        first, second = convert.convert_pair(slot_data, folders[n], folders[n] + '_rare', log=quiet)
        made = [(model_path, first), (shiny_path, second)]
    elif need_normal:
        made = [(model_path, convert.convert(slot_data, folders[n], shiny=False, log=quiet))]
    elif need_shiny:
        made = [(shiny_path, convert.convert(slot_data, folders[n] + '_rare', shiny=True, log=quiet))]

    for path, pkx in made:
        with open(path + '.part', 'wb') as f:
            f.write(pkx)
        os.replace(path + '.part', path)
        lines.append('  %s: %d bytes' % (os.path.basename(path), len(pkx)))

    with open(os.path.join(folder, STAMP), 'w', encoding='utf-8') as f:
        f.write('%d\n' % REMADE['version'])
    return lines


def main():
    args = sys.argv[1:]
    by_number = '--by-number' in args
    keep = '--keep' in args or bool(os.environ.get('KEEP_MODELS'))
    args = [a for a in args if a not in ('--by-number', '--keep')]
    rom_path, out, pack_name, numbers = args[0], args[1], args[2], [int(n) for n in args[3:]]
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, 'pack.json'), 'w', encoding='utf-8') as f:
        json.dump({'name': pack_name, 'author': '3ds2pkx, from Pokémon Ultra Sun / Ultra Moon',
                   'credits': CREDITS}, f, indent=2, ensure_ascii=False)

    # Precompute cry map and pokepic index once in parent so workers skip scanning /a/0/7/3 and /a/2/4/4
    with rom3ds.Rom3DS(rom_path) as rom:
        cry_map = cries.build_cry_map(rom)
        pokepic_index = usumdata.USUMData(rom).pokepic_index()

    count = int(os.environ.get('USUM2PKX_JOBS') or 0) or min(4, os.cpu_count() or 1)
    count = max(1, min(count, len(numbers)))
    setup = (rom_path, out, by_number, keep, numbers, cry_map, pokepic_index)
    if count == 1:
        start(setup)
        done = map(make_one, numbers)
    else:
        from concurrent.futures import ProcessPoolExecutor
        pool = ProcessPoolExecutor(count, initializer=start, initargs=(setup,))
        done = pool.map(make_one, numbers)
    for i, lines in enumerate(done, 1):
        print('\n'.join(lines + ['Made %d of %d Pokémon' % (i, len(numbers))]), flush=True)
    if count > 1:
        pool.shutdown()


if __name__ == '__main__':
    main()
