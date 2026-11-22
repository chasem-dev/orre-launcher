'use strict';
// Online Trades: two players trade the Pokémon they choose (shadowtrade-work/SPEC-trades.md). One makes a trade code and
// shares it, the other joins with it (trade-session.js); in the trade window each picks a Pokémon from their party or
// PC boxes and sees the other's, and once both are ready the two swap. Colosseum and XD players trade with each other:
// the receiver's launcher makes the Pokémon its game's (trade-convert.js), and says beforehand when its game couldn't
// take it. A Pokémon that evolves by trade evolves for the receiver with their game's own scene, now when their game
// is running, else the next time they play from the launcher.
//
// As Shadowtrade (shadowtrade.js), a Pokémon is never in two places and never lost: each trade is in the journal
// (state.json here) before the save changes; the Pokémon leaves the save before it's deposited with the room; what
// comes back is acknowledged only once the save holds it. The trade lives in the room until both sides have taken
// what's theirs, so a trade cut short (the launcher closed, the game closed, the network gone) is finished later by
// sync(), from the journal, over HTTP with this player's key.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const savePokemon = require('./save-pokemon');
const convert = require('./trade-convert');
const { TradeSession } = require('./trade-session');

const STATE_VERSION = 1;
const HISTORY = 30;
const EVERSTONE = 195;
// The trade evolutions both discs have (research-trade-evolution.md), by Colosseum's species: [item or 0, into].
// The game decides (pokemonEvolutionCheck's trade mode); this only says which may, so a closed game's waits.
const TRADE_EVOLUTIONS = new Map([[61, [[187, 186]]], [64, [[0, 65]]], [67, [[0, 68]]], [75, [[0, 76]]], [79, [[187, 199]]],
  [93, [[0, 94]]], [95, [[199, 208]]], [117, [[201, 230]]], [123, [[199, 212]]], [137, [[218, 233]]], [373, [[192, 374], [193, 375]]]]);

const b64 = bytes => Buffer.from(bytes).toString('base64');
const unb64 = text => Buffer.from(String(text || ''), 'base64');
const atOf = game => game === 'xd' ? savePokemon.XD.at : savePokemon.COLOSSEUM.at;
const identityOf = (game, bytes) => ({ species: bytes.readUInt16BE(0), rnd: bytes.readUInt32BE(atOf(game).rnd), trainer: bytes.readUInt32BE(atOf(game).trainer) });

// Whether a Pokémon (this game's bytes) evolves by trade, as the game would see it: into what, or 0.
function tradeEvolution(game, bytes) {
  const p = convert.read(game, bytes);
  if (p.item === EVERSTONE || p.egg || p.shadowNow) return 0;
  const into = (TRADE_EVOLUTIONS.get(p.species) || []).find(([item]) => !item || item === p.item);
  return into ? convert.speciesFromColosseum(game, into[1]) : 0;
}

// What the trade window shows of a Pokémon: every stat it has, in the viewer's game's numbers, from its bytes, whichever
// game's (the page works out from them what the game would show: gender, ability, nature's effect, Hidden Power).
function summary(game, bytes, viewerGame = game) {
  const p = convert.read(game, bytes);
  const text = codes => { const end = codes.indexOf(0); return String.fromCharCode(...(end < 0 ? codes : codes.slice(0, end))); };
  return { game, species: convert.speciesFromColosseum(viewerGame, p.species), nickname: p.nicknameText, level: p.level, exp: p.exp,
    item: Math.max(convert.itemFromColosseum(viewerGame, Math.max(p.item, 0)), 0), heldKeyItem: p.item < 0,
    moves: p.moves.filter(m => !m.shadow).map(m => ({ id: convert.moveFromColosseum(viewerGame, m.id), pp: m.pp, ppUps: m.ppUps })),
    personality: p.rnd, shiny: (((p.otId >>> 16) ^ (p.otId & 0xffff) ^ (p.rnd >>> 16) ^ (p.rnd & 0xffff)) >>> 0) < 8,
    nature: p.rnd % 25, abilitySlot: p.abilitySlot, ball: p.ball, hp: p.hp, maxHp: p.stats[0], stats: p.stats, ivs: p.ivs, evs: p.evs,
    friendship: p.friendship, otName: text(p.otName), otId: p.otId & 0xffff, otGender: p.otGender,
    ribbons: p.ribbons, contest: p.contest, contestRanks: p.ranks, sheen: p.sheen, pokerus: p.pokerus, markings: p.markings,
    metLevel: p.metLevel, origin: p.attest[0], language: p.attest[3], event: p.event,
    evolvesInto: viewerGame === game ? tradeEvolution(game, bytes) : 0 };
}

