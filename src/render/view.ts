import { TABLE_H, TABLE_W } from '../game/constants.js';
import type { Vec } from '../game/table.js';

/** Marge autour de la surface de jeu (bandes + cadre), en mm. */
export const FRAME = 84;

const MIN_X = -FRAME;
const MIN_Y = -FRAME;
const MAX_X = TABLE_W + FRAME;
const MAX_Y = TABLE_H + FRAME;
const WORLD_W = MAX_X - MIN_X;
const WORLD_H = MAX_Y - MIN_Y;

/**
 * Passage monde (mm) ↔ écran (pixels CSS). En format portrait la table est
 * tournée d'un quart de tour, zone de baulk en bas.
 */
export class View {
  rotated = false;
  scale = 1;
  /** Matrice monde → écran : sx = a·x + c·y + e ; sy = b·x + d·y + f */
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;
  width = 0;
  height = 0;

  fit(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.rotated = height > width * 1.15;
    const ww = this.rotated ? WORLD_H : WORLD_W;
    const wh = this.rotated ? WORLD_W : WORLD_H;
    const s = Math.min(width / ww, height / wh);
    this.scale = s;
    const offX = (width - ww * s) / 2;
    const offY = (height - wh * s) / 2;
    if (this.rotated) {
      this.a = 0;
      this.c = s;
      this.e = offX - s * MIN_Y;
      this.b = -s;
      this.d = 0;
      this.f = offY + s * MAX_X;
    } else {
      this.a = s;
      this.c = 0;
      this.e = offX - s * MIN_X;
      this.b = 0;
      this.d = s;
      this.f = offY - s * MIN_Y;
    }
  }

  toWorld(sx: number, sy: number): Vec {
    if (this.rotated) return { x: (this.f - sy) / this.scale, y: (sx - this.e) / this.scale };
    return { x: (sx - this.e) / this.scale, y: (sy - this.f) / this.scale };
  }

  /** Convertit une direction écran en direction monde (vecteur unitaire). */
  screenDirToWorld(dx: number, dy: number): Vec {
    return this.rotated ? { x: -dy, y: dx } : { x: dx, y: dy };
  }

  apply(ctx: CanvasRenderingContext2D, dpr: number): void {
    ctx.setTransform(this.a * dpr, this.b * dpr, this.c * dpr, this.d * dpr, this.e * dpr, this.f * dpr);
  }
}
