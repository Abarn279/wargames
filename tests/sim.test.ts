import { describe, expect, it } from 'vitest';
import { MAPS, isWalkable, tileAt, key, type Pt } from '../src/sim/map';
import { findPath } from '../src/sim/path';
import { Sim, type TeamPlan, type Command } from '../src/sim/sim';
import { Match } from '../src/sim/match';
import { planAi, AiDirector } from '../src/sim/ai';
import { RULES, type Team } from '../src/sim/config';

const m = MAPS.crossroads;

function runRound(match: Match, seed: number) {
  const p0 = planAi(m, 0, match, seed * 7 + 1);
  const p1 = planAi(m, 1, match, seed * 7 + 2);
  match.teams[0].money -= p0.spent;
  match.teams[1].money -= p1.spent;
  const sim = new Sim(m, [p0.plan, p1.plan], seed);
  const ai = [new AiDirector(0, seed + 11), new AiDirector(1, seed + 12)];
  while (!sim.result) sim.step([...ai[0].think(sim), ...ai[1].think(sim)]);
  return sim;
}

describe('map', () => {
  it('is point-symmetric', () => {
    for (let y = 0; y < m.h; y++)
      for (let x = 0; x < m.w; x++) expect(tileAt(m, x, y)).toBe(tileAt(m, m.w - 1 - x, m.h - 1 - y));
  });
  it('every walkable tile is reachable from the west deploy zone', () => {
    const start: Pt = { x: 3, y: 10 };
    const seen = new Set([key(start.x, start.y)]);
    const q = [start];
    while (q.length) {
      const c = q.pop()!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = { x: c.x + dx, y: c.y + dy };
        if (isWalkable(tileAt(m, n.x, n.y)) && !seen.has(key(n.x, n.y))) { seen.add(key(n.x, n.y)); q.push(n); }
      }
    }
    for (let y = 0; y < m.h; y++)
      for (let x = 0; x < m.w; x++) if (isWalkable(tileAt(m, x, y))) expect(seen.has(key(x, y))).toBe(true);
  });
  it('finds a path base to base', () => {
    expect(findPath(m, { x: 3, y: 10 }, { x: 32, y: 9 })?.length).toBeGreaterThan(25);
  });
});

describe('sim', () => {
  it('is deterministic for the same seed and commands', () => {
    const a = runRound(new Match(), 42);
    const b = runRound(new Match(), 42);
    expect(a.result).toEqual(b.result);
    expect(a.units.map((u) => [u.x, u.y, u.hp])).toEqual(b.units.map((u) => [u.x, u.y, u.hp]));
  });

  it('ends in a draw when everyone is recalled', () => {
    const match = new Match();
    const plan = (t: Team): TeamPlan => ({
      units: [{ id: `${t}-u1`, type: 'rifleman', spawn: t === 0 ? { x: 3, y: 10 } : { x: 32, y: 9 }, waypoints: [{ x: t === 0 ? 10 : 25, y: 2, hold: false }] }],
      defenses: [],
    });
    void match;
    const sim = new Sim(m, [plan(0), plan(1)], 1);
    for (let i = 0; i < 20; i++) sim.step();
    const cmds: Command[] = [{ team: 0, unitId: '0-u1', kind: 'recall' }, { team: 1, unitId: '1-u1', kind: 'recall' }];
    sim.step(cmds);
    while (!sim.result) sim.step();
    expect(sim.result.winner).toBeNull();
    expect(sim.result.reason).toBe('Everyone pulled back');
    // Recalled units can't be sent back out
    expect(sim.units.every((u) => u.state === 'home')).toBe(true);
  });

  it('a lone breacher can destroy an undefended base', () => {
    const sim = new Sim(m, [
      { units: [{ id: '0-u1', type: 'breacher', spawn: { x: 30, y: 9 }, waypoints: [{ x: 33, y: 9, hold: false }] }], defenses: [] },
      { units: [{ id: '1-u1', type: 'rifleman', spawn: { x: 20, y: 1 }, waypoints: [] }], defenses: [] },
    ], 3);
    while (!sim.result) sim.step();
    expect(sim.result.winner).toBe(0);
    expect(sim.result.reason).toBe('Base destroyed');
  });

  it('a defender near the base makes it invulnerable', () => {
    const sim = new Sim(m, [
      { units: [{ id: '0-u1', type: 'breacher', spawn: { x: 30, y: 9 }, waypoints: [{ x: 33, y: 9, hold: false }] }], defenses: [] },
      { units: [{ id: '1-u1', type: 'gunner', spawn: { x: 33, y: 13 }, waypoints: [] }], defenses: [{ type: 'barricade', x: 33, y: 12 }] },
    ], 3);
    for (let i = 0; i < 40 && !sim.result; i++) {
      sim.step();
      expect(sim.bases[1].hp).toBe(RULES.baseHp);
    }
  });
});

describe('AI vs AI', () => {
  it('plays full matches that terminate with sane outcomes', () => {
    const tally = { w0: 0, w1: 0, d: 0, reasons: {} as Record<string, number>, rounds: 0, avgSecs: 0 };
    for (let g = 0; g < 20; g++) {
      const match = new Match();
      let seed = g * 1000;
      while (match.winner === undefined) {
        const sim = runRound(match, seed++);
        const r = sim.result!;
        tally.reasons[r.reason] = (tally.reasons[r.reason] ?? 0) + 1;
        tally.rounds++;
        tally.avgSecs += r.ticks / RULES.tickRate;
        match.finishRound(r);
        for (const t of [0, 1] as Team[]) expect(match.teams[t].money).toBeGreaterThanOrEqual(0);
      }
      if (match.winner === 0) tally.w0++; else if (match.winner === 1) tally.w1++; else tally.d++;
    }
    tally.avgSecs /= tally.rounds;
    console.log(JSON.stringify(tally));
    expect(tally.w0 + tally.w1 + tally.d).toBe(20);
  });
});
