import { Match } from './game/match.js';
import { ballsPerGroup } from './game/rack.js';
import { Replay, ShotLog } from './game/replay.js';
import {
  type ApiError,
  Online,
  createRoom,
  joinRoom,
  normalizeCode,
  type Incoming,
  type RoomInfo,
  type Session,
  type StateMsg,
} from './net/online.js';
import { Renderer } from './render/renderer.js';
import type { CameraMode, Renderer3D } from './render/renderer3d.js';
import type { TableRenderer } from './render/types.js';
import { Sound } from './ui/audio.js';
import { Chat } from './ui/chat.js';
import { Controls } from './ui/controls.js';
import { Hud, type HudView } from './ui/hud.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} introuvable`);
  return el as T;
};

const STORE_KEY = 'billard-anglais:setup';
const SESSION_KEY = 'billard-anglais:online';

type Mode = 'local' | 'online';

interface Setup {
  mode: Mode;
  count: 2 | 3;
  names: string[];
  /** Visée réaliste : seulement la direction de la blanche. */
  realistic: boolean;
}

function loadSetup(): Setup {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Setup>;
      if ((s.count === 2 || s.count === 3) && Array.isArray(s.names)) {
        return {
          mode: s.mode === 'online' ? 'online' : 'local',
          count: s.count,
          names: s.names.map(String).slice(0, 3),
          realistic: s.realistic === true,
        };
      }
    }
  } catch {
    /* stockage indisponible : valeurs par défaut */
  }
  return { mode: 'local', count: 2, names: [], realistic: false };
}

function saveSetup(s: Setup): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* ignoré */
  }
}

/** Place gardée dans une salle, pour la retrouver après un rechargement. */
function loadSession(code: string): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as Session | null;
    if (s && s.code === code && typeof s.token === 'string') return s;
  } catch {
    /* ignoré */
  }
  return null;
}

function saveSession(s: Session | null): void {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignoré */
  }
}

function roomLink(code: string): string {
  return `${location.origin}${location.pathname}#salle=${code}`;
}

function setRoomHash(code: string | null): void {
  history.replaceState(null, '', code ? `#salle=${code}` : location.pathname + location.search);
}

function hashRoom(): string | null {
  const m = /salle=([A-Za-z0-9-]+)/.exec(location.hash);
  return m ? normalizeCode(m[1]!) : null;
}

const menu = $('menu');
const lobby = $('lobby');
const game = $('game');
const form = $<HTMLFormElement>('setup');
const p1Label = $('p1-label');
const p2Field = $('p2-field');
const p3Field = $('p3-field');
const colours = $('colours');
const btnPlay = $<HTMLButtonElement>('btn-play');
const joinBlock = $('join-block');
const joinCode = $<HTMLInputElement>('join-code');
const btnJoin = $<HTMLButtonElement>('btn-join');
const menuError = $('menu-error');
const btnNew = $<HTMLButtonElement>('btn-new');
const btnSound = $<HTMLButtonElement>('btn-sound');
const btnCopy = $<HTMLButtonElement>('btn-copy');
const rulesDialog = $<HTMLDialogElement>('rules-dialog');
const endDialog = $<HTMLDialogElement>('end-dialog');
const confirmDialog = $<HTMLDialogElement>('confirm-dialog');
const canvas = $<HTMLCanvasElement>('table');
const wrap = $('table-wrap');

const canvas3d = $<HTMLCanvasElement>('table3d');
const renderer2d = new Renderer(canvas);
/** Rendu actif : 2D par défaut, 3D (chargée à la demande) au choix du joueur. */
let renderer: TableRenderer = renderer2d;
let renderer3d: Renderer3D | null = null;
const sound = new Sound();
const hud = new Hud($('players'), $('status'), $('hint'), $('power'), $('spin'));

let match: Match | null = null;
let setup = loadSetup();
/** Coups de la partie en cours, pour les revoir. */
const shotLog = new ShotLog();
/** Relecture en cours (la vraie partie continue derrière). */
let replay: Replay | null = null;
const btnReplay = $<HTMLButtonElement>('btn-replay');
const replayBar = $('replay-bar');

