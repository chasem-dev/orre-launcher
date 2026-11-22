// Pokémon that came from a trade (Online Trades or Shadowtrade) and are already in the save, waiting for the running game
// to show them: its P★DA-style notice, a trade evolution with the game's own scene, then a card with the Pokémon and
// "Open PC" or "Close" (the game's "arrive" command, host/arrival.c). Kept in a file until the game has shown each, so a
// trade made with the game closed is shown the next time it runs, and a trade evolution waits for it too.
//
// An arrival: { id, game, kind: 'trade'|'shadowtrade'|'local', from, data (base64: the Pokémon as this game has it),
// identity, place, evolvesInto (0 or the species it evolves into by trade), tradeId, at, saveTrainer (the trainer id of
// the save it went into), restored (times it was put back) }.
//
// A Pokémon the game can't find in its save ("error missing": a game left running from before saved over the trade, or
// an older copy of the save was loaded) is never let go: its bytes are kept here, and the launcher puts it back into
// that save (the same trainer id) the next time the game runs with it, then has the game show it.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATE_VERSION = 1;
const SHOW_DAYS = 30;   // a notice not shown in this long is let go (a trade evolution never is, nor a missing Pokémon)
const RESTORE_MAX = 3;  // times a missing Pokémon is put back; after that it waits (its bytes kept) for a person to look

function writeAtomic(file, text) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, text);
  try { fs.renameSync(temporary, file); } catch (error) {
    if (process.platform !== 'win32') throw error;
    fs.rmSync(file, { force: true });
    fs.renameSync(temporary, file);
  }
}

class Arrivals {
  // describe(arrival) -> { lines: ['show ...'], art: [{ width, height, rgba }] } (main.js: names, sprites); onDone(arrival,
  // result): shown (result.evolved: the species it evolved into, 0 none); trainerOf(game): the trainer id of that game's
  // save now (null unknown); onRestored(arrival): a missing Pokémon was put back.
  constructor({ folder, log = () => {}, onChange = () => {}, describe = () => ({ lines: [], art: [] }), onDone = () => {}, trainerOf = () => null,
    onRestored = () => {}, now = () => Date.now() }) {
    Object.assign(this, { folder, log, onChange, describe, onDone, trainerOf, onRestored, now });
    this.file = path.join(folder, 'state.json');
    this.state = this.load();
    this.busy = null;
    this.said = new Set();   // missing Pokémon already logged as waiting, this run
  }

  load() {
    try {
      const state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (state.version === STATE_VERSION && Array.isArray(state.waiting)) return state;
    } catch (_) { /* none yet */ }
    return { version: STATE_VERSION, waiting: [] };
  }

  save() {
    fs.mkdirSync(this.folder, { recursive: true });
    writeAtomic(this.file, JSON.stringify(this.state, null, 2));
    this.onChange(this.view());
  }

  view() { return { waiting: this.state.waiting.map(({ data, ...rest }) => rest) }; }

  add(arrival) {
    let saveTrainer = null;
    try { saveTrainer = this.trainerOf(arrival.game) ?? null; } catch (_) { /* no save to read: unknown */ }
    const entry = { id: crypto.randomBytes(8).toString('hex'), at: this.now(), evolvesInto: 0, saveTrainer, restored: 0, ...arrival };
    if (entry.tradeId && this.state.waiting.some(each => each.tradeId === entry.tradeId)) return null;
    this.state.waiting.push(entry);
    this.save();
    return entry;
  }

  pending(game) { return this.state.waiting.filter(each => !game || each.game === game); }
  isWaiting(tradeId) { return this.state.waiting.some(each => each.tradeId === tradeId); }

  remove(entry) {
    this.state.waiting = this.state.waiting.filter(each => each !== entry);
    this.save();
  }

  // The game's showing of one: its notice and card (arrive), or a trade evolution alone for a game without arrive
  async show(entry, access) {
    if (access.arrive) {
      let shown = { lines: [], art: [] };
      try { shown = this.describe(entry) || shown; } catch (error) { this.log(`Trades: couldn't describe the Pokémon (${error.message}).`); }
      return access.arrive(entry.identity, entry.place, { evolve: Boolean(entry.evolvesInto), lines: shown.lines, art: shown.art });
    }
    if (entry.evolvesInto && access.evolve) {
      const result = await access.evolve(entry.identity, entry.place || { area: 'party', box: 0, slot: 0 });
      if (result.ok) result.evolved = result.area === 'evolved' ? entry.evolvesInto : 0;   // ("ok evolved party 0 1 into N")
      return result;
    }
    return { ok: true, evolved: 0 };   // a game too old to show it: nothing to wait for
  }

