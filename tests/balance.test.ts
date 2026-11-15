import { it } from 'vitest';
import { duel } from './helpers';
import { UNITS, type UnitType } from '../src/sim/config';

// Prints a matchup table for the current stats. Not an assertion: run it after tuning config.ts.
const R: UnitType = 'rifleman', G: UnitType = 'gunner', A: UnitType = 'rocketeer', T: UnitType = 'tank';
const S: UnitType = 'sniper', M: UnitType = 'medic', B: UnitType = 'breacher';
const MATCHUPS: [UnitType[], UnitType[]][] = [
  [[T], [R, R, R, R]], [[T], [G, G]], [[A, A], [T]], [[A, A, A], [T]], [[R, R, R], [A, A]],
  [[T, R, R], [A, A, A, A]], [[T, R], [A, A, R, R]], [[G, G], [R, R, R, R]], [[S, R], [R, R, R]],
  [[R, R, R, M], [R, R, R, R]], [[B, B], [R, R, R]],
];

it('balance table', () => {
  const cost = (u: UnitType[]) => u.reduce((a, t) => a + UNITS[t].cost, 0);
  const name = (u: UnitType[]) => u.map((t) => UNITS[t].short).join('');
  const rows = MATCHUPS.map(([a, b]) =>
    `  ${name(a).padStart(5)} $${String(cost(a)).padEnd(5)} vs ${name(b).padEnd(5)} $${String(cost(b)).padEnd(5)} -> ${(duel(a, b, 20) * 100).toFixed(0).padStart(3)}%`);
  console.log('Open-field win rate for the left side:\n' + rows.join('\n'));
});
