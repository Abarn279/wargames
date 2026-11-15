import { RULES, UNITS, DEFENSES, GO_CODES, other, type Team, type UnitType, type DefenseType, type GoCode } from './config';
import { type GameMap, type Pt, canDeployUnit, canFortify, key, mirrorTile, nearestWalkable } from './map';
import { findPath, type Waypoint } from './path';
import { Rng } from './rng';
import { ownBlocked, type Command, type DefensePlan, type Sim, type TeamPlan, type UnitPlan } from './sim';
import type { Match } from './match';

const side = (m: GameMap, team: Team, p: Pt) => (team === 0 ? p : mirrorTile(m, p));

export interface AiPlanResult { plan: TeamPlan; spent: number }

/** Build the AI's purchases, defenses and unit plans for a round. Reacts to what the enemy fielded last round. */
export function planAi(m: GameMap, team: Team, match: Match, seed: number): AiPlanResult {
  const rng = new Rng(seed);
  const econ = match.teams[team];
  let money = econ.money;
  const units: UnitPlan[] = econ.roster.map((u) => ({ ...u, waypoints: [] }));
  const intel = match.lastFielded[other(team)];
  const count = (types: UnitType[], t: UnitType) => types.filter((x) => x === t).length;
  const enemyTanks = count(intel, 'tank');
  const enemyAT = count(intel, 'rocketeer');

  // --- Defenses first so unit paths route around them ---
  const defenses: DefensePlan[] = [];
  const defBudget = Math.floor(money * (money > 2200 ? 0.22 : 0.08));
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
  if (enemyTanks) { buyDef('tanktrap', m.ai.tanktrap); buyDef('mine', m.ai.mine); }
  else if (defBudget >= DEFENSES.turret.cost && rng.next() < 0.6) buyDef('turret', m.ai.turret);
  for (let i = 0; i < 6; i++) {
    const roll = rng.next();
    const [type, spots]: [DefenseType, Pt[]] = roll < 0.45 ? ['mine', m.ai.mine] : roll < 0.8 ? ['barricade', m.ai.barricade] : ['tanktrap', m.ai.tanktrap];
    if (!buyDef(type, spots)) break;
  }
  money -= defSpent;

  // --- Units ---
  const buy = (t: UnitType) => {
    const owned = units.filter((u) => u.type === t).length;
    if (UNITS[t].cost > money || units.length >= RULES.maxUnits || owned >= (UNITS[t].maxPerTeam ?? 99)) return false;
    units.push({ id: match.newUnitId(team), type: t, spawn: { x: -1, y: -1 }, waypoints: [] });
    money -= UNITS[t].cost;
    return true;
  };
  const tankOdds = enemyAT >= 2 ? 0.2 : intel.length && !enemyAT ? 0.7 : 0.45;
  if (money >= UNITS.tank.cost + 400 && rng.next() < tankOdds) buy('tank');
  for (let i = 0; i < Math.min(2, enemyTanks * 2); i++) buy('rocketeer');
  const weights: [UnitType, number][] = [['rifleman', 4], ['gunner', 2], ['breacher', 2], ['sniper', 1.2], ['medic', 1], ['rocketeer', 0.6]];
  const roll = (): UnitType => {
    const total = weights.reduce((a, [, w]) => a + w, 0);
    let r = rng.next() * total;
    for (const [t, w] of weights) if ((r -= w) <= 0) return t;
    return 'rifleman';
  };
  for (let guard = 0; units.length < 5 && guard < 40; guard++) {
    if (!buy(roll()) && !buy('rifleman')) break;
  }

  // --- Spawns (closest free tile to base that the unit's movement class can use) ---
  const taken = new Set<number>();
  const zone = m.deploy[team];
  const base = m.bases[team];
  for (const u of units) {
    const cls = UNITS[u.type].move;
    const blocked = ownBlocked(defenses, cls);
    const ok = (p: Pt) => canDeployUnit(m, team, p.x, p.y, cls) && !blocked.has(key(p.x, p.y)) && !taken.has(key(p.x, p.y)) && !defenses.some((d) => d.x === p.x && d.y === p.y);
    if (!ok(u.spawn)) {
      const tiles: Pt[] = [];
      for (let y = 0; y < m.h; y++) for (let x = zone.x0; x <= zone.x1; x++) if (ok({ x, y })) tiles.push({ x, y });
      tiles.sort((a, b) => Math.hypot(a.x - base.x, a.y - base.y) - Math.hypot(b.x - base.x, b.y - base.y));
      u.spawn = tiles[0] ?? u.spawn;
    }
    taken.add(key(u.spawn.x, u.spawn.y));
  }

  // --- Roles & routes ---
  const vehicleLanes = m.ai.lanes.map((l, i) => (l.vehicle ? i : -1)).filter((i) => i >= 0);
  const hasTank = units.some((u) => u.type === 'tank');
  const laneA = hasTank ? rng.pick(vehicleLanes) : rng.int(0, m.ai.lanes.length - 1);
  const laneB = (laneA + rng.int(1, m.ai.lanes.length - 1)) % m.ai.lanes.length;
  const groups: { lane: number; code: GoCode }[] = [{ lane: laneA, code: 'A' }];
  if (rng.next() < 0.6) groups.push({ lane: laneB, code: 'B' });
  const holds = rng.next() < 0.8;

  const order = [...units].sort((a, b) => roleRank(a.type) - roleRank(b.type));
  let guards = units.length >= 3 ? 1 : 0;
  let garrisons = m.ai.garrison.length && units.length >= 4 && rng.next() < 0.65 ? 1 : 0;
  let gi = 0;
  for (const u of order) {
    const cls = UNITS[u.type].move;
    const blocked = ownBlocked(defenses, cls);
    const reach = (w: Pt) => findPath(m, u.spawn, w, blocked, cls) !== null;
    if (cls === 'foot' && guards > 0 && (u.type === 'gunner' || u.type === 'rifleman' || u.type === 'medic')) {
      guards--;
      u.waypoints = [{ ...nearestWalkable(m, side(m, team, rng.pick(m.ai.guard)), blocked), code: null }];
      continue;
    }
    if (cls === 'foot' && garrisons > 0 && (u.type === 'sniper' || u.type === 'rocketeer' || u.type === 'gunner')) {
      garrisons--;
      const spot = nearestWalkable(m, side(m, team, rng.pick(m.ai.garrison)), blocked);
      if (reach(spot)) { u.waypoints = [{ ...spot, code: null }]; continue; }
    }
    const g = cls === 'vehicle' ? groups[0] : groups[gi++ % groups.length];
    const lane = m.ai.lanes[cls === 'vehicle' && !m.ai.lanes[g.lane].vehicle ? rng.pick(vehicleLanes) : g.lane];
    const wps: Waypoint[] = lane.pts.map((p, j) => ({
      ...nearestWalkable(m, side(m, team, p), blocked, cls),
      code: holds && j === lane.hold ? g.code : null,
    }));
    u.waypoints = wps.filter(reach);
  }
  return { plan: { units, defenses }, spent: econ.money - money };
}

