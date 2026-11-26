'use strict';

// Gen 3 Pokémon saves (Ruby, Sapphire, Emerald, FireRed, LeafGreen), for the virtual GBA the game links
// with (its host/gba_virtual.c): which game, the trainer, the party, and whether it can link, read
// from the save file alone; and where players' emulators keep them.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SAVE_SIZE = 0x20000;
const SLOT_SIZE = 0xE000;
const SECTION = 0x1000;
const SECTIONS = 14;
const SIGNATURE = 0x08012025;
const SECTION_SIZES = [3884, 3968, 3968, 3968, 3848, 3968, 3968, 3968, 3968, 3968, 3968, 3968, 3968, 2000];
// From pret's decompilations (include/global.h): SaveBlock1's party, the Pokédex's two copies of the seen flags
// (seen1, seen2), and the gift ribbons, which ExternalEventData and then ExternalEventFlags follow (ribbons): the
// port's host/gba_virtual.c has the same table.
const GAMES = {
  rs: { name: 'Ruby/Sapphire', partyCount: 0x234, party: 0x238, flags: 0x1220, seen1: 0x938, seen2: 0x3A8C, ribbons: 0x3110, region: 'Hoenn' },
  frlg: { name: 'FireRed/LeafGreen', partyCount: 0x34, party: 0x38, seen1: 0x5F8, seen2: 0x3A18, ribbons: 0x309C, region: 'Kanto' },
  e: { name: 'Emerald', partyCount: 0x234, party: 0x238, seen1: 0x988, seen2: 0x3B24, ribbons: 0x31A8, region: 'Hoenn' }
};
// SaveBlock1's money: Emerald keeps it XORed with its key (SaveBlock2's 0xAC); Ruby/Sapphire keep it as it is.
const MONEY = 0x490, MAX_MONEY = 999999;
// SaveBlock1 runs on across sections 1 to 4, 0xF80 bytes of each.
const BLOCK = 0xF80;
// Gen 3's text: letters, digits and a few marks; the rest as '?'.
function text(bytes) {
  let out = '';
  for (const c of bytes) {
    if (c === 0xFF) break;
    if (c >= 0xBB && c <= 0xD4) out += String.fromCharCode(65 + c - 0xBB);
    else if (c >= 0xD5 && c <= 0xEE) out += String.fromCharCode(97 + c - 0xD5);
    else if (c >= 0xA1 && c <= 0xAA) out += String.fromCharCode(48 + c - 0xA1);
    else if (c === 0x00) out += ' ';
    else if (c === 0xAD) out += '.';
    else if (c === 0xAE) out += '-';
    else if (c === 0xB4) out += "'";
    else out += '?';
  }
  return out.trim();
}

function checksum(data, size) {
  let sum = 0;
  for (let i = 0; i + 3 < size; i += 4) sum = (sum + data.readUInt32LE(i)) >>> 0;
  return ((sum >>> 16) + sum) & 0xFFFF;
}

// A slot's sections by id, and its save counter; null unless every section is there and intact.
function slotSections(buffer, slot) {
  const at = new Array(SECTIONS).fill(-1);
  let counter = null;
  for (let k = 0; k < SECTIONS; k++) {
    const base = slot * SLOT_SIZE + k * SECTION;
    const id = buffer.readUInt16LE(base + 0xFF4);
    if (buffer.readUInt32LE(base + 0xFF8) !== SIGNATURE || id >= SECTIONS || at[id] >= 0) return null;
    if (checksum(buffer.subarray(base), SECTION_SIZES[id]) !== buffer.readUInt16LE(base + 0xFF6)) return null;
    const c = buffer.readUInt32LE(base + 0xFFC);
    if (counter === null) counter = c; else if (c !== counter) return null;
    at[id] = base;
  }
  return { at, counter };
}

// The order of a Pokémon's four 12-byte substructures (growth, attacks, EVs, misc) by personality % 24.
const ORDERS = ['GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG',
  'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG'];

// One party Pokémon (100 bytes): its species (the games' own numbering), level, nickname and language.
function pokemon(data) {
  const personality = data.readUInt32LE(0), otId = data.readUInt32LE(4);
  if (!personality && !otId) return null;
  const key = (personality ^ otId) >>> 0;
  const growth = ORDERS[personality % 24].indexOf('G') * 12;
  const species = (data.readUInt32LE(0x20 + growth) ^ key) & 0xFFFF;
  return { species, level: data[0x54], nickname: text(data.subarray(8, 18)), language: data[0x12], otId };
}

