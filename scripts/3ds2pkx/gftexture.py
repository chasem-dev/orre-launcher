"""PICA200 GFTexture (0x15041213) decoder and PNG encoder for Gen 7 3DS Pokémon textures & portraits."""
import struct
import zlib

# PICA200 8x8 Morton tile lookup table (tile pixel index -> (x, y) within 8x8 tile)
SWIZZLE_LUT = [
    0,  1,  8,  9,  2,  3, 10, 11,
   16, 17, 24, 25, 18, 19, 26, 27,
    4,  5, 12, 13,  6,  7, 14, 15,
   20, 21, 28, 29, 22, 23, 30, 31,
   32, 33, 40, 41, 34, 35, 42, 43,
   48, 49, 56, 57, 50, 51, 58, 59,
   36, 37, 44, 45, 38, 39, 46, 47,
   52, 53, 60, 61, 54, 55, 62, 63,
]

ETC1_LUT = (
    (2, 8, -2, -8),
    (5, 17, -5, -17),
    (9, 29, -9, -29),
    (13, 42, -13, -42),
    (18, 60, -18, -60),
    (24, 80, -24, -80),
    (33, 106, -33, -106),
    (47, 183, -47, -183),
)

# GFTexture format enum (at header offset 0x6C)
FMT_RGB565   = 0x02
FMT_RGB8     = 0x03
FMT_RGBA8    = 0x04
FMT_RGBA4    = 0x16
FMT_RGBA5551 = 0x17
FMT_LA8      = 0x23
FMT_HILO8    = 0x24
FMT_L8       = 0x25
FMT_A8       = 0x26
FMT_LA4      = 0x27
FMT_L4       = 0x28
FMT_A4       = 0x29
FMT_ETC1     = 0x2A
FMT_ETC1A4   = 0x2B


def _clamp(v):
    return 0 if v < 0 else 255 if v > 255 else v


def _decode_etc1_block(color_u64, alpha_u64, has_alpha):
    """Decode one 4x4 ETC1 (or ETC1A4) block -> list of 16 (r, g, b, a) in row-major order (y=0..3, x=0..3)."""
    diff = (color_u64 >> 33) & 1
    flip = (color_u64 >> 32) & 1
    if diff:
        r1 = (color_u64 >> 59) & 0x1F
        g1 = (color_u64 >> 51) & 0x1F
        b1 = (color_u64 >> 43) & 0x1F
        dr = (color_u64 >> 56) & 0x7
        dg = (color_u64 >> 48) & 0x7
        db = (color_u64 >> 40) & 0x7
        if dr >= 4: dr -= 8
        if dg >= 4: dg -= 8
        if db >= 4: db -= 8
        r2, g2, b2 = (r1 + dr) & 0x1F, (g1 + dg) & 0x1F, (b1 + db) & 0x1F
        c1 = ((r1 << 3) | (r1 >> 2), (g1 << 3) | (g1 >> 2), (b1 << 3) | (b1 >> 2))
        c2 = ((r2 << 3) | (r2 >> 2), (g2 << 3) | (g2 >> 2), (b2 << 3) | (b2 >> 2))
    else:
        r1, r2 = (color_u64 >> 60) & 0xF, (color_u64 >> 56) & 0xF
        g1, g2 = (color_u64 >> 52) & 0xF, (color_u64 >> 48) & 0xF
        b1, b2 = (color_u64 >> 44) & 0xF, (color_u64 >> 40) & 0xF
        c1 = ((r1 << 4) | r1, (g1 << 4) | g1, (b1 << 4) | b1)
        c2 = ((r2 << 4) | r2, (g2 << 4) | g2, (b2 << 4) | b2)
    t1 = ETC1_LUT[(color_u64 >> 37) & 0x7]
    t2 = ETC1_LUT[(color_u64 >> 34) & 0x7]
    out = [None] * 16
    for x in range(4):
        for y in range(4):
            bit = x * 4 + y
            idx = (((color_u64 >> (bit + 16)) & 1) << 1) | ((color_u64 >> bit) & 1)
            second = (y >= 2) if flip else (x >= 2)
            base = c2 if second else c1
            mod = (t2 if second else t1)[idx]
            a = 255
            if has_alpha:
                nib = (alpha_u64 >> (bit * 4)) & 0xF
                a = (nib << 4) | nib
            out[y * 4 + x] = (_clamp(base[0] + mod), _clamp(base[1] + mod), _clamp(base[2] + mod), a)
    return out


