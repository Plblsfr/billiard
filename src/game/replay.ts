/**
 * Enregistrement des coups d'une partie et relecture.
 *
 * Chaque coup garde l'état avant la frappe, la frappe elle-même et l'état officiel après.
 * La relecture recalcule le coup avec la même physique sur une copie de la table, puis se recale
 * sur l'état officiel (identique sur l'écran qui a tiré, à quelques millimètres près ailleurs).
 */
import { Match, type MatchListener, type MatchSnapshot } from './match.js';
import type { ShotOutcome } from './rules.js';
import type { Vec } from './table.js';

export interface ShotRecord {
  before: MatchSnapshot;
  angle: number;
  power: number;
  spin: number;
  after: MatchSnapshot | null;
}

export class ShotLog {
  records: ShotRecord[] = [];

  /** Coup joué : à appeler juste avant Match.shoot. */
  start(before: MatchSnapshot, angle: number, power: number, spin: number): void {
    this.records.push({ before, angle, power, spin, after: null });
  }

  /** État officiel après le coup (ignoré s'il ne correspond pas au dernier coup enregistré). */
  finish(after: MatchSnapshot): void {
    const last = this.records.at(-1);
    if (last && !last.after && after.shots === last.before.shots + 1) last.after = after;
  }

  /** Coups terminés, les seuls que l'on peut revoir. */
  get complete(): ShotRecord[] {
    return this.records.filter((r) => r.after !== null);
  }

  clear(): void {
    this.records = [];
  }
}

export interface ReplayHooks {
  /** Lance l'animation de la queue ; renvoie le délai avant le contact (ms). */
  strike(cue: Vec, angle: number, power: number): number;
  /** Écouteur branché sur la table rejouée (sons, chutes dans les poches). */
  listener: MatchListener;
  /** Fin d'un coup rejoué. */
  outcome(o: ShotOutcome): void;
}

type Step = 'aim' | 'strike' | 'roll' | 'hold' | 'done';

/** Temps de visée affiché avant la frappe, puis pause sur le résultat (ms, à vitesse ×1). */
const AIM_MS = 650;
const HOLD_MS = 1100;

export class Replay {
  index = 0;
  match: Match;
  playing = true;
  speed: 1 | 2 = 1;
  private step: Step = 'aim';
  private t = 0;
  private lead = 0;

  constructor(
    readonly shots: readonly ShotRecord[],
    start: number,
    /** Enchaîne les coups jusqu'au dernier (revoir la partie) ou s'arrête après un seul. */
    readonly all: boolean,
    private hooks: ReplayHooks,
  ) {
    if (shots.length === 0) throw new Error('Aucun coup à revoir');
    this.match = this.load(Math.max(0, Math.min(shots.length - 1, start)));
  }

  get record(): ShotRecord {
    return this.shots[this.index]!;
  }

  get finished(): boolean {
    return this.step === 'done';
  }

  /** Nom du joueur qui tire dans le coup affiché. */
  get shooter(): string {
    const r = this.record.before.rules;
    return r.players[r.current]?.name ?? '';
  }

  /** Visée à dessiner pendant la préparation du coup. */
  get aim(): { angle: number; power: number } {
    const r = this.record;
    if (this.step !== 'aim') return { angle: r.angle, power: 0 };
    const k = Math.min(1, this.t / AIM_MS);
    return { angle: r.angle, power: r.power * k * k };
  }

  goTo(i: number): void {
    if (i < 0 || i >= this.shots.length) return;
    this.match = this.load(i);
    this.playing = true;
  }

  /** Lecture / pause ; relance depuis le début du coup s'il était fini. */
  toggle(): void {
    if (this.step === 'done') {
      this.goTo(this.all && this.index === this.shots.length - 1 ? 0 : this.index);
      return;
    }
    this.playing = !this.playing;
  }

  /** Avance la relecture de dtMs millisecondes réelles. */
  update(dtMs: number): void {
    if (!this.playing || this.step === 'done') return;
    const r = this.record;
    const dt = dtMs * this.speed;
    switch (this.step) {
      case 'aim':
        this.t += dt;
        if (this.t >= AIM_MS) {
          this.lead = this.hooks.strike(this.match.cue, r.angle, r.power);
          this.step = 'strike';
          this.t = 0;
        }
        break;
      case 'strike':
        // l'animation de la queue suit l'horloge réelle
        this.t += dtMs;
        if (this.t >= this.lead) {
          this.match.shoot(r.angle, r.power, r.spin);
          this.step = 'roll';
        }
        break;
      case 'roll':
        this.match.update(Math.min(0.1, dt / 1000));
        if (!this.match.world.isMoving()) {
          if (r.after) {
            this.match.restore(r.after);
            if (r.after.lastOutcome) this.hooks.outcome(r.after.lastOutcome);
          }
          this.step = 'hold';
          this.t = 0;
        }
        break;
      case 'hold':
        this.t += dt;
        if (this.t >= HOLD_MS) {
          if (this.all && this.index < this.shots.length - 1) this.match = this.load(this.index + 1);
          else {
            this.step = 'done';
            this.playing = false;
          }
        }
        break;
    }
  }

  private load(i: number): Match {
    this.index = i;
    this.step = 'aim';
    this.t = 0;
    const m = Match.fromSnapshot(this.shots[i]!.before);
    m.resolveLocally = false;
    m.on(this.hooks.listener);
    return m;
  }
}
