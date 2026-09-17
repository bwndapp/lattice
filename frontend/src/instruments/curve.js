/**
 * How a drawn line runs from one point to the next: u (0 … 1 along the segment) → how far
 * it has got (0 … 1). Shared by the editor (CurveEditor.jsx), the patch model and the audio
 * thread (as source), so what you draw is what plays.
 *
 *   s = 0  a power curve: c bends it (0 straight, ±1 strongly), as automation's lines do
 *   s = 1  a sine-shaped segment: c 0 is half a cosine (eases out and in), c -1 a quarter
 *          sine that eases in (it leaves fast), c +1 one that eases out; between, a blend
 */
export function shapeAt(u, c, s) {
  if (!s) return c ? u ** (2 ** (c * 3)) : u
  const half = (1 - Math.cos(Math.PI * u)) / 2
  if (!c) return half
  const quarter = c > 0 ? 1 - Math.cos((Math.PI * u) / 2) : Math.sin((Math.PI * u) / 2)
  return half + (quarter - half) * Math.min(1, Math.abs(c))
}

/** The same function, as an expression the audio thread can be built from. */
export const SHAPE_SOURCE = `(${shapeAt.toString()})`

/** Where a drawn shape is at x (0 … 1), with points { x, y, c?, s? }: 0 … 1. */
export function curveAt(points, x) {
  if (!points.length) return 0.5
  if (x <= points[0].x) return points[0].y
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (x < b.x) {
      const u = b.x > a.x ? (x - a.x) / (b.x - a.x) : 1
      return a.y + (b.y - a.y) * shapeAt(u, a.c ?? 0, a.s ?? 0)
    }
  }
  return points[points.length - 1].y
}