/** Partie en ligne en cours (null en jeu local). */
interface Net {
  online: Online;
  room: RoomInfo | null;
  connected: boolean;
  /** Numéro de partie dans la salle (revanches). */
  game: number;
  /** Siège de chaque joueur de la partie, dans l'ordre du jeu. */
  order: number[];
  /** Version du dernier état officiel connu. */
  version: number;
  /** Le coup en cours a été joué sur cet écran : c'est lui qui enverra le résultat. */
  mine: boolean;
  /** État reçu pendant que l'animation du coup tourne encore ici. */
  pending: Incoming & StateMsg | null;
  pendingAt: number;
  /** Dernier état officiel, pour revenir en arrière si le coup regardé n'aboutit jamais. */
  official: StateMsg | null;
  /** Depuis quand les billes sont arrêtées ici sans état officiel du tireur. */
  stalledSince: number;
  /** Visée du joueur qui a la main, vue depuis les autres écrans (lissée à l'affichage). */
  remoteAim: { angle: number; power: number };
  /** Dernière visée reçue, vers laquelle remoteAim glisse à chaque image. */
  aimTarget: { angle: number; power: number; seq: number; cue: { x: number; y: number } | null };
  lastAimKey: string;
}
let net: Net | null = null;

const meIndex = (): number => (net && match ? net.order.indexOf(net.online.seat) : -1);
const myTurn = (): boolean => !net || (match !== null && net.order[match.rules.current] === net.online.seat);

/** Coup en attente : la queue est en route vers la blanche. */
let pendingShot: number | null = null;

/** Anime la queue jusqu'à la blanche, puis joue le coup au moment du contact. */
function strikeThen(m: Match, angle: number, power: number, hit: () => void): void {
  if (pendingShot !== null) return;
  const lead = renderer.shot(m.cue, angle, power);
  pendingShot = window.setTimeout(() => {
    pendingShot = null;
    if (match === m && m.phase === 'aiming') hit();
  }, lead);
}

function cancelStrike(): void {
  if (pendingShot !== null) window.clearTimeout(pendingShot);
  pendingShot = null;
}

const controls = new Controls(
  {
    match: () => match,
    view: () => renderer.view,
    blocked: () =>
      game.hidden !== false ||
      document.querySelector('dialog[open]') !== null ||
      !myTurn() ||
      pendingShot !== null ||
      replay !== null,
    shoot: (angle, power, spin) => {
      const m = match;
      if (!m || m.phase !== 'aiming' || power <= 0) return;
      strikeThen(m, angle, power, () => {
        m.resolveLocally = true;
        const before = m.snapshot();
        if (!m.shoot(angle, power, spin)) return;
        shotLog.start(before, angle, power, spin);
        sound.strike(power);
        if (net) {
          net.mine = true;
          net.online.send({ type: 'shot', angle, power, spin, shots: m.shots }).catch(() => undefined);
        }
      });
    },
    placed: () => {
      if (net) sendState();
    },
    gesture: () => sound.unlock(),
  },
  {
    canvases: [canvas, canvas3d],
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
function nameInput(n: 'p1' | 'p2' | 'p3'): HTMLInputElement {
  return form.elements.namedItem(n) as HTMLInputElement;
}

function renderSetup(): void {
  const online = setup.mode === 'online';
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.mode === setup.mode));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-count]').forEach((b) => {
    b.setAttribute('aria-pressed', String(Number(b.dataset.count) === setup.count));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-aim]').forEach((b) => {
    b.setAttribute('aria-pressed', String((b.dataset.aim === 'real') === setup.realistic));
  });
  $('aim-help').textContent = aimLabel(setup.realistic) + (online ? ' Vaut pour toute la salle.' : '');
  p1Label.innerHTML = online ? 'Votre nom' : 'Joueur 1 <small>casse</small>';
  p2Field.hidden = online;
  p3Field.hidden = online || setup.count !== 3;
  joinBlock.hidden = !online;
  btnPlay.textContent = online ? `Créer une salle à ${setup.count}` : 'Jouer';
  const kinds = setup.count === 3 ? ['red', 'yellow', 'blue', 'black'] : ['red', 'yellow', 'black'];
  colours.innerHTML =
    kinds.map((k) => `<span class="chip" data-kind="${k}"></span>`).join('') +
    `<span>${ballsPerGroup(setup.count)} billes par couleur + la noire</span>`;
  (['p1', 'p2', 'p3'] as const).forEach((n, i) => {
    const input = nameInput(n);
    if (!input.value && setup.names[i]) input.value = setup.names[i]!;
  });
}

function showError(msg: string | null): void {
  menuError.textContent = msg ?? '';
  menuError.hidden = !msg;
}

function setBusy(busy: boolean): void {
  btnPlay.disabled = busy;
  btnJoin.disabled = busy;
}

document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => {
  b.addEventListener('click', () => {
    setup = { ...setup, mode: b.dataset.mode === 'online' ? 'online' : 'local' };
    showError(null);
    renderSetup();
  });
});

