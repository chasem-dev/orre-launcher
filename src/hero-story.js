'use strict';

// The story in the heroes' Customize colours. Every model the story shows of a hero (the field, battle and menus, the
// HD models, XD's field and snag models the launcher makes from the battle model) draws that hero's textures from the
// disc, so this repaints each of those textures (hero-colors.js recolor, as the Customize page does) and writes it as a
// texture pack image under the texture's own name (texture-pack-lookup.js textureNames), in a folder put first in the
// game's texture packs: the game then draws it in place of the disc's wherever the hero is, with no change to the game.
// With the HD pack, a texture it has is repainted at its size from its image. Online battles don't use the folder: each
// player is drawn in their own colours there (hero-bake.js).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Disc } = require('./disc');
const fsys = require('./fsys');
const hsd = require('./hsd-model');
const colors = require('./hero-colors');
const texturePackLookup = require('./texture-pack-lookup');
const { decodePng } = require('./pokemon-packs');
const { png } = require('./pokedex');
const { colosseumPkx } = require('./xd-disc');

// The folders' version: made again when it changes (raise it whenever what's made changes)
const VERSION = 3;  // 2: the faces' blink frames, and regions sorted by where they're drawn; 3: small textures judged at the disc's size
const KEPT = 4;
const PKX_HEADER = 0x40;

// The models of each hero the story shows, by game: a pkx archive (`file`), or an entry of an archive (`entry`, a bare
// .dat). Colosseum's field models are their own (Wes's ken_b1, the others' agb_*_b1 and akami_*_b1, which the game opens
// in their place); its HD models and XD's made models (field, snag) are the battle model's textures. XD's Michael: his
// three costumes' battle models, the snag's and the Aura Reader's, and his field models (people_archive's rinto entries).
const PEOPLE = 'people_archive.fsys';
const STORY_MODELS = {
  colosseum: {
    wes: [{ file: 'pkx_ken_a1.fsys' }, { file: 'field_common.fsys', entry: 0x00f70400 }],
    brendan: [{ file: 'pkx_agb_m_a1.fsys' }, { file: PEOPLE, entry: 0x0d220400 }],
    may: [{ file: 'pkx_agb_f_a1.fsys' }, { file: PEOPLE, entry: 0x031e0400 }],
    red: [{ file: 'pkx_akami_m_a1.fsys' }, { file: PEOPLE, entry: 0x0d270400 }],
    leaf: [{ file: 'pkx_akami_f_a1.fsys' }, { file: PEOPLE, entry: 0x0d260400 }],
  },
  xd: {
    wes: [{ file: 'pkx_ken_a1.fsys' }],
    brendan: [{ file: 'pkx_agb_m_a1.fsys' }],
    may: [{ file: 'pkx_agb_f_a1.fsys' }],
    red: [{ file: 'pkx_akami_m_a1.fsys' }],
    leaf: [{ file: 'pkx_akami_f_a1.fsys' }],
    michael: [{ file: 'pkx_rinto_0101.fsys' }, { file: 'pkx_rinto_1101.fsys' }, { file: 'pkx_rinto_2101.fsys' }, { file: 'pkx_rinto_1102.fsys' },
      { file: 'pkx_rinto_2102.fsys' }, ...[0x16c90400, 0x169e0400, 0x169f0400, 0x16a00400, 0x1edf0400, 0x20250400, 0x1ee20400].map(entry => ({ file: PEOPLE, entry }))],
  },
};

// The heroes of `looks` with colours chosen, in `game`
const paintedHeroes = (looks, game) => colors.heroesFor(game).map(hero => hero.id)
  .filter(id => STORY_MODELS[game]?.[id] && Object.keys(looks?.colors?.[id] || {}).length);

// Each model's file from the disc, as hsd-model.js reads one (a Colosseum-layout pkx); a model the disc hasn't is left out
function readModels(disc, list) {
  const archives = new Map(), out = [];
  for (const { file, entry } of list) {
    if (!disc.files.has(file)) continue;
    if (!archives.has(file)) archives.set(file, fsys.entries(disc.file(file)));
    const found = entry === undefined ? archives.get(file)[0] : archives.get(file).find(each => each.id === entry);
    if (!found) continue;
    const data = Buffer.from(found.data());
    if (entry !== undefined) {
      const pkx = Buffer.concat([Buffer.alloc(PKX_HEADER), data]);
      pkx.writeUInt32BE(data.length, 0);
      out.push(pkx);
    } else out.push(disc.gameId?.startsWith('GXX') ? colosseumPkx(data) : data);
  }
  return out;
}

// An HD pack image, decoded, or null
function readImage(found) {
  if (!found) return null;
  try {
    const image = decodePng(fs.readFileSync(found.file));
    return { rgba: new Uint8Array(image.rgba.buffer, image.rgba.byteOffset, image.rgba.length), width: image.width, height: image.height };
  } catch (_) { return null; }
}

