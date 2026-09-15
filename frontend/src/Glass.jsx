import { useEffect, useId, useRef, useState } from 'react'

/*
 * Liquid glass (ref: ayeeye.net/posts/claude-opus/liquid-glass-on-the-web, after kube.io).
 * What's behind the element is bent at its edge by a displacement map worked out from
 * Snell's law over a squircle bezel, with a thin rim of light from the top left.
 * Only Chromium takes an SVG filter as a backdrop-filter; elsewhere the CSS fallback shows.
 */

const IOR = 1.5
const SAMPLES = 127
const LIGHT = [-0.55, -0.83] // the light comes from above, a little to the left

const squircle = (x) => Math.pow(1 - Math.pow(1 - x, 4), 1 / 4)

/** How far (px, inward) a ray lands at each point across the bezel, outer edge first. */
function bezelProfile(bezel, thickness) {
  const out = new Float32Array(SAMPLES)
  const h = 1e-3
  for (let i = 0; i < SAMPLES; i++) {
    const x = i / (SAMPLES - 1)
    const a = Math.max(0, x - h), b = Math.min(1, x + h)
    const slope = ((squircle(b) - squircle(a)) / (b - a)) * (thickness / bezel)
    const t1 = Math.atan(slope)
    const t2 = Math.asin(Math.sin(t1) / IOR)
    // the ray travels through the glass above this point, plus the slab below the dome
    out[i] = Math.tan(t1 - t2) * (squircle(x) * thickness + thickness * 0.35)
  }
  return out
}

/** The displacement map and the rim-light image for a rounded box, as data URLs. */
function buildMaps(w, h, radius) {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const cw = Math.max(1, Math.round(w * dpr)), ch = Math.max(1, Math.round(h * dpr))
  const r = Math.min(radius, w / 2, h / 2)
  const bezel = Math.max(2, Math.min(r * 0.55, 9)) // a thin bezel: the label in the flat middle stays put
  const profile = bezelProfile(bezel, bezel)
  let max = 0
  for (const v of profile) max = Math.max(max, v)

  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  const map = ctx.createImageData(cw, ch)
  const spec = ctx.createImageData(cw, ch)
  const [lx, ly] = LIGHT

  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      const px = (i + 0.5) / dpr, py = (j + 0.5) / dpr
      const sx = Math.sign(px - w / 2) || 1, sy = Math.sign(py - h / 2) || 1
      const qx = Math.abs(px - w / 2) - (w / 2 - r)
      const qy = Math.abs(py - h / 2) - (h / 2 - r)
      let d, nx, ny // distance in from the edge, and the outward normal
      if (qx > 0 && qy > 0) {
        const len = Math.hypot(qx, qy) || 1
        d = r - len
        nx = (qx / len) * sx
        ny = (qy / len) * sy
      } else if (qx > qy) {
        d = r - qx; nx = sx; ny = 0
      } else {
        d = r - qy; nx = 0; ny = sy
      }
      const k = (j * cw + i) * 4
      let dx = 0, dy = 0
      if (d >= 0 && d < bezel) {
        const m = profile[Math.round((d / bezel) * (SAMPLES - 1))] / max
        dx = -nx * m // inward: convex glass samples from inside itself
        dy = -ny * m
      }
      map.data[k] = 128 + dx * 127
      map.data[k + 1] = 128 + dy * 127
      map.data[k + 2] = 128
      map.data[k + 3] = 255
      // rim light: strongest on the edge facing the light, a hair on the far edge
      if (d >= 0) {
        const facing = nx * lx + ny * ly
        const rim = Math.exp(-d / 1.1)
        const a = rim * (facing > 0 ? 0.08 + 0.62 * facing ** 1.5 : 0.1 * -facing)
        spec.data[k] = spec.data[k + 1] = spec.data[k + 2] = 255
        spec.data[k + 3] = Math.round(Math.min(1, a) * 255)
      }
    }
  }
  ctx.putImageData(map, 0, 0)
  const mapUrl = canvas.toDataURL('image/png')
  ctx.clearRect(0, 0, cw, ch)
  ctx.putImageData(spec, 0, 0)
  const specUrl = canvas.toDataURL('image/png')
  return { mapUrl, specUrl, scale: max }
}

const refracts = () => typeof navigator !== 'undefined'
  && !!navigator.userAgentData?.brands?.some((b) => /Chrom/.test(b.brand))

/** A glass element: pass the className and it bends whatever sits behind it. */
export function Glass({ className = '', radius = 999, ...rest }) {
  const ref = useRef(null)
  const id = `glass-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [maps, setMaps] = useState(null)
  const [size, setSize] = useState(null)
  const on = useRef(refracts()).current

  useEffect(() => {
    if (!on) return
    const el = ref.current
    const measure = () => {
      const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight)
      if (w && h) setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [on])

  useEffect(() => {
    if (!size) return
    setMaps({ ...buildMaps(size.w, size.h, radius), ...size })
  }, [size, radius])

  return (
    <span
      ref={ref}
      className={`${className} glass ${maps ? 'refracting' : ''}`}
      style={maps ? { '--glass': `url(#${id})` } : undefined}
      {...rest}
    >
      {maps && (
        <svg width="0" height="0" aria-hidden style={{ position: 'absolute' }}>
          <filter id={id} x="0" y="0" width={maps.w} height={maps.h} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
            <feImage href={maps.mapUrl} x="0" y="0" width={maps.w} height={maps.h} preserveAspectRatio="none" result="map" />
            <feDisplacementMap in="SourceGraphic" in2="map" scale={maps.scale} xChannelSelector="R" yChannelSelector="G" result="bent" />
            <feImage href={maps.specUrl} x="0" y="0" width={maps.w} height={maps.h} preserveAspectRatio="none" result="light" />
            <feComposite in="light" in2="bent" operator="over" />
          </filter>
        </svg>
      )}
    </span>
  )
}