function writeAtomic(file, text) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, text);
  try { fs.renameSync(temporary, file); } catch (error) {
    if (process.platform !== 'win32') throw error;
    fs.rmSync(file, { force: true });
    fs.renameSync(temporary, file);
  }
}

const COMMAND_ERRORS = {
  'last-pokemon': 'You can\'t trade your last Pokémon that can battle: keep one in your party.',
  shadow: 'A Shadow Pokémon can\'t be traded until it\'s purified.', egg: 'Eggs can\'t be traded.',
  full: 'Your party and PC boxes are full: make room for the Pokémon you\'re getting.',
  save: 'The game couldn\'t save, so nothing was traded.', missing: 'That Pokémon isn\'t in the save any more.',
  timeout: 'The game didn\'t reach a moment it could trade in: walk around in the field, outside menus and battles.',
  unknown: 'The game didn\'t say whether it traded. The launcher looks at your save and finishes the trade.',
  invalid: 'The game refused the Pokémon. Update the game if Online Trades are new to it.'
};
const commandError = result => COMMAND_ERRORS[result.code] || `The game couldn't trade (${result.code}${result.message ? `: ${result.message}` : ''}).`;

class OnlineTrades extends EventEmitter {
  // url: the trade server; accessFor(game): the save as shadowtrade.js reaches it (cardAccess / liveAccess);
  // receiverFor(game): what that game takes (trade-convert.js problems: laterPokemon, laterMoves, laterItems);
  // unavailable(game): why that save can't be reached now (null: there is none yet)
  constructor({ folder, url, fetch = globalThis.fetch, WebSocket = globalThis.WebSocket, log = () => {}, onChange = () => {},
    accessFor = () => null, receiverFor = game => ({ game }), name = () => 'Trainer', launcher = '', arrivals = null, unavailable = () => null }) {
    super();
    // arrivals: arrivals.js, which has the running game show each Pokémon that came, and do its trade evolution (null:
    // the evolution is this journal's, and nothing is shown)
    Object.assign(this, { folder, url, fetch, WebSocket, log, onChange, accessFor, receiverFor, name, launcherVersion: launcher, arrivals, unavailable });
    this.file = path.join(folder, 'state.json');
    this.state = this.load();
    this.session = null;     // the room this player is in now
    this.room = null;        // { game, role, code }
    this.server = null;      // the room's last state
    this.mine = null;        // what this player offers: { place, identity, data (base64), summary }
    this.verdicts = new Map();   // the other's offers judged: hash -> { ok, problems }
    this.connection = null;
    this.notice = null;
    this.queue = Promise.resolve();
  }

  load() {
    try {
      const state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (state.version === STATE_VERSION) return { journal: [], history: [], ...state };
    } catch (_) { /* a new one */ }
    return { version: STATE_VERSION, journal: [], history: [] };
  }

  save() {
    fs.mkdirSync(this.folder, { recursive: true });
    writeAtomic(this.file, JSON.stringify(this.state, null, 2));
    this.changed();
  }

  changed() { this.onChange(this.view()); }

  // one thing at a time: the save is changed by one step at a time, in order
  serial(work) {
    const run = this.queue.then(work, work);
    this.queue = run.catch(error => this.log(`Online Trades: ${error.message}`));
    return run;
  }

