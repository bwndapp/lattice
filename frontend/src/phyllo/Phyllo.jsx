import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAudioContext, superdough } from '@strudel/webaudio'
import Knob from '../Knob.jsx'
import { ensureAudio } from '../audio'
import {
  FILTER_SLOPES, FILTER_TYPES, FM_WAVES, K, LAYER_TYPES, LFO_BARS, LFO_SHAPES, MAX_LAYERS, NOISES, PRESETS,
  SOURCES, SOURCE_LABELS, TABLES, WARP_MODES, WAVES, barsLabel, compileVoice, makeLayer, newPartId,
  normalizePatch, previewValues, tableFrame, targetSpec, voiceCount,
} from './engine'
import './phyllo.css'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const SIZE_KEY = 'phyllo:size'
const PRESET_KEY = 'phyllo:presets'
const NOTE_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b']
const noteName = (m) => `${NOTE_NAMES[m % 12]}${Math.floor(m / 12) - 1}`
const COMPUTER_KEYS = 'awsedftgyhujkolp;'

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable */ }
}

/** Play one note of the patch straight through the audio engine. */
function playNote(patch, midi, cps) {
  ensureAudio()
  try {
    const ac = getAudioContext()
    const t = ac.currentTime + 0.03
    const dur = clamp(patch.amp.attack + patch.amp.decay + 0.25, 0.15, 2.5)
    for (const value of previewValues(patch, midi, { cps })) Promise.resolve(superdough(value, t, dur)).catch(() => {})
  } catch { /* audio not ready yet */ }
}

// ── drawing ──────────────────────────────────────────────────────────────────

function useCanvas(draw, deps) {
  const ref = useRef(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const paint = () => {
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (!w || !h) return
      if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr)
      if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr)
      const ctx = canvas.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const css = getComputedStyle(canvas)
      draw(ctx, w, h, { ink: css.getPropertyValue('--ph-ink').trim() || '#e4ff1a', grid: css.getPropertyValue('--ph-grid').trim() || '#2e2e2a' })
    }
    paint()
    const ro = new ResizeObserver(paint)
    ro.observe(canvas)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return ref
}

const midline = (ctx, w, h, grid) => {
  ctx.strokeStyle = grid
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(0, h / 2 + 0.5); ctx.lineTo(w, h / 2 + 0.5); ctx.stroke()
}

const WAVE_FN = {
  sine: (p) => Math.sin(2 * Math.PI * p),
  triangle: (p) => 1 - 4 * Math.abs(((p + 0.25) % 1) - 0.5),
  sawtooth: (p) => 2 * ((p + 0.5) % 1) - 1,
  square: (p) => (p % 1 < 0.5 ? 1 : -1),
}

/** The waveform a layer makes, two cycles of it. */
function LayerScope({ layer }) {
  const ref = useCanvas((ctx, w, h, { ink, grid }) => {
    midline(ctx, w, h, grid)
    const frame = layer.type === 'wavetable' ? tableFrame(layer.table, layer.pos) : null
    const fm = layer.type === 'noise' ? 0 : layer.fm
    const sample = (p) => {
      const q = p + (fm * 0.06) * Math.sin(2 * Math.PI * p * layer.ratio)
      if (frame) return frame[Math.floor((((q % 1) + 1) % 1) * frame.length)]
      if (layer.type === 'analog' && layer.wave === 'pulse') return ((q % 1) + 1) % 1 < layer.pw ? 1 : -1
      return (WAVE_FN[layer.type === 'supersaw' ? 'sawtooth' : layer.wave] ?? WAVE_FN.sine)(((q % 1) + 1) % 1)
    }
    const trace = (fn, alpha) => {
      ctx.globalAlpha = alpha
      ctx.strokeStyle = ink
      ctx.lineWidth = 1.5
      ctx.beginPath()
      for (let x = 0; x <= w; x++) {
        const y = h / 2 - fn((x / w) * 2) * (h / 2 - 4) * (layer.on ? 1 : 0.4)
        x ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
      }
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    if (layer.type === 'noise') {
      let seed = 7
      const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
      let smooth = 0
      const k = { white: 1, pink: 0.45, brown: 0.12 }[layer.color]
      trace(() => (smooth += (rand() - smooth) * k) * (layer.color === 'brown' ? 2.2 : 1), 1)
    } else if (layer.type === 'supersaw' || layer.unison > 1) {
      const n = Math.min(layer.unison, 5)
      for (let v = 0; v < n; v++) {
        const off = (v - (n - 1) / 2) * layer.detune * 0.06
        trace((p) => sample(p * (1 + off) + v * 0.13), v === Math.floor(n / 2) ? 1 : 0.35)
      }
    } else trace(sample, 1)
  }, [layer.type, layer.wave, layer.pw, layer.table, layer.pos, layer.fm, layer.ratio, layer.unison, layer.detune, layer.color, layer.on])
  return <canvas className="ph-scope" ref={ref} aria-hidden />
}

/** An approximate response curve for the filter. */
function FilterScope({ filter }) {
  const ref = useCanvas((ctx, w, h, { ink, grid }) => {
    const fx = (f) => (Math.log(f / 20) / Math.log(1000)) * w
    ctx.strokeStyle = grid
    for (const f of [100, 1000, 10000]) { ctx.beginPath(); ctx.moveTo(fx(f) + 0.5, 0); ctx.lineTo(fx(f) + 0.5, h); ctx.stroke() }
    const order = filter.slope === '12db' ? 1 : 2
    const q = 0.5 + filter.reso * 0.6
    ctx.strokeStyle = ink
    ctx.globalAlpha = filter.on ? 1 : 0.35
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let x = 0; x <= w; x++) {
      const f = 20 * 1000 ** (x / w)
      const r = f / filter.cutoff
      let mag
      if (filter.type === 'lowpass') mag = 1 / Math.sqrt((1 - r * r) ** 2 + (r / q) ** 2)
      else if (filter.type === 'highpass') mag = (r * r) / Math.sqrt((1 - r * r) ** 2 + (r / q) ** 2)
      else mag = (r / q) / Math.sqrt((1 - r * r) ** 2 + (r / q) ** 2)
      const db = 20 * Math.log10(mag ** order + 1e-6)
      const y = h * 0.35 - (db / 36) * h * 0.6
      x ? ctx.lineTo(x, clamp(y, 1, h - 1)) : ctx.moveTo(x, clamp(y, 1, h - 1))
    }
    ctx.stroke()
    ctx.globalAlpha = 1
  }, [filter.on, filter.type, filter.slope, filter.cutoff, filter.reso])
  return <canvas className="ph-scope filter" ref={ref} aria-hidden />
}

