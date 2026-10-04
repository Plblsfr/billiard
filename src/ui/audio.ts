import type { PhysicsEvent } from '../game/physics.js';

/** Sons synthétisés à la volée (aucun fichier audio à charger). */
export class Sound {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private budget = 0;
  muted = false;

  /** À appeler depuis un geste utilisateur (politique d'autoplay des navigateurs). */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const len = Math.floor(this.ctx.sampleRate * 0.25);
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  /** Limite le nombre de sons par image (casse). */
  frame(): void {
    this.budget = 6;
  }

  physics(e: PhysicsEvent): void {
    if (e.type === 'ball') this.click(Math.min(1, e.speed / 3500));
    else if (e.type === 'cushion') this.thud(Math.min(1, e.speed / 4000));
    else this.pocket();
  }

  strike(power: number): void {
    this.burst(1800, 6, 0.05, 0.25 + power * 0.5, 'bandpass');
  }

  private click(v: number): void {
    if (v < 0.01) return;
    this.burst(3200, 4, 0.035, 0.15 + v * 0.85, 'bandpass');
  }

  private thud(v: number): void {
    if (v < 0.03) return;
    this.burst(260, 1.2, 0.07, v * 0.6, 'lowpass');
  }

  private pocket(): void {
    this.burst(180, 1.5, 0.18, 0.7, 'lowpass');
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(150, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(70, ctx.currentTime + 0.2);
    g.gain.setValueAtTime(0.25, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.25);
  }

  private burst(freq: number, q: number, dur: number, vol: number, type: BiquadFilterType): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || this.muted || this.budget <= 0) return;
    this.budget--;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(vol * 0.6, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f).connect(g).connect(ctx.destination);
    src.start(t, Math.random() * 0.1, dur + 0.02);
  }
}
