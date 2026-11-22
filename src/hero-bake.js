'use strict';

// Each player's hero in an online battle, as they made them on the Customize page: their hero's battle model with its
// textures repainted in their colours (hero-colors.js recolor, as the page paints them), for the game to load in that
// player's place (the game's host/online.c, its `look` lines).
//
// The repainted textures go back into the model at the disc's size as RGBA8 (GX format 6), which keeps every colour
// as painted; the disc's are CMPR. Where the HD texture pack has the hero's textures, its images are repainted too and
// named after the new textures (texture-pack-lookup.js), in a folder the game reads before the pack. A colour scheme
// is its own textures, so two players with the same hero in other colours each keep theirs.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const colors = require('./hero-colors');
const hsd = require('./hsd-model');
const texturePackLookup = require('./texture-pack-lookup');
const { decodePng } = require('./pokemon-packs');
const { png } = require('./pokedex');
const { colosseumPkx } = require('./xd-disc');

const VERSION = 3;          // of what bake makes: a new one makes every look again (2: the faces' blink frames, and regions sorted by where they're drawn; 3: small textures judged at the disc's size)
const PKX_HEADER = 0x40;
const RGBA8 = 6;
const KEPT = 8;             // looks kept made, the newest
const align32 = n => (n + 31) & ~31;

// The game's numbers for the heroes (host/online.c), in hero-colors.js's ids.
const HERO_NUMBERS = { wes: 0, brendan: 1, may: 2, red: 3, leaf: 4, michael: 5 };

// A look as it may travel between launchers: { hero, colors } with a real hero and only its real regions' colours, or
// null for one that isn't.
function normalizeLook(look) {
  if (!look || typeof look !== 'object' || !colors.hero(look.hero)) return null;
  return { hero: look.hero, colors: colors.normalizeColors(look.hero, look.colors) };
}

const painted = look => Object.keys(look.colors).length > 0;

// RGBA texels as GX RGBA8: 4x4 tiles of 64 bytes, each the tile's alpha-red pairs then its green-blue pairs.
function encodeRgba8(rgba, width, height) {
  const across = Math.ceil(width / 4), down = Math.ceil(height / 4), out = Buffer.alloc(across * down * 64);
  let at = 0;
  for (let ty = 0; ty < down; ty++) for (let tx = 0; tx < across; tx++, at += 64)
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const px = Math.min(tx * 4 + x, width - 1), py = Math.min(ty * 4 + y, height - 1), i = (py * width + px) * 4, k = (y * 4 + x) * 2;
      out[at + k] = rgba[i + 3];
      out[at + k + 1] = rgba[i];
      out[at + 32 + k] = rgba[i + 1];
      out[at + 32 + k + 1] = rgba[i + 2];
    }
  return out;
}

// A model (`dat`, an HSD archive) with each image (an HSD_ImageDesc's offset in its data, and those of others with the
// same texels: { image, also, data, width, height })
// put after its data and pointed at as RGBA8 with no mipmaps. The pointers to them are where the disc's pointed, so the
// relocation table stays as it is.
function rebuildDat(dat, images) {
  const dataSize = dat.readUInt32BE(4), data = Buffer.from(dat.subarray(0x20, 0x20 + dataSize)), chunks = [data];
  let end = dataSize;
  for (const { image, also = [], data: texels, width, height } of images) {
    const at = align32(end);
    chunks.push(Buffer.alloc(at - end), texels);
    end = at + texels.length;
    // every HSD_ImageDesc of the same texels (a texture animation's frames point at the face's) takes the new ones
    for (const desc of [image, ...also]) {
      data.writeUInt32BE(at, desc);
      data.writeUInt16BE(width, desc + 4);
      data.writeUInt16BE(height, desc + 6);
      data.writeUInt32BE(RGBA8, desc + 8);
      data.writeUInt32BE(0, desc + 0x0c);
      data.writeFloatBE(0, desc + 0x10);
      data.writeFloatBE(0, desc + 0x14);
    }
  }
  const header = Buffer.from(dat.subarray(0, 0x20)), rest = dat.subarray(0x20 + dataSize);
  header.writeUInt32BE(0x20 + end + rest.length, 0);
  header.writeUInt32BE(end, 4);
  return Buffer.concat([header, ...chunks, rest]);
}

