import type { GoCode, MoveClass } from './config';
import { type GameMap, type Pt, tileAt, passable, stepCost, key } from './map';

const DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/**
 * 8-way A* over tiles, no corner cutting. Terrain cost depends on movement class.
 * `blocked` holds extra impassable tiles (your own defenses).
 * Returns tiles from start (exclusive) to goal (inclusive), or null if unreachable.
 */
export function findPath(m: GameMap, from: Pt, to: Pt, blocked?: Set<number>, cls: MoveClass = 'foot'): Pt[] | null {
  const ok = (x: number, y: number) =>
    passable(tileAt(m, x, y), cls) && !blocked?.has(key(x, y));
  if (!ok(to.x, to.y)) return null;
  if (from.x === to.x && from.y === to.y) return [];

  const n = m.w * m.h;
  const g = new Float64Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const idx = (x: number, y: number) => y * m.w + x;
  const hfn = (x: number, y: number) => {
    const dx = Math.abs(x - to.x), dy = Math.abs(y - to.y);
    return (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * 0.7; // admissible: cheapest tile (road) costs 0.7
  };

  // Binary heap of [f, index]
  const heap: [number, number][] = [];
  const push = (f: number, i: number) => {
    heap.push([f, i]);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p][0] <= heap[c][0]) break;
      [heap[p], heap[c]] = [heap[c], heap[p]];
      c = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1, r = l + 1;
        let s = p;
        if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
        if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
        if (s === p) break;
        [heap[p], heap[s]] = [heap[s], heap[p]];
        p = s;
      }
    }
    return top;
  };

  const s = idx(from.x, from.y);
  g[s] = 0;
  push(hfn(from.x, from.y), s);
  const goal = idx(to.x, to.y);

  while (heap.length) {
    const [, cur] = pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goal) break;
    const cx = cur % m.w, cy = (cur / m.w) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (!ok(nx, ny)) continue;
      if (dx && dy && (!ok(cx + dx, cy) || !ok(cx, cy + dy))) continue;
      const step = (dx && dy ? Math.SQRT2 : 1) * stepCost(tileAt(m, nx, ny), cls);
      const ni = idx(nx, ny);
      const ng = g[cur] + step;
      if (ng < g[ni]) {
        g[ni] = ng;
        came[ni] = cur;
        push(ng + hfn(nx, ny), ni);
      }
    }
  }
  if (came[goal] === -1) return null;
  const out: Pt[] = [];
  for (let c = goal; c !== s; c = came[c]) out.push({ x: c % m.w, y: (c / m.w) | 0 });
  return out.reverse();
}

/** A waypoint; `code` set means it's a breakpoint released by that go code (or a tap on the unit). */
export interface Waypoint extends Pt { code: GoCode | null }
export interface PathNode extends Pt { bp: GoCode | null }

/** Expand a spawn + waypoint list into the full tile path a unit will walk. Unreachable legs are skipped. */
export function expandPlan(m: GameMap, spawn: Pt, waypoints: Waypoint[], blocked?: Set<number>, cls: MoveClass = 'foot'): PathNode[] {
  const nodes: PathNode[] = [];
  let cur = spawn;
  for (const wp of waypoints) {
    const leg = findPath(m, cur, wp, blocked, cls);
    if (!leg) continue;
    for (const p of leg) nodes.push({ x: p.x, y: p.y, bp: null });
    if (nodes.length && (cur.x !== wp.x || cur.y !== wp.y)) nodes[nodes.length - 1].bp = wp.code;
    cur = wp;
  }
  return nodes;
}
