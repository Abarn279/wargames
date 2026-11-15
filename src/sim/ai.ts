import { RULES, UNITS, DEFENSES, other, type Team, type UnitType, type DefenseType } from './config';
import { type GameMap, type Pt, canDeployUnit, canFortify, key, mirrorTile, nearestWalkable } from './map';
import { findPath, type Waypoint } from './path';
import { Rng } from './rng';
import { ownBlocked, type Command, type DefensePlan, type Sim, type TeamPlan, type UnitPlan } from './sim';
import type { Match } from './match';

// All AI positions are authored from the west (team 0) side and mirrored for team 1.
const LANES: Pt[][] = [
  [{ x: 12, y: 1 }, { x: 23, y: 1 }, { x: 31, y: 5 }, { x: 33, y: 9 }],
  [{ x: 13, y: 10 }, { x: 22, y: 10 }, { x: 33, y: 10 }],
  [{ x: 12, y: 18 }, { x: 23, y: 18 }, { x: 31, y: 14 }, { x: 33, y: 10 }],
];
const HOLD_INDEX = 1; // breakpoint at the far side of midfield
const GUARD_SPOTS: Pt[] = [{ x: 5, y: 9 }, { x: 5, y: 11 }, { x: 4, y: 7 }, { x: 4, y: 12 }];
const TURRET_SPOTS: Pt[] = [{ x: 4, y: 9 }, { x: 4, y: 11 }, { x: 3, y: 7 }, { x: 3, y: 12 }];
const BARRICADE_SPOTS: Pt[] = [{ x: 6, y: 6 }, { x: 6, y: 13 }, { x: 9, y: 9 }, { x: 9, y: 10 }, { x: 7, y: 6 }, { x: 7, y: 13 }];
const MINE_SPOTS: Pt[] = [{ x: 11, y: 2 }, { x: 11, y: 17 }, { x: 13, y: 9 }, { x: 8, y: 4 }, { x: 8, y: 15 }, { x: 14, y: 11 }];

const side = (m: GameMap, team: Team, p: Pt) => (team === 0 ? p : mirrorTile(m, p));

export interface AiPlanResult { plan: TeamPlan; spent: number }

/** Build the AI's purchases, defenses and unit plans for a round. */
export function planAi(m: GameMap, team: Team, match: Match, seed: number): AiPlanResult {
  const rng = new Rng(seed);
  const econ = match.teams[team];
  let money = econ.money;
  const units: UnitPlan[] = econ.roster.map((u) => ({ ...u, waypoints: [] }));

  // --- Defenses first so unit paths route around them ---
  const defenses: DefensePlan[] = [];
  const defBudget = Math.floor(money * (money > 2000 ? 0.25 : 0.1));
  let defSpent = 0;
  const buyDef = (type: DefenseType, spots: Pt[]) => {
    const cost = DEFENSES[type].cost;
    if (defSpent + cost > defBudget || defenses.length >= RULES.maxDefenses) return false;
    const free = spots.map((p) => side(m, team, p)).filter(
      (p) => canFortify(m, team, p.x, p.y) && !defenses.some((d) => d.x === p.x && d.y === p.y),
    );
    if (!free.length) return false;
    const p = rng.pick(free);
    defenses.push({ type, x: p.x, y: p.y });
    defSpent += cost;
    return true;
  };
  if (defBudget >= DEFENSES.turret.cost && rng.next() < 0.7) buyDef('turret', TURRET_SPOTS);
  for (let i = 0; i < 6; i++) {
    const roll = rng.next();
    if (!buyDef(roll < 0.5 ? 'mine' : 'barricade', roll < 0.5 ? MINE_SPOTS : BARRICADE_SPOTS)) break;
  }
  money -= defSpent;

  // --- Units ---
  const weights: [UnitType, number][] = [['rifleman', 4], ['gunner', 2], ['breacher', 3], ['sniper', 1.5]];
  const roll = (): UnitType => {
    const total = weights.reduce((a, [, w]) => a + w, 0);
    let r = rng.next() * total;
    for (const [t, w] of weights) if ((r -= w) <= 0) return t;
    return 'rifleman';
  };
  const target = Math.min(RULES.maxUnits, 5);
  let guard = 0;
  while (units.length < target && guard++ < 40) {
    let t = roll();
    if (UNITS[t].cost > money) t = 'rifleman';
    if (UNITS[t].cost > money) break;
    units.push({ id: match.newUnitId(team), type: t, spawn: { x: 0, y: 0 }, waypoints: [] });
    money -= UNITS[t].cost;
  }

  // --- Spawns ---
  const blocked = ownBlocked(defenses);
  const taken = new Set<number>();
  const zone = m.deploy[team];
  const spawnTiles: Pt[] = [];
  for (let y = 0; y < m.h; y++)
    for (let x = zone.x0; x <= zone.x1; x++)
      if (canDeployUnit(m, team, x, y) && !blocked.has(key(x, y))) spawnTiles.push({ x, y });
  const base = m.bases[team];
  spawnTiles.sort((a, b) => Math.hypot(a.x - base.x, a.y - base.y) - Math.hypot(b.x - base.x, b.y - base.y));
  for (const u of units) {
    const ok = (p: Pt) => !taken.has(key(p.x, p.y)) && spawnTiles.some((s) => s.x === p.x && s.y === p.y);
    if (!ok(u.spawn)) u.spawn = spawnTiles.find(ok) ?? spawnTiles[0];
    taken.add(key(u.spawn.x, u.spawn.y));
  }

  // --- Roles & routes ---
  const order = [...units].sort((a, b) => (a.type === 'gunner' ? -1 : 0) - (b.type === 'gunner' ? -1 : 0));
  const guards = units.length >= 3 ? 1 : 0;
  const lanePicks = [rng.int(0, 2)];
  if (rng.next() < 0.6) lanePicks.push((lanePicks[0] + rng.int(1, 2)) % 3);
  order.forEach((u, i) => {
    if (i < guards) {
      const g = nearestWalkable(m, side(m, team, rng.pick(GUARD_SPOTS)), blocked);
      u.waypoints = [{ ...g, hold: false }];
      return;
    }
    const lane = LANES[lanePicks[i % lanePicks.length]];
    const holds = rng.next() < 0.65;
    const wps: Waypoint[] = lane.map((p, j) => ({ ...nearestWalkable(m, side(m, team, p), blocked), hold: holds && j === HOLD_INDEX }));
    // Drop legs that are unreachable from the spawn (defensive; the map is fully connected).
    u.waypoints = wps.filter((w) => findPath(m, u.spawn, w, blocked) !== null || (w.x === u.spawn.x && w.y === u.spawn.y));
  });

  return { plan: { units, defenses }, spent: econ.money - money };
}

