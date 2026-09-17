import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Knob from '../Knob.jsx'
import { engineTarget } from '../automation.js'
import { holdInPatch, previewInPatch } from '../audio'
import { ENGINES, engineData } from './index.js'
import { closeSynth, raiseSynth } from './windows.js'
import { watchInstrument } from './host.js'
import { keyNote, readOctave, writeOctave } from '../keyboard.js'
import KickPanel from './KickPanel.jsx'
import PhylloPanel from './phyllo/PhylloPanel.jsx'
import './SynthWindow.css'

/** Engines with a face of their own; the rest get their knobs in groups. */
const PANELS = { kick: KickPanel, phyllo: PhylloPanel }

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const POS_KEY = 'lattice:synth-window'
const places = new Map() // instrument id → where its window was, for when it opens again
const readPlace = () => { try { return JSON.parse(localStorage.getItem(POS_KEY)) } catch { return null } }
const writePlace = (p) => { try { localStorage.setItem(POS_KEY, JSON.stringify(p)) } catch { /* storage unavailable */ } }

/**
 * An instrument engine's window: a plugin window that floats over the app. Drag it by its
 * title bar; it stays open while you work elsewhere, and the one you touched last is in
 * front. Knobs change the instrument as they turn, and right-click automates them.
 */
export default function SynthWindow({ project, patternId, channelId, order, front, onUpdateProject }) {
  const ref = useRef(null)
  const drag = useRef(null)
  const pattern = project.patterns.find((p) => p.id === patternId)
  const ch = pattern?.channels.find((c) => c.id === channelId)
  const spec = ch?.engine && ENGINES[ch.engine.type]
  const close = () => closeSynth(channelId)

  // where it opens: where it was, else where the last window was left, stepped down a little
  const [pos, setPos] = useState(() => {
    if (places.has(channelId)) return places.get(channelId)
    const last = readPlace() ?? { x: Math.max(16, window.innerWidth / 2 - 380), y: 90 }
    return { x: last.x + order * 28, y: last.y + order * 28 }
  })
  // always reachable: the title bar stays on screen
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => setPos((p) => {
      const next = { x: clamp(p.x, 8 - el.offsetWidth + 120, window.innerWidth - 120), y: clamp(p.y, 8, window.innerHeight - 48) }
      return next.x === p.x && next.y === p.y ? p : next
    })
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])
  useEffect(() => { places.set(channelId, pos) }, [channelId, pos])

  useEffect(() => { ref.current?.focus({ preventScroll: true }) }, [])

  // while the window has focus, the computer keyboard plays the instrument (as in the piano roll)
  // (an engine with a home octave, like the kick's, keeps its own)
  const octaveKey = spec?.keyOctave != null ? `lattice:synth-octave:${spec.type}` : undefined
  const [octave, setOctave] = useState(() => readOctave(octaveKey, spec?.keyOctave ?? 4))
  const shiftOctave = (by) => setOctave((o) => { const next = clamp(o + by, 0, 8); writeOctave(next, octaveKey); return next })
  const [lit, setLit] = useState(false) // a key is playing, for the header's light
  const down = useRef(new Map()) // key → let go of its note
  const letGo = (key) => {
    const release = down.current.get(key)
    if (release) { release(); down.current.delete(key) }
    if (!down.current.size) setLit(false)
  }
  const letGoAll = () => { for (const key of [...down.current.keys()]) letGo(key) }
  useEffect(() => () => { for (const release of down.current.values()) release() }, [])
  // the instrument went away (deleted, undone, another sound picked)
  useEffect(() => { if (!spec) closeSynth(channelId) }, [spec, channelId])
  if (!spec) return null

  const data = engineData(ch.engine)
  const edit = (fn) => onUpdateProject((p) => {
    const c = p.patterns.find((x) => x.id === patternId)?.channels.find((x) => x.id === channelId)
    if (c?.engine) fn(c)
  })
  const set = (key, value) => edit((c) => { c.engine = { ...c.engine, data: { ...c.engine.data, [key]: value } } })
  // settings with structure (layers, routes): `fn` changes a copy of them
  const change = (fn) => edit((c) => {
    const draft = JSON.parse(JSON.stringify(engineData(c.engine)))
    fn(draft)
    c.engine = { ...c.engine, data: draft }
  })
  const target = (key) => engineTarget(patternId, channelId, key)
  // what the instrument is doing right now (its processor's reports)
  const watch = (fn) => watchInstrument(channelId, spec.type, fn)
  const reset = () => edit((c) => { c.engine = { ...c.engine, data: {} } })
  const play = (note) => previewInPatch(project, patternId, ch, note == null ? {} : { note, pitched: true })
  // a note that lasts until `release()` (the on-screen keys and the computer keyboard)
  const hold = (note) => holdInPatch(project, patternId, ch, { note, pitched: true })
  const knob = (def) => (
    <Knob key={def.key} def={def} value={data[def.key]} onChange={(v) => set(def.key, v)} target={engineTarget(patternId, channelId, def.key)} />
  )
  const groups = spec.groups.map(([key, title]) => ({ key, title, params: spec.params.filter((p) => p.group === key) }))
  const Panel = PANELS[spec.type]

  const startDrag = (e) => {
    if (e.button !== 0 || e.target.closest('button, input, select')) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }
  }
  const moveDrag = (e) => {
    const d = drag.current
    if (!d) return
    const el = ref.current
    setPos({
      x: clamp(e.clientX - d.x, 8 - el.offsetWidth + 120, window.innerWidth - 120),
      y: clamp(e.clientY - d.y, 8, window.innerHeight - 48),
    })
  }
  const endDrag = () => {
    if (!drag.current) return
    drag.current = null
    writePlace(pos) // the next window opens where this one was left
  }

  return (
    <div
      ref={ref}
      className={`synth-window ${front ? 'front' : ''} ${spec.width ? 'wide' : ''}`}
      role="dialog"
      aria-labelledby={`sw-title-${channelId}`}
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y, zIndex: 50 + order, width: spec.width ? `min(${spec.width}px, calc(100vw - 32px))` : undefined }}
      onPointerDownCapture={() => raiseSynth(channelId)}
      onFocusCapture={() => raiseSynth(channelId)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.stopPropagation(); close(); return }
        // keys stay in here: Delete on a knob must not delete nodes behind the window
        e.stopPropagation()
        if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
        const hit = keyNote(e.key, octave)
        if (!hit) return
        e.preventDefault()
        if (hit.octave) return shiftOctave(hit.octave)
        if (e.repeat || down.current.has(e.code)) return
        down.current.set(e.code, hold(hit.note))
        setLit(true)
      }}
      onKeyUp={(e) => letGo(e.code)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) letGoAll() }}
    >
      <header
        className="sw-head"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(e) => { if (!e.target.closest('button')) setPos({ x: Math.max(16, window.innerWidth / 2 - (ref.current?.offsetWidth ?? 760) / 2), y: 90 }) }}
        title="Drag to move · double-click to centre"
      >
        <h2 id={`sw-title-${channelId}`} className="sw-title">{spec.label}</h2>
        <span className="sw-where">{ch.name} · {pattern.name}</span>
        <span className="sw-spacer" />
        <span className={`sw-keys ${lit ? 'lit' : ''}`} title={'Type to play it while this window has focus: z s x d c v g b h n j m , is one octave, q 2 w 3 e r 5 t 6 y 7 u the next · − and = change octave'}>
          <span className="sw-keys-led" aria-hidden />
          keys
          <button type="button" className="sw-oct" disabled={octave <= 0} onClick={() => shiftOctave(-1)} aria-label="An octave down">−</button>
          <span className="sw-oct-at">C{octave}</span>
          <button type="button" className="sw-oct" disabled={octave >= 8} onClick={() => shiftOctave(1)} aria-label="An octave up">+</button>
        </span>
        <button type="button" className="btn" onClick={() => play(null)} title="Play one hit">hear</button>
        <button type="button" className="btn ghost" onClick={reset} title="Every knob back to where it started">reset</button>
        <button type="button" className="sw-close" onClick={close} title="Close (Esc)" aria-label={`Close ${spec.label}`}>×</button>
      </header>
      <div className="sw-body">
        {Panel
          ? <Panel data={data} groups={groups} knob={knob} change={change} target={target} play={play} hold={hold} watch={watch} cps={(Number(project.bpm) || 120) / (Number(project.beats) || 4) / 60} />
          : (
            <div className="sw-groups">
              {groups.map((g) => (
                <section key={g.key} className="sw-group" aria-label={g.title}>
                  <h3 className="sw-group-title">{g.title}</h3>
                  <div className="sw-knobs">{g.params.map(knob)}</div>
                </section>
              ))}
            </div>
          )}
      </div>
    </div>
  )
}
