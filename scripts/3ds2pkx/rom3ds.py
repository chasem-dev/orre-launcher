"""Direct reader for decrypted Nintendo 3DS (.3ds) Gen 7 Pokémon ROMs (USUM / SM).

Reads NCSD -> NCCH Partition 0 -> IVFC Level 3 RomFS -> GARC v6 -> LZSS (0x11) -> GF mini-archives
straight from the .3ds file via seek()/read() with no external extraction tools and no 4 GB temp copy.
"""
import struct

PRODUCT_CODES = {
    'CTR-P-A2AA': ('Pokémon Ultra Sun', True),
    'CTR-P-A2BA': ('Pokémon Ultra Moon', True),
    'CTR-P-BNDA': ('Pokémon Sun', False),
    'CTR-P-BNEA': ('Pokémon Moon', False),
}


def decompress_lzss11(data):
    """Decompress Nintendo 3DS LZSS (type 0x11) stream."""
    if not data or data[0] != 0x11:
        return data
    decomp_sz = data[1] | (data[2] << 8) | (data[3] << 16)
    if decomp_sz == 0 or decomp_sz > 64 * 1024 * 1024:
        return data
    out = bytearray(decomp_sz)
    out_pos = 0
    pos = 4
    n = len(data)
    while out_pos < decomp_sz and pos < n:
        flags = data[pos]
        pos += 1
        for bit in range(7, -1, -1):
            if out_pos >= decomp_sz or pos >= n:
                break
            if not (flags & (1 << bit)):
                out[out_pos] = data[pos]
                out_pos += 1
                pos += 1
            else:
                b0 = data[pos]
                top = b0 >> 4
                if top == 0:
                    b1, b2 = data[pos + 1], data[pos + 2]
                    pos += 3
                    length = (((b0 & 0xF) << 4) | (b1 >> 4)) + 0x11
                    disp = (((b1 & 0xF) << 8) | b2) + 1
                elif top == 1:
                    b1, b2, b3 = data[pos + 1], data[pos + 2], data[pos + 3]
                    pos += 4
                    length = (((b0 & 0xF) << 12) | (b1 << 4) | (b2 >> 4)) + 0x111
                    disp = (((b2 & 0xF) << 8) | b3) + 1
                else:
                    b1 = data[pos + 1]
                    pos += 2
                    length = top + 1
                    disp = (((b0 & 0xF) << 8) | b1) + 1
                if out_pos + length > decomp_sz:
                    length = decomp_sz - out_pos
                if disp >= length:
                    src = out_pos - disp
                    out[out_pos:out_pos + length] = out[src:src + length]
                    out_pos += length
                else:
                    for _ in range(length):
                        out[out_pos] = out[out_pos - disp]
                        out_pos += 1
    return bytes(out[:out_pos])


def parse_mini(data):
    """Parse a Game Freak 2-letter mini-archive (PC, PS, CM, etc.). Returns (magic_str, list[bytes]) or None."""
    if len(data) < 8:
        return None
    if not (65 <= data[0] <= 90 and 65 <= data[1] <= 90):
        return None
    cnt = struct.unpack_from('<H', data, 2)[0]
    if cnt == 0 or cnt > 5000 or 4 + (cnt + 1) * 4 > len(data):
        return None
    offs = struct.unpack_from('<%dI' % (cnt + 1), data, 4)
    if offs[0] < 4 + (cnt + 1) * 4 or offs[-1] > len(data):
        return None
    for i in range(cnt):
        if offs[i] > offs[i + 1]:
            return None
    return data[:2].decode('ascii'), [data[offs[i]:offs[i + 1]] for i in range(cnt)]


