'use strict';

// Later generations, which the player opts into under Settings → Gameplay: their battle rules, and their Pokémon and
// moves. Each is a file of src/generations (gen<N>.json, made from Pokémon Showdown's data and, for moves, Pokémon
// Platinum's by scripts/generation-data/make.js) and how Colosseum plays what it lacks (gen<N>-colosseum.json, written
// by hand).
// Rules and Pokémon are separate choices: Colosseum's own rules with generation 4's Pokémon, or generation 4's rules
// with or without them. A generation added later is another pair of files.
//
// This turns them into what the game's expansion file holds (src/pokemon-packs.js writes it, host/pokemonpacks.c and
// host/mechanics.c read it):
//   - rules: each move's category, the feature bits, and the old moves whose numbers or flags that generation changed;
//   - moves: each new move as a row of Colosseum's move table, copied from the move it plays as (`as`: its effect,
//     animation and messages) with the new move's own numbers and flags. A new move is numbered 3 past its own number,
//     after Colosseum's 355-357 (its own unnamed move, Shadow Rush and "????"), so a saved Pokémon's moves keep their
//     meaning;
//   - Pokémon: each new species as a pack Pokémon's row, numbered 26 past its National Pokédex number (387 is 413,
//     right after Colosseum's 413), with a Pokémon Colosseum has of the same type and stage standing in for its looks
//     and cry until one of its own is converted (src/pbr-models.js).
//
// The Fairy type is a choice of its own, under either rules (fairy.json, made from generation 6's data by
// scripts/generation-data/fairy.js, and fairy-colosseum.json, by hand): the type (the game's 19th, after Dark: FAIRY_TYPE),
// generation 6's types for the Pokémon and moves it changed, and its Fairy-type moves, which the Pokémon that learn them
// by level in generation 6 learn at those levels. host/types.c plays the type, with generation 6's type chart.
const fs = require('node:fs');
const path = require('node:path');
const mechanics = require('./mechanics');

const DIRECTORY = path.join(__dirname, 'generations');
const COLOSSEUM_RULES = 3;
const MOVE_OFFSET = 3, FIRST_NEW_MOVE = 355, SPECIES_OFFSET = 26;
const SAME_ABILITIES = 75;   // Stench to Shell Armor: the same numbers in Ruby and later (Ruby's 76 is Cacophony)
const FEATURES = { physicalSpecialSplit: 1, sandstormRockSpecialDefense: 2 };
const CATEGORY = { Physical: 1, Special: 2, Status: 0 };
const FAIRY_TYPE = 18;   // the type the Fairy type setting adds, after the game's 18 (host/types.c)
const LEVEL_MOVES = 20, ALL_LEVEL_MOVES = 60;  // the level-up moves a species row holds, and with the MORE chunk past it
const MOVE_ROW = 0x38;
// A move's row (decomp include/game/bios_records.h WazaDataBiosFields). 0x06-0x12 are flags, 1 or 0: contact, Protect,
// Magic Coat, Snatch, Mirror Move and King's Rock act on it; Metronome, Mimic, Assist and Sleep Talk can call it; it's
// a sound move (Soundproof); Pressure (unread by the game, and left as Colosseum has it); an HM (can't be forgotten).
// 0x13 marks a move with a drawback for the trainer AI, and 0x34-0x36 the kinds of move it takes a move for: a new move
// takes its AI move's (moveAi).
const RISK = 0x13, AI_KINDS = 0x34;
const MV = { priority: 0, pp: 1, type: 2, target: 3, accuracy: 4, chance: 5, power: 0x16, effect: 0x1a };
const FLAGS = { contact: 6, protect: 7, reflectable: 8, snatch: 9, mirror: 0x0a, kingsRock: 0x0b, metronome: 0x0c,
  mimic: 0x0d, assist: 0x0e, sleepTalk: 0x0f, sound: 0x10, hm: 0x12 };
// Who stands in for a new Pokémon's looks and cry: a Pokémon Colosseum has, by first type and stage.
const STAND_INS = {
  Grass: ['Treecko', 'Grovyle', 'Sceptile'], Fire: ['Torchic', 'Combusken', 'Blaziken'], Water: ['Mudkip', 'Marshtomp', 'Swampert'],
  Normal: ['Zigzagoon', 'Linoone', 'Slaking'], Electric: ['Electrike', 'Manectric', 'Manectric'], Bug: ['Wurmple', 'Dustox', 'Beautifly'],
  Flying: ['Taillow', 'Swellow', 'Swellow'], Psychic: ['Ralts', 'Kirlia', 'Gardevoir'], Rock: ['Aron', 'Lairon', 'Aggron'],
  Ground: ['Trapinch', 'Vibrava', 'Flygon'], Ghost: ['Shuppet', 'Banette', 'Dusclops'], Ice: ['Snorunt', 'Glalie', 'Glalie'],
  Dragon: ['Bagon', 'Shelgon', 'Salamence'], Dark: ['Poochyena', 'Mightyena', 'Absol'], Steel: ['Beldum', 'Metang', 'Metagross'],
  Poison: ['Gulpin', 'Swalot', 'Swalot'], Fighting: ['Makuhita', 'Hariyama', 'Hariyama']
};

const key = text => String(text).toLowerCase().replace(/[\s_]+/g, ' ').replace(/é/g, 'e').trim();
const cache = new Map();

