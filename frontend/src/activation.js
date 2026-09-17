/**
 * Has this page had a real gesture yet? Audio can't start before one, so the engine waits
 * for it.
 *
 * `navigator.userActivation` answers this where it exists — Chromium, and Safari from 16.4
 * — and nowhere else, which is the whole of Firefox and every older Safari. Asking a
 * browser that doesn't have it gets `undefined` forever, gesture or no gesture, so
 * anything waiting on it waits for good. We watch for the first gesture ourselves and
 * answer from that when the browser won't.
 */
let touched = false
const mark = () => { touched = true }

if (typeof window !== 'undefined') {
  for (const kind of ['pointerdown', 'keydown', 'touchstart', 'mousedown']) {
    window.addEventListener(kind, mark, { capture: true, once: true })
  }
}

export function hasGesture() {
  if (typeof navigator === 'undefined') return false
  return navigator.userActivation?.hasBeenActive || touched
}
