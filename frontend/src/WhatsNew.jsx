import { useEffect, useRef, useState } from 'react'
import { NEWS } from './changelog.js'
import './ConfirmDialog.css'
import './WhatsNew.css'

const when = (id) => new Date(`${id}T12:00:00`).toLocaleDateString([], { month: 'long', day: 'numeric' })

/** **bold** and nothing else: enough to point at a name without writing markup in the list. */
function line(text) {
  return String(text).split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part))
}

/**
 * What's changed since you were last here.
 *
 * It opens by itself when there's something you haven't seen, and closing it is agreeing
 * you've seen it. Everything older is still in here, so it doubles as the whole list from
 * the file menu.
 */
export default function WhatsNew({ since, onClose }) {
  const ref = useRef(null)
  const closeRef = useRef(null)
  const listRef = useRef(null)
  const [more, setMore] = useState(false) // something under the fold: the list fades out

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (!dialog.open) dialog.showModal()
    closeRef.current?.focus()
    return () => { if (dialog.open) dialog.close() }
  }, [])

  useEffect(() => {
    const list = listRef.current
    if (!list) return undefined
    const check = () => setMore(list.scrollTop + list.clientHeight < list.scrollHeight - 4)
    check()
    list.addEventListener('scroll', check, { passive: true })
    return () => list.removeEventListener('scroll', check)
  }, [])

  return (
    <dialog
      ref={ref}
      className="confirm-dialog calm whats-new"
      aria-labelledby="whats-new-title"
      onCancel={(e) => { e.preventDefault(); onClose() }}
      onKeyDown={(e) => { if (e.key !== 'Escape') e.stopPropagation() }}
      onClick={(e) => { if (e.target === ref.current) onClose() }}
    >
      <div className="cd-body">
        <h2 id="whats-new-title" className="cd-title">What’s new</h2>
        <div className={`wn-list ${more ? 'more' : ''}`} ref={listRef}>
          {NEWS.map((entry) => (
            <section key={entry.id} className={`wn-entry ${since && entry.id > since ? 'fresh' : ''}`}>
              <header className="wn-head">
                <h3 className="wn-title">{entry.title}</h3>
                <span className="wn-when">{when(entry.id)}</span>
              </header>
              <ul className="wn-items">
                {entry.items.map((item, i) => <li key={i}>{line(item)}</li>)}
              </ul>
            </section>
          ))}
        </div>
        <div className="cd-actions">
          <button ref={closeRef} type="button" className="btn primary" onClick={onClose}>got it</button>
        </div>
      </div>
    </dialog>
  )
}
