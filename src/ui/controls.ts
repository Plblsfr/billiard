import { BALL_R } from '../game/constants.js';
import type { Match } from '../game/match.js';
import type { View } from '../render/view.js';

export interface ControlsHost {
  match(): Match | null;
  view(): View;
  /** Les commandes ne doivent pas réagir (modale ouverte, menu affiché…). */
  blocked(): boolean;
  shoot(angle: number, power: number, spin: number): void;
  /** La blanche en main vient d'être posée. */
  placed?(): void;
  /** Premier geste utilisateur : débloque l'audio. */
  gesture(): void;
}

export interface ControlsElements {
  canvas: HTMLCanvasElement;
  power: HTMLElement;
  powerFill: HTMLElement;
  powerGrip: HTMLElement;
  spin: HTMLElement;
  spinDot: HTMLElement;
  fineLeft: HTMLElement;
  fineRight: HTMLElement;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const MIN_POWER = 0.03;

export class Controls {
  angle = 0;
  power = 0;
  spin = 0;
  private canvasPointer: number | null = null;
  private powerPointer: number | null = null;
  private spinPointer: number | null = null;
  private repeat: number | null = null;

  constructor(
    private host: ControlsHost,
    private el: ControlsElements,
  ) {
    this.bindCanvas();
    this.bindPower();
    this.bindSpin();
    this.bindFine(el.fineLeft, -1);
    this.bindFine(el.fineRight, 1);
    document.addEventListener('keydown', (e) => this.onKey(e));
    this.sync();
  }

  /** Remet l'effet et la puissance à zéro (nouveau coup, nouvelle partie). */
  reset(): void {
    this.power = 0;
    this.spin = 0;
    this.sync();
  }

  private active(): Match | null {
    if (this.host.blocked()) return null;
    return this.host.match();
  }

  private toWorld(e: PointerEvent): { x: number; y: number } {
    const r = this.el.canvas.getBoundingClientRect();
    return this.host.view().toWorld(e.clientX - r.left, e.clientY - r.top);
  }

  private aimAt(m: Match, p: { x: number; y: number }): void {
    const c = m.cue;
    if (Math.hypot(p.x - c.x, p.y - c.y) < BALL_R * 0.6) return;
    this.angle = Math.atan2(p.y - c.y, p.x - c.x);
  }

  // ---------- table ----------
  private bindCanvas(): void {
    const cv = this.el.canvas;
    cv.addEventListener('pointerdown', (e) => {
      const m = this.active();
      if (!m || !e.isPrimary) return;
      this.host.gesture();
      if (m.phase !== 'placing' && m.phase !== 'aiming') return;
      e.preventDefault();
      this.canvasPointer = e.pointerId;
      cv.setPointerCapture(e.pointerId);
      const p = this.toWorld(e);
      if (m.phase === 'placing') m.moveCueInHand(p);
      else this.aimAt(m, p);
    });
    cv.addEventListener('pointermove', (e) => {
      const m = this.active();
      if (!m) return;
      const pressed = this.canvasPointer === e.pointerId;
      const p = this.toWorld(e);
      if (m.phase === 'placing' && (pressed || e.pointerType === 'mouse')) m.moveCueInHand(p);
      else if (m.phase === 'aiming' && pressed) this.aimAt(m, p);
    });
    const end = (e: PointerEvent, place: boolean): void => {
      if (this.canvasPointer !== e.pointerId) return;
      this.canvasPointer = null;
      const m = this.active();
      if (place && m?.phase === 'placing') this.place(m);
    };
    cv.addEventListener('pointerup', (e) => end(e, true));
    cv.addEventListener('pointercancel', (e) => end(e, false));
    cv.addEventListener(
      'wheel',
      (e) => {
        const m = this.active();
        if (!m || m.phase !== 'aiming') return;
        e.preventDefault();
        const step = e.shiftKey ? 0.0006 : 0.003;
        this.angle += Math.sign(e.deltaY || e.deltaX) * step;
      },
      { passive: false },
    );
  }

  // ---------- puissance ----------
  private bindPower(): void {
    const el = this.el.power;
    const fromEvent = (e: PointerEvent): void => {
      const r = el.getBoundingClientRect();
      this.power = clamp((e.clientY - r.top - 6) / (r.height - 12), 0, 1);
      this.sync();
    };
    el.addEventListener('pointerdown', (e) => {
      const m = this.active();
      if (!m || m.phase !== 'aiming' || !e.isPrimary) return;
      this.host.gesture();
      e.preventDefault();
      el.focus({ preventScroll: true });
      this.powerPointer = e.pointerId;
      el.setPointerCapture(e.pointerId);
      fromEvent(e);
    });
    el.addEventListener('pointermove', (e) => {
      if (this.powerPointer === e.pointerId) fromEvent(e);
    });
    el.addEventListener('pointerup', (e) => {
      if (this.powerPointer !== e.pointerId) return;
      this.powerPointer = null;
      if (this.power >= MIN_POWER) this.fire();
      else this.reset();
    });
    el.addEventListener('pointercancel', (e) => {
      if (this.powerPointer !== e.pointerId) return;
      this.powerPointer = null;
      this.power = 0;
      this.sync();
    });
  }

