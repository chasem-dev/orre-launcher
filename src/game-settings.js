'use strict';
// The changes the player made on the game's own Settings screen (the field menu's SETTINGS, host/settings.c in the game),
// kept for the next game. The launcher names a file in COLO_SETTINGS_SAVE; the game writes every change to it at once, as
// a JSON object of the launcher's setting names and the values' names as its screen shows them ({"msaa": "4x",
// "volumeMusic": "60"}). While the game runs the launcher reads it every half second (main.js keepGameSettings), and
// again when the game closes, and keeps each change it understands at once (a value it has no setting for is left out), and port.normalizeSettings checks the result as it checks any other.

const fs = require('fs');

const lower = (name) => String(name).toLowerCase().replace(/\s+/g, '');
const onOff = (name) => (name === 'On' ? true : name === 'Off' ? false : undefined);
const number = (name, lo, hi) => {
  const value = /^\d+$/.test(String(name)) ? Number(name) : NaN;
  return value >= lo && value <= hi ? value : undefined;
};
// "Off", "2x", "4x": a count of samples or a filtering level, 0 for Off
const times = (name, allowed) => {
  if (name === 'Off') return 0;
  const match = /^(\d+)x$/.exec(String(name));
  return match && allowed.includes(Number(match[1])) ? Number(match[1]) : undefined;
};
const choice = (map) => (name) => map[name];

const READERS = {
  fullscreen: onOff,
  fullscreenMode: choice({ Borderless: 'desktop', Exclusive: 'exclusive' }),
  exclusiveResolution: (name) => {
    if (name === 'Desktop') return 'desktop';
    const match = /^(\d{3,5}) x (\d{3,5})$/.exec(String(name));
    return match ? `${match[1]}x${match[2]}` : undefined;
  },
  display: (name) => {
    const match = /^Monitor (\d+)( \(primary\))?$/.exec(String(name));
    if (!match) return undefined;
    return match[2] ? 'primary' : `monitor${match[1]}`;
  },
  aspect: choice({ Keep: 'keep', Stretch: 'stretch', 'Whole Multiples': 'integer' }),
  brightness: (name) => number(name, 50, 200),
  frameRate: choice({ '30 fps': 30, '60 fps': 60, '120 fps': 120 }),
  vsync: choice({ Off: 'off', On: 'on', Adaptive: 'adaptive' }),
  overlay: onOff,
  resolution: (name) => (name === 'Native' ? 1 : times(name, [2, 3, 4])),
  msaa: (name) => times(name, [2, 4, 8]),
  fxaa: onOff,
  anisotropic: (name) => times(name, [2, 4, 8, 16]),
  sharpen: (name) => (name === 'Off' ? 0 : number(name, 0, 100)),
  presentFilter: choice({ Bilinear: 'bilinear', Sharp: 'sharp', Nearest: 'nearest', 'FSR 1': 'fsr', NIS: 'nis' }),
  fsrMode: (name) => (['native', 'quality', 'balanced', 'performance', 'ultraperformance'].includes(lower(name)) ? lower(name) : undefined),
  textures: onOff,
  shaderWarmup: onOff,
  volumeMaster: (name) => number(name, 0, 100),
  volumeMusic: (name) => number(name, 0, 100),
  volumeEffects: (name) => number(name, 0, 100)
};

// The launcher's settings for the game's changes: { key: value } for those it understands.
function translate(changes) {
  const out = {};
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return out;
  for (const [key, name] of Object.entries(changes)) {
    if (!Object.prototype.hasOwnProperty.call(READERS, key)) continue;
    const value = READERS[key](name);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// Reads and removes the game's file: the changes it holds, translated ({} when there is none or it can't be read).
function take(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return {}; }
  try { fs.rmSync(file, { force: true }); } catch (_) { /* read once more next time: the same changes */ }
  try { return translate(JSON.parse(text)); } catch (_) { return {}; }
}

// What changed, for the log: "msaa 4, volumeMusic 60"
function describe(settings, changes) {
  return Object.entries(changes).filter(([key, value]) => settings[key] !== value).map(([key, value]) => `${key} ${value}`).join(', ');
}

module.exports = { translate, take, describe };
