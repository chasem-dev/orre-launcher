// The Pokédex: every Pokémon on the player's disc, to browse and turn around in 3D. Nothing
// of it stays on the GPU while the page is hidden, and it holds still when left alone.
import { createViewer } from './model-viewer.js';
import { createCry } from './pokedex-cry.js';

const $ = id => document.getElementById(id);
const STATS = ['HP', 'Attack', 'Defense', 'Sp. Atk', 'Sp. Def', 'Speed'];
const MAX_STAT = 255;
// What the filters offer. Each Pokémon's status (pokedex.js) says where it belongs.
const FILTERS = [
  { id: 'all', label: 'All', matches: () => true },
  { id: 'available', label: 'Obtainable', matches: entry => !entry.status.locked },
  { id: 'battle', label: 'Battle only', matches: entry => entry.status.kind === 'battle' },
  { id: 'hidden', label: 'Hidden on disc', matches: entry => entry.status.kind === 'hidden' },
  { id: 'packs', label: 'Packs', matches: entry => entry.status.kind === 'pack', onlyWhenAny: true },
  { id: 'generations', label: 'Later generations', matches: entry => entry.status.kind === 'generation', onlyWhenAny: true },
];
// Clips this short are held poses the game blends into, not motions to watch (for a model whose header lists none).
const SHORTEST_MOTION = 20;
// What each kind of battle motion (hsd-model.js readHeader) is called here.
const MOTION_LABEL = { idle: 'Idle', physical: 'Physical move', special: 'Special move', hit: 'Hit', faint: 'Faint', extra: 'Extra' };

let species = null, packProblems = [], canMakePacks = false, loading = null, visible = false, filter = 'all', selected = null, form = null, viewer = null;
// The Look menu's choice (a look that isn't a shiny one) and the Shiny switch, which stays on from one Pokémon to the next
let look = null, shiny = false;
// The newest choice: a slower answer to an older one is dropped.
let request = 0;
// Each entry's button, by its key: a disc Pokémon's National Pokédex number, or a pack Pokémon's "pack:<pack>/<folder>".
const entries = new Map();

const message = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const number = national => `#${String(national).padStart(3, '0')}`;

function setStatus(text, { busy = false, retry = false } = {}) {
  $('pokedex-status-text').textContent = text;
  $('pokedex-status').classList.toggle('loading', busy);
  $('pokedex-retry').hidden = !retry;
  $('pokedex-status').hidden = !text;
}

// A fresh canvas for each view: one whose context was let go can't make another.
function startViewer() {
  if (viewer) return true;
  const canvas = $('pokedex-stage').cloneNode(false);
  canvas.classList.remove('ready');
  $('pokedex-stage').replaceWith(canvas);
  try { viewer = createViewer(canvas); }
  catch (_) {
    setStatus('The 3D view couldn\'t start. Try again, or restart the launcher to reset its graphics.', { retry: true });
    return false;
  }
  return true;
}

function stopViewer() {
  viewer?.dispose();
  viewer = null;
}

// --- The list ------------------------------------------------------------------------

function matches(entry, search) {
  if (!FILTERS.find(item => item.id === filter).matches(entry)) return false;
  if (!search) return true;
  return entry.name.toLowerCase().includes(search) || String(entry.national).padStart(3, '0').includes(search.replace(/^#/, ''));
}

function applyFilter() {
  const search = $('pokedex-search').value.trim().toLowerCase();
  let shown = 0;
  for (const entry of species) {
    if (!entries.has(entry.key)) continue;   /* (a form row: not listed) */
    const show = matches(entry, search);
    entries.get(entry.key).hidden = !show;
    if (show) shown++;
  }
  $('pokedex-empty').hidden = shown > 0;
}

function renderFilters() {
  const shown = FILTERS.filter(item => !item.onlyWhenAny || species.some(item.matches));
  if (!shown.some(item => item.id === filter)) filter = 'all';
  $('pokedex-filters').replaceChildren(...shown.map(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pokedex-filter';
    button.dataset.filter = item.id;
    button.setAttribute('aria-pressed', String(item.id === filter));
    const count = document.createElement('span');
    count.textContent = species.filter(item.matches).length;
    button.append(`${item.label} `, count);
    button.addEventListener('click', () => {
      filter = item.id;
      for (const other of $('pokedex-filters').children) other.setAttribute('aria-pressed', String(other === button));
      applyFilter();
    });
    return button;
  }));
}

function renderEntry(entry) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pokedex-entry';
  button.dataset.kind = entry.status.kind;
  button.title = `${entry.name}: ${entry.status.label}`;
  if (entry.sprite) {
    const image = document.createElement('img');
    image.src = entry.sprite;
    image.alt = '';
    image.loading = 'lazy';
    image.width = image.height = 48;
    button.append(image);
  } else button.append(Object.assign(document.createElement('span'), { className: 'pokedex-no-sprite', textContent: '?' }));
  const label = document.createElement('span');
  label.className = 'pokedex-entry-label';
  const small = document.createElement('small');
  small.textContent = entry.pack && entry.status.kind === 'pack' ? `${number(entry.national)} · ${entry.pack.name}` : number(entry.national);
  const name = document.createElement('span');
  name.textContent = entry.name;
  label.append(small, name);
  button.append(label);
  if (entry.status.locked) {
    const lock = $('pokedex-availability').querySelector('.pokedex-lock').cloneNode(true);
    lock.classList.add('pokedex-entry-lock');
    button.append(lock);
  }
  button.addEventListener('click', () => select(entry));
  entries.set(entry.key, button);
  return button;
}