// The generations there are data for: { generation, name, newSpecies, newMoves }.
function available() {
  return fs.readdirSync(DIRECTORY).map(name => /^gen(\d+)\.json$/.exec(name)).filter(Boolean)
    .map(match => Number(match[1])).sort((a, b) => a - b).map(n => {
      const data = load(n);
      return { generation: n, name: data.name, newSpecies: data.newSpecies, newMoves: data.newMoves, mechanics: mechanicList(data),
        hasSpecies: data.newSpecies[1] >= data.newSpecies[0] };
    });
}

// A generation's mechanics, by id: its file's list (gen6.json), or the ones its object names (gen4.json's)
const mechanicList = data => Array.isArray(data.mechanics) ? data.mechanics : Object.keys(data.mechanics).filter(id => data.mechanics[id]);

function load(generation) {
  if (!cache.has(generation)) {
    const data = JSON.parse(fs.readFileSync(path.join(DIRECTORY, `gen${generation}.json`), 'utf8'));
    let colosseum = JSON.parse(fs.readFileSync(path.join(DIRECTORY, `gen${generation}-colosseum.json`), 'utf8'));
    // a later generation's file can say how the game plays its moves as an earlier one's does, with its own on top
    if (colosseum.inherits) {
      const from = load(colosseum.inherits).colosseum;
      colosseum = { ...from, ...colosseum, moves: { ...from.moves, ...colosseum.moves }, oldMoves: { ...from.oldMoves, ...(colosseum.oldMoves || {}) },
        abilities: { ...from.abilities, ...(colosseum.abilities || {}) },
        evolutionItems: { ...from.evolutionItems, ...(colosseum.evolutionItems || {}) },
        evolutionPlaces: { ...from.evolutionPlaces, ...(colosseum.evolutionPlaces || {}) } };
    }
    data.colosseum = colosseum;
    cache.set(generation, data);
  }
  return cache.get(generation);
}

let fairyData = null;
function loadFairy() {
  if (!fairyData) {
    fairyData = JSON.parse(fs.readFileSync(path.join(DIRECTORY, 'fairy.json'), 'utf8'));
    fairyData.colosseum = JSON.parse(fs.readFileSync(path.join(DIRECTORY, 'fairy-colosseum.json'), 'utf8'));
  }
  return fairyData;
}

// The settings as kept:
//   - battleRules: the rules of a generation there is data for (else Colosseum's);
//   - mechanicChanges: the mechanics the player turned on or off on top of those rules' (src/mechanics.js), and
//     mechanics, the ones that are on;
//   - generationPokemon: the generations whose Pokémon are imported (those that bring Pokémon);
//   - learnsets: the generation whose level-up moves the game's Pokémon learn ('auto': the rules' when they're
//     generation 6's, else the latest imported generation's, else the game's own);
//   - fairyType: whether Gen 6 types are on (the mechanic gen6Types: the setting from before mechanics, kept as one).
function normalize(input = {}) {
  const all = available(), known = new Set(all.map(each => each.generation));
  const rules = known.has(Number(input.battleRules)) ? Number(input.battleRules) : COLOSSEUM_RULES;
  const withSpecies = new Set(all.filter(each => each.hasSpecies).map(each => each.generation));
  const pokemon = [...new Set((Array.isArray(input.generationPokemon) ? input.generationPokemon : []).map(Number).filter(n => withSpecies.has(n)))].sort();
  const changes = {};
  if (input.mechanicChanges && typeof input.mechanicChanges === 'object')
    for (const [id, value] of Object.entries(input.mechanicChanges)) if (mechanics.get(id) && typeof value === 'boolean') changes[id] = value;
  // the Gen 6 types switch from before mechanics
  // (on only: it was off unless asked for, so off says nothing about rules that have the types already)
  if (input.fairyType === true && !('gen6Types' in changes) && !mechanics.preset(rules).includes('gen6Types')) changes.gen6Types = true;
  const chosen = mechanics.choose(rules, changes);
  const learnsets = [COLOSSEUM_RULES, ...known].includes(Number(input.learnsets)) ? Number(input.learnsets) : 'auto';
  return { battleRules: rules, generationPokemon: pokemon, mechanics: chosen, mechanicChanges: mechanics.changesFrom(rules, chosen),
    learnsets, fairyType: chosen.includes('gen6Types') };
}

// The generation whose level-up moves the game's Pokémon learn, for normalize's settings
const learnsetGeneration = chosen => chosen.learnsets !== 'auto' ? chosen.learnsets
  : chosen.battleRules >= 6 ? chosen.battleRules : chosen.generationPokemon.length ? Math.max(...chosen.generationPokemon) : COLOSSEUM_RULES;

// Physical, Special or Status for each of Colosseum's own moves by its id, as a generation's rules make it (the split
// gives each its own; without it the game goes by the move's type, so this is empty). What the team builder shows.
function moveCategories(generation) {
  const data = load(generation), out = {};
  if (!mechanicList(data).includes('physicalSpecialSplit')) return out;
  for (let id = 1; id < FIRST_NEW_MOVE; id++) if (data.moves[id]) out[id] = data.moves[id].category;
  return out;
}

const colosseumMove = number => number >= FIRST_NEW_MOVE ? number + MOVE_OFFSET : number;
const speciesId = national => national + SPECIES_OFFSET;
const isGenerationSpecies = id => id >= 387 + SPECIES_OFFSET && id < 1100;