function aimLabel(realistic: boolean): string {
  return realistic
    ? 'Seule la direction de la blanche est tracée.'
    : 'Bille fantôme et trajectoire de la bille visée.';
}

document.querySelectorAll<HTMLButtonElement>('[data-aim]').forEach((b) => {
  b.addEventListener('click', () => {
    setup = { ...setup, realistic: b.dataset.aim === 'real' };
    saveSetup(setup);
    renderSetup();
  });
});

document.querySelectorAll<HTMLButtonElement>('[data-count]').forEach((b) => {
  b.addEventListener('click', () => {
    setup = { ...setup, count: Number(b.dataset.count) === 3 ? 3 : 2 };
    renderSetup();
  });
});

function readNames(): string[] {
  const count = setup.mode === 'online' ? 1 : setup.count;
  return (['p1', 'p2', 'p3'] as const)
    .slice(0, count)
    .map((n, i) => nameInput(n).value.trim() || `Joueur ${i + 1}`);
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  sound.unlock();
  showError(null);
  const names = readNames();
  setup = { ...setup, names: [...names, ...setup.names.slice(names.length)] };
  saveSetup(setup);
  if (setup.mode === 'local') {
    startLocal(names);
    return;
  }
  setBusy(true);
  createRoom(names[0]!, setup.count, setup.realistic)
    .then((s) => enterRoom({ ...s, code: normalizeCode(s.code) }))
    .catch((err: Error) => showError(err.message))
    .finally(() => setBusy(false));
});

function joinFromMenu(): void {
  sound.unlock();
  showError(null);
  const code = normalizeCode(joinCode.value);
  if (code.length < 4) {
    showError('Entrez le code de la salle.');
    joinCode.focus();
    return;
  }
  const name = readNames()[0]!;
  setup = { ...setup, names: [name, ...setup.names.slice(1)] };
  saveSetup(setup);
  setBusy(true);
  joinRoom(code, name, loadSession(code)?.token)
    .then(enterRoom)
    .catch((err: Error) => showError(err.message))
    .finally(() => setBusy(false));
}

btnJoin.addEventListener('click', joinFromMenu);
joinCode.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  joinFromMenu();
});
joinCode.addEventListener('input', () => {
  joinCode.value = normalizeCode(joinCode.value);
});

function showMenu(): void {
  exitReplay(false);
  match = null;
  btn3d.hidden = true;
  sound.rolling(0);
  game.hidden = true;
  lobby.hidden = true;
  menu.hidden = false;
  btnNew.hidden = true;
  renderSetup();
  nameInput('p1').focus();
}

/** Affiche la table pour une partie (locale ou en ligne). */
function showGame(m: Match): void {
  exitReplay(false);
  shotLog.clear();
  match = m;
  m.on({
    physics: (e) => {
      sound.physics(e);
      renderer.event(e);
    },
    outcome: (o, mm) => {
      sound.outcome(o);
      if (match === mm) shotLog.finish(mm.snapshot());
      if (net?.mine && match === mm) {
        net.mine = false;
        sendState();
      }
      if (mm.phase === 'over') window.setTimeout(() => showEnd(mm), 650);
    },
  });
  controls.angle = 0;
  controls.reset();
  cancelStrike();
  renderer.reset();
  hud.invalidate();
  menu.hidden = true;
  lobby.hidden = true;
  game.hidden = false;
  btnNew.hidden = false;
  btn3d.hidden = false;
  btnNew.textContent = net ? 'Quitter la salle' : 'Nouvelle partie';
  resize();
}

/** Visée réaliste de la partie locale en cours (choisie au menu). */
let localRealistic = false;

function startLocal(names: string[]): void {
  localRealistic = setup.realistic;
  showGame(new Match(names));
}

/** En ligne, la visée est fixée par l'hôte pour toute la salle. */
function realisticAim(): boolean {
  return net ? net.room?.realistic === true : localRealistic;
}

function showEnd(m: Match): void {
  if (match !== m || endDialog.open) return;
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
  const host = !net || net.online.seat === 0;
  $('end-again').hidden = !host;
  $('end-wait').hidden = host;
  $('end-menu').textContent = net ? 'Quitter la salle' : 'Menu';
  endDialog.showModal();
}

$('end-again').addEventListener('click', () => {
  endDialog.close();
  if (!match) return;
  if (net) return rematchOnline();
  // la casse passe au joueur suivant
  const names = [...match.names.slice(1), match.names[0]!];
  startLocal(names);
});
$('end-menu').addEventListener('click', () => {
  endDialog.close();
  if (net) leaveRoom();
  else showMenu();
});

