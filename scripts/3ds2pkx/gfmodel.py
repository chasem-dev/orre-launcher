"""Game Freak 3DS GFModel (0x15122117) parser: skeleton, materials, and PICA200 meshes."""
import struct

# PICA200 registers used in GFMesh & GFMaterial command buffers
PICA_GPUREG_FACECULLING_CONFIG = 0x0040
PICA_GPUREG_COLOR_OPERATION    = 0x0100
PICA_GPUREG_BLEND_FUNC         = 0x0101
PICA_GPUREG_FRAGOP_ALPHA_TEST  = 0x0104
PICA_GPUREG_ATTRIBBUFFERS_FORMAT_LOW  = 0x0201
PICA_GPUREG_ATTRIBBUFFERS_FORMAT_HIGH = 0x0202
PICA_GPUREG_ATTRIBBUFFER0_CONFIG1     = 0x0204
PICA_GPUREG_ATTRIBBUFFER0_CONFIG2     = 0x0205
PICA_GPUREG_INDEXBUFFER_CONFIG        = 0x0227
PICA_GPUREG_NUMVERTICES               = 0x0228
PICA_GPUREG_FIXEDATTRIB_INDEX         = 0x0232
PICA_GPUREG_FIXEDATTRIB_DATA0         = 0x0233
PICA_GPUREG_FIXEDATTRIB_DATA1         = 0x0234
PICA_GPUREG_FIXEDATTRIB_DATA2         = 0x0235
PICA_GPUREG_PRIMITIVE_CONFIG          = 0x025E
PICA_GPUREG_VSH_ATTR_PERM_LOW         = 0x02BB
PICA_GPUREG_VSH_ATTR_PERM_HIGH        = 0x02BC

# PICA200 vertex attribute types & byte sizes
ATTR_SBYTE  = 0
ATTR_UBYTE  = 1
ATTR_SHORT  = 2
ATTR_FLOAT  = 3
ATTR_SIZES  = (1, 1, 2, 4)
ATTR_FMTS   = ('b', 'B', 'h', 'f')

# GFModel semantic attribute indices (standard SPICA PICA attribute mapping)
ATTR_POSITION   = 0
ATTR_NORMAL     = 1
ATTR_TANGENT    = 2
ATTR_COLOR      = 3
ATTR_TEXCOORD0  = 4
ATTR_TEXCOORD1  = 5
ATTR_TEXCOORD2  = 6
ATTR_BONE_INDEX = 7
ATTR_BONE_WEIGHT = 8

# PICA200 primitive modes
PRIM_TRIANGLES      = 0
PRIM_TRIANGLE_STRIP = 1
PRIM_TRIANGLE_FAN   = 2


def _read_len_str(data, pos):
    n = data[pos]
    return data[pos + 1:pos + 1 + n].decode('ascii', errors='replace'), pos + 1 + n


def _read_hash_name(data, pos):
    h = struct.unpack_from('<I', data, pos)[0]
    s, pos = _read_len_str(data, pos + 4)
    return h, s, pos


def _read_pica_commands(data, start, word_count):
    """Yield (reg_id, value) pairs from a PICA200 command buffer."""
    cmds = struct.unpack_from('<%dI' % word_count, data, start)
    i = 0
    n = len(cmds)
    while i + 1 < n:
        param = cmds[i]
        hdr = cmds[i + 1]
        reg = hdr & 0xFFFF
        mask = (hdr >> 16) & 0xF
        extra = (hdr >> 20) & 0x7FF
        consec = (hdr >> 31) & 1
        i += 2
        yield reg, param, mask
        for k in range(extra):
            if i >= n:
                break
            val = cmds[i]
            i += 1
            yield (reg + k + 1 if consec else reg), val, mask
        if extra & 1:
            i += 1  # align back to 8-byte command boundary


def _unpack_float24(u24):
    """Decode PICA200 24-bit float (1 sign, 7 exp bias 63, 16 mantissa)."""
    sign = -1.0 if (u24 & 0x800000) else 1.0
    exp = (u24 >> 16) & 0x7F
    mant = u24 & 0xFFFF
    if exp == 0:
        return 0.0
    return sign * (1.0 + mant / 65536.0) * (2.0 ** (exp - 63))