const isFormRow = entry => entry.status?.kind === 'generation' && entry.national >= 722;
function renderList() {
  const disc = species.filter(entry => !entry.pack), available = disc.filter(entry => !entry.status.locked).length;
  // (a form with stats of its own, 722 on, is its base's: shown under its base's Look, not as an entry of its own)
  const listed = species.filter(entry => !isFormRow(entry));
  const packs = species.filter(entry => entry.status.kind === 'pack').length, later = listed.filter(entry => entry.status.kind === 'generation').length;
  $('pokedex-summary').textContent = `${disc.length} Pokémon on your disc. ${available} can be obtained in the game; the rest are locked away.` +
    (later ? ` ${later} more from later generations.` : '') +
    (packs ? ` ${packs} from your Pokémon packs.` : '');
  $('pokedex-pack-problems').hidden = !packProblems.length;
  $('pokedex-pack-problem-list').replaceChildren(...packProblems.map(text => Object.assign(document.createElement('li'), { textContent: text })));
  renderFilters();
  $('pokedex-list').replaceChildren(...listed.map(renderEntry));
  applyFilter();
}

// --- The chosen Pokémon --------------------------------------------------------------

// An entry as a look of its shows it: a 3DS form's own types, stats, abilities, height and weight, and what the form
// is in the game in place of how the Pokémon can be had (pokemon-packs.js formLooks)
function asLook(entry, id) {
  const look = entry.forms.find(item => item.id === id);
  if (!look?.note) return entry;
  const hiddenAbility = look.info?.abilities ? null : entry.hiddenAbility;
  return { ...entry, ...look.info, hiddenAbility, status: { ...entry.status, label: look.title, note: look.note, locked: false, kind: 'form' } };
}

function renderInfo(entry) {
  $('pokedex-info').hidden = false;
  $('pokedex-number').textContent = number(entry.national);
  $('pokedex-name').textContent = entry.name;
  $('pokedex-types').replaceChildren(...entry.types.map(type => {
    const pill = document.createElement('span');
    pill.className = 'pokedex-type';
    pill.dataset.type = type.toLowerCase();
    pill.textContent = type;
    return pill;
  }));
  $('pokedex-availability').dataset.kind = entry.status.kind;
  $('pokedex-availability').classList.toggle('locked', entry.status.locked);
  $('pokedex-availability-label').textContent = entry.status.label;
  $('pokedex-availability-note').textContent = entry.status.note;
  $('pokedex-stats').replaceChildren(...entry.stats.flatMap((value, index) => {
    const label = document.createElement('dt'), row = document.createElement('dd'), bar = document.createElement('i'), text = document.createElement('span');
    label.textContent = STATS[index];
    text.textContent = value;
    bar.style.setProperty('--stat', `${Math.round(value / MAX_STAT * 100)}%`);
    row.append(text, bar);
    return [label, row];
  }));
  $('pokedex-height').textContent = entry.height;
  $('pokedex-weight').textContent = entry.weight;
  const abilities = [...(entry.abilities || []), ...(entry.hiddenAbility ? [`${entry.hiddenAbility} (Hidden)`] : [])];
  $('pokedex-abilities').textContent = abilities.join(', ') || '—';
  renderEvolutions(entry);
}

