"""A Pokémon's menu pictures drawn from its own converted 3D model, as Colosseum's are.

Colosseum's body sprites (poke_body.fsys, 64x64) and faces (poke_face.fsys, 42x42) are renders of its models:
the whole Pokémon turned a little to the side, and a close-up of its head on black. The 3DS games have no such
pictures (their 128x128 menu portraits are small, soft and framed loosely, and a crop of one isn't a face), so
these are drawn here from the same meshes and textures convert.py writes into the .pkx: a small software
renderer (no Blender, GPU or numpy), textured, smooth-shaded and lit from the upper front, drawn at twice the
size and averaged down.

render(parts, head) -> (body PNG, face PNG)
  parts: dicts with 'vertices' (model space), 'faces' (triangles), 'normals' and 'uvs' (one per corner),
         'image' (IRImage, bottom-up RGBA, or None), 'wrap' ((s, t) WrapMode names), 'kind' ('opaque', 'cut',
         'blend' or 'add'), 'lit', 'cull', 'head' (a weight on the head for each vertex, 0..1), 'eye' (an eye's),
         and optionally 'mask' ((IRImage, wrap) whose alpha the part's is multiplied by, read at 'mask_uvs')
"""
import math

import gftexture

BODY, FACE = 128, 128          # the PNGs' sizes (the launcher fits them to the game's 64 and 42)
SUPER = 2                      # drawn at this many times the size, then averaged down
YAW, PITCH = math.radians(28), math.radians(10)    # turned to face the picture's left, seen a little from above
LIGHT = (-0.35, 0.55, 0.76)    # towards the light, in view space: upper left, in front
AMBIENT, DIFFUSE = 0.45, 0.75
MARGIN = 0.05                  # of the body picture, on each side
EYES_SPAN = 2.0                # the face picture is this many times as wide as its eyes span
FACE_FILL = 1.1                # the face picture is this many times the head's width or height


def _norm(v):
    n = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    return (v[0] / n, v[1] / n, v[2] / n) if n > 1e-12 else (0.0, 0.0, 1.0)


LIGHT = _norm(LIGHT)
_CY, _SY, _CP, _SP = math.cos(YAW), math.sin(YAW), math.cos(PITCH), math.sin(PITCH)


def _view(p):
    """Model space (Y up, the Pokémon facing +Z) to view space: X right, Y up, Z towards the viewer."""
    x, y, z = p
    x, z = x * _CY + z * _SY, -x * _SY + z * _CY
    y, z = y * _CP - z * _SP, y * _SP + z * _CP
    return x, y, z


def _wrap(t, mode):
    if mode == 'CLAMP':
        return min(max(t, 0.0), 0.999999)
    if mode == 'MIRROR':
        t = t % 2.0
        return 2.0 - t - 1e-6 if t >= 1.0 else t
    return t % 1.0


def _sampler(image, wrap):
    if image is None:
        return lambda u, v: (255, 255, 255, 255)
    w, h, px = image.width, image.height, image.pixels
    ws, wt = wrap

    def sample(u, v, *_):
        x = int(_wrap(u, ws) * w)
        y = int(_wrap(v, wt) * h)   # bottom-up rows, as the IR keeps them
        o = (y * w + x) * 4
        return px[o], px[o + 1], px[o + 2], px[o + 3]
    return sample


def _masked(sample, mask, adds=False):
    """`sample` with its alpha times `mask`'s, read at a second pair of coordinates: an iris seen only where
    the eye is open, as the 3DS draws it. `adds`: plus `mask`'s instead (a flame's core cut out by two textures)."""
    def both(u, v, mu, mv, *rest):
        r, g, b, a = sample(u, v, *rest)
        m = mask(mu, mv)[3]
        return r, g, b, min(255, a + m) if adds else a * m // 255
    return both


def _tinted(sample):
    """`sample` times a colour (0..1) given after its coordinates: a part coloured by its points."""
    def tinted(*args):
        r, g, b, a = sample(*args[:-3])
        tr, tg, tb = args[-3:]
        return int(r * tr), int(g * tg), int(b * tb), a
    return tinted


