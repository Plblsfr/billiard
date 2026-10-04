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
