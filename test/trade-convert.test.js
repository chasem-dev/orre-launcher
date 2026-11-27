'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tc = require('../src/trade-convert');
const { tradeEvolution, summary, offerProblems } = require('../src/online-trades');

const name = (b, at, text) => [...text].forEach((c, i) => b.writeUInt16BE(c.charCodeAt(0), at + 2 * i));

// A Colosseum Pokémon as a save holds one, with leftover memory where no field is.
function colosseum({ species = 64, item = 0, moves = [93, 50, 60, 248], shadow = 0, heart = -100, rnd = 0x12345678 } = {}) {
  const b = Buffer.alloc(0x138, 0);
  b.writeUInt16BE(species, 0); b.writeUInt32BE(rnd, 0x04); b.writeUInt32BE(0x0b030202, 0x08);
  b.writeUInt16BE(0x2a, 0x0c); b[0x0e] = 12; b[0x0f] = 4; b[0x10] = 0; b.writeUInt32BE(0xae3b618b, 0x14);
  name(b, 0x18, 'LEO'); name(b, 0x2e, 'KADABRA'); name(b, 0x44, 'KADABRA'); b.writeUInt16BE(0x8d71, 0x44 + 22);
  b.writeUInt32BE(27000, 0x5c); b[0x60] = 30; b.writeUInt32BE(0x5, 0x64);
  moves.forEach((m, i) => { b.writeUInt16BE(m, 0x78 + 4 * i); b[0x78 + 4 * i + 2] = 10; b[0x78 + 4 * i + 3] = i === 0 ? 2 : 0; });
  b.writeUInt16BE(item, 0x88); b.writeUInt16BE(70, 0x8a);
  [80, 40, 35, 100, 60, 95].forEach((v, i) => b.writeUInt16BE(v, 0x8c + 2 * i));
  [4, 0, 0, 252, 0, 252].forEach((v, i) => b.writeUInt16BE(v, 0x98 + 2 * i));
  [31, 2, 30, 31, 17, 31].forEach((v, i) => b.writeUInt16BE(v, 0xa4 + 2 * i));
  b.writeUInt16BE(140, 0xb0); b[0xb2] = 10; b[0xbc] = 3; b[0xbd] = 1; b[0xc6] = 1; b[0xcc] = 1; b[0xcf] = 5; b[0xd0] = 0xff;
  b.writeUInt16BE(shadow, 0xd8); b.writeInt32BE(heart, 0xdc);
  b.writeUInt32BE(0x70864080, 0x100);   // leftover host memory past the last field
  return b;
}

const anyReceiver = game => ({ game, laterPokemon: true, laterMoves: true, laterItems: true });

test('a Colosseum Pokémon made XD\'s and back keeps every field, and leaves leftover memory behind', () => {
  const original = colosseum();
  const xd = tc.convert('colosseum', original, anyReceiver('xd'));
  assert.deepEqual(xd.problems, []);
  assert.equal(xd.bytes.length, 0xc4);
  const asXd = tc.read('xd', xd.bytes);
  assert.deepEqual([asXd.species, asXd.rnd, asXd.otId, asXd.level, asXd.exp, asXd.nicknameText], [64, 0x12345678, 0xae3b618b, 30, 27000, 'KADABRA']);
  assert.deepEqual(asXd.ivs, [31, 2, 30, 31, 17, 31]);
  assert.deepEqual(asXd.ribbons.slice(0, 12).map(Number), [1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]);
  assert.equal(xd.bytes.readUInt32BE(0x7c) & 0xfff, 0);   // XD's spare ribbon bits stay clear
  const back = tc.convert('xd', xd.bytes, anyReceiver('colosseum')).bytes;
  const a = tc.read('colosseum', original), c = tc.read('colosseum', back);
  for (const key of ['species', 'rnd', 'otId', 'otName', 'nickname', 'exp', 'level', 'moves', 'item', 'stats', 'evs', 'ivs', 'friendship', 'contest', 'sheen', 'ribbons', 'abilitySlot', 'markings'])
    assert.deepEqual(c[key], a[key], key);
  assert.equal(back.readUInt32BE(0x100), 0);            // the leftover word didn't travel
  assert.equal(back.readUInt16BE(0x44 + 22), 0);        // nor the 12th letter of the original name
  assert.equal(back.readUInt32BE(0x64), 0);             // its status healed
});

test('a purified Pokémon arrives without its old Shadow id or Shadow move', () => {
  const purified = colosseum({ shadow: 12, heart: -100, moves: [356, 93] });
  const made = tc.convert('colosseum', purified, anyReceiver('colosseum'));
  assert.deepEqual(made.problems, []);
  assert.equal(made.bytes.readUInt16BE(0xd8), 0);
  assert.equal(made.bytes.readInt32BE(0xdc), -100);
  assert.deepEqual(tc.read('colosseum', made.bytes).moves.map(m => m.id), [93]);
  const xd = tc.convert('colosseum', purified, anyReceiver('xd'));
  assert.equal(xd.bytes.readUInt16BE(0xba), 0);
});

