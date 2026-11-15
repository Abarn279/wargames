import { type GameMap, tileAt, blocksSight, givesCover, key } from './map';

/** Line of sight between two points in tile space, sampled every quarter tile. */
export function hasLos(m: GameMap, ax: number, ay: number, bx: number, by: number, blockers?: Set<number>): boolean {
  const dx = bx - ax, dy = by - ay;
  const dist = Math.hypot(dx, dy);
  const steps = Math.ceil(dist / 0.25);
  const sx = Math.floor(ax), sy = Math.floor(ay), ex = Math.floor(bx), ey = Math.floor(by);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = Math.floor(ax + dx * t), y = Math.floor(ay + dy * t);
    if ((x === sx && y === sy) || (x === ex && y === ey)) continue;
    if (blocksSight(tileAt(m, x, y))) return false;
    if (blockers?.has(key(x, y))) return false;
  }
  return true;
}

/** Target is in cover if the tile just in front of it (toward the shooter) is a wall, crate, or base. */
export function inCover(m: GameMap, tx: number, ty: number, fromX: number, fromY: number, extra?: Set<number>): boolean {
  const dx = fromX - tx, dy = fromY - ty;
  const d = Math.hypot(dx, dy);
  if (d < 1.2) return false; // point blank: cover doesn't help
  const px = Math.floor(tx + (dx / d) * 0.85), py = Math.floor(ty + (dy / d) * 0.85);
  if (px === Math.floor(tx) && py === Math.floor(ty)) return false;
  return givesCover(tileAt(m, px, py)) || !!extra?.has(key(px, py));
}