function roleRank(t: UnitType) {
  return { gunner: 0, sniper: 1, rocketeer: 2, medic: 3, rifleman: 4, breacher: 5, tank: 6 }[t];
}

/** Live AI: calls go codes once its groups are set, and recalls when the base is threatened. */
export class AiDirector {
  private firstHold = new Map<GoCode, number>();
  private patience = new Map<GoCode, number>();
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

    for (const code of GO_CODES) {
      if (sim.fired[this.team].has(code)) continue;
      // Members: units holding on this code, or still en route to a breakpoint with it.
      const members = mine.filter((u) => u.holdCode === code || (u.state === 'moving' && u.path.slice(u.pi).some((n) => n.bp === code)));
      const holding = members.filter((u) => u.state === 'holding');
      if (!holding.length) continue;
      if (!this.firstHold.has(code)) {
        this.firstHold.set(code, sim.tick);
        this.patience.set(code, tr * (5 + this.rng.next() * 6));
      }
      const waited = sim.tick - this.firstHold.get(code)!;
      if ((holding.length === members.length && waited > tr) || waited >= this.patience.get(code)!) cmds.push({ team: this.team, kind: 'code', code });
    }

    // Emergency audible: enemy spotted near our base and nobody guarding it.
    const seen = sim.visibleTo(this.team);
    const base = sim.bases[this.team];
    const threat = sim.units.some((e) => e.team === other(this.team) && e.state !== 'dead' && seen.has(e.id) && Math.hypot(e.x - base.x, e.y - base.y) < 8);
    if (threat && !sim.baseDefended(this.team) && sim.tick - this.lastRecall > tr * 6) {
      const candidates = mine.filter((u) => u.state === 'moving' || u.state === 'holding' || u.state === 'done');
      candidates.sort((a, b) => Math.hypot(a.x - base.x, a.y - base.y) - Math.hypot(b.x - base.x, b.y - base.y));
      if (candidates.length > 1) { // never pull the last attacker
        cmds.push({ team: this.team, kind: 'recall', unitId: candidates[0].id });
        this.lastRecall = sim.tick;
      }
    }
    return cmds;
  }
}
