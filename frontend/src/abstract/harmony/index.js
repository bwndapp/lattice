import { asPattern, code, normalize, parts } from './model.js'

/** The harmony engine: chords, bass, melody and arp in one key (see model.js; HarmonyPanel.jsx is its window). */
export default {
  type: 'harmony',
  label: 'harmony',
  blurb: 'Chords, a bass line, a melody and an arp, all in one key: roll a progression and wire a layer into Syrup to play it',
  layers: ['chords', 'bass', 'melody', 'arp'],
  normalize,
  code,
  parts,
  asPattern,
  width: 900,
}