def decode_pica_texture(raw, width, height, fmt):
    """Decode PICA200 Morton-tiled texture to RGBA bytes (rows TOP to BOTTOM)."""
    out = bytearray(width * height * 4)
    if fmt in (FMT_ETC1, FMT_ETC1A4):
        has_alpha = (fmt == FMT_ETC1A4)
        stride_blk = 16 if has_alpha else 8
        off = 0
        for ty in range(0, height, 8):
            for tx in range(0, width, 8):
                for sy in (0, 4):
                    for sx in (0, 4):
                        if off + stride_blk > len(raw):
                            break
                        if has_alpha:
                            alpha_u64, color_u64 = struct.unpack_from('<QQ', raw, off)
                        else:
                            alpha_u64, color_u64 = 0, struct.unpack_from('<Q', raw, off)[0]
                        off += stride_blk
                        blk = _decode_etc1_block(color_u64, alpha_u64, has_alpha)
                        for py in range(4):
                            y = ty + sy + py
                            if y >= height:
                                continue
                            row_o = (y * width + tx + sx) * 4
                            for px in range(4):
                                if tx + sx + px < width:
                                    r, g, b, a = blk[py * 4 + px]
                                    o = row_o + px * 4
                                    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a
        return bytes(out)

    # Non-ETC1 8x8 Morton-tiled formats
    off = 0
    for ty in range(0, height, 8):
        for tx in range(0, width, 8):
            for k in range(64):
                sw = SWIZZLE_LUT[k]
                x = tx + (sw & 7)
                y = ty + (sw >> 3)
                inside = (x < width and y < height)
                o = (y * width + x) * 4 if inside else -1

                if fmt == FMT_RGBA8:
                    if off + 4 > len(raw): break
                    a, b, g, r = raw[off], raw[off + 1], raw[off + 2], raw[off + 3]
                    off += 4
                elif fmt == FMT_RGB8:
                    if off + 3 > len(raw): break
                    b, g, r, a = raw[off], raw[off + 1], raw[off + 2], 255
                    off += 3
                elif fmt == FMT_RGBA5551:
                    if off + 2 > len(raw): break
                    v = raw[off] | (raw[off + 1] << 8)
                    off += 2
                    r = ((v >> 11) & 0x1F) * 255 // 31
                    g = ((v >> 6) & 0x1F) * 255 // 31
                    b = ((v >> 1) & 0x1F) * 255 // 31
                    a = 255 if (v & 1) else 0
                elif fmt == FMT_RGB565:
                    if off + 2 > len(raw): break
                    v = raw[off] | (raw[off + 1] << 8)
                    off += 2
                    r = ((v >> 11) & 0x1F) * 255 // 31
                    g = ((v >> 5) & 0x3F) * 255 // 63
                    b = (v & 0x1F) * 255 // 31
                    a = 255
                elif fmt == FMT_RGBA4:
                    if off + 2 > len(raw): break
                    v = raw[off] | (raw[off + 1] << 8)
                    off += 2
                    a = (v & 0xF) * 17
                    b = ((v >> 4) & 0xF) * 17
                    g = ((v >> 8) & 0xF) * 17
                    r = ((v >> 12) & 0xF) * 17
                elif fmt == FMT_LA8:
                    if off + 2 > len(raw): break
                    a, l = raw[off], raw[off + 1]
                    off += 2
                    r = g = b = l
                elif fmt == FMT_HILO8:
                    if off + 2 > len(raw): break
                    r, g, b, a = raw[off + 1], raw[off], 255, 255
                    off += 2
                elif fmt == FMT_L8:
                    if off + 1 > len(raw): break
                    r = g = b = raw[off]
                    a = 255
                    off += 1
                elif fmt == FMT_A8:
                    if off + 1 > len(raw): break
                    r = g = b = 255
                    a = raw[off]
                    off += 1
                elif fmt == FMT_LA4:
                    if off + 1 > len(raw): break
                    v = raw[off]
                    off += 1
                    a = (v & 0xF) * 17
                    r = g = b = (v >> 4) * 17
                elif fmt in (FMT_L4, FMT_A4):
                    byte_idx = off >> 1
                    if byte_idx >= len(raw): break
                    nib = (raw[byte_idx] >> 4) if (off & 1) else (raw[byte_idx] & 0xF)
                    off += 1
                    val = nib * 17
                    if fmt == FMT_L4:
                        r = g = b = val; a = 255
                    else:
                        r = g = b = 255; a = val
                else:
                    raise ValueError('Unsupported PICA200 GFTexture format 0x%x' % fmt)

                if inside:
                    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a
    return bytes(out)


