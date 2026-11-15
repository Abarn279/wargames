export const C = {
  bg: '#0d1215',
  floor: '#1a2227',
  floorAlt: '#1c252a',
  grid: 'rgba(255,255,255,0.035)',
  wall: '#3a4651',
  wallTop: '#53626f',
  crate: '#6a5232',
  crateEdge: '#8c6d43',
  rough: '#262a1f',
  roughDot: '#3a3f2c',
  team: ['#4ea8ff', '#ff5c5c'] as const,
  teamDim: ['rgba(78,168,255,0.14)', 'rgba(255,92,92,0.14)'] as const,
  text: '#e8eef2',
  dim: '#8796a0',
  hold: '#ffd23f',
  danger: '#ff6b4a',
  ok: '#5fdc8a',
  panel: '#121a1f',
  panelEdge: '#2a363e',
  button: '#1d2830',
  buttonHi: '#2a3a45',
};

export interface Rect { x: number; y: number; w: number; h: number }

export const inRect = (r: Rect, x: number, y: number) => x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;

export function roundRect(ctx: CanvasRenderingContext2D, r: Rect, rad: number) {
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, rad);
}

export function text(
  ctx: CanvasRenderingContext2D, s: string, x: number, y: number,
  size: number, color: string = C.text, align: CanvasTextAlign = 'left', weight = 600,
) {
  ctx.font = `${weight} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(s, x, y);
}

export function bar(ctx: CanvasRenderingContext2D, r: Rect, frac: number, color: string) {
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = color;
  ctx.fillRect(r.x, r.y, r.w * Math.max(0, Math.min(1, frac)), r.h);
}

export const fmtTime = (s: number) => {
  const t = Math.ceil(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

/** Draw text shrunk (down to `min` px) or ellipsized so it fits `maxW`. */
export function fitText(
  ctx: CanvasRenderingContext2D, s: string, x: number, y: number, maxW: number,
  size: number, color: string = C.text, align: CanvasTextAlign = 'left', weight = 600, min = 9,
) {
  let fs = size;
  const font = (f: number) => `${weight} ${f}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.font = font(fs);
  while (fs > min && ctx.measureText(s).width > maxW) ctx.font = font(--fs);
  let out = s;
  while (out.length > 1 && ctx.measureText(out).width > maxW) out = out.slice(0, -2) + '…';
  text(ctx, out, x, y, fs, color, align, weight);
}
