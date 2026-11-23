"""4x4 matrices as lists of rows, column vectors, as HSD has them: the little convert.py needs, in plain Python."""
import math


def eye():
    return [[1.0 if i == j else 0.0 for j in range(4)] for i in range(4)]


def translation(v):
    m = eye()
    m[0][3], m[1][3], m[2][3] = float(v[0]), float(v[1]), float(v[2])
    return m


def scaling(v):
    m = eye()
    m[0][0], m[1][1], m[2][2] = float(v[0]), float(v[1]), float(v[2])
    return m


def euler(r):
    """Euler XYZ as HSD has it: Rz Ry Rx."""
    cx, sx, cy, sy, cz, sz = math.cos(r[0]), math.sin(r[0]), math.cos(r[1]), math.sin(r[1]), math.cos(r[2]), math.sin(r[2])
    return [[cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz, 0.0],
            [cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz, 0.0],
            [-sy, sx * cy, cx * cy, 0.0],
            [0.0, 0.0, 0.0, 1.0]]


def mul(*ms):
    out = ms[0]
    for b in ms[1:]:
        a = out
        out = [[a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j] + a[i][3] * b[3][j] for j in range(4)] for i in range(4)]
    return out


def det3(m):
    return (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]))


def inv(m):
    """The inverse of an affine matrix (its last row 0 0 0 1)."""
    d = det3(m)
    if abs(d) < 1e-20:
        raise ValueError('a matrix with no inverse')
    a = [[(m[(j + 1) % 3][(i + 1) % 3] * m[(j + 2) % 3][(i + 2) % 3] - m[(j + 1) % 3][(i + 2) % 3] * m[(j + 2) % 3][(i + 1) % 3]) / d
          for j in range(3)] for i in range(3)]
    t = [-(a[i][0] * m[0][3] + a[i][1] * m[1][3] + a[i][2] * m[2][3]) for i in range(3)]
    return [a[0] + [t[0]], a[1] + [t[1]], a[2] + [t[2]], [0.0, 0.0, 0.0, 1.0]]


def column_lengths(m):
    return [math.sqrt(m[0][j] ** 2 + m[1][j] ** 2 + m[2][j] ** 2) for j in range(3)]


def apply(m, v):
    """A point moved by a matrix."""
    return [m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2] + m[i][3] for i in range(3)]


def apply3(m, v):
    """A direction turned by a matrix (no translation)."""
    return [m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2] for i in range(3)]


def normalized(v):
    length = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) ** 0.5
    return tuple(x / length for x in v) if length > 1e-12 else tuple(v)
