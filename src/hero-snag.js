'use strict';

// Pokémon XD's Snag Ball throw for Wes, Brendan, May, Red and Leaf. XD's snag swaps Michael's battle model for a model
// of its own (trainer model 0x42, pkx_rinto_1102), whose slots 6 (the Snag Machine readied) and 7 (the throw) play
// Michael's two snag clips while the snag's camera films them. Played as another hero (host/xd/player.c), that model is
// the hero's battle model, which has no such clips. This makes each hero's battle model file (XD's pkx, as on the
// disc) with Michael's two clips added, moved onto the hero's skeleton, and its slots 6 and 7 playing them on Michael's
// timings, at the hero's own joints. The game reads it in place of the disc's (COLO_HERO_FIELD/<hero>.pkx).
//
// Slot 6 is the Aura Reader's reveal of a Shadow Pokémon too. The same file is the trainer's own model, so it also gets
// Michael's Poké Ball throw in slot 1: XD flies the ball from where his hand lets it go, which a hero's own throw doesn't
// match. The file ends with the hero's height against Michael's, by which the game films the snag model's close-ups.
//
// How a clip is moved over:
//   - Michael's battle model bends its arms and legs itself (inverse kinematics: each limb reaches for a target joint
//     the clip moves), so his clip's own arm and leg joints aren't where the game draws them. His pose is first made as
//     the game makes it (resolveIKJoint1, resolveIKJoint2 and the effector in jobj.c), and his limbs' joints set to it;
//   - then it's moved as hero-field.js moves his field clips (the same matched joints, the hips and feet scaled by leg
//     length, each leg bent to put its ankle where his is);
//   - the heroes' legs are inverse kinematics too: each foot target joint is put where that leg's ankle is, so the game
//     bends the leg as the clip has it, and a joint pinned to another (Wes's pelvis) has that joint follow it;
//   - only the channels the hero's own clips key are keyed: the others stay as the battle sets them.

const hsd = require('./hsd-model');
const retarget = require('./hero-retarget');
const field = require('./hero-field');
const { colosseumPkx } = require('./xd-disc');

// The files' version: made again when it changes (raise it whenever what buildSnagModel makes changes)
const VERSION = 4;
// Michael's snag model, and its slots
const MICHAEL_SNAG = 'pkx_rinto_1102.fsys';
const SNAG_SLOTS = [6, 7];
const SLOT_THROW = 1;
// Michael's battle model, whose Poké Ball throw (slot 1) the heroes play too: the ball flies from where his hand lets
// go of it, wherever the hero's own throw has their hand, so with their own it came out of their chest
const MICHAEL_BATTLE = 'pkx_rinto_1101.fsys';
// The snag's close-up of the ball in Michael's hand: the hand eases there over the readied clip's first frames, and back
// to the hero's own swing as he winds up to throw (frames of the throw's clip)
const CLOSE_UP_IN = 40, CLOSE_UP_OUT = [80, 100];
// Each hero's height against Michael's, by where their eyes are: the game films the snag model's close-ups (the Aura
// Reader's reveal and the Snag Ball's throw, both slot 6 then 7) this much further out for them (host/xd/player.c's
// colo_xd_hero_camera_scale), so the ball hand is brought this much further out too. The file says it at its end.
// May's is a little less than her eyes say (1.3): her arms are short for her height, and reaching that far turns her
// hand away from the Snag Ball's close-up, leaving the ball alone in it.
const CAMERA_SCALE = { wes: 1.38, brendan: 1.3, may: 1.15, red: 1.27, leaf: 1.22 };
const SCALE_MAGIC = 'CHCS';
// XD's pkx: a 0x84-byte header (the slot count at 0x10), the slots, the particles (their size at 8), then the model
// (its size at 0). A slot (ModelSequence's MotionSection, 0xD0 bytes): its motions' count at 4, timings in seconds from
// 0x10, the joints the battle's effects attach to at 0x4C (16, -1 for none; 6 is where a thrown ball is held), then its
// motions at 0x8C (8 of { type, animation }, type 0 unused).
const X_HEAD = 0x84, SLOT = 0xd0, SLOT_JOINTS = 0x4c, SLOT_MOTIONS = 0x8c, MOTIONS = 8, JOINTS = 16, BALL = 6;
// ...but a Poké Ball's throw holds it at 7, a joint pinned to the other palm, Michael's and each hero's own. Michael's
// throw lets go of the pin as he lets go of the ball, and that joint flies on as the ball (its own keys); each hero's
// stays pinned. So the heroes' slots hold their balls at a joint of the file's own, after all of theirs, which each clip
// puts where it holds the ball, sized and turned as Michael's is (withBallJoint)
const THROWN_BALL = 7;
const JOBJ_CHILD = 0x08, JOBJ_NEXT = 0x0c, JOBJ_SCALE = 0x20, JOBJ_SIZE = 0x40;   // and JOBJ_FLAGS (below)
const C_HEAD = 0x40;
const align32 = n => (n + 31) & ~31;

// --- a pkx's parts ----------------------------------------------------------------------------------------------------

