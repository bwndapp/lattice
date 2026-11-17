import { useEffect, useRef, useState } from 'react'
import PianoRoll from './PianoRoll.jsx'
import { PatternChannels, exactStepAt } from './Rack.jsx'
import { NameInput } from './NameInput.jsx'
import { previewInPatch } from './audio'
import { STEPS_PER_BAR, midiToNote, reshapePattern, stepDivision } from './project'
import { useOctave } from './keyboard.js'
import { useTypingKeys } from './typingKeys.js'
import Knob from './Knob.jsx'
import { formatValue } from './knobMath.js'
import { CHANNEL_FADER, NODE_TYPES, channelGain, inputKey, inputsOf } from './graph'
import { nodeTitle, originLabel } from './Graph.jsx'
import { songTimeFor } from './song.js'
import './DetailDock.css'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const HEIGHT_KEY = 'strudel:roll:dock-height'
const mod = (a, n) => ((a % n) + n) % n

const KEYS_KEY = 'strudel:roll:keys'
const readPref = (key, fallback) => { try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback } catch { return fallback } }
const writePref = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable */ } }

export function readDockHeight() {
  try { return clamp(Number(localStorage.getItem(HEIGHT_KEY)) || 360, 160, 900) } catch { return 360 }
}

/**
 * The detail view along the bottom of the app, as a DAW has one: the pattern you're working
 * on, with its instruments (rack) or one instrument's notes (piano roll). It stays open
 * while you work on the patch or the timeline, and its top edge drags to resize.
 */
export default function DetailDock(props) {
  return props.at?.busId ? <BusDock {...props} /> : <PatternDock {...props} />
}

/** The dock's top edge: drag to resize, double-click for the usual height. */
function Grip({ height, onHeight }) {
  const dragRef = useRef(null)
  return (
    <div
      className="dd-grip"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        dragRef.current = { y: e.clientY, height }
      }}
      onPointerMove={(e) => { const d = dragRef.current; if (d) onHeight(clamp(d.height + (d.y - e.clientY), 160, window.innerHeight - 200)) }}
      onPointerUp={() => { dragRef.current = null }}
      onPointerCancel={() => { dragRef.current = null }}
      onDoubleClick={() => onHeight(360)}
      title="Drag to resize · double-click for the usual height"
      aria-hidden
    />
  )
}

/*
 * A mixer fader: drag up and down (shift for fine), double-click for 0 dB, wheel to nudge.
 * Its travel is the square root of the gain, so 0 dB sits most of the way up, as on a desk.
 */
const FADER_MAX = 1.5
const faderPos = (g) => Math.sqrt(clamp(g, 0, FADER_MAX) / FADER_MAX)
const faderGain = (p) => clamp(p, 0, 1) ** 2 * FADER_MAX
function Fader({ value, onChange, label }) {
  const drag = useRef(null)
  const pos = faderPos(value)
  const set = (p) => onChange(Math.round(faderGain(p) * 1000) / 1000)
  return (
    <div
      className="fader"
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={FADER_MAX}
      aria-valuenow={value}
      aria-valuetext={formatValue(value, CHANNEL_FADER)}
      draggable={false}
      onDragStart={(e) => { e.preventDefault(); e.stopPropagation() }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        e.currentTarget.setPointerCapture(e.pointerId)
        const box = e.currentTarget.getBoundingClientRect()
        // grabbing the cap keeps it where it is; clicking the track jumps there
        const onCap = Math.abs((1 - pos) * box.height - (e.clientY - box.top)) < 12
        const start = onCap ? pos : 1 - (e.clientY - box.top) / box.height
        if (!onCap) set(start)
        drag.current = { y: e.clientY, pos: start, h: box.height }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        set(clamp(d.pos - ((e.clientY - d.y) / d.h) * (e.shiftKey ? 0.2 : 1), 0, 1))
      }}
      onPointerUp={() => { drag.current = null }}
      onPointerCancel={() => { drag.current = null }}
      onDoubleClick={() => onChange(1)}
      onWheel={(e) => { set(clamp(pos - Math.sign(e.deltaY) * (e.shiftKey ? 0.005 : 0.02), 0, 1)) }}
      onKeyDown={(e) => {
        const by = { ArrowUp: 0.02, ArrowDown: -0.02, PageUp: 0.1, PageDown: -0.1 }[e.key]
        if (by) { e.preventDefault(); set(clamp(pos + by, 0, 1)) }
      }}
      title={`${label} · drag (shift: fine) · double-click for 0 dB`}
    >
      <span className="fader-track" />
      <span className="fader-unity" style={{ bottom: `${faderPos(1) * 100}%` }} />
      <span className="fader-cap" style={{ bottom: `${pos * 100}%` }} />
    </div>
  )
}

