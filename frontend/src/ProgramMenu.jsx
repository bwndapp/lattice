import { useEffect, useRef, useState } from 'react'
import './ProgramMenu.css'

/**
 * The one menu, like a desktop program's: a list of menus (file, edit, view, …), each
 * opening its items to the side. Hover or click a menu to open it; arrow keys move, Enter
 * picks, Esc closes. On a phone the items open underneath instead.
 *
 *   menus: [{ label, items: [item | 'line' | { heading } | { custom: node }] }]
 *   item:  { label, shortcut?, onSelect, disabled?, danger?, checked?, hint? }
 */
/** Items that are there (false = hidden), without separators at the ends or twice in a row. */
function tidy(items) {
  const out = []
  for (const item of items) {
    if (!item) continue
    if (item === 'line' && (!out.length || out.at(-1) === 'line')) continue
    out.push(item)
  }
  while (out.at(-1) === 'line') out.pop()
  return out
}

export default function ProgramMenu({ menus, close, header = null }) {
  const [open, setOpen] = useState(null) // index of the menu showing its items
  const listRef = useRef(null)
  const hoverTimer = useRef(null)

  // the keyboard lands in the menu, so the arrows move through it
  useEffect(() => {
    const raf = requestAnimationFrame(() => listRef.current?.querySelector('.pm-menu')?.focus())
    return () => cancelAnimationFrame(raf)
  }, [])
  useEffect(() => () => clearTimeout(hoverTimer.current), [])

  const focusables = (root) => [...(root?.querySelectorAll('button:not(:disabled), input, select') ?? [])]
  const onKeyDown = (e) => {
    const inSub = e.target.closest('.pm-sub')
    if (e.target.matches('input, select') && !['Escape', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const root = inSub ?? listRef.current
      const items = inSub ? focusables(inSub) : [...listRef.current.querySelectorAll(':scope > .pm-list > li > .pm-menu')]
      const at = items.indexOf(document.activeElement)
      items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
      if (!inSub && root) setOpen(null)
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !inSub && e.target.classList.contains('pm-menu')) {
      e.preventDefault()
      const i = Number(e.target.dataset.index)
      setOpen(i)
      requestAnimationFrame(() => focusables(listRef.current?.querySelector(`.pm-sub[data-index="${i}"]`))[0]?.focus())
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && inSub && !e.target.matches('input, select')) {
      e.preventDefault()
      const i = Number(inSub.dataset.index)
      setOpen(null)
      listRef.current?.querySelector(`.pm-menu[data-index="${i}"]`)?.focus()
    }
  }

  return (
    <div className="pm" ref={listRef} role="menubar" aria-orientation="vertical" onKeyDown={onKeyDown}>
      {header}
      <ul className="pm-list">
        {menus.map((menu, i) => (
          <li
            key={menu.label}
            className={`pm-entry ${open === i ? 'open' : ''}`}
            onPointerEnter={(e) => {
              if (e.pointerType !== 'mouse') return
              clearTimeout(hoverTimer.current)
              hoverTimer.current = setTimeout(() => setOpen(i), open === null ? 0 : 90)
            }}
          >
            <button
              type="button"
              className="pm-menu"
              data-index={i}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={open === i}
              onClick={() => setOpen((o) => (o === i ? null : i))}
            >
              <span>{menu.label}</span>
              <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden><path d="M6.5 2 3.5 5l3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            {open === i && (
              <div className="pm-sub" data-index={i} role="menu" aria-label={menu.label}>
                {tidy(menu.items).map((item, j) => {
                  if (item === 'line') return <hr key={`l${j}`} className="pm-line" />
                  if (item.heading) return <div key={`h${j}`} className="pm-heading">{item.heading}</div>
                  if (item.custom) return <div key={`c${j}`} className="pm-custom">{item.custom}</div>
                  return (
                    <button
                      key={item.label}
                      type="button"
                      role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
                      aria-checked={item.checked}
                      className={`pm-item ${item.danger ? 'danger' : ''} ${item.checked ? 'checked' : ''}`}
                      disabled={item.disabled}
                      title={item.hint}
                      onClick={() => { close(); item.onSelect() }}
                    >
                      <span className="pm-check" aria-hidden>{item.checked ? '●' : ''}</span>
                      <span className="pm-label">{item.label}</span>
                      {item.shortcut && <kbd>{item.shortcut}</kbd>}
                    </button>
                  )
                })}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
