'use strict';

// The randomizer's settings, and what a save says about its run. The game does the choosing
// (host/randomizer.c in the port): a new save takes the setting, and keeps its seed from then on.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { newestPlain } = require('./gci-save');
const xdSave = require('./xd-save');
const saves = require('./saves');
const savePokemon = require('./save-pokemon');

// What can change, as the game's stamp holds it.
const OPTIONS = { randomizerStarters: 1, randomizerShadow: 2, randomizerTrainers: 4, randomizerGifts: 8, randomizerSimilar: 16, randomizerNoLegendaries: 32,
  randomizerPacks: 64, randomizerNoRepeats: 128, randomizerBaseForms: 256 };
const PARTS = 15;
const PACKS = 64;   // Pokémon packs' own Pokémon too (src/pokemon-packs.js)
// No evolution family twice among the starters and Shadow Pokémon, or in a trainer's team; and starters and Shadow
// Pokémon only of a first form. Options from 256 on are the stamp's byte 7.
const NO_REPEATS = 128;
const BASE_FORMS = 256;
// Similar strength's choices spread evenly over the Pokémon close in strength to the one replaced (within 10% of its base
// stats, widened only when too few are), so a run of few generations doesn't give the same few Pokémon to most trainers.
// Sent with similar strength whenever the game knows it; not a setting of its own.
const SPREAD = 512;
// A pack's own Pokémon in the game's spoiler log: this much past its place in the species table, as it may share its base's number.
const PACK_SPECIES = 0x10000;
const GENERATIONS = { randomizerGen1: 1, randomizerGen2: 2, randomizerGen3: 4, randomizerGen4: 8, randomizerGen5: 16, randomizerGen6: 32 };
const GAME_GENERATIONS = 7;   // the game's own: the first three
const GEN4 = 8, GEN5 = 16, GEN6 = 32, GEN56 = GEN5 | GEN6;

// The stamp, in a save's unscrambled slot: its place in the body, past where the body starts.
const STAMP = 8 + 0x1df80;
const STAMP_SIZE = 0x20;
const STAMP_MAGIC = 0x43524e44;
const STAMP_VERSION = 1;
const CHECK = 0x5eedc01d;
// Byte written to a snagged story Shadow Pokémon's record (host/randomizer.c: Colosseum +0x13, XD +0x43) so changing or
// removing the save's randomizer stamp keeps what the player actually snagged in the Snag List / Shadow Monitor.
const FROZEN_MARK = 0xd2;
const COLOSSEUM_RECORD = id => 0x1b4ac + 0x18 * id;
const XD_STORY_SHADOWS = 83;
const XD_RECORD_SIZE = 0x48;
const XD_RECORD_SPECIES = 0x1a;
const XD_RECORD_FROZEN = 0x43;

const SAVE_FILE = 'pokemon_colosseum.dat';
// Each game's card file, and where its stamp is in the save it loads: XD keeps it in reserve 1's room of its pack
// (host/randomizer.c), which moves from save to save (xd-save.js).
const SAVES = {
  colosseum: { file: SAVE_FILE, read: data => ({ plain: newestPlain(data).plain, at: STAMP }) },
  xd: { file: 'PokemonXD.dat', read: data => {
    const pack = xdSave.newestPack(data);
    if (!pack) throw new Error('no save the game would load');
    return { plain: pack.plain, at: xdSave.stampAt(pack.plain) };
  } }
};
const saveOf = gameId => SAVES[gameId] || SAVES.colosseum;
const SPOILER_FILE = 'randomizer-spoiler.txt';

function newSeed() { return crypto.randomBytes(4).toString('hex').toUpperCase(); }

function normalizeSeed(input) {
  const seed = String(input ?? '').trim().toUpperCase();
  return /^[0-9A-F]{1,8}$/.test(seed) ? seed.padStart(8, '0') : '';
}

