import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// ── right-click menu on a knob ────────────────────────────────────────────────
/** A small menu at the pointer. `items` are [label, action, { danger }]; null draws a line. */
export function KnobMenu({ x, y, title, items, onClose }) {
  const ref = useRef(null)
  const [pos, setPos] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setPos({ left: clamp(x, 8, window.innerWidth - el.offsetWidth - 8), top: clamp(y, 8, window.innerHeight - el.offsetHeight - 8) })
  }, [x, y])
  useEffect(() => {
    const away = (e) => { if (!ref.current?.contains(e.target)) onClose() }
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    // after this press: the right-click that opened the menu mustn't close it
    const timer = setTimeout(() => {
      window.addEventListener('pointerdown', away, true)
      window.addEventListener('contextmenu', away, true)
    }, 0)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onClose)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('contextmenu', away, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])
  useEffect(() => { ref.current?.querySelector('button')?.focus() }, [])
  // on the page itself: inside a canvas node, `position: fixed` would follow the node's zoom
  return createPortal(
    <div className="knob-menu" ref={ref} role="menu" aria-label={title} style={pos} onContextMenu={(e) => e.preventDefault()}>
      <div className="knob-menu-title">{title}</div>
      {items.map((item, i) => (item ? (
        <button
          key={item[0]}
          type="button"
          role="menuitem"
          className={`knob-menu-item ${item[2]?.danger ? 'danger' : ''} ${item[2]?.accent ? 'accent' : ''}`}
          onClick={() => { onClose(); item[1]() }}
        >{item[0]}</button>
      ) : <hr key={`line${i}`} className="knob-menu-line" />))}
    </div>,
    // a modal window makes everything outside it inert: the menu goes inside
    document.querySelector('dialog:modal') ?? document.body,
  )
}

