import {
  DAMAGE, DEFENSES, GARRISON, RULES, UNITS, other,
  type ArmorClass, type DamageType, type DefenseType, type GoCode, type MoveClass, type Team, type UnitType,
} from './config';
import { type GameMap, type Objective, type Pt, conceals, garrisoned, key, speedMult, tileAt } from './map';
import { expandPlan, findPath, type PathNode, type Waypoint } from './path';
import { hasLos, inCover } from './los';
import { Rng } from './rng';

// ---------- Plans (the only input to a round besides live commands) ----------

export interface UnitPlan {
  id: string; // stable across rounds for carried-over units
  type: UnitType;
  spawn: Pt;
  waypoints: Waypoint[];
}
export interface DefensePlan { type: DefenseType; x: number; y: number }
export interface TeamPlan { units: UnitPlan[]; defenses: DefensePlan[] }

/** Tiles a team's own pathing must avoid: its own defenses that block that movement class. */
export function ownBlocked(defs: DefensePlan[], cls: MoveClass = 'foot'): Set<number> {
  const s = new Set<number>();
  for (const d of defs) {
    const st = DEFENSES[d.type];
    if (cls === 'foot' ? st.blocksFoot : st.blocksVehicle) s.add(key(d.x, d.y));
  }
  return s;
}

// ---------- Live state ----------

export type UnitState = 'moving' | 'holding' | 'done' | 'recalling' | 'home' | 'dead';

export interface Unit {
  id: string;
  num: number; // 1-based label shown on map + card
  team: Team;
  type: UnitType;
  cls: MoveClass;
  x: number; y: number;
  px: number; py: number; // previous tick position, for render interpolation
  hp: number; maxHp: number;
  state: UnitState;
  holdCode: GoCode | null; // which code a holding unit is waiting on
  path: PathNode[];
  pi: number; // index of next path node
  cooldown: number;
  spawn: Pt;
  revealUntil: number; // tick until which firing has revealed this unit to the enemy
  suppressedUntil: number;
  facing: number;
  engaged: boolean; // had a target this tick
  movedTick: number; // last tick this unit changed position
  shotTick: number; // last tick this unit fired
  ambushUntil: number; // tick until which this unit's opening burst gets the overwatch bonus
}

export interface Defense {
  id: string;
  team: Team;
  type: DefenseType;
  x: number; y: number; // tile
  hp: number; maxHp: number;
  cooldown: number;
  alive: boolean;
}

export interface Base { team: Team; x: number; y: number; hp: number; maxHp: number }

export type Command =
  | { team: Team; kind: 'go' | 'recall'; unitId: string }
  | { team: Team; kind: 'code'; code: GoCode };

export type SimEvent =
  | { kind: 'shot'; team: Team; shooter: string; fx: number; fy: number; tx: number; ty: number; hit: boolean; dtype: DamageType }
  | { kind: 'boom'; team: Team; x: number; y: number; r: number }
  | { kind: 'death'; team: Team; id: string; x: number; y: number }
  | { kind: 'wreck'; team: Team; id: string; x: number; y: number }
  | { kind: 'code'; team: Team; code: GoCode }
  | { kind: 'objective'; id: string; phase: 'live' | 'closed'; holder: Team | null };

export interface RoundResult {
  winner: Team | null;
  reason: string;
  kills: [number, number];
  baseDestroyed: Team | null;
  survivors: [UnitPlan[], UnitPlan[]];
  fielded: [UnitType[], UnitType[]];
  ticks: number;
  /** Objective points (seconds held) per team. */
  score: [number, number];
}

type Target =
  | { kind: 'unit'; u: Unit }
  | { kind: 'def'; d: Defense }
  | { kind: 'base'; b: Base };

const DT = 1 / RULES.tickRate;
const armorOf = (t: Target): ArmorClass => (t.kind === 'unit' ? UNITS[t.u.type].armor : 'structure');
const posOf = (t: Target): Pt =>
  t.kind === 'unit' ? { x: t.u.x, y: t.u.y } : t.kind === 'def' ? { x: t.d.x + 0.5, y: t.d.y + 0.5 } : { x: t.b.x, y: t.b.y };

