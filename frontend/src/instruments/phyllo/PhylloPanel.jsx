import { useEffect, useMemo, useRef, useState } from 'react'
import Knob from '../../Knob.jsx'
import { drawCurve, drawWave, fitCanvas } from '../scope.js'
import {
  FILTER_SLOPES, FILTER_TYPES, FM_WAVES, K, LFO_BARS, LFO_MODES, LFO_PRESETS, MAX_LAYERS, MAX_ROUTES, NOISES, PRESETS, SOURCE_LABELS,
  TABLES, TABLE_NAMES, WARP_MODES, barsLabel, layerKnobKey, makeLayer, newPartId, normalizePatch, targetSpec,
} from './model.js'
import { tableFrame } from './tables.js'
import CurveEditor from '../CurveEditor.jsx'
import './phyllo.css'

/**
 * Phyllo's face, inside its instrument window: oscillators and filter across the top,
 * envelopes and LFOs below, each modulator listing where it goes, and a keyboard.
 *
 * Props from the window: `data` (the patch), `change(fn)` (edit a copy of it),
 * `target(key)` (a knob's automation target) and `hold(note)` (play until the returned
 * function is called).
 */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const PRESET_KEY = 'phyllo:presets'
const NOTE_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b']
const noteName = (m) => `${NOTE_NAMES[m % 12]}${Math.floor(m / 12) - 1}`
const letter = (i) => String.fromCharCode(65 + i)

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable */ }
}

// ── drawing ──────────────────────────────────────────────────────────────────

/** A small canvas, drawn by `draw(ctx, w, h, dpr, colors)` in device pixels, redrawn on resize. */
function Scope({ className = '', draw, deps }) {
  const ref = useRef(null)
  const [size, setSize] = useState(0)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ro = new ResizeObserver(() => setSize(canvas.clientWidth * 10000 + canvas.clientHeight))
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !size) return
    const [ctx, w, h, dpr] = fitCanvas(canvas)
    const css = getComputedStyle(canvas)
    draw(ctx, w, h, dpr, { ink: css.getPropertyValue('--ph-ink').trim() || '#e4ff1a', grid: css.getPropertyValue('--ph-grid').trim() || '#2e2e2a' })
  }, [size, ...deps]) // eslint-disable-line react-hooks/exhaustive-deps
  return <canvas className={`ph-scope ${className}`} ref={ref} aria-hidden />
}

const midline = (ctx, w, h, grid) => {
  ctx.strokeStyle = grid
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(0, Math.round(h / 2) + 0.5); ctx.lineTo(w, Math.round(h / 2) + 0.5); ctx.stroke()
}

const WAVE_FN = {
  sine: (p) => Math.sin(2 * Math.PI * p),
  triangle: (p) => 1 - 4 * Math.abs(p - 0.5),
  sawtooth: (p) => 2 * p - 1,
  square: (p) => (p < 0.5 ? 1 : -1),
}
const wrap = (p) => p - Math.floor(p)

/** Two cycles of what a layer makes. */
function LayerScope({ layer }) {
  const frame = useMemo(() => (layer.type === 'wavetable' ? tableFrame(TABLE_NAMES.indexOf(layer.table), layer.pos) : null), [layer.type, layer.table, layer.pos])
  return (
    <Scope
      deps={[frame, layer.type, layer.wave, layer.pw, layer.fm, layer.ratio, layer.unison, layer.detune, layer.color, layer.on, layer.fmwave]}
      draw={(ctx, w, h, dpr, { ink, grid }) => {
        midline(ctx, w, h, grid)
        const n = 600
        const fm = layer.type === 'noise' ? 0 : layer.fm
        const fmw = { sine: WAVE_FN.sine, triangle: WAVE_FN.triangle, sawtooth: WAVE_FN.sawtooth, square: WAVE_FN.square }[layer.fmwave]
        const sample = (p) => {
          const q = wrap(p + (fm / (2 * Math.PI)) * fmw(wrap(p * layer.ratio)))
          if (frame) return frame[Math.floor(q * frame.length) % frame.length]
          if (layer.type === 'analog' && layer.wave === 'pulse') return q < layer.pw ? 1 : -1
          return (WAVE_FN[layer.type === 'supersaw' ? 'sawtooth' : layer.wave] ?? WAVE_FN.sine)(q)
        }
        const alpha = layer.on ? 1 : 0.35
        if (layer.type === 'noise') {
          let seed = 7
          const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
          let smooth = 0
          const k = { white: 1, pink: 0.45, brown: 0.12 }[layer.color]
          const values = Float32Array.from({ length: n }, () => (smooth += (rand() - smooth) * k) * (layer.color === 'brown' ? 2.2 : 1))
          ctx.globalAlpha = alpha
          drawWave(ctx, values, { width: w, height: h, color: ink, pad: 3 * dpr, lineWidth: 1.2 * dpr })
          ctx.globalAlpha = 1
          return
        }
        const voices = layer.type === 'supersaw' || (layer.type === 'wavetable' && layer.unison > 1) ? Math.min(layer.unison, 5) : 1
        for (let v = 0; v < voices; v++) {
          const off = voices > 1 ? (v / (voices - 1) - 0.5) * layer.detune * 0.12 : 0
          const values = Float32Array.from({ length: n }, (_, i) => sample(wrap(((i / n) * 2) * (1 + off) + v * 0.13)))
          ctx.globalAlpha = alpha * (v === Math.floor(voices / 2) ? 1 : 0.35)
          drawWave(ctx, values, { width: w, height: h, color: ink, pad: 3 * dpr, lineWidth: 1.4 * dpr })
        }
        ctx.globalAlpha = 1
      }}
    />
  )
}

