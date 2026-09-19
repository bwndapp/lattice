import { useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, highlightActiveLine, highlightSpecialChars, drawSelection, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, syntaxHighlighting, HighlightStyle, indentOnInput } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { javascript } from '@codemirror/lang-javascript'
import { tags } from '@lezer/highlight'
import './CodeBox.css'

/*
 * Code in lattice looks like the rest of lattice: black ground, one acid accent, and
 * everything else in the paper and grey the panels use. Sounds and mini-notation are
 * strings, and they're the part you actually read, so they get the accent; the plumbing
 * around them stays quiet.
 */
const paint = HighlightStyle.define([
  { tag: tags.string, color: '#e4ff1a' },
  { tag: tags.number, color: '#f2f0e6' },
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: '#c8a2ff' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#86d8cc' },
  { tag: [tags.propertyName, tags.attributeName], color: '#b9c96a' },
  { tag: [tags.variableName, tags.definition(tags.variableName)], color: '#f2f0e6' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#6f6f67', fontStyle: 'italic' },
  { tag: [tags.punctuation, tags.bracket, tags.operator], color: '#a3a39a' },
  { tag: tags.bool, color: '#ffb347' },
])

const look = EditorView.theme({
  '&': { color: '#f2f0e6', backgroundColor: 'transparent', fontSize: '12px' },
  '.cm-content': { fontFamily: 'var(--mono)', padding: '0.4rem 0', caretColor: '#e4ff1a', lineHeight: '1.55' },
  '.cm-line': { padding: '0 0.55rem' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#e4ff1a', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(228, 255, 26, 0.22)' },
  '.cm-activeLine': { backgroundColor: 'rgba(242, 240, 230, 0.03)' },
  '.cm-gutters': { backgroundColor: 'transparent', color: '#45453b', border: 'none', fontFamily: 'var(--mono)', fontSize: '10px' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#8a8a80' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'rgba(228, 255, 26, 0.18)', outline: 'none', color: 'inherit' },
  '.cm-scroller': { overflow: 'auto' },
}, { dark: true })

/**
 * A small code editor: the language, the theme and the two keys that matter.
 *
 * Typing doesn't change the patch — what you write is applied when you leave the box or
 * press ctrl/cmd + enter, the same as every other field in a node. That way a half-written
 * line never takes the sound down with it.
 */
export default function CodeBox({ value = '', onCommit, numbers = false, autoFocus = false, className = '', onExpand }) {
  const host = useRef(null)
  const view = useRef(null)
  const latest = useRef({ value, onCommit })
  latest.current = { value, onCommit }
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    const commit = () => {
      const text = view.current?.state.doc.toString() ?? ''
      setDirty(false)
      if (text !== latest.current.value) latest.current.onCommit?.(text)
    }
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          numbers ? lineNumbers() : [],
          history(),
          drawSelection(),
          highlightSpecialChars(),
          highlightActiveLine(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          javascript(),
          syntaxHighlighting(paint),
          look,
          EditorView.lineWrapping,
          EditorView.updateListener.of((v) => {
            if (v.docChanged) setDirty(v.state.doc.toString() !== latest.current.value)
          }),
          EditorView.domEventHandlers({ blur: () => { commit(); return false } }),
          keymap.of([
            { key: 'Mod-Enter', preventDefault: true, run: () => { commit(); return true } },
            { key: 'Escape', run: (v) => { v.contentDOM.blur(); return true } },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
        ],
      }),
    })
    view.current = editor
    if (autoFocus) editor.focus()
    return () => { editor.destroy(); view.current = null }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // a change from somewhere else (undo, a peer, loading a track) replaces what's in the box
  useEffect(() => {
    const editor = view.current
    if (!editor || editor.hasFocus) return
    const now = editor.state.doc.toString()
    if (now === value) return
    editor.dispatch({ changes: { from: 0, to: now.length, insert: value } })
    setDirty(false)
  }, [value])

  return (
    <div className={`codebox ${dirty ? 'dirty' : ''} ${className}`}>
      <div className="codebox-cm nodrag nowheel" ref={host} />
      {onExpand && (
        <button type="button" className="codebox-expand" onClick={onExpand} title="Open it bigger (a window of its own)" aria-label="Open the code bigger">⤢</button>
      )}
      {dirty && <span className="codebox-dirty" aria-hidden>ctrl/cmd ⏎</span>}
    </div>
  )
}
