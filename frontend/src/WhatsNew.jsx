import { useEffect, useRef, useState } from 'react'
import { NEWS, VERSION } from './changelog.js'
import './ConfirmDialog.css'
import './WhatsNew.css'

const when = (entry) => new Date(`${entry.date ?? entry.id}T12:00:00`).toLocaleDateString([], { month: 'long', day: 'numeric' })

/** **bold** and nothing else: enough to point at a name without writing markup in the list. */
function line(text) {
  return String(text).split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part))
}

/**
 * What's changed since you were last here.
 *
 * Opened by itself, it shows what's new and nothing else — a list that grows every release
 * would bury the thing you opened it for under everything you've already read. What came
 * before is one line away, and opening it from the file menu starts there: then you came
 * for the history, not for the news.
 */
export default function WhatsNew({ since, onClose }) {
  const ref = useRef(null)
  const closeRef = useRef(null)
  const listRef = useRef(null)
  const [more, setMore] = useState(false) // something under the fold: the list fades out
  const fresh = since ? NEWS.filter((entry) => entry.id > since) : []
  // it arrived with news to show: start on that, and keep the rest behind a line
  const [all, setAll] = useState(!fresh.length)
  const shown = all ? NEWS : fresh
  const behind = NEWS.length - fresh.length

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
        <h2 id="whats-new-title" className="cd-title">{all ? 'What’s new' : fresh.length > 1 ? 'While you were away' : 'What’s new'}</h2>
        <p className="wn-now">you’re on <b>{VERSION}</b></p>
        <div className={`wn-list ${more ? 'more' : ''}`} ref={listRef}>
          {shown.map((entry) => (
            <section key={entry.id} className={`wn-entry ${since && entry.id > since ? 'fresh' : ''}`}>
              <header className="wn-head">
                <h3 className="wn-title">{entry.title}</h3>
                <span className="wn-when">
                  {entry.version && <b className="wn-ver">{entry.version}</b>}
                  {when(entry)}
                </span>
              </header>
              <ul className="wn-items">
                {entry.items.map((item, i) => <li key={i}>{line(item)}</li>)}
              </ul>
            </section>
          ))}
          {!all && behind > 0 && (
            <button type="button" className="wn-back" onClick={() => setAll(true)}>
              everything before this <span>{behind}</span>
            </button>
          )}
        </div>
        <div className="cd-actions">
          <button ref={closeRef} type="button" className="btn primary" onClick={onClose}>got it</button>
        </div>
      </div>
    </dialog>
  )
}
