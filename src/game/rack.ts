import { BALL_R, BAULK_X, FOOT_SPOT, ROW_DX, TABLE_H } from './constants.js';
import { GROUP_ORDER, type Ball, type BallKind, type Group } from './types.js';

export type Random = () => number;

/** Disposition classique du blackball : A et B sont les deux couleurs, K la noire. */
const PATTERN_2P = ['A', 'BA', 'AKB', 'BABA', 'BABBA'];

function shuffle<T>(items: T[], rnd: Random): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function groupsFor(playerCount: 2 | 3): Group[] {
  return GROUP_ORDER.slice(0, playerCount);
}

/** Nombre de billes par couleur : 7 à deux joueurs, 4 à trois joueurs. */
export function ballsPerGroup(playerCount: 2 | 3): number {
  return playerCount === 2 ? 7 : 4;
}

export function cueStart(): { x: number; y: number } {
  return { x: BAULK_X * 0.55, y: TABLE_H / 2 };
}

/**
 * Prépare le triangle.
 * - 2 joueurs : 15 billes (7 rouges, 7 jaunes, la noire au centre de la 3e rangée).
 * - 3 joueurs : 13 billes (4 rouges, 4 jaunes, 4 bleues et la noire),
 *   le triangle complet sans ses deux coins arrière.
 */
export function rack(playerCount: 2 | 3, rnd: Random = Math.random): Ball[] {
  const balls: Ball[] = [];
  let id = 0;
  const start = cueStart();
  balls.push({ id: id++, kind: 'cue', x: start.x, y: start.y, vx: 0, vy: 0, onTable: true });

  const spacing = BALL_R * 2 + 0.05;
  const place = (row: number, k: number, kind: BallKind): void => {
    balls.push({
      id: id++,
      kind,
      x: FOOT_SPOT.x + row * ROW_DX,
      y: FOOT_SPOT.y + (k - row / 2) * spacing,
      vx: 0,
      vy: 0,
      onTable: true,
    });
  };

  if (playerCount === 2) {
    const [a, b] = rnd() < 0.5 ? (['red', 'yellow'] as const) : (['yellow', 'red'] as const);
    PATTERN_2P.forEach((row, r) => {
      [...row].forEach((ch, k) => place(r, k, ch === 'K' ? 'black' : ch === 'A' ? a : b));
    });
    return balls;
  }

  const colours = shuffle(
    groupsFor(3).flatMap((g) => Array<Group>(ballsPerGroup(3)).fill(g)),
    rnd,
  );
  for (let r = 0; r < 5; r++) {
    for (let k = 0; k <= r; k++) {
      if (r === 4 && (k === 0 || k === 4)) continue; // coins arrière retirés
      if (r === 2 && k === 1) {
        place(r, k, 'black');
        continue;
      }
      place(r, k, colours.pop()!);
    }
  }
  return balls;
}
