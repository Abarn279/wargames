import { CODE_NAMES, DEFENSES, GO_CODES, RULES, UNITS, type DamageType, type DefenseType, type GoCode, type Team, type UnitType } from '../sim/config';
import { MAPS, MAP_ORDER, canDeployUnit, canFortify, key, nearestWalkable, speedMult, tileAt, type Pt } from '../sim/map';
import { expandPlan, findPath, type PathNode, type Waypoint } from '../sim/path';
import { hasLos } from '../sim/los';
import { Sim, ownBlocked, type Command, type DefensePlan, type TeamPlan, type Unit } from '../sim/sim';
import { Match, type RoundSummary } from '../sim/match';
import { AiDirector, planAi, type CodeTiming } from '../sim/ai';
import { C, bar, fitText, fmtTime, inRect, roundRect, text, type Rect } from './draw';

type Phase = 'title' | 'plan' | 'live' | 'roundEnd' | 'matchEnd';
type ShopItem = { kind: 'unit'; type: UnitType } | { kind: 'def'; type: DefenseType };
type Selection = { kind: 'unit'; id: string } | { kind: 'def'; index: number };

interface PlanUnit { id: string; type: UnitType; spawn: Pt; waypoints: Waypoint[]; veteran: boolean }
interface Hit extends Rect { fn: () => void }

type Effect =
  | { kind: 'tracer'; team: Team; fx: number; fy: number; tx: number; ty: number; t0: number; dtype: DamageType; hit: boolean }
  | { kind: 'boom'; x: number; y: number; r: number; t0: number }
  | { kind: 'corpse'; team: Team; x: number; y: number; t0: number; tank: boolean }
  | { kind: 'wreck'; x: number; y: number; t0: number };

const SHOP_UNITS: ShopItem[] = (['rifleman', 'gunner', 'sniper', 'rocketeer', 'breacher', 'medic', 'tank'] as UnitType[]).map((type) => ({ kind: 'unit', type }));
const SHOP_DEFS: ShopItem[] = (['barricade', 'tanktrap', 'turret', 'mine'] as DefenseType[]).map((type) => ({ kind: 'def', type }));
const TRACERS: Record<DamageType, { life: number; width: number; color?: string }> = {
  bullet: { life: 110, width: 1.2 },
  precision: { life: 260, width: 1.6, color: '#ffffff' },
  rocket: { life: 260, width: 3, color: '#ff9a3c' },
  he: { life: 180, width: 3.2, color: '#ffe08a' },
  demo: { life: 120, width: 2.2 },
  blast: { life: 0, width: 0 },
};
const withAlpha = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
export const CODE_COLORS: Record<GoCode, string> = { A: '#ffd23f', B: '#3fd8ff', C: '#ff6bd5' };
const PLAYER: Team = 0;
const ENEMY: Team = 1;
const TICK = 1000 / RULES.tickRate;

const itemCost = (i: ShopItem) => (i.kind === 'unit' ? UNITS[i.type].cost : DEFENSES[i.type].cost);
const itemName = (i: ShopItem) => (i.kind === 'unit' ? UNITS[i.type].name : DEFENSES[i.type].name);

export class Game {
  private ctx: CanvasRenderingContext2D;
  private W = 0;
  private H = 0;
  private dpr = 1;
  private mapId = MAP_ORDER[0];
  private map = MAPS[MAP_ORDER[0]];
  private shopTab: 'unit' | 'def' = 'unit';
  private match = new Match();
  private phase: Phase = 'title';
  private now = 0;
  private hits: Hit[] = [];
  private seed = (Math.random() * 1e9) | 0;

  // layout
  private top = 44;
  private side = true;
  private panel: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private insetL = 0;
  private insetR = 0;
  private insetB = 0;
  private ts = 20;
  private ox = 0;
  private oy = 0;

  // planning
  private units: PlanUnit[] = [];
  private defenses: DefensePlan[] = [];
  private money = 0;
  private placing: ShopItem | null = null;
  private selected: Selection | null = null;
  private lastWaypoints = new Map<string, Waypoint[]>();
  private aiPlan: TeamPlan = { units: [], defenses: [] };
  private aiSchedule: CodeTiming[] = [];
  private pathCache = new Map<string, PathNode[]>();

  // live
  private sim: Sim | null = null;
  private ai: AiDirector | null = null;
  private pending: Command[] = [];
  private acc = 0;
  private lastFrame = 0;
  private visible = new Set<string>();
  private seenDefs = new Set<string>();
  private fog = new Uint8Array(0);
  private hulls = new Map<string, number>();
  private effects: Effect[] = [];
  private summary: RoundSummary | null = null;
  private resultAt = 0;

