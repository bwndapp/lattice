// Tags on a track: the same cleaning the server does (src/api/tracks.py _tag), so what you
// type turns into the chip you'll get back.
export const MAX_TAG = 24
export const MAX_TAGS = 8
export const MAX_TITLE = 80

/** One tag as it's kept: lowercase letters, numbers, spaces and dashes, no leading #. */
export function cleanTag(raw) {
  const t = String(raw ?? '').trim().toLowerCase().replace(/^#+/, '')
    .replace(/[^\p{L}\p{N} -]/gu, '')
    .replace(/\s+/g, ' ').replace(/^[ -]+|[ -]+$/g, '')
  return t.slice(0, MAX_TAG).replace(/[ -]+$/, '')
}

/** Tags with more added: cleaned, without repeats, no more than MAX_TAGS. */
export function addTags(tags, raw) {
  const out = [...tags]
  for (const r of [].concat(raw)) {
    const t = cleanTag(r)
    if (t && !out.includes(t)) out.push(t)
  }
  return out.slice(0, MAX_TAGS)
}
