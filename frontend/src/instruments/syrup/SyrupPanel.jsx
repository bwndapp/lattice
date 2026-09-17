import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Knob from '../../Knob.jsx'
import { drawCurve, drawWave, fitCanvas } from '../scope.js'
import {
  FM_WAVES, K, LANES, LFO_BARS, LFO_MODES, LFO_POLARITIES, LFO_PRESETS, MAX_LAYERS, MAX_MODULATORS, MAX_ROUTES, MAX_ROUTES_EACH,
  NOISES, PRESETS, TABLES, TABLE_NAMES, WARP_MODES, barsLabel, layerKnobKey, layerLetter, makeEnv, makeLayer, makeLfo,
  MAX_LANE_FX, fxKnobKey, laneFxCatalog, laneLoops, laneName, lanesSummed, makeLaneFx, modColor, modKnobKey, modName, newPartId, normalizePatch, targetSpec,
} from './model.js'
import { tableFrame } from './tables.js'
import CurveEditor from '../CurveEditor.jsx'
import './syrup.css'

/**
 * Syrup's face, inside its instrument window, laid out as Phase Plant is: generators
 * stacked down the left, each playing into one of three lanes beside them (each a stack of
 * the app's effects, out to master or into another lane), and a bar of modulators along the bottom — as many LFOs and envelopes as you add, each
 * listing where it goes. (Typing plays it: the window's keyboard, see SynthWindow.jsx.)
 *
 * Props from the window: `data` (the patch), `change(fn)` (edit a copy of it),
 * `target(key)` (a knob's automation target), `watch(fn)` (the processor's reports) and
 * `cps` (the track's tempo).
 */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const PRESET_KEY = 'syrup:presets'
const OLD_PRESET_KEY = 'phyllo:presets' // what this synth was called before

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
    draw(ctx, w, h, dpr, { ink: css.getPropertyValue('--sy-ink').trim() || '#e4ff1a', grid: css.getPropertyValue('--sy-grid').trim() || '#2e2e2a' })
  }, [size, ...deps]) // eslint-disable-line react-hooks/exhaustive-deps
  return <canvas className={`sy-scope ${className}`} ref={ref} aria-hidden />
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
    <div className="sy-stepper" role="group" aria-label={label}>
      <div className="sy-stepper-row">
        <button type="button" onClick={() => onChange(clamp(value - 1, min, max))} disabled={value <= min} aria-label={`${label} down`}>−</button>
        <output>{format(value)}</output>
        <button type="button" onClick={() => onChange(clamp(value + 1, min, max))} disabled={value >= max} aria-label={`${label} up`}>+</button>
      </div>
      <span className="sy-small-label">{label}</span>
    </div>
  )
}

