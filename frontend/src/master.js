/**
 * The master's safety: nothing leaves at more than full scale. Past full scale the browser
 * cuts the wave flat, which sounds crushed and bitty. Up to 0.8 this passes the sound
 * through untouched; above that it rounds the peaks off smoothly to just under 1 (a soft
 * clipper, oversampled so the rounding doesn't alias). Patches that never get that hot
 * sound exactly as before.
 *
 * Strudel rebuilds its output when the audio is reset, so this hooks that too.
 */
const KNEE = 0.8
const RANGE = 2 // the curve covers -2 … 2: anything louder is held at the top

let curve = null
function makeCurve() {
  const n = 4096
  const c = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const u = ((i / (n - 1)) * 2 - 1) * RANGE
    const a = Math.abs(u)
    c[i] = Math.sign(u) * (a <= KNEE ? a : KNEE + (1 - KNEE) * Math.tanh((a - KNEE) / (1 - KNEE)))
  }
  return c
}

function guard(output) {
  const ac = output.audioContext
  const gain = output.destinationGain
  if (!ac || !gain || gain.__guarded) return
  curve ??= makeCurve()
  const into = new GainNode(ac, { gain: 1 / RANGE })
  const shaper = new WaveShaperNode(ac, { curve, oversample: '4x' })
  gain.disconnect(ac.destination)
  gain.connect(into)
  into.connect(shaper)
  shaper.connect(ac.destination)
  gain.__guarded = true
  gain.__heard = shaper // the last thing before the speakers: what's heard, for the stream to tap
}

/** Put the safety on a Strudel audio controller's output (and keep it there). */
export function guardMaster(controller) {
  const output = controller?.output
  if (!output || output.__guardHooked) { if (output) guard(output); return }
  output.__guardHooked = true
  const init = output.initializeAudio.bind(output)
  output.initializeAudio = () => { init(); guard(output) }
  try { guard(output) } catch (err) { console.warn('[master] no safety on the output', err) }
}
