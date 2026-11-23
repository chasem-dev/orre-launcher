'use strict';

// Checks the file a player chooses as their Nintendo 3DS Pokémon ROM (Ultra Sun, Ultra Moon, Sun or Moon) before the
// launcher keeps it. Reads the NCSD + NCCH Partition 0 header directly, catching encrypted ROMs (NoCrypto bit clear),
// archives (ZIP/7z/RAR), other 3DS games, CIA files, or truncated copies with clear player-facing messages.

const fs = require('node:fs');
const path = require('node:path');

const GAMES = {
  'CTR-P-A2AA': { name: 'Pokémon Ultra Sun', ultra: true },
  'CTR-P-A2BA': { name: 'Pokémon Ultra Moon', ultra: true },
  'CTR-P-BNDA': { name: 'Pokémon Sun', ultra: false },
  'CTR-P-BNEA': { name: 'Pokémon Moon', ultra: false }
};
const NAME = 'Pokémon Ultra Sun, Ultra Moon, Sun or Moon';
const CHOOSE = `Choose a decrypted Nintendo 3DS (.3ds) ROM of your own ${NAME} cartridge.`;
const ARCHIVES = { zip: 'a ZIP archive', '7z': 'a 7-Zip archive', rar: 'a RAR archive' };

function readAt(fd, offset, length) {
  const out = Buffer.alloc(length);
  return out.subarray(0, fs.readSync(fd, out, 0, length, offset));
}

function megabytes(bytes) { return `${Math.round(bytes / 1048576).toLocaleString('en-US')} MB`; }

// What the 3DS ROM is: { file, productCode, game, format, warning? }; otherwise throws an Error with a clear message.
function validate(file) {
  if (!file || typeof file !== 'string') throw new Error(`No file was chosen. ${CHOOSE}`);
  const absolute = path.resolve(file);
  let fd;
  try { fd = fs.openSync(absolute, 'r'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`That file can't be found. ${CHOOSE}`);
    if (error.code === 'EISDIR') throw new Error(`That's a folder. ${CHOOSE}`);
    throw new Error(`The launcher can't open that file (${error.code || error.message}). ${CHOOSE}`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`That's a folder. ${CHOOSE}`);
    const head = readAt(fd, 0, 0x200);
    const magic4 = head.toString('latin1', 0, 4);
    if (magic4 === 'PK\x03\x04') throw new Error(`That's ${ARCHIVES.zip}, not a .3ds ROM. Extract the .3ds file from it first, then choose that.`);
    if (head.toString('latin1', 0, 6) === '7z\xbc\xaf\x27\x1c') throw new Error(`That's ${ARCHIVES['7z']}, not a .3ds ROM. Extract the .3ds file from it first, then choose that.`);
    if (magic4 === 'Rar!') throw new Error(`That's ${ARCHIVES.rar}, not a .3ds ROM. Extract the .3ds file from it first, then choose that.`);
    if (stat.size < 0x200) throw new Error(`That file is too small to be a 3DS ROM (${stat.size.toLocaleString('en-US')} bytes). ${CHOOSE}`);
    // CIA files start with header size 0x2020 LE at offset 0
    if (head.readUInt32LE(0) === 0x2020 && head.toString('latin1', 0x100, 0x104) !== 'NCSD')
      throw new Error(`That looks like a .cia install file, not a .3ds cartridge image. Convert it to a decrypted .3ds file first, then choose that.`);
    if (head.toString('latin1', 0x100, 0x104) !== 'NCSD')
      throw new Error(`That file isn't a Nintendo 3DS (.3ds) cartridge image. ${CHOOSE}`);

    const p0Offset = head.readUInt32LE(0x120) * 0x200;
    const p0Size = head.readUInt32LE(0x124) * 0x200;
    if (!p0Offset || !p0Size || p0Offset + 0x200 > stat.size)
      throw new Error(`That .3ds file is incomplete or damaged. Copy it from your cartridge again and choose the new file.`);

    const ncch = readAt(fd, p0Offset, 0x200);
    if (ncch.length < 0x200 || ncch.toString('latin1', 0x100, 0x104) !== 'NCCH')
      throw new Error(`That .3ds file's main partition is damaged. Copy it from your cartridge again and choose the new file.`);

    const nul = ncch.indexOf(0, 0x150);
    const productCode = ncch.toString('latin1', 0x150, Math.min(nul < 0 ? 0x160 : nul, 0x160)).trim();
    const known = GAMES[productCode];
    if (!known)
      throw new Error(`That's another 3DS game (${productCode || 'unknown'}), not ${NAME}. ${CHOOSE}`);

    const flags7 = ncch[0x18f];
    if (!(flags7 & 0x04))
      throw new Error(`That copy of ${known.name} (${productCode}) is still encrypted. Decrypt it first (for example with GodMode9 on your 3DS), then choose the decrypted .3ds file.`);

    const romfsOffset = p0Offset + ncch.readUInt32LE(0x1b0) * 0x200;
    const romfsSize = ncch.readUInt32LE(0x1b4) * 0x200;
    if (!romfsSize || romfsOffset + 0x20 > stat.size)
      throw new Error(`That .3ds file is incomplete (missing RomFS data). Copy it from your cartridge again and choose the new file.`);

    const ivfc = readAt(fd, romfsOffset, 4);
    if (ivfc.toString('latin1', 0, 4) !== 'IVFC')
      throw new Error(`That copy of ${known.name} (${productCode}) has encrypted or damaged game files (RomFS). Decrypt the full .3ds image first, then choose it again.`);

    let warning = '';
    const needed = romfsOffset + romfsSize;
    if (stat.size < needed)
      warning = `It may be incomplete: it's ${megabytes(stat.size)}, but the game files need ${megabytes(needed)}. If making the assets fails, dump your cartridge again.`;

    return { file: absolute, productCode, game: known.name, ultra: known.ultra, format: '3ds', ...(warning && { warning }) };
  } finally { fs.closeSync(fd); }
}

function describe(rom) {
  return `${rom.game} (${rom.productCode}, decrypted 3DS).${rom.warning ? ` ${rom.warning}` : ''}`;
}

module.exports = { GAMES, validate, describe };
