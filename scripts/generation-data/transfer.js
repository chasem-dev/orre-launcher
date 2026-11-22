'use strict';

// Makes src/generations/gen4-transfer.json: what the launcher needs to bring a Pokémon from a Diamond, Pearl or
// Platinum save into Colosseum or XD (src/save-import.js), from pret's decompilation of Pokémon Platinum:
// - species: the Ruby and Sapphire numbers of the Hoenn Pokémon (277-411) by their National Pokédex numbers (252-386),
//   as Pal Park turns them (src/main_menu/gba_pokemon.c sGBAToDSSpecies);
// - items: Platinum's item numbers in the games' own: an item Ruby and Sapphire had keeps its number there (its gbaID),
//   one Diamond and Pearl added gets the game's, FIRST_NEW_ITEM on, in the order the game's tools/gen4/make_items.py
//   gives them (checked against the game's host/gen4_items.h); an item neither game can hold isn't listed;
// - text: Platinum's characters (tools/msgenc/charmap.txt), each by its code, but Korean's.
//
// usage: node transfer.js PLATINUM_DIR GAME_DIR
//   PLATINUM_DIR: a checkout of https://github.com/pret/pokeplatinum
//   GAME_DIR: a checkout of the game (https://git.softwareauralabs.com/chase/pokemon-colosseum), for host/gen4_items.h
const fs = require('node:fs');
const path = require('node:path');

const [root, game] = process.argv.slice(2);
if (!root || !game) { console.error('usage: node transfer.js PLATINUM_DIR GAME_DIR'); process.exit(1); }
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const lines = file => read(file).split('\n').map(line => line.trim()).filter(Boolean);

// ---- species ----
const national = new Map(lines('generated/species.txt').map((name, i) => [name, i]));
const gbaSpecies = new Map([...read('include/constants/gba/species.h').matchAll(/#define (GBA_SPECIES_\w+)\s+(\d+)/g)].map(([, name, n]) => [name, Number(n)]));
const species = {};
const table = read('src/main_menu/gba_pokemon.c');
for (const [, gba, ds] of table.matchAll(/\{ (GBA_SPECIES_\w+), (SPECIES_\w+) \}/g)) {
  if (!gbaSpecies.has(gba) || !national.has(ds)) throw new Error(`${gba} or ${ds} isn't known.`);
  species[national.get(ds)] = gbaSpecies.get(gba);
}
if (Object.keys(species).length !== 135) throw new Error(`Expected 135 Hoenn Pokémon, found ${Object.keys(species).length}.`);

// ---- items ----
const itemIds = new Map(lines('generated/items.txt').map((name, i) => [name, i]));
const gba = new Map();
{
  const source = read('include/constants/gba/items.h');
  let value = -1;
  for (const [, name, , v] of source.slice(source.indexOf('{')).matchAll(/\b(GBA_ITEM_[A-Z0-9_]+)\b(\s*=\s*(\w+))?/g)) {
    value = v ? (/^\d/.test(v) ? Number(v) : gba.get(v)) : value + 1;
    gba.set(name, value);
  }
}
const FIRST_NEW_ITEM = 0x224;
const header = fs.readFileSync(path.join(game, 'host/gen4_items.h'), 'utf8');
const hostNew = [...header.matchAll(/\{ (0x[0-9A-F]+), (-?\d+), G4_\w+,[^}]*\},\s*\/\* (.*?) \*\//g)]
  .filter(([, number]) => Number(number) >= FIRST_NEW_ITEM).map(([, number, , name]) => ({ id: Number(number), name }));
const files = fs.readdirSync(path.join(root, 'res/items/data')).filter(file => file.endsWith('.json')).sort();
const items = {}, made = [];
for (const file of files) {
  const d = JSON.parse(fs.readFileSync(path.join(root, 'res/items/data', file), 'utf8'));
  const id = itemIds.get(`ITEM_${file.slice(0, -5).toUpperCase()}`);
  if (id === undefined) throw new Error(`${file} has no item number.`);
  const holdable = d.holdEffect !== 'HOLD_EFFECT_NONE' || d.flingPower || d.naturalGiftPower;
  if (d.gbaID !== 'GBA_ITEM_NONE') { items[id] = gba.get(d.gbaID); continue; }
  if (!holdable) continue;
  const number = FIRST_NEW_ITEM + made.length;
  made.push({ id: number, name: d.name });
  items[id] = number;
}
if (made.length !== hostNew.length || made.some((item, i) => item.id !== hostNew[i].id || item.name !== hostNew[i].name))
  throw new Error('The new items don\'t match the game\'s host/gen4_items.h: rebuild that first.');

// ---- text ----
const text = {};
// (a line's trailing space is its character: only leading space is trimmed)
for (const line of read('tools/msgenc/charmap.txt').split('\n').map(each => each.replace(/\r$/, '').trimStart())) {
  const match = /^([0-9A-F]{4})=(.)$/u.exec(line);
  // (Korean, from 0x400 on, isn't a script either game can show)
  if (match && parseInt(match[1], 16) < 0x400) text[parseInt(match[1], 16)] = match[2];
}

const out = { source: 'pret/pokeplatinum (scripts/generation-data/transfer.js)', species, items, text };
fs.writeFileSync(path.join(__dirname, '../../src/generations/gen4-transfer.json'), `${JSON.stringify(out)}\n`);
console.log(`species ${Object.keys(species).length}, items ${Object.keys(items).length} (${made.length} new), text ${Object.keys(text).length}`);