function EnvScope({ env }) {
  const ref = useCanvas((ctx, w, h, { ink, grid }) => {
    const hold = 0.35
    const total = env.attack + env.decay + hold + env.release
    const X = (t) => 2 + (t / total) * (w - 4)
    const Y = (v) => h - 3 - v * (h - 6)
    ctx.strokeStyle = grid
    ctx.beginPath(); ctx.moveTo(0, Y(0) + 0.5); ctx.lineTo(w, Y(0) + 0.5); ctx.stroke()
    ctx.strokeStyle = ink
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(X(0), Y(0))
    ctx.lineTo(X(env.attack), Y(1))
    ctx.lineTo(X(env.attack + env.decay), Y(env.sustain))
    ctx.lineTo(X(env.attack + env.decay + hold), Y(env.sustain))
    ctx.lineTo(X(total), Y(0))
    ctx.stroke()
  }, [env.attack, env.decay, env.sustain, env.release])
  return <canvas className="ph-scope env" ref={ref} aria-hidden />
}

const LFO_FN = {
  sine: (p) => Math.sin(2 * Math.PI * p),
  tri: (p) => 1 - 4 * Math.abs((p % 1) - 0.5),
  saw: (p) => 1 - 2 * (p % 1),
  ramp: (p) => 2 * (p % 1) - 1,
  square: (p) => (p % 1 < 0.5 ? 1 : -1),
}
function LfoScope({ lfo }) {
  const ref = useCanvas((ctx, w, h, { ink, grid }) => {
    midline(ctx, w, h, grid)
    ctx.strokeStyle = ink
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let x = 0; x <= w; x++) {
      const y = h / 2 - LFO_FN[lfo.shape]((x / w) * 2) * (h / 2 - 3)
      x ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
    }
    ctx.stroke()
  }, [lfo.shape])
  return <canvas className="ph-scope lfo" ref={ref} aria-hidden />
}

// ── controls ─────────────────────────────────────────────────────────────────

function Stepper({ label, value, min, max, onChange, format = (v) => v }) {
  return (
    <div className="ph-stepper" role="group" aria-label={label}>
      <span className="ph-stepper-label">{label}</span>
      <div className="ph-stepper-row">
        <button type="button" onClick={() => onChange(clamp(value - 1, min, max))} disabled={value <= min} aria-label={`${label} down`}>−</button>
        <output>{format(value)}</output>
        <button type="button" onClick={() => onChange(clamp(value + 1, min, max))} disabled={value >= max} aria-label={`${label} up`}>+</button>
      </div>
    </div>
  )
}

function Select({ label, value, options, onChange, format = (o) => o, wide }) {
  return (
    <label className={`ph-select ${wide ? 'wide' : ''}`}>
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o} value={o}>{format(o)}</option>)}
      </select>
    </label>
  )
}

function Segmented({ label, value, options, onChange }) {
  return (
    <div className="ph-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o} type="button" role="radio" aria-checked={value === o} className={value === o ? 'on' : ''} onClick={() => onChange(o)}>{o}</button>
      ))}
    </div>
  )
}

/**
 * A knob that can be modulated: drop a modulator's grip on it to route, and a coloured
 * ring per route shows how far the modulation swings.
 */
