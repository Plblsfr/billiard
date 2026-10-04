import { BALL_R, BAULK_X, BLACK_SPOT, FOOT_SPOT, TABLE_H, TABLE_W } from '../game/constants.js';
import type { Match } from '../game/match.js';
import { traceAim, type PhysicsEvent } from '../game/physics.js';
import { legalTargets } from '../game/rules.js';
import { POCKETS, POCKET_THROATS, type Vec } from '../game/table.js';
import type { Ball, BallKind } from '../game/types.js';
import { cueGap, strikeLead, strikePose, type AimState, type TableRenderer } from './types.js';
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

export type { AimState } from './types.js';

/** Bille en train de tomber dans une poche. */
interface Fall {
  kind: BallKind;
  from: Vec;
  to: Vec;
  pocket: number;
  t0: number;
}

/** Onde de couleur autour d'une poche quand une bille y tombe. */
interface Ripple {
  at: Vec;
  r: number;
  color: string;
  t0: number;
}

/** Coup de queue : la queue part frapper la blanche puis s'efface. */
interface Strike {
  from: Vec;
  angle: number;
  gap: number;
  t0: number;
  /** Durée de la poussée jusqu'au contact (ms). */
  lead: number;
}

/** Orientation d'une bille (matrice 3×3) pour voir la blanche rouler. */
interface Spin3 {
  m: number[];
  x: number;
  y: number;
}

const FALL_MS = 420;
const RIPPLE_MS = 560;
/** Pois rouges de la blanche (axes d'un octaèdre). */
const CUE_SPOTS: readonly [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));

export class Renderer implements TableRenderer {
  readonly view = new View();
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private feltPattern: CanvasPattern | null = null;
  private falls: Fall[] = [];
  private ripples: Ripple[] = [];
  private strike: Strike | null = null;
  private spins = new Map<number, Spin3>();

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

  /** Efface les animations en cours (nouvelle partie). */
  reset(): void {
    this.falls = [];
    this.ripples = [];
    this.strike = null;
    this.spins.clear();
  }

  /** Événement de la physique : une bille qui tombe lance son animation. */
  event(e: PhysicsEvent, now = performance.now()): void {
    if (e.type !== 'pocket') return;
    const p = POCKETS[e.pocket];
    if (!p) return;
    // la bille file vers le fond de la poche, dans le sens de sa course
    const speed = Math.hypot(e.vx, e.vy);
    const push = Math.min(p.hole * 0.35, speed * 0.012);
    const to = speed > 0 ? { x: p.c.x + (e.vx / speed) * push, y: p.c.y + (e.vy / speed) * push } : { ...p.c };
    this.falls.push({ kind: e.kind, from: { x: e.x, y: e.y }, to, pocket: e.pocket, t0: now });
    this.ripples.push({ at: { ...p.c }, r: p.hole, color: BALL_COLORS[e.kind].base, t0: now + FALL_MS * 0.55 });
  }

  /**
   * La queue part frapper la blanche. Renvoie le délai (ms) avant le contact :
   * c'est à ce moment qu'il faut lancer Match.shoot.
   */
  shot(cue: Vec, angle: number, power: number, now = performance.now()): number {
    const lead = strikeLead(power);
    this.strike = { from: { x: cue.x, y: cue.y }, angle, gap: cueGap(power), t0: now, lead };
    return lead;
  }

  /** Une queue est-elle en train de frapper ? */
  get striking(): boolean {
    return this.strike !== null;
  }

  draw(m: Match, aim: AimState, now = performance.now()): void {
    const ctx = this.ctx;
    this.updateSpins(m.world.balls);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.view.apply(ctx, this.dpr);

    this.drawTable();

    if (m.phase === 'placing') this.drawBaulkZone();

    const balls = m.world.balls.filter((b) => b.onTable);
    const light = this.view.screenDirToWorld(-0.38, -0.42);
    this.drawFalls(light, now);
    this.drawRipples(now);
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
    if (this.strike) this.drawStrike(now);
    else if (m.phase === 'aiming') {
      this.drawAim(m, aim.angle, aim.realistic === true);
      this.drawCueStick(m.cue, aim.angle, cueGap(aim.power));
    }
  }

