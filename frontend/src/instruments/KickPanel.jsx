import { useEffect, useMemo, useRef, useState } from 'react'
import { drawCurve, drawWave, fitCanvas } from './scope.js'
import { KickDrive } from './kick.js'

/**
 * The kick's face: its waveform and pitch drawn from the knobs as they are, then the
 * knobs in strips. The drawing follows the same maths as the processor (kick.js), drive
 * stage and all, without the click's noise. Each strip shows the knobs you reach for every
 * time; the rest (params marked `more`) fold away behind its 'more'. A param with
 * `choices` is a small menu up front, a row of buttons behind 'more'.
 */
export default function KickPanel({ data, groups, knob, change }) {
  const [open, setOpen] = useState(readOpen)
  const toggle = (key) => setOpen((was) => {
    const next = was.includes(key) ? was.filter((k) => k !== key) : [...was, key]
    writeOpen(next)
    return next
  })
  const pick = (p) => (v) => change((d) => { d[p.key] = v })
  return (
    <div className="kick-panel">
      <KickShape data={data} />
      <div className="sw-groups">
        {groups.map((g) => {
          const front = g.params.filter((p) => !p.more)
          const extra = g.params.filter((p) => p.more)
          const shown = open.includes(g.key) && extra.length > 0
          // a folded-away knob that's been moved: a dot on 'more' says so
          const moved = extra.some((p) => Math.abs(data[p.key] - p.def) > 1e-6)
          return (
            <section key={g.key} className={`sw-group kick-group sw-group-${g.key} ${shown ? 'open' : ''}`} aria-label={g.title}>
              <h3 className="sw-group-title">
                {g.title}
                {extra.length > 0 && (
                  <button type="button" className="kick-more-btn" aria-expanded={shown} onClick={() => toggle(g.key)} title={shown ? 'Fold the rest away' : `${extra.map((p) => p.label).join(', ')}`}>
                    <Chevron open={shown} />{shown ? 'less' : 'more'}
                    {moved && !shown && <span className="kick-more-dot" aria-label="(changed)" />}
                  </button>
                )}
              </h3>
              <div className="kick-row">
                <div className="sw-knobs">
                  {front.map((p) => (p.choices ? <Pick key={p.key} def={p} value={data[p.key]} onChange={pick(p)} /> : knob(p)))}
                </div>
                {shown && (
                  <div className="kick-more">
                    {extra.some((p) => p.choices) && (
                      <div className="kick-choices">
                        {extra.filter((p) => p.choices).map((p) => <Choice key={p.key} def={p} value={data[p.key]} onChange={pick(p)} />)}
                      </div>
                    )}
                    <div className="sw-knobs">{extra.filter((p) => !p.choices).map(knob)}</div>
                  </div>
                )}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

// which strips have their 'more' open, for this browser session
const OPEN_KEY = 'lattice:kick-more'
const readOpen = () => { try { return JSON.parse(sessionStorage.getItem(OPEN_KEY)) ?? [] } catch { return [] } }
const writeOpen = (v) => { try { sessionStorage.setItem(OPEN_KEY, JSON.stringify(v)) } catch { /* storage unavailable */ } }

const Chevron = ({ open }) => (
  <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s' }}>
    <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
)

/** A choice as a small menu, the size of a knob, its name underneath like a knob's. */
function Pick({ def, value, onChange }) {
  const at = Math.round(value)
  return (
    <label className={`kick-pick ${at !== def.def ? 'changed' : ''}`}>
      <select value={at} onChange={(e) => onChange(Number(e.target.value))}>
        {def.choices.map((name, i) => <option key={name} value={i}>{name}</option>)}
      </select>
      <span className="knob-label">{def.label}</span>
    </label>
  )
}

/** A choice as a row of buttons. */
function Choice({ def, value, onChange }) {
  const at = Math.round(value)
  return (
    <div className="kick-choice">
      <span className="kick-choice-label">{def.label}</span>
      <div className="kick-seg" role="radiogroup" aria-label={def.label}>
        {def.choices.map((name, i) => (
          <button key={name} type="button" role="radio" aria-checked={at === i} className={at === i ? 'on' : ''} onClick={() => onChange(i)}>{name}</button>
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
  let drive = null
  if (d.drive > 0.001) { drive = new KickDrive(rate); drive.set(d) }
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
    if (drive) y = drive.run(y, 0, t)
    wave[i] = y * gain
    pitch[i] = f
  }
  return { wave, pitch, length }
}

function KickShape({ data }) {
  const ref = useRef(null)
  const [size, setSize] = useState(0)
  // redraw when the window changes size (the canvas follows it)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const observer = new ResizeObserver(() => setSize(canvas.clientWidth))
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])
  // the hit at the audio rate, so the drawing is the sound (capped for very long kicks)
  const key = JSON.stringify(data) // a fresh object each render: only a change of settings redraws
  const shape = useMemo(() => {
    const length = data.attack + data.hold + data.decay
    return simulate(data, Math.min(48000, 240000 / Math.max(0.05, length)))
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !size) return
    const [ctx, w, h, dpr] = fitCanvas(canvas)
    const css = getComputedStyle(document.documentElement)
    const acid = css.getPropertyValue('--acid').trim() || '#e4ff1a'
    const line = css.getPropertyValue('--line').trim() || '#2e2e2a'
    const muted = css.getPropertyValue('--muted').trim() || '#a3a39a'
    const { wave, pitch, length } = shape

    // time marks: every 10, 50 or 100 ms, whichever gives a handful
    const step = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1].find((s) => length / s <= 10) ?? 1
    ctx.strokeStyle = line
    ctx.lineWidth = 1
    ctx.fillStyle = muted
    ctx.font = `${10 * dpr}px "Martian Mono", ui-monospace, monospace`
    ctx.textBaseline = 'bottom'
    for (let t = step; t < length; t += step) {
      const x = Math.round((t / length) * w) + 0.5
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
      ctx.fillText(`${Math.round(t * 1000)}`, x + 3 * dpr, h - 3 * dpr)
    }
    ctx.beginPath(); ctx.moveTo(0, Math.round(h / 2) + 0.5); ctx.lineTo(w, Math.round(h / 2) + 0.5); ctx.stroke()

    // how the pitch falls, on a log scale from 20 Hz to 4 kHz, behind the wave
    const ly = (f) => h - 4 * dpr - (Math.log(Math.max(20, f) / 20) / Math.log(200)) * (h - 8 * dpr)
    drawCurve(ctx, pitch, { width: w, map: ly, color: muted, lineWidth: 1.25 * dpr, dash: [4 * dpr, 3 * dpr] })

    drawWave(ctx, wave, { width: w, height: h, color: acid, pad: 8 * dpr, lineWidth: 1.4 * dpr })

    ctx.fillStyle = muted
    ctx.textBaseline = 'top'
    ctx.fillText('pitch', 6 * dpr, 6 * dpr)
    const total = `${Math.round(length * 1000)} ms`
    ctx.fillText(total, w - ctx.measureText(total).width - 6 * dpr, 6 * dpr)
  }, [shape, size])
  return <canvas ref={ref} className="kick-shape" role="img" aria-label="The kick's waveform and pitch" />
}
