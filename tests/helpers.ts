import { Sim, type TeamPlan } from '../src/sim/sim';
import type { GameMap, Tile } from '../src/sim/map';
import type { Team, UnitType } from '../src/sim/config';

/** A plain open field for isolated matchups. */
export function field(w = 30, h = 9, paint?: (set: (x: number, y: number, t: Tile) => void) => void): GameMap {
  const tiles: Tile[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tiles.push(x === 0 || y === 0 || x === w - 1 || y === h - 1 ? 'wall' : 'floor');
  paint?.((x, y, t) => { tiles[y * w + x] = t; });
  return {
    id: 'field', name: 'Field', blurb: '', w, h, tiles,
    bases: [{ x: 1.5, y: 1 }, { x: w - 1.5, y: h - 1 }],
    deploy: [{ x0: 1, x1: 5 }, { x0: w - 6, x1: w - 2 }],
    fortify: [{ x0: 1, x1: 10 }, { x0: w - 11, x1: w - 2 }],
    ai: { lanes: [], guard: [], garrison: [], turret: [], barricade: [], tanktrap: [], mine: [] },
  };
}

/** Two squads advance at each other across open ground; returns how often team 0 wins out of n. */
export function duel(a: UnitType[], b: UnitType[], n = 12): number {
  const m = field();
  let wins = 0;
  for (let s = 0; s < n; s++) {
    const squad = (team: Team, types: UnitType[]): TeamPlan => ({
      units: types.map((t, i) => ({
        id: `${team}-u${i}`, type: t,
        spawn: { x: team === 0 ? 3 : 26, y: 2 + i },
        waypoints: [{ x: team === 0 ? 26 : 3, y: 2 + i, code: null }],
      })),
      defenses: [],
    });
    const sim = new Sim(m, [squad(0, a), squad(1, b)], 1000 + s);
    while (!sim.result) sim.step();
    if (sim.result.winner === 0) wins++;
  }
  return wins / n;
}