def _draw(parts, size, window):
    """RGBA (top-down rows) of the parts seen through `window` ((x0, y0, side) in view space)."""
    x0, y0, side = window
    scale = size / side
    depth = [-1e30] * (size * size)
    color = [None] * (size * size)          # (r, g, b, a) of the nearest solid fragment
    late = []                                # see-through triangles: drawn after, back to front

    for part in parts:
        sample = _sampler(part['image'], part['wrap'])
        if part.get('flat'):
            sample = lambda *_, c=part['flat']: c
        uvs = part['uvs']
        if part.get('mask'):
            sample = _masked(sample, _sampler(*part['mask']), part.get('mask_adds'))
            uvs = [tuple(t) + tuple(m) for t, m in zip(uvs, part['mask_uvs'])]
        if part.get('tint'):
            sample = _tinted(sample)
            uvs = [tuple(t) + tuple(c[:3]) for t, c in zip(uvs, part['tint'])]
        mc = part.get('mat_color')
        ma = part.get('mat_alpha', 1.0)
        if (mc and mc != (1.0, 1.0, 1.0)) or ma < 0.999:
            mr, mg, mb = mc or (1.0, 1.0, 1.0)
            prev = sample
            sample = lambda *args, f=prev, r0=mr, g0=mg, b0=mb, a0=ma: (
                lambda r, g, b, a: (int(r * r0), int(g * g0), int(b * b0), int(a * a0))
            )(*f(*args))
        pts = [_view(v) for v in part['vertices']]
        scr = [((p[0] - x0) * scale, (y0 + side - p[1]) * scale, p[2]) for p in pts]
        nrm = [_view(n) for n in part['normals']]
        corner = 0
        for f in part['faces']:
            a, b, c = f[0], f[1], f[2]
            tri = (scr[a], scr[b], scr[c], nrm[corner:corner + 3], uvs[corner:corner + 3], part, sample)
            corner += len(f)
            if part['kind'] in ('blend', 'add', 'through'):
                late.append(((scr[a][2] + scr[b][2] + scr[c][2]) / 3.0 + (1e9 if part['kind'] == 'through' else 0.0), tri))
            else:
                _raster(tri, size, depth, color, True)
    late.sort(key=lambda t: t[0])
    for _, tri in late:
        _raster(tri, size, depth, color, False)
    out = bytearray(size * size * 4)
    for i, c in enumerate(color):
        if c:
            out[i * 4:i * 4 + 4] = bytes(c)
    return out


def _raster(tri, size, depth, color, solid):
    (ax, ay, az), (bx, by, bz), (cx, cy, cz), ns, uvs, part, sample = tri
    area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if abs(area) < 1e-9:
        return
    # the IR's triangles go anticlockwise seen from the front; screen Y runs down, so the front's area is negative
    if part['cull'] and area > 0:
        return
    minx, maxx = max(int(min(ax, bx, cx)), 0), min(int(max(ax, bx, cx)) + 1, size - 1)
    miny, maxy = max(int(min(ay, by, cy)), 0), min(int(max(ay, by, cy)) + 1, size - 1)
    if minx > maxx or miny > maxy:
        return
    inv = 1.0 / area
    (n0, n1, n2), (t0, t1, t2) = ns, uvs
    lit, kind = part['lit'], part['kind']
    for y in range(miny, maxy + 1):
        py = y + 0.5
        for x in range(minx, maxx + 1):
            px = x + 0.5
            w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * inv
            w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * inv
            w2 = 1.0 - w0 - w1
            if w0 < 0 or w1 < 0 or w2 < 0:
                continue
            z = w0 * az + w1 * bz + w2 * cz
            i = y * size + x
            if kind == 'through':   # seen through what is in front, but only over what is drawn
                if color[i] is None:
                    continue
            elif z <= depth[i]:
                continue
            r, g, b, a = sample(*[w0 * t0[k] + w1 * t1[k] + w2 * t2[k] for k in range(len(t0))])
            if kind == 'cut' and a < 128:
                continue
            if lit:
                nx = w0 * n0[0] + w1 * n1[0] + w2 * n2[0]
                ny = w0 * n0[1] + w1 * n1[1] + w2 * n2[1]
                nz = w0 * n0[2] + w1 * n1[2] + w2 * n2[2]
                ln = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
                s = AMBIENT + DIFFUSE * max(0.0, (nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]) / ln)
                r, g, b = min(255, int(r * s)), min(255, int(g * s)), min(255, int(b * s))
            if solid:
                depth[i] = z
                color[i] = (r, g, b, 255)
                continue
            under = color[i] or (0, 0, 0, 0)
            if kind == 'add':
                k = a / 255.0
                color[i] = (min(255, under[0] + int(r * k)), min(255, under[1] + int(g * k)),
                            min(255, under[2] + int(b * k)), max(under[3], a))
            else:
                k = a / 255.0
                color[i] = (int(under[0] * (1 - k) + r * k), int(under[1] * (1 - k) + g * k),
                            int(under[2] * (1 - k) + b * k), max(under[3], a))


