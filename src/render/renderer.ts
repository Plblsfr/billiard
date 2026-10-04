import { BALL_R, BAULK_X, BLACK_SPOT, FOOT_SPOT, TABLE_H, TABLE_W } from '../game/constants.js';
import type { Match } from '../game/match.js';
import { traceAim } from '../game/physics.js';
import { legalTargets } from '../game/rules.js';
import { POCKETS, POCKET_THROATS, type Vec } from '../game/table.js';
import type { Ball, BallKind } from '../game/types.js';
import { FRAME, View } from './view.js';

export const BALL_COLORS: Record<BallKind, { base: string; dark: string }> = {
  cue: { base: '#f6f1e7', dark: '#bdb4a3' },
  black: { base: '#1c1c1c', dark: '#000000' },
  red: { base: '#d1342f', dark: '#7d1513' },
  yellow: { base: '#f0bd24', dark: '#9a6c00' },
  blue: { base: '#2f63d6', dark: '#13306f' },
};

const FELT = '#2c6b52';
const FELT_LIGHT = '#35795e';
const CUSHION = '#235843';
const RAIL = '#101010';
const ROSE = '#f4c7d5';
const ROSE_DARK = '#c8607f';
const CREME = '#faf6f3';

export interface AimState {
  angle: number;
  /** Puissance armée (0 à 1) : recul de la queue. */
  power: number;
  /** La blanche peut-elle être posée à sa position actuelle ? */
  placeValid: boolean;
}

