import type { MoveClass, Team } from './config';

export type Tile =
  | 'floor' | 'wall' | 'crate' | 'sandbag' | 'rough' | 'base'
  | 'road' | 'water' | 'ford' | 'forest'
  | 'interior' | 'window' | 'door';

export interface Pt { x: number; y: number }

/**
 * A point that scores while it is live: each second one team holds it uncontested is a point.
 * Windows are published before the round, so plans become timelines: where to be, and when.
 */
export interface Objective {
  id: string;
  name: string;
  x: number; y: number; // center, tile coordinates
  r: number; // radius in tiles
  from: number; to: number; // live window, seconds into the round
}

export interface AiLane { pts: Pt[]; hold: number; vehicle: boolean }
/** Positions the AI uses, authored from the west side and mirrored for the east. */
export interface AiSpots {
  lanes: AiLane[];
  guard: Pt[];
  garrison: Pt[];
  turret: Pt[];
  barricade: Pt[];
  tanktrap: Pt[];
  mine: Pt[];
}

export interface GameMap {
  id: string;
  name: string;
  blurb: string;
  w: number;
  h: number;
  tiles: Tile[]; // row-major
  /** Base center in tile coordinates (the corner shared by its 2 tiles). */
  bases: [Pt, Pt];
  /** Inclusive x-range of each team's unit deploy zone. */
  deploy: [{ x0: number; x1: number }, { x0: number; x1: number }];
  /** Inclusive x-range where each team may place defenses. */
  fortify: [{ x0: number; x1: number }, { x0: number; x1: number }];
  ai: AiSpots;
  objectives: Objective[];
}

const CH: Record<string, Tile> = {
  '#': 'wall', '.': 'floor', o: 'crate', s: 'sandbag', ':': 'rough', B: 'base',
  '=': 'road', '~': 'water', f: 'ford', t: 'forest', i: 'interior', w: 'window', d: 'door',
};

/** Build a map from its west half; the east half is the 180-degree rotation, so maps are fair by construction. */
function build(def: Omit<GameMap, 'w' | 'h' | 'tiles' | 'bases' | 'deploy' | 'fortify'> & { west: string[]; baseY: number; deployW: number; fortifyW: number }): GameMap {
  const h = def.west.length;
  const half = def.west[0].length;
  const w = half * 2;
  const tiles: Tile[] = new Array(w * h);
  for (let y = 0; y < h; y++) {
    if (def.west[y].length !== half) throw new Error(`${def.id}: row ${y} has wrong width`);
    for (let x = 0; x < half; x++) {
      const t = CH[def.west[y][x]];
      if (!t) throw new Error(`${def.id}: bad tile '${def.west[y][x]}'`);
      tiles[y * w + x] = t;
      tiles[(h - 1 - y) * w + (w - 1 - x)] = t;
    }
  }
  return {
    id: def.id, name: def.name, blurb: def.blurb, ai: def.ai, objectives: def.objectives,
    w, h, tiles,
    bases: [{ x: 1.5, y: def.baseY }, { x: w - 1.5, y: h - def.baseY }],
    deploy: [{ x0: 1, x1: def.deployW }, { x0: w - 1 - def.deployW, x1: w - 2 }],
    fortify: [{ x0: 1, x1: def.fortifyW }, { x0: w - 1 - def.fortifyW, x1: w - 2 }],
  };
}

