import { describe, expect, it } from 'vitest';
import { MAPS, passable, tileAt, key, type GameMap, type Pt } from '../src/sim/map';
import { duel, field } from './helpers';
import { findPath } from '../src/sim/path';
import { Sim, type TeamPlan, type Command } from '../src/sim/sim';
import { Match } from '../src/sim/match';
import { planAi, AiDirector } from '../src/sim/ai';
import { RULES, type Team, type UnitType } from '../src/sim/config';
import { hasLos } from '../src/sim/los';

function runRound(m: GameMap, match: Match, seed: number) {
  const p0 = planAi(m, 0, match, seed * 7 + 1);
  const p1 = planAi(m, 1, match, seed * 7 + 2);
  match.teams[0].money -= p0.spent;
  match.teams[1].money -= p1.spent;
  const sim = new Sim(m, [p0.plan, p1.plan], seed);
  const ai = [new AiDirector(0, seed + 11), new AiDirector(1, seed + 12)];
  while (!sim.result) sim.step([...ai[0].think(sim), ...ai[1].think(sim)]);
  return sim;
}

describe('maps', () => {
  for (const m of Object.values(MAPS)) {
    it(`${m.id}: point-symmetric`, () => {
      for (let y = 0; y < m.h; y++)
        for (let x = 0; x < m.w; x++) expect(tileAt(m, x, y)).toBe(tileAt(m, m.w - 1 - x, m.h - 1 - y));
    });
    it(`${m.id}: every foot tile reachable; vehicles can reach the enemy base`, () => {
      const start: Pt = { x: 3, y: Math.floor(m.bases[0].y) };
      const seen = new Set([key(start.x, start.y)]);
      const q = [start];
      while (q.length) {
        const c = q.pop()!;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const n = { x: c.x + dx, y: c.y + dy };
          if (passable(tileAt(m, n.x, n.y)) && !seen.has(key(n.x, n.y))) { seen.add(key(n.x, n.y)); q.push(n); }
        }
      }
      for (let y = 0; y < m.h; y++)
        for (let x = 0; x < m.w; x++) if (passable(tileAt(m, x, y))) expect(seen.has(key(x, y))).toBe(true);
      const goal = { x: m.w - 4, y: Math.floor(m.bases[1].y) };
      expect(findPath(m, start, goal, undefined, 'vehicle')).not.toBeNull();
    });
  }
  it('vehicles cannot enter buildings, forest or fords', () => {
    const m = MAPS.riverside;
    expect(findPath(m, { x: 6, y: 7 }, { x: 13, y: 7 }, undefined, 'vehicle')).toBeNull(); // warehouse interior
    expect(findPath(m, { x: 6, y: 7 }, { x: 13, y: 7 }, undefined, 'foot')).not.toBeNull();
  });
  it('windows let you shoot out but not see deep inside', () => {
    const m = MAPS.riverside;
    // Window at (16,6). A unit at the window sees out; one deep inside at (12,7) cannot be seen from outside.
    expect(hasLos(m, 15.5, 6.5, 18.5, 6.5)).toBe(true);
    expect(hasLos(m, 12.5, 6.5, 18.5, 6.5)).toBe(false);
  });
});