/** The filter's response, roughly: shaded, with the cutoff marked and the decades named. */
function FilterScope({ filter }) {
  return (
    <Scope
      className="filter"
      deps={[filter.on, filter.type, filter.slope, filter.cutoff, filter.reso]}
      draw={(ctx, w, h, dpr, { ink, grid }) => {
        const fx = (f) => (Math.log(f / 20) / Math.log(1000)) * w
        const order = filter.slope === '12db' ? 1 : 2
        const q = 0.5 + filter.reso * 12
        const type = filter.slope === 'ladder' ? 'lowpass' : filter.type
        const dbAt = (f) => {
          const r = f / filter.cutoff
          const den = Math.sqrt((1 - r * r) ** 2 + (r / q) ** 2)
          const mag = type === 'lowpass' ? 1 / den : type === 'highpass' ? (r * r) / den : (r / q) / den
          return 20 * Math.log10(mag ** order + 1e-6)
        }
        const zero = h * 0.42
        const yOf = (db) => clamp(zero - (db / 36) * h * 0.55, 2 * dpr, h - 2 * dpr)
        ctx.lineWidth = 1
        ctx.font = `${9 * dpr}px ${getComputedStyle(document.body).fontFamily}`
        ctx.textBaseline = 'bottom'
        for (const [f, label] of [[100, '100'], [1000, '1k'], [10000, '10k']]) {
          const gx = Math.round(fx(f)) + 0.5
          ctx.strokeStyle = grid
          ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke()
          ctx.fillStyle = grid === '#1a1a16' ? '#4a4a40' : grid
          ctx.fillText(label, gx + 3 * dpr, h - 3 * dpr)
        }
        ctx.strokeStyle = grid
        ctx.setLineDash([2 * dpr, 3 * dpr])
        ctx.beginPath(); ctx.moveTo(0, Math.round(zero) + 0.5); ctx.lineTo(w, Math.round(zero) + 0.5); ctx.stroke()
        ctx.setLineDash([])
        const values = Float32Array.from({ length: Math.ceil(w) + 1 }, (_, x) => dbAt(20 * 1000 ** (x / w)))
        ctx.globalAlpha = filter.on ? 1 : 0.35
        drawCurve(ctx, values, { width: w, map: yOf, color: ink, lineWidth: 1.6 * dpr, fill: h, glow: filter.on ? 6 * dpr : 0 })
        // the cutoff: a line down from the curve and a dot on it
        const cx = fx(filter.cutoff)
        const cy = yOf(dbAt(filter.cutoff))
        ctx.strokeStyle = ink
        ctx.globalAlpha *= 0.35
        ctx.setLineDash([2 * dpr, 2 * dpr])
        ctx.beginPath(); ctx.moveTo(Math.round(cx) + 0.5, cy); ctx.lineTo(Math.round(cx) + 0.5, h); ctx.stroke()
        ctx.setLineDash([])
        ctx.globalAlpha = filter.on ? 1 : 0.35
        ctx.fillStyle = '#050504'
        ctx.beginPath(); ctx.arc(cx, cy, 4 * dpr, 0, Math.PI * 2); ctx.fill()
        ctx.lineWidth = 1.5 * dpr
        ctx.stroke()
        ctx.globalAlpha = 1
      }}
    />
  )
}

