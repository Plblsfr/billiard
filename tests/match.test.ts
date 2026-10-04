import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../src/game/match.js';
import { legalTargets } from '../src/game/rules.js';
import { BALL_R, BAULK_X } from '../src/game/constants.js';
import { isGroup } from '../src/game/types.js';
import { seeded } from './helpers.js';

/** Joue une partie complète avec un joueur automatique imprécis. */
function autoplay(names: string[], seed: number): Match {
  const rnd = seeded(seed);
  const m = new Match(names, rnd);
  for (let i = 0; i < 600 && m.phase !== 'over'; i++) {
    if (m.phase === 'placing') {
      assert.ok(m.placeCue(), 'placement de la blanche');
      continue;
    }
    assert.equal(m.phase, 'aiming');
    const targets = legalTargets(m.rules, m.rules.current);
    const candidates = m.world.balls.filter((b) => b.onTable && targets.includes(b.kind));
    const t = candidates[Math.floor(rnd() * candidates.length)] ?? m.world.balls.find((b) => b.onTable && b.kind !== 'cue')!;
    const angle = Math.atan2(t.y - m.cue.y, t.x - m.cue.x) + (rnd() - 0.5) * 0.06;
    m.shoot(angle, m.shots === 0 ? 1 : 0.25 + rnd() * 0.6, rnd() * 2 - 1);
    m.settle();

    // cohérence entre les règles et la table
    for (const g of m.rules.groups) {
      const n = m.world.balls.filter((b) => b.onTable && b.kind === g).length;
      assert.equal(n, m.rules.onTable[g], `compte ${g}`);
    }
    for (const b of m.world.balls) {
      if (b.onTable && isGroup(b.kind)) assert.ok(m.rules.groups.includes(b.kind), 'couleur retirée encore sur la table');
    }
    assert.ok(m.world.balls.find((b) => b.kind === 'black')!.onTable || (m.phase as string) === 'over', 'noire sur la table');
  }
  return m;
}

describe('partie complète', () => {
  it('parties à 2 joueurs jusqu’au bout', () => {
    let finished = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const m = autoplay(['Anna', 'Bob'], seed);
      if (m.phase === 'over') finished++;
    }
    assert.ok(finished >= 8, `${finished} parties terminées`);
  });

  it('parties à 3 joueurs jusqu’au bout', () => {
    let finished = 0;
    for (let seed = 100; seed <= 111; seed++) {
      const m = autoplay(['Anna', 'Bob', 'Chloé'], seed);
      if (m.phase === 'over') {
        finished++;
        assert.ok(m.rules.winner !== null);
        assert.equal(m.rules.players[m.rules.winner!]!.eliminated, false);
      }
    }
    assert.ok(finished >= 8, `${finished} parties terminées`);
  });

  it('la blanche en main reste derrière la ligne de baulk', () => {
    const m = new Match(['Anna', 'Bob'], seeded(3));
    assert.equal(m.phase, 'placing');
    m.moveCueInHand({ x: 1200, y: 400 });
    assert.ok(m.cue.x <= BAULK_X);
    assert.equal(m.canPlaceCue({ x: BAULK_X + 10, y: 400 }), false);
    assert.equal(m.canPlaceCue({ x: BALL_R + 1, y: BALL_R + 1 }), false, 'trop près de la poche');
    assert.ok(m.placeCue({ x: 200, y: 450 }));
    assert.equal(m.phase, 'aiming');
  });
});

describe('instantanés (jeu en ligne)', () => {
  it('un instantané passé en JSON redonne la même partie', () => {
    const rnd = seeded(7);
    const a = new Match(['Anna', 'Bob', 'Chloé'], rnd);
    a.placeCue();
    a.shoot(0.01, 1, 0);
    a.settle();
    const snap = JSON.parse(JSON.stringify(a.snapshot()));
    const b = Match.fromSnapshot(snap);
    assert.deepEqual(b.snapshot(), a.snapshot());
    assert.equal(b.phase, a.phase);
    assert.equal(b.rules.current, a.rules.current);
  });

  it('un écran spectateur attend l’état officiel au lieu d’appliquer les règles', () => {
    const shooter = new Match(['Anna', 'Bob'], seeded(11));
    shooter.placeCue();
    const viewer = Match.fromSnapshot(shooter.snapshot());
    viewer.resolveLocally = false;

    shooter.shoot(0, 1, 0);
    viewer.shoot(0, 1, 0);
    for (let i = 0; i < 4000 && shooter.phase === 'rolling'; i++) shooter.update(1 / 60);
    for (let i = 0; i < 4000 && viewer.world.isMoving(); i++) viewer.update(1 / 60);

    assert.notEqual(shooter.phase, 'rolling');
    assert.equal(viewer.phase, 'rolling', 'le spectateur reste en attente');
    assert.equal(viewer.lastOutcome, null);
    viewer.restore(shooter.snapshot());
    assert.deepEqual(viewer.snapshot(), shooter.snapshot());
  });
});

describe('triangle à trois joueurs', () => {
  it('6 billes par couleur et la noire, sans chevauchement', () => {
    const m = new Match(['Anna', 'Bob', 'Chloé'], seeded(5));
    const balls = m.world.balls.filter((b) => b.kind !== 'cue');
    assert.equal(balls.length, 19);
    for (const g of ['red', 'yellow', 'blue'] as const) {
      assert.equal(balls.filter((b) => b.kind === g).length, 6, g);
      assert.equal(m.rules.onTable[g], 6);
    }
    assert.equal(balls.filter((b) => b.kind === 'black').length, 1);
    for (const a of balls) for (const b of balls) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= BALL_R * 2);
  });
});