btnNew.addEventListener('click', () => {
  if (!net && (!match || match.phase === 'over')) return showMenu();
  // fenêtre de fin fermée (Échap) : on la rouvre pour la revanche ou pour quitter
  if (net && match?.phase === 'over') return showEnd(match);
  $('confirm-title').innerHTML = net ? 'Quitter la <span class="hl">salle</span> ?' : 'Abandonner la <span class="hl">partie</span> ?';
  $('confirm-lead').textContent = net
    ? 'Vous pourrez reprendre votre place en rouvrant le lien, tant que la salle existe.'
    : 'La partie en cours sera perdue.';
  $('confirm-ok').textContent = net ? 'Quitter' : 'Nouvelle partie';
  confirmDialog.returnValue = '';
  confirmDialog.showModal();
});
confirmDialog.addEventListener('close', () => {
  if (confirmDialog.returnValue !== 'ok') return;
  if (net) leaveRoom();
  else showMenu();
});

$('btn-rules').addEventListener('click', () => rulesDialog.showModal());

btnSound.addEventListener('click', () => {
  sound.unlock();
  sound.muted = !sound.muted;
  btnSound.setAttribute('aria-pressed', String(sound.muted));
  btnSound.textContent = sound.muted ? 'Son : coupé' : 'Son : activé';
});

// ---------- en ligne ----------
function enterRoom(session: Session): void {
  net?.online.disconnect();
  saveSession(session);
  setRoomHash(session.code);
  const online = new Online(session, {
    room: onRoom,
    msg: onNetMsg,
    connection: (c) => {
      if (!net || net.online !== online) return;
      net.connected = c;
      if (!match) renderLobby();
    },
    chat: (lines) => {
      if (net?.online === online) chat.add(lines);
    },
    closed: (reason) => {
      if (!net || net.online !== online) return;
      endDialog.close();
      chat.disable();
      net = null;
      saveSession(null);
      setRoomHash(null);
      showMenu();
      showError(reason);
    },
  });
  net = {
    online,
    room: null,
    connected: false,
    game: 0,
    order: [],
    version: 0,
    mine: false,
    pending: null,
    pendingAt: 0,
    official: null,
    stalledSince: 0,
    remoteAim: { angle: 0, power: 0 },
    aimTarget: { angle: 0, power: 0, seq: 0, cue: null },
    lastAimKey: '',
  };
  match = null;
  menu.hidden = true;
  game.hidden = true;
  lobby.hidden = false;
  btnNew.hidden = true;
  chat.reset(session.seat);
  renderLobby();
  online.connect();
}

function leaveRoom(): void {
  if (net) void net.online.leave();
  chat.disable();
  net = null;
  saveSession(null);
  setRoomHash(null);
  showMenu();
}

function renderLobby(): void {
  if (!net) return;
  const { code } = net.online.session;
  const info = net.room;
  $('lobby-code').textContent = code;
  $('lobby-mode').textContent = info
    ? `${info.count} joueurs · visée ${info.realistic ? 'réaliste' : 'assistée'} : ${aimLabel(info.realistic).toLowerCase()}`
    : '';
  $<HTMLInputElement>('lobby-link').value = roomLink(code);
  const count = info?.count ?? 2;
  const seats = $('lobby-seats');
  seats.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const s = info?.seats[i] ?? null;
    const li = document.createElement('li');
    li.className = s ? '' : 'is-empty';
    const name = document.createElement('span');
    name.className = 'seat-name';
    name.textContent = s ? s.name : 'En attente…';
    const tags = [i === 0 ? 'hôte' : '', i === net.online.seat ? 'vous' : '', s && !s.online ? 'hors ligne' : '']
      .filter(Boolean)
      .join(' · ');
    const small = document.createElement('small');
    small.textContent = tags;
    li.append(name, small);
    seats.append(li);
  }
  const missing = info ? info.seats.filter((s) => !s).length : count - 1;
  $('lobby-status').textContent = !net.connected
    ? 'Connexion au serveur…'
    : missing > 0
      ? `En attente de ${missing} joueur${missing > 1 ? 's' : ''}…`
      : 'Tout le monde est là, la partie commence…';
}

