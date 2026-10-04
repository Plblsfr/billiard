import {
  BALL_R,
  BALL_RESTITUTION,
  CUSHION_RESTITUTION,
  LINEAR_DAMPING,
  PHYSICS_DT,
  ROLL_DECEL,
  SPIN_DECAY,
  SPIN_FACTOR,
  STOP_SPEED,
  TABLE_H,
  TABLE_W,
} from './constants.js';
import { CUSHIONS, POCKETS, closestOnSegment, type Vec } from './table.js';
import type { Ball, BallKind } from './types.js';

export type PhysicsEvent =
  | { type: 'ball'; a: number; b: number; speed: number }
  | { type: 'cushion'; a: number; speed: number }
  | { type: 'pocket'; a: number; pocket: number };

const TWO_R = BALL_R * 2;
/** Au-delà de cette distance hors de la table, une bille est forcément dans une poche. */
const ESCAPE = 70;

export class World {
  balls: Ball[];
  /** Bille touchée en premier par la blanche pendant le coup en cours. */
  firstContact: BallKind | null = null;
  /** Billes empochées pendant le coup en cours, dans l'ordre. */
  potted: Ball[] = [];
  /** Événements depuis le dernier drainEvents() (sons, statistiques). */
  private events: PhysicsEvent[] = [];
  private spin = 0;
  private spinDir: Vec = { x: 0, y: 0 };
  private accumulator = 0;

  constructor(balls: Ball[]) {
    this.balls = balls;
  }

  get cue(): Ball {
    const cue = this.balls.find((b) => b.kind === 'cue');
    if (!cue) throw new Error('Blanche absente');
    return cue;
  }

  /**
   * Frappe la blanche.
   * @param angle direction en radians
   * @param speed vitesse initiale (mm/s)
   * @param spin effet de -1 (rétro) à 1 (coulé)
   */
  strike(angle: number, speed: number, spin: number): void {
    const cue = this.cue;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    cue.vx = dx * speed;
    cue.vy = dy * speed;
    this.spin = Math.max(-1, Math.min(1, spin)) * speed * SPIN_FACTOR;
    this.spinDir = { x: dx, y: dy };
    this.firstContact = null;
    this.potted = [];
    this.accumulator = 0;
  }

  isMoving(): boolean {
    return this.balls.some((b) => b.onTable && (b.vx !== 0 || b.vy !== 0));
  }

  drainEvents(): PhysicsEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  /** Avance la simulation d'une durée réelle (s) par pas fixes. */
  advance(seconds: number): void {
    this.accumulator += Math.min(seconds, 0.1);
    while (this.accumulator >= PHYSICS_DT) {
      this.step(PHYSICS_DT);
      this.accumulator -= PHYSICS_DT;
    }
  }

  /** Simule jusqu'à l'arrêt complet (tests, IA). Renvoie la durée simulée. */
  settle(maxSeconds = 60): number {
    let t = 0;
    while (this.isMoving() && t < maxSeconds) {
      this.step(PHYSICS_DT);
      t += PHYSICS_DT;
    }
    return t;
  }

