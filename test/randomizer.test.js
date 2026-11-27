'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const randomizer = require('../src/randomizer');
const port = require('../src/port');
const gciSave = require('../src/gci-save');
const xdSave = require('../src/xd-save');
const saves = require('../src/saves');
const savePokemon = require('../src/save-pokemon');
const shadowEntries = require('../src/shadow-entries');

const on = (extra = {}) => randomizer.normalize({ randomizer: true, randomizerSeed: 'C0FFEE11', ...extra });

test('off, nothing reaches the game, and no seed is made', () => {
  const settings = randomizer.normalize({});
  assert.equal(settings.randomizer, false);
  assert.equal(settings.randomizerSeed, '');
  assert.equal(randomizer.environmentValue(settings), null);
});

test('the setting says the seed, what changes and which generations', () => {
  assert.equal(randomizer.environmentValue(on()), 'C0FFEE11:19:7');
  assert.equal(randomizer.environmentValue(on({ randomizerTrainers: true, randomizerGifts: true })), 'C0FFEE11:31:7');
  assert.equal(randomizer.environmentValue(on({ randomizerNoLegendaries: true, randomizerGen2: false })), 'C0FFEE11:51:5');
});

test('by default a run changes the starters and Shadow Pokémon, from every generation, at similar strength', () => {
  const { randomizerStarters, randomizerShadow, randomizerTrainers, randomizerGifts, randomizerSimilar, randomizerNoLegendaries,
    randomizerGen1, randomizerGen2, randomizerGen3 } = randomizer.normalize({});
  assert.deepEqual({ randomizerStarters, randomizerShadow, randomizerTrainers, randomizerGifts, randomizerSimilar, randomizerNoLegendaries },
    { randomizerStarters: true, randomizerShadow: true, randomizerTrainers: false, randomizerGifts: false, randomizerSimilar: true, randomizerNoLegendaries: false });
  assert.deepEqual([randomizerGen1, randomizerGen2, randomizerGen3], [true, true, true]);
});

test('similar strength can be turned off', () => {
  assert.equal(randomizer.environmentValue(on({ randomizerSimilar: false })), 'C0FFEE11:3:7');
});

test('turning it on makes a seed, and a seed the player typed is kept', () => {
  assert.match(randomizer.normalize({ randomizer: true }).randomizerSeed, /^[0-9A-F]{8}$/);
  assert.equal(on({ randomizerSeed: 'abc' }).randomizerSeed, '00000ABC');
  assert.match(on({ randomizerSeed: 'not hex!' }).randomizerSeed, /^[0-9A-F]{8}$/);
});

test('a run needs a generation, so choosing none means all of them', () => {
  const settings = on({ randomizerGen1: false, randomizerGen2: false, randomizerGen3: false });
  assert.equal(randomizer.environmentValue(settings), 'C0FFEE11:19:7');
});

test('with nothing to change, a new save is the normal game', () => {
  const settings = on({ randomizerStarters: false, randomizerShadow: false, randomizerTrainers: false, randomizerGifts: false, randomizerSimilar: true });
  assert.equal(randomizer.environmentValue(settings), null);
});

test('the game is told only when it is on', () => {
  const env = settings => port.buildEnvironment(port.normalizeSettings(settings), '/disc.iso', '/game');
  assert.equal(env({}).COLO_RANDOMIZER, undefined);
  assert.equal(env({ randomizer: true, randomizerSeed: 'C0FFEE11' }).COLO_RANDOMIZER, 'C0FFEE11:19:7');
  assert.equal(env({ randomizer: true, randomizerSeed: 'C0FFEE11', randomizerGen4: true, randomizerGen5: true, randomizerGen6: true }).COLO_RANDOMIZER, 'C0FFEE11:19:7');
  const gen46 = { generationPokemon: [4, 6] };
  assert.equal(randomizer.environmentValue({ ...on({ randomizerGen4: true, randomizerGen5: true, randomizerGen6: true }), ...gen46 }, { laterGenerations: true, gen6Randomizer: true }), 'C0FFEE11:19:63');
  assert.equal(randomizer.environmentValue({ ...on({ randomizerGen1: false, randomizerGen2: false, randomizerGen3: false, randomizerGen4: false, randomizerGen5: true, randomizerGen6: false }), ...gen46 }, { gen6Randomizer: true }), 'C0FFEE11:19:16');
  assert.equal(randomizer.environmentValue({ ...on({ randomizerGen1: false, randomizerGen2: false, randomizerGen3: false, randomizerGen4: false, randomizerGen5: false, randomizerGen6: true }), ...gen46 }, { gen6Randomizer: true }), 'C0FFEE11:19:32');
  assert.equal(randomizer.hasGen56({ randomizerGen5: true, generationPokemon: [6] }, true), true);
  assert.equal(randomizer.hasGen56({ randomizerGen6: true, generationPokemon: [6] }, true), true);
  assert.equal(randomizer.hasGen56({ randomizerGen4: true, generationPokemon: [4] }, true), false);
});