/** A stereo meter, driven by flow.js through `data-meter` (the wire it reads). */
const Meter = ({ wire }) => (
  <span className="strip-meter" data-meter={wire ?? undefined} aria-hidden><i /><i /></span>
)

/**
 * A mixer bus along the bottom: a strip a channel, each with its level, in the order they
 * come into the bus. Drag a strip (or use its arrows) to reorder: the wires swap slots, the
 * sound and each channel's level stay as they were.
 */
function BusDock({ project, at, height, onUpdateProject, onHeight, onClose }) {
  const bus = project.nodes.find((n) => n.id === at.busId && n.type === 'bus')
  useEffect(() => { if (!bus) onClose() }, [bus, onClose])
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      if (e.target.closest?.('input:not([type=range]), textarea, select, [contenteditable="true"], dialog, .popover, .knob-menu, .synth-window')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const [dragging, setDragging] = useState(null) // the wire id being dragged
  const [over, setOver] = useState(null) // the index it would land at
  if (!bus) return null
  const wires = inputsOf(project.edges, bus.id)
  const spec = NODE_TYPES.bus
  const editBus = (fn) => onUpdateProject((p) => { const n = p.nodes.find((x) => x.id === bus.id); if (n) fn(n.data) })
  // reorder: the bus's wires take slots in-0, in-1… in the new order
  const move = (from, to) => {
    if (from === to || to < 0 || to >= wires.length) return
    const order = wires.map((w) => w.id)
    const [it] = order.splice(from, 1)
    order.splice(to, 0, it)
    onUpdateProject((p) => {
      for (const e of p.edges) {
        const i = order.indexOf(e.id)
        if (e.target === bus.id && i >= 0) e.targetHandle = `in-${i}`
      }
    })
  }
  const busParam = (key) => spec.params.find((p) => p.key === key)
  return (
    <section data-surface="dock" className="detail-dock" style={{ height }} aria-label={`${bus.data?.name || 'bus'}: channels`}>
      <Grip height={height} onHeight={onHeight} />
      <div className="dd-head">
        <NameInput className="dd-name" value={bus.data?.name || 'bus'} maxLength={40} aria-label="Bus name" onCommit={(v) => editBus((d) => { d.name = v || 'bus' })} />
        <span className="dd-uses">mixer bus · {wires.length} channel{wires.length === 1 ? '' : 's'}</span>
        <span className="dd-spacer" />
        <button type="button" className="node-btn" onClick={onClose} title="Close (Esc)">close</button>
      </div>
      <div className="bus-strips" onDragOver={(e) => e.preventDefault()}>
        {wires.map((w, i) => {
          const src = project.nodes.find((n) => n.id === w.source)
          const origin = originLabel(project, w)
          const last = nodeTitle(src, project, w.sourceHandle)
          const via = last === origin ? null : last
          const key = inputKey(w)
          const level = channelGain(bus.data, key)
          return (
            <div
              key={w.id}
              className={`bus-strip ${dragging === w.id ? 'dragging' : ''} ${over === i && dragging && dragging !== w.id ? 'over' : ''}`}
              draggable
              onDragStart={(e) => { setDragging(w.id); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', w.id) } catch { /* fine */ } }}
              onDragEnter={() => setOver(i)}
              onDragOver={(e) => { e.preventDefault(); if (over !== i) setOver(i) }}
              onDrop={(e) => { e.preventDefault(); const from = wires.findIndex((x) => x.id === dragging); if (from >= 0) move(from, i); setDragging(null); setOver(null) }}
              onDragEnd={() => { setDragging(null); setOver(null) }}
              title="Drag to reorder"
            >
              <span className="bus-strip-num">{i + 1}</span>
              <span className="bus-strip-name" title={via ? `${origin} via ${via}` : origin}>
                {origin}
                {via && <em> via {via}</em>}
              </span>
              <span className="bus-strip-read">{formatValue(level, CHANNEL_FADER)}</span>
              <span className="bus-strip-desk">
                <Fader label={`${origin} level`} value={level} onChange={(v) => editBus((d) => { d.chan = { ...(d.chan ?? {}), [key]: v } })} />
                <Meter wire={w.id} />
              </span>
              <span className="bus-strip-move">
                <button type="button" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={`Move ${origin} left`} title="Move left">‹</button>
                <button type="button" disabled={i === wires.length - 1} onClick={() => move(i, i + 1)} aria-label={`Move ${origin} right`} title="Move right">›</button>
              </span>
            </div>
          )
        })}
        {!wires.length && <p className="bus-empty">Nothing wired into this bus yet.</p>}
        {/* the bus itself: level and pan on everything together */}
        <div className="bus-strip master">
          <span className="bus-strip-num">bus</span>
          <span className="bus-strip-name">{bus.data?.name || 'bus'}</span>
          <span className="bus-strip-read">{formatValue(bus.data?.vol ?? 1, busParam('vol'))}</span>
          <span className="bus-strip-desk">
            <Fader label={`${bus.data?.name || 'bus'} volume`} value={bus.data?.vol ?? 1} onChange={(v) => editBus((d) => { d.vol = v })} />
            {/* what leaves the bus: any wire out of it carries the same */}
            <Meter wire={project.edges.find((e) => e.source === bus.id)?.id} />
          </span>
          <span className="bus-strip-knob">
            <Knob def={busParam('pan')} value={bus.data?.pan ?? 0.5} onChange={(v) => editBus((d) => { d.pan = v })} target={`n:${bus.id}:pan`} />
          </span>
        </div>
      </div>
    </section>
  )
}

function PatternDock({ project, at, transport, started, height, onUpdateProject, onHeight, onPick, onTab, onClose }) {
  const dragRef = useRef(null)
  const pattern = project.patterns.find((p) => p.id === at.patternId)
  const synths = pattern?.channels.filter((c) => c.kind === 'synth') ?? []
  const channel = synths.find((c) => c.id === at.channelId) ?? synths[0]
  const tab = at.tab === 'notes' && channel ? 'notes' : 'rack'

  useEffect(() => { try { localStorage.setItem(HEIGHT_KEY, String(Math.round(height))) } catch { /* storage unavailable */ } }, [height])
  useEffect(() => { if (!pattern) onClose() }, [pattern, onClose])

  // the computer keyboard as a piano: on or off, and which octave it starts from
  const [keysOn, setKeysOn] = useState(() => readPref(KEYS_KEY, true))
  const [octave, shiftOctave] = useOctave() // shared with the patch and with instrument windows
  useEffect(() => writePref(KEYS_KEY, keysOn), [keysOn])

  const [held, setHeld] = useState(() => new Set()) // MIDI notes typed and still down, lit on the roll

  const cursorRef = useRef(() => -1)
  cursorRef.current = () => (pattern ? exactStepAt(project, pattern, transport.position()) : -1)

  // While the notes tab is open with keys on, typing plays the instrument wherever you are
  // in the app — no need to click into the roll first. Text fields keep their letters.
  useTypingKeys({
    enabled: tab === 'notes' && keysOn,
    project,
    pattern,
    channel,
    octave,
    onOctave: shiftOctave,
    onHeld: setHeld,
  })

  // Esc closes the dock wherever you are, as long as nothing in front of it used the key
  // first: a menu, a dialog, a text field, or the roll clearing its selection.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      if (e.target.closest?.('input:not([type=range]), textarea, select, [contenteditable="true"], dialog, .popover, .knob-menu, .synth-window')) return
      if (document.querySelector('dialog:modal')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!pattern) return null

  const startResize = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { y: e.clientY, height }
  }
  const onResize = (e) => {
    const d = dragRef.current
    if (!d) return
    onHeight(clamp(d.height + (d.y - e.clientY), 160, window.innerHeight - 200))
  }

  const editPattern = (fn) => onUpdateProject((p) => { const pat = p.patterns.find((x) => x.id === pattern.id); if (pat) fn(pat) })
  const uses = project.nodes.filter((n) => n.type === 'pattern' && n.data.patternId === pattern.id).length

  return (
    <section
      data-surface="dock"
      className="detail-dock"
      style={{ height }}
      aria-label={`${pattern.name}: ${tab === 'notes' ? 'piano roll' : 'instruments'}`}
    >
      <div
        className="dd-grip"
        onPointerDown={startResize}
        onPointerMove={onResize}
        onPointerUp={() => { dragRef.current = null }}
        onPointerCancel={() => { dragRef.current = null }}
        onDoubleClick={() => onHeight(360)}
        title="Drag to resize · double-click for the usual height"
        aria-hidden
      />
      <div className="dd-head">
        <NameInput className="dd-name" value={pattern.name} maxLength={40} aria-label="Pattern name" onCommit={(v) => editPattern((pat) => { pat.name = v })} />
        <span className="dd-tabs" role="tablist" aria-label="Show">
          <button type="button" role="tab" aria-selected={tab === 'rack'} className={`dd-tab ${tab === 'rack' ? 'on' : ''}`} onClick={() => onTab('rack')}>rack</button>
          <button type="button" role="tab" aria-selected={tab === 'notes'} className={`dd-tab ${tab === 'notes' ? 'on' : ''}`} disabled={!channel} onClick={() => onTab('notes')} title={channel ? 'The notes of one instrument' : 'Add a synth to write notes'}>notes</button>
        </span>

        {tab === 'notes' && (
          <span className="dd-keys" role="group" aria-label="Play from the keyboard">
            <button
              type="button"
              className={`dd-keys-on ${keysOn ? 'on' : ''}`}
              aria-pressed={keysOn}
              onClick={() => setKeysOn((v) => !v)}
              title={'Play this instrument by typing, wherever you are in the app: z s x d c v g b h n j m , is one octave, q 2 w 3 e r 5 t 6 y 7 u the next. While it\'s on, those letters play notes instead of being shortcuts.'}
            >keys</button>
            <button type="button" className="dd-oct" disabled={!keysOn || octave <= 0} onClick={() => shiftOctave(octave - 1)} title="An octave down (− or [)" aria-label="An octave down">−</button>
            <span className={`dd-oct-at ${keysOn ? '' : 'off'}`} title="The octave z and q play">C{octave}–C{Math.min(8, octave + 2)}</span>
            <button type="button" className="dd-oct" disabled={!keysOn || octave >= 8} onClick={() => shiftOctave(octave + 1)} title="An octave up (= or ])" aria-label="An octave up">+</button>
          </span>
        )}
        {tab === 'notes' && synths.length > 1 && (
          <span className="dd-tabs instruments" role="tablist" aria-label="Instrument">
            {synths.map((c) => (
              <button key={c.id} type="button" role="tab" aria-selected={c.id === channel.id} className={`dd-tab ${c.id === channel.id ? 'on' : ''}`} onClick={() => onPick(c.id)}>{c.name}</button>
            ))}
          </span>
        )}
        {/* how long the pattern is belongs to both tabs */}
        <label className="dd-field">
          <span>bars</span>
          <select className="select" value={pattern.bars} onChange={(e) => editPattern((pat) => reshapePattern(pat, { bars: Number(e.target.value) }))} aria-label="Bars in this pattern">
            {[1, 2, 3, 4, 6, 8, 12, 16].map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        <label className="dd-field">
          <span>steps / bar</span>
          <select className="select" value={pattern.stepsPerBar} onChange={(e) => editPattern((pat) => reshapePattern(pat, { stepsPerBar: Number(e.target.value) }))} aria-label="Steps per bar">
            {STEPS_PER_BAR.map((n) => {
              const div = stepDivision(n, project.beats)
              return <option key={n} value={n}>{div ? `${n} · ${div}` : n}</option>
            })}
          </select>
        </label>
        {uses > 1 && tab === 'rack' && <span className="dd-uses" title="Every node playing this pattern changes with it">in {uses} nodes</span>}
        <span className="dd-spacer" />
        <button type="button" className="node-btn" onClick={onClose} title="Close (Esc)">close</button>
      </div>

      {tab === 'notes' && channel ? (
        <PianoRoll
          key={`${pattern.id}:${channel.id}`}
          channel={channel}
          pattern={pattern}
          beats={project.beats}
          cursorRef={cursorRef}
          held={held}
          fill
          onSeek={(bars, { fine } = {}) => {
            // the pattern repeats, so land in the repetition that's playing now
            const local = mod(fine ? bars : Math.round(bars * pattern.stepsPerBar) / pattern.stepsPerBar, pattern.bars)
            // in the clip that's playing, on the timeline (song.js): where you clicked in it
            transport.seek(Math.max(0, songTimeFor(project, pattern.id, local, transport.position(), pattern.bars)))
          }}
          onPreview={(midi) => previewInPatch(project, pattern.id, channel, { note: midi })}
          onChangeNotes={(notes) => onUpdateProject((p) => {
            const ch = p.patterns.find((x) => x.id === pattern.id)?.channels.find((c) => c.id === channel.id)
            if (!ch) return
            ch.notes = notes
            if (notes.length) ch.note = midiToNote(notes[notes.length - 1].n)
          })}
        />
      ) : (
        <PatternChannels
          project={project}
          pattern={pattern}
          onUpdateProject={onUpdateProject}
          transport={transport}
          started={started}
          playMode="pattern"
          compact
        />
      )}
    </section>
  )
}
