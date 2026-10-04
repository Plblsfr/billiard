import { BALL_R, BAULK_X, BLACK_SPOT, TABLE_H, TABLE_W, shotSpeed } from './constants.js';
import { World, type PhysicsEvent } from './physics.js';
import { ballsPerGroup, cueStart, groupsFor, rack, type Random } from './rack.js';
import { createRules, resolveShot, type RulesState, type ShotOutcome } from './rules.js';
import { inPocketZone, insidePlayArea, type Vec } from './table.js';
import { isGroup, type Ball } from './types.js';

export type Phase = 'placing' | 'aiming' | 'rolling' | 'over';

/** État complet d'une partie à l'arrêt, sérialisable en JSON (jeu en ligne). */
export interface MatchSnapshot {
  names: string[];
  balls: Ball[];
  rules: RulesState;
  phase: Phase;
  lastOutcome: ShotOutcome | null;
  shots: number;
}

export interface MatchListener {
  physics?(e: PhysicsEvent): void;
  outcome?(o: ShotOutcome, m: Match): void;
}

export class Match {
  readonly playerCount: 2 | 3;
  readonly names: string[];
  world: World;
  rules: RulesState;
  phase: Phase = 'placing';
  lastOutcome: ShotOutcome | null = null;
  shots = 0;
  /**
   * Faux sur les écrans qui regardent un coup joué ailleurs : à l'arrêt des billes,
   * la partie attend l'état officiel (restore) au lieu d'appliquer elle-même les règles.
   */
  resolveLocally = true;
  private listeners: MatchListener[] = [];

  constructor(names: string[], rnd: Random = Math.random) {
    if (names.length !== 2 && names.length !== 3) throw new Error('2 ou 3 joueurs');
    this.playerCount = names.length as 2 | 3;
    this.names = [...names];
    this.world = new World(rack(this.playerCount, rnd));
    this.rules = createRules(names, groupsFor(this.playerCount), ballsPerGroup(this.playerCount));
  }