  // input
  private toast: { msg: string; until: number; color: string } | null = null;
  private down: { x: number; y: number; t: number; dragUnit: string | null; dragging: boolean } | null = null;
  private dragTile: Pt | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    window.addEventListener('resize', () => this.resize());
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', () => { this.down = null; this.dragTile = null; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.resize();
  }

  start() {
    const loop = (t: number) => {
      this.frame(t);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ======================= Layout =======================

  private resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.W = this.canvas.clientWidth;
    this.H = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    const css = getComputedStyle(document.documentElement);
    const inset = (n: string) => parseFloat(css.getPropertyValue(n)) || 0;
    this.insetL = inset('--sal');
    this.insetR = inset('--sar');
    this.insetB = inset('--sab');
    this.top = Math.round(Math.max(34, Math.min(46, this.H * 0.08)));
    this.side = this.W / this.H >= 1.7;
    let mapArea: Rect;
    if (this.side) {
      const sw = Math.round(Math.max(132, Math.min(210, this.W * 0.18)));
      this.panel = { x: this.W - sw - this.insetR, y: this.top, w: sw, h: this.H - this.top - this.insetB };
      mapArea = { x: this.insetL, y: this.top, w: this.panel.x - this.insetL, h: this.H - this.top - this.insetB };
    } else {
      const bh = Math.round(Math.max(72, Math.min(110, this.H * 0.17)));
      this.panel = { x: this.insetL, y: this.H - bh - this.insetB, w: this.W - this.insetL - this.insetR, h: bh };
      mapArea = { x: this.insetL, y: this.top, w: this.W - this.insetL - this.insetR, h: this.panel.y - this.top };
    }
    this.ts = Math.max(6, Math.min((mapArea.w - 8) / this.map.w, (mapArea.h - 8) / this.map.h));
    this.ox = mapArea.x + (mapArea.w - this.ts * this.map.w) / 2;
    this.oy = mapArea.y + (mapArea.h - this.ts * this.map.h) / 2;
  }

  private sx(x: number) { return this.ox + x * this.ts; }
  private sy(y: number) { return this.oy + y * this.ts; }
  private toTile(px: number, py: number): Pt | null {
    const x = Math.floor((px - this.ox) / this.ts), y = Math.floor((py - this.oy) / this.ts);
    return x >= 0 && y >= 0 && x < this.map.w && y < this.map.h ? { x, y } : null;
  }

  // ======================= Phase transitions =======================

  private startMatch() {
    this.map = MAPS[this.mapId];
    this.resize();
    this.match = new Match();
    this.lastWaypoints.clear();
    this.startPlanning();
  }

  private startPlanning() {
    this.phase = 'plan';
    const econ = this.match.teams[PLAYER];
    this.money = econ.money;
    this.units = econ.roster.map((u) => ({ ...u, waypoints: (this.lastWaypoints.get(u.id) ?? []).map((w) => ({ ...w })), veteran: true }));
    this.defenses = [];
    this.placing = null;
    this.selected = null;
    const ai = planAi(this.map, ENEMY, this.match, this.seed + this.match.round * 7919);
    this.aiPlan = ai.plan;
    this.aiSchedule = ai.schedule;
    this.match.teams[ENEMY].money -= ai.spent;
    if (this.units.length) this.flash(`${this.units.length} veteran${this.units.length > 1 ? 's' : ''} carried over. Re-plan or keep last route.`);
    else this.flash('Buy units, then tap a unit and tap the map to route it.');
  }

  private ready() {
    if (this.phase !== 'plan') return;
    this.match.teams[PLAYER].money = this.money;
    for (const u of this.units) this.lastWaypoints.set(u.id, u.waypoints.map((w) => ({ ...w })));
    const plan: TeamPlan = {
      units: this.units.map((u) => ({ id: u.id, type: u.type, spawn: u.spawn, waypoints: u.waypoints })),
      defenses: this.defenses,
    };
    const seed = this.seed ^ (this.match.round * 2654435761);
    this.sim = new Sim(this.map, [plan, this.aiPlan], seed);
    this.ai = new AiDirector(ENEMY, seed + 1, this.aiSchedule);
    this.pending = [];
    this.acc = 0;
    this.effects = [];
    this.seenDefs.clear();
    this.summary = null;
    this.phase = 'live';
    this.refreshVision();
    this.flash('Units stop at breakpoints. Call the go code (or tap a card) to send them.', C.hold);
  }

  private endRound() {
    const r = this.sim!.result!;
    this.summary = this.match.finishRound(r);
    this.resultAt = this.now;
    this.phase = 'roundEnd';
  }

  // ======================= Frame =======================

  private frame(t: number) {
    const dt = this.lastFrame ? Math.min(250, t - this.lastFrame) : 16;
    this.lastFrame = t;
    this.now = t;

    if (this.phase === 'live' && this.sim) {
      this.acc += dt;
      while (this.acc >= TICK && !this.sim.result) {
        this.acc -= TICK;
        const cmds = [...this.pending, ...this.ai!.think(this.sim)];
        this.pending = [];
        this.sim.step(cmds);
        this.ingestEvents();
        this.refreshVision();
      }
      if (this.sim.result && !this.resultAt) this.resultAt = this.now;
      if (this.sim.result && this.now - this.resultAt > 1400) this.endRound();
    } else if (this.phase !== 'roundEnd') {
      this.resultAt = 0;
    }

    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, this.W, this.H);
    this.hits = [];

    if (this.phase === 'title') { this.drawTitle(); return; }
    this.drawMap();
    if (this.phase === 'plan') this.drawPlan();
    else this.drawLive();
    this.drawTopBar();
    if (this.phase === 'plan') this.drawShop();
    else this.drawCards();
    if (this.phase === 'roundEnd') this.drawRoundEnd();
    if (this.phase === 'matchEnd') this.drawMatchEnd();
    this.drawToast();
    if (this.H > this.W * 1.05) this.drawRotateHint();
  }

  private ingestEvents() {
    const sim = this.sim!;
    for (const e of sim.events) {
      if (e.kind === 'shot') {
        const mine = e.team === PLAYER;
        const shooterSeen = mine || this.visible.has(e.shooter) || this.fogAt(e.fx, e.fy);
        if (shooterSeen || this.fogAt(e.tx, e.ty)) this.effects.push({ kind: 'tracer', team: e.team, fx: e.fx, fy: e.fy, tx: e.tx, ty: e.ty, t0: this.now, dtype: e.dtype, hit: e.hit });
      } else if (e.kind === 'boom') {
        if (e.team === PLAYER || this.fogAt(e.x, e.y)) this.effects.push({ kind: 'boom', x: e.x, y: e.y, r: e.r, t0: this.now });
        if (e.r > 1.2 && navigator.vibrate) navigator.vibrate(30);
      } else if (e.kind === 'objective') {
        const o = this.map.objectives.find((x) => x.id === e.id);
        if (o && e.phase === 'live') this.flash(`${o.name} is live until ${fmtTime(o.to)}`, C.hold);
        if (o && e.phase === 'closed') this.flash(`${o.name} closed${e.holder === PLAYER ? ' — you held it' : e.holder === ENEMY ? ' — the AI held it' : ''}`, e.holder === PLAYER ? C.team[0] : e.holder === ENEMY ? C.team[1] : C.dim);
      } else if (e.kind === 'code') {
        if (e.team === PLAYER) this.flash(`${CODE_NAMES[e.code]} — go, go, go`, CODE_COLORS[e.code]);
      } else if (e.kind === 'death') {
        if (e.team === PLAYER || this.fogAt(e.x, e.y)) this.effects.push({ kind: 'corpse', team: e.team, x: e.x, y: e.y, t0: this.now, tank: sim.units.find((u) => u.id === e.id)?.type === 'tank' });
        if (e.team === PLAYER) this.flash(`Unit down`, C.danger);
      } else if (e.kind === 'wreck') {
        this.effects.push({ kind: 'wreck', x: e.x, y: e.y, t0: this.now });
      }
    }
    this.effects = this.effects.filter((f) => f.kind === 'corpse' || f.kind === 'wreck' || this.now - f.t0 < 700);
  }

  private fogAt(x: number, y: number) {
    const tx = Math.floor(x), ty = Math.floor(y);
    return this.fog[ty * this.map.w + tx] === 1;
  }

  /** Recompute what the player can see (fog of war) once per sim tick. */
  private refreshVision() {
    const sim = this.sim!;
    this.visible = sim.visibleTo(PLAYER);
    for (const d of sim.defenses) if (this.visible.has(d.id)) this.seenDefs.add(d.id);
    const m = this.map;
    if (this.fog.length !== m.w * m.h) this.fog = new Uint8Array(m.w * m.h);
    this.fog.fill(0);
    const blockers = sim.losBlockers();
    const obs: { x: number; y: number; v: number }[] = [];
    for (const u of sim.units) if (u.team === PLAYER && u.state !== 'dead') obs.push({ x: u.x, y: u.y, v: UNITS[u.type].vision });
    for (const d of sim.defenses) if (d.team === PLAYER && d.alive && d.type === 'turret') obs.push({ x: d.x + 0.5, y: d.y + 0.5, v: DEFENSES.turret.vision });
    const b = sim.bases[PLAYER];
    obs.push({ x: b.x, y: b.y, v: 3.5 });
    for (let y = 0; y < m.h; y++)
      for (let x = 0; x < m.w; x++) {
        const cx = x + 0.5, cy = y + 0.5;
        for (const o of obs) {
          if ((o.x - cx) ** 2 + (o.y - cy) ** 2 > o.v * o.v) continue;
          if (hasLos(m, o.x, o.y, cx, cy, blockers)) { this.fog[y * m.w + x] = 1; break; }
        }
      }
  }

  // ======================= Planning logic =======================

  private flash(msg: string, color: string = C.text) {
    this.toast = { msg, until: this.now + 2600, color };
  }

  private blockedForPlayer(type: UnitType = 'rifleman') { return ownBlocked(this.defenses, UNITS[type].move); }
  private cls(type: UnitType) { return UNITS[type].move; }

  private occupied(x: number, y: number) {
    return this.units.some((u) => u.spawn.x === x && u.spawn.y === y) || this.defenses.some((d) => d.x === x && d.y === y);
  }

  private pathFor(u: PlanUnit): PathNode[] {
    const k = `${u.type}|${u.spawn.x},${u.spawn.y}|${u.waypoints.map((w) => `${w.x},${w.y},${w.code}`).join(';')}|${this.defenses.map((d) => `${d.type}${d.x},${d.y}`).join(';')}`;
    let p = this.pathCache.get(k);
    if (!p) {
      p = expandPlan(this.map, u.spawn, u.waypoints, this.blockedForPlayer(u.type), this.cls(u.type));
      if (this.pathCache.size > 400) this.pathCache.clear();
      this.pathCache.set(k, p);
    }
    return p;
  }

  private canBuy(i: ShopItem): string | null {
    if (itemCost(i) > this.money) return 'Not enough money';
    if (i.kind === 'unit' && this.units.length >= RULES.maxUnits) return `Max ${RULES.maxUnits} units`;
    if (i.kind === 'def' && this.defenses.length >= RULES.maxDefenses) return `Max ${RULES.maxDefenses} defenses`;
    const cap = i.kind === 'unit' ? UNITS[i.type].maxPerTeam : undefined;
    if (cap !== undefined && this.units.filter((u) => u.type === i.type).length >= cap) return `Max ${cap} ${UNITS[i.type as UnitType].name.toLowerCase()}s`;
    return null;
  }

  private shopTap(i: ShopItem) {
    const why = this.canBuy(i);
    if (why) { this.flash(why, C.danger); return; }
    const same = this.placing && this.placing.kind === i.kind && this.placing.type === i.type;
    this.placing = same ? null : i;
    this.selected = null;
    if (this.placing) {
      if (i.kind === 'unit') {
        const st = UNITS[i.type];
        this.flash(`${st.name}: strong vs ${st.strong.toLowerCase()}, weak vs ${st.weak.toLowerCase()}. Tap the shaded zone.`, C.text);
      } else this.flash(`${DEFENSES[i.type].blurb} Tap inside your half to place.`);
    }
  }

  private placeAt(t: Pt) {
    const i = this.placing!;
    const why = this.canBuy(i);
    if (why) { this.flash(why, C.danger); this.placing = null; return; }
    if (this.occupied(t.x, t.y)) { this.flash('Tile occupied', C.danger); return; }
    if (i.kind === 'unit') {
      if (!canDeployUnit(this.map, PLAYER, t.x, t.y, this.cls(i.type)) || this.blockedForPlayer(i.type).has(key(t.x, t.y))) {
        this.flash(this.cls(i.type) === 'vehicle' ? 'Tanks deploy on open ground in the shaded zone' : 'Units deploy in the shaded zone', C.danger);
        return;
      }
      const id = this.match.newUnitId(PLAYER);
      this.units.push({ id, type: i.type, spawn: t, waypoints: [], veteran: false });
      this.money -= itemCost(i);
      this.placing = null;
      this.selected = { kind: 'unit', id };
      this.flash('Tap the map to add waypoints. Tap a waypoint to set its go code (A → B → C → off).');
    } else {
      if (!canFortify(this.map, PLAYER, t.x, t.y)) { this.flash('Defenses go on open ground in your half', C.danger); return; }
      this.defenses.push({ type: i.type, x: t.x, y: t.y });
      this.money -= itemCost(i);
      if (this.canBuy(i)) this.placing = null;
    }
  }

  private selUnit(): PlanUnit | undefined {
    const s = this.selected;
    return s?.kind === 'unit' ? this.units.find((u) => u.id === s.id) : undefined;
  }

  private planTap(px: number, py: number) {
    const t = this.toTile(px, py);
    if (!t) { this.selected = null; this.placing = null; return; }
    if (this.placing) { this.placeAt(t); return; }

    const sel = this.selUnit();
    // Tap an existing waypoint of the selected unit -> cycle its go code
    if (sel) {
      const wi = sel.waypoints.findIndex((w) => w.x === t.x && w.y === t.y);
      if (wi >= 0) { this.cycleCode(sel.waypoints[wi]); return; }
    }
    const unitHere = this.units.find((u) => u.spawn.x === t.x && u.spawn.y === t.y);
    if (unitHere && unitHere !== sel) { this.selected = { kind: 'unit', id: unitHere.id }; return; }
    const di = this.defenses.findIndex((d) => d.x === t.x && d.y === t.y);
    if (di >= 0 && !sel) { this.selected = { kind: 'def', index: di }; return; }
    if (sel) {
      const cls = this.cls(sel.type);
      const blocked = this.blockedForPlayer(sel.type);
      const target = nearestWalkable(this.map, { x: t.x + 0.5, y: t.y + 0.5 }, blocked, cls);
      const from = sel.waypoints.length ? sel.waypoints[sel.waypoints.length - 1] : sel.spawn;
      if (from.x === target.x && from.y === target.y) return;
      if (!findPath(this.map, from, target, blocked, cls)) { this.flash('No route there', C.danger); return; }
      if (cls === 'vehicle' && (target.x !== t.x || target.y !== t.y)) this.flash('Tanks can’t enter buildings, forest or water — snapped to open ground', C.dim);
      sel.waypoints.push({ ...target, code: null });
      return;
    }
    this.selected = null;
  }

  private cycleCode(w: Waypoint) {
    const order: (GoCode | null)[] = [null, ...GO_CODES];
    w.code = order[(order.indexOf(w.code) + 1) % order.length];
    this.flash(w.code ? `Breakpoint ${CODE_NAMES[w.code]}: waits here until you call ${CODE_NAMES[w.code]}` : 'Breakpoint removed', w.code ? CODE_COLORS[w.code] : C.dim);
  }

  private sellSelected() {
    const s = this.selected;
    if (!s) return;
    if (s.kind === 'unit') {
      const u = this.selUnit();
      if (!u) return;
      if (u.veteran) { this.flash('Veterans can’t be sold', C.danger); return; }
      this.money += UNITS[u.type].cost;
      this.units = this.units.filter((v) => v !== u);
    } else {
      const d = this.defenses[s.index];
      this.money += DEFENSES[d.type].cost;
      this.defenses.splice(s.index, 1);
    }
    this.selected = null;
  }

  // ======================= Live logic =======================

  private command(u: Unit, kind: 'go' | 'recall') {
    this.pending.push({ team: PLAYER, unitId: u.id, kind });
    if (navigator.vibrate) navigator.vibrate(kind === 'go' ? 15 : [20, 40, 20]);
  }

  private callCode(code: GoCode) {
    this.pending.push({ team: PLAYER, kind: 'code', code });
    if (navigator.vibrate) navigator.vibrate(25);
  }

  private liveTap(px: number, py: number) {
    const sim = this.sim!;
    const tx = (px - this.ox) / this.ts, ty = (py - this.oy) / this.ts;
    let best: Unit | null = null, bd = 0.9;
    for (const u of sim.units) {
      if (u.team !== PLAYER || u.state !== 'holding') continue;
      const d = Math.hypot(u.x - tx, u.y - ty);
      if (d < bd) { bd = d; best = u; }
    }
    if (best) this.command(best, 'go');
  }

  // ======================= Input =======================

  private pos(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown(e: PointerEvent) {
    const p = this.pos(e);
    let dragUnit: string | null = null;
    if (this.phase === 'plan' && !this.placing) {
      const t = this.toTile(p.x, p.y);
      const u = t && this.units.find((v) => v.spawn.x === t.x && v.spawn.y === t.y);
      if (u) dragUnit = u.id;
    }
    this.down = { x: p.x, y: p.y, t: this.now, dragUnit, dragging: false };
    this.canvas.setPointerCapture(e.pointerId);
  }

  private onMove(e: PointerEvent) {
    if (!this.down) return;
    const p = this.pos(e);
    if (this.down.dragUnit && Math.hypot(p.x - this.down.x, p.y - this.down.y) > 8) {
      this.down.dragging = true;
      this.dragTile = this.toTile(p.x, p.y);
    }
  }

  private onUp(e: PointerEvent) {
    const d = this.down;
    this.down = null;
    if (!d) return;
    const p = this.pos(e);
    if (d.dragging && d.dragUnit) {
      const t = this.dragTile;
      this.dragTile = null;
      const u = this.units.find((v) => v.id === d.dragUnit);
      if (u && t && canDeployUnit(this.map, PLAYER, t.x, t.y, this.cls(u.type)) && !this.occupied(t.x, t.y) && !this.blockedForPlayer(u.type).has(key(t.x, t.y))) {
        u.spawn = t;
        this.selected = { kind: 'unit', id: u.id };
      } else if (u && t && !(t.x === u.spawn.x && t.y === u.spawn.y)) this.flash('Units start in the deploy zone', C.danger);
      return;
    }
    if (Math.hypot(p.x - d.x, p.y - d.y) > 14) return;
    this.tap(p.x, p.y);
  }

  private tap(x: number, y: number) {
    for (let i = this.hits.length - 1; i >= 0; i--) {
      if (inRect(this.hits[i], x, y)) { this.hits[i].fn(); return; }
    }
    if (this.phase === 'plan') this.planTap(x, y);
    else if (this.phase === 'live') this.liveTap(x, y);
    else if (this.phase === 'roundEnd' && this.now - this.resultAt > 600) {
      if (this.match.winner !== undefined) this.phase = 'matchEnd';
      else this.startPlanning();
    } else if (this.phase === 'matchEnd') this.startMatch();
  }

  private button(r: Rect, label: string, fn: () => void, opts: { color?: string; fill?: string; size?: number; disabled?: boolean } = {}) {
    const ctx = this.ctx;
    roundRect(ctx, r, 7);
    ctx.fillStyle = opts.fill ?? C.button;
    ctx.fill();
    ctx.strokeStyle = opts.color ?? C.panelEdge;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    text(ctx, label, r.x + r.w / 2, r.y + r.h / 2 + 1, opts.size ?? Math.min(15, r.h * 0.42), opts.disabled ? C.dim : (opts.color ?? C.text), 'center', 700);
    if (!opts.disabled) this.hits.push({ ...r, fn });
  }

  // ======================= Drawing: map =======================

  private mapLayer: HTMLCanvasElement | null = null;
  private mapLayerKey = '';

  /** The terrain never changes during a match, so it is painted once into an offscreen layer per size. */
  private drawMap() {
    const m = this.map, ts = this.ts;
    const k = `${m.id}|${ts}|${this.dpr}`;
    if (k !== this.mapLayerKey || !this.mapLayer) {
      const c = this.mapLayer ?? document.createElement('canvas');
      c.width = Math.ceil(m.w * ts * this.dpr);
      c.height = Math.ceil(m.h * ts * this.dpr);
      const lctx = c.getContext('2d')!;
      lctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.paintTerrain(lctx);
      this.mapLayer = c;
      this.mapLayerKey = k;
    }
    this.ctx.drawImage(this.mapLayer, this.ox, this.oy, m.w * ts, m.h * ts);
  }

  private paintTerrain(ctx: CanvasRenderingContext2D) {
    const m = this.map, ts = this.ts;
    const at = (x: number, y: number) => tileAt(m, x, y);
    const dots = (X: number, Y: number, col: string, pts: number[][], size = 0.08) => {
      ctx.fillStyle = col;
      for (const [a, b] of pts) ctx.fillRect(X + a * ts, Y + b * ts, Math.max(1, ts * size), Math.max(1, ts * size));
    };
    // pass 1: ground
    for (let y = 0; y < m.h; y++)
      for (let x = 0; x < m.w; x++) {
        const t = at(x, y), X = x * ts, Y = y * ts;
        const base = (x + y) % 2 ? C.floor : C.floorAlt;
        const fill: Partial<Record<string, string>> = {
          rough: C.rough, road: '#2b2d2c', water: '#0e2633', ford: '#1a3a42', forest: '#13241a',
          interior: (x + y) % 2 ? '#2b241d' : '#2e2720', door: '#2b241d', wall: C.wall, window: C.wall,
        };
        ctx.fillStyle = fill[t] ?? base;
        ctx.fillRect(X, Y, ts + 0.5, ts + 0.5);
        if (t === 'rough') dots(X, Y, C.roughDot, [[0.25, 0.3], [0.7, 0.2], [0.5, 0.65], [0.2, 0.8], [0.8, 0.75]]);
        if (t === 'road') {
          ctx.fillStyle = 'rgba(255,255,255,0.05)';
          const horiz = at(x - 1, y) === 'road' || at(x + 1, y) === 'road';
          if (horiz) ctx.fillRect(X, Y + ts * 0.47, ts * 0.5, ts * 0.06); else ctx.fillRect(X + ts * 0.47, Y, ts * 0.06, ts * 0.5);
        }
        if (t === 'water') {
          ctx.strokeStyle = 'rgba(120,190,230,0.18)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (const yy of [0.3, 0.7]) {
            ctx.moveTo(X + ts * 0.1, Y + ts * yy);
            ctx.quadraticCurveTo(X + ts * 0.3, Y + ts * (yy - 0.1), X + ts * 0.5, Y + ts * yy);
            ctx.quadraticCurveTo(X + ts * 0.7, Y + ts * (yy + 0.1), X + ts * 0.9, Y + ts * yy);
          }
          ctx.stroke();
        }
        if (t === 'ford') dots(X, Y, 'rgba(150,200,210,0.25)', [[0.2, 0.25], [0.6, 0.4], [0.35, 0.7], [0.75, 0.8]], 0.1);
        if (t === 'interior' || t === 'door') {
          ctx.fillStyle = 'rgba(0,0,0,0.18)';
          ctx.fillRect(X, Y + ts * 0.32, ts, 1);
          ctx.fillRect(X, Y + ts * 0.66, ts, 1);
        }
        if (t === 'wall' && at(x, y + 1) !== 'wall' && at(x, y + 1) !== 'window') { ctx.fillStyle = C.wallTop; ctx.fillRect(X, Y + ts * 0.78, ts + 0.5, ts * 0.22); }
        if (t === 'window') {
          const vert = at(x, y - 1) === 'wall' || at(x, y - 1) === 'window' || at(x, y + 1) === 'wall' || at(x, y + 1) === 'window';
          ctx.fillStyle = '#7fc4e8';
          if (vert) ctx.fillRect(X + ts * 0.38, Y + ts * 0.12, ts * 0.24, ts * 0.76);
          else ctx.fillRect(X + ts * 0.12, Y + ts * 0.38, ts * 0.76, ts * 0.24);
        }
        if (t === 'door') {
          ctx.strokeStyle = '#a0763f';
          ctx.lineWidth = Math.max(1.5, ts * 0.1);
          ctx.strokeRect(X + ts * 0.15, Y + ts * 0.15, ts * 0.7, ts * 0.7);
        }
        if (t === 'crate') {
          const p = ts * 0.12;
          ctx.fillStyle = C.crate;
          ctx.fillRect(X + p, Y + p, ts - 2 * p, ts - 2 * p);
          ctx.strokeStyle = C.crateEdge;
          ctx.lineWidth = Math.max(1, ts * 0.06);
          ctx.strokeRect(X + p, Y + p, ts - 2 * p, ts - 2 * p);
          ctx.beginPath();
          ctx.moveTo(X + p, Y + p); ctx.lineTo(X + ts - p, Y + ts - p);
          ctx.moveTo(X + ts - p, Y + p); ctx.lineTo(X + p, Y + ts - p);
          ctx.stroke();
        }
        if (t === 'sandbag') {
          ctx.fillStyle = '#857552';
          for (const [a, b] of [[0.1, 0.18], [0.5, 0.18], [0.3, 0.45], [0.1, 0.72], [0.5, 0.72]]) {
            ctx.beginPath(); ctx.roundRect(X + a * ts, Y + b * ts, ts * 0.4, ts * 0.24, ts * 0.1); ctx.fill();
          }
        }
      }
    // pass 2: tree canopies overlap neighbouring tiles, so draw them on top
    for (let y = 0; y < m.h; y++)
      for (let x = 0; x < m.w; x++) {
        if (at(x, y) !== 'forest') continue;
        const X = x * ts, Y = y * ts;
        for (const [a, b, r, c] of [[0.3, 0.32, 0.3, '#1d3b27'], [0.72, 0.45, 0.28, '#224530'], [0.42, 0.75, 0.3, '#1a3524']] as [number, number, number, string][]) {
          ctx.fillStyle = c;
          ctx.beginPath(); ctx.arc(X + a * ts, Y + b * ts, r * ts, 0, Math.PI * 2); ctx.fill();
        }
      }
    // grid + midline
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= m.w; x++) { ctx.moveTo(x * ts, 0); ctx.lineTo(x * ts, m.h * ts); }
    for (let y = 0; y <= m.h; y++) { ctx.moveTo(0, y * ts); ctx.lineTo(m.w * ts, y * ts); }
    ctx.stroke();
  }

  private drawBase(team: Team, hp: number, defended: boolean | null) {
    const ctx = this.ctx, ts = this.ts;
    const b = this.map.bases[team];
    const X = this.sx(b.x), Y = this.sy(b.y);
    const col = C.team[team];
    if (defended !== null) {
      ctx.beginPath();
      ctx.arc(X, Y, RULES.baseDefendRadius * ts, 0, Math.PI * 2);
      ctx.strokeStyle = defended ? col : 'rgba(255,255,255,0.12)';
      ctx.globalAlpha = defended ? 0.35 : 1;
      ctx.setLineDash(defended ? [] : [ts * 0.25, ts * 0.25]);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    const r: Rect = { x: X - ts * 0.48, y: Y - ts * 0.95, w: ts * 0.96, h: ts * 1.9 };
    roundRect(ctx, r, ts * 0.15);
    ctx.fillStyle = '#0b0f12';
    ctx.fill();
    ctx.lineWidth = Math.max(2, ts * 0.12);
    ctx.strokeStyle = col;
    ctx.stroke();
    // star
    ctx.fillStyle = col;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? ts * 0.15 : ts * 0.34;
      ctx.lineTo(X + Math.cos(a) * rr, Y + Math.sin(a) * rr);
    }
    ctx.fill();
    bar(ctx, { x: X - ts * 0.9, y: Y - ts * 1.35, w: ts * 1.8, h: Math.max(3, ts * 0.16) }, hp / RULES.baseHp, hp / RULES.baseHp > 0.35 ? col : C.danger);
  }

  private drawDefense(d: { type: DefenseType; x: number; y: number; team: Team; hp?: number; maxHp?: number }, alpha = 1) {
    const ctx = this.ctx, ts = this.ts;
    const X = this.sx(d.x), Y = this.sy(d.y), cx = X + ts / 2, cy = Y + ts / 2;
    const col = C.team[d.team];
    ctx.globalAlpha = alpha;
    if (d.type === 'barricade') {
      const p = ts * 0.06;
      ctx.fillStyle = '#4b4a3f';
      ctx.fillRect(X + p, Y + p, ts - 2 * p, ts - 2 * p);
      ctx.save();
      ctx.beginPath(); ctx.rect(X + p, Y + p, ts - 2 * p, ts - 2 * p); ctx.clip();
      ctx.strokeStyle = col;
      ctx.lineWidth = ts * 0.14;
      for (let i = -1; i < 3; i++) { ctx.beginPath(); ctx.moveTo(X + i * ts * 0.45, Y + ts); ctx.lineTo(X + i * ts * 0.45 + ts, Y); ctx.stroke(); }
      ctx.restore();
    } else if (d.type === 'tanktrap') {
      // Czech hedgehog
      ctx.strokeStyle = '#9aa3a8';
      ctx.lineWidth = Math.max(2, ts * 0.13);
      ctx.lineCap = 'round';
      const r = ts * 0.32;
      ctx.beginPath();
      ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
      ctx.moveTo(cx + r, cy - r); ctx.lineTo(cx - r, cy + r);
      ctx.moveTo(cx, cy - r * 1.1); ctx.lineTo(cx, cy + r * 1.1);
      ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(cx, cy, ts * 0.09, 0, Math.PI * 2); ctx.fill();
    } else if (d.type === 'turret') {
      ctx.fillStyle = '#20282e';
      ctx.beginPath(); ctx.arc(cx, cy, ts * 0.42, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.5, ts * 0.1); ctx.stroke();
      ctx.fillStyle = col;
      ctx.fillRect(cx - ts * 0.08, cy - ts * 0.08, ts * 0.45, ts * 0.16);
      ctx.beginPath(); ctx.arc(cx, cy, ts * 0.17, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.5, ts * 0.08);
      ctx.beginPath(); ctx.arc(cx, cy, ts * 0.22, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(cx, cy, ts * 0.08, 0, Math.PI * 2); ctx.fill();
    }
    if (d.hp !== undefined && d.maxHp && d.hp < d.maxHp && d.type !== 'mine')
      bar(ctx, { x: X + ts * 0.1, y: Y - ts * 0.12, w: ts * 0.8, h: Math.max(2, ts * 0.1) }, d.hp / d.maxHp, col);
    ctx.globalAlpha = 1;
  }

  private drawTank(X: number, Y: number, team: Team, facing: number, hull: number) {
    const ctx = this.ctx, ts = this.ts;
    ctx.save();
    ctx.translate(X, Y);
    ctx.rotate(hull);
    const L = ts * 0.92, Wd = ts * 0.66;
    ctx.fillStyle = '#11171b';
    ctx.fillRect(-L / 2, -Wd / 2, L, ts * 0.16);
    ctx.fillRect(-L / 2, Wd / 2 - ts * 0.16, L, ts * 0.16);
    ctx.fillStyle = C.team[team];
    ctx.beginPath(); ctx.roundRect(-L * 0.44, -Wd * 0.36, L * 0.88, Wd * 0.72, ts * 0.08); ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.translate(X, Y);
    ctx.rotate(facing);
    ctx.fillStyle = '#0b0f12';
    ctx.fillRect(0, -ts * 0.06, ts * 0.62, ts * 0.12);
    ctx.beginPath(); ctx.arc(0, 0, ts * 0.21, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = C.team[team]; ctx.lineWidth = Math.max(1.5, ts * 0.06); ctx.stroke();
    ctx.restore();
  }

  private drawUnitGlyph(x: number, y: number, team: Team, type: UnitType, num: number, facing: number,
    opts: { hpFrac?: number; ring?: string; alpha?: number; selected?: boolean; suppressed?: boolean; hull?: number; code?: GoCode | null; overwatch?: boolean } = {}) {
    const ctx = this.ctx, ts = this.ts;
    const X = this.sx(x), Y = this.sy(y), tank = type === 'tank';
    const r = ts * (tank ? 0.46 : 0.36);
    ctx.globalAlpha = opts.alpha ?? 1;
    if (opts.overwatch) {
      // Overwatch: a sight arc in the direction the unit is watching.
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = Math.max(1.5, ts * 0.08);
      ctx.beginPath(); ctx.arc(X, Y, r + ts * 0.32, facing - 0.55, facing + 0.55); ctx.stroke();
    }
    if (tank) {
      if (opts.selected) { ctx.beginPath(); ctx.arc(X, Y, r + ts * 0.18, 0, Math.PI * 2); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); }
      if (opts.ring) { ctx.beginPath(); ctx.arc(X, Y, r + ts * 0.08, 0, Math.PI * 2); ctx.strokeStyle = opts.ring; ctx.lineWidth = Math.max(2, ts * 0.1); ctx.stroke(); }
      this.drawTank(X, Y, team, facing, opts.hull ?? facing);
      this.unitBadges(X, Y, r, team, num, opts);
      ctx.globalAlpha = 1;
      return;
    }
    if (opts.selected) {
      ctx.beginPath(); ctx.arc(X, Y, r + ts * 0.2, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    }
    if (opts.ring) {
      ctx.beginPath(); ctx.arc(X, Y, r + ts * 0.12, 0, Math.PI * 2);
      ctx.strokeStyle = opts.ring; ctx.lineWidth = Math.max(2, ts * 0.1); ctx.stroke();
    }
    // facing wedge
    ctx.fillStyle = C.team[team];
    ctx.beginPath();
    ctx.moveTo(X + Math.cos(facing) * r * 1.45, Y + Math.sin(facing) * r * 1.45);
    ctx.lineTo(X + Math.cos(facing + 0.6) * r, Y + Math.sin(facing + 0.6) * r);
    ctx.lineTo(X + Math.cos(facing - 0.6) * r, Y + Math.sin(facing - 0.6) * r);
    ctx.fill();
    ctx.beginPath(); ctx.arc(X, Y, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0b0f12';
    ctx.beginPath(); ctx.arc(X, Y, r * 0.72, 0, Math.PI * 2); ctx.fill();
    if (type === 'medic') {
      ctx.fillStyle = C.team[team];
      ctx.fillRect(X - r * 0.12, Y - r * 0.45, r * 0.24, r * 0.9);
      ctx.fillRect(X - r * 0.45, Y - r * 0.12, r * 0.9, r * 0.24);
    } else text(ctx, UNITS[type].short, X, Y + 1, Math.max(8, r * 1.05), C.team[team], 'center', 800);
    this.unitBadges(X, Y, r, team, num, opts);
    ctx.globalAlpha = 1;
  }

  private unitBadges(X: number, Y: number, r: number, team: Team, num: number, opts: { hpFrac?: number; suppressed?: boolean; code?: GoCode | null }) {
    const ctx = this.ctx, ts = this.ts;
    if (team === PLAYER && num > 0) {
      const bx = X + r * 0.85, by = Y - r * 0.85;
      ctx.fillStyle = C.team[team];
      ctx.beginPath(); ctx.arc(bx, by, Math.max(5, r * 0.5), 0, Math.PI * 2); ctx.fill();
      text(ctx, String(num), bx, by + 0.5, Math.max(7, r * 0.62), '#0b0f12', 'center', 800);
    }
    if (opts.code) {
      const bx = X - r * 0.9, by = Y - r * 0.9;
      ctx.fillStyle = CODE_COLORS[opts.code];
      ctx.beginPath(); ctx.arc(bx, by, Math.max(5, r * 0.5), 0, Math.PI * 2); ctx.fill();
      text(ctx, opts.code, bx, by + 0.5, Math.max(7, r * 0.62), '#0b0f12', 'center', 900);
    }
    if (opts.suppressed) {
      // pinned-down marker: little chevrons over the head
      ctx.strokeStyle = '#ffffff';
      ctx.globalAlpha *= 0.85;
      ctx.lineWidth = Math.max(1, ts * 0.06);
      ctx.beginPath();
      for (const dx of [-0.25, 0.25]) {
        ctx.moveTo(X + (dx - 0.12) * ts, Y - r - ts * 0.28);
        ctx.lineTo(X + dx * ts, Y - r - ts * 0.16);
        ctx.lineTo(X + (dx + 0.12) * ts, Y - r - ts * 0.28);
      }
      ctx.stroke();
    }
    if (opts.hpFrac !== undefined && opts.hpFrac < 1)
      bar(ctx, { x: X - r, y: Y + r + ts * 0.12, w: r * 2, h: Math.max(2, ts * 0.09) }, opts.hpFrac, opts.hpFrac > 0.35 ? C.ok : C.danger);
  }

  private drawPath(start: Pt, nodes: PathNode[], waypoints: Waypoint[] | null, color: string, emphasis: boolean, fired?: Set<GoCode>, etas?: string[]) {
    const ctx = this.ctx, ts = this.ts;
    if (!nodes.length) return;
    ctx.strokeStyle = color;
    ctx.globalAlpha = emphasis ? 0.95 : 0.45;
    ctx.lineWidth = emphasis ? Math.max(2, ts * 0.1) : Math.max(1.5, ts * 0.07);
    ctx.setLineDash([ts * 0.25, ts * 0.18]);
    ctx.beginPath();
    ctx.moveTo(this.sx(start.x), this.sy(start.y));
    for (const n of nodes) ctx.lineTo(this.sx(n.x + 0.5), this.sy(n.y + 0.5));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    // breakpoints along the path
    for (const n of nodes) if (n.bp) this.drawBreakpoint(n.x + 0.5, n.y + 0.5, n.bp, emphasis, fired?.has(n.bp));
    if (waypoints && emphasis) {
      waypoints.forEach((w, i) => {
        const X = this.sx(w.x + 0.5), Y = this.sy(w.y + 0.5);
        if (!w.code) {
          ctx.fillStyle = color;
          ctx.beginPath(); ctx.arc(X, Y, ts * 0.22, 0, Math.PI * 2); ctx.fill();
          text(ctx, String(i + 1), X, Y + 0.5, Math.max(7, ts * 0.28), '#0b0f12', 'center', 800);
        }
        const eta = etas?.[i];
        if (eta) {
          const fs = Math.max(9, ts * 0.5);
          ctx.font = `700 ${fs}px system-ui`;
          const tw = ctx.measureText(eta).width + 8;
          const ly = Y + ts * 0.5;
          roundRect(ctx, { x: X - tw / 2, y: ly, w: tw, h: fs + 4 }, 4);
          ctx.fillStyle = 'rgba(8,12,14,0.85)';
          ctx.fill();
          text(ctx, eta, X, ly + fs / 2 + 2, fs, C.text, 'center', 700);
        }
      });
    }
  }

  /** Breakpoint marker: a diamond in the go code's color with its letter. Called codes show hollow. */
  private drawBreakpoint(x: number, y: number, code: GoCode, emphasis: boolean, fired = false) {
    const ctx = this.ctx, ts = this.ts, X = this.sx(x), Y = this.sy(y), r = ts * 0.38;
    ctx.globalAlpha = emphasis ? 1 : 0.75;
    ctx.beginPath();
    ctx.moveTo(X, Y - r); ctx.lineTo(X + r, Y); ctx.lineTo(X, Y + r); ctx.lineTo(X - r, Y); ctx.closePath();
    if (fired) {
      ctx.strokeStyle = CODE_COLORS[code]; ctx.lineWidth = 1.5; ctx.stroke();
    } else {
      ctx.fillStyle = CODE_COLORS[code]; ctx.fill();
      text(ctx, code, X, Y + 1, Math.max(7, r * 0.95), '#0b0f12', 'center', 900);
    }
    ctx.globalAlpha = 1;
  }

  /** Arrival time at each waypoint (clock time until the first hold, then time after that code is called). */
  private etaLabels(u: PlanUnit): string[] {
    const st = UNITS[u.type];
    const out: string[] = [];
    let t = 0, prefix = '', wi = 0;
    let px = u.spawn.x + 0.5, py = u.spawn.y + 0.5;
    for (const n of this.pathFor(u)) {
      const cx = n.x + 0.5, cy = n.y + 0.5;
      t += Math.hypot(cx - px, cy - py) / (st.speed * speedMult(tileAt(this.map, Math.floor(px), Math.floor(py)), st.move));
      px = cx; py = cy;
      const w = u.waypoints[wi];
      if (w && w.x === n.x && w.y === n.y) {
        out[wi] = prefix ? `${prefix} +${Math.round(t)}s` : fmtTime(t);
        if (w.code) { prefix = w.code; t = 0; }
        wi++;
      }
    }
    return out;
  }

  /** Objective zones on the map: dashed while pending, pulsing while live (tinted by holder), faded when closed. */
  private drawObjectives() {
    const ctx = this.ctx, ts = this.ts;
    const sim = this.phase === 'plan' ? null : this.sim;
    const pulse = 0.5 + 0.5 * Math.sin(this.now / 220);
    for (const o of this.map.objectives) {
      const phase = sim ? sim.objectivePhase(o) : 'pending';
      const holder = sim && phase === 'live' ? sim.objectiveHolder(o) : null;
      const X = this.sx(o.x), Y = this.sy(o.y), R = o.r * ts;
      ctx.beginPath(); ctx.arc(X, Y, R, 0, Math.PI * 2);
      if (phase === 'live') {
        ctx.fillStyle = holder === 0 ? 'rgba(78,168,255,0.2)' : holder === 1 ? 'rgba(255,92,92,0.2)' : 'rgba(255,210,63,0.08)';
        ctx.fill();
        ctx.strokeStyle = holder === 'contested' ? '#ffffff' : withAlpha(C.hold, 0.55 + 0.45 * pulse);
        ctx.lineWidth = 2.5;
        ctx.setLineDash(holder === 'contested' ? [ts * 0.2, ts * 0.15] : []);
      } else {
        ctx.strokeStyle = phase === 'pending' ? 'rgba(255,210,63,0.6)' : 'rgba(255,255,255,0.18)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([ts * 0.25, ts * 0.2]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      const fs = Math.max(9, ts * 0.55);
      const label = phase === 'live'
        ? `${o.name} · ${holder === 'contested' ? 'CONTESTED' : `${Math.ceil(o.to - sim!.elapsed)}s left`}`
        : phase === 'pending' ? `${o.name} · ${fmtTime(o.from)}–${fmtTime(o.to)}` : `${o.name} · closed`;
      ctx.font = `700 ${fs}px system-ui`;
      const tw = ctx.measureText(label).width + 10;
      // Above the ring, unless that would run into the timeline strip on the top row; then below it.
      const above = Y - R - fs - 4;
      const ly = above < this.sy(1.1) ? Y + R + 3 : above;
      roundRect(ctx, { x: X - tw / 2, y: ly, w: tw, h: fs + 5 }, 4);
      ctx.fillStyle = 'rgba(8,12,14,0.85)';
      ctx.fill();
      text(ctx, label, X, ly + fs / 2 + 2.5, fs, phase === 'live' ? C.hold : phase === 'pending' ? '#e9d79a' : C.dim, 'center', 700);
    }
  }

  /** Round timeline drawn over the map's top wall row: when each objective is live, and (live) the clock. */
  private drawTimeline() {
    const m = this.map;
    if (!m.objectives.length) return;
    const ctx = this.ctx, ts = this.ts;
    const x0 = this.sx(1), x1 = this.sx(m.w - 1), w = x1 - x0;
    const y = this.sy(0) + ts * 0.12, h = ts * 0.76;
    const T = RULES.roundSeconds;
    const sim = this.phase === 'plan' ? null : this.sim;
    roundRect(ctx, { x: x0, y, w, h }, 4);
    ctx.fillStyle = 'rgba(8,12,14,0.9)';
    ctx.fill();
    const fs = Math.max(8, Math.min(12, h * 0.62));
    for (let s = 30; s < T; s += 30) {
      const x = x0 + (s / T) * w;
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(x, y, 1, h);
    }
    for (const o of m.objectives) {
      const a = x0 + (o.from / T) * w, b = x0 + (o.to / T) * w;
      const phase = sim ? sim.objectivePhase(o) : 'pending';
      const holder = sim && phase === 'live' ? sim.objectiveHolder(o) : null;
      ctx.fillStyle = holder === 0 ? 'rgba(78,168,255,0.45)' : holder === 1 ? 'rgba(255,92,92,0.45)'
        : phase === 'closed' ? 'rgba(255,255,255,0.08)' : 'rgba(255,210,63,0.28)';
      ctx.fillRect(a + 1, y + 2, b - a - 2, h - 4);
      fitText(ctx, `${o.name} ${fmtTime(o.from)}`, (a + b) / 2, y + h / 2 + 1, b - a - 6, fs, phase === 'closed' ? C.dim : C.text, 'center', 700, 7);
    }
    if (sim) {
      const x = x0 + Math.min(1, sim.elapsed / T) * w;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x - 1, y - 2, 2, h + 4);
    }
  }

  // ======================= Drawing: planning =======================

  private drawPlan() {
    const ctx = this.ctx, m = this.map, ts = this.ts;
    // zones
    const dz = m.deploy[PLAYER], fz = m.fortify[PLAYER];
    ctx.fillStyle = C.teamDim[PLAYER];
    const dragType = this.down?.dragUnit ? this.units.find((u) => u.id === this.down!.dragUnit)?.type : undefined;
    const zoneCls = (this.placing?.kind === 'unit' && this.placing.type === 'tank') || dragType === 'tank' ? 'vehicle' : 'foot';
    for (let y = 0; y < m.h; y++)
      for (let x = dz.x0; x <= dz.x1; x++) if (canDeployUnit(m, PLAYER, x, y, zoneCls)) ctx.fillRect(this.sx(x), this.sy(y), ts, ts);
    if (this.placing?.kind === 'def') {
      ctx.strokeStyle = 'rgba(78,168,255,0.5)';
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(this.sx(fz.x0), this.sy(1), (fz.x1 - fz.x0 + 1) * ts, (m.h - 2) * ts);
      ctx.setLineDash([]);
    }
    this.drawBase(PLAYER, RULES.baseHp, null);
    this.drawBase(ENEMY, RULES.baseHp, null);
    // enemy side is unknown during planning
    ctx.fillStyle = 'rgba(5,8,10,0.35)';
    ctx.fillRect(this.sx(m.w / 2), this.sy(0), (m.w / 2) * ts, m.h * ts);
    this.drawObjectives();
    this.drawTimeline();

    this.defenses.forEach((d, i) => {
      this.drawDefense({ ...d, team: PLAYER });
      if (this.selected?.kind === 'def' && this.selected.index === i) {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.strokeRect(this.sx(d.x) - 2, this.sy(d.y) - 2, ts + 4, ts + 4);
      }
    });
    const sel = this.selUnit();
    for (const u of this.units) if (u !== sel) this.drawPath({ x: u.spawn.x + 0.5, y: u.spawn.y + 0.5 }, this.pathFor(u), u.waypoints, C.team[PLAYER], false);
    if (sel) this.drawPath({ x: sel.spawn.x + 0.5, y: sel.spawn.y + 0.5 }, this.pathFor(sel), sel.waypoints, '#cfe6ff', true, undefined, this.etaLabels(sel));
    this.units.forEach((u, i) => {
      const dragging = this.down?.dragging && this.down.dragUnit === u.id;
      this.drawUnitGlyph(u.spawn.x + 0.5, u.spawn.y + 0.5, PLAYER, u.type, i + 1, 0, { selected: u === sel, alpha: dragging ? 0.35 : 1 });
    });
    if (this.dragTile && this.down?.dragUnit) {
      const u = this.units.find((v) => v.id === this.down!.dragUnit);
      const t = this.dragTile;
      const ok = !!u && canDeployUnit(m, PLAYER, t.x, t.y, this.cls(u.type)) && !this.occupied(t.x, t.y);
      if (u) this.drawUnitGlyph(t.x + 0.5, t.y + 0.5, PLAYER, u.type, this.units.indexOf(u) + 1, 0, { alpha: 0.8, ring: ok ? C.ok : C.danger });
    }
    if (!this.side) this.drawSelectionTools();
  }

  // ======================= Drawing: live =======================

  private drawLive() {
    const sim = this.sim!, ctx = this.ctx, m = this.map, ts = this.ts;
    const alpha = Math.min(1, this.acc / TICK);
    // corpses & wrecks under everything
    for (const f of this.effects) {
      if (f.kind === 'corpse' && f.tank) {
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = '#1a1d1f';
        ctx.fillRect(this.sx(f.x) - ts * 0.45, this.sy(f.y) - ts * 0.33, ts * 0.9, ts * 0.66);
        ctx.strokeStyle = C.team[f.team]; ctx.lineWidth = 1.5;
        ctx.strokeRect(this.sx(f.x) - ts * 0.45, this.sy(f.y) - ts * 0.33, ts * 0.9, ts * 0.66);
        ctx.globalAlpha = 1;
      } else if (f.kind === 'corpse') {
        ctx.strokeStyle = C.team[f.team]; ctx.globalAlpha = 0.5; ctx.lineWidth = 2;
        const X = this.sx(f.x), Y = this.sy(f.y), r = ts * 0.22;
        ctx.beginPath(); ctx.moveTo(X - r, Y - r); ctx.lineTo(X + r, Y + r); ctx.moveTo(X + r, Y - r); ctx.lineTo(X - r, Y + r); ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (f.kind === 'wreck') {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath(); ctx.arc(this.sx(f.x), this.sy(f.y), ts * 0.4, 0, Math.PI * 2); ctx.fill();
      }
    }
    for (const d of sim.defenses) {
      if (!d.alive) continue;
      if (d.team === PLAYER || this.seenDefs.has(d.id)) this.drawDefense(d, d.team === PLAYER || this.visible.has(d.id) ? 1 : 0.55);
    }
    this.drawBase(PLAYER, sim.bases[PLAYER].hp, sim.baseDefended(PLAYER));
    this.drawBase(ENEMY, sim.bases[ENEMY].hp, this.fogAt(sim.bases[ENEMY].x - 1, sim.bases[ENEMY].y) || this.fogAt(sim.bases[ENEMY].x, sim.bases[ENEMY].y) ? sim.baseDefended(ENEMY) : null);

    // fog of war
    ctx.fillStyle = 'rgba(3,5,7,0.62)';
    for (let y = 0; y < m.h; y++)
      for (let x = 0; x < m.w; x++)
        if (!this.fog[y * m.w + x] && tileAt(m, x, y) !== 'wall') ctx.fillRect(this.sx(x), this.sy(y), ts + 0.5, ts + 0.5);

    this.drawObjectives();
    this.drawTimeline();

    // own remaining paths
    for (const u of sim.units) {
      if (u.team !== PLAYER || u.state === 'dead' || u.pi >= u.path.length) continue;
      this.drawPath({ x: u.x, y: u.y }, u.path.slice(u.pi), null, u.state === 'recalling' ? C.danger : C.team[PLAYER], u.state === 'holding', sim.fired[PLAYER]);
    }

    // tracers / explosions
    for (const f of this.effects) {
      const age = this.now - f.t0;
      if (f.kind === 'tracer') {
        const style = TRACERS[f.dtype];
        if (age > style.life) continue;
        ctx.globalAlpha = 1 - age / style.life;
        ctx.strokeStyle = style.color ?? (f.team === PLAYER ? '#bfe0ff' : '#ffc2b5');
        ctx.lineWidth = style.width;
        ctx.beginPath(); ctx.moveTo(this.sx(f.fx), this.sy(f.fy)); ctx.lineTo(this.sx(f.tx), this.sy(f.ty)); ctx.stroke();
        if (f.hit) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(this.sx(f.tx), this.sy(f.ty), ts * 0.1, 0, Math.PI * 2); ctx.fill(); }
        ctx.globalAlpha = 1;
      } else if (f.kind === 'boom' && age < 600) {
        const k = age / 600;
        ctx.globalAlpha = 1 - k;
        ctx.fillStyle = '#ffb347';
        ctx.beginPath(); ctx.arc(this.sx(f.x), this.sy(f.y), ts * f.r * (0.3 + 0.7 * k), 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // units
    const pulse = 0.5 + 0.5 * Math.sin(this.now / 160);
    for (const u of sim.units) {
      if (u.state === 'dead') continue;
      if (u.team !== PLAYER && !this.visible.has(u.id)) continue;
      const x = u.px + (u.x - u.px) * alpha, y = u.py + (u.y - u.py) * alpha;
      const holdCol = u.holdCode ? CODE_COLORS[u.holdCode] : C.hold;
      const ring = u.team !== PLAYER ? undefined : u.state === 'holding' ? withAlpha(holdCol, 0.4 + 0.6 * pulse) : u.state === 'recalling' || u.state === 'home' ? C.danger : undefined;
      // Hull points where the tank is driving; the turret (facing) tracks targets.
      if (u.type === 'tank' && (u.x !== u.px || u.y !== u.py)) this.hulls.set(u.id, Math.atan2(u.y - u.py, u.x - u.px));
      this.drawUnitGlyph(x, y, u.team, u.type, u.num, u.facing, {
        hpFrac: u.hp / u.maxHp, ring, suppressed: sim.isSuppressed(u), hull: this.hulls.get(u.id) ?? u.facing,
        overwatch: u.team === PLAYER && sim.isOverwatching(u) && u.state !== 'holding',
        code: u.team === PLAYER && u.state === 'holding' ? u.holdCode : null,
      });
    }
  }

  private panelBg() {
    const ctx = this.ctx, p = this.panel;
    ctx.fillStyle = C.panel;
    if (this.side) {
      ctx.fillRect(p.x, p.y, this.W - p.x, this.H - p.y);
      ctx.fillStyle = C.panelEdge;
      ctx.fillRect(p.x, p.y, 1, this.H - p.y);
    } else {
      ctx.fillRect(0, p.y, this.W, this.H - p.y);
      ctx.fillStyle = C.panelEdge;
      ctx.fillRect(0, p.y, this.W, 1);
    }
  }

  /** Lay out n equal cells along the panel (vertical stack on the side, row along the bottom). */
  private cells(n: number, pad = 8, gap = 6, reserve = 0, lead = 0): Rect[] {
    const p = this.panel;
    const out: Rect[] = [];
    if (this.side) {
      const h = Math.min(64, (p.h - pad * 2 - gap * (n - 1) - reserve - lead) / n);
      for (let i = 0; i < n; i++) out.push({ x: p.x + pad, y: p.y + pad + lead + i * (h + gap), w: p.w - pad * 2, h });
    } else {
      const w = Math.min(150, (p.w - pad * 2 - gap * (n - 1) - reserve - lead) / n);
      const x0 = p.x + lead + (p.w - lead - (w * n + gap * (n - 1) + reserve)) / 2;
      for (let i = 0; i < n; i++) out.push({ x: x0 + i * (w + gap), y: p.y + pad, w, h: p.h - pad * 2 });
    }
    return out;
  }

  /** Temporarily draw in screen space at a given glyph size (callers pass screen coords / size as tile coords). */
  private glyphAt(size: number, f: () => void) {
    const save = [this.ts, this.ox, this.oy];
    this.ts = size;
    this.ox = 0;
    this.oy = 0;
    f();
    [this.ts, this.ox, this.oy] = save;
  }

  private drawSelectionTools() {
    const s = this.selected;
    if (!s) return;
    const ctx = this.ctx;
    type Btn = { label: string; fn: () => void; color?: string; fill?: string };
    const codeRow: Btn[] = [];
    const btns: Btn[] = [];
    let title = '';
    let sub = '';
    let sub2 = '';
    if (s.kind === 'unit') {
      const u = this.selUnit();
      if (!u) return;
      const st = UNITS[u.type];
      title = `${this.units.indexOf(u) + 1} · ${st.name}${u.veteran ? ' ★' : ''}`;
      sub = `Strong: ${st.strong}`;
      sub2 = `Weak: ${st.weak}`;
      const last = u.waypoints[u.waypoints.length - 1];
      if (last) {
        for (const c of [null, ...GO_CODES] as (GoCode | null)[]) {
          const on = last.code === c;
          codeRow.push({
            label: c ?? '—', fn: () => { last.code = c; },
            color: c ? CODE_COLORS[c] : C.dim, fill: on ? (c ? withAlpha(CODE_COLORS[c], 0.3) : C.buttonHi) : undefined,
          });
        }
      }
      if (u.waypoints.length) btns.push({ label: 'Undo waypoint', fn: () => { u.waypoints.pop(); } });
      if (u.waypoints.length) btns.push({ label: 'Clear route', fn: () => { u.waypoints = []; } });
      if (!u.veteran) btns.push({ label: `Sell  +$${st.cost}`, fn: () => this.sellSelected(), color: C.danger });
    } else {
      const d = this.defenses[s.index];
      if (!d) return;
      title = DEFENSES[d.type].name;
      sub = DEFENSES[d.type].blurb;
      btns.push({ label: `Sell  +$${DEFENSES[d.type].cost}`, fn: () => this.sellSelected(), color: C.danger });
    }
    btns.push({ label: 'Done', fn: () => { this.selected = null; }, color: C.ok });

    if (this.side) {
      // Replace the shop with the tools for the selection.
      const p = this.panel, pad = 8;
      this.hits.push({ ...p, fn: () => {} });
      const tw = p.w - pad * 2 - 4;
      let y = p.y + 18;
      fitText(ctx, title, p.x + pad + 2, y, tw, 15, C.text, 'left', 800);
      y += 20;
      if (sub) { fitText(ctx, sub, p.x + pad + 2, y, tw, 11, C.ok, 'left', 600, 8); y += 15; }
      if (sub2) { fitText(ctx, sub2, p.x + pad + 2, y, tw, 11, C.danger, 'left', 600, 8); y += 15; }
      y += 6;
      if (s.kind === 'unit') {
        if (codeRow.length) {
          text(ctx, 'Last waypoint go code', p.x + pad + 2, y, 11, C.dim, 'left', 700);
          y += 10;
          const cw = (p.w - pad * 2 - 3 * 5) / 4;
          codeRow.forEach((b, i) => this.button({ x: p.x + pad + i * (cw + 5), y, w: cw, h: 34 }, b.label, b.fn, { color: b.color, fill: b.fill, size: 15 }));
          y += 42;
        } else text(ctx, 'Tap the map to route', p.x + pad + 2, y, 12, C.hold, 'left', 700);
      }
      const bh = Math.min(42, (p.y + p.h - y - pad - btns.length * 6) / btns.length);
      btns.forEach((b, i) => {
        const by = p.y + p.h - pad - (btns.length - i) * (bh + 6) + 6;
        this.button({ x: p.x + pad, y: by, w: p.w - pad * 2, h: bh }, b.label, b.fn, { color: b.color, size: 14 });
      });
      return;
    }
    const h = 36, gap = 6, y = this.panel.y - h - 10;
    ctx.font = '700 14px system-ui';
    const all = [...codeRow.map((b) => ({ ...b, w: 36 })), ...btns.map((b) => ({ ...b, w: Math.max(64, ctx.measureText(b.label).width + 24) }))];
    const titleW = Math.max(120, ctx.measureText(title).width + 24);
    const total = titleW + all.reduce((a, b) => a + b.w + gap, 0);
    let x = Math.max(8, (this.W - total) / 2);
    const panel: Rect = { x: x - 6, y: y - 6, w: total + 6, h: h + 12 };
    roundRect(ctx, panel, 10);
    ctx.fillStyle = 'rgba(12,17,20,0.92)';
    ctx.fill();
    this.hits.push({ ...panel, fn: () => {} });
    text(ctx, title, x + 8, y + h / 2, 14, C.text, 'left', 700);
    x += titleW;
    for (const b of all) {
      this.button({ x, y, w: b.w, h }, b.label, b.fn, { color: b.color, fill: b.fill });
      x += b.w + gap;
    }
  }

  private drawShop() {
    const ctx = this.ctx;
    this.panelBg();
    if (this.side && this.selected) { this.drawSelectionTools(); return; }
    const items = this.shopTab === 'unit' ? SHOP_UNITS : SHOP_DEFS;
    // tabs
    const p = this.panel, pad = 8;
    const tabLead = this.side ? 38 : 76;
    const tabs: ['unit' | 'def', string][] = [['unit', 'UNITS'], ['def', 'DEFENSES']];
    tabs.forEach(([k, label], i) => {
      const r: Rect = this.side
        ? { x: p.x + pad + i * ((p.w - pad * 2) / 2 + 2), y: p.y + pad, w: (p.w - pad * 2) / 2 - 2, h: 30 }
        : { x: p.x + pad, y: p.y + pad + i * ((p.h - pad * 2) / 2 + 2), w: 70, h: (p.h - pad * 2) / 2 - 2 };
      const on = this.shopTab === k;
      this.button(r, label, () => { this.shopTab = k; this.placing = null; }, { color: on ? C.text : C.dim, fill: on ? C.buttonHi : 'transparent', size: 12 });
    });
    const rects = this.cells(items.length, 8, 5, 0, tabLead);
    items.forEach((item, i) => {
      const r = rects[i];
      const why = this.canBuy(item);
      const active = this.placing?.kind === item.kind && this.placing.type === item.type;
      roundRect(ctx, r, 8);
      ctx.fillStyle = active ? C.buttonHi : C.button;
      ctx.fill();
      ctx.strokeStyle = active ? '#fff' : C.panelEdge;
      ctx.lineWidth = active ? 2 : 1;
      ctx.stroke();
      const alpha = why ? 0.42 : 1;
      ctx.globalAlpha = alpha;
      const cost = `$${itemCost(item)}`;
      const costCol = item.kind === 'unit' ? C.ok : C.hold;
      const glyph = (gx: number, gy: number, g: number) => this.glyphAt(g, () => {
        if (item.kind === 'unit') this.drawUnitGlyph(gx / g, gy / g, PLAYER, item.type, 0, -Math.PI / 2, { alpha });
        else this.drawDefense({ type: item.type, x: gx / g - 0.5, y: gy / g - 0.5, team: PLAYER }, alpha);
      });
      if (this.side) {
        const g = Math.min(r.h * 0.62, 28);
        glyph(r.x + 6 + g / 2, r.y + r.h / 2, g);
        ctx.globalAlpha = alpha;
        const fs = Math.max(11, Math.min(14, r.h * 0.32));
        text(ctx, cost, r.x + r.w - 8, r.y + r.h / 2 + 1, fs * 0.92, costCol, 'right', 700);
        const costW = ctx.measureText(cost).width;
        fitText(ctx, itemName(item), r.x + g + 12, r.y + r.h / 2 + 1, r.w - g - 26 - costW, fs, C.text, 'left', 700);
      } else {
        const g = Math.min(r.h * 0.4, r.w * 0.36);
        glyph(r.x + r.w / 2, r.y + r.h * 0.32, g);
        ctx.globalAlpha = alpha;
        const fs = Math.max(10, Math.min(14, r.w * 0.13, r.h * 0.19));
        fitText(ctx, itemName(item), r.x + r.w / 2, r.y + r.h * 0.7, r.w - 8, fs, C.text, 'center', 700);
        text(ctx, cost, r.x + r.w / 2, r.y + r.h * 0.88, fs * 0.9, costCol, 'center', 700);
      }
      ctx.globalAlpha = 1;
      this.hits.push({ ...r, fn: () => this.shopTap(item) });
    });
  }

  private drawCards() {
    const sim = this.sim;
    if (!sim) return;
    const ctx = this.ctx;
    this.panelBg();
    const mine = sim.units.filter((u) => u.team === PLAYER);
    const p = this.panel;
    const codeArea = this.side ? 62 : 3 * 64 + 12;
    const rects = this.cells(Math.max(1, mine.length), 8, 6, codeArea + 6);
    const pulse = 0.5 + 0.5 * Math.sin(this.now / 160);
    const live = this.phase === 'live' && !sim.result;
    mine.forEach((u, i) => {
      const r = rects[i];
      const dead = u.state === 'dead';
      const holding = u.state === 'holding';
      const canRecall = live && (u.state === 'moving' || u.state === 'holding' || u.state === 'done');
      const holdCol = u.holdCode ? CODE_COLORS[u.holdCode] : C.hold;
      let main: Rect, rec: Rect;
      if (this.side) {
        const rw = Math.min(46, r.w * 0.3);
        main = { x: r.x, y: r.y, w: r.w - rw - 5, h: r.h };
        rec = { x: r.x + r.w - rw, y: r.y, w: rw, h: r.h };
      } else {
        main = { x: r.x, y: r.y, w: r.w, h: r.h * 0.64 };
        rec = { x: r.x, y: r.y + r.h * 0.68, w: r.w, h: r.h * 0.32 };
      }
      roundRect(ctx, main, 8);
      ctx.fillStyle = holding ? withAlpha(holdCol, 0.15 + 0.22 * pulse) : C.button;
      ctx.fill();
      ctx.strokeStyle = holding ? holdCol : C.panelEdge;
      ctx.lineWidth = holding ? 2 : 1;
      ctx.stroke();
      ctx.globalAlpha = dead ? 0.35 : 1;
      const g = Math.min(main.h * 0.55, 26);
      const gx = main.x + 6 + g / 2, gy = main.y + main.h * 0.47;
      this.glyphAt(g, () => this.drawUnitGlyph(gx / g, gy / g, PLAYER, u.type, u.num, -Math.PI / 2, { code: holding ? u.holdCode : null }));
      ctx.globalAlpha = dead ? 0.35 : 1;
      const fs = Math.max(10, Math.min(13, main.w * 0.11, main.h * 0.28));
      const label = dead ? 'KIA' : holding ? 'GO ▶' : u.state === 'moving' ? (u.engaged ? 'Engaging' : 'Moving')
        : u.state === 'done' ? (u.engaged ? 'Engaging' : sim.isOverwatching(u) ? 'Overwatch' : 'In position') : u.state === 'recalling' ? 'Falling back' : 'Home';
      const lx = main.x + g + 14;
      fitText(ctx, label, lx, main.y + main.h * 0.36, main.x + main.w - lx - 6, holding ? fs * 1.1 : fs, holding ? holdCol : u.engaged ? C.danger : C.text, 'left', 800, 7);
      bar(ctx, { x: lx, y: main.y + main.h * 0.66, w: main.x + main.w - lx - 8, h: 5 }, u.hp / u.maxHp, u.hp / u.maxHp > 0.35 ? C.ok : C.danger);
      ctx.globalAlpha = 1;
      if (holding && live) this.hits.push({ ...main, fn: () => this.command(u, 'go') });
      roundRect(ctx, rec, 6);
      ctx.fillStyle = canRecall ? 'rgba(255,107,74,0.16)' : 'rgba(255,255,255,0.03)';
      ctx.fill();
      ctx.strokeStyle = canRecall ? C.danger : C.panelEdge;
      ctx.lineWidth = 1;
      ctx.stroke();
      const rl = dead ? '—' : u.state === 'home' || u.state === 'recalling' ? 'HOME' : this.side ? '⟲' : '⟲ RECALL';
      text(ctx, rl, rec.x + rec.w / 2, rec.y + rec.h / 2 + 1, this.side && rl === '⟲' ? 20 : Math.max(9, fs * 0.85), canRecall ? C.danger : C.dim, 'center', 800);
      if (canRecall) this.hits.push({ ...rec, fn: () => this.command(u, 'recall') });
    });

    // Go code buttons. Calling a code early opens it: units arriving later walk straight through.
    const area: Rect = this.side
      ? { x: p.x + 8, y: p.y + p.h - 8 - codeArea + 6, w: p.w - 16, h: codeArea - 6 }
      : (() => { const last = rects[rects.length - 1]; return { x: last.x + last.w + 6, y: last.y, w: codeArea, h: last.h }; })();
    const cw = (area.w - 2 * 6) / 3;
    GO_CODES.forEach((code, i) => {
      const r: Rect = { x: area.x + i * (cw + 6), y: area.y, w: cw, h: area.h };
      const fired = sim.fired[PLAYER].has(code);
      const waiting = mine.filter((u) => u.state === 'holding' && u.holdCode === code).length;
      const pending = mine.filter((u) => u.state === 'moving' && u.path.slice(u.pi).some((n) => n.bp === code)).length;
      const col = CODE_COLORS[code];
      const usable = live && !fired;
      roundRect(ctx, r, 8);
      ctx.fillStyle = fired ? 'rgba(255,255,255,0.03)' : waiting ? withAlpha(col, 0.15 + 0.25 * pulse) : C.button;
      ctx.fill();
      ctx.strokeStyle = fired ? C.panelEdge : waiting || pending ? col : withAlpha(col, 0.35);
      ctx.lineWidth = waiting ? 2 : 1;
      ctx.stroke();
      text(ctx, fired ? '✓' : code, r.x + r.w / 2, r.y + r.h * 0.36, Math.min(22, r.h * 0.4), fired ? C.dim : col, 'center', 900);
      const sub = fired ? 'called' : waiting ? `${waiting} ready` : pending ? `${pending} en route` : CODE_NAMES[code];
      text(ctx, sub, r.x + r.w / 2, r.y + r.h * 0.74, Math.max(9, Math.min(11, r.w * 0.16)), fired ? C.dim : C.text, 'center', 700);
      if (usable) this.hits.push({ ...r, fn: () => this.callCode(code) });
    });
  }

  // ======================= HUD / overlays =======================

  private drawTopBar() {
    const ctx = this.ctx, h = this.top;
    ctx.fillStyle = C.panel;
    ctx.fillRect(0, 0, this.W, h);
    ctx.fillStyle = C.panelEdge;
    ctx.fillRect(0, h - 1, this.W, 1);
    const fs = Math.min(15, h * 0.38);
    const [s0, s1] = [this.match.teams[0].score, this.match.teams[1].score];
    text(ctx, `ROUND ${this.match.round - (this.phase === 'roundEnd' || this.phase === 'matchEnd' ? 1 : 0)}`, 12, h / 2, fs, C.dim, 'left', 800);
    const cx = this.W / 2;
    text(ctx, 'YOU', cx - 34, h / 2, fs, C.team[0], 'right', 800);
    text(ctx, `${s0} – ${s1}`, cx, h / 2, fs * 1.25, C.text, 'center', 800);
    text(ctx, 'AI', cx + 34, h / 2, fs, C.team[1], 'left', 800);
    text(ctx, `first to ${RULES.roundsToWin}`, cx + 34 + fs * 3, h / 2, fs * 0.75, C.dim, 'left', 600);

    if (this.phase === 'plan') {
      // Untimed: the round starts when you say so.
      const bw = 92;
      const canGo = this.units.length > 0;
      this.button({ x: this.W - bw - 8, y: 5, w: bw, h: h - 10 }, 'READY ▶', () => {
        if (!this.units.length) { this.flash('Buy at least one unit first', C.danger); return; }
        this.ready();
      }, { color: canGo ? C.ok : C.dim, size: fs });
      text(ctx, `$${this.money}`, this.W - bw - 20, h / 2, fs * 1.1, C.ok, 'right', 800);
      text(ctx, 'PLAN', 12 + fs * 6, h / 2, fs, C.hold, 'left', 800);
    } else if (this.sim) {
      text(ctx, fmtTime(this.sim.timeLeft), this.W - 12, h / 2, fs * 1.1, this.sim.timeLeft < 15 ? C.danger : C.text, 'right', 800);
      text(ctx, 'LIVE', 12 + fs * 6, h / 2, fs, C.danger, 'left', 800);
      if (this.map.objectives.length) {
        const [p0, p1] = this.sim.score.map((v) => Math.round(v));
        const rx = this.W - 76;
        text(ctx, String(p1), rx, h / 2, fs * 1.05, C.team[1], 'right', 800);
        ctx.font = `800 ${fs * 1.05}px system-ui`;
        const w1 = ctx.measureText(String(p1)).width;
        text(ctx, '·', rx - w1 - 8, h / 2, fs, C.dim, 'center', 800);
        text(ctx, String(p0), rx - w1 - 16, h / 2, fs * 1.05, C.team[0], 'right', 800);
        ctx.font = `800 ${fs * 1.05}px system-ui`;
        const w0 = ctx.measureText(String(p0)).width;
        text(ctx, 'PTS', rx - w1 - 22 - w0, h / 2, fs * 0.75, C.dim, 'right', 700);
      }
    }
  }

  private drawToast() {
    const t = this.toast;
    if (!t || this.now > t.until) return;
    const ctx = this.ctx;
    ctx.font = '700 14px system-ui';
    const areaW = this.side ? this.panel.x : this.W;
    const w = Math.min(areaW - 24, ctx.measureText(t.msg).width + 28);
    // Bottom of the map area: the top of the map carries the objective timeline.
    const r: Rect = { x: (areaW - w) / 2, y: this.oy + this.map.h * this.ts - this.ts * 1.1 - 32, w, h: 32 };
    ctx.globalAlpha = Math.min(1, (t.until - this.now) / 300);
    roundRect(ctx, r, 16);
    ctx.fillStyle = 'rgba(10,14,17,0.92)';
    ctx.fill();
    ctx.strokeStyle = t.color;
    ctx.lineWidth = 1;
    ctx.stroke();
    fitText(ctx, t.msg, r.x + r.w / 2, r.y + 17, r.w - 20, 13, t.color, 'center', 700, 9);
    ctx.globalAlpha = 1;
  }

  private overlay(lines: { s: string; size: number; color?: string; weight?: number }[], footer: string) {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(5,8,10,0.72)';
    ctx.fillRect(0, 0, this.W, this.H);
    const total = lines.reduce((a, l) => a + l.size * 1.5, 0);
    let y = this.H / 2 - total / 2;
    for (const l of lines) {
      y += l.size * 0.75;
      text(ctx, l.s, this.W / 2, y, l.size, l.color ?? C.text, 'center', l.weight ?? 700);
      y += l.size * 0.75;
    }
    const a = 0.5 + 0.5 * Math.sin(this.now / 300);
    ctx.globalAlpha = 0.5 + 0.5 * a;
    text(ctx, footer, this.W / 2, y + 26, 14, C.dim, 'center', 700);
    ctx.globalAlpha = 1;
  }

  private drawRoundEnd() {
    const s = this.summary!;
    const r = s.result;
    const big = Math.min(44, this.W * 0.07);
    const head = r.winner === PLAYER ? 'ROUND WON' : r.winner === ENEMY ? 'ROUND LOST' : 'ROUND DRAWN';
    const col = r.winner === PLAYER ? C.team[0] : r.winner === ENEMY ? C.team[1] : C.hold;
    this.overlay([
      { s: head, size: big, color: col, weight: 900 },
      { s: r.reason, size: 18, color: C.text },
      ...(this.map.objectives.length && !r.reason.includes('objectives') ? [{ s: `Objective points  ${r.score[0]} – ${r.score[1]}`, size: 15, color: C.hold }] : []),
      { s: `Kills  ${r.kills[0]} – ${r.kills[1]}     Survivors carried over: ${r.survivors[0].length}`, size: 15, color: C.dim },
      { s: `+$${s.earned[0]} income`, size: 18, color: C.ok },
    ], this.match.winner !== undefined ? 'Tap to see the result' : 'Tap to plan the next round');
  }

  private drawMatchEnd() {
    const w = this.match.winner;
    const big = Math.min(54, this.W * 0.09);
    this.overlay([
      { s: w === PLAYER ? 'VICTORY' : w === ENEMY ? 'DEFEAT' : 'STALEMATE', size: big, color: w === PLAYER ? C.team[0] : w === ENEMY ? C.team[1] : C.hold, weight: 900 },
      { s: `${this.match.teams[0].score} – ${this.match.teams[1].score}`, size: 26 },
      { s: `${this.match.history.length} rounds played`, size: 15, color: C.dim },
    ], 'Tap to play again');
  }

  private drawTitle() {
    const ctx = this.ctx;
    const rules = [
      ['1', 'Objectives go live on a schedule. Hold one uncontested to score.'],
      ['2', 'Buy and route every unit — waypoints show arrival times. No timer.'],
      ['3', 'Tag waypoints ALPHA/BRAVO/CHARLIE; call the code to move together.'],
      ['4', 'Moving units are exposed. Still, quiet units ambush with aimed fire.'],
      ['5', 'Tanks beat infantry, rockets beat tanks, rifles beat rockets.'],
      ['6', 'Most points at time wins — or wipe them out. First to 5 rounds.'],
    ];
    const fs = Math.max(11, Math.min(16, this.W * 0.021, this.H * 0.034));
    const big = Math.min(64, this.W * 0.1, this.H * 0.11);
    const bh = Math.min(50, Math.max(38, this.H * 0.1)), bw = 220;
    const total = big + fs * 2.2 + rules.length * fs * 1.85 + 16 + bh + 44;
    let y = Math.max(8, (this.H - total) / 2) + big / 2;
    text(ctx, 'WARGAMES', this.W / 2, y, big, C.text, 'center', 900);
    y += big * 0.5 + fs * 1.1;
    text(ctx, 'Skirmish vs AI  ·  Buy. Plan. Execute. Adapt.', this.W / 2, y, fs * 1.1, C.hold, 'center', 700);
    y += fs * 2.1;
    ctx.font = `500 ${fs}px system-ui`;
    const widest = Math.max(...rules.map(([, s]) => ctx.measureText(s).width));
    const x0 = Math.max(12, (this.W - widest - fs * 2) / 2);
    for (const [n, s] of rules) {
      ctx.fillStyle = C.team[0];
      ctx.beginPath(); ctx.arc(x0 + fs * 0.6, y, fs * 0.68, 0, Math.PI * 2); ctx.fill();
      text(ctx, n, x0 + fs * 0.6, y + 1, fs * 0.85, '#0b0f12', 'center', 800);
      text(ctx, s, x0 + fs * 1.9, y, fs, C.text, 'left', 500);
      y += fs * 1.85;
    }
    // map picker
    y += 4;
    const mw = 150, gap = 8;
    let mx = (this.W - (MAP_ORDER.length * mw + (MAP_ORDER.length - 1) * gap)) / 2;
    for (const id of MAP_ORDER) {
      const on = id === this.mapId;
      this.button({ x: mx, y, w: mw, h: 34 }, MAPS[id].name, () => { this.mapId = id; }, { color: on ? C.text : C.dim, fill: on ? C.buttonHi : 'transparent', size: 14 });
      mx += mw + gap;
    }
    text(ctx, MAPS[this.mapId].blurb, this.W / 2, y + 46, Math.max(11, fs * 0.85), C.dim, 'center', 500);
    this.button({ x: (this.W - bw) / 2, y: y + 62, w: bw, h: bh }, 'DEPLOY ▶', () => this.startMatch(), { color: C.ok, size: 20 });
    if (this.H > this.W * 1.05) this.drawRotateHint();
  }

  private drawRotateHint() {
    const ctx = this.ctx;
    const r: Rect = { x: 12, y: this.H - 60, w: this.W - 24, h: 40 };
    roundRect(ctx, r, 10);
    ctx.fillStyle = 'rgba(10,14,17,0.92)';
    ctx.fill();
    text(ctx, '↻ Rotate to landscape for the best view', this.W / 2, r.y + r.h / 2, 14, C.hold, 'center', 700);
  }
}