def read_gftexture(data):
    """Parse a GFTexture (0x15041213) chunk -> dict(name, width, height, format, rgba_top_down, rgba_bottom_up)."""
    if len(data) < 0x80 or struct.unpack_from('<I', data, 0)[0] != 0x15041213:
        return None
    data_len = struct.unpack_from('<I', data, 0x18)[0]
    name = data[0x28:0x68].split(b'\x00', 1)[0].decode('ascii', errors='replace')
    width, height, fmt, mips = struct.unpack_from('<HHHH', data, 0x68)
    raw = data[0x80:0x80 + data_len]
    top_down = decode_pica_texture(raw, width, height, fmt)
    # PICA200 textures are natively bottom-up (V=0 at bottom in OpenGL/PICA, matching GameCube IR!).
    #Wait: decode_pica_texture places tile (ty=0) at y=0, which in PICA200 IS the top row of the image on screen
    # for 2D sprites (pokepic), OR bottom-up for 3D UV V=0 at bottom.
    # Let's expose both top_down (y=0 is tile 0) and flipped (bottom-up rows reversed) cleanly.
    stride = width * 4
    flipped = b''.join(top_down[y * stride:(y + 1) * stride] for y in range(height - 1, -1, -1))
    return {
        'name': name,
        'width': width,
        'height': height,
        'format': fmt,
        'mips': mips,
        'rgba': top_down,
        'rgba_flipped': flipped,
    }


def encode_png(width, height, rgba_top_down):
    """Encode top-down RGBA bytes to a PNG."""
    def chunk(kind, body):
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xFFFFFFFF)
    stride = width * 4
    rows = b''.join(b'\x00' + rgba_top_down[y * stride:(y + 1) * stride] for y in range(height))
    return (b'\x89PNG\r\n\x1a\n' +
            chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(rows, 6)) +
            chunk(b'IEND', b''))


def crop_rgba(rgba, w, h, x0, y0, cw, ch):
    """Crop a sub-rectangle from top-down RGBA bytes (clamping/transparent outside bounds)."""
    out = bytearray(cw * ch * 4)
    for y in range(ch):
        sy = y0 + y
        if 0 <= sy < h:
            sx0 = max(0, x0)
            sx1 = min(w, x0 + cw)
            if sx1 > sx0:
                dx = sx0 - x0
                src_o = (sy * w + sx0) * 4
                dst_o = (y * cw + dx) * 4
                out[dst_o:dst_o + (sx1 - sx0) * 4] = rgba[src_o:src_o + (sx1 - sx0) * 4]
    return bytes(out)


def make_face_png(rgba, w, h):
    """Frame a 128x128 pokepic portrait neatly into a square face crop focused on the upper/center body."""
    # Find non-transparent bounding box
    min_x, min_y, max_x, max_y = w, h, -1, -1
    for y in range(h):
        row_o = y * w * 4
        for x in range(w):
            if rgba[row_o + x * 4 + 3] > 24:
                if x < min_x: min_x = x
                if x > max_x: max_x = x
                if y < min_y: min_y = y
                if y > max_y: max_y = y
    if max_x < min_x:
        return encode_png(w, h, rgba)
    bw, bh = max_x - min_x + 1, max_y - min_y + 1
    # Square crop covering ~78% of max dimension centered horizontally, biased slightly upward toward the head
    side = max(32, min(w, h, int(max(bw, bh) * 0.85) + 4))
    cx = (min_x + max_x) // 2
    cy = min_y + int(bh * 0.42)
    x0 = max(0, min(w - side, cx - side // 2))
    y0 = max(0, min(h - side, cy - side // 2))
    cropped = crop_rgba(rgba, w, h, x0, y0, side, side)
    return encode_png(side, side, cropped)
