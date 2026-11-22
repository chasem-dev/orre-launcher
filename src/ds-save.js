'use strict';

// Pokémon Diamond, Pearl and Platinum saves (Generation 4, Nintendo DS), for bringing their Pokémon into Colosseum or
// XD (src/save-import.js): which game, the trainer, the party and the PC boxes, read from the save file alone. A save
// is 512 KB (emulators: .sav, RetroArch's .srm, DeSmuME's .dsv with its own footer after it). From pret's decompilation
// of Platinum (include/savedata.h, include/struct_defs/pokemon.h, src/pokemon.c) and the sizes each game's save keeps:
// - two copies, at 0 and 0x40000, each a general block (the trainer, the party) then a storage block (the PC boxes);
//   each block ends in a footer (save counter, block counter, size, 0x20060623, id, CRC-16 of the block before it),
//   and the newer intact one of each is the save;
// - a Pokémon is 136 bytes in a box, 236 in the party: its four 32-byte blocks shuffled by its personality and
//   enciphered with its checksum (the party's stats after them, with its personality).

const SAVE_SIZE = 0x80000;
const COPY = 0x40000;
const FOOTER = 0x14;
const SIGNATURE = 0x20060623;
const BOX_SIZE = 136, PARTY_SIZE = 236, BOXES = 18, PER_BOX = 30, BOX_NAME = 40;
// Each game's blocks (general, then storage right after it) and where its trainer, party and boxes are.
const GAMES = {
  dp: { name: 'Diamond/Pearl', general: 0xC100, storage: 0x121E0, trainer: 0x64, party: 0x98, boxes: 4 },
  pt: { name: 'Platinum', general: 0xCF2C, storage: 0x121E4, trainer: 0x68, party: 0xA0, boxes: 4 }
};
// Each order of the blocks A, B, C, D: where each is (src/pokemon.c BoxPokemon_GetDataBlock), by (personality >> 13) % 24
const ORDERS = [[0, 1, 2, 3], [0, 1, 3, 2], [0, 2, 1, 3], [0, 3, 1, 2], [0, 2, 3, 1], [0, 3, 2, 1], [1, 0, 2, 3], [1, 0, 3, 2],
  [2, 0, 1, 3], [3, 0, 1, 2], [2, 0, 3, 1], [3, 0, 2, 1], [1, 2, 0, 3], [1, 3, 0, 2], [2, 1, 0, 3], [3, 1, 0, 2], [2, 3, 0, 1],
  [3, 2, 0, 1], [1, 2, 3, 0], [1, 3, 2, 0], [2, 1, 3, 0], [3, 1, 2, 0], [2, 3, 1, 0], [3, 2, 1, 0]];

function crc16(bytes) {
  let crc = 0xFFFF;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc;
}

// A block at `at` of `size` bytes, if its footer says it's whole: { at, save, block }, else null.
function block(buffer, at, size) {
  const footer = at + size - FOOTER;
  if (footer + FOOTER > buffer.length) return null;
  if (buffer.readUInt32LE(footer + 12) !== SIGNATURE || buffer.readUInt32LE(footer + 8) !== size) return null;
  if (crc16(buffer.subarray(at, footer)) !== buffer.readUInt16LE(footer + 0x12)) return null;
  return { at, save: buffer.readUInt32LE(footer), block: buffer.readUInt32LE(footer + 4) };
}
const newest = list => list.filter(Boolean).sort((a, b) => b.save - a.save || b.block - a.block)[0] || null;

// The PRNG the games encipher a Pokémon with: each 16-bit word XORed with the next value's high half
function cipher(data, seed) {
  const out = Buffer.from(data);
  let state = seed >>> 0;
  for (let i = 0; i + 1 < out.length; i += 2) {
    state = (Math.imul(state, 0x41C64E6D) + 0x6073) >>> 0;
    out.writeUInt16LE(out.readUInt16LE(i) ^ (state >>> 16), i);
  }
  return out;
}

