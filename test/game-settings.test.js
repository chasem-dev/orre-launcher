'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const gameSettings = require('../src/game-settings');
const port = require('../src/port');

test('the game screen\'s value names become the launcher\'s values', () => {
  // the names as the game's Settings screen writes them (ext/sms_gx gx_settings.cpp, host/settings.c)
  const changes = gameSettings.translate({
    fullscreen: 'On', fullscreenMode: 'Exclusive', exclusiveResolution: '2560 x 1440', display: 'Monitor 2', aspect: 'Whole Multiples',
    brightness: '120', frameRate: '120 fps', vsync: 'Adaptive', overlay: 'Off', resolution: '3x', msaa: '8x', fxaa: 'On', anisotropic: 'Off', sharpen: '25',
    presentFilter: 'FSR 1', fsrMode: 'Ultra Performance', textures: 'Off', shaderWarmup: 'Off', volumeMaster: '80', volumeMusic: '0',
    volumeEffects: '55'
  });
  assert.deepEqual(changes, {
    fullscreen: true, fullscreenMode: 'exclusive', exclusiveResolution: '2560x1440', display: 'monitor2', aspect: 'integer',
    brightness: 120, frameRate: 120, vsync: 'adaptive', overlay: false, resolution: 3, msaa: 8, fxaa: true, anisotropic: 0, sharpen: 25,
    presentFilter: 'fsr', fsrMode: 'ultraperformance', textures: false, shaderWarmup: false, volumeMaster: 80, volumeMusic: 0,
    volumeEffects: 55
  });
  // and the launcher keeps every one of them as it is
  const settings = port.normalizeSettings({ ...port.normalizeSettings({}, 'linux'), ...changes }, 'linux');
  for (const [key, value] of Object.entries(changes)) assert.deepEqual(settings[key], value, key);
  assert.deepEqual(gameSettings.translate({ frameRate: '30 fps' }), { frameRate: 30 });
  assert.deepEqual(gameSettings.translate({ frameRate: '60 fps' }), { frameRate: 60 });
});

test('values the launcher has no setting for are left out', () => {
  assert.deepEqual(gameSettings.translate({
    resolution: '2.67x',          // an upscaling mode's scale
    msaa: '16x',
    frameRate: '90 fps',
    display: 'Monitor 1 (primary)',
    colorSpace: 'NTSC-J',         // the renderer's, not the launcher's
    volumeMusic: '140',
    brightness: 'bright',
    constructor: 'On'
  }), { display: 'primary' });
  assert.deepEqual(gameSettings.translate(null), {});
  assert.deepEqual(gameSettings.translate(['msaa']), {});
});

test('the game\'s file is read once, and a broken one is no change', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colo-game-settings-'));
  try {
    const file = path.join(dir, 'game-settings.json');
    assert.deepEqual(gameSettings.take(file), {});
    fs.writeFileSync(file, '{\n  "msaa": "4x",\n  "volumeMusic": "60"\n}\n');
    assert.deepEqual(gameSettings.take(file), { msaa: 4, volumeMusic: 60 });
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, '{"msaa": "4x"');
    assert.deepEqual(gameSettings.take(file), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('describe names only what changed', () => {
  assert.equal(gameSettings.describe({ msaa: 4, volumeMusic: 100 }, { msaa: 4, volumeMusic: 60 }), 'volumeMusic 60');
  assert.equal(gameSettings.describe({ msaa: 4 }, { msaa: 4 }), '');
});

test('the volumes reach the game only when they are not 100', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colo-volume-'));
  try {
    const plain = port.buildEnvironment(port.normalizeSettings({}, 'linux'), '/disc.iso', root);
    for (const name of ['COLO_VOLUME', 'COLO_MUSIC_VOLUME', 'COLO_SFX_VOLUME']) assert.equal(plain[name], process.env[name], name);
    const env = port.buildEnvironment(port.normalizeSettings({ volumeMaster: 90, volumeMusic: 0, volumeEffects: 100 }, 'linux'), '/disc.iso', root);
    assert.equal(env.COLO_VOLUME, '90');
    assert.equal(env.COLO_MUSIC_VOLUME, '0');
    assert.equal(env.COLO_SFX_VOLUME, process.env.COLO_SFX_VOLUME);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
