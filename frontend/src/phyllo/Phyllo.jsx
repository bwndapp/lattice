import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAudioContext, superdough } from '@strudel/webaudio'
import Knob from '../Knob.jsx'
import { ensureAudio } from '../audio'
import {
  FILTER_SLOPES, FILTER_TYPES, FM_WAVES, K, LFO_BARS, LFO_SHAPES, MAX_LAYERS, NOISES, PRESETS, SOURCE_LABELS,
  TABLES, WARP_MODES, barsLabel, compileVoice, makeLayer, newPartId, normalizePatch, previewValues, tableFrame, targetSpec,
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
        <button key={o} type="button" role="radio" aria-checked={value === o} className={value === o ? 'on' : ''} onClick={() => onChange(o)}>{format(o)}</button>
      ))}
    </div>
  )
}

/** A knob with a coloured ring for each modulation moving it. */
function ModKnob({ ui, target, def, value, onChange }) {
  const routes = target ? ui.patch.mods.filter((m) => m.target === target && ui.status[m.id] !== 'off') : []
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
      <Knob def={def} value={value} onChange={onChange} />
      {routes.length > 0 && (
        <svg className="ph-rings" width="44" height="44" viewBox="0 0 44 44" aria-hidden>
          {routes.map((m, i) => {
            const swing = Math.abs(m.amt) / 2
            return <path key={m.id} d={arc(clamp(at - swing, 0, 1), clamp(at + swing, 0, 1), 19 - i * 3)} className={`ph-ring src-${m.src}`} />
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
  ['wavetable', Object.keys(TABLES).map((t) => [`wavetable:${t}`, `${t} table`])],
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
const letter = (i) => String.fromCharCode(65 + i)

// ── modulation destinations ──────────────────────────────────────────────────

/** Everything a source can move, with names a person would use. */
function destinations(patch, src) {
  const list = [['filter.cutoff', 'filter cutoff'], ['filter.reso', 'filter resonance'], ['pitch', 'pitch'], ['amp.level', 'volume']]
  if (patch.filter.slope !== 'ladder') list.splice(2, 0, ['filter.drive', 'filter drive'])
  patch.layers.forEach((l, i) => {
    const knobs = ['level', 'pan']
    const tone = toneKnob(l)
    if (tone) knobs.unshift(tone)
    if (l.type === 'wavetable') knobs.push('warp')
    if (l.type !== 'noise') knobs.push('fm', 'fine')
    for (const k of knobs) list.push([`layer:${l.id}.${k}`, `${letter(i)} ${K[k].label}`])
  })
  return list.filter(([t]) => accepts(patch, src, t))
}

/** An envelope can only shape things Strudel shapes per note; an lfo can move anything. */
function accepts(patch, src, target) {
  const t = targetSpec(patch, target)
  if (!t) return false
  if (src !== 'env') return true
  if (target === 'filter.cutoff' || target === 'pitch') return true
  const layer = t.layerId && patch.layers.find((l) => l.id === t.layerId)
  if (!layer) return false
  return t.knob === 'fm' ? layer.type !== 'noise' : layer.type === 'wavetable' && (t.knob === 'pos' || t.knob === 'warp')
}

const AMOUNT = { key: 'amt', label: 'amount', min: -1, max: 1, def: 0.5, unit: 'bi', origin: 0 }
const NOTE = { 'per note': 'moves once per note', off: 'not available', 'native (sine)': 'sine only' }

function Destinations({ ui, src }) {
  const { patch, edit, status } = ui
  const routes = patch.mods.filter((m) => m.src === src)
  const options = destinations(patch, src)
  const free = options.filter(([t]) => !routes.some((m) => m.target === t))
  return (
    <div className="ph-dests">
      {routes.map((m) => {
        const here = options.find(([t]) => t === m.target)
        return (
          <div key={m.id} className={`ph-dest ${status[m.id] === 'off' ? 'off' : ''}`}>
            <span className={`ph-dot src-${src}`} aria-hidden />
            <select
              value={m.target}
              aria-label={`${SOURCE_LABELS[src]} destination`}
              onChange={(e) => edit((p) => { const r = p.mods.find((x) => x.id === m.id); if (r && !p.mods.some((x) => x.src === src && x.target === e.target.value)) r.target = e.target.value })}
            >
              {!here && <option value={m.target}>{targetSpec(patch, m.target)?.label ?? 'gone'}</option>}
              {options.map(([t, label]) => <option key={t} value={t} disabled={t !== m.target && routes.some((x) => x.target === t)}>{label}</option>)}
            </select>
            <div className="ph-dest-amt">
              <Knob def={AMOUNT} value={m.amt} onChange={(v) => edit((p) => { const r = p.mods.find((x) => x.id === m.id); if (r) r.amt = v })} />
            </div>
            {NOTE[status[m.id]] && <span className="ph-dest-note">{NOTE[status[m.id]]}</span>}
            <button type="button" className="ph-x" aria-label="Remove destination" onClick={() => edit((p) => { p.mods = p.mods.filter((x) => x.id !== m.id) })}>×</button>
          </div>
        )
      })}
      {free.length > 0 && routes.length < 4 && (
        <button type="button" className="ph-add" onClick={() => edit((p) => { p.mods.push({ id: newPartId(), src, target: free[0][0], amt: 0.5 }) })}>+ destination</button>
      )}
    </div>
  )
}

// ── sections ─────────────────────────────────────────────────────────────────

function Section({ title, className = '', aside, children }) {
  return (
    <section className={`ph-card ${className}`} aria-label={title}>
      <header className="ph-card-head"><h3>{title}</h3>{aside}</header>
      {children}
    </section>
  )
}

function LayerStrip({ ui, layer, index, open, onToggle }) {
  const set = (fn) => ui.edit((p) => { const l = p.layers.find((x) => x.id === layer.id); if (l) fn(l) })
  const knob = (k) => <ModKnob key={k} ui={ui} target={`layer:${layer.id}.${k}`} def={K[k]} value={layer[k]} onChange={(v) => set((l) => { l[k] = v })} />
  const tone = toneKnob(layer)
  const count = ui.patch.layers.length
  return (
    <div className={`ph-layer ${layer.on ? '' : 'off'} ${open ? 'open' : ''}`}>
      <div className="ph-layer-row">
        <button type="button" className={`ph-power ${layer.on ? 'on' : ''}`} aria-pressed={layer.on} aria-label={`Layer ${letter(index)} ${layer.on ? 'on' : 'off'}`} onClick={() => set((l) => { l.on = !l.on })}>{letter(index)}</button>
        <select className="ph-sound" value={soundOf(layer)} aria-label={`Layer ${letter(index)} sound`} onChange={(e) => set((l) => applySound(l, e.target.value))}>
          {SOUND_GROUPS.map(([group, items]) => (
            <optgroup key={group} label={group}>{items.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</optgroup>
          ))}
        </select>
        <LayerScope layer={layer} />
        <Stepper label="octave" value={layer.oct} min={-3} max={3} onChange={(v) => set((l) => { l.oct = v })} format={(v) => (v > 0 ? `+${v}` : v)} />
        <div className="ph-layer-knobs">
          {tone ? knob(tone) : <span className="ph-knob-space" />}
          {knob('level')}
        </div>
        <button type="button" className={`ph-more ${open ? 'on' : ''}`} aria-expanded={open} onClick={onToggle} title="More controls for this layer">{open ? 'less' : 'more'}</button>
        <button type="button" className="ph-x" disabled={count <= 1} aria-label={`Remove layer ${letter(index)}`} onClick={() => ui.edit((p) => { p.layers = p.layers.filter((x) => x.id !== layer.id); p.mods = p.mods.filter((m) => !m.target.startsWith(`layer:${layer.id}.`)) })}>×</button>
      </div>
      {open && (
        <div className="ph-layer-more">
          <Stepper label="semitones" value={layer.semi} min={-12} max={12} onChange={(v) => set((l) => { l.semi = v })} format={(v) => (v > 0 ? `+${v}` : v)} />
          {layer.type !== 'noise' && knob('fine')}
          {knob('pan')}
          {(layer.type === 'supersaw' || layer.type === 'wavetable') && <Stepper label="voices" value={layer.unison} min={1} max={16} onChange={(v) => set((l) => { l.unison = v })} />}
          {layer.type === 'wavetable' && layer.unison > 1 && knob('detune')}
          {(layer.type === 'supersaw' || (layer.type === 'wavetable' && layer.unison > 1)) && knob('spread')}
          {layer.type === 'wavetable' && knob('warp')}
          {layer.type === 'wavetable' && (
            <label className="ph-field"><select value={layer.warpmode} onChange={(e) => set((l) => { l.warpmode = e.target.value })}>{WARP_MODES.map((w) => <option key={w}>{w}</option>)}</select><span className="ph-small-label">warp mode</span></label>
          )}
          {layer.type !== 'noise' && knob('fm')}
          {layer.type !== 'noise' && layer.fm > 0 && <Knob def={K.ratio} value={layer.ratio} onChange={(v) => set((l) => { l.ratio = v })} />}
          {layer.type !== 'noise' && layer.fm > 0 && (
            <label className="ph-field"><select value={layer.fmwave} onChange={(e) => set((l) => { l.fmwave = e.target.value })}>{FM_WAVES.map((w) => <option key={w}>{w}</option>)}</select><span className="ph-small-label">fm wave</span></label>
          )}
          <span className="spacer" />
          <button type="button" className="ph-link" disabled={count >= MAX_LAYERS} onClick={() => ui.edit((p) => { const i = p.layers.findIndex((x) => x.id === layer.id); if (i >= 0 && p.layers.length < MAX_LAYERS) p.layers.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(layer)), id: newPartId() }) })}>duplicate</button>
        </div>
      )}
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
    else p.mods.push({ id: newPartId(), src: 'env', target: 'filter.cutoff', amt: v })
  })
  return (
    <Section
      title="filter"
      className={`ph-filter ${f.on ? '' : 'off'}`}
      aside={<button type="button" className={`ph-toggle ${f.on ? 'on' : ''}`} aria-pressed={f.on} onClick={() => set((x) => { x.on = !x.on })}>{f.on ? 'on' : 'off'}</button>}
    >
      <div className="ph-filter-top">
        <Segmented label="Filter type" value={f.type} options={FILTER_TYPES} format={(t) => ({ lowpass: 'low pass', highpass: 'high pass', bandpass: 'band pass' })[t]} onChange={(v) => set((x) => { x.type = v; x.on = true })} />
        <Segmented label="Slope" value={f.slope} options={FILTER_SLOPES} format={(s) => ({ '12db': '12 dB', '24db': '24 dB', ladder: 'ladder' })[s]} onChange={(v) => set((x) => { x.slope = v; x.on = true })} />
      </div>
      <FilterScope filter={f} />
      <div className="ph-knobs">
        <ModKnob ui={ui} target="filter.cutoff" def={K.cutoff} value={f.cutoff} onChange={(v) => set((x) => { x.cutoff = v; x.on = true })} />
        <ModKnob ui={ui} target="filter.reso" def={K.reso} value={f.reso} onChange={(v) => set((x) => { x.reso = v })} />
        <ModKnob ui={ui} target="filter.drive" def={K.drive} value={f.drive} onChange={(v) => set((x) => { x.drive = v })} />
        <div className="ph-env-amt" title="How far the mod envelope opens (or closes) the cutoff on each note">
          <Knob def={{ key: 'envamt', label: 'env amount', min: -1, max: 1, def: 0, unit: 'bi', origin: 0 }} value={envRoute?.amt ?? 0} onChange={setEnv} />
        </div>
      </div>
    </Section>
  )
}

function Envelope({ ui, which }) {
  const env = ui.patch[which]
  const set = (k) => (v) => ui.edit((p) => { p[which][k] = v })
  const isAmp = which === 'amp'
  return (
    <Section title={isAmp ? 'amp envelope' : 'mod envelope'} className={isAmp ? 'ph-amp' : 'ph-src src-env'}>
      <EnvScope env={env} />
      <div className="ph-knobs tight">
        {['attack', 'decay', 'sustain', 'release'].map((k) => <Knob key={k} def={K[k]} value={env[k]} onChange={set(k)} />)}
      </div>
      {!isAmp && <Destinations ui={ui} src="env" />}
    </Section>
  )
}

function Lfo({ ui, index }) {
  const src = `lfo${index + 1}`
  const lfo = ui.patch.lfos[index]
  const set = (fn) => ui.edit((p) => fn(p.lfos[index]))
  return (
    <Section title={`lfo ${index + 1}`} className={`ph-src src-${src}`}>
      <LfoScope lfo={lfo} />
      <div className="ph-lfo-controls">
        <Segmented label="Shape" value={lfo.shape} options={LFO_SHAPES} format={(s) => ({ sine: 'sin', tri: 'tri', saw: 'saw', ramp: 'ramp', square: 'sq' })[s]} onChange={(v) => set((l) => { l.shape = v })} />
        <div className="ph-rate">
          <Segmented label="Rate mode" value={lfo.sync ? 'bars' : 'hz'} options={['bars', 'hz']} onChange={(v) => set((l) => { l.sync = v === 'bars' })} />
          {lfo.sync
            ? <select className="ph-rate-select" aria-label="Every" value={String(lfo.bars)} onChange={(e) => set((l) => { l.bars = Number(e.target.value) })}>{LFO_BARS.map((b) => <option key={b} value={String(b)}>{barsLabel(b)}</option>)}</select>
            : <Knob def={K.hz} value={lfo.hz} onChange={(v) => set((l) => { l.hz = v })} />}
        </div>
      </div>
      <Destinations ui={ui} src={src} />
    </Section>
  )
}

function Keys({ patch, cps, base, setBase }) {
  const [down, setDown] = useState(null)
  const play = (m) => { setDown(m); playNote(patch, m, cps) }
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
      <p className="ph-hint">play with <kbd>a</kbd>–<kbd>;</kbd> · <kbd>z</kbd> <kbd>x</kbd> octave</p>
    </footer>
  )
}

// ── the window ───────────────────────────────────────────────────────────────

/** The synth: a floating window over the patch for one node's instrument. */
export default function Phyllo({ node, cps, anchor, onEdit, onClose, fx }) {
  const patch = useMemo(() => normalizePatch(node.data.patch), [node.data.patch])
  const status = useMemo(() => compileVoice(patch, { cps }).status, [patch, cps])
  const [openLayer, setOpenLayer] = useState(null)
  const [fxOpen, setFxOpen] = useState(false)
  const [userPresets, setUserPresets] = useState(() => readJson(PRESET_KEY, []))
  const ref = useRef(null)
  const patchRef = useRef(patch)
  patchRef.current = patch
  const [base, setBase] = useState(48)
  const baseRef = useRef(base)
  baseRef.current = base

  const edit = useCallback((fn) => onEdit((raw) => fn(raw)), [onEdit])
  const ui = { patch, status, edit }

  // window: remembered size, drag the top bar to move, expand to fill
  const [size] = useState(() => {
    const s = readJson(SIZE_KEY, { w: 1040, h: 700 })
    return { w: clamp(s.w, 640, window.innerWidth - 24), h: clamp(s.h, 440, window.innerHeight - 24) }
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

  // Escape or a click outside closes; letter keys play the keyboard
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

  const allPresets = [...PRESETS.map((p) => ({ key: `builtin:${p.name}`, name: p.name, patch: p })), ...userPresets.map((p, i) => ({ key: `user:${i}`, name: p.name, patch: p }))]
  const loadPreset = (key) => {
    const found = allPresets.find((p) => p.key === key)
    if (found) edit((p) => { Object.keys(p).forEach((k) => delete p[k]); Object.assign(p, JSON.parse(JSON.stringify(found.patch))) })
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
  const fxCount = node.data.chain?.length ?? 0

  return (
    <div
      className={`phyllo ${expanded ? 'expanded' : ''}`}
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
        <div className="ph-preset">
          <button type="button" className="ph-arrow" onClick={() => stepPreset(-1)} aria-label="Previous preset">‹</button>
          <input className="ph-name" value={patch.name} maxLength={40} aria-label="Patch name" onChange={(e) => edit((p) => { p.name = e.target.value })} />
          <select className="ph-preset-list" value="" aria-label="Presets" onChange={(e) => { if (e.target.value) loadPreset(e.target.value) }}>
            <option value="">▾</option>
            <optgroup label="presets">{allPresets.filter((p) => p.key.startsWith('builtin')).map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</optgroup>
            {userPresets.length > 0 && <optgroup label="saved in this browser">{allPresets.filter((p) => p.key.startsWith('user')).map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</optgroup>}
          </select>
          <button type="button" className="ph-arrow" onClick={() => stepPreset(1)} aria-label="Next preset">›</button>
        </div>
        <button type="button" className="ph-link" onClick={savePreset} title="Keep this patch in this browser's presets">save</button>
        <span className="spacer" />
        <div className="ph-volume"><ModKnob ui={ui} target="volume" def={K.volume} value={patch.volume} onChange={(v) => edit((p) => { p.volume = v })} /></div>
        <button type="button" className="ph-link" onClick={() => setExpanded((v) => !v)} aria-pressed={expanded}>{expanded ? 'shrink' : 'expand'}</button>
        <button type="button" className="ph-close" onClick={onClose} aria-label="Close">×</button>
      </div>

      <div className="ph-body">
        <Section
          title="oscillators"
          className="ph-oscs"
          aside={patch.layers.length < MAX_LAYERS && (
            <button type="button" className="ph-link" onClick={() => edit((p) => { if (p.layers.length < MAX_LAYERS) p.layers.push(makeLayer('analog', { wave: 'sawtooth' })) })}>+ layer</button>
          )}
        >
          <div className="ph-layers">
            {patch.layers.map((l, i) => (
              <LayerStrip key={l.id} ui={ui} layer={l} index={i} open={openLayer === l.id} onToggle={() => setOpenLayer((o) => (o === l.id ? null : l.id))} />
            ))}
          </div>
        </Section>
        <Filter ui={ui} />
        <div className="ph-row">
          <Envelope ui={ui} which="amp" />
          <Envelope ui={ui} which="env" />
          <Lfo ui={ui} index={0} />
          <Lfo ui={ui} index={1} />
        </div>
        <section className={`ph-card ph-fx ${fxOpen ? 'open' : ''}`} aria-label="Effects">
          <header className="ph-card-head">
            <button type="button" className="ph-fold" aria-expanded={fxOpen} onClick={() => setFxOpen((v) => !v)}>
              <h3>effects</h3><span className="ph-count">{fxCount ? `${fxCount} on this synth` : 'none yet'}</span><span aria-hidden>{fxOpen ? '▴' : '▾'}</span>
            </button>
          </header>
          {fxOpen && <div className="ph-fx-body">{fx}</div>}
        </section>
      </div>

      <Keys patch={patch} cps={cps} base={base} setBase={setBase} />
    </div>
  )
}

/** What a phyllo node shows on the patch: a glance at the sound and the knobs you reach for most. */
export function PhylloFace({ node, onEdit, onOpen }) {
  const patch = useMemo(() => normalizePatch(node.data.patch), [node.data.patch])
  const lead = patch.layers.find((l) => l.on) ?? patch.layers[0]
  const f = patch.filter
  const soundName = (l) => SOUND_GROUPS.flatMap(([, items]) => items).find(([k]) => k === soundOf(l))?.[1] ?? l.type
  return (
    <div className="ph-face">
      <div className="ph-face-top">
        <LayerScope layer={lead} />
        <div className="ph-face-info">
          <strong>{patch.name}</strong>
          <span>{patch.layers.map((l, i) => `${letter(i)} ${soundName(l)}`).join(' · ')}</span>
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