function EnvScope({ env }) {
  return (
    <Scope
      className="env"
      deps={[env.attack, env.decay, env.sustain, env.release]}
      draw={(ctx, w, h, dpr, { ink, grid }) => {
        const hold = 0.35
        const total = env.attack + env.decay + hold + env.release
        const n = Math.ceil(w)
        const base = h - 4 * dpr
        const top = 5 * dpr
        const yOf = (v) => base - v * (base - top)
        // the shape the processor makes: a straight rise, then curves that settle
        const values = Float32Array.from({ length: n + 1 }, (_, x) => {
          const t = (x / n) * total
          if (t < env.attack) return t / env.attack
          if (t < env.attack + env.decay + hold) return env.sustain + (1 - env.sustain) * Math.exp((-5 * (t - env.attack)) / env.decay)
          const s = env.sustain + (1 - env.sustain) * Math.exp((-5 * (env.decay + hold)) / env.decay)
          return s * Math.exp((-5 * (t - env.attack - env.decay - hold)) / env.release)
        })
        // where each stage starts, named
        ctx.font = `${8 * dpr}px ${getComputedStyle(document.body).fontFamily}`
        ctx.textBaseline = 'top'
        ctx.lineWidth = 1
        let at = 0
        for (const [label, len] of [['A', env.attack], ['D', env.decay], ['S', hold], ['R', env.release]]) {
          const sx = Math.round((at / total) * w) + 0.5
          if (at > 0) {
            ctx.strokeStyle = grid
            ctx.beginPath(); ctx.moveTo(sx, top); ctx.lineTo(sx, base); ctx.stroke()
          }
          ctx.fillStyle = '#4a4a40'
          if ((len / total) * w > 10 * dpr) ctx.fillText(label, sx + 3 * dpr, 2 * dpr)
          at += len
        }
        ctx.strokeStyle = grid
        ctx.beginPath(); ctx.moveTo(0, Math.round(base) + 0.5); ctx.lineTo(w, Math.round(base) + 0.5); ctx.stroke()
        drawCurve(ctx, values, { width: w, map: yOf, color: ink, lineWidth: 1.6 * dpr, fill: base, glow: 5 * dpr })
      }}
    />
  )
}

// ── small controls ───────────────────────────────────────────────────────────

function Stepper({ label, value, min, max, onChange, format = (v) => v }) {
  return (
    <div className="ph-stepper" role="group" aria-label={label}>
      <div className="ph-stepper-row">
        <button type="button" onClick={() => onChange(clamp(value - 1, min, max))} disabled={value <= min} aria-label={`${label} down`}>−</button>
        <output>{format(value)}</output>
        <button type="button" onClick={() => onChange(clamp(value + 1, min, max))} disabled={value >= max} aria-label={`${label} up`}>+</button>
      </div>
      <span className="ph-small-label">{label}</span>
    </div>
  )
}

function Segmented({ label, value, options, onChange, format = (o) => o }) {
  return (
    <div className="ph-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o)} type="button" role="radio" aria-checked={value === o} className={value === o ? 'on' : ''} onClick={() => onChange(o)}>{format(o)}</button>
      ))}
    </div>
  )
}

/**
 * A knob with a coloured ring for each route moving it. `route` is its name as a
 * modulation destination, `auto` its automation key.
 */
function ModKnob({ ui, route, auto, def, value, onChange }) {
  const routes = route ? ui.patch.mods.filter((m) => m.target === route) : []
  const pos = (v) => (def.log ? Math.log(v / def.min) / Math.log(def.max / def.min) : (v - def.min) / (def.max - def.min))
  const at = clamp(pos(value), 0, 1)
  const arc = (a0, a1, r) => {
    const ang = (a) => ((225 - a * 270) * Math.PI) / 180
    const p = (a) => [22 + r * Math.cos(ang(a)), 22 - r * Math.sin(ang(a))]
    const [x0, y0] = p(Math.min(a0, a1))
    const [x1, y1] = p(Math.max(a0, a1))
    return `M ${x0} ${y0} A ${r} ${r} 0 ${Math.abs(a1 - a0) > 2 / 3 ? 1 : 0} 1 ${x1} ${y1}`
  }
  return (
    <div className="ph-modknob" title={routes.length ? `moved by ${routes.map((m) => SOURCE_LABELS[m.src]).join(', ')}` : undefined}>
      <Knob def={def} value={value} onChange={onChange} target={auto ? ui.target(auto) : null} />
      {routes.length > 0 && (
        <svg className="ph-rings" width="44" height="44" viewBox="0 0 44 44" aria-hidden>
          {routes.map((m, i) => {
            // an envelope sweeps one way from the knob; an lfo swings either side
            const [a0, a1] = m.src === 'env' ? [at, at + m.amt] : [at - Math.abs(m.amt) / 2, at + Math.abs(m.amt) / 2]
            return <path key={m.id} d={arc(clamp(a0, 0, 1), clamp(a1, 0, 1), 20 - i * 3)} className={`ph-ring src-${m.src}`} />
          })}
        </svg>
      )}
    </div>
  )
}

// ── what a layer sounds like ─────────────────────────────────────────────────