/** Live AI: releases breakpoints with some timing sense and recalls when the base is threatened. */
export class AiDirector {
  private holdSince = new Map<string, number>();
  private patience = new Map<string, number>();
  private lastRecall = -999;
  private rng: Rng;
  constructor(readonly team: Team, seed: number) {
    this.rng = new Rng(seed);
  }

  think(sim: Sim): Command[] {
    if (sim.tick % 5 !== 0) return [];
    const cmds: Command[] = [];
    const mine = sim.alive(this.team);
    const tr = RULES.tickRate;

    // Coordinated release: a held unit goes once its patience runs out,
    // or immediately when every other advancing teammate is also holding.
    const advancing = mine.filter((u) => u.state === 'moving' || u.state === 'holding');
    const allHolding = advancing.length > 0 && advancing.every((u) => u.state === 'holding');
    for (const u of mine) {
      if (u.state !== 'holding') { this.holdSince.delete(u.id); continue; }
      if (!this.holdSince.has(u.id)) {
        this.holdSince.set(u.id, sim.tick);
        this.patience.set(u.id, tr * (2 + this.rng.next() * 5));
      }
      const waited = sim.tick - this.holdSince.get(u.id)!;
      if ((allHolding && waited > tr) || waited >= this.patience.get(u.id)!) cmds.push({ team: this.team, unitId: u.id, kind: 'go' });
    }

    // Emergency audible: enemy spotted near our base and nobody guarding it.
    const seen = sim.visibleTo(this.team);
    const base = sim.bases[this.team];
    const threat = sim.units.some((e) => e.team === other(this.team) && e.state !== 'dead' && seen.has(e.id) && Math.hypot(e.x - base.x, e.y - base.y) < 8);
    if (threat && !sim.baseDefended(this.team) && sim.tick - this.lastRecall > tr * 6) {
      const candidates = mine.filter((u) => u.state === 'moving' || u.state === 'holding' || u.state === 'done');
      candidates.sort((a, b) => Math.hypot(a.x - base.x, a.y - base.y) - Math.hypot(b.x - base.x, b.y - base.y));
      if (candidates.length > 1) { // never pull the last attacker
        cmds.push({ team: this.team, unitId: candidates[0].id, kind: 'recall' });
        this.lastRecall = sim.tick;
      }
    }
    return cmds;
  }
}