const canShare = typeof navigator.share === 'function';
const copyLabel = canShare ? 'Partager' : 'Copier';
btnCopy.textContent = copyLabel;
btnCopy.addEventListener('click', () => {
  if (!net) return;
  const url = roomLink(net.online.session.code);
  const done = (): void => {
    btnCopy.textContent = 'Copié !';
    window.setTimeout(() => (btnCopy.textContent = copyLabel), 1600);
  };
  if (canShare) {
    navigator.share({ title: 'Billard anglais', text: 'Viens jouer au billard !', url }).catch(() => undefined);
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(done, () => $<HTMLInputElement>('lobby-link').select());
  } else {
    $<HTMLInputElement>('lobby-link').select();
  }
});
$('lobby-link').addEventListener('focus', (e) => (e.target as HTMLInputElement).select());
$('btn-leave').addEventListener('click', leaveRoom);

function onRoom(info: RoomInfo): void {
  if (!net) return;
  net.room = info;
  if (!match) renderLobby();
  // l'hôte lance la partie dès que toutes les places sont prises
  if (net.online.seat === 0 && !info.started && !match && info.seats.every((s) => s !== null)) {
    const order = info.seats.map((_s, i) => i);
    net.game = 1;
    startOnline(order);
  }
}

function seatName(seat: number): string {
  return net?.room?.seats[seat]?.name ?? `Joueur ${seat + 1}`;
}

function startOnline(order: number[]): void {
  if (!net) return;
  net.order = order;
  showGame(new Match(order.map(seatName)));
  sendState();
}

function rematchOnline(): void {
  if (!net) return;
  // la casse passe au joueur suivant
  const order = [...net.order.slice(1), net.order[0]!];
  net.game++;
  startOnline(order);
}

/** Envoie l'état officiel de la partie (après la casse, un placement ou un coup). */
function sendState(attempt = 0): void {
  if (!net || !match) return;
  const n = net;
  const msg: StateMsg = {
    type: 'state',
    game: n.game,
    order: n.order,
    turn: n.order[match.rules.current]!,
    over: match.phase === 'over',
    snap: match.snapshot(),
  };
  n.official = msg;
  n.online
    .send(msg)
    .then((v) => {
      if (v !== undefined) n.version = Math.max(n.version, v);
    })
    .catch(() => {
      // réseau coupé : on réessaie tant que l'état n'a pas changé ici
      if (attempt < 5 && net === n) {
        window.setTimeout(() => {
          if (net === n && match && match.shots === msg.snap.shots) sendState(attempt + 1);
        }, 1500);
      }
    });
}

function onNetMsg(m: Incoming): void {
  if (!net) return;
  if (m.type === 'state') {
    receiveState(m);
    return;
  }
  if (!match || net.order[match.rules.current] !== m.from || m.from === net.online.seat) return;
  if (m.type === 'aim') {
    const seq = m.seq ?? 0;
    if (seq && seq <= net.aimTarget.seq) return; // aperçu arrivé après un plus récent
    const cue = m.x !== undefined && m.y !== undefined ? { x: m.x, y: m.y } : null;
    net.aimTarget = { angle: m.angle, power: m.power, seq, cue };
  } else if (m.type === 'shot') {
    if (stalled(match) && net.official) {
      // le tireur a rechargé sa page pendant le coup précédent et le rejoue
      match.restore(net.official.snap);
      match.resolveLocally = true;
    }
    if (match.phase !== 'aiming' || m.shots !== match.shots + 1) return;
    const mm = match;
    // la queue frappe exactement dans l'axe du coup
    net.remoteAim = { angle: m.angle, power: m.power };
    net.aimTarget = { ...net.aimTarget, angle: m.angle, power: 0, cue: null };
    strikeThen(mm, m.angle, m.power, () => {
      mm.resolveLocally = false;
      const before = mm.snapshot();
      if (!mm.shoot(m.angle, m.power, m.spin)) return;
      shotLog.start(before, m.angle, m.power, m.spin);
      sound.strike(m.power);
    });
  }
}

function receiveState(m: Incoming & StateMsg): void {
  if (!net || (m.version ?? 0) <= net.version) return;
  // le coup est encore en train de rouler ici : on le laisse finir avant de recaler la table
  if (
    match &&
    m.game === net.game &&
    match.phase === 'rolling' &&
    !match.resolveLocally &&
    match.shots === m.snap.shots &&
    match.world.isMoving()
  ) {
    net.pending = m;
    net.pendingAt = performance.now();
    return;
  }
  adopt(m);
}