  on(l: MatchListener): () => void {
    this.listeners.push(l);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l);
    };
  }

  get cue(): Ball {
    return this.world.cue;
  }

  /** Une bille blanche peut-elle être posée en p (derrière la ligne de baulk) ? */
  canPlaceCue(p: Vec): boolean {
    if (!insidePlayArea(p) || p.x > BAULK_X) return false;
    if (inPocketZone(p, BALL_R)) return false;
    return this.world.balls.every(
      (b) => b.kind === 'cue' || !b.onTable || Math.hypot(b.x - p.x, b.y - p.y) >= BALL_R * 2 + 0.5,
    );
  }

  /** Déplace la blanche pendant le placement (bornée à la zone de baulk). */
  moveCueInHand(p: Vec): void {
    if (this.phase !== 'placing') return;
    const cue = this.cue;
    cue.x = Math.min(BAULK_X, Math.max(BALL_R, p.x));
    cue.y = Math.min(TABLE_H - BALL_R, Math.max(BALL_R, p.y));
  }

  /** Valide la position de la blanche en main. */
  placeCue(p?: Vec): boolean {
    if (this.phase !== 'placing') return false;
    if (p) this.moveCueInHand(p);
    if (!this.canPlaceCue(this.cue)) return false;
    this.phase = 'aiming';
    return true;
  }

  shoot(angle: number, power: number, spin = 0): boolean {
    if (this.phase !== 'aiming' || power <= 0) return false;
    this.world.strike(angle, shotSpeed(power), spin);
    this.phase = 'rolling';
    this.shots++;
    return true;
  }

  /** Avance l'animation. Renvoie vrai si un coup vient de se terminer. */
  update(dt: number): boolean {
    if (this.phase !== 'rolling') return false;
    this.world.advance(dt);
    this.flushEvents();
    if (this.world.isMoving() || !this.resolveLocally) return false;
    this.finishShot();
    return true;
  }

  /** Copie de l'état, à prendre billes arrêtées (hors phase « rolling »). */
  snapshot(): MatchSnapshot {
    return {
      names: [...this.names],
      balls: this.world.balls.map((b) => ({ ...b, vx: 0, vy: 0 })),
      rules: structuredClone(this.rules),
      phase: this.phase,
      lastOutcome: structuredClone(this.lastOutcome),
      shots: this.shots,
    };
  }

  /** Remplace l'état par un instantané (sans prévenir les écouteurs). */
  restore(s: MatchSnapshot): void {
    if (s.names.length !== this.playerCount) throw new Error('Nombre de joueurs différent');
    this.world = new World(s.balls.map((b) => ({ ...b, vx: 0, vy: 0 })));
    this.rules = structuredClone(s.rules);
    this.phase = s.phase === 'rolling' ? 'aiming' : s.phase;
    this.lastOutcome = structuredClone(s.lastOutcome);
    this.shots = s.shots;
  }

  static fromSnapshot(s: MatchSnapshot): Match {
    const m = new Match(s.names);
    m.restore(s);
    return m;
  }

  /** Termine immédiatement le coup en cours (tests, avance rapide). */
  settle(): void {
    if (this.phase !== 'rolling') return;
    this.world.settle();
    this.flushEvents();
    this.finishShot();
  }

  private flushEvents(): void {
    const events = this.world.drainEvents();
    for (const l of this.listeners) if (l.physics) events.forEach((e) => l.physics!(e));
  }

  private finishShot(): void {
    const potted = this.world.potted;
    const { state, outcome } = resolveShot(this.rules, {
      firstContact: this.world.firstContact,
      potted: potted.filter((b) => b.kind !== 'cue').map((b) => b.kind),
      cuePotted: potted.some((b) => b.kind === 'cue'),
    });
    this.rules = state;
    this.lastOutcome = outcome;

    for (const b of this.world.balls) {
      if (b.onTable && isGroup(b.kind) && outcome.removeGroups.includes(b.kind)) b.onTable = false;
    }
    if (outcome.respotBlack) this.respotBlack();

    if (state.winner !== null) {
      this.phase = 'over';
    } else if (outcome.ballInHand || !this.cue.onTable) {
      const cue = this.cue;
      cue.onTable = true;
      cue.vx = 0;
      cue.vy = 0;
      const spot = this.freeBaulkSpot();
      cue.x = spot.x;
      cue.y = spot.y;
      this.phase = 'placing';
    } else {
      this.phase = 'aiming';
    }
    for (const l of this.listeners) l.outcome?.(outcome, this);
  }

  private isFree(p: Vec, ignore?: Ball): boolean {
    return this.world.balls.every(
      (b) => b === ignore || !b.onTable || Math.hypot(b.x - p.x, b.y - p.y) >= BALL_R * 2 + 0.5,
    );
  }

  private respotBlack(): void {
    const black = this.world.balls.find((b) => b.kind === 'black');
    if (!black) return;
    const y = BLACK_SPOT.y;
    let x = BLACK_SPOT.x;
    // vers la bande du haut de table, puis vers le baulk si tout est occupé
    while (!this.isFree({ x, y }, black) && x < TABLE_W - BALL_R) x += 1;
    if (!this.isFree({ x, y }, black)) {
      x = BLACK_SPOT.x;
      while (!this.isFree({ x, y }, black) && x > BALL_R) x -= 1;
    }
    black.x = x;
    black.y = y;
    black.vx = 0;
    black.vy = 0;
    black.onTable = true;
  }

  private freeBaulkSpot(): Vec {
    const start = cueStart();
    if (this.canPlaceCue(start)) return start;
    for (let r = BALL_R; r < TABLE_H; r += BALL_R / 2) {
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
        const p = { x: start.x + Math.cos(a) * r, y: start.y + Math.sin(a) * r };
        if (this.canPlaceCue(p)) return p;
      }
    }
    return start;
  }
}
