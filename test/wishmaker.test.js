'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gen3 = require('../src/gen3-save');
const wishmaker = require('../src/wishmaker');
const bonusDisc = require('../src/bonus-disc');
const saveImport = require('../src/save-import');
const fs = require('node:fs');

// A gift shaped as src/bonus-disc.js reads it (test values, not the disc's): a level 5 Pokémon with three level-up
// moves by then, and natures that leave every stat alone but #3 (Attack up, Sp. Atk down).
function gift() {
  const natures = Array.from({ length: 25 }, () => [0, 0, 0, 0, 0]);
  natures[3] = [1, 0, 0, -1, 0];
  const name = Buffer.alloc(10, 0xFF);
  Buffer.from([0xC4, 0xC3, 0xCC, 0xBB, 0xBD, 0xC2, 0xC3]).copy(name);   // JIRACHI
  return {
    species: 409, level: 5, moves: [0, 0, 0, 0], nickname: name,
    otName: Buffer.from([0xD1, 0xC3, 0xCD, 0xC2, 0xC7, 0xC5, 0xCC]), otId: 20043, otGender: 0,   // WISHMKR
    baseStats: [100, 100, 100, 100, 100, 100], friendship: 100, ability: 32, experience: level => level === 5 ? 156 : 0,
    levelUp: [{ level: 1, move: 273 }, { level: 1, move: 93 }, { level: 5, move: 156 }, { level: 10, move: 129 }],
    pp: move => ({ 273: 10, 93: 25, 156: 10 })[move], natures, items: [169, 170], ball: 4, metLocation: 255, metGame: 2, language: 2
  };
}

// A Gen 3 save of `game` with a party of `party` Pokémon (personality 0, English), money and coins as each game keeps
// them, and SaveBlock2's 0xAC as it is: FireRed/LeafGreen's 1, Emerald's key, and in Ruby/Sapphire 0 or, once the
// Battle Tower has a record, the start of the player's name.
const SIZES = [3884, 3968, 3968, 3968, 3848, 3968, 3968, 3968, 3968, 3968, 3968, 3968, 3968, 2000];
const LAYOUT = { rs: [0x234, 0x238], frlg: [0x34, 0x38], e: [0x234, 0x238] };
function save({ game = 'rs', tower = true, party = 2, language = 2, key = 0x9A3F51C2, money = 3000, coins = 120 } = {}) {
  const data = Buffer.alloc(gen3.SAVE_SIZE);
  const sections = SIZES.map(() => Buffer.alloc(0x1000));
  const sb2 = sections[0], sb1 = Buffer.alloc(0xF80 * 4);
  Buffer.from([0xBB, 0xCD, 0xC2, 0xFF]).copy(sb2, 0);
  sb2.writeUInt32LE(0x1234ABCD, 0x0A);
  const code = game === 'frlg' ? 1 : game === 'e' ? key : tower ? 0xC9C7BFC7 : 0;
  sb2.writeUInt32LE(code >>> 0, 0xAC);
  const crypt = game === 'e' ? key : 0;
  sb1.writeUInt32LE((money ^ crypt) >>> 0, 0x490);
  sb1.writeUInt16LE((coins ^ (crypt & 0xFFFF)) & 0xFFFF, 0x494);
  const [countAt, partyAt] = LAYOUT[game];
  sb1[countAt] = party;
  for (let i = 0; i < party; i++) {
    const mon = sb1.subarray(partyAt + i * 100, partyAt + (i + 1) * 100);
    mon.writeUInt32LE(0x1234ABCD, 4);
    mon[0x12] = language;
    mon.writeUInt32LE((304 ^ 0x1234ABCD) >>> 0, 0x20);
    mon[0x54] = 30;
  }
  for (let id = 1; id <= 4; id++) sb1.copy(sections[id], 0, (id - 1) * 0xF80, id * 0xF80);
  sections.forEach((section, id) => {
    let sum = 0;
    for (let i = 0; i < SIZES[id]; i += 4) sum = (sum + section.readUInt32LE(i)) >>> 0;
    section.writeUInt16LE(id, 0xFF4);
    section.writeUInt16LE(((sum >>> 16) + sum) & 0xFFFF, 0xFF6);
    section.writeUInt32LE(0x08012025, 0xFF8);
    section.writeUInt32LE(7, 0xFFC);
    section.copy(data, ((id + 5) % 14) * 0x1000);
  });
  return data;
}

test('a Ruby or Sapphire save with a Battle Tower record is still Ruby/Sapphire, not Emerald', () => {
  assert.equal(gen3.parse(save({ game: 'rs', tower: true })).game, 'rs');
  assert.equal(gen3.parse(save({ game: 'rs', tower: false })).game, 'rs');
  assert.equal(gen3.parse(save({ game: 'frlg' })).game, 'frlg');
  assert.equal(gen3.parse(save({ game: 'e' })).game, 'e');
  // a key so small both readings are possible: Emerald, as before
  assert.equal(gen3.parse(save({ game: 'e', key: 0x5EED })).game, 'e');
});

test("the Jirachi a seed makes is the games' random numbers in the disc program's order", () => {
  const draw = wishmaker.rng(0x180E);
  const r = Array.from({ length: 5 }, draw);
  const jirachi = wishmaker.make(gift(), 0x180E);
  assert.equal(jirachi.personality, ((r[0] << 16) | r[1]) >>> 0);
  assert.deepEqual(jirachi.ivs, [r[2] & 31, (r[2] >> 5) & 31, (r[2] >> 10) & 31, r[3] & 31, (r[3] >> 5) & 31, (r[3] >> 10) & 31]);
  assert.equal(jirachi.item, (Math.floor(r[4] / 3) & 1) ? 169 : 170);
  assert.deepEqual(jirachi.moves, [273, 93, 156]);
  assert.deepEqual(wishmaker.make(gift(), 0x180E).data, jirachi.data, 'a save gets the same Jirachi every time');
  assert.notDeepEqual(wishmaker.make(gift(), 0x180F).personality, jirachi.personality);
  // the games' stat formula at level 5, base 100, no EVs
  const hp = Math.floor((200 + jirachi.ivs[0]) * 5 / 100) + 15;
  assert.equal(jirachi.stats[0], hp);
});