/** One menu for a layer's sound: every analog wave, supersaw, each wavetable, each noise. */
const SOUND_GROUPS = [
  ['analog', [['analog:sawtooth', 'saw'], ['analog:square', 'square'], ['analog:triangle', 'triangle'], ['analog:sine', 'sine'], ['analog:pulse', 'pulse']]],
  ['stacked', [['supersaw:', 'supersaw']]],
  ['wavetable', TABLE_NAMES.map((t) => [`wavetable:${t}`, `${t} table`])],
  ['noise', NOISES.map((c) => [`noise:${c}`, `${c} noise`])],
]
const soundOf = (l) => (l.type === 'analog' ? `analog:${l.wave}` : l.type === 'supersaw' ? 'supersaw:' : l.type === 'wavetable' ? `wavetable:${l.table}` : `noise:${l.color}`)
function applySound(l, key) {
  const [type, variant] = key.split(':')
  if (type !== l.type) {
    const fresh = makeLayer(type)
    Object.assign(l, { type, unison: fresh.unison, detune: fresh.detune })
  }
  if (type === 'analog') l.wave = variant
  if (type === 'wavetable') l.table = variant
  if (type === 'noise') l.color = variant
}

/** The one knob that changes a layer's character most, if its sound has one. */
const toneKnob = (l) => (l.type === 'wavetable' ? 'pos' : l.type === 'supersaw' ? 'detune' : l.type === 'analog' && l.wave === 'pulse' ? 'pw' : null)

// ── modulation destinations ──────────────────────────────────────────────────

/** Everything a modulator can move, with names a person would use. */
function destinations(patch) {
  const list = [['filter.cutoff', 'filter cutoff'], ['filter.reso', 'filter resonance'], ['filter.drive', 'filter drive'], ['pitch', 'pitch'], ['amp.level', 'volume']]
  patch.layers.forEach((l, i) => {
    const knobs = ['level', 'pan']
    const tone = toneKnob(l)
    if (tone) knobs.unshift(tone)
    if (l.type === 'wavetable') knobs.push('warp', 'detune', 'spread')
    if (l.type === 'supersaw') knobs.push('spread')
    if (l.type !== 'noise') knobs.push('fm', 'fine')
    for (const k of new Set(knobs)) list.push([`layer:${l.id}.${k}`, `${letter(i)} ${K[k].label}`])
  })
  return list
}

const AMOUNT = { key: 'amt', label: 'amount', min: -1, max: 1, def: 0.5, unit: 'bi', origin: 0 }

function Destinations({ ui, src }) {
  const { patch, edit } = ui
  const routes = patch.mods.filter((m) => m.src === src)
  const options = destinations(patch)
  const free = options.filter(([t]) => !routes.some((m) => m.target === t))
  return (
    <div className="ph-dests">
      {routes.map((m) => (
        <div key={m.id} className="ph-dest">
          <span className={`ph-dot src-${src}`} aria-hidden />
          <select
            value={m.target}
            aria-label={`${SOURCE_LABELS[src]} destination`}
            onChange={(e) => edit((p) => { const r = p.mods.find((x) => x.id === m.id); if (r && !p.mods.some((x) => x.src === src && x.target === e.target.value)) r.target = e.target.value })}
          >
            {!options.some(([t]) => t === m.target) && <option value={m.target}>{targetSpec(patch, m.target)?.label ?? 'gone'}</option>}
            {options.map(([t, label]) => <option key={t} value={t} disabled={t !== m.target && routes.some((x) => x.target === t)}>{label}</option>)}
          </select>
          <div className="ph-dest-amt">
            <Knob def={AMOUNT} value={m.amt} onChange={(v) => edit((p) => { const r = p.mods.find((x) => x.id === m.id); if (r) r.amt = v })} />
          </div>
          <button type="button" className="ph-x" aria-label="Remove destination" onClick={() => edit((p) => { p.mods = p.mods.filter((x) => x.id !== m.id) })}>×</button>
        </div>
      ))}
      {free.length > 0 && routes.length < MAX_ROUTES && (
        <button type="button" className="ph-add" onClick={() => edit((p) => { p.mods.push({ id: newPartId(), src, target: free[0][0], amt: 0.5 }) })}>+ destination</button>
      )}
    </div>
  )
}

// ── sections ─────────────────────────────────────────────────────────────────