// The settings as they are kept: on, a seed once it's on, and at least one generation, as a run needs one. The fourth
// counts only with Generation 4 Pokémon added (environmentValue), and is chosen to start with, as the first three are.
// So are Pokémon packs' Pokémon, which count only when there are some.
function normalize(input = {}) {
  const settings = { randomizer: Boolean(input.randomizer), randomizerSeed: normalizeSeed(input.randomizerSeed),
    randomizerStarters: input.randomizerStarters !== false, randomizerShadow: input.randomizerShadow !== false,
    randomizerTrainers: Boolean(input.randomizerTrainers), randomizerGifts: Boolean(input.randomizerGifts),
    randomizerSimilar: input.randomizerSimilar !== false, randomizerNoLegendaries: Boolean(input.randomizerNoLegendaries),
    randomizerGen1: input.randomizerGen1 !== false, randomizerGen2: input.randomizerGen2 !== false, randomizerGen3: input.randomizerGen3 !== false,
    randomizerGen4: input.randomizerGen4 !== false, randomizerGen5: input.randomizerGen5 !== false, randomizerGen6: input.randomizerGen6 !== false,
    randomizerPacks: input.randomizerPacks !== false,
    randomizerNoRepeats: Boolean(input.randomizerNoRepeats), randomizerBaseForms: Boolean(input.randomizerBaseForms) };
  if (!settings.randomizerGen1 && !settings.randomizerGen2 && !settings.randomizerGen3 && !settings.randomizerGen4 && !settings.randomizerGen5 && !settings.randomizerGen6)
    settings.randomizerGen1 = settings.randomizerGen2 = settings.randomizerGen3 = settings.randomizerGen4 = settings.randomizerGen5 = settings.randomizerGen6 = true;
  if (settings.randomizer && !settings.randomizerSeed) settings.randomizerSeed = newSeed();
  return settings;
}

function flags(settings, table) {
  return Object.entries(table).reduce((bits, [key, bit]) => (settings[key] ? bits | bit : bits), 0);
}

// Whether a run would have the fourth generation: it's chosen, its Pokémon are added (settings.generationPokemon), and
// the game knows it (laterGenerations: a game before it would stamp the save with it and ignore it, and the run would
// change once the game updates).
const hasGen4 = (settings, laterGenerations) => Boolean(settings.randomizerGen4 && laterGenerations
  && Array.isArray(settings.generationPokemon) && settings.generationPokemon.includes(4));
const hasGen56 = (settings, gen6Randomizer) => Boolean((settings.randomizerGen5 || settings.randomizerGen6) && gen6Randomizer
  && Array.isArray(settings.generationPokemon) && settings.generationPokemon.includes(6));

// The run these settings would stamp into a save ({ seed, options, generations }), or null when a save should be the
// normal game. A run of only later generations without their Pokémon is a run of the game's own three. packPokemon: the
// player has Pokémon packs' Pokémon and the game can choose them. Without them the run isn't one with packs, so it stays
// as it is when a pack is added later. noRepeats and baseForms: the game knows those options (a game before them would
// keep only the first eight bits). spread: the game spreads similar strength's choices (SPREAD); a save keeps how its
// run was made.
function plannedRun(settings, { laterGenerations = false, gen6Randomizer = false, packPokemon = false, noRepeats = false, baseForms = false, spread = false } = {}) {
  let options = flags(settings, OPTIONS) & (packPokemon ? ~0 : ~PACKS) & (noRepeats ? ~0 : ~NO_REPEATS) & (baseForms ? ~0 : ~BASE_FORMS);
  if (spread && (options & OPTIONS.randomizerSimilar)) options |= SPREAD;
  if (!settings.randomizer || !settings.randomizerSeed || !(options & PARTS)) return null;
  const mask = GAME_GENERATIONS | (hasGen4(settings, laterGenerations) ? GEN4 : 0) | (hasGen56(settings, gen6Randomizer) ? GEN56 : 0);
  let generations = flags(settings, GENERATIONS) & mask;
  if (!generations) generations = GAME_GENERATIONS;
  return { seed: settings.randomizerSeed, options, generations };
}

// COLO_RANDOMIZER for these settings, or null when a new save should be the normal game.
function environmentValue(settings, capabilities = {}) {
  const run = plannedRun(settings, capabilities);
  return run ? `${run.seed}:${run.options}:${run.generations}` : null;
}

// Whether two runs have the same seed, visible switches and generations (SPREAD is an internal choice-distribution flag,
// not a player-facing switch).
function runsEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.seed === b.seed && (a.options & ~SPREAD) === (b.options & ~SPREAD) && a.generations === b.generations;
}