// A save's slot as the game writes it: the header, then the body scrambled against its own hash.
const SLOT = 0x1e000, FIRST = 0x6000, HASH = 0x1dfec, HASHED = 0x1dfd8, START = 0x18;
const sha1 = bytes => crypto.createHash('sha1').update(bytes).digest();
function slot(count, stamp) {
  const plain = Buffer.alloc(SLOT);
  plain[0] = plain[1] = 1;
  plain.writeInt32BE(count, 4);
  if (stamp) stamp.copy(plain, 8 + 0x1df80);
  const hash = sha1(plain.subarray(0, HASHED)), out = Buffer.from(plain);
  hash.copy(out, HASH);
  let key = Buffer.from(hash.map(byte => byte ^ 0xff));
  for (let offset = START; offset < HASHED; offset += 20) {
    for (let i = 0; i < 20; i++) out[offset + i] ^= key[i];
    key = sha1(out.subarray(offset, offset + 20));
  }
  let sum = 0;
  for (let word = 0; word < 8; word++) if (word !== 3) sum = (sum + out.readUInt32BE(word * 4)) >>> 0;
  out.writeUInt32BE((0x100000000 - sum) >>> 0, 0x0c);
  return out;
}
// (options from 256 on are byte 7, and checked 16 bits up, as host/randomizer.c writes them)
function stamp(seed, options = 15, generations = 7) {
  const out = Buffer.alloc(16);
  out.writeUInt32BE(0x43524e44, 0);
  out[4] = 1;
  out[5] = options & 0xff;
  out[6] = generations;
  out[7] = options >> 8;
  out.writeUInt32BE(seed, 8);
  out.writeUInt32BE((seed ^ 0x5eedc01d ^ ((options & 0xff) << 8) ^ generations ^ ((options >> 8) << 16)) >>> 0, 12);
  return out;
}
// temporary card folders, removed when the tests are done (they used to pile up in the system's temp folder)
const made = [];
test.after(() => { for (const folder of made) fs.rmSync(folder, { recursive: true, force: true }); });
function tempFolder() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'colo-randomizer-'));
  made.push(folder);
  return folder;
}
function card(...slots) {
  const folder = tempFolder();
  fs.writeFileSync(path.join(folder, 'pokemon_colosseum.dat'), Buffer.concat([Buffer.alloc(FIRST), ...slots]));
  return folder;
}

test('a save says its run, from the copy the game would load', () => {
  const folder = card(slot(1, stamp(0xc0ffee11)), slot(2, stamp(0xbadc0de5, 31, 2)), slot(0));
  assert.deepEqual(randomizer.readSave(folder), { exists: true, run: { seed: 'BADC0DE5', options: 31, generations: 2 } });
});

test('a save says the options past the first eight byte, no repeats and first forms only', () => {
  const folder = card(slot(1, stamp(0xbadc0de5, 0x1ff, 7)), slot(0), slot(0));
  assert.deepEqual(randomizer.readSave(folder), { exists: true, run: { seed: 'BADC0DE5', options: 0x1ff, generations: 7 } });
  // byte 7 counts in the check: a stamp whose byte 7 changed is no run
  const broken = stamp(0xbadc0de5, 0x1ff, 7);
  broken[7] = 0;
  assert.equal(randomizer.readSave(card(slot(1, broken), slot(0), slot(0))).run, null);
});