  // ---------- effet ----------
  private bindSpin(): void {
    const el = this.el.spin;
    const fromEvent = (e: PointerEvent): void => {
      const r = el.getBoundingClientRect();
      const dy = e.clientY - (r.top + r.height / 2);
      this.spin = clamp(-dy / (r.height * 0.4), -1, 1);
      if (Math.abs(this.spin) < 0.08) this.spin = 0;
      this.sync();
    };
    el.addEventListener('pointerdown', (e) => {
      if (!this.active() || !e.isPrimary) return;
      this.host.gesture();
      e.preventDefault();
      el.focus({ preventScroll: true });
      this.spinPointer = e.pointerId;
      el.setPointerCapture(e.pointerId);
      fromEvent(e);
    });
    el.addEventListener('pointermove', (e) => {
      if (this.spinPointer === e.pointerId) fromEvent(e);
    });
    const stop = (e: PointerEvent): void => {
      if (this.spinPointer === e.pointerId) this.spinPointer = null;
    };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
    el.addEventListener('dblclick', () => {
      this.spin = 0;
      this.sync();
    });
  }

  // ---------- visée fine (maintien = répétition) ----------
  private bindFine(btn: HTMLElement, dir: 1 | -1): void {
    const stop = (): void => {
      if (this.repeat !== null) window.clearTimeout(this.repeat);
      this.repeat = null;
    };
    btn.addEventListener('pointerdown', (e) => {
      const m = this.active();
      if (!m || m.phase !== 'aiming') return;
      e.preventDefault();
      this.host.gesture();
      let n = 0;
      const tick = (): void => {
        const step = n < 10 ? 0.0015 : n < 30 ? 0.004 : 0.012;
        this.angle += dir * step;
        n++;
        this.repeat = window.setTimeout(tick, n === 1 ? 300 : 45);
      };
      stop();
      tick();
    });
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('click', (e) => {
      // activation clavier (Entrée / Espace sur le bouton)
      if (e.detail === 0 && this.active()?.phase === 'aiming') this.angle += dir * 0.0015;
    });
  }

  // ---------- clavier ----------
  private onKey(e: KeyboardEvent): void {
    const m = this.active();
    if (!m) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const onButton = t?.tagName === 'BUTTON';
    const fine = e.shiftKey;

    if (m.phase === 'placing') {
      const step = fine ? 1 : 6;
      const c = m.cue;
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const mv = moves[e.key];
      if (mv) {
        e.preventDefault();
        const d = this.host.view().screenDirToWorld(mv[0], mv[1]);
        m.moveCueInHand({ x: c.x + d.x, y: c.y + d.y });
      } else if ((e.key === 'Enter' || e.key === ' ') && !onButton) {
        e.preventDefault();
        this.place(m);
      }
      return;
    }
    if (m.phase !== 'aiming') return;

    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        this.angle -= fine ? 0.0015 : 0.012;
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.angle += fine ? 0.0015 : 0.012;
        break;
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        const up = e.key === 'ArrowUp';
        if (t === this.el.spin) this.spin = clamp(this.spin + (up ? 0.1 : -0.1), -1, 1);
        else this.power = clamp(this.power + (up ? 0.05 : -0.05), 0, 1);
        this.sync();
        break;
      }
      case ' ':
      case 'Enter':
        if (onButton) return;
        e.preventDefault();
        if (this.power < MIN_POWER) this.power = 0.5;
        this.fire();
        break;
      case '0':
        this.spin = 0;
        this.sync();
        break;
    }
  }

  private place(m: Match): void {
    if (m.placeCue()) this.host.placed?.();
  }

  private fire(): void {
    const m = this.active();
    if (!m || m.phase !== 'aiming') return;
    this.host.shoot(this.angle, this.power, this.spin);
    this.reset();
  }

  /** Met à jour l'affichage des jauges. */
  sync(): void {
    const pct = Math.round(this.power * 100);
    this.el.powerFill.style.height = `${pct}%`;
    this.el.powerGrip.style.top = `calc(${pct}% - ${pct > 0 ? 8 : 0}px)`;
    this.el.power.setAttribute('aria-valuenow', String(pct));
    this.el.power.setAttribute('aria-valuetext', `${pct} %`);
    const sp = Math.round(this.spin * 100);
    this.el.spinDot.style.top = `${50 - this.spin * 36}%`;
    this.el.spin.setAttribute('aria-valuenow', String(sp));
    this.el.spin.setAttribute(
      'aria-valuetext',
      sp === 0 ? 'sans effet' : sp > 0 ? `coulé ${sp} %` : `rétro ${-sp} %`,
    );
  }
}
