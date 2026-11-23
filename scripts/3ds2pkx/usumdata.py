"""Pokémon data & 2D portraits directly from a decrypted 3DS Gen 7 ROM (USUM / SM).

Reads:
  /a/0/1/7  Personal Info (base stats, types, catch rate, EV yield, gender, friendship, growth, abilities, height, weight, TMs)
  /a/0/1/3  Level-up learnsets ((u16 move_id, u16 level) pairs terminated by 0xFFFF, 0xFFFF)
  /a/0/1/4  Evolutions (8 x 8-byte entries per species)
  /a/0/1/1  Move data (WD mini-archive, 40 bytes per move)
  /a/0/3/2  English text (species names [60], ability names [101], move descriptions [117], move names [118])
  /a/2/4/4  128x128 ETC1A4 pokepic portraits (normal & shiny)
"""
import re
import struct

from rom3ds import parse_mini
import gftexture

TYPES = [
    'Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel',
    'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark', 'Fairy',
]

GROWTH_RATES = ['mediumFast', 'erratic', 'fluctuating', 'mediumSlow', 'fast', 'slow']

# USUM / SM TM01..TM100 move IDs (National move IDs, 0-indexed for TM bitmask at Personal+0x28).
# Used to map 3DS TM learnability onto Colosseum's TM/HM table.
USUM_TMS = [
    526, 337, 473, 347, 46, 92, 258, 339, 474, 237,
    241, 269, 58, 59, 63, 113, 182, 240, 355, 219,
    218, 76, 479, 85, 87, 89, 216, 141, 94, 247,
    280, 104, 115, 482, 53, 188, 201, 126, 317, 332,
    259, 263, 488, 156, 213, 168, 490, 496, 497, 315,
    211, 411, 412, 206, 503, 374, 451, 507, 693, 511,
    261, 512, 373, 153, 421, 371, 684, 416, 397, 694,
    444, 521, 86, 360, 14, 19, 244, 523, 524, 157,
    404, 525, 611, 398, 138, 447, 207, 214, 369, 164,
    430, 433, 528, 57, 555, 267, 399, 127, 605, 590,
]


def decode_text_file(data):
    """Decode one Gen 7 GF text binary from /a/0/3/2."""
    if not data or len(data) < 0x10:
        return []
    _sec_cnt, line_cnt, _total_len, _, sec_off = struct.unpack_from('<HHIII', data, 0)
    base = sec_off
    lines = []
    for i in range(line_cnt):
        loff, llen = struct.unpack_from('<II', data, base + 4 + i * 8)
        key = (0x7C89 + i * 0x2983) & 0xFFFF
        chars = []
        p = base + loff
        end_p = p + llen * 2
        while p + 2 <= end_p and p + 2 <= len(data):
            c = struct.unpack_from('<H', data, p)[0] ^ key
            key = ((key << 3) | (key >> 13)) & 0xFFFF
            p += 2
            if c == 0x0000:
                break
            if c == 0x0010:
                # Control sequence: length u16 + type u16 + args
                if p + 2 > end_p:
                    break
                var_len = struct.unpack_from('<H', data, p)[0] ^ key
                key = ((key << 3) | (key >> 13)) & 0xFFFF
                p += 2
                for _ in range(var_len):
                    if p + 2 > end_p:
                        break
                    key = ((key << 3) | (key >> 13)) & 0xFFFF
                    p += 2
                continue
            if c == 0x000A or c == 0x000D:
                chars.append(' ')
            elif c == 0xE08E:
                chars.append('♂')
            elif c == 0xE08F:
                chars.append('♀')
            elif c >= 0x20:
                chars.append(chr(c))
        text = re.sub(r'\s+', ' ', ''.join(chars)).strip()
        lines.append(text)
    return lines


