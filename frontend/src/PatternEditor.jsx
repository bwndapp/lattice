import { useEffect, useRef, useState } from 'react'
import { reshapePattern } from './project'
import { PatternChannels } from './Rack.jsx'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** A text field that applies on Enter or blur. */
export function NameInput({ value, onCommit, ...props }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const commit = () => { const v = text.trim(); if (v && v !== value) onCommit(v); else setText(value) }
  return (
    <input
      {...props}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setText(value); e.currentTarget.blur() } }}
    />
  )
}

/** A floating editor for one pattern: name, length, instruments with their steps and notes. */
export default function PatternEditor({ project, patternId, anchor, transport, started, onUpdateProject, onOpenRack, onClose }) {
  const ref = useRef(null)
  const pattern = project.patterns.find((p) => p.id === patternId)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !e.target.closest?.('input, select, textarea')) onClose() }
    const onDown = (e) => {
      if (ref.current?.contains(e.target)) return
      if (e.target.closest?.('.sound-picker, .palette')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pointerdown', onDown) }
  }, [onClose])

  const [pos, setPos] = useState({ left: anchor.x, top: anchor.y })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setPos({
      left: clamp(anchor.x - 40, 12, window.innerWidth - el.offsetWidth - 12),
      top: clamp(anchor.y + 16, 12, window.innerHeight - el.offsetHeight - 12),
    })
  }, [anchor.x, anchor.y, pattern?.channels.length])

  if (!pattern) return null
  const update = (fn) => onUpdateProject((p) => { const pat = p.patterns.find((x) => x.id === patternId); if (pat) fn(pat) })
  const uses = project.nodes.filter((n) => n.type === 'pattern' && n.data.patternId === patternId).length

  return (
    <div className="pattern-pop" ref={ref} role="dialog" aria-label={`Edit ${pattern.name}`} style={{ left: pos.left, top: pos.top }}>
      <div className="pop-head">
        <NameInput className="pop-name" value={pattern.name} maxLength={40} aria-label="Pattern name" onCommit={(v) => update((pat) => { pat.name = v })} />
        <label className="rack-field">
          <span className="syn">bars</span>
          <select className="select" value={pattern.bars} onChange={(e) => update((pat) => reshapePattern(pat, { bars: Number(e.target.value) }))} aria-label="Bars in this pattern">
            {[1, 2, 3, 4, 6, 8, 12, 16].map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        {uses > 1 && <span className="pop-uses" title="Every node using this pattern changes with it">used by {uses} nodes</span>}
        <span className="spacer" />
        <button className="btn" onClick={onOpenRack}>open in rack</button>
        <button className="btn ghost" onClick={onClose} aria-label="Close">close</button>
      </div>
      <PatternChannels
        project={project}
        pattern={pattern}
        onUpdateProject={onUpdateProject}
        transport={transport}
        started={started}
        playMode="pattern"
        compact
      />
    </div>
  )
}
