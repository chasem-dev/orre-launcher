'use strict';

// WISHMAKER Jirachi: the Bonus Disc's gift (src/bonus-disc.js reads it from the player's disc), put into a Gen 3 save
// as the disc's GBA program puts it into Ruby or Sapphire, and into FireRed, LeafGreen and Emerald too.
//
// What the program does, from its code (client.bin, unpacked at 0x02010000):
//   - it seeds the games' random numbers (x * 0x41C64E6D + 0x6073, each draw the top 16 bits) with section 0's
//     checksum in the newer copy of the save, so each save gets its own Jirachi, and the same one every time;
//   - the personality is two draws, the first the top half; the IVs two more (HP, Attack, Defense from the first,
//     5 bits each from bit 0; Speed, Sp. Atk, Sp. Def from the second); the moves are the species' own at its level;
//   - the held item is one more draw, divided by 3: odd, the first berry (0xA9, Ganlon), even, the second (0xAA, Salac);
//   - it goes into the party, Jirachi is marked seen and caught in the Pokédex (its three copies of seen), and
//     ExternalEventFlags' third byte (receivedGCNJirachi) is set, so a save gets one Jirachi;
//   - it refuses a game that isn't the North American Ruby or Sapphire, a full party, and a save that has had one.
// The other games keep the same things in other places (gen3-save.js's GAMES), and the Jirachi is the same as on
// Ruby: met in Ruby, as the disc made it.

const gen3 = require('./gen3-save');

const PARTY_SIZE = 6, MON = 100;
const RECEIVED = 0x21;                    // from the gift ribbons: ExternalEventData (11 on, 0x14 long), then the flags' byte 2
const DEX_OWNED = 0x28, DEX_SEEN = 0x5C;  // SaveBlock2's Pokédex (from 0x18): caught and seen, a bit each by National number
const JIRACHI_NATIONAL = 385;
// Game Pak codes (without the region letter) for each game, for when the player has chosen one.
const PAK_GAMES = { AXV: 'rs', AXP: 'rs', BPR: 'frlg', BPG: 'frlg', BPE: 'e' };
const ENGLISH = 2;

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 0x41C64E6D) + 0x6073) >>> 0;
    return state >>> 16;
  };
}

// The moves a Pokémon knows when made at `level`: each of its level-up moves to then, in order, the oldest
// forgotten for a fifth.
function initialMoves(gift) {
  if (gift.moves.some(Boolean)) return gift.moves.filter(Boolean);
  const moves = [];
  for (const { level, move } of gift.levelUp) {
    if (level > gift.level) break;
    if (moves.includes(move)) continue;
    if (moves.length === 4) moves.shift();
    moves.push(move);
  }
  return moves;
}

// The six stats: HP, Attack, Defense, Speed, Sp. Atk, Sp. Def (no EVs yet), the nature raising or lowering one.
function stats(gift, ivs, nature) {
  const level = gift.level;
  return gift.baseStats.map((base, i) => {
    const raw = Math.floor((2 * base + ivs[i]) * level / 100);
    if (i === 0) return raw + level + 10;
    const change = gift.natures[nature][i - 1];
    return Math.floor((raw + 5) * (100 + 10 * change) / 100);
  });
}

// Jirachi for the save whose section 0 checksum is `seed`: its facts, and its 100 bytes as a party Pokémon.
function make(gift, seed) {
  const draw = rng(seed);
  const personality = ((draw() << 16) | draw()) >>> 0;
  const first = draw(), second = draw();
  const ivs = [first & 31, (first >> 5) & 31, (first >> 10) & 31, second & 31, (second >> 5) & 31, (second >> 10) & 31];
  const item = gift.items[(Math.floor(draw() / 3) & 1) ? 0 : 1];
  const nature = personality % 25;
  const moves = initialMoves(gift);
  const values = stats(gift, ivs, nature);

  const growth = Buffer.alloc(12), attacks = Buffer.alloc(12), evs = Buffer.alloc(12), misc = Buffer.alloc(12);
  growth.writeUInt16LE(gift.species, 0);
  growth.writeUInt16LE(item, 2);
  growth.writeUInt32LE(gift.experience(gift.level), 4);
  growth[9] = gift.friendship;
  moves.forEach((move, i) => { attacks.writeUInt16LE(move, 2 * i); attacks[8 + i] = gift.pp(move); });
  misc[1] = gift.metLocation;
  misc.writeUInt16LE(gift.level | gift.metGame << 7 | gift.ball << 11 | gift.otGender << 15, 2);
  // IVs in the games' order of bits: HP, Attack, Defense, Speed, Sp. Atk, Sp. Def; the ability its first
  misc.writeUInt32LE((ivs[0] | ivs[1] << 5 | ivs[2] << 10 | ivs[3] << 15 | ivs[4] << 20 | ivs[5] << 25) >>> 0, 4);

  const order = gen3.ORDERS[personality % 24], parts = { G: growth, A: attacks, E: evs, M: misc };
  const plain = Buffer.concat([...order].map(letter => parts[letter]));
  let sum = 0;
  for (let i = 0; i < 48; i += 2) sum = (sum + plain.readUInt16LE(i)) & 0xFFFF;

  const mon = Buffer.alloc(MON);
  mon.writeUInt32LE(personality, 0);
  mon.writeUInt32LE(gift.otId >>> 0, 4);
  gift.nickname.copy(mon, 0x08, 0, 10);
  mon[0x12] = gift.language;
  mon[0x13] = 0x02;                          // has its species (not an egg, not a bad egg)
  gift.otName.copy(mon, 0x14, 0, 7);
  mon.writeUInt16LE(sum, 0x1C);
  const key = (personality ^ gift.otId) >>> 0;
  for (let i = 0; i < 48; i += 4) mon.writeUInt32LE((plain.readUInt32LE(i) ^ key) >>> 0, 0x20 + i);
  // the party's part: no status, its level, no mail, full HP, its stats
  mon[0x54] = gift.level;
  mon[0x55] = 0xFF;
  mon.writeUInt16LE(values[0], 0x56);
  values.forEach((value, i) => mon.writeUInt16LE(value, 0x58 + 2 * i));
  return { personality, ivs, item, nature, moves, stats: values, data: mon };
}

