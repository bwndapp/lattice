# Plan: tidy the effects, one plugin format, then a Faust node editor

*September 2026. Planning only; no app code changed. Builds on `docs/research/plugin-engine.md` (commit ce6aa94).*

**In one line:** lattice has about 35 ways to change a sound, built five different ways and spread across six places. First tidy what users see (Phase 0). Then put every effect and instrument on one plugin spec (Phase 1). Then add a Faust runtime (Phase 2) and a node editor where users build their own plugins (Phase 3), which they can then share (Phase 4).

---

## 1. Decisions the user needs to make

| # | Decision | Recommendation |
|---|---|---|
| D1 | **Per-note Strudel effects** (the instrument's cutoff, reso, low cut, drive, crush, attack, release, pitch knobs): keep them, or fold them into bus effects? | **Keep them, renamed "sound" knobs.** They are cheap, exact per note, and they survive in pasted Strudel code. Everything placed on a wire or in a rack becomes an "effect", and effects always run on the bus. |
| D2 | Old duplicate nodes (`space`, `drive`, `level`, `clipper`/`softclip`): hide them or migrate them? | **Hide them in Phase 0** (old tracks still load and play). **Migrate them automatically in Phase 1**, with tests. |
| D3 | **Pan and gain ranges**: pan is 0–1 today and gain is linear 0–1.5. Change the stored values (to −1…1 and dB), or only change how they are shown? | **Show-only in Phase 0** (L/C/R, dB readout). Change the stored values in Phase 1 through the project migration. |
| D4 | The **compressor** moves from the browser's black box to a worklet with a sidechain input. Old tracks will sound slightly different. | Accept it, and keep the browser version as the `classic` mode for old tracks. |
| D5 | The **shared reverb/delay** (the `g_rv`/`g_dl` sends behind every instrument's reverb and delay knobs) is invisible and can't be set. | Show it as a "send" bus with its own settings in Phase 1. |
| D6 | **Faust bundle** is about 6 MB (the compiler), loaded only when someone opens the editor or a track that uses a user plugin. Host it ourselves or use a CDN? | **Host it ourselves**, loaded on demand. Built-ins never need it. |
| D7 | Does the editor ship **before or after** the migration? | **After the Phase 1 core only**: spec, host, automation and 3–4 migrated effects. The rest of the migration can continue alongside Phases 2 and 3. |
| D8 | **Sharing**: can anyone publish at once, or is there review first? What is the default licence? | Anyone can publish Faust-only plugins with auto-generated UI. A "verified" badge comes from review. Default licence: CC BY-SA. |

---

## 2. Inventory: everything a user can reach today

**Legend.** *Where it runs:* **note** = superdough per-note param (a fresh chain for every note); **insert** = a lattice bus unit from `stereo.js` `UNITS` on an orbit rack; **send** = a `fxbus.js` reverb/delay; **worklet** = a custom AudioWorklet; **engine** = an instrument engine (`instruments/`). *Auto* = can follow an automation lane: *rAF* means it is pushed at about 60 Hz through `APP_PARAMS`, *code* means it is evaluated per note in the generated code. *Mod* = can be modulated (only inside Syrup today). Every item below renders in export (`exportAudio.js` awaits `prepareInserts`/`prepareInstruments`) unless marked otherwise.

### 2.1 Patch nodes (`graph.js` `NODE_TYPES`, add menu)

| Shown as (key) | Group | Where it runs / impl | St | Auto | Rack | Lane | Quirks |
|---|---|---|---|---|---|---|---|
| filter (`filter`) | effects | insert `filter` (biquads) | st | rAF | ✓ | ✓ | Same knob names as the per-note cutoff/reso/low cut |
| dj filter (`djfilter`) | effects | insert `djfilter` | st | rAF | ✓ | ✓ | |
| space (`space`) | effects | 2 sends, `rv_`/`dl_<node>`; delay time in **bars** | st | code (mix) + rAF (time) | ✓ | ✗ | A worse copy of reverb + delay |
| reverb (`reverb`) | effects | send; JS-generated IR, 2 convolver slots | st | rAF, mix via code | ✓ | ✓ (dry path added) | Rebuild params, debounced 90 ms |
| delay (`delay`) | effects | send; tone/HPF/tanh feedback | st | rAF (fb, tone); time is a select | ✓ | ✓ | Time in note divisions |
| level (`level`) | effects | insert `fader` (gain + pan) | st | rAF | ✓ | ✓ | Duplicates `utility` and the bus fader |
| drive (`drive`) | effects | insert `shaper` (scurve) + crush | st | rAF | ✓ | ✓ | Same label as the per-note "drive" knob |
| distortion (`distortion`) | effects | insert `dist` (node "pedal") | st | **none** (no `APP_PARAMS` row) | ✓ | ✓ | Automation lanes can be drawn but seem not to move it live |
| pitch (`pitch`) | effects | worklet `lattice-pitch` | st | **none** | ✓ | ✓ | `fine` is cents but has unit `bi` |
| freq shift (`freqshift`) | effects | worklet `lattice-freqshift` | st | **none** | ✓ | ✓ | |
| phaser / chorus / flanger / tremolo | effects | inserts (node graphs + LFOs) | st | rAF | ✓ | ✓ | Rate has no unit (Hz implied); no tempo sync |
| vowel (`vowel`) | effects | insert (3 formant peaks) | st | select only | ✓ | ✓ | |
| lo-fi (`lofi`) | effects | worklet `lattice-coarse` | st | rAF | ✓ | ✓ | "grit" is an int 1–32; crush elsewhere is 0–1 |
| sidechain (`sidechain`) | effects | superdough `duckorbit` (note-triggered) | — | code | ✗ | ✗ | Not an audio sidechain; one trigger only |
| fx rack (`fxrack`) | effects | chain of units on one orbit | st | `u:` targets | — | — | Its picker is a flat `<select>` of 26 items (`Graph.jsx:448`) |
| 3-band eq (`eq3`) | eq, dynamics & stereo | insert `eq` (3 biquads) | st | rAF | ✓ | ✓ | |
| saturator (`saturator`) | eq, dyn & st | insert `shaper`, 6 curves | st | rAF | ✓ | ✓ | `out` is linear 0.05–1, labelled "output" |
| hard clip (`clipper`) / soft clip (`softclip`) | eq, dyn & st | insert `shaper` | st | rAF | ✓ | ✓ | Two nodes for one unit; "output" is linear here but dB on the limiter |
| compressor | eq, dyn & st | `DynamicsCompressorNode` + makeup | st | rAF | ✓ | ✓ | No key input, no lookahead |
| limiter | eq, dyn & st | worklet `lattice-limiter`, 3 ms lookahead | st | rAF | ✓ | ✓ | Latency is not reported or compensated |
| transient (`punch`) | eq, dyn & st | **note**: superdough `transient-processor` via `fmap` | mono→pan | code | ✓ | ✗ | The only per-note effect shown as a bus effect; the key and label differ |
| haas / stereo widener / utility | eq, dyn & st | inserts (node graphs) | st | rAF | ✓ | ✓ | Utility gain is in dB; level and bus vol are linear |
| mixer bus (`bus`) | combine | orbit + `fader`, `declareRoute` | st | rAF | ✗ | ✗ | Per-channel faders 0–1.5 linear |
| echo (`echo`) | transform | Strudel pattern echo (repeats notes) | — | code | ✗ | ✗ | Search "delay" finds it next to the real delay |
| every / sometimes → "bitcrush" (`APPLY.crush`) | transform | per-note `crush(4)` | — | — | — | — | A third crush |

### 2.2 Instrument "sound" knobs (`project.js` `PARAMS`, per channel)

vol, pan, **cutoff, reso, low cut** (note filters), **reverb, delay** (sends to the shared `g_rv`/`g_dl`, fixed settings), pitch (drums: `speed`), attack/release (synths), **drive** (`shape`), **crush**. All are per note, automatable per note (`c:` targets), and can't be modulated. Every channel also has a free-text `fx` string of raw Strudel (`project.js:330`), so any superdough effect (phaser, vowel, coarse, …) is reachable per note in code, and code nodes reach all of them.

### 2.3 Instruments

| Shown as | Where | Impl | Notes |
|---|---|---|---|
| kick, snare, clap, hat, open hat, rim, tom, crash | add menu "instruments", Rack | samples, with kit banks (`BANKS`) | |
| bass, lead, pad, pluck | add menu | superdough oscillators + note params | Presets are defined as raw `fx` strings |
| piano | add menu | soundfont | |
| **kick synth** | add menu; sound picker "engines" (drum) | engine `kick`: worklet, 4 voices, 25 params, own panel | Has its own drive group, a fourth drive |
| **syrup** | add menu; sound picker "engines" (synth) | engine `syrup`: 8 voices, 8 layers, 16 mods, **3 lanes of bus fx** (`laneFx.js`, `LANE_FX_CATALOG`) | Lane fx are app units driven by `postMessage` modulation; the `K` param table is its own format |
| code | add menu | code channel | |
| sound picker tabs | Rack | drum: `kits`, `samples`, `engines`; synth: `synths`, **`instruments`** (soundfonts), `samples`, `engines` | "instruments" means soundfonts here but channels elsewhere |

The piano roll and the detail dock have no effects of their own; they edit notes and the channel's knobs.

---

## 3. The mess

1. **Same effect, many forms.**
   - *Filter:* a per-note knob, a bus node, and a lane effect. The labels are identical, but they behave differently: per note, the filter is fixed at the note's start.
   - *Reverb:* a per-note send to a hidden shared reverb, the `space` node, the `reverb` node, and a Syrup lane (with a dry path added).
   - *Delay:* the same set of four, plus `echo`, which isn't audio.
   - *Drive/crush:* the per-note drive and crush, the `drive` node, `saturator`, `distortion`, `clipper`, `softclip`, `lofi`, `APPLY.crush`, and the kick's own drive.
   - *Volume/pan:* the channel knobs, `level`, `utility`, and the bus fader.
2. **Names don't match keys or each other.** `punch`→"transient", `shape`→"shuffle", `sound`→"rhythm", `notes`→"melody", `clipper`→"hard clip". Wet level is called "amount" (chorus, flanger, haas, reverb, delay) or "mix" (pitch, freqshift, distortion). "output" is sometimes linear and sometimes dB. "pitch" means granular shift (node), sample `speed` (drum knob) and a Syrup layer's semitones.
3. **Ranges and units are inconsistent.**
   - Pan is 0–1 everywhere, with no L/C/R display.
   - Gain is linear 0–1.5 in three places and dB in two.
   - Crush is 0–1, but lo-fi grit is an int 1–32.
   - Delay time is given as bars (space), divisions (delay) or cycles (echo).
   - Rate knobs have no unit and no sync.
   - Unit `bi` is used for semitones, cents, Hz and plain bipolar values, while Syrup uses `ct` and `st` for the same things.
4. **Four param formats.** `NODE_TYPES` params (`type: knob|int|select`, `options`), engine params (`group`, `choices`, as an index), Syrup's `K` table, and the processors' `parameterDescriptors`. There is also a fifth list, `APP_PARAMS`, that must be kept in step by hand.
5. **Automation gaps.** `distortion`, `pitch` and `freqshift` have no `APP_PARAMS` row, so their lanes seem to do nothing on playback (to be confirmed in Phase 0). Bus params move at about 60 Hz from the UI thread, and export uses `suspend()` stepping.
6. **Available in one place, not another.**
   - `space` and `punch` can't go in a Syrup lane (they have no `code.insert`).
   - `sidechain` and `bus` can't go in a rack.
   - Instrument lanes exist only in Syrup; the kick has none.
   - The per-note sends can only reach the one hidden reverb and delay.
   - Modulation exists only inside Syrup.
7. **Confusing add menu.** Two groups share the effects: "effects" and "eq, dynamics & stereo". Distortion is under effects, but saturator and the clippers are under mixing. `fxrack` and `sidechain` sit among the plain effects. A per-note effect (`punch`) sits among bus effects. The sound picker's "instruments" tab clashes with the add menu's "instruments" group.
8. **Hidden layer rules.** `BUS_NODES` run after all per-note nodes, whatever the wire order, and nothing in the UI says so.
9. **Dead code.** `live.js` (`liveBus`, the `.bmod` live-knob scheme) is imported nowhere. Nothing tests `STEREO_TYPES`, `FX_UNITS`, `LANE_FX` or `APP_PARAMS` against each other.

---

## 4. Phases

Hot files that force tasks to run **one after another**: `graph.js`, `Graph.jsx`, `automation.js`, `App.jsx`, `stereo.js`, `fxbus.js`. Tasks marked **∥** touch none of them, or only new files, and can run in parallel. Tests go in `frontend/test/*.test.mjs` (run with `node --test`).

### Phase 0: quick-win tidy (days, **S–M**)

**Goal:** a user sees one clear set of effects, with consistent names and units, without any change to how audio runs.

**After it, users can:** find any effect in a menu grouped by what it does; tell "sound" knobs (per note, on the instrument) from "effects" (on the wire, on the whole sound); read pan as L/C/R and levels in dB.

**The mental model shown in the UI:**
- *Instruments* make sound.
- *Sound knobs* shape each note.
- *Effects* process everything wired into them.
- *Routing* (bus, sidechain, stack, sequence, arrange) moves sound around.
- *Pattern tools* (transform) change the notes, not the audio.

| Task | Files | Order |
|---|---|---|
| 0.1 Verify and fix the automation gaps: add `APP_PARAMS` rows for distortion, pitch and freqshift, plus a test that every knob of every `BUS_NODES` type has a row | `automation.js`, test | seq (automation.js) |
| 0.2 Add a `cat` field to effect types: filter & eq, drive & crush, space (reverb/delay), modulation, dynamics, stereo & utility, pitch. Rename the groups: sources · instruments · pattern tools · effects · routing · output | `graph.js` | seq |
| 0.3 Add-menu flyout with category sub-headings; hide types marked `hidden: true` (`space`, `drive`, `level`) from the menu and search while old tracks still load them; put the clippers next to each other | `AddMenu.jsx`, `AddMenu.css`, `Graph.jsx` (`SEARCH_WORDS`, `paletteItems`) | seq after 0.2 |
| 0.4 Label pass: "mix" for every wet/dry knob; key and label aligned (`punch`: "transient shaper"); "echo" → "note echo"; blurbs say "per note" or "on the bus" | `graph.js`, `project.js` (`PARAMS` labels only) | seq after 0.2 |
| 0.5 Display units ∥: a `fmt` hint on params (`pan`→L/C/R, `gain-lin`→dB readout, `ct`, `st`, `hz`, `ms`); replace `bi` with `origin` + a real unit | `knobMath.js`, `Knob.jsx`, `KnobMenu.jsx`, then unit strings in `graph.js` and `kick.js` | knob files ∥; graph.js part seq |
| 0.6 Rack picker and Syrup lane picker grouped by `cat` (`<optgroup>`), from one shared helper | `Graph.jsx` (FxRack), `instruments/syrup/SyrupPanel.jsx` | seq (Graph.jsx) |
| 0.7 Sound picker ∥: "instruments" tab → "soundfonts", "engines" → "lattice synths" | `SoundPicker.jsx` | ∥ |
| 0.8 Channel knob panel headed "sound (per note)"; the reverb/delay knobs say "send" | `Rack.jsx`, `DetailDock.jsx` | ∥ |
| 0.9 Dead code ∥: delete `live.js`; add a consistency test that `FX_UNITS` ⊇ `LANE_FX`, every `STEREO_TYPES` entry has `code.insert` or is `bus`, and every `NODE_TYPES` knob has min<def<max and a known unit | `live.js`, `test/fxcatalog.test.mjs` | ∥ |
| 0.10 Changelog line when published | `changelog.js` | last |

**Risks:** hiding nodes might confuse people who already use them (mitigation: they stay on existing tracks, and search still finds them with a "(older)" tag). **Acceptance:** every existing track plays unchanged (the same code is generated: snapshot test on the demo projects in `project.js`); the add menu has ≤7 top groups; every effect has a category; distortion, pitch and freqshift lanes move the sound.

### Phase 1: one lattice plugin spec (**L–XL**)

**Goal:** every built-in effect and instrument is described once, hosted once, and automated sample-accurately.

**After it, users can:** put any effect anywhere (a rack, a lane on any instrument, a send); automate any bus knob smoothly, identically in export; use a real sidechain input on the compressor; save and load presets for any effect; set the shared send reverb/delay.

**The spec** (from the research, §Stage 1), `frontend/src/plugins/spec.js`:
`{ id, version, label, cat, blurb, role: insert|send|instrument, io: {inputs:[{name,ch,sidechain?}], outputs:[{ch}]}, params:[{id, label, min, max, def, curve: lin|log|exp, unit, fmt?, origin?, choices?, step?, automatable, modulatable, smooth: seconds|'rebuild'}], groups, ui: {layout, width, scope?}, state: {normalize, extra?}, latency, tail(state), dsp: {kind: graph|worklet|faust|wam, …} }`. Param ids are stable forever. Modulation follows CLAP: value = base + Σ offsets on 0–1 travel.

| Task | Files | Order |
|---|---|---|
| 1.1 Spec, validator, registry and adapters that *generate* `NODE_TYPES` effect entries, `FX_UNITS`, `LANE_FX` and `APP_PARAMS` rows from specs | new `plugins/spec.js`, `plugins/index.js`, test | ∥ (new files) |
| 1.2 Host: `makeUnit(spec, ac)` → `{input, output, param(id), set, dispose}` for `graph` and `worklet` kinds; the generalised `prepare*()` barrier | new `plugins/host.js`; thin hooks in `stereo.js` `makeInsert` and `fxbus.js` `makeSendEffect` | seq (stereo/fxbus) |
| 1.3 Null-test harness: render fixture tracks with `exportAudio` in a dev page (`/preview/?nulltest`) and compare against stored RMS/peak and spectrum fingerprints, pass/fail in one click | new `tools/nulltest/`, `exportAudio.js` hook | ∥ |
| 1.4 Sample-accurate automation: schedule curves ahead (`setValueCurveAtTime`, 100 ms lookahead) via `param(id)`; retire the rAF push and the export `suspend()` stepping behind a flag | new `plugins/automate.js`, `App.jsx`, `exportAudio.js`, `automation.js` | seq |
| 1.5 Project migration: `project.version`, and `migrate(raw)` maps `space`→reverb+delay nodes, `drive`→saturator(+lofi), `level`→utility, `clipper`/`softclip`→`clipper{knee}`, pan 0–1→−1…1, and linear gains→dB (D3). Nodes gain `data.plugin = {id, version}` | new `project-migrate.js`, `project.js` (load path), `test/migrate.test.mjs` with 10+ fixture tracks | seq after 1.1 |
| 1.6a–n Migrate the units one per session, each with a null test (see the order below) | the unit moves from `stereo.js`/`fxbus.js` into `plugins/builtin/<id>.js` | seq in pairs (stereo.js) |
| 1.7 One send path: shared (`g_rv`), per-node (`rv_<id>`) and lane (dry + wet) all come from `role: 'send'`; the shared sends become a visible "send" in the mixer (D5) | `fxbus.js`, `laneFx.js`, `graph.js` | seq, after reverb/delay migrate |
| 1.8 Worklet compressor with `key` input (a sidechain wire on the node), lookahead and a `classic` mode (D4); the `sidechain` node is renamed "duck (note-triggered)" | `plugins/builtin/compressor.js`, `graph.js`, `Graph.jsx` (second port) | seq |
| 1.9 Instruments: `kick` onto the spec (`role: instrument`, `worklet` dsp), then `syrup` (`state.extra` = layers/mods/routes; the `K` table becomes spec params; lanes host any `insert` plugin) | `instruments/kick.js`, `instruments/index.js`, `instruments/host.js`, `syrup/*` | seq; syrup last |
| 1.10 Lanes for every engine (the kick gets lanes) and presets per plugin (save/load/rename, stored per user) | `instruments/laneFx.js`, new `plugins/presets.js`, `src/api/presets.py` | ∥ after 1.2 |
| 1.11 (optional, M) A patch-level `lfo` node that can target any `modulatable` param as an offset | `graph.js`, `Graph.jsx`, `plugins/automate.js` | seq, last |

**Migration order** (simplest and least-used first; one or two per session; each ends with a null test):
1. utility, haas, widener (pure graphs)
2. eq3
3. filter, djfilter
4. fader (level, bus)
5. the shaper family (saturator, drive, clippers)
6. distortion
7. tremolo, phaser, chorus, flanger, vowel
8. lofi, pitch, freqshift (worklets)
9. limiter (report latency)
10. compressor (1.8)
11. reverb, delay (1.7)
12. `punch`: a new bus transient worklet; the per-note version is kept only for old tracks via migration
13. kick
14. syrup

**Per-note effects (D1):** they stay as instrument "sound" knobs and in code. They don't become plugins. The spec gains a `noteParams` hint so the UI can say "per note".

**Saved tracks stay compatible:**
- `migrate()` runs on every load, before `normalizeGraph`, and is idempotent.
- Old keys map through a `WAS_CALLED`-style table.
- `node.type` names stay valid forever as aliases.
- Tests load every fixture, migrate it, and check the generated code and the null-test fingerprints.
- Collab peers on older builds get a version bump notice instead of silently corrupting the document.

**Dependencies:** Phase 0. **Risks:** a refactor of working audio (mitigated by the null tests and one unit per commit); two sessions editing `stereo.js` at once (serialise); Syrup's rig timing. **Open questions:** do we keep the `bmod`-style glide for per-note knobs? Do presets live per user or per track? **Acceptance:** all built-ins are registered from specs; `APP_PARAMS` is deleted; the old tracks' null tests pass within −60 dB (or documented changes for D3/D4); automation in export matches live playback; any insert can sit in a kick or Syrup lane.

### Phase 2: Faust runtime (**L**)

**Goal:** lattice can compile Faust source in the browser and run it as a plugin, live and in export.

**After it, users can:** add a "Faust code" effect (behind a labs flag), type DSP, hear it reload with a cross-fade, and get knobs for free.

| Task | Files | Order |
|---|---|---|
| 2.1 Bundle `@grame/faustwasm` served from our own origin and lazy-loaded (D6); measure the size and first-load time | `package.json`, `vite.config.js`, new `plugins/faust/load.js` | ∥ |
| 2.2 Compile in a Worker: source → `{WebAssembly.Module, json, errors[{line,msg}]}`, with a 5 s timeout | new `plugins/faust/worker.js` | ∥ |
| 2.3 Cache: IndexedDB keyed by `sha256(source + faust version + flags)`, plus an in-memory map | new `plugins/faust/cache.js` | ∥ |
| 2.4 `dsp.kind: 'faust'` in the host: one processor name per hash (`lattice-f-<hash>`) with its own `addModule`; Faust JSON → spec params (`[unit:]`, `[scale:log]`, `[style:menu]`); in/out counts → mono/stereo; poly `nvoices` via the note protocol | `plugins/host.js`, new `plugins/faust/adapter.js` | seq after 1.2 |
| 2.5 Hot swap: two slots with a 30 ms equal-power cross-fade; carry params over by label path; keep the last good build on error | `plugins/host.js` | seq |
| 2.6 Export: `prepare()` compiles every Faust plugin used by the track into the `OfflineAudioContext` | `exportAudio.js` | seq |
| 2.7 CPU budget: benchmark each build offline (render 2 s, time it) → cost; a per-track budget; an over-budget plugin is bypassed with a badge; worklet-side underrun counter where available | new `plugins/budget.js`, badge in node UI | ∥ |
| 2.8 Parity proof: `eq3` rewritten in Faust (`plugins/builtin/eq3.dsp`), compared with the built-in by frequency response (±0.2 dB, 20 Hz–20 kHz) and on the null-test fixtures | test + `tools/nulltest` | after 2.4 |
| 2.9 Denormal guard and templates (gain, filter, delay, synth voice) with `ma.EPSILON` idioms | `plugins/faust/templates/` | ∥ |

**Dependencies:** 1.1, 1.2 and 1.4 (it doesn't need the full migration). **Risks:** compile latency on big DSP; Safari's worklet WASM quirks; a 6 MB first load. **Open questions:** do we allow the Faust `soundfile` primitive (no, at first)? **Acceptance:** a Faust effect runs live and in export with an identical render; editing re-compiles in <1 s for small DSP without a click; `eq3.dsp` matches the built-in within tolerance; an over-budget plugin is bypassed, not glitching.

### Phase 3: Faust node editor MVP (**XL**)

**Goal:** users build their own effect or synth by wiring blocks in a plugin window, and it compiles to Faust.

**After it, users can:**
- open "new plugin" and wire blocks such as osc → filter → env → out;
- drop in a raw Faust node;
- mark knobs as exposed, and get a front panel;
- save presets;
- use the plugin on any wire or as an instrument, and have it saved in the track.

**Shape:** a floating plugin window (the same shell as `instruments/SynthWindow.jsx`), with its **own** React Flow canvas that reuses the patcher's patterns (wires, quick-wire, knife) but none of `Graph.jsx`'s state. This follows the self-contained synth-module rule. Its data model is `{blocks, wires, exposed, voice: 'poly'|'mono'}`.

| Task | Files | Order |
|---|---|---|
| 3.1 Model, normalize, limits (≤200 blocks) and cycle rule (a cycle is only allowed through a `feedback` block) | new `plugins/grid/model.js`, test | ∥ |
| 3.2 Block library (~20): sine/saw/square/tri osc, noise, lowpass/highpass/bandpass (SVF), ADSR, LFO, delay, reverb (`re.zita_rev1`), drive, add/mul/scale, mix, pan, in, out, **feedback** (explicit one-block delay), note in (freq/gate/gain) | new `plugins/grid/blocks.js` | ∥ |
| 3.3 Codegen graph → Faust (topological sort, `~` for feedback, one `hslider` per exposed knob with its unit and scale); snapshot tests, plus compile tests run in Node with faustwasm | new `plugins/grid/codegen.js`, test | after 3.1/3.2 |
| 3.4 Window and canvas: block nodes, typed ports (audio/control), wire validation | new `plugins/editor/PluginWindow.jsx`, `BlockNode.jsx`, `editor.css`; register in `instruments/windows.js` | ∥ with 3.3 |
| 3.5 Raw Faust node: CodeBox editor; its ports come from the compiled inputs/outputs; errors shown inline | `plugins/editor/FaustNode.jsx` | after 2.2 |
| 3.6 Expose-a-knob and front panel: an auto layout, with range, curve and label editable | `plugins/editor/Panel.jsx` | after 3.4 |
| 3.7 Compile loop: debounce 300 ms, keep the last good build, pin errors to blocks | `plugins/editor/useCompile.js` | after 2.5, 3.3 |
| 3.8 Save in the track: `project.plugins[hash] = {grid, source, spec}`; a node `{type:'plugin', data:{plugin:{id,hash}, params}}`; collab ops; size cap | `project.js`, `graph.js`, `Graph.jsx`, `project-migrate.js` | seq |
| 3.9 Presets and templates, and add-menu entries: "new plugin…" and "my plugins" | `AddMenu.jsx`, `plugins/presets.js` | seq (after 0.3) |
| 3.10 Instrument role: a poly grid becomes a channel engine (the sound picker lists "my synths") | `instruments/index.js`, `SoundPicker.jsx` | after 1.9 |

**Dependencies:** Phase 2. 3.1, 3.2 and 3.4 can start during Phase 2. **Risks:** UX scope (keep to 20 blocks); compile lag while patching; per-voice vs shared confusion (MVP: the whole grid is one voice-type). **Open questions:** do plugins nest inside plugins (later)? How do Grid control signals (0–1 vs Hz) convert (a VCV-style convention: control is 0–1, pitch is Hz)? **Acceptance:** a user builds a filtered-saw synth and a feedback delay without writing code; the codegen tests pass; the plugin plays identically after a reload, in export and for a collab peer; a Faust error shows on the right block and the sound keeps playing.

### Phase 4: sharing and a library (**L**)

**Goal:** a plugin can be published, found and used like a track, safely.

**After it, users can:** publish a plugin; browse and search by tag; add someone's plugin to a track; fork it; get told when a new version exists, without it changing under them.

| Task | Files | Order |
|---|---|---|
| 4.1 API: publish/fetch/list plugins, content-addressed by source hash, with versions, tags and licence | new `src/api/plugins.py` (draft DB) | ∥ |
| 4.2 Load path: always re-compile from source (never trust uploaded wasm) and verify the hash | `plugins/faust/*` | ∥ |
| 4.3 Browse tab: search, tags, preview audio, "add to track", fork | `Browser.jsx`, `Browser.css` | ∥ |
| 4.4 Version pinning in tracks: `plugin:{id, version, hash}`, source embedded when private ("freeze"), an "update available" chip | `project.js`, `project-migrate.js` | seq |
| 4.5 Safety: Faust-only for shared plugins; CPU guard badge; report/hide; a "verified" flag that unlocks custom panels (D8) | `plugins/budget.js`, API | after 4.1 |

**Risks:** abuse and review load; runaway CPU in shared tracks. **Acceptance:** a track using a shared plugin plays for a logged-out visitor with the pinned version; unpublishing doesn't break tracks (the source is embedded).

### Phase 5 (optional): WAM2 (**M**)

Host curated, pinned WAM2 URLs only (`dsp.kind: 'wam'`: params, state, automation events, notes as MIDI), and export Faust-based lattice plugins as WAM2 via faustwasm's generator. Only after Phase 4's safety model exists.

---

## 5. Summary of effort and order

| Phase | Effort | Can start when | Runs in parallel with |
|---|---|---|---|
| 0 Tidy | S–M (days) | now | — |
| 1 Plugin spec + migration | L–XL | Phase 0 | the tail of 1.6 alongside 2 and 3 |
| 2 Faust runtime | L | 1.1, 1.2, 1.4 | the rest of 1.6–1.10 |
| 3 Node editor MVP | XL | 2.2–2.5 (3.1, 3.2, 3.4 earlier) | 1.9, 4.1 |
| 4 Sharing | L | 3.8 | — |
| 5 WAM2 | M | 4.5 | — |
