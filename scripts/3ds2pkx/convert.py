"""A 3DS Gen 7 Pokémon GFModel + GFTexture + GFMotion, as a Colosseum .pkx, without Blender.

Reads the parsed GFModel, GFTexture packs (normal & shiny), and Battle GFMotion bank from a
decrypted 3DS Pokémon ROM (Ultra Sun / Ultra Moon / Sun / Moon), turns them into the IR of
StarsMmd's Blender-Addon-Gamecube-Models (GPL-3.0), and writes the .pkx via that add-on's
compose, serialize and package phases.

Coordinate & unit conventions:
  - 3DS GFModel is right-handed, +X left, +Y up, +Z forward, in centimetres.
  - GameCube IR is right-handed, +X left, +Y up, +Z forward, in metres (compose_scene scales x10
    to GameCube decimetres). So UNIT = 0.01 matches Battle Revolution and Colosseum 1:1.
  - 3DS meshes are stored in world/bind space; each bone's rest transform is its local TRS
    (scale -> Euler XYZ -> translate), chained from root to leaf.
  - 3DS GFMotion animations run at 30 fps (matching HSD's 30 fps) with Axis-Angle or Euler XYZ
    rotations and per-mesh visibility bitmasks.
"""
import copy
import math
import os
import sys

import mat4

ADDON = os.environ.get('GAMECUBE_ADDON') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'addon')
if ADDON not in sys.path:
    sys.path.insert(0, ADDON)
STUBS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'stubs')
if STUBS not in sys.path:
    sys.path.insert(0, STUBS)
import sitecustomize  # noqa: E402,F401

from shared.IR.scene import IRScene                                                       # noqa: E402
from shared.IR.skeleton import IRModel, IRBone                                            # noqa: E402
from shared.IR.geometry import IRMesh, IRUVLayer, IRBoneWeights                           # noqa: E402
from shared.IR.material import IRMaterial, IRTextureLayer, IRImage, FragmentBlending      # noqa: E402
from shared.IR.animation import IRKeyframe, IRBoneTrack, IRBoneAnimationSet, IRMaterialTrack  # noqa: E402
from shared.IR.enums import (SkinType, ScaleInheritance, Interpolation, CoordType, WrapMode, LayerBlendMode,  # noqa: E402
                             LightmapChannel, ColorSource, LightingModel, OutputBlendEffect, BlendFactor)
from shared.IR.material import GXTextureFormat                                           # noqa: E402
from shared.helpers.pkx_header import PKXHeader, AnimMetadataEntry, SubAnim, BODY_MAP_KEYS  # noqa: E402
from shared.helpers.logger import StubLogger                                              # noqa: E402
from exporter.phases.plan.helpers.scene import refine_bone_flags                          # noqa: E402
from exporter.phases.compose.compose import compose_scene                                 # noqa: E402
import exporter.phases.compose.compose as compose_phase                                   # noqa: E402
import exporter.phases.compose.helpers.materials as compose_materials                     # noqa: E402
from exporter.phases.serialize.serialize import serialize                                 # noqa: E402
from exporter.phases.package.package import package_output                                # noqa: E402

import boundbox                                                                           # noqa: E402
import textures                                                                           # noqa: E402
import shared.texture_encoder                                                             # noqa: E402
import gfmodel                                                                            # noqa: E402
import gfmotion                                                                           # noqa: E402
import gftexture                                                                          # noqa: E402

boundbox.install(compose_phase)
textures.install(shared.texture_encoder)


def _pixel_engine(fragment_blending, build=compose_materials._build_pixel_engine):
    """Ensure PE flags enable colour update + depth test + depth update on alpha-tested cutouts."""
    pe = build(fragment_blending)
    if pe is not None:
        pe.flags = 0x01 | 0x10 | 0x20
    return pe


compose_materials._build_pixel_engine = _pixel_engine

UNIT = 0.01  # 3DS centimetres -> IR metres (compose_scene scales x10 to GameCube decimetres)
FPS = 30
TOLERANCE = {'location': 0.0005, 'rotation': 0.003, 'scale': 0.003}

