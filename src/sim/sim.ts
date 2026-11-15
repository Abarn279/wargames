import { DEFENSES, RULES, UNITS, other, type DefenseType, type Team, type UnitType } from './config';
import { type GameMap, type Pt, key, tileAt } from './map';
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

/** Tiles a team's own pathing must avoid: its own move-blocking defenses. */
export function ownBlocked(defs: DefensePlan[]): Set<number> {
  const s = new Set<number>();
  for (const d of defs) if (DEFENSES[d.type].blocksMove) s.add(key(d.x, d.y));
  return s;
}

// ---------- Live state ----------

export type UnitState = 'moving' | 'holding' | 'done' | 'recalling' | 'home' | 'dead';

export interface Unit {
  id: string;
  num: number; // 1-based label shown on map + card
  team: Team;
  type: UnitType;
  x: number; y: number;
  px: number; py: number; // previous tick position, for render interpolation
  hp: number; maxHp: number;
  state: UnitState;
  path: PathNode[];
  pi: number; // index of next path node
  cooldown: number;
  spawn: Pt;
  revealUntil: number; // tick until which firing has revealed this unit to the enemy
  facing: number;
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

export type Command = { team: Team; unitId: string; kind: 'go' | 'recall' };

export type SimEvent =
  | { kind: 'shot'; team: Team; shooter: string; fx: number; fy: number; tx: number; ty: number; hit: boolean; heavy: boolean }
  | { kind: 'boom'; team: Team; x: number; y: number }
  | { kind: 'death'; team: Team; id: string; x: number; y: number }
  | { kind: 'wreck'; team: Team; id: string; x: number; y: number };

export interface RoundResult {
  winner: Team | null;
  reason: string;
  kills: [number, number];
  baseDestroyed: Team | null;
  survivors: [UnitPlan[], UnitPlan[]];
  ticks: number;
}

type Target =
  | { kind: 'unit'; u: Unit }
  | { kind: 'def'; d: Defense }
  | { kind: 'base'; b: Base };

const DT = 1 / RULES.tickRate;

export class Sim {
  readonly units: Unit[] = [];
  readonly defenses: Defense[] = [];
  readonly bases: [Base, Base];
  tick = 0;
  events: SimEvent[] = [];
  result: RoundResult | null = null;
  private kills: [number, number] = [0, 0];
  private lastAction = 0;
  private rng: Rng;
  private blocked: [Set<number>, Set<number>];

  constructor(readonly map: GameMap, plans: [TeamPlan, TeamPlan], seed: number) {
    this.rng = new Rng(seed);
    this.bases = [0, 1].map((t) => ({
      team: t as Team, x: map.bases[t].x, y: map.bases[t].y, hp: RULES.baseHp, maxHp: RULES.baseHp,
    })) as [Base, Base];
    this.blocked = [ownBlocked(plans[0].defenses), ownBlocked(plans[1].defenses)];

    for (const team of [0, 1] as Team[]) {
      plans[team].defenses.forEach((d, i) => {
        const st = DEFENSES[d.type];
        this.defenses.push({ id: `${team}-d${i}`, team, type: d.type, x: d.x, y: d.y, hp: st.hp, maxHp: st.hp, cooldown: 0, alive: true });
      });
      plans[team].units.forEach((p, i) => {
        const st = UNITS[p.type];
        const path = expandPlan(map, p.spawn, p.waypoints, this.blocked[team]);
        const x = p.spawn.x + 0.5, y = p.spawn.y + 0.5;
        this.units.push({
          id: p.id, num: i + 1, team, type: p.type, x, y, px: x, py: y, hp: st.hp, maxHp: st.hp,
          state: path.length ? 'moving' : 'done', path, pi: 0, cooldown: 0, spawn: p.spawn,
          revealUntil: -1, facing: team === 0 ? 0 : Math.PI,
        });
      });
    }
  }

  get elapsed() { return this.tick * DT; }
  get timeLeft() { return Math.max(0, RULES.roundSeconds - this.elapsed); }

  alive(team?: Team) {
    return this.units.filter((u) => u.state !== 'dead' && (team === undefined || u.team === team));
  }

