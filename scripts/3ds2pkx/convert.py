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
from shared.IR.geometry import IRMesh, IRUVLayer, IRColorLayer, IRBoneWeights             # noqa: E402
from shared.IR.material import IRMaterial, IRTextureLayer, IRImage, FragmentBlending      # noqa: E402
from shared.IR.animation import IRKeyframe, IRBoneTrack, IRBoneAnimationSet, IRMaterialTrack, IRTextureUVTrack  # noqa: E402
from shared.IR.enums import (SkinType, ScaleInheritance, Interpolation, CoordType, WrapMode, LayerBlendMode,  # noqa: E402
                             LightmapChannel, ColorSource, LightingModel, OutputBlendEffect, BlendFactor)
from shared.IR.material import GXTextureFormat                                           # noqa: E402
from shared.Constants.hsd import (RENDER_NO_ZUPDATE, JOBJ_XLU, JOBJ_TEXEDGE,               # noqa: E402
                                  JOBJ_ROOT_XLU, JOBJ_ROOT_TEXEDGE)
from shared.helpers.pkx_header import PKXHeader, AnimMetadataEntry, SubAnim, BODY_MAP_KEYS  # noqa: E402
from shared.helpers.logger import StubLogger                                              # noqa: E402
from exporter.phases.plan.helpers.scene import refine_bone_flags                          # noqa: E402
from exporter.phases.compose.compose import compose_scene                                 # noqa: E402
import exporter.phases.compose.compose as compose_phase                                   # noqa: E402
import exporter.phases.compose.helpers.materials as compose_materials                     # noqa: E402
import exporter.phases.compose.helpers.meshes as compose_meshes                           # noqa: E402
from exporter.phases.serialize.serialize import serialize                                 # noqa: E402
from exporter.phases.package.package import package_output                                # noqa: E402

import boundbox                                                                           # noqa: E402
import portrait                                                                           # noqa: E402
import textures                                                                           # noqa: E402
import shared.texture_encoder                                                             # noqa: E402
import gfmodel                                                                            # noqa: E402
import gfmotion                                                                           # noqa: E402
import gftexture                                                                          # noqa: E402

boundbox.install(compose_phase)
textures.install(shared.texture_encoder)


def _render_mode(ir_mat, build=compose_materials._build_render_mode):
    """Set RENDER_NO_ZUPDATE on translucent materials whose 3DS shader disables depth writes (e.g. Reuniclus's jelly,
    Avalugg's ice visor, Chandelure's flames, Zygarde's glow). HSD panics if RENDER_NO_ZUPDATE is set without
    RENDER_XLU, so only set it on translucent materials."""
    mode = build(ir_mat)
    if ir_mat.is_translucent and getattr(ir_mat, 'no_depth_update', False):
        mode |= RENDER_NO_ZUPDATE
    return mode


compose_materials._build_render_mode = _render_mode


def _pixel_engine(fragment_blending, build=compose_materials._build_pixel_engine):
    """Ensure PE flags enable colour update + depth test + depth update on alpha-tested cutouts, and disable depth
    update on translucent materials with depth_write=False. A material whose depth test always passes (ALWAYS, 7:
    _through_material) neither tests nor writes depth: drawn over what is in front of it, as the 3DS draws a part
    seen through another."""
    pe = build(fragment_blending)
    if pe is not None:
        if fragment_blending.depth_compare == 7:
            pe.flags = 0x01
        elif getattr(fragment_blending, 'no_depth_update', False):
            pe.flags = 0x01 | 0x10
        else:
            pe.flags = 0x01 | 0x10 | 0x20
    return pe


compose_materials._build_pixel_engine = _pixel_engine


def _xlu_flags(bones, meshes):
    """Split translucent bones between JOBJ_TEXEDGE (depth-writing cutouts / hideable parts) and JOBJ_XLU
    (RENDER_XLU | RENDER_NO_ZUPDATE parts). GameCube HSD puts RENDER_XLU|RENDER_NO_ZUPDATE DObjs in the XLU pass
    (drawn last, after all opaque and cutout meshes), so joints owning them must carry JOBJ_XLU / JOBJ_ROOT_XLU."""
    texedge, xlu = set(), set()
    for m in meshes:
        bi = m.parent_bone_index
        mat = m.material
        if bi >= len(bones) or mat is None or not getattr(mat, 'is_translucent', False):
            continue
        if getattr(mat, 'no_depth_update', False):
            xlu.add(bi)
        else:
            texedge.add(bi)
    texedge_anc, xlu_anc = set(texedge), set(xlu)
    for i in range(len(bones) - 1, -1, -1):
        pi = bones[i].parent_index
        if pi is not None:
            if i in texedge_anc:
                texedge_anc.add(pi)
            if i in xlu_anc:
                xlu_anc.add(pi)
    clear = JOBJ_TEXEDGE | JOBJ_XLU | JOBJ_ROOT_TEXEDGE | JOBJ_ROOT_XLU
    for i, bone in enumerate(bones):
        flags = bone.flags & ~clear
        if i in texedge:
            flags |= JOBJ_TEXEDGE
        if i in xlu:
            flags |= JOBJ_XLU
        if i in texedge_anc:
            flags |= JOBJ_ROOT_TEXEDGE
        if i in xlu_anc:
            flags |= JOBJ_ROOT_XLU
        bone.flags = flags


def _display_list(faces, vertices, vertex_descs, vertex_buffers, *rest, encode=compose_meshes._encode_display_list, **named):
    """Write each point's attributes in the GameCube's order (position, normal, colours, then texture coordinates),
    as it reads them. Compose writes them in the order it made them, colours after texture coordinates, so a mesh
    with both (a flame's core: _stencil_fires) had its colours read from its texture coordinates' indices, and
    showed every colour of the rainbow. The game sets each attribute up on its own, so the mesh's attribute list
    can stay as it is (the envelope splitter reads it beside its own buffers for every part)."""
    order = sorted(range(len(vertex_descs)), key=lambda i: vertex_descs[i].attribute)
    return encode(faces, vertices, [vertex_descs[i] for i in order], [vertex_buffers[i] for i in order], *rest, **named)


compose_meshes._encode_display_list = _display_list

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

