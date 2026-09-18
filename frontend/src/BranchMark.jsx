/** The mark for a track that came off another one: a line leaving a line. */
export default function BranchMark({ className = '' }) {
  return (
    <svg className={`branch-mark ${className}`} viewBox="0 0 12 12" aria-hidden>
      <path d="M3.2 2.6v2.2c0 2.2 1.6 3.4 3.8 3.4h1.4" />
      <circle cx="3.2" cy="1.9" r="1.35" />
      <circle cx="9.2" cy="8.2" r="1.35" />
    </svg>
  )
}