// The newer whole copy of the save: its trainer (SaveBlock2), its SaveBlock1 (the party) and its PC (PokemonStorage:
// the current box, 14 boxes of 30 80-byte Pokémon, their names), and which game it is. Throws with a reason for players.
function blocks(buffer) {
  if (buffer.length < SAVE_SIZE) throw new Error("This isn't a Pokémon Ruby, Sapphire, Emerald, FireRed or LeafGreen save: it's too small.");
  const slots = [slotSections(buffer, 0), slotSections(buffer, 1)].map((s, slot) => s && { ...s, slot });
  const live = slots.filter(Boolean).sort((a, b) => b.counter - a.counter)[0];
  if (!live) throw new Error("This isn't a Pokémon Ruby, Sapphire, Emerald, FireRed or LeafGreen save, or it's damaged.");
  const sb2 = buffer.subarray(live.at[0], live.at[0] + 0xF80);
  const sb1 = Buffer.concat([1, 2, 3, 4].map(id => buffer.subarray(live.at[id], live.at[id] + 0xF80)));
  const storage = Buffer.concat([5, 6, 7, 8, 9, 10, 11, 12, 13].map(id => buffer.subarray(live.at[id], live.at[id] + SECTION_SIZES[id])));
  const gameId = gameOf(sb1, sb2);
  return { live, sb1, sb2, storage, gameId, game: GAMES[gameId] };
}

// Which game a save is, from the save alone. SaveBlock2's 0xAC is 1 in FireRed/LeafGreen, Emerald's key (any number)
// in Emerald, and in Ruby/Sapphire the Battle Tower's record, which is 0 until it holds the player's name. So past 0
// and 1 the money decides: a reading that gives more than the games allow ($999,999) is the wrong game's. Ruby's
// record there starts with the name's letters (0xA1 and up), so read as a key it makes any money too much; an
// Emerald key under 2^20 leaves both readings possible, and then it is Emerald, as before.
function gameOf(sb1, sb2) {
  const code = sb2.readUInt32LE(0xAC);
  if (code === 0) return 'rs';
  if (code === 1) return 'frlg';
  const money = sb1.readUInt32LE(MONEY);
  return money <= MAX_MONEY && ((money ^ code) >>> 0) > MAX_MONEY ? 'rs' : 'e';
}

// Where a byte of SaveBlock1 ('sb1') or SaveBlock2 ('sb2') of the newer copy is in the save file.
function place(live, block, offset) {
  if (block === 'sb2') return live.at[0] + offset;
  return live.at[1 + Math.floor(offset / BLOCK)] + offset % BLOCK;
}

// A section's checksum again after its bytes changed, at the file position of one of its bytes.
function resum(buffer, at) {
  const base = at - (at % SECTION);
  buffer.writeUInt16LE(checksum(buffer.subarray(base), SECTION_SIZES[buffer.readUInt16LE(base + 0xFF4)]), base + 0xFF6);
}

// The PC's boxes: { name, pokemon: [80-byte Pokémon or null] } for each of the 14
const BOXES = 14, PER_BOX = 30, BOX_MON = 80;
function boxes(storage) {
  const names = 4 + BOXES * PER_BOX * BOX_MON;
  return Array.from({ length: BOXES }, (_, b) => ({
    name: text(storage.subarray(names + b * 9, names + b * 9 + 9)),
    pokemon: Array.from({ length: PER_BOX }, (_, i) => {
      const at = 4 + (b * PER_BOX + i) * BOX_MON, data = storage.subarray(at, at + BOX_MON);
      return data.readUInt32LE(0) || data.readUInt32LE(4) ? data : null;
    })
  }));
}

// What the save is, or an error: { game, trainer, party, ... } or throws with a reason for players.
function parse(buffer) {
  const { live, sb1, sb2, gameId, game } = blocks(buffer);
  const partyCount = Math.min(6, sb1[game.partyCount]);
  const party = [];
  for (let i = 0; i < partyCount; i++) {
    const mon = pokemon(sb1.subarray(game.party + i * 100, game.party + (i + 1) * 100));
    if (mon) party.push(mon);
  }
  const trainerId = sb2.readUInt32LE(0x0A);
  const own = party.find(mon => mon.otId === trainerId);
  // Colosseum's link flags (gcnLinkFlags); Ruby and Sapphire keep none, and the Pokédex stands in
  // (FLAG_SYS_POKEDEX_GET, 0x801), as the game's virtual GBA reads it
  const linkFlags = gameId === 'rs' ? (sb1[game.flags + (0x801 >> 3)] >> (0x801 & 7)) & 1 : sb2.readUInt32LE(0xA8);
  return {
    game: gameId, gameName: game.name, region: game.region,
    trainer: text(sb2.subarray(0, 8)), gender: sb2[8] ? 'girl' : 'boy', trainerId: trainerId & 0xFFFF,
    playTime: `${sb2.readUInt16LE(0x0E)}:${String(sb2[0x10]).padStart(2, '0')}`,
    party, saves: live.counter,
    // Colosseum's own checks (the GBA side's flags): saved inside a Pokémon Center, and far enough along
    savedInPokemonCenter: (sb2[0x09] & 0x02) !== 0,
    linkUnlocked: (linkFlags & 1) !== 0,
    language: own ? own.language : 2
  };
}