export class Sim {
  readonly units: Unit[] = [];
  readonly defenses: Defense[] = [];
  readonly bases: [Base, Base];
  readonly fired: [Set<GoCode>, Set<GoCode>] = [new Set(), new Set()];
  tick = 0;
  events: SimEvent[] = [];
  result: RoundResult | null = null;
  private kills: [number, number] = [0, 0];
  private lastAction = 0;
  /** Objective points: seconds each team has held a live objective uncontested. */
  score: [number, number] = [0, 0];
  /** Enemy units that recently shot at each team (id -> tick), so covering units prioritize them. */
  private threats: [Map<string, number>, Map<string, number>] = [new Map(), new Map()];
  private rng: Rng;
  private plans: [TeamPlan, TeamPlan];
  private seen: [Set<string>, Set<string>] = [new Set(), new Set()];
  private blockersCache: Set<number> | null = null;

  constructor(readonly map: GameMap, plans: [TeamPlan, TeamPlan], seed: number) {
    this.rng = new Rng(seed);
    this.plans = plans;
    this.bases = [0, 1].map((t) => ({
      team: t as Team, x: map.bases[t].x, y: map.bases[t].y, hp: RULES.baseHp, maxHp: RULES.baseHp,
    })) as [Base, Base];

    for (const team of [0, 1] as Team[]) {
      plans[team].defenses.forEach((d, i) => {
        const st = DEFENSES[d.type];
        this.defenses.push({ id: `${team}-d${i}`, team, type: d.type, x: d.x, y: d.y, hp: st.hp, maxHp: st.hp, cooldown: 0, alive: true });
      });
      plans[team].units.forEach((p, i) => {
        const st = UNITS[p.type];
        const path = expandPlan(map, p.spawn, p.waypoints, ownBlocked(plans[team].defenses, st.move), st.move);
        const x = p.spawn.x + 0.5, y = p.spawn.y + 0.5;
        this.units.push({
          id: p.id, num: i + 1, team, type: p.type, cls: st.move, x, y, px: x, py: y, hp: st.hp, maxHp: st.hp,
          state: path.length ? 'moving' : 'done', holdCode: null, path, pi: 0, cooldown: 0, spawn: p.spawn,
          revealUntil: -1, suppressedUntil: -1, facing: team === 0 ? 0 : Math.PI, engaged: false,
          movedTick: -1000, shotTick: -1000, ambushUntil: -1,
        });
      });
    }
    this.seen = [this.visibleTo(0), this.visibleTo(1)];
  }

  get elapsed() { return this.tick * DT; }
  get timeLeft() { return Math.max(0, RULES.roundSeconds - this.elapsed); }

  alive(team?: Team) {
    return this.units.filter((u) => u.state !== 'dead' && (team === undefined || u.team === team));
  }

  isSuppressed(u: Unit) { return u.suppressedUntil > this.tick; }

  /** Moved within the last moment: no cover or garrison protection, and shaky aim. */
  isExposed(u: Unit) { return this.tick - u.movedTick < RULES.exposedSeconds * RULES.tickRate; }

  /** Settled, quiet and not pinned: the next shot is an aimed ambush shot. */
  isOverwatching(u: Unit) {
    const tr = RULES.tickRate;
    return u.state !== 'dead' && !this.isSuppressed(u) &&
      this.tick - u.movedTick >= RULES.overwatchSettleSeconds * tr &&
      this.tick - u.shotTick >= RULES.overwatchQuietSeconds * tr;
  }

  objectivePhase(o: Objective): 'pending' | 'live' | 'closed' {
    const t = this.elapsed;
    return t < o.from ? 'pending' : t < o.to ? 'live' : 'closed';
  }

  /** Who holds an objective right now: a team, 'contested', or null if nobody is on it. */
  objectiveHolder(o: Objective): Team | 'contested' | null {
    let here0 = false, here1 = false;
    for (const u of this.units) {
      if (u.state === 'dead' || Math.hypot(u.x - o.x, u.y - o.y) > o.r) continue;
      if (u.team === 0) here0 = true; else here1 = true;
    }
    return here0 && here1 ? 'contested' : here0 ? 0 : here1 ? 1 : null;
  }

