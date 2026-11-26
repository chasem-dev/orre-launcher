'use strict';

// The Pokémon Colosseum Bonus Disc (PC6E01, North America): its WISHMAKER Jirachi, read from the player's own disc.
//
// The disc's tgc/pokedownload.tgc is a GameCube program of its own (a TGC: a disc image inside the disc). It sends
// client.bin to the Game Boy Advance over the link cable, and that program makes Jirachi in the GBA's Ruby or Sapphire
// save. The program is mostly LZ77-compressed (the GBA BIOS's kind, type 0x10); unpacked, it is loaded at 0x02010000
// and keeps everything the gift is made of: the Pokémon to give (level, species, moves), its trainer (WISHMKR, ID
// 20043), Jirachi's base stats, level-up moves and experience table, the move table (for PP) and the nature table.
// src/wishmaker.js makes the Pokémon from these exactly as the program does. Nothing of the disc is kept by the
// launcher; this reads it each time.

const crypto = require('node:crypto');
const { Disc, parseFst } = require('./disc');

const GAME_ID = 'PC6E01';
const TGC_FILE = 'tgc/pokedownload.tgc';
const TGC_MAGIC = 0xAE0F38A2;
const CLIENT = 'client.bin';
// The unpacked program on the North American disc: the one this reads, by offsets in it.
const CLIENT_SHA1 = '15cc339ac4095fd8e25bbf1c6c9bec54ca879309';
const LOAD = 0x02010000;
const at = address => address - LOAD;

// Where the program keeps each part (its EWRAM addresses). The gift: a 7-character name, then the level (u16), the
// species (u16), 4 moves (0: the species' own at that level) and a held item (u16, replaced by the berry drawn below);
// then its trainer: a pointer to the name, the ID (u32, the secret ID above) and the trainer's gender.
const GIFT = { name: at(0x02019E82), level: at(0x02019E8C), species: at(0x02019E8E), moves: at(0x02019E90),
  otName: at(0x02019EA4), otId: at(0x02019EB0), otGender: at(0x02019EB4) };
const BASE_STATS = at(0x020199C0);       // Jirachi's: 6 stats, types, ..., friendship +0x12, growth +0x13, abilities +0x16
const LEVEL_UP = at(0x020199DC);         // Jirachi's level-up moves: level << 9 | move, to 0xFFFF
const EXPERIENCE = at(0x020186B4);       // experience for each growth rate (101 u32 each, by level)
const MOVES = at(0x02017610);            // the move table: 12 bytes a move, its PP at +4
const NATURES = at(0x02017590);          // 25 natures x 5 stats (Attack, Defense, Speed, Sp. Atk, Sp. Def): +1, -1 or 0
const MET_GAME = at(0x020199F6);         // the game it was met in (2: Ruby), and its language (2: English)
const LANGUAGE = at(0x020199F7);
// Immediates of the code (Thumb "movs r0, #n"): the two berries the held item is drawn from (odd, then even), the
// ball, and the place it was met.
const CODE = { oddItem: at(0x02013364), evenItem: at(0x0201337A), ball: at(0x020107BA), metLocation: at(0x02010798) };

// The GBA BIOS's LZ77 (SWI 0x11): a 0x10 byte and the unpacked size, then flag bytes, high bit first, 1 a copy of
// 3 to 18 bytes from up to 4096 back.
function lz77(data, from) {
  if (data[from] !== 0x10) throw new Error("The Bonus Disc's GBA program isn't packed as expected.");
  const size = data.readUInt32LE(from) >>> 8, out = Buffer.alloc(size);
  let i = from + 4, o = 0;
  while (o < size) {
    const flags = data[i++];
    for (let bit = 0x80; bit && o < size; bit >>= 1) {
      if (!(flags & bit)) { out[o++] = data[i++]; continue; }
      const pair = data[i] << 8 | data[i + 1], length = (pair >> 12) + 3, back = (pair & 0xFFF) + 1;
      i += 2;
      if (back > o) throw new Error("The Bonus Disc's GBA program is damaged.");
      for (let k = 0; k < length && o < size; k++, o++) out[o] = out[o - back];
    }
    if (i > data.length) throw new Error("The Bonus Disc's GBA program is damaged.");
  }
  return out;
}

// The program's packed part starts after its header and a small unpacker: the first LZ77 stream that unpacks to it.
function unpackClient(client) {
  for (let from = 0xC0; from + 4 < client.length; from += 4) {
    if (client[from] !== 0x10) continue;
    const size = client.readUInt32LE(from) >>> 8;
    if (size < 0x8000 || size > 0x40000) continue;
    try {
      const out = lz77(client, from);
      if (crypto.createHash('sha1').update(out).digest('hex') === CLIENT_SHA1) return out;
    } catch (_) { /* not the stream */ }
  }
  throw new Error("This Bonus Disc's Jirachi program isn't the North American one the launcher knows.");
}

// A file inside the TGC: its header (0x10 the file table, 0x24 where its files are, 0x34 the address its table
// counts them from) and its file system table.
function tgcFile(disc, tgc, name) {
  const header = disc.read(tgc.offset, 0x38);
  if (header.readUInt32BE(0) !== TGC_MAGIC) throw new Error("The Bonus Disc's download program isn't there.");
  const fst = disc.read(tgc.offset + header.readUInt32BE(0x10), header.readUInt32BE(0x14));
  const entry = parseFst(fst).get(name);
  if (!entry) throw new Error(`The Bonus Disc's download program has no ${name}.`);
  return disc.read(tgc.offset + entry.offset - header.readUInt32BE(0x34) + header.readUInt32BE(0x24), entry.size);
}

