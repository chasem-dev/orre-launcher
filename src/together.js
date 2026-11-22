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

// A request from the Online page, checked: { mode: 'host' | 'join', code (joining), name, listed (hosting) }
function request(value = {}) {
  const mode = value.mode === 'join' ? 'join' : value.mode === 'host' ? 'host' : null;
  if (!mode) throw new Error('Choose to host or to join.');
  if (mode === 'host') return { mode, name: name(value.name), listed: Boolean(value.listed) };
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
      ? {
          COLO_MULTIPLAYER_PORT: String(together.port),
          COLO_MULTIPLAYER_LOCAL: '1',
          COLO_MULTIPLAYER_CODE: together.code,
          ...(together.listed ? { COLO_MULTIPLAYER_LISTED: '1' } : {})
        }
      : { COLO_MULTIPLAYER_ADDRESS: `127.0.0.1:${together.port}` }),
    ...(together.build ? { COLO_GAME_VERSION: together.build } : {}),
  };
}

// What the Online page keeps between visits: the last code joined and whether hosted rooms are listed publicly
function remembered(value = {}) {
  return { code: parseCode(value?.code) || '', listed: Boolean(value?.listed) };
}

// Live co-op hosting for an already-running singleplayer game over its launcher link (host/netcoop.c).
// The game asks `coop-host` (from START → Settings → Co-op), or the launcher calls host() directly; the relay opens a
// room on the room server and replies `coop-hosted code=... port=... build=... listed=...` with the trainer name in
// payload bytes. `coop-listed`, `coop-stop`, `stop()`, or the link closing updates or ends the room.
function wireLiveHost(link, { game, getHello, createRelay, copy = () => {}, onState = () => {}, onListed = () => {}, onExternalStop = () => {}, log = () => {} }) {
  let active = null;
  let opening = null;
  const snapshot = () => active
    ? { code: active.code, hosting: true, live: true, listed: Boolean(active.listed), playing: Boolean(active.peer), peer: active.peer || undefined }
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

  function setListed(listed, { notifyGame = true } = {}) {
    const on = Boolean(listed);
    if (active) {
      active.listed = on;
      try { active.relay.setListed?.(on); } catch (_) {}
      if (notifyGame) {
        try { link.send('coop-listed', { listed: on ? '1' : '0' }); } catch (_) {}
      }
      tell();
      log(on ? 'Listed co-op room in the public lobby.' : 'Removed co-op room from the public lobby.');
    }
    onListed(on);
    return on;
  }

  async function host(overrideName, options = {}) {
    const requestedListed = options.listed !== undefined ? Boolean(options.listed) : undefined;
    if (active) {
      if (requestedListed !== undefined && requestedListed !== active.listed) setListed(requestedListed, { notifyGame: false });
      try {
        link.send('coop-hosted', { code: active.code, port: String(active.gamePort), build: active.build, listed: active.listed ? '1' : '0' }, Buffer.from(active.name, 'utf8'));
      } catch (_) {}
      tell();
      return { code: active.code, gamePort: active.gamePort };
    }
    if (opening) return opening;
    opening = (async () => {
      const hello = await getHello(overrideName, { listed: requestedListed });
      const listed = requestedListed !== undefined ? requestedListed : Boolean(hello.listed);
      const relay = createRelay();
      try {
        const { code, gamePort } = await relay.host({ ...hello, listed });
        const formatted = formatCode(code);
        active = { relay, code: formatted, gamePort, build: hello.build, name: hello.name, listed, peer: null };
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
        link.send('coop-hosted', { code: formatted, port: String(gamePort), build: hello.build, listed: listed ? '1' : '0' }, Buffer.from(hello.name, 'utf8'));
        onListed(listed);
        tell();
        log(`Hosting co-op live (${game}): the other player joins with the code ${formatted}${listed ? ' (public lobby)' : ''}.`);
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

  link.on('message:coop-host', ({ fields } = {}) => {
    const listed = fields?.listed !== undefined ? fields.listed !== '0' : undefined;
    host(undefined, { listed }).catch(error => {
      const message = String(error?.message || error || 'Could not open a co-op room.');
      log(`Live co-op host failed: ${message}`);
      try { link.send('coop-error', {}, Buffer.from(message, 'utf8')); } catch (_) {}
    });
  });
  link.on('message:coop-listed', ({ fields } = {}) => {
    const on = fields?.listed !== '0';
    setListed(on, { notifyGame: false });
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

  return { host, stop, setListed, state: snapshot };
}

module.exports = { name, request, coopBuild, environment, remembered, wireLiveHost };