  losBlockers(): Set<number> {
    if (this.blockersCache) return this.blockersCache;
    const s = new Set<number>();
    for (const d of this.defenses) if (d.alive && DEFENSES[d.type].blocksLos) s.add(key(d.x, d.y));
    return (this.blockersCache = s);
  }

  /** Base is attackable only when nobody from its team (unit or turret) is guarding it. */
  baseDefended(team: Team): boolean {
    const b = this.bases[team];
    const r2 = RULES.baseDefendRadius ** 2;
    for (const u of this.units)
      if (u.team === team && u.state !== 'dead' && (u.x - b.x) ** 2 + (u.y - b.y) ** 2 <= r2) return true;
    for (const d of this.defenses)
      if (d.team === team && d.alive && d.type === 'turret' && (d.x + 0.5 - b.x) ** 2 + (d.y + 0.5 - b.y) ** 2 <= r2) return true;
    return false;
  }

  /**
   * What `team` can currently see of the enemy (unit and defense ids). Spotting is shared:
   * anything one of your units sees, all of them can shoot at. Units in forest or buildings
   * are only spotted up close unless they've just fired. Mines are never revealed.
   */
  visibleTo(team: Team): Set<string> {
    const seen = new Set<string>();
    const blockers = this.losBlockers();
    const observers: { x: number; y: number; v: number }[] = [];
    for (const u of this.units) if (u.team === team && u.state !== 'dead') observers.push({ x: u.x, y: u.y, v: UNITS[u.type].vision });
    for (const d of this.defenses) if (d.team === team && d.alive && d.type === 'turret') observers.push({ x: d.x + 0.5, y: d.y + 0.5, v: DEFENSES.turret.vision });
    const b = this.bases[team];
    observers.push({ x: b.x, y: b.y, v: 3.5 });
    const sees = (x: number, y: number, hidden: boolean) =>
      observers.some((o) => {
        const r = hidden ? Math.min(o.v, RULES.concealRange) : o.v;
        return (o.x - x) ** 2 + (o.y - y) ** 2 <= r * r && hasLos(this.map, o.x, o.y, x, y, blockers);
      });
    for (const u of this.units) {
      if (u.team === team || u.state === 'dead') continue;
      const hidden = conceals(tileAt(this.map, Math.floor(u.x), Math.floor(u.y)));
      if (u.revealUntil >= this.tick || sees(u.x, u.y, hidden)) seen.add(u.id);
    }
    for (const d of this.defenses) {
      if (d.team === team || !d.alive || d.type === 'mine') continue;
      if (sees(d.x + 0.5, d.y + 0.5, false)) seen.add(d.id);
    }
    return seen;
  }

  private enemyStructureAt(u: Unit, x: number, y: number): Defense | undefined {
    return this.defenses.find((d) => {
      if (!d.alive || d.team === u.team || d.x !== x || d.y !== y) return false;
      const st = DEFENSES[d.type];
      return u.cls === 'foot' ? st.blocksFoot : st.blocksVehicle;
    });
  }

  private release(u: Unit) {
    if (u.state !== 'holding') return;
    u.state = 'moving';
    u.holdCode = null;
  }

  private apply(cmd: Command) {
    if (cmd.kind === 'code') {
      if (this.fired[cmd.team].has(cmd.code)) return;
      this.fired[cmd.team].add(cmd.code);
      this.events.push({ kind: 'code', team: cmd.team, code: cmd.code });
      for (const u of this.units) if (u.team === cmd.team && u.state === 'holding' && u.holdCode === cmd.code) this.release(u);
      return;
    }
    const u = this.units.find((v) => v.id === cmd.unitId && v.team === cmd.team);
    if (!u) return;
    if (cmd.kind === 'go') this.release(u);
    if (cmd.kind === 'recall' && (u.state === 'moving' || u.state === 'holding' || u.state === 'done')) {
      const from = { x: Math.floor(u.x), y: Math.floor(u.y) };
      const homePath = findPath(this.map, from, u.spawn, ownBlocked(this.plans[u.team].defenses, u.cls), u.cls) ?? [];
      u.path = homePath.map((p) => ({ ...p, bp: null }));
      u.pi = 0;
      u.holdCode = null;
      u.state = u.path.length ? 'recalling' : 'home';
    }
  }