// What Colosseum's own moves tell about its move table: which byte each of the generation's ranges is, and "never
// misses".
function learnMoveTable(tables, data) {
  const votes = {}, misses = {};
  for (let id = 1; id < FIRST_NEW_MOVE; id++) {
    const move = data.moves[id], row = tables.moveRows[id];
    if (!move || !row) continue;
    (votes[move.range] ||= {})[row[MV.target]] = (votes[move.range][row[MV.target]] || 0) + 1;
    if (move.accuracy === 0) misses[row[MV.accuracy]] = (misses[row[MV.accuracy]] || 0) + 1;
  }
  const top = counts => Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
  const targets = Object.fromEntries(Object.entries(votes).map(([range, counts]) => [range, top(counts)]));
  return { targets, neverMiss: Object.keys(misses).length ? top(misses) : 0 };
}

// A move's numbers and flags written into a row (a copy of another's, or its own). A range Colosseum has no move of
// keeps the row's.
function writeMove(row, move, learned, tables, { power = move.power, chance = move.effectChance } = {}) {
  const type = tables.types.indexOf(key(move.type));
  row[MV.priority] = move.priority & 0xff;
  row[MV.pp] = move.pp;
  if (type >= 0) row[MV.type] = type;
  if (move.range in learned.targets) row[MV.target] = learned.targets[move.range];
  row[MV.accuracy] = move.accuracy === 0 ? learned.neverMiss : move.accuracy;
  row[MV.chance] = chance;
  for (const [flag, at] of Object.entries(FLAGS)) row[at] = move[flag] ? 1 : 0;
  row.writeUInt16BE(power, MV.power);
  return row;
}

// The added-effect chance a row gets. Platinum's 0 and 100 aren't a roll: its effect never or always happens, and its
// own script makes it so (Bind, Thief, Pay Day have 0; Fake Out, Skull Bash, Overheat 100). Colosseum's scripts read
// the chance as a roll, so where the row plays the move's own effect, it keeps the chance it has (100 for Bind). Any
// other chance is Platinum's.
const chanceFor = (move, row, sameEffect) =>
  sameEffect && (move.effectChance === 0 || move.effectChance === 100) ? row[MV.chance] : move.effectChance;

// The game's own move a new move's trainer AI is the AI of (generations/move-ai.json, by its National number): its
// number in the game (the third generation's are the same), or 0 for none. The row takes that move's drawback mark
// (0x13) and the kinds of move the AI takes it for (0x34, three: damaging, healing...), which only the AI reads; the
// game takes its AI's functions from the expansion file (host/pokemonpacks.c), keeping its animation's.
let moveAiTable = null;
function moveAi(tables, number, row) {
  if (!moveAiTable) moveAiTable = JSON.parse(fs.readFileSync(path.join(__dirname, 'generations', 'move-ai.json'), 'utf8')).moves;
  const name = moveAiTable[number];
  // (by the disc's name, which runs some together: SOLARBEAM)
  const loose = text => key(text).replace(/[\s-]/g, '');
  const id = name ? tables.moves.get(key(name)) || [...tables.moves].find(([each]) => loose(each) === loose(name))?.[1] : 0;
  if (!id || id >= FIRST_NEW_MOVE) return 0;
  const own = tables.moveRows[id];
  if (own) { row[RISK] = own[RISK]; own.copy(row, AI_KINDS, AI_KINDS, AI_KINDS + 3); }
  return id;
}

// The new moves a generation brings that Colosseum can play, by Colosseum's number: { id, name, description, row,
// number (its own), exact, note }. Problems in the hand-written file are thrown.
function newMoves(tables, data) {
  const learned = learnMoveTable(tables, data), out = [];
  for (let number = data.newMoves[0]; number <= data.newMoves[1]; number++) {
    const move = data.moves[number];
    if (!move) continue;
    if (!(move.name in data.colosseum.moves)) throw new Error(`generation ${data.generation}: ${move.name} isn't in gen${data.generation}-colosseum.json`);
    const how = data.colosseum.moves[move.name];
    if (!how) continue;
    const template = tables.moves.get(key(how.as));
    if (!template || template >= FIRST_NEW_MOVE) throw new Error(`generation ${data.generation}: ${move.name} plays as "${how.as}", which Colosseum hasn't`);
    // A damaging move whose power is worked out as it's used has 1, as Pokémon Platinum has it.
    const power = how.power ?? move.power, from = tables.moveRows[template];
    // The effect the game plays: the template's, or one of the port's own (host/gen4.c's EFFECT_*), or another of the game's
    // (effectAs: e.g. Leaf Storm plays Petal Dance's animation with Overheat's effect).
    let effectId = template;
    if (how.effectAs) {
      effectId = tables.moves.get(key(how.effectAs));
      if (!effectId || effectId >= FIRST_NEW_MOVE) throw new Error(`generation ${data.generation}: ${move.name} plays the effect of "${how.effectAs}", which Colosseum hasn't`);
    }
    const effectRow = tables.moveRows[effectId];
    // The template's chance, where it plays the same effect as Platinum has the move play (Magma Storm as Fire Spin, Leaf Storm effectAs Overheat)
    const sameEffect = how.effect === undefined && data.moves[effectId]?.effect === move.effect;
    const row = writeMove(Buffer.from(from), move, learned, tables, { power, chance: chanceFor(move, effectRow, sameEffect) });
    if (how.effectAs) {
      row.writeUInt16BE(effectRow.readUInt16BE(MV.effect), MV.effect);
      // a move with no added effect of its own keeps the chance of the row whose effect it plays (Growl's for Baby-Doll Eyes)
      if (!move.effectChance && !sameEffect) row[MV.chance] = effectRow[MV.chance];
    }
    if (how.effect !== undefined) row.writeUInt16BE(how.effect, MV.effect);
    // Who it's aimed at, where no move of Colosseum's has its range (Acupressure: the user or its partner).
    if (how.target !== undefined) row[MV.target] = how.target;
    out.push({ id: colosseumMove(number), number, name: (how.name || move.name.toUpperCase()).slice(0, 12), description: move.description,
      row, exact: Boolean(how.exact), note: how.note || '', as: how.as, category: move.category, ai: moveAi(tables, number, row) });
  }
  return out;
}