function Section({ title, index, className = '', aside, children }) {
  return (
    <section className={`ph-card ${className}`} aria-label={title}>
      <header className="ph-card-head">
        {index != null && <span className="ph-card-num" aria-hidden>{String(index).padStart(2, '0')}</span>}
        <h3>{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  )
}

/** One oscillator slot: its sound, a look at it, and every control it has, all in view. */
function LayerSlot({ ui, layer, index }) {
  const set = (fn) => ui.edit((p) => { const l = p.layers.find((x) => x.id === layer.id); if (l) fn(l) })
  const knob = (k) => (
    <ModKnob key={k} ui={ui} route={`layer:${layer.id}.${k}`} auto={layerKnobKey(layer.id, k)} def={K[k]} value={layer[k]} onChange={(v) => set((l) => { l[k] = v })} />
  )
  const tone = toneKnob(layer)
  const full = ui.patch.layers.length >= MAX_LAYERS
  const stacked = layer.type === 'supersaw' || layer.type === 'wavetable'
  const pitched = layer.type !== 'noise'
  return (
    <div className={`ph-slot ${layer.on ? '' : 'off'}`}>
      <div className="ph-slot-head">
        <button type="button" className={`ph-power ${layer.on ? 'on' : ''}`} aria-pressed={layer.on} title={layer.on ? 'Turn this layer off' : 'Turn this layer on'} aria-label={`Layer ${letter(index)} ${layer.on ? 'on' : 'off'}`} onClick={() => set((l) => { l.on = !l.on })}>{letter(index)}</button>
        <select className="ph-sound" value={soundOf(layer)} aria-label={`Layer ${letter(index)} sound`} title={layer.type === 'wavetable' ? TABLES[layer.table] : undefined} onChange={(e) => set((l) => applySound(l, e.target.value))}>
          {SOUND_GROUPS.map(([group, items]) => (
            <optgroup key={group} label={group}>{items.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</optgroup>
          ))}
        </select>
        <button type="button" className="ph-icon" disabled={full} title="Duplicate this layer" aria-label={`Duplicate layer ${letter(index)}`} onClick={() => ui.edit((p) => { const i = p.layers.findIndex((x) => x.id === layer.id); if (i >= 0 && p.layers.length < MAX_LAYERS) p.layers.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(layer)), id: newPartId() }) })}><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><rect x="0.5" y="3.5" width="8" height="8" fill="none" stroke="currentColor" /><path d="M3.5 3.5V0.5h8v8h-3" fill="none" stroke="currentColor" /></svg></button>
        <button type="button" className="ph-icon" title="Remove this layer" aria-label={`Remove layer ${letter(index)}`} onClick={() => ui.edit((p) => { p.layers = p.layers.filter((x) => x.id !== layer.id); p.mods = p.mods.filter((m) => !m.target.startsWith(`layer:${layer.id}.`)) })}>×</button>
      </div>
      <LayerScope layer={layer} />
      <div className="ph-slot-steps">
        {pitched && <Stepper label="octave" value={layer.oct} min={-3} max={3} onChange={(v) => set((l) => { l.oct = v })} format={(v) => (v > 0 ? `+${v}` : v)} />}
        {pitched && <Stepper label="semi" value={layer.semi} min={-12} max={12} onChange={(v) => set((l) => { l.semi = v })} format={(v) => (v > 0 ? `+${v}` : v)} />}
        {stacked && <Stepper label="voices" value={layer.unison} min={1} max={16} onChange={(v) => set((l) => { l.unison = v })} />}
      </div>
      <div className="ph-slot-knobs">
        {knob('level')}
        {knob('pan')}
        {tone && knob(tone)}
        {pitched && knob('fine')}
        {layer.type === 'wavetable' && layer.unison > 1 && knob('detune')}
        {stacked && (layer.type === 'supersaw' || layer.unison > 1) && knob('spread')}
        {layer.type === 'wavetable' && knob('warp')}
        {pitched && knob('fm')}
        {pitched && layer.fm > 0 && knob('ratio')}
      </div>
      {(layer.type === 'wavetable' || (pitched && layer.fm > 0)) && (
        <div className="ph-slot-opts">
          {layer.type === 'wavetable' && (
            <label className="ph-field"><span className="ph-small-label">warp</span><select value={layer.warpmode} onChange={(e) => set((l) => { l.warpmode = e.target.value })}>{WARP_MODES.map((w) => <option key={w}>{w}</option>)}</select></label>
          )}
          {pitched && layer.fm > 0 && (
            <label className="ph-field"><span className="ph-small-label">fm wave</span><select value={layer.fmwave} onChange={(e) => set((l) => { l.fmwave = e.target.value })}>{FM_WAVES.map((w) => <option key={w}>{w}</option>)}</select></label>
          )}
        </div>
      )}
    </div>
  )
}