describe('rock-paper-scissors', () => {
  it('tank beats an equal-cost rifle squad', () => {
    expect(duel(['tank'], ['rifleman', 'rifleman', 'rifleman', 'rifleman'])).toBeGreaterThanOrEqual(0.8);
  });
  it('tank beats gunners', () => {
    expect(duel(['tank'], ['gunner', 'gunner'])).toBeGreaterThanOrEqual(0.8);
  });
  it('two rocketeers ($700) trade with a tank ($900); three beat it', () => {
    const two = duel(['rocketeer', 'rocketeer'], ['tank'], 20);
    expect(two).toBeGreaterThanOrEqual(0.2);
    expect(two).toBeLessThanOrEqual(0.7);
    expect(duel(['rocketeer', 'rocketeer', 'rocketeer'], ['tank'])).toBeGreaterThanOrEqual(0.75);
  });
  it('riflemen beat rocketeers', () => {
    expect(duel(['rifleman', 'rifleman', 'rifleman'], ['rocketeer', 'rocketeer'])).toBeGreaterThanOrEqual(0.75);
  });
  it('tank plus infantry escort beats rocketeers', () => {
    expect(duel(['tank', 'rifleman', 'rifleman'], ['rocketeer', 'rocketeer', 'rocketeer', 'rocketeer'])).toBeGreaterThanOrEqual(0.6);
  });
  it('buildings protect against rifles but not tank shells', () => {
    // Defender garrisoned inside a small building vs attacker in the open.
    const m = field(30, 9, (set) => {
      for (let x = 14; x <= 18; x++) { set(x, 2, 'wall'); set(x, 6, 'wall'); }
      for (let y = 2; y <= 6; y++) { set(14, y, 'wall'); set(18, y, 'wall'); }
      for (let x = 15; x <= 17; x++) for (let y = 3; y <= 5; y++) set(x, y, 'interior');
      set(14, 4, 'window');
    });
    const hpLoss = (attacker: UnitType) => {
      const sim = new Sim(m, [
        { units: [{ id: '0-a', type: attacker, spawn: { x: 11, y: 4 }, waypoints: [] }], defenses: [] },
        { units: [{ id: '1-d', type: 'rifleman', spawn: { x: 15, y: 4 }, waypoints: [] }], defenses: [] },
      ], 5);
      const d = sim.units[1];
      // make the defender passive so we measure incoming damage only
      d.cooldown = 1e9;
      for (let i = 0; i < 60 && d.state !== 'dead'; i++) { d.cooldown = 1e9; sim.step(); }
      return 100 - Math.max(0, d.hp);
    };
    const outside = (() => {
      const sim = new Sim(m, [
        { units: [{ id: '0-a', type: 'rifleman', spawn: { x: 9, y: 7 }, waypoints: [] }], defenses: [] },
        { units: [{ id: '1-d', type: 'rifleman', spawn: { x: 13, y: 7 }, waypoints: [] }], defenses: [] },
      ], 5);
      const d = sim.units[1];
      for (let i = 0; i < 60 && d.state !== 'dead'; i++) { d.cooldown = 1e9; sim.step(); }
      return 100 - Math.max(0, d.hp);
    })();
    const rifleVsGarrison = hpLoss('rifleman');
    expect(rifleVsGarrison).toBeGreaterThan(0);
    expect(rifleVsGarrison).toBeLessThan(outside * 0.7);
    expect(hpLoss('tank')).toBeGreaterThan(rifleVsGarrison * 1.5); // HE ignores the garrison bonus
  });
});