// One Pokémon, deciphered: 136 bytes laid out A, B, C, D (and the party's 100 after them), with whether it's whole; null
// for an empty slot.
function decipher(raw) {
  const personality = raw.readUInt32LE(0), checksum = raw.readUInt16LE(6);
  if (!personality && !checksum && raw.subarray(8, BOX_SIZE).every(byte => !byte)) return null;
  const blocks = cipher(raw.subarray(8, BOX_SIZE), checksum);
  const order = ORDERS[((personality & 0x3E000) >>> 13) % 24];
  const out = Buffer.alloc(raw.length >= PARTY_SIZE ? PARTY_SIZE : BOX_SIZE);
  raw.copy(out, 0, 0, 8);
  for (let id = 0; id < 4; id++) blocks.copy(out, 8 + id * 32, order[id] * 32, order[id] * 32 + 32);
  if (out.length === PARTY_SIZE) cipher(raw.subarray(BOX_SIZE, PARTY_SIZE), personality).copy(out, BOX_SIZE);
  let sum = 0;
  for (let i = 8; i < BOX_SIZE; i += 2) sum = (sum + out.readUInt16LE(i)) & 0xFFFF;
  const whole = sum === checksum && !(raw.readUInt16LE(4) & 4);
  // (an empty slot the game has cleared is enciphered zeros: no species)
  if (whole && !out.readUInt16LE(8)) return null;
  return { data: out, whole };
}

// A DS name (16-bit codes, 0xFFFF ends it) as its codes, at most `count`
function codes(bytes, count) {
  const out = [];
  for (let i = 0; i < count && i * 2 + 1 < bytes.length; i++) {
    const code = bytes.readUInt16LE(i * 2);
    if (code === 0xFFFF) break;
    out.push(code);
  }
  return out;
}

// What the save is, or an error with a reason for players: { game, gameName, trainer (codes), trainerId, secretId,
// party: [{ data, whole }], boxes: [{ name (codes), pokemon: [{ data, whole } | null] }] }.
function parse(buffer) {
  if (buffer.length < SAVE_SIZE) throw new Error("This isn't a Pokémon Diamond, Pearl or Platinum save: it's too small.");
  for (const [id, game] of Object.entries(GAMES)) {
    const general = newest([block(buffer, 0, game.general), block(buffer, COPY, game.general)]);
    if (!general) continue;
    const storage = newest([block(buffer, game.general, game.storage), block(buffer, COPY + game.general, game.storage)]);
    if (!storage) throw new Error(`This ${game.name} save's PC boxes are damaged.`);
    const g = buffer.subarray(general.at, general.at + game.general);
    const s = buffer.subarray(storage.at, storage.at + game.storage);
    const count = Math.min(6, g.readUInt32LE(game.party - 4));
    const party = [];
    for (let i = 0; i < count; i++) {
      const mon = decipher(g.subarray(game.party + i * PARTY_SIZE, game.party + (i + 1) * PARTY_SIZE));
      if (mon) party.push(mon);
    }
    const names = game.boxes + BOXES * PER_BOX * BOX_SIZE;
    const boxes = Array.from({ length: BOXES }, (_, b) => ({
      name: codes(s.subarray(names + b * BOX_NAME, names + (b + 1) * BOX_NAME), 20),
      pokemon: Array.from({ length: PER_BOX }, (_, i) => {
        const at = game.boxes + (b * PER_BOX + i) * BOX_SIZE;
        return decipher(s.subarray(at, at + BOX_SIZE));
      })
    }));
    const t = game.trainer;
    return { game: id, gameName: game.name, trainer: codes(g.subarray(t, t + 16), 8), trainerId: g.readUInt16LE(t + 0x10),
      secretId: g.readUInt16LE(t + 0x12), party, boxes };
  }
  throw new Error("This isn't a Pokémon Diamond, Pearl or Platinum save, or it's damaged. (HeartGold and SoulSilver saves can't be read yet.)");
}

module.exports = { SAVE_SIZE, GAMES, parse, decipher, cipher, crc16, codes, BOX_SIZE, PARTY_SIZE };