  /**
   * Pick the target this unit is best equipped to hurt: effectiveness (damage multiplier vs the
   * target's armor) over distance. A rocketeer prefers the tank; a rifleman prefers the soldier next to it.
   */
  private pickTarget(u: Unit, blockers: Set<number>): Target | null {
    const st = UNITS[u.type];
    const r2 = st.range * st.range;
    const seen = this.seen[u.team];
    const eff = DAMAGE[st.dtype];
    let best: Target | null = null;
    let bestScore = 0;
    for (const e of this.units) {
      if (e.team === u.team || e.state === 'dead' || !seen.has(e.id)) continue;
      const d2 = (e.x - u.x) ** 2 + (e.y - u.y) ** 2;
      if (d2 > r2) continue;
      // Covering fire: an enemy that just shot at one of ours jumps to the top of the list.
      const threat = this.tick - (this.threats[u.team].get(e.id) ?? -1e9) <= RULES.tickRate * 2 ? RULES.coverFirePriority : 1;
      const score = threat * eff[UNITS[e.type].armor] / (Math.sqrt(d2) + 2);
      if (score > bestScore && hasLos(this.map, u.x, u.y, e.x, e.y, blockers)) { best = { kind: 'unit', u: e }; bestScore = score; }
    }
    for (const d of this.defenses) {
      if (d.team === u.team || !d.alive || d.type !== 'turret' || !seen.has(d.id)) continue;
      const d2 = (d.x + 0.5 - u.x) ** 2 + (d.y + 0.5 - u.y) ** 2;
      if (d2 > r2) continue;
      const score = eff.structure / (Math.sqrt(d2) + 2);
      if (score > bestScore && hasLos(this.map, u.x, u.y, d.x + 0.5, d.y + 0.5, blockers)) { best = { kind: 'def', d }; bestScore = score; }
    }
    if (best) return best;
    const next = u.path[u.pi];
    if (next && (u.state === 'moving' || u.state === 'recalling')) {
      const wall = this.enemyStructureAt(u, next.x, next.y);
      if (wall) return { kind: 'def', d: wall };
    }
    const eb = this.bases[other(u.team)];
    const db = Math.hypot(eb.x - u.x, eb.y - u.y) - 0.8;
    if (db <= st.range && !this.baseDefended(eb.team) && hasLos(this.map, u.x, u.y, eb.x, eb.y, blockers)) return { kind: 'base', b: eb };
    return null;
  }

  /** Apply damage of a type to a unit, accounting for armor class, garrison and cover. */
  private hurtUnit(t: Unit, raw: number, dtype: DamageType, by: Team, fx: number, fy: number, blockers: Set<number>) {
    const armor = UNITS[t.type].armor;
    let dmg = raw * DAMAGE[dtype][armor];
    if (armor === 'infantry' && !this.isExposed(t)) {
      const tile = tileAt(this.map, Math.floor(t.x), Math.floor(t.y));
      let mult = 1;
      if (garrisoned(tile)) mult = GARRISON[dtype];
      if ((dtype === 'bullet' || dtype === 'precision') && inCover(this.map, t.x, t.y, fx, fy, blockers)) mult = Math.min(mult, 1 - RULES.coverReduction);
      dmg *= mult;
    }
    t.hp -= dmg;
    if (t.hp <= 0 && t.state !== 'dead') this.kill(t, by);
  }

