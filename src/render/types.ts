import { BALL_R } from '../game/constants.js';
import type { Match } from '../game/match.js';
import type { PhysicsEvent } from '../game/physics.js';
import type { Vec } from '../game/table.js';

export interface AimState {
  angle: number;
  /** Puissance armée (0 à 1) : recul de la queue. */
  power: number;
  /** La blanche peut-elle être posée à sa position actuelle ? */
  placeValid: boolean;
  /** Visée réaliste : seulement la direction de la blanche, sans bille fantôme ni trajectoires. */
  realistic?: boolean;
}

/** Passage écran → table, utilisé par les commandes (pointeur, clavier). */
export interface TableView {
  /** Point de la table (mm) sous le pixel CSS (sx, sy) du canevas. */
  toWorld(sx: number, sy: number): Vec;
  /** Direction écran (flèches du clavier) en direction sur la table. */
  screenDirToWorld(dx: number, dy: number): Vec;
}

/** Ce que le jeu attend d'un rendu de table, en 2D comme en 3D. */
export interface TableRenderer {
  readonly view: TableView;
  resize(width: number, height: number): void;
  /** Efface les animations en cours (nouvelle partie, replay). */
  reset(): void;
  event(e: PhysicsEvent, now?: number): void;
  /** Lance l'animation de la queue ; renvoie le délai avant le contact (ms). */
  shot(cue: Vec, angle: number, power: number, now?: number): number;
  draw(m: Match, aim: AimState, now?: number): void;
}

// ---------- coup de queue (identique en 2D et en 3D) ----------

/** Accompagnement de la queue après le contact (ms). */
export const FOLLOW_MS = 320;

/** Recul de la queue (mm entre sa pointe et le centre de la blanche) pour une puissance armée. */
export function cueGap(power: number): number {
  return BALL_R + 10 + power * 200;
}

/** Délai entre le relâchement et le contact : plus le coup est fort, plus la poussée est rapide. */
export function strikeLead(power: number): number {
  return Math.round(110 - 60 * Math.min(1, Math.max(0, power)));
}

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/**
 * Position de la queue ms millisecondes après le relâchement : poussée qui accélère jusqu'à
 * la blanche, accompagnement, puis la queue s'efface. Null quand l'animation est finie.
 */
export function strikePose(ms: number, startGap: number, lead: number): { gap: number; alpha: number } | null {
  if (ms >= lead + FOLLOW_MS) return null;
  const t0 = Math.max(0, ms);
  const contact = BALL_R + 1;
  if (t0 < lead) return { gap: startGap + (contact - startGap) * Math.pow(t0 / lead, 2), alpha: 1 };
  const t = (t0 - lead) / FOLLOW_MS;
  return { gap: contact - 46 * easeOutCubic(t), alpha: 1 - Math.min(1, Math.max(0, (t - 0.3) / 0.7)) };
}