// The run a save's unscrambled slot holds, or null for the normal game. at: where the stamp is (XD's moves).
function runOf(plain, at = STAMP) {
  if (at < 0 || plain.length < at + 16 || plain.readUInt32BE(at) !== STAMP_MAGIC || plain[at + 4] !== STAMP_VERSION) return null;
  const options = plain[at + 5] | plain[at + 7] << 8, generations = plain[at + 6], seed = plain.readUInt32BE(at + 8);
  const expected = (seed ^ CHECK ^ (plain[at + 5] << 8) ^ generations ^ (plain[at + 7] << 16)) >>> 0;
  if (plain.readUInt32BE(at + 12) !== expected) return null;
  return { seed: seed.toString(16).toUpperCase().padStart(8, '0'), options, generations };
}

// Writes a run's stamp at `at` (matching host/randomizer.c write_stamp_in), or clears it when `run` is null.
function writeStamp(plain, at, run) {
  if (at < 0 || plain.length < at + STAMP_SIZE) throw new Error('Save buffer is too small for the randomizer stamp.');
  plain.fill(0, at, at + STAMP_SIZE);
  if (!run) return;
  const seed = parseInt(normalizeSeed(run.seed), 16) >>> 0;
  const options = Number(run.options) & 0xffff;
  const generations = Number(run.generations) & 0xff;
  if (!normalizeSeed(run.seed) || !(options & PARTS) || !(generations & 63)) return;
  plain.writeUInt32BE(STAMP_MAGIC, at);
  plain[at + 4] = STAMP_VERSION;
  plain[at + 5] = options & 0xff;
  plain[at + 6] = generations;
  plain[at + 7] = (options >> 8) & 0xff;
  plain.writeUInt32BE(seed, at + 8);
  plain.writeUInt32BE((seed ^ CHECK ^ ((options & 0xff) << 8) ^ generations ^ (((options >> 8) & 0xff) << 16)) >>> 0, at + 12);
}

// What gameId's save in a memory card folder is: { exists: false }, or whether it's a run and which.
function readSave(saveDirectory, gameId = 'colosseum') {
  const save = saveOf(gameId);
  let data;
  try { data = fs.readFileSync(path.join(saveDirectory, save.file)); }
  catch (_) { return { exists: false, run: null }; }
  try {
    const { plain, at } = save.read(data);
    return { exists: true, run: runOf(plain, at) };
  } catch (_) { return { exists: false, run: null }; }
}

// readSave, read again only when the save file changes (or after invalidate()).
function createSaveReader() {
  let known = null;
  const reader = (saveDirectory, gameId = 'colosseum') => {
    const { file } = saveOf(gameId);
    let stamp = `${gameId}:${saveDirectory}`;
    try {
      const stat = fs.statSync(path.join(saveDirectory, file));
      stamp += `:${stat.size}:${stat.mtimeMs}:${stat.ino}`;
    } catch (_) { stamp += ':none'; }
    if (known?.stamp !== stamp) known = { stamp, save: readSave(saveDirectory, gameId) };
    return known.save;
  };
  reader.invalidate = () => { known = null; };
  return reader;
}

// What each game's spoilers call its parts: XD starts with one Eevee, and its gifts are trades and Mt. Battle's.
const SPOILER_TEXT = {
  colosseum: { title: 'Pokémon Colosseum randomizer', starters: 'Starters', gifts: 'Gifts' },
  xd: { title: 'Pokémon XD: Gale of Darkness randomizer', starters: 'Starter', gifts: 'Gifts and trades' }
};

