"""Item icons from the player's decrypted 3DS Gen 7 ROM (Ultra Sun / Ultra Moon / Sun / Moon), for the bag's and shops'
item pictures in the port (host/itemsprites.c, COLO_ITEM_SPRITES).

  python item_icons.py ROM OUT

writes OUT/<name>.png for every item the ROM has a name and an icon for, named the way the port looks them up: the
English name in lower case, words joined by hyphens, other marks left out, é an e (Hyper Potion: hyper-potion.png,
Poké Ball: poke-ball.png, King's Rock: kings-rock.png). Gen 3's spellings the games use that later games changed
(ENERGYPOWDER, PARLYZ HEAL, X SPECIAL...) get a copy under that name too (ALIASES). TMs: tm-<type>.png, one per move
type, from the ROM's TM of that type, since a TM's picture is its type's disc and the GameCube games' TM numbers teach
other moves than Gen 7's. Last, OUT/item-icons-version.txt, VERSION: the launcher makes them again when that changes.

Where things are:
  /a/0/6/1  the icons: FLIM textures, 32 x 32 RGBA5551, stored turned (the BFLIM swizzle 4)
  /a/0/3/2  text: the item names file is found by what it holds (Master Ball first, then Ultra, Great, Poké Ball)
  /a/0/1/1  move data (WD mini-archive, 40 bytes a move, its type first): the TMs' types
  code.bin  (ExeFS, compressed) each item's icon: a table of (u16 icon, u16 0) per item, found by how it starts: item
            0 has the last icon (none), and the 16 balls have icons 0 to 15
"""
import os
import struct
import sys

from rom3ds import Rom3DS, parse_mini
import gftexture as gt
from usumdata import decode_text_file, TYPES, USUM_TMS

VERSION = 1

# BFLIM's format numbers, as gftexture's PICA200 ones
FLIM_FORMATS = {0: gt.FMT_L8, 1: gt.FMT_A8, 2: gt.FMT_LA4, 3: gt.FMT_LA8, 4: gt.FMT_HILO8, 5: gt.FMT_RGB565,
                6: gt.FMT_RGB8, 7: gt.FMT_RGBA5551, 8: gt.FMT_RGBA4, 9: gt.FMT_RGBA8, 10: gt.FMT_ETC1,
                11: gt.FMT_ETC1A4, 12: gt.FMT_L4, 13: gt.FMT_A4}

# Gen 3 names (as the GameCube games spell them, made file names) -> Gen 7's
ALIASES = {
    'energypowder': 'energy-powder', 'parlyz-heal': 'paralyze-heal', 'x-defend': 'x-defense',
    'x-special': 'x-sp-atk', 'thunderstone': 'thunder-stone', 'tinymushroom': 'tiny-mushroom',
    'brightpowder': 'bright-powder', 'silverpowder': 'silver-powder', 'deepseatooth': 'deep-sea-tooth',
    'deepseascale': 'deep-sea-scale', 'twistedspoon': 'twisted-spoon', 'blackglasses': 'black-glasses',
    'nevermeltice': 'never-melt-ice',
}


def slug(name):
    """A name as the port makes it a file name (host/itemsprites.c slug_of)."""
    out, hyphen = [], False
    for ch in name:
        c = ch.lower()
        if c in 'éÉ':
            c = 'e'
        if ('a' <= c <= 'z') or ('0' <= c <= '9'):
            if hyphen and out:
                out.append('-')
            hyphen = False
            out.append(c)
        elif c in ' -_':
            hyphen = True
    return ''.join(out)


def blz_decompress(data):
    """The 3DS ExeFS code compression: LZ77 read backwards from the end."""
    top, extra = struct.unpack_from('<II', data, len(data) - 8)
    header, encoded = top >> 24, top & 0xFFFFFF
    out = bytearray(data) + bytearray(extra)
    src, dst, end = len(data) - header, len(out), len(data) - encoded
    while src > end:
        src -= 1
        flags = out[src]
        for _ in range(8):
            if src <= end:
                break
            if flags & 0x80:
                src -= 2
                pair = out[src] | out[src + 1] << 8
                length, disp = (pair >> 12) + 3, (pair & 0xFFF) + 3
                if disp >= length:   # no overlap: one slice
                    out[dst - length:dst] = out[dst - length + disp:dst + disp]
                    dst -= length
                else:
                    for _ in range(length):
                        dst -= 1
                        out[dst] = out[dst + disp]
            else:
                src -= 1
                dst -= 1
                out[dst] = out[src]
            flags = (flags << 1) & 0xFF
    return bytes(out)


