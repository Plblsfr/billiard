import { Match } from './game/match.js';
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
import { Sound } from './ui/audio.js';
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
}

function loadSetup(): Setup {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Setup>;
      if ((s.count === 2 || s.count === 3) && Array.isArray(s.names)) {
        return { mode: s.mode === 'online' ? 'online' : 'local', count: s.count, names: s.names.map(String).slice(0, 3) };
      }
    }
  } catch {
    /* stockage indisponible : valeurs par défaut */
  }
  return { mode: 'local', count: 2, names: [] };
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

const renderer = new Renderer(canvas);
const sound = new Sound();
const hud = new Hud($('players'), $('status'), $('hint'), $('power'), $('spin'));

let match: Match | null = null;
let setup = loadSetup();

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
  /** Visée du joueur qui a la main, vue depuis les autres écrans. */
  remoteAim: { angle: number; power: number };
  lastAimKey: string;
}
let net: Net | null = null;

const meIndex = (): number => (net && match ? net.order.indexOf(net.online.seat) : -1);
const myTurn = (): boolean => !net || (match !== null && net.order[match.rules.current] === net.online.seat);

const controls = new Controls(
  {
    match: () => match,
    view: () => renderer.view,
    blocked: () => game.hidden !== false || document.querySelector('dialog[open]') !== null || !myTurn(),
    shoot: (angle, power, spin) => {
      if (!match) return;
      match.resolveLocally = true;
      if (!match.shoot(angle, power, spin)) return;
      sound.strike(power);
      if (net) {
        net.mine = true;
        net.online.send({ type: 'shot', angle, power, spin, shots: match.shots }).catch(() => undefined);
      }
    },
    placed: () => {
      if (net) sendState();
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
  p1Label.innerHTML = online ? 'Votre nom' : 'Joueur 1 <small>casse</small>';
  p2Field.hidden = online;
  p3Field.hidden = online || setup.count !== 3;
  joinBlock.hidden = !online;
  btnPlay.textContent = online ? `Créer une salle à ${setup.count}` : 'Jouer';
  const kinds = setup.count === 3 ? ['red', 'yellow', 'blue', 'black'] : ['red', 'yellow', 'black'];
  colours.innerHTML =
    kinds.map((k) => `<span class="chip" data-kind="${k}"></span>`).join('') +
    `<span>${setup.count === 3 ? '4 billes par couleur' : '7 billes par couleur'} + la noire</span>`;
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
  createRoom(names[0]!, setup.count)
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
  match = null;
  game.hidden = true;
  lobby.hidden = true;
  menu.hidden = false;
  btnNew.hidden = true;
  renderSetup();
  nameInput('p1').focus();
}

/** Affiche la table pour une partie (locale ou en ligne). */
function showGame(m: Match): void {
  match = m;
  m.on({
    physics: (e) => sound.physics(e),
    outcome: (_o, mm) => {
      if (net?.mine && match === mm) {
        net.mine = false;
        sendState();
      }
      if (mm.phase === 'over') window.setTimeout(() => showEnd(mm), 650);
    },
  });
  controls.angle = 0;
  controls.reset();
  hud.invalidate();
  menu.hidden = true;
  lobby.hidden = true;
  game.hidden = false;
  btnNew.hidden = false;
  btnNew.textContent = net ? 'Quitter la salle' : 'Nouvelle partie';
  resize();
}

function startLocal(names: string[]): void {
  showGame(new Match(names));
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
    closed: (reason) => {
      if (!net || net.online !== online) return;
      endDialog.close();
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
    lastAimKey: '',
  };
  match = null;
  menu.hidden = true;
  game.hidden = true;
  lobby.hidden = false;
  btnNew.hidden = true;
  renderLobby();
  online.connect();
}

function leaveRoom(): void {
  if (net) void net.online.leave();
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
    net.remoteAim = { angle: m.angle, power: m.power };
    if (m.x !== undefined && m.y !== undefined && match.phase === 'placing') match.moveCueInHand({ x: m.x, y: m.y });
  } else if (m.type === 'shot') {
    if (stalled(match) && net.official) {
      // le tireur a rechargé sa page pendant le coup précédent et le rejoue
      match.restore(net.official.snap);
      match.resolveLocally = true;
    }
    if (match.phase !== 'aiming' || m.shots !== match.shots + 1) return;
    match.resolveLocally = false;
    if (match.shoot(m.angle, m.power, m.spin)) sound.strike(m.power);
    net.remoteAim = { angle: m.angle, power: 0 };
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
  if (newGame) {
    if (endDialog.open) endDialog.close();
    showGame(Match.fromSnapshot(m.snap));
  } else {
    match!.restore(m.snap);
    match!.resolveLocally = true;
    if (prevShots !== match!.shots) controls.reset();
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
  if (!net || !myTurn()) return;
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
  if (net?.pending && match && (!match.world.isMoving() || now - net.pendingAt > 4000)) adopt(net.pending);
  const m = match;
  if (m && !game.hidden) {
    sound.frame();
    m.update(dt);
    checkStalled(m, now);
    shareAim(m);
    const aim = net && !myTurn() ? net.remoteAim : { angle: controls.angle, power: controls.power };
    renderer.draw(m, {
      angle: aim.angle,
      power: aim.power,
      placeValid: m.phase === 'placing' && m.canPlaceCue(m.cue),
    });
    hud.update(m, hudView());
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- démarrage ----------
showMenu();
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
  Object.assign(window, { __billard: { match: () => match, controls, net: () => net } });
}