// Which game the save is for: the Game Pak's code when the player chose one (as the disc read the cartridge's),
// otherwise the save's own (gen3-save.js).
function gameFor(blocks, pakCode) {
  if (pakCode) {
    const game = PAK_GAMES[pakCode.slice(0, 3)];
    if (!game) throw new Error("The Game Pak chosen for this save isn't Ruby, Sapphire, Emerald, FireRed or LeafGreen.");
    if (pakCode[3] !== 'E') throw new Error('WISHMAKER Jirachi goes to North American (English) games only, as on the Bonus Disc.');
    return game;
  }
  return blocks.gameId;
}

// Whether the save can take Jirachi: '' when it can, otherwise why not, in the disc's own terms.
function problem(buffer, { pakCode = '' } = {}) {
  let blocks, info;
  try {
    blocks = gen3.blocks(buffer);
    info = gen3.parse(buffer);
  } catch (_) {
    return 'The save file is corrupted.';
  }
  let game;
  try { game = gen3.GAMES[gameFor(blocks, pakCode)]; } catch (error) { return error.message; }
  if (info.language !== ENGLISH) return 'WISHMAKER Jirachi goes to North American (English) games only, as on the Bonus Disc.';
  if (blocks.sb1[game.partyCount] >= PARTY_SIZE) return 'Your Pokémon party is full. Put a Pokémon in the PC, save, then try again.';
  if (blocks.sb1[game.ribbons + RECEIVED] & 1) return 'You already have been given JIRACHI as a gift. You can only receive one JIRACHI per save.';
  return '';
}

// Jirachi in the save: a new buffer with it in the party, the Pokédex and the flag set and the checksums made again,
// and what it got. Throws with problem()'s reason when the save can't take it.
function give(buffer, gift, options = {}) {
  const why = problem(buffer, options);
  if (why) throw new Error(why);
  const out = Buffer.from(buffer);
  const blocks = gen3.blocks(out), game = gen3.GAMES[gameFor(blocks, options.pakCode)], live = blocks.live;
  const seed = out.readUInt16LE(live.at[0] + 0xFF6);
  const jirachi = make(gift, seed);
  const touched = new Set();
  const set = (block, offset, apply) => {
    const at = gen3.place(live, block, offset);
    out[at] = apply(out[at]);
    touched.add(at);
  };
  const count = blocks.sb1[game.partyCount];
  const slot = gen3.place(live, 'sb1', game.party + count * MON);
  jirachi.data.copy(out, slot);
  touched.add(slot);
  set('sb1', game.partyCount, value => value + 1);
  const byte = (JIRACHI_NATIONAL - 1) >> 3, bit = 1 << ((JIRACHI_NATIONAL - 1) & 7);
  set('sb2', DEX_OWNED + byte, value => value | bit);
  set('sb2', DEX_SEEN + byte, value => value | bit);
  set('sb1', game.seen1 + byte, value => value | bit);
  set('sb1', game.seen2 + byte, value => value | bit);
  set('sb1', game.ribbons + RECEIVED, value => value | 1);
  for (const at of touched) gen3.resum(out, at);
  return { buffer: out, game: game.name, seed, ...jirachi };
}

// The seed for a Colosseum save's Jirachi, which has no GBA save to take one from: its trainer ID folded to 16 bits
// (the visible ID XOR the secret one), as the disc's seed is 16 bits.
function colosseumSeed(trainerId) { return ((trainerId >>> 16) ^ trainerId) & 0xFFFF; }

module.exports = { make, give, problem, initialMoves, rng, colosseumSeed };