// The Fairy type setting's new moves (fairy.json's), by Colosseum's number, as newMoves gives a generation's: each a row
// copied from the move it plays as, with the effect of another where fairy-colosseum.json says so (effectAs), and its
// name as the game's twelve letters fit it (fairy-colosseum.json's `name`, else its own). `tables` has the Fairy type.
function fairyMoves(tables) {
  const fairy = loadFairy(), learned = learnMoveTable(tables, load(4)), out = [];
  const gameMove = name => {
    const id = tables.moves.get(key(name));
    if (!id || id >= FIRST_NEW_MOVE) throw new Error(`fairy-colosseum.json: the game has no move "${name}"`);
    return id;
  };
  for (const [number, move] of Object.entries(fairy.newMoves)) {
    const how = fairy.colosseum.moves[move.name];
    if (!how) throw new Error(`${move.name} isn't in fairy-colosseum.json`);
    const from = tables.moveRows[gameMove(how.as)], effectRow = how.effectAs ? tables.moveRows[gameMove(how.effectAs)] : from;
    // A move with no added effect of its own keeps the chance of the row whose effect it plays (Growl's for Baby-Doll Eyes)
    const row = writeMove(Buffer.from(from), move, learned, tables, { power: move.power, chance: move.effectChance || effectRow[MV.chance] });
    row.writeUInt16BE(effectRow.readUInt16BE(MV.effect), MV.effect);
    if (how.effect !== undefined) row.writeUInt16BE(how.effect, MV.effect);
    out.push({ id: colosseumMove(Number(number)), number: Number(number), name: (how.name || move.name.toUpperCase()).slice(0, 12),
      description: move.description, row, exact: Boolean(how.exact), note: how.note || '', as: how.as, category: move.category,
      ai: moveAi(tables, Number(number), row) });
  }
  return out;
}

// The game's own Pokémon and moves whose types generation 6 changed, for the expansion file's TYPE chunk:
// { species: [{ id, types: [first, second] }], moves: [{ id, type }] }, by the game's numbers. `tables` has the Fairy type.
function fairyTypes(tables) {
  const fairy = loadFairy(), typeOf = name => tables.types.indexOf(key(name));
  const species = [];
  for (const each of tables.species || []) {
    const types = each.national >= 1 && each.national <= 386 ? fairy.species[each.national] : null;
    if (!types || !each.row) continue;
    const ids = types.map(typeOf);
    if (ids.some(id => id < 0)) throw new Error(`fairy.json: a type of #${each.national} the game hasn't`);
    species.push({ id: each.id, types: [ids[0], ids[1] ?? ids[0]] });
  }
  const moves = Object.entries(fairy.moves).map(([number, type]) => ({ id: colosseumMove(Number(number)), type: typeOf(type) }));
  return { count: FAIRY_TYPE + 1, species, moves };
}

// A species row's level-up moves, [[level, move]] (up to 20 of 4 bytes at 0xBA: the level, 0, the move)
function rowLevelUp(row) {
  const out = [];
  for (let i = 0; i < LEVEL_MOVES; i++) {
    const level = row[0xba + i * 4], move = row.readUInt16BE(0xba + i * 4 + 2);
    if (level && move) out.push([level, move]);
  }
  return out;
}

// A Pokémon's level-up moves with the Fairy moves it learns by level in generation 6 (fairy.json levelUp, by its
// National Pokédex number) put in at their levels, after the moves it already learns at the same level. At most twenty,
// as a row holds: where that's too many, its other moves go from the last, so it keeps its Fairy moves.
function withFairyMoves(levelUp, national) {
  const added = (loadFairy().levelUp[national] || []).map(([level, number]) => [level, colosseumMove(number), true]);
  if (!added.length) return levelUp;
  const have = new Set(levelUp.map(([, move]) => move));
  const merged = [...levelUp.map(([level, move]) => [level, move, false]), ...added.filter(([, move]) => !have.has(move))]
    .map((entry, order) => ({ entry, order })).sort((a, b) => a.entry[0] - b.entry[0] || a.order - b.order).map(each => each.entry);
  while (merged.length > ALL_LEVEL_MOVES) {   /* (twenty in the row, the rest past it: the MORE chunk) */
    const last = merged.map(each => each[2]).lastIndexOf(false);
    merged.splice(last < 0 ? merged.length - 1 : last, 1);
  }
  return merged.map(([level, move]) => [level, move]);
}

