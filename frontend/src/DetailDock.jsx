import { useEffect, useRef } from 'react'
import PianoRoll from './PianoRoll.jsx'
import { PatternChannels, exactStepAt } from './Rack.jsx'
import { NameInput } from './NameInput.jsx'
import { previewInPatch } from './audio'
import { midiToNote, reshapePattern } from './project'
import './DetailDock.css'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const HEIGHT_KEY = 'strudel:roll:dock-height'
const mod = (a, n) => ((a % n) + n) % n

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

  const cursorRef = useRef(() => -1)
  cursorRef.current = () => (pattern ? exactStepAt(project, pattern, transport.position()) : -1)

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
      className="detail-dock"
      style={{ height }}
      aria-label={`${pattern.name}: ${tab === 'notes' ? 'piano roll' : 'instruments'}`}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }} // the roll keeps Esc while notes are selected
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

        {tab === 'notes' && synths.length > 1 && (
          <span className="dd-tabs instruments" role="tablist" aria-label="Instrument">
            {synths.map((c) => (
              <button key={c.id} type="button" role="tab" aria-selected={c.id === channel.id} className={`dd-tab ${c.id === channel.id ? 'on' : ''}`} onClick={() => onPick(c.id)}>{c.name}</button>
            ))}
          </span>
        )}
        {tab === 'rack' && (
          <>
            <label className="dd-field">
              <span>bars</span>
              <select className="select" value={pattern.bars} onChange={(e) => editPattern((pat) => reshapePattern(pat, { bars: Number(e.target.value) }))} aria-label="Bars in this pattern">
                {[1, 2, 3, 4, 6, 8, 12, 16].map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>
            <label className="dd-field">
              <span>steps / bar</span>
              <select className="select" value={pattern.stepsPerBar} onChange={(e) => editPattern((pat) => reshapePattern(pat, { stepsPerBar: Number(e.target.value) }))} aria-label="Steps per bar">
                {[8, 12, 16, 24, 32].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            {uses > 1 && <span className="dd-uses" title="Every node playing this pattern changes with it">in {uses} nodes</span>}
          </>
        )}
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