// Colosseum's pkx (hsd-model.js readHeader): a 0x40-byte header, the model, the particles, the motion slots.
function writePkx(pkx, images) {
  const size = pkx.readUInt32BE(0), model = rebuildDat(pkx.subarray(PKX_HEADER, PKX_HEADER + size), images);
  const top = Buffer.from(pkx.subarray(0, PKX_HEADER));
  top.writeUInt32BE(model.length, 0);
  return Buffer.concat([top, model, Buffer.alloc(align32(model.length) - model.length), pkx.subarray(PKX_HEADER + align32(size))]);
}

// XD's (xd-disc.js colosseumPkx): a 0x84-byte header, the motion slots (0xD0 each, their count at 0x10), the particles
// (their size at 8), each aligned to 32, then the model (its size at 0). Only the model and its size change.
const XD_HEADER = 0x84, SLOT_SIZE = 0xd0;
function xdModelAt(pkx) { return align32(XD_HEADER + pkx.readUInt32BE(0x10) * SLOT_SIZE) + align32(pkx.readUInt32BE(8)); }
function writeXdPkx(pkx, images) {
  const at = xdModelAt(pkx), size = pkx.readUInt32BE(0), model = rebuildDat(pkx.subarray(at, at + size), images);
  const out = Buffer.concat([pkx.subarray(0, at), model, pkx.subarray(at + size)]);
  out.writeUInt32BE(model.length, 0);
  return out;
}

// A look made from its hero's battle model (`pkx`, from the disc): { pkx, hd: [{ name, png }] }. `index` is
// texture-pack-lookup.js's of the folders the game reads HD textures from, or null; `xd`, that the pkx is XD's.
function bake(pkx, look, index = null, { xd = false } = {}) {
  // with the images its texture animations swap in, so the face keeps its colours as the hero blinks
  const heroId = look.hero, model = hsd.parseModel(xd ? colosseumPkx(pkx) : pkx, { animated: true }), textures = model.textures;
  const base = colors.prepare(heroId, textures);
  // One image can be several textures (wrapped two ways): each is painted once
  const images = new Map();
  textures.forEach((texture, i) => { if (texture.disc && !images.has(texture.disc.image)) images.set(texture.disc.image, i); });
  const made = [...images].map(([image, i]) => {
    const { rgba, width, height } = textures[i];
    return { image, also: textures[i].disc.also || [], i, width, height, data: encodeRgba8(colors.recolor(heroId, rgba, base.textures[i], base.refs, look.colors), width, height) };
  });

  // The HD pack's images of the same textures, sorted into regions together as the Customize page does
  const hd = [];
  const found = textures.map(texture => {
    const replacement = index && texturePackLookup.findReplacement(index, texture.disc);
    if (!replacement) return null;
    try {
      const image = decodePng(fs.readFileSync(replacement.file));
      return { rgba: new Uint8Array(image.rgba.buffer, image.rgba.byteOffset, image.rgba.length), width: image.width, height: image.height };
    } catch (_) { return null; }
  });
  if (found.some(Boolean)) {
    const large = found.map((image, i) => image || textures[i]), sorted = colors.prepare(heroId, large, textures);
    for (const { i, data, width, height } of made) {
      if (!found[i]) continue;
      const { rgba, width: w, height: h } = found[i];
      const name = texturePackLookup.textureNames({ data, format: RGBA8, width, height })[0];
      hd.push({ name: `${name}.png`, png: png(w, h, colors.recolor(heroId, rgba, sorted.textures[i], sorted.refs, look.colors)) });
    }
  }
  return { pkx: xd ? writeXdPkx(pkx, made) : writePkx(pkx, made), hd };
}