// A generation's rules: its feature bits, each move's category, and Colosseum's own moves as that generation has them
// (power, accuracy, PP, type, priority, range, added-effect chance and flags), as whole rows; their effects, messages
// and animations stay Colosseum's, but for the few whose effect the generation changed (oldMoves).
function rules(tables, data, moves, chosen = mechanicList(data)) {
  const features = mechanics.features(chosen);
  const highest = Math.max(FIRST_NEW_MOVE, ...moves.map(move => move.id + 1));
  const categories = Buffer.alloc(highest);
  for (let id = 1; id < FIRST_NEW_MOVE; id++) if (data.moves[id]) categories[id] = CATEGORY[data.moves[id].category];
  for (const move of moves) categories[move.id] = CATEGORY[move.category ?? data.moves[move.number].category];
  const learned = learnMoveTable(tables, data), changed = [];
  for (let id = 1; id < FIRST_NEW_MOVE; id++) {
    const move = data.moves[id], row = tables.moveRows[id];
    if (!move || !row) continue;
    // A move whose power is worked out as it's used has 1 in Platinum's data. Colosseum's Spit Up has 100 there, the
    // power Ruby and Sapphire multiply by the Stockpile count, as Platinum's script does: it keeps it.
    const power = move.power === 1 ? row.readUInt16BE(MV.power) : move.power;
    // An old move whose effect the generation changed plays another (gen4-colosseum.json's oldMoves): Waterfall flinches.
    const effect = data.colosseum.oldMoves?.[move.name]?.effect;
    const wanted = writeMove(Buffer.from(row), move, learned, tables, { power, chance: chanceFor(move, row, effect === undefined) });
    if (effect !== undefined) wanted.writeUInt16BE(effect, MV.effect);
    if (!wanted.equals(row)) changed.push({ id, row: wanted });
  }
  // The game's own Pokémon with the abilities the generation gives them (Diamond and Pearl gave many a second one:
  // Scizor's Technician, Breloom's Poison Heal), the generation's own by their number in the game (colosseumAbility).
  const numberOf = name => Number(Object.keys(data.abilities).find(n => data.abilities[n].name === name));
  // Ruby's names run some together (LIGHTNINGROD, COMPOUNDEYES): 1 to 75 are the same abilities by number in both
  const abilityId = name => tables.abilities.get(key(name)) ?? (numberOf(name) >= data.newAbilities[0] ? colosseumAbility(numberOf(name))
    : numberOf(name) >= 1 && numberOf(name) <= SAME_ABILITIES ? numberOf(name) : undefined);
  const species = [];
  for (const each of tables.species || []) {
    const entry = each.national >= 1 && each.national <= 386 ? data.species[each.national] : null;
    if (!entry || !each.row) continue;
    const ids = entry.abilities.map(abilityId).filter(Boolean).slice(0, 2);
    if (!ids.length) continue;
    const wanted = [ids[0], ids[1] || 0];
    if (wanted[0] !== each.row[0x32] || wanted[1] !== each.row[0x33]) species.push({ id: each.id, abilities: wanted });
  }
  return { generation: data.generation, features, categories, changed, species };
}

// A Pokémon's level-up moves, the ones Colosseum can play, by Colosseum's number: twenty in its row, the rest (up to
// sixty in all) in the MORE chunk past it (host/evolutions.c).
const levelUpMoves = (entry, usable) =>
  entry.levelUp.map(([level, move]) => [Math.max(1, level), usable(move)]).filter(([, move]) => move).slice(0, 60);

// The generation a Pokémon came in, by its National Pokédex number (generation 6's file has the fifth's too)
const GENERATION_STARTS = [[650, 6], [494, 5], [387, 4], [252, 3], [152, 2], [1, 1]];
const FIRST_FORM = 722;   // generation 6's file's forms with stats of their own, 722 on (a form's generation is 6)
const generationOf = number => (GENERATION_STARTS.find(([first]) => number >= first) || [0, 0])[1];
// a form's base's National number (722 on), else the number itself
const baseNational = number => (number >= FIRST_FORM ? (available().some(each => each.generation === 6) && load(6).species[number]?.formOf) || number : number);

// The generations whose Pokémon a generation's rules play (online, and the team builder's party of that generation):
// it and each before it with Pokémon of their own (generation 6's: the fourth's, and the fifth's and sixth's)
const pokemonGenerations = generation => available().filter(each => each.hasSpecies && each.generation <= generation).map(each => each.generation);

const intoOf = number => number > 386 ? `generation:${number}` : number;

// An evolution of a later generation's (Pokémon Platinum's, make.js) as pokemon.json says one Colosseum can make
// (src/pokemon-packs.js), or null where it can't. Colosseum evolves by level, friendship, an item it has or a trade, and
// the port adds knowing a move, a Pokémon in the party, and a level for one gender (host/evolutions.c). The game keeps
// no time of day, so an evolution by friendship in the day or at night is by friendship; an item or a place the game
// hasn't is a level, or no evolution (gen<N>-colosseum.json: Eevee's mossy and icy rocks).
// Highest level-up evolution that produces `number` (0 when none), so a fallback item/place level never sits at or
// below the level a Pokémon itself evolved at (Lampent evolves from Litwick at 41 -> Chandelure 50; Doublade 35 -> Aegislash 45).
function preEvolutionLevel(data, number) {
  if (!number) return 0;
  let max = 0;
  for (const entry of Object.values(data.species)) {
    for (const ev of entry.evolutions || []) {
      if (ev.into === number && ev.level && ev.level > max) max = ev.level;
    }
  }
  return max;
}

function fallbackLevel(data, fromNumber, level) {
  if (!level) return 0;
  const pre = preEvolutionLevel(data, fromNumber);
  return pre && level <= pre ? Math.ceil((pre + 6) / 5) * 5 : level;
}