function read(file) {
  let buffer;
  try { buffer = fs.readFileSync(file); }
  catch (error) { throw new Error(`Can't read ${path.basename(file)}: ${error.code || error.message}.`); }
  if (buffer.length > SAVE_SIZE + 0x100) throw new Error(`${path.basename(file)} isn't a GBA save: it's too big.`);
  return parse(buffer);
}

// What would stop Colosseum linking with this save, in the words the launcher shows, or ''.
function linkProblem(info) {
  if (!info.savedInPokemonCenter) return `Save inside a Pokémon Center in ${info.gameName} first: Colosseum links only with a game saved there.`;
  if (!info.linkUnlocked) return info.game === 'frlg'
    ? `${info.gameName} links with Colosseum after the National Pokédex: carry on in the game first.`
    : `${info.gameName} links with Colosseum once you have the Pokédex: carry on in the game first.`;
  if (info.language !== 2) return 'This copy of Colosseum links with the English GBA games.';
  return '';
}

// Where emulators keep GBA saves: RetroArch, OpenEmu, EmuDeck and mGBA's beside-the-game, plus the
// player's usual folders. Searched a few levels down for files of a Gen 3 save's size.
function searchFolders(platform = process.platform, env = process.env, home = os.homedir()) {
  const folders = [];
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    folders.push(path.join(appData, 'RetroArch', 'saves'), 'C:\\RetroArch-Win64\\saves', path.join(appData, 'mGBA'),
      path.join(home, 'Documents'), path.join(home, 'Downloads'), path.join(home, 'Games'));
  } else if (platform === 'darwin') {
    folders.push(path.join(home, 'Library', 'Application Support', 'RetroArch', 'saves'),
      path.join(home, 'Library', 'Application Support', 'OpenEmu', 'mGBA', 'Battery Saves'),
      path.join(home, 'Documents'), path.join(home, 'Downloads'), path.join(home, 'Games'));
  } else {
    folders.push(path.join(home, '.config', 'retroarch', 'saves'),
      path.join(home, '.var', 'app', 'org.libretro.RetroArch', 'config', 'retroarch', 'saves'),
      path.join(home, 'Emulation', 'saves'), path.join(home, '.config', 'mgba'),
      path.join(home, 'Documents'), path.join(home, 'Downloads'), path.join(home, 'Games'), path.join(home, 'ROMs'));
  }
  return folders;
}

// Gen 3 saves under the folders (a few levels down, at most `limit` looked at), newest first.
function findSaves(folders, { depth = 3, limit = 4000 } = {}) {
  const found = [], seen = new Set();
  let looked = 0;
  const walk = (dir, level) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (++looked > limit) return;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (level < depth && !entry.name.startsWith('.') && entry.name !== 'node_modules') walk(file, level + 1);
        continue;
      }
      if (!/\.(sav|srm)$/i.test(entry.name)) continue;
      let stat;
      try { stat = fs.statSync(file); } catch (_) { continue; }
      if (stat.size < SAVE_SIZE || stat.size > SAVE_SIZE + 0x100) continue;
      let real = file;
      try { real = fs.realpathSync(file); } catch (_) { /* as found */ }
      if (seen.has(real)) continue;
      seen.add(real);
      try { found.push({ path: file, modified: stat.mtimeMs, ...read(file) }); } catch (_) { /* not a Gen 3 save */ }
    }
  };
  for (const folder of folders) walk(folder, 0);
  return found.sort((a, b) => b.modified - a.modified);
}

module.exports = { SAVE_SIZE, GAMES, ORDERS, parse, read, blocks, boxes, pokemon, linkProblem, searchFolders, findSaves, text,
  gameOf, place, resum };