# 3DS bone name priority list for Colosseum's 16-entry body map
BODY_MAP_PRIORITY = {
    'origin': ['origin', 'root'],
    'mouth': ['jaw', 'mouth', 'head', 'neck', 'spine3', 'spine2', 'spine1', 'waist', 'origin'],
    'chest': ['spine2', 'spine1', 'chest', 'spine', 'waist', 'hips', 'origin'],
    'tail': ['tail10', 'tail9', 'tail8', 'tail7', 'tail6', 'tail5', 'tail4', 'tail3', 'tail2', 'tail1', 'tail', 'waist', 'origin'],
    'eye_left': ['leye', 'l_eye', 'eye_l', 'head', 'origin'],
    'eye_right': ['reye', 'r_eye', 'eye_r', 'head', 'origin'],
    'hand_left': ['lhand', 'l_hand', 'lforearm', 'larm', 'l_arm', 'lwing', 'lfoot', 'lleg', 'origin'],
    'hand_right': ['rhand', 'r_hand', 'rforearm', 'rarm', 'r_arm', 'rwing', 'rfoot', 'rleg', 'origin'],
    'additional_1': ['origin'],
    'additional_2': ['origin'],
    'additional_3': ['origin'],
    'additional_4': ['origin'],
    'foot_left': ['lfoot', 'l_foot', 'ltoe', 'lleg', 'l_leg', 'lthigh', 'lhand', 'larm', 'origin'],
    'foot_right': ['rfoot', 'r_foot', 'rtoe', 'rleg', 'r_leg', 'rthigh', 'rhand', 'rarm', 'origin'],
    'center': ['waist', 'hips', 'pelvis', 'spine1', 'spine', 'origin'],
    'additional_5': ['origin'],
}

# Battle motion indices inside /a/0/9/4 slot +4 (PC[32])
IDLE_SLOTS = [0, 1]
PHYSICAL_SLOTS = [8, 9, 10, 11, 12, 0]
SPECIAL_SLOTS = [12, 13, 14, 15, 8, 0]
DAMAGE_SLOTS = [16, 17, 0]
FAINT_SLOTS = [17, 16, 0]

# Colosseum's 17 animation slots: (anim_type, [candidate index lists])
SLOTS = [
    (2, [IDLE_SLOTS]),
    (4, [SPECIAL_SLOTS]),
    (4, [PHYSICAL_SLOTS]),
    (4, [PHYSICAL_SLOTS]),
    (4, [PHYSICAL_SLOTS]),
    (4, [PHYSICAL_SLOTS]),
    (4, [SPECIAL_SLOTS]),
    (4, [PHYSICAL_SLOTS]),
    (3, [DAMAGE_SLOTS]),
    (5, [DAMAGE_SLOTS, FAINT_SLOTS]),
    (3, [FAINT_SLOTS]),
    (2, None),
    (4, [SPECIAL_SLOTS]),
    (4, [SPECIAL_SLOTS]),
    (4, None),
    (4, [PHYSICAL_SLOTS]),
    (2, None),
]

# PICA200 wrap modes: 0=ClampToEdge, 1=ClampToBorder, 2=Repeat, 3=MirroredRepeat
PICA_WRAP = {
    0: WrapMode.CLAMP,
    1: WrapMode.CLAMP,
    2: WrapMode.REPEAT,
    3: WrapMode.MIRROR,
}

# PICA200 non-albedo texture suffixes to skip if accidentally listed first
SKIP_TEX_SUFFIXES = ('nor.tga', 'mask.tga', 'lta.tga', 'hta.tga', 'linertable.tga')


def take_apart(m, near=None):
    """Decompose 4x4 matrix into (translate, euler_xyz, scale), staying continuous with `near`."""
    t = [m[0][3], m[1][3], m[2][3]]
    s = mat4.column_lengths(m)
    r = [[m[i][j] / (s[j] if s[j] > 1e-12 else 1.0) for j in range(3)] for i in range(3)]
    if mat4.det3(r) < 0:
        s[0] = -s[0]
        for i in range(3):
            r[i][0] = -r[i][0]
    sy = -r[2][0]
    if abs(sy) < 0.999999:
        a = (math.atan2(r[2][1], r[2][2]), math.asin(max(-1.0, min(1.0, sy))), math.atan2(r[1][0], r[0][0]))
        b = (a[0] + math.pi, math.pi - a[1], a[2] + math.pi)
        choices = [a, b]
    else:
        choices = [(math.atan2(-r[1][2], r[1][1]), math.copysign(math.pi / 2, sy), 0.0)]
    if near is None:
        e = choices[0]
    else:
        def closest(angles):
            return tuple(x + 2 * math.pi * round((p - x) / (2 * math.pi)) for x, p in zip(angles, near))
        choices = [closest(c) for c in choices]
        e = min(choices, key=lambda c: sum((x - p) ** 2 for x, p in zip(c, near)))
    return t, e, s


def as_list(m):
    return [[float(x) for x in row] for row in m]


def trs_matrix(t, r, s, unit=1.0):
    return mat4.mul(mat4.translation([t[0] * unit, t[1] * unit, t[2] * unit]), mat4.euler(r), mat4.scaling(s))


def thin(values, tolerance):
    """Keep only keyframes needed so linear interpolation stays within `tolerance`."""
    n = len(values)
    if n <= 2:
        return list(range(n))
    keep, start = [0], 0
    while start < n - 1:
        end = start + 1
        while end + 1 < n:
            ok = all(
                abs(values[start] + (values[end + 1] - values[start]) * (i - start) / (end + 1 - start) - values[i]) <= tolerance
                for i in range(start + 1, end + 1)
            )
            if not ok:
                break
            end += 1
        keep.append(end)
        start = end
    return keep