  // ---------- animations ----------
  private drawFalls(light: Vec, now: number): void {
    const ctx = this.ctx;
    this.falls = this.falls.filter((f) => now - f.t0 < FALL_MS);
    for (const f of this.falls) {
      const t = clamp01((now - f.t0) / FALL_MS);
      const p = POCKETS[f.pocket]!;
      const k = easeOutCubic(t);
      const x = f.from.x + (f.to.x - f.from.x) * k;
      const y = f.from.y + (f.to.y - f.from.y) * k;
      const scale = 1 - 0.45 * t * t;
      ctx.save();
      // la lèvre de la poche se referme sur la bille à mesure qu'elle s'enfonce
      ctx.beginPath();
      ctx.arc(p.c.x, p.c.y, p.hole + BALL_R * 2.2 * (1 - k), 0, Math.PI * 2);
      ctx.clip();
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      ctx.translate(-x, -y);
      const ball: Ball = { id: -1, kind: f.kind, x, y, vx: 0, vy: 0, onTable: false };
      this.drawBall(ball, light, 1 - clamp01((t - 0.75) / 0.25));
      // plongée dans l'ombre du trou
      ctx.fillStyle = `rgba(0,0,0,${0.85 * Math.pow(t, 1.4)})`;
      ctx.beginPath();
      ctx.arc(x, y, BALL_R + 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  private drawRipples(now: number): void {
    const ctx = this.ctx;
    this.ripples = this.ripples.filter((r) => now - r.t0 < RIPPLE_MS);
    for (const r of this.ripples) {
      const t = (now - r.t0) / RIPPLE_MS;
      if (t < 0) continue;
      const k = easeOutCubic(t);
      ctx.save();
      ctx.globalAlpha = 0.75 * (1 - t);
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 6 * (1 - t) + 1.5;
      ctx.beginPath();
      ctx.arc(r.at.x, r.at.y, r.r + 8 + 46 * k, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.5 * (1 - t);
      ctx.strokeStyle = CREME;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(r.at.x, r.at.y, r.r + 4 + 24 * k, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawStrike(now: number): void {
    const s = this.strike;
    if (!s) return;
    const pose = strikePose(now - s.t0, s.gap, s.lead);
    if (!pose) {
      this.strike = null;
      return;
    }
    this.drawCueStick(s.from, s.angle, pose.gap, pose.alpha);
  }

  /** Fait tourner chaque bille d'après son déplacement (roulement sans glissement). */
  private updateSpins(balls: readonly Ball[]): void {
    for (const b of balls) {
      if (b.kind !== 'cue') continue;
      let s = this.spins.get(b.id);
      if (!s) {
        s = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], x: b.x, y: b.y };
        // orientation de départ un peu de biais pour voir plusieurs pois
        rotate(s.m, 0.7071, 0.7071, 0.6);
        this.spins.set(b.id, s);
      }
      const dx = b.x - s.x;
      const dy = b.y - s.y;
      s.x = b.x;
      s.y = b.y;
      const d = Math.hypot(dx, dy);
      // grand saut (replacement, état reçu) : pas de roulement
      if (d < 1e-6 || d > BALL_R * 4) continue;
      rotate(s.m, -dy / d, dx / d, d / BALL_R);
    }
  }

  private drawCueSpots(b: Ball): void {
    const s = this.spins.get(b.id);
    if (!s) return;
    const ctx = this.ctx;
    const m = s.m;
    ctx.save();
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#c8302c';
    const spot = BALL_R * 0.2;
    for (const [px, py, pz] of CUE_SPOTS) {
      const wx = m[0]! * px + m[1]! * py + m[2]! * pz;
      const wy = m[3]! * px + m[4]! * py + m[5]! * pz;
      const wz = m[6]! * px + m[7]! * py + m[8]! * pz;
      if (wz <= 0.02) continue;
      ctx.beginPath();
      ctx.ellipse(b.x + wx * BALL_R, b.y + wy * BALL_R, spot * wz, spot, Math.atan2(wy, wx), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
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
    if (b.kind === 'cue') this.drawCueSpots(b);
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

  private drawAim(m: Match, angle: number, realistic: boolean): void {
    const ctx = this.ctx;
    const cue = m.cue;
    const t = traceAim(m.world.balls, cue, angle);
    const legal = legalTargets(m.rules, m.rules.current);

    if (realistic) {
      // seulement la direction de la blanche, jusqu'à la première bille ou la bande
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([14, 12]);
      ctx.beginPath();
      ctx.moveTo(cue.x + Math.cos(angle) * BALL_R, cue.y + Math.sin(angle) * BALL_R);
      ctx.lineTo(t.ghost.x, t.ghost.y);
      ctx.stroke();
      ctx.restore();
      return;
    }

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

  private drawCueStick(cue: Vec, angle: number, gap: number, alpha = 1): void {
    const ctx = this.ctx;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const len = 1350;
    ctx.save();
    ctx.globalAlpha = alpha;
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

/** Applique à m (3×3, ligne par ligne) une rotation d'angle a autour de l'axe horizontal (ux, uy, 0). */
function rotate(m: number[], ux: number, uy: number, a: number): void {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const t = 1 - c;
  // matrice de Rodrigues pour un axe sans composante z
  const r = [t * ux * ux + c, t * ux * uy, s * uy, t * ux * uy, t * uy * uy + c, -s * ux, -s * uy, s * ux, c];
  const out = new Array<number>(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i * 3 + j] = r[i * 3]! * m[j]! + r[i * 3 + 1]! * m[3 + j]! + r[i * 3 + 2]! * m[6 + j]!;
    }
  }
  for (let k = 0; k < 9; k++) m[k] = out[k]!;
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