def _unpack_fixed_vec4(w0, w1, w2):
    """Decode PICA200 3-word packed 4x float24 fixed vertex attribute (DATA0=W..Z, DATA1=Z..Y, DATA2=Y..X)."""
    w = _unpack_float24((w0 >> 8) & 0xFFFFFF)
    z = _unpack_float24(((w0 & 0xFF) << 16) | ((w1 >> 16) & 0xFFFF))
    y = _unpack_float24(((w1 & 0xFFFF) << 8) | ((w2 >> 24) & 0xFF))
    x = _unpack_float24(w2 & 0xFFFFFF)
    return (x, y, z, w)


def _parse_material(data, start, length):
    pos = start + 16  # skip GFSection header
    end = pos + length
    _, mat_name, pos = _read_hash_name(data, pos)
    _, shader_name, pos = _read_hash_name(data, pos)
    _, vsh_name, pos = _read_hash_name(data, pos)
    _, fsh_name, pos = _read_hash_name(data, pos)

    # LUT hashes (3 x u32) + u32 pad
    pos += 16
    # bump_texture (s8), constant_assignments (6 x u8), pad (u8)
    pos += 8
    # 10 RGBA8 colors: ambient, diffuse, specular0, specular1, emission, const0..const5 (actually 4+6=10? Wait: check!)
    # Let's read exact SPICA GFMaterial layout:
    # Emission(4), Ambient(4), Diffuse(4), Specular0(4), Specular1(4), Const0..5(24) = 11 * 4 = 44 bytes!
    # Let's verify: earlier @p=0x2758 to tex_unit_count @0x2800 was 0xA8 = 168 bytes!
    # 16 (luts+pad) + 8 (bump+const+pad) + 44 (11 colors) + 40 (edge/rim/phong/etc: 10*4) + 12 (bake? no wait: 16+8+44+...=168 -> 168 - 24 = 144 bytes!)
    # Wait: let's read colors at pos (44 bytes), then scan cleanly or use exact SPICA offsets!
    emission  = tuple(b / 255.0 for b in data[pos:pos + 4]); pos += 4
    ambient   = tuple(b / 255.0 for b in data[pos:pos + 4]); pos += 4
    diffuse   = tuple(b / 255.0 for b in data[pos:pos + 4]); pos += 4
    specular0 = tuple(b / 255.0 for b in data[pos:pos + 4]); pos += 4
    specular1 = tuple(b / 255.0 for b in data[pos:pos + 4]); pos += 4
    # Constant0..5 (6 x 4 = 24 bytes)
    pos += 24
    # EdgeType(4), IDEdgeEnable(4), EdgeID(4), ProjectionType(4), RimPower(4), RimScale(4),
    # PhongPower(4), PhongScale(4), IDEdgeOffsetEnable(4), EdgeMapAlphaMask(4),
    # BakeTex0..2(12), VertexShaderType(4), ShaderParam0..3(16) -> 10*4 + 12 + 4 + 16 = 72 bytes?
    # Check: 16 + 8 + 44 + 72 = 140... wait earlier 0x2800 - 0x2758 = 168 bytes! Difference = 28 bytes!
    # Wait: 44 + 72 = 116; 168 - 24 - 116 = 28 bytes (7 u32s: e.g. 4B pad + 24B?).
    # Instead of guessing a single version's padding, let's check directly: right before tex_unit_count (0..3),
    # let's verify at pos + 72..pos + 120 where unit_count (0..3) sits!
    # Actually: in SPICA GFMaterial.cs:
    #   LUTHashes[3] (12) + 4 = 16
    #   BumpTex(1) + ConstAssign[6](6) + 1 = 8 -> +24
    #   Colors: Emission, Ambient, Diffuse, Specular0, Specular1, Constant0..5 (11 * 4 = 44) -> +68
    #   EdgeType(4), IDEdgeEnable(4), EdgeID(4), ProjectionType(4), RimPower(4), RimScale(4),
    #   PhongPower(4), PhongScale(4), IDEdgeOffsetEnable(4), EdgeMapAlphaMask(4),
    #   BakeTex0(4), BakeTex1(4), BakeTex2(4), VertexShaderType(4), ShaderParams[4](16) = 72 -> +140
    #   WAIT: why was 0x2800 at +168 (+0xA8)? Let's check 0x2758 + 140 = 0x27E4!
    #   At 0x2758 + 140 = 0x27E4, let's look back at the hex dump we printed:
    #   0x2758..0x27D8 was 128 bytes:
    #   at +0x70 (0x27C8): 01 00 00 00 ff ff ff ff 02 00 00 00 00..00 (16B) -> 0x27E8..0x2800!
    #   There are 28 bytes of padding / UnitsCount is at +0xA8 (168) from end of fsh_name!
    # Let's check if UnitsCount is ALWAYS at p_after_names + 0xA8 (168) — wait, let's verify across models,
    # AND locate it robustly!
    p_after = start + 16
    _, _, p_after = _read_hash_name(data, p_after)
    _, _, p_after = _read_hash_name(data, p_after)
    _, _, p_after = _read_hash_name(data, p_after)
    _, _, p_after = _read_hash_name(data, p_after)
    # SPICA exact layout after 4 names:
    # 12 (3 lut hashes) + 4 (pad) + 8 (bump + 6 const + pad) + 44 (11 colors) + 4*25 (100 bytes!) = 168 bytes!
    # (SPICA: EdgeType, IDEdgeEnable, EdgeID, ProjType, RimPow, RimScale, PhongPow, PhongScale,
    #  IDEdgeOffsetEnable, EdgeMapAlphaMask, BakeTex[3], VertexShaderType, ShaderParam[4], then 7 more u32s = 28B!)
    pos = p_after + 168
    unit_cnt = struct.unpack_from('<I', data, pos)[0]
    pos += 4
    if unit_cnt > 4:
        # Fallback: scan for valid unit_cnt (0..3) followed by hash + plausible ascii len + ".tga"
        unit_cnt = 0
        for probe in range(p_after + 120, min(end - 16, p_after + 220), 4):
            c = struct.unpack_from('<I', data, probe)[0]
            if 1 <= c <= 3 and probe + 10 < end:
                nlen = data[probe + 8]
                if 4 <= nlen <= 64 and data[probe + 9:probe + 9 + nlen].endswith(b'.tga'):
                    unit_cnt = c
                    pos = probe + 4
                    break

    tex_coords = []
    for _ in range(unit_cnt):
        _, tname, pos = _read_hash_name(data, pos)
        unit_idx = data[pos]
        mapping_type = data[pos + 1]
        scale_u, scale_v, rot, trans_u, trans_v = struct.unpack_from('<5f', data, pos + 2)
        wrap_u, wrap_v, mag_f, min_f, _min_lod = struct.unpack_from('<5I', data, pos + 22)
        pos += 42
        tex_coords.append({
            'name': tname,
            'unit': unit_idx,
            'mapping': mapping_type,
            'scale': (scale_u, scale_v),
            'rotation': rot,
            'translation': (trans_u, trans_v),
            'wrap_u': wrap_u,
            'wrap_v': wrap_v,
        })

    # Align to 16 bytes for PICA commands header!
    pos = (pos + 15) & ~15
    cull_mode = 2  # back-face culling default
    alpha_test = False
    blend_enabled = False
    render_priority = 0
    render_layer = 0
    if pos + 16 <= end:
        cmd_len, render_priority, _unk, render_layer = struct.unpack_from('<4I', data, pos)
        pos += 16
        if cmd_len > 0 and pos + cmd_len <= end:
            for reg, val, _mask in _read_pica_commands(data, pos, cmd_len // 4):
                if reg == PICA_GPUREG_FACECULLING_CONFIG:
                    cull_mode = val & 3  # 0=never, 1=front, 2=back
                elif reg == PICA_GPUREG_FRAGOP_ALPHA_TEST:
                    alpha_test = bool(val & 1)
                elif reg == PICA_GPUREG_COLOR_OPERATION:
                    blend_enabled = bool((val >> 8) & 1)

    return {
        'name': mat_name,
        'shader': shader_name,
        'vsh': vsh_name,
        'fsh': fsh_name,
        'emission': emission,
        'ambient': ambient,
        'diffuse': diffuse,
        'specular0': specular0,
        'tex_coords': tex_coords,
        'cull_mode': cull_mode,
        'alpha_test': alpha_test,
        'blend_enabled': blend_enabled,
        'render_layer': render_layer,
        'render_priority': render_priority,
    }


def _parse_mesh(data, start, length):
    pos = start + 16  # skip GFSection header
    _hash = struct.unpack_from('<I', data, pos)[0]
    mesh_name = data[pos + 4:pos + 68].split(b'\x00', 1)[0].decode('ascii', errors='replace')
    # +0x44 pad(4), +0x48 bbox_min(16), +0x58 bbox_max(16)
    submesh_cnt, bone_idx_per_vtx = struct.unpack_from('<II', data, pos + 0x68)
    # +0x70: 16 bytes of 0xFF padding -> cmd descriptors start at pos + 0x80
    cmd_desc_pos = pos + 0x80

    # Command lists are interleaved: [16-byte header (cmd_len, cmd_idx, cmd_cnt, pad) + cmd_len bytes] x total_descs
    first_len, first_idx, total_descs, _ = struct.unpack_from('<4I', data, cmd_desc_pos)
    cmd_buffers = []
    cur = cmd_desc_pos
    for _ in range(total_descs):
        clen, cidx, ccnt, _ = struct.unpack_from('<4I', data, cur)
        cur += 16
        cmd_buffers.append((cur, clen))
        cur += clen

    # After all command buffers come `submesh_cnt` submesh headers!
    sub_hdr_pos = cur
    submeshes = []
    for si in range(submesh_cnt):
        _shash = struct.unpack_from('<I', data, sub_hdr_pos)[0]
        slen = struct.unpack_from('<I', data, sub_hdr_pos + 4)[0]
        sname = data[sub_hdr_pos + 8:sub_hdr_pos + 8 + slen].split(b'\x00', 1)[0].decode('ascii', errors='replace').strip()
        p = sub_hdr_pos + 8 + slen
        node_cnt = data[p]
        node_list = list(data[p + 1:p + 1 + 31])[:node_cnt]
        p += 32
        vtx_cnt, idx_cnt, vtx_len, idx_len = struct.unpack_from('<4I', data, p)
        sub_hdr_pos = p + 16
        submeshes.append({
            'name': sname,
            'node_list': node_list,
            'vtx_cnt': vtx_cnt,
            'idx_cnt': idx_cnt,
            'vtx_len': vtx_len,
            'idx_len': idx_len,
        })

    # Data buffers follow immediately after all submesh headers!
    data_pos = sub_hdr_pos
    out_submeshes = []
    for si, sm in enumerate(submeshes):
        # Parse enable command buffer (descs index si*3) and index command buffer (si*3 + 2)
        en_off, en_len = cmd_buffers[si * 3]
        ix_off, ix_len = cmd_buffers[si * 3 + 2]

        fmt_lo = 0
        fmt_hi = 0
        cfg1 = 0
        cfg2 = 0
        perm_lo = 0x76543210
        perm_hi = 0x0000BA98
        fixed_idx = -1
        fixed_words = []
        fixed_attrs_raw = {}

        for reg, val, _mask in _read_pica_commands(data, en_off, en_len // 4):
            if reg == PICA_GPUREG_ATTRIBBUFFERS_FORMAT_LOW:
                fmt_lo = val
            elif reg == PICA_GPUREG_ATTRIBBUFFERS_FORMAT_HIGH:
                fmt_hi = val
            elif reg == PICA_GPUREG_ATTRIBBUFFER0_CONFIG1:
                cfg1 = val
            elif reg == PICA_GPUREG_ATTRIBBUFFER0_CONFIG2:
                cfg2 = val
            elif reg == PICA_GPUREG_VSH_ATTR_PERM_LOW:
                perm_lo = val
            elif reg == PICA_GPUREG_VSH_ATTR_PERM_HIGH:
                perm_hi = val
            elif reg == PICA_GPUREG_FIXEDATTRIB_INDEX:
                fixed_idx = val
                fixed_words = []
            elif reg in (PICA_GPUREG_FIXEDATTRIB_DATA0, PICA_GPUREG_FIXEDATTRIB_DATA1, PICA_GPUREG_FIXEDATTRIB_DATA2):
                fixed_words.append(val)
                if len(fixed_words) == 3:
                    fixed_attrs_raw[fixed_idx] = _unpack_fixed_vec4(fixed_words[0], fixed_words[1], fixed_words[2])
                    fixed_words = []

        perm_all = perm_lo | (perm_hi << 32)
        # Map fixed attribute slot indices through VSH attribute permutation -> semantic IDs
        fixed_attrs = {}
        for slot_i, fval in fixed_attrs_raw.items():
            sem_id = (perm_all >> (slot_i * 4)) & 0xF
            fixed_attrs[sem_id] = fval

        idx_cfg = 0
        num_verts = sm['idx_cnt']
        prim_mode = PRIM_TRIANGLES
        for reg, val, _mask in _read_pica_commands(data, ix_off, ix_len // 4):
            if reg == PICA_GPUREG_INDEXBUFFER_CONFIG:
                idx_cfg = val
            elif reg == PICA_GPUREG_NUMVERTICES:
                num_verts = val
            elif reg == PICA_GPUREG_PRIMITIVE_CONFIG:
                prim_mode = (val >> 8) & 3

        # Decode buffer attribute list from (fmt_lo, fmt_hi, cfg1, cfg2) mapped via VSH permutation
        vtx_stride = (cfg2 >> 16) & 0xFF
        attr_cnt = (cfg2 >> 28) & 0xF
        fmt_all = fmt_lo | (fmt_hi << 32)
        cfg_all = cfg1 | ((cfg2 & 0xFFFF) << 32)

        attrs = []  # (semantic_id, elem_type, elem_count, byte_offset)
        cur_off = 0
        for a_i in range(attr_cnt):
            slot_id = (cfg_all >> (a_i * 4)) & 0xF
            if slot_id >= 12:
                # padding: (slot_id - 11) * 4 bytes
                cur_off += (slot_id - 11) * 4
                continue
            afmt = (fmt_all >> (slot_id * 4)) & 0xF
            etype = afmt & 3
            ecount = (afmt >> 2) + 1
            sem_id = (perm_all >> (slot_id * 4)) & 0xF
            attrs.append((sem_id, etype, ecount, cur_off))
            cur_off += ATTR_SIZES[etype] * ecount

        vtx_bytes = data[data_pos:data_pos + sm['vtx_len']]
        data_pos += sm['vtx_len']
        idx_bytes = data[data_pos:data_pos + sm['idx_len']]
        data_pos += sm['idx_len']

        # Decode vertices
        vtx_cnt = sm['vtx_cnt']
        positions = []
        normals = []
        uv0 = []
        uv1 = []
        uv2 = []
        colors = []
        bone_indices = []
        bone_weights = []

        # Default fixed attributes (e.g. constant weight = 1.0 or bone_index = 0 or color = white)
        def get_fixed(aid, default):
            return fixed_attrs.get(aid, default)

        # Precompute struct formats for speed
        attr_unpackers = []
        for attr_id, etype, ecount, aoff in attrs:
            ufmt = '<%d%s' % (ecount, ATTR_FMTS[etype])
            # Scale factor for non-float attributes (SPICA GFMesh scales)
            scale = 1.0
            if etype != ATTR_FLOAT:
                if attr_id == ATTR_COLOR:
                    scale = 1.0 / 255.0
                elif attr_id == ATTR_BONE_WEIGHT:
                    scale = 1.0 / (255.0 if etype == ATTR_UBYTE else 127.0 if etype == ATTR_SBYTE else 32767.0)
                elif attr_id == ATTR_NORMAL or attr_id == ATTR_TANGENT:
                    scale = 1.0 / (127.0 if etype == ATTR_SBYTE else 32767.0 if etype == ATTR_SHORT else 255.0)
                elif attr_id in (ATTR_TEXCOORD0, ATTR_TEXCOORD1, ATTR_TEXCOORD2):
                    scale = 1.0 / (128.0 if etype == ATTR_SBYTE else 255.0 if etype == ATTR_UBYTE else 32768.0)
                elif attr_id == ATTR_POSITION:
                    scale = 1.0  # positions in GFMesh are float or unscaled short/byte? Usually float
            attr_unpackers.append((attr_id, struct.Struct(ufmt), aoff, scale, etype))

        has_attr = {a[0] for a in attrs}
        fixed_bidx = get_fixed(ATTR_BONE_INDEX, None)
        fixed_bwgt = get_fixed(ATTR_BONE_WEIGHT, None)
        fixed_uv0 = get_fixed(ATTR_TEXCOORD0, (0.0, 0.0, 0.0, 0.0))
        fixed_nrm = get_fixed(ATTR_NORMAL, (0.0, 1.0, 0.0, 0.0))

        for vi in range(vtx_cnt):
            base_o = vi * vtx_stride
            pos_v = (0.0, 0.0, 0.0)
            nrm_v = fixed_nrm[:3]
            t0_v = fixed_uv0[:2]
            t1_v = (0.0, 0.0)
            t2_v = (0.0, 0.0)
            col_v = (1.0, 1.0, 1.0, 1.0)
            bidx_v = tuple(int(round(x)) for x in fixed_bidx[:4]) if fixed_bidx else None
            bwgt_v = fixed_bwgt[:4] if fixed_bwgt else None

            for attr_id, st, aoff, scale, etype in attr_unpackers:
                vals = st.unpack_from(vtx_bytes, base_o + aoff)
                if attr_id == ATTR_POSITION:
                    pos_v = (vals[0] * scale, vals[1] * scale, vals[2] * scale) if len(vals) >= 3 else (0.0, 0.0, 0.0)
                elif attr_id == ATTR_NORMAL:
                    nrm_v = (vals[0] * scale, vals[1] * scale, vals[2] * scale) if len(vals) >= 3 else (0.0, 1.0, 0.0)
                elif attr_id == ATTR_TEXCOORD0:
                    t0_v = (vals[0] * scale, vals[1] * scale) if len(vals) >= 2 else (0.0, 0.0)
                elif attr_id == ATTR_TEXCOORD1:
                    t1_v = (vals[0] * scale, vals[1] * scale) if len(vals) >= 2 else (0.0, 0.0)
                elif attr_id == ATTR_TEXCOORD2:
                    t2_v = (vals[0] * scale, vals[1] * scale) if len(vals) >= 2 else (0.0, 0.0)
                elif attr_id == ATTR_COLOR:
                    if len(vals) == 4:
                        col_v = (vals[0] * scale, vals[1] * scale, vals[2] * scale, vals[3] * scale)
                    elif len(vals) == 3:
                        col_v = (vals[0] * scale, vals[1] * scale, vals[2] * scale, 1.0)
                elif attr_id == ATTR_BONE_INDEX:
                    bidx_v = tuple(int(x) for x in vals)
                elif attr_id == ATTR_BONE_WEIGHT:
                    bwgt_v = tuple(x * scale for x in vals)

            positions.append(pos_v)
            normals.append(nrm_v)
            uv0.append(t0_v)
            if ATTR_TEXCOORD1 in has_attr:
                uv1.append(t1_v)
            if ATTR_TEXCOORD2 in has_attr:
                uv2.append(t2_v)
            if ATTR_COLOR in has_attr:
                colors.append(col_v)

            # Resolve per-vertex bone weights through submesh node_list
            nlist = sm['node_list']
            if bidx_v is not None:
                if bwgt_v is None:
                    # Single rigid bone per vertex (fixed weight 1.0)
                    bwgt_v = (1.0,) + (0.0,) * (len(bidx_v) - 1)
                pairs = []
                for bi, bw in zip(bidx_v, bwgt_v):
                    if bw > 0.0 and bi >= 0:
                        real_b = nlist[bi] if (nlist and 0 <= bi < len(nlist)) else bi
                        pairs.append((real_b, float(bw)))
                if not pairs and nlist:
                    fb = bidx_v[0] if (0 <= bidx_v[0] < len(nlist)) else 0
                    pairs = [(nlist[fb], 1.0)]
                bone_indices.append(pairs)
            elif nlist:
                bone_indices.append([(nlist[0], 1.0)])
            else:
                bone_indices.append([])

        # Decode index buffer
        is_u16 = bool(idx_cfg >> 31)
        if is_u16:
            count = min(num_verts, len(idx_bytes) // 2)
            raw_indices = struct.unpack_from('<%dH' % count, idx_bytes, 0)
        else:
            count = min(num_verts, len(idx_bytes))
            raw_indices = list(idx_bytes[:count])

        # Convert primitives to triangle index triples
        tris = []
        if prim_mode == PRIM_TRIANGLES:
            for k in range(0, len(raw_indices) - 2, 3):
                a, b, c = raw_indices[k], raw_indices[k + 1], raw_indices[k + 2]
                if a != b and b != c and a != c and a < vtx_cnt and b < vtx_cnt and c < vtx_cnt:
                    tris.append((a, b, c))
        elif prim_mode == PRIM_TRIANGLE_STRIP:
            for k in range(len(raw_indices) - 2):
                a, b, c = (raw_indices[k], raw_indices[k + 1], raw_indices[k + 2]) if (k % 2 == 0) else (raw_indices[k + 1], raw_indices[k], raw_indices[k + 2])
                if a != b and b != c and a != c and a < vtx_cnt and b < vtx_cnt and c < vtx_cnt:
                    tris.append((a, b, c))
        elif prim_mode == PRIM_TRIANGLE_FAN:
            for k in range(1, len(raw_indices) - 1):
                a, b, c = raw_indices[0], raw_indices[k], raw_indices[k + 1]
                if a != b and b != c and a != c and a < vtx_cnt and b < vtx_cnt and c < vtx_cnt:
                    tris.append((a, b, c))

        out_submeshes.append({
            'name': sm['name'],  # matches material name!
            'node_list': sm['node_list'],
            'positions': positions,
            'normals': normals,
            'uv0': uv0,
            'uv1': uv1,
            'uv2': uv2,
            'colors': colors,
            'weights': bone_indices,
            'triangles': tris,
            'has_color': ATTR_COLOR in has_attr,
        })

    return {
        'name': mesh_name,
        'bone_idx_per_vtx': bone_idx_per_vtx,
        'submeshes': out_submeshes,
    }


def read_gfmodel(data):
    """Parse a complete GFModel (0x15122117) binary into skeleton, materials, and meshes."""
    if len(data) < 0x20 or struct.unpack_from('<I', data, 0)[0] != 0x15122117:
        raise ValueError('Not a GFModel (bad magic)')

    pos = 0x10
    skeleton = []
    materials = []
    meshes = []
    bbox = ((0.0, 0.0, 0.0), (0.0, 0.0, 0.0))

    while pos + 16 <= len(data):
        tag = data[pos:pos + 8].split(b'\x00', 1)[0].decode('ascii', errors='replace')
        slen = struct.unpack_from('<I', data, pos + 8)[0]
        if not tag and slen == 0:
            break
        if tag == 'gfmodel':
            p = pos + 16
            # Skip 4 string tables: shaders, textures, materials, meshes
            for _ in range(4):
                cnt = struct.unpack_from('<I', data, p)[0]
                p += 4 + cnt * 68
            # Bounding box (2 x vec4 = 32B) + transform matrix (16f = 64B)
            bmin = struct.unpack_from('<3f', data, p)
            bmax = struct.unpack_from('<3f', data, p + 16)
            bbox = (bmin, bmax)
            p += 32 + 64
            # Empty data length + empty data offset -> skip (empty_len + 0x20? Check exact header: u32 empty_len, u32 empty_off, pad)
            empty_len = struct.unpack_from('<I', data, p)[0]
            p += 0x10 + empty_len
            # Align / skip to bone_count: in Gen 7 GFModel, after transform (64B) is:
            # u32 empty_len, u32 empty_off (0x10), pad(8), empty_data(empty_len + 0x10?) -> bone_cnt at +0x20!
            # Let's read bone_count accurately: @p_after_transform + 0x04 is empty_off (0x10), then empty_data at +0x10,
            # so bones start at (p_after_transform + 0x10 + empty_len + empty_off)!
            # Verify against our Snivy dump: p_after_transform=0xa20, empty_len=0, empty_off=0x10 -> 0xa20+0x10+0+0x10 = 0xa40 -> bone_cnt=56!!
            p_xform_end = pos + 16
            for _ in range(4):
                cnt = struct.unpack_from('<I', data, p_xform_end)[0]
                p_xform_end += 4 + cnt * 68
            p_xform_end += 96
            empty_len, empty_off = struct.unpack_from('<II', data, p_xform_end)
            bp = p_xform_end + 0x10 + empty_off + empty_len
            bone_cnt = struct.unpack_from('<I', data, bp)[0]
            bp += 16  # bone_cnt + 12 pad bytes
            for _ in range(bone_cnt):
                bname, bp = _read_len_str(data, bp)
                pname, bp = _read_len_str(data, bp)
                bflags = data[bp]
                bp += 1
                scale = struct.unpack_from('<3f', data, bp)
                rot = struct.unpack_from('<3f', data, bp + 12)
                trans = struct.unpack_from('<3f', data, bp + 24)
                bp += 36
                skeleton.append({
                    'name': bname,
                    'parent': pname,
                    'flags': bflags,
                    'scale': scale,
                    'rotation': rot,
                    'translation': trans,
                })
        elif tag == 'material':
            materials.append(_parse_material(data, pos, slen))
        elif tag == 'mesh':
            meshes.append(_parse_mesh(data, pos, slen))
        pos += 16 + slen

    return {
        'bbox': bbox,
        'skeleton': skeleton,
        'materials': materials,
        'meshes': meshes,
    }
