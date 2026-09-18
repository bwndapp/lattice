import { useEffect, useRef, useState } from 'react'
import PianoRoll from './PianoRoll.jsx'
import { PatternChannels, exactStepAt } from './Rack.jsx'
import { NameInput } from './NameInput.jsx'
import { previewInPatch } from './audio'
import { STEPS_PER_BAR, midiToNote, reshapePattern, stepDivision } from './project'
import { OCTAVE_KEY } from './keyboard.js'
import { useTypingKeys } from './typingKeys.js'
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
export default function DetailDock({ project, at, transport, started, height, onUpdateProject, onHeight, onPick, onTab, onClose }) {
  const dragRef = useRef(null)
  const pattern = project.patterns.find((p) => p.id === at.patternId)
  const synths = pattern?.channels.filter((c) => c.kind === 'synth') ?? []
  const channel = synths.find((c) => c.id === at.channelId) ?? synths[0]
  const tab = at.tab === 'notes' && channel ? 'notes' : 'rack'

  useEffect(() => { try { localStorage.setItem(HEIGHT_KEY, String(Math.round(height))) } catch { /* storage unavailable */ } }, [height])
  useEffect(() => { if (!pattern) onClose() }, [pattern, onClose])

  // the computer keyboard as a piano: on or off, and which octave it starts from
  const [keysOn, setKeysOn] = useState(() => readPref(KEYS_KEY, true))
  const [octave, setOctave] = useState(() => readPref(OCTAVE_KEY, 4))
  const shiftOctave = (to) => { const next = clamp(to, 0, 8); setOctave(next); writePref(OCTAVE_KEY, next) }
  useEffect(() => writePref(KEYS_KEY, keysOn), [keysOn])

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
          fill
          onSeek={(bars, { fine } = {}) => {
            // the pattern repeats, so land in the repetition that's playing now
            const local = mod(fine ? bars : Math.round(bars * pattern.stepsPerBar) / pattern.stepsPerBar, pattern.bars)
            const now = transport.position()
            transport.seek(Math.max(0, Math.floor(now / pattern.bars) * pattern.bars + local))
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
