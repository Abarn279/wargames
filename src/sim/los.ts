import { type GameMap, tileAt, blocksSight, givesCover, key } from './map';

/**
 * Line of sight between two points in tile space, sampled every quarter tile.
 * - Walls and LOS-blocking defenses block.
 * - Windows only pass sight if one end is right at the window (you can shoot out, not see deep in).
 * - Two or more forest tiles in between block sight.
 */
export function hasLos(m: GameMap, ax: number, ay: number, bx: number, by: number, blockers?: Set<number>): boolean {
  const dx = bx - ax, dy = by - ay;
  const dist = Math.hypot(dx, dy);
  const steps = Math.ceil(dist / 0.25);
  const sx = Math.floor(ax), sy = Math.floor(ay), ex = Math.floor(bx), ey = Math.floor(by);
  let forest = 0;
  let lastKey = -1;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = Math.floor(ax + dx * t), y = Math.floor(ay + dy * t);
    if ((x === sx && y === sy) || (x === ex && y === ey)) continue;
    const k = key(x, y);
    if (k === lastKey) continue;
    lastKey = k;
    const tile = tileAt(m, x, y);
    if (blocksSight(tile)) return false;
    if (blockers?.has(k)) return false;
    if (tile === 'window') {
      const cx = x + 0.5, cy = y + 0.5;
      if (Math.hypot(ax - cx, ay - cy) > 1.6 && Math.hypot(bx - cx, by - cy) > 1.6) return false;
    }
    if (tile === 'forest' && ++forest >= 2) return false;
  }
  return true;
}

/** Target is in cover if the tile just in front of it (toward the shooter) is hard cover. */
export function inCover(m: GameMap, tx: number, ty: number, fromX: number, fromY: number, extra?: Set<number>): boolean {
  const dx = fromX - tx, dy = fromY - ty;
  const d = Math.hypot(dx, dy);
  if (d < 1.2) return false; // point blank: cover doesn't help
  const px = Math.floor(tx + (dx / d) * 0.85), py = Math.floor(ty + (dy / d) * 0.85);
  if (px === Math.floor(tx) && py === Math.floor(ty)) return false;
  return givesCover(tileAt(m, px, py)) || !!extra?.has(key(px, py));
}
