import type { Team } from './config';

export type Tile = 'floor' | 'wall' | 'crate' | 'rough' | 'base';

export interface Pt { x: number; y: number }

export interface GameMap {
  name: string;
  w: number;
  h: number;
  tiles: Tile[]; // row-major
  /** Base center in tile coordinates (the corner shared by its 2x2 tiles). */
  bases: [Pt, Pt];
  /** Inclusive x-range of each team's unit deploy zone. */
  deploy: [{ x0: number; x1: number }, { x0: number; x1: number }];
  /** Inclusive x-range where each team may place defenses. */
  fortify: [{ x0: number; x1: number }, { x0: number; x1: number }];
}

// West half only; the east half is the 180-degree rotation, so the map is fair by construction.
// # wall (blocks move + sight)   o crate (blocks move, gives cover)   : rough (slow)   B base
const WEST_HALF = [
  '##################',
  '#.....:::.........',
  '#.....:::...##....',
  '#...........##..o.',
  '#..o.....#......o.',
  '#........#........',
  '####.....#####....',
  '#......o.......:##',
  '#..............:..',
  '#B.........o......',
  '#B.........o.....o',
  '#..............:..',
  '#......o.......:##',
  '####.....#####....',
  '#........#........',
  '#..o.....#......o.',
  '#...........##..o.',
  '#.....:::...##....',
  '#.....:::.........',
  '##################',
];

const CH: Record<string, Tile> = { '#': 'wall', '.': 'floor', o: 'crate', ':': 'rough', B: 'base' };

function buildCrossroads(): GameMap {
  const h = WEST_HALF.length;
  const half = WEST_HALF[0].length;
  const w = half * 2;
  const tiles: Tile[] = new Array(w * h);
  for (let y = 0; y < h; y++) {
    if (WEST_HALF[y].length !== half) throw new Error(`map row ${y} has wrong width`);
    for (let x = 0; x < half; x++) {
      const t = CH[WEST_HALF[y][x]];
      tiles[y * w + x] = t;
      tiles[(h - 1 - y) * w + (w - 1 - x)] = t;
    }
  }
  return {
    name: 'Crossroads',
    w,
    h,
    tiles,
    bases: [{ x: 1.5, y: 10 }, { x: w - 1.5, y: h - 10 }],
    deploy: [{ x0: 1, x1: 6 }, { x0: w - 7, x1: w - 2 }],
    fortify: [{ x0: 1, x1: half - 3 }, { x0: half + 2, x1: w - 2 }],
  };
}

export const MAPS = { crossroads: buildCrossroads() };

export const tileAt = (m: GameMap, x: number, y: number): Tile =>
  x < 0 || y < 0 || x >= m.w || y >= m.h ? 'wall' : m.tiles[y * m.w + x];

export const isWalkable = (t: Tile) => t === 'floor' || t === 'rough';
export const blocksSight = (t: Tile) => t === 'wall';
export const givesCover = (t: Tile) => t === 'wall' || t === 'crate' || t === 'base';

export const key = (x: number, y: number) => y * 1000 + x;

export function inZone(z: { x0: number; x1: number }, x: number) {
  return x >= z.x0 && x <= z.x1;
}

export function canDeployUnit(m: GameMap, team: Team, x: number, y: number) {
  return inZone(m.deploy[team], x) && isWalkable(tileAt(m, x, y));
}

export function canFortify(m: GameMap, team: Team, x: number, y: number) {
  return inZone(m.fortify[team], x) && isWalkable(tileAt(m, x, y));
}

/** Nearest walkable tile to a point (used to snap taps on walls / the base to something reachable). */
export function nearestWalkable(m: GameMap, p: Pt, blocked?: Set<number>): Pt {
  let best: Pt = { x: Math.floor(p.x), y: Math.floor(p.y) };
  let bestD = Infinity;
  for (let y = 0; y < m.h; y++)
    for (let x = 0; x < m.w; x++) {
      if (!isWalkable(tileAt(m, x, y)) || blocked?.has(key(x, y))) continue;
      const d = (x + 0.5 - p.x) ** 2 + (y + 0.5 - p.y) ** 2;
      if (d < bestD) { bestD = d; best = { x, y }; }
    }
  return best;
}

/** Rotate a tile coordinate 180 degrees (map symmetry): mirrors a plan from one side to the other. */
export const mirrorTile = (m: GameMap, p: Pt): Pt => ({ x: m.w - 1 - p.x, y: m.h - 1 - p.y });
