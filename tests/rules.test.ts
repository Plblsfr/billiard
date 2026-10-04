import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRules, legalTargets, resolveShot, type RulesState, type ShotReport } from '../src/game/rules.js';
import type { BallKind, Group } from '../src/game/types.js';

function two(groups: (Group | null)[] = [null, null]): RulesState {
  const s = createRules(['Anna', 'Bob'], ['red', 'yellow'], 7);
  s.isBreak = false;
  s.players.forEach((p, i) => (p.group = groups[i] ?? null));
  return s;
}

function three(groups: (Group | null)[] = [null, null, null]): RulesState {
  const s = createRules(['Anna', 'Bob', 'Chloé'], ['red', 'yellow', 'blue'], 4);
  s.isBreak = false;
  s.players.forEach((p, i) => (p.group = groups[i] ?? null));
  return s;
}

const shot = (firstContact: BallKind | null, potted: BallKind[] = [], cuePotted = false): ShotReport => ({
  firstContact,
  potted,
  cuePotted,
});

describe('casse', () => {
  it('casse sans bille empochée : au suivant', () => {
    const s = createRules(['Anna', 'Bob'], ['red', 'yellow'], 7);
    const { state, outcome } = resolveShot(s, shot('red'));
    assert.equal(outcome.foul, null);
    assert.equal(state.current, 1);
    assert.equal(state.isBreak, false);
  });

  it('bille empochée à la casse : on rejoue, la table reste ouverte', () => {
    const s = createRules(['Anna', 'Bob'], ['red', 'yellow'], 7);
    const { state, outcome } = resolveShot(s, shot('yellow', ['red']));
    assert.equal(outcome.continues, true);
    assert.equal(state.current, 0);
    assert.equal(state.players[0]!.group, null);
    assert.equal(state.onTable.red, 6);
  });

  it('noire empochée à la casse : replacée sans pénalité', () => {
    const s = createRules(['Anna', 'Bob'], ['red', 'yellow'], 7);
    const { state, outcome } = resolveShot(s, shot('red', ['black']));
    assert.equal(outcome.respotBlack, true);
    assert.equal(state.winner, null);
  });

  it('blanche empochée à la casse : faute, bille en main et deux coups', () => {
    const s = createRules(['Anna', 'Bob'], ['red', 'yellow'], 7);
    const { state, outcome } = resolveShot(s, shot('red', [], true));
    assert.ok(outcome.foul);
    assert.equal(outcome.ballInHand, true);
    assert.equal(state.current, 1);
    assert.equal(state.visits, 2);
  });
});

describe('table ouverte (2 joueurs)', () => {
  it('la première bille empochée attribue les couleurs', () => {
    const { state, outcome } = resolveShot(two(), shot('red', ['yellow', 'red']));
    assert.equal(state.players[0]!.group, 'yellow');
    assert.equal(state.players[1]!.group, 'red');
    assert.equal(outcome.continues, true);
    assert.equal(outcome.assigned.length, 2);
  });

  it('toucher la noire en premier sur table ouverte est une faute', () => {
    const { state, outcome } = resolveShot(two(), shot('black', ['red']));
    assert.ok(outcome.foul);
    assert.equal(state.players[0]!.group, null);
    assert.equal(state.current, 1);
  });
});

describe('fautes', () => {
  it('toucher la couleur adverse en premier', () => {
    const { state, outcome } = resolveShot(two(['red', 'yellow']), shot('yellow', ['red']));
    assert.ok(outcome.foul);
    assert.equal(state.current, 1);
    assert.equal(state.visits, 2);
    assert.equal(outcome.ballInHand, false);
  });

  it('empocher une bille adverse', () => {
    const { outcome } = resolveShot(two(['red', 'yellow']), shot('red', ['red', 'yellow']));
    assert.ok(outcome.foul);
  });

  it('aucune bille touchée', () => {
    const { outcome } = resolveShot(two(['red', 'yellow']), shot(null));
    assert.ok(outcome.foul);
  });
});

describe('deux coups', () => {
  it('rater le premier des deux coups laisse le second', () => {
    const s = two(['red', 'yellow']);
    s.visits = 2;
    const r1 = resolveShot(s, shot('red'));
    assert.equal(r1.state.current, 0);
    assert.equal(r1.state.visits, 1);
    assert.equal(r1.outcome.continues, true);
    const r2 = resolveShot(r1.state, shot('red'));
    assert.equal(r2.state.current, 1);
    assert.equal(r2.state.visits, 1);
  });

  it('empocher ne consomme pas de coup', () => {
    const s = two(['red', 'yellow']);
    s.visits = 2;
    const { state } = resolveShot(s, shot('red', ['red']));
    assert.equal(state.visits, 2);
    assert.equal(state.current, 0);
  });
});

