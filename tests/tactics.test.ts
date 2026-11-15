import { describe, expect, it } from 'vitest';
import { Sim, type TeamPlan } from '../src/sim/sim';
import { MAPS, type Objective } from '../src/sim/map';
import { RULES, type Team, type UnitType } from '../src/sim/config';
import type { Tile } from '../src/sim/map';
import { field } from './helpers';

type Spec = { type: UnitType; at: [number, number]; to?: [number, number] };

/** Run a scripted engagement on an open field n times; returns team 0's win rate. */
function engage(a: Spec[], b: Spec[], n = 20, paint?: (set: (x: number, y: number, t: Tile) => void) => void): number {
  const m = field(30, 11, paint);
  let wins = 0;
  for (let s = 0; s < n; s++) {
    const plan = (team: Team, specs: Spec[]): TeamPlan => ({
      units: specs.map((sp, i) => ({
        id: `${team}-${i}`, type: sp.type, spawn: { x: sp.at[0], y: sp.at[1] },
        waypoints: sp.to ? [{ x: sp.to[0], y: sp.to[1], code: null }] : [],
      })),
      defenses: [],
    });
    const sim = new Sim(m, [plan(0, a), plan(1, b)], 300 + s);
    while (!sim.result) sim.step();
    if (sim.result.winner === 0) wins++;
  }
  return wins / n;
}

describe('movement and overwatch', () => {
  it('a settled rifleman ambushes one that walks into it', () => {
    // Team 0 waits; team 1 walks across open ground toward it.
    const run = () => engage([{ type: 'rifleman', at: [8, 5] }], [{ type: 'rifleman', at: [24, 5], to: [3, 5] }], 60);
    const withRules = run();
    const saved = { ...RULES };
    Object.assign(RULES, { exposedAccuracy: 1, overwatchAccuracy: 1, overwatchDamage: 1, exposedSeconds: 0 });
    const without = run();
    Object.assign(RULES, saved);
    console.log(`ambush win rate: ${withRules} with overwatch rules, ${without} without`);
    expect(withRules).toBeGreaterThanOrEqual(0.75);
    expect(withRules).toBeGreaterThan(without + 0.15);
  });

  it('overwatch is not a free win against numbers', () => {
    // 2v1: numbers should still matter, the ambush only evens it up a bit.
    const rate = engage([{ type: 'rifleman', at: [8, 5] }], [
      { type: 'rifleman', at: [24, 4], to: [3, 4] },
      { type: 'rifleman', at: [24, 6], to: [3, 6] },
    ], 40);
    expect(rate).toBeLessThan(0.6);
  });

  it('covering fire: a settled sniper punishes an ambusher that reveals itself by firing', () => {
    // A rifleman hides in a copse beside the road. Team 0's rifleman has to walk past it.
    const copse = (set: (x: number, y: number, t: Tile) => void) => {
      for (let x = 14; x <= 16; x++) for (let y = 1; y <= 3; y++) set(x, y, 'forest');
    };
    const ambusher: Spec[] = [{ type: 'rifleman', at: [15, 2] }];
    const mover: Spec = { type: 'rifleman', at: [3, 6], to: [27, 6] };
    // Alone, and with a sniper walking alongside (both exposed when the ambush springs).
    const alone = engage([mover], ambusher, 40, copse);
    const together = engage([mover, { type: 'sniper', at: [3, 8], to: [27, 8] }], ambusher, 40, copse);
    // Covered: the sniper sets up first, out of the ambusher's range, and watches the road.
    const covered = engage([mover, { type: 'sniper', at: [8, 9] }], ambusher, 40, copse);
    console.log(`mover alone ${alone}, sniper tagging along ${together}, sniper on overwatch ${covered}`);
    expect(covered).toBeGreaterThan(alone + 0.3);
    expect(covered).toBeGreaterThan(together);
  });

  it('moving units lose their garrison protection', () => {
    const m = MAPS.riverside;
    const sim = new Sim(m, [
      { units: [{ id: '0-a', type: 'rifleman', spawn: { x: 13, y: 7 }, waypoints: [{ x: 14, y: 6, code: null }, { x: 13, y: 7, code: null }] }], defenses: [] },
      { units: [{ id: '1-a', type: 'rifleman', spawn: { x: 30, y: 2 }, waypoints: [] }], defenses: [] },
    ], 1);
    sim.step();
    const u = sim.units[0];
    expect(sim.isExposed(u)).toBe(true);
    for (let i = 0; i < 60; i++) sim.step();
    expect(sim.isExposed(u)).toBe(false);
    expect(sim.isOverwatching(u)).toBe(true);
  });
});

describe('objectives', () => {
  const obj: Objective = { id: 'mid', name: 'Mid', x: 15, y: 5.5, r: 2, from: 2, to: 6 };
  const later: Objective = { ...obj, from: 9, to: 13 };
  const withObj = () => ({ ...field(30, 11), objectives: [obj] });

  it('scores a second per second held uncontested while live, and decides the round on time', () => {
    const m = withObj();
    const sim = new Sim(m, [
      { units: [{ id: '0-a', type: 'rifleman', spawn: { x: 14, y: 5 }, waypoints: [] }], defenses: [] },
      { units: [{ id: '1-a', type: 'rifleman', spawn: { x: 27, y: 9 }, waypoints: [{ x: 28, y: 9, code: null }] }], defenses: [] },
    ], 1);
    while (!sim.result) sim.step();
    expect(sim.result.score[0]).toBe(4);
    expect(sim.result.score[1]).toBe(0);
    expect(sim.result.winner).toBe(0);
  });

  it('contested objectives score for nobody', () => {
    const m = withObj();
    const sim = new Sim(m, [
      { units: [{ id: '0-a', type: 'tank', spawn: { x: 14, y: 5 }, waypoints: [] }], defenses: [] },
      { units: [{ id: '1-a', type: 'tank', spawn: { x: 16, y: 5 }, waypoints: [] }], defenses: [] },
    ], 1);
    for (let i = 0; i < 20 * 5; i++) sim.step();
    expect(sim.score[0] + sim.score[1]).toBe(0);
  });

  it('a unit parked on a future objective is credited when the round ends early', () => {
    const m = { ...field(30, 11), objectives: [later] };
    const sim = new Sim(m, [
      { units: [{ id: '0-a', type: 'rifleman', spawn: { x: 3, y: 5 }, waypoints: [{ x: 15, y: 5, code: null }] }], defenses: [] },
      { units: [{ id: '1-a', type: 'rifleman', spawn: { x: 27, y: 9 }, waypoints: [] }], defenses: [] },
    ], 1);
    while (!sim.result) sim.step();
    expect(sim.result.winner).toBe(0);
    expect(sim.result.score[0]).toBe(4);
    expect(sim.result.ticks).toBeLessThan(9 * 20); // ended before the window even opened
  });
});