// What a Thumb "movs r0, #n" at `offset` loads.
function immediate(program, offset) {
  if (program[offset + 1] !== 0x20) throw new Error("The Bonus Disc's Jirachi program isn't the one the launcher knows.");
  return program[offset];
}

// The gift, from the unpacked program: everything src/wishmaker.js needs to make it.
function gift(program) {
  const base = program.subarray(BASE_STATS, BASE_STATS + 28);
  const levelUp = [];
  for (let i = LEVEL_UP; ; i += 2) {
    const entry = program.readUInt16LE(i);
    if (entry === 0xFFFF) break;
    levelUp.push({ level: entry >> 9, move: entry & 0x1FF });
  }
  const growth = base[0x13];
  const otNameAt = at(program.readUInt32LE(GIFT.otId - 4));
  // the species' name as the nickname: to its end (0xFF), the rest of the 10 bytes 0xFF as well
  const name = program.subarray(GIFT.name, GIFT.name + 10), end = name.indexOf(0xFF);
  const nickname = Buffer.alloc(10, 0xFF);
  name.copy(nickname, 0, 0, end < 0 ? 10 : end);
  return {
    species: program.readUInt16LE(GIFT.species), level: program.readUInt16LE(GIFT.level),
    moves: [0, 1, 2, 3].map(i => program.readUInt16LE(GIFT.moves + 2 * i)),
    nickname, otName: program.subarray(otNameAt, otNameAt + 7),
    otId: program.readUInt32LE(GIFT.otId), otGender: program[GIFT.otGender],
    baseStats: [...base.subarray(0, 6)], friendship: base[0x12], ability: base[0x16],
    experience: level => program.readUInt32LE(EXPERIENCE + growth * 101 * 4 + level * 4),
    levelUp, pp: move => program[MOVES + move * 12 + 4],
    natures: Array.from({ length: 25 }, (_, n) => [...program.subarray(NATURES + n * 5, NATURES + n * 5 + 5)].map(v => (v << 24) >> 24)),
    items: [immediate(program, CODE.oddItem), immediate(program, CODE.evenItem)],
    ball: immediate(program, CODE.ball), metLocation: immediate(program, CODE.metLocation),
    metGame: program[MET_GAME], language: program[LANGUAGE]
  };
}

// The Bonus Disc at `file` (an ISO, GCM or CISO, as the game's disc): its Jirachi gift. Throws with a reason for players.
function read(file) {
  let disc;
  try {
    disc = new Disc(file);
  } catch (error) {
    throw new Error(`That file can't be read as a GameCube disc: ${error.message}`);
  }
  try {
    if (disc.gameId !== GAME_ID) throw new Error(disc.gameId.startsWith('PC6')
      ? "That's another region's Bonus Disc: the launcher knows the North American one (PC6E01)."
      : "That isn't the Pokémon Colosseum Bonus Disc (PC6E01).");
    const tgc = disc.files.get(TGC_FILE);
    if (!tgc) throw new Error("That Bonus Disc has no Jirachi download program.");
    return gift(unpackClient(tgcFile(disc, tgc, CLIENT)));
  } finally {
    disc.close();
  }
}

// The same gift without the disc, for players who haven't one: what read() gives for the North American disc, written
// out (test/wishmaker.test.js compares the two when a disc is at hand). Facts about one Pokémon and the games' rules,
// not the disc's data: the nature table is the games' rule (nature n raises stat n / 5 and lowers stat n % 5, in the
// order Attack, Defense, Speed, Sp. Atk, Sp. Def; neutral when they are the same), and the experience is the Slow
// growth rate's (5n³ / 4), Jirachi's.
const NAME_JIRACHI = [0xC4, 0xC3, 0xCC, 0xBB, 0xBD, 0xC2, 0xC3];   // JIRACHI, in the games' characters
const NAME_WISHMKR = [0xD1, 0xC3, 0xCD, 0xC2, 0xC7, 0xC5, 0xCC];   // WISHMKR
const PP = { 273: 10, 93: 25, 156: 10 };                             // Wish, Confusion, Rest
function builtIn() {
  const nickname = Buffer.alloc(10, 0xFF);
  Buffer.from(NAME_JIRACHI).copy(nickname);
  return {
    species: 409, level: 5, moves: [0, 0, 0, 0], nickname, otName: Buffer.from(NAME_WISHMKR), otId: 20043, otGender: 0,
    baseStats: [100, 100, 100, 100, 100, 100], friendship: 100, ability: 32,
    experience: level => Math.floor(5 * level ** 3 / 4),
    levelUp: [{ level: 1, move: 273 }, { level: 1, move: 93 }, { level: 5, move: 156 }],
    pp: move => PP[move] || 0,
    natures: Array.from({ length: 25 }, (_, n) => [0, 1, 2, 3, 4].map(stat =>
      Math.floor(n / 5) === n % 5 ? 0 : stat === Math.floor(n / 5) ? 1 : stat === n % 5 ? -1 : 0)),
    items: [169, 170], ball: 4, metLocation: 255, metGame: 2, language: 2
  };
}

module.exports = { GAME_ID, CLIENT_SHA1, read, gift, lz77, builtIn };
