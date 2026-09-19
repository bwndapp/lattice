import { useEffect, useRef, useState } from 'react'
import CodeBox from './CodeBox.jsx'
import './ConfirmDialog.css'
import './CodeBox.css'

/**
 * One node's code, big enough to work in.
 *
 * It's the same text as the box on the node — what you apply here is on the patch at once
 * — so there's no saving to remember and no copy to get out of step. Escape closes it, and
 * closing applies whatever is in it, because losing a line you just wrote to a stray click
 * is worse than applying one you weren't sure about (undo is one key away).
 */
export default function CodeWindow({ title, value, onCommit, onClose }) {
  const ref = useRef(null)
  const live = useRef(value)
  const [text, setText] = useState(value)
  live.current = text

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (!dialog.open) dialog.showModal()
    return () => { if (dialog.open) dialog.close() }
  }, [])

  const done = () => { if (live.current !== value) onCommit(live.current); onClose() }

  return (
    <dialog
      ref={ref}
      className="confirm-dialog calm code-window"
      aria-labelledby="code-window-title"
      onCancel={(e) => { e.preventDefault(); done() }}
      onKeyDown={(e) => { if (e.key !== 'Escape') e.stopPropagation() }}
      onClick={(e) => { if (e.target === ref.current) done() }}
    >
      <div className="cd-body">
        <h2 id="code-window-title" className="cd-title">code</h2>
        <p className="cw-where">on <b>{title}</b> · any Strudel pattern · it runs as soon as you apply it</p>
        <CodeBox value={text} numbers autoFocus onCommit={setText} />
        <div className="cd-actions">
          <span className="cw-keys">ctrl/cmd ⏎ applies · esc closes</span>
          <button type="button" className="btn primary" onClick={done}>done</button>
        </div>
      </div>
    </dialog>
  )
}
