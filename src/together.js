'use strict';
// Online co-op (the game's host/netcoop.c): two players play the story together, each on their own screen. One hosts
// their own save and gets a co-op code; the other joins with the code and plays the host's game beside them. The games
// talk through the room server (src/coop-relay.js): nobody forwards a port. The launcher starts each game hosting or
// joining on this computer, and the relay passes the packets on.

const { parseCode, formatCode } = require('./coop-relay');

const NAME_LENGTH = 23;
const COOP_BUILD = 64;   // what the room keeps of a build

function name(value) {
  const text = String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, NAME_LENGTH);
  return text || 'Player';
}

// A request from the Online page, checked: { mode: 'host' | 'join', code (joining), name }
function request(value = {}) {
  const mode = value.mode === 'join' ? 'join' : value.mode === 'host' ? 'host' : null;
  if (!mode) throw new Error('Choose to host or to join.');
  if (mode === 'host') return { mode, name: name(value.name) };
  const code = parseCode(value.code);
  if (!code) throw new Error('Enter the host\'s co-op code: six letters and numbers, like KQ7-M2D.');
  return { mode, code, name: name(value.name) };
}

// Which games play together: the same game at the very same commit (the save's layout and the co-op messages must be
// alike), "colosseum-0123abcd4567ef89"
function coopBuild(game, installed) {
  const commit = installed?.commit || installed?.gameVersion || 'unknown';
  return `${game}-${String(commit).slice(0, 16)}`.slice(0, COOP_BUILD);
}

// The game's settings: hosting on `port` of this computer only, or joining the relay's port; its name, the code to
// show, and the build
function environment(together) {
  if (!together) return {};
  return {
    COLO_MULTIPLAYER: together.mode,
    COLO_MULTIPLAYER_NAME: together.name,
    ...(together.mode === 'host'
      ? { COLO_MULTIPLAYER_PORT: String(together.port), COLO_MULTIPLAYER_LOCAL: '1', COLO_MULTIPLAYER_CODE: together.code }
      : { COLO_MULTIPLAYER_ADDRESS: `127.0.0.1:${together.port}` }),
    ...(together.build ? { COLO_GAME_VERSION: together.build } : {}),
  };
}

// What the Online page keeps between visits: the last code joined
function remembered(value = {}) {
  return { code: parseCode(value?.code) || '' };
}

// Live co-op hosting for an already-running singleplayer game over its launcher link (host/netcoop.c).
// The game asks `coop-host` (from START → Settings → Co-op), or the launcher calls host() directly; the relay opens a
// room on the room server and replies `coop-hosted code=... port=... build=...` with the trainer name in payload bytes.
// `coop-stop`, `stop()`, or the link closing ends the room.
function wireLiveHost(link, { game, getHello, createRelay, copy = () => {}, onState = () => {}, onExternalStop = () => {}, log = () => {} }) {
  let active = null;
  let opening = null;
  const snapshot = () => active
    ? { code: active.code, hosting: true, live: true, playing: Boolean(active.peer), peer: active.peer || undefined }
    : null;
  const tell = () => onState(snapshot());

  function stop(notifyGame = true) {
    opening = null;
    if (!active) return;
    const prev = active;
    active = null;
    try { prev.relay.close(); } catch (_) {}
    if (notifyGame) {
      try { link.send('coop-closed'); } catch (_) {}
    }
    tell();
    log('Closed the live co-op room.');
  }

  async function host(overrideName) {
    if (active) {
      try { link.send('coop-hosted', { code: active.code, port: String(active.gamePort), build: active.build }, Buffer.from(active.name, 'utf8')); } catch (_) {}
      tell();
      return { code: active.code, gamePort: active.gamePort };
    }
    if (opening) return opening;
    opening = (async () => {
      const hello = await getHello(overrideName);
      const relay = createRelay();
      try {
        const { code, gamePort } = await relay.host(hello);
        const formatted = formatCode(code);
        active = { relay, code: formatted, gamePort, build: hello.build, name: hello.name, peer: null };
        relay.on('peer', peer => {
          if (active?.relay !== relay) return;
          active.peer = peer.name;
          tell();
          log(`${peer.name} is playing with you.`);
        });
        relay.on('peer-lost', () => {
          if (active?.relay !== relay) return;
          log('The other player\'s connection dropped: they have a minute to come back.');
        });
        relay.on('left', () => {
          if (active?.relay !== relay) return;
          active.peer = null;
          tell();
          log('The other player has left.');
        });
        relay.on('closed', () => {
          if (active?.relay !== relay) return;
          stop(true);
        });
        link.send('coop-hosted', { code: formatted, port: String(gamePort), build: hello.build }, Buffer.from(hello.name, 'utf8'));
        tell();
        log(`Hosting co-op live (${game}): the other player joins with the code ${formatted}.`);
        return { code: formatted, gamePort };
      } catch (error) {
        try { relay.close(); } catch (_) {}
        throw error;
      } finally {
        opening = null;
      }
    })();
    return opening;
  }

  link.on('message:coop-host', () => {
    host().catch(error => {
      const message = String(error?.message || error || 'Could not open a co-op room.');
      log(`Live co-op host failed: ${message}`);
      try { link.send('coop-error', {}, Buffer.from(message, 'utf8')); } catch (_) {}
    });
  });
  link.on('message:coop-stop', () => {
    if (active) stop(false);
    else onExternalStop();
  });
  link.on('message:coop-copy', ({ fields }) => {
    const code = String(fields?.code || active?.code || '').slice(0, 7);
    if (code) copy(code);
  });
  link.on('close', () => stop(false));

  return { host, stop, state: snapshot };
}

module.exports = { name, request, coopBuild, environment, remembered, wireLiveHost };
