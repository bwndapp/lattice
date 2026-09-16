import { useEffect, useRef, useState } from 'react'
import PianoRoll from './PianoRoll.jsx'
import { exactStepAt } from './Rack.jsx'
import { previewInPatch } from './audio'
import { midiToNote } from './project'
import './RollDock.css'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const HEIGHT_KEY = 'strudel:roll:dock-height'
const mod = (a, n) => ((a % n) + n) % n

function readHeight() {
  try { return clamp(Number(localStorage.getItem(HEIGHT_KEY)) || 360, 160, 900) } catch { return 360 }
}

/**
 * The piano roll along the bottom of the app: which instrument it shows is a tab in its
 * header, the canvas above shrinks to make room, and its top edge drags to resize.
 */
export default function RollDock({ project, at, transport, onUpdateProject, onPick, onClose }) {
  const [height, setHeight] = useState(readHeight)
  const dragRef = useRef(null)
  const pattern = project.patterns.find((p) => p.id === at.patternId)
  const synths = pattern?.channels.filter((c) => c.kind === 'synth') ?? []
  const channel = synths.find((c) => c.id === at.channelId) ?? synths[0]

  useEffect(() => { try { localStorage.setItem(HEIGHT_KEY, String(Math.round(height))) } catch { /* storage unavailable */ } }, [height])
  // the instrument (or its pattern) went away
  useEffect(() => { if (!channel) onClose() }, [channel, onClose])

  const cursorRef = useRef(() => -1)
  cursorRef.current = () => (pattern ? exactStepAt(project, pattern, transport.position()) : -1)

  if (!pattern || !channel) return null

  const startResize = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { y: e.clientY, height }
  }
  const onResize = (e) => {
    const d = dragRef.current
    if (!d) return
    setHeight(clamp(d.height + (d.y - e.clientY), 160, window.innerHeight - 160))
  }

  const update = (fn) => onUpdateProject((p) => {
    const pat = p.patterns.find((x) => x.id === pattern.id)
    const ch = pat?.channels.find((c) => c.id === channel.id)
    if (ch) fn(ch, pat)
  })

  return (
    <section
      className="roll-dock"
      style={{ height }}
      aria-label={`Piano roll: ${channel.name}`}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }} // the roll keeps Esc while notes are selected
    >
      <div
        className="rd-grip"
        onPointerDown={startResize}
        onPointerMove={onResize}
        onPointerUp={() => { dragRef.current = null }}
        onPointerCancel={() => { dragRef.current = null }}
        onDoubleClick={() => setHeight(360)}
        title="Drag to resize · double-click for the usual height"
        aria-hidden
      />
      <div className="rd-head">
        <span className="rd-what">
          <span className="rd-pattern">{pattern.name}</span>
          <span className="rd-note">piano roll</span>
        </span>
        {synths.length > 1 && (
          <span className="rd-tabs" role="tablist" aria-label="Instrument">
            {synths.map((c) => (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={c.id === channel.id}
                className={`rd-tab ${c.id === channel.id ? 'on' : ''}`}
                onClick={() => onPick(c.id)}
              >{c.name}</button>
            ))}
          </span>
        )}
        <span className="rd-spacer" />
        <button type="button" className="node-btn" onClick={onClose} title="Close the piano roll (Esc)">close</button>
      </div>
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
        onChangeNotes={(notes) => update((ch) => { ch.notes = notes; if (notes.length) ch.note = midiToNote(notes[notes.length - 1].n) })}
      />
    </section>
  )
}
