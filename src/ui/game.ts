import { DEFENSES, RULES, UNITS, type DefenseType, type Team, type UnitType } from '../sim/config';
import { MAPS, canDeployUnit, canFortify, key, nearestWalkable, tileAt, type Pt } from '../sim/map';
import { expandPlan, findPath, type PathNode, type Waypoint } from '../sim/path';
import { hasLos } from '../sim/los';
import { Sim, ownBlocked, type Command, type DefensePlan, type TeamPlan, type Unit } from '../sim/sim';
import { Match, type RoundSummary } from '../sim/match';
import { AiDirector, planAi } from '../sim/ai';
import { C, bar, fmtTime, inRect, roundRect, text, type Rect } from './draw';

type Phase = 'title' | 'plan' | 'live' | 'roundEnd' | 'matchEnd';
type ShopItem = { kind: 'unit'; type: UnitType } | { kind: 'def'; type: DefenseType };
type Selection = { kind: 'unit'; id: string } | { kind: 'def'; index: number };

interface PlanUnit { id: string; type: UnitType; spawn: Pt; waypoints: Waypoint[]; veteran: boolean }
interface Hit extends Rect { fn: () => void }

type Effect =
  | { kind: 'tracer'; team: Team; fx: number; fy: number; tx: number; ty: number; t0: number; heavy: boolean; hit: boolean }
  | { kind: 'boom'; x: number; y: number; t0: number }
  | { kind: 'corpse'; team: Team; x: number; y: number; t0: number }
  | { kind: 'wreck'; x: number; y: number; t0: number };

