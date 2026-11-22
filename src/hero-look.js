'use strict';

// The Customize page's heroes: each one's models read from the player's disc, with their textures as the HD pack
// has them when it does, sorted into the hero's colour regions (hero-colors.js) so the page can repaint them as
// colours are chosen; and their motions, a Game Boy Advance hero's missing ones played from Wes's
// (hero-retarget.js). The colours chosen are kept in their own file, beside the launcher's settings.

const fs = require('node:fs');
const path = require('node:path');
const { Disc } = require('./disc');
const fsys = require('./fsys');
const hsd = require('./hsd-model');
const colors = require('./hero-colors');
const retarget = require('./hero-retarget');
const heroSnag = require('./hero-snag');
const texturePackLookup = require('./texture-pack-lookup');
const { decodePng } = require('./pokemon-packs');
const { colosseumPkx } = require('./xd-disc');

const PKX_HEADER = 0x40;   // hsd-model.js's
// A pkx's battle motion slots (sequence.c fn_801DD5E8, as hsd-model.js readHeader reads them)
const LOAD_MODE = 5, SLOT_SIZE = 0xd0, SLOT_MOTIONS = 0x8c;
const align32 = n => (n + 31) & ~31;

// The clip each battle motion slot plays first, -1 for an empty slot.
function slotClips(pkx, animationCount) {
  if (pkx.length < PKX_HEADER || pkx.readUInt32BE(0x10) !== LOAD_MODE) return [];
  const count = pkx.readUInt32BE(8), slots = PKX_HEADER + align32(pkx.readUInt32BE(0)) + align32(pkx.readUInt32BE(4));
  if (count > 32 || slots + count * SLOT_SIZE > pkx.length) return [];
  return Array.from({ length: count }, (_, slot) => {
    const at = slots + slot * SLOT_SIZE, n = Math.min(pkx.readUInt32BE(at + 4), 8);
    for (let k = 0; k < n; k++) {
      const type = pkx.readUInt32BE(at + SLOT_MOTIONS + k * 8), index = pkx.readUInt32BE(at + SLOT_MOTIONS + k * 8 + 4);
      if (!type && index < animationCount) return index;
    }
    return -1;
  });
}

// The idle a pkx's header names, else its first clip (for a model with no header).
function idleOf(model) {
  return model.motions.find(motion => motion.kind === 'idle')?.index ?? (model.animations.length ? 0 : -1);
}

// A model's file: a pkx archive's model, or a people model (an archive's entry), given the pkx header hsd-model.js
// reads (with no battle motions). XD's pkx are laid out as Colosseum's for it (xd-disc.js colosseumPkx) unless `raw`.
function readFile(rom, label, { file, entry }, { game = 'colosseum', raw = false } = {}) {
  const disc = new Disc(rom);
  try {
    if (!disc.files.has(file)) throw new Error(`${label}'s model isn't on this disc.`);
    const entries = fsys.entries(disc.file(file)), found = entry === undefined ? entries[0] : entries.find(each => each.id === entry);
    if (!found) throw new Error(`${label}'s model isn't on this disc.`);
    const data = Buffer.from(found.data());
    if (entry === undefined) return game === 'xd' && !raw ? colosseumPkx(data) : data;
    const pkx = Buffer.concat([Buffer.alloc(PKX_HEADER), data]);
    pkx.writeUInt32BE(data.length, 0);
    return pkx;
  } finally { disc.close(); }
}

