/**
 * Règles du billard anglais (variante « pub » : deux coups après une faute),
 * étendues à trois joueurs et trois couleurs.
 *
 * Module pur : il ne connaît ni la physique ni l'affichage. On lui donne l'état
 * et le compte rendu d'un coup, il renvoie le nouvel état et ce qu'il faut faire
 * sur la table (replacer la noire, retirer une couleur, bille en main…).
 */
import { GROUP_LABEL, isGroup, type BallKind, type Group } from './types.js';

export interface Player {
  name: string;
  group: Group | null;
  eliminated: boolean;
}

export interface RulesState {
  players: Player[];
  /** Couleurs en jeu (2 ou 3). */
  groups: Group[];
  current: number;
  /** Nombre de passages au tapis restant au joueur courant (1 ou 2). */
  visits: number;
  isBreak: boolean;
  /** Billes de chaque couleur encore sur la table. */
  onTable: Record<Group, number>;
  winner: number | null;
}

export interface ShotReport {
  /** Première bille touchée par la blanche (null si aucune). */
  firstContact: BallKind | null;
  /** Billes empochées pendant le coup (hors blanche), dans l'ordre. */
  potted: BallKind[];
  cuePotted: boolean;
}

export interface ShotOutcome {
  foul: string | null;
  /** Le joueur qui a tiré rejoue-t-il ? */
  continues: boolean;
  assigned: { player: number; group: Group }[];
  eliminated: number | null;
  winner: number | null;
  /** La noire doit être replacée sur son point. */
  respotBlack: boolean;
  /** Couleurs dont les billes restantes doivent être retirées de la table. */
  removeGroups: Group[];
  /** Le prochain joueur place la blanche derrière la ligne de baulk. */
  ballInHand: boolean;
  messages: string[];
}

export function createRules(names: string[], groups: Group[], perGroup: number): RulesState {
  if (names.length !== groups.length) throw new Error('Un joueur par couleur');
  const onTable = { red: 0, yellow: 0, blue: 0 } as Record<Group, number>;
  for (const g of groups) onTable[g] = perGroup;
  return {
    players: names.map((name) => ({ name, group: null, eliminated: false })),
    groups: [...groups],
    current: 0,
    visits: 1,
    isBreak: true,
    onTable,
    winner: null,
  };
}

function clone(s: RulesState): RulesState {
  return {
    ...s,
    players: s.players.map((p) => ({ ...p })),
    groups: [...s.groups],
    onTable: { ...s.onTable },
  };
}

export function ownerOf(s: RulesState, g: Group): number | null {
  const i = s.players.findIndex((p) => !p.eliminated && p.group === g);
  return i < 0 ? null : i;
}

export function alivePlayers(s: RulesState): number[] {
  return s.players.flatMap((p, i) => (p.eliminated ? [] : [i]));
}

export function nextAlive(s: RulesState, from: number): number {
  const n = s.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    if (!s.players[i]!.eliminated) return i;
  }
  return from;
}

/** Le joueur a-t-il vidé sa couleur (il doit alors jouer la noire) ? */
export function isOnBlack(s: RulesState, player: number): boolean {
  const g = s.players[player]!.group;
  return g !== null && s.onTable[g] === 0;
}

/** Couleurs que le joueur a le droit de toucher en premier. */
export function legalTargets(s: RulesState, player: number): BallKind[] {
  if (s.isBreak) return ['black', ...s.groups.filter((g) => s.onTable[g] > 0)];
  if (isOnBlack(s, player)) return ['black'];
  const g = s.players[player]!.group;
  if (g) return [g];
  return s.groups.filter((x) => ownerOf(s, x) === null && s.onTable[x] > 0);
}

/** Attribue automatiquement les couleurs quand il ne reste qu'un choix possible. */
function autoAssign(s: RulesState, out: ShotOutcome): void {
  for (;;) {
    const unassigned = alivePlayers(s).filter((i) => s.players[i]!.group === null);
    const free = s.groups.filter((g) => ownerOf(s, g) === null);
    if (unassigned.length === 1 && free.length === 1) {
      const p = unassigned[0]!;
      s.players[p]!.group = free[0]!;
      out.assigned.push({ player: p, group: free[0]! });
      out.messages.push(`${s.players[p]!.name} joue les ${GROUP_LABEL[free[0]!].many}`);
      continue;
    }
    if (unassigned.length === 0) {
      // couleurs sans propriétaire (joueur éliminé avant d'avoir une couleur)
      for (const g of free) {
        if (s.onTable[g] > 0) {
          out.removeGroups.push(g);
          out.messages.push(`Les ${GROUP_LABEL[g].many} sans joueur sont retirées`);
        }
        s.onTable[g] = 0;
      }
      s.groups = s.groups.filter((g) => !free.includes(g));
    }
    return;
  }
}

function eliminate(s: RulesState, player: number, out: ShotOutcome): void {
  const p = s.players[player]!;
  p.eliminated = true;
  out.eliminated = player;
  if (p.group) {
    const g = p.group;
    if (s.onTable[g] > 0) out.removeGroups.push(g);
    s.onTable[g] = 0;
    s.groups = s.groups.filter((x) => x !== g);
  }
  const alive = alivePlayers(s);
  if (alive.length === 1) {
    s.winner = alive[0]!;
    out.winner = s.winner;
    return;
  }
  autoAssign(s, out);
}