function adopt(m: Incoming & StateMsg): void {
  if (!net) return;
  net.version = m.version ?? net.version;
  net.pending = null;
  net.official = m;
  const newGame = !match || m.game !== net.game || match.playerCount !== m.snap.names.length;
  const wasOver = match?.phase === 'over';
  const prevShots = match?.shots;
  net.game = m.game;
  net.order = m.order;
  net.mine = false;
  net.aimTarget.cue = null;
  if (newGame) {
    if (endDialog.open) endDialog.close();
    showGame(Match.fromSnapshot(m.snap));
  } else {
    match!.restore(m.snap);
    match!.resolveLocally = true;
    shotLog.finish(match!.snapshot());
    if (prevShots !== match!.shots) {
      controls.reset();
      // le coup joué ailleurs vient de se conclure : même signal sonore que chez le tireur
      if (match!.lastOutcome) sound.outcome(match!.lastOutcome);
    }
    hud.invalidate();
  }
  const cur = match!;
  if (cur.phase === 'over' && (newGame || !wasOver)) window.setTimeout(() => showEnd(cur), 650);
}

/** Coup regardé dont les billes sont arrêtées sans que l'état officiel soit arrivé. */
function stalled(m: Match): boolean {
  return m.phase === 'rolling' && !m.resolveLocally && !m.world.isMoving();
}

/** Sans nouvelles du tireur après l'arrêt des billes, on revient au dernier état officiel. */
function checkStalled(m: Match, now: number): void {
  if (!net) return;
  if (!stalled(m)) {
    net.stalledSince = 0;
    return;
  }
  if (!net.stalledSince) net.stalledSince = now;
  else if (now - net.stalledSince > 8000 && net.official) {
    net.stalledSince = 0;
    m.restore(net.official.snap);
    m.resolveLocally = true;
    hud.invalidate();
  }
}

function hudView(): HudView | null {
  if (!net || !match) return null;
  const seats = net.room?.seats ?? [];
  return {
    me: meIndex(),
    offline: net.order.flatMap((seat, i) => (seats[seat] && !seats[seat]!.online ? [i] : [])),
    connected: net.connected,
  };
}

/** Diffuse la visée (ou la blanche en main) du joueur qui a la main sur cet écran. */
function shareAim(m: Match): void {
  if (!net || !myTurn() || pendingShot !== null) return;
  let key = '';
  if (m.phase === 'aiming') key = `a${controls.angle.toFixed(4)}:${controls.power.toFixed(2)}`;
  else if (m.phase === 'placing') key = `p${m.cue.x.toFixed(1)}:${m.cue.y.toFixed(1)}`;
  if (!key || key === net.lastAimKey) return;
  net.lastAimKey = key;
  net.online.aim(
    m.phase === 'placing'
      ? { type: 'aim', angle: controls.angle, power: 0, x: m.cue.x, y: m.cue.y }
      : { type: 'aim', angle: controls.angle, power: controls.power },
  );
}

/**
 * Les aperçus de visée arrivent par à-coups (réseau, envoi toutes les 50 ms) :
 * la queue et la blanche en main glissent vers la dernière position reçue au lieu d'y sauter.
 */
function smoothRemoteAim(m: Match, dt: number): void {
  if (!net || myTurn() || pendingShot !== null) return;
  const k = 1 - Math.exp(-dt * 16);
  const t = net.aimTarget;
  const a = net.remoteAim;
  let da = t.angle - a.angle;
  da = Math.atan2(Math.sin(da), Math.cos(da)); // plus court chemin
  a.angle += da * k;
  a.power += (t.power - a.power) * k;
  if (t.cue && m.phase === 'placing') {
    const c = m.cue;
    m.moveCueInHand({ x: c.x + (t.cue.x - c.x) * k, y: c.y + (t.cue.y - c.y) * k });
  }
}

// ---------- replay ----------
function startReplay(all: boolean): void {
  const shots = shotLog.complete;
  if (!match || shots.length === 0) return;
  cancelStrike();
  renderer.reset();
  replay = new Replay(shots, all ? 0 : shots.length - 1, all, {
    strike: (cue, angle, power) => renderer.shot(cue, angle, power),
    listener: {
      physics: (e) => {
        sound.physics(e);
        renderer.event(e);
      },
    },
    outcome: (o) => sound.outcome(o),
  });
  replayBar.hidden = false;
  btnReplay.hidden = true;
  replayAvailable = false;
  hud.invalidate();
  renderReplayBar();
  $('replay-play').focus({ preventScroll: true });
}

/** Quitte la relecture ; en fin de partie, rouvre la fenêtre de fin si demandé. */
function exitReplay(showEndAgain = true): void {
  if (!replay) return;
  replay = null;
  replayBar.hidden = true;
  sound.rolling(0);
  renderer.reset();
  hud.invalidate();
  if (showEndAgain && match?.phase === 'over') showEnd(match);
}

