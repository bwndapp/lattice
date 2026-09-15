import { useEffect, useRef } from 'react'
import './ConfirmDialog.css'

/**
 * A modal that asks before something drastic. Built on <dialog>, so focus stays inside
 * and Esc cancels. The safe choice has focus when it opens.
 */
export default function ConfirmDialog({ title, children, confirmLabel, cancelLabel = 'Cancel', danger = false, onConfirm, onCancel, altLabel = null, onAlt = null }) {
  const ref = useRef(null)
  const cancelRef = useRef(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (!dialog.open) dialog.showModal()
    cancelRef.current?.focus()
    return () => { if (dialog.open) dialog.close() }
  }, [])

  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      aria-labelledby="confirm-dialog-title"
      onCancel={(e) => { e.preventDefault(); onCancel() }}
      // keys stay in here: space must not start playback, Delete must not delete nodes
      onKeyDown={(e) => { if (e.key !== 'Escape') e.stopPropagation() }}
      onClick={(e) => { if (e.target === ref.current) onCancel() }}
    >
      <div className="cd-body">
        <h2 id="confirm-dialog-title" className="cd-title">{title}</h2>
        <div className="cd-text">{children}</div>
        <div className="cd-actions">
          <button ref={cancelRef} type="button" className="btn" onClick={onCancel}>{cancelLabel}</button>
          {altLabel && <button type="button" className="btn" onClick={onAlt}>{altLabel}</button>}
          <button type="button" className={`btn ${danger ? 'cd-danger' : 'primary'}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </dialog>
  )
}