# The 3DS games' face tables, battle motions 19, 20 and 21 (both eyes, then each eye alone): 80 frames that walk the eye
# sheet's eight expressions, ten frames each, with no joints. The games sample them to set a face, and blink with them
# from code, so no idle animation has a blink in it. HALF_SHUT and SHUT are the frames of the half-closed and closed eyes.
FACE_TABLES = (19, 20, 21)
HALF_SHUT, SHUT = 15, 25
# Colosseum's three eye animations (pkx header 0x18 falling asleep, 0x1C waking, 0x20 a blink when idle), which XD plays
# as its part animations too: (frame, face table frame, or None for the eyes as they rest). Falling asleep ends shut, as
# the game leaves an eye animation's last frame on until the body's next animation.
EYE_ACTIONS = (
    ((0, HALF_SHUT), (2, SHUT), (3, SHUT)),
    ((0, SHUT), (2, HALF_SHUT), (4, None), (5, None)),
    ((0, HALF_SHUT), (1, SHUT), (3, HALF_SHUT), (4, None), (5, None)),
)

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


def _iris_mask(gf_mat, tex_dict):
    """(texture coordinate, texture) of the mask an iris is seen through, or None. A 3DS iris is its own mesh over
    the eye, drawn see-through (render layer 1) and multiplied by the alpha of its material's third texture: the
    eye's ...EyeNor.tga, whose alpha is where the eye is open, read as the eye's own material reads it. Without it,
    an iris was drawn over the eyelid (Zorua's red lid, Tepig's orange one)."""
    if not gf_mat or 'iris' not in gf_mat.get('shader', '').lower() or not gf_mat.get('blend_enabled'):
        return None
    units = gf_mat.get('tex_coords') or []
    if len(units) < 3:
        return None
    tex = tex_dict.get(units[2]['name'].lower())
    if not tex or all(a == 255 for a in tex['rgba_flipped'][3::4]):
        return None
    return units[2], tex


def _chandela_fire_mask(gf_mat, tex_dict):
    """(texture coordinate, texture) of the flame mask on Litwick, Lampent and Chandelure (PDC_pm_chandela_FireGRE).
    Their blended flame meshes use a solid flame-colour texture on u0 and a grayscale flame-shape mask on u2
    (...Mask.tga); without u2 as an alpha mask the flame draws as opaque purple/blue squares."""
    if not gf_mat or 'chandela_fire' not in gf_mat.get('shader', '').lower() or not gf_mat.get('blend_enabled'):
        return None
    units = gf_mat.get('tex_coords') or []
    if len(units) < 3:
        return None
    tex = tex_dict.get(units[2]['name'].lower())
    if not tex:
        return None
    return units[2], tex


def _apply_uv_transform(u, v, tc):
    """Apply a GFTextureCoord (scale, rotation, translation) to (u, v) as the 3DS games do (Maya's texture matrix,
    SPICA's DccMaya): the translation is taken away before the scale, u' = scale * (u - translation), and a rotation
    turns about the texture's middle (no Pokémon's material has one). An eye or mouth texture is a sheet of
    expressions, two across (mirrored) and four down, and its translation picks one: added instead, every eye
    showed the sheet's other column, the narrowed, angry-looking eyes."""
    if not tc:
        return (float(u), float(v))
    sx, sy = tc['scale']
    tx, ty = tc['translation']
    rot = tc['rotation']
    if abs(rot) > 1e-6:
        c, s = math.cos(rot), math.sin(rot)
        u2 = sx * (u * c - v * s) + sx * (0.5 * s - 0.5 * c + 0.5 - tx)
        v2 = sy * (u * s + v * c) + sy * (-0.5 * s - 0.5 * c + 0.5 - ty)
        return (float(u2), float(v2))
    return (float(sx * (u - tx)), float(sy * (v - ty)))


# A fire's shell is lit from inside as if this much of its own colour were added (the 3DS shader adds the vertex
# shader's alpha times its first colour's alpha; that alpha changes with the view, so half is the middle of it).
FIRE_GLOW = 0.5


def _sample(tex, tc, u, v):
    """RGBA (0..1) of a decoded texture at raw coordinates (u, v), read through its texture coordinate's transform
    and wrap, nearest texel, as the IR keeps rows (bottom up)."""
    u, v = _apply_uv_transform(u, v, tc)
    w, h, px = tex['width'], tex['height'], tex['rgba_flipped']

    def wrap(t, mode):
        if mode == 2:
            return t - math.floor(t)
        if mode == 3:
            t = abs(t) % 2.0
            return 2.0 - t if t > 1.0 else t
        return min(max(t, 0.0), 1.0)
    x = min(int(wrap(u, tc['wrap_u']) * w), w - 1)
    y = min(int(wrap(v, tc['wrap_v']) * h), h - 1)
    o = (y * w + x) * 4
    return tuple(px[o + k] / 255.0 for k in range(4))


def _nearest_on_triangle(p, a, b, c):
    """Barycentric weights (wa, wb, wc) of the point of triangle abc nearest p (Ericson, Real-Time Collision
    Detection, 5.1.5)."""
    sub = lambda x, y: (x[0] - y[0], x[1] - y[1], x[2] - y[2])
    dot = lambda x, y: x[0] * y[0] + x[1] * y[1] + x[2] * y[2]
    ab, ac, ap = sub(b, a), sub(c, a), sub(p, a)
    d1, d2 = dot(ab, ap), dot(ac, ap)
    if d1 <= 0 and d2 <= 0:
        return 1.0, 0.0, 0.0
    bp = sub(p, b)
    d3, d4 = dot(ab, bp), dot(ac, bp)
    if d3 >= 0 and d4 <= d3:
        return 0.0, 1.0, 0.0
    vc = d1 * d4 - d3 * d2
    if vc <= 0 and d1 >= 0 and d3 <= 0:
        t = d1 / (d1 - d3)
        return 1.0 - t, t, 0.0
    cp = sub(p, c)
    d5, d6 = dot(ab, cp), dot(ac, cp)
    if d6 >= 0 and d5 <= d6:
        return 0.0, 0.0, 1.0
    vb = d5 * d2 - d1 * d6
    if vb <= 0 and d2 >= 0 and d6 <= 0:
        t = d2 / (d2 - d6)
        return 1.0 - t, 0.0, t
    va = d3 * d6 - d5 * d4
    if va <= 0 and d4 - d3 >= 0 and d5 - d6 >= 0:
        t = (d4 - d3) / ((d4 - d3) + (d5 - d6))
        return 0.0, 1.0 - t, t
    den = 1.0 / (va + vb + vc)
    wb, wc = vb * den, vc * den
    return 1.0 - wb - wc, wb, wc


