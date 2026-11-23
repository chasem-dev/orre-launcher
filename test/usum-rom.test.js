'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const usumRom = require('../src/usum-rom');

// Minimal valid decrypted .3ds NCSD + NCCH Partition 0 + IVFC RomFS header
function rom3ds({ productCode = 'CTR-P-A2AA', decrypted = true, ivfc = true, truncate = false } = {}) {
  const p0 = 0x4000, romfsRel = 0x2000, romfsSize = 0x2000;
  const total = truncate ? p0 + romfsRel + 0x400 : p0 + romfsRel + romfsSize;
  const buf = Buffer.alloc(total);
  buf.write('NCSD', 0x100, 'latin1');
  buf.writeUInt32LE(p0 / 0x200, 0x120);
  buf.writeUInt32LE((romfsRel + romfsSize) / 0x200, 0x124);
  buf.write('NCCH', p0 + 0x100, 'latin1');
  buf.write(productCode, p0 + 0x150, 'latin1');
  buf[p0 + 0x18f] = decrypted ? 0x04 : 0x00;
  buf.writeUInt32LE(romfsRel / 0x200, p0 + 0x1b0);
  buf.writeUInt32LE(romfsSize / 0x200, p0 + 0x1b4);
  if (ivfc) buf.write('IVFC', p0 + romfsRel, 'latin1');
  return buf;
}

function withFiles(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usum-rom-'));
  const write = (name, bytes) => { const file = path.join(root, name); fs.writeFileSync(file, bytes); return file; };
  try { fn(write, root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('decrypted Gen 7 3DS Pokémon ROMs pass validation', () => withFiles(write => {
  const us = usumRom.validate(write('us.3ds', rom3ds({ productCode: 'CTR-P-A2AA' })));
  assert.equal(us.game, 'Pokémon Ultra Sun');
  assert.equal(us.productCode, 'CTR-P-A2AA');
  assert.equal(us.ultra, true);
  assert.equal(us.warning, undefined);
  assert.match(usumRom.describe(us), /Pokémon Ultra Sun \(CTR-P-A2AA, decrypted 3DS\)/);

  assert.equal(usumRom.validate(write('um.3ds', rom3ds({ productCode: 'CTR-P-A2BA' }))).game, 'Pokémon Ultra Moon');
  assert.equal(usumRom.validate(write('sun.3ds', rom3ds({ productCode: 'CTR-P-BNDA' }))).game, 'Pokémon Sun');
  assert.equal(usumRom.validate(write('moon.3ds', rom3ds({ productCode: 'CTR-P-BNEA' }))).game, 'Pokémon Moon');
}));

test('encrypted, wrong-game, archive, CIA, or corrupt files are rejected with clear reasons', () => withFiles((write, root) => {
  assert.throws(() => usumRom.validate(write('enc.3ds', rom3ds({ decrypted: false }))), /still encrypted\. Decrypt it first/);
  assert.throws(() => usumRom.validate(write('badivfc.3ds', rom3ds({ ivfc: false }))), /encrypted or damaged game files/);
  assert.throws(() => usumRom.validate(write('xy.3ds', rom3ds({ productCode: 'CTR-P-EKJA' }))), /another 3DS game \(CTR-P-EKJA\)/);
  assert.throws(() => usumRom.validate(write('us.zip', Buffer.from('PK\x03\x04rest', 'latin1'))), /ZIP archive/);
  const cia = Buffer.alloc(0x400); cia.writeUInt32LE(0x2020, 0);
  assert.throws(() => usumRom.validate(write('us.cia', cia)), /\.cia install file/);
  assert.throws(() => usumRom.validate(write('tiny.3ds', Buffer.from('hi'))), /too small to be a 3DS ROM/);
  assert.throws(() => usumRom.validate(write('notes.txt', Buffer.alloc(0x400, 0x41))), /isn't a Nintendo 3DS/);
  assert.throws(() => usumRom.validate(path.join(root, 'gone.3ds')), /can't be found/);
  assert.throws(() => usumRom.validate(root), /That's a folder/);
  assert.throws(() => usumRom.validate(''), /No file was chosen/);
}));

test('a truncated .3ds past RomFS header is kept with a warning', () => withFiles(write => {
  const cut = usumRom.validate(write('cut.3ds', rom3ds({ truncate: true })));
  assert.match(cut.warning, /may be incomplete/);
  assert.match(usumRom.describe(cut), /may be incomplete/);
}));
