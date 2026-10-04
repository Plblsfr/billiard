/**
 * Dimensions d'une table de billard anglais 7 pieds (unités : millimètres).
 * L'axe x suit la longueur de la table (zone de baulk à gauche, triangle à droite),
 * l'axe y la largeur.
 */
export const TABLE_W = 1830;
export const TABLE_H = 915;

/** Rayon des billes (2 pouces de diamètre). */
export const BALL_R = 25.4;

/** Ligne de baulk : 1/5 de la longueur depuis la bande de départ. */
export const BAULK_X = TABLE_W / 5;

/** Point du triangle (pointe du rack). */
export const FOOT_SPOT = { x: (TABLE_W * 3) / 4, y: TABLE_H / 2 };

/** Écart entre deux rangées du triangle. */
export const ROW_DX = BALL_R * Math.sqrt(3) + 0.05;

/** Position de la noire dans le triangle : centre de la 3e rangée. */
export const BLACK_SPOT = { x: FOOT_SPOT.x + 2 * ROW_DX, y: TABLE_H / 2 };

/** Physique */
export const BALL_RESTITUTION = 0.95;
export const CUSHION_RESTITUTION = 0.78;
/** Décélération de roulement (mm/s²). */
export const ROLL_DECEL = 190;
/** Amortissement proportionnel à la vitesse (1/s). */
export const LINEAR_DAMPING = 0.22;
/** En dessous de cette vitesse (mm/s) une bille est considérée arrêtée. */
export const STOP_SPEED = 6;
/** Pas de simulation fixe (s). */
export const PHYSICS_DT = 1 / 960;

/** Vitesse de la blanche pour une puissance de 0 à 1. */
export const MIN_SHOT_SPEED = 120;
export const MAX_SHOT_SPEED = 5400;
export function shotSpeed(power: number): number {
  const p = Math.min(1, Math.max(0, power));
  return MIN_SHOT_SPEED + (MAX_SHOT_SPEED - MIN_SHOT_SPEED) * Math.pow(p, 1.5);
}

/** Effet (coulé / rétro) : part de la vitesse de tir rendue à la blanche à l'impact. */
export const SPIN_FACTOR = 0.62;
/** Décroissance de l'effet avec le temps (1/s). */
export const SPIN_DECAY = 0.85;
