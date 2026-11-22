'use strict';

// What the Jukebox's Purification Chamber needs to know to dance: where in the music the beat falls, and where each dancer stands and
// how it moves. Nothing here touches the page or the GPU, so it can be tried on its own (test/jukebox-beat.test.js).
(function (root) {
  // How loud the low end is, 0 to 1: the mean of the analyser's bins (0 to 255 each) up to `hertz`.
  function bassEnergy(bins, sampleRate, hertz = 160) {
    if (!bins?.length || !(sampleRate > 0)) return 0;
    const width = sampleRate / 2 / bins.length, last = Math.max(1, Math.min(bins.length, Math.ceil(hertz / width)));
    let sum = 0;
    for (let i = 0; i < last; i++) sum += bins[i];
    return sum / last / 255;
  }

  // Finds the beat in a stream of loudness readings. A beat is a reading well above the recent average, at least `gap` seconds after the
  // last, so a steady loud passage doesn't beat and a quiet song's drum still does (the average follows it). `pulse` jumps to 1 on a beat
  // and dies away, for a dancer to bounce on; `tempo` is the beats' spacing as the last few show it, in seconds, or 0 until there are two.
  function createBeatTracker({ gap = 0.22, rise = 1.3, floor = 0.04, decay = 5.5, follow = 0.9 } = {}) {
    let average = 0, last = -Infinity, pulse = 0, now = 0, previous = 0;
    const spacing = [];
    return {
      // `energy` at `seconds` (any clock that only goes forward); returns { beat, pulse, tempo }.
      push(energy, seconds) {
        const step = Math.max(0, Math.min(0.25, seconds - now));
        now = seconds;
        pulse = Math.max(0, pulse - step * decay);
        let beat = false;
        const e = Math.max(0, Number(energy) || 0);
        // a beat is a rise: the reading is high against the average, and higher than the one before it
        if (e > floor && e > average * rise && e >= previous && seconds - last >= gap) {
          beat = true;
          if (Number.isFinite(last) && seconds - last < 2) { spacing.push(seconds - last); if (spacing.length > 8) spacing.shift(); }
          last = seconds;
          pulse = 1;
        }
        average = average ? average * follow + e * (1 - follow) : e;
        previous = e;
        const tempo = spacing.length >= 2 ? [...spacing].sort((a, b) => a - b)[spacing.length >> 1] : 0;
        return { beat, pulse, tempo };
      },
      reset() { average = 0; last = -Infinity; pulse = 0; previous = 0; spacing.length = 0; },
    };
  }

  // Where each of `count` dancers stands round the chamber's floor: evenly round a ring of `radius`, the first at the front, each turned
  // to face the middle. x is to the right, z toward the camera, and `yaw` is the turn (radians) that makes a model facing +z look inward.
  // `start` turns the whole ring (radians): half a step leaves no dancer straight in front of the camera, with its back to it.
  function ring(count, radius, start = 0) {
    return Array.from({ length: count }, (_, i) => {
      const angle = (i / count) * Math.PI * 2 + start;
      const x = Math.sin(angle) * radius, z = Math.cos(angle) * radius;
      return { x, z, yaw: Math.atan2(-x, -z) };
    });
  }

  // A dancer's body at a moment: a hop that lands on each beat, a lean from side to side every other beat, and a turn that picks up on
  // a strong one. `dancer` is its place in the ring (0 to 1), so the ring doesn't move as one; `tempo` is the beat's spacing in seconds
  // (a song that hasn't shown one yet gets a calm 0.5); `pulse` is the tracker's 0..1; `seconds` the time.
  // `side` (1 or -1) is which way it leans first, so neighbours sway against each other; they all hop together.
  function move({ seconds, pulse = 0, tempo = 0, dancer = 0, side = 1, beat: position, accent = 1 }) {
    const beat = tempo > 0.2 && tempo < 1.5 ? tempo : 0.5;
    // on the beat clock when there is one: the hop lands on each beat; else on the time
    const phase = (position ?? seconds / beat) + dancer * 0.5;
    const hop = Math.abs(Math.sin(phase * Math.PI));
    const lean = Math.sin(phase * Math.PI * 0.5);
    return {
      y: hop * (0.08 + 0.2 * pulse) * accent,
      roll: side * lean * (0.05 + 0.07 * pulse),
      yawOffset: side * Math.sin(phase * Math.PI * 0.5) * (0.05 + 0.12 * pulse),
      squash: 1 - (1 - hop) * 0.04 * (0.5 + pulse),
    };
  }

  // Which of a model's motions a dancer plays now: its idle most of the time, a move on the first beat of a bar of `bar` beats that comes
  // round to it. `moves` is how many it has besides the idle; `beats` the beats counted so far. Returns -1 for the idle, else 0..moves-1.
  function pickMove({ beats, moves, dancer = 0, bar = 4 }) {
    if (!moves || !(bar > 0)) return -1;
    const barNumber = Math.floor(beats / bar);
    if ((barNumber + dancer) % 2) return -1;
    return (Math.floor(barNumber / 2) + dancer) % moves;
  }


  // The shortest way round from angle `a` to `b`, `t` (0..1) of it.
  function angleLerp(a, b, t) {
    const turn = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    return a + turn * t;
  }

  // 0 to 1 with a soft start and end.
  const ease = t => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };

  // When a motion has its dancer in the air: the first and last frames at which `heights` (the body's height at each frame) is more than
  // `share` of the way from where it began to its highest. Null for a motion that doesn't leave the ground.
  function airborne(heights, share = 0.3, least = 1) {
    if (!heights?.length) return null;
    const base = heights[0];
    let top = base;
    for (const h of heights) if (h > top) top = h;
    if (top - base < least) return null;
    const level = base + (top - base) * share;
    let take = -1, land = -1;
    heights.forEach((h, frame) => { if (h > level) { if (take < 0) take = frame; land = frame; } });
    return { take, land };
  }

  // A tempo as a beat spacing a dancer can keep time to: one faster than about 200 BPM is danced at half speed, a very slow one at double (a fast
  // song, around 180, keeps its real beat, and its dancers move that much faster).
  function normalizePeriod(seconds, low = 0.3, high = 0.76) {
    let p = Number(seconds);
    if (!(p > 0)) return 0.5;
    while (p < low) p *= 2;
    while (p > high) p /= 2;
    return p;
  }

  // A steady count of the beats, kept in step with the ones the tracker hears. `at(seconds)` is where the music is in beats (a whole number
  // is a beat, counting from the first heard); it runs on by itself at the tempo, and each beat heard nudges it a little toward that beat,
  // so that it keeps time through a bar with no drum in it and ignores a hit that falls between the beats.
  function createBeatClock({ period = 0.5, gain = 0.3, window = 0.3 } = {}) {
    let p = period, t0 = null, b0 = 0, synced = false;
    const at = seconds => { if (t0 === null) t0 = seconds; return b0 + (seconds - t0) / p; };
    return {
      at,
      get period() { return p; },
      get synced() { return synced; },
      // the tempo heard (a beat spacing) at `seconds`; the clock moves toward it without a jump in where it is
      setTempo(spacing, seconds) {
        const target = normalizePeriod(spacing);
        if (t0 !== null) { b0 = at(seconds); t0 = seconds; }
        p += (target - p) * 0.3;
      },
      // a beat heard at `seconds`
      onset(seconds) {
        if (!synced) { b0 = Math.round(at(seconds)); t0 = seconds; synced = true; return; }
        const b = at(seconds), error = b - Math.round(b);
        if (Math.abs(error) < window) t0 += error * gain * p;
      },
      reset() { p = period; t0 = null; b0 = 0; synced = false; },
    };
  }

  // The frames of a looping motion where its body lands: the low points of `heights` (its height at each frame), `share` or less of the way
  // up from its lowest, one to a hop. Empty for a motion that barely moves up and down.
  function landings(heights, { share = 0.3, least = 0.4, gap = 4 } = {}) {
    const n = heights?.length || 0;
    if (n < 4) return [];
    const low = Math.min(...heights), high = Math.max(...heights);
    if (high - low < least) return [];
    const limit = low + (high - low) * share, found = [];
    for (let i = 0; i < n; i++) {
      const h = heights[i];
      if (h <= limit && h <= heights[(i + n - 1) % n] && h <= heights[(i + 1) % n]) found.push(i);
    }
    // a flat low point gives several frames, and the loop's end meets its start: one landing for each group, at its lowest
    const merged = [];
    for (const i of found) {
      const last = merged[merged.length - 1];
      if (last !== undefined && i - last < gap) { if (heights[i] < heights[last]) merged[merged.length - 1] = i; }
      else merged.push(i);
    }
    if (merged.length > 1 && merged[0] + n - merged[merged.length - 1] < gap) {
      if (heights[merged[merged.length - 1]] < heights[merged[0]]) merged.shift(); else merged.pop();
    }
    return merged;
  }

  // The frame of a looping motion to show at beat `position`, when each hop of it (landing to landing) takes `perHop` beats and the first
  // landing is on a beat: so that every landing is on a beat, and the motion between runs at whatever speed that takes.
  function warp(landing, frames, position, perHop = 1) {
    const n = landing.length;
    if (!n) return 0;
    const h = position / perHop, k = Math.floor(h), part = h - k;
    const from = landing[((k % n) + n) % n];
    let to = landing[(((k + 1) % n) + n) % n];
    if (to <= from) to += frames;
    return (from + part * (to - from)) % frames;
  }

  const api = { bassEnergy, createBeatTracker, ring, move, pickMove, angleLerp, ease, airborne, normalizePeriod, createBeatClock, landings, warp };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.coloJukeboxBeat = api;
})(typeof globalThis === 'object' ? globalThis : this);
