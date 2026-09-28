/*
 * What the studio opens when the page loads, and where it goes when a track won't load.
 * Pure, so it can be tested (frontend/test/start.test.mjs).
 */

/**
 * On load at / (no track in the address): stay on the scratch pad, go back to the last
 * track, look up the newest saved one, or wait to know who's here.
 *   → 'stay' | 'wait' | 'latest' | { track: id }
 */
export function whatToOpen({ trackId, fresh, scratchWins, lastTrack, userLoading, signedIn }) {
  if (trackId || fresh) return 'stay' // the address already says what to open
  if (scratchWins) return 'stay' // you were last working on the scratch pad
  if (lastTrack) return { track: lastTrack }
  if (userLoading) return 'wait'
  return signedIn ? 'latest' : 'stay'
}

/**
 * A track that won't load (gone, private, not yours, offline) never leaves an empty studio:
 * go to the scratch pad (your unsaved draft there, or a blank project), say why, and only
 * stop reopening it if it's really gone.
 */
export function whenLoadFails(status) {
  const gone = status === 404 || status === 401 || status === 403
  return {
    forget: gone,
    message: gone ? 'That track doesn’t exist, or it’s private' : 'Couldn’t load that track, check your connection',
  }
}