test('what the receiver\'s game can\'t take is said, not sent', () => {
  const codes = (bytes, receiver, game = 'colosseum') => tc.convert(game, bytes, receiver).problems.map(p => p.code);
  assert.deepEqual(codes(colosseum({ shadow: 3, heart: 2000 }), anyReceiver('xd')), ['shadow']);
  assert.deepEqual(codes(colosseum({ species: 420 }), { game: 'xd' }), ['later-species']);
  assert.deepEqual(codes(colosseum({ species: 420 }), anyReceiver('xd')), []);
  assert.deepEqual(codes(colosseum({ species: 260 }), anyReceiver('xd')), ['pack']);
  assert.deepEqual(codes(colosseum({ item: 0x219 }), anyReceiver('xd')), ['key-item']);
  assert.deepEqual(codes(colosseum({ item: 0x237 }), { game: 'xd', laterPokemon: true, laterMoves: true }), ['later-item']);
  assert.deepEqual(codes(colosseum({ moves: [400] }), { game: 'xd' }), ['later-move']);
  assert.deepEqual(codes(colosseum({ moves: [356] }), anyReceiver('xd')), ['no-moves']);
});

test('the fourth generation\'s numbers and XD\'s own Bonsly and Munchlax', () => {
  assert.equal(tc.speciesFromColosseum('xd', 420), 422);
  assert.equal(tc.speciesToColosseum('xd', 422), 420);
  assert.equal(tc.speciesFromColosseum('xd', 464), 413);
  assert.equal(tc.speciesToColosseum('xd', 414), 472);
  assert.equal(tc.moveFromColosseum('xd', 400), 417);
  assert.deepEqual(tc.moveToColosseum('xd', 360), { id: 0, shadow: true });
  assert.equal(tc.itemFromColosseum('xd', 0x237), 0x265);
  // Gen 5, Gen 6 and alternate form rows (up to 773 -> XD 775) round-trip cleanly
  assert.equal(tc.speciesFromColosseum('xd', 520), 522);
  assert.equal(tc.speciesToColosseum('xd', 522), 520);
  assert.equal(tc.speciesFromColosseum('xd', 684), 686);
  assert.equal(tc.speciesToColosseum('xd', 686), 684);
  assert.equal(tc.speciesFromColosseum('xd', 773), 775);
  assert.equal(tc.speciesToColosseum('xd', 775), 773);
  // a later Pokémon round trip through XD lands where it was
  const bonsly = colosseum({ species: 464 });
  const there = tc.convert('colosseum', bonsly, anyReceiver('xd')).bytes;
  assert.equal(there.readUInt16BE(0), 413);
  assert.equal(tc.convert('xd', there, anyReceiver('colosseum')).bytes.readUInt16BE(0), 464);
});

test('a trade evolution is foreseen as the game would see it: the item, an Everstone', () => {
  assert.equal(tradeEvolution('colosseum', colosseum({ species: 64 })), 65);
  assert.equal(tradeEvolution('colosseum', colosseum({ species: 64, item: 195 })), 0);
  assert.equal(tradeEvolution('colosseum', colosseum({ species: 95 })), 0);
  assert.equal(tradeEvolution('colosseum', colosseum({ species: 95, item: 199 })), 208);
  assert.equal(tradeEvolution('colosseum', colosseum({ species: 373, item: 193 })), 375);
  assert.equal(tradeEvolution('colosseum', colosseum({ species: 328, item: 0x2a2 })), 329);
  assert.equal(tradeEvolution('colosseum', colosseum({ species: 708, item: 0x2a4 })), 709);
  assert.equal(tradeEvolution('colosseum', colosseum({ species: 710, item: 0x2a3 })), 711);
  const xdSwirlix = tc.convert('colosseum', colosseum({ species: 710, item: 0x2a3 }), { ...anyReceiver('xd'), gen6Pokemon: true, gen6Moves: true, gen6Items: true }).bytes;
  assert.equal(tradeEvolution('xd', xdSwirlix), 713);
  const card = summary('colosseum', colosseum(), 'xd');
  assert.deepEqual([card.species, card.nickname, card.level, card.otName, card.otId, card.evolvesInto], [64, 'KADABRA', 30, 'LEO', 0x618b, 0]);
});

test('a Generation 5 or 6 Pokémon, move or held item can be offered: the other player\'s game says whether it takes it', () => {
  const codes = (game, bytes) => offerProblems(game, bytes).map(p => p.code);
  assert.deepEqual(codes('colosseum', colosseum({ species: 710 })), []);                        // Swirlix
  assert.deepEqual(codes('colosseum', colosseum({ moves: [93, 588] })), []);                    // Moonblast
  assert.deepEqual(codes('colosseum', colosseum({ moves: [93, 506] })), []);                    // a Gen 5 move
  assert.deepEqual(codes('colosseum', colosseum({ item: 0x28a })), []);                         // Assault Vest
  const xdSwirlix = tc.convert('colosseum', colosseum({ species: 710 }), { ...anyReceiver('xd'), gen6Pokemon: true, gen6Moves: true, gen6Items: true }).bytes;
  assert.deepEqual(codes('xd', xdSwirlix), []);
  // what no game takes still can't be offered
  assert.deepEqual(codes('colosseum', colosseum({ species: 260 })), ['pack']);
  assert.deepEqual(codes('colosseum', colosseum({ species: 64, shadow: 5, heart: 1000 })), ['shadow']);
});