  losBlockers(): Set<number> {
    const s = new Set<number>();
    for (const d of this.defenses) if (d.alive && DEFENSES[d.type].blocksLos) s.add(key(d.x, d.y));
    return s;
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

  /** What `team` can currently see of the enemy: unit ids and defense ids. Mines are never revealed. */
  visibleTo(team: Team): Set<string> {
    const seen = new Set<string>();
    const blockers = this.losBlockers();
    const observers: { x: number; y: number; v: number }[] = [];
    for (const u of this.units) if (u.team === team && u.state !== 'dead') observers.push({ x: u.x, y: u.y, v: UNITS[u.type].vision });
    for (const d of this.defenses) if (d.team === team && d.alive && d.type === 'turret') observers.push({ x: d.x + 0.5, y: d.y + 0.5, v: DEFENSES.turret.vision });
    const b = this.bases[team];
    observers.push({ x: b.x, y: b.y, v: 3.5 });
    const sees = (x: number, y: number) =>
      observers.some((o) => (o.x - x) ** 2 + (o.y - y) ** 2 <= o.v * o.v && hasLos(this.map, o.x, o.y, x, y, blockers));
    for (const u of this.units) {
      if (u.team === team || u.state === 'dead') continue;
      if (u.revealUntil >= this.tick || sees(u.x, u.y)) seen.add(u.id);
    }
    for (const d of this.defenses) {
      if (d.team === team || !d.alive || d.type === 'mine') continue;
      if (sees(d.x + 0.5, d.y + 0.5)) seen.add(d.id);
    }
    return seen;
  }

  private enemyStructureAt(team: Team, x: number, y: number): Defense | undefined {
    return this.defenses.find((d) => d.alive && d.team !== team && d.x === x && d.y === y && DEFENSES[d.type].blocksMove);
  }

  private apply(cmd: Command) {
    const u = this.units.find((v) => v.id === cmd.unitId && v.team === cmd.team);
    if (!u) return;
    if (cmd.kind === 'go' && u.state === 'holding') u.state = 'moving';
    if (cmd.kind === 'recall' && (u.state === 'moving' || u.state === 'holding' || u.state === 'done')) {
      const from = { x: Math.floor(u.x), y: Math.floor(u.y) };
      const homePath = findPath(this.map, from, u.spawn, this.blocked[u.team]) ?? [];
      u.path = homePath.map((p) => ({ ...p, bp: false }));
      u.pi = 0;
      u.state = u.path.length ? 'recalling' : 'home';
    }
  }

  private pickTarget(u: Unit, blockers: Set<number>): Target | null {
    const st = UNITS[u.type];
    const r2 = st.range * st.range;
    let best: Target | null = null;
    let bestD = Infinity;
    for (const e of this.units) {
      if (e.team === u.team || e.state === 'dead') continue;
      const d = (e.x - u.x) ** 2 + (e.y - u.y) ** 2;
      if (d <= r2 && d < bestD && hasLos(this.map, u.x, u.y, e.x, e.y, blockers)) { best = { kind: 'unit', u: e }; bestD = d; }
    }
    if (best) return best;
    for (const d of this.defenses) {
      if (d.team === u.team || !d.alive || d.type !== 'turret') continue;
      const dd = (d.x + 0.5 - u.x) ** 2 + (d.y + 0.5 - u.y) ** 2;
      if (dd <= r2 && dd < bestD && hasLos(this.map, u.x, u.y, d.x + 0.5, d.y + 0.5, blockers)) { best = { kind: 'def', d }; bestD = dd; }
    }
    if (best) return best;
    const next = u.path[u.pi];
    if (next && (u.state === 'moving' || u.state === 'recalling')) {
      const wall = this.enemyStructureAt(u.team, next.x, next.y);
      if (wall) return { kind: 'def', d: wall };
    }
    const eb = this.bases[other(u.team)];
    const db = Math.hypot(eb.x - u.x, eb.y - u.y) - 0.8;
    if (db <= st.range && !this.baseDefended(eb.team) && hasLos(this.map, u.x, u.y, eb.x, eb.y, blockers)) return { kind: 'base', b: eb };
    return null;
  }

  private fire(team: Team, shooterId: string, fx: number, fy: number, range: number, damage: number, acc: number, structMult: number, t: Target, blockers: Set<number>) {
    const tx = t.kind === 'unit' ? t.u.x : t.kind === 'def' ? t.d.x + 0.5 : t.b.x;
    const ty = t.kind === 'unit' ? t.u.y : t.kind === 'def' ? t.d.y + 0.5 : t.b.y;
    const dist = Math.hypot(tx - fx, ty - fy);
    const hit = this.rng.next() < acc * (1 - 0.35 * Math.min(1, dist / Math.max(range, 1)));
    // Misses land near the target so tracers read correctly.
    const jx = hit ? 0 : (this.rng.next() - 0.5) * 0.9, jy = hit ? 0 : (this.rng.next() - 0.5) * 0.9;
    this.lastAction = this.tick;
    this.events.push({ kind: 'shot', team, shooter: shooterId, fx, fy, tx: tx + jx, ty: ty + jy, hit, heavy: damage >= 30 });
    if (!hit) return;
    if (t.kind === 'unit') {
      const cover = inCover(this.map, t.u.x, t.u.y, fx, fy, blockers);
      t.u.hp -= damage * (cover ? 1 - RULES.coverReduction : 1);
      if (t.u.hp <= 0 && t.u.state !== 'dead') this.kill(t.u, team);
    } else if (t.kind === 'def') {
      t.d.hp -= damage * structMult;
      if (t.d.hp <= 0 && t.d.alive) {
        t.d.alive = false;
        this.events.push({ kind: 'wreck', team: t.d.team, id: t.d.id, x: t.d.x + 0.5, y: t.d.y + 0.5 });
      }
    } else {
      t.b.hp = Math.max(0, t.b.hp - damage * structMult);
    }
  }

  private kill(u: Unit, by: Team) {
    u.state = 'dead';
    u.hp = 0;
    this.kills[by]++;
    this.events.push({ kind: 'death', team: u.team, id: u.id, x: u.x, y: u.y });
  }

  private move(u: Unit) {
    let budget = UNITS[u.type].speed * DT * (tileAt(this.map, Math.floor(u.x), Math.floor(u.y)) === 'rough' ? 0.55 : 1);
    while (budget > 0 && u.pi < u.path.length) {
      const n = u.path[u.pi];
      if (this.enemyStructureAt(u.team, n.x, n.y)) return; // breach it first
      const tx = n.x + 0.5, ty = n.y + 0.5;
      const dx = tx - u.x, dy = ty - u.y;
      const d = Math.hypot(dx, dy);
      if (d > 1e-6) u.facing = Math.atan2(dy, dx);
      if (d <= budget) {
        u.x = tx; u.y = ty; budget -= d; u.pi++;
        if (n.bp && u.state === 'moving') { u.state = 'holding'; return; }
      } else {
        u.x += (dx / d) * budget; u.y += (dy / d) * budget; budget = 0;
      }
    }
    if (u.pi >= u.path.length) u.state = u.state === 'recalling' ? 'home' : 'done';
  }

  step(commands: Command[] = []) {
    if (this.result) return;
    this.events = [];
    for (const c of commands) this.apply(c);
    for (const u of this.units) { u.px = u.x; u.py = u.y; }

    // Mines
    for (const m of this.defenses) {
      if (!m.alive || m.type !== 'mine') continue;
      const mx = m.x + 0.5, my = m.y + 0.5;
      const triggered = this.units.some((u) => u.team !== m.team && u.state !== 'dead' && Math.hypot(u.x - mx, u.y - my) <= DEFENSES.mine.range);
      if (!triggered) continue;
      m.alive = false;
      this.events.push({ kind: 'boom', team: m.team, x: mx, y: my });
      for (const u of this.units) {
        if (u.team === m.team || u.state === 'dead') continue;
        if (Math.hypot(u.x - mx, u.y - my) <= RULES.mineBlastRadius) {
          u.hp -= DEFENSES.mine.damage;
          if (u.hp <= 0) this.kill(u, m.team);
        }
      }
    }

    const blockers = this.losBlockers();

    // Units: shoot, then move if free to
    for (const u of this.units) {
      if (u.state === 'dead') continue;
      const st = UNITS[u.type];
      u.cooldown -= DT;
      const t = this.pickTarget(u, blockers);
      if (t) {
        const tx = t.kind === 'unit' ? t.u.x : t.kind === 'def' ? t.d.x + 0.5 : t.b.x;
        const ty = t.kind === 'unit' ? t.u.y : t.kind === 'def' ? t.d.y + 0.5 : t.b.y;
        u.facing = Math.atan2(ty - u.y, tx - u.x);
        if (u.cooldown <= 0) {
          u.cooldown = st.cooldown;
          u.revealUntil = this.tick + RULES.tickRate * 1.5;
          this.fire(u.team, u.id, u.x, u.y, st.range, st.damage, u.state === 'recalling' ? st.accuracy * 0.6 : st.accuracy, st.structureMult, t, blockers);
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
      let best: Unit | null = null, bestD = st.range * st.range;
      for (const e of this.units) {
        if (e.team === d.team || e.state === 'dead') continue;
        const dd = (e.x - cx) ** 2 + (e.y - cy) ** 2;
        if (dd <= bestD && hasLos(this.map, cx, cy, e.x, e.y, blockers)) { best = e; bestD = dd; }
      }
      if (best) {
        d.cooldown = st.cooldown;
        this.fire(d.team, d.id, cx, cy, st.range, st.damage, st.accuracy, 1, { kind: 'unit', u: best }, blockers);
      }
    }

    this.tick++;
    this.checkEnd();
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
    } else if ([...a0, ...a1].every((u) => u.state === 'home')) {
      winner = null; reason = 'Everyone pulled back';
    } else if (
      [...a0, ...a1].every((u) => u.state === 'home' || u.state === 'done') &&
      this.tick - this.lastAction > RULES.tickRate * RULES.stalemateSeconds
    ) {
      // Nobody can advance any more and nobody is shooting: no point running out the clock.
      winner = null; reason = 'Stalemate';
    } else if (this.timeLeft <= 0) {
      winner = null; reason = 'Time expired';
    }
    if (winner === undefined) return;
    const carry = (t: Team): UnitPlan[] =>
      this.alive(t).map((u) => ({ id: u.id, type: u.type, spawn: u.spawn, waypoints: [] }));
    const survivors: [UnitPlan[], UnitPlan[]] = [carry(0), carry(1)];
    this.result = { winner, reason, kills: [...this.kills] as [number, number], baseDestroyed, survivors, ticks: this.tick };
  }
}