test('a save with no stamp is the normal game, even over an older run', () => {
  assert.deepEqual(randomizer.readSave(card(slot(1, stamp(0xc0ffee11)), slot(2), slot(0))), { exists: true, run: null });
});

test('a stamp that does not check out is no run', () => {
  const broken = stamp(0xc0ffee11);
  broken[9] ^= 1;
  assert.equal(randomizer.readSave(card(slot(1, broken), slot(0), slot(0))).run, null);
});

test('no save, or one that cannot be read, is no run', () => {
  assert.deepEqual(randomizer.readSave(tempFolder()), { exists: false, run: null });
  const folder = tempFolder();
  fs.writeFileSync(path.join(folder, 'pokemon_colosseum.dat'), Buffer.alloc(16));
  assert.equal(randomizer.readSave(folder).run, null);
});

test('the reader follows the save when it changes', () => {
  const folder = card(slot(1, stamp(0xc0ffee11)), slot(0), slot(0)), read = randomizer.createSaveReader();
  assert.equal(read(folder).run.seed, 'C0FFEE11');
  const later = new Date(Date.now() + 5000), file = path.join(folder, 'pokemon_colosseum.dat');
  fs.writeFileSync(file, Buffer.concat([Buffer.alloc(FIRST), slot(1, stamp(0xbadc0de5)), slot(0), slot(0)]));
  fs.utimesSync(file, later, later);
  assert.equal(read(folder).run.seed, 'BADC0DE5');
});

test('spoilers name the Pokémon and leave the teams out', () => {
  const raw = 'seed C0FFEE11 options 15 generations 7\nstarter 197 25\ngift 311 6\nshadow 1 296 28\nrow 8 100 296 28 1 2 3 4\n';
  const text = randomizer.spoilerText(raw, [{ national: 197, name: 'Umbreon' }, { national: 25, name: 'Pikachu' }, { national: 311, name: 'Plusle' },
    { national: 6, name: 'Charizard' }, { national: 296, name: 'Makuhita' }, { national: 28, name: 'Sandslash' }]);
  assert.match(text, /seed C0FFEE11/);
  assert.match(text, /Umbreon is now Pikachu/);
  assert.match(text, /Plusle is now Charizard/);
  assert.match(text, /Makuhita is now Sandslash/);
  assert.doesNotMatch(text, /row/);
  assert.equal(randomizer.spoilerSeed(raw), 'C0FFEE11');
  assert.equal(randomizer.spoilerSeed(null), null);
});

test('a run has Pokémon packs\' Pokémon when there are some and the game can choose them, and is chosen to start with', () => {
  assert.equal(randomizer.normalize({}).randomizerPacks, true);
  assert.equal(randomizer.normalize({ randomizerPacks: false }).randomizerPacks, false);
  assert.equal(randomizer.environmentValue(on(), { packPokemon: true }), 'C0FFEE11:83:7');
  assert.equal(randomizer.environmentValue(on({ randomizerPacks: false }), { packPokemon: true }), 'C0FFEE11:19:7');
  // without packs, or with a game from before, the run is the one it always was, and stays so when a pack is added
  assert.equal(randomizer.environmentValue(on()), 'C0FFEE11:19:7');
  assert.equal(randomizer.environmentValue(on(), { packPokemon: false }), 'C0FFEE11:19:7');
  // packs alone randomize nothing
  const nothing = on({ randomizerStarters: false, randomizerShadow: false });
  assert.equal(randomizer.environmentValue(nothing, { packPokemon: true }), null);
  const env = (settings, options) => port.buildEnvironment(port.normalizeSettings(settings), '/disc.iso', '/game', options);
  assert.equal(env({ randomizer: true, randomizerSeed: 'C0FFEE11' }, { packPokemon: true }).COLO_RANDOMIZER, 'C0FFEE11:83:7');
  assert.equal(env({ randomizer: true, randomizerSeed: 'C0FFEE11' }, {}).COLO_RANDOMIZER, 'C0FFEE11:19:7');
});