def channel_keys(values, tolerance, rest, needed=False):
    if max(values) - min(values) <= tolerance:
        if abs(values[0] - rest) <= tolerance and not needed:
            return []
        return [
            IRKeyframe(frame=0.0, value=float(values[0]), interpolation=Interpolation.LINEAR),
            IRKeyframe(frame=float(len(values) - 1), value=float(values[0]), interpolation=Interpolation.LINEAR),
        ]
    return [IRKeyframe(frame=float(f), value=float(values[f]), interpolation=Interpolation.LINEAR) for f in thin(values, tolerance)]


def pick_bone(names, candidates):
    lower = {n.lower(): n for n in names}
    for c in candidates:
        if c in lower:
            return lower[c]
    # Substring fallback (e.g. 'TailA1' matches 'tail', 'L_Hand' matches 'lhand')
    for c in candidates:
        for lo, orig in lower.items():
            if c in lo:
                return orig
    return None


def limit_weights(weights, bone_names, most=4, step=0.1):
    w = sorted(((bone_names[b], x) for b, x in weights if x > 0 and 0 <= b < len(bone_names)), key=lambda p: -p[1])[:most]
    if not w:
        return [(bone_names[0], 1.0)]
    total = sum(x for _, x in w) or 1.0
    q = [(n, round(x / total / step) * step) for n, x in w]
    q = [(n, x) for n, x in q if x > 0] or [(w[0][0], 1.0)]
    q[0] = (q[0][0], q[0][1] + 1.0 - sum(x for _, x in q))
    merged = {}
    for n, x in q:
        merged[n] = merged.get(n, 0.0) + x
    return [(n, round(x, 6)) for n, x in merged.items()]


def _decode_texture_pack(tex_blobs):
    """Decode all GFTexture blobs in a pack -> dict(name_lower -> decoded_tex)."""
    out = {}
    for blob in tex_blobs:
        t = gftexture.read_gftexture(blob)
        if t:
            out[t['name'].lower()] = t
    return out


ALPHA_KIND = {}


def _make_ir_image(tex, image_id, max_size):
    """Build an IRImage (bottom-up RGBA, resized to <= max_size) and classify its alpha."""
    w, h = tex['width'], tex['height']
    # IRImage expects bottom-to-top rows (OpenGL/Blender convention)
    px = tex['rgba_flipped']
    alpha = px[3::4]
    see_through = sum(1 for a in alpha if a < 240)
    kind = 'opaque' if not see_through else 'blend' if sum(1 for a in alpha if 16 <= a < 240) > len(alpha) // 100 else 'cut'
    ALPHA_KIND[(tex['name'], image_id)] = kind
    while max(w, h) > max_size and w >= 8 and h >= 8:
        px, w, h = textures.shrink(px, w, h), w // 2, h // 2
    grey = (px[0::4] == px[1::4] == px[2::4])
    alpha_now = px[3::4]
    fmt = GXTextureFormat.AUTO
    if grey and alpha_now.count(255) != len(alpha_now) and alpha_now != px[0::4]:
        fmt = GXTextureFormat.IA8
    elif kind == 'blend' and not grey:
        fmt = GXTextureFormat.RGB5A3
    return IRImage(name=tex['name'], width=w, height=h, pixels=px, image_id=image_id, palette_id=0, gx_format_override=fmt)


def _pick_diffuse_texcoord(gf_mat, tex_dict):
    """Pick the primary albedo texture coordinate unit on a GFMaterial."""
    if not gf_mat or not gf_mat.get('tex_coords'):
        return None, None
    # Prefer the first unit whose texture exists in tex_dict and isn't a normal/mask/LUT map
    for tc in gf_mat['tex_coords']:
        nm = tc['name'].lower()
        if nm in tex_dict and not any(nm.endswith(suf) for suf in SKIP_TEX_SUFFIXES):
            return tc, tex_dict[nm]
    for tc in gf_mat['tex_coords']:
        nm = tc['name'].lower()
        if nm in tex_dict:
            return tc, tex_dict[nm]
    return gf_mat['tex_coords'][0], None


def _apply_uv_transform(u, v, tc):
    """Apply PICA200 / Maya GFTextureCoord (scale, rotation, translation) to (u, v)."""
    if not tc:
        return (float(u), float(v))
    sx, sy = tc['scale']
    tx, ty = tc['translation']
    rot = tc['rotation']
    if abs(rot) > 1e-6:
        c, s = math.cos(rot), math.sin(rot)
        u2 = (u * c - v * s) * sx + tx
        v2 = (u * s + v * c) * sy + ty
        return (float(u2), float(v2))
    return (float(u * sx + tx), float(v * sy + ty))