// The Pokémon's whole family, from its first stage: every evolution, with what it needs on the arrow before it, and the
// notes on those that need one (that it can't happen in this game, or how Platinum had it) below. Each stage opens
// its own entry.
function renderEvolutions(entry) {
  const byKey = new Map(species.map(item => [item.key, item]));
  const parentOf = key => species.find(item => item.key !== key && item.evolutions.includes(key));
  let first = entry;
  for (const seen = new Set([entry.key]); ;) {
    const parent = parentOf(first.key);
    if (!parent || seen.has(parent.key)) break;
    seen.add(parent.key);
    first = parent;
  }
  const notes = [], placed = new Set();
  const stage = item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `pokedex-chain-stage${item.key === entry.key ? ' current' : ''}`;
    button.title = item.key === entry.key ? item.name : `Show ${item.name}`;
    if (item.sprite) button.append(Object.assign(document.createElement('img'), { src: item.sprite, alt: '', width: 40, height: 40, loading: 'lazy' }));
    else button.append(Object.assign(document.createElement('span'), { className: 'pokedex-no-sprite', textContent: '?' }));
    button.append(Object.assign(document.createElement('small'), { textContent: number(item.national) }),
      Object.assign(document.createElement('span'), { textContent: item.name }));
    if (item.key !== entry.key) button.addEventListener('click', () => { select(item); entries.get(item.key)?.scrollIntoView({ block: 'nearest' }); });
    return button;
  };
  const branch = item => {
    placed.add(item.key);
    const out = document.createElement('div');
    out.className = 'pokedex-chain-branch';
    out.append(stage(item));
    const next = item.evolutions.map((key, i) => [byKey.get(key), item.evolutionWays?.[i]]).filter(([target]) => target && !placed.has(target.key));
    if (!next.length) return out;
    const column = document.createElement('div');
    column.className = 'pokedex-chain-next';
    for (const [target, way = { text: '' }] of next) {
      const link = document.createElement('div'), arrow = document.createElement('div');
      link.className = 'pokedex-chain-link';
      arrow.className = `pokedex-chain-way${way.note ? ' noted' : ''}${way.blocked ? ' blocked' : ''}`;
      arrow.append(Object.assign(document.createElement('span'), { textContent: way.text }));
      if (way.note) {
        arrow.title = way.note;
        // one note for each evolution of the chosen Pokémon and into it; the same note for two (Wurmple's) is said once
        const same = notes.find(note => note.from === item && note.text === way.note);
        if (same) same.into.push(target.name);
        else if (item.key === entry.key || target.key === entry.key) notes.push({ from: item, into: [target.name], text: way.note });
      }
      link.append(arrow, branch(target));
      column.append(link);
    }
    out.append(column);
    return out;
  };
  const tree = branch(first);
  $('pokedex-chain').replaceChildren(placed.size > 1 ? tree : Object.assign(document.createElement('p'), { className: 'pokedex-chain-empty', textContent: `${entry.name} doesn't evolve.` }));
  $('pokedex-evolution-notes').replaceChildren(...notes.map(note =>
    Object.assign(document.createElement('li'), { textContent: `${note.from.name} to ${note.into.join(' or ')}: ${note.text}` })));
}

// An entry's looks for the Look menu: each one but the shiny ones, with its shiny one beside it (labelled "Shiny" for
// "Normal", else "Shiny <its name>") for the Shiny switch. A look with none (Castform's weather) shows the same shiny.
function lookChoices(entry) {
  const byLabel = new Map(entry.forms.map(item => [item.label, item]));
  const shinyOf = label => byLabel.get(label === 'Normal' ? 'Shiny' : `Shiny ${label}`) || null;
  const isShiny = item => item.label === 'Shiny' ? byLabel.has('Normal') : item.label.startsWith('Shiny ') && byLabel.has(item.label.slice('Shiny '.length));
  return entry.forms.filter(item => !isShiny(item)).map(item => ({ ...item, shiny: shinyOf(item.label) }));
}
// The look shown: the chosen one, or its shiny one with the switch on
function chosenLook(entry) {
  const choices = lookChoices(entry), chosen = choices.find(item => item.id === look) || choices[0];
  return chosen && shiny && chosen.shiny ? chosen.shiny.id : chosen?.id;
}

