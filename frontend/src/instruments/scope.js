/**
 * Drawing a rendered sound, for instrument windows: smooth at any zoom.
 *
 * Where a screen pixel holds less than a cycle, the wave is drawn as the line it is, through
 * every sample at its exact (sub-pixel) place. Where a pixel holds whole cycles, a line would
 * scribble, so that stretch is drawn as its outline instead: a filled band from each
 * pixel's lowest point to its highest, with smooth edges. The two meet where the wave's
 * peaks are, so the change from one to the other doesn't show.
 *
 * Everything is drawn in device pixels, so it's sharp on any screen.
 */

/** Size a canvas to its box at the screen's density; returns [context, width, height, dpr]. */
export function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, w, h)
  return [ctx, w, h, dpr]
}

/**
 * Draw `samples` across the canvas, 0 at the middle, ±`range` at the edges (less `pad`).
 * `color` for the line and band; the band is filled with a fade of it.
 */
export function drawWave(ctx, samples, { x = 0, y = 0, width, height, color, range = 1, pad = 6, lineWidth = 1.5 } = {}) {
  const n = samples.length
  if (n < 2 || width < 2) return
  const mid = y + height / 2
  const scale = (height / 2 - pad) / range
  const py = (v) => mid - Math.max(-range * 1.15, Math.min(range * 1.15, v)) * scale
  const per = n / width // samples per device pixel
  const cols = Math.ceil(width)

  // for each pixel column: its lowest and highest point, and how often it crosses zero
  const lo = new Float32Array(cols)
  const hi = new Float32Array(cols)
  const crossings = new Uint16Array(cols)
  let sign = 0
  for (let c = 0; c < cols; c++) {
    const from = Math.floor(c * per)
    const to = Math.min(n, Math.max(from + 1, Math.floor((c + 1) * per) + 1))
    let min = Infinity
    let max = -Infinity
    let count = 0
    for (let i = from; i < to; i++) {
      const v = samples[i]
      if (v < min) min = v
      if (v > max) max = v
      const sg = v > 1e-9 ? 1 : v < -1e-9 ? -1 : 0
      if (sg && sg !== sign) { if (sign) count++; sign = sg }
    }
    lo[c] = min
    hi[c] = max
    crossings[c] = count
  }
  // too busy for a line: where half a cycle is narrower than three line widths, the strokes
  // (and a squared wave's two edges) would run into each other, so that stretch is a band
  const reach = Math.max(1, Math.ceil(3 * lineWidth))
  const dense = new Uint8Array(cols)
  let windowed = 0
  for (let c = -reach; c < cols; c++) {
    if (c + reach < cols) windowed += crossings[c + reach]
    if (c - reach - 1 >= 0) windowed -= crossings[c - reach - 1]
    if (c < 0) continue
    const span = Math.min(cols - 1, c + reach) - Math.max(0, c - reach) + 1
    dense[c] = windowed > 0 && span / windowed < 3 * lineWidth ? 1 : 0
  }
  // the band's edges: the highest and lowest point near each column (a pixel on its own may
  // hold only part of a cycle, and its edges would zigzag)
  const top = new Float32Array(cols)
  const bottom = new Float32Array(cols)
  for (let c = 0; c < cols; c++) {
    let max = -Infinity
    let min = Infinity
    for (let k = Math.max(0, c - reach); k <= Math.min(cols - 1, c + reach); k++) {
      if (hi[k] > max) max = hi[k]
      if (lo[k] < min) min = lo[k]
    }
    top[c] = max
    bottom[c] = min
  }
  // a short gap between busy stretches is busy too, so the band doesn't flicker into lines
  for (let c = 0; c < cols; c++) {
    if (dense[c] || !c || !dense[c - 1]) continue
    let end = c
    while (end < cols && !dense[end]) end++
    if (end < cols && end - c <= 2 * reach) dense.fill(1, c, end)
    c = end
  }

  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  // the band, one filled shape per run of busy columns
  const fill = ctx.createLinearGradient(0, y, 0, y + height)
  fill.addColorStop(0, withAlpha(color, 0.8))
  fill.addColorStop(0.5, withAlpha(color, 0.45))
  fill.addColorStop(1, withAlpha(color, 0.8))
  ctx.fillStyle = fill
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  for (let c = 0; c < cols; c++) {
    if (!dense[c]) continue
    let end = c
    while (end + 1 < cols && dense[end + 1]) end++
    ctx.beginPath()
    ctx.moveTo(x + c, py(top[c]))
    for (let k = c + 1; k <= end; k++) ctx.lineTo(x + k + 0.5, py(top[k]))
    ctx.lineTo(x + end + 1, py(top[end]))
    ctx.lineTo(x + end + 1, py(bottom[end]))
    for (let k = end; k >= c; k--) ctx.lineTo(x + k + 0.5, py(bottom[k]))
    ctx.lineTo(x + c, py(bottom[c]))
    ctx.closePath()
    ctx.fill()
    // its top and bottom edges, not its ends (those would read as bars)
    for (const edge of [top, bottom]) {
      ctx.beginPath()
      ctx.moveTo(x + c, py(edge[c]))
      for (let k = c; k <= end; k++) ctx.lineTo(x + k + 0.5, py(edge[k]))
      ctx.lineTo(x + end + 1, py(edge[end]))
      ctx.stroke()
    }
    c = end
  }

  // the line, through every sample of the quiet columns (and one either side, to join up)
  ctx.beginPath()
  let drawing = false
  let last = -1 // the last sample drawn: each goes in once, in order
  for (let c = 0; c < cols; c++) {
    if (dense[c]) { drawing = false; continue }
    const from = Math.max(0, last + 1, Math.floor(c * per) - 1)
    const to = Math.min(n, Math.floor((c + 1) * per) + 2)
    for (let i = from; i < to; i++) {
      const px = x + i / per
      if (!drawing) { ctx.moveTo(px, py(samples[i])); drawing = true } else ctx.lineTo(px, py(samples[i]))
      last = i
    }
  }
  ctx.stroke()
  ctx.restore()
}

/** A smooth line for a value that changes slowly (a pitch, an envelope), `map` → screen y. */
export function drawCurve(ctx, values, { x = 0, width, map, color, lineWidth = 1.5, dash = null }) {
  const n = values.length
  if (n < 2) return
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.lineJoin = 'round'
  if (dash) ctx.setLineDash(dash)
  ctx.beginPath()
  // one point per device pixel is as smooth as a slow curve gets
  const cols = Math.ceil(width)
  for (let c = 0; c <= cols; c++) {
    const at = Math.min(n - 1, (c / cols) * (n - 1))
    const i = Math.floor(at)
    const f = at - i
    const v = values[i] + (values[Math.min(n - 1, i + 1)] - values[i]) * f
    if (c === 0) ctx.moveTo(x + c, map(v)); else ctx.lineTo(x + c, map(v))
  }
  ctx.stroke()
  ctx.restore()
}

/** A CSS colour (#rgb, #rrggbb or rgb()) at an alpha. */
export function withAlpha(color, alpha) {
  const c = String(color).trim()
  let m = /^#([0-9a-f]{3})$/i.exec(c)
  if (m) return `rgba(${[...m[1]].map((d) => parseInt(d + d, 16)).join(', ')}, ${alpha})`
  m = /^#([0-9a-f]{6})$/i.exec(c)
  if (m) return `rgba(${[0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).join(', ')}, ${alpha})`
  m = /^rgba?\(([^)]+)\)$/i.exec(c)
  if (m) return `rgba(${m[1].split(',').slice(0, 3).join(',')}, ${alpha})`
  return c
}