// The repainted images of one hero's models: [{ names, png }], each texture once (by its first name). `index` is
// texture-pack-lookup.js's of the game's texture pack folders, or null.
function heroImages(heroId, models, chosen, index) {
  const out = new Map();
  for (const pkx of models) {
    // with the images its texture animations swap in (a battle model's face as the hero blinks)
    const textures = hsd.parseModel(pkx, { animated: true }).textures, base = colors.prepare(heroId, textures);
    const found = textures.map(texture => (index && texture.disc ? texturePackLookup.findReplacement(index, texture.disc) : null));
    const large = found.map(readImage), sorted = large.some(Boolean) ? colors.prepare(heroId, large.map((image, i) => image || textures[i]), textures) : null;
    textures.forEach((texture, i) => {
      if (!texture.disc) return;
      const names = texturePackLookup.textureNames(texture.disc);
      if (!names.length || out.has(names[0])) return;
      // a texture the colours leave as it is (the eyes, a reflection) stays the disc's, or the HD pack's
      const own = colors.recolor(heroId, texture.rgba, base.textures[i], base.refs, chosen);
      if (Buffer.compare(Buffer.from(own.buffer, own.byteOffset, own.length), Buffer.from(texture.rgba.buffer, texture.rgba.byteOffset, texture.rgba.length)) === 0) return;
      // the HD pack's name first: the one the game would find
      const all = [...new Set([...(found[i] ? [found[i].name] : []), ...names])];
      const image = large[i]
        ? png(large[i].width, large[i].height, colors.recolor(heroId, large[i].rgba, sorted.textures[i], sorted.refs, chosen))
        : png(texture.width, texture.height, own);
      out.set(names[0], { names: all, png: image });
    });
  }
  return [...out.values()];
}

// The folder of the story's repainted textures for `looks` in `game`, made in `root` (the launcher's own) from the disc
// `rom`, or null when no hero there has colours. Made once for the same colours, disc and HD images; the newest few kept.
// `folders` are the game's texture pack folders (the HD pack's, the player's own), whose images are repainted too.
function makeStoryPack(rom, game, looks, root, folders = []) {
  const heroes = paintedHeroes(looks, game);
  if (!heroes.length) return null;
  const disc = new Disc(rom);
  try {
    const index = folders.length ? texturePackLookup.indexFolders(folders) : null;
    const models = new Map(heroes.map(id => [id, readModels(disc, STORY_MODELS[game][id])]));
    const hash = crypto.createHash('sha256').update(JSON.stringify({ VERSION, game, colors: heroes.map(id => [id, Object.entries(looks.colors[id]).sort()]) }));
    for (const id of heroes) for (const pkx of models.get(id)) {
      hash.update(pkx);
      if (index) for (const texture of hsd.parseModel(pkx, { animated: true }).textures) {
        const found = texture.disc && texturePackLookup.findReplacement(index, texture.disc);
        if (!found) continue;
        try { const { size, mtimeMs } = fs.statSync(found.file); hash.update(`${found.file}:${size}:${mtimeMs}`); } catch (_) { /* not there after all */ }
      }
    }
    const key = hash.digest('hex').slice(0, 24), at = path.join(root, key);
    if (fs.existsSync(path.join(at, 'made.json'))) {
      const now = new Date();
      try { fs.utimesSync(at, now, now); } catch (_) { /* kept anyway */ }
      return at;
    }
    const temporary = `${at}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.mkdirSync(temporary, { recursive: true });
    let count = 0;
    for (const id of heroes) for (const { names, png: bytes } of heroImages(id, models.get(id), looks.colors[id], index)) {
      for (const name of names) fs.writeFileSync(path.join(temporary, `${name}.png`), bytes);
      count++;
    }
    fs.writeFileSync(path.join(temporary, 'made.json'), JSON.stringify({ version: VERSION, game, heroes, textures: count }));
    fs.rmSync(at, { recursive: true, force: true });
    fs.renameSync(temporary, at);
    prune(root, key);
    return at;
  } finally { disc.close(); }
}

// Only the newest folders stay, and nothing half made that's older than any would take
const ABANDONED = 10 * 60 * 1000;
function prune(root, keep) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()); } catch (_) { return; }
  const dated = entries.map(entry => {
    const at = path.join(root, entry.name);
    try { return { at, name: entry.name, time: fs.statSync(at).mtimeMs }; } catch (_) { return null; }
  }).filter(Boolean).sort((a, b) => b.time - a.time);
  const made = dated.filter(({ name }) => !name.endsWith('.tmp'));
  for (const { at, name } of made.slice(KEPT)) if (name !== keep) fs.rmSync(at, { recursive: true, force: true });
  for (const { at, name, time } of dated) if (name.endsWith('.tmp') && Date.now() - time > ABANDONED) fs.rmSync(at, { recursive: true, force: true });
}

module.exports = { VERSION, STORY_MODELS, paintedHeroes, makeStoryPack, heroImages };
