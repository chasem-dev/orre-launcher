"""The add-on's CMPR (DXT1) texture encoder, the same bytes several times faster.

shared/texture_encoder.py encodes CMPR with numpy when it has it, and otherwise one 4x4 block at a time through small
helper functions, which is about a third of a model's time here. This is that pure-Python encoder (encode_cmpr and
_encode_dxt1_block) with the helpers written inline and each distinct block encoded once: its endpoints, by the same
search in the same order, its palette and its indices are what the add-on's give, so the texture's bytes are too.
"""


def _block(b):
    # _encode_dxt1_block, for the block's 16 pixels as 64 RGBA bytes (rows top to bottom as GX has them)
    unique, transparent = [], False
    for i in range(0, 64, 4):
        if b[i + 3] < 0x80:
            transparent = True
            continue
        c = ((b[i] >> 3) << 11) | ((b[i + 1] >> 2) << 5) | (b[i + 2] >> 3)
        if c not in unique:
            unique.append(c)
    if not unique:   # all transparent: null endpoints, every index 3
        return b'\0\0\0\0\xff\xff\xff\xff'
    best0 = best1 = unique[0]
    if len(unique) > 1:
        rgb = [(((c >> 11) & 0x1F) << 3, ((c >> 5) & 0x3F) << 2, (c & 0x1F) << 3) for c in unique]
        greatest = -1
        for c0, (r0, g0, b0) in zip(unique, rgb):
            for c1, (r1, g1, b1) in zip(unique, rgb):
                d = abs(r0 - r1) + abs(g0 - g1) + abs(b0 - b1)
                if d > greatest:
                    greatest, best0, best1 = d, c0, c1
    if transparent:
        hex1, hex2 = min(best0, best1), max(best0, best1)
    else:
        hex1, hex2 = max(best0, best1), min(best0, best1)
    p1 = (((hex1 >> 11) & 0x1F) << 3, ((hex1 >> 5) & 0x3F) << 2, (hex1 & 0x1F) << 3)
    p2 = (((hex2 >> 11) & 0x1F) << 3, ((hex2 >> 5) & 0x3F) << 2, (hex2 & 0x1F) << 3)
    if hex1 > hex2:
        palette = (p1, p2, ((2 * p1[0] + p2[0]) // 3, (2 * p1[1] + p2[1]) // 3, (2 * p1[2] + p2[2]) // 3),
                   ((2 * p2[0] + p1[0]) // 3, (2 * p2[1] + p1[1]) // 3, (2 * p2[2] + p1[2]) // 3))
    else:
        palette = (p1, p2, ((p1[0] + p2[0]) // 2, (p1[1] + p2[1]) // 2, (p1[2] + p2[2]) // 2), (0, 0, 0))
    bits = 0
    for i in range(0, 64, 4):
        bits <<= 2
        if b[i + 3] < 0x80:
            bits |= 3
            continue
        r, g, bl = b[i], b[i + 1], b[i + 2]
        best, least = 0, 1 << 30
        for j, (pr, pg, pb) in enumerate(palette):   # the first nearest (Manhattan on RGB)
            d = abs(r - pr) + abs(g - pg) + abs(bl - pb)
            if d < least:
                least, best = d, j
        bits |= best
    return bytes((hex1 >> 8, hex1 & 0xFF, hex2 >> 8, hex2 & 0xFF,
                  (bits >> 24) & 0xFF, (bits >> 16) & 0xFF, (bits >> 8) & 0xFF, bits & 0xFF))


def _pixels(pixels, width, height, x0, y0):
    # The block's pixels as _get_pixel reads them: the IR's rows are bottom to top, and outside the image is 0 0 0 0
    rows = []
    for y in range(y0, y0 + 4):
        fy = (height - 1) - y
        if 0 <= fy < height and 0 <= x0 and x0 + 4 <= width and (fy * width + x0 + 3) * 4 + 3 < len(pixels):
            off = (fy * width + x0) * 4
            rows.append(pixels[off:off + 16])
        else:
            row = bytearray(16)
            for k in range(4):
                x = x0 + k
                off = (fy * width + x) * 4
                if 0 <= x < width and 0 <= fy < height and off + 3 < len(pixels):
                    row[4 * k:4 * k + 4] = pixels[off:off + 4]
            rows.append(bytes(row))
    return b''.join(rows)


def encode_cmpr(pixels, width, height):
    """encode_cmpr: 8x8 macro-tiles of four 4x4 blocks, each block's 8 bytes."""
    pixels = bytes(pixels)
    done = {}
    out = []
    for by in range(0, height, 8):
        for bx in range(0, width, 8):
            for y, x in ((by, bx), (by, bx + 4), (by + 4, bx), (by + 4, bx + 4)):
                key = _pixels(pixels, width, height, x, y)
                block = done.get(key)
                if block is None:
                    block = done[key] = _block(key)
                out.append(block)
    return b''.join(out)


def shrink(px, w, h):
    """Half the size, each pixel the rounded mean of a 2x2 block's (convert.image_of's), by rows."""
    out = bytearray((w // 2) * (h // 2) * 4)
    row = (w // 2) * 4
    for y in range(h // 2):
        r0, r1 = px[(2 * y) * w * 4:(2 * y + 1) * w * 4], px[(2 * y + 1) * w * 4:(2 * y + 2) * w * 4]
        o = y * row
        for c in range(4):
            out[o + c:o + row:4] = bytes((a + b + p + q + 2) // 4 for a, b, p, q in
                                         zip(r0[c::8], r0[4 + c::8], r1[c::8], r1[4 + c::8]))
    return bytes(out)


def install(texture_encoder):
    """Put encode_cmpr in place of the add-on's when it hasn't numpy (with numpy, its own is faster)."""
    if getattr(texture_encoder, '_np', None) is not None:
        return
    texture_encoder.encode_cmpr = encode_cmpr
    for table in (getattr(texture_encoder, '_ENCODERS', None),):
        if table:
            for key, value in list(table.items()):
                if getattr(value, '__name__', '') == 'encode_cmpr':
                    table[key] = encode_cmpr