const hint = $('hint');
const REPLAY_HINT = 'Replay · Espace : pause · ← → : coup précédent / suivant · Échap : retour au jeu';
let replayKey = '';
function renderReplayBar(): void {
  if (!replay) return;
  const key = `${replay.index}:${replay.playing}:${replay.speed}:${replay.finished}`;
  if (key === replayKey) return;
  replayKey = key;
  $('replay-label').textContent = `Coup ${replay.index + 1}/${replay.shots.length} · ${replay.shooter}`;
  const play = $('replay-play');
  play.textContent = replay.playing ? '⏸' : replay.finished ? '↻' : '▶';
  play.setAttribute('aria-label', replay.playing ? 'Pause' : replay.finished ? 'Revoir' : 'Lecture');
  $<HTMLButtonElement>('replay-prev').disabled = replay.index === 0;
  $<HTMLButtonElement>('replay-next').disabled = replay.index >= replay.shots.length - 1;
  const speed = $('replay-speed');
  speed.textContent = `×${replay.speed}`;
  speed.setAttribute('aria-label', `Vitesse ×${replay.speed}`);
}

function drawReplay(r: Replay, dt: number, now: number): void {
  r.update(dt * 1000);
  const rm = r.match;
  sound.rolling(rollingSpeed(rm));
  const aim = r.aim;
  renderer.draw(rm, { angle: aim.angle, power: aim.power, placeValid: true, realistic: realisticAim() }, now);
  hud.update(rm, null);
  if (hint.textContent !== REPLAY_HINT) hint.textContent = REPLAY_HINT;
  renderReplayBar();
}

let replayAvailable = false;
function updateReplayButton(m: Match): void {
  const ok = !replay && m.phase !== 'rolling' && shotLog.complete.length > 0;
  if (ok === replayAvailable) return;
  replayAvailable = ok;
  btnReplay.hidden = !ok;
}

btnReplay.addEventListener('click', () => startReplay(false));
$('end-replay').addEventListener('click', () => {
  endDialog.close();
  startReplay(true);
});
$('replay-exit').addEventListener('click', () => exitReplay());
$('replay-play').addEventListener('click', () => replay?.toggle());
$('replay-prev').addEventListener('click', () => replay?.goTo(replay.index - 1));
$('replay-next').addEventListener('click', () => replay?.goTo(replay.index + 1));
$('replay-speed').addEventListener('click', () => {
  if (replay) replay.speed = replay.speed === 1 ? 2 : 1;
});
document.addEventListener('keydown', (e) => {
  if (!replay || document.querySelector('dialog[open]')) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  if (e.key === 'Escape') exitReplay();
  else if (e.key === ' ' && t?.tagName !== 'BUTTON') replay.toggle();
  else if (e.key === 'ArrowLeft') replay.goTo(replay.index - 1);
  else if (e.key === 'ArrowRight') replay.goTo(replay.index + 1);
  else return;
  e.preventDefault();
});

// ---------- chat ----------
const chat = new Chat(
  {
    panel: $('chat'),
    list: $('chat-list'),
    form: $<HTMLFormElement>('chat-form'),
    input: $<HTMLInputElement>('chat-input'),
    quick: $('chat-quick'),
    error: $('chat-error'),
    toggle: $<HTMLButtonElement>('btn-chat'),
    unread: $('chat-unread'),
    close: $('chat-close'),
  },
  {
    send: (text) => (net ? net.online.say(text) : Promise.reject(new Error('Pas de salle'))),
    incoming: () => sound.chat(),
  },
);

// ---------- vue 3D ----------
const VIEW3D_KEY = 'billard-anglais:3d';
const btn3d = $<HTMLButtonElement>('btn-3d');
const bar3d = $('view3d-bar');
let loading3d = false;

/** Angle de visée affiché : le sien, celui du joueur qui a la main, ou celui du coup rejoué. */
function shownAimAngle(): number {
  if (replay) return replay.aim.angle;
  return net && !myTurn() ? net.remoteAim.angle : controls.angle;
}

const myAiming = (): boolean =>
  match !== null && myTurn() && !replay && pendingShot === null && document.querySelector('dialog[open]') === null;

