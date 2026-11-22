'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const convert = require('../src/trade-convert');
const story = require('../src/generations/shadow-story.json');
const { shadowFor, storyIdFor, shadowState } = require('../src/shadow-convert');
const { checkReceived } = require('../src/shadowtrade');

const units = text => [...text].map(c => c.charCodeAt(0)).concat(Array(11).fill(0)).slice(0, 11);
// A Pokémon in trade-convert.js's form (Colosseum's numbers)
function form(species, level, extra = {}) {
  return { species, rnd: 0x11bef5eb, attest: [11, 3, 2, 2], metLocation: 0x8f, metLevel: level, ball: 11, otGender: 0, otId: 0x12345678,
    otName: units('WES'), nickname: units('MAKUHITA'), nicknameOrg: units('MAKUHITA'), exp: 27000, level, conditionAmari: 0,
    moves: [{ id: 193, pp: 40, ppUps: 0 }, { id: 116, pp: 30, ppUps: 0 }, { id: 233, pp: 10, ppUps: 0 }, { id: 238, pp: 5, ppUps: 0 }],
    item: 0, hp: 90, stats: [90, 60, 40, 30, 40, 30], evs: [0, 0, 0, 0, 0, 0], ivs: [30, 18, 17, 18, 16, 11], friendship: 70,
    contest: [0, 0, 0, 0, 0], ranks: [0, 0, 0, 0, 0], sheen: 0, ribbons: Array(12).fill(false), ribbonSpare: 0, pokerus: 0, abilitySlot: 0,
    flagAmari: 0, markings: 0, para1Amari: 0, amari: 0, event: false, ...extra };
}
// A snagged Colosseum Shadow: story id, gauge (x100), banked EXP and friendship
function colosseumShadow(species, level, id, gauge, { poolExp = 0, poolFriend = 0 } = {}) {
  const b = convert.write('colosseum', form(species, level));
  b.writeUInt16BE(id, 0xd8); b.writeInt32BE(gauge, 0xdc); b.writeUInt32BE(poolExp, 0xe0); b.writeUInt16BE(poolFriend, 0xe4);
  return b;
}
// A snagged XD Shadow and its record (species in Colosseum's numbers, as form's)
function xdShadow(species, level, id, gauge, { poolExp = 0, poolFriend = 0 } = {}) {
  const b = convert.write('xd', form(species, level));
  b.writeUInt16BE(id, 0xba);
  const r = Buffer.alloc(0x48);
  r.writeUInt32BE((3 << 29 | 1 << 15) >>> 0, 0); r.writeUInt32BE((poolExp << 12 | 4 << 8) >>> 0, 4);
  r.writeUInt16BE(poolFriend, 0x18); r.writeUInt16BE(species, 0x1a); r.writeInt32BE(gauge, 0x24); r.writeUInt16BE(id, 0x3e); r[0x40] = 2;
  return { data: b, record: r };
}
const b64 = bytes => bytes.toString('base64');

test('a story id for the other game\'s Shadow: its species\'s if the story has it, else the nearest level\'s', () => {
  assert.equal(story.xd[15].species, 335);
  assert.equal(storyIdFor('xd', 335, 30), 15, 'XD has a Shadow Makuhita');
  const id = storyIdFor('colosseum', 216, 11);   // no Teddiursa in Colosseum's story: the nearest level, lowest id
  const nearest = Math.min(...Object.values(story.colosseum).map(v => Math.abs(v.level - 11)));
  assert.equal(Math.abs(story.colosseum[id].level - 11), nearest);
  assert.ok(Object.entries(story.colosseum).every(([n, v]) => Math.abs(v.level - 11) > nearest || Number(n) >= id));
  // XD's own Bonsly is Colosseum's 464; species compare in Colosseum's numbers
  assert.equal(storyIdFor('xd', 464, 20) > 0, true);
});