  step(dt: number): void {
    const balls = this.balls;

    for (const b of balls) {
      if (!b.onTable || (b.vx === 0 && b.vy === 0)) continue;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      const s = Math.hypot(b.vx, b.vy);
      let ns = Math.max(0, s - ROLL_DECEL * dt) * (1 - LINEAR_DAMPING * dt);
      if (ns < STOP_SPEED) ns = 0;
      const k = s === 0 ? 0 : ns / s;
      b.vx *= k;
      b.vy *= k;
    }

    if (this.spin !== 0) this.spin *= Math.exp(-SPIN_DECAY * dt);

    // Collisions bille / bille
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i]!;
      if (!a.onTable) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const b = balls[j]!;
        if (!b.onTable) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        if (Math.abs(dx) >= TWO_R || Math.abs(dy) >= TWO_R) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 >= TWO_R * TWO_R) continue;
        this.collideBalls(a, b, dx, dy, Math.sqrt(d2));
      }
    }

    // Bandes et poches
    for (const b of balls) {
      if (!b.onTable) continue;
      for (const s of CUSHIONS) {
        const q = closestOnSegment(b, s);
        const dx = b.x - q.x;
        const dy = b.y - q.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= BALL_R * BALL_R) continue;
        const d = Math.sqrt(d2) || 1e-6;
        const nx = dx / d;
        const ny = dy / d;
        b.x = q.x + nx * BALL_R;
        b.y = q.y + ny * BALL_R;
        const vn = b.vx * nx + b.vy * ny;
        if (vn < 0) {
          b.vx -= (1 + CUSHION_RESTITUTION) * vn * nx;
          b.vy -= (1 + CUSHION_RESTITUTION) * vn * ny;
          // légère perte tangentielle due au frottement de la bande
          const tx = -ny;
          const ty = nx;
          const vt = b.vx * tx + b.vy * ty;
          b.vx -= vt * 0.06 * tx;
          b.vy -= vt * 0.06 * ty;
          this.events.push({ type: 'cushion', a: b.id, speed: -vn });
          if (b.kind === 'cue' && this.firstContact === null) this.spin *= 0.5;
        }
      }
      this.checkPocket(b);
    }
  }

  private collideBalls(a: Ball, b: Ball, dx: number, dy: number, d: number): void {
    const dist = d || 1e-6;
    const nx = dx / dist;
    const ny = dy / dist;
    const overlap = TWO_R - dist;
    a.x -= (nx * overlap) / 2;
    a.y -= (ny * overlap) / 2;
    b.x += (nx * overlap) / 2;
    b.y += (ny * overlap) / 2;
    const vrel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
    if (vrel <= 0) return;
    const j = ((1 + BALL_RESTITUTION) / 2) * vrel;
    a.vx -= j * nx;
    a.vy -= j * ny;
    b.vx += j * nx;
    b.vy += j * ny;
    this.events.push({ type: 'ball', a: a.id, b: b.id, speed: vrel });

    const cue = a.kind === 'cue' ? a : b.kind === 'cue' ? b : null;
    if (cue && this.firstContact === null) {
      this.firstContact = cue === a ? b.kind : a.kind;
      if (this.spin !== 0) {
        cue.vx += this.spinDir.x * this.spin;
        cue.vy += this.spinDir.y * this.spin;
        this.spin = 0;
      }
    }
  }

  private checkPocket(b: Ball): void {
    let pocketIndex = POCKETS.findIndex((p) => Math.hypot(b.x - p.c.x, b.y - p.c.y) < p.r);
    if (
      pocketIndex < 0 &&
      (b.x < -ESCAPE || b.x > TABLE_W + ESCAPE || b.y < -ESCAPE || b.y > TABLE_H + ESCAPE)
    ) {
      // filet de sécurité numérique : poche la plus proche
      let best = Infinity;
      POCKETS.forEach((p, i) => {
        const d = Math.hypot(b.x - p.c.x, b.y - p.c.y);
        if (d < best) {
          best = d;
          pocketIndex = i;
        }
      });
    }
    if (pocketIndex < 0) return;
    const p = POCKETS[pocketIndex]!;
    b.onTable = false;
    b.vx = 0;
    b.vy = 0;
    b.x = p.c.x;
    b.y = p.c.y;
    this.potted.push(b);
    this.events.push({ type: 'pocket', a: b.id, pocket: pocketIndex });
  }
}

export interface AimTrace {
  /** Position de la blanche au contact (bille fantôme) ou à la bande. */
  ghost: Vec;
  /** Bille visée, si la trajectoire en rencontre une. */
  target: Ball | null;
  /** Direction prise par la bille visée après le choc. */
  targetDir: Vec | null;
  /** Direction approximative de la blanche après le choc. */
  cueDir: Vec | null;
}

/** Trace la ligne de visée depuis la blanche dans la direction donnée. */
export function traceAim(balls: readonly Ball[], from: Vec, angle: number): AimTrace {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let bestT = Infinity;
  let target: Ball | null = null;

  for (const b of balls) {
    if (!b.onTable || b.kind === 'cue') continue;
    // intersection du rayon avec un cercle de rayon 2R autour de la bille
    const ox = from.x - b.x;
    const oy = from.y - b.y;
    const bq = ox * dx + oy * dy;
    const c = ox * ox + oy * oy - TWO_R * TWO_R;
    const disc = bq * bq - c;
    if (disc < 0) continue;
    const t = -bq - Math.sqrt(disc);
    if (t > 0 && t < bestT) {
      bestT = t;
      target = b;
    }
  }

  // bandes (rectangle réduit du rayon)
  const lim = (p: number, v: number, lo: number, hi: number): number => {
    if (v > 0) return (hi - p) / v;
    if (v < 0) return (lo - p) / v;
    return Infinity;
  };
  const tWall = Math.min(
    lim(from.x, dx, BALL_R, TABLE_W - BALL_R),
    lim(from.y, dy, BALL_R, TABLE_H - BALL_R),
  );
  if (tWall < bestT) {
    return {
      ghost: { x: from.x + dx * tWall, y: from.y + dy * tWall },
      target: null,
      targetDir: null,
      cueDir: null,
    };
  }

  const ghost = { x: from.x + dx * bestT, y: from.y + dy * bestT };
  if (!target) return { ghost, target: null, targetDir: null, cueDir: null };
  const nx = (target.x - ghost.x) / TWO_R;
  const ny = (target.y - ghost.y) / TWO_R;
  // la blanche part perpendiculairement à la ligne des centres
  const dot = dx * nx + dy * ny;
  // (longueur = part de la vitesse conservée par la blanche)
  const cx = dx - dot * nx;
  const cy = dy - dot * ny;
  const cl = Math.hypot(cx, cy);
  return {
    ghost,
    target,
    targetDir: { x: nx * dot, y: ny * dot },
    cueDir: cl > 1e-3 ? { x: cx, y: cy } : null,
  };
}