function renderForms(entry) {
  const choices = lookChoices(entry), chosen = choices.find(item => item.id === look) || choices[0];
  $('pokedex-form-field').hidden = choices.length < 2;
  $('pokedex-form').replaceChildren(...choices.map(item => new Option(item.label, item.id)));
  $('pokedex-form').value = chosen?.id ?? '';
  const button = $('pokedex-shiny');
  button.hidden = !choices.some(item => item.shiny);
  button.disabled = !chosen?.shiny;
  button.setAttribute('aria-pressed', String(shiny));
  button.title = chosen?.shiny ? (shiny ? 'Show it as it usually looks' : 'Show its shiny look') : 'This look has no shiny one of its own';
}

// A model's motions to choose from: its battle motions, named by what the game plays them for, from its header; or, for
// a model whose header lists none, each animation long enough to be one.
function motionsOf(model) {
  if (model.motions?.length) {
    const counts = {}, totals = {};
    for (const { kind } of model.motions) totals[kind] = (totals[kind] || 0) + 1;
    return model.motions.map(({ index, kind }) => {
      counts[kind] = (counts[kind] || 0) + 1;
      return { index, kind, label: totals[kind] > 1 ? `${MOTION_LABEL[kind]} ${counts[kind]}` : MOTION_LABEL[kind] };
    });
  }
  return model.animations.map((frames, index) => ({ frames, index })).filter(({ frames }) => frames >= SHORTEST_MOTION)
    .map(({ index }, position) => ({ index, kind: position ? 'extra' : 'idle', label: `Motion ${position + 1}` }));
}

let motions = [];
function renderMotions(model, chosen) {
  motions = motionsOf(model);
  $('pokedex-motion-field').hidden = motions.length < 2;
  $('pokedex-motion').replaceChildren(...motions.map(motion => new Option(motion.label, motion.index)));
  $('pokedex-motion').value = chosen;
}

// The motion a model opens on: its idle. Its first pose is also how it stands, since some models' joints only make
// sense animated.
const openingMotion = model => motionsOf(model)[0]?.index ?? (model.animations.length ? 0 : -1);
const blinksIn = index => motions.find(motion => motion.index === index)?.kind === 'idle';