async function set3D(on: boolean): Promise<void> {
  if (on && !renderer3d) {
    if (loading3d) return;
    loading3d = true;
    btn3d.disabled = true;
    try {
      const mod = await import('./render/renderer3d.js');
      renderer3d = new mod.Renderer3D(canvas3d, wrap, {
        aimAngle: shownAimAngle,
        canRotateAim: () => myAiming() && match!.phase === 'aiming',
        rotateAim: (d) => {
          controls.angle += d;
        },
        wantsPointer: () => myAiming() && (match!.phase === 'aiming' || match!.phase === 'placing'),
        cancelGamePointer: () => controls.cancelPointer(),
        modeChanged: renderCameraBar,
      });
    } catch (err) {
      console.error(err);
      hint.textContent = 'La vue 3D n’est pas disponible sur cet appareil (WebGL).';
      on = false;
    } finally {
      loading3d = false;
      btn3d.disabled = false;
    }
  }
  const use3d = on && renderer3d !== null;
  renderer = use3d ? renderer3d! : renderer2d;
  canvas.hidden = use3d;
  canvas3d.hidden = !use3d;
  bar3d.hidden = !use3d;
  btn3d.setAttribute('aria-pressed', String(use3d));
  btn3d.textContent = use3d ? 'Vue 2D' : 'Vue 3D';
  renderer.reset();
  hud.threeD = use3d;
  hud.invalidate();
  resize();
  try {
    localStorage.setItem(VIEW3D_KEY, use3d ? '1' : '0');
  } catch {
    /* ignoré */
  }
}

function renderCameraBar(mode: CameraMode): void {
  bar3d.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.cam === mode));
  });
}

btn3d.addEventListener('click', () => void set3D(renderer === renderer2d));
bar3d.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach((b) => {
  b.addEventListener('click', () => {
    if (renderer3d) renderer3d.mode = b.dataset.cam as CameraMode;
  });
});
$('cam-reset').addEventListener('click', () => renderer3d?.resetView());

// ---------- rendu ----------
function resize(): void {
  const r = wrap.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return;
  renderer2d.resize(r.width, r.height);
  renderer3d?.resize(r.width, r.height);
}
new ResizeObserver(resize).observe(wrap);

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (net?.pending && match && (!match.world.isMoving() || now - net.pendingAt > 4000)) adopt(net.pending);
  const m = match;
  // un coup part sur la vraie table (joué ailleurs) : on quitte la relecture pour ne rien manquer
  if (replay && m && m.phase === 'rolling') exitReplay(false);
  if (m && !game.hidden && replay) {
    sound.frame();
    m.update(dt);
    drawReplay(replay, dt, now);
  } else if (m && !game.hidden) {
    sound.frame();
    m.update(dt);
    sound.rolling(rollingSpeed(m));
    checkStalled(m, now);
    shareAim(m);
    smoothRemoteAim(m, dt);
    const aim = net && !myTurn() ? net.remoteAim : { angle: controls.angle, power: controls.power };
    renderer.draw(m, {
      angle: aim.angle,
      power: aim.power,
      placeValid: m.phase === 'placing' && m.canPlaceCue(m.cue),
      realistic: realisticAim(),
    }, now);
    hud.update(m, hudView());
    updateReplayButton(m);
  }
  requestAnimationFrame(frame);
}

function rollingSpeed(m: Match): number {
  return m.phase === 'rolling' ? m.world.balls.reduce((v, b) => (b.onTable ? v + Math.hypot(b.vx, b.vy) : v), 0) : 0;
}
requestAnimationFrame(frame);

// ---------- démarrage ----------
showMenu();
try {
  if (localStorage.getItem(VIEW3D_KEY) === '1') void set3D(true);
} catch {
  /* stockage indisponible */
}
const linkCode = hashRoom();
if (linkCode) {
  setup = { ...setup, mode: 'online' };
  joinCode.value = linkCode;
  renderSetup();
  const saved = loadSession(linkCode);
  if (saved) {
    // rechargement ou retour sur le lien : on reprend sa place
    setBusy(true);
    joinRoom(linkCode, setup.names[0] ?? '', saved.token)
      .then(enterRoom)
      .catch((err: ApiError) => {
        if (err.status === 404 || err.status === 403) saveSession(null);
        showError(err.status === 404 ? 'Cette salle n’existe plus.' : err.message);
      })
      .finally(() => setBusy(false));
  } else {
    showError(null);
    nameInput('p1').focus();
  }
}

// Point d'accès pour les tests de bout en bout (?debug dans l'URL).
if (new URLSearchParams(location.search).has('debug')) {
  Object.assign(window, { __billard: { match: () => match, controls, net: () => net, replay: () => replay, shotLog } });
}