export class Renderer {
  readonly view = new View();
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private feltPattern: CanvasPattern | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Canvas 2D indisponible');
    this.ctx = ctx;
    this.feltPattern = this.makeFeltPattern();
  }

  resize(width: number, height: number): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.view.fit(width, height);
  }

  /** Léger grain du tapis. */
  private makeFeltPattern(): CanvasPattern | null {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    if (!g) return null;
    const img = g.createImageData(64, 64);
    let seed = 7;
    for (let i = 0; i < img.data.length; i += 4) {
      seed = (seed * 16807) % 2147483647;
      const v = seed % 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 9;
    }
    g.putImageData(img, 0, 0);
    return this.ctx.createPattern(c, 'repeat');
  }

  draw(m: Match, aim: AimState): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.view.apply(ctx, this.dpr);

    this.drawTable();

    if (m.phase === 'placing') this.drawBaulkZone();

    const balls = m.world.balls.filter((b) => b.onTable);
    const light = this.view.screenDirToWorld(-0.38, -0.42);
    for (const b of balls) this.drawShadow(b, light);

    if (m.phase === 'aiming' && !m.rules.isBreak) {
      const targets = legalTargets(m.rules, m.rules.current);
      for (const b of balls) if (b.kind !== 'cue' && targets.includes(b.kind)) this.drawHalo(b);
    }

    for (const b of balls) {
      const ghost = m.phase === 'placing' && b.kind === 'cue';
      this.drawBall(b, light, ghost ? 0.85 : 1);
    }

    if (m.phase === 'placing') this.drawPlacementRing(m.cue, aim.placeValid);
    if (m.phase === 'aiming') {
      this.drawAim(m, aim.angle);
      this.drawCueStick(m.cue, aim.angle, aim.power);
    }
  }

  private drawTable(): void {
    const ctx = this.ctx;
    const W = TABLE_W;
    const H = TABLE_H;

    // cadre
    ctx.fillStyle = RAIL;
    roundRect(ctx, -FRAME, -FRAME, W + FRAME * 2, H + FRAME * 2, 34);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 3;
    roundRect(ctx, -FRAME + 6, -FRAME + 6, W + FRAME * 2 - 12, H + FRAME * 2 - 12, 30);
    ctx.stroke();

    // mouches (repères) sur le cadre
    ctx.fillStyle = CREME;
    const sightOff = FRAME - 22;
    for (let i = 1; i < 8; i++) {
      if (i === 4) continue;
      const x = (W * i) / 8;
      diamond(ctx, x, -sightOff, 6);
      diamond(ctx, x, H + sightOff, 6);
    }
    for (let i = 1; i < 4; i++) {
      const y = (H * i) / 4;
      diamond(ctx, -sightOff, y, 6);
      diamond(ctx, W + sightOff, y, 6);
    }

    // bandes
    ctx.fillStyle = CUSHION;
    ctx.fillRect(-40, -40, W + 80, H + 80);

    // tapis + gorges des poches
    const grad = ctx.createRadialGradient(W / 2, H / 2, 80, W / 2, H / 2, W * 0.62);
    grad.addColorStop(0, FELT_LIGHT);
    grad.addColorStop(1, FELT);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    for (const poly of POCKET_THROATS) {
      ctx.beginPath();
      poly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.fill();
    }
    if (this.feltPattern) {
      ctx.save();
      ctx.fillStyle = this.feltPattern;
      ctx.globalCompositeOperation = 'overlay';
      ctx.fillRect(-40, -40, W + 80, H + 80);
      ctx.restore();
    }

    // ombre du nez de bande
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.lineWidth = 5;
    ctx.strokeRect(2.5, 2.5, W - 5, H - 5);

    // poches
    for (const p of POCKETS) {
      const g = ctx.createRadialGradient(p.c.x, p.c.y, 4, p.c.x, p.c.y, p.hole);
      g.addColorStop(0, '#000');
      g.addColorStop(0.75, '#050505');
      g.addColorStop(1, '#1a1a1a');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.c.x, p.c.y, p.hole, 0, Math.PI * 2);
      ctx.fill();
    }

    // ligne de baulk et points
    ctx.strokeStyle = 'rgba(255,255,255,0.32)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(BAULK_X, 0);
    ctx.lineTo(BAULK_X, H);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    for (const s of [BLACK_SPOT, FOOT_SPOT, { x: W / 2, y: H / 2 }]) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawBaulkZone(): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(244,199,213,0.10)';
    ctx.fillRect(0, 0, BAULK_X, TABLE_H);
  }

  private drawShadow(b: Ball, light: Vec): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.arc(b.x - light.x * 7, b.y - light.y * 7, BALL_R * 1.02, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawHalo(b: Ball): void {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255,255,255,0.42)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_R + 7, 0, Math.PI * 2);
    ctx.stroke();
  }

  private drawBall(b: Ball, light: Vec, alpha: number): void {
    const ctx = this.ctx;
    const col = BALL_COLORS[b.kind];
    ctx.save();
    ctx.globalAlpha = alpha;
    const hx = b.x + light.x * BALL_R * 0.42;
    const hy = b.y + light.y * BALL_R * 0.42;
    const g = ctx.createRadialGradient(hx, hy, BALL_R * 0.08, b.x, b.y, BALL_R * 1.05);
    g.addColorStop(0, b.kind === 'black' ? '#6a6a6a' : '#ffffff');
    g.addColorStop(0.18, col.base);
    g.addColorStop(0.82, col.base);
    g.addColorStop(1, col.dark);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_R, 0, Math.PI * 2);
    ctx.fill();
    // reflet
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.arc(b.x + light.x * BALL_R * 0.5, b.y + light.y * BALL_R * 0.5, BALL_R * 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawPlacementRing(cue: Ball, valid: boolean): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.setLineDash([10, 8]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = valid ? CREME : ROSE_DARK;
    ctx.beginPath();
    ctx.arc(cue.x, cue.y, BALL_R + 9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawAim(m: Match, angle: number): void {
    const ctx = this.ctx;
    const cue = m.cue;
    const t = traceAim(m.world.balls, cue, angle);
    const legal = legalTargets(m.rules, m.rules.current);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([14, 12]);
    ctx.beginPath();
    ctx.moveTo(cue.x + Math.cos(angle) * BALL_R, cue.y + Math.sin(angle) * BALL_R);
    ctx.lineTo(t.ghost.x, t.ghost.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // bille fantôme
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.beginPath();
    ctx.arc(t.ghost.x, t.ghost.y, BALL_R, 0, Math.PI * 2);
    ctx.stroke();

    if (t.target && t.targetDir) {
      const ok = legal.includes(t.target.kind);
      const len = 90 + 260 * Math.hypot(t.targetDir.x, t.targetDir.y);
      const n = Math.hypot(t.targetDir.x, t.targetDir.y) || 1;
      ctx.strokeStyle = ok ? 'rgba(255,255,255,0.85)' : ROSE;
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(t.target.x, t.target.y);
      ctx.lineTo(t.target.x + (t.targetDir.x / n) * len, t.target.y + (t.targetDir.y / n) * len);
      ctx.stroke();
      if (!ok) {
        // croix sur une bille interdite
        ctx.lineWidth = 4;
        const r = BALL_R * 0.55;
        ctx.beginPath();
        ctx.moveTo(t.target.x - r, t.target.y - r);
        ctx.lineTo(t.target.x + r, t.target.y + r);
        ctx.moveTo(t.target.x + r, t.target.y - r);
        ctx.lineTo(t.target.x - r, t.target.y + r);
        ctx.stroke();
      }
      if (t.cueDir) {
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 8]);
        const cl = 50 + 200 * Math.hypot(t.cueDir.x, t.cueDir.y);
        const cn = Math.hypot(t.cueDir.x, t.cueDir.y) || 1;
        ctx.beginPath();
        ctx.moveTo(t.ghost.x, t.ghost.y);
        ctx.lineTo(t.ghost.x + (t.cueDir.x / cn) * cl, t.ghost.y + (t.cueDir.y / cn) * cl);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawCueStick(cue: Ball, angle: number, power: number): void {
    const ctx = this.ctx;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const gap = BALL_R + 10 + power * 200;
    const len = 1350;
    ctx.save();
    ctx.translate(cue.x - dx * gap, cue.y - dy * gap);
    ctx.rotate(angle + Math.PI);
    // ombre
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    taper(ctx, 10, 9, len, 6.5, 14);
    // fût
    const g = ctx.createLinearGradient(0, -14, 0, 14);
    g.addColorStop(0, '#f0dcb4');
    g.addColorStop(0.5, '#d8b583');
    g.addColorStop(1, '#a98454');
    ctx.fillStyle = g;
    taper(ctx, 0, 0, len, 6, 13);
    // virole et procédé
    ctx.fillStyle = CREME;
    taper(ctx, 0, 0, 22, 6, 6.2);
    ctx.fillStyle = '#4a7bd0';
    taper(ctx, 0, 0, 5, 5.6, 5.8);
    // talon noir et bague rose
    ctx.fillStyle = RAIL;
    ctx.beginPath();
    ctx.moveTo(len * 0.62, -10.5);
    ctx.lineTo(len, -13);
    ctx.lineTo(len, 13);
    ctx.lineTo(len * 0.62, 10.5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = ROSE;
    ctx.fillRect(len * 0.62 - 14, -10.6, 14, 21.2);
    ctx.restore();
  }
}

function taper(ctx: CanvasRenderingContext2D, x: number, y: number, len: number, w0: number, w1: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - w0);
  ctx.lineTo(x + len, y - w1);
  ctx.lineTo(x + len, y + w1);
  ctx.lineTo(x, y + w0);
  ctx.closePath();
  ctx.fill();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fill();
}
