import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../src/game/match.js';
import { Replay, ShotLog } from '../src/game/replay.js';
import { seeded } from './helpers.js';

/** Joue quelques coups en les enregistrant comme le fait l'interface. */
function playAndRecord(n: number): { m: Match; log: ShotLog } {
  const rnd = seeded(21);
  const m = new Match(['Anna', 'Bob'], rnd);
  const log = new ShotLog();
  m.on({ outcome: (_o, mm) => log.finish(mm.snapshot()) });
  for (let i = 0; i < n && m.phase !== 'over'; i++) {
    if (m.phase === 'placing') m.placeCue();
    const angle = (rnd() - 0.5) * 0.3 + (i === 0 ? 0 : Math.PI * (rnd() - 0.5));
    const power = i === 0 ? 1 : 0.3 + rnd() * 0.5;
    const spin = rnd() * 2 - 1;
    const before = m.snapshot();
    m.shoot(angle, power, spin);
    log.start(before, angle, power, spin);
    m.settle();
  }
  return { m, log };
}

describe('replay', () => {
  it('enregistre chaque coup avec son état avant et après', () => {
    const { m, log } = playAndRecord(4);
    assert.equal(log.complete.length, m.shots);
    log.complete.forEach((r, i) => {
      assert.equal(r.before.shots, i);
      assert.equal(r.after!.shots, i + 1);
    });
    // un état qui ne suit pas le dernier coup est ignoré
    log.start(m.snapshot(), 0, 0.5, 0);
    log.finish(log.complete[0]!.after!);
    assert.equal(log.records.at(-1)!.after, null);
  });

  it('rejouer un coup sur le même appareil redonne exactement le même résultat', () => {
    const { log } = playAndRecord(3);
    for (const r of log.complete) {
      const copy = Match.fromSnapshot(r.before);
      copy.resolveLocally = false;
      copy.shoot(r.angle, r.power, r.spin);
      for (let i = 0; i < 100000 && copy.world.isMoving(); i++) copy.update(1 / 60);
      assert.deepEqual(
        copy.world.balls.map((b) => [b.id, b.onTable, b.x, b.y]),
        r.after!.balls.map((b) => [b.id, b.onTable, b.x, b.y]),
      );
    }
  });

  it('enchaîne tous les coups, avec pause, saut et fin', () => {
    const { log } = playAndRecord(3);
    const shots = log.complete;
    let strikes = 0;
    let outcomes = 0;
    const r = new Replay(shots, 0, true, {
      strike: () => {
        strikes++;
        return 60;
      },
      listener: {},
      outcome: () => outcomes++,
    });
    assert.equal(r.shooter, 'Anna');
    r.toggle();
    for (let i = 0; i < 50; i++) r.update(16);
    assert.equal(strikes, 0, 'en pause, rien ne bouge');
    r.toggle();
    for (let i = 0; i < 20000 && !r.finished; i++) r.update(16);
    assert.ok(r.finished);
    assert.equal(r.index, shots.length - 1);
    assert.equal(strikes, shots.length);
    assert.equal(outcomes, shots.length);
    assert.deepEqual(r.match.snapshot().balls, shots.at(-1)!.after!.balls);

    r.goTo(0);
    assert.equal(r.index, 0);
    assert.equal(r.finished, false);
    assert.deepEqual(r.match.snapshot().balls, shots[0]!.before.balls);
  });
});