test('Colosseum to XD: the Pokémon, a record made for it, and its gauge as open as it was', () => {
  const sent = colosseumShadow(335, 30, 1, 2900, { poolExp: 1234, poolFriend: 9 });   // Makuhita: 2900 of 3000
  assert.equal(shadowState('colosseum', sent).full, 2900 / 3000);
  const got = shadowFor('colosseum', { data: sent }, 'xd');
  assert.equal(got.storyId, 15);
  assert.equal(got.data.length, 0xc4);
  assert.equal(got.data.readUInt16BE(0), 335);
  assert.equal(got.data.readUInt16BE(0xba), 15);
  const r = got.record;
  assert.equal(r[0] >> 5, 3, 'snagged');
  assert.equal(r.readUInt16BE(0x3e), 15);
  assert.equal(r.readInt32BE(0x24), Math.round(2900 / 3000 * story.xd[15].gauge));
  assert.equal(r.readUInt32BE(4) >>> 12, 1234);
  assert.equal((r.readUInt32BE(4) >>> 8) & 15, 11, 'its ball');
  assert.equal(r.readUInt16BE(0x18), 9);
  assert.equal(r.readUInt32BE(0x1c), 0x11bef5eb, 'its personality');
  assert.deepEqual([...r.subarray(0x0b, 0x11)], [30, 18, 17, 18, 16, 11], 'its IVs');
  assert.equal(r[0x40], story.xd[15].revers);
  assert.equal(String.fromCharCode(...[0, 1, 2].map(i => r.readUInt16BE(0x28 + 2 * i))), 'WES');
  assert.deepEqual([0, 1, 2, 3].map(i => got.data.readUInt16BE(0x80 + 4 * i)), [193, 116, 233, 238], 'its own moves; Shadow moves are the story id\'s');
  checkReceived('xd', { pokemon: { data: b64(got.data), record: b64(got.record) } });
});

test('XD to Colosseum: the gauge, banked EXP and friendship go into the Pokémon', () => {
  const { data, record } = xdShadow(216, 11, 1, 1500, { poolExp: 700, poolFriend: 30 });   // Teddiursa: 1500 of 3000
  const got = shadowFor('xd', { data, record }, 'colosseum');
  assert.equal(got.record, null);
  assert.equal(got.data.length, 0x138);
  assert.equal(got.data.readUInt16BE(0), 216);
  assert.equal(got.data.readUInt16BE(0xd8), got.storyId);
  assert.equal(got.data.readInt32BE(0xdc), Math.round(0.5 * story.colosseum[got.storyId].gauge));
  assert.equal(got.data.readUInt32BE(0xe0), 700);
  assert.equal(got.data.readUInt16BE(0xe4), 30);
  checkReceived('colosseum', { pokemon: { data: b64(got.data) } });
  // an open heart stays open
  assert.equal(shadowFor('xd', xdShadow(216, 11, 1, 0), 'colosseum').data.readInt32BE(0xdc), 0);
});

test('Generation 4 across games: only to a game that has them on', () => {
  const bonsly = xdShadow(464, 20, 1, 3000);   // (form's numbers are Colosseum's) XD's own Bonsly, 413 there: Generation 4 in Colosseum
  assert.equal(bonsly.data.readUInt16BE(0), 413);
  assert.throws(() => shadowFor('xd', bonsly, 'colosseum'), /Generation 4/);
  const got = shadowFor('xd', bonsly, 'colosseum', { laterPokemon: true });
  assert.equal(got.data.readUInt16BE(0), 464);
  checkReceived('colosseum', { pokemon: { data: b64(got.data) } }, { later: true });
  assert.equal(shadowFor('colosseum', { data: colosseumShadow(464, 20, 1, 3000) }, 'xd').data.readUInt16BE(0), 413, 'and back: XD has it of its own');
});

test('a Pokémon that isn\'t a Shadow of the other game\'s story is refused', () => {
  assert.throws(() => shadowFor('colosseum', { data: colosseumShadow(335, 30, 0x60, 2900) }, 'xd'), /story/);
  const { data, record } = xdShadow(216, 11, 1, 1500);
  record[0] = 4 << 5;   // purified
  assert.throws(() => shadowFor('xd', { data, record }, 'colosseum'), /damaged/);
});