def _down(rgba, size, by, background=None):
    """Average `by` x `by` blocks (colour weighted by alpha); `background` fills what is see-through."""
    out_size = size // by
    out = bytearray(out_size * out_size * 4)
    n = by * by
    for oy in range(out_size):
        for ox in range(out_size):
            r = g = b = a = 0
            for dy in range(by):
                row = ((oy * by + dy) * size + ox * by) * 4
                for dx in range(by):
                    o = row + dx * 4
                    al = rgba[o + 3]
                    r += rgba[o] * al
                    g += rgba[o + 1] * al
                    b += rgba[o + 2] * al
                    a += al
            o = (oy * out_size + ox) * 4
            if background is not None:
                k = a / (255.0 * n)
                bg = background
                out[o:o + 4] = bytes((int((r / a if a else 0) * k + bg[0] * (1 - k)), int((g / a if a else 0) * k + bg[1] * (1 - k)),
                                      int((b / a if a else 0) * k + bg[2] * (1 - k)), 255))
            elif a:
                out[o:o + 4] = bytes((r // a, g // a, b // a, a // n))
    return out


def _box(points):
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    return min(xs), min(ys), max(xs), max(ys)


def _framed_points(parts, near=0.15, much=1.5):
    """The points (view space) the picture is framed on: those of the biggest connected piece of the model, and of
    every piece whose box touches theirs (or comes within `near` of its size), grown until no piece is left that
    does. Pieces left out (Mega Steelix's rocks, floating metres away) are framed on too unless leaving them out
    makes the Pokémon `much` bigger in the picture."""
    pieces = []   # (box, points)
    for part in parts:
        pts = [_view(v) for v in part['vertices']]
        if not pts:
            continue
        root = list(range(len(pts)))

        def find(i):
            while root[i] != i:
                root[i] = root[root[i]]
                i = root[i]
            return i
        for f in part['faces']:
            for a in f[1:]:
                ra, rb = find(f[0]), find(a)
                if ra != rb:
                    root[ra] = rb
        groups = {}
        for i in range(len(pts)):
            groups.setdefault(find(i), []).append(pts[i])
        pieces += [(_box(g), g) for g in groups.values()]
    every = [p for _, g in pieces for p in g]
    if len(pieces) < 2:
        return every
    pieces.sort(key=lambda piece: -len(piece[1]))
    kept, box = [False] * len(pieces), list(pieces[0][0])
    kept[0] = grown = True
    while grown:
        grown = False
        pad = near * max(box[2] - box[0], box[3] - box[1])
        for i, (b, _) in enumerate(pieces):
            if not kept[i] and b[0] <= box[2] + pad and b[2] >= box[0] - pad and b[1] <= box[3] + pad and b[3] >= box[1] - pad:
                kept[i] = grown = True
                box = [min(box[0], b[0]), min(box[1], b[1]), max(box[2], b[2]), max(box[3], b[3])]
    whole = _box(every)
    if max(whole[2] - whole[0], whole[3] - whole[1]) < much * max(box[2] - box[0], box[3] - box[1]):
        return every
    return [p for i, (_, g) in enumerate(pieces) if kept[i] for p in g]


def render(parts, has_head=True):
    """(body PNG, face PNG) of the model's parts (see the module's docstring)."""
    framed = [p for p in parts if p['kind'] != 'add'] or parts
    seen = _framed_points(framed)
    if not seen:
        return None, None
    x0, y0, x1, y1 = _box(seen)
    side = max(x1 - x0, y1 - y0) / (1.0 - 2 * MARGIN)
    body_window = ((x0 + x1 - side) / 2, (y0 + y1 - side) / 2, side)

    eyes = [_view(v) for p in framed if p.get('eye') for v in p['vertices']]
    head = [_view(v) for p in framed for v, w in zip(p['vertices'], p['head']) if w >= 0.5] if has_head else []
    if len(eyes) >= 4:
        # around its eyes (an Eye material, as almost every 3DS model has), a little below them: its head bone may
        # carry antlers, ears or a whole body
        ex0, ey0, ex1, ey1 = _box(eyes)
        fside = max((ex1 - ex0) * EYES_SPAN, (ey1 - ey0) * 3.0, side * 0.12)
        if len(head) >= 8:
            hx0, hy0, hx1, hy1 = _box(head)
            fside = min(fside, max(hx1 - hx0, hy1 - hy0) * FACE_FILL)
        face_window = ((ex0 + ex1 - fside) / 2, (ey0 + ey1) / 2 - fside * 0.6, fside)   # its eyes 40% down, as Colosseum's faces
    elif len(head) >= 8:
        hx0, hy0, hx1, hy1 = _box(head)
        fside = max(hx1 - hx0, hy1 - hy0) * FACE_FILL
        face_window = ((hx0 + hx1 - fside) / 2, (hy0 + hy1 - fside) / 2, fside)
    else:
        # no eyes or head of its own (Klink, Roggenrola...): the middle of the whole Pokémon
        fside = max(x1 - x0, y1 - y0) * 0.7
        face_window = ((x0 + x1 - fside) / 2, (y0 + y1 - fside) / 2, fside)

    body = _down(_draw(parts, BODY * SUPER, body_window), BODY * SUPER, SUPER)
    face = _down(_draw(parts, FACE * SUPER, face_window), FACE * SUPER, SUPER, background=(0, 0, 0))
    return gftexture.encode_png(BODY, BODY, bytes(body)), gftexture.encode_png(FACE, FACE, bytes(face))
