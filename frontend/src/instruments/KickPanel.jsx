import { useEffect, useRef } from 'react'

/**
 * The kick's face: its waveform and pitch drawn from the knobs as they are, then the
 * knobs in four strips. The drawing follows the same maths as the processor (kick.js),
 * without the click's noise.
 */
export default function KickPanel({ data, groups, knob }) {
  return (
    <div className="kick-panel">
      <KickShape data={data} />
      <div className="sw-groups">
        {groups.map((g) => (
          <section key={g.key} className={`sw-group sw-group-${g.key}`} aria-label={g.title}>
            <h3 className="sw-group-title">{g.title}</h3>
            <div className="sw-knobs">{g.params.map(knob)}</div>
          </section>
        ))}
      </div>
    </div>
  )
}

/** One hit, worked out: the wave, and how its pitch falls. */
function simulate(d, rate) {
  const length = d.attack + d.hold + d.decay
  const n = Math.max(2, Math.ceil(length * rate))
  const wave = new Float32Array(n)
  const pitch = new Float32Array(n)
  const start = Math.max(d.tune, d.start)
  const drive = d.drive > 0.001 ? 1 + d.drive * 8 : 0
  const norm = drive ? 1 / Math.tanh(drive) : 1
  const gain = 10 ** (d.level / 20)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const u = t / d.sweep
    const f = d.tune * (start / d.tune) ** (u < 1 ? (1 - u) ** d.bend : 0)
    let amp = 0
    if (t < d.attack) amp = t / d.attack
    else if (t < d.attack + d.hold) amp = 1
    else amp = Math.max(0, 1 - (t - d.attack - d.hold) / d.decay) ** d.curve
    phase += f / rate
    let y = Math.sin(2 * Math.PI * phase)
    if (d.shape > 0.001) { const g = 1 + d.shape * 6; y = Math.tanh(y * g) / Math.tanh(g) }
    y *= amp
    if (drive) y = Math.tanh(y * drive) * norm
    wave[i] = y * gain
    pitch[i] = f
  }
  return { wave, pitch, length }
}

function KickShape({ data }) {
  const ref = useRef(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const css = getComputedStyle(document.documentElement)
    const acid = css.getPropertyValue('--acid').trim() || '#e4ff1a'
    const line = css.getPropertyValue('--line').trim() || '#2e2e2a'
    const muted = css.getPropertyValue('--muted').trim() || '#a3a39a'

    // enough samples to see each cycle of the start of the sweep
    const { wave, pitch, length } = simulate(data, 12000)
    const mid = h / 2
    ctx.strokeStyle = line
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(0, mid + 0.5); ctx.lineTo(w, mid + 0.5); ctx.stroke()

    // the wave: min and max of every column, so fast early cycles read as a filled shape
    const per = wave.length / w
    ctx.fillStyle = acid
    for (let x = 0; x < w; x++) {
      const from = Math.floor(x * per)
      const to = Math.max(from + 1, Math.floor((x + 1) * per))
      let lo = 1
      let hi = -1
      for (let i = from; i < to && i < wave.length; i++) { if (wave[i] < lo) lo = wave[i]; if (wave[i] > hi) hi = wave[i] }
      if (hi < lo) continue
      const y0 = mid - Math.min(1.2, hi) * (mid - 6)
      const y1 = mid - Math.max(-1.2, lo) * (mid - 6)
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0))
    }

    // the pitch, on a log scale from 20 Hz to 4 kHz
    const ly = (f) => h - 4 - (Math.log(f / 20) / Math.log(200)) * (h - 8)
    ctx.strokeStyle = muted
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let x = 0; x < w; x++) {
      const f = pitch[Math.min(pitch.length - 1, Math.floor(x * per))]
      if (x === 0) ctx.moveTo(x, ly(f)); else ctx.lineTo(x, ly(f))
    }
    ctx.stroke()

    ctx.fillStyle = muted
    ctx.font = '10px "Martian Mono", ui-monospace, monospace'
    ctx.textBaseline = 'top'
    ctx.fillText(`${Math.round(length * 1000)} ms`, w - 60, 6)
    ctx.fillText('pitch', 6, 6)
  }, [data])
  return <canvas ref={ref} className="kick-shape" role="img" aria-label="The kick's waveform and pitch" />
}