  // A Pokémon the game's save doesn't have: put back in it, as the trade gave it. { ok, code, area, box, slot }; code
  // 'kept' for one that can't be put back now (it waits, bytes and all).
  async putBack(entry, access) {
    const who = `the ${entry.kind === 'shadowtrade' ? 'Shadow Pokémon' : 'Pokémon'} from ${entry.from || 'the trade'}`;
    const keep = why => {
      if (!this.said.has(entry.id)) this.log(`Trades: ${who} isn't in the save the game has: ${why} It's kept, with its data, in the launcher.`);
      this.said.add(entry.id);
      return { ok: false, code: 'kept' };
    };
    if (!entry.data) return keep('the launcher has no copy of it to put back.');
    if ((entry.restored || 0) >= RESTORE_MAX) return keep(`it was put back ${RESTORE_MAX} times and went again.`);
    // a Shadow Pokémon needs its entry and, in XD, its record merged as Shadowtrade gives it: only Colosseum's goes back here
    if (entry.kind === 'shadowtrade' && entry.game === 'xd') return keep('an XD Shadow Pokémon can\'t be put back by itself.');
    const give = entry.kind === 'shadowtrade' ? access.give?.bind(access) : access.tradeGive?.bind(access);
    if (!give) return keep('this version of the game can\'t take it while it runs.');
    const data = Buffer.from(entry.data, 'base64');
    const given = entry.kind === 'shadowtrade' ? await give(data, null) : await give(data);
    if (!given.ok) {
      this.log(`Trades: ${who} isn't in the save the game has, and couldn't be put back yet (${given.code}${given.code === 'full' ? ': the party and PC boxes are full' : ''}).`);
      return given;
    }
    entry.restored = (entry.restored || 0) + 1;
    if (given.area) entry.place = { area: given.area, box: given.box, slot: given.slot };
    this.save();
    this.log(`Trades: ${who} wasn't in the save the game has (it was saved over), so the launcher put it back.`);
    try { this.onRestored(entry); } catch (_) { /* (only a notice) */ }
    return given;
  }

  // Shows what is waiting for `game` in the running game, one at a time (access: shadowtrade.js liveAccess; a card's
  // access has no game to show it in, so they wait). Stops at the first the game couldn't show now (it tries again later).
  // One that went to another save (another trainer id) waits for that save.
  deliver(game, access) {
    if (this.busy) return this.busy;
    const run = (async () => {
      {
        if (!access || access.mode !== 'live') return;
        let trainer = null;
        try { trainer = access.read?.()?.model?.trainerId ?? null; } catch (_) { /* unknown */ }
        for (const entry of this.pending(game)) {
          const missing = (entry.restored || 0) > 0 || this.said.has(entry.id);
          if (!entry.evolvesInto && !missing && this.now() - entry.at > SHOW_DAYS * 864e5) { this.remove(entry); continue; }
          if (entry.saveTrainer != null && trainer != null && entry.saveTrainer >>> 0 !== trainer >>> 0) continue;
          if (this.said.has(entry.id)) continue;   // kept, and said so: it waits for a person
          let result = await this.show(entry, access);
          if (!result.ok && result.code === 'missing') {
            if (entry.saveTrainer == null || trainer == null) {
              // which save it went to isn't known: never into another one
              this.putBackUnknown(entry);
              continue;
            }
            const put = await this.putBack(entry, access);
            if (put.code === 'kept') continue;
            if (!put.ok) return;
            result = await this.show(entry, access);
            if (!result.ok && result.code === 'missing') continue;   // (next time: it counts toward RESTORE_MAX)
          }
          if (!result.ok) {
            this.log(`Trades: the game will show ${entry.kind === 'shadowtrade' ? 'the Shadowtrade' : 'the trade'} later (${result.code}).`);
            return;
          }
          this.remove(entry);
          this.onDone(entry, result);
        }
      }
    })();
    this.busy = run.finally(() => { if (this.busy === guarded) this.busy = null; });
    const guarded = this.busy;
    return guarded;
  }

  putBackUnknown(entry) {
    if (this.said.has(entry.id)) return;
    this.said.add(entry.id);
    this.log(`Trades: the Pokémon from ${entry.from || 'the trade'} isn't in the save the game has, and which save it went to isn't known, so it isn't put back by itself. It's kept, with its data, in the launcher.`);
  }
}

module.exports = { Arrivals };