function evolutionOf(data, evolution, usable, fromNumber = 0) {
  const into = intoOf(evolution.into), gender = evolution.gender ? { gender: evolution.gender } : {};
  if (evolution.other) return null;   // the third generation's, which the game's own Pokémon have as it has them
  if (evolution.level) return { into, level: evolution.level, ...gender, ...(evolution.partyType ? { partyType: evolution.partyType } : {}) };
  // (Sylveon: high friendship knowing a Fairy move, as generation 8 has it for generation 6's affection)
  if (evolution.friendship && evolution.knowsType) return { into, friendship: true, knowsType: evolution.knowsType };
  if (evolution.friendship) return { into, friendship: true };
  if (evolution.knowsMove) { const move = usable(evolution.knowsMove); return move ? { into, knowsMove: move } : null; }
  if (evolution.withPokemon) return { into, withPokemon: intoOf(evolution.withPokemon) };
  if (evolution.trade === true) return { into, trade: true };
  const item = evolution.item || evolution.heldItem || evolution.trade;
  if (item) {
    const level = data.colosseum.evolutionItems[item];
    if (level === undefined) return evolution.item ? { into, item } : evolution.heldItem ? null : { into, trade: item };
    const adjusted = fallbackLevel(data, fromNumber, level);
    return adjusted ? { into, level: adjusted, ...gender } : null;
  }
  if (evolution.place) {
    // a level, or (Eevee's Moss Rock and Ice Rock) an item the game has to use or hold
    const way = data.colosseum.evolutionPlaces?.[evolution.place];
    if (way && typeof way === 'object') return way.item ? { into, item: way.item } : way.heldItem ? { into, heldItem: way.heldItem } : null;
    const adjusted = fallbackLevel(data, fromNumber, way);
    return adjusted ? { into, level: adjusted } : null;
  }
  return null;
}

// The game's own Pokémon (1 to 386) with a later generation's Pokémon added: their level-up moves as that generation
// has them, and their evolutions into its new Pokémon, which go after the game's own (Yanma into Yanmega by knowing
// Ancient Power, Murkrow into Honchkrow). [{ id, national, levelUp, evolutions }], as src/pokemon-packs.js ownRows
// writes them into the game's rows.
// `data` is the generation whose level-up moves they learn, `evolveData` the one whose Pokémon are imported (their
// evolutions into those: none without).
function ownSpecies(tables, data, moves, evolveData = data) {
  const playable = new Set(moves.map(move => move.number));
  const usable = n => n < FIRST_NEW_MOVE ? n : playable.has(n) ? colosseumMove(n) : null;
  const out = [];
  for (const each of tables.species || []) {
    const entry = each.national >= 1 && each.national <= 386 ? data.species[each.national] : null;
    if (!entry || !each.row) continue;
    const evolveFrom = evolveData?.species[each.national];
    const evolutions = (evolveFrom?.evolutions || []).filter(evolution => evolution.into > 386 || evolution.trade === 'Prism Scale')
      .map(evolution => evolutionOf(evolveData, evolution, usable, each.national)).filter(Boolean);
    out.push({ id: each.id, national: each.national, levelUp: levelUpMoves(entry, usable), evolutions });
  }
  return out;
}

function stageOf(data, number) {
  const parents = new Map();
  for (const [n, entry] of Object.entries(data.species)) for (const evolution of entry.evolutions) parents.set(evolution.into, Number(n));
  let stage = 1;
  while (parents.has(number) && stage < 3) { number = parents.get(number); stage++; }
  return stage;
}

// A Pokémon's name as the game has it: capitals, ten letters at most (a saved Pokémon's nickname holds ten), with a
// shortening of its own for one that has more (Fletchinder, the only one to #721)
const SHORT_NAMES = { Fletchinder: 'FLETCHINDR' };
const gameName = name => SHORT_NAMES[name] || name.toUpperCase().slice(0, 10);

// A new species as a pokemon.json (src/pokemon-packs.js buildRow takes it): its own numbers, moves by Colosseum's number,
// abilities Colosseum has, and evolutions it can make.
function speciesSpec(tables, data, number, moves, ownAbilities, learnData = null) {
  const entry = data.species[number], playable = new Set(moves.map(move => move.number));
  // its moves as the chosen learnsets' generation has them (its own, else)
  const learns = learnData?.species[number] || entry;
  const usable = n => n < FIRST_NEW_MOVE ? n : playable.has(n) ? colosseumMove(n) : null;
  const abilities = [];
  // Under the generation's own rules its abilities are the game's too (host/gen4.c plays them: build's `abilities`);
  // under Colosseum's, each becomes one the game has.
  const numberOf = name => Number(Object.keys(data.abilities).find(n => data.abilities[n].name === name));
  for (const name of entry.abilities) {
    if (tables.abilities.has(key(name)) || (numberOf(name) >= 1 && numberOf(name) <= SAME_ABILITIES)) abilities.push(name);
    else if (ownAbilities && numberOf(name) >= data.newAbilities[0]) abilities.push(name);
  }
  if (!abilities.length) abilities.push(...entry.abilities.map(name => data.colosseum.abilities[name]).filter(Boolean));
  const moveList = levelUpMoves(learns, usable);
  const evolutions = entry.evolutions.map(evolution => evolutionOf(data, evolution, usable, number)).filter(Boolean);
  const types = [...new Set(entry.types)];
  return {
    base: (STAND_INS[types[0]] || STAND_INS.Normal)[stageOf(data, number) - 1],
    // (a form, 722 on: its base's name in the game, and its base's National number in the description)
    name: gameName(entry.gameName || entry.name), national: number,
    description: entry.formOf ? `${entry.name}: a form of #${entry.formOf}, ${entry.gameName}.` : `Generation ${generationOf(number)}, National Pokédex #${number}.`,
    types, stats: entry.stats, ...(entry.evYield ? { evYield: entry.evYield } : {}),
    ...(entry.catchRate ? { catchRate: entry.catchRate } : {}), ...(entry.baseExp ? { baseExp: entry.baseExp } : {}),
    ...(entry.baseFriendship !== undefined ? { baseFriendship: entry.baseFriendship } : {}),
    ...(entry.growthRate ? { growthRate: entry.growthRate } : {}),
    gender: entry.gender, ...(entry.height ? { height: entry.height } : {}), ...(entry.weight ? { weight: entry.weight } : {}),
    ...(abilities.length ? { abilities: abilities.slice(0, 2) } : {}),
    moves: moveList.length ? moveList : [[1, 33]],
    // the disc's TMs it can use: a move it learns by TM, a tutor or level in its generation (generation 6 teaches the
    // third's Iron Tail and Shock Wave by a tutor, and Water Pulse by level to many)
    tmMoves: [...new Set([...(learns.tm || entry.tm || []), ...(learns.tutor || entry.tutor || []), ...(learns.levelUp || entry.levelUp || []).map(([, move]) => move)])]
      .map(usable).filter(Boolean),
    // always, even none: without, the row keeps its stand-in's (Arceus evolved into Linoone)
    evolutions
  };
}