// Reads one disc's heroes (`game`'s, whose disc it is); each model's file is read once while the reader lasts.
function createReader(rom, game = 'colosseum') {
  const files = new Map(), models = new Map(), matches = new Map();
  const fileOf = (id, kind) => {
    const key = `${id}:${kind}`;
    if (!files.has(key)) {
      const hero = colors.heroIn(id, game);
      if (!hero) throw new Error('There\'s no such hero.');
      files.set(key, readFile(rom, hero.label, hero[kind] || hero.battle, { game }));
    }
    return files.get(key);
  };
  const modelOf = (id, kind) => {
    const key = `${id}:${kind}`;
    if (!models.has(key)) {
      const pkx = fileOf(id, kind), model = hsd.parseModel(pkx);
      models.set(key, { pkx, model, slots: slotClips(pkx, model.animations.length) });
    }
    return models.get(key);
  };

  // A hero's model (`kind` 'stand' or 'battle') as the page draws it: `index` is texture-pack-lookup.js's index of the
  // texture folders, for the HD images (each one found takes its texture's place; one this can't read leaves the
  // disc's).
  function hero(id, kind, index = null) {
    const hero = colors.heroIn(id, game);
    if (!hero) throw new Error('There\'s no such hero.');
    const model = hsd.parseModel(fileOf(id, kind));
    const discs = model.textures.map(({ width, height }) => ({ width, height }));
    let hd = 0;
    for (const texture of model.textures) {
      const found = index && texturePackLookup.findReplacement(index, texture.disc);
      delete texture.disc;
      if (!found) continue;
      try {
        const image = decodePng(fs.readFileSync(found.file));
        Object.assign(texture, { rgba: new Uint8Array(image.rgba.buffer, image.rgba.byteOffset, image.rgba.length), width: image.width, height: image.height });
        hd++;
      } catch (_) { /* the disc's, then */ }
    }
    return { id, kind, label: hero.label, model, hd, ...colors.prepare(id, model.textures, discs) };
  }

  // A model at rest as the game draws it (hero-snag.js withLimbsSet), made once per model
  const drawn = new WeakMap();
  function asDrawn(model) {
    if (!drawn.has(model)) {
      const rest = Float32Array.from(model.joints.flatMap(joint => [...joint.scale, ...joint.rotation, ...joint.translation]));
      const { values } = heroSnag.withLimbsSet(model, heroSnag.rigOfModel(model), { frames: 1, values: rest }, { pins: true });
      drawn.set(model, { ...model, joints: model.joints.map((joint, j) => ({ ...joint, scale: Array.from(values.subarray(j * 9, j * 9 + 3)),
        rotation: Array.from(values.subarray(j * 9 + 3, j * 9 + 6)), translation: Array.from(values.subarray(j * 9 + 6, j * 9 + 9)) })) });
    }
    return drawn.get(model);
  }

  // Wes's motion on another hero's model: his standing idle (from his field model, where the disc has it, else his battle
  // model's stance) or a battle slot's.
  function fromWes(id, kind, motionId, slot) {
    const stands = motionId === 'idle' && colors.heroIn('wes', game).stand;
    const sourceKind = stands ? 'stand' : 'battle', wes = modelOf('wes', sourceKind), own = modelOf(id, kind);
    const index = stands ? colors.heroIn('wes', game).stand.idle : wes.slots[motionId === 'idle' ? 0 : slot] ?? -1;
    if (index < 0) return { clip: null, from: null };
    const key = `${id}:${kind}:${sourceKind}`;
    // Both models matched and moved as the game draws them: their bent limbs' joints (and Wes's pinned pelvis) set to
    // where the game puts them, at rest and in Wes's clip, since a bent limb's own values aren't what's seen
    const source = asDrawn(wes.model), hero = asDrawn(own.model);
    if (!matches.has(key)) matches.set(key, retarget.matchJoints(source, hero));
    const match = matches.get(key), clip = heroSnag.withLimbsSet(wes.model, heroSnag.rigOfModel(wes.model), hsd.parseClip(wes.pkx, index), { pins: true });
    const moved = retarget.retarget(source, clip, hero, match);
    // then the hero's own limb targets put where the moved limbs end, so the game's way of bending them bends them there
    const { values } = heroSnag.withTargets(own.model, heroSnag.rigOfModel(own.model), { ...moved, samples: moved.frames }, j => match.map[j] >= 0);
    return { clip: { ...moved, values }, from: 'wes' };
  }

  // A motion of a hero's, on the model modelFor says: { clip, from }, `from` 'wes' for one moved over from Wes's
  // (every one, with `wesMoves`, else those the hero hasn't); clip null when there's no such motion.
  function clip(id, motionId, { wesMoves = false } = {}) {
    const hero = colors.heroIn(id, game), motion = colors.MOTIONS.find(each => each.id === motionId);
    if (!hero || !motion) throw new Error('There\'s no such motion.');
    const kind = colors.modelFor(id, motionId, game), own = modelOf(id, kind);
    if (wesMoves && id !== 'wes') return fromWes(id, kind, motionId, motion.slot);
    if (motionId === 'idle') {
      const index = kind === 'stand' ? hero.stand.idle : own.slots[0] ?? idleOf(own.model);
      return { clip: index >= 0 ? hsd.parseClip(own.pkx, index) : null, from: null };
    }
    const index = own.slots[motion.slot] ?? -1;
    if (index >= 0) return { clip: hsd.parseClip(own.pkx, index), from: null };
    if (id === 'wes') return { clip: null, from: null };
    return fromWes(id, kind, motionId, motion.slot);
  }

  return { hero, clip };
}

function looksFile(userData) { return path.join(userData, 'hero-looks.json'); }

function readLooks(userData) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(looksFile(userData), 'utf8')); } catch (_) { /* none yet */ }
  return colors.normalizeLooks(saved);
}

// The looks as the page has changed them: saved, and returned as kept.
function saveLooks(userData, looks) {
  const kept = colors.normalizeLooks(looks), file = looksFile(userData), temporary = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify(kept, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
  return kept;
}

module.exports = { createReader, readFile, readLooks, saveLooks, idleOf, slotClips };