/** A slot with no layer: the first one offers to add one. */
function EmptySlot({ ui, index, first }) {
  if (!first) return <div className="ph-slot empty" aria-hidden><span className="ph-slot-letter">{letter(index)}</span></div>
  const add = (type, over = {}) => ui.edit((p) => { if (p.layers.length < MAX_LAYERS) p.layers.push(makeLayer(type, over)) })
  return (
    <div className="ph-slot empty first">
      <span className="ph-slot-letter">{letter(index)}</span>
      <span className="ph-small-label">{index === 0 ? 'no sound yet · add a layer' : 'add a layer'}</span>
      <div className="ph-add-list">
        <button type="button" onClick={() => add('analog', { wave: 'sawtooth' })}>analog</button>
        <button type="button" onClick={() => add('supersaw')}>supersaw</button>
        <button type="button" onClick={() => add('wavetable')}>wavetable</button>
        <button type="button" onClick={() => add('noise')}>noise</button>
      </div>
    </div>
  )
}

function Filter({ ui }) {
  const f = ui.patch.filter
  const set = (fn) => ui.edit((p) => fn(p.filter))
  const envRoute = ui.patch.mods.find((m) => m.src === 'env' && m.target === 'filter.cutoff')
  const setEnv = (v) => ui.edit((p) => {
    const r = p.mods.find((m) => m.src === 'env' && m.target === 'filter.cutoff')
    if (Math.abs(v) < 0.02) p.mods = p.mods.filter((m) => m !== r)
    else if (r) r.amt = v
    else if (p.mods.filter((m) => m.src === 'env').length < MAX_ROUTES) p.mods.push({ id: newPartId(), src: 'env', target: 'filter.cutoff', amt: v })
  })
  const fk = (k) => <ModKnob ui={ui} route={`filter.${k}`} auto={`filter_${k}`} def={K[k]} value={f[k]} onChange={(v) => set((x) => { x[k] = v; if (k === 'cutoff') x.on = true })} />
  return (
    <Section
      title="filter"
      index={2}
      className={`ph-filter ${f.on ? '' : 'off'}`}
      aside={<button type="button" className={`ph-toggle ${f.on ? 'on' : ''}`} aria-pressed={f.on} onClick={() => set((x) => { x.on = !x.on })}>{f.on ? 'on' : 'off'}</button>}
    >
      <div className="ph-filter-top">
        <Segmented label="Filter type" value={f.type} options={FILTER_TYPES} format={(t) => ({ lowpass: 'low pass', highpass: 'high pass', bandpass: 'band pass' })[t]} onChange={(v) => set((x) => { x.type = v; x.on = true; if (v !== 'lowpass' && x.slope === 'ladder') x.slope = '24db' })} />
        <Segmented label="Slope" value={f.slope} options={FILTER_SLOPES} format={(s) => ({ '12db': '12 dB', '24db': '24 dB', ladder: 'ladder' })[s]} onChange={(v) => set((x) => { x.slope = v; x.on = true; if (v === 'ladder') x.type = 'lowpass' })} />
      </div>
      <FilterScope filter={f} />
      <div className="ph-knobs">
        {fk('cutoff')}
        {fk('reso')}
        {fk('drive')}
        <div className="ph-env-amt" title="How far the mod envelope opens (or closes) the cutoff on each note">
          <Knob def={{ key: 'envamt', label: 'env amount', min: -1, max: 1, def: 0, unit: 'bi', origin: 0 }} value={envRoute?.amt ?? 0} onChange={setEnv} />
        </div>
      </div>
    </Section>
  )
}

function Envelope({ ui, which }) {
  const env = ui.patch[which]
  const isAmp = which === 'amp'
  return (
    <Section title={isAmp ? 'amp envelope' : 'mod envelope'} index={isAmp ? 3 : 4} className={isAmp ? 'ph-amp' : 'ph-src src-env'}>
      <EnvScope env={env} />
      <div className="ph-knobs tight">
        {['attack', 'decay', 'sustain', 'release'].map((k) => (
          <Knob key={k} def={K[k]} value={env[k]} onChange={(v) => ui.edit((p) => { p[which][k] = v })} target={ui.target(`${which}_${k}`)} />
        ))}
      </div>
      {!isAmp && <Destinations ui={ui} src="env" />}
    </Section>
  )
}

const LFO_BUTTONS = [['sine', 'sin'], ['tri', 'tri'], ['saw', 'saw'], ['ramp', 'ramp'], ['square', 'sq'], ['pluck', 'pluck'], ['swell', 'swell'], ['stairs', 'steps']]
const GRIDS = [[0, 'free'], [4, '1/4'], [8, '1/8'], [16, '1/16'], [32, '1/32']]
const sameShape = (a, b) => a.length === b.length && a.every((p, i) => Math.abs(p.x - b[i].x) < 1e-6 && Math.abs(p.y - b[i].y) < 1e-6 && Math.abs((p.c ?? 0) - (b[i].c ?? 0)) < 0.011)

