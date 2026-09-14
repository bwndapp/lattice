import { useEffect, useRef, useState } from 'react'
import { reshapePattern } from './project'
import { PatternChannels } from './Rack.jsx'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const SIZE_KEY = 'strudel:pattern-editor:size'

function readSize() {
  try {
    const s = JSON.parse(localStorage.getItem(SIZE_KEY))
    if (s && Number.isFinite(s.w) && Number.isFinite(s.h)) return s
  } catch { /* storage unavailable */ }
  return { w: 860, h: 560 }
}

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
export default function PatternEditor({ project, patternId, anchor, transport, started, onUpdateProject, onClose }) {
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

  // Size: drag the bottom-right corner (remembered). Position: drag the header. Expand fills the window.
  const [size, setSize] = useState(() => {
    const s = readSize()
    return { w: clamp(s.w, 520, window.innerWidth - 24), h: clamp(s.h, 260, window.innerHeight - 24) }
  })
  const [pos, setPos] = useState(() => ({
    left: clamp(anchor.x - 40, 12, Math.max(12, window.innerWidth - size.w - 12)),
    top: clamp(anchor.y + 16, 12, Math.max(12, window.innerHeight - size.h - 12)),
  }))
  const [expanded, setExpanded] = useState(false)
  const moveRef = useRef(null)

  useEffect(() => {
    const el = ref.current
    if (!el || expanded) return
    let timer
    const observer = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        // remember what the corner was dragged to, so expand → shrink and reopening come back to it
        const next = { w: Math.round(el.offsetWidth), h: Math.round(el.offsetHeight) }
        setSize((s) => (s.w === next.w && s.h === next.h ? s : next))
        try { localStorage.setItem(SIZE_KEY, JSON.stringify(next)) } catch { /* storage unavailable */ }
      }, 150)
    })
    observer.observe(el)
    return () => { observer.disconnect(); clearTimeout(timer) }
  }, [expanded])

  const startMove = (e) => {
    if (expanded || e.button !== 0 || e.target.closest('input, select, button, textarea')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    moveRef.current = { x: e.clientX, y: e.clientY, left: pos.left, top: pos.top }
  }
  const onMove = (e) => {
    const m = moveRef.current
    if (!m) return
    const el = ref.current
    setPos({
      left: clamp(m.left + e.clientX - m.x, 12 - el.offsetWidth + 120, window.innerWidth - 120),
      top: clamp(m.top + e.clientY - m.y, 0, window.innerHeight - 60),
    })
  }

  if (!pattern) return null
  const update = (fn) => onUpdateProject((p) => { const pat = p.patterns.find((x) => x.id === patternId); if (pat) fn(pat) })
  const uses = project.nodes.filter((n) => n.type === 'pattern' && n.data.patternId === patternId).length

  return (
    <div
      className={`pattern-pop ${expanded ? 'expanded' : ''}`}
      ref={ref}
      role="dialog"
      aria-label={`Edit ${pattern.name}`}
      style={expanded ? undefined : { left: pos.left, top: pos.top, width: size.w, height: size.h }}
    >
      <div
        className="pop-head"
        onPointerDown={startMove}
        onPointerMove={onMove}
        onPointerUp={() => { moveRef.current = null }}
        onPointerCancel={() => { moveRef.current = null }}
        title={expanded ? undefined : 'Drag to move · drag the bottom-right corner to resize'}
      >
        <NameInput className="pop-name" value={pattern.name} maxLength={40} aria-label="Pattern name" onCommit={(v) => update((pat) => { pat.name = v })} />
        <label className="rack-field">
          <span className="syn">bars</span>
          <select className="select" value={pattern.bars} onChange={(e) => update((pat) => reshapePattern(pat, { bars: Number(e.target.value) }))} aria-label="Bars in this pattern">
            {[1, 2, 3, 4, 6, 8, 12, 16].map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        <label className="rack-field">
          <span className="syn">steps / bar</span>
          <select className="select" value={pattern.stepsPerBar} onChange={(e) => update((pat) => reshapePattern(pat, { stepsPerBar: Number(e.target.value) }))} aria-label="Steps per bar">
            {[8, 12, 16, 24, 32].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        {uses > 1 && <span className="pop-uses" title="Every node using this pattern changes with it">used by {uses} nodes</span>}
        <span className="spacer" />
        <button className="btn" onClick={() => setExpanded((v) => !v)} aria-pressed={expanded} title={expanded ? 'Back to a floating window' : 'Fill the window'}>{expanded ? 'shrink' : 'expand'}</button>
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
