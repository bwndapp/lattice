import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * A button that opens a small panel under itself (kept on screen). A click outside, Esc,
 * or `close()` from the panel's content closes it. `children` is a function of `close`.
 */
export default function Popover({ label, title, className = '', panelClassName = '', align = 'right', children }) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef(null)
  const panelRef = useRef(null)
  const [pos, setPos] = useState(null)
  const close = () => setOpen(false)

  useLayoutEffect(() => {
    if (!open) return
    const b = buttonRef.current.getBoundingClientRect()
    const w = panelRef.current?.offsetWidth ?? 300
    const left = align === 'right' ? b.right - w : b.left
    setPos({ top: b.bottom + 6, left: Math.max(8, Math.min(left, window.innerWidth - w - 8)) })
  }, [open, align])

  useEffect(() => {
    if (!open) return
    const away = (e) => { if (!panelRef.current?.contains(e.target) && !buttonRef.current?.contains(e.target)) close() }
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); buttonRef.current?.focus() } }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', onKey, true) }
  }, [open])

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`btn ${className} ${open ? 'on' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={title}
        onClick={() => setOpen((v) => !v)}
      >{label}</button>
      {open && (
        <div ref={panelRef} className={`popover ${panelClassName}`} role="dialog" aria-label={title} style={pos ?? { visibility: 'hidden' }}>
          {children(close)}
        </div>
      )}
    </>
  )
}