for (const game of ['rs', 'frlg', 'e']) {
  test(`Jirachi joins a ${game} save's party, in its Pokédex, once`, () => {
    const before = save({ game });
    assert.equal(wishmaker.problem(before), '');
    const result = wishmaker.give(before, gift());
    const info = gen3.parse(result.buffer);   // every section's checksum is right again
    assert.equal(info.party.length, 3);
    const blocks = gen3.blocks(result.buffer), layout = gen3.GAMES[game];
    assert.equal(result.seed, before.readUInt16LE(gen3.blocks(before).live.at[0] + 0xFF6), 'seeded by the save as it was');
    const mon = saveImport.fromGba(blocks.sb1.subarray(layout.party + 200, layout.party + 300)).pokemon;
    assert.equal(mon.invalid, false);
    assert.deepEqual([mon.species, mon.metLevel, mon.metLocation, mon.ball, mon.otId, mon.friendship, mon.exp, mon.item],
      [409, 5, 255, 4, 20043, 100, 156, result.item]);
    assert.equal(String.fromCharCode(...mon.otName), 'WISHMKR');
    assert.deepEqual(mon.moves.map(move => [move.id, move.pp]), [[273, 10], [93, 25], [156, 10]]);
    const byte = 384 >> 3;
    for (const at of [0x28 + byte, 0x5C + byte]) assert.equal(blocks.sb2[at] & 1, 1);
    for (const at of [layout.seen1 + byte, layout.seen2 + byte]) assert.equal(blocks.sb1[at] & 1, 1);
    assert.equal(blocks.sb1[layout.ribbons + 0x21] & 1, 1);
    assert.match(wishmaker.problem(result.buffer), /already have been given JIRACHI/);
    assert.throws(() => wishmaker.give(result.buffer, gift()), /already have been given JIRACHI/);
  });
}

test("a Colosseum save's Jirachi is seeded by its trainer ID, folded to 16 bits, and comes over as Import brings one", () => {
  assert.equal(wishmaker.colosseumSeed(0x12345678), 0x1234 ^ 0x5678);
  const jirachi = wishmaker.make(gift(), wishmaker.colosseumSeed(0x12345678));
  assert.deepEqual(wishmaker.make(gift(), wishmaker.colosseumSeed(0x12345678)).data, jirachi.data, 'the same for that save every time');
  const judged = saveImport.judge(saveImport.fromGba(jirachi.data), { game: 'colosseum' });
  assert.deepEqual(judged.problems, []);
  assert.ok(judged.bytes);
});

test("Jirachi isn't given to a full party, another language's game or a damaged save", () => {
  assert.match(wishmaker.problem(save({ party: 6 })), /party is full/);
  assert.match(wishmaker.problem(save({ language: 5 })), /North American/);
  assert.match(wishmaker.problem(save(), { pakCode: 'AXVD' }), /North American/);
  assert.match(wishmaker.problem(save(), { pakCode: 'AGBE' }), /isn't Ruby, Sapphire/);
  assert.equal(wishmaker.problem(save({ game: 'e' }), { pakCode: 'BPEE' }), '');
  const damaged = save();
  damaged[0x5000 + 9] ^= 1;
  assert.match(wishmaker.problem(damaged), /corrupted/);
});

test('without the Bonus Disc, the built-in gift makes the Jirachi the gift above makes', () => {
  const built = bonusDisc.builtIn(), ours = { ...gift(), natures: built.natures };   // the test gift fills in one nature only
  for (const seed of [0, 0x180E, 0x3669, 0xFFFF]) assert.deepEqual(wishmaker.make(built, seed).data, wishmaker.make(ours, seed).data);
  // the games' nature rule: 25 natures, neutral on the diagonal, else one stat up and one down
  assert.deepEqual(built.natures[0], [0, 0, 0, 0, 0]);
  assert.deepEqual(built.natures[3], [1, 0, 0, -1, 0]);
  assert.ok(built.natures.every((row, n) => n % 6 === 0 ? row.every(v => v === 0) : row.filter(v => v).sort().join() === '-1,1'));
});

// With the North American Bonus Disc at hand (COLO_BONUS_DISC), the built-in gift is the disc's own for every seed.
test("the built-in gift is the Bonus Disc's, when a disc is at hand", { skip: !process.env.COLO_BONUS_DISC || !fs.existsSync(process.env.COLO_BONUS_DISC) }, () => {
  const disc = bonusDisc.read(process.env.COLO_BONUS_DISC), built = bonusDisc.builtIn();
  for (let seed = 0; seed < 0x10000; seed += 0x101) assert.deepEqual(wishmaker.make(built, seed).data, wishmaker.make(disc, seed).data);
});

test("the GBA BIOS's LZ77 unpacks literals and copies", () => {
  // "ABCABCABCD": three literals, a copy of 6 from 3 back, a literal
  const packed = Buffer.from([0x10, 10, 0, 0, 0b00010000, 0x41, 0x42, 0x43, 0x30, 0x02, 0x44]);
  assert.equal(bonusDisc.lz77(packed, 0).toString('latin1'), 'ABCABCABCD');
  assert.throws(() => bonusDisc.lz77(Buffer.from([0x11, 1, 0, 0]), 0), /packed/);
});