function xdLayout(pkx) {
  if (pkx.length < X_HEAD) throw new Error('A battle model file is damaged.');
  const count = pkx.readUInt32BE(0x10), modelAt = align32(X_HEAD + count * SLOT) + align32(pkx.readUInt32BE(8)), size = pkx.readUInt32BE(0);
  if (count > 32 || modelAt + size > pkx.length) throw new Error('A battle model file is damaged.');
  return { count, modelAt, size };
}

// An XD slot's first motion in use: its animation, or -1
function slotClip(pkx, slot) {
  const at = X_HEAD + slot * SLOT;
  for (let k = 0; k < Math.min(pkx.readUInt32BE(at + 4), MOTIONS); k++)
    if (pkx.readUInt32BE(at + SLOT_MOTIONS + k * 8)) return pkx.readUInt32BE(at + SLOT_MOTIONS + k * 8 + 4);
  return -1;
}
const slotJoints = (pkx, slot) => Array.from({ length: JOINTS }, (_, k) => pkx.readInt32BE(X_HEAD + slot * SLOT + SLOT_JOINTS + k * 4));

// A Colosseum-layout pkx's model (.dat), as hero-field.js reads one
const datOf = pkx => field.readDat(pkx.subarray(C_HEAD, C_HEAD + pkx.readUInt32BE(0)));

// --- constraints ------------------------------------------------------------------------------------------------------
// A joint's constraints (RObj, its JObj +0x3C): a reference to another joint (its type at the low bits: 1 its place,
// 3 the way a limb bends) or an inverse kinematics hint (the bone's length and a turn, through a pointer; flag 4 bends
// it the other way). A limb the game bends is a joint flagged JOINT1, its child flagged JOINT2, and its child, the
// effector, which reaches for the joint its place constraint names.
const JOBJ_FLAGS = 0x04, JOBJ_ROBJ = 0x3c, JOINT_MASK = 0x600000, JOINT1 = 0x200000, JOINT2 = 0x400000, EFFECTOR = 0x600000;
const ROBJ_ACTIVE = 0x80000000, ROBJ_KIND = 0x70000000, REF_JOBJ = 0x10000000, REF_HINT = 0x40000000;
const PLACE = 1, POLE = 3;

function rigOf(pkx) {
  const dat = datOf(pkx), { pointer } = field.reader(dat), joints = field.jointOffsets(dat, field.sceneSet(dat));
  const index = new Map(joints.map((at, j) => [at, j]));
  return joints.map(at => {
    const out = { type: dat.data.readUInt32BE(at + JOBJ_FLAGS) & JOINT_MASK, refs: [], hint: null };
    for (let robj = pointer(at + JOBJ_ROBJ); robj; robj = pointer(robj)) {
      const flags = dat.data.readUInt32BE(robj + 4);
      if (!(flags & ROBJ_ACTIVE)) continue;
      if ((flags & ROBJ_KIND) === REF_JOBJ && index.has(pointer(robj + 8))) out.refs.push({ type: flags & 0xfffffff, joint: index.get(pointer(robj + 8)) });
      else if ((flags & ROBJ_KIND) === REF_HINT && !out.hint) {
        const hint = pointer(robj + 8);
        out.hint = { length: hint ? dat.data.readFloatBE(hint) : 0, turn: hint ? dat.data.readFloatBE(hint + 4) : 0, flip: Boolean(flags & 4) };
      }
    }
    return out;
  });
}
// The same, from a model hsd-model.js parsed (its joints' `constraint`: limb 1, 2 or 3 for JOINT1, JOINT2, EFFECTOR)
const rigOfModel = model => model.joints.map(({ constraint }) => ({ type: (constraint?.limb || 0) << 21, refs: constraint?.refs || [], hint: constraint?.hint || null }));
const refsOf = (rig, j, type) => rig[j].refs.filter(ref => ref.type === type).map(ref => ref.joint);

const isUnder = (model, j, ancestor) => { for (let k = model.joints[j].parent; k >= 0; k = model.joints[k].parent) if (k === ancestor) return true; return false; };

// --- poses as the game draws them -------------------------------------------------------------------------------------