def _material_of(gf_mat, tex_dict, images, max_size, hideable=False):
    tc, tex = _pick_diffuse_texcoord(gf_mat, tex_dict)
    layers = []
    alpha = 'opaque'
    diffuse = (1.0, 1.0, 1.0, 1.0)
    ambient = (0.5, 0.5, 0.5, 1.0)
    lighting = LightingModel.LIT

    # Detect emissive / fire / eye-glow materials (common on 3DS: Fire, Flame, Glow, Beam, Inc)
    if gf_mat:
        em = gf_mat.get('emission', (0.0, 0.0, 0.0, 0.0))
        mat_lo = gf_mat['name'].lower()
        if max(em[:3]) > 0.35 or 'fire' in mat_lo or 'flame' in mat_lo:
            lighting = LightingModel.UNLIT
            if not tex:
                d = gf_mat.get('diffuse', (1.0, 1.0, 1.0, 1.0))
                diffuse = tuple(min(1.0, a + b) for a, b in zip(d[:3], em[:3])) + (1.0,)
        elif not tex:
            d = gf_mat.get('diffuse', (1.0, 1.0, 1.0, 1.0))
            diffuse = d[:3] + (1.0,)

    if tex:
        key = tex['name'].lower()
        if key not in images:
            images[key] = _make_ir_image(tex, 0x7000 + len(images), max_size)
        ir_img = images[key]
        alpha = ALPHA_KIND.get((ir_img.name, ir_img.image_id), 'opaque')
        wrap_s = PICA_WRAP.get(tc['wrap_u'], WrapMode.REPEAT) if tc else WrapMode.REPEAT
        wrap_t = PICA_WRAP.get(tc['wrap_v'], WrapMode.REPEAT) if tc else WrapMode.REPEAT
        # If material explicitly enables alpha test, treat as cut-out at minimum
        if alpha == 'opaque' and gf_mat and gf_mat.get('alpha_test'):
            alpha = 'cut'
        layers.append(IRTextureLayer(
            image=ir_img, coord_type=CoordType.UV, uv_index=0,
            rotation=(0.0, 0.0, 0.0), scale=(1.0, 1.0, 1.0), translation=(0.0, 0.0, 0.0),
            wrap_s=wrap_s, wrap_t=wrap_t, repeat_s=1, repeat_t=1, interpolation=None,
            color_blend=LayerBlendMode.MIX,
            alpha_blend=LayerBlendMode.NONE if alpha == 'opaque' else LayerBlendMode.MULTIPLY,
            blend_factor=1.0, lightmap_channel=LightmapChannel.DIFFUSE, is_bump=False, combiner=None,
        ))

    is_blend = (alpha == 'blend') or (gf_mat and gf_mat.get('blend_enabled') and alpha != 'opaque')
    translucent = bool(is_blend or hideable)
    cut = None if translucent or alpha != 'cut' else FragmentBlending(
        effect=OutputBlendEffect.OPAQUE, source_factor=BlendFactor.ONE, dest_factor=BlendFactor.ZERO,
        alpha_test_threshold_0=4, alpha_test_threshold_1=7, alpha_test_op=0, depth_compare=3,
    )
    return IRMaterial(
        diffuse_color=diffuse, ambient_color=ambient, specular_color=(1.0, 1.0, 1.0, 1.0),
        alpha=1.0, shininess=50.0, color_source=ColorSource.MATERIAL, alpha_source=ColorSource.MATERIAL,
        lighting=lighting, enable_specular=False, is_translucent=translucent, texture_layers=layers,
        fragment_blending=cut,
    )