// Everything the settings ask for, for the expansion file: { rules (or null), moves, species: [{ id, number, spec }],
// ownSpecies (ownSpecies), notes }. tables: src/pokemon-packs.js readGameTables.
// A later generation's ability by the game's number: its own, but Tangled Feet's 77 is Air Lock's in Colosseum (which keeps
// Ruby and Sapphire's numbers, Cacophony 76 and Air Lock 77), so it's 124 (host/gen4.c), and generations 5 and 6's,
// from Pickpocket's 124, are one past their own (125 to 192).
const colosseumAbility = number => number === 77 ? 124 : number >= 124 ? number + 1 : number;
// The other way: a later generation's ability number from the game's
const abilityNumber = id => id === 124 ? 77 : id > 124 ? id - 1 : id;

// The Pokémon's base stats, base experience and hidden abilities, where the mechanics change them (gen6Stats,
// hiddenAbilities), from generation 6's file: [{ id, stats (6, or null), hidden (the game's ability number, or 0), exp
// (when it changes) }] for the game's own Pokémon (the SPCH and SPEX chunks, host/species.c), only where they differ
// from the disc's row.
const STAT_KEYS = ['hp', 'attack', 'defense', 'spAttack', 'spDefense', 'speed'];   // a species row's order (0x84: src/pokemon-packs.js STATS)
function speciesChanges(tables, chosen, abilityId) {
  const wantStats = chosen.mechanics.includes('gen6Stats'), wantHidden = chosen.mechanics.includes('hiddenAbilities');
  if (!wantStats && !wantHidden || !available().some(each => each.generation === 6)) return [];
  const data = load(6), out = [];
  for (const each of tables.species || []) {
    const entry = each.national >= 1 && each.national <= 386 ? data.species[each.national] : null;
    if (!entry || !each.row) continue;
    const stats = wantStats ? STAT_KEYS.map(k => entry.stats[k]) : null;
    const same = !stats || stats.every((value, i) => value === each.row.readUInt16BE(0x84 + i * 2));
    const hidden = wantHidden && entry.hidden ? abilityId(entry.hidden) || 0 : 0;
    // generation 5 on's base experience, with the later base stats (the SPEX chunk)
    const exp = wantStats && entry.baseExp && entry.baseExp !== each.row.readUInt16BE(0x06) ? entry.baseExp : 0;
    if (!same || hidden || exp) out.push({ id: each.id, stats: same ? null : stats, hidden, ...(exp ? { exp } : {}) });
  }
  return out;
}

const withoutFairy = types => types.includes('Fairy') ? (types.filter(type => type !== 'Fairy').length ? types.filter(type => type !== 'Fairy') : ['Normal']) : types;