describe('sim', () => {
  const m = MAPS.crossroads;
  it('is deterministic for the same seed and commands', () => {
    const a = runRound(MAPS.riverside, new Match(), 42);
    const b = runRound(MAPS.riverside, new Match(), 42);
    expect(a.result).toEqual(b.result);
    expect(a.units.map((u) => [u.x, u.y, u.hp])).toEqual(b.units.map((u) => [u.x, u.y, u.hp]));
  });

  it('go codes release every unit holding on that code, and later arrivals pass through', () => {
    const sim = new Sim(m, [
      { units: [
        { id: '0-u1', type: 'rifleman', spawn: { x: 3, y: 10 }, waypoints: [{ x: 8, y: 10, code: 'A' }, { x: 10, y: 2, code: null }] },
        { id: '0-u2', type: 'rifleman', spawn: { x: 3, y: 8 }, waypoints: [{ x: 8, y: 8, code: 'A' }, { x: 10, y: 2, code: null }] },
        { id: '0-u3', type: 'gunner', spawn: { x: 1, y: 12 }, waypoints: [{ x: 8, y: 12, code: 'A' }, { x: 10, y: 2, code: null }] },
        { id: '0-u4', type: 'rifleman', spawn: { x: 3, y: 11 }, waypoints: [{ x: 6, y: 11, code: 'B' }] },
      ], defenses: [] },
      { units: [{ id: '1-u1', type: 'rifleman', spawn: { x: 33, y: 2 }, waypoints: [] }], defenses: [] },
    ], 9);
    for (let i = 0; i < 50; i++) sim.step();
    const [u1, u2, u3, u4] = sim.units;
    expect(u1.state).toBe('holding');
    expect(u2.state).toBe('holding');
    expect(u3.state).toBe('moving'); // slow gunner still en route
    expect(u4.holdCode).toBe('B');
    sim.step([{ team: 0, kind: 'code', code: 'A' }]);
    expect(u1.state).toBe('moving');
    expect(u2.state).toBe('moving');
    expect(u4.state).toBe('holding'); // different code
    for (let i = 0; i < 60; i++) sim.step();
    expect(u3.state === 'moving' || u3.state === 'done').toBe(true); // passed the already-called breakpoint
    expect(u3.pi).toBeGreaterThan(6);
  });

  it('ends in a draw when everyone is recalled', () => {
    const plan = (t: Team): TeamPlan => ({
      units: [{ id: `${t}-u1`, type: 'rifleman', spawn: t === 0 ? { x: 3, y: 10 } : { x: 32, y: 9 }, waypoints: [{ x: t === 0 ? 10 : 25, y: 2, code: null }] }],
      defenses: [],
    });
    const sim = new Sim(m, [plan(0), plan(1)], 1);
    for (let i = 0; i < 20; i++) sim.step();
    const cmds: Command[] = [{ team: 0, kind: 'recall', unitId: '0-u1' }, { team: 1, kind: 'recall', unitId: '1-u1' }];
    sim.step(cmds);
    while (!sim.result) sim.step();
    expect(sim.result.winner).toBeNull();
    expect(sim.result.reason).toBe('Everyone pulled back');
  });

  it('a lone breacher can destroy an undefended base', () => {
    const sim = new Sim(m, [
      { units: [{ id: '0-u1', type: 'breacher', spawn: { x: 30, y: 9 }, waypoints: [{ x: 33, y: 9, code: null }] }], defenses: [] },
      { units: [{ id: '1-u1', type: 'rifleman', spawn: { x: 20, y: 1 }, waypoints: [] }], defenses: [] },
    ], 3);
    while (!sim.result) sim.step();
    expect(sim.result.winner).toBe(0);
    expect(sim.result.reason).toBe('Base destroyed');
  });

  it('tank traps stop tanks but not infantry', () => {
    const fm = field();
    const sim = new Sim(fm, [
      { units: [
        { id: '0-t', type: 'tank', spawn: { x: 3, y: 2 }, waypoints: [{ x: 20, y: 2, code: null }] },
        { id: '0-r', type: 'rifleman', spawn: { x: 3, y: 4 }, waypoints: [{ x: 20, y: 4, code: null }] },
      ], defenses: [] },
      { units: [{ id: '1-u', type: 'rifleman', spawn: { x: 27, y: 7 }, waypoints: [] }],
        defenses: [{ type: 'tanktrap', x: 10, y: 2 }, { type: 'tanktrap', x: 10, y: 4 }] },
    ], 2);
    for (let i = 0; i < 100; i++) sim.step();
    expect(sim.units[0].x).toBeLessThan(10); // tank stuck shelling the trap
    expect(sim.units[1].x).toBeGreaterThan(11); // rifleman walked through
  });
});

describe('AI vs AI', () => {
  for (const id of ['riverside', 'crossroads']) {
    it(`${id}: full matches terminate with sane outcomes`, () => {
      const m = MAPS[id];
      const tally = { w0: 0, w1: 0, d: 0, reasons: {} as Record<string, number>, rounds: 0, avgSecs: 0, tanks: 0, tankWins: 0 };
      for (let g = 0; g < 16; g++) {
        const match = new Match();
        let seed = g * 1000;
        while (match.winner === undefined) {
          const sim = runRound(m, match, seed++);
          const r = sim.result!;
          tally.reasons[r.reason] = (tally.reasons[r.reason] ?? 0) + 1;
          tally.rounds++;
          tally.avgSecs += r.ticks / RULES.tickRate;
          for (const t of [0, 1] as Team[]) if (r.fielded[t].includes('tank')) { tally.tanks++; if (r.winner === t) tally.tankWins++; }
          match.finishRound(r);
          for (const t of [0, 1] as Team[]) expect(match.teams[t].money).toBeGreaterThanOrEqual(0);
        }
        if (match.winner === 0) tally.w0++; else if (match.winner === 1) tally.w1++; else tally.d++;
      }
      tally.avgSecs = Math.round(tally.avgSecs / tally.rounds);
      console.log(id, JSON.stringify(tally));
      expect(tally.w0 + tally.w1 + tally.d).toBe(16);
    });
  }
});
