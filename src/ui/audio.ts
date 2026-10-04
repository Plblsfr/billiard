import type { PhysicsEvent } from '../game/physics.js';
import type { ShotOutcome } from '../game/rules.js';

/**
 * Sons synthétisés à la volée (aucun fichier audio à charger) :
 * chocs de billes, bandes, coup de queue, chute dans la poche puis roulement dans la gouttière,
 * bruit de roulement continu sur le tapis et petits signaux de jeu (faute, changement de main, victoire).
 */
export class Sound {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private master: GainNode | null = null;
  private roll: GainNode | null = null;
  private budget = 0;
  private _muted = false;

  get muted(): boolean {
    return this._muted;
  }

  set muted(v: boolean) {
    this._muted = v;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v ? 0 : 1, this.ctx.currentTime, 0.02);
  }

  /** À appeler depuis un geste utilisateur (politique d'autoplay des navigateurs). */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // tout passe par un compresseur : la casse reste forte sans saturer
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    this.master = ctx.createGain();
    this.master.gain.value = this._muted ? 0 : 1;
    this.master.connect(comp).connect(ctx.destination);

    // roulement sur le drap : bruit sourd en boucle dont le volume suit la vitesse des billes
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 260;
    band.Q.value = 0.8;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 520;
    this.roll = ctx.createGain();
    this.roll.gain.value = 0;
    src.connect(band).connect(low).connect(this.roll).connect(this.master);
    src.start();

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.rolling(0);
    });
  }

  /** Limite le nombre de chocs joués par image (casse). */
  frame(): void {
    this.budget = 7;
  }

  /** Vitesse cumulée des billes sur la table (mm/s), appelée à chaque image. */
  rolling(totalSpeed: number): void {
    if (!this.ctx || !this.roll) return;
    const v = Math.min(1, totalSpeed / 9000);
    this.roll.gain.setTargetAtTime(v > 0.004 ? 0.05 + v * 0.32 : 0, this.ctx.currentTime, 0.06);
  }

  physics(e: PhysicsEvent): void {
    if (e.type === 'ball') this.clack(Math.min(1, e.speed / 3500));
    else if (e.type === 'cushion') this.thud(Math.min(1, e.speed / 4000));
    else this.pocket(Math.min(1, Math.hypot(e.vx, e.vy) / 2500));
  }

  /** Coup de queue : le « toc » du procédé en cuir sur la blanche. */
  strike(power: number): void {
    this.noiseBurst(1300, 1.8, 0.05, 0.25 + power * 0.5, 'bandpass');
    this.tone('sine', 520, 260, 0.06, 0.18 + power * 0.3);
    this.tone('triangle', 1100, 900, 0.025, 0.06 + power * 0.1);
  }

  /** Son de fin de coup, d'après son résultat. */
  outcome(o: ShotOutcome): void {
    if (o.winner !== null) this.win();
    else if (o.foul || o.eliminated !== null) this.foul();
    else if (!o.continues) this.turn();
  }

  // ---------- chocs ----------
  private clack(v: number, at = 0): void {
    if (v < 0.01 || !this.take()) return;
    // claquement net de la résine : partiels aigus brefs + souffle filtré
    const f = 2500 + Math.random() * 600;
    this.tone('sine', f, f * 0.97, 0.03, 0.12 + v * 0.45, at);
    this.tone('sine', f * 2.1, f * 2, 0.018, 0.05 + v * 0.18, at);
    this.noiseBurst(4200, 3, 0.03, 0.12 + v * 0.7, 'bandpass', at);
  }

  private thud(v: number): void {
    if (v < 0.03 || !this.take()) return;
    this.tone('sine', 120, 70, 0.09, v * 0.55);
    this.noiseBurst(380, 1, 0.07, v * 0.5, 'lowpass');
  }

  /** Chute dans la poche, roulement dans la gouttière, puis choc contre les billes déjà rentrées. */
  private pocket(v: number): void {
    // impact sourd contre le fond de la poche
    this.tone('sine', 150, 52, 0.24, 0.3 + v * 0.35);
    this.noiseBurst(260, 1.2, 0.16, 0.45 + v * 0.3, 'lowpass');
    this.gully(0.14, 0.75);
    this.clack(0.35, 0.92);
  }

  private gully(at: number, dur: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || !this.master || this._muted) return;
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(700, t);
    f.frequency.linearRampToValueAtTime(420, t + dur);
    f.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.32, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    // roulement saccadé sur les rails de la gouttière
    const lfo = ctx.createOscillator();
    lfo.frequency.setValueAtTime(26, t);
    lfo.frequency.linearRampToValueAtTime(14, t + dur);
    const depth = ctx.createGain();
    depth.gain.value = 0.5;
    const trem = ctx.createGain();
    trem.gain.value = 0.6;
    lfo.connect(depth).connect(trem.gain);
    src.connect(f).connect(g).connect(trem).connect(this.master);
    src.start(t, Math.random() * 0.2, dur + 0.05);
    lfo.start(t);
    lfo.stop(t + dur + 0.05);
  }

  // ---------- signaux de jeu ----------
  private foul(): void {
    this.tone('triangle', 330, 320, 0.16, 0.16, 0.12);
    this.tone('triangle', 233, 220, 0.26, 0.16, 0.3);
  }

  private turn(): void {
    this.tone('sine', 660, 660, 0.09, 0.07, 0.15);
    this.tone('sine', 880, 880, 0.14, 0.07, 0.24);
  }

  private win(): void {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      this.tone('triangle', f, f, i === 3 ? 0.7 : 0.18, 0.14, 0.2 + i * 0.12);
      this.tone('sine', f * 2, f * 2, i === 3 ? 0.5 : 0.12, 0.04, 0.2 + i * 0.12);
    });
  }

  // ---------- briques ----------
  private take(): boolean {
    if (this.budget <= 0) return false;
    this.budget--;
    return true;
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, at = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this._muted) return;
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noiseBurst(freq: number, q: number, dur: number, vol: number, type: BiquadFilterType, at = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || !this.master || this._muted) return;
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol * 0.6, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5, dur + 0.02);
  }
}
