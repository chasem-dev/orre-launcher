'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const colors = require('../src/hero-colors');
const heroLook = require('../src/hero-look');

// A texture of flat patches, each a colour as the disc has it, with a darker and a lighter shade of each.
function patches(list) {
  const width = list.length * 3, height = 2, rgba = new Uint8Array(width * height * 4);
  list.forEach((hex, i) => {
    const [r, g, b] = [1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16));
    [0.7, 1, 1.15].forEach((shade, j) => {
      for (let y = 0; y < height; y++) rgba.set([r * shade, g * shade, b * shade, 255].map(v => Math.min(255, Math.round(v))), ((y * width) + i * 3 + j) * 4);
    });
  });
  return { rgba, width, height };
}

test('every hero has its model file, regions with seeds, and presets of its own regions', () => {
  assert.deepEqual(colors.HEROES.map(hero => hero.id), ['wes', 'brendan', 'may', 'red', 'leaf', 'michael']);
  for (const hero of colors.HEROES) {
    assert.match(hero.battle.file, /^pkx_\w+\.fsys$/);
    const ids = hero.regions.map(region => region.id);
    assert.equal(new Set(ids).size, ids.length, `${hero.id}'s regions are named once`);
    assert.ok(hero.regions.every(region => region.seeds.length && region.seeds.every(seed => seed.length === 3)));
    assert.ok(ids.includes('skin') && ids.includes('eyes'), `${hero.id} has skin and eyes for its face`);
    for (const preset of hero.presets) for (const id of Object.keys(preset.colors)) assert.ok(ids.includes(id), `${hero.id}'s ${preset.id} colours ${id}`);
  }
});

test('the looks keep only real heroes, real regions and #rrggbb colours', () => {
  const looks = colors.normalizeLooks({ shown: 'ash', colors: { wes: { coat: '#AA0000', cape: '#00ff00', trim: 'red' }, gary: { coat: '#000000' } } });
  assert.equal(looks.shown, 'wes');
  assert.deepEqual(looks.colors.wes, { coat: '#aa0000' });
  assert.deepEqual(Object.keys(looks.colors), ['wes', 'brendan', 'may', 'red', 'leaf', 'michael']);
  assert.deepEqual(colors.normalizeLooks(null).colors.leaf, {});
  assert.equal(colors.normalizeLooks({ shown: 'may' }).shown, 'may');
});

test('a texture is sorted by region, repainted only where a colour is chosen, and keeps its shading', () => {
  // Wes's coat blue, his trim's orange and his suit's black
  const texture = patches(['#0d4f78', '#7f2200', '#2b2526']);
  const { textures: [sorted] } = colors.prepare('wes', [texture]);
  const regions = colors.hero('wes').regions.map(region => region.id);
  // too small a texture is left alone: this one is padded out to a real size first
  assert.ok(sorted.mask.every(region => region === 255), 'a lens-sized texture keeps every texel');
  const big = { width: 48, height: 48, rgba: new Uint8Array(48 * 48 * 4) };
  for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) big.rgba.set(texture.rgba.subarray(((y % 2) * texture.width + (x % texture.width)) * 4, ((y % 2) * texture.width + (x % texture.width)) * 4 + 4), (y * 48 + x) * 4);
  const prepared = colors.prepare('wes', [big]), [one] = prepared.textures;
  assert.equal(one.face, false);
  assert.equal(regions[one.mask[1]], 'coat');
  assert.equal(regions[one.mask[4]], 'trim');
  assert.equal(regions[one.mask[7]], 'suit');

  const unchanged = colors.recolor('wes', big.rgba, one, prepared.refs, {});
  assert.deepEqual(Array.from(unchanged), Array.from(big.rgba), 'no colour chosen leaves the texture as it was');
  const red = colors.recolor('wes', big.rgba, one, prepared.refs, { coat: '#c02020' });
  const at = i => Array.from(red.subarray(i * 4, i * 4 + 3));
  assert.ok(at(1)[0] > at(1)[2] + 60, 'the coat is red now');
  assert.ok(at(0)[0] < at(1)[0] && at(1)[0] < at(2)[0], 'its darker and lighter shades stay darker and lighter');
  assert.deepEqual(at(7), Array.from(big.rgba.subarray(28, 31)), 'the suit is left as it was');
});