  private fire(team: Team, shooterId: string, fx: number, fy: number, range: number, damage: number, acc: number,
    dtype: DamageType, t: Target, blockers: Set<number>, opts: { splash?: number; suppress?: number; accVs?: Partial<Record<ArmorClass, number>>; aimed?: boolean } = {}) {
    this.lastAction = this.tick;
    const tp = posOf(t);
    const dist = Math.hypot(tp.x - fx, tp.y - fy);
    const accMult = opts.accVs?.[armorOf(t)] ?? 1;
    // Aimed (overwatch) fire down a prepared line doesn't fall off with range.
    const falloff = opts.aimed ? 1 : 1 - 0.35 * Math.min(1, dist / Math.max(range, 1));
    const hit = this.rng.next() < acc * accMult * falloff;
    const spread = dtype === 'he' ? 1.4 : 0.9;
    const jx = hit ? 0 : (this.rng.next() - 0.5) * spread, jy = hit ? 0 : (this.rng.next() - 0.5) * spread;
    const ix = tp.x + jx, iy = tp.y + jy;
    this.events.push({ kind: 'shot', team, shooter: shooterId, fx, fy, tx: ix, ty: iy, hit, dtype });
    if (t.kind === 'unit') this.threats[t.u.team].set(shooterId, this.tick);
    if (hit) {
      if (t.kind === 'unit') {
        this.hurtUnit(t.u, damage, dtype, team, fx, fy, blockers);
        if (opts.suppress && UNITS[t.u.type].armor === 'infantry') t.u.suppressedUntil = this.tick + opts.suppress * RULES.tickRate;
      } else if (t.kind === 'def') {
        t.d.hp -= damage * DAMAGE[dtype].structure;
        if (t.d.hp <= 0 && t.d.alive) {
          t.d.alive = false;
          this.blockersCache = null;
          this.events.push({ kind: 'wreck', team: t.d.team, id: t.d.id, x: t.d.x + 0.5, y: t.d.y + 0.5 });
        }
      } else {
        t.b.hp = Math.max(0, t.b.hp - damage * DAMAGE[dtype].structure);
      }
    }
    // High explosive splashes whether or not it hit: half damage to every other enemy nearby.
    if (opts.splash) {
      this.events.push({ kind: 'boom', team, x: ix, y: iy, r: opts.splash });
      for (const e of this.units) {
        if (e.team === team || e.state === 'dead' || (t.kind === 'unit' && hit && e === t.u)) continue;
        if (Math.hypot(e.x - ix, e.y - iy) <= opts.splash) this.hurtUnit(e, damage * 0.5, dtype, team, ix, iy, blockers);
      }
    }
  }

  private kill(u: Unit, by: Team) {
    u.state = 'dead';
    u.hp = 0;
    this.kills[by]++;
    this.events.push({ kind: 'death', team: u.team, id: u.id, x: u.x, y: u.y });
  }

  private move(u: Unit) {
    const tile = tileAt(this.map, Math.floor(u.x), Math.floor(u.y));
    let budget = UNITS[u.type].speed * DT * speedMult(tile, u.cls) * (this.isSuppressed(u) ? RULES.suppressedSpeed : 1);
    while (budget > 0 && u.pi < u.path.length) {
      const n = u.path[u.pi];
      if (this.enemyStructureAt(u, n.x, n.y)) return; // breach it first
      const tx = n.x + 0.5, ty = n.y + 0.5;
      const dx = tx - u.x, dy = ty - u.y;
      const d = Math.hypot(dx, dy);
      if (d > 1e-6) u.facing = Math.atan2(dy, dx);
      if (d <= budget) {
        u.x = tx; u.y = ty; budget -= d; u.pi++;
        u.movedTick = this.tick;
        // A breakpoint whose code was already called is open: keep going.
        if (n.bp && u.state === 'moving' && !this.fired[u.team].has(n.bp)) {
          u.state = 'holding';
          u.holdCode = n.bp;
          return;
        }
      } else {
        u.x += (dx / d) * budget; u.y += (dy / d) * budget; budget = 0;
        u.movedTick = this.tick;
      }
    }
    if (u.pi >= u.path.length) u.state = u.state === 'recalling' ? 'home' : 'done';
  }

