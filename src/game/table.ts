import { BALL_R, TABLE_H, TABLE_W } from './constants.js';

export interface Vec {
  x: number;
  y: number;
}

export interface Segment {
  a: Vec;
  b: Vec;
}

export interface Pocket {
  /** Centre de la zone de capture. */
  c: Vec;
  /** Rayon de capture : une bille dont le centre entre dans ce cercle tombe. */
  r: number;
  /** Rayon visuel du trou. */
  hole: number;
  kind: 'corner' | 'middle';
}

/** Demi-ouverture des poches de coin, mesurée sur chaque bande. */
const CORNER_C = 78;
/** Longueur des mâchoires des poches de coin (à 45°). */
const CORNER_JAW = 45;
/** Demi-ouverture des poches du milieu. */
const MIDDLE_HALF = 58;
const MIDDLE_JAW_DEPTH = 40;
const MIDDLE_JAW_TAPER = 8;

const W = TABLE_W;
const H = TABLE_H;
const MID = W / 2;

function seg(ax: number, ay: number, bx: number, by: number): Segment {
  return { a: { x: ax, y: ay }, b: { x: bx, y: by } };
}

/** Nez de bande et mâchoires des poches. */
export const CUSHIONS: readonly Segment[] = [
  // bandes longues (haut et bas), coupées par les poches du milieu
  seg(CORNER_C, 0, MID - MIDDLE_HALF, 0),
  seg(MID + MIDDLE_HALF, 0, W - CORNER_C, 0),
  seg(CORNER_C, H, MID - MIDDLE_HALF, H),
  seg(MID + MIDDLE_HALF, H, W - CORNER_C, H),
  // bandes courtes
  seg(0, CORNER_C, 0, H - CORNER_C),
  seg(W, CORNER_C, W, H - CORNER_C),
  // mâchoires des coins
  seg(CORNER_C, 0, CORNER_C - CORNER_JAW, -CORNER_JAW),
  seg(0, CORNER_C, -CORNER_JAW, CORNER_C - CORNER_JAW),
  seg(W - CORNER_C, 0, W - CORNER_C + CORNER_JAW, -CORNER_JAW),
  seg(W, CORNER_C, W + CORNER_JAW, CORNER_C - CORNER_JAW),
  seg(CORNER_C, H, CORNER_C - CORNER_JAW, H + CORNER_JAW),
  seg(0, H - CORNER_C, -CORNER_JAW, H - CORNER_C + CORNER_JAW),
  seg(W - CORNER_C, H, W - CORNER_C + CORNER_JAW, H + CORNER_JAW),
  seg(W, H - CORNER_C, W + CORNER_JAW, H - CORNER_C + CORNER_JAW),
  // mâchoires du milieu
  seg(MID - MIDDLE_HALF, 0, MID - MIDDLE_HALF + MIDDLE_JAW_TAPER, -MIDDLE_JAW_DEPTH),
  seg(MID + MIDDLE_HALF, 0, MID + MIDDLE_HALF - MIDDLE_JAW_TAPER, -MIDDLE_JAW_DEPTH),
  seg(MID - MIDDLE_HALF, H, MID - MIDDLE_HALF + MIDDLE_JAW_TAPER, H + MIDDLE_JAW_DEPTH),
  seg(MID + MIDDLE_HALF, H, MID + MIDDLE_HALF - MIDDLE_JAW_TAPER, H + MIDDLE_JAW_DEPTH),
];

const CORNER_OFF = 14;
const CORNER_R = 50;
const MIDDLE_OFF = 24;
const MIDDLE_R = 46;

export const POCKETS: readonly Pocket[] = [
  { c: { x: -CORNER_OFF, y: -CORNER_OFF }, r: CORNER_R, hole: 56, kind: 'corner' },
  { c: { x: MID, y: -MIDDLE_OFF }, r: MIDDLE_R, hole: 52, kind: 'middle' },
  { c: { x: W + CORNER_OFF, y: -CORNER_OFF }, r: CORNER_R, hole: 56, kind: 'corner' },
  { c: { x: -CORNER_OFF, y: H + CORNER_OFF }, r: CORNER_R, hole: 56, kind: 'corner' },
  { c: { x: MID, y: H + MIDDLE_OFF }, r: MIDDLE_R, hole: 52, kind: 'middle' },
  { c: { x: W + CORNER_OFF, y: H + CORNER_OFF }, r: CORNER_R, hole: 56, kind: 'corner' },
];

/** Gorges des poches (zone entre les mâchoires), pour l'affichage. */
export const POCKET_THROATS: readonly Vec[][] = (() => {
  const c = CORNER_C;
  const j = CORNER_JAW;
  const corner = (sx: number, sy: number, ox: number, oy: number): Vec[] =>
    [
      [c, 0],
      [c - j, -j],
      [-j, c - j],
      [0, c],
      [0, 0],
    ].map(([x, y]) => ({ x: ox + sx * x!, y: oy + sy * y! }));
  const middle = (sy: number, oy: number): Vec[] =>
    [
      [-MIDDLE_HALF, 0],
      [-MIDDLE_HALF + MIDDLE_JAW_TAPER, -MIDDLE_JAW_DEPTH],
      [MIDDLE_HALF - MIDDLE_JAW_TAPER, -MIDDLE_JAW_DEPTH],
      [MIDDLE_HALF, 0],
    ].map(([x, y]) => ({ x: MID + x!, y: oy + sy * y! }));
  return [
    corner(1, 1, 0, 0),
    corner(-1, 1, W, 0),
    corner(1, -1, 0, H),
    corner(-1, -1, W, H),
    middle(1, 0),
    middle(-1, H),
  ];
})();

/** Point du segment le plus proche de p. */
export function closestOnSegment(p: Vec, s: Segment): Vec {
  const dx = s.b.x - s.a.x;
  const dy = s.b.y - s.a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { x: s.a.x + t * dx, y: s.a.y + t * dy };
}

/** Vrai si une bille posée en p tomberait immédiatement dans une poche. */
export function inPocketZone(p: Vec, margin = 0): boolean {
  return POCKETS.some((pk) => Math.hypot(p.x - pk.c.x, p.y - pk.c.y) < pk.r + margin);
}

/** Vrai si le centre d'une bille est dans la surface de jeu (bandes comprises). */
export function insidePlayArea(p: Vec): boolean {
  return p.x >= BALL_R && p.x <= TABLE_W - BALL_R && p.y >= BALL_R && p.y <= TABLE_H - BALL_R;
}
