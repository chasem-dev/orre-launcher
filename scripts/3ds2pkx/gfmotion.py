"""Game Freak 3DS GFMotion (0x00060000) parser: skeletal, material, and visibility animations."""
import math
import struct


def _read_len_str(data, pos):
    n = data[pos]
    return data[pos + 1:pos + 1 + n].decode('ascii', errors='replace'), pos + 1 + n


def _decode_keyframe_list(data, pos, mode, frames_count):
    """Decode one GFMotKeyFrame list (SPICA GFMotKeyFrame.SetList).

    Returns (keyframes, new_pos) where keyframes is a list of (frame, value, slope).
    mode:
      0 -> absent
      3 -> constant float
      4 -> quantized (u8 frame if frames_count<=255 else u16, u16 val, u16 slope? Wait: SPICA mode 4=u8/f32, 5=u16, 6=float, 7=Hermite)
    """
    if mode <= 2:
        return [], pos
    if mode == 3:
        val = struct.unpack_from('<f', data, pos)[0]
        return [(0, val, 0.0)], pos + 4

    # Modes 4, 5, 6, 7: keyframe count (u32) + frame indices + values/slopes!
    # Wait: in SPICA GFMotKeyFrame.cs:
    #   key_count = u32
    #   frames: if frames_count > 0xFF -> key_count * u16, else key_count * u8
    #   then align to 4 bytes!
    #   Mode 4: float value_scale, float value_offset, float slope_scale, float slope_offset,
    #           then key_count * (u16 qval, u16 qslope)? Wait: Mode 4 = u16 quantized (or u8?), Mode 5 = u16, Mode 6 = float?
    #   Let's check SPICA's exact GFMotKeyFrame.cs switch!
    #   In SPICA:
    #     case 3: constant float (4B)
    #     case 4: u32 count, frames (u8/u16), align 4, float val_scale, float val_offset,
    #             then count * u16 (quantized value, slope=0, linear? Wait: no, u16 val + u16 slope? No: case 4 is u16 val, case 5 is u16 val+slope!)
    #   WAIT: let's verify exact cases 4, 5, 6, 7 against real Snivy Motion[0] bytes right after writing this file!
    key_cnt = struct.unpack_from('<I', data, pos)[0]
    pos += 4
    if frames_count > 0xFF:
        kf_frames = struct.unpack_from('<%dH' % key_cnt, data, pos)
        pos += key_cnt * 2
    else:
        kf_frames = list(data[pos:pos + key_cnt])
        pos += key_cnt
    # Align to 4 bytes
    pos = (pos + 3) & ~3

    kfs = []
    if mode == 4:
        # Quantized u16 values AND slopes (Hermite)
        v_scale, v_off, s_scale, s_off = struct.unpack_from('<4f', data, pos)
        pos += 16
        for f in kf_frames:
            qv, qs = struct.unpack_from('<HH', data, pos)
            pos += 4
            kfs.append((f, (qv / 65535.0) * v_scale + v_off, (qs / 65535.0) * s_scale + s_off))
    elif mode == 5:
        # Raw float values AND slopes (Hermite)
        for f in kf_frames:
            v, s = struct.unpack_from('<ff', data, pos)
            pos += 8
            kfs.append((f, v, s))
    elif mode == 6:
        # Quantized u16 values only (linear)
        v_scale, v_off = struct.unpack_from('<ff', data, pos)
        pos += 8
        for f in kf_frames:
            qv = struct.unpack_from('<H', data, pos)[0]
            pos += 2
            kfs.append((f, (qv / 65535.0) * v_scale + v_off, 0.0))
        pos = (pos + 3) & ~3
    elif mode == 7:
        # Raw float values only (linear)
        for f in kf_frames:
            v = struct.unpack_from('<f', data, pos)[0]
            pos += 4
            kfs.append((f, v, 0.0))
    return kfs, pos


def evaluate_track(kfs, frame, default_val):
    """Evaluate a GFMotion keyframe list at integer/float `frame`."""
    if not kfs:
        return default_val
    if len(kfs) == 1 or frame <= kfs[0][0]:
        return kfs[0][1]
    if frame >= kfs[-1][0]:
        return kfs[-1][1]
    for i in range(len(kfs) - 1):
        f0, v0, s0 = kfs[i]
        f1, v1, s1 = kfs[i + 1]
        if f0 <= frame <= f1:
            dt = f1 - f0
            if dt <= 0:
                return v0
            t = (frame - f0) / dt
            if s0 == 0.0 and s1 == 0.0:
                return v0 + (v1 - v0) * t
            t2 = t * t
            t3 = t2 * t
            return ((2 * t3 - 3 * t2 + 1) * v0 +
                    (t3 - 2 * t2 + t) * (s0 * dt) +
                    (-2 * t3 + 3 * t2) * v1 +
                    (t3 - t2) * (s1 * dt))
    return kfs[-1][1]