// A face texture: May's skin all over, with `marks` of other colours painted on as [hex, u0, v0, u1, v1] boxes.
function face(size, marks) {
  const rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) rgba.set([0xef, 0xcb, 0x9c, 255], i * 4);
  for (const [hex, u0, v0, u1, v1] of marks) {
    const c = [1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16));
    for (let y = Math.round(v0 * size); y < Math.round(v1 * size); y++) for (let x = Math.round(u0 * size); x < Math.round(u1 * size); x++) rgba.set([...c, 255], (y * size + x) * 4);
  }
  return { rgba, width: size, height: size };
}

test('eye colours are the eyes only in the irises: brows and lashes in them keep theirs, specks go with what\'s around them', () => {
  const regions = colors.hero('may').regions.map(region => region.id);
  // an iris where May's are, the same blue as a brow above it, and a speck of shirt red in the skin
  const texture = face(128, [['#4a5573', 0.25, 0.45, 0.3, 0.56], ['#4a5573', 0.2, 0.25, 0.35, 0.27], ['#a42c21', 0.6, 0.8, 0.61, 0.81]]);
  const { textures: [sorted] } = colors.prepare('may', [texture]);
  const at = (u, v) => sorted.mask[Math.floor(v * 128) * 128 + Math.floor(u * 128)];
  assert.equal(sorted.face, true);
  assert.equal(regions[at(0.27, 0.5)], 'eyes');
  assert.equal(at(0.27, 0.26), 255, 'a brow in the eye colour is kept as drawn');
  assert.equal(regions[at(0.6, 0.8)], 'skin', 'a speck takes the region around it');
});

test('Wes\'s lids, shaded in his eyes\' orange, are skin', () => {
  const regions = colors.hero('wes').regions.map(region => region.id);
  const texture = face(128, [['#ce8a18', 0.22, 0.5, 0.3, 0.6], ['#d78039', 0.75, 0.38, 0.85, 0.41]]);
  const { textures: [sorted] } = colors.prepare('wes', [texture]);
  const at = (u, v) => regions[sorted.mask[Math.floor(v * 128) * 128 + Math.floor(u * 128)]];
  assert.equal(at(0.26, 0.55), 'eyes');
  assert.equal(at(0.8, 0.395), 'skin');
});

test('lips follow the skin until they have a colour of their own', () => {
  const texture = face(128, [['#c6554a', 0.4, 0.8, 0.6, 0.82]]);
  const prepared = colors.prepare('may', [texture]), [sorted] = prepared.textures;
  const regions = colors.hero('may').regions.map(region => region.id), lip = (0.81 * 128 | 0) * 128 + 64;
  assert.equal(regions[sorted.mask[lip]], 'lips');
  const red = i => colors.recolor('may', texture.rgba, sorted, prepared.refs, i)[lip * 4];
  assert.equal(red({}), 0xc6, 'no colours chosen leaves the lips as drawn');
  assert.ok(red({ skin: '#5a3018' }) < 0xc6 - 40, 'darker skin, darker lips');
  assert.ok(colors.effectiveColors('may', prepared.refs, { skin: '#5a3018' }).lips, 'the page shows the colour they follow');
  const own = colors.recolor('may', texture.rgba, sorted, prepared.refs, { skin: '#5a3018', lips: '#2040ff' });
  assert.ok(own[lip * 4 + 2] > own[lip * 4], 'lips chosen are their own colour');
});

test('a dark colour\'s lighter shades get lighter as gently as its darker ones get darker', () => {
  const out = colors.ramp([0x3a, 0x20, 0x10], 70), L = q => colors.lab(Array.from(out.subarray(q * 3, q * 3 + 3)))[0];
  const step = Math.round(70 * 2.55);
  assert.ok(Math.abs((L(step + 10) - L(step)) - (L(step) - L(step - 10))) < 3, 'no steeper above the typical shade than below');
  assert.ok(L(255) > 90, 'the lightest highlight still reaches white');
});