describe('la noire (2 joueurs)', () => {
  it('noire empochée après sa couleur : victoire', () => {
    const s = two(['red', 'yellow']);
    s.onTable.red = 0;
    assert.deepEqual(legalTargets(s, 0), ['black']);
    const { state, outcome } = resolveShot(s, shot('black', ['black']));
    assert.equal(state.winner, 0);
    assert.equal(outcome.winner, 0);
  });

  it('noire empochée trop tôt : défaite', () => {
    const { state } = resolveShot(two(['red', 'yellow']), shot('red', ['black']));
    assert.equal(state.winner, 1);
  });

  it('dernière couleur et noire dans le même coup : défaite', () => {
    const s = two(['red', 'yellow']);
    s.onTable.red = 1;
    const { state } = resolveShot(s, shot('red', ['red', 'black']));
    assert.equal(state.winner, 1);
  });

  it('noire empochée avec la blanche : défaite', () => {
    const s = two(['red', 'yellow']);
    s.onTable.red = 0;
    const { state } = resolveShot(s, shot('black', ['black'], true));
    assert.equal(state.winner, 1);
  });

  it('sur la noire, toucher une autre bille est une faute', () => {
    const s = two(['red', 'yellow']);
    s.onTable.red = 0;
    const { state, outcome } = resolveShot(s, shot('yellow'));
    assert.ok(outcome.foul);
    assert.equal(state.current, 1);
  });
});

describe('trois joueurs', () => {
  it('chaque joueur reçoit une couleur, la dernière est automatique', () => {
    const r1 = resolveShot(three(), shot('blue', ['blue']));
    assert.equal(r1.state.players[0]!.group, 'blue');
    assert.equal(r1.state.players[1]!.group, null);
    // Anna rate, Bob prend les rouges, Chloé reçoit les jaunes
    const r2 = resolveShot(r1.state, shot('blue'));
    assert.equal(r2.state.current, 1);
    const r3 = resolveShot(r2.state, shot('red', ['red']));
    assert.equal(r3.state.players[1]!.group, 'red');
    assert.equal(r3.state.players[2]!.group, 'yellow');
  });

  it('table ouverte : toucher la couleur d’un autre joueur est une faute', () => {
    const s = three(['blue', null, null]);
    s.current = 1;
    const { outcome, state } = resolveShot(s, shot('blue', ['red']));
    assert.ok(outcome.foul);
    assert.equal(state.players[1]!.group, null);
    assert.equal(state.current, 2);
  });

  it('noire trop tôt : élimination, couleur retirée, la partie continue', () => {
    const s = three(['red', 'yellow', 'blue']);
    s.current = 1;
    const { state, outcome } = resolveShot(s, shot('yellow', ['black']));
    assert.equal(outcome.eliminated, 1);
    assert.equal(state.winner, null);
    assert.deepEqual(outcome.removeGroups, ['yellow']);
    assert.equal(outcome.respotBlack, true);
    assert.equal(state.current, 2);
    assert.equal(state.visits, 2);
    assert.deepEqual(state.groups, ['red', 'blue']);
  });

  it('élimination d’un joueur sans couleur : la couleur orpheline disparaît', () => {
    const s = three(['red', 'yellow', null]);
    s.current = 2;
    const { state, outcome } = resolveShot(s, shot('blue', ['black']));
    assert.equal(outcome.eliminated, 2);
    assert.deepEqual(outcome.removeGroups, ['blue']);
    assert.equal(state.onTable.blue, 0);
  });

  it('après une élimination, perdre sur la noire donne la victoire au dernier', () => {
    const s = three(['red', 'yellow', 'blue']);
    s.players[1]!.eliminated = true;
    s.groups = ['red', 'blue'];
    s.onTable.yellow = 0;
    s.current = 2;
    const { state } = resolveShot(s, shot('blue', ['black']));
    assert.equal(state.winner, 0);
  });

  it('les tours sautent les joueurs éliminés', () => {
    const s = three(['red', 'yellow', 'blue']);
    s.players[1]!.eliminated = true;
    const { state } = resolveShot(s, shot('red'));
    assert.equal(state.current, 2);
  });

  it('victoire à trois joueurs', () => {
    const s = three(['red', 'yellow', 'blue']);
    s.current = 2;
    s.onTable.blue = 0;
    const { state } = resolveShot(s, shot('black', ['black']));
    assert.equal(state.winner, 2);
  });
});