def _stencil_fires(gf, gf_mats, tex_dict):
    """The 3DS games' fire (Mega Charizard X and Y, Mega Blaziken, Alolan Marowak, Braixen, Delphox...), which the
    GameCube can't draw as they do: it has no stencil buffer. A flame's core (a FireCore shader) is drawn cut out
    where its two textures' red adds up to more than nothing, and marks the stencil with a number; then a shell
    around it (FireSten), drawn only where the stencil holds that number, colours it: its first colour where the
    flame is faint, its second where it is strong, how strong being the shell's two scrolling noise textures under
    its mask's alpha, plus the mask's red. Drawn as they are, the shell was a sheet of black and white streaks and
    the core flat white.

    Here the shell isn't drawn, and its colour goes on the core's points: each takes the shell's at the point of
    the shell nearest it, with the noise at its average (it scrolls). Returns (the shells' material names, the
    core submeshes' point colours by (mesh index, submesh index))."""
    shells = {}
    for name, m in gf_mats.items():
        st, units = m.get('stencil'), m.get('tex_coords') or []
        if st and st[0] == 2 and m['shader'].lower().startswith('firesten') and len(units) >= 3 \
                and all(u['name'].lower() in tex_dict for u in units[:3]):
            shells.setdefault(st[1], name)
    cores = {name: shells[m['stencil'][1]] for name, m in gf_mats.items()
             if m.get('stencil') and m['stencil'][0] == 1 and m['stencil'][2] == 2 and m['stencil'][1] in shells
             and 'firecore' in m['shader'].lower()}
    if not cores:
        return set(), {}
    triangles = {}
    for mesh in gf['meshes']:
        for sm in mesh['submeshes']:
            if sm['name'] in shells.values() and sm['positions'] and sm['uv0']:
                pos, uv = sm['positions'], sm['uv0']
                triangles.setdefault(sm['name'], []).extend(
                    (pos[a], pos[b], pos[c], uv[a], uv[b], uv[c]) for a, b, c in sm['triangles']
                    if max(a, b, c) < min(len(pos), len(uv)))

    def average_red(tex):
        reds = tex['rgba_flipped'][0::4]
        return sum(reds) / (255.0 * len(reds))

    def shell_colour(shell, u, v):
        m = gf_mats[shell]
        units = m['tex_coords']
        noise = sum(average_red(tex_dict[units[k]['name'].lower()]) for k in (0, 1))
        mask = _sample(tex_dict[units[2]['name'].lower()], units[2], u, v)
        strength = min(1.0, min(1.0, noise * (1.0 - mask[3])) + mask[0])
        faint, strong = (m['constants'][m['constant_of'][k]] for k in (0, 1))
        faint = [min(1.0, faint[k] + FIRE_GLOW * faint[3]) for k in range(3)]
        strong = [min(1.0, strong[k] + FIRE_GLOW * strong[3]) for k in range(3)]
        return tuple(strong[k] * strength + faint[k] * (1.0 - strength) for k in range(3)) + (1.0,)

    colours = {}
    for mi, mesh in enumerate(gf['meshes']):
        for si, sm in enumerate(mesh['submeshes']):
            shell = cores.get(sm['name'])
            tris = triangles.get(shell)
            if not tris:
                continue
            out = []
            for p in sm['positions']:
                best = None
                for a, b, c, ua, ub, uc in tris:
                    wa, wb, wc = _nearest_on_triangle(p, a, b, c)
                    q = [wa * a[k] + wb * b[k] + wc * c[k] for k in range(3)]
                    d = sum((q[k] - p[k]) ** 2 for k in range(3))
                    if best is None or d < best[0]:
                        best = (d, wa * ua[0] + wb * ub[0] + wc * uc[0], wa * ua[1] + wb * ub[1] + wc * uc[1])
                out.append(shell_colour(shell, best[1], best[2]))
            colours[(mi, si)] = out
    return set(cores.values()), colours