def code_bin(rom):
    """The game's code from the ExeFS, decompressed if its extended header says it is compressed."""
    f = rom.f
    f.seek(rom.ncch_off + 0x1A0)
    exefs_off, _ = struct.unpack('<II', f.read(8))
    base = rom.ncch_off + exefs_off * 0x200
    f.seek(base)
    header = f.read(0x200)
    for i in range(10):
        name = header[i * 16:i * 16 + 8].rstrip(b'\0')
        off, size = struct.unpack_from('<II', header, i * 16 + 8)
        if name == b'.code':
            f.seek(base + 0x200 + off)
            raw = f.read(size)
            f.seek(rom.ncch_off + 0x200 + 0xD)   # the extended header's system control flags: bit 0, compressed
            return blz_decompress(raw) if f.read(1)[0] & 1 else raw
    raise ValueError('The ROM has no code in its ExeFS')


def icon_table(code, icons, items):
    """Each item's icon number, from code.bin: up to `items` long, ending sooner where the table does (an entry that
    isn't (icon, 0) with an icon the ROM has), so a ROM with more names than icon entries loses only those items."""
    start = struct.pack('<2H', icons - 1, 0) + b''.join(struct.pack('<2H', i, 0) for i in range(16))
    at = code.find(start)
    if at < 0 or code.find(start, at + 1) >= 0:
        raise ValueError('The item icon table was not found in the ROM\'s code')
    table = []
    for item in range(min(items, (len(code) - at) // 4)):
        icon, zero = struct.unpack_from('<2H', code, at + item * 4)
        if zero or icon >= icons:
            break
        table.append(icon)
    return table


def item_names(rom):
    text = rom.garc('/a/0/3/2')
    for i in range(text.entry_cnt):
        try:
            names = decode_text_file(text.get_entry(i))
        except Exception:
            continue
        if len(names) > 16 and names[1:4] == ['Master Ball', 'Ultra Ball', 'Great Ball'] and slug(names[4]) == 'poke-ball':
            return names
    raise ValueError('The item names were not found in the ROM\'s text')


def move_types(rom):
    data = rom.garc('/a/0/1/1').get_entry(0)
    mini = parse_mini(data)
    if not mini:
        raise ValueError('The move data was not found in the ROM')
    return [TYPES[m[0]] if m and m[0] < len(TYPES) else None for m in mini[1]]


def decode_icon(data):
    """A FLIM icon as (width, height, RGBA rows top down)."""
    foot = data[-0x28:]
    if foot[:4] != b'FLIM' or foot[0x14:0x18] != b'imag':
        raise ValueError('not a FLIM image')
    w, h, _align, fmt, swizzle = struct.unpack_from('<HHHBB', foot, 0x1C)
    turned = swizzle == 4   # stored turned a quarter: its rows are the picture's columns, bottom first
    sw, sh = (h, w) if turned else (w, h)
    pw, ph = max(8, 1 << (sw - 1).bit_length()), max(8, 1 << (sh - 1).bit_length())
    rgba = gt.decode_pica_texture(data[:-0x28], pw, ph, FLIM_FORMATS[fmt])
    out = bytearray(w * h * 4)
    for y in range(h):
        for x in range(w):
            sx, sy = (h - 1 - y, x) if turned else (x, y)
            o, s = (y * w + x) * 4, (sy * pw + sx) * 4
            out[o:o + 4] = rgba[s:s + 4]
    return w, h, bytes(out)


def main(rom_path, out):
    os.makedirs(out, exist_ok=True)
    with Rom3DS(rom_path) as rom:
        icons = rom.garc('/a/0/6/1')
        names = item_names(rom)
        table = icon_table(code_bin(rom), icons.entry_cnt, len(names))
        types = move_types(rom)
        pngs = {}
        def png(icon):
            if icon not in pngs:
                pngs[icon] = gt.encode_png(*decode_icon(icons.get_entry(icon)))
            return pngs[icon]
        files = {}
        if len(table) < len(names):
            print('item icons: the icon table ends at item %d of %d; the rest have none' % (len(table), len(names)))
        names = names[:len(table)]
        for item, name in enumerate(names):
            key = slug(name)
            numbered_machine = key[:2] in ('tm', 'hm', 'tr') and key[2:].isdigit()   # by type instead, below
            if item and key and not numbered_machine and key not in files and table[item] != icons.entry_cnt - 1:
                files[key] = table[item]
        for gen3, gen7 in ALIASES.items():
            if gen7 in files:
                files.setdefault(gen3, files[gen7])
        # TMs by type: TM01..TM100 are items named so, each teaching USUM_TMS's move (the same TMs in Sun and Moon)
        for item, name in enumerate(names):
            if name.startswith('TM') and name[2:].isdigit() and 1 <= int(name[2:]) <= len(USUM_TMS):
                move = USUM_TMS[int(name[2:]) - 1]
                kind = types[move] if move < len(types) else None
                if kind:
                    files.setdefault('tm-' + kind.lower(), table[item])
        for key, icon in files.items():
            with open(os.path.join(out, key + '.png'), 'wb') as f:
                f.write(png(icon))
    with open(os.path.join(out, 'item-icons-version.txt'), 'w') as f:
        f.write('%d\n' % VERSION)
    print('item icons: %d files from %d icons' % (len(files), len(pngs)))


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('usage: item_icons.py ROM OUT')
    main(sys.argv[1], sys.argv[2])