class GARCReader:
    def __init__(self, f, abs_off, sz):
        self.f = f
        self.abs_off = abs_off
        self.sz = sz
        f.seek(abs_off)
        hdr = f.read(0x24)
        if hdr[:4] != b'CRAG':
            raise ValueError('Not a GARC archive')
        self.hdr_len, _bom, self.ver, _chunks, self.data_off, self.file_sz = struct.unpack_from('<IHHIII', hdr, 4)
        f.seek(abs_off + self.hdr_len)
        _fato_magic, fato_len, self.entry_cnt = struct.unpack('<4sIH', f.read(10))
        f.seek(abs_off + self.hdr_len + 12)
        self.fato_offs = struct.unpack('<%dI' % self.entry_cnt, f.read(4 * self.entry_cnt))
        self.fatb_base = abs_off + self.hdr_len + fato_len
        f.seek(self.fatb_base)
        _fatb_magic, _fatb_len, self.fatb_cnt = struct.unpack('<4sII', f.read(12))
        self.fatb_entries_base = self.fatb_base + 12
        self.data_base = abs_off + self.data_off

    def get_entry_raw(self, idx, sub_idx=0):
        self.f.seek(self.fatb_entries_base + self.fato_offs[idx])
        bits = struct.unpack('<I', self.f.read(4))[0]
        cur = 0
        for b in range(32):
            if bits & (1 << b):
                start, _end, esz = struct.unpack('<III', self.f.read(12))
                if cur == sub_idx:
                    if esz == 0:
                        return b''
                    self.f.seek(self.data_base + start)
                    return self.f.read(esz)
                cur += 1
        return b''

    def get_entry(self, idx, sub_idx=0, decomp=True):
        raw = self.get_entry_raw(idx, sub_idx)
        if decomp and raw and raw[0] == 0x11:
            return decompress_lzss11(raw)
        return raw