def _alpha_image(tex, images, max_size):
    """The texture's red as the alpha of a white image (a flame's core is cut out by its textures' red)."""
    key = tex['name'].lower() + '#red'
    if key not in images:
        px = bytearray(tex['rgba_flipped'])
        px[3::4] = px[0::4]
        px[0::4] = px[1::4] = px[2::4] = b'\xff' * (len(px) // 4)
        images[key] = _make_ir_image(dict(tex, name=tex['name'][:-4] + 'Alpha.tga', rgba_flipped=px),
                                     0x7000 + len(images), max_size)
    return images[key]


def _fire_core_material(gf_mat, tex_dict, images, max_size, hideable):
    """A flame's core (_stencil_fires): unlit, coloured by its points, cut out where its first texture's red plus
    its second's is more than nothing."""
    units = gf_mat['tex_coords']
    layers = []
    for k, unit in enumerate(units[:2]):
        tex = tex_dict.get(unit['name'].lower())
        if not tex:
            continue
        layers.append(IRTextureLayer(
            image=_alpha_image(tex, images, max_size), coord_type=CoordType.UV, uv_index=k,
            rotation=(0.0, 0.0, 0.0), scale=(1.0, 1.0, 1.0), translation=(0.0, 0.0, 0.0),
            wrap_s=PICA_WRAP.get(unit['wrap_u'], WrapMode.REPEAT), wrap_t=PICA_WRAP.get(unit['wrap_v'], WrapMode.REPEAT),
            repeat_s=1, repeat_t=1, interpolation=None,
            color_blend=LayerBlendMode.MULTIPLY if not layers else LayerBlendMode.PASS,
            alpha_blend=LayerBlendMode.MULTIPLY if not layers else LayerBlendMode.ADD,
            blend_factor=1.0, lightmap_channel=LightmapChannel.DIFFUSE, is_bump=False, combiner=None,
        ))
    cut = None if hideable else FragmentBlending(
        effect=OutputBlendEffect.OPAQUE, source_factor=BlendFactor.ONE, dest_factor=BlendFactor.ZERO,
        alpha_test_threshold_0=4, alpha_test_threshold_1=7, alpha_test_op=0, depth_compare=3,
    )
    return IRMaterial(
        diffuse_color=(1.0, 1.0, 1.0, 1.0), ambient_color=(1.0, 1.0, 1.0, 1.0), specular_color=(1.0, 1.0, 1.0, 1.0),
        alpha=1.0, shininess=50.0, color_source=ColorSource.VERTEX, alpha_source=ColorSource.MATERIAL,
        lighting=LightingModel.UNLIT, enable_specular=False, is_translucent=bool(hideable), texture_layers=layers,
        fragment_blending=cut,
    )


def _idle_materials(gf_mats, parsed_motions, slot_actions):
    """The materials as the idle animation's first frame sets them: the 3DS animates some of their constant colours
    (GFMotion section 5), and what a glow shows at rest is what those make it; and their texture coordinates
    (section 3), which pick the face a Pokémon makes at rest from its eye and mouth sheets."""
    idle = slot_actions[0][1][0] if slot_actions and slot_actions[0][1] else None
    motion = parsed_motions.get(idle) or {}
    out = dict(gf_mats)
    for name, channels_of in (motion.get('constants') or {}).items():
        if name not in out or not out[name].get('constants'):
            continue
        m = dict(out[name])
        ks = list(m['constants'])
        for index, channels in channels_of.items():
            if 0 <= index < len(ks):
                ks[index] = tuple(gfmotion.evaluate_track(channels[k], 0, ks[index][k]) for k in range(4))
        m['constants'] = ks
        out[name] = m
    for name, channels_of in (motion.get('uv') or {}).items():
        if name not in out or not out[name].get('tex_coords'):
            continue
        m = dict(out[name])
        units = list(m['tex_coords'])
        for k, tc in enumerate(units):
            channels = channels_of.get(tc.get('unit', k))
            if not channels:
                continue
            at = [gfmotion.evaluate_track(channels[c], 0, rest) for c, rest in
                  enumerate(tc['scale'] + (tc['rotation'],) + tc['translation'])]
            units[k] = dict(tc, scale=(at[0], at[1]), rotation=at[2], translation=(at[3], at[4]))
        m['tex_coords'] = units
        out[name] = m
    return out


def _stage_constant(gf_mat, stage):
    """The constant colour (RGBA, 0..1) a texture combiner stage of the material reads."""
    return gf_mat['constants'][gf_mat['constant_of'][stage]]


def _plain_material(colour=(1.0, 1.0, 1.0, 1.0), blending=None, translucent=False):
    """An untextured, unlit material of one colour."""
    return IRMaterial(
        diffuse_color=tuple(colour[:3]) + (1.0,), ambient_color=(1.0, 1.0, 1.0, 1.0), specular_color=(1.0, 1.0, 1.0, 1.0),
        alpha=colour[3], shininess=50.0, color_source=ColorSource.MATERIAL, alpha_source=ColorSource.MATERIAL,
        lighting=LightingModel.UNLIT, enable_specular=False, is_translucent=translucent, texture_layers=[],
        fragment_blending=blending,
    )


def _drawn_as(effect, source, dest, depth_compare):
    return FragmentBlending(effect=effect, source_factor=source, dest_factor=dest, alpha_test_threshold_0=7,
                            alpha_test_threshold_1=7, alpha_test_op=0, depth_compare=depth_compare)


def _special_material(gf_mat, tex_dict=None, images=None, max_size=256):
    """A material the 3DS draws in a way the usual one can't stand for, or None:

    - Depth only (blended ZERO, ONE: Mega Gengar's mask, a sheet at its feet): writes depth and no colour, so what
      is below the ground stays hidden. The stage's own floor hides that in the game, so nothing is drawn: build
      leaves such parts out, as the game's shadow would still have the sheet's shape (a dark square). Drawn as a
      texture it was a white sheet.
    - Yveltal's markings, Mega Gallade's aura and Zygarde's glows (PDC_pm0769_Y_EffA, EffB and PDC_pm0770_Z_EffB
      shaders, added): glows whose strength is a constant the animations set; at rest it is 0, so nothing is drawn
      (and they are left out). Where EffA is lit at rest (Zygarde 50%'s green hexagonal glow), it tints its mask
      by stage 2's constant colour instead of drawing the raw white mask texture.
    - Primal Kyogre's glowing lines (kyogresp Lay1 Core): meshes inside its body, drawn see-through over it without
      a depth test, but only where its own shell is in front (the stencil). Here: the same colour and see-through,
      with no depth test; the shell's outline isn't kept, so they would show over anything in front of Kyogre too.
    """
    if not gf_mat or not gf_mat.get('constants'):
        return None
    shader = gf_mat['shader'].lower()
    nothing = _plain_material(blending=_drawn_as(OutputBlendEffect.INVISIBLE, BlendFactor.ZERO, BlendFactor.ONE, 7))
    if (gf_mat.get('blend_src'), gf_mat.get('blend_dst')) == (0, 1):
        return nothing
    if 'pm0769_y_effa' in shader:   # alpha: stage 4's constant; tint: stage 2's constant
        a = _stage_constant(gf_mat, 4)[3]
        if a <= 0:
            return nothing
        if tex_dict is None or images is None:
            return None
        units = gf_mat.get('tex_coords') or []
        tc = units[0] if units else None
        tex = tex_dict.get(tc['name'].lower()) if tc else None
        if not tex:
            return None
        key = tex['name'].lower()
        if key not in images:
            images[key] = _make_ir_image(tex, 0x7000 + len(images), max_size)
        tint = _stage_constant(gf_mat, 2)[:3] + (1.0,)
        layer = IRTextureLayer(
            image=images[key], coord_type=CoordType.UV, uv_index=0,
            rotation=(0.0, 0.0, 0.0), scale=(1.0, 1.0, 1.0), translation=(0.0, 0.0, 0.0),
            wrap_s=PICA_WRAP.get(tc['wrap_u'], WrapMode.REPEAT), wrap_t=PICA_WRAP.get(tc['wrap_v'], WrapMode.REPEAT),
            repeat_s=1, repeat_t=1, interpolation=None,
            color_blend=LayerBlendMode.MULTIPLY, alpha_blend=LayerBlendMode.MULTIPLY,
            blend_factor=1.0, lightmap_channel=LightmapChannel.DIFFUSE, is_bump=False, combiner=None,
        )
        fb = FragmentBlending(effect=OutputBlendEffect.ADDITIVE_ALPHA, source_factor=BlendFactor.SRC_ALPHA,
                              dest_factor=BlendFactor.ONE, alpha_test_threshold_0=4, alpha_test_threshold_1=7,
                              alpha_test_op=0, depth_compare=3)
        fb.no_depth_update = True
        mat = IRMaterial(
            diffuse_color=tint, ambient_color=(1.0, 1.0, 1.0, 1.0), specular_color=(1.0, 1.0, 1.0, 1.0),
            alpha=float(a), shininess=50.0, color_source=ColorSource.MATERIAL, alpha_source=ColorSource.MATERIAL,
            lighting=LightingModel.UNLIT, enable_specular=False, is_translucent=True, texture_layers=[layer],
            fragment_blending=fb,
        )
        mat.no_depth_update = True
        return mat
    if 'pm0769_y_effb' in shader or 'pm0770_z_effb' in shader:   # colour and alpha: times stage 0's constant's alpha
        return nothing if _stage_constant(gf_mat, 0)[3] <= 0 else None
    # Victini's V-aura (pm0150_51_neuron2), Tepig's tail flare (pm_pokabu_tail), Kyurem's glow (pm_chonchie_glow)
    # and Xerneas's back aura (pm0768_x_back) fade via stage 4's constant alpha; zebraika_thunder fades via stage 3 RGB.
    if any(k in shader for k in ('pm0150_51_neuron2', 'pm_pokabu_tail', 'pm_chonchie_glow', 'pm0768_x_back')):
        return nothing if _stage_constant(gf_mat, 4)[3] <= 0 else None
    if 'pm_zebraika_thunder' in shader:
        return nothing if max(_stage_constant(gf_mat, 3)[:3]) <= 0 else None
    if 'kyogresp_lay1_core' in shader:
        # stage 1: its colour; 2: toward its pale colour by the vertex shader's alpha (FIRE_GLOW, as for fire);
        # 3: plus a dark one times its alpha; 5: times (stage 2's alpha + white), so twice; alpha: stage 4's
        k1, k2, k3 = (_stage_constant(gf_mat, i) for i in (1, 2, 3))
        twice = 1.0 + _stage_constant(gf_mat, 2)[3]
        colour = [min(1.0, min(1.0, k2[c] * FIRE_GLOW + k1[c] * (1.0 - FIRE_GLOW) + k3[c] * k3[3]) * twice) for c in range(3)]
        mat = _plain_material(tuple(colour) + (_stage_constant(gf_mat, 4)[3],), translucent=True,
                              blending=_drawn_as(OutputBlendEffect.ALPHA_BLEND, BlendFactor.SRC_ALPHA, BlendFactor.INV_SRC_ALPHA, 7))
        mat.no_depth_update = True
        return mat
    return None


def _draws_nothing(gf_mat):
    """The material is one _special_material draws as nothing."""
    special = _special_material(gf_mat)
    return special is not None and special.fragment_blending.effect == OutputBlendEffect.INVISIBLE


def _material_of(gf_mat, tex_dict, images, max_size, hideable=False, fire=False):
    if fire:
        return _fire_core_material(gf_mat, tex_dict, images, max_size, hideable)
    special = _special_material(gf_mat, tex_dict, images, max_size)
    if special is not None:
        return special
    tc, tex = _pick_diffuse_texcoord(gf_mat, tex_dict)
    layers = []
    alpha = 'opaque'
    tex_alpha = 'opaque'
    mat_alpha = 1.0
    diffuse = (1.0, 1.0, 1.0, 1.0)
    ambient = (0.5, 0.5, 0.5, 1.0)
    lighting = LightingModel.LIT

    # Detect emissive / fire / eye-glow materials (common on 3DS: Fire, Flame, Glow, Beam, Inc)
    if gf_mat:
        em = gf_mat.get('emission', (0.0, 0.0, 0.0, 0.0))
        mat_lo = gf_mat['name'].lower()
        # PROTO: 'emission'/'diffuse' were Constant0/Constant2; only added (glowing) parts are unlit
        if gf_mat.get('blend_dst') == 1 or 'fire' in mat_lo or 'flame' in mat_lo:
            lighting = LightingModel.UNLIT

    if tex:
        key = tex['name'].lower()
        if key not in images:
            images[key] = _make_ir_image(tex, 0x7000 + len(images), max_size)
        ir_img = images[key]
        tex_alpha = ALPHA_KIND.get((ir_img.name, ir_img.image_id), 'opaque')
        alpha = tex_alpha
        wrap_s = PICA_WRAP.get(tc['wrap_u'], WrapMode.REPEAT) if tc else WrapMode.REPEAT
        wrap_t = PICA_WRAP.get(tc['wrap_v'], WrapMode.REPEAT) if tc else WrapMode.REPEAT
        # Materials with neither alpha blending nor alpha testing (ALW shaders, e.g. Scraggy's eyes sharing
        # Eye1.tga with its iris, Malamar's BodyAUniran01) draw opaque on 3DS regardless of texture alpha.
        if gf_mat and not gf_mat.get('blend_enabled') and not gf_mat.get('alpha_test'):
            alpha = 'opaque'
        elif alpha == 'opaque' and gf_mat and gf_mat.get('alpha_test'):
            alpha = 'cut'
        layers.append(IRTextureLayer(
            image=ir_img, coord_type=CoordType.UV, uv_index=0,
            rotation=(0.0, 0.0, 0.0), scale=(1.0, 1.0, 1.0), translation=(0.0, 0.0, 0.0),
            wrap_s=wrap_s, wrap_t=wrap_t, repeat_s=1, repeat_t=1, interpolation=None,
            color_blend=LayerBlendMode.MIX,
            alpha_blend=LayerBlendMode.NONE if alpha == 'opaque' else LayerBlendMode.MULTIPLY,
            blend_factor=1.0, lightmap_channel=LightmapChannel.DIFFUSE, is_bump=False, combiner=None,
        ))

    iris_mask = _iris_mask(gf_mat, tex_dict) if layers else None
    fire_mask = _chandela_fire_mask(gf_mat, tex_dict) if (layers and not iris_mask) else None
    mask = iris_mask or fire_mask
    if mask:
        mtc, mtex = mask
        if fire_mask:
            mimg = _alpha_image(mtex, images, max_size)
            alpha = 'blend'
            lighting = LightingModel.UNLIT
        else:
            key = mtex['name'].lower() + '#alpha'
            if key not in images:
                px = bytearray(mtex['rgba_flipped'])
                px[0::4] = px[1::4] = px[2::4] = b'\xff' * (len(px) // 4)
                images[key] = _make_ir_image(dict(mtex, name=mtex['name'][:-4] + 'Alpha.tga', rgba_flipped=px),
                                             0x7000 + len(images), max_size)
            mimg = images[key]
        layers.append(IRTextureLayer(
            image=mimg, coord_type=CoordType.UV, uv_index=1,
            rotation=(0.0, 0.0, 0.0), scale=(1.0, 1.0, 1.0), translation=(0.0, 0.0, 0.0),
            wrap_s=PICA_WRAP.get(mtc['wrap_u'], WrapMode.REPEAT), wrap_t=PICA_WRAP.get(mtc['wrap_v'], WrapMode.REPEAT),
            repeat_s=1, repeat_t=1, interpolation=None, color_blend=LayerBlendMode.PASS,
            alpha_blend=LayerBlendMode.MULTIPLY, blend_factor=1.0, lightmap_channel=LightmapChannel.DIFFUSE,
            is_bump=False, combiner=None,
        ))

    # Translucent shaders with opaque textures whose opacity comes from stage 4's constant alpha
    # (e.g. Avalugg's BodyAIce01 visor over its eyes, Bergmite, Zekrom, Kyurem, Genesect, Diancie).
    if (gf_mat and gf_mat.get('blend_enabled') and (gf_mat.get('blend_src'), gf_mat.get('blend_dst')) == (6, 7)
            and tex_alpha == 'opaque' and not mask and gf_mat.get('constants')):
        c4 = _stage_constant(gf_mat, 4)[3]
        if 0.0 < c4 < 0.99:
            mat_alpha = float(c4)
            alpha = 'blend'
            if layers:
                layers[0].alpha_blend = LayerBlendMode.NONE

    added = bool(gf_mat and gf_mat.get('blend_dst') == 1)
    is_blend = (alpha == 'blend') or (gf_mat and gf_mat.get('blend_enabled') and alpha != 'opaque') or added
    translucent = bool(is_blend or hideable)
    no_zwrite = bool(is_blend and gf_mat and gf_mat.get('blend_enabled') and not gf_mat.get('depth_write'))
    cut = None if translucent or alpha != 'cut' else FragmentBlending(
        effect=OutputBlendEffect.OPAQUE, source_factor=BlendFactor.ONE, dest_factor=BlendFactor.ZERO,
        alpha_test_threshold_0=4, alpha_test_threshold_1=7, alpha_test_op=0, depth_compare=3,
    )
    if added:
        cut = FragmentBlending(effect=OutputBlendEffect.ADDITIVE_ALPHA, source_factor=BlendFactor.SRC_ALPHA,
                               dest_factor=BlendFactor.ONE, alpha_test_threshold_0=4, alpha_test_threshold_1=7,
                               alpha_test_op=0, depth_compare=3)
    if cut is not None:
        cut.no_depth_update = no_zwrite
    mat = IRMaterial(
        diffuse_color=diffuse, ambient_color=ambient, specular_color=(1.0, 1.0, 1.0, 1.0),
        alpha=mat_alpha, shininess=50.0, color_source=ColorSource.MATERIAL, alpha_source=ColorSource.MATERIAL,
        lighting=lighting, enable_specular=False, is_translucent=translucent, texture_layers=layers,
        fragment_blending=cut,
    )
    mat.no_depth_update = no_zwrite
    return mat


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


def _undeform_normals(mesh, bones):
    """Turn a mesh's normals as the add-on's compose turns its points, so the game turns both back alike.

    Compose stores a rigid mesh's points in its bone's space, and a skinned mesh's points undone by the
    matrix each envelope will apply (for a point all on one bone, that bone's world matrix), but writes the
    normals as given. 3DS bones are turned at rest (often 90 degrees), so the game turned those normals
    away from their surfaces and lit fronts as backs. This takes the linear part of compose's own
    un-deformation at each point (_undeform_vertices, or the rigid bone's inverse) and applies it to the
    normals of the corners there."""
    if not mesh.normals or not mesh.faces:
        return
    bw = mesh.bone_weights
    if bw and bw.type == SkinType.WEIGHTED and bw.assignments:
        names = {b.name: i for i, b in enumerate(bones)}
        emap = compose_meshes._build_envelope_map(bw.assignments, names)
        undo = lambda vs: compose_meshes._undeform_vertices(vs, emap, bones, names, mesh.parent_bone_index, None)
        base = undo(mesh.vertices)
        axes = [undo([tuple(p[i] + (1.0 if i == k else 0.0) for i in range(3)) for p in mesh.vertices]) for k in range(3)]
        linear = lambda v: [[axes[k][v][r] - base[v][r] for k in range(3)] for r in range(3)]
    elif bw and bw.type in (SkinType.SINGLE_BONE, SkinType.RIGID) and bones[mesh.parent_bone_index].world_matrix:
        inv = mat4.inv(bones[mesh.parent_bone_index].world_matrix)
        rigid = [[inv[r][k] for k in range(3)] for r in range(3)]
        linear = lambda v: rigid
    else:
        return
    turned, corner = [], 0
    for face in mesh.faces:
        for v in face:
            a, n = linear(v), mesh.normals[corner]
            turned.append(mat4.normalized(tuple(sum(a[r][k] * n[k] for k in range(3)) for r in range(3))))
            corner += 1
    mesh.normals = turned


def _posed(gf_skel, order, bone_fields, motion, frame):
    """Each bone's skinning matrix (posed world @ inverse bind) at a frame of a parsed GFMotion, as the IR's bones
    hold them (metres), by position in `order`."""
    mot_bones = motion.get('bones', {}) if motion else {}
    world, skin = [], []
    for pos, orig in enumerate(order):
        b = gf_skel[orig]
        mb = mot_bones.get(b['name'])
        t, r, sc = b['translation'], b['rotation'], b['scale']
        if mb:
            tr = mb['tracks']
            sc = tuple(gfmotion.evaluate_track(tr[k], frame, sc[k]) for k in range(3))
            if any(tr[3 + k] for k in range(3)):
                if mb['is_axis_angle']:
                    r = gfmotion.axis_angle_to_euler_xyz(*(gfmotion.evaluate_track(tr[3 + k], frame, 0.0) for k in range(3)))
                else:
                    r = tuple(gfmotion.evaluate_track(tr[3 + k], frame, r[k]) for k in range(3))
            t = tuple(gfmotion.evaluate_track(tr[6 + k], frame, t[k]) for k in range(3))
        local = trs_matrix(t, r, sc, UNIT)
        parent = bone_fields[pos]['parent_index']
        w = mat4.mul(world[parent], local) if parent is not None else local
        world.append(w)
        skin.append(mat4.mul(w, bone_fields[pos]['inverse_bind_matrix']))
    return skin


def _portraits(gf, order, meshes, geometry, bone_fields, parsed_motions, slot_actions, hideable):
    """The model's body and face pictures (portrait.render), posed as its idle animation's first frame shows it
    (meshes it hides there, such as closed eyes, are left out). Its face is what its Head bone carries."""
    names = [b['name'] for b in bone_fields]
    index = {nm: i for i, nm in enumerate(names)}
    heads = [i for i, nm in enumerate(names) if nm.lower() == 'head'] or \
            [i for i, nm in enumerate(names) if 'head' in nm.lower() and 'skin' not in nm.lower()]
    head = names[heads[0]] if heads else None
    idle = slot_actions[0][1][0] if slot_actions and slot_actions[0][1] else None
    motion = parsed_motions.get(idle) if idle is not None else None
    skin = _posed(gf['skeleton'], order, bone_fields, motion, 0)
    shown = motion.get('visibility', {}) if motion else {}
    parts = []
    for (mn, mat_name, _fields), m in zip(geometry, meshes):
        if mn in hideable and shown.get(mn) and not shown[mn][0]:
            continue
        bw = m.bone_weights
        if bw.type == SkinType.WEIGHTED:
            weights = [[] for _ in m.vertices]
            for vi, lw in bw.assignments:
                weights[vi] = [(index[bn], w) for bn, w in lw if bn in index]
        else:
            weights = [[(index.get(bw.bone_name, m.parent_bone_index), 1.0)]] * len(m.vertices)
        vertices = []
        for v, lw in zip(m.vertices, weights):
            if not lw:
                vertices.append(tuple(v))
                continue
            p = [0.0, 0.0, 0.0]
            for bi, w in lw:
                q = mat4.apply(skin[bi], v)
                p = [p[k] + w * q[k] for k in range(3)]
            vertices.append(tuple(p))
        normals, corner = [], 0
        for f in m.faces:
            for vi in f:
                n, lw = (m.normals[corner] if m.normals else (0.0, 0.0, 1.0)), weights[vi]
                if lw:
                    q = [0.0, 0.0, 0.0]
                    for bi, w in lw:
                        r = mat4.apply3(skin[bi], n)
                        q = [q[k] + w * r[k] for k in range(3)]
                    n = mat4.normalized(q)
                normals.append(n)
                corner += 1
        mat = m.material
        layer = mat.texture_layers[0] if mat.texture_layers else None
        fb = mat.fragment_blending
        flat = None
        if fb is not None and fb.effect == OutputBlendEffect.INVISIBLE:   # draws nothing (_special_material)
            continue
        elif fb is not None and fb.depth_compare == 7:   # seen through what is in front (_special_material)
            kind, flat = 'through', tuple(int(c * 255) for c in mat.diffuse_color[:3]) + (int(mat.alpha * 255),)
        elif fb is not None and fb.effect == OutputBlendEffect.ADDITIVE_ALPHA:
            kind = 'add'
        elif (layer is not None and layer.alpha_blend != LayerBlendMode.NONE) or mat.alpha < 0.999 or len(mat.texture_layers) > 1:
            kind = 'cut' if fb is not None else 'blend'
        else:
            kind = 'opaque'
        seen = mat.texture_layers[1] if len(mat.texture_layers) > 1 and len(m.uv_layers) > 1 else None
        on_head = [sum(w for bi, w in lw if names[bi] == head) if head else 0.0 for lw in weights]
        parts.append(dict(vertices=vertices, faces=m.faces, normals=normals, uvs=m.uv_layers[0].uvs,
                          image=layer.image if layer else None,
                          wrap=(layer.wrap_s.value, layer.wrap_t.value) if layer else ('REPEAT', 'REPEAT'),
                          kind=kind, lit=mat.lighting == LightingModel.LIT, cull=m.cull_back, head=on_head,
                          eye='eye' in (mat_name or '').lower(),
                          mask=(seen.image, (seen.wrap_s.value, seen.wrap_t.value)) if seen else None,
                          mask_uvs=m.uv_layers[1].uvs if seen else None,
                          mask_adds=bool(seen and seen.alpha_blend == LayerBlendMode.ADD),
                          tint=m.color_layers[0].colors if m.color_layers else None, flat=flat,
                          mat_color=mat.diffuse_color[:3], mat_alpha=mat.alpha))
    return portrait.render(parts, has_head=bool(head))


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


def _face_layers(geometry, gf_mats, tex_dict, battle_blobs):
    """The texture layers the face tables (FACE_TABLES) move, by mesh: [(mesh id, [(layer, offset at a table frame)])].
    A layer is the eye's or mouth's texture (layer 0) or an iris's mask (layer 1: the eye's open part, which moves with
    the eye, so the pupil shows where the eye is open), as _material_of makes them. The model's UVs already read each
    texture where the idle puts it (_idle_materials), so a table frame's place is an offset from there: the HSD texture
    translation T, read at UV - T, is scale * (translation at that frame - translation at rest), as u' = scale * (u - t)."""
    tables = []
    for index in FACE_TABLES:
        blob = battle_blobs[index] if index < len(battle_blobs) else None
        motion = gfmotion.read_gfmotion(blob) if blob else None
        if motion and motion['uv']:
            tables.append(motion['uv'])
    if not tables:
        return []
    out = []
    for mesh_name, mat_name, fields in geometry:
        gf_mat = gf_mats.get(mat_name)
        if not gf_mat or fields.get('color_layers') or _special_material(gf_mat) is not None:
            continue
        tc, tex = _pick_diffuse_texcoord(gf_mat, tex_dict)
        if not tex:
            continue
        units = [tc]
        if _iris_mask(gf_mat, tex_dict):
            units.append(gf_mat['tex_coords'][2])
        layers = []
        for layer, unit in enumerate(units):
            channels = next((t[mat_name][unit['unit']] for t in tables
                             if unit['unit'] in t.get(mat_name, {})), None)
            if not channels:
                continue

            def offset(frame, unit=unit, channels=channels):
                if frame is None:
                    return (0.0, 0.0)
                d = [gfmotion.evaluate_track(channels[3 + k], frame, unit['translation'][k]) - unit['translation'][k]
                     for k in range(2)]
                return tuple(0.0 if abs(v) < 1e-6 else unit['scale'][k] * v for k, v in enumerate(d))
            layers.append((layer, offset))
        if layers:
            out.append((fields['id'], layers))
    return out


def _uv_keys(values):
    """Constant keys for (frame, value) pairs: an expression sheet's cells, not a slide between them. Always two or more
    (HSD writes no track of one key)."""
    if len(values) == 1:
        values = values + [(values[0][0] + 1, values[0][1])]
    return [IRKeyframe(frame=float(f), value=float(v), interpolation=Interpolation.CONSTANT) for f, v in values]


def _face_tracks(faces, keys_of, loop):
    """IRMaterialTracks moving each face layer: keys_of(offset) gives (frame, (u, v)) pairs."""
    tracks = []
    for mesh_id, layers in faces:
        uv = []
        for layer, offset in layers:
            keys = keys_of(offset)
            uv.append(IRTextureUVTrack(texture_index=layer, translation_u=_uv_keys([(f, o[0]) for f, o in keys]),
                                       translation_v=_uv_keys([(f, o[1]) for f, o in keys])))
        tracks.append(IRMaterialTrack(material_mesh_name=mesh_id, texture_uv_tracks=uv, loop=loop))
    return tracks


def _merged(tracks):
    """Material tracks for the same mesh as one (its alpha and its texture slides)."""
    out = {}
    for t in tracks:
        if t.material_mesh_name in out:
            first = out[t.material_mesh_name]
            first.alpha = first.alpha or t.alpha
            first.texture_uv_tracks = first.texture_uv_tracks + t.texture_uv_tracks
        else:
            out[t.material_mesh_name] = copy.copy(t)
    return list(out.values())


def build(model_data, tex_blobs, battle_blobs, name, max_texture=256, log=print, reuse=None, portraits=None):
    """Build a Colosseum .pkx from GFModel bytes, texture pack blobs, and battle motion blobs.

    Returns (pkx_bytes, made_cache) where `made_cache` can be passed as `reuse=` when converting
    the matching shiny variant (3DS shiny Pokémon share 100% of geometry, skeleton, and motions).
    `portraits`, a dict, gets the model's menu pictures drawn from it (portrait.py): 'body' and 'face' PNGs.
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
        gf_mats = _idle_materials(gf_mats, parsed_motions, slot_actions)
        used_indices = reuse['used_indices']
        hideable = reuse['hideable']
        geometry = copy.deepcopy(reuse['geometry'])
        sampled = copy.deepcopy(reuse['sampled'])
        mat_tracks = copy.deepcopy(reuse['mat_tracks'])
        lengths = reuse['lengths']
    else:
        order, orig_to_pos, unique_names, bone_fields = _prepare_skeleton(gf['skeleton'])
        parsed_motions, slot_actions, used_indices = _select_battle_motions(battle_blobs)
        gf_mats = _idle_materials(gf_mats, parsed_motions, slot_actions)
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
        shells, fire = _stencil_fires(gf, gf_mats, tex_dict)
        for mi, mesh in enumerate(gf['meshes']):
            mn = mesh['name']
            if mn in always_hidden:
                continue
            for si, sm in enumerate(mesh['submeshes']):
                # (a part that draws nothing is left out: the game's shadow would still have its shape, as Mega
                # Gengar's mask's square)
                if not sm['triangles'] or not sm['positions'] or sm['name'] in shells or _draws_nothing(gf_mats.get(sm['name'])):
                    continue
                gf_mat = gf_mats.get(sm['name'])
                tc, _ = _pick_diffuse_texcoord(gf_mat, tex_dict)
                mask = _iris_mask(gf_mat, tex_dict) or _chandela_fire_mask(gf_mat, tex_dict)
                glow = fire.get((mi, si))
                if glow:   # a flame's core: its second texture's coordinates, and its colours (no normals: unlit)
                    tc = gf_mat['tex_coords'][0]
                    mask = (gf_mat['tex_coords'][1], None) if len(gf_mat['tex_coords']) > 1 else None
                colours = []
                mask_uvs = []
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
                        if mask:
                            mask_uvs.append(_apply_uv_transform(u, v, mask[0]))
                        if glow:
                            colours.append(glow[vi])
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
                    uv_layers=[IRUVLayer(name='UVMap', uvs=uvs)] + ([IRUVLayer(name='UVMap.1', uvs=mask_uvs)] if mask else []),
                    color_layers=[IRColorLayer(name='color_0', colors=colours)] if glow else [],
                    normals=None if glow else normals,
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
        ir_mat = _material_of(gf_mats.get(mat_name), tex_dict, images, max_texture, mn in hideable,
                              fire=bool(fields.get('color_layers')))
        meshes.append(IRMesh(material=ir_mat, **fields))

    if portraits is not None:
        try:
            portraits['body'], portraits['face'] = _portraits(gf, order, meshes, geometry, bone_fields, parsed_motions, slot_actions, hideable)
        except Exception as error:   # the 3DS's own pictures stay
            log('  portraits: %s' % error)
    for mi, m in enumerate(meshes):
        bones[m.parent_bone_index].mesh_indices.append(mi)
    refine_bone_flags(bones, meshes, logger=StubLogger())
    _xlu_flags(bones, meshes)
    for m in meshes:
        _undeform_normals(m, bones)

    # Blinking: the game keeps a texture animation on until another names that texture, so every body animation holds
    # the face where it rests, and the eye animations (EYE_ACTIONS) move it, from the face tables.
    faces = _face_layers(geometry, gf_mats, tex_dict, battle_blobs)
    animation_sets = []
    for mot_idx in used_indices:
        tracks = sampled.get(mot_idx, [])
        loop = mot_idx in IDLE_SLOTS
        last = lengths[mot_idx] - 1
        held = _face_tracks(faces, lambda offset: [(0, (0.0, 0.0)), (last, (0.0, 0.0))], loop)
        animation_sets.append(IRBoneAnimationSet(
            name='%s_m%02d' % (name, mot_idx),
            tracks=tracks,
            loop=loop,
            material_tracks=_merged(mat_tracks.get(mot_idx, []) + held),
        ))
        log('  m%02d        %3d frames, %d bones animated, %d keys' % (
            mot_idx, lengths[mot_idx], len(tracks),
            sum(len(k) for tr in tracks for ch in (tr.rotation, tr.location, tr.scale) for k in ch),
        ))
    eye_sets = []
    for k, action in enumerate(EYE_ACTIONS if faces else ()):
        last = action[-1][0]
        # Its joints hold still: the root at its rest, keyed over it, as retail eye animations' joints are (the game plays
        # only its texture animation; the launcher's Pokédex takes an animation's length from its joints). No alpha
        # tracks: a mesh it doesn't name keeps what the body's animation gave it.
        root = bone_fields[0]
        hold = lambda rest: [[IRKeyframe(frame=float(f), value=float(v), interpolation=Interpolation.LINEAR)
                              for f in (0, last)] for v in rest]
        still = IRBoneTrack(bone_name=unique_names[0], bone_index=0, rotation=hold(root['rotation']),
                            location=hold(root['position']), scale=hold(root['scale']),
                            rest_local_matrix=root['local_matrix'], rest_rotation=root['rotation'],
                            rest_position=root['position'], rest_scale=root['scale'], end_frame=float(last))
        eye_sets.append(len(animation_sets))
        animation_sets.append(IRBoneAnimationSet(
            name='%s_%s' % (name, ('sleep', 'wake', 'blink')[k]), tracks=[still], loop=False,
            material_tracks=_face_tracks(faces, lambda offset: [(f, offset(at)) for f, at in action], False)))
    if faces:
        log('  eyes: blink, sleep and wake on %d meshes' % len(faces))

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
    header.colo_part_anim_refs = eye_sets or [-1, -1, -1]   # falling asleep, waking, a blink when idle
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


def convert_pair(slot_data, name, shiny_name, max_texture=256, log=print, portraits=None):
    """Convert a Pokémon's normal and shiny 3DS models into two .pkx files, reusing all geometry/anims.
    `portraits`, a dict, gets 'normal' and 'shiny' dicts of their menu pictures (build's)."""
    model_data = slot_data['model_pc'][0]
    battle = slot_data['battle_motions']
    normal = {} if portraits is not None else None
    shiny = {} if portraits is not None else None
    first, made = build(model_data, slot_data['normal_tex_pc'], battle, name, max_texture, log, portraits=normal)
    second, _ = build(model_data, slot_data['shiny_tex_pc'], battle, shiny_name, max_texture, log, reuse=made, portraits=shiny)
    if portraits is not None:
        portraits['normal'], portraits['shiny'] = normal, shiny
    return first, second