test('spoilers name a pack\'s Pokémon by its place in the species table, not its base\'s number', () => {
  const raw = 'seed C0FFEE11 options 83 generations 7\nstarter 197 65788\nshadow 1 296 66636\n';
  const species = [{ national: 197, name: 'Umbreon' }, { national: 296, name: 'Makuhita' }];
  // Moonfang is based on Umbreon and keeps its number: 65788 is 65536 + its row, 252
  const text = randomizer.spoilerText(raw, species, [{ packId: 252, national: 197, name: 'Moonfang' }]);
  assert.match(text, /Umbreon is now Moonfang/);
  assert.match(text, /Makuhita is now a Pokémon of a pack that isn't here now/);
});

test('a run has Generation 4 Pokémon when they are added and the game knows them, and is chosen to start with', () => {
  // the settings as the launcher keeps them: the randomizer's, with the generations whose Pokémon are added
  const gen4 = extra => ({ ...on(extra), generationPokemon: [4] });
  assert.equal(randomizer.normalize({}).randomizerGen4, true);
  assert.equal(randomizer.environmentValue(gen4(), { laterGenerations: true }), 'C0FFEE11:19:15');
  assert.equal(randomizer.environmentValue(gen4({ randomizerGen4: false }), { laterGenerations: true }), 'C0FFEE11:19:7');
  // without the Pokémon, or with a game from before, the run is the game's own three: the same run it always was
  assert.equal(randomizer.environmentValue(on(), { laterGenerations: true }), 'C0FFEE11:19:7');
  assert.equal(randomizer.environmentValue(gen4()), 'C0FFEE11:19:7');
  // only the fourth, without its Pokémon: the game's own three rather than none
  const only4 = { randomizerGen1: false, randomizerGen2: false, randomizerGen3: false };
  assert.equal(randomizer.environmentValue(gen4(only4), { laterGenerations: true }), 'C0FFEE11:19:8');
  assert.equal(randomizer.environmentValue(on(only4), { laterGenerations: true }), 'C0FFEE11:19:7');
});

test('similar strength spreads its picks when the game knows how, and only with similar strength on', () => {
  assert.equal(randomizer.SPREAD, 512);
  assert.equal(randomizer.environmentValue(on(), { spread: true }), 'C0FFEE11:531:7');
  assert.equal(randomizer.environmentValue(on({ randomizerSimilar: false }), { spread: true }), 'C0FFEE11:3:7');
  // a game from before it makes the run it always made
  assert.equal(randomizer.environmentValue(on()), 'C0FFEE11:19:7');
  assert.equal(randomizer.environmentValue(on(), { spread: false }), 'C0FFEE11:19:7');
  // it randomizes nothing by itself
  assert.equal(randomizer.environmentValue(on({ randomizerStarters: false, randomizerShadow: false }), { spread: true }), null);
  // a save made with it reads back with it (options from 256 on are the stamp's byte 7)
  const plain = Buffer.alloc(0x1df80 + 8 + 16);
  const at = 0x1df80 + 8, seed = 0xc0ffee11, options = 531, generations = 7;
  plain.writeUInt32BE(0x43524e44, at); plain[at + 4] = 1; plain[at + 5] = options & 0xff; plain[at + 6] = generations; plain[at + 7] = options >> 8;
  plain.writeUInt32BE(seed, at + 8);
  plain.writeUInt32BE((seed ^ 0x5eedc01d ^ ((options & 0xff) << 8) ^ generations ^ ((options >> 8) << 16)) >>> 0, at + 12);
  assert.deepEqual(randomizer.runOf(plain), { seed: 'C0FFEE11', options: 531, generations: 7 });
});

test('no repeats and first forms only are off to start with, and reach the game only when it knows them', () => {
  const settings = randomizer.normalize({});
  assert.equal(settings.randomizerNoRepeats, false);
  assert.equal(settings.randomizerBaseForms, false);
  const both = on({ randomizerNoRepeats: true, randomizerBaseForms: true });
  assert.equal(randomizer.environmentValue(both, { noRepeats: true, baseForms: true }), 'C0FFEE11:403:7');
  assert.equal(randomizer.environmentValue(on({ randomizerNoRepeats: true }), { noRepeats: true, baseForms: true }), 'C0FFEE11:147:7');
  assert.equal(randomizer.environmentValue(on({ randomizerBaseForms: true }), { noRepeats: true, baseForms: true }), 'C0FFEE11:275:7');
  // off, or with a game from before them, the run is the one it always was
  assert.equal(randomizer.environmentValue(on(), { noRepeats: true, baseForms: true }), 'C0FFEE11:19:7');
  assert.equal(randomizer.environmentValue(both), 'C0FFEE11:19:7');
  assert.equal(randomizer.environmentValue(both, { noRepeats: true }), 'C0FFEE11:147:7');
  assert.equal(randomizer.environmentValue(both, { baseForms: true }), 'C0FFEE11:275:7');
  // they randomize nothing by themselves
  const nothing = on({ randomizerStarters: false, randomizerShadow: false, randomizerNoRepeats: true, randomizerBaseForms: true });
  assert.equal(randomizer.environmentValue(nothing, { noRepeats: true, baseForms: true }), null);
  const env = (extra, options) => port.buildEnvironment(port.normalizeSettings({ randomizer: true, randomizerSeed: 'C0FFEE11', ...extra }), '/disc.iso', '/game', options);
  assert.equal(env({ randomizerNoRepeats: true, randomizerBaseForms: true }, { noRepeats: true, baseForms: true }).COLO_RANDOMIZER, 'C0FFEE11:403:7');
  assert.equal(env({ randomizerNoRepeats: true, randomizerBaseForms: true }, {}).COLO_RANDOMIZER, 'C0FFEE11:19:7');
});

test('spoilers leave out the teams a run with no repeats lists, as they do rows', () => {
  const raw = 'seed C0FFEE11 options 415 generations 7\nstarter 197 214\nstarter 196 131\nshadow 1 296 270\nrow 8 30 296 270 0 0 0 0 0 0\nteam 1 8 9 10 11 12 13\n';
  const species = [{ national: 197, name: 'Umbreon' }, { national: 196, name: 'Espeon' }, { national: 214, name: 'Heracross' },
    { national: 131, name: 'Lapras' }, { national: 296, name: 'Makuhita' }, { national: 270, name: 'Lotad' }];
  const text = randomizer.spoilerText(raw, species);
  assert.match(text, /Umbreon is now Heracross/);
  assert.match(text, /Espeon is now Lapras/);
  assert.match(text, /Makuhita is now Lotad/);
  assert.doesNotMatch(text, /team|row/);
});

test('spoilers list extra Shadow Pokémon when the game logs them', () => {
  const raw = 'seed C0FFEE11 options 147 generations 7\nshadow 1 216 383\nextra 127 264 212\nextra 126 161 161\n';
  const species = [{ national: 216, name: 'Teddiursa' }, { national: 383, name: 'Groudon' },
    { national: 264, name: 'Linoone' }, { national: 212, name: 'Scizor' }, { national: 161, name: 'Sentret' }];
  const text = randomizer.spoilerText(raw, species, [], 'xd');
  assert.match(text, /Shadow Pokémon\n  Teddiursa is now Groudon\n\nExtra Shadow Pokémon\n  Linoone is now Scizor\n  Sentret\n/);
});

test('runsEqual ignores internal spread bit while catching seed, option and generation changes', () => {
  assert.equal(randomizer.runsEqual(null, null), true);
  assert.equal(randomizer.runsEqual(null, { seed: 'C0FFEE11', options: 19, generations: 7 }), false);
  assert.equal(randomizer.runsEqual(
    { seed: 'C0FFEE11', options: 19, generations: 7 },
    { seed: 'C0FFEE11', options: 19 | randomizer.SPREAD, generations: 7 }
  ), true);
  assert.equal(randomizer.runsEqual(
    { seed: 'C0FFEE11', options: 19, generations: 15 },
    { seed: 'C0FFEE11', options: 19, generations: 63 }
  ), false);
  assert.equal(randomizer.runsEqual(
    { seed: 'C0FFEE11', options: 19, generations: 7 },
    { seed: 'BADC0DE5', options: 19, generations: 7 }
  ), false);
});

test('spoilerMatches verifies seed, options and generations so updating a run invalidates old spoilers', () => {
  const raw = 'seed C0FFEE11 options 19 generations 15\nshadow 1 296 416\n';
  assert.equal(randomizer.spoilerMatches(raw, { seed: 'C0FFEE11', options: 19, generations: 15 }), true);
  assert.equal(randomizer.spoilerMatches(raw, { seed: 'C0FFEE11', options: 19, generations: 63 }), false);
  assert.equal(randomizer.spoilerMatches(raw, { seed: 'C0FFEE11', options: 23, generations: 15 }), false);
  assert.equal(randomizer.spoilerMatches('seed C0FFEE11\n', { seed: 'C0FFEE11', options: 19, generations: 15 }), true);
  assert.equal(randomizer.spoilerMatches(null, { seed: 'C0FFEE11', options: 19, generations: 15 }), false);
});

test('writeStamp round-trips Gen 5/6-only runs and clears cleanly on null', () => {
  const plain = Buffer.alloc(0x1df80 + 8 + 0x20);
  const at = 0x1df80 + 8;
  randomizer.writeStamp(plain, at, { seed: '1234ABCD', options: 531, generations: 48 });
  assert.deepEqual(randomizer.runOf(plain, at), { seed: '1234ABCD', options: 531, generations: 48 });
  randomizer.writeStamp(plain, at, null);
  assert.equal(randomizer.runOf(plain, at), null);
  assert.equal(plain.subarray(at, at + 0x20).every(byte => byte === 0), true);
});

test('runSummary formats Normal game and active runs for Colosseum and XD', () => {
  assert.equal(randomizer.runSummary(null), 'Normal game');
  assert.equal(randomizer.runSummary({ seed: 'C0FFEE11', options: 531, generations: 63 }, 'colosseum'),
    'Seed C0FFEE11 · Starters, Shadow Pokémon, Similar strength · Gen 1, Gen 2, Gen 3, Gen 4, Gen 5, Gen 6');
  assert.equal(randomizer.runSummary({ seed: 'C0FFEE11', options: 1, generations: 48 }, 'xd'),
    'Seed C0FFEE11 · Starter · Gen 5, Gen 6');
});

function colosseumPlain(count, { stampBytes = null, snaggedShadows = [], party = [] } = {}) {
  const plain = Buffer.alloc(SLOT);
  plain[0] = plain[1] = 1;
  plain.writeInt32BE(count, 4);
  if (stampBytes) stampBytes.copy(plain, 8 + 0x1df80);
  for (const { id, discSpecies } of snaggedShadows) {
    const rec = 0x1b4ac + 0x18 * id;
    plain.writeUInt16BE(discSpecies, rec + 0x10);
    shadowEntries.setColosseumFlag(plain, 'met', id, true);
    shadowEntries.setColosseumFlag(plain, 'snagged', id, true);
  }
  party.forEach(({ species, shadowId = 0 }, i) => {
    const at = savePokemon.COLOSSEUM.party + i * savePokemon.COLOSSEUM.size;
    plain.writeUInt16BE(species, at);
    plain.writeUInt16BE(shadowId, at + savePokemon.COLOSSEUM.at.shadow);
  });
  return plain;
}

test('applyRunToSave updates Colosseum saves (normal -> randomized -> gen 5+6 -> revert), backs up, and freezes snagged Snag List species', () => {
  const backups = tempFolder();
  // Normal save: snagged Makuhita (Shadow id 1, disc species 296), did not snag id 2 (disc species 153).
  const p1 = colosseumPlain(1, { snaggedShadows: [{ id: 1, discSpecies: 296 }], party: [{ species: 296, shadowId: 1 }] });
  const p2 = colosseumPlain(2, { snaggedShadows: [{ id: 1, discSpecies: 296 }], party: [{ species: 296, shadowId: 1 }] });
  p2.writeUInt16BE(153, 0x1b4ac + 0x18 * 2 + 0x10);
  const folder = card(gciSave.scramble(p1), gciSave.scramble(p2), slot(0));

  // 1) Normal -> Randomized (Gen 1-4)
  const gen4Run = { seed: 'C0FFEE11', options: 19, generations: 15 };
  const first = randomizer.applyRunToSave(folder, gen4Run, { gameId: 'colosseum', backups });
  assert.equal(first.previous, null);
  assert.deepEqual(first.run, gen4Run);
  assert.equal(first.frozenCount, 1);
  assert.ok(first.backup);
  assert.equal(saves.listBackups(backups).length, 1);
  assert.equal(saves.listBackups(backups)[0].reason, 'before-randomizer-apply');
  assert.deepEqual(randomizer.readSave(folder, 'colosseum'), { exists: true, run: gen4Run });

  // Verify snagged id 1 kept Makuhita (296) and is marked frozen (0xD2), while unsnagged id 2 is NOT frozen.
  let data = fs.readFileSync(path.join(folder, 'pokemon_colosseum.dat'));
  let newest = gciSave.newestPlain(data).plain;
  assert.equal(newest.readUInt16BE(0x1b4ac + 0x18 * 1 + 0x10), 296);
  assert.equal(newest[0x1b4ac + 0x18 * 1 + 0x13], randomizer.FROZEN_MARK);
  assert.equal(newest[0x1b4ac + 0x18 * 2 + 0x13], 0);
  // Older valid slot was updated too so fallback cannot revert the run.
  const older = gciSave.unscramble(data.subarray(FIRST, FIRST + SLOT));
  assert.deepEqual(randomizer.runOf(older), gen4Run);

  // 2) Simulate snagging id 2 as Chimchar (national 390 -> Colosseum id 416) under Gen 4 run, then updating to Gen 1-6.
  const spoiler = 'seed C0FFEE11 options 19 generations 15\nshadow 1 296 390\nshadow 2 153 390\n';
  const speciesByNational = new Map([[390, 416]]);
  savePokemon.editCard(folder, 'colosseum', ctx => {
    shadowEntries.setColosseumFlag(ctx.plain, 'snagged', 2, true);
    ctx.plain.writeUInt16BE(416, savePokemon.COLOSSEUM.party + savePokemon.COLOSSEUM.size);
    ctx.plain.writeUInt16BE(2, savePokemon.COLOSSEUM.party + savePokemon.COLOSSEUM.size + savePokemon.COLOSSEUM.at.shadow);
    return { ok: true };
  });
  const gen6Run = { seed: 'C0FFEE11', options: 531, generations: 63 };
  const second = randomizer.applyRunToSave(folder, gen6Run, { gameId: 'colosseum', backups, spoilerRaw: spoiler, speciesByNational });
  assert.deepEqual(second.run, gen6Run);
  assert.equal(second.frozenCount, 1); // only newly snagged id 2; id 1 was already frozen
  data = fs.readFileSync(path.join(folder, 'pokemon_colosseum.dat'));
  newest = gciSave.newestPlain(data).plain;
  assert.equal(newest.readUInt16BE(0x1b4ac + 0x18 * 1 + 0x10), 296); // still Makuhita!
  assert.equal(newest.readUInt16BE(0x1b4ac + 0x18 * 2 + 0x10), 416); // locked to Chimchar!
  assert.equal(newest[0x1b4ac + 0x18 * 2 + 0x13], randomizer.FROZEN_MARK);

  // 3) Revert Randomized -> Normal game
  const third = randomizer.applyRunToSave(folder, null, { gameId: 'colosseum', backups });
  assert.deepEqual(third.previous, gen6Run);
  assert.equal(third.run, null);
  assert.deepEqual(randomizer.readSave(folder, 'colosseum'), { exists: true, run: null });
  data = fs.readFileSync(path.join(folder, 'pokemon_colosseum.dat'));
  newest = gciSave.newestPlain(data).plain;
  assert.equal(newest.readUInt16BE(0x1b4ac + 0x18 * 2 + 0x10), 416); // Chimchar preserved even after revert!
});

function xdCard({ count = 1, run = null, darkRecords = [], party = [] } = {}) {
  const folder = tempFolder();
  const pack = Buffer.alloc(xdSave.PACK_SIZE);
  // Place sections cleanly inside the pack body (after 0xA0)
  const setSection = (tableAt, offset) => {
    pack.writeUInt16BE(offset & 0xffff, tableAt);
    pack.writeUInt16BE((offset >>> 16) & 0xffff, tableAt + 2);
  };
  setSection(xdSave.SECTION.hero, 0x0000);
  setSection(xdSave.SECTION.pcBox, 0x1000);
  setSection(0x48, 0xd000); // dayCare
  setSection(xdSave.SECTION.darkPokemon, 0xd200);
  setSection(xdSave.SECTION.reserve1, 0xf800);
  setSection(0x70, 0xfc00); // chamber
  if (run) randomizer.writeStamp(pack, xdSave.stampAt(pack), run);
  const darkBase = xdSave.sectionAt(pack, 'darkPokemon');
  for (const { id, species, status } of darkRecords) {
    const rec = darkBase + id * 0x48;
    pack[rec] = (status & 7) << 5;
    pack.writeUInt16BE(species, rec + 0x1a);
    pack.writeUInt16BE(id, rec + 0x3e);
  }
  const heroBase = xdSave.sectionAt(pack, 'hero');
  party.forEach(({ species, shadowId = 0 }, i) => {
    const at = heroBase + xdSave.PARTY + i * xdSave.POKEMON;
    pack.writeUInt16BE(species, at);
    pack.writeUInt16BE(shadowId, at + 0xba);
  });
  const file = Buffer.alloc(xdSave.SLOTS[1] + xdSave.SLOT_SIZE);
  const start = xdSave.SLOTS[0];
  file[start] = file[start + 1] = file[start + 2] = 1;
  file.writeInt32BE(count, start + 4);
  xdSave.encipher(pack).copy(file, start + xdSave.PACK);
  fs.writeFileSync(path.join(folder, 'PokemonXD.dat'), file);
  return folder;
}

test('applyRunToSave works on XD saves (enable, update to Gen 5+6, revert) and freezes snagged Shadow Monitor records', () => {
  const backups = tempFolder();
  const folder = xdCard({
    count: 5,
    run: { seed: 'DEADBEEF', options: 19, generations: 15 },
    darkRecords: [
      { id: 1, species: 216, status: savePokemon.XD_STATUS.snagged }, // Teddiursa snagged as Chimchar (XD id 418)
      { id: 2, species: 165, status: savePokemon.XD_STATUS.met }      // Ledyba only seen, not snagged
    ],
    party: [{ species: 418, shadowId: 1 }]
  });
  // Update Gen 4 -> Gen 1-6 (fallback to owned party Pokemon id 418 when no spoiler file exists)
  const gen6Run = { seed: 'DEADBEEF', options: 531, generations: 63 };
  const updated = randomizer.applyRunToSave(folder, gen6Run, { gameId: 'xd', backups });
  assert.deepEqual(updated.run, gen6Run);
  assert.equal(updated.frozenCount, 1);
  assert.deepEqual(randomizer.readSave(folder, 'xd'), { exists: true, run: gen6Run });

  let pack = xdSave.newestPack(fs.readFileSync(path.join(folder, 'PokemonXD.dat'))).plain;
  const darkBase = xdSave.sectionAt(pack, 'darkPokemon');
  assert.equal(pack.readUInt16BE(darkBase + 1 * 0x48 + 0x1a), 418);
  assert.equal(pack[darkBase + 1 * 0x48 + 0x43], randomizer.FROZEN_MARK);
  assert.equal(pack[darkBase + 2 * 0x48 + 0x43], 0); // seen-only is NOT frozen

  // Revert XD save to normal game
  const reverted = randomizer.applyRunToSave(folder, null, { gameId: 'xd', backups });
  assert.equal(reverted.run, null);
  assert.deepEqual(randomizer.readSave(folder, 'xd'), { exists: true, run: null });
  pack = xdSave.newestPack(fs.readFileSync(path.join(folder, 'PokemonXD.dat'))).plain;
  assert.equal(pack.readUInt16BE(xdSave.sectionAt(pack, 'darkPokemon') + 1 * 0x48 + 0x1a), 418);
});
