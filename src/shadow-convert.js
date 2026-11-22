'use strict';

// Shadowtrade between Colosseum and XD: a Shadow Pokémon from the other game, made this game's. The Pokémon itself goes
// across as Online Trades take one (trade-convert.js read and write: Colosseum's 0x138 bytes, XD's 0xC4, in each game's
// numbers). The Shadow part is each game's own and doesn't travel as it is:
//   - A Shadow's Shadow moves, its heart gauge's size, the level it's caught at and its purification EXP are its story
//     id's, from the game's tables (Colosseum: Shadow Rush; XD: the id's DDPK row), and the Pokémon keeps only its
//     ordinary moves. So it becomes one of this game's story Shadows: the one of its species if the story has it, else
//     the one nearest its level. It gets an entry of its own in the save as every received Shadow does
//     (save-pokemon.js giveTo), under that story id.
//   - The heart gauge goes across as how full it is: the sender's gauge over its story Shadow's full gauge, times the
//     new one's (generations/shadow-story.json has both games' full gauges, from the discs).
//   - Colosseum keeps the gauge, banked EXP and banked friendship in the Pokémon (+0xDC, +0xE0, +0xE4); XD keeps them in
//     its save's record for the id (0x48 bytes: darkPoint +0x24, poolExp in +0x04's top 20 bits, poolFriend +0x18), so
//     one going to XD gets a record made for it, as a snag's would be (status snagged, its personality, IVs, ball and
//     trainer, the id's Hyper Mode column), which the save then merges as it does any received record. Hyper Mode
//     itself doesn't come across: it ends when a Pokémon leaves a battle anyway.
// Shadowtrade's plain pools only: a randomizer's story ids mean other Pokémon, so its runs keep to their own game.
const convert = require('./trade-convert');
const story = require('./generations/shadow-story.json');

const SHADOW_AT = { colosseum: 0xd8, xd: 0xba };
const COLOSSEUM = { gauge: 0xdc, poolExp: 0xe0, poolFriend: 0xe4 };
const XD_RECORD = { size: 0x48, ball: 0x06, ivs: 0x0b, poolFriend: 0x18, species: 0x1a, rnd: 0x1c, gauge: 0x24, trainerName: 0x28, id: 0x3e, revers: 0x40 };
const XD_SNAGGED = 3, POOL_EXP_MAX = 0xfffff, POOL_FRIEND_MAX = 0xff;

const storyOf = (game, id) => story[game][String(id)] || null;

// This game's story id for a Pokémon of `species` (Colosseum's numbers) and `level`: its species's if the story has
// it, else the nearest level's (the lowest id of those as near).
function storyIdFor(game, species, level) {
  const rank = ([key, entry]) => [convert.speciesToColosseum(game, entry.species) === species ? 0 : 1, Math.abs(entry.level - level), Number(key)];
  const before = (a, b) => { const i = a.findIndex((v, k) => v !== b[k]); return i >= 0 && a[i] < b[i]; };
  return Object.entries(story[game]).map(rank).reduce((best, each) => (before(each, best) ? each : best))[2];
}

// How full a Shadow's heart gauge is, from 0 (open: ready to purify) to 1, and its banked EXP and friendship.
function shadowState(game, data, record) {
  const id = data.readUInt16BE(SHADOW_AT[game]), full = storyOf(game, id)?.gauge;
  if (!full) throw new Error('The Pokémon received isn\'t a Shadow Pokémon of the other game\'s story.');
  if (game === 'colosseum') {
    return { id, full: Math.min(Math.max(data.readInt32BE(COLOSSEUM.gauge) / full, 0), 1),
      poolExp: data.readUInt32BE(COLOSSEUM.poolExp), poolFriend: data.readUInt16BE(COLOSSEUM.poolFriend) };
  }
  if (!record || record.length !== XD_RECORD.size || (record[0] >> 5) !== XD_SNAGGED) throw new Error('The Pokémon received is damaged.');
  return { id, full: Math.min(Math.max(record.readInt32BE(XD_RECORD.gauge) / full, 0), 1),
    poolExp: record.readUInt32BE(0x04) >>> 12, poolFriend: record.readUInt16BE(XD_RECORD.poolFriend) };
}

