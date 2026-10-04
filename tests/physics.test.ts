import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BALL_R, TABLE_H, TABLE_W } from '../src/game/constants.js';
import { World, traceAim } from '../src/game/physics.js';
import { POCKETS } from '../src/game/table.js';
import { rack } from '../src/game/rack.js';
import { ball, seeded } from './helpers.js';

function shootAt(w: World, x: number, y: number, speed: number, spin = 0): void {
  const c = w.cue;
  w.strike(Math.atan2(y - c.y, x - c.x), speed, spin);
}

function pocketOf(w: World, id: number): number | null {
  const e = w.drainEvents().find((ev) => ev.type === 'pocket' && ev.a === id);
  return e && e.type === 'pocket' ? e.pocket : null;
}

describe('physique', () => {
  it('chaque poche accepte une bille jouée droit dedans', () => {
    POCKETS.forEach((p, i) => {
      const from = {
        x: Math.min(TABLE_W - 200, Math.max(200, p.c.x)),
        y: TABLE_H / 2,
      };
      if (p.kind === 'corner') from.x = p.c.x < TABLE_W / 2 ? 250 : TABLE_W - 250;
      const w = new World([ball('cue', from.x, from.y)]);
      shootAt(w, p.c.x, p.c.y, 1500);
      w.settle();
      assert.equal(w.cue.onTable, false, `poche ${i}`);
      assert.equal(pocketOf(w, w.cue.id), i);
    });
  });

  it('une bille qui longe la bande tombe dans la poche de coin', () => {
    const w = new World([ball('cue', 500, BALL_R + 0.5)]);
    w.strike(Math.PI, 1400, 0);
    w.settle();
    assert.equal(pocketOf(w, w.cue.id), 0);
  });

  it('une bille qui longe la bande passe devant la poche du milieu', () => {
    const w = new World([ball('cue', TABLE_W / 2 - 400, BALL_R + 0.5)]);
    w.strike(0, 1300, 0);
    w.settle();
    assert.notEqual(pocketOf(w, w.cue.id), 1);
  });

  it('rebondit sur une bande avec perte d’énergie', () => {
    const w = new World([ball('cue', TABLE_W / 2, TABLE_H / 2)]);
    w.strike(0, 1000, 0);
    for (let i = 0; i < 2000 && w.cue.vx > 0; i++) w.step(1 / 960);
    assert.ok(w.cue.vx < 0, 'la blanche repart');
    assert.ok(Math.abs(w.cue.vx) < 1000 * 0.8);
  });

  it('choc frontal : la blanche transmet sa vitesse', () => {
    const w = new World([ball('cue', 400, 400), ball('red', 600, 400)]);
    w.strike(0, 2000, 0);
    for (let i = 0; i < 400 && w.firstContact === null; i++) w.step(1 / 960);
    assert.equal(w.firstContact, 'red');
    const red = w.balls[1]!;
    assert.ok(red.vx > 1800, `rouge ${red.vx}`);
    assert.ok(Math.abs(w.cue.vx) < 150, `blanche ${w.cue.vx}`);
  });

  it('le rétro fait revenir la blanche', () => {
    const w = new World([ball('cue', 400, 400), ball('red', 700, 400)]);
    w.strike(0, 2500, -1);
    for (let i = 0; i < 960 && w.firstContact === null; i++) w.step(1 / 960);
    for (let i = 0; i < 20; i++) w.step(1 / 960);
    assert.ok(w.cue.vx < -300, `blanche ${w.cue.vx}`);
  });

  it('le coulé fait suivre la blanche', () => {
    const w = new World([ball('cue', 400, 400), ball('red', 700, 400)]);
    w.strike(0, 2500, 1);
    for (let i = 0; i < 960 && w.firstContact === null; i++) w.step(1 / 960);
    for (let i = 0; i < 20; i++) w.step(1 / 960);
    assert.ok(w.cue.vx > 300, `blanche ${w.cue.vx}`);
  });

  it('la casse se termine et aucune bille ne se chevauche', () => {
    for (const players of [2, 3] as const) {
      for (let seed = 1; seed <= 5; seed++) {
        const rnd = seeded(seed);
        const w = new World(rack(players, rnd));
        w.strike((rnd() - 0.5) * 0.04, 5400, 0);
        const t = w.settle();
        assert.ok(t < 40, `durée ${t}`);
        const on = w.balls.filter((b) => b.onTable);
        for (const b of on) {
          const inRect =
            b.x >= BALL_R - 0.01 && b.x <= TABLE_W - BALL_R + 0.01 && b.y >= BALL_R - 0.01 && b.y <= TABLE_H - BALL_R + 0.01;
          // hors du rectangle, une bille ne peut être qu'arrêtée dans l'entrée d'une poche (entre les mâchoires)
          const inMouth = POCKETS.some((p) => Math.hypot(b.x - p.c.x, b.y - p.c.y) < p.r + BALL_R * 2);
          assert.ok(inRect || inMouth, `bille hors de la table (${b.x.toFixed(1)}, ${b.y.toFixed(1)})`);
          for (const o of on) {
            if (o === b) continue;
            assert.ok(Math.hypot(o.x - b.x, o.y - b.y) > BALL_R * 2 - 0.5, 'chevauchement');
          }
        }
      }
    }
  });

  it('la ligne de visée trouve la bille visée et sa direction', () => {
    const cue = ball('cue', 400, 400);
    const red = ball('red', 800, 400);
    const t = traceAim([cue, red], cue, 0);
    assert.equal(t.target, red);
    assert.ok(Math.abs(t.ghost.x - (800 - BALL_R * 2)) < 0.01);
    assert.ok(t.targetDir && t.targetDir.x > 0.99);
  });
});