// The game's spoiler log (what host/randomizer.c writes) as a player reads it. Teams' rows are
// left out: thousands of lines, and each trainer's turn to surprise (in XD a row is its deck's kind * 4096 plus its
// row, which says nothing to a player either). species are named by their National Pokédex
// numbers, and packs (Pokémon packs' own, { packId, name }) by their places in the species table.
function spoilerText(raw, species, packs = [], gameId = 'colosseum') {
  const words = SPOILER_TEXT[gameId] || SPOILER_TEXT.colosseum;
  const nameOf = number => number >= PACK_SPECIES
    ? packs.find(entry => entry.packId === number - PACK_SPECIES)?.name || 'a Pokémon of a pack that isn\'t here now'
    : species.find(entry => entry.national === number)?.name || `#${number}`;
  const lines = String(raw).trim().split('\n'), [, seed] = (lines[0] || '').split(' ');
  const out = [`${words.title}: seed ${seed}`, ''];
  const section = (title, kind, describe) => {
    const items = lines.map(line => line.split(' ')).filter(parts => parts[0] === kind);
    if (items.length) out.push(title, ...items.map(describe), '');
  };
  const swap = ([, was, now]) => `  ${nameOf(Number(was))} is now ${nameOf(Number(now))}`;
  section(words.starters, 'starter', swap);
  section(words.gifts, 'gift', swap);
  section('Shadow Pokémon', 'shadow', ([, , was, now]) => `  ${nameOf(Number(was))} is now ${nameOf(Number(now))}`);
  section('Extra Shadow Pokémon', 'extra', ([, , was, now]) => was === now
    ? `  ${nameOf(Number(now))}`
    : `  ${nameOf(Number(was))} is now ${nameOf(Number(now))}`);
  return out.join('\n');
}

const OPTION_NAMES = [['randomizerStarters', 'Starters'], ['randomizerShadow', 'Shadow Pokémon'], ['randomizerTrainers', 'Trainers\' Pokémon'],
  ['randomizerGifts', 'Gifts'], ['randomizerSimilar', 'Similar strength'], ['randomizerNoLegendaries', 'No legendaries'],
  ['randomizerNoRepeats', 'No repeats'], ['randomizerBaseForms', 'First forms only']];
const optionName = (key, name, gameId) => (key === 'randomizerStarters' && gameId === 'xd' ? 'Starter' : name);

function generationNames(generations) {
  return Object.values(GENERATIONS).map((bit, at) => (generations & bit ? `Gen ${at + 1}` : null)).filter(Boolean);
}

// One-line plain description of a run (or "Normal game" when null), shown when applying settings to an existing save.
function runSummary(run, gameId = 'colosseum') {
  if (!run) return 'Normal game';
  const on = OPTION_NAMES.filter(([key]) => run.options & OPTIONS[key]).map(([key, name]) => optionName(key, name, gameId));
  if (run.options & PACKS) on.push('Pokémon packs');
  const gens = generationNames(run.generations);
  return [`Seed ${run.seed}`, on.join(', '), gens.join(', ')].filter(Boolean).join(' · ');
}

function spoilerHeader(raw) {
  const match = String(raw || '').match(/^seed ([0-9A-F]{8})(?: options (\d+) generations (\d+))?/);
  if (!match) return null;
  return {
    seed: match[1],
    options: match[2] !== undefined ? Number(match[2]) : null,
    generations: match[3] !== undefined ? Number(match[3]) : null
  };
}

function spoilerSeed(raw) { return spoilerHeader(raw)?.seed || null; }

// Whether a spoiler log was written for this exact run (seed, options and generations).
function spoilerMatches(raw, run) {
  const head = spoilerHeader(raw);
  if (!head || !run || head.seed !== run.seed) return false;
  if (head.options !== null && head.options !== run.options) return false;
  if (head.generations !== null && head.generations !== run.generations) return false;
  return true;
}

// Shadow id -> logged species number (National Pokédex number, or PACK_SPECIES + id for a pack's own) from a spoiler log.
function parseSpoilerShadows(raw) {
  const out = new Map();
  for (const line of String(raw || '').split('\n')) {
    const parts = line.trim().split(' ');
    if (parts[0] === 'shadow' && parts.length >= 4) {
      const id = Number(parts[1]), now = Number(parts[3]);
      if (Number.isInteger(id) && id > 0 && Number.isInteger(now) && now > 0) out.set(id, now);
    }
  }
  return out;
}

function resolveLoggedSpecies(logged, speciesByNational) {
  if (!logged) return 0;
  if (logged >= PACK_SPECIES) return logged - PACK_SPECIES;
  return speciesByNational?.get(logged) || 0;
}

// Maps story Shadow id -> internal species id for Pokémon currently held in the save (party, PC boxes, day care, XD Purify Chamber).
function ownedShadowSpecies(ctx) {
  const shadowOffset = ctx.game === 'xd' ? savePokemon.XD.at.shadow : savePokemon.COLOSSEUM.at.shadow;
  const out = new Map();
  for (const place of savePokemon.allPlaces(ctx)) {
    const species = place.buffer.readUInt16BE(place.at);
    if (!species) continue;
    const shadowId = place.buffer.readUInt16BE(place.at + shadowOffset);
    if (shadowId && !out.has(shadowId)) out.set(shadowId, species);
  }
  return out;
}

