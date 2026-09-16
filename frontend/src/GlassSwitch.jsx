import { Glass } from './Glass.jsx'
import './GlassSwitch.css'

/**
 * The house switch: a lattice-etched track with a glass thumb that slides to what's chosen
 * (the same one as TIMELINE / PATCH in the header). `options` are [value, label] pairs.
 */
export default function GlassSwitch({ options, value, onChange, label, size = 'md', className = '' }) {
  const at = Math.max(0, options.findIndex(([key]) => key === value))
  return (
    <span
      className={`gswitch ${size} ${className}`}
      role="group"
      aria-label={label}
      style={{ '--n': options.length, '--at': at }}
    >
      <Glass className="gswitch-thumb" aria-hidden />
      {options.map(([key, text, hint]) => (
        <button
          key={key}
          type="button"
          className={`gswitch-opt ${value === key ? 'on' : ''}`}
          aria-pressed={value === key}
          title={hint}
          onClick={() => onChange(key)}
        >{text}</button>
      ))}
    </span>
  )
}