  step(commands: Command[] = []) {
    if (this.result) return;
    this.events = [];
    this.blockersCache = null;
    for (const c of commands) this.apply(c);
    for (const u of this.units) { u.px = u.x; u.py = u.y; }
    this.seen = [this.visibleTo(0), this.visibleTo(1)];

    // Mines
    for (const m of this.defenses) {
      if (!m.alive || m.type !== 'mine') continue;
      const mx = m.x + 0.5, my = m.y + 0.5;
      const triggered = this.units.some((u) => u.team !== m.team && u.state !== 'dead' && Math.hypot(u.x - mx, u.y - my) <= DEFENSES.mine.range);
      if (!triggered) continue;
      m.alive = false;
      this.lastAction = this.tick;
      this.events.push({ kind: 'boom', team: m.team, x: mx, y: my, r: RULES.mineBlastRadius });
      for (const u of this.units) {
        if (u.team === m.team || u.state === 'dead') continue;
        if (Math.hypot(u.x - mx, u.y - my) <= RULES.mineBlastRadius) {
          u.hp -= DEFENSES.mine.damage * DAMAGE.blast[UNITS[u.type].armor];
          if (u.hp <= 0) this.kill(u, m.team);
        }
      }
    }

    const blockers = this.losBlockers();

    // Units: heal, shoot, then move if free to
    for (const u of this.units) {
      if (u.state === 'dead') continue;
      const st = UNITS[u.type];
      if (st.heal) this.heal(u, st.heal);
      u.cooldown -= DT;
      const t = this.pickTarget(u, blockers);
      u.engaged = !!t;
      if (t) {
        const tp = posOf(t);
        u.facing = Math.atan2(tp.y - u.y, tp.x - u.x);
        if (u.cooldown <= 0) {
          u.cooldown = st.cooldown;
          u.revealUntil = this.tick + RULES.tickRate * 1.5;
          let acc = st.accuracy;
          let dmg = st.damage;
          let aimed = false;
          if (u.state === 'recalling') acc *= 0.6;
          if (this.isSuppressed(u)) acc *= RULES.suppressedAccuracy;
          if (this.isExposed(u)) acc *= RULES.exposedAccuracy;
          else {
            // Springing an ambush: the opening burst from a settled, quiet unit is aimed fire.
            if (this.isOverwatching(u)) u.ambushUntil = this.tick + RULES.ambushBurstSeconds * RULES.tickRate;
            if (this.tick < u.ambushUntil && !this.isSuppressed(u)) {
              acc = Math.min(0.95, acc * RULES.overwatchAccuracy);
              dmg *= RULES.overwatchDamage;
              aimed = true;
            }
          }
          u.shotTick = this.tick;
          this.fire(u.team, u.id, u.x, u.y, st.range, dmg, acc, st.dtype, t, blockers, { splash: st.splash, suppress: st.suppress, accVs: st.accVs, aimed });
        }
      }
      // Advancing units stop to fight; retreating units keep running.
      if (u.state === 'recalling' || (u.state === 'moving' && !t)) this.move(u);
    }

    // Turrets
    for (const d of this.defenses) {
      if (!d.alive || d.type !== 'turret') continue;
      const st = DEFENSES.turret;
      d.cooldown -= DT;
      if (d.cooldown > 0) continue;
      const cx = d.x + 0.5, cy = d.y + 0.5;
      let best: Unit | null = null, bestScore = 0;
      for (const e of this.units) {
        if (e.team === d.team || e.state === 'dead' || !this.seen[d.team].has(e.id)) continue;
        const dist = Math.hypot(e.x - cx, e.y - cy);
        if (dist > st.range) continue;
        const score = DAMAGE[st.dtype][UNITS[e.type].armor] / (dist + 2);
        if (score > bestScore && hasLos(this.map, cx, cy, e.x, e.y, blockers)) { best = e; bestScore = score; }
      }
      if (best) {
        d.cooldown = st.cooldown;
        this.fire(d.team, d.id, cx, cy, st.range, st.damage, st.accuracy, st.dtype, { kind: 'unit', u: best }, blockers);
      }
    }

    this.scoreObjectives();
    this.tick++;
    this.checkEnd();
  }