/** An LFO: a shape you draw, how it runs, how fast, and where it goes. */
function Lfo({ ui, index }) {
  const src = `lfo${index + 1}`
  const lfo = ui.patch.lfos[index]
  const set = (fn) => ui.edit((p) => fn(p.lfos[index]))
  // the dot: where the lfo is on the window's clock (a voice's own run starts at its note)
  const rate = lfo.sync ? ui.cps / lfo.bars : lfo.hz
  const dot = useRef(null)
  dot.current = () => {
    const t = performance.now() / 1000
    if (lfo.mode === 'env') { const period = 1 / rate; const loop = period + 0.6; return Math.min(1, (t % loop) / period) }
    return (t * rate) % 1
  }
  const preset = LFO_BUTTONS.find(([name]) => sameShape(lfo.points, LFO_PRESETS[name]))?.[0]
  return (
    <Section
      title={`lfo ${index + 1}`}
      index={5 + index}
      className={`ph-src src-${src} ph-lfo`}
      aside={<Segmented label="Mode" value={lfo.mode} options={LFO_MODES} onChange={(v) => set((l) => { l.mode = v })} format={(m) => ({ free: 'free', retrig: 'trig', env: 'env' })[m]} />}
    >
      <div className="ph-lfo-shapes" role="group" aria-label="Start from a shape">
        {LFO_BUTTONS.map(([name, label]) => (
          <button key={name} type="button" className={preset === name ? 'on' : ''} onClick={() => set((l) => { l.points = LFO_PRESETS[name].map((p) => ({ ...p })) })} title={`Start from a ${name} shape`}>{label}</button>
        ))}
      </div>
      <div className="ph-lfo-draw">
        <CurveEditor
          points={lfo.points}
          grid={lfo.grid}
          height={112}
          dot={dot}
          onChange={(points) => set((l) => { l.points = points })}
        />
      </div>
      <div className="ph-lfo-controls">
        <div className="ph-rate">
          <Segmented label="Rate mode" value={lfo.sync ? 'bars' : 'hz'} options={['bars', 'hz']} onChange={(v) => set((l) => { l.sync = v === 'bars' })} />
          {lfo.sync
            ? <select className="ph-rate-select" aria-label="Every" value={String(lfo.bars)} onChange={(e) => set((l) => { l.bars = Number(e.target.value) })}>{LFO_BARS.map((b) => <option key={b} value={String(b)}>{barsLabel(b)}</option>)}</select>
            : <Knob def={K.hz} value={lfo.hz} onChange={(v) => set((l) => { l.hz = v })} target={ui.target(`lfo${index + 1}_hz`)} />}
        </div>
        <label className="ph-grid-pick" title="Where new and dragged points snap to (alt: anywhere)">
          <span className="ph-small-label">grid</span>
          <select value={lfo.grid} onChange={(e) => set((l) => { l.grid = Number(e.target.value) })}>
            {GRIDS.map(([g, label]) => <option key={g} value={g}>{label}</option>)}
          </select>
        </label>
      </div>
      <Destinations ui={ui} src={src} />
    </Section>
  )
}

/** Two octaves to play, from `base`: a key sounds for as long as it's pressed. */
function Keys({ hold, base, setBase }) {
  const [down, setDown] = useState(null)
  const release = useRef(null)
  const up = () => { release.current?.(); release.current = null; setDown(null) }
  useEffect(() => () => release.current?.(), [])
  const press = (m) => (e) => {
    if (e.button !== 0) return
    e.currentTarget.releasePointerCapture?.(e.pointerId) // so sliding onto the next key plays it
    up()
    release.current = hold(m)
    setDown(m)
  }
  // sliding across the keys plays each one in turn
  const slide = (m) => (e) => { if (e.buttons & 1 && down !== m) press(m)({ ...e, button: 0, currentTarget: e.currentTarget }) }
  useEffect(() => {
    if (down === null) return
    window.addEventListener('pointerup', up)
    window.addEventListener('blur', up)
    return () => { window.removeEventListener('pointerup', up); window.removeEventListener('blur', up) }
  }, [down]) // eslint-disable-line react-hooks/exhaustive-deps
  const keys = []
  for (let m = base; m < base + 25; m++) keys.push(m)
  const black = (m) => [1, 3, 6, 8, 10].includes(m % 12)
  const whites = keys.filter((m) => !black(m))
  return (
    <footer className="ph-keys">
      <Stepper label="octave" value={Math.floor(base / 12) - 1} min={0} max={7} onChange={(v) => setBase((v + 1) * 12)} />
      <div className="ph-piano" role="group" aria-label="Keyboard: click to hear the patch">
        {whites.map((m) => (
          <div key={m} className="ph-white-wrap">
            <button type="button" tabIndex={-1} className={`ph-white ${down === m ? 'down' : ''}`} onPointerDown={press(m)} onPointerEnter={slide(m)} aria-label={noteName(m)}>
              {m % 12 === 0 && <span>{noteName(m)}</span>}
            </button>
            {keys.includes(m + 1) && black(m + 1) && <button type="button" tabIndex={-1} className={`ph-black ${down === m + 1 ? 'down' : ''}`} onPointerDown={press(m + 1)} onPointerEnter={slide(m + 1)} aria-label={noteName(m + 1)} />}
          </div>
        ))}
      </div>
    </footer>
  )
}

