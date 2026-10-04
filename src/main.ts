import { Match } from './game/match.js';
import { Renderer } from './render/renderer.js';
import { Sound } from './ui/audio.js';
import { Controls } from './ui/controls.js';
import { Hud } from './ui/hud.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} introuvable`);
  return el as T;
};

const STORE_KEY = 'billard-anglais:setup';

interface Setup {
  count: 2 | 3;
  names: string[];
}

function loadSetup(): Setup {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Setup>;
      if ((s.count === 2 || s.count === 3) && Array.isArray(s.names)) {
        return { count: s.count, names: s.names.map(String).slice(0, 3) };
      }
    }
  } catch {
    /* stockage indisponible : valeurs par défaut */
  }
  return { count: 2, names: [] };
}

function saveSetup(s: Setup): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* ignoré */
  }
}

const menu = $('menu');
const game = $('game');
const form = $<HTMLFormElement>('setup');
const p3Field = $('p3-field');
const colours = $('colours');
const btnNew = $<HTMLButtonElement>('btn-new');
const btnSound = $<HTMLButtonElement>('btn-sound');
const rulesDialog = $<HTMLDialogElement>('rules-dialog');
const endDialog = $<HTMLDialogElement>('end-dialog');
const confirmDialog = $<HTMLDialogElement>('confirm-dialog');
const canvas = $<HTMLCanvasElement>('table');
const wrap = $('table-wrap');

const renderer = new Renderer(canvas);
const sound = new Sound();
const hud = new Hud($('players'), $('status'), $('hint'), $('power'), $('spin'));

let match: Match | null = null;
let setup = loadSetup();

const controls = new Controls(
  {
    match: () => match,
    view: () => renderer.view,
    blocked: () => game.hidden !== false || document.querySelector('dialog[open]') !== null,
    shoot: (angle, power, spin) => {
      if (match?.shoot(angle, power, spin)) sound.strike(power);
    },
    gesture: () => sound.unlock(),
  },
  {
    canvas,
    power: $('power'),
    powerFill: $('power-fill'),
    powerGrip: $('power-grip'),
    spin: $('spin'),
    spinDot: $('spin-dot'),
    fineLeft: $('fine-left'),
    fineRight: $('fine-right'),
  },
);

// ---------- menu ----------
function renderSetup(): void {
  document.querySelectorAll<HTMLButtonElement>('.segmented button').forEach((b) => {
    b.setAttribute('aria-pressed', String(Number(b.dataset.count) === setup.count));
  });
  p3Field.hidden = setup.count !== 3;
  const kinds = setup.count === 3 ? ['red', 'yellow', 'blue', 'black'] : ['red', 'yellow', 'black'];
  colours.innerHTML =
    kinds.map((k) => `<span class="chip" data-kind="${k}"></span>`).join('') +
    `<span>${setup.count === 3 ? '4 billes par couleur' : '7 billes par couleur'} + la noire</span>`;
  (['p1', 'p2', 'p3'] as const).forEach((n, i) => {
    const input = form.elements.namedItem(n) as HTMLInputElement;
    if (!input.value && setup.names[i]) input.value = setup.names[i]!;
  });
}

document.querySelectorAll<HTMLButtonElement>('.segmented button').forEach((b) => {
  b.addEventListener('click', () => {
    setup = { ...setup, count: Number(b.dataset.count) === 3 ? 3 : 2 };
    renderSetup();
  });
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  sound.unlock();
  const names = (['p1', 'p2', 'p3'] as const)
    .slice(0, setup.count)
    .map((n, i) => (form.elements.namedItem(n) as HTMLInputElement).value.trim() || `Joueur ${i + 1}`);
  setup = { count: setup.count, names };
  saveSetup(setup);
  startMatch(names);
});

function showMenu(): void {
  match = null;
  game.hidden = true;
  menu.hidden = false;
  btnNew.hidden = true;
  renderSetup();
  (form.elements.namedItem('p1') as HTMLInputElement).focus();
}

function startMatch(names: string[]): void {
  match = new Match(names);
  match.on({
    physics: (e) => sound.physics(e),
    outcome: (_o, m) => {
      if (m.phase === 'over') window.setTimeout(() => showEnd(m), 650);
    },
  });
  controls.angle = 0;
  controls.reset();
  hud.invalidate();
  menu.hidden = true;
  game.hidden = false;
  btnNew.hidden = false;
  resize();
}

function showEnd(m: Match): void {
  if (match !== m) return;
  const w = m.rules.winner;
  if (w === null) return;
  const title = $('end-title');
  title.textContent = '';
  title.append(`${m.rules.players[w]!.name} `);
  const hl = document.createElement('span');
  hl.className = 'hl';
  hl.textContent = 'gagne';
  title.append(hl);
  $('end-detail').textContent = m.lastOutcome?.messages.join(' · ') ?? '';
  endDialog.showModal();
}

$('end-again').addEventListener('click', () => {
  endDialog.close();
  if (!match) return;
  // la casse passe au joueur suivant
  const names = [...match.names.slice(1), match.names[0]!];
  startMatch(names);
});
$('end-menu').addEventListener('click', () => {
  endDialog.close();
  showMenu();
});

btnNew.addEventListener('click', () => {
  if (!match || match.phase === 'over') return showMenu();
  confirmDialog.returnValue = '';
  confirmDialog.showModal();
});
confirmDialog.addEventListener('close', () => {
  if (confirmDialog.returnValue === 'ok') showMenu();
});

$('btn-rules').addEventListener('click', () => rulesDialog.showModal());

btnSound.addEventListener('click', () => {
  sound.unlock();
  sound.muted = !sound.muted;
  btnSound.setAttribute('aria-pressed', String(sound.muted));
  btnSound.textContent = sound.muted ? 'Son : coupé' : 'Son : activé';
});

// ---------- rendu ----------
function resize(): void {
  const r = wrap.getBoundingClientRect();
  if (r.width > 0 && r.height > 0) renderer.resize(r.width, r.height);
}
new ResizeObserver(resize).observe(wrap);

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const m = match;
  if (m && !game.hidden) {
    sound.frame();
    m.update(dt);
    renderer.draw(m, {
      angle: controls.angle,
      power: controls.power,
      placeValid: m.phase === 'placing' && m.canPlaceCue(m.cue),
    });
    hud.update(m);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

showMenu();

// Point d'accès pour les tests de bout en bout (?debug dans l'URL).
if (new URLSearchParams(location.search).has('debug')) {
  Object.assign(window, { __billard: { match: () => match, controls } });
}