function ModKnob({ ui, target, def, value, onChange }) {
  const routes = ui.patch.mods.filter((m) => m.target === target)
  const pos = (v) => (def.log ? Math.log(v / def.min) / Math.log(def.max / def.min) : (v - def.min) / (def.max - def.min))
  const at = clamp(pos(value), 0, 1)
  const arc = (a0, a1, r) => {
    const ang = (a) => ((225 - a * 270) * Math.PI) / 180
    const p = (a) => [22 + r * Math.cos(ang(a)), 22 - r * Math.sin(ang(a))]
    const [x0, y0] = p(Math.min(a0, a1))
    const [x1, y1] = p(Math.max(a0, a1))
    return `M ${x0} ${y0} A ${r} ${r} 0 ${Math.abs(a1 - a0) > 2 / 3 ? 1 : 0} 1 ${x1} ${y1}`
  }
  const armed = ui.dragging && targetAccepts(ui.patch, ui.dragging, target)
  return (
    <div
      className={`ph-modknob ${routes.length ? 'routed' : ''} ${armed ? 'armed' : ''} ${ui.dragging && !armed ? 'dim' : ''}`}
      data-mod-target={target}
    >
      <Knob def={def} value={value} onChange={onChange} />
      {routes.length > 0 && (
        <svg className="ph-rings" width="44" height="44" viewBox="0 0 44 44" aria-hidden>
          {routes.map((m, i) => {
            const swing = Math.abs(m.amt) / 2
            const off = ui.status[m.id] === 'off'
            return <path key={m.id} d={arc(clamp(at - swing, 0, 1), clamp(at + swing, 0, 1), 19 - i * 3)} className={`ph-ring src-${m.src} ${off ? 'off' : ''}`} />
          })}
        </svg>
      )}
    </div>
  )
}

/** A drop target with no knob of its own ("pitch", "amp"). */
function ModPad({ ui, target, label, hint }) {
  const routes = ui.patch.mods.filter((m) => m.target === target)
  const armed = ui.dragging && targetAccepts(ui.patch, ui.dragging, target)
  return (
    <div className={`ph-pad ${armed ? 'armed' : ''} ${ui.dragging && !armed ? 'dim' : ''}`} data-mod-target={target} title={hint}>
      <span>{label}</span>
      <span className="ph-pad-dots">{routes.map((m) => <i key={m.id} className={`src-${m.src}`} />)}</span>
    </div>
  )
}

/** Which targets make sense for a source (the env can't swing a pan knob). */
function targetAccepts(patch, src, target) {
  const t = targetSpec(patch, target)
  if (!t) return false
  if (src !== 'env') return true
  if (target === 'filter.cutoff' || target === 'pitch') return true
  if (!t.layerId) return false
  const layer = patch.layers.find((l) => l.id === t.layerId)
  return t.knob === 'fm' ? layer?.type !== 'noise' : layer?.type === 'wavetable' && (t.knob === 'pos' || t.knob === 'warp')
}