// ── the panel ────────────────────────────────────────────────────────────────

export default function PhylloPanel({ data, change, target, hold, cps = 0.5 }) {
  const patch = data
  const [userPresets, setUserPresets] = useState(() => readJson(PRESET_KEY, []))
  const [base, setBase] = useState(48)
  const ui = { patch, edit: change, target, cps }

  const allPresets = [
    ...PRESETS.map((p) => ({ key: `builtin:${p.name}`, name: p.name, patch: p })),
    ...userPresets.map((p, i) => ({ key: `user:${i}`, name: p.name, patch: p })),
  ]
  const loadPreset = (key) => {
    const found = allPresets.find((p) => p.key === key)
    if (!found) return
    // fresh layer and route ids, so automation on the old patch doesn't land on the new one
    const next = normalizePatch(JSON.parse(JSON.stringify(found.patch)))
    const ids = new Map(next.layers.map((l) => [l.id, newPartId()]))
    next.layers.forEach((l) => { l.id = ids.get(l.id) })
    next.mods.forEach((m) => { m.id = newPartId(); m.target = m.target.replace(/^layer:(\w+)\./, (all, id) => `layer:${ids.get(id) ?? id}.`) })
    change((p) => { Object.keys(p).forEach((k) => delete p[k]); Object.assign(p, next) })
  }
  const stepPreset = (dir) => {
    const at = allPresets.findIndex((p) => p.name === patch.name)
    loadPreset(allPresets[(at + dir + allPresets.length) % allPresets.length].key)
  }
  const savePreset = () => {
    const next = [...userPresets.filter((p) => p.name !== patch.name), JSON.parse(JSON.stringify(patch))].slice(-40)
    setUserPresets(next)
    writeJson(PRESET_KEY, next)
  }

  return (
    <div className="ph-panel">
      <div className="ph-top">
        <div className="ph-preset">
          <button type="button" className="ph-arrow" onClick={() => stepPreset(-1)} aria-label="Previous preset">‹</button>
          <input className="ph-name" value={patch.name} maxLength={40} aria-label="Patch name" onChange={(e) => { const v = e.target.value; change((p) => { p.name = v }) }} />
          <select className="ph-preset-list" value="" aria-label="Presets" onChange={(e) => { if (e.target.value) loadPreset(e.target.value) }}>
            <option value="">▾</option>
            <optgroup label="presets">{allPresets.filter((p) => p.key.startsWith('builtin')).map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</optgroup>
            {userPresets.length > 0 && <optgroup label="saved in this browser">{allPresets.filter((p) => p.key.startsWith('user')).map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</optgroup>}
          </select>
          <button type="button" className="ph-arrow" onClick={() => stepPreset(1)} aria-label="Next preset">›</button>
        </div>
        <button type="button" className="ph-btn" onClick={savePreset} title="Keep this patch in this browser's presets">save</button>
        <span className="spacer" />
        <div className="ph-voicing">
          <Segmented label="Voicing" value={patch.mono ? 'mono' : 'poly'} options={['poly', 'mono']} onChange={(v) => change((p) => { p.mono = v === 'mono' })} />
          <Knob def={K.glide} value={patch.glide} onChange={(v) => change((p) => { p.glide = v })} target={target('glide')} />
        </div>
        <div className="ph-volume"><ModKnob ui={ui} auto="volume" def={K.volume} value={patch.volume} onChange={(v) => change((p) => { p.volume = v })} /></div>
      </div>

      <div className="ph-main">
        <Section title="oscillators" index={1} className="ph-oscs" aside={<span className="ph-count">{patch.layers.length} / {MAX_LAYERS}</span>}>
          <div className="ph-slots">
            {patch.layers.map((l, i) => <LayerSlot key={l.id} ui={ui} layer={l} index={i} />)}
            {Array.from({ length: MAX_LAYERS - patch.layers.length }, (_, i) => (
              <EmptySlot key={`empty${i}`} ui={ui} index={patch.layers.length + i} first={i === 0} />
            ))}
          </div>
        </Section>
        <Filter ui={ui} />
      </div>
      <div className="ph-mods">
        <Envelope ui={ui} which="amp" />
        <Envelope ui={ui} which="env" />
        <Lfo ui={ui} index={0} />
        <Lfo ui={ui} index={1} />
      </div>

      <Keys hold={hold} base={base} setBase={setBase} />
    </div>
  )
}