test('a lens\'s gradient is left as it is, an HD image of one too, and a small texture of hair is repainted', () => {
  // A texture of one colour: Michael's hair, at a size
  const flat = (width, height) => {
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) rgba.set([0x95, 0x41, 0x2c, 255], i * 4);
    return { rgba, width, height };
  };
  const hair = colors.HEROES.find(hero => hero.id === 'michael').regions.findIndex(region => region.id === 'hair');
  const lens = flat(32, 32), lensHd = flat(128, 128), strands = flat(24, 64);
  const [disc, hd, own] = colors.prepare('michael', [lens, lensHd, strands], [lens, lens, strands]).textures;
  assert.ok(disc.mask.every(region => region === 255));
  assert.ok(hd.mask.every(region => region === 255), 'the HD image goes by the disc\'s size');
  assert.ok(own.mask.every(region => region === hair));
});

test('a hero\'s idle motion is the one the model names, else its first', () => {
  assert.equal(heroLook.idleOf({ motions: [{ index: 2, kind: 'special' }, { index: 1, kind: 'idle' }], animations: [10, 30, 30] }), 1);
  assert.equal(heroLook.idleOf({ motions: [], animations: [10] }), 0);
  assert.equal(heroLook.idleOf({ motions: [], animations: [] }), -1);
});

test('a joint\'s rotation read back from its matrix is the one it was made with', () => {
  const retarget = require('../src/hero-retarget');
  for (const rotation of [[0, 0, 0], [0.3, -0.7, 1.2], [-1.1, 0.4, -2.5], [2.9, 1.2, 0.1]]) {
    const m = retarget.jointLocal([1, 1, 1], rotation, [0, 0, 0]);
    const r = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
    const again = retarget.jointLocal([1, 1, 1], retarget.eulerOf(r), [0, 0, 0]);
    for (let e = 0; e < 16; e++) assert.ok(Math.abs(again[e] - m[e]) < 1e-9, `rotation ${rotation} element ${e}`);
  }
});

test('a pkx\'s battle slots name their first clip, and an empty slot -1', () => {
  // the header (0x40), a model and its particles of 0x20 bytes each, then three 0xD0-byte slots
  const pkx = Buffer.alloc(0x40 + 0x20 + 0x20 + 3 * 0xd0);
  pkx.writeUInt32BE(0x20, 0); pkx.writeUInt32BE(0x20, 4); pkx.writeUInt32BE(3, 8); pkx.writeUInt32BE(5, 0x10);
  const slot = i => 0x80 + i * 0xd0;
  pkx.writeUInt32BE(1, slot(0) + 4); pkx.writeUInt32BE(0, slot(0) + 0x8c); pkx.writeUInt32BE(4, slot(0) + 0x90);
  pkx.writeUInt32BE(2, slot(2) + 4); pkx.writeUInt32BE(1, slot(2) + 0x8c); pkx.writeUInt32BE(9, slot(2) + 0x90); pkx.writeUInt32BE(0, slot(2) + 0x94); pkx.writeUInt32BE(2, slot(2) + 0x98);
  assert.deepEqual(heroLook.slotClips(pkx, 10), [4, -1, 2]);
  assert.deepEqual(heroLook.slotClips(pkx, 3), [-1, -1, 2], 'a clip past the model\'s isn\'t played');
  assert.deepEqual(heroLook.slotClips(Buffer.alloc(0x40), 3), [], 'no battle header, no slots');
});

test('every motion is named once; Idle comes first and is played standing when a hero has a model to stand as', () => {
  const ids = colors.MOTIONS.map(motion => motion.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids[0], 'idle');
  assert.equal(colors.modelFor('wes', 'idle'), 'stand');
  assert.equal(colors.modelFor('wes', 'snag'), 'battle');
  assert.equal(colors.modelFor('brendan', 'idle'), 'battle');
  assert.ok(colors.MOTIONS.filter(motion => motion.id !== 'idle').every(motion => Number.isInteger(motion.slot)));
});

test('the story\'s hero is kept when it\'s a hero, and plays only in a game that has them', () => {
  assert.equal(colors.normalizeLooks({ story: 'red' }).story, 'red');
  assert.equal(colors.normalizeLooks({ story: 'gary' }).story, null);
  assert.equal(colors.normalizeLooks({}).story, null);
  assert.equal(colors.storyHero({ story: 'red' }, 'colosseum'), 'red');
  assert.equal(colors.storyHero({ story: 'wes' }, 'xd'), 'wes');
  assert.equal(colors.storyHero({ story: 'michael' }, 'xd'), 'michael');
  assert.equal(colors.storyHero({ story: 'michael' }, 'colosseum'), null);
  assert.equal(colors.storyHero({ story: null }, 'xd'), null);
});