def _prepare_skeleton(gf_skel):
    """Order bones parent-before-child and compute world/local/inverse-bind matrices in IR metres."""
    if not gf_skel:
        gf_skel = [{'name': 'Origin', 'parent': '', 'flags': 0,
                    'scale': (1.0, 1.0, 1.0), 'rotation': (0.0, 0.0, 0.0), 'translation': (0.0, 0.0, 0.0)}]
    by_name = {b['name']: i for i, b in enumerate(gf_skel)}
    children = [[] for _ in gf_skel]
    roots = []
    for i, b in enumerate(gf_skel):
        p = by_name.get(b['parent']) if b['parent'] else None
        if p is not None and p != i:
            children[p].append(i)
        else:
            roots.append(i)
    order = []
    visited = set()

    def walk(idx):
        if idx in visited:
            return
        visited.add(idx)
        order.append(idx)
        for c in children[idx]:
            walk(c)

    for r in roots:
        walk(r)
    for i in range(len(gf_skel)):
        walk(i)

    orig_to_pos = {orig: pos for pos, orig in enumerate(order)}
    unique_names = []
    taken = set()
    for pos, orig in enumerate(order):
        nm = gf_skel[orig]['name'] or ('Bone_%d' % pos)
        if nm in taken:
            nm = '%s.%d' % (nm, pos)
            while nm in taken:
                nm += '_'
        taken.add(nm)
        unique_names.append(nm)

    world_mats = {}
    bone_fields = []
    for pos, orig in enumerate(order):
        b = gf_skel[orig]
        p_orig = by_name.get(b['parent']) if b['parent'] else None
        if p_orig == orig:
            p_orig = None
        parent_pos = orig_to_pos[p_orig] if p_orig is not None else None
        local = trs_matrix(b['translation'], b['rotation'], b['scale'], UNIT)
        parent_world = world_mats[parent_pos] if parent_pos is not None else mat4.eye()
        world = mat4.mul(parent_world, local)
        world_mats[pos] = world
        t, r, s = take_apart(local)
        bone_fields.append(dict(
            name=unique_names[pos],
            parent_index=parent_pos,
            position=tuple(float(x) for x in t),
            rotation=tuple(float(x) for x in r),
            scale=tuple(float(x) for x in s),
            inverse_bind_matrix=as_list(mat4.inv(world)),
            flags=0,
            is_hidden=False,
            inherit_scale=ScaleInheritance.ALIGNED,
            ik_shrink=False,
            world_matrix=as_list(world),
            local_matrix=as_list(local),
            normalized_world_matrix=as_list(world),
            normalized_local_matrix=as_list(local),
            scale_correction=as_list(mat4.eye()),
            accumulated_scale=(1.0, 1.0, 1.0),
        ))
    return order, orig_to_pos, unique_names, bone_fields


def _select_battle_motions(battle_blobs):
    """Parse available skeletal battle motions from slot +4 and map Colosseum's 17 slots."""
    parsed = {}
    for idx, blob in enumerate(battle_blobs):
        if not blob:
            continue
        mot = gfmotion.read_gfmotion(blob)
        if mot and mot['frames'] > 0 and (mot['bones'] or mot['visibility']):
            parsed[idx] = mot

    def pick_slot(candidates):
        for c in candidates:
            if c in parsed and parsed[c]['bones']:
                return c
        for c in candidates:
            if c in parsed:
                return c
        return next(iter(parsed), None)

    slot_actions = []
    used_indices = []
    for kind, lists in SLOTS:
        chosen = [pick_slot(cands) for cands in lists] if lists else None
        if chosen and None in chosen:
            chosen = None
        slot_actions.append((kind, chosen))
        for idx in chosen or []:
            if idx not in used_indices:
                used_indices.append(idx)
    return parsed, slot_actions, used_indices


