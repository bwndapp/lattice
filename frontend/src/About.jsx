import { useEffect, useRef } from 'react'
import './ConfirmDialog.css'

const SOURCE = 'https://github.com/bwndapp/lattice'

/**
 * What lattice is, and where its source is.
 *
 * The link isn't decoration: lattice is built on Strudel, which is free software under the
 * AGPL, and the AGPL asks that anyone using a copy over the network be told plainly how to
 * get the source of the version they're using. So it lives in the file menu, not in a
 * footnote.
 */
export default function About({ onClose }) {
  const ref = useRef(null)
  const closeRef = useRef(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (!dialog.open) dialog.showModal()
    closeRef.current?.focus()
    return () => { if (dialog.open) dialog.close() }
  }, [])

  return (
    <dialog
      ref={ref}
      className="confirm-dialog calm"
      aria-labelledby="about-title"
      onCancel={(e) => { e.preventDefault(); onClose() }}
      onKeyDown={(e) => { if (e.key !== 'Escape') e.stopPropagation() }}
      onClick={(e) => { if (e.target === ref.current) onClose() }}
    >
      <div className="cd-body">
        <h2 id="about-title" className="cd-title">lattice</h2>
        <div className="cd-text">
          <p>
            A node-patch studio for <a className="link" href="https://strudel.cc" target="_blank" rel="noreferrer noopener">Strudel</a>:
            wire beats, synths and effects together as nodes, arrange the parts on a timeline,
            and hear the patch play in the browser.
          </p>
          <p>
            Strudel is free software under the <b>AGPL-3.0</b>, and lattice is built on it, so
            lattice is AGPL-3.0-or-later too. Everything that builds the page you're using is here:
          </p>
          <p>
            <a className="link" href={SOURCE} target="_blank" rel="noreferrer noopener">github.com/bwndapp/lattice</a>
          </p>
          <p className="cd-quiet">
            Tracks people save are their own; the licence covers the program, not the music.
          </p>
        </div>
        <div className="cd-actions">
          <button ref={closeRef} type="button" className="btn primary" onClick={onClose}>close</button>
        </div>
      </div>
    </dialog>
  )
}