class USUMData:
    """Lazy reader for species stats, moves, evolutions, text, and pokepic icons from Rom3DS."""

    def __init__(self, rom):
        self.rom = rom
        g32 = rom.garc('/a/0/3/2')
        self.species_names = decode_text_file(g32.get_entry(60))
        self.ability_names = decode_text_file(g32.get_entry(101))
        self.move_names = decode_text_file(g32.get_entry(118))
        self.move_descs = decode_text_file(g32.get_entry(117))
        self.personal = rom.garc('/a/0/1/7')
        self.learnsets = rom.garc('/a/0/1/3')
        self.evolutions_garc = rom.garc('/a/0/1/4')
        self._pokepic_index = None
        self._evo_parents = None

    def pokepic_index(self):
        """Return dict mapping (national, 'n'|'r') -> GARC entry index in /a/2/4/4."""
        if self._pokepic_index is None:
            g = self.rom.garc('/a/2/4/4')
            idx_map = {}
            for i in range(1, g.entry_cnt):
                raw = g.get_entry(i)
                if len(raw) >= 0x68 and struct.unpack_from('<I', raw, 0)[0] == 0x15041213:
                    name = raw[0x28:0x68].split(b'\x00', 1)[0].decode('ascii', errors='replace')
                    m = re.match(r'pokepic_(\d{3})_(\d{2})[^_]*_([nr])_', name)
                    if m:
                        nat, form, nr = int(m.group(1)), int(m.group(2)), m.group(3)
                        if form == 0 and (nat, nr) not in idx_map:
                            idx_map[(nat, nr)] = i
            self._pokepic_index = idx_map
        return self._pokepic_index

    def icon_pngs(self, national):
        """Return (body_normal_png, body_shiny_png, face_normal_png, face_shiny_png) or Nones."""
        idx_map = self.pokepic_index()
        g = self.rom.garc('/a/2/4/4')
        out = {}
        for nr in ('n', 'r'):
            entry_idx = idx_map.get((national, nr))
            if entry_idx is None:
                out[nr] = (None, None)
                continue
            tex = gftexture.read_gftexture(g.get_entry(entry_idx))
            if not tex:
                out[nr] = (None, None)
                continue
            # PICA200 decode_pica_texture produces top-down RGBA directly
            body = gftexture.encode_png(tex['width'], tex['height'], tex['rgba'])
            face = gftexture.make_face_png(tex['rgba'], tex['width'], tex['height'])
            out[nr] = (body, face)
        return out['n'][0], out['r'][0], out['n'][1], out['r'][1]

    def raw_evolutions(self, national):
        """Return list of (method, param, into_species, form, level) tuples."""
        data = self.evolutions_garc.get_entry(national)
        out = []
        for i in range(len(data) // 8):
            method, param, into, form, level = struct.unpack_from('<HHHbB', data, i * 8)
            if method and into:
                out.append((method, param, into, form, level))
        return out

    def stage_of(self, national):
        """1 for a base form, 2 for middle/first evo, 3 for second evo."""
        if self._evo_parents is None:
            parents = {}
            count = min(self.evolutions_garc.entry_cnt, len(self.species_names))
            for n in range(1, count):
                for _m, _p, into, _f, _l in self.raw_evolutions(n):
                    if into not in parents:
                        parents[into] = n
            self._evo_parents = parents
        stage = 1
        cur = national
        while cur in self._evo_parents and stage < 3:
            cur = self._evo_parents[cur]
            stage += 1
        return stage

    def species(self, national):
        """Return full parsed species dict for a National Dex number."""
        d = self.personal.get_entry(national)
        hp, atk, df, spe, spa, spd = d[0:6]
        t1, t2 = TYPES[d[6]], TYPES[d[7]]
        types = [t1] if t1 == t2 else [t1, t2]
        catch_rate = d[8]
        ev_bits = struct.unpack_from('<H', d, 10)[0]
        ev_yield = {
            'hp': (ev_bits >> 0) & 3,
            'attack': (ev_bits >> 2) & 3,
            'defense': (ev_bits >> 4) & 3,
            'speed': (ev_bits >> 6) & 3,
            'spAttack': (ev_bits >> 8) & 3,
            'spDefense': (ev_bits >> 10) & 3,
        }
        gender = d[0x12]
        friendship = d[0x14]
        growth = GROWTH_RATES[d[0x15]] if d[0x15] < len(GROWTH_RATES) else 'mediumFast'
        ab_ids = [a for a in (d[0x18], d[0x19]) if a > 0]
        abilities = list(dict.fromkeys(ab_ids))
        base_exp, h_cm, w_hg = struct.unpack_from('<HHH', d, 0x22)
        tm_bytes = d[0x28:0x3C]
        tms = []
        for idx, move_id in enumerate(USUM_TMS):
            byte_i, bit_i = idx >> 3, idx & 7
            if byte_i < len(tm_bytes) and (tm_bytes[byte_i] & (1 << bit_i)):
                tms.append(move_id)
        # Level-up learnset
        lraw = self.learnsets.get_entry(national)
        moves = []
        for i in range(0, len(lraw) - 3, 4):
            mid, lvl = struct.unpack_from('<HH', lraw, i)
            if mid == 0xFFFF and lvl == 0xFFFF:
                break
            if mid > 0:
                moves.append((max(1, lvl), mid))
        return {
            'national': national,
            'name': self.species_names[national] if national < len(self.species_names) else ('Pokemon %d' % national),
            'types': types,
            'stats': {'hp': hp, 'attack': atk, 'defense': df, 'spAttack': spa, 'spDefense': spd, 'speed': spe},
            'evYield': ev_yield,
            'catchRate': catch_rate,
            'baseExp': base_exp,
            'baseFriendship': friendship,
            'growthRate': growth,
            'gender': gender,
            'height': round(h_cm / 100.0, 2) if h_cm > 0 else 0.5,
            'weight': round(w_hg / 10.0, 1) if w_hg > 0 else 1.0,
            'abilities': abilities,
            'abilityNames': [self.ability_names[a] for a in abilities if a < len(self.ability_names)],
            'moves': moves,
            'tms': tms,
            'evolutions': self.raw_evolutions(national),
        }