class Rom3DS:
    """Open a decrypted .3ds ROM and read RomFS files / GARCs directly."""

    def __init__(self, path):
        self.path = path
        self.f = open(path, 'rb')
        self.f.seek(0x100)
        if self.f.read(4) != b'NCSD':
            raise ValueError('Not a Nintendo 3DS (.3ds) NCSD file')
        self.f.seek(0x120)
        p0_off_u, p0_len_u = struct.unpack('<II', self.f.read(8))
        self.ncch_off = p0_off_u * 0x200
        self.f.seek(self.ncch_off + 0x100)
        if self.f.read(4) != b'NCCH':
            raise ValueError('Partition 0 is not a valid NCCH')
        self.f.seek(self.ncch_off + 0x150)
        self.product_code = self.f.read(16).split(b'\x00', 1)[0].decode('ascii', errors='replace')
        self.f.seek(self.ncch_off + 0x188)
        flags = self.f.read(8)
        if not (flags[7] & 0x04):
            raise ValueError('This 3DS ROM is encrypted. Decrypt it first (NoCrypto flag is not set).')
        self.f.seek(self.ncch_off + 0x1B0)
        romfs_off_u, romfs_sz_u = struct.unpack('<II', self.f.read(8))
        self.romfs_base = self.ncch_off + romfs_off_u * 0x200
        self.romfs_sz = romfs_sz_u * 0x200

        self.f.seek(self.romfs_base)
        if self.f.read(4) != b'IVFC':
            raise ValueError('RomFS is encrypted or damaged (bad IVFC magic)')
        _, master_hash_sz = struct.unpack('<II', self.f.read(8))
        levels = []
        for _ in range(3):
            loff, sz, bsz, _ = struct.unpack('<QQII', self.f.read(24))
            levels.append((loff, sz, 1 << bsz))
        l3_block = levels[2][2]
        l3_off = ((0x60 + master_hash_sz + l3_block - 1) // l3_block) * l3_block
        self.l3_base = self.romfs_base + l3_off
        self.f.seek(self.l3_base)
        hdr = struct.unpack('<10I', self.f.read(40))
        if hdr[0] != 0x28:
            raise ValueError('Unexpected RomFS Level 3 header')
        self.dir_meta_off, self.dir_meta_len = hdr[3], hdr[4]
        self.file_meta_off, self.file_meta_len = hdr[7], hdr[8]
        self.data_off = hdr[9]

        self.f.seek(self.l3_base + self.dir_meta_off)
        self.dir_meta = self.f.read(self.dir_meta_len)
        self.f.seek(self.l3_base + self.file_meta_off)
        self.file_meta = self.f.read(self.file_meta_len)
        self.files = {}
        self._walk_dir(0, '')
        self._garcs = {}
        self._model_index = None

    def close(self):
        if self.f:
            self.f.close()
            self.f = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def _walk_dir(self, off, prefix):
        _, _, child_dir, child_file, _, name_len = struct.unpack_from('<6I', self.dir_meta, off)
        name = self.dir_meta[off + 24:off + 24 + name_len].decode('utf-16le')
        cur_path = f'{prefix}/{name}' if name else ''
        foff = child_file
        while foff != 0xFFFFFFFF:
            _, fsib, data_off, data_sz, _, fname_len = struct.unpack_from('<IIQQII', self.file_meta, foff)
            fname = self.file_meta[foff + 32:foff + 32 + fname_len].decode('utf-16le')
            fpath = f'{cur_path}/{fname}' if cur_path else f'/{fname}'
            self.files[fpath] = (self.l3_base + self.data_off + data_off, data_sz)
            foff = fsib
        doff = child_dir
        while doff != 0xFFFFFFFF:
            self._walk_dir(doff, cur_path)
            _, doff, _, _, _, _ = struct.unpack_from('<6I', self.dir_meta, doff)

    def garc(self, romfs_path):
        if romfs_path not in self._garcs:
            off, sz = self.files[romfs_path]
            self._garcs[romfs_path] = GARCReader(self.f, off, sz)
        return self._garcs[romfs_path]

    def model_index(self):
        """Return (species_table, fallback_table) from /a/0/9/4 Entry 0."""
        if self._model_index is None:
            g = self.garc('/a/0/9/4')
            e0 = g.get_entry(0, decomp=False)
            total_slots = (g.entry_cnt - 1) // 9
            # Entry 0 = (species_count * 4) + (total_slots * 2)
            species_count = (len(e0) - total_slots * 2) // 4
            sp_tbl = [struct.unpack_from('<HBB', e0, i * 4) for i in range(species_count)]
            part_b = [struct.unpack_from('<BB', e0, species_count * 4 + i * 2) for i in range(total_slots)]
            self._model_index = (sp_tbl, part_b)
        return self._model_index

    def resolve_model_slot(self, national, form=0, female=False):
        """Return (slot, fallback_flags, target_slot) for a National Dex number and form."""
        sp_tbl, part_b = self.model_index()
        if national < 1 or national > len(sp_tbl):
            raise KeyError('National Dex #%d not in ROM' % national)
        start, cnt, flags = sp_tbl[national - 1]
        has_female = bool(flags & 0x02)
        if form == 0:
            offset = 1 if (female and has_female) else 0
        else:
            offset = form + (1 if has_female else 0)
        if offset >= cnt:
            offset = 0
        slot = start + offset
        fb_flags, fb_target = part_b[slot]
        # fb_target is a form index (0 = base; if species has female diff and fb_target > 0, add 1)
        if fb_target == 0:
            target_slot = start
        else:
            target_slot = start + fb_target + (1 if has_female else 0)
        if target_slot >= start + cnt:
            target_slot = start
        return slot, fb_flags, target_slot

    def read_pokemon_slot(self, national, form=0, female=False):
        """Return dict with raw decompressed sub-archives for model, normal tex, shiny tex, battle motions, meta."""
        g = self.garc('/a/0/9/4')
        slot, fb_flags, target_slot = self.resolve_model_slot(national, form, female)
        asset_slot = target_slot if fb_flags == 7 else slot
        base = 1 + asset_slot * 9
        model_pc = parse_mini(g.get_entry(base + 0))
        normal_pc = parse_mini(g.get_entry(base + 1))
        shiny_pc = parse_mini(g.get_entry(base + 2))
        battle_pc = parse_mini(g.get_entry(base + 4))
        # If partial animation fallback (fb_flags == 1) and target differs, fill empty battle motion slots
        if fb_flags == 1 and target_slot != asset_slot:
            fb_battle = parse_mini(g.get_entry(1 + target_slot * 9 + 4))
            if battle_pc and fb_battle:
                merged = [a if a else b for a, b in zip(battle_pc[1], fb_battle[1])]
                battle_pc = (battle_pc[0], merged)
        meta_pc = parse_mini(g.get_entry(1 + slot * 9 + 8))
        return {
            'slot': slot,
            'asset_slot': asset_slot,
            'model_pc': model_pc[1] if model_pc else [],
            'normal_tex_pc': normal_pc[1] if normal_pc else [],
            'shiny_tex_pc': shiny_pc[1] if shiny_pc else [],
            'battle_motions': battle_pc[1] if battle_pc else [],
            'meta': meta_pc[1] if meta_pc else [],
        }
