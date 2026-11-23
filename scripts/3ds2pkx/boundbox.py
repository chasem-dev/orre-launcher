"""The add-on's per-frame bound box, the same numbers made about twenty times faster.

A .pkx holds an axis-aligned box for every frame of every animation, around the model as skinned on that frame. The
add-on's compose phase (exporter/phases/compose/compose.py, _compose_bound_box) works them out by skinning every
vertex on every frame with its pure-Python Matrix and Vector stand-ins, which is more than nine tenths of the time a
model takes to convert. This does the same sums in the same order on plain floats instead: every matrix is a joint's
(translate, rotate, scale), so its last row is 0 0 0 1 and it is kept as its 12 other numbers, and the products and
sums leave out only terms that are exactly zero, so the boxes come out as the add-on's, bit for bit. Vertices that
skin the same way are only skinned once.
"""
import math
import struct


def _rotation(angle, axis):
    # math_shim Matrix.Rotation with a unit axis, as rows of three columns and a zero translation
    c, s = math.cos(angle), math.sin(angle)
    x, y, z = axis
    t = 1 - c
    return (t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0.0,
            t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0.0,
            t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0.0)


def _scale(factor, axis):
    # math_shim Matrix.Scale along a unit axis
    m = [0.0] * 12
    for i in range(3):
        for j in range(3):
            m[i * 4 + j] = 1.0 + (factor - 1.0) * axis[i] * axis[j] if i == j else (factor - 1.0) * axis[i] * axis[j]
    return tuple(m)


def _multiply(a, b):
    # a @ b for two matrices whose last row is 0 0 0 1, summed in the shim's order (k = 0..3)
    out = []
    for i in range(0, 12, 4):
        a0, a1, a2, a3 = a[i], a[i + 1], a[i + 2], a[i + 3]
        out.append(0 + a0 * b[0] + a1 * b[4] + a2 * b[8] + a3 * 0)
        out.append(0 + a0 * b[1] + a1 * b[5] + a2 * b[9] + a3 * 0)
        out.append(0 + a0 * b[2] + a1 * b[6] + a2 * b[10] + a3 * 0)
        out.append(0 + a0 * b[3] + a1 * b[7] + a2 * b[11] + a3 * 1.0)
    return out


X, Y, Z = (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)


def _srt(scale, rotation, position):
    # math_shim compile_srt_matrix: Translation @ RotZ @ RotY @ RotX @ ScaleZ @ ScaleY @ ScaleX
    m = (1.0, 0.0, 0.0, position[0], 0.0, 1.0, 0.0, position[1], 0.0, 0.0, 1.0, position[2])
    for step in (_rotation(rotation[2], Z), _rotation(rotation[1], Y), _rotation(rotation[0], X),
                 _scale(scale[2], Z), _scale(scale[1], Y), _scale(scale[0], X)):
        m = _multiply(m, step)
    return m


def _flat(matrix):
    return [float(matrix[r][c]) for r in range(3) for c in range(4)]


def _world(model, anim_set, frame, eval_channel, cache):
    # compose._animated_bone_world_matrices; a joint's matrix is made once for each pose it takes
    tracks = {t.bone_index: t for t in anim_set.tracks}
    world = [None] * len(model.bones)
    for i, bone in enumerate(model.bones):
        track = tracks.get(i)
        if track is not None:
            r = [eval_channel(track.rotation[k], frame, bone.rotation[k]) for k in range(3)]
            p = [eval_channel(track.location[k], frame, bone.position[k]) for k in range(3)]
            s = [eval_channel(track.scale[k], frame, bone.scale[k]) for k in range(3)]
        else:
            r, p, s = bone.rotation, bone.position, bone.scale
        key = (i, *s, *r, *p)
        local = cache.get(key)
        if local is None:
            local = cache[key] = _srt(s, r, p)
        parent = bone.parent_index
        world[i] = _multiply(world[parent], local) if parent is not None and 0 <= parent < i and world[parent] is not None else local
    return world


def _box(samples, world):
    # compose._compute_skinned_aabb
    inf = float('inf')
    x0 = y0 = z0 = inf
    x1 = y1 = z1 = -inf
    for entries in samples:
        if len(entries) == 1:
            b, _w, x, y, z = entries[0]
            m = world[b]
            px = 0 + m[0] * x + m[1] * y + m[2] * z + m[3] * 1.0
            py = 0 + m[4] * x + m[5] * y + m[6] * z + m[7] * 1.0
            pz = 0 + m[8] * x + m[9] * y + m[10] * z + m[11] * 1.0
        else:
            px = py = pz = 0.0
            for b, w, x, y, z in entries:
                m = world[b]
                px += w * (0 + m[0] * x + m[1] * y + m[2] * z + m[3] * 1.0)
                py += w * (0 + m[4] * x + m[5] * y + m[6] * z + m[7] * 1.0)
                pz += w * (0 + m[8] * x + m[9] * y + m[10] * z + m[11] * 1.0)
        if px < x0: x0 = px
        if px > x1: x1 = px
        if py < y0: y0 = py
        if py > y1: y1 = py
        if pz < z0: z0 = pz
        if pz > z1: z1 = pz
    return x0, y0, z0, x1, y1, z1


# convert.build's: the boxes of the model compose last made, as (its IR model, boxes), and boxes to use for the next
# model instead of working them out, as (that model, boxes): a shiny model of the same shape has its normal one's
given = None
last = None


def install(compose):
    """Put this in place of the add-on's compose._compose_bound_box."""
    def compose_bound_box(model, logger):
        from shared.IR.enums import SkinType
        global last
        if not model.meshes:
            return None
        if given and given[0] is model and given[1]:
            per_set = given[1]
            last = (model, per_set)
            return make(per_set)
        skin = compose._build_skin_samples(model, SkinType)
        if not skin:
            return None
        samples = list(dict.fromkeys(tuple((b, w, float(v[0]), float(v[1]), float(v[2])) for b, w, v in entries)
                                     for entries in skin))
        anim_sets = model.bone_animations or []
        per_set = []
        if not anim_sets:
            world = [_flat(m) for m in compose._rest_bone_world_matrices(model)]
            per_set.append([struct.pack('>ffffff', *_box(samples, world))])
        cache = {}
        for anim_set in anim_sets:
            count = max(1, max((int(t.end_frame) for t in anim_set.tracks), default=1) + 1)
            per_set.append([struct.pack('>ffffff', *_box(samples, _world(model, anim_set, f, compose._eval_channel, cache)))
                            for f in range(count)])
        last = (model, per_set)
        logger.info("    Bound box: %d set(s), %d total frames (per-frame skinned, %d samples)",
                    len(per_set), sum(len(f) for f in per_set), len(skin))
        return make(per_set)

    def make(per_set):
        bb = compose.BoundBox(address=None, blender_obj=None)
        bb.anim_set_count = len(per_set)
        bb.first_anim_frame_count = len(per_set[0])
        bb.raw_aabb_data = compose.BoundBox.build_blob(per_set)
        return bb
    compose._compose_bound_box = compose_bound_box