const SHOP: ShopItem[] = [
  { kind: 'unit', type: 'rifleman' },
  { kind: 'unit', type: 'gunner' },
  { kind: 'unit', type: 'sniper' },
  { kind: 'unit', type: 'breacher' },
  { kind: 'def', type: 'barricade' },
  { kind: 'def', type: 'turret' },
  { kind: 'def', type: 'mine' },
];
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
  private map = MAPS.crossroads;
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
  private planEnds = 0;
  private placing: ShopItem | null = null;
  private selected: Selection | null = null;
  private lastWaypoints = new Map<string, Waypoint[]>();
  private aiPlan: TeamPlan = { units: [], defenses: [] };
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
    this.planEnds = this.now + RULES.planSeconds * 1000;
    const ai = planAi(this.map, ENEMY, this.match, this.seed + this.match.round * 7919);
    this.aiPlan = ai.plan;
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
    this.ai = new AiDirector(ENEMY, seed + 1);
    this.pending = [];
    this.acc = 0;
    this.effects = [];
    this.seenDefs.clear();
    this.summary = null;
    this.phase = 'live';
    this.refreshVision();
    this.flash('Breakpoints flash yellow — tap the unit card to send them.', C.hold);
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

    if (this.phase === 'plan' && this.now >= this.planEnds) this.ready();
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
        if (shooterSeen || this.fogAt(e.tx, e.ty)) this.effects.push({ kind: 'tracer', team: e.team, fx: e.fx, fy: e.fy, tx: e.tx, ty: e.ty, t0: this.now, heavy: e.heavy, hit: e.hit });
      } else if (e.kind === 'boom') {
        this.effects.push({ kind: 'boom', x: e.x, y: e.y, t0: this.now });
        if (navigator.vibrate) navigator.vibrate(30);
      } else if (e.kind === 'death') {
        if (e.team === PLAYER || this.fogAt(e.x, e.y)) this.effects.push({ kind: 'corpse', team: e.team, x: e.x, y: e.y, t0: this.now });
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

  private blockedForPlayer() { return ownBlocked(this.defenses); }

  private occupied(x: number, y: number) {
    return this.units.some((u) => u.spawn.x === x && u.spawn.y === y) || this.defenses.some((d) => d.x === x && d.y === y);
  }

  private pathFor(u: PlanUnit): PathNode[] {
    const k = `${u.spawn.x},${u.spawn.y}|${u.waypoints.map((w) => `${w.x},${w.y},${+w.hold}`).join(';')}|${this.defenses.map((d) => `${d.type}${d.x},${d.y}`).join(';')}`;
    let p = this.pathCache.get(k);
    if (!p) {
      p = expandPlan(this.map, u.spawn, u.waypoints, this.blockedForPlayer());
      if (this.pathCache.size > 400) this.pathCache.clear();
      this.pathCache.set(k, p);
    }
    return p;
  }

  private canBuy(i: ShopItem): string | null {
    if (itemCost(i) > this.money) return 'Not enough money';
    if (i.kind === 'unit' && this.units.length >= RULES.maxUnits) return `Max ${RULES.maxUnits} units`;
    if (i.kind === 'def' && this.defenses.length >= RULES.maxDefenses) return `Max ${RULES.maxDefenses} defenses`;
    return null;
  }

  private shopTap(i: ShopItem) {
    const why = this.canBuy(i);
    if (why) { this.flash(why, C.danger); return; }
    const same = this.placing && this.placing.kind === i.kind && this.placing.type === i.type;
    this.placing = same ? null : i;
    this.selected = null;
    if (this.placing) this.flash(i.kind === 'unit' ? 'Tap inside your deploy zone (shaded) to place.' : 'Tap inside your half to place. Tap again to place more.');
  }

  private placeAt(t: Pt) {
    const i = this.placing!;
    const why = this.canBuy(i);
    if (why) { this.flash(why, C.danger); this.placing = null; return; }
    if (this.occupied(t.x, t.y)) { this.flash('Tile occupied', C.danger); return; }
    if (i.kind === 'unit') {
      if (!canDeployUnit(this.map, PLAYER, t.x, t.y) || this.blockedForPlayer().has(key(t.x, t.y))) { this.flash('Units deploy in the shaded zone', C.danger); return; }
      const id = this.match.newUnitId(PLAYER);
      this.units.push({ id, type: i.type, spawn: t, waypoints: [], veteran: false });
      this.money -= itemCost(i);
      this.placing = null;
      this.selected = { kind: 'unit', id };
      this.flash('Tap the map to add waypoints. Tap a waypoint to make it a breakpoint.');
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
    // Tap an existing waypoint of the selected unit -> toggle breakpoint
    if (sel) {
      const wi = sel.waypoints.findIndex((w) => w.x === t.x && w.y === t.y);
      if (wi >= 0) {
        sel.waypoints[wi].hold = !sel.waypoints[wi].hold;
        this.flash(sel.waypoints[wi].hold ? 'Breakpoint set: unit will wait here for your GO.' : 'Breakpoint removed', C.hold);
        return;
      }
    }
    const unitHere = this.units.find((u) => u.spawn.x === t.x && u.spawn.y === t.y);
    if (unitHere && unitHere !== sel) { this.selected = { kind: 'unit', id: unitHere.id }; return; }
    const di = this.defenses.findIndex((d) => d.x === t.x && d.y === t.y);
    if (di >= 0 && !sel) { this.selected = { kind: 'def', index: di }; return; }
    if (sel) {
      const blocked = this.blockedForPlayer();
      const target = nearestWalkable(this.map, { x: t.x + 0.5, y: t.y + 0.5 }, blocked);
      const from = sel.waypoints.length ? sel.waypoints[sel.waypoints.length - 1] : sel.spawn;
      if (from.x === target.x && from.y === target.y) return;
      if (!findPath(this.map, from, target, blocked)) { this.flash('No route there', C.danger); return; }
      sel.waypoints.push({ ...target, hold: false });
      return;
    }
    this.selected = null;
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
      if (u && t && canDeployUnit(this.map, PLAYER, t.x, t.y) && !this.occupied(t.x, t.y) && !this.blockedForPlayer().has(key(t.x, t.y))) {
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
    if (this.phase === 'title') { this.startMatch(); return; }
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

  private drawMap() {
    const ctx = this.ctx, m = this.map, ts = this.ts;
    for (let y = 0; y < m.h; y++)
      for (let x = 0; x < m.w; x++) {
        const t = tileAt(m, x, y);
        const X = this.sx(x), Y = this.sy(y);
        if (t === 'wall') {
          ctx.fillStyle = C.wall;
          ctx.fillRect(X, Y, ts + 0.5, ts + 0.5);
          if (tileAt(m, x, y + 1) !== 'wall') { ctx.fillStyle = C.wallTop; ctx.fillRect(X, Y + ts * 0.78, ts + 0.5, ts * 0.22); }
        } else {
          ctx.fillStyle = t === 'rough' ? C.rough : (x + y) % 2 ? C.floor : C.floorAlt;
          ctx.fillRect(X, Y, ts + 0.5, ts + 0.5);
          if (t === 'rough') {
            ctx.fillStyle = C.roughDot;
            for (const [a, b] of [[0.25, 0.3], [0.7, 0.2], [0.5, 0.65], [0.2, 0.8], [0.8, 0.75]]) ctx.fillRect(X + a * ts, Y + b * ts, Math.max(1, ts * 0.08), Math.max(1, ts * 0.08));
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
        }
      }
    // subtle grid
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= m.w; x++) { ctx.moveTo(this.sx(x), this.sy(0)); ctx.lineTo(this.sx(x), this.sy(m.h)); }
    for (let y = 0; y <= m.h; y++) { ctx.moveTo(this.sx(0), this.sy(y)); ctx.lineTo(this.sx(m.w), this.sy(y)); }
    ctx.stroke();
    // midline
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.setLineDash([ts * 0.3, ts * 0.3]);
    ctx.beginPath();
    ctx.moveTo(this.sx(m.w / 2), this.sy(1)); ctx.lineTo(this.sx(m.w / 2), this.sy(m.h - 1));
    ctx.stroke();
    ctx.setLineDash([]);
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

  private drawUnitGlyph(x: number, y: number, team: Team, type: UnitType, num: number, facing: number, opts: { hpFrac?: number; ring?: string; alpha?: number; selected?: boolean } = {}) {
    const ctx = this.ctx, ts = this.ts;
    const X = this.sx(x), Y = this.sy(y), r = ts * 0.36;
    ctx.globalAlpha = opts.alpha ?? 1;
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
    text(ctx, UNITS[type].short, X, Y + 1, Math.max(8, r * 1.05), C.team[team], 'center', 800);
    if (team === PLAYER && num > 0) {
      const bx = X + r * 0.85, by = Y - r * 0.85;
      ctx.fillStyle = C.team[team];
      ctx.beginPath(); ctx.arc(bx, by, Math.max(5, r * 0.5), 0, Math.PI * 2); ctx.fill();
      text(ctx, String(num), bx, by + 0.5, Math.max(7, r * 0.62), '#0b0f12', 'center', 800);
    }
    if (opts.hpFrac !== undefined && opts.hpFrac < 1)
      bar(ctx, { x: X - r, y: Y + r + ts * 0.12, w: r * 2, h: Math.max(2, ts * 0.09) }, opts.hpFrac, opts.hpFrac > 0.35 ? C.ok : C.danger);
    ctx.globalAlpha = 1;
  }

  private drawPath(start: Pt, nodes: PathNode[], waypoints: Waypoint[] | null, color: string, emphasis: boolean) {
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
    for (const n of nodes) if (n.bp) this.drawBreakpoint(n.x + 0.5, n.y + 0.5, emphasis);
    if (waypoints && emphasis) {
      waypoints.forEach((w, i) => {
        const X = this.sx(w.x + 0.5), Y = this.sy(w.y + 0.5);
        if (!w.hold) {
          ctx.fillStyle = color;
          ctx.beginPath(); ctx.arc(X, Y, ts * 0.22, 0, Math.PI * 2); ctx.fill();
          text(ctx, String(i + 1), X, Y + 0.5, Math.max(7, ts * 0.28), '#0b0f12', 'center', 800);
        }
      });
    }
  }

  private drawBreakpoint(x: number, y: number, emphasis: boolean) {
    const ctx = this.ctx, ts = this.ts, X = this.sx(x), Y = this.sy(y), r = ts * 0.32;
    ctx.globalAlpha = emphasis ? 1 : 0.7;
    ctx.fillStyle = C.hold;
    ctx.beginPath();
    ctx.moveTo(X, Y - r); ctx.lineTo(X + r, Y); ctx.lineTo(X, Y + r); ctx.lineTo(X - r, Y); ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#0b0f12';
    ctx.fillRect(X - r * 0.32, Y - r * 0.38, r * 0.2, r * 0.76);
    ctx.fillRect(X + r * 0.12, Y - r * 0.38, r * 0.2, r * 0.76);
    ctx.globalAlpha = 1;
  }

  // ======================= Drawing: planning =======================

  private drawPlan() {
    const ctx = this.ctx, m = this.map, ts = this.ts;
    // zones
    const dz = m.deploy[PLAYER], fz = m.fortify[PLAYER];
    ctx.fillStyle = C.teamDim[PLAYER];
    for (let y = 0; y < m.h; y++)
      for (let x = dz.x0; x <= dz.x1; x++) if (canDeployUnit(m, PLAYER, x, y)) ctx.fillRect(this.sx(x), this.sy(y), ts, ts);
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

    this.defenses.forEach((d, i) => {
      this.drawDefense({ ...d, team: PLAYER });
      if (this.selected?.kind === 'def' && this.selected.index === i) {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.strokeRect(this.sx(d.x) - 2, this.sy(d.y) - 2, ts + 4, ts + 4);
      }
    });
    const sel = this.selUnit();
    for (const u of this.units) if (u !== sel) this.drawPath({ x: u.spawn.x + 0.5, y: u.spawn.y + 0.5 }, this.pathFor(u), u.waypoints, C.team[PLAYER], false);
    if (sel) this.drawPath({ x: sel.spawn.x + 0.5, y: sel.spawn.y + 0.5 }, this.pathFor(sel), sel.waypoints, '#cfe6ff', true);
    this.units.forEach((u, i) => {
      const dragging = this.down?.dragging && this.down.dragUnit === u.id;
      this.drawUnitGlyph(u.spawn.x + 0.5, u.spawn.y + 0.5, PLAYER, u.type, i + 1, 0, { selected: u === sel, alpha: dragging ? 0.35 : 1 });
    });
    if (this.dragTile && this.down?.dragUnit) {
      const u = this.units.find((v) => v.id === this.down!.dragUnit);
      const t = this.dragTile;
      const ok = canDeployUnit(m, PLAYER, t.x, t.y) && !this.occupied(t.x, t.y);
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
      if (f.kind === 'corpse') {
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

    // own remaining paths
    for (const u of sim.units) {
      if (u.team !== PLAYER || u.state === 'dead' || u.pi >= u.path.length) continue;
      this.drawPath({ x: u.x, y: u.y }, u.path.slice(u.pi), null, u.state === 'recalling' ? C.danger : C.team[PLAYER], u.state === 'holding');
    }

    // tracers / explosions
    for (const f of this.effects) {
      const age = this.now - f.t0;
      if (f.kind === 'tracer' && age < 140) {
        ctx.globalAlpha = 1 - age / 140;
        ctx.strokeStyle = f.team === PLAYER ? '#bfe0ff' : '#ffc2b5';
        ctx.lineWidth = f.heavy ? 2.5 : 1.3;
        ctx.beginPath(); ctx.moveTo(this.sx(f.fx), this.sy(f.fy)); ctx.lineTo(this.sx(f.tx), this.sy(f.ty)); ctx.stroke();
        if (f.hit) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(this.sx(f.tx), this.sy(f.ty), ts * 0.1, 0, Math.PI * 2); ctx.fill(); }
        ctx.globalAlpha = 1;
      } else if (f.kind === 'boom' && age < 700) {
        const k = age / 700;
        ctx.globalAlpha = 1 - k;
        ctx.fillStyle = '#ffb347';
        ctx.beginPath(); ctx.arc(this.sx(f.x), this.sy(f.y), ts * RULES.mineBlastRadius * (0.3 + 0.7 * k), 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // units
    const pulse = 0.5 + 0.5 * Math.sin(this.now / 160);
    for (const u of sim.units) {
      if (u.state === 'dead') continue;
      if (u.team !== PLAYER && !this.visible.has(u.id)) continue;
      const x = u.px + (u.x - u.px) * alpha, y = u.py + (u.y - u.py) * alpha;
      const ring = u.team !== PLAYER ? undefined : u.state === 'holding' ? `rgba(255,210,63,${0.4 + 0.6 * pulse})` : u.state === 'recalling' || u.state === 'home' ? C.danger : undefined;
      this.drawUnitGlyph(x, y, u.team, u.type, u.num, u.facing, { hpFrac: u.hp / u.maxHp, ring });
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
  private cells(n: number, pad = 8, gap = 6, reserve = 0): Rect[] {
    const p = this.panel;
    const out: Rect[] = [];
    if (this.side) {
      const h = Math.min(64, (p.h - pad * 2 - gap * (n - 1) - reserve) / n);
      for (let i = 0; i < n; i++) out.push({ x: p.x + pad, y: p.y + pad + i * (h + gap), w: p.w - pad * 2, h });
    } else {
      const w = Math.min(150, (p.w - pad * 2 - gap * (n - 1) - reserve) / n);
      const x0 = p.x + (p.w - (w * n + gap * (n - 1) + reserve)) / 2;
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
    const btns: [string, () => void, string?][] = [];
    let title = '';
    let sub = '';
    if (s.kind === 'unit') {
      const u = this.selUnit();
      if (!u) return;
      title = `${this.units.indexOf(u) + 1} · ${UNITS[u.type].name}`;
      sub = u.veteran ? 'Veteran' : UNITS[u.type].blurb;
      const last = u.waypoints[u.waypoints.length - 1];
      if (last) btns.push([last.hold ? 'Remove hold' : 'Hold here', () => { last.hold = !last.hold; }, C.hold]);
      if (u.waypoints.length) btns.push(['Undo waypoint', () => { u.waypoints.pop(); }]);
      if (u.waypoints.length) btns.push(['Clear route', () => { u.waypoints = []; }]);
      if (!u.veteran) btns.push([`Sell  +$${UNITS[u.type].cost}`, () => this.sellSelected(), C.danger]);
    } else {
      const d = this.defenses[s.index];
      if (!d) return;
      title = DEFENSES[d.type].name;
      sub = DEFENSES[d.type].blurb;
      btns.push([`Sell  +$${DEFENSES[d.type].cost}`, () => this.sellSelected(), C.danger]);
    }
    btns.push(['Done', () => { this.selected = null; }, C.ok]);
    const ctx = this.ctx;

    if (this.side) {
      // Replace the shop with the tools for the selection.
      const p = this.panel, pad = 8;
      this.hits.push({ ...p, fn: () => {} });
      text(ctx, title, p.x + pad + 2, p.y + 18, 15, C.text, 'left', 800);
      text(ctx, sub, p.x + pad + 2, p.y + 38, 11, C.dim, 'left', 500);
      if (s.kind === 'unit' && !this.selUnit()!.waypoints.length) text(ctx, 'Tap the map to route', p.x + pad + 2, p.y + 56, 11, C.hold, 'left', 700);
      const bh = Math.min(44, (p.h - 72 - btns.length * 6) / btns.length);
      btns.forEach(([l, fn, col], i) => {
        const y = p.y + p.h - pad - (btns.length - i) * (bh + 6) + 6;
        this.button({ x: p.x + pad, y, w: p.w - pad * 2, h: bh }, l, fn, { color: col, size: 14 });
      });
      return;
    }
    const h = 36, gap = 8, y = this.panel.y - h - 10;
    ctx.font = '700 14px system-ui';
    const widths = btns.map(([l]) => Math.max(64, ctx.measureText(l).width + 24));
    const titleW = Math.max(110, ctx.measureText(title).width + 24);
    const total = titleW + widths.reduce((a, b) => a + b + gap, 0);
    let x = Math.max(8, (this.W - total) / 2);
    const panel: Rect = { x: x - 6, y: y - 6, w: total + 6, h: h + 12 };
    roundRect(ctx, panel, 10);
    ctx.fillStyle = 'rgba(12,17,20,0.92)';
    ctx.fill();
    this.hits.push({ ...panel, fn: () => {} });
    text(ctx, title, x + 8, y + h / 2, 14, C.text, 'left', 700);
    x += titleW;
    btns.forEach(([l, fn, col], i) => {
      this.button({ x, y, w: widths[i], h }, l, fn, { color: col });
      x += widths[i] + gap;
    });
  }

  private drawShop() {
    const ctx = this.ctx;
    this.panelBg();
    if (this.side && this.selected) { this.drawSelectionTools(); return; }
    const rects = this.cells(SHOP.length, 8, 5, 8);
    SHOP.forEach((item, i) => {
      const r = { ...rects[i] };
      if (i >= 4) { if (this.side) r.y += 8; else r.x += 8; } // gap between units and defenses
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
      if (this.side) {
        const g = Math.min(r.h * 0.62, 30);
        const gx = r.x + 6 + g / 2, gy = r.y + r.h / 2;
        this.glyphAt(g, () => {
          if (item.kind === 'unit') this.drawUnitGlyph(gx / g, gy / g, PLAYER, item.type, 0, -Math.PI / 2, { alpha });
          else this.drawDefense({ type: item.type, x: gx / g - 0.5, y: gy / g - 0.5, team: PLAYER }, alpha);
        });
        ctx.globalAlpha = alpha;
        const fs = Math.max(11, Math.min(14, r.h * 0.3));
        text(ctx, itemName(item), r.x + g + 12, r.y + r.h / 2 + 1, fs, C.text, 'left', 700);
        text(ctx, cost, r.x + r.w - 8, r.y + r.h / 2 + 1, fs * 0.92, costCol, 'right', 700);
      } else {
        const g = Math.min(r.h * 0.42, r.w * 0.38);
        const gx = r.x + r.w / 2, gy = r.y + r.h * 0.32;
        this.glyphAt(g, () => {
          if (item.kind === 'unit') this.drawUnitGlyph(gx / g, gy / g, PLAYER, item.type, 0, -Math.PI / 2, { alpha });
          else this.drawDefense({ type: item.type, x: gx / g - 0.5, y: gy / g - 0.5, team: PLAYER }, alpha);
        });
        ctx.globalAlpha = alpha;
        const fs = Math.max(10, Math.min(15, r.w * 0.13, r.h * 0.2));
        text(ctx, itemName(item), r.x + r.w / 2, r.y + r.h * 0.7, fs, C.text, 'center', 700);
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
    const goAll = this.side ? 52 : 84;
    const rects = this.cells(Math.max(1, mine.length), 8, 6, goAll + 6);
    const pulse = 0.5 + 0.5 * Math.sin(this.now / 160);
    const live = this.phase === 'live' && !sim.result;
    mine.forEach((u, i) => {
      const r = rects[i];
      const dead = u.state === 'dead';
      const holding = u.state === 'holding';
      const canRecall = live && (u.state === 'moving' || u.state === 'holding' || u.state === 'done');
      let main: Rect, rec: Rect;
      if (this.side) {
        const rw = Math.min(54, r.w * 0.36);
        main = { x: r.x, y: r.y, w: r.w - rw - 5, h: r.h };
        rec = { x: r.x + r.w - rw, y: r.y, w: rw, h: r.h };
      } else {
        main = { x: r.x, y: r.y, w: r.w, h: r.h * 0.64 };
        rec = { x: r.x, y: r.y + r.h * 0.68, w: r.w, h: r.h * 0.32 };
      }
      roundRect(ctx, main, 8);
      ctx.fillStyle = holding ? `rgba(255,210,63,${0.18 + 0.25 * pulse})` : C.button;
      ctx.fill();
      ctx.strokeStyle = holding ? C.hold : C.panelEdge;
      ctx.lineWidth = holding ? 2 : 1;
      ctx.stroke();
      ctx.globalAlpha = dead ? 0.35 : 1;
      const g = Math.min(main.h * 0.55, 28);
      const gx = main.x + 6 + g / 2, gy = main.y + main.h * 0.45;
      this.glyphAt(g, () => this.drawUnitGlyph(gx / g, gy / g, PLAYER, u.type, u.num, -Math.PI / 2));
      ctx.globalAlpha = dead ? 0.35 : 1;
      const fs = Math.max(10, Math.min(14, main.w * 0.11, main.h * 0.28));
      const label = dead ? 'KIA' : holding ? 'GO ▶' : u.state === 'moving' ? 'Moving' : u.state === 'done' ? 'In position' : u.state === 'recalling' ? 'Falling back' : 'Home';
      const lx = main.x + g + 14;
      text(ctx, label, lx, main.y + main.h * 0.38, holding ? fs * 1.15 : fs, holding ? C.hold : C.text, 'left', 800);
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
      text(ctx, rl, rec.x + rec.w / 2, rec.y + rec.h / 2 + 1, this.side && rl === '⟲' ? 22 : Math.max(9, fs * 0.85), canRecall ? C.danger : C.dim, 'center', 800);
      if (canRecall) this.hits.push({ ...rec, fn: () => this.command(u, 'recall') });
    });
    const anyHolding = mine.some((u) => u.state === 'holding');
    const p = this.panel;
    const goRect: Rect = this.side
      ? { x: p.x + 8, y: p.y + p.h - 8 - goAll, w: p.w - 16, h: goAll }
      : (() => { const last = rects[rects.length - 1]; return { x: last.x + last.w + 6, y: last.y, w: goAll, h: last.h }; })();
    this.button(goRect, 'GO ALL', () => {
      for (const u of mine) if (u.state === 'holding') this.command(u, 'go');
    }, { color: anyHolding && live ? C.hold : C.dim, disabled: !anyHolding || !live, size: 15 });
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
    text(ctx, 'BLUE', cx - 34, h / 2, fs, C.team[0], 'right', 800);
    text(ctx, `${s0} – ${s1}`, cx, h / 2, fs * 1.25, C.text, 'center', 800);
    text(ctx, 'RED', cx + 34, h / 2, fs, C.team[1], 'left', 800);
    text(ctx, `first to ${RULES.roundsToWin}`, cx + 34 + fs * 3, h / 2, fs * 0.75, C.dim, 'left', 600);

    if (this.phase === 'plan') {
      const left = Math.max(0, (this.planEnds - this.now) / 1000);
      const bw = 92;
      this.button({ x: this.W - bw - 8, y: 5, w: bw, h: h - 10 }, 'READY ▶', () => {
        if (!this.units.length) this.flash('No units: you will lose by elimination!', C.danger);
        this.ready();
      }, { color: C.ok, size: fs });
      text(ctx, fmtTime(left), this.W - bw - 20, h / 2, fs * 1.1, left < 10 ? C.danger : C.text, 'right', 800);
      text(ctx, `$${this.money}`, this.W - bw - 80, h / 2, fs * 1.1, C.ok, 'right', 800);
      text(ctx, 'PLAN', 12 + fs * 6, h / 2, fs, C.hold, 'left', 800);
    } else if (this.sim) {
      text(ctx, fmtTime(this.sim.timeLeft), this.W - 12, h / 2, fs * 1.1, this.sim.timeLeft < 15 ? C.danger : C.text, 'right', 800);
      text(ctx, 'LIVE', 12 + fs * 6, h / 2, fs, C.danger, 'left', 800);
      const alive = [this.sim.alive(0).length, this.sim.alive(1).length];
      text(ctx, `${alive[0]} alive`, this.W - 80, h / 2, fs * 0.85, C.dim, 'right', 700);
    }
  }

  private drawToast() {
    const t = this.toast;
    if (!t || this.now > t.until) return;
    const ctx = this.ctx;
    ctx.font = '700 14px system-ui';
    const w = Math.min(this.W - 24, ctx.measureText(t.msg).width + 28);
    const r: Rect = { x: (this.W - w) / 2, y: this.top + 10, w, h: 32 };
    ctx.globalAlpha = Math.min(1, (t.until - this.now) / 300);
    roundRect(ctx, r, 16);
    ctx.fillStyle = 'rgba(10,14,17,0.92)';
    ctx.fill();
    ctx.strokeStyle = t.color;
    ctx.lineWidth = 1;
    ctx.stroke();
    text(ctx, t.msg, this.W / 2, r.y + 17, 13, t.color, 'center', 700);
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
      ['1', 'Each round you get 60s to buy units and defenses and draw each unit’s route.'],
      ['2', 'Tap a waypoint to make it a breakpoint. Units wait there for your GO.'],
      ['3', 'Then it plays out live. Tap a flashing card to send that unit on.'],
      ['4', 'Win by wiping the enemy, or by hitting their base when nobody guards it.'],
      ['5', '⟲ RECALL sends a unit home for good. Everyone home = draw.'],
      ['6', 'Survivors carry over. Money rolls over. First to 5 rounds wins.'],
    ];
    const fs = Math.max(11, Math.min(16, this.W * 0.021, this.H * 0.036));
    const big = Math.min(64, this.W * 0.1, this.H * 0.12);
    const bh = Math.min(52, Math.max(40, this.H * 0.11)), bw = 220;
    const total = big + fs * 2.2 + rules.length * fs * 1.9 + 16 + bh;
    let y = Math.max(8, (this.H - total) / 2) + big / 2;
    text(ctx, 'WARGAMES', this.W / 2, y, big, C.text, 'center', 900);
    y += big * 0.5 + fs * 1.1;
    text(ctx, 'Buy. Plan. Execute. Adapt.', this.W / 2, y, fs * 1.1, C.hold, 'center', 700);
    y += fs * 2.1;
    ctx.font = `500 ${fs}px system-ui`;
    const widest = Math.max(...rules.map(([, s]) => ctx.measureText(s).width));
    const x0 = Math.max(12, (this.W - widest - fs * 2) / 2);
    for (const [n, s] of rules) {
      ctx.fillStyle = C.team[0];
      ctx.beginPath(); ctx.arc(x0 + fs * 0.6, y, fs * 0.68, 0, Math.PI * 2); ctx.fill();
      text(ctx, n, x0 + fs * 0.6, y + 1, fs * 0.85, '#0b0f12', 'center', 800);
      text(ctx, s, x0 + fs * 1.9, y, fs, C.text, 'left', 500);
      y += fs * 1.9;
    }
    this.button({ x: (this.W - bw) / 2, y: y + 6, w: bw, h: bh }, 'DEPLOY ▶', () => this.startMatch(), { color: C.ok, size: 20 });
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