  view() {
    const s = this.server, game = this.room?.game;
    const theirs = s?.peer.offer ? (() => {
      const data = unb64(s.peer.offer.data), judged = this.verdicts.get(s.peer.offer.hash);
      return { hash: s.peer.offer.hash, summary: summary(s.peer.offer.game, data, game), fromGame: s.peer.offer.game,
        problems: judged?.problems || [], evolvesInto: judged?.evolvesInto || 0 };
    })() : null;
    const entry = s?.trade ? this.state.journal.find(each => each.tradeId === s.trade.tradeId) : null;
    return {
      room: this.room ? { ...this.room, connection: this.connection, code: this.session?.displayCode || this.room.code,
        you: s ? { name: s.you.name, offer: this.mine && s.you.offer ? { place: this.mine.place, summary: this.mine.summary } : null,
          accepted: s.you.verdict ? s.you.verdict.ok : null, refusedBecause: s.you.verdict && !s.you.verdict.ok ? s.you.verdict.reason : null, ready: s.you.ready } : null,
        peer: s ? { name: s.peer.name, game: s.peer.game, present: s.peer.present, here: s.peer.here, ready: s.peer.ready, offer: theirs } : null,
        canReady: Boolean(s && this.mine && s.you.offer && theirs && !theirs.problems.length && s.you.verdict?.ok && !s.trade),
        trade: s?.trade ? { tradeId: s.trade.tradeId, stage: s.trade.stage, deadline: s.trade.deadline, reason: s.trade.reason, mine: entry?.stage || null, message: entry?.message || null } : null,
        last: s?.last || null } : null,
      notice: this.notice,
      journal: this.state.journal.map(entry => ({ tradeId: entry.tradeId, game: entry.game, stage: entry.stage, message: entry.message || null,
        sent: entry.sent.summary, received: entry.received?.summary || null, from: entry.received?.from || null, returned: Boolean(entry.received?.returned),
        evolvesInto: entry.evolvesInto || 0, createdAt: entry.createdAt })),
      history: this.state.history.slice(0, HISTORY)
    };
  }