// The look made in `folder` (the launcher's own): { file, hd }, the model's file and the folder of its HD images (null
// for none). Made once for the same look of the same model with the same HD images, and kept with the newest few.
// `pkx` is the hero's battle model from the disc; `index` as bake's.
function makeLook(folder, look, pkx, index = null, { xd = false } = {}) {
  const images = [];
  if (index) for (const texture of hsd.parseModel(xd ? colosseumPkx(pkx) : pkx, { animated: true }).textures) {
    const found = texturePackLookup.findReplacement(index, texture.disc);
    if (!found) continue;
    try { const { size, mtimeMs } = fs.statSync(found.file); images.push([found.file, size, mtimeMs]); } catch (_) { /* not there after all */ }
  }
  const key = crypto.createHash('sha256').update(JSON.stringify({ VERSION, hero: look.hero, colors: Object.entries(look.colors).sort(), images }))
    .update(pkx).digest('hex').slice(0, 24);
  const at = path.join(folder, key), file = path.join(at, 'hero.pkx'), hd = path.join(at, 'hd');
  if (fs.existsSync(path.join(at, 'made.json'))) {
    const now = new Date();
    try { fs.utimesSync(at, now, now); } catch (_) { /* kept anyway */ }
    return { file, hd: fs.existsSync(hd) ? hd : null };
  }
  const made = bake(pkx, look, index, { xd });
  const temporary = `${at}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.mkdirSync(temporary, { recursive: true });
  fs.writeFileSync(path.join(temporary, 'hero.pkx'), made.pkx);
  if (made.hd.length) {
    fs.mkdirSync(path.join(temporary, 'hd'));
    for (const { name, png: bytes } of made.hd) fs.writeFileSync(path.join(temporary, 'hd', name), bytes);
  }
  fs.writeFileSync(path.join(temporary, 'made.json'), JSON.stringify({ version: VERSION, look, hd: made.hd.length }));
  fs.rmSync(at, { recursive: true, force: true });
  fs.renameSync(temporary, at);
  prune(folder, key);
  return { file, hd: made.hd.length ? hd : null };
}

// Only the newest looks stay made, and nothing half made that's older than any would take.
const ABANDONED = 10 * 60 * 1000;
function prune(folder, keep) {
  let entries;
  try { entries = fs.readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isDirectory()); } catch (_) { return; }
  const dated = entries.map(entry => {
    const at = path.join(folder, entry.name);
    try { return { at, name: entry.name, time: fs.statSync(at).mtimeMs }; } catch (_) { return null; }
  }).filter(Boolean).sort((a, b) => b.time - a.time);
  const made = dated.filter(({ name }) => !name.endsWith('.tmp'));
  for (const [i, { at, name }] of made.entries()) if (name !== keep && i >= KEPT) fs.rmSync(at, { recursive: true, force: true });
  for (const { at, name, time } of dated) if (name.endsWith('.tmp') && Date.now() - time > ABANDONED) fs.rmSync(at, { recursive: true, force: true });
}

// The hero a save plays as: the stamp the game writes in it, or the game's own hero for none, as the game takes a save
// without one. Colosseum's (host/player.c) is at 0x1DFC0 of the save body, 8 bytes into the plain copy (gci-save.js);
// XD's (host/xd/player.c) 0x20 into reserve 1 of the deciphered pack (xd-save.js stampAt, after the randomizer's), and a
// save without one is Michael's. Both stamps name one of Colosseum's five.
const HERO_STAMP = 8 + 0x1dfc0, XD_HERO_STAMP = 0x20, HERO_STAMP_MAGIC = 0x43504852, HERO_STAMP_VERSION = 1, HERO_STAMP_CHECK = 0x4e20c0de;
const HERO_IDS = Object.keys(HERO_NUMBERS);
function stampedHero(plain, { at = HERO_STAMP, none = 'wes' } = {}) {
  if (!plain || at < 0 || plain.length < at + 16 || plain.readUInt32BE(at) !== HERO_STAMP_MAGIC || plain[at + 4] !== HERO_STAMP_VERSION) return none;
  let check = HERO_STAMP_CHECK;
  for (let i = 0; i < 12; i += 4) check = Math.imul(check ^ plain.readUInt32BE(at + i), 0x01000193) >>> 0;
  if (check !== plain.readUInt32BE(at + 12) || plain[at + 5] > 4) return none;
  return HERO_IDS[plain[at + 5]];
}

// The look a player battles online as, from the Customize page's looks: the hero chosen there for online battles when
// this game has them (`available`, its heroes' ids), else their save's hero (`saveHero`), in that hero's colours.
function onlineLook(looks, saveHero = 'wes', available = null) {
  const has = id => colors.hero(id) && (!available || available.includes(id));
  const hero = has(looks?.online) ? looks.online : has(saveHero) ? saveHero : 'wes';
  return normalizeLook({ hero, colors: looks?.colors?.[hero] || {} });
}

// The look lines for a game (host/online.c): one for each side, `made` each side's made look ({ file } or null).
function lookLines(looks, made) {
  return looks.flatMap((look, side) => look ? [`look ${side} ${HERO_NUMBERS[look.hero]}${made[side]?.file ? ` ${made[side].file}` : ''}`] : []);
}

module.exports = { VERSION, HERO_NUMBERS, XD_HERO_STAMP, normalizeLook, painted, encodeRgba8, writePkx, writeXdPkx, bake, makeLook, prune, stampedHero, onlineLook, lookLines };