const multiply = (a, b) => {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
};
function invertAffine(m) {
  const [a, b, c, , d, e, f, , g, h, i] = m, det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e) || 1;
  const r = [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det, 0, (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det, 0,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det, 0, 0, 0, 0, 1];
  for (let k = 0; k < 3; k++) r[12 + k] = -(r[k] * m[12] + r[4 + k] * m[13] + r[8 + k] * m[14]);
  return r;
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scaled = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => scaled(a, Math.sqrt(1 / (1e-10 + dot(a, a))));
const column = (m, c) => [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];
const placeOf = m => column(m, 3);
const matrix = (x, y, z, place) => [...x, 0, ...y, 0, ...z, 0, ...place, 1];
const local = (values, o) => retarget.jointLocal([values[o], values[o + 1], values[o + 2]], [values[o + 3], values[o + 4], values[o + 5]], [values[o + 6], values[o + 7], values[o + 8]]);
function turnAbout(axis, angle, v) {
  const [x, y, z] = unit(axis), c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [(t * x * x + c) * v[0] + (t * x * y - s * z) * v[1] + (t * x * z + s * y) * v[2],
    (t * x * y + s * z) * v[0] + (t * y * y + c) * v[1] + (t * y * z - s * x) * v[2],
    (t * x * z - s * y) * v[0] + (t * y * z + s * x) * v[1] + (t * z * z + c) * v[2]];
}

// Each joint's matrix in the model's space on one frame, with the limbs bent as the game bends them (jobj.c
// HSD_JObjSetupMatrixSub). A limb reaches for its target as the target is posed by the clip.
function posed(model, rig, values, frame) {
  const count = model.joints.length, plain = new Array(count), out = new Array(count);
  for (let j = 0; j < count; j++) {
    const parent = model.joints[j].parent, mine = local(values, (frame * count + j) * 9);
    plain[j] = parent >= 0 ? multiply(plain[parent], mine) : mine;
  }
  const at = j => (out[j] ? placeOf(out[j]) : placeOf(plain[j]));
  const average = joints => scaled(joints.reduce((sum, j) => add(sum, at(j)), [0, 0, 0]), 1 / joints.length);
  const childOf = (j, type) => model.joints.findIndex((joint, k) => joint.parent === j && rig[k].type === type);
  const scaleOf = j => values.subarray((frame * count + j) * 9, (frame * count + j) * 9 + 3);
  const scales = model.joints.map(() => [1, 1, 1]), hasScale = new Uint8Array(count);
  const worldScale = k => (hasScale[k] ? scales[k] : [1, 1, 1]);
  const target = {};
  for (let j = 0; j < count; j++) {
    const joint = model.joints[j], parent = joint.parent, mine = local(values, (frame * count + j) * 9);
    const parentScale = parent >= 0 && hasScale[parent] ? scales[parent] : null;
    if (joint.classicalScale) {
      hasScale[j] = parentScale ? 1 : 0;
      if (parentScale) scales[j] = [...parentScale];
    } else {
      const s = scaleOf(j);
      hasScale[j] = 1;
      scales[j] = [s[0] * (parentScale ? parentScale[0] : 1), s[1] * (parentScale ? parentScale[1] : 1), s[2] * (parentScale ? parentScale[2] : 1)];
    }
    out[j] = parent >= 0 ? multiply(out[parent], mine) : mine;
    const { type, hint } = rig[j];
    if (type === JOINT1 && hint) {
      const scale = worldScale(j), joint2 = childOf(j, JOINT2), effector = joint2 >= 0 ? childOf(joint2, EFFECTOR) : childOf(j, EFFECTOR);
      if (effector < 0 || !refsOf(rig, effector, PLACE).length) continue;
      const a = hint.length * scale[0], b = joint2 >= 0 && rig[joint2].hint ? rig[joint2].hint.length * scaleOf(joint2)[0] * scale[0] : 0;
      const flip = joint2 >= 0 && rig[joint2].hint ? rig[joint2].hint.flip : false;
      const base = parent >= 0 ? placeOf(out[parent]) : [0, 0, 0];
      target[effector] = average(refsOf(rig, effector, PLACE));
      const toward = sub(target[effector], base), d2 = dot(toward, toward);
      if (d2 <= 1e-8) continue;
      let normal, side;
      const poles = refsOf(rig, j, POLE);
      if (poles.length) {
        side = sub(average(poles), base);
        if (hint.turn) side = turnAbout(toward, hint.turn, side);
        normal = cross(toward, side);
        side = cross(normal, toward);
      } else {
        normal = column(out[j], 2);
        side = cross(normal, toward);
        normal = cross(toward, side);
      }
      normal = unit(normal);
      side = unit(side);
      const a2 = a * a, b2 = b * b, t = a2 - b2;
      const h2 = Math.max(0, 0.25 * (2 * (a2 + b2) - d2 - (t * t) / d2));
      const along = Math.sqrt(Math.max(0, (a2 - h2) / d2)), height = Math.sqrt(h2) * (flip ? -1 : 1);
      const x = unit(add(scaled(toward, b2 - h2 < d2 ? along : -along), scaled(side, height)));
      out[j] = matrix(scaled(x, scale[0]), scaled(cross(normal, x), scale[1]), scaled(normal, scale[2]), base);
    } else if (type === JOINT2 && parent >= 0 && rig[parent].hint) {
      const effector = childOf(j, EFFECTOR);
      if (effector < 0 || !target[effector]) continue;
      const scale = worldScale(j);
      const elbow = add(placeOf(out[parent]), scaled(unit(column(out[parent], 0)), rig[parent].hint.length * worldScale(parent)[0]));
      const x = unit(sub(target[effector], elbow)), y = unit(cross(column(out[parent], 2), x));
      out[j] = matrix(scaled(x, scale[0]), scaled(y, scale[1]), scaled(cross(x, y), scale[2]), elbow);
    } else if (type === EFFECTOR && parent >= 0 && rig[parent].hint) {
      const end = add(placeOf(out[parent]), scaled(unit(column(out[parent], 0)), rig[parent].hint.length * worldScale(parent)[0]));
      out[j] = [...out[j].slice(0, 12), ...end, 1];
    } else if (!type && refsOf(rig, j, PLACE).length) {
      // pinned to another joint's place (HSD_RObjUpdateAll)
      out[j] = [...out[j].slice(0, 12), ...average(refsOf(rig, j, PLACE)), 1];
    }
  }
  return out;
}

// The joint's values (its own scale kept) that put it at `world` under its parent posed as `parentWorld`
function valuesFor(values, o, parentWorld, world) {
  const mine = parentWorld ? multiply(invertAffine(parentWorld), world) : world, scale = values.subarray(o, o + 3), turn = new Array(9);
  for (let c = 0; c < 3; c++) {
    const l = Math.hypot(mine[c * 4], mine[c * 4 + 1], mine[c * 4 + 2]) || 1;
    for (let r = 0; r < 3; r++) turn[c * 3 + r] = mine[c * 4 + r] / l;
  }
  values.set([...scale, ...retarget.eulerOf(turn), mine[12], mine[13], mine[14]], o);
}

// The clip with its bent limbs' joints set to where the game draws them, so the clip says what's seen without them
// (with `pins`, a joint pinned to another's place too, as Wes's pelvis is)
function withLimbsSet(model, rig, clip, { pins = false } = {}) {
  const count = model.joints.length, values = Float32Array.from(clip.values);
  const bent = model.joints.map((_, j) => (rig[j].type !== 0 ? rig[j].type !== JOINT1 || rig[j].hint : pins && refsOf(rig, j, PLACE).length > 0));
  for (let frame = 0; frame < clip.frames; frame++) {
    const world = posed(model, rig, values, frame);
    for (let j = 0; j < count; j++) {
      if (!bent[j]) continue;
      const parent = model.joints[j].parent;
      valuesFor(values, (frame * count + j) * 9, parent >= 0 ? world[parent] : null, world[j]);
    }
  }
  return { ...clip, values };
}

// The hero's foot targets where the clip has each leg's ankle (the end of its lower leg, as the game's effector is),
// and a joint another is pinned to (Wes's pelvis, pinned to a joint his own clips lower) where that other one is, when
// the clip moves the pinned joint: the game then bends the legs, and moves the pinned joint, as the clip has them.
function withTargets(model, rig, clip, moved) {
  const count = model.joints.length, values = Float32Array.from(clip.values);
  const childOf = (j, type) => model.joints.findIndex((joint, k) => joint.parent === j && rig[k].type === type);
  const feet = [], pins = [];
  rig.forEach((joint, j) => {
    for (const target of refsOf(rig, j, PLACE)) {
      if (joint.type === EFFECTOR) feet.push({ effector: j, target });
      else if (!joint.type && moved(j) && !moved(target)) pins.push({ joint: j, target });
    }
  });
  for (let frame = 0; frame < clip.samples; frame++) {
    let world = field.worlds(model, values, frame);
    const put = (j, place) => {
      const parent = model.joints[j].parent, inverse = parent >= 0 ? invertAffine(world[parent]) : null;
      const at = inverse ? [0, 1, 2].map(k => inverse[k] * place[0] + inverse[4 + k] * place[1] + inverse[8 + k] * place[2] + inverse[12 + k]) : place;
      values.set(at, (frame * count + j) * 9 + 6);
      world = field.worlds(model, values, frame);
    };
    for (const { effector, target } of feet) {
      const joint2 = model.joints[effector].parent, hint = joint2 >= 0 && rig[joint2].hint;
      if (!hint || rig[joint2].type !== JOINT2 || childOf(joint2, EFFECTOR) !== effector) continue;
      const scale = values[(frame * count + joint2) * 9];
      put(target, add(placeOf(world[joint2]), scaled(unit(column(world[joint2], 0)), hint.length * scale)));
    }
    for (const { joint, target } of pins) put(target, placeOf(world[joint]));
  }
  return { ...clip, values, feet: feet.map(foot => foot.target), pins: pins.map(pin => pin.target), pinned: pins.map(pin => pin.joint) };
}

// The hero's ball hand (`reach`, a joint of the arm `arm`: collarbone, shoulder, elbow, wrist, hand) brought to where
// Michael's ball is (`goals`, a place on each frame, in the model's space, unscaled) by `weights[frame]` (0 leaves the
// arm as it is): the snag's close-up films the ball in Michael's hand from a place of its own, and a taller hero's hand
// moved as his is, scaled, is out of the shot. The shoulder and the elbow turn (a few passes, each turning its bone to
// point the hand at the goal); the wrist and hand keep their own turn from the forearm.
function withHandAt(model, clip, arm, reach, goals, weights, pointOf = world => placeOf(world[reach])) {
  const count = model.joints.length, values = Float32Array.from(clip.values), turning = [arm[2], arm[1]];
  for (let frame = 0; frame < clip.samples; frame++) {
    const weight = weights(frame);
    if (!(weight > 0)) continue;
    let world = field.worlds(model, values, frame);
    const goal = add(pointOf(world), scaled(sub(goals[frame], pointOf(world)), weight));
    for (let pass = 0; pass < 8; pass++) for (const j of turning) {
      const at = placeOf(world[j]), from = unit(sub(pointOf(world), at)), to = unit(sub(goal, at));
      const axis = cross(from, to), sine = Math.hypot(...axis);
      if (sine < 1e-6) continue;
      const angle = Math.atan2(sine, dot(from, to)), turned = c => turnAbout(axis, angle, column(world[j], c));
      const parent = model.joints[j].parent;
      valuesFor(values, (frame * count + j) * 9, parent >= 0 ? world[parent] : null, matrix(turned(0), turned(1), turned(2), at));
      world = field.worlds(model, values, frame);
    }
  }
  return { ...clip, values };
}

// --- keys -------------------------------------------------------------------------------------------------------------

// The channels the hero's own clips key on each joint (hsd-model.js's order), and their flags and length
const CHANNEL_TYPE = [8, 9, 10, 1, 2, 3, 5, 6, 7];
function keyedChannels(dat, count) {
  const { pointer, list } = field.reader(dat), set = field.sceneSet(dat), keyed = Array.from({ length: count }, () => new Set());
  for (const root of list(pointer(set + 4))) {
    let next = 0;
    const walk = (anim, joint) => {
      for (; anim && joint; anim = pointer(anim + 4), joint = pointer(joint + 0x0c)) {
        const j = next++, aobj = pointer(anim + 8);
        if (aobj && j < count) for (let fobj = pointer(aobj + 8); fobj; fobj = pointer(fobj)) {
          const channel = CHANNEL_TYPE.indexOf(dat.data[fobj + 0x0c]);
          if (channel >= 0) keyed[j].add(channel);
        }
        walk(pointer(anim), pointer(joint + 8));
      }
    };
    walk(root, pointer(set));
  }
  return keyed;
}
function clipTiming(dat, index) {
  const { pointer, list } = field.reader(dat), root = list(pointer(field.sceneSet(dat) + 4))[index];
  let flags = null, end = 0;
  const walk = first => {
    for (let at = first; at; at = pointer(at + 4)) {
      const aobj = pointer(at + 8);
      if (aobj) { if (flags === null) flags = dat.data.readUInt32BE(aobj); end = Math.max(end, dat.data.readFloatBE(aobj + 4)); }
      walk(pointer(at));
    }
  };
  walk(root);
  return { flags: flags ?? 0, end };
}

// The clip with only the channels `keyed` names moving: every other channel stays as at rest, and each joint takes the
// turn and place that put it where the clip has it, under its parent as it then is. A joint keying fewer than three
// angles (a knee) takes the ones that come nearest.
const turnApart = (a, b) => { let t = 0; for (let k = 0; k < 9; k++) t += a[k] * b[k]; return Math.acos(Math.max(-1, Math.min(1, (t - 1) / 2))); };
const turnPart = m => [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
const turnOf = angles => turnPart(retarget.jointLocal([1, 1, 1], angles, [0, 0, 0]));
function fitToKeys(model, clip, keyed, pinned = new Set()) {
  const count = model.joints.length, values = new Float32Array(clip.values.length);
  const rest = model.joints.map(joint => [...joint.scale, ...joint.rotation, ...joint.translation]);
  for (let frame = 0; frame < clip.samples; frame++) {
    const o = frame * count * 9, wanted = [], actual = [];
    for (let j = 0; j < count; j++) {
      const parent = model.joints[j].parent;
      wanted[j] = parent >= 0 ? multiply(wanted[parent], local(clip.values, o + j * 9)) : local(clip.values, o + j * 9);
      const under = parent >= 0 ? multiply(invertAffine(actual[parent]), wanted[j]) : wanted[j];
      const want = turnPart(under).map((x, k) => x / (rest[j][Math.floor(k / 3)] || 1)), out = rest[j].slice();
      const axes = [0, 1, 2].filter(k => keyed[j].has(3 + k));
      if (axes.length === 3) out.splice(3, 3, ...retarget.eulerOf(want));
      else if (axes.length) {
        const start = retarget.eulerOf(want), angles = rest[j].slice(3, 6);
        axes.forEach(k => { angles[k] = start[k]; });
        for (let pass = 0, step = 0.5; pass < 24; pass++, step *= 0.6) for (const k of axes) {
          let best = turnApart(turnOf(angles), want);
          for (const change of [-step, step]) {
            const tried = angles.slice(); tried[k] += change;
            const apart = turnApart(turnOf(tried), want);
            if (apart < best) { best = apart; angles[k] = tried[k]; }
          }
        }
        out.splice(3, 3, ...angles);
      }
      for (let k = 0; k < 3; k++) if (keyed[j].has(6 + k)) out[6 + k] = under[12 + k];
      if (!out.every(Number.isFinite)) out.splice(0, 9, ...rest[j]);
      values.set(out, o + j * 9);
      actual[j] = parent >= 0 ? multiply(actual[parent], local(values, o + j * 9)) : local(values, o + j * 9);
      if (pinned.has(j)) actual[j] = [...actual[j].slice(0, 12), ...placeOf(wanted[j]), 1];
    }
  }
  return { ...clip, values };
}

// --- the file ---------------------------------------------------------------------------------------------------------

// The hand the Snag Ball is held in, on a skeleton (in the T-pose every hero's rests in): the joint furthest out along
// the arm reaching +X, its fingers. The ball is held in the palm before them (palmPoint).
function fingersOf(model) {
  const world = retarget.skeletonOf(model).world;
  let best = 0;
  world.forEach((m, j) => { if (m[12] > world[best][12]) best = j; });
  return best;
}

// Where the hero holds the Snag Ball, as a place on a pose (each joint's matrix): as far from their wrist (`wrist`) as
// Michael's palm, which his ball is pinned to (`mBall`), is from his, in the T-pose both rest in, which is out along the
// hand and below it (the palm's side). Held at their wrist or fingers, the ball was inside their fist.
function palmPoint(michael, michaelRig, mBall, hero, wrist) {
  const palm = refsOf(michaelRig, mBall, PLACE)[0], mWrist = palm >= 0 ? michael.joints[palm].parent : -1;
  if (!(mWrist >= 0) || !(wrist >= 0)) throw new Error('Michael\'s Snag Machine motions aren\'t as expected.');
  const resting = model => field.worlds(model, field.restValues(model), 0);
  const his = resting(michael), mine = invertAffine(resting(hero)[wrist]);
  const apart = sub(placeOf(his[palm]), placeOf(his[mWrist])), offset = [0, 1, 2].map(k => mine[k] * apart[0] + mine[4 + k] * apart[1] + mine[8 + k] * apart[2]);
  return world => { const m = world[wrist]; return [0, 1, 2].map(k => m[k] * offset[0] + m[4 + k] * offset[1] + m[8 + k] * offset[2] + m[12 + k]); };
}

// The `clip` (on the hero's joints) with one more joint after them, the ball's, under the root: where the hero holds it
// (`held`, a place on a pose), sized and turned as Michael's ball (`mBall`) is on his clip (`raw`). The Snag
// Ball starts a tenth of its size, spinning, and grows as it flashes in his hand; held at a joint of the hero's own, it
// was whole, and turned as their hand happens to be, all through. With `flies` (the Poké Ball's throw), from when
// Michael lets go of his (his joint pinned to his palm, whose own keys stay put until then), it's where his flies.
function withBallJoint(hero, clip, held, michael, raw, mBall, { flies = false } = {}) {
  const count = hero.joints.length, wide = count + 1, values = new Float32Array(clip.samples * wide * 9);
  const his = f => field.worlds(michael, raw.values, Math.min(f, raw.frames - 1))[mBall];
  let release = Infinity;
  if (flies) {
    const still = placeOf(his(0));
    release = -1;
    for (let f = 1; f < raw.frames && release < 0; f++) if (Math.hypot(...sub(placeOf(his(f)), still)) > 1e-3) release = f;
    if (release < 0) throw new Error('Michael\'s Poké Ball throw isn\'t as expected.');
  }
  for (let f = 0; f < clip.samples; f++) {
    values.set(clip.values.subarray(f * count * 9, (f + 1) * count * 9), f * wide * 9);
    const world = field.worlds(hero, clip.values, f), m = his(f), place = f < release ? held(world) : placeOf(m);
    const mine = multiply(invertAffine(world[0]), [...m.slice(0, 12), ...place, 1]), scale = [0, 1, 2].map(c => Math.hypot(...column(mine, c)) || 1);
    const turn = [0, 1, 2].flatMap(c => column(mine, c).map(x => x / scale[c]));
    values.set([...scale, ...retarget.eulerOf(turn), mine[12], mine[13], mine[14]], (f * wide + count) * 9);
  }
  const rest = new Float32Array(wide * 9);
  field.restValues(hero).forEach((x, k) => { rest[k] = x; });
  rest.set([1, 1, 1], count * 9);
  field.steadyTurns(values, clip.samples, rest);
  return { ...clip, values, keyed: [...clip.keyed, new Set([0, 1, 2, 3, 4, 5, 6, 7, 8])], carrier: true, release };
}

// A hero's XD battle model file (`heroXd`, from XD's disc) with Michael's Snag Machine clips from his snag model
// (`michaelXd`, pkx_rinto_1102) in its slots 6 and 7, and, given his battle model (`throwXd`, pkx_rinto_1101), his
// Poké Ball throw in its slot 1. `cameraScale` is the hero's height against his (CAMERA_SCALE), which the file ends
// with. Returns the new file.
function buildSnagModel(heroXd, michaelXd, { throwXd = null, cameraScale = 1 } = {}) {
  const heroPkx = colosseumPkx(heroXd), hero = hsd.parseModel(heroPkx), heroLayout = xdLayout(heroXd);
  if (heroLayout.count <= Math.max(SLOT_THROW, ...SNAG_SLOTS)) throw new Error('A battle model file isn\'t as expected.');
  if (!(cameraScale > 0.5 && cameraScale < 2.5)) throw new Error('A hero\'s height isn\'t as expected.');

  const heroRig = rigOf(heroPkx);
  // the channels the hero's own clips key (their idle keys all of them): the snag model's clips key more (below), which
  // its own model, shown only for them, can; the trainer's own model goes back to the hero's idle after the Poké Ball's
  // throw, which would keep any more where the throw left them
  const heroDat = datOf(heroPkx), ownKeys = keyedChannels(heroDat, hero.joints.length);
  const snagKeys = ownKeys.map(channels => new Set(channels));
  const rest = field.restValues(hero);
  // the hand each slot holds the ball in: the hero's own snag slot's joint (Wes's, a joint pinned to his wrist), else its
  // fingers; Michael's, a joint pinned to his palm
  const balls = SNAG_SLOTS.map(slot => (slotClip(heroXd, slot) >= 0 ? slotJoints(heroXd, slot)[BALL] : fingersOf(hero)));
  const reachOf = j => { const pin = !heroRig[j].type && refsOf(heroRig, j, PLACE)[0]; return pin === undefined || pin === false ? j : pin; };
  const limbs = retarget.limbs(retarget.skeletonOf(hero));
  const ease = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  // each clip moved over: Michael's file and slot, the hero's slot it plays in, where the hero holds the ball, how much
  // further out than his the ball hand goes (the close-ups' camera's scale), and how much it's brought there on a frame
  const from = xd => {
    const pkx = colosseumPkx(xd), model = hsd.parseModel(pkx);
    if (xdLayout(xd).count <= Math.max(SLOT_THROW, ...SNAG_SLOTS)) throw new Error('A battle model file isn\'t as expected.');
    return { xd, pkx, model, rig: rigOf(pkx), dat: datOf(pkx), fieldRig: field.rigFor(model, hero) };
  };
  const snag = from(michaelXd), rig = snag.fieldRig;
  const specs = [
    // the Snag Machine readied (and the Aura Reader's reveal): eased there as it's raised
    { source: snag, slot: 6, ball: balls[0], held: BALL, scale: cameraScale, weight: f => ease(f / CLOSE_UP_IN), face: 0, keyed: snagKeys },
    // the Snag Ball's throw: until he winds up to throw
    { source: snag, slot: 7, ball: balls[1], held: BALL, scale: cameraScale, weight: f => 1 - ease((f - CLOSE_UP_OUT[0]) / (CLOSE_UP_OUT[1] - CLOSE_UP_OUT[0])), face: SLOT_THROW, keyed: snagKeys },
  ];
  // the Poké Ball's throw, filmed from afar about the trainer's own model: all through, the ball in the hand the hero's
  // own throw holds it in (its slot's joint pinned to that palm), which is the hand Michael throws with
  if (throwXd) specs.push({ source: from(throwXd), slot: SLOT_THROW, ball: slotJoints(heroXd, SLOT_THROW)[THROWN_BALL], held: THROWN_BALL, scale: 1, weight: () => 1, face: SLOT_THROW, keyed: ownKeys, own: true });
  for (const spec of specs) if (slotClip(spec.source.xd, spec.slot) < 0 || !(spec.ball >= 0 && spec.ball < hero.joints.length)) throw new Error('Michael\'s Snag Machine motions aren\'t on this disc.');
  const clips = specs.map(({ source: { xd, pkx, model: michael, rig: michaelRig, dat: michaelDat, fieldRig }, slot, ball, held, scale, weight, keyed, own }) => {
    const index = slotClip(xd, slot), timing = clipTiming(michaelDat, index), raw = hsd.parseClip(pkx, index);
    const source = withLimbsSet(michael, michaelRig, raw);
    let moved = field.fieldClip(michael, hero, fieldRig, source);
    // the ball hand where Michael's ball is (scaled as the camera is), the Snag Ball held in its palm, the Poké Ball where
    // the hero's own throw holds it
    const reach = reachOf(ball), mBall = slotJoints(xd, slot)[held];
    if (!(mBall >= 0 && mBall < michael.joints.length)) throw new Error('Michael\'s Snag Machine motions aren\'t on this disc.');
    const pointOf = own ? world => placeOf(world[reach]) : palmPoint(michael, michaelRig, mBall, hero, hero.joints[reach].parent);
    const arm = limbs.arms.find(chain => chain.length >= 4 && (chain.includes(reach) || isUnder(hero, reach, chain[3])));
    if (arm) {
      const goals = Array.from({ length: moved.samples }, (_, f) => scaled(placeOf(posed(michael, michaelRig, source.values, Math.min(f, source.frames - 1))[mBall]), scale));
      moved = withHandAt(hero, moved, arm, reach, goals, weight, pointOf);
    }
    const targeted = withTargets(hero, heroRig, moved, j => fieldRig.match.map[j] >= 0);
    // the snag model's: the foot targets and pinned-to joints move whether the hero's own clips move them or not, and the
    // hips turn and move (Wes's own clips leave his hips joint, which sits on the ground, to the pin)
    if (!own) {
      for (const j of [...targeted.feet, ...targeted.pins]) for (let k = 6; k < 9; k++) keyed[j].add(k);
      for (let k = 3; k < 9; k++) keyed[fieldRig.hips].add(k);
    }
    const fitted = fitToKeys(hero, targeted, keyed, new Set(targeted.pinned));
    field.steadyTurns(fitted.values, fitted.samples, rest);
    return { ...withBallJoint(hero, { ...fitted, keyed }, pointOf, michael, raw, mBall, { flies: slot === SLOT_THROW }), ...timing };
  });

  // the model: the hero's own, its animation lists longer by the clips (each one's face as the hero's idle or throw has it)
  const dat = heroDat, { pointer, list } = field.reader(dat), set = field.sceneSet(dat);
  const animList = pointer(set + 4), materialList = pointer(set + 8), anims = list(animList), materials = materialList ? list(materialList) : [];
  if (anims.length !== hero.animations.length) throw new Error('A battle model file isn\'t as expected.');
  const added = new field.Added(align32(dat.data.length)), lead = added.base - dat.data.length;
  // a rotation to within a twentieth of a degree, a position to within a ten-thousandth of the hero's height
  const tolerances = [1e-4, Math.PI / 3600, rig.height * 1e-4];
  // the ball's joint, the root's last child (after every joint the hero has, so none is numbered again)
  const carrier = clips.some(clip => clip.carrier) ? added.alloc(JOBJ_SIZE) : null, root = pointer(set);
  let last = pointer(root + JOBJ_CHILD);
  while (last && pointer(last + JOBJ_NEXT)) last = pointer(last + JOBJ_NEXT);
  if (carrier && (!last || pointer(root + JOBJ_NEXT))) throw new Error('A battle model file isn\'t as expected.');
  const roots = clips.map(clip => field.addClip(added, dat, set, clip, clip, clip.keyed, tolerances, clip.carrier ? last : 0));
  if (carrier) {
    const joints = field.jointOffsets(dat, set);
    carrier.buffer.writeUInt32BE(dat.data.readUInt32BE(joints[slotJoints(heroXd, SLOT_THROW)[THROWN_BALL]] + JOBJ_FLAGS) & ~JOINT_MASK, JOBJ_FLAGS);
    for (let k = 0; k < 3; k++) carrier.buffer.writeFloatBE(1, JOBJ_SCALE + k * 4);
    dat.data.writeUInt32BE(carrier.at, last + JOBJ_NEXT);
    dat.pointers.push(last + JOBJ_NEXT);
  }
  const newAnims = added.alloc((anims.length + roots.length + 1) * 4);
  [...anims, ...roots].forEach((at, i) => added.pointer(newAnims, i * 4, at));
  let newMaterials = null;
  if (materials.length === anims.length) {
    const faces = specs.map(spec => materials[Math.max(0, slotClip(heroXd, spec.face))]);
    newMaterials = added.alloc((materials.length + roots.length + 1) * 4);
    [...materials, ...faces].forEach((at, i) => added.pointer(newMaterials, i * 4, at));
  }
  for (const at of dat.pointers) {
    const target = dat.data.readUInt32BE(at);
    if (target === animList) dat.data.writeUInt32BE(newAnims.at, at);
    else if (newMaterials && target === materialList) dat.data.writeUInt32BE(newMaterials.at, at);
  }
  const model = field.writeDat(dat, Buffer.concat([Buffer.alloc(lead), added.bytes()]), added.pointers.map(at => at + lead));

  // the slots: Michael's (his timings), at the hero's own joints: its own snag slot's when it has one (Wes), else its
  // throw's, with the ball at the ball's joint, and where its own have none, the hero's joints matched to Michael's
  const out = Buffer.from(heroXd.subarray(0, heroLayout.modelAt));
  specs.forEach(({ source: { xd, fieldRig }, slot, held }, i) => {
    const heroOf = new Map();
    fieldRig.match.map.forEach((m, j) => { if (m >= 0) heroOf.set(m, j); });
    const at = X_HEAD + slot * SLOT, own = slotClip(heroXd, slot) >= 0;
    const joints = slotJoints(heroXd, own ? slot : SLOT_THROW), his = slotJoints(xd, slot);
    joints[held] = hero.joints.length;
    for (let k = 0; k < JOINTS; k++) if (joints[k] < 0 && his[k] >= 0 && heroOf.has(his[k])) joints[k] = heroOf.get(his[k]);
    xd.copy(out, at, X_HEAD + slot * SLOT, X_HEAD + (slot + 1) * SLOT);
    joints.forEach((j, k) => out.writeInt32BE(j, at + SLOT_JOINTS + k * 4));
    out.fill(0, at + SLOT_MOTIONS, at + SLOT_MOTIONS + MOTIONS * 8);
    out.writeUInt32BE(1, at + 4);
    out.writeUInt32BE(1, at + SLOT_MOTIONS);
    out.writeUInt32BE(anims.length + i, at + SLOT_MOTIONS + 4);
  });
  out.writeUInt32BE(model.length, 0);
  // the hero's height against Michael's: 'CHCS', the scale, 8 bytes of 0 (the game doesn't load them)
  const scale = Buffer.alloc(16);
  scale.write(SCALE_MAGIC, 0, 'latin1');
  scale.writeFloatBE(cameraScale, 4);
  return Buffer.concat([out, model, heroXd.subarray(heroLayout.modelAt + heroLayout.size), scale]);
}

module.exports = {
  VERSION, MICHAEL_SNAG, MICHAEL_BATTLE, CAMERA_SCALE, SNAG_SLOTS, buildSnagModel, rigOfModel, withLimbsSet, withTargets,
  // for the tests
  rigOf, posed, fitToKeys, keyedChannels, clipTiming, datOf, slotClip, slotJoints, fingersOf, palmPoint, xdLayout,
};