function build(tables, settings) {
  const chosen = normalize(settings), out = { rules: null, moves: [], abilities: [], species: [], ownSpecies: [], types: null,
    speciesChanges: [], mechanics: chosen.mechanics, notes: [] };
  // With the Fairy type, the game has a 19th type, after Dark
  if (chosen.fairyType) tables = { ...tables, types: [...tables.types.slice(0, FAIRY_TYPE), key(loadFairy().type)] };
  const learned = learnsetGeneration(chosen);
  const generations = new Set([...chosen.generationPokemon, ...(chosen.battleRules > COLOSSEUM_RULES ? [chosen.battleRules] : []),
    ...(learned > COLOSSEUM_RULES ? [learned] : [])]);
  // each new move once, by its number in the game: the rules' generation's, else the latest's (its numbers and flags)
  const moveById = new Map();
  const order = [...generations].sort((a, b) => (a === chosen.battleRules) - (b === chosen.battleRules) || a - b);
  for (const generation of order) {
    const data = load(generation), moves = newMoves(tables, data);
    // The moves come with the generation's rules too, Pokémon or not: its Metronome calls any of them. A generation's
    // learnsets bring theirs.
    if (chosen.generationPokemon.includes(generation) || chosen.battleRules >= generation || learned === generation)
      for (const move of moves) moveById.set(move.id, move);
    // its abilities, [name, number], which the game has under its rules
    if (chosen.battleRules >= generation)
      for (let n = data.newAbilities[0]; n <= data.newAbilities[1]; n++) if (data.abilities[n] && !out.abilities.some(([, id]) => id === colosseumAbility(n)))
        out.abilities.push([data.abilities[n].name, colosseumAbility(n)]);
  }
  out.moves = [...moveById.values()].sort((a, b) => a.id - b.id);
  // each imported generation's Pokémon, as its own file has them, learning moves as the chosen learnsets' file has them
  const learnData = learned > COLOSSEUM_RULES ? load(learned) : null;
  for (const generation of chosen.generationPokemon) {
    const data = load(generation);
    // (and the forms with stats of their own, past them: generation 6's file's, 722 on)
    const numbers = [];
    for (let number = data.newSpecies[0]; number <= data.newSpecies[1]; number++) numbers.push(number);
    if (data.forms) for (let number = data.forms[0]; number <= data.forms[1]; number++) numbers.push(number);
    for (const number of numbers) {
      if (!data.species[number]) continue;
      const spec = speciesSpec(tables, data, number, out.moves, chosen.battleRules >= generation, learnData);
      const later = chosen.mechanics.includes('gen6Stats') && learnData?.generation >= 6 && learnData.species[number] ? learnData.species[number]
        : chosen.mechanics.includes('gen6Stats') && available().some(each => each.generation === 6) ? load(6).species[number] : null;
      // (generation 6's base stats, and generation 5 on's base experience)
      if (later) { spec.stats = later.stats; if (later.baseExp) spec.baseExp = later.baseExp; }
      out.species.push({ id: speciesId(number), number, generation, spec });
    }
  }
  // Without Gen 6 types the game has no Fairy type: generation 6's Fairy Pokémon are their other type, or Normal (as
  // generation 6 made Clefairy Fairy from Normal)
  if (!chosen.fairyType) for (const each of out.species) each.spec.types = withoutFairy(each.spec.types);
  // the game's own Pokémon learn (and evolve) as the chosen learnsets' generation has them
  if (learnData) {
    const evolveData = chosen.generationPokemon.length ? load(Math.max(...chosen.generationPokemon)) : null;
    out.ownSpecies = ownSpecies(tables, learnData, out.moves, evolveData);
    // only into the Pokémon imported (generations 5 and 6's without the fourth's: no Magnezone)
    const imported = new Set(out.species.map(each => intoOf(each.number)));
    for (const each of out.ownSpecies) each.evolutions = each.evolutions.filter(evolution => typeof evolution.into !== 'string' || imported.has(evolution.into));
  }
  if (chosen.fairyType) {
    const fairy = loadFairy();
    for (const move of fairyMoves(tables)) if (!moveById.has(move.id)) { moveById.set(move.id, move); out.moves.push(move); }
    out.types = fairyTypes(tables);
    // a later generation's Pokémon with generation 6's types (Togekiss, Mime Jr.) and its Fairy moves
    for (const each of out.species) {
      if (fairy.species[each.number]) each.spec.types = [...fairy.species[each.number]];
      each.spec.moves = withFairyMoves(each.spec.moves, each.number);
    }
    // the game's own Pokémon that learn a Fairy move by level: their level-up moves (the generation's, or the disc's)
    // with it
    for (const each of tables.species || []) {
      if (!each.row || !(each.national >= 1 && each.national <= 386) || !fairy.levelUp[each.national]) continue;
      let own = out.ownSpecies.find(entry => entry.id === each.id);
      if (!own) out.ownSpecies.push(own = { id: each.id, national: each.national, levelUp: rowLevelUp(each.row), evolutions: [] });
      own.levelUp = withFairyMoves(own.levelUp, each.national);
    }
    out.typeNames = tables.types;
  }
  // abilities by name, the game's number: the disc's, then those of the generations' that it plays under these rules
  const abilityId = name => tables.abilities.get(key(name)) ?? out.abilities.find(([n]) => key(n) === key(name))?.[1];
  out.speciesChanges = speciesChanges(tables, chosen, abilityId);
  // a later generation's Pokémon's hidden abilities too (Scizor's is the disc's own; Lucario's Justified isn't one the
  // game has)
  if (chosen.mechanics.includes('hiddenAbilities') && available().some(each => each.generation === 6))
    for (const each of out.species) {
      const name = load(6).species[each.number]?.hidden, id = name ? abilityId(name) : 0;
      if (id && !out.speciesChanges.some(change => change.id === each.id)) out.speciesChanges.push({ id: each.id, stats: null, hidden: id });
    }
  const features = mechanics.features(chosen.mechanics);
  if (chosen.battleRules > COLOSSEUM_RULES) out.rules = rules(tables, load(chosen.battleRules), out.moves, chosen.mechanics);
  else if (features) {
    // Colosseum's own rules with mechanics of their own (the split): the moves' categories, as generation 4's file has
    // them, and none of the rows a later generation changed
    const data = load(4), highest = Math.max(FIRST_NEW_MOVE, ...out.moves.map(move => move.id + 1)), categories = Buffer.alloc(highest);
    for (let id = 1; id < FIRST_NEW_MOVE; id++) if (data.moves[id]) categories[id] = CATEGORY[data.moves[id].category];
    for (const move of out.moves) categories[move.id] = CATEGORY[move.category] ?? 0;
    out.rules = { generation: COLOSSEUM_RULES, features, categories, changed: [], species: [] };
  }
  return out;
}

module.exports = { gameName, baseNational, FIRST_FORM, abilityNumber, generationOf, pokemonGenerations, withoutFairy, learnsetGeneration, speciesChanges, mechanicList, SAME_ABILITIES, colosseumAbility, COLOSSEUM_RULES, FIRST_NEW_MOVE, MOVE_OFFSET, SPECIES_OFFSET, FEATURES, MV, FLAGS, FAIRY_TYPE, available, load, loadFairy, normalize, build, moveCategories,
  newMoves, fairyMoves, fairyTypes, withFairyMoves, rowLevelUp, rules, speciesSpec, ownSpecies, evolutionOf, learnMoveTable, colosseumMove, speciesId, isGenerationSpecies, stageOf };
