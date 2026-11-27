'use strict';

// The bag's item pictures from the player's 3DS ROM (scripts/3ds2pkx/item_icons.py, src/port.js itemIcons*).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const port = require('../src/port');

test('item icons are made by item_icons.py from the 3DS ROM into the given folder', () => {
  const cmd = port.itemIconsCommand('/roms/ultramoon.3ds', '/data/usum-models/item-icons', 'linux', {});
  assert.equal(cmd.command, 'python3');
  assert.equal(path.basename(cmd.args[0]), 'item_icons.py');
  assert.equal(path.basename(cmd.cwd), '3ds2pkx');
  assert.deepEqual(cmd.args.slice(1), ['/roms/ultramoon.3ds', '/data/usum-models/item-icons']);
});

test('item icons count as made only with the version file of this launcher', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'item-icons-'));
  try {
    assert.equal(port.itemIconsReady(dir), false);
    fs.writeFileSync(path.join(dir, 'item-icons-version.txt'), '0\n');
    assert.equal(port.itemIconsReady(dir), false);
    const script = fs.readFileSync(port.itemIconsScript(), 'utf8');
    const version = /^VERSION = (\d+)$/m.exec(script);
    assert.ok(version, 'item_icons.py has a VERSION');
    fs.writeFileSync(path.join(dir, 'item-icons-version.txt'), `${version[1]}\n`);
    assert.equal(port.itemIconsReady(dir), true, 'the launcher and item_icons.py agree on the version');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
