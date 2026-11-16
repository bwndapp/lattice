import { useEffect, useRef, useState } from 'react'
import './SharePanel.css'

/**
 * Everything about sharing a track, in one place: who can open it, its link, and jamming on
 * it together. Who can open it applies the moment it's picked (only that setting is saved,
 * never the patch); a track that isn't saved yet says so first, since there's nothing to
 * share until it is.
 *
 *   track         the saved track, or null while it's new
 *   visibility    'private' | 'unlisted' | 'public' (a new track's is used when it's saved)
 *   jam           { mode: 'open' | 'invite', key } — the session, owner only (collab.js)
 *   editors       whether people in the jam may change the track
 */
const WHO = [
  ['private', 'only me', 'Nobody else can open it'],
  ['unlisted', 'anyone with the link', "Not listed: only people you send it to"],
  ['public', 'everyone', 'Listed in explore for anyone to find'],
]

function CopyField({ label, url, onCopy, extra }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1400) } catch { window.prompt('Copy this link', url) }
    onCopy?.()
  }
  return (
    <div className="sh-field">
      <span className="sh-label">{label}</span>
      <div className="sh-link">
        <input className="sh-url" readOnly value={url} aria-label={label} onFocus={(e) => e.target.select()} />
        <button type="button" className="btn primary sh-copy" onClick={copy}>{copied ? 'copied ✓' : 'copy'}</button>
        {extra}
      </div>
    </div>
  )
}

function Choice({ options, value, onPick, disabled = () => false, label }) {
  return (
    <div className="sh-choice" role="radiogroup" aria-label={label}>
      {options.map(([v, text, tip]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          className={value === v ? 'on' : ''}
          disabled={disabled(v)}
          title={tip}
          onClick={() => onPick(v)}
        >{text}</button>
      ))}
    </div>
  )
}

export default function SharePanel({
  track, title, isOwner, isNew, signedIn, dirty, busy,
  visibility, onVisibility, onSave, onSignIn,
  trackLink, jam, onJam, inviteLink, onNewInvite, editors, onEditors, onClose,
}) {
  const box = useRef(null)
  // a click anywhere else, or Esc, puts it away
  useEffect(() => {
    const away = (e) => { if (box.current && !box.current.contains(e.target) && !e.target.closest?.('.share-btn')) onClose() }
    const esc = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', esc) }
  }, [onClose])

  const name = title || track?.title || 'untitled'
  const who = WHO.find(([v]) => v === visibility) ?? WHO[0]
  const isPrivate = visibility === 'private'

  return (
    <div className="share-panel" ref={box} role="dialog" aria-label={`Share ${name}`}>
      <header className="sh-head">
        <span className="sh-title">share <b>{name}</b></span>
        <button type="button" className="sh-x" onClick={onClose} aria-label="Close">×</button>
      </header>

      {/* someone else's track: its link, nothing to decide */}
      {!isOwner && track && (
        <section className="sh-section">
          {track.visibility === 'private'
            ? <p className="sh-note">This track is private to its owner.</p>
            : <CopyField label="link" url={trackLink} />}
        </section>
      )}

      {(isOwner || isNew) && (
        <section className="sh-section">
          <span className="sh-label">who can open it</span>
          <Choice label="Who can open it" options={WHO} value={visibility} onPick={onVisibility} />
          <p className="sh-note">{who[2]}{isNew ? ' · applies when you save' : ''}</p>
        </section>
      )}

      {/* nothing to share until it's saved */}
      {isNew && (
        <section className="sh-section sh-first">
          {signedIn ? (
            <>
              <p className="sh-note">Save it first: sharing starts from a saved track.</p>
              <button type="button" className="btn primary" disabled={busy} onClick={onSave}>{busy ? 'saving…' : 'save and share'}</button>
            </>
          ) : (
            <>
              <p className="sh-note">Sign in to save this track, then share it.</p>
              <button type="button" className="btn primary" onClick={onSignIn}>sign in</button>
            </>
          )}
        </section>
      )}

      {isOwner && !isNew && (
        <section className="sh-section">
          <CopyField label="link" url={trackLink} />
          {isPrivate && (
            <p className="sh-note sh-warn">
              Only you can open this link.{' '}
              <button type="button" className="linkish" onClick={() => onVisibility('unlisted')}>Let anyone with it open it</button>
            </p>
          )}
          {dirty && <p className="sh-note">You have unsaved changes: people with the link hear the last save. <button type="button" className="linkish" disabled={busy} onClick={onSave}>save now</button></p>}
        </section>
      )}

      {isOwner && !isNew && (
        <section className="sh-section">
          <span className="sh-label">jam together</span>
          <div className="sh-row">
            <span className="sh-rowname">people in the jam can</span>
            <Choice
              label="People in the jam can"
              options={[['listen', 'listen', 'They hear it and see what you do'], ['edit', 'edit with you', 'Anyone signed in can change it with you, live. Saving stays yours']]}
              value={editors ? 'edit' : 'listen'}
              onPick={(v) => onEditors(v === 'edit')}
            />
          </div>
          <div className="sh-row">
            <span className="sh-rowname">who can join</span>
            <Choice
              label="Who can join the jam"
              options={[['open', 'anyone with the link', 'Opening the track joins you while you work on it'], ['invite', 'invite link only', 'Only people with the invite link below']]}
              value={isPrivate ? 'invite' : jam.mode}
              disabled={(v) => isPrivate && v === 'open'}
              onPick={onJam}
            />
          </div>
          {(isPrivate || jam.mode === 'invite') && (
            jam.mode === 'invite' && jam.key
              ? <CopyField
                  label="invite link"
                  url={inviteLink}
                  extra={<button type="button" className="btn ghost" onClick={onNewInvite} title="Stops every invite link you've handed out. Anyone already here stays">new link</button>}
                />
              : <button type="button" className="btn" onClick={() => onJam('invite')}>make an invite link</button>
          )}
          <p className="sh-note">
            {isPrivate
              ? 'The track is private, so the invite link is the only way in: it works even though nobody else can open the track.'
              : jam.mode === 'invite'
                ? 'Opening the track lets people listen to the last save; only the invite link brings them into your session.'
                : 'Anyone who opens the link while you have the track open joins you, and it shows as live in browse.'}
          </p>
        </section>
      )}
    </div>
  )
}
