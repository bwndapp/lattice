import { useEffect, useRef } from 'react'
import { getAudioContext, getSuperdoughAudioController } from '@strudel/webaudio'
import './MiniScopes.css'

/**
 * Two small meters on the master, in a strip above the top bar:
 *
 *   waveform  the sound as it goes, scrolling right to left: each pixel column is the
 *             loudest and quietest the master reached in that sliver of time
 *   stereo    a stereo scope (a goniometer): left against right, turned 45° so mono stands
 *             straight up and down and a wide mix blooms sideways; a correlation bar under
 *             it reads +1 (mono) … 0 (wide) … −1 (out of phase, which vanishes in mono)
 *
 * They listen to the master after its last stage, through an analyser per side, and only
 * draw while the page is visible.
 */
const SCROLL_PX = 1.5 // how far the waveform moves each frame

function useMasterTap() {
  const ref = useRef(null)
  const get = () => {
    const ac = getAudioContext()
    const master = getSuperdoughAudioController()?.output?.destinationGain
    if (!ac || !master || ac.state !== 'running') return null
    const t = ref.current
    if (t && t.master === master && t.ac === ac) return t
    if (t) { try { t.master.disconnect(t.split) } catch { /* gone with its context */ } try { t.sink.disconnect() } catch { /* gone */ } }
    const split = new ChannelSplitterNode(ac, { numberOfOutputs: 2 })
    const l = new AnalyserNode(ac, { fftSize: 2048, smoothingTimeConstant: 0 })
    const r = new AnalyserNode(ac, { fftSize: 2048, smoothingTimeConstant: 0 })
    master.connect(split)
    split.connect(l, 0)
    split.connect(r, 1)
    // an analyser nobody pulls from isn't run: a silent wire on to the speakers keeps it listening
    const sink = new GainNode(ac, { gain: 0 })
    l.connect(sink); r.connect(sink); sink.connect(ac.destination)
    ref.current = { ac, master, split, l, r, sink, bl: new Float32Array(2048), br: new Float32Array(2048) }
    return ref.current
  }
  return get
}