export function resolveShot(
  prev: RulesState,
  report: ShotReport,
): { state: RulesState; outcome: ShotOutcome } {
  if (prev.winner !== null) throw new Error('La partie est terminée');
  const s = clone(prev);
  const P = s.current;
  const player = s.players[P]!;
  const name = player.name;
  const wasBreak = s.isBreak;
  const onBlack = isOnBlack(s, P);
  const out: ShotOutcome = {
    foul: null,
    continues: false,
    assigned: [],
    eliminated: null,
    winner: null,
    respotBlack: false,
    removeGroups: [],
    ballInHand: false,
    messages: [],
  };

  let blackPotted = false;
  for (const k of report.potted) {
    if (k === 'black') blackPotted = true;
    else if (isGroup(k)) s.onTable[k] = Math.max(0, s.onTable[k] - 1);
  }

  // ---- Fautes
  let foul: string | null = null;
  const fc = report.firstContact;
  if (report.cuePotted) foul = 'la blanche est tombée';
  else if (fc === null) foul = 'aucune bille touchée';
  else if (!wasBreak) {
    if (onBlack) {
      if (fc !== 'black') foul = 'il fallait toucher la noire en premier';
    } else if (player.group) {
      if (fc !== player.group) foul = `il fallait toucher une ${GROUP_LABEL[player.group].one} en premier`;
    } else if (fc === 'black') {
      foul = 'la noire ne se touche pas en premier';
    } else if (isGroup(fc)) {
      const owner = ownerOf(prev, fc);
      if (owner !== null && owner !== P) foul = `les ${GROUP_LABEL[fc].many} sont à ${prev.players[owner]!.name}`;
    }
  }
  if (!foul && !wasBreak) {
    for (const k of report.potted) {
      if (!isGroup(k)) continue;
      const owner = ownerOf(prev, k);
      if (owner !== null && owner !== P) {
        foul = `${GROUP_LABEL[k].one} empochée (couleur de ${prev.players[owner]!.name})`;
        break;
      }
    }
  }
  out.foul = foul;
  s.isBreak = false;

  // ---- La noire
  if (blackPotted) {
    if (wasBreak) {
      out.respotBlack = true;
      out.messages.push('Noire empochée à la casse : elle est replacée');
    } else if (onBlack && !foul) {
      s.winner = P;
      out.winner = P;
      out.messages.push(`${name} empoche la noire et gagne !`);
      return { state: s, outcome: out };
    } else {
      const why = onBlack ? `faute sur la noire (${foul})` : 'noire empochée trop tôt';
      if (alivePlayers(s).length <= 2) {
        const other = nextAlive(s, P);
        s.winner = other;
        out.winner = other;
        out.messages.push(`${name} perd : ${why}. ${s.players[other]!.name} gagne !`);
        return { state: s, outcome: out };
      }
      out.messages.push(`${name} est éliminé·e : ${why}`);
      out.respotBlack = true;
      eliminate(s, P, out);
      if (s.winner !== null) {
        out.messages.push(`${s.players[s.winner]!.name} gagne !`);
        return { state: s, outcome: out };
      }
      s.current = nextAlive(s, P);
      s.visits = 2;
      out.ballInHand = report.cuePotted;
      out.messages.push(`${s.players[s.current]!.name} a deux coups`);
      return { state: s, outcome: out };
    }
  }

  // ---- Attribution des couleurs (table ouverte, coup valable)
  if (!foul && !wasBreak && player.group === null) {
    const first = report.potted.find((k): k is Group => isGroup(k) && ownerOf(s, k) === null);
    if (first) {
      player.group = first;
      out.assigned.push({ player: P, group: first });
      out.messages.push(`${name} joue les ${GROUP_LABEL[first].many}`);
      autoAssign(s, out);
    }
  }

  // ---- Suite du jeu
  if (foul) {
    s.current = nextAlive(s, P);
    s.visits = 2;
    out.ballInHand = report.cuePotted;
    out.messages.unshift(`Faute de ${name} : ${foul}`);
    out.messages.push(`${s.players[s.current]!.name} a deux coups`);
    return { state: s, outcome: out };
  }

  const g = player.group;
  const scored = wasBreak
    ? report.potted.some((k) => isGroup(k))
    : g !== null && report.potted.includes(g);

  if (scored) {
    out.continues = true;
    out.messages.push(isOnBlack(s, P) ? `${name} joue la noire` : `${name} rejoue`);
    return { state: s, outcome: out };
  }

  s.visits -= 1;
  if (s.visits >= 1) {
    out.continues = true;
    out.messages.push(`${name} joue son deuxième coup`);
  } else {
    s.current = nextAlive(s, P);
    s.visits = 1;
    out.messages.push(`À ${s.players[s.current]!.name} de jouer`);
  }
  return { state: s, outcome: out };
}