// #wall  o crate  s sandbags  : rubble  = road  ~ river  f ford  t forest  i/w/d building floor/window/door  B base
const RIVERSIDE = build({
  id: 'riverside',
  name: 'Riverside',
  blurb: 'Two bridges for armor, a ford for infantry, buildings overlooking both.',
  // The bridges mirror each other (each side has a building overlooking one); the ford is dead center.
  objectives: [
    { id: 'nbridge', name: 'North bridge', x: 20, y: 3.5, r: 2.2, from: 15, to: 45 },
    { id: 'sbridge', name: 'South bridge', x: 20, y: 18.5, r: 2.2, from: 45, to: 75 },
    { id: 'ford', name: 'Ford', x: 20, y: 11, r: 2.6, from: 75, to: 115 },
  ],
  baseY: 11,
  deployW: 6,
  fortifyW: 17,
  west: [
    '####################',
    '#.......::.....ttt.~',
    '#...o............s.~',
    '#...o.==============',
    '#..s..=..........s.~',
    '#.....=..t.##ww##..~',
    '#.....=..t.wiiiiw..~',
    '####..=..t.#iiiid..~',
    '#...s.=....diiiiws.~',
    '#.....=.s..##wd##.ff',
    '#B=====...........ff',
    '#B=====...s..ss...ff',
    '#.....=.tt........ff',
    '#...s.=.tt.#wd##ts.~',
    '####..=.tt.wiiiwtt.~',
    '#.....=.tt.diiidtt.~',
    '#..s..=.tt.##w##...~',
    '#.ttt.=............~',
    '#.ttt.==============',
    '#.ttt.....::.......~',
    '#.......::.........~',
    '####################',
  ],
  ai: {
    lanes: [
      { pts: [{ x: 12, y: 3 }, { x: 18, y: 3 }, { x: 27, y: 3 }, { x: 33, y: 6 }, { x: 36, y: 10 }], hold: 1, vehicle: true },
      { pts: [{ x: 10, y: 10 }, { x: 17, y: 10 }, { x: 24, y: 11 }, { x: 36, y: 11 }], hold: 1, vehicle: false },
      { pts: [{ x: 12, y: 18 }, { x: 18, y: 18 }, { x: 27, y: 18 }, { x: 33, y: 15 }, { x: 36, y: 11 }], hold: 1, vehicle: true },
    ],
    guard: [{ x: 5, y: 9 }, { x: 5, y: 12 }, { x: 3, y: 9 }, { x: 3, y: 12 }],
    garrison: [{ x: 14, y: 7 }, { x: 15, y: 6 }, { x: 13, y: 14 }, { x: 14, y: 15 }],
    turret: [{ x: 4, y: 9 }, { x: 4, y: 12 }, { x: 3, y: 8 }, { x: 3, y: 13 }],
    barricade: [{ x: 4, y: 7 }, { x: 5, y: 7 }, { x: 4, y: 14 }, { x: 5, y: 14 }, { x: 9, y: 10 }, { x: 9, y: 11 }],
    tanktrap: [{ x: 6, y: 7 }, { x: 6, y: 14 }, { x: 12, y: 3 }, { x: 12, y: 18 }],
    mine: [{ x: 14, y: 3 }, { x: 14, y: 18 }, { x: 16, y: 10 }, { x: 16, y: 11 }, { x: 8, y: 4 }, { x: 8, y: 17 }],
  },
});

const CROSSROADS = build({
  id: 'crossroads',
  name: 'Crossroads',
  blurb: 'Compact, open, three lanes. Fast and bloody.',
  objectives: [
    { id: 'north', name: 'North lane', x: 18, y: 2.5, r: 2.2, from: 15, to: 45 },
    { id: 'south', name: 'South lane', x: 18, y: 17.5, r: 2.2, from: 45, to: 75 },
    { id: 'center', name: 'Center', x: 18, y: 10, r: 2.4, from: 75, to: 115 },
  ],
  baseY: 10,
  deployW: 6,
  fortifyW: 15,
  west: [
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
  ],
  ai: {
    lanes: [
      { pts: [{ x: 12, y: 1 }, { x: 23, y: 1 }, { x: 31, y: 5 }, { x: 33, y: 9 }], hold: 1, vehicle: true },
      { pts: [{ x: 13, y: 10 }, { x: 22, y: 10 }, { x: 33, y: 10 }], hold: 1, vehicle: true },
      { pts: [{ x: 12, y: 18 }, { x: 23, y: 18 }, { x: 31, y: 14 }, { x: 33, y: 10 }], hold: 1, vehicle: true },
    ],
    guard: [{ x: 5, y: 9 }, { x: 5, y: 11 }, { x: 4, y: 7 }, { x: 4, y: 12 }],
    garrison: [],
    turret: [{ x: 4, y: 9 }, { x: 4, y: 11 }, { x: 3, y: 7 }, { x: 3, y: 12 }],
    barricade: [{ x: 6, y: 6 }, { x: 6, y: 13 }, { x: 9, y: 9 }, { x: 9, y: 10 }, { x: 7, y: 6 }, { x: 7, y: 13 }],
    tanktrap: [{ x: 8, y: 8 }, { x: 8, y: 11 }, { x: 10, y: 2 }, { x: 10, y: 17 }],
    mine: [{ x: 11, y: 2 }, { x: 11, y: 17 }, { x: 13, y: 9 }, { x: 8, y: 4 }, { x: 8, y: 15 }, { x: 14, y: 11 }],
  },
});

