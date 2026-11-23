"""Nintendo 3DS Pokémon Ultra Sun / Ultra Moon / Sun / Moon cries (/a/0/7/3) as WAV files.

In /a/0/7/3, entries 0..(cseq_end-1) are CSEQ sequence headers whose LABL chunks carry the voice
identifier (`PV001`..`PV649` for Gens 1-5 by National Dex, `PVXY701`..`PVXY774` for Gen 6 by
internal dev ID `pm0XXX`, `PVNJ_801`.. for Gen 7), and entries cseq_end..end are CWAR wave
archives, each holding one mono Nintendo DSP-ADPCM CWAV.

Collapsing sub-sequences (5-entry groups, SMF_*, PVXY750_01..04, PVXY771_01..04) produces the
exact ordered list of voices matching the CWAR table (with a fixed +3 offset before PV124 from
extra Pikachu voice clips, dynamically derived as `cwar_count - len(groups)`).
"""
import re
import struct

QUIET = 32  # trailing silence threshold


def decode_cwar(cwar_data):
    """Decode the first CWAV inside a CWAR archive -> (samples_list, sample_rate)."""
    if not cwar_data or cwar_data[:4] != b'CWAR':
        raise ValueError('Not a CWAR archive')
    info_off = struct.unpack_from('<I', cwar_data, 0x18)[0]
    file_off = struct.unpack_from('<I', cwar_data, 0x24)[0]
    cnt = struct.unpack_from('<I', cwar_data, info_off + 8)[0]
    if cnt < 1:
        raise ValueError('Empty CWAR archive')
    _, _, woff, wsz = struct.unpack_from('<HHII', cwar_data, info_off + 12)
    cwav = cwar_data[file_off + 8 + woff:file_off + 8 + woff + wsz]
    if cwav[:4] != b'CWAV':
        raise ValueError('Not a CWAV inside CWAR')
    winfo = struct.unpack_from('<I', cwav, 0x18)[0]
    wdata = struct.unpack_from('<I', cwav, 0x24)[0]
    enc = cwav[winfo + 8]
    if enc != 2:
        raise ValueError('CWAV encoding %d is not DSP-ADPCM' % enc)
    sr, _loop_s, total_samples = struct.unpack_from('<III', cwav, winfo + 12)
    ch_off = winfo + 28 + struct.unpack_from('<I', cwav, winfo + 32 + 4)[0]
    sample_off = struct.unpack_from('<I', cwav, ch_off + 4)[0]
    adpcm_off = ch_off + struct.unpack_from('<I', cwav, ch_off + 12)[0]
    coefs = struct.unpack_from('<16h', cwav, adpcm_off)
    _ps, h1, h2 = struct.unpack_from('<Hhh', cwav, adpcm_off + 32)

    raw = cwav[wdata + 8 + sample_off:]
    samples = []
    at = 0
    n = 0
    raw_len = len(raw)
    while n < total_samples and at < raw_len:
        hdr = raw[at]
        scale = 1 << (hdr & 15)
        pred = (hdr >> 4) & 7
        c1, c2 = coefs[pred * 2], coefs[pred * 2 + 1]
        take = min(14, total_samples - n)
        for j in range(take):
            b = raw[at + 1 + (j >> 1)]
            nib = (b & 15) if (j & 1) else (b >> 4)
            if nib >= 8:
                nib -= 16
            v = (nib * scale * 2048 + c1 * h1 + c2 * h2 + 1024) >> 11
            if v < -32768:
                v = -32768
            elif v > 32767:
                v = 32767
            h2, h1 = h1, v
            samples.append(v)
        n += 14
        at += 8
    return samples[:total_samples], sr


def wav(samples, rate):
    body = struct.pack('<%dh' % len(samples), *samples)
    return (b'RIFF' + struct.pack('<I', 36 + len(body)) + b'WAVEfmt ' +
            struct.pack('<IHHIIHH', 16, 1, 1, rate, rate * 2, 2, 16) +
            b'data' + struct.pack('<I', len(body)) + body)


def cry_wav(cwar_data):
    """Convert a CWAR entry into a trimmed mono 16-bit PCM WAV. Returns (wav_bytes, seconds)."""
    samples, rate = decode_cwar(cwar_data)
    tail = rate // 20
    last = max((i for i, v in enumerate(samples) if abs(v) > QUIET), default=-1)
    if last >= 0:
        samples = samples[:min(len(samples), last + 1 + tail)]
    # Colosseum's cry buffer holds at most 4 seconds at 32000 Hz (128000 samples).
    max_samples = min(32000 * 4, rate * 4)
    if len(samples) > max_samples:
        samples = samples[:max_samples]
    return wav(samples, rate), len(samples) / rate


def build_cry_map(rom):
    """Build a dict mapping PV label (e.g. 'PV495', 'PVXY725') -> GARC entry index in /a/0/7/3."""
    g73 = rom.garc('/a/0/7/3')
    cseq_end = 0
    for i in range(g73.entry_cnt):
        if g73.get_entry_raw(i)[:4] == b'CWAR':
            cseq_end = i
            break
    cwar_cnt = g73.entry_cnt - cseq_end
    groups = []
    for i in range(cseq_end):
        d = g73.get_entry(i, decomp=False)
        idx = d.find(b'LABL')
        if idx == -1:
            continue
        lcnt = struct.unpack_from('<I', d, idx + 8)[0]
        if lcnt == 0:
            continue
        loff = struct.unpack_from('<I', d, idx + 12 + 4)[0]
        pos = idx + 8 + loff
        slen = struct.unpack_from('<I', d, pos + 8)[0]
        lbl = d[pos + 12:pos + 12 + slen].split(b'\x00', 1)[0].decode('ascii', errors='replace')
        if lbl.startswith('SMF_'):
            continue
        if lbl.startswith('PVXY750_0') or lbl.startswith('PVXY771_0'):
            continue
        if groups and groups[-1][1] == lbl and i - groups[-1][0] <= 4 and 'PV025' not in lbl:
            continue
        groups.append((i, lbl))
    offset = cwar_cnt - len(groups)
    label_to_entry = {}
    for idx, (_, lbl) in enumerate(groups):
        if lbl not in label_to_entry:
            entry = cseq_end + idx + offset
            if cseq_end <= entry < g73.entry_cnt:
                label_to_entry[lbl] = entry
    return label_to_entry


def cry_entry_for_species(rom, label_to_entry, national, model_slot_data=None):
    """Return the /a/0/7/3 GARC entry index for a National Dex species, or None."""
    if national <= 649:
        return label_to_entry.get('PV%03d' % national)
    if model_slot_data is None:
        model_slot_data = rom.read_pokemon_slot(national)
    # Extract internal dev ID `pm0XXX` from texture header name (fast: no pixel decoding)
    for tblob in model_slot_data.get('normal_tex_pc', []):
        if len(tblob) >= 0x68 and struct.unpack_from('<I', tblob, 0)[0] == 0x15041213:
            name = tblob[0x28:0x68].split(b'\x00', 1)[0].decode('ascii', errors='replace')
            m = re.match(r'pm0(\d{3})', name)
            if m:
                pm = int(m.group(1))
                key = ('PVXY%03d' if national <= 721 else 'PVNJ_%03d') % pm
                if key in label_to_entry:
                    return label_to_entry[key]
    return None