def _sample_animations(gf_skel, order, bone_fields, unique_names, parsed_motions, used_indices, geometry, hideable):
    """Sample all chosen GFMotion clips at 30 fps into IRBoneTrack & IRMaterialTrack lists."""
    # Pre-check which bones/channels move across any animation
    curves = []  # (mot_idx, pos, series)
    lengths = {}
    for mot_idx in used_indices:
        mot = parsed_motions[mot_idx]
        frames = max(2, int(mot['frames']) + 1)
        lengths[mot_idx] = frames
        mot_bones = mot['bones']
        for pos, orig in enumerate(order):
            b = gf_skel[orig]
            mb = mot_bones.get(b['name'])
            if not mb:
                continue
            tracks = mb['tracks']
            is_aa = mb['is_axis_angle']
            rx0, ry0, rz0 = b['rotation']
            tx0, ty0, tz0 = b['translation']
            sx0, sy0, sz0 = b['scale']
            # Check if rotation tracks are present when axis-angle
            has_rot = any(tracks[3 + k] for k in range(3))
            series = {'location': [[], [], []], 'rotation': [[], [], []], 'scale': [[], [], []]}
            prev_rot = bone_fields[pos]['rotation']
            for f in range(frames):
                sx = gfmotion.evaluate_track(tracks[0], f, sx0)
                sy = gfmotion.evaluate_track(tracks[1], f, sy0)
                sz = gfmotion.evaluate_track(tracks[2], f, sz0)
                if has_rot:
                    if is_aa:
                        ax = gfmotion.evaluate_track(tracks[3], f, 0.0)
                        ay = gfmotion.evaluate_track(tracks[4], f, 0.0)
                        az = gfmotion.evaluate_track(tracks[5], f, 0.0)
                        rx, ry, rz = gfmotion.axis_angle_to_euler_xyz(ax, ay, az)
                    else:
                        rx = gfmotion.evaluate_track(tracks[3], f, rx0)
                        ry = gfmotion.evaluate_track(tracks[4], f, ry0)
                        rz = gfmotion.evaluate_track(tracks[5], f, rz0)
                else:
                    rx, ry, rz = rx0, ry0, rz0
                tx = gfmotion.evaluate_track(tracks[6], f, tx0)
                ty = gfmotion.evaluate_track(tracks[7], f, ty0)
                tz = gfmotion.evaluate_track(tracks[8], f, tz0)
                m = trs_matrix((tx, ty, tz), (rx, ry, rz), (sx, sy, sz), UNIT)
                tt, rr, ss = take_apart(m, prev_rot)
                prev_rot = rr
                for k in range(3):
                    series['location'][k].append(float(tt[k]))
                    series['rotation'][k].append(float(rr[k]))
                    series['scale'][k].append(float(ss[k]))
            curves.append((mot_idx, pos, series))

    rests = {'rotation': 'rotation', 'location': 'position', 'scale': 'scale'}
    keys = {}
    for mot_idx, pos, series in curves:
        bf = bone_fields[pos]
        for kind in rests:
            for k in range(3):
                keys[(mot_idx, pos, kind, k)] = channel_keys(series[kind][k], TOLERANCE[kind], bf[rests[kind]][k])
    needed = {(pos, kind, k) for (_, pos, kind, k), kf in keys.items() if kf}

    # Ensure every bone/channel animated by ANY clip is keyed in ALL clips so transitions reset cleanly
    sampled = {mot_idx: [] for mot_idx in used_indices}
    by_mot_pos = {(mot_idx, pos): series for mot_idx, pos, series in curves}
    animated_positions = sorted({pos for pos, _, _ in needed})
    for mot_idx in used_indices:
        frames = lengths[mot_idx]
        for pos in animated_positions:
            bf = bone_fields[pos]
            series = by_mot_pos.get((mot_idx, pos))
            made_keys = {}
            for kind in rests:
                ch_list = []
                for k in range(3):
                    if series is not None:
                        kf = keys.get((mot_idx, pos, kind, k))
                        if not kf and (pos, kind, k) in needed:
                            kf = channel_keys(series[kind][k], TOLERANCE[kind], bf[rests[kind]][k], True)
                    elif (pos, kind, k) in needed:
                        rest_val = float(bf[rests[kind]][k])
                        kf = [
                            IRKeyframe(frame=0.0, value=rest_val, interpolation=Interpolation.LINEAR),
                            IRKeyframe(frame=float(frames - 1), value=rest_val, interpolation=Interpolation.LINEAR),
                        ]
                    else:
                        kf = []
                    ch_list.append(kf or [])
                made_keys[kind] = ch_list
            if not any(made_keys['rotation'] + made_keys['location'] + made_keys['scale']):
                continue
            sampled[mot_idx].append(IRBoneTrack(
                bone_name=unique_names[pos],
                bone_index=pos,
                rotation=made_keys['rotation'],
                location=made_keys['location'],
                scale=made_keys['scale'],
                rest_local_matrix=bf['local_matrix'],
                rest_rotation=bf['rotation'],
                rest_position=bf['position'],
                rest_scale=bf['scale'],
                end_frame=float(frames - 1),
            ))

    # Material visibility tracks (alpha 0 = shown, 1/255 = hidden per HSD MObjUpdateFunc)
    mat_tracks = {}
    for mot_idx in used_indices:
        mot = parsed_motions[mot_idx]
        frames = lengths[mot_idx]
        vis_map = mot['visibility']
        loop = mot_idx in IDLE_SLOTS
        tracks = []
        for mesh_name, _mat_name, fields in geometry:
            if mesh_name not in hideable:
                continue
            vis = vis_map.get(mesh_name)
            if vis:
                vals = [1.0 if vis[min(f, len(vis) - 1)] else 0.0 for f in range(frames)]
            else:
                vals = [1.0] * frames
            alpha = [
                IRKeyframe(frame=float(f), value=(1.0 - vals[f]) / 255.0, interpolation=Interpolation.LINEAR)
                for f in thin(vals, 0.01)
            ]
            tracks.append(IRMaterialTrack(material_mesh_name=fields['id'], alpha=alpha, loop=loop))
        mat_tracks[mot_idx] = tracks

    return sampled, mat_tracks, lengths