function Segmented({ label, value, options, onChange, format = (o) => o }) {
  return (
    <div className="sy-seg" role="radiogroup" aria-label={label}>
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
  const routes = route ? ui.patch.routes.filter((r) => r.target === route) : []
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
    <div className="sy-modknob" title={routes.length ? `moved by ${routes.map((r) => modName(ui.patch, r.src)).join(', ')}` : undefined}>
      <Knob def={def} value={value} onChange={onChange} target={auto ? ui.target(auto) : null} />
      {routes.length > 0 && (
        <svg className="sy-rings" width="44" height="44" viewBox="0 0 44 44" aria-hidden>
          {routes.slice(0, 4).map((r, i) => {
            // a bipolar lfo swings either side of the knob; envelopes and up or down lfos push one way
            const mod = ui.patch.modulators.find((m) => m.id === r.src)
            const pol = mod?.kind === 'lfo' ? mod.polarity : 'up'
            const [a0, a1] = pol === 'bi' ? [at - Math.abs(r.amt) / 2, at + Math.abs(r.amt) / 2] : [at, at + (pol === 'down' ? -r.amt : r.amt)]
            return <path key={r.id} d={arc(clamp(a0, 0, 1), clamp(a1, 0, 1), 20 - i * 3)} className="sy-ring" style={{ stroke: modColor(ui.patch, r.src) }} />
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
  const list = [['pitch', 'pitch'], ['amp.level', 'volume'], ...Array.from({ length: LANES }, (_, i) => [`lane:${i}.gain`, `lane ${laneName(i)} level`])]
  patch.layers.forEach((l, i) => {
    const knobs = ['level', 'pan']
    const tone = toneKnob(l)
    if (tone) knobs.unshift(tone)
    if (l.type === 'wavetable') knobs.push('warp', 'detune', 'spread')
    if (l.type === 'supersaw') knobs.push('spread')
    if (l.type !== 'noise') knobs.push('fm', 'ratio', 'fine')
    for (const k of new Set(knobs)) list.push([`layer:${l.id}.${k}`, `${layerLetter(i)} ${K[k].label}`])
  })
  // every knob on every lane effect
  const catalog = laneFxCatalog()
  patch.lanes.forEach((lane, li) => {
    for (const fx of lane.effects) {
      const spec = catalog?.spec(fx.type)
      for (const def of spec?.params ?? []) {
        if (def.type === 'knob') list.push([`fx:${fx.id}.${def.key}`, `${laneName(li)} · ${spec.label} ${def.label}`])
      }
    }
  })
  return list
}

const DEST_GROUPS = [
  ['voice', (t) => t === 'pitch' || t === 'amp.level'],
  ['generators', (t) => t.startsWith('layer:')],
  ['lanes', (t) => t.startsWith('lane:')],
  ['lane effects', (t) => t.startsWith('fx:')],
]

const AMOUNT = { key: 'amt', label: 'amount', min: -1, max: 1, def: 0.5, unit: 'bi', origin: 0 }

/** Where one modulator goes: a destination and an amount each. */
function Destinations({ ui, src }) {
  const { patch, edit } = ui
  const routes = patch.routes.filter((r) => r.src === src)
  const options = destinations(patch)
  const free = options.filter(([t]) => !routes.some((r) => r.target === t))
  const color = modColor(patch, src)
  const room = routes.length < MAX_ROUTES_EACH && patch.routes.length < MAX_ROUTES
  return (
    <div className="sy-dests">
      {routes.map((r) => (
        <div key={r.id} className="sy-dest">
          <span className="sy-dot" style={{ color }} aria-hidden />
          <select
            value={r.target}
            aria-label={`${modName(patch, src)} destination`}
            onChange={(e) => edit((p) => { const x = p.routes.find((y) => y.id === r.id); if (x && !p.routes.some((y) => y.src === src && y.target === e.target.value)) x.target = e.target.value })}
          >
            {!options.some(([t]) => t === r.target) && <option value={r.target}>{targetSpec(patch, r.target)?.label ?? 'gone'}</option>}
            {DEST_GROUPS.map(([name, test]) => {
              const items = options.filter(([t]) => test(t))
              return items.length ? (
                <optgroup key={name} label={name}>
                  {items.map(([t, label]) => <option key={t} value={t} disabled={t !== r.target && routes.some((x) => x.target === t)}>{label}</option>)}
                </optgroup>
              ) : null
            })}
          </select>
          <div className="sy-dest-amt">
            <Knob def={AMOUNT} value={r.amt} onChange={(v) => edit((p) => { const x = p.routes.find((y) => y.id === r.id); if (x) x.amt = v })} />
          </div>
          <button type="button" className="sy-x" aria-label="Remove destination" onClick={() => edit((p) => { p.routes = p.routes.filter((x) => x.id !== r.id) })}>×</button>
        </div>
      ))}
      {free.length > 0 && room && (
        <button type="button" className="sy-add" onClick={() => edit((p) => { p.routes.push({ id: newPartId(), src, target: free[0][0], amt: 0.5 }) })}>+ destination</button>
      )}
      {!routes.length && !free.length && <span className="sy-small-label">add a generator to have something to move</span>}
    </div>
  )
}

// ── sections ─────────────────────────────────────────────────────────────────

function Section({ title, className = '', aside, children }) {
  return (
    <section className={`sy-card ${className}`} aria-label={title}>
      <header className="sy-card-head">
        <h3>{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  )
}

const Chevron = ({ open }) => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s' }}>
    <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
)
const CopyIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><rect x="0.5" y="3.5" width="8" height="8" fill="none" stroke="currentColor" /><path d="M3.5 3.5V0.5h8v8h-3" fill="none" stroke="currentColor" /></svg>
)

/** One generator: a strip in the stack, folding down to its header. */
function Generator({ ui, layer, index }) {
  const set = (fn) => ui.edit((p) => { const l = p.layers.find((x) => x.id === layer.id); if (l) fn(l) })
  const knob = (k) => (
    <ModKnob key={k} ui={ui} route={`layer:${layer.id}.${k}`} auto={layerKnobKey(layer.id, k)} def={K[k]} value={layer[k]} onChange={(v) => set((l) => { l[k] = v })} />
  )
  const tone = toneKnob(layer)
  const full = ui.patch.layers.length >= MAX_LAYERS
  const stacked = layer.type === 'supersaw' || layer.type === 'wavetable'
  const pitched = layer.type !== 'noise'
  const open = !layer.collapsed
  return (
    <div className={`sy-gen ${layer.on ? '' : 'off'} ${open ? 'open' : 'folded'}`}>
      <div className="sy-gen-head">
        <button type="button" className="sy-fold" aria-expanded={open} title={open ? 'Fold it away' : 'Open it'} onClick={() => set((l) => { if (l.collapsed) delete l.collapsed; else l.collapsed = true })}><Chevron open={open} /></button>
        <button type="button" className={`sy-power ${layer.on ? 'on' : ''}`} aria-pressed={layer.on} title={layer.on ? 'Turn this generator off' : 'Turn this generator on'} aria-label={`Generator ${layerLetter(index)} ${layer.on ? 'on' : 'off'}`} onClick={() => set((l) => { l.on = !l.on })}>{layerLetter(index)}</button>
        <select className="sy-sound" value={soundOf(layer)} aria-label={`Generator ${layerLetter(index)} sound`} title={layer.type === 'wavetable' ? TABLES[layer.table] : undefined} onChange={(e) => set((l) => applySound(l, e.target.value))}>
          {SOUND_GROUPS.map(([group, items]) => (
            <optgroup key={group} label={group}>{items.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</optgroup>
          ))}
        </select>
        {!open && <span className="sy-gen-sum">{Math.round(layer.level * 100)}%{layer.oct ? ` · ${layer.oct > 0 ? '+' : ''}${layer.oct} oct` : ''}</span>}
        <span className="spacer" />
        <span className="sy-lane-pick" title="Which lane this generator plays into">
          <span aria-hidden>→</span>
          <Segmented label={`Generator ${layerLetter(index)} lane`} value={layer.lane} options={[0, 1, 2]} format={laneName} onChange={(v) => set((l) => { l.lane = v })} />
        </span>
        <button type="button" className="sy-icon" title="Move up" aria-label="Move up" disabled={index === 0} onClick={() => ui.edit((p) => { const i = p.layers.findIndex((x) => x.id === layer.id); if (i > 0) p.layers.splice(i - 1, 0, ...p.layers.splice(i, 1)) })}>↑</button>
        <button type="button" className="sy-icon" title="Move down" aria-label="Move down" disabled={index === ui.patch.layers.length - 1} onClick={() => ui.edit((p) => { const i = p.layers.findIndex((x) => x.id === layer.id); if (i >= 0 && i < p.layers.length - 1) p.layers.splice(i + 1, 0, ...p.layers.splice(i, 1)) })}>↓</button>
        <button type="button" className="sy-icon" disabled={full} title="Duplicate" aria-label={`Duplicate generator ${layerLetter(index)}`} onClick={() => ui.edit((p) => { const i = p.layers.findIndex((x) => x.id === layer.id); if (i >= 0 && p.layers.length < MAX_LAYERS) p.layers.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(layer)), id: newPartId() }) })}><CopyIcon /></button>
        <button type="button" className="sy-icon" title="Remove" aria-label={`Remove generator ${layerLetter(index)}`} onClick={() => ui.edit((p) => { p.layers = p.layers.filter((x) => x.id !== layer.id); p.routes = p.routes.filter((r) => !r.target.startsWith(`layer:${layer.id}.`)) })}>×</button>
      </div>
      {open && (
        <div className="sy-gen-body">
          <LayerScope layer={layer} />
          <div className="sy-gen-steps">
            {pitched && <Stepper label="octave" value={layer.oct} min={-3} max={3} onChange={(v) => set((l) => { l.oct = v })} format={(v) => (v > 0 ? `+${v}` : v)} />}
            {pitched && <Stepper label="semi" value={layer.semi} min={-12} max={12} onChange={(v) => set((l) => { l.semi = v })} format={(v) => (v > 0 ? `+${v}` : v)} />}
            {stacked && <Stepper label="voices" value={layer.unison} min={1} max={16} onChange={(v) => set((l) => { l.unison = v })} />}
          </div>
          <div className="sy-gen-knobs">
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
            <div className="sy-gen-opts">
              {layer.type === 'wavetable' && (
                <label className="sy-field"><span className="sy-small-label">warp</span><select value={layer.warpmode} onChange={(e) => set((l) => { l.warpmode = e.target.value })}>{WARP_MODES.map((w) => <option key={w}>{w}</option>)}</select></label>
              )}
              {pitched && layer.fm > 0 && (
                <label className="sy-field"><span className="sy-small-label">fm wave</span><select value={layer.fmwave} onChange={(e) => set((l) => { l.fmwave = e.target.value })}>{FM_WAVES.map((w) => <option key={w}>{w}</option>)}</select></label>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Adding a generator: one button a kind. */
function AddGenerator({ ui }) {
  if (ui.patch.layers.length >= MAX_LAYERS) return null
  const add = (type, over = {}) => ui.edit((p) => { if (p.layers.length < MAX_LAYERS) p.layers.push(makeLayer(type, over)) })
  return (
    <div className={`sy-gen-add ${ui.patch.layers.length ? '' : 'first'}`}>
      {!ui.patch.layers.length && <span className="sy-small-label">no sound yet · add a generator</span>}
      <div className="sy-add-list">
        <button type="button" onClick={() => add('analog', { wave: 'sawtooth' })}>analog</button>
        <button type="button" onClick={() => add('supersaw')}>supersaw</button>
        <button type="button" onClick={() => add('wavetable')}>wavetable</button>
        <button type="button" onClick={() => add('noise')}>noise</button>
      </div>
    </div>
  )
}

const ADSR = ['attack', 'decay', 'sustain', 'release']

/** The amp envelope: every generator goes out through it. */
function AmpOut({ ui }) {
  const amp = ui.patch.amp
  return (
    <div className="sy-amp-out sy-amp">
      <div className="sy-gen-head">
        <span className="sy-out-mark" aria-hidden>out</span>
        <h4>amp envelope</h4>
      </div>
      <div className="sy-amp-body">
        <EnvScope env={amp} />
        <div className="sy-knobs tight">
          {ADSR.map((k) => (
            <ModKnob key={k} ui={ui} auto={`amp_${k}`} def={K[k]} value={amp[k]} onChange={(v) => ui.edit((p) => { p.amp[k] = v })} />
          ))}
        </div>
      </div>
    </div>
  )
}

const LFO_BUTTONS = [['sine', 'sin'], ['tri', 'tri'], ['saw', 'saw'], ['ramp', 'ramp'], ['square', 'sq'], ['pluck', 'pluck'], ['swell', 'swell'], ['stairs', 'steps']]
const GRIDS = [[0, 'free'], [4, '1/4'], [8, '1/8'], [16, '1/16'], [32, '1/32']]
const sameShape = (a, b) => a.length === b.length && a.every((p, i) => Math.abs(p.x - b[i].x) < 1e-6 && Math.abs(p.y - b[i].y) < 1e-6 && Math.abs((p.c ?? 0) - (b[i].c ?? 0)) < 0.011 && !p.s === !b[i].s)

/**
 * Dragging a lane effect by its header: up and down its lane, or across into another. A
 * label follows the pointer (the effect stays put, dimmed); a line shows where it lands;
 * letting go moves it. `drag` is { id, label, lane, x, y, px, py, to: { lane, index } }.
 */
function useFxDrag(ui) {
  const [drag, setDrag] = useState(null)
  const held = useRef(null)
  held.current = drag
  const where = (e) => {
    // the lane under the pointer (the held effect lets the pointer through), and the place in
    // it: before the first effect whose middle is below the pointer
    const under = document.elementsFromPoint(e.clientX, e.clientY).find((el) => !el.closest('.sy-fx.held, .sy-fx-ghost'))
    const laneEl = under?.closest?.('.sy-lane')
    if (!laneEl) return held.current?.to ?? null
    const lane = Number(laneEl.dataset.lane)
    const items = [...laneEl.querySelectorAll('.sy-fx')].filter((el) => el.dataset.id !== held.current?.id)
    let index = items.findIndex((el) => { const r = el.getBoundingClientRect(); return e.clientY < r.top + r.height / 2 })
    if (index < 0) index = items.length
    return { lane, index }
  }
  return {
    drag,
    start(e, lane, fx, label) {
      if (e.button !== 0 || e.target.closest('button, input, select')) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      setDrag({ id: fx.id, label, lane, x: e.clientX, y: e.clientY, px: e.clientX, py: e.clientY, to: null, moved: false })
    },
    move(e) {
      const d = held.current
      if (!d) return
      const moved = d.moved || Math.abs(e.clientX - d.x) > 3 || Math.abs(e.clientY - d.y) > 3
      setDrag({ ...d, px: e.clientX, py: e.clientY, moved, to: moved ? where(e) : null })
    },
    end() {
      const d = held.current
      setDrag(null)
      if (!d?.to || !d.moved) return
      ui.edit((p) => {
        const from = p.lanes[d.lane].effects
        const i = from.findIndex((x) => x.id === d.id)
        if (i < 0) return
        const target = p.lanes[d.to.lane].effects
        if (target !== from && target.length >= MAX_LANE_FX) return
        const [unit] = from.splice(i, 1)
        target.splice(Math.min(d.to.index, target.length), 0, unit)
      })
    },
  }
}

/** One effect in a lane: its name, on or bypassed, its place in the stack, its knobs. */
function LaneEffect({ ui, laneIndex, fx, index, count, drag }) {
  const catalog = laneFxCatalog()
  const spec = catalog?.spec(fx.type)
  if (!spec) return null
  const edit = (fn) => ui.edit((p) => { const list = p.lanes[laneIndex].effects; const i = list.findIndex((e) => e.id === fx.id); if (i >= 0) fn(list, i) })
  const open = !fx.collapsed
  const d = drag.drag
  const held = d?.moved && d.id === fx.id
  const landing = d?.moved && !held && d.to?.lane === laneIndex && d.to.index === index
  return (
    <li className={`sy-fx ${fx.on ? '' : 'bypassed'} ${held ? 'held' : ''} ${landing ? 'land-before' : ''}`} data-id={fx.id}>
      <div
        className="sy-fx-head"
        title="Drag to move it: up, down, or into another lane"
        onPointerDown={(e) => drag.start(e, laneIndex, fx, spec.label)}
        onPointerMove={drag.move}
        onPointerUp={drag.end}
        onPointerCancel={drag.end}
      >
        <button type="button" className="sy-fold" aria-expanded={open} title={open ? 'Fold it away' : 'Open it'} onClick={() => edit((l, i) => { if (l[i].collapsed) delete l[i].collapsed; else l[i].collapsed = true })}><Chevron open={open} /></button>
        <button type="button" className={`sy-led ${fx.on ? 'on' : ''}`} aria-pressed={fx.on} title={fx.on ? 'Bypass it' : 'Turn it back on'} aria-label={`${spec.label} ${fx.on ? 'on' : 'bypassed'}`} onClick={() => edit((l, i) => { l[i].on = !l[i].on })} />
        <span className="sy-fx-name" title={spec.blurb}>{spec.label}</span>
        <span className="spacer" />
        <button type="button" className="sy-icon" disabled={index === 0} title="Earlier" aria-label={`Move ${spec.label} up`} onClick={() => edit((l, i) => { if (i > 0) l.splice(i - 1, 0, ...l.splice(i, 1)) })}>↑</button>
        <button type="button" className="sy-icon" disabled={index === count - 1} title="Later" aria-label={`Move ${spec.label} down`} onClick={() => edit((l, i) => { if (i < l.length - 1) l.splice(i + 1, 0, ...l.splice(i, 1)) })}>↓</button>
        <button type="button" className="sy-icon" title="Remove" aria-label={`Remove ${spec.label}`} onClick={() => edit((l, i) => { l.splice(i, 1) })}>×</button>
      </div>
      {open && (
        <div className="sy-fx-params">
          {spec.params.map((def) => (def.type === 'select'
            ? (
              <label key={def.key} className="sy-field">
                <span className="sy-small-label">{def.label}</span>
                <select value={fx.data[def.key] ?? def.def} onChange={(e) => { const v = e.target.value; edit((l, i) => { l[i].data[def.key] = v }) }}>
                  {def.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </label>
            )
            : def.type === 'knob'
              ? <ModKnob key={def.key} ui={ui} route={`fx:${fx.id}.${def.key}`} auto={fxKnobKey(fx.id, def.key)} def={def} value={fx.data[def.key] ?? def.def} onChange={(v) => edit((l, i) => { l[i].data[def.key] = v })} />
              : null))}
        </div>
      )}
    </li>
  )
}

/** One lane: what plays into it, its effects top to bottom, its level, and where it goes. */
function Lane({ ui, index, drag }) {
  const { patch, edit } = ui
  const lane = patch.lanes[index]
  const set = (fn) => edit((p) => fn(p.lanes[index]))
  const from = patch.layers.map((l, i) => [l, i]).filter(([l]) => l.lane === index)
  const summed = lanesSummed(patch.lanes)[index]
  const catalog = laneFxCatalog()
  const feeds = patch.lanes.map((l, i) => i).filter((i) => patch.lanes[i].out === index)
  const d = drag.drag?.moved ? drag.drag : null
  const count = lane.effects.filter((e) => e.id !== d?.id).length
  const landingEnd = d && d.to?.lane === index && d.to.index >= count
  return (
    <section className={`sy-lane ${lane.mute ? 'muted' : ''} ${d?.to?.lane === index ? 'drop' : ''}`} data-lane={index} aria-label={`Lane ${laneName(index)}`}>
      <header className="sy-lane-head">
        <span className="sy-lane-num">{laneName(index)}</span>
        <div className="sy-lane-in" title="What plays into this lane">
          {from.map(([l, i]) => <span key={l.id} className={`sy-lane-chip ${l.on ? '' : 'off'}`}>{layerLetter(i)}</span>)}
          {feeds.map((i) => <span key={`n${i}`} className="sy-lane-chip lane">{laneName(i)}</span>)}
          {!from.length && !feeds.length && <span className="sy-small-label">empty</span>}
        </div>
        <span className="spacer" />
        {summed && <span className="sy-lane-sum" title="Mixed across every voice, then through its effects">Σ</span>}
        <button type="button" className={`sy-toggle ${lane.mute ? 'mute' : ''}`} aria-pressed={lane.mute} title={lane.mute ? 'Unmute this lane' : 'Mute this lane'} onClick={() => set((l) => { l.mute = !l.mute })}>m</button>
      </header>
      <div className="sy-lane-body">
        <ol className={`sy-fx-list ${landingEnd ? 'land-end' : ''}`}>
          {lane.effects.map((fx, i) => {
            // where it sits counting without the one being dragged, so the landing line matches
            const at = lane.effects.slice(0, i).filter((e) => e.id !== d?.id).length
            return <LaneEffect key={fx.id} ui={ui} laneIndex={index} fx={fx} index={at} count={lane.effects.length} drag={drag} />
          })}
        </ol>
        {lane.effects.length < MAX_LANE_FX && catalog && (
          <select
            className={`sy-fx-add ${lane.effects.length ? '' : 'first'}`}
            value=""
            aria-label={`Add an effect to lane ${laneName(index)}`}
            onChange={(e) => { const type = e.target.value; if (type) edit((p) => { if (p.lanes[index].effects.length < MAX_LANE_FX) p.lanes[index].effects.push(makeLaneFx(type)) }) }}
          >
            <option value="">+ effect</option>
            {catalog.types.map((t) => <option key={t} value={t}>{catalog.spec(t).label}</option>)}
          </select>
        )}
        {!lane.effects.length && <span className="sy-fx-hint">{from.length || feeds.length ? 'plays straight through' : 'nothing plays in yet'}</span>}
      </div>
      <footer className="sy-lane-foot">
        <ModKnob ui={ui} route={`lane:${index}.gain`} auto={`lane${index + 1}_gain`} def={K.gain} value={lane.gain} onChange={(v) => set((l) => { l.gain = v })} />
        <label className="sy-lane-out">
          <span className="sy-small-label">out</span>
          <select value={String(lane.out)} onChange={(e) => { const v = e.target.value === 'master' ? 'master' : Number(e.target.value); set((l) => { l.out = v }) }}>
            <option value="master">master</option>
            {Array.from({ length: LANES }, (_, i) => i).filter((i) => i !== index).map((i) => (
              <option key={i} value={String(i)} disabled={laneLoops(patch.lanes, index, i)}>lane {laneName(i)}{laneLoops(patch.lanes, index, i) ? ' (loops)' : ''}</option>
            ))}
          </select>
        </label>
      </footer>
    </section>
  )
}

/** An LFO's insides: a shape you draw, how it runs, how fast. */
function LfoBody({ ui, mod, slot }) {
  const set = (fn) => ui.edit((p) => { const m = p.modulators.find((x) => x.id === mod.id); if (m) fn(m) })
  // the dots: where the synth says this lfo is, carried on at its rate between reports.
  // Free: one shared place. Trig and env: one per sounding voice, none when nothing plays.
  const rate = mod.sync ? ui.cps / mod.bars : mod.hz
  const dot = useRef(null)
  dot.current = () => {
    const now = performance.now()
    const r = ui.live.current
    const age = (now - r.t) / 1000
    const fresh = age < 0.4 && r.lfo?.length > slot
    if (mod.mode === 'free') return fresh ? wrap(r.lfo[slot] + rate * age) : wrap((now / 1000) * rate)
    if (!fresh) return null
    return r.voices.map((v) => (mod.mode === 'env' ? Math.min(1, v[slot] + rate * age) : wrap(v[slot] + rate * age)))
  }
  const preset = LFO_BUTTONS.find(([name]) => sameShape(mod.points, LFO_PRESETS[name]))?.[0]
  return (
    <>
      <div className="sy-lfo-shapes" role="group" aria-label="Start from a shape">
        {LFO_BUTTONS.map(([name, label]) => (
          <button key={name} type="button" className={preset === name ? 'on' : ''} onClick={() => set((m) => { m.points = LFO_PRESETS[name].map((p) => ({ ...p })) })} title={`Start from a ${name} shape`}>{label}</button>
        ))}
      </div>
      <div className="sy-lfo-draw">
        <CurveEditor
          points={mod.points}
          grid={mod.grid}
          zero={({ up: 'bottom', bi: 'middle', down: 'top' })[mod.polarity]}
          height={104}
          dot={dot}
          onChange={(points) => set((m) => { m.points = points })}
        />
      </div>
      <div className="sy-lfo-controls">
        <div className="sy-rate">
          <Segmented label="Rate mode" value={mod.sync ? 'bars' : 'hz'} options={['bars', 'hz']} onChange={(v) => set((m) => { m.sync = v === 'bars' })} />
          {mod.sync
            ? <select className="sy-rate-select" aria-label="Every" value={String(mod.bars)} onChange={(e) => set((m) => { m.bars = Number(e.target.value) })}>{LFO_BARS.map((b) => <option key={b} value={String(b)}>{barsLabel(b)}</option>)}</select>
            : <Knob def={K.hz} value={mod.hz} onChange={(v) => set((m) => { m.hz = v })} target={ui.target(modKnobKey(mod.id, 'hz'))} />}
        </div>
        <Segmented label="Polarity" value={mod.polarity} options={LFO_POLARITIES} format={(v) => ({ up: '+', bi: '±', down: '−' })[v]} onChange={(v) => set((m) => { m.polarity = v })} />
        <select className="sy-grid-select" value={mod.grid} aria-label="Grid" title="Where points snap to (alt: anywhere)" onChange={(e) => set((m) => { m.grid = Number(e.target.value) })}>
          {GRIDS.map(([g, label]) => <option key={g} value={g}>{label === 'free' ? 'no grid' : `grid ${label}`}</option>)}
        </select>
      </div>
    </>
  )
}

/** An envelope modulator's insides. */
function EnvBody({ ui, mod }) {
  return (
    <>
      <EnvScope env={mod} />
      <div className="sy-knobs tight">
        {ADSR.map((k) => (
          <Knob key={k} def={K[k]} value={mod[k]} onChange={(v) => ui.edit((p) => { const m = p.modulators.find((x) => x.id === mod.id); if (m) m[k] = v })} target={ui.target(modKnobKey(mod.id, k))} />
        ))}
      </div>
    </>
  )
}

/** One modulator in the bar: its own colour, its insides, where it goes. */
function Modulator({ ui, mod, slot }) {
  const color = modColor(ui.patch, mod.id)
  const set = (fn) => ui.edit((p) => { const m = p.modulators.find((x) => x.id === mod.id); if (m) fn(m) })
  return (
    <section className={`sy-mod ${mod.kind}`} style={{ '--sy-ink': color }} aria-label={modName(ui.patch, mod.id)}>
      <header className="sy-mod-head">
        <span className="sy-mod-kind">{mod.kind === 'lfo' ? 'lfo' : 'env'}</span>
        <h3>{modName(ui.patch, mod.id)}</h3>
        <span className="spacer" />
        {mod.kind === 'lfo' && (
          <Segmented label="Mode" value={mod.mode} options={LFO_MODES} onChange={(v) => set((m) => { m.mode = v })} format={(m) => ({ free: 'free', retrig: 'trig', env: 'env' })[m]} />
        )}
        <button type="button" className="sy-icon" title="Duplicate" aria-label="Duplicate" disabled={ui.patch.modulators.length >= MAX_MODULATORS} onClick={() => ui.edit((p) => { const i = p.modulators.findIndex((x) => x.id === mod.id); if (i >= 0 && p.modulators.length < MAX_MODULATORS) { const copy = { ...JSON.parse(JSON.stringify(mod)), id: newPartId() }; delete copy.name; p.modulators.splice(i + 1, 0, copy) } })}><CopyIcon /></button>
        <button type="button" className="sy-icon" title="Remove (and where it goes)" aria-label="Remove" onClick={() => ui.edit((p) => { p.modulators = p.modulators.filter((x) => x.id !== mod.id); p.routes = p.routes.filter((r) => r.src !== mod.id) })}>×</button>
      </header>
      <div className="sy-mod-body">
        {mod.kind === 'lfo' ? <LfoBody ui={ui} mod={mod} slot={slot} /> : <EnvBody ui={ui} mod={mod} />}
      </div>
      <Destinations ui={ui} src={mod.id} />
    </section>
  )
}

/** Adding a modulator. */
function AddModulator({ ui, compact = false }) {
  const full = ui.patch.modulators.length >= MAX_MODULATORS
  const add = (make) => ui.edit((p) => { if (p.modulators.length < MAX_MODULATORS) p.modulators.push(make()) })
  return (
    <div className={compact ? 'sy-mod-add-inline' : 'sy-mod-add'}>
      {!compact && <span className="sy-small-label">{full ? `${MAX_MODULATORS} is the most` : ui.patch.modulators.length ? 'another' : 'nothing moving yet'}</span>}
      <button type="button" className="sy-btn" disabled={full} onClick={() => add(() => makeLfo())}>+ lfo</button>
      <button type="button" className="sy-btn" disabled={full} onClick={() => add(() => makeEnv())}>+ envelope</button>
    </div>
  )
}

// ── the panel ────────────────────────────────────────────────────────────────

export default function SyrupPanel({ data, change, target, watch, cps = 0.5 }) {
  const patch = data
  const [userPresets, setUserPresets] = useState(() => readJson(PRESET_KEY, null) ?? readJson(OLD_PRESET_KEY, []))
  // what the processor last said about its LFOs, and when (see dsp.js report)
  const live = useRef({ t: -Infinity, lfo: [], voices: [] })
  useEffect(() => watch?.((report) => { live.current = { ...report, t: performance.now() } }), []) // eslint-disable-line react-hooks/exhaustive-deps
  const ui = { patch, edit: change, target, cps, live }
  const fxDrag = useFxDrag(ui)

  const allPresets = [
    ...PRESETS.map((p) => ({ key: `builtin:${p.name}`, name: p.name, patch: p })),
    ...userPresets.map((p, i) => ({ key: `user:${i}`, name: p.name, patch: p })),
  ]
  const loadPreset = (key) => {
    const found = allPresets.find((p) => p.key === key)
    if (!found) return
    // fresh ids, so automation on the old patch doesn't land on the new one
    const next = normalizePatch(JSON.parse(JSON.stringify(found.patch)))
    const ids = new Map([...next.layers, ...next.modulators].map((x) => [x.id, newPartId()]))
    next.layers.forEach((l) => { l.id = ids.get(l.id) })
    next.modulators.forEach((m) => { m.id = ids.get(m.id) })
    next.routes.forEach((r) => {
      r.id = newPartId()
      r.src = ids.get(r.src) ?? r.src
      r.target = r.target.replace(/^layer:(\w+)\./, (all, id) => `layer:${ids.get(id) ?? id}.`)
    })
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
    <div className="sy-panel">
      <div className="sy-top">
        <div className="sy-preset">
          <button type="button" className="sy-arrow" onClick={() => stepPreset(-1)} aria-label="Previous preset">‹</button>
          <input className="sy-name" value={patch.name} maxLength={40} aria-label="Patch name" onChange={(e) => { const v = e.target.value; change((p) => { p.name = v }) }} />
          <select className="sy-preset-list" value="" aria-label="Presets" onChange={(e) => { if (e.target.value) loadPreset(e.target.value) }}>
            <option value="">▾</option>
            <optgroup label="presets">{allPresets.filter((p) => p.key.startsWith('builtin')).map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</optgroup>
            {userPresets.length > 0 && <optgroup label="saved in this browser">{allPresets.filter((p) => p.key.startsWith('user')).map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</optgroup>}
          </select>
          <button type="button" className="sy-arrow" onClick={() => stepPreset(1)} aria-label="Next preset">›</button>
        </div>
        <button type="button" className="sy-btn" onClick={savePreset} title="Keep this patch in this browser's presets">save</button>
        <span className="spacer" />
        <div className="sy-voicing">
          <Segmented label="Voicing" value={patch.mono ? 'mono' : 'poly'} options={['poly', 'mono']} onChange={(v) => change((p) => { p.mono = v === 'mono' })} />
          <Knob def={K.glide} value={patch.glide} onChange={(v) => change((p) => { p.glide = v })} target={target('glide')} />
        </div>
        <div className="sy-volume"><ModKnob ui={ui} route="amp.level" auto="volume" def={K.volume} value={patch.volume} onChange={(v) => change((p) => { p.volume = v })} /></div>
      </div>

      <div className="sy-main">
        <Section title="generators" className="sy-gens" aside={<span className="sy-count">{patch.layers.length} / {MAX_LAYERS}</span>}>
          <div className="sy-gen-list">
            {patch.layers.map((l, i) => <Generator key={l.id} ui={ui} layer={l} index={i} />)}
            <AddGenerator ui={ui} />
          </div>
          {/* where every generator goes out: always in view under the stack */}
          <AmpOut ui={ui} />
        </Section>
        <Section title="lanes" className="sy-fxcol" aside={<span className="sy-count">generators play in, lanes play out</span>}>
          <div className="sy-lanes">
            {Array.from({ length: LANES }, (_, i) => <Lane key={i} ui={ui} index={i} drag={fxDrag} />)}
          </div>
        </Section>
      </div>

      {fxDrag.drag?.moved && createPortal(
        <div className="sy-fx-ghost" style={{ left: fxDrag.drag.px, top: fxDrag.drag.py }} aria-hidden>
          {fxDrag.drag.label}
          {fxDrag.drag.to && <span>→ lane {laneName(fxDrag.drag.to.lane)}</span>}
        </div>,
        document.body,
      )}
      <section className="sy-modbar" aria-label="Modulators">
        <header className="sy-card-head">
          <h3>modulators</h3>
          <span className="sy-count">{patch.modulators.length} / {MAX_MODULATORS}</span>
          <AddModulator ui={ui} compact />
        </header>
        <div className="sy-mod-scroll">
          {patch.modulators.map((m, j) => <Modulator key={m.id} ui={ui} mod={m} slot={j} />)}
          <AddModulator ui={ui} />
        </div>
      </section>
    </div>
  )
}