// Freezes the Snag List / Shadow Monitor species on every already-snagged story Shadow Pokémon before the save's stamp
// changes, so previously snagged Pokémon keep their names under the new settings (or when reverting to the normal game).
function freezeSnaggedStoryShadows(ctx, oldRun, spoilerShadows, speciesByNational) {
  const owned = ownedShadowSpecies(ctx);
  const oldRandomizedShadows = Boolean(oldRun && (oldRun.options & OPTIONS.randomizerShadow));
  let frozen = 0;
  if (ctx.game === 'xd') {
    for (let id = 1; id <= XD_STORY_SHADOWS; id++) {
      const at = ctx.sections.darkPokemon + id * XD_RECORD_SIZE;
      if (at + XD_RECORD_SIZE > ctx.plain.length) continue;
      const status = ctx.plain[at] >> 5;
      if (status < savePokemon.XD_STATUS.snagged) continue;
      if (ctx.plain[at + XD_RECORD_FROZEN] === FROZEN_MARK) continue;
      if (oldRandomizedShadows) {
        const species = resolveLoggedSpecies(spoilerShadows.get(id), speciesByNational) || owned.get(id) || 0;
        if (species) ctx.plain.writeUInt16BE(species, at + XD_RECORD_SPECIES);
      }
      ctx.plain[at + XD_RECORD_FROZEN] = FROZEN_MARK;
      frozen++;
    }
    return frozen;
  }
  for (const id of savePokemon.COLOSSEUM_STORY_IDS) {
    if (!savePokemon.colosseumFlag(ctx.plain, 'snagged', id).set && !savePokemon.colosseumFlag(ctx.plain, 'purified', id).set) continue;
    const rec = COLOSSEUM_RECORD(id);
    if (rec + 0x18 > ctx.plain.length) continue;
    if (ctx.plain[rec + 0x13] === FROZEN_MARK) continue;
    if (oldRandomizedShadows) {
      const species = resolveLoggedSpecies(spoilerShadows.get(id), speciesByNational) || owned.get(id) || 0;
      if (species) ctx.plain.writeUInt16BE(species, rec + 0x10);
    }
    ctx.plain[rec + 0x13] = FROZEN_MARK;
    frozen++;
  }
  return frozen;
}

// Applies `run` (or clears the stamp when `run` is null) to every valid save copy on the card for `gameId`, backing up
// the memory card first and preserving Snag List / Shadow Monitor species for already-snagged story Shadow Pokémon.
function applyRunToSave(saveDirectory, run, { gameId = 'colosseum', backups = saves.backupRoot(), spoilerRaw = null, speciesByNational = null } = {}) {
  const current = readSave(saveDirectory, gameId);
  if (!current.exists) throw new Error('There is no save to update yet.');
  const backup = saves.backupSaves(saveDirectory, backups, 'before-randomizer-apply');
  const result = savePokemon.editCard(saveDirectory, gameId, ctx => {
    const at = ctx.game === 'xd' ? xdSave.stampAt(ctx.plain) : STAMP;
    const previous = runOf(ctx.plain, at);
    const spoilerShadows = previous && spoilerRaw && spoilerMatches(spoilerRaw, previous) ? parseSpoilerShadows(spoilerRaw) : new Map();
    const frozenCount = freezeSnaggedStoryShadows(ctx, previous, spoilerShadows, speciesByNational);
    writeStamp(ctx.plain, at, run);
    return { previous, run: runOf(ctx.plain, at), frozenCount };
  });
  return { ...result, backup: backup.directory || null };
}

module.exports = { OPTIONS, GENERATIONS, PACKS, NO_REPEATS, BASE_FORMS, SPREAD, SPOILER_FILE, FROZEN_MARK, hasGen4, hasGen56, newSeed, normalizeSeed, normalize, plannedRun, environmentValue, runsEqual, runOf, writeStamp, readSave, createSaveReader, spoilerText, spoilerHeader, spoilerSeed, spoilerMatches, parseSpoilerShadows, runSummary, applyRunToSave };
