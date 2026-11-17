/**
 * What's changed, newest first.
 *
 * It ships with the app rather than coming from a server, so a browser that has the new
 * build has the news that goes with it — there's nothing to get out of step. Anything
 * newer than the last entry someone has seen is shown once, when they open lattice.
 *
 * **Features only.** What someone can now do with lattice that they couldn't before, in
 * their words. Nothing from behind the scenes — no infrastructure, no refactors, no
 * publishing or storage work, no fixes for things nobody noticed. If a line doesn't change
 * what a person can do or hear, it doesn't belong in here.
 *
 * A line is a line, not a sentence: name the thing in **bold**, say what it does in a few
 * words, stop. Someone reads this standing up, deciding whether to go and try something.
 *
 * Each entry is a release with a number. Numbering starts at 0.1.0, the first release with
 * this list in it; the three before it are numbered back from there, since they happened
 * whether or not anyone was counting. While lattice is 0.x: the middle number moves when
 * there's something new to use, the last one when something already there got better.
 *
 * `id` orders the entries and is what a browser remembers having seen, so it only ever
 * grows: two on the same day are `2026-09-19` and `2026-09-19-2`. `date` is what's shown.
 * The version is for people to say out loud; the id is for the machine.
 */
export const NEWS = [
  {
    id: '2026-11-17-1',
    date: '2026-11-17',
    version: '0.18.0',
    title: 'B4SS, and a tighter timeline',
    items: [
      '**B4SS**: a new bass synth — 808s that drop and slide, wobbles in time with the song, growls, yois, riddim chops, reese and space basses, with a clean sub under it all and 19 presets',
      '**Move an instrument** to another pattern, or a pattern of its own, from its row in the rack: its wiring comes with it',
      '**Timeline**: zoom in much further, smoothly and into the cursor, with 1/8, 1/16 and triplet snaps',
      '**Clips play what they show**: a moved, trimmed or sliced clip of a pattern a machine fires starts its rhythm where the clip does, and the pattern’s own playhead follows its clip',
      '**Automation**: shift-drag a point to lock it to its value or its time; curves hold from the very first note, in export too',
      '**Fixed**: a bright blip at the start of playback from effects warming up',
      '**Fixed**: stopping in a jam could start again a few seconds later',
    ],
  },
  {
    id: '2026-11-16-3',
    date: '2026-11-16',
    version: '0.17.0',
    title: 'A mixer in the dock, and parts of their own',
    items: [
      '**Click a mixer bus** and its channels open along the bottom: a fader and a live meter each, plus the bus’s own — drag strips to reorder',
      '**Reorder instruments** in a pattern’s rack by dragging their ≡ grip',
      '**On the timeline**, every pattern a rhythm machine fires is a part of its own: arrange each one, still on the machine’s rhythm',
      '**Fixed**: adding or removing an effect let half a second of the unprocessed track through',
      '**Fixed**: unwiring an instrument’s own out puts it back on the main',
    ],
  },
  {
    id: '2026-11-16-2',
    date: '2026-11-16',
    version: '0.16.0',
    title: 'A real sidechain, and sharing in one place',
    items: [
      '**Sidechain, rebuilt**: the sound is shaped by the trigger’s own audio, sample by sample, so it pumps exactly with the kick and is never late — **clean** for a tight pump, **ring** for gritty ring-mod',
      '**Any trigger**: wire the kick from its saturator or fx rack and that’s what drives the sidechain',
      '**Share**: one button for who can open a track, its link, and jamming on it together — changes apply at once',
      '**Browse is a list**: play, see the shape, the artist, tags, bpm and plays at a glance',
      '**Alt + S** solos everything on a node’s line; **Alt + B** bypasses the selected nodes',
      '**A sound sent two ways** (dry and through an effect) now plays down both',
      '**Fixed**: switching on the stream’s audio could silence everything',
    ],
  },
  {
    id: '2026-11-16',
    date: '2026-11-16',
    version: '0.15.0',
    title: 'Groove and harmony engines',
    items: [
      '**Groove engine**: a rhythm machine that knows styles — house, breaks, funk, afro, boom bap, d&b, trap, dembow, dubstep — with density, swing, ghosts and fills, a roll for a new groove and a lock per lane',
      '**Harmony engine**: chords, bass, melody and arp in one key and scale — roll a progression, voice-led chords, a melody that follows them, each lane firing any instrument',
      '**Generators**: the rhythm machines and the harmony engine together in the add menu',
      '**Fx racks open in a sidebar**: the node shows its chain at a glance, a click opens the whole rack',
      '**Double-click any knob** to reset it; Enter types a value',
      '**Cleaner wires**: taut by default, and wires that run backwards go round underneath',
      '**Stream the sound itself**: turn on audio on the stream node for a lossless link VLC, OBS or ffmpeg can open',
      '**Stream says what’s playing**: track name, artist, tempo and length for whatever is listening',
      '**A smoother feel** all round: things ease in, knobs lift under the pointer',
    ],
  },
  {
    id: '2026-11-15-2',
    date: '2026-11-15',
    version: '0.14.0',
    title: 'Granulizer, evolving Fibonacci and tighter routing',
    items: [
      '**Granulizer**: chop any sound into grains and spray them back — tiny buzzing grains to long smears, with freeze, feedback, glide, chaos and pitch steps',
      '**Fibonacci evolves**: switch it on and the loops change as the song plays, on Fibonacci timing, so the groove keeps growing',
      '**Tune Physical**: pitch and fine knobs, so a sound fired by a rhythm machine can sit at any note',
      '**Rename any node**: double-click its title — two cubes or racks no longer both say “cube” in the mixer',
      '**Ctrl + M** mutes or unmutes the selected nodes',
      '**Routing does what the wires say**: a reverb or delay after a split stays on its branch, sidechains keep each sound’s effects, and split paths joined again play once',
      '**Automation clips** on the timeline are coloured again',
      '**Stream**: a waveform and a level for each instrument, for TouchDesigner and the like',
      '**Smoother playback** on busy songs',
    ],
  },
  {
    id: '2026-11-15',
    date: '2026-11-15',
    version: '0.13.0',
    title: 'Physical, triggers and a flat look',
    items: [
      '**Physical**: a new synth — pluck, strike, bow or blow a string, bar, drum skin, plate, bell and more, with 29 presets',
      '**Triggers**: rhythm machines fire instruments on your patterns through square trigger ports',
      '**Rhythm machine layers take any number of wires**, and what they fire lights up on the patch',
      '**A cleaner, flat look**: gold only for what\u2019s live',
      '**Ctrl+Space** opens the add picker as a search bar, with a preview of each thing',
      '**Tuning**: set A4 beside the tempo, every pitched note follows it',
      '**Stream node**: send hits and the spectrum live to TouchDesigner and the like',
      '**Steadier playback**: fewer dropped or late notes, especially on busy patches and fast screens',
    ],
  },
  {
    id: '2026-11-14',
    date: '2026-11-14',
    version: '0.12.1',
    title: 'Every Fibonacci hit on the timeline',
    items: [
      '**Fibonacci in bar timing**: its clip now shows every hit, even on loops of 21, 34 and 55',
    ],
  },
  {
    id: '2026-11-11-2',
    date: '2026-11-11',
    version: '0.12.0',
    title: 'Split the bus',
    items: [
      '**Parallel processing**: split a mixer bus into a dry and a wet path, each with its own effects and fader',
      '**The Fibonacci is the clip**: anything wired into it plays with its clip, and stays off the timeline',
    ],
  },
  {
    id: '2026-11-11',
    date: '2026-11-11',
    version: '0.11.2',
    title: 'One clip for the Fibonacci',
    items: [
      '**Fibonacci on the timeline**: one clip plays it, with every instrument wired into it',
      '**Just you in the room**: your other tabs, and dropped connections, no longer show as other people',
    ],
  },
  {
    id: '2026-11-10-8',
    date: '2026-11-10',
    version: '0.11.1',
    title: 'Watch the Fibonacci drift',
    items: [
      '**Drifting loops on the timeline**: a Fibonacci clip shows its loops sliding apart, bar by bar',
      '**Longer rolls**: roll can now land on loops of 34 and 55 steps',
      '**Faster start**: the cube\'s 3D only downloads when you open one',
    ],
  },
  {
    id: '2026-11-10-7',
    date: '2026-11-10',
    version: '0.11.0',
    title: 'Stack the Fibonacci',
    items: [
      '**Keep adding Fibonacci layers**, up to sixteen — loops now run to 34 and 55 steps',
      '**Rhythm machines fire Syrup with no notes drawn**: wire it in and every hit plays',
      '**Duplicate a synth patch** from its window or the pattern rack, and keep going from there',
    ],
  },
  {
    id: '2026-11-10-6',
    date: '2026-11-10',
    version: '0.10.2',
    title: 'Rhythms first',
    items: [
      '**Cube and Fibonacci start silent**: just the rhythm — pick a drum, or wire Syrup in to play it',
    ],
  },
  {
    id: '2026-11-10-5',
    date: '2026-11-10',
    version: '0.10.1',
    title: 'A cleaner Fibonacci',
    items: [
      '**Fibonacci window redone**: one row per loop, each coloured to match its ring',
    ],
  },
  {
    id: '2026-11-10-4',
    date: '2026-11-10',
    version: '0.10.0',
    title: 'Fibonacci, and rhythms that play anything',
    items: [
      '**Fibonacci machine**: four drum loops of Fibonacci lengths that drift against each other — **roll** to hunt for a groove',
      '**Play any sound on a rhythm**: wire Syrup or a melody into a cube or Fibonacci layer and it plays on that layer\'s rhythm',
    ],
  },
  {
    id: '2026-11-10-3',
    date: '2026-11-10',
    version: '0.9.0',
    title: 'Bitcrush',
    items: [
      '**Bitcrush**: fewer bits, lower rate, a mix knob — in **drive & colour**',
    ],
  },
  {
    id: '2026-11-10-2',
    date: '2026-11-10',
    version: '0.8.1',
    title: 'Cube layers on their own',
    items: [
      '**Every cube layer has its own port**: wire one drum into its own effects, like a pattern\'s instruments',
    ],
  },
  {
    id: '2026-11-10',
    date: '2026-11-10',
    version: '0.8.0',
    title: 'The cube',
    items: [
      '**Cube**: a drum machine you twist — four drums ringed round a 3D puzzle, each ring one bar',
      '**Scramble it** for a new groove from the same hits, **solve** to get yours back',
      'Add it from **sources** in the patch; it lands on the **timeline** like any part',
    ],
  },
  {
    id: '2026-11-07',
    date: '2026-11-07',
    version: '0.7.0',
    title: 'Clay, and a roll for drums',
    items: [
      '**A new look**: one soft grey, lit like clay — what\'s on is raised, what\'s off sits in',
      '**Roll button on drum rows**: scatter random hits across every bar',
    ],
  },
  {
    id: '2026-10-08',
    date: '2026-10-08',
    version: '0.6.0',
    title: 'Your picture, everywhere',
    items: [
      '**Your blue wind picture** at the top of the menu',
      '**See who made a track**: their picture on its card and its page',
      '**Pictures in a jam**: everyone in the room shows their picture',
      '**Knobs always turn up and down** when you drag them',
    ],
  },
  {
    id: '2026-09-29',
    date: '2026-09-29',
    version: '0.5.0',
    title: 'A new look',
    items: [
      'Grey chrome, dark where the work is — easier on the eyes for a long session',
      'One **signal** colour, and it only marks what’s live',
      'New mark, icon and share card to match',
    ],
  },
  {
    id: '2026-09-28-2',
    date: '2026-09-28',
    version: '0.4.0',
    title: 'Better knobs, a deeper syrup',
    items: [
      '**Knobs turn smoothly**: double-click to type a value like 2k or -6dB, ctrl/cmd-click to reset',
      '**Syrup modulates more**: each oscillator\'s pitch, envelope times, glide, even other modulators',
      '**Drag an LFO onto a knob** in Syrup to map it',
      '**Unison on every oscillator**, with a blend knob, in place of supersaw',
      '**The knife on several wires** puts one effect on them all through a bus',
      '**Delete a node** and the wires around it join back up',
      '**A tidier mixer bus**, and its input levels now work',
      '**Smaller things**: no banner when you save, typing a name in a synth no longer plays notes, a blank track instead of a blank screen',
    ],
  },
  {
    id: '2026-09-28',
    date: '2026-09-28',
    version: '0.3.0',
    title: 'Frames, faster wiring, and tags',
    items: [
      '**Frames**: ctrl/cmd + F boxes the selected nodes',
      '**Fold a frame** down to its title bar',
      '**Shift + A** with one node selected adds the new one already wired in',
      '**Shift + drag** a node across a wire to drop it inline',
      '**Click the tempo** to type it',
      '**New tracks start at 140 BPM**',
      '**Rename and tag a track** from its page; search finds tags, click one to find more',
    ],
  },
  {
    id: '2026-09-26-5',
    date: '2026-09-26',
    version: '0.2.5',
    title: 'You stay signed in',
    items: [
      '**You stay signed in**: no more being signed out at random',
      '**A plain sign-in button** at the top of the menu',
    ],
  },
  {
    id: '2026-09-26-4',
    date: '2026-09-26',
    version: '0.2.4',
    title: 'A cleaner top bar',
    items: [
      '**A cleaner top bar**: rename your track from the Track tab',
    ],
  },
  {
    id: '2026-09-26-3',
    date: '2026-09-26',
    version: '0.2.3',
    title: 'The kick gets drive and a plugin-style panel',
    items: [
      '**Kick drive** with five curves to pick from, a clean sub underneath, and its own envelope and tone',
      '**The kick panel** looks like a plugin: sections down the side, the hit drawn big, knobs along the bottom',
      '**Everyday knobs up front**, the rest tucked behind “more”',
    ],
  },
  {
    id: '2026-09-26-2',
    date: '2026-09-26',
    version: '0.2.2',
    title: 'Your face at the top of the menu',
    items: [
      '**Your face** at the top of the menu, once you’re signed in',
    ],
  },
  {
    id: '2026-09-26',
    date: '2026-09-26',
    version: '0.2.1',
    title: 'Paste a whole song into code',
    items: [
      '**Code** takes a whole script — consts, sliders and all — and plays its last pattern',
      'A **code** part with a mistake goes quiet instead of stopping the track',
    ],
  },
  {
    id: '2026-09-19-3',
    date: '2026-09-19',
    version: '0.2.0',
    title: 'Pitch, frequency shift, and a code window',
    items: [
      '**Pitch** — semitones up or down, tempo untouched',
      '**Freq shift** — every partial by the same hertz, so a note turns into a bell',
      '**Sidechain** ducks as many sounds as you wire into it',
      '**Code** has a real editor · **⤢ bigger** opens it as a window, like a synth',
      'Clips say when nothing on the patch plays them any more',
      '**Unused in this track**, in the add pane: put a part back, or bin it',
    ],
  },
  {
    id: '2026-09-19-2',
    date: '2026-09-19',
    version: '0.1.1',
    title: 'What’s new, when it’s new',
    items: [
      'This — what has changed since you were last here, once, as you arrive',
      'The **file menu** keeps it, with everything older underneath',
    ],
  },
  {
    id: '2026-09-19',
    date: '2026-09-19',
    version: '0.1.0',
    title: 'Distortion, one octave, engines in time',
    items: [
      '**Distortion** — five pedals: overdrive, crunch, rat, fuzz, octave',
      '**Tighten** keeps the bass out of the clipping · **mix** for parallel drive',
      'One **octave** for the whole app, in the top bar',
      'Typing plays the instrument whose **effects** you\'re on',
      'Synced **LFOs** follow the song, so a sweep keeps its place when you seek',
    ],
  },
  {
    id: '2026-09-18',
    date: '2026-09-18',
    version: '0.0.9',
    title: 'Tracks have a history you can hear',
    items: [
      'Every track has a **page** of its own',
      '**Hear this** — any save, as it stood',
      '**Branch from here** — that save, as a track of yours',
      'Branches say they\'re branches, and point back',
      'Cards **draw their arrangement**, so the list looks like music',
    ],
  },
  {
    id: '2026-09-17',
    date: '2026-09-17',
    version: '0.0.8',
    title: 'The timeline, with more give',
    items: [
      'A white **outline** shows where a clip will land',
      '**Alt** frees the grid',
      '**Triplets** and dotted divisions in the roll and the sequencer',
    ],
  },
]

export const LATEST = NEWS[0]?.id ?? ''
/** What this build of lattice is called. */
export const VERSION = NEWS[0]?.version ?? '0.1.0'
export const SEEN_KEY = 'lattice:news-seen'