def axis_angle_to_euler_xyz(rx, ry, rz):
    """Convert Gen 7 GFMotion Axis-Angle (encoded as axis * (angle / 2)!) to Euler XYZ (Rz * Ry * Rx).

    In SPICA's GFMotBoneTransform: when IsAxisAngle is set, (rx, ry, rz) stores axis * (angle / 2),
    so angle = 2 * |(rx, ry, rz)| and quaternion = (sin(angle/2) * unit_axis, cos(angle/2)).
    """
    half_angle = math.sqrt(rx * rx + ry * ry + rz * rz)
    if half_angle < 1e-8:
        return (0.0, 0.0, 0.0)
    s = math.sin(half_angle) / half_angle
    qx, qy, qz, qw = rx * s, ry * s, rz * s, math.cos(half_angle)
    # Quaternion to rotation matrix (column-major / standard right-handed)
    xx, yy, zz = qx * qx, qy * qy, qz * qz
    xy, xz, yz = qx * qy, qx * qz, qy * qz
    wx, wy, wz = qw * qx, qw * qy, qw * qz
    r00 = 1.0 - 2.0 * (yy + zz)
    r10 = 2.0 * (xy + wz)
    r20 = 2.0 * (xz - wy)
    r21 = 2.0 * (yz + wx)
    r22 = 1.0 - 2.0 * (xx + yy)
    r12 = 2.0 * (yz - wx)
    r11 = 1.0 - 2.0 * (xx + zz)
    sy = -r20
    if abs(sy) < 0.999999:
        return (math.atan2(r21, r22), math.asin(max(-1.0, min(1.0, sy))), math.atan2(r10, r00))
    return (math.atan2(-r12, r11), math.copysign(math.pi / 2.0, sy), 0.0)


def read_gfmotion(data):
    """Parse a GFMotion (0x00060000) binary."""
    if not data or len(data) < 0x10 or struct.unpack_from('<I', data, 0)[0] != 0x00060000:
        return None
    sec_cnt = struct.unpack_from('<I', data, 4)[0]
    if 8 + sec_cnt * 12 > len(data):
        return None
    secs = [struct.unpack_from('<III', data, 8 + i * 12) for i in range(sec_cnt)]

    frames_count = 0
    is_loop = False
    bones = {}       # bone_name -> {'is_axis_angle': bool, 'tracks': [9 keyframe lists]}
    visibility = {}  # mesh_name -> list[bool] per frame

    # Pass 1: Section 0 metadata (needed for frames_count)
    for sid, slen, saddr in secs:
        if sid == 0 and saddr + 8 <= len(data):
            frames_count, flags = struct.unpack_from('<II', data, saddr)
            is_loop = bool(flags & 1)

    if frames_count <= 0:
        return None

    # Pass 2: Section 1 (Skeletal) & Section 6 (Visibility)
    for sid, slen, saddr in secs:
        if sid == 1 and saddr + 8 <= len(data):
            bone_cnt, names_len = struct.unpack_from('<II', data, saddr)
            np = saddr + 8
            bone_names = []
            for _ in range(bone_cnt):
                bn, np = _read_len_str(data, np)
                bone_names.append(bn)
            bp = saddr + 8 + names_len
            for bn in bone_names:
                if bp + 8 > len(data):
                    break
                flags, bdata_len = struct.unpack_from('<II', data, bp)
                bp += 8
                end_b = bp + bdata_len
                is_axis_angle = not bool(flags & 0x80000000)
                tracks = []
                tp = bp
                for ch in range(9):
                    mode = (flags >> (ch * 3)) & 7
                    kfs, tp = _decode_keyframe_list(data, tp, mode, frames_count)
                    tracks.append(kfs)
                bones[bn] = {'is_axis_angle': is_axis_angle, 'tracks': tracks}
                bp = end_b
        elif sid == 6 and saddr + 8 <= len(data):
            mesh_cnt, names_len = struct.unpack_from('<II', data, saddr)
            np = saddr + 8
            mesh_names = []
            for _ in range(mesh_cnt):
                mn, np = _read_len_str(data, np)
                mesh_names.append(mn)
            vp = saddr + 8 + names_len
            for mn in mesh_names:
                vis = []
                bit = 0
                cur_byte = 0
                for _ in range(frames_count + 1):
                    if bit == 0:
                        if vp >= len(data):
                            break
                        cur_byte = data[vp]
                        vp += 1
                    vis.append(bool(cur_byte & (1 << bit)))
                    bit = (bit + 1) & 7
                visibility[mn] = vis

    return {
        'frames': frames_count,
        'loop': is_loop,
        'bones': bones,
        'visibility': visibility,
    }
