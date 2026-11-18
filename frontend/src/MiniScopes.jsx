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

export default function MiniScopes() {
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
        const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr)
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h }
      }
      // ── the waveform: shift what's there left, draw the newest sliver at the right ──
      const wg = wave.getContext('2d')
      const W = wave.width, H = wave.height
      const step = Math.max(1, Math.round(SCROLL_PX * dpr))
      wg.drawImage(wave, -step, 0)
      wg.clearRect(W - step, 0, step, H)
      let peak = 0, low = 0, high = 0, sum = 0, count = 0
      if (t) {
        t.l.getFloatTimeDomainData(t.bl)
        t.r.getFloatTimeDomainData(t.br)
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
      wg.fillStyle = peak > 0.99 ? '#ff5a43' : ink
      wg.globalAlpha = 0.35
      wg.fillRect(W - step, mid - Math.max(0.5, high * mid * 0.95), step, Math.max(1, (high - low) * mid * 0.95))
      wg.globalAlpha = 0.95
      const half = Math.min(1, rms * 1.41) * mid * 0.95
      wg.fillRect(W - step, mid - half, step, Math.max(1, half * 2))
      wg.globalAlpha = 1
      // ── the stereo scope: the last frame's samples, left against right, turned 45° ──
      const sg = scope.getContext('2d')
      const S = Math.min(scope.width, scope.height)
      const cx = scope.width / 2, cy = scope.height / 2
      sg.fillStyle = 'rgba(11, 11, 11, 0.45)' // what was there fades, a short trail
      sg.fillRect(0, 0, scope.width, scope.height)
      sg.strokeStyle = 'rgba(255, 255, 255, 0.08)'
      sg.beginPath(); sg.moveTo(cx, 0); sg.lineTo(cx, scope.height); sg.moveTo(0, cy); sg.lineTo(scope.width, cy); sg.stroke()
      let corr = 0, el = 0, er = 0
      if (t) {
        // a line through the last frame's samples: easier to read at this size than dots
        sg.strokeStyle = ink
        sg.lineWidth = 1 * dpr
        sg.globalAlpha = 0.85
        sg.beginPath()
        const n = t.bl.length
        const scale = (S / 2) * 0.95
        for (let i = n - 1024; i < n; i++) {
          const l = t.bl[i], r = t.br[i]
          corr += l * r; el += l * l; er += r * r
          // mono (l = r) straight up; one side only leans 45°
          const x = cx + (r - l) * 0.7071 * scale, y = cy - (l + r) * 0.7071 * scale
          if (i === n - 1024) sg.moveTo(x, y); else sg.lineTo(x, y)
        }
        sg.stroke()
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
      <span className="ms-stereo" title="Stereo scope: mono stands up straight, a wide mix spreads sideways · the bar under it is the correlation: right is mono, left is out of phase (red: it'll vanish in mono)">
        <canvas ref={scopeRef} className="ms-scope" />
        <span ref={corrRef} className="ms-corr"><i /></span>
      </span>
    </div>
  )
}