/** The grip you drag out of a modulator onto a knob. */
function Grip({ src, ui }) {
  return (
    <button
      type="button"
      className={`ph-grip src-${src} ${ui.dragging === src ? 'active' : ''}`}
      title={`Drag onto a knob to modulate it with ${SOURCE_LABELS[src]}`}
      aria-label={`Modulate with ${SOURCE_LABELS[src]}: drag onto a knob`}
      onPointerDown={(e) => ui.startDrag(src, e)}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        {[3, 7, 11].flatMap((x) => [4, 10].map((y) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.4" />))}
      </svg>
    </button>
  )
}

// ── sections ─────────────────────────────────────────────────────────────────

function LayerCard({ ui, layer, index }) {
  const set = (fn) => ui.edit((p) => { const l = p.layers.find((x) => x.id === layer.id); if (l) fn(l) })
  const knob = (k) => (
    <ModKnob ui={ui} target={`layer:${layer.id}.${k}`} def={K[k]} value={layer[k]} onChange={(v) => set((l) => { l[k] = v })} />
  )
  const plain = (k) => <Knob def={K[k]} value={layer[k]} onChange={(v) => set((l) => { l[k] = v })} />
  const count = ui.patch.layers.length
  return (
    <article className={`ph-layer ${layer.on ? '' : 'off'}`} aria-label={`Layer ${index + 1}`}>
      <header className="ph-layer-head">
        <button type="button" className={`ph-led ${layer.on ? 'on' : ''}`} aria-pressed={layer.on} title={layer.on ? 'Mute this layer' : 'Unmute this layer'} onClick={() => set((l) => { l.on = !l.on })} />
        <span className="ph-layer-num">{String.fromCharCode(65 + index)}</span>
        <select className="ph-layer-type" value={layer.type} aria-label="Layer type" onChange={(e) => set((l) => {
          const fresh = makeLayer(e.target.value)
          Object.assign(l, { type: fresh.type, unison: fresh.unison, detune: fresh.detune })
        })}>
          {Object.entries(LAYER_TYPES).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
        </select>
        {layer.type === 'analog' && <select className="ph-layer-sub" value={layer.wave} aria-label="Wave" onChange={(e) => set((l) => { l.wave = e.target.value })}>{WAVES.map((w) => <option key={w}>{w}</option>)}</select>}
        {layer.type === 'wavetable' && <select className="ph-layer-sub" value={layer.table} aria-label="Wavetable" title={TABLES[layer.table]} onChange={(e) => set((l) => { l.table = e.target.value })}>{Object.keys(TABLES).map((t) => <option key={t}>{t}</option>)}</select>}
        {layer.type === 'noise' && <select className="ph-layer-sub" value={layer.color} aria-label="Noise colour" onChange={(e) => set((l) => { l.color = e.target.value })}>{NOISES.map((w) => <option key={w}>{w}</option>)}</select>}
        <span className="spacer" />
        <button type="button" className="ph-mini" disabled={index === 0} onClick={() => ui.edit((p) => { const i = p.layers.findIndex((x) => x.id === layer.id); if (i > 0) [p.layers[i - 1], p.layers[i]] = [p.layers[i], p.layers[i - 1]] })} aria-label="Move layer up">↑</button>
        <button type="button" className="ph-mini" disabled={count >= MAX_LAYERS} title="Duplicate layer" onClick={() => ui.edit((p) => { const i = p.layers.findIndex((x) => x.id === layer.id); if (i >= 0 && p.layers.length < MAX_LAYERS) p.layers.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(layer)), id: newPartId() }) })} aria-label="Duplicate layer">⧉</button>
        <button type="button" className="ph-mini" disabled={count <= 1} onClick={() => ui.edit((p) => { p.layers = p.layers.filter((x) => x.id !== layer.id); p.mods = p.mods.filter((m) => !m.target.startsWith(`layer:${layer.id}.`)) })} aria-label="Remove layer">×</button>
      </header>
      <div className="ph-layer-body">
        <LayerScope layer={layer} />
        <div className="ph-layer-pitch">
          <Stepper label="oct" value={layer.oct} min={-3} max={3} onChange={(v) => set((l) => { l.oct = v })} format={(v) => (v > 0 ? `+${v}` : v)} />
          <Stepper label="semi" value={layer.semi} min={-12} max={12} onChange={(v) => set((l) => { l.semi = v })} format={(v) => (v > 0 ? `+${v}` : v)} />
          {layer.type !== 'noise' && knob('fine')}
        </div>
      </div>
      <div className="ph-knobs">
        {layer.type === 'wavetable' && knob('pos')}
        {layer.type === 'wavetable' && knob('warp')}
        {layer.type === 'analog' && layer.wave === 'pulse' && knob('pw')}
        {(layer.type === 'supersaw' || layer.type === 'wavetable') && (
          <Stepper label="voices" value={layer.unison} min={1} max={16} onChange={(v) => set((l) => { l.unison = v })} />
        )}
        {(layer.type === 'supersaw' || (layer.type === 'wavetable' && layer.unison > 1)) && <>{knob('detune')}{knob('spread')}</>}
        {layer.type !== 'noise' && <>{knob('fm')}{layer.fm > 0 && plain('ratio')}</>}
        <span className="ph-knob-gap" />
        {knob('pan')}
        {knob('level')}
      </div>
      {(layer.type === 'wavetable' || (layer.type !== 'noise' && layer.fm > 0)) && (
        <div className="ph-layer-foot">
          {layer.type === 'wavetable' && <Select label="warp mode" value={layer.warpmode} options={WARP_MODES} onChange={(v) => set((l) => { l.warpmode = v })} />}
          {layer.type !== 'noise' && layer.fm > 0 && <Select label="fm wave" value={layer.fmwave} options={FM_WAVES} onChange={(v) => set((l) => { l.fmwave = v })} />}
        </div>
      )}
    </article>
  )
}

function FilterSection({ ui }) {
  const f = ui.patch.filter
  const set = (fn) => ui.edit((p) => fn(p.filter))
  return (
    <section className={`ph-section ph-filter ${f.on ? '' : 'off'}`} aria-label="Filter">
      <header className="ph-section-head">
        <button type="button" className={`ph-led ${f.on ? 'on' : ''}`} aria-pressed={f.on} title={f.on ? 'Turn the filter off' : 'Turn the filter on'} onClick={() => set((x) => { x.on = !x.on })} />
        <h3>filter</h3>
        <span className="spacer" />
        <Segmented label="Filter type" value={f.type} options={FILTER_TYPES} onChange={(v) => set((x) => { x.type = v; x.on = true })} />
      </header>
      <FilterScope filter={f} />
      <div className="ph-knobs">
        <Select label="slope" value={f.slope} options={FILTER_SLOPES} onChange={(v) => set((x) => { x.slope = v })} />
        <ModKnob ui={ui} target="filter.cutoff" def={K.cutoff} value={f.cutoff} onChange={(v) => set((x) => { x.cutoff = v; x.on = true })} />
        <ModKnob ui={ui} target="filter.reso" def={K.reso} value={f.reso} onChange={(v) => set((x) => { x.reso = v })} />
        <ModKnob ui={ui} target="filter.drive" def={K.drive} value={f.drive} onChange={(v) => set((x) => { x.drive = v })} />
      </div>
    </section>
  )
}

function EnvSection({ ui, which }) {
  const env = ui.patch[which]
  const set = (k) => (v) => ui.edit((p) => { p[which][k] = v })
  const isAmp = which === 'amp'
  return (
    <section className={`ph-section ph-env ${isAmp ? '' : 'src-env'}`} aria-label={isAmp ? 'Amp envelope' : 'Mod envelope'}>
      <header className="ph-section-head">
        {!isAmp && <Grip src="env" ui={ui} />}
        <h3>{isAmp ? 'amp env' : 'mod env'}</h3>
        <span className="spacer" />
        {!isAmp && <span className="ph-count">{ui.patch.mods.filter((m) => m.src === 'env').length || ''}</span>}
      </header>
      <EnvScope env={env} />
      <div className="ph-knobs">
        {['attack', 'decay', 'sustain', 'release'].map((k) => <Knob key={k} def={K[k]} value={env[k]} onChange={set(k)} />)}
      </div>
    </section>
  )
}

function LfoSection({ ui, index }) {
  const src = `lfo${index + 1}`
  const lfo = ui.patch.lfos[index]
  const set = (fn) => ui.edit((p) => fn(p.lfos[index]))
  return (
    <section className={`ph-section ph-lfo src-${src}`} aria-label={`LFO ${index + 1}`}>
      <header className="ph-section-head">
        <Grip src={src} ui={ui} />
        <h3>lfo {index + 1}</h3>
        <span className="spacer" />
        <span className="ph-count">{ui.patch.mods.filter((m) => m.src === src).length || ''}</span>
      </header>
      <LfoScope lfo={lfo} />
      <div className="ph-knobs">
        <Select label="shape" value={lfo.shape} options={LFO_SHAPES} onChange={(v) => set((l) => { l.shape = v })} />
        <div className="ph-rate">
          <button type="button" className={`ph-toggle ${lfo.sync ? 'on' : ''}`} aria-pressed={lfo.sync} title={lfo.sync ? 'Synced to bars; click for a free rate' : 'Free rate; click to sync to bars'} onClick={() => set((l) => { l.sync = !l.sync })}>sync</button>
          {lfo.sync
            ? <Select label="every" value={String(lfo.bars)} options={LFO_BARS.map(String)} format={(o) => barsLabel(Number(o))} onChange={(v) => set((l) => { l.bars = Number(v) })} />
            : <Knob def={K.hz} value={lfo.hz} onChange={(v) => set((l) => { l.hz = v })} />}
        </div>
      </div>
    </section>
  )
}

const STATUS_HINT = {
  native: 'Smooth: Strudel moves this while the note plays',
  'native (sine)': 'Smooth, but pitch wobble is always a sine in Strudel',
  'per note': 'Stepped: each note starts at the lfo’s current value and holds it',
  off: 'Not heard: this target can’t take this source, is switched off, or is already taken',
}

function Matrix({ ui }) {
  const { patch } = ui
  const [src, setSrc] = useState('lfo1')
  const [target, setTarget] = useState('filter.cutoff')
  const targets = useMemo(() => {
    const list = [['filter.cutoff', 'filter cutoff'], ['filter.reso', 'filter reso'], ['filter.drive', 'filter drive'], ['pitch', 'pitch'], ['amp.level', 'amp'], ['volume', 'volume']]
    patch.layers.forEach((l, i) => {
      const knobs = ['level', 'pan', 'fine', 'fm']
      if (l.type === 'wavetable') knobs.push('pos', 'warp', 'detune', 'spread')
      if (l.type === 'supersaw') knobs.push('detune', 'spread')
      if (l.type === 'analog' && l.wave === 'pulse') knobs.push('pw')
      for (const k of knobs) list.push([`layer:${l.id}.${k}`, `${String.fromCharCode(65 + i)} ${K[k].label}`])
    })
    return list
  }, [patch.layers])
  const exists = patch.mods.some((m) => m.src === src && m.target === target)
  return (
    <section className="ph-matrix" aria-label="Modulation matrix">
      <table>
        <thead><tr><th scope="col">source</th><th scope="col">target</th><th scope="col">amount</th><th scope="col">how it moves</th><th scope="col"><span className="sr-only">remove</span></th></tr></thead>
        <tbody>
          {patch.mods.length === 0 && (
            <tr><td colSpan={5} className="ph-empty">No routes yet. Drag a grip from mod env or an lfo onto any glowing knob, or add one below.</td></tr>
          )}
          {patch.mods.map((m) => (
            <tr key={m.id}>
              <td><span className={`ph-chip src-${m.src}`}>{SOURCE_LABELS[m.src]}</span></td>
              <td>{targetSpec(patch, m.target)?.label ?? m.target}</td>
              <td>
                <input
                  type="range" min="-1" max="1" step="0.01" value={m.amt}
                  className={`ph-amount src-${m.src}`}
                  aria-label={`${SOURCE_LABELS[m.src]} to ${targetSpec(patch, m.target)?.label}: amount`}
                  onChange={(e) => ui.edit((p) => { const r = p.mods.find((x) => x.id === m.id); if (r) r.amt = Number(e.target.value) })}
                  onDoubleClick={() => ui.edit((p) => { const r = p.mods.find((x) => x.id === m.id); if (r) r.amt = 0.5 })}
                />
                <output>{m.amt > 0 ? '+' : ''}{Math.round(m.amt * 100)}</output>
              </td>
              <td><span className={`ph-status s-${(ui.status[m.id] ?? 'off').replace(/\W+/g, '-')}`} title={STATUS_HINT[ui.status[m.id] ?? 'off']}>{ui.status[m.id] ?? 'off'}</span></td>
              <td><button type="button" className="ph-mini" aria-label="Remove route" onClick={() => ui.edit((p) => { p.mods = p.mods.filter((x) => x.id !== m.id) })}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ph-matrix-add">
        <Select label="source" value={src} options={SOURCES} format={(s) => SOURCE_LABELS[s]} onChange={setSrc} />
        <Select label="target" value={target} options={targets.map(([t]) => t)} format={(t) => targets.find(([x]) => x === t)?.[1] ?? t} onChange={setTarget} wide />
        <button type="button" className="btn" disabled={exists || !targetAccepts(patch, src, target)} onClick={() => ui.addRoute(src, target)}>
          {exists ? 'already routed' : targetAccepts(patch, src, target) ? 'add route' : 'env can’t move that'}
        </button>
      </div>
    </section>
  )
}

function Keys({ ui, cps, base, setBase }) {
  const [down, setDown] = useState(null)
  const play = (m) => { setDown(m); playNote(ui.patch, m, cps) }
  useEffect(() => {
    if (down === null) return
    const t = setTimeout(() => setDown(null), 180)
    return () => clearTimeout(t)
  }, [down])
  const keys = []
  for (let m = base; m < base + 25; m++) keys.push(m)
  const whites = keys.filter((m) => ![1, 3, 6, 8, 10].includes(m % 12))
  return (
    <footer className="ph-keys">
      <Stepper label="octave" value={Math.floor(base / 12) - 1} min={1} max={6} onChange={(v) => setBase((v + 1) * 12)} />
      <div className="ph-piano" role="group" aria-label="Keyboard: click to hear the patch">
        {whites.map((m) => {
          const black = keys.includes(m + 1) && [1, 3, 6, 8, 10].includes((m + 1) % 12)
          const ki = keys.indexOf(m)
          return (
            <div key={m} className="ph-white-wrap">
              <button type="button" className={`ph-white ${down === m ? 'down' : ''}`} onPointerDown={() => play(m)} aria-label={noteName(m)}>
                {m % 12 === 0 && <span>{noteName(m)}</span>}
                {COMPUTER_KEYS[ki] && <kbd>{COMPUTER_KEYS[ki]}</kbd>}
              </button>
              {black && <button type="button" className={`ph-black ${down === m + 1 ? 'down' : ''}`} onPointerDown={() => play(m + 1)} aria-label={noteName(m + 1)} />}
            </div>
          )
        })}
      </div>
      <p className="ph-hint">keys <kbd>a</kbd>–<kbd>;</kbd> play too · <kbd>z</kbd>/<kbd>x</kbd> octave</p>
    </footer>
  )
}

// ── the panel ────────────────────────────────────────────────────────────────

/** The full synth: a floating window over the patch, one node's instrument. */
export default function Phyllo({ node, cps, anchor, onEdit, onClose, fx }) {
  const patch = useMemo(() => normalizePatch(node.data.patch), [node.data.patch])
  const status = useMemo(() => compileVoice(patch, { cps }).status, [patch, cps])
  const [tab, setTab] = useState('synth')
  const [dragging, setDragging] = useState(null)
  const [ghost, setGhost] = useState(null)
  const [userPresets, setUserPresets] = useState(() => readJson(PRESET_KEY, []))
  const ref = useRef(null)
  const patchRef = useRef(patch)
  patchRef.current = patch
  const [base, setBase] = useState(48) // lowest note on the keyboard
  const baseRef = useRef(base)
  baseRef.current = base

  const edit = useCallback((fn) => onEdit((raw) => fn(raw)), [onEdit])

  const addRoute = useCallback((src, target, amt = 0.5) => edit((p) => {
    if (p.mods.some((m) => m.src === src && m.target === target)) return
    p.mods.push({ id: newPartId(), src, target, amt })
  }), [edit])

  // drag a modulator's grip onto a knob
  const startDrag = useCallback((src, e) => {
    e.preventDefault()
    setDragging(src)
    setGhost({ x: e.clientX, y: e.clientY })
    const move = (ev) => setGhost({ x: ev.clientX, y: ev.clientY })
    const up = (ev) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDragging(null)
      setGhost(null)
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('[data-mod-target]')?.dataset.modTarget
      if (target && targetAccepts(patchRef.current, src, target)) addRoute(src, target)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [addRoute])

  const ui = { patch, status, edit, dragging, startDrag, addRoute }

  // window: remembered size, drag the header to move, expand to fill
  const [size] = useState(() => {
    const s = readJson(SIZE_KEY, { w: 1080, h: 700 })
    return { w: clamp(s.w, 640, window.innerWidth - 24), h: clamp(s.h, 420, window.innerHeight - 24) }
  })
  const [pos, setPos] = useState(() => ({
    left: clamp((anchor?.x ?? window.innerWidth / 2) - size.w / 2, 12, Math.max(12, window.innerWidth - size.w - 12)),
    top: clamp((anchor?.y ?? 120) - 40, 12, Math.max(12, window.innerHeight - size.h - 12)),
  }))
  const [expanded, setExpanded] = useState(false)
  const moveRef = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el || expanded) return
    let timer
    const ro = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => writeJson(SIZE_KEY, { w: Math.round(el.offsetWidth), h: Math.round(el.offsetHeight) }), 200)
    })
    ro.observe(el)
    return () => { ro.disconnect(); clearTimeout(timer) }
  }, [expanded])

  // close on Escape or a click outside; keys play the keyboard
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.('input, select, textarea')) return
      if (e.key === 'Escape') { onClose(); return }
      if (!ref.current?.contains(document.activeElement) && document.activeElement !== document.body) return
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
      const k = e.key.toLowerCase()
      if (k === 'z' || k === 'x') { setBase((b) => clamp(b + (k === 'z' ? -12 : 12), 24, 84)); e.preventDefault(); return }
      const i = COMPUTER_KEYS.indexOf(k)
      if (i >= 0) { playNote(patchRef.current, baseRef.current + i, cps); e.preventDefault() }
    }
    const onDown = (e) => {
      if (ref.current?.contains(e.target) || e.target.closest?.('.sound-picker')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pointerdown', onDown) }
  }, [onClose, cps])

  const presetOptions = [...PRESETS.map((p) => `builtin:${p.name}`), ...userPresets.map((p, i) => `user:${i}`)]
  const loadPreset = (key) => {
    const [kind, id] = key.split(':')
    const source = kind === 'builtin' ? PRESETS.find((p) => p.name === id) : userPresets[Number(id)]
    if (source) edit((p) => { Object.keys(p).forEach((k) => delete p[k]); Object.assign(p, JSON.parse(JSON.stringify(source))) })
  }
  const savePreset = () => {
    const next = [...userPresets.filter((p) => p.name !== patch.name), JSON.parse(JSON.stringify(patch))].slice(-40)
    setUserPresets(next)
    writeJson(PRESET_KEY, next)
  }

  const voices = voiceCount(patch)
  return (
    <div
      className={`phyllo ${expanded ? 'expanded' : ''} ${dragging ? 'modding' : ''}`}
      ref={ref}
      role="dialog"
      aria-label={`Phyllo synth: ${patch.name}`}
      style={expanded ? undefined : { left: pos.left, top: pos.top, width: size.w, height: size.h }}
      onKeyDown={(e) => { if (['Delete', 'Backspace'].includes(e.key) && !e.target.closest('input, select, textarea')) e.stopPropagation() }}
    >
      <div
        className="ph-top"
        onPointerDown={(e) => {
          if (expanded || e.button !== 0 || e.target.closest('input, select, button, textarea')) return
          e.currentTarget.setPointerCapture(e.pointerId)
          moveRef.current = { x: e.clientX, y: e.clientY, left: pos.left, top: pos.top }
        }}
        onPointerMove={(e) => {
          const m = moveRef.current
          if (!m) return
          setPos({ left: clamp(m.left + e.clientX - m.x, 120 - size.w, window.innerWidth - 120), top: clamp(m.top + e.clientY - m.y, 0, window.innerHeight - 60) })
        }}
        onPointerUp={() => { moveRef.current = null }}
        onPointerCancel={() => { moveRef.current = null }}
      >
        <span className="ph-mark" aria-hidden>phyllo</span>
        <input
          className="ph-name"
          value={patch.name}
          maxLength={40}
          aria-label="Patch name"
          onChange={(e) => edit((p) => { p.name = e.target.value })}
        />
        <label className="ph-select ph-presets">
          <span className="sr-only">Presets</span>
          <select value="" onChange={(e) => { if (e.target.value) loadPreset(e.target.value) }}>
            <option value="">presets…</option>
            <optgroup label="phyllo">{PRESETS.map((p) => <option key={p.name} value={`builtin:${p.name}`}>{p.name}</option>)}</optgroup>
            {userPresets.length > 0 && <optgroup label="saved in this browser">{userPresets.map((p, i) => <option key={`${p.name}${i}`} value={presetOptions[PRESETS.length + i]}>{p.name}</option>)}</optgroup>}
          </select>
        </label>
        <button type="button" className="btn" onClick={savePreset} title="Keep this patch in this browser's preset list">save preset</button>
        <nav className="ph-tabs" aria-label="Phyllo sections">
          {['synth', 'matrix', 'fx'].map((t) => (
            <button key={t} type="button" className={tab === t ? 'on' : ''} aria-pressed={tab === t} onClick={() => setTab(t)}>
              {t}{t === 'matrix' && patch.mods.length > 0 && <sup>{patch.mods.length}</sup>}{t === 'fx' && (node.data.chain?.length ?? 0) > 0 && <sup>{node.data.chain.length}</sup>}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <span className="ph-voices" title="Voices each note uses (Strudel plays 128 at once)">{voices} voice{voices === 1 ? '' : 's'}/note</span>
        <button type="button" className="btn" onClick={() => setExpanded((v) => !v)} aria-pressed={expanded}>{expanded ? 'shrink' : 'expand'}</button>
        <button type="button" className="btn ghost" onClick={onClose} aria-label="Close">close</button>
      </div>

      {tab === 'synth' && (
        <div className="ph-main">
          <div className="ph-layers">
            {patch.layers.map((l, i) => <LayerCard key={l.id} ui={ui} layer={l} index={i} />)}
            {patch.layers.length < MAX_LAYERS && (
              <div className="ph-add-layer">
                <span>add a layer</span>
                {Object.entries(LAYER_TYPES).map(([k, t]) => (
                  <button key={k} type="button" className="btn" title={t.blurb} onClick={() => edit((p) => { if (p.layers.length < MAX_LAYERS) p.layers.push(makeLayer(k, k === 'noise' ? { level: 0.25 } : {})) })}>+ {t.label}</button>
                ))}
              </div>
            )}
          </div>
          <div className="ph-side">
            <FilterSection ui={ui} />
            <div className="ph-mods">
              <EnvSection ui={ui} which="amp" />
              <EnvSection ui={ui} which="env" />
              <LfoSection ui={ui} index={0} />
              <LfoSection ui={ui} index={1} />
            </div>
            <section className="ph-section ph-master" aria-label="Output">
              <header className="ph-section-head"><h3>output</h3></header>
              <div className="ph-knobs">
                <ModPad ui={ui} target="pitch" label="pitch" hint="Drop the mod env for a pitch sweep, or an lfo for vibrato" />
                <ModPad ui={ui} target="amp.level" label="amp" hint="Drop an lfo for tremolo" />
                <span className="ph-knob-gap" />
                <ModKnob ui={ui} target="volume" def={K.volume} value={patch.volume} onChange={(v) => edit((p) => { p.volume = v })} />
              </div>
            </section>
          </div>
        </div>
      )}
      {tab === 'matrix' && <div className="ph-main single"><Matrix ui={ui} /></div>}
      {tab === 'fx' && (
        <div className="ph-main single ph-fx">
          <p className="ph-hint">Effects after the synth, top to bottom. They're part of this module, so they travel with the patch.</p>
          {fx}
        </div>
      )}

      <Keys ui={ui} cps={cps} base={base} setBase={setBase} />

      {ghost && dragging && (
        <div className={`ph-ghost src-${dragging}`} style={{ left: ghost.x + 12, top: ghost.y + 12 }} aria-hidden>{SOURCE_LABELS[dragging]} → drop on a knob</div>
      )}
    </div>
  )
}

/** What a phyllo node shows on the patch: a glance at the sound and the knobs you reach for most. */
export function PhylloFace({ node, onEdit, onOpen }) {
  const patch = useMemo(() => normalizePatch(node.data.patch), [node.data.patch])
  const lead = patch.layers.find((l) => l.on) ?? patch.layers[0]
  const f = patch.filter
  return (
    <div className="ph-face">
      <div className="ph-face-top">
        <LayerScope layer={lead} />
        <div className="ph-face-info">
          <strong>{patch.name}</strong>
          <span>{patch.layers.map((l, i) => `${String.fromCharCode(65 + i)} ${l.type === 'analog' ? l.wave : l.type === 'wavetable' ? l.table : l.type}`).join(' · ')}</span>
          {patch.mods.length > 0 && <span>{patch.mods.length} mod{patch.mods.length === 1 ? '' : 's'}</span>}
        </div>
      </div>
      <div className="node-params nowheel nodrag">
        <Knob def={K.cutoff} value={f.cutoff} onChange={(v) => onEdit((p) => { p.filter.cutoff = v; p.filter.on = true })} />
        <Knob def={K.reso} value={f.reso} onChange={(v) => onEdit((p) => { p.filter.reso = v })} />
        <Knob def={K.attack} value={patch.amp.attack} onChange={(v) => onEdit((p) => { p.amp.attack = v })} />
        <Knob def={K.release} value={patch.amp.release} onChange={(v) => onEdit((p) => { p.amp.release = v })} />
      </div>
      <div className="node-actions nodrag">
        <button type="button" className="btn primary" onClick={onOpen}>open synth</button>
      </div>
    </div>
  )
}