def build(model_data, tex_blobs, battle_blobs, name, max_texture=256, log=print, reuse=None):
    """Build a Colosseum .pkx from GFModel bytes, texture pack blobs, and battle motion blobs.

    Returns (pkx_bytes, made_cache) where `made_cache` can be passed as `reuse=` when converting
    the matching shiny variant (3DS shiny Pokémon share 100% of geometry, skeleton, and motions).
    """
    gf = reuse['gf'] if reuse else gfmodel.read_gfmodel(model_data)
    gf_mats = {m['name']: m for m in gf['materials']}
    tex_dict = _decode_texture_pack(tex_blobs)

    if reuse:
        order = reuse['order']
        orig_to_pos = reuse['orig_to_pos']
        unique_names = reuse['unique_names']
        bone_fields = copy.deepcopy(reuse['bone_fields'])
        parsed_motions = reuse['parsed_motions']
        slot_actions = reuse['slot_actions']
        used_indices = reuse['used_indices']
        hideable = reuse['hideable']
        geometry = copy.deepcopy(reuse['geometry'])
        sampled = copy.deepcopy(reuse['sampled'])
        mat_tracks = copy.deepcopy(reuse['mat_tracks'])
        lengths = reuse['lengths']
    else:
        order, orig_to_pos, unique_names, bone_fields = _prepare_skeleton(gf['skeleton'])
        parsed_motions, slot_actions, used_indices = _select_battle_motions(battle_blobs)
        if not used_indices:
            # Create a minimal 2-frame static idle animation if a model has no motions
            parsed_motions = {0: {'frames': 1, 'loop': True, 'bones': {}, 'visibility': {}}}
            used_indices = [0]
            slot_actions = [(kind, [0] if lists else None) for kind, lists in SLOTS]

        # Classify mesh visibility across all used battle animations
        always_hidden = set()
        hideable = set()
        all_mesh_names = {m['name'] for m in gf['meshes']}
        for mn in all_mesh_names:
            seen_true = False
            seen_false = False
            for mot_idx in used_indices:
                vis = parsed_motions[mot_idx]['visibility'].get(mn)
                if not vis:
                    seen_true = True
                else:
                    if any(vis):
                        seen_true = True
                    if not all(vis):
                        seen_false = True
            if seen_false and not seen_true:
                always_hidden.add(mn)
            elif seen_false and seen_true:
                hideable.add(mn)

        geometry = []
        for mi, mesh in enumerate(gf['meshes']):
            mn = mesh['name']
            if mn in always_hidden:
                continue
            for si, sm in enumerate(mesh['submeshes']):
                if not sm['triangles'] or not sm['positions']:
                    continue
                gf_mat = gf_mats.get(sm['name'])
                tc, _ = _pick_diffuse_texcoord(gf_mat, tex_dict)
                n_verts = len(sm['positions'])
                vertices = [(float(x) * UNIT, float(y) * UNIT, float(z) * UNIT) for x, y, z in sm['positions']]
                raw_norms = sm['normals']
                raw_uv0 = sm['uv0']
                faces = []
                normals = []
                uvs = []
                for a, b, c in sm['triangles']:
                    if a == b or b == c or a == c or max(a, b, c) >= n_verts:
                        continue
                    # PICA200 triangles are CCW front-facing, matching Blender/IRMesh (compose reverses to GX CW)
                    faces.append([a, b, c])
                    for vi in (a, b, c):
                        nrm = raw_norms[vi] if vi < len(raw_norms) else (0.0, 1.0, 0.0)
                        normals.append((float(nrm[0]), float(nrm[1]), float(nrm[2])))
                        u, v = raw_uv0[vi] if vi < len(raw_uv0) else (0.0, 0.0)
                        uvs.append(_apply_uv_transform(u, v, tc))
                if not faces:
                    continue

                # Remap skin bone weights from original GF skeleton index -> ordered IR bone index
                raw_w = sm['weights']
                assignments = []
                rigid_bones = set()
                for vi in range(n_verts):
                    vw = raw_w[vi] if vi < len(raw_w) else []
                    mapped = [(orig_to_pos[bidx], w) for bidx, w in vw if bidx in orig_to_pos and w > 0]
                    lw = limit_weights(mapped, unique_names)
                    assignments.append((vi, lw))
                    if len(lw) == 1 and lw[0][1] >= 0.999:
                        rigid_bones.add(lw[0][0])
                    else:
                        rigid_bones.add(None)

                if len(rigid_bones) == 1 and None not in rigid_bones:
                    only_bone = next(iter(rigid_bones))
                    parent_bi = unique_names.index(only_bone)
                    weights = IRBoneWeights(type=SkinType.RIGID, bone_name=only_bone)
                else:
                    parent_bi = 0
                    weights = IRBoneWeights(type=SkinType.WEIGHTED, assignments=assignments)

                cull_back = (gf_mat.get('cull_mode', 2) != 0) if gf_mat else True
                mesh_id = '%s_%d_%d' % (mn or 'mesh', mi, si)
                fields = dict(
                    name=mesh_id,
                    id=mesh_id,
                    vertices=vertices,
                    faces=faces,
                    uv_layers=[IRUVLayer(name='UVMap', uvs=uvs)],
                    normals=normals,
                    bone_weights=weights,
                    parent_bone_index=parent_bi,
                    cull_back=cull_back,
                )
                geometry.append((mn, sm['name'], fields))

        sampled, mat_tracks, lengths = _sample_animations(
            gf['skeleton'], order, bone_fields, unique_names, parsed_motions, used_indices, geometry, hideable
        )

    bones = [IRBone(**bf) for bf in bone_fields]
    images = {}
    meshes = []
    for mn, mat_name, fields in geometry:
        ir_mat = _material_of(gf_mats.get(mat_name), tex_dict, images, max_texture, mn in hideable)
        meshes.append(IRMesh(material=ir_mat, **fields))

    for mi, m in enumerate(meshes):
        bones[m.parent_bone_index].mesh_indices.append(mi)
    refine_bone_flags(bones, meshes, logger=StubLogger())

    animation_sets = []
    for mot_idx in used_indices:
        tracks = sampled.get(mot_idx, [])
        mtracks = mat_tracks.get(mot_idx, [])
        loop = mot_idx in IDLE_SLOTS
        animation_sets.append(IRBoneAnimationSet(
            name='%s_m%02d' % (name, mot_idx),
            tracks=tracks,
            loop=loop,
            material_tracks=mtracks,
        ))
        log('  m%02d        %3d frames, %d bones animated, %d keys' % (
            mot_idx, lengths[mot_idx], len(tracks),
            sum(len(k) for tr in tracks for ch in (tr.rotation, tr.location, tr.scale) for k in ch),
        ))

    ir_model = IRModel(name=name, bones=bones, meshes=meshes, bone_animations=animation_sets)
    scene = IRScene(models=[ir_model], lights=[], cameras=[], fogs=[])

    # Colosseum PKX header
    bone_names = [b.name for b in bones]
    body = []
    for key in BODY_MAP_KEYS:
        chosen = pick_bone(bone_names, BODY_MAP_PRIORITY[key]) or bone_names[0]
        body.append(bone_names.index(chosen))
    head = body[BODY_MAP_KEYS.index('mouth')]
    header = PKXHeader(is_xd=False)
    header.anim_section_count = len(SLOTS)
    header.particle_orientation = -1
    header.head_bone_index = head
    header.colo_part_anim_refs = [-1, -1, -1]
    header.colo_unknown_10 = 5
    header.colo_unknown_14 = -1
    header.type_id = 12
    entries = []
    for kind, chosen in slot_actions:
        if chosen:
            subs = [SubAnim(motion_type=0, anim_index=used_indices.index(idx)) for idx in chosen]
            d = [(lengths[idx] - 1) / FPS for idx in chosen]
            hit = [dur * 0.45 for dur in d]
            timing = {
                2: (d[0], 0.0, 0.0, 0.0),
                4: (hit[0] * 0.5, hit[0], d[0], 0.0),
                3: (hit[0], d[0], 0.0, 0.0),
                5: (hit[0], d[0], hit[-1], d[-1]),
            }[kind]
        else:
            subs, timing = [SubAnim(motion_type=1, anim_index=0)], (0.0, 0.0, 0.0, 0.0)
        entries.append(AnimMetadataEntry(
            anim_type=kind, sub_anim_count=len(subs), damage_flags=0, timing=timing,
            body_map_bones=list(body), sub_anims=subs, terminator=1,
        ))
    header.anim_entries = entries

    made = None
    if not reuse:
        made = {
            'gf': gf,
            'order': order,
            'orig_to_pos': orig_to_pos,
            'unique_names': unique_names,
            'bone_fields': copy.deepcopy(bone_fields),
            'parsed_motions': parsed_motions,
            'slot_actions': slot_actions,
            'used_indices': used_indices,
            'hideable': hideable,
            'geometry': copy.deepcopy(geometry),
            'sampled': copy.deepcopy(sampled),
            'mat_tracks': copy.deepcopy(mat_tracks),
            'lengths': lengths,
        }

    log_ = StubLogger()
    boundbox.given = (ir_model, reuse['box']) if reuse else None
    roots, sections = compose_scene(scene, {}, log_)
    if made is not None:
        made['box'] = boundbox.last[1] if boundbox.last and boundbox.last[0] is ir_model else None
    boundbox.given = boundbox.last = None
    dat = serialize(roots, sections, log_)
    pkx = package_output(dat, name + '.pkx', {}, log_, shiny_params=None, pkx_header=header)
    log('  %d bones, %d meshes (%d triangles), %d animations, %d textures: %d bytes' % (
        len(bones), len(meshes), sum(len(m.faces) for m in meshes), len(animation_sets), len(images), len(pkx)))
    return pkx, made


def convert(slot_data, name, shiny=False, max_texture=256, log=print):
    tex_blobs = slot_data['shiny_tex_pc'] if shiny else slot_data['normal_tex_pc']
    return build(slot_data['model_pc'][0], tex_blobs, slot_data['battle_motions'], name, max_texture, log)[0]


def convert_pair(slot_data, name, shiny_name, max_texture=256, log=print):
    """Convert a Pokémon's normal and shiny 3DS models into two .pkx files, reusing all geometry/anims."""
    model_data = slot_data['model_pc'][0]
    battle = slot_data['battle_motions']
    first, made = build(model_data, slot_data['normal_tex_pc'], battle, name, max_texture, log)
    second, _ = build(model_data, slot_data['shiny_tex_pc'], battle, shiny_name, max_texture, log, reuse=made)
    return first, second