// The HD pack's images a model's textures come with, decoded. One that can't be read leaves the disc's.
async function decodeHdTextures(model) {
  await Promise.all(model.textures.map(async source => {
    if (!source.image) return;
    try {
      source.bitmap = await createImageBitmap(new Blob([source.image], { type: 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    } catch (_) {}
    delete source.image;
  }));
}

const closeBitmaps = model => { for (const source of model.textures) source.bitmap?.close(); };

async function showModel(entry) {
  const mine = ++request;
  $('pokedex-motion-field').hidden = true;
  setStatus(`Reading ${entry.name} from your disc…`, { busy: true });
  $('pokedex-stage').classList.remove('ready');
  try {
    const model = await window.colo.pokedexModel(entry.key, form), motion = openingMotion(model);
    const clip = motion >= 0 ? await window.colo.pokedexClip(entry.key, form, motion) : null;
    // The game's blink, played over the idle now and then
    const blink = model.blink >= 0 ? await window.colo.pokedexClip(entry.key, form, model.blink) : null;
    await decodeHdTextures(model);
    if (mine !== request || !visible || !startViewer()) return closeBitmaps(model);
    renderMotions(model, motion);
    viewer.setModel(model, clip, { blink, shiny: model.shinyFilter ? model.shiny : null });
    viewer.setClip(clip, { blinks: blinksIn(motion) });
    setStatus(model.shinyFilter && !model.shiny ? `${entry.name} looks the same when shiny.` : '');
    requestAnimationFrame(() => requestAnimationFrame(() => $('pokedex-stage').classList.add('ready')));
  } catch (error) {
    if (mine === request) setStatus(message(error), { retry: true });
  }
}

function select(entry) {
  selected = entry;
  cry.show(entry);
  look = lookChoices(entry)[0]?.id ?? null;
  form = chosenLook(entry);
  for (const [key, button] of entries) button.classList.toggle('selected', key === entry.key);
  renderInfo(asLook(entry, form));
  renderForms(entry);
  // Make a pack: for the game's own Pokémon (a pack's is one already)
  $('pokedex-make-pack').hidden = !canMakePacks || !/^\d+$/.test(entry.key);
  if (form) showModel(entry);
  else setStatus(`${entry.name} has no model on this disc.`);
}

// One list: the disc's Pokémon by number, each pack Pokémon after the one it's based on, and those numbered past the
// disc's (a later generation's) after them in their order. Evolutions name entries by key.
function combine(disc, packs) {
  const list = [], numbers = new Set(disc.map(entry => entry.national));
  const pack = entry => ({ ...entry, evolutions: entry.evolutions.map(into => typeof into === 'number' ? String(into) : `pack:${into}`) });
  for (const entry of disc) {
    list.push({ ...entry, key: String(entry.national), evolutions: entry.evolutions.map(String) });
    for (const each of packs) if (each.national === entry.national) list.push(pack(each));
  }
  for (const each of packs.filter(entry => !numbers.has(entry.national)).sort((a, b) => a.national - b.national)) list.push(pack(each));
  return list;
}

// Which game's list is wanted: one read for a game since left is dropped.
let listFor = 0;
// `choose`: the key of the entry to show once read (a pack just made), else the first.
async function load(choose = null) {
  const mine = listFor;
  setStatus('Reading your disc…', { busy: true });
  try {
    const list = await window.colo.pokedex();
    if (mine !== listFor) return;
    species = combine(list.species, list.packs);
    packProblems = list.problems;
    canMakePacks = Boolean(list.canMakePacks);
    renderList();
    const chosen = choose && species.find(entry => entry.key === choose);
    if (chosen) entries.get(chosen.key)?.scrollIntoView({ block: 'nearest' });
    if (visible) select(chosen || species[0]);
  } catch (error) {
    if (mine === listFor) setStatus(message(error), { retry: true });
  } finally { if (mine === listFor) loading = null; }
}

const cry = createCry($('pokedex-cry'), { onError: setStatus });

$('pokedex-search').addEventListener('input', () => { if (species) applyFilter(); });
// A look chosen, or the Shiny switch turned: the look's model and what it has of its own
function showLook() {
  form = chosenLook(selected);
  renderInfo(asLook(selected, form));
  renderForms(selected);
  showModel(selected);
}
$('pokedex-shiny').addEventListener('click', () => {
  shiny = !shiny;
  if (selected) showLook();
});
$('pokedex-form').addEventListener('change', event => {
  look = event.target.value;
  showLook();
});
$('pokedex-motion').addEventListener('change', async event => {
  const mine = ++request;
  try {
    const index = Number(event.target.value), clip = await window.colo.pokedexClip(selected.key, form, index);
    if (mine === request) viewer?.setClip(clip, { blinks: blinksIn(index) });
  } catch (error) {
    if (mine === request) setStatus(message(error), { retry: true });
  }
});
$('pokedex-open-packs').addEventListener('click', () => window.colo.openPokemonPacks().catch(error => setStatus(message(error))));
// The chosen Pokémon as a pack of the player's own: made in the packs folder (which opens), then shown in the list.
$('pokedex-make-pack').addEventListener('click', async () => {
  if (loading || !selected) return;
  const button = $('pokedex-make-pack');
  button.disabled = true;
  try {
    const made = await window.colo.pokedexMakePack(selected.national);
    stopViewer();
    species = null;
    selected = null;
    loading = load(made.key);
    await loading;
    $('pokedex-pack-made').textContent = `${made.name} is now a pack of your own, in ${made.folder} in your packs folder. Change its pokemon.json there, then press Reload.`;
    $('pokedex-pack-made').hidden = false;
  } catch (error) {
    $('pokedex-pack-made').textContent = message(error);
    $('pokedex-pack-made').hidden = false;
  } finally { button.disabled = false; }
});
$('pokedex-reload').addEventListener('click', () => {
  if (loading) return;
  const keep = selected?.key || null;
  $('pokedex-pack-made').hidden = true;
  stopViewer();
  species = null;
  selected = null;
  loading = load(keep);
});
$('pokedex-retry').addEventListener('click', () => {
  stopViewer();
  setStatus('');
  if (!species) loading ||= load();
  else if (selected) showModel(selected);
});

window.coloPokedex = {
  show() {
    visible = true;
    if (!species) loading ||= load();
    else if (selected && form) showModel(selected);
  },
  hide() {
    visible = false;
    request++;
    cry.stop();
    stopViewer();
  },
  // Another game, battle rule, generation setting or asset set changed: read the Pokédex again when the page shows.
  reset() {
    const keep = selected?.key || null;
    request++;
    $('pokedex-pack-made').hidden = true;
    cry.stop();
    stopViewer();
    species = null;
    selected = null;
    listFor++;
    loading = visible ? load(keep) : null;
  },
};