  async post(code, action, body) {
    const response = await this.fetch(`${this.url}/v1/trades/${code}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let reply = null;
    try { reply = await response.json(); } catch (_) { /* below */ }
    if (!response.ok) throw Object.assign(new Error(reply?.error || `The trade server answered ${response.status}.`), { status: response.status, reply });
    return reply;
  }

  // ---- the room ----

  async open(game, code = null) {
    if (this.session) this.leave();
    if (!this.accessFor(game)) throw new Error(this.unavailable(game) || 'There is no save to trade from yet.');
    const session = new TradeSession({ url: this.url, WebSocket: this.WebSocket, hello: { name: this.name(game), game, launcher: this.launcherVersion } });
    this.session = session;
    this.room = { game, role: code ? 'joiner' : 'host', code: null };
    this.mine = null; this.server = null; this.verdicts.clear(); this.notice = null; this.connection = 'connected';
    session.on('room', ({ code: roomCode }) => { this.room.code = roomCode; this.changed(); });
    session.on('state', state => this.serial(() => this.onState(session, state)));
    session.on('connection', status => { this.connection = status === 'lost' ? 'reconnecting' : 'connected'; this.changed(); });
    session.on('room-error', reason => { if (reason === 'stale') return; this.log(`Online Trades: the room said ${reason}.`); });
    session.on('closed', ({ reason }) => {
      if (this.session !== session) return;
      this.notice = reason === 'host-left' ? 'The other player closed the trade room.' : reason === 'dropped' ? 'The connection to the trade room was lost.' : 'The trade room has closed.';
      this.session = null; this.room = null; this.server = null; this.mine = null;
      this.changed();
    });
    try {
      await (code ? session.join(code) : session.host());
    } catch (error) {
      if (this.session === session) { this.session = null; this.room = null; }
      session.close();
      throw error;
    }
    this.changed();
    return this.view();
  }

  leave() {
    const session = this.session;
    this.session = null; this.room = null; this.server = null; this.mine = null; this.verdicts.clear();
    if (session) session.leave();
    this.changed();
  }

  // This player's Pokémon at `place` ({ area, box, slot }) for the trade, or null to take it back.
  offer(place) {
    if (!this.session || !this.room) throw new Error('Make or join a trade room first.');
    if (this.server?.trade) throw new Error('A trade is under way.');
    if (!place) { this.mine = null; this.session.offer(null); this.changed(); return this.view(); }
    const access = this.accessFor(this.room.game), read = access?.read();
    if (!read) throw new Error('There is no save to trade from yet.');
    const list = place.area === 'party' ? read.model.party : read.model.boxes[place.box]?.pokemon;
    const pokemon = list?.[place.slot];
    const problem = savePokemon.tradeProblem(read.model, pokemon);
    if (problem) throw new Error(problem);
    const identity = { species: pokemon.species, rnd: pokemon.rnd, trainer: pokemon.trainer };
    const found = savePokemon.findPokemon(read.ctx, identity, place);
    // what would keep any game from taking it (the other's own say comes as its verdict)
    const own = convert.problems(convert.read(this.room.game, found.bytes), { game: this.room.game, laterPokemon: true, laterMoves: true, laterItems: true });
    if (own.length) throw new Error(own[0].text);
    this.mine = { place, identity, data: b64(found.bytes), summary: summary(this.room.game, found.bytes) };
    this.session.offer({ game: this.room.game, data: this.mine.data });
    this.changed();
    return this.view();
  }

  ready() { if (!this.view().room?.canReady) throw new Error('Both of you need a Pokémon the other\'s game can take.'); this.session.ready(); }
  unready() { this.session?.unready(); }

  // ---- what the room says ----

  async onState(session, state) {
    // only the room's latest: states that came while a step ran (the game taking a Pokémon) are older than it
    if (session !== this.session || state !== session.state) return;
    this.server = state;
    // the room forgot the offers (a trade finished): so does the window. Only once the room has had this one: a state
    // the room sent before this offer reached it says none, and isn't about it.
    if (state.you.offer && this.mine && state.you.offer.data === this.mine.data) this.mine.confirmed = true;
    if (!state.you.offer && this.mine?.confirmed) this.mine = null;
    // the other's offer: can this save take it?
    const theirs = state.peer.offer;
    if (theirs && !this.verdicts.has(theirs.hash)) {
      const judged = this.judge(theirs);
      this.verdicts.set(theirs.hash, judged);
      session.verdict(theirs.hash, !judged.problems.length, judged.problems[0]?.text);
    }
    const trade = state.trade;
    if (trade) await this.advance(trade);
    this.changed();
  }

  judge(offer) {
    const game = this.room.game;
    try {
      const made = convert.convert(offer.game, unb64(offer.data), this.receiverFor(game));
      const problems = [...made.problems];
      const read = this.accessFor(game)?.read();
      if (read && !problems.length) {
        const slots = [...read.model.party, ...read.model.boxes.flatMap(box => box.pokemon)];
        const free = read.model.party.filter(each => !each).length + read.model.boxes.reduce((n, box) => n + box.pokemon.filter(each => !each).length, 0);
        if (!free && !this.mine && slots.length) problems.push({ code: 'full', text: 'The other player\'s party and boxes are full.' });
      }
      return { problems, evolvesInto: made.bytes ? tradeEvolution(game, made.bytes) : 0 };
    } catch (_) {
      return { problems: [{ code: 'invalid', text: 'That Pokémon\'s data is damaged.' }], evolvesInto: 0 };
    }
  }

  // A trade under way, as the room sees it: take, deposit, give, acknowledge, as far as each can go now.
  async advance(trade) {
    let entry = this.state.journal.find(each => each.tradeId === trade.tradeId);
    const finished = this.state.history.some(each => each.tradeId === trade.tradeId);
    if (trade.stage === 'committed' && !entry && !finished && !trade.deposited.you && this.mine) entry = await this.take(trade.tradeId);
    if (!entry) return;
    await this.step(entry, trade);
  }

  // Takes the offered Pokémon from the save for a committed trade, then deposits it.
  async take(tradeId) {
    const access = this.accessFor(this.room.game);
    const { code, key } = { code: this.session.code, key: this.session.key };
    const mine = this.mine;
    const read = access?.read();
    const found = read && savePokemon.findPokemon(read.ctx, mine.identity, mine.place);
    if (!found || b64(found.bytes) !== mine.data) {
      // changed since it was offered (a level gained in the game, or moved away): the trade can't be this one
      this.session.abort(tradeId, 'changed');
      this.notice = 'Your Pokémon changed in the game since you offered it, so the trade was called off. Offer it again.';
      return null;
    }
    const entry = { tradeId, code, key, role: this.room.role, game: this.room.game, stage: 'taking', createdAt: Date.now(),
      peerName: this.server?.peer.name || null,
      sent: { data: mine.data, identity: mine.identity, place: mine.place, summary: mine.summary } };
    this.state.journal.push(entry);
    this.save();
    const taken = await access.tradeTake(mine.identity, mine.place);
    if (!taken.ok && taken.code === 'unknown') {
      entry.message = commandError(taken);
      this.save();
      return entry;   // (sync() looks at the save)
    }
    if (!taken.ok) {
      this.state.journal = this.state.journal.filter(each => each !== entry);
      this.save();
      this.session.abort(tradeId, commandError(taken));
      this.notice = commandError(taken);
      return null;
    }
    entry.stage = 'taken';
    entry.message = null;
    this.save();
    this.log(`Online Trades: ${mine.summary.nickname} left the save for the trade.`);
    return entry;
  }

  // One trade's next steps from where its journal entry is, given the room's view of it (null: ask the room).
  async step(entry, trade = null) {
    if (entry.stage === 'taking') {
      const access = this.accessFor(entry.game);
      if (!access) return;
      if (access.has(entry.sent.identity)) {
        // the take never happened: the trade can't go on without it
        this.state.journal = this.state.journal.filter(each => each !== entry);
        this.save();
        try { await this.post(entry.code, 'abort', { key: entry.key, tradeId: entry.tradeId, reason: 'not taken' }); } catch (_) { /* the deadline aborts it */ }
        return;
      }
      entry.stage = 'taken';
      this.save();
    }
    if (entry.stage === 'taken') {
      let reply;
      try {
        reply = trade?.deposited?.you ? trade
          : await this.post(entry.code, 'deposit', { key: entry.key, tradeId: entry.tradeId, pokemon: { game: entry.game, data: entry.sent.data } });
      } catch (error) {
        if (error.status === 409 || error.status === 404) reply = await this.post(entry.code, 'status', { key: entry.key, tradeId: entry.tradeId }).catch(() => null);
        if (!reply) { entry.message = `Not sent yet: ${error.message} It's kept safe and finished when the server can be reached.`; this.save(); return; }
      }
      if (reply.stage === 'released' && reply.pokemon) {
        entry.stage = 'received';
        entry.received = { game: reply.pokemon.game, data: reply.pokemon.data, from: reply.from || entry.peerName || 'Trainer', summary: summary(reply.pokemon.game, unb64(reply.pokemon.data), entry.game) };
      } else if (reply.stage === 'returned' || (reply.stage === 'aborted' && !trade?.deposited?.you)) {
        // called off: this side's own Pokémon goes back into its save
        entry.stage = 'received';
        entry.received = { game: entry.game, data: entry.sent.data, from: null, returned: true, reason: reply.reason || null, summary: entry.sent.summary };
      } else if (reply.stage === 'done') {
        entry.stage = 'given';
      } else { entry.message = null; this.save(); return; }   // waiting for the other side's deposit
      entry.message = null;
      this.save();
    }
    if (entry.stage === 'received' || entry.stage === 'giving') await this.give(entry);
    if (entry.stage === 'given') {
      try { await this.post(entry.code, 'ack', { key: entry.key, tradeId: entry.tradeId }); } catch (error) {
        if (error.status !== 404) { this.log(`Online Trades: couldn't tell the server yet (${error.message}).`); return; }
      }
      if (this.arrivals && entry.placed && !entry.received?.returned) {
        this.arrivals.add({ game: entry.game, kind: 'trade', from: entry.received.from || '', data: entry.placed.data, identity: entry.placed.identity,
          place: entry.placed.place, evolvesInto: entry.evolvesInto || 0, tradeId: entry.tradeId });
        entry.stage = 'finished';
      } else entry.stage = entry.evolvesInto ? 'evolving' : 'finished';
      this.save();
    }
    if (entry.stage === 'evolving') await this.evolve(entry);
    if (entry.stage === 'finished') this.finish(entry);
  }

  // The Pokémon that came (or this side's own, called off) into the save, made this game's.
  async give(entry) {
    const access = this.accessFor(entry.game);
    if (!access) return;
    let made;
    try {
      made = convert.convert(entry.received.game, unb64(entry.received.data), { ...this.receiverFor(entry.game), game: entry.game });
    } catch (error) { entry.message = error.message; this.save(); return; }
    if (!made.bytes) { entry.message = `Your game can't take it: ${made.problems[0].text}`; this.save(); return; }
    const identity = identityOf(entry.game, made.bytes);
    if (entry.stage === 'received') { entry.stage = 'giving'; this.save(); }
    const given = access.has(identity) ? { ok: true, already: true } : await access.tradeGive(made.bytes);
    if (!given.ok) {
      entry.stage = given.code === 'unknown' ? 'giving' : 'received';
      entry.message = commandError(given);
      this.save();
      return;
    }
    entry.stage = 'given';
    entry.placed = { identity, place: given.area ? { area: given.area, box: given.box, slot: given.slot } : null, data: b64(made.bytes) };
    entry.evolvesInto = entry.received.returned ? 0 : tradeEvolution(entry.game, made.bytes);
    entry.message = null;
    this.save();
    this.log(entry.received.returned ? `Online Trades: ${entry.sent.summary.nickname} is back in the save (the trade was called off).`
      : `Online Trades: ${entry.received.summary.nickname} from ${entry.received.from} is in the save.`);
  }

  // A trade evolution: the running game does it with its scene; a closed one's waits for the game.
  async evolve(entry) {
    const access = this.accessFor(entry.game);
    if (!access?.evolve || !entry.placed) { entry.stage = 'finished'; return; }
    const place = entry.placed.place || { area: 'party', box: 0, slot: 0 };
    const result = await access.evolve(entry.placed.identity, place);
    if (result.ok || result.code === 'missing') {
      entry.stage = 'finished';
      entry.message = null;
      this.save();
      return;
    }
    entry.message = result.code === 'later' ? 'It evolves the next time you play from the launcher.' : commandError(result);
    this.save();
  }

  finish(entry) {
    this.state.journal = this.state.journal.filter(each => each !== entry);
    // evolved: false while a trade evolution waits for the running game (arrivals.js), true once it has happened
    const waits = Boolean(this.arrivals && entry.evolvesInto && this.arrivals.isWaiting(entry.tradeId));
    this.state.history.unshift({ tradeId: entry.tradeId, game: entry.game, sent: entry.sent.summary, received: entry.received?.summary || null,
      from: entry.received?.from || null, returned: Boolean(entry.received?.returned), evolvedInto: entry.evolvesInto || 0, evolved: entry.evolvesInto ? !waits : false, at: Date.now() });
    this.state.history = this.state.history.slice(0, HISTORY);
    this.save();
  }

  // The running game has shown a Pokémon that came (arrivals.js): result.evolved, the species it evolved into (0 none)
  arrived(tradeId, result) {
    const item = this.state.history.find(each => each.tradeId === tradeId);
    if (!item) return;
    item.evolved = Boolean(result?.evolved) || (item.evolvedInto && result?.already) || false;
    if (item.evolvedInto && !item.evolved && result?.ok) item.evolvedInto = 0;   // it didn't evolve after all (an Everstone, say)
    item.shown = true;
    this.save();
  }

  // Every trade the journal has that isn't finished: as far as each can go now (the launcher started, a game linked).
  sync() {
    return this.serial(async () => {
      for (const entry of [...this.state.journal]) {
        const live = this.server?.trade?.tradeId === entry.tradeId ? this.server.trade : null;
        await this.step(entry, live);
      }
      return this.view();
    });
  }
}

module.exports = { OnlineTrades, summary, tradeEvolution, TRADE_EVOLUTIONS };