// An XD record for a Shadow received as story id `id` (save-pokemon.js mergeXdRecord then adds the save's own parts:
// where it is, the Shadow Monitor's order and marks).
function xdRecord(p, id, state) {
  const r = Buffer.alloc(XD_RECORD.size), entry = storyOf('xd', id);
  r.writeUInt32BE((XD_SNAGGED << 29) >>> 0, 0);
  r.writeUInt32BE(((Math.min(state.poolExp, POOL_EXP_MAX) << 12) | ((p.ball & 0x0f) << 8)) >>> 0, 0x04);
  p.ivs.forEach((value, i) => { r[XD_RECORD.ivs + i] = value & 0x1f; });
  r.writeUInt16BE(Math.min(state.poolFriend, POOL_FRIEND_MAX), XD_RECORD.poolFriend);
  r.writeUInt16BE(convert.speciesFromColosseum('xd', p.species), XD_RECORD.species);
  r.writeUInt32BE(p.rnd >>> 0, XD_RECORD.rnd);
  r.writeInt32BE(Math.round(state.full * entry.gauge), XD_RECORD.gauge);
  const end = p.otName.indexOf(0);
  (end < 0 ? p.otName : p.otName.slice(0, end)).slice(0, 10).forEach((unit, i) => r.writeUInt16BE(unit, XD_RECORD.trainerName + 2 * i));
  r.writeUInt16BE(id, XD_RECORD.id);
  r[XD_RECORD.revers] = entry.revers;
  return r;
}

// The Shadow Pokémon `received` ({ data, record? } as Buffers) of `fromGame`, made `toGame`'s: { data, record (XD) or
// null, storyId }. receiver: { laterPokemon, laterMoves } (the game's Generation 4 setting). A move or held item the
// receiver's game can't have is left behind rather than keeping the Pokémon from arriving (the server has already
// matched it): only the Shadow Pokémon of a plain story travel, which know and hold only what both games have.
function shadowFor(fromGame, received, toGame, receiver = {}) {
  const data = Buffer.from(received.data), record = received.record ? Buffer.from(received.record) : null;
  if (data.length !== convert.SIZE[fromGame]) throw new Error('The Pokémon received is damaged.');
  const state = shadowState(fromGame, data, record);
  const p = convert.read(fromGame, data);
  const found = convert.problems(p, { game: toGame, laterPokemon: Boolean(receiver.laterPokemon), laterMoves: Boolean(receiver.laterMoves || receiver.laterPokemon) });
  const codes = new Set(found.map(each => each.code));
  for (const code of ['egg', 'invalid', 'pack', 'later-species']) {
    if (codes.has(code)) throw new Error(found.find(each => each.code === code).text.replace('This Pokémon', 'The Pokémon received'));
  }
  if (codes.has('later-move') || codes.has('move')) {
    const kept = p.moves.filter(m => !m.shadow && m.id >= 1 && m.id <= 470 && (receiver.laterMoves || receiver.laterPokemon || m.id < 358));
    p.moves = kept.length ? kept : p.moves.slice(0, 1);
  }
  if (codes.has('key-item') || codes.has('item') || codes.has('later-item')) p.item = 0;
  const id = storyIdFor(toGame, p.species, p.level);
  const out = convert.write(toGame, p);
  out.writeUInt16BE(id, SHADOW_AT[toGame]);
  if (toGame === 'colosseum') {
    out.writeInt32BE(Math.round(state.full * storyOf('colosseum', id).gauge), COLOSSEUM.gauge);
    out.writeUInt32BE(state.poolExp >>> 0, COLOSSEUM.poolExp);
    out.writeUInt16BE(Math.min(state.poolFriend, POOL_FRIEND_MAX), COLOSSEUM.poolFriend);
    return { data: out, record: null, storyId: id };
  }
  return { data: out, record: xdRecord(p, id, state), storyId: id };
}

module.exports = { shadowFor, storyIdFor, shadowState };