  private scoreObjectives() {
    const tr = RULES.tickRate;
    for (const o of this.map.objectives) {
      if (this.tick === Math.round(o.from * tr)) this.events.push({ kind: 'objective', id: o.id, phase: 'live', holder: null });
      if (this.tick === Math.round(o.to * tr)) {
        const h = this.objectiveHolder(o);
        this.events.push({ kind: 'objective', id: o.id, phase: 'closed', holder: h === 'contested' ? null : h });
      }
      if (this.objectivePhase(o) !== 'live') continue;
      const h = this.objectiveHolder(o);
      if (h === 0 || h === 1) this.score[h] += DT;
    }
  }

  /**
   * Final objective score if nothing moves or fires again: every unfinished window goes to
   * whoever is sitting on it now. Used to end frozen rounds early without changing the result.
   */
  projectedScore(): [number, number] {
    const s: [number, number] = [this.score[0], this.score[1]];
    const t = this.elapsed;
    for (const o of this.map.objectives) {
      if (o.to <= t) continue;
      const h = this.objectiveHolder(o);
      if (h === 0 || h === 1) s[h] += o.to - Math.max(o.from, t);
    }
    return s;
  }

  private heal(medic: Unit, rate: number) {
    let best: Unit | null = null;
    for (const f of this.units) {
      if (f.team !== medic.team || f.state === 'dead' || f.hp >= f.maxHp || UNITS[f.type].armor !== 'infantry') continue;
      if (Math.hypot(f.x - medic.x, f.y - medic.y) > 2.5) continue;
      if (!best || f.hp / f.maxHp < best.hp / best.maxHp) best = f;
    }
    if (best) best.hp = Math.min(best.maxHp, best.hp + rate * DT * (best === medic ? 0.5 : 1));
  }

  private checkEnd() {
    const a0 = this.alive(0), a1 = this.alive(1);
    let winner: Team | null | undefined;
    let reason = '';
    let baseDestroyed: Team | null = null;
    const b0 = this.bases[0].hp <= 0, b1 = this.bases[1].hp <= 0;
    if (b0 || b1) {
      if (b0 && b1) { winner = null; reason = 'Both bases destroyed'; }
      else { baseDestroyed = b0 ? 0 : 1; winner = other(baseDestroyed); reason = 'Base destroyed'; }
    } else if (!a0.length || !a1.length) {
      if (!a0.length && !a1.length) { winner = null; reason = 'Mutual elimination'; }
      else { winner = a0.length ? 0 : 1; reason = 'Enemy team eliminated'; }
    } else if (
      [...a0, ...a1].every((u) => u.state === 'home' || u.state === 'done') &&
      ([...a0, ...a1].every((u) => u.state === 'home') || this.tick - this.lastAction > RULES.tickRate * RULES.stalemateSeconds)
    ) {
      // Nobody can advance any more and nobody is shooting: the rest of the round is already decided.
      this.score = this.projectedScore();
      [winner, reason] = this.decideOnPoints('Positions locked');
    } else if (this.timeLeft <= 0) {
      [winner, reason] = this.decideOnPoints('Time');
    }
    if (winner === undefined) return;
    const carry = (t: Team): UnitPlan[] =>
      this.alive(t).map((u) => ({ id: u.id, type: u.type, spawn: u.spawn, waypoints: [] }));
    const fielded = (t: Team) => this.units.filter((u) => u.team === t).map((u) => u.type);
    this.result = {
      winner, reason, kills: [...this.kills] as [number, number], baseDestroyed,
      survivors: [carry(0), carry(1)], fielded: [fielded(0), fielded(1)], ticks: this.tick,
      score: [Math.round(this.score[0]), Math.round(this.score[1])],
    };
  }

  private decideOnPoints(prefix: string): [Team | null, string] {
    if (!this.map.objectives.length) return [null, `${prefix}: draw`];
    const [s0, s1] = this.score.map(Math.round);
    if (s0 === s1) return [null, `${prefix}: objectives tied ${s0}–${s1}`];
    return [s0 > s1 ? 0 : 1, `${prefix}: objectives ${s0}–${s1}`];
  }
}