export default function MiniScopes({ playing = true }) {
  const playingRef = useRef(playing)
  playingRef.current = playing
  const waveRef = useRef(null)
  const scopeRef = useRef(null)
  const corrRef = useRef(null)
  const tap = useMasterTap()

  useEffect(() => {
    let raf = 0
    let lastRead = 0
    const draw = (now) => {
      raf = requestAnimationFrame(draw)
      if (document.hidden) return
      const t = tap()
      const wave = waveRef.current
      const scope = scopeRef.current
      if (!wave || !scope) return
      const ink = getComputedStyle(wave).getPropertyValue('--scope-ink').trim() || '#e4ff1a'
      const dpr = window.devicePixelRatio || 1
      for (const c of [wave, scope]) {
        // the stereo field's guides live in CSS behind it, so its canvas keeps only the dots
        const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr)
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h }
      }
      if (t) {
        t.l.getFloatTimeDomainData(t.bl)
        t.r.getFloatTimeDomainData(t.br)
      }
      // Nothing new coming in (stopped, paused, or the audio that fed it is gone): the
      // analyser keeps handing back the last slice it heard, which would scroll by for ever.
      // So the waveform holds still and the stereo field fades away.
      let fresh = false
      if (t) {
        const sig = t.bl[0] + t.bl[511] * 3 + t.bl[1023] * 7 + t.bl[2047] * 11 + t.br[777] * 13
        fresh = sig !== t.sig
        t.sig = sig
      }
      const live = playingRef.current && fresh
      // ── the waveform: shift what's there left, draw the newest sliver at the right ──
      const wg = wave.getContext('2d')
      const W = wave.width, H = wave.height
      const step = Math.max(1, Math.round(SCROLL_PX * dpr))
      if (live) {
        wg.drawImage(wave, -step, 0)
        wg.clearRect(W - step, 0, step, H)
      }
      let peak = 0, low = 0, high = 0, sum = 0, count = 0
      if (t && live) {
        // the samples since the last frame (about one frame's worth at the end of the buffer)
        const since = Math.min(t.bl.length, Math.max(64, Math.round(((now - lastRead) / 1000 || 1 / 60) * t.ac.sampleRate)))
        lastRead = now
        for (let i = t.bl.length - since; i < t.bl.length; i++) {
          const m = (t.bl[i] + t.br[i]) / 2
          if (m > high) high = m
          if (m < low) low = m
          peak = Math.max(peak, Math.abs(t.bl[i]), Math.abs(t.br[i]))
          sum += m * m
          count++
        }
      }
      const mid = H / 2
      // the peaks faint, the average level solid on them: the beat's shape shows even in a loud mix
      const rms = count ? Math.sqrt(sum / count) : 0
      if (live) {
      wg.fillStyle = peak > 0.99 ? '#ff5a43' : ink
      wg.globalAlpha = 0.35
      wg.fillRect(W - step, mid - Math.max(0.5, high * mid * 0.95), step, Math.max(1, (high - low) * mid * 0.95))
      wg.globalAlpha = 0.95
      const half = Math.min(1, rms * 1.41) * mid * 0.95
      wg.fillRect(W - step, mid - half, step, Math.max(1, half * 2))
      wg.globalAlpha = 1
      }
      // ── the stereo field: each sample a dot, across by where it sits (hard left … mono …
      //    hard right), up by how loud it is; a short trail so it reads as a cloud ──
      const sg = scope.getContext('2d')
      const SW = scope.width, SH = scope.height
      sg.globalCompositeOperation = 'destination-out' // fade what's there toward see-through
      sg.fillStyle = 'rgba(0, 0, 0, 0.28)'
      sg.fillRect(0, 0, SW, SH)
      sg.globalCompositeOperation = 'source-over'
      let corr = 0, el = 0, er = 0
      if (t && live) {
        sg.fillStyle = ink
        const n = t.bl.length
        const dot = Math.max(1, 1.4 * dpr)
        for (let i = n - 1024; i < n; i++) {
          const l = t.bl[i], r = t.br[i]
          corr += l * r; el += l * l; er += r * r
          const mid = (l + r) * 0.7071, side = (r - l) * 0.7071
          const amp = Math.sqrt(l * l + r * r) * 0.7071
          if (amp < 0.02) continue // near-silence has no place to speak of: it would only smear the floor
          // where it sits: the angle off the mono line, folded so out-of-phase reads as wide
          const pos = Math.atan2(side, Math.abs(mid)) / (Math.PI / 2) // −1 left … 0 mono … 1 right
          sg.globalAlpha = 0.55
          sg.fillRect(SW / 2 + pos * (SW / 2) * 0.96 - dot / 2, SH - Math.min(1, amp) * SH * 0.95 - dot / 2, dot, dot)
        }
        sg.globalAlpha = 1
      }
      // ── correlation: +1 mono, 0 wide, −1 out of phase ──
      const c = el > 1e-9 && er > 1e-9 ? corr / Math.sqrt(el * er) : 1
      const bar = corrRef.current
      if (bar) {
        bar.style.setProperty('--corr', String((c + 1) / 2))
        bar.classList.toggle('bad', c < -0.1)
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [tap])

  return (
    <div className="mini-scopes" aria-hidden>
      <canvas ref={waveRef} className="ms-wave" title="The master as it plays, scrolling" />
      <span className="ms-stereo" title="Stereo field: across is where the sound sits (left · mono in the middle · right), up is how loud · the bar under it is the correlation: right end mono, middle wide, red at the left: out of phase, it'll vanish in mono">
        <span className="ms-field">
          <span className="ms-guide l" />
          <span className="ms-guide c" />
          <span className="ms-guide r" />
          <span className="ms-tag l">L</span>
          <span className="ms-tag r">R</span>
          <canvas ref={scopeRef} className="ms-scope" />
        </span>
        <span ref={corrRef} className="ms-corr"><i /></span>
      </span>
    </div>
  )
}