export const MAPS: Record<string, GameMap> = { riverside: RIVERSIDE, crossroads: CROSSROADS };
export const MAP_ORDER = ['riverside', 'crossroads'];

export const tileAt = (m: GameMap, x: number, y: number): Tile =>
  x < 0 || y < 0 || x >= m.w || y >= m.h ? 'wall' : m.tiles[y * m.w + x];

const FOOT = new Set<Tile>(['floor', 'rough', 'road', 'ford', 'forest', 'interior', 'door']);
const VEHICLE = new Set<Tile>(['floor', 'rough', 'road']);

export const passable = (t: Tile, cls: MoveClass = 'foot') => (cls === 'foot' ? FOOT : VEHICLE).has(t);
/** A* step cost multiplier. */
export function stepCost(t: Tile, cls: MoveClass): number {
  if (cls === 'vehicle') return t === 'rough' ? 2 : t === 'road' ? 0.7 : 1;
  return t === 'rough' ? 2 : t === 'ford' ? 2.5 : t === 'forest' ? 1.4 : t === 'road' ? 0.9 : 1;
}
/** Movement speed multiplier while standing on a tile. */
export function speedMult(t: Tile, cls: MoveClass): number {
  if (cls === 'vehicle') return t === 'rough' ? 0.5 : t === 'road' ? 1.3 : 1;
  return t === 'rough' ? 0.55 : t === 'ford' ? 0.45 : t === 'forest' ? 0.8 : t === 'road' ? 1.1 : 1;
}
export const blocksSight = (t: Tile) => t === 'wall';
export const givesCover = (t: Tile) => t === 'wall' || t === 'crate' || t === 'sandbag' || t === 'base' || t === 'window';
/** Units standing here are hard to spot from range. */
export const conceals = (t: Tile) => t === 'forest' || t === 'interior' || t === 'door';
/** Units standing here are garrisoned in a building. */
export const garrisoned = (t: Tile) => t === 'interior' || t === 'door';

export const key = (x: number, y: number) => y * 1000 + x;

export function inZone(z: { x0: number; x1: number }, x: number) {
  return x >= z.x0 && x <= z.x1;
}

export function canDeployUnit(m: GameMap, team: Team, x: number, y: number, cls: MoveClass = 'foot') {
  return inZone(m.deploy[team], x) && passable(tileAt(m, x, y), cls);
}

export function canFortify(m: GameMap, team: Team, x: number, y: number) {
  const t = tileAt(m, x, y);
  return inZone(m.fortify[team], x) && (t === 'floor' || t === 'road' || t === 'rough' || t === 'interior' || t === 'door');
}

/** Nearest passable tile to a point (snaps taps on walls / the base to something reachable). */
export function nearestWalkable(m: GameMap, p: Pt, blocked?: Set<number>, cls: MoveClass = 'foot'): Pt {
  let best: Pt = { x: Math.floor(p.x), y: Math.floor(p.y) };
  let bestD = Infinity;
  for (let y = 0; y < m.h; y++)
    for (let x = 0; x < m.w; x++) {
      if (!passable(tileAt(m, x, y), cls) || blocked?.has(key(x, y))) continue;
      const d = (x + 0.5 - p.x) ** 2 + (y + 0.5 - p.y) ** 2;
      if (d < bestD) { bestD = d; best = { x, y }; }
    }
  return best;
}

/** Rotate a tile coordinate 180 degrees (map symmetry): mirrors a plan from one side to the other. */
export const mirrorTile = (m: GameMap, p: Pt): Pt => ({ x: m.w - 1 - p.x, y: m.h - 1 - p.y });
