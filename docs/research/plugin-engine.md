# Plugins in lattice: how the audio works today, and how it could become a plugin engine

*Research note, September 2026. No app code was changed.*

**The short version.** Lattice already has two plugin-shaped systems: the instrument engine registry (`frontend/src/instruments/`) and the bus-effect catalog (`NODE_TYPES` in `graph.js` plus the `UNITS` table in `stereo.js`). They work, but every plugin is hand-written JavaScript compiled into the app, and parameters, state, automation and UI are described four slightly different ways. The recommended path is: (1) put every built-in effect and instrument onto one "lattice plugin" spec, (2) let people write DSP in **Faust** (compiled to WebAssembly in the browser) with hot reload, plus a small patch-cable graph editor built on the same runtime, (3) add **WAM2** hosting and export, and (4) share plugins like tracks: content-addressed, versioned, and run under a CPU budget. Stage 1 unlocks all the others and is worth doing on its own.

---

## Part 1 — How lattice's audio works today

### 1.1 Two layers of DSP: Strudel's notes and lattice's buses

Sound starts as **Strudel patterns**. The patch graph is compiled into Strudel code (`graphCode`, `frontend/src/graph.js:861`), and each event reaches **superdough** (Strudel's audio engine, v1.3.0) as a flat object of note params (`s`, `note`, `lpf`, `shape`, `room`, `orbit`, …). superdough builds a fresh Web Audio chain **for every note**: source → filters → `crush`/`shape`/`distort` worklets → tremolo → compressor → pan → phaser … (`node_modules/superdough/superdough.mjs`, roughly lines 780–980, with its own worklets such as `shape-processor` and `ladder-processor` in `worklets.mjs`). The note then lands on an **orbit**, superdough's name for a bus. Each orbit has one reverb and one delay whose settings are "whatever the latest note said" (`superdough.mjs:931–952`), plus a duck gain for sidechain (`superdoughoutput.mjs:207–217`).

So Strudel gives you **per-note effects**, and effects on the sum of several notes are limited to one reverb and one delay per orbit. Most of what lattice adds is about getting past that: real effects on the **summed** sound of a bus. It does this by hooking into superdough's audio controller, not by forking it:

- `fxbus.js` wraps `controller.getBus` (`fxbus.js:116–117`), so a note that asks for bus N gets a lattice router node instead.
- `stereo.js` wraps `controller.getOrbit` (`stereo.js:363–372`), so every orbit numbered 40 or above (`STEREO_ORBIT_BASE`, `stereo.js:296`) gets a **rack** between the orbit and the speakers (`mount`, `stereo.js:380`).

Nothing about this depends on the generated code. The generated code only *moves a sound onto an orbit* (`.orbit(41)`), and the processing lives in the app. That is why pasted code "plays dry" elsewhere, as the comments in `fxbus.js:22` and `stereo.js:8` say.

### 1.2 The declare / commit pattern

Both bus systems work the same way. While the code is generated, each node *declares* what it needs, and the result is committed in one go:

```
beginFx() → declareFx(list, key, kind, params) … → commitFx(list)          fxbus.js:47–62
beginInserts() → declareInsert(list, orbit, key, kind, params) … → commitInserts(list)   stereo.js:305–331
```

`commitInserts` diffs the declared list against the live racks: units whose `kind` changed are rebuilt, new ones are made from the `UNITS` table, all get `unit.set(params)`, and the chain is only rewired when the order changes (`wire`, `stereo.js:421–446`). Moving a knob therefore never rebuilds audio. It is a `set()` that glides AudioParams with `setTargetAtTime` (`smooth`, `stereo.js:504`). This is the core plugin contract lattice already has:

```js
unit = { input: AudioNode, output: AudioNode, set(params), dispose() }   // stereo.js:651–1186
```

### 1.3 The effects one by one

| Effect | Where | How it is built |
|---|---|---|
| **3-band EQ** (`eq3`) | `graph.js:392`, `stereo.js:657` | `lowshelf` → `peaking` → `highshelf` BiquadFilterNodes. The bell's frequency is the geometric mean of the two crossovers, and its Q is derived from their distance in octaves. Params: `low, mid, high` (dB), `lowf, highf` (Hz). |
| **Reverb** | `graph.js:216`, `fxbus.js:209–342` | A send effect. Pre-delay `DelayNode` → high-pass → `ConvolverNode`, with an impulse response *generated in JS* (`roomImpulse`: decaying decorrelated noise, a darkening lowpass, early reflections, energy-normalised). There are two convolver slots, so a new room cross-fades over the old one. Rebuilding the room is debounced 90 ms while a knob turns. |
| **Delay** | `graph.js:234`, `fxbus.js:339–411` | Two `DelayNode` lines, each with tone lowpass → high-pass → `WaveShaperNode` tanh soft-clip → feedback gain. Stereo or ping-pong is chosen by rewiring. Time is tempo divisions × beat seconds. |
| **Shared reverb/delay** | `fxbus.js:36–37`, `graph.js:881–882` | `GLOBAL_REVERB`/`GLOBAL_DELAY` (`g_rv`, `g_dl`) are declared on every build. The instruments' own reverb/delay knobs send to them. |
| **Compressor** | `stereo.js:982` | The browser's `DynamicsCompressorNode` plus a makeup gain. No sidechain input, no lookahead control, fixed curve. |
| **Limiter** | `stereo.js:202–274`, `1007` | A real **AudioWorklet** (`lattice-limiter`): 3 ms lookahead, a running-minimum gain queue, box-smoothed gain, and a hard guard at the ceiling. A `DynamicsCompressorNode` stands in until the module loads. |
| **Saturator / drive / clipper / softclip** | `stereo.js:882` (`shaper`) | One `WaveShaperNode` at 4× oversampling, using a lookup table built from the same curves superdough uses per note (`CURVES`, `stereo.js:515`). The table is rebuilt only when the curve, drive or bit depth changes. |
| **Distortion** | `stereo.js:928` | A "pedal" made of nodes: tighten HPF → voice peaking → pre-gain → `ConstantSourceNode` bias → WaveShaper → DC block → tone LPF, with a wet/dry mix. |
| **Haas / utility / widener** | `stereo.js:1052`, `1093`, `1137` | Pure node graphs: splitter/merger, a delay on one side; a 2×2 gain matrix; mid/side with a decorrelating delay and a high-passed side. |
| **Lo-fi, pitch, frequency shift** | `stereo.js:21–190` | Custom worklets (`lattice-coarse`, `lattice-pitch` using two-head granular pitch shifting, `lattice-freqshift` using a Hilbert allpass pair). All of them live in one source string loaded via a Blob URL (`prepareInserts`, `stereo.js:283`). |
| **Mixer bus** (`bus`) | `graph.js:534–560` | Moves every input onto one orbit, declares a `fader` unit (gain + `StereoPannerNode`, `stereo.js:684`), and `declareRoute` sends that orbit's rack into another orbit's summing node instead of the speakers (`aim`, `stereo.js:399`). |
| **Sidechain** | `graph.js:350–390` | Not an audio sidechain. It uses superdough's `duckorbit`: the *trigger's notes* fire a gain envelope on the ducked orbit. No envelope follower, no key input. |

Every "insert" node gets **its own orbit** (numbered in patch order, `graph.js:871–877`), because superdough only lets a note choose one orbit. A chain of eq → comp → limiter is one rack on one orbit, and the `fxrack` node (`graph.js:521`) folds several units into the same rack.

`STEREO_TYPES` (`graph.js:671`), `BUS_NODES` and `FX_UNITS` (`graph.js:682`) are the lists that say which node types are bus effects. `stereoCode(kind, params)` (`graph.js:656`) is the adapter that turns a node spec into an insert declaration. It also records `code.insert = { kind, params }`, so other hosts, such as instrument lanes, can make the same unit.

### 1.4 Instruments

`frontend/src/instruments/index.js:1–40` documents the **engine spec**, which is already a plugin descriptor:

```
type, label, blurb, kinds ['drum'|'synth'], processor (registered name), voices, oneShot,
params [{ key, group, label, min, max, def, log?, unit?, origin?, choices? }], groups,
tail(data), dsp (worklet source string), width,
normalize(raw), encode(data,{cps}) → {audioParamKey: number}, audioParams,
knobAt(data, key), voicesFor(data), message(data), extraOutputs, rig(ac, node, voices)
```

How it runs (`instruments/host.js`):

- **Loading.** `prepareInstruments` concatenates `DSP_BASE` with every engine's `dsp` string into one module, turns it into a Blob URL, and calls `audioWorklet.addModule` once per AudioContext (`host.js:29–45`).
- **One long-lived processor per instrument**, with one stereo output per voice (`createInstance`, `host.js:145`). Each engine is registered as a Strudel sound named `lattice_<type>` (`registerEngineSounds`, `host.js:307–341`). When Strudel plays a note, the host picks a voice (free, else the oldest) and writes the note into **sample-timed AudioParams**: `v<n>_trig`, `_note`, `_vel`, `_gate`, `_gain`, `_pan`. It then hands Strudel a gated `GainNode` tap on that voice's output (`tapNote`, `host.js:248`). Strudel runs the tap through the note's usual chain, so an engine plays through filters, sends and orbits like a sample would.
- **The base class** `LatticeInstrument` (`instruments/dsp.js:37–153`) turns `static knobs` into `p_<key>` k-rate AudioParams, splits each 128-frame block at trig/gate changes, and calls `noteOn / noteOff / render(voice, L, R, from, to) / beginBlock / endBlock`. It also posts `report()` about 38×/s while the window is open, for scopes.
- **Kick** (`kick.js`) has 25 flat params and 4 voices. Its `KickDrive` class is plain JS inlined into the worklet with `${KickDrive.toString()}` (`kick.js:273–274`), so the panel can run the *same code* to draw the waveform. That is a nice trick for plugin UIs.
- **Syrup** (`syrup/`) is the complex case. It has 8 voices, up to 8 layers, 16 modulators, 3 effect lanes, and a structured patch, with `normalize/encode/message/knobAt` (`syrup/index.js`). Knobs that must be sample-accurate are AudioParams in fixed slots (`l<layer>_<knob>`, `d<mod>_<knob>`). Structure (what each slot is, drawn shapes, routes) goes by `postMessage` (`syrup/model.js:1–20`). Modulation runs inside the worklet every 32 samples (`syrup/dsp.js`). The lanes' effects run *outside* the worklet in a `rig` of ordinary lattice bus units (`syrup/rig.js`, `laneFx.js`). The processor reports modulator values back so the rig can turn those units' knobs, which is only as fast as `postMessage`.

### 1.5 Parameters, automation, modulation

- **Param specs** are declared four ways: node `params` in `NODE_TYPES` (`type: 'knob'|'select'|'int'`, min/max/def/log/unit/origin); engine `params` (the same fields plus `group`, `choices`); Syrup's `K` table (`syrup/model.js`); and the processor's `parameterDescriptors`. They are close to identical, but still separate.
- **Knobs.** `useKnobControl.jsx:42` is one gesture engine for every knob-like control. `knobBridge.live(target, value)` (`knobBridge.js`) moves the sound at once for app-owned params, and writes to the project at most 10×/s. A whole turn is one undo step.
- **Automation** (`automation.js`) targets `n:<node>:<param>`, `u:<node>:<unit>:<param>`, `c:<pattern>:<channel>:<param>` and `e:<pattern>:<channel>:<param>`, with curves in 0–1 of knob travel. It then splits two ways:
  - **Per-note** params are evaluated in the generated Strudel code at each note's start, so they are exact per note but step-wise.
  - **App-owned** params (`APP_PARAMS`, `automation.js:44+`, resolved by `appParam`, `automation.js:69`) are pushed from the UI thread by a `requestAnimationFrame` loop (`App.jsx:~830–880`) through `setFxParams / setInsertParams / setEngineParams`. That is about 60 Hz, jittery, and not sample-accurate. Each target also needs a hand-written row in `APP_PARAMS`.
- **Modulation** exists only inside Syrup (LFOs/envelopes → routes on 0–1 travel). There is no patch-level modulation between nodes.

### 1.6 Export and collaboration

- **Export** (`exportAudio.js`) re-points superdough at an `OfflineAudioContext`. It awaits `prepareInserts()` and `prepareInstruments()` (worklet modules must load before rendering), replays every hap, and steps app-owned automation by `suspend()`ing the render every 50 ms, or 10 ms when an engine's modulators drive its rig (`exportAudio.js:69–70`, `137–148`). This works because every effect is a Web Audio node. **Any future plugin runtime must also run in an `OfflineAudioContext`.** WASM and worklets do; iframes and anything needing the real-time clock don't.
- **Storage and collab.** The whole project is JSON in the first line of the code (`// @project {…}`, `project.js:24`, `253`). Node params live in `node.data`, and engines in `channel.engine = { type, data }` with defaults stripped (`normalizeEngine`, `instruments/index.js:65`). Collab (`collab.js`, `src/api/collab.py`) syncs JSON ops on that document. So plugin *state* is already data-only and collab-friendly. There is simply no place yet for plugin *code*.

### 1.7 What is already plugin-shaped, and the limits

**Seams that already exist:**
1. The engine registry `ENGINES` (`instruments/index.js:43`), with a descriptor that has params, DSP source, voices, state normalisation, encode/message and a rig.
2. The unit contract `{input, output, set, dispose}` (`stereo.js`), with `makeInsert(kind)` (`stereo.js:1188`) and `makeSendEffect` (`fxbus.js:418`) as factories, and `makeLaneEffect` (`laneFx.js`) proving the same unit can be hosted in two places.
3. `NODE_TYPES` as a catalog, with declarative params that auto-generate knobs, and `stereoCode` as the adapter from a node to a bus unit.
4. Worklet source loaded from strings via Blob URLs: the same mechanism user code would use.
5. superdough itself already runs user DSP: `dspworklet.mjs` wraps a user `dsp(t)` function into a worklet, and `GenericProcessor` (`worklets.mjs:~1490–1562`) compiles a ugen graph to a `new Function`. There is precedent, but no sandbox.

**Limits:**
- **Per-note vs per-bus.** A lattice effect is either a note param (superdough) or a bus unit (lattice). A plugin author has to know which, and a bus unit costs an orbit.
- **Routing is serial.** A rack is a straight chain (`wire`, `stereo.js:421`). There is no parallel split, no multi-input unit, no true **sidechain key input**, and ducking is note-triggered.
- **Mostly native nodes.** The compressor is the browser's black box. Biquads and waveshapers can't be modulated per-sample in custom ways. Anything novel needs a worklet, and there are only five today.
- **Automation of bus params is ~60 Hz from the UI thread**, and each new target needs an `APP_PARAMS` row.
- **One module per context.** Each of `prepareInserts` / `prepareInstruments` builds its module once. Adding a new processor later, or hot-reloading one, needs a new `addModule` with a new processor name, because `registerProcessor` names can't be reused.
- **Latency.** Stereo inserts add no latency reporting. The limiter's 3 ms lookahead isn't compensated.
- **No user code, no sandbox, no versioning of DSP.** A saved track names `type: 'kick'` and trusts the app's current kick.
- **No cross-origin isolation.** The preview serves no COOP/COEP headers (checked with `curl -I`), so `SharedArrayBuffer` is unavailable. Everything talks by `postMessage` and AudioParams.

---

## Part 2 — The landscape

### 2.1 Browser facts every option lives with

- **AudioWorklet is the only real-time slot.** The default block is 128 frames. Web Audio 1.1 adds `renderSizeHint`, but only Chrome ships it (Chrome 153) ([spec](https://www.w3.org/TR/webaudio-1.1/), [release notes](https://developer.chrome.com/release-notes/153)). The worklet scope has no DOM and no `fetch`, and all processors in a context share one global scope ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletGlobalScope), [WebAudio #1439](https://github.com/WebAudio/web-audio-api/issues/1439)). WASM is compiled on the main thread and the `Module` is posted in ([Emscripten](https://emscripten.org/docs/api_reference/wasm_audio_worklets.html)).
- **No watchdog.** A slow `process()` glitches the *whole* context, and nothing preempts it ([Chrome profiling](https://web.dev/articles/profiling-web-audio-apps-in-chrome), [design pattern](https://developer.chrome.com/blog/audio-worklet-design-pattern)). No browser feature caps a worklet's CPU.
- **SharedArrayBuffer** needs cross-origin isolation (COOP `same-origin` + COEP `require-corp`/`credentialless`) ([web.dev](https://web.dev/articles/coop-coep)). Lattice doesn't send these today. Turning them on would break cross-origin samples and embeds unless those send CORP/CORS headers, so it is a platform decision, not a flag. Emscripten's `-sAUDIO_WORKLET` and wasm-bindgen's threaded example both need it. Single-threaded WASM does not.
- **WASM SIMD** is in every current engine (Chrome 91, Firefox 89, Safari 16.4) ([ref](https://platform.uno/blog/safari-16-4-support-for-webassembly-fixed-width-simd-how-to-use-it-with-c/)). There is **no flush-to-zero**, so denormals in decaying feedback must be handled in code ([WebAssembly/simd#2](https://github.com/WebAssembly/simd/issues/2)). Faust and good hand-written DSP add tiny offsets or flush explicitly.

### 2.2 Ways to write DSP

| Option | What it is | Fit for lattice |
|---|---|---|
| **Raw AudioWorklet JS** | What lattice does now | Zero toolchain, instant hot reload. But the code is untrusted JS (it can post messages and allocate) and it risks GC pauses. Fine for built-ins, risky for sharing. |
| **Faust** ([faustwasm](https://github.com/grame-cncm/faustwasm)) | Functional DSP language → WASM, with a compiler that runs *in the browser* | The best match. The compiler is about 6.2 MB lazy-loaded ([unpkg](https://app.unpkg.com/@grame/faustwasm/files/libfaust-wasm)). UI metadata such as `hslider("freq[style:knob]",…)` comes out as JSON ([docs](https://faustdoc.grame.fr/manual/architectures/)). It has polyphony via `declare nvoices` and `freq/gain/gate` ([README](https://github.com/grame-cncm/faustwasm/blob/master/README.md)), and the Faust IDE already exports WAM2 ([WAM docs](https://www.webaudiomodules.com/docs/usage/generate-with-faustide/)). It has a big standard library (filters, reverbs, compressors). The output has no ambient authority. |
| **Cmajor** | C-like DSP language, JSON `.cmajorpatch`, Wasm/JS export | Great language, but export needs the native toolchain (no in-browser compiler) and the licence is GPLv3 or commercial ([licence](https://cmajor.dev/docs/Licence)). Better as an import format than an authoring one. |
| **SOUL** | Cmajor's predecessor | Abandoned for IP reasons when ROLI struggled ([forum](https://forum.hise.audio/topic/7949/c-major-another-audio-language/5)). The lesson: don't bet on a language one company owns. |
| **Elementary** | JS functional audio graph → Wasm renderer, MIT ([docs](https://www.elementary.audio/docs/packages/web-renderer)) | Close in spirit to Strudel (describe a graph, the renderer diffs it). A strong base for a Grid-like node editor, but it is a second runtime, and it needs care in an `OfflineAudioContext`. |
| **Csound WASM** | `@csound/browser`, AudioWorklet-only, LGPL ([npm](https://www.npmjs.com/package/@csound/browser)) | Deep, but heavy and old-style. It fits a "Csound node" better than a plugin format. |
| **Pd: WebPd / libpd** | WebPd compiles `.pd` to JS/AssemblyScript (~120 objects) ([WebPd](https://github.com/sebpiq/WebPd)); libpd-wasm runs real Pd | A nice import path for Pd patches. The object coverage is partial. |
| **Max RNBO** | Max patch → Web export | Free for non-commercial use and small companies, otherwise licensed ([FAQ](https://support.cycling74.com/hc/en-us/articles/10730637742483-RNBO-Export-Licensing-FAQ)). Users can bring exports; lattice can't depend on it. |
| **Rust/C++ → WASM** | wasm-bindgen / Emscripten | Needs an offline toolchain. The threaded paths need SAB ([Emscripten](https://emscripten.org/docs/api_reference/wasm_audio_worklets.html)). This is for plugin *developers*, via WAM2, not in-app authoring. |

### 2.3 WAM2: the web's plugin standard

WAM2 ([API](https://github.com/webaudiomodules/api), [paper](https://dl.acm.org/doi/fullHtml/10.1145/3487553.3524225)) pairs a main-thread `WamNode` (an AudioNode) with a `WamProcessor` worklet. It has:

- a descriptor: name, vendor, version, `isInstrument`, and I/O flags for audio, MIDI and automation;
- `WamParameterInfo` fields: type, min, max, default, `discreteStep`, `exponent`, `choices`, units;
- sample-timed events: `wam-automation`, `wam-midi`, `wam-transport`;
- `getState`/`setState`, and `createGui()` → HTMLElement;
- `WamGroup`, so a host's plugins can route events among themselves.

About 40 community plugins are indexed in a JSON catalog ([wam-community](https://github.com/boourns/wam-community)), and there are hosts such as Sequencer Party ([burns-audio-wam](https://github.com/boourns/burns-audio-wam)). WAM2 matches lattice's model well: a node with an input and an output, a state blob, and param info that maps almost 1:1 onto lattice's `{min, max, def, log, choices}`. The friction points:

- A third-party GUI is arbitrary DOM, and a WAM is arbitrary JS. Its processor runs in *lattice's* worklet scope, next to lattice's own processors.
- WAM2 has MIDI events, but Strudel notes arrive as haps. Lattice would translate them.

### 2.4 Lessons from elsewhere

- **JSFX (REAPER).** A text file with `@init/@slider/@block/@sample` sections. Slider lines *are* the UI, so a plugin is usable with zero UI code ([docs](https://www.reaper.fm/sdk/js/js.php)). Lesson: **declarative params that auto-generate a UI are what make hobbyists write plugins.** Lattice already has this in `params`.
- **Bitwig Grid.** Poly/FX/Note grids, one patch instance per voice, stereo oversampled cables ([Bitwig](https://www.bitwig.com/the-grid/)). Lesson: a graph editor needs a **per-voice vs global** distinction, like Syrup's voices vs lanes.
- **VCV Rack.** Voltage conventions (1 V/oct, ±5 V) and 16-channel polyphonic cables ([voltages](https://vcvrack.com/manual/VoltageStandards), [polyphony](https://vcvrack.com/manual/Polyphony)), plus a library with a manifest, open source and review ([library](https://github.com/VCVRack/library)). Lesson: **a signal convention and a reviewed catalogue** are what hold a module ecosystem together.
- **CLAP / VST3.** Param IDs are *stable forever*. Flags cover stepped, enum, periodic, automatable and modulatable. **Modulation is a non-destructive offset on top of the automated base value** ([CLAP params.h](https://github.com/free-audio/clap/blob/main/include/clap/ext/params.h)). VST3 normalises every param to 0–1 and separates processor and controller state ([VST3](https://steinbergmedia.github.io/vst3_dev_portal/pages/Technical+Documentation/Parameters+Automation/Index.html)). Lattice's automation already stores 0–1 travel, and Syrup's routes are offsets on travel. Both line up with CLAP's model.
- **Max for Live / Pd.** Max for Live "freezes" a device and its dependencies into one `.amxd` ([guidelines](https://github.com/Ableton/maxdevtools/blob/main/m4l-production-guidelines/m4l-production-guidelines.md)). Pd abstractions are patches used as objects, with `$0` per-instance IDs. Lesson: **a shared plugin must be self-contained**, and user plugins should nest inside other user plugins.

### 2.5 Security, sharing, UI, state

- **Sandboxing.** A worklet can't touch the DOM, but it can burn CPU, and there is no per-worklet limit. Arbitrary JS in the shared worklet scope could also reach other processors' globals. SES `Compartment`s restrict *authority*, not loops ([SES guide](https://github.com/endojs/endo/blob/master/packages/ses/docs/guide.md)). ShadowRealm isn't shipping ([TC39](https://github.com/tc39/proposal-shadowrealm)). A cross-origin sandboxed iframe gets its own process ([Chromium](https://chromium.googlesource.com/chromium/src/+/main/docs/process_model_and_site_isolation.md)), but also its *own* AudioContext, so its audio can't join lattice's graph without a MessagePort/SAB bridge. That adds latency and breaks offline export. **The practical sandbox is a language:** Faust compiled to WASM has no imports beyond math, so shared code can't do anything but compute samples. CPU is then handled by measuring and bypassing, not by preventing.
- **UI.** A declarative spec (params + groups + hints like `knob/slider/menu/meter`) generates 90% of UIs. Custom UIs come in two levels: *safe* (a drawing DSL or a `report()` → scope, as the kick panel does) and *trusted* (arbitrary DOM, built-ins and reviewed plugins only).
- **Presets and versioning.** Store state as `{plugin id, version, params by stable key, extra blob}`. Keep old versions runnable. Migrate with a per-plugin `normalize`, as `WAS_CALLED`/`normalizeEngine` already do.

---

## Part 3 — Proposal

The guiding choice: **keep lattice's model** (Strudel decides *when*; long-lived bus units and engines decide *how it sounds*; everything is Web Audio, so export keeps working) and make the plugin the unit of that model. Don't try to replace superdough's per-note chain; plugins live where lattice's own code already lives: on buses, sends, lanes and instrument engines.

### Stage 1 — One "lattice plugin" spec for everything built in  (effort: **L**)

**Unlocks for users:** nothing visible at first. Then: every effect gets sample-accurate automation and modulation; any effect can sit in a rack, a Syrup lane, or a send; presets for every effect; a real sidechain input. It is the foundation for stages 2–4.

**The spec** (a superset of today's engine spec, `instruments/index.js:13–40`):

```js
{
  id: 'lattice.eq3', version: '1.0.0', label, blurb,
  role: 'insert' | 'send' | 'instrument',          // where it can be placed
  io: { inputs: [{ name: 'in', ch: 2 }, { name: 'key', ch: 2, sidechain: true }?], outputs: [{ ch: 2 }] },
  params: [{ id: 'low', label, min, max, def, log?, unit?, origin?, choices?, step?,
             automatable: true, modulatable: true, smooth: 0.02 }],   // ids stable forever (CLAP rule)
  groups, ui: { layout?: 'auto' | Component, width?, scope?: report-shape },
  state: { normalize(raw), extra?: schema },       // non-knob state (Syrup's layers, drawn curves)
  latency?: samples, tail(state) → seconds,
  dsp: { kind: 'graph', build(ac) → { input, output, param(id) → AudioParam | setter, dispose } }
     | { kind: 'worklet', source, processor, voices? }          // today's engines and stereo.js worklets
     | { kind: 'faust', source | wasm+json }                    // stage 2
     | { kind: 'wam', url }                                     // stage 3
}
```

**Key decisions and what changes:**
- **One registry** (`plugins/index.js`) replaces `ENGINES`, the `UNITS` table, `FX_UNITS`/`STEREO_TYPES`/`LANE_FX`, and `APP_PARAMS`. `NODE_TYPES` entries for effects are *generated* from plugin specs. `stereoCode` and `sendCode` pick the adapter from `role`.
- **One host** for insert/send/instrument, from the pieces that exist: rack wiring (`stereo.js:421`), routers (`fxbus.js:75`), voices and taps (`host.js`). The `{input, output, set, dispose}` unit contract stays. It gains `param(id)`, so automation can talk to AudioParams directly.
- **Automation becomes sample-accurate for bus params.** Instead of the `requestAnimationFrame` push (`App.jsx:~857`), schedule each automated param's curve ahead with `setValueCurveAtTime`/`linearRampToValueAtTime` (look-ahead, like Strudel's own scheduler). That also removes the `suspend()` stepping in export (`exportAudio.js:137–148`). For worklet/Faust params, post the curve segments to the processor.
- **Modulation as offset.** Adopt CLAP's rule: `value = base (knob or automation) + Σ mod offsets on 0–1 travel`, which Syrup already does internally. Patch-level modulators (an LFO node, an envelope follower) can then target any plugin param.
- **A real sidechain.** A second input on the unit, fed from another orbit's rack output. A worklet compressor reads it. This replaces the browser's `DynamicsCompressorNode`, whose curve can't be keyed or shaped.
- **Project format.** `node.data` stays, but gains `plugin: { id, version }`. Old tracks map via a `WAS_CALLED`-style table (`instruments/index.js:46`).

**Risks.** Big refactor of working audio. Do it type by type behind the existing adapters, and compare with a null test (render before/after with `exportAudio`, subtract). Worklet modules must be loaded before an offline render: keep the `prepare*()` barrier, generalised.

### Stage 2 — Write your own DSP: Faust code editor, then a Grid  (effort: **L** for Faust, **XL** for the Grid)

**Unlocks:** users write an effect or synth in a code node, hear it while they type, and get knobs, automation and presets for free.

**Decisions:**
- **Faust first, not a home-made language.** It compiles in the browser to WASM (~6 MB compiler, lazy-loaded only when someone opens the editor). Its UI metadata maps directly onto lattice params (`[unit:dB]`, `[scale:log]`, `[style:knob|menu]`). It has a large standard library, polyphony (`freq/gain/gate`, which fits `v<n>_note/_gate`), and WAM2 export. Most importantly, **compiled Faust can do nothing but compute samples**, which makes stage 4's security much easier. A home-made "lattice DSP" language would be nicer to read but is years of work, and SOUL shows the risk of an owned language.
- **Hot reload.** Every compile produces a new processor name (`lattice-u-<hash>`), since `registerProcessor` can't redefine a name, and a new `addModule`. The host swaps nodes with a 20–50 ms cross-fade (the reverb's two-slot trick, `fxbus.js:269–316`), and carries over param values by stable id. Compile on the main thread (or a Worker) and post the `WebAssembly.Module` into the processor. No SAB needed.
- **Instruments.** A Faust poly DSP becomes a `role: 'instrument'` plugin. The host keeps lattice's note protocol (AudioParam-timed trig/gate/note), and a thin adapter maps it to Faust's `keyOn/keyOff` per voice.
- **The Grid** comes later, as a *front end* that generates Faust, not a second runtime. Modules are Faust library functions; cables are signals; a "voice" region marks per-voice vs shared, as Bitwig's Poly Grid does. Generating code keeps one compiler, one security model and one export path. Elementary Audio is the alternative if Faust's compile latency (hundreds of ms for big graphs) feels too slow for live patching.

**Risks:** Faust's learning curve (mitigate with templates: "gain", "filter", "delay", "synth voice"); compile errors in the UI; big patches compiling slowly; denormals in user feedback loops (mitigate by adding Faust's `ma.EPSILON`/flush idioms to the templates).

### Stage 3 — WAM2 in and out  (effort: **M** to host, **S–M** to export)

**Unlocks:** the ~40 community WAMs and any Faust IDE/RNBO/Cmajor export run in lattice; lattice plugins run in other web DAWs.

- **Hosting:** a `dsp.kind: 'wam'` adapter that maps `WamParameterInfo` → lattice params (`exponent` → `log`, `choices` → select), node data → `getState/setState`, automation → `wam-automation` events, notes → `wam-midi`, and the transport → `wam-transport`. A custom GUI opens in a lattice floating window (matching the self-contained synth-window model).
- **Risk:** a WAM is *arbitrary JS* on both threads, in lattice's page and worklet scope. **Only curated, pinned URLs**, never arbitrary links from a shared track. Export also needs the WAM to load in an `OfflineAudioContext`; most do, but test each one.
- **Export:** wrap a Faust-based lattice plugin with faustwasm's WAM generator. Built-in JS plugins can be wrapped by a small `WamProcessor` shim.

### Stage 4 — Share plugins like tracks  (effort: **L**)

**Unlocks:** "open in lattice" for a plugin; fork someone's reverb; a browse tab of plugins next to tracks.

- **Storage:** a plugin is a document `{id, version, source (Faust), compiled wasm+json cache, spec, author, licence}`, content-addressed by a hash of its source. A track stores `plugin: { id, version, hash }` and **embeds the source** if the plugin isn't public, so a track always plays (the Max for Live "freeze" lesson). The `src/api/tracks.py` storage and collab doc model carry it unchanged, because it is just JSON.
- **Security model:** shared plugins are **Faust-only** (or another capability-free language). No shared JS, and no shared WAMs unless reviewed. Compiled output is re-compiled on load from the source (don't trust uploaded wasm).
- **CPU limits:** measure each plugin's `process()` time with `currentTime`/`performance.now` deltas where available, or estimate it offline at install by rendering 10 s and timing. Then enforce a budget: an over-budget plugin is **bypassed with a visible badge**, rather than glitching the whole context. Offline export ignores the budget.
- **Review and signing:** "verified" plugins (reviewed by the team, signed hash) can use custom UIs and appear in the catalog. Unverified ones get the auto-generated UI only.

### Worked example 1 — the 3-band EQ

Stage 1, as a built-in graph plugin (the code from `stereo.js:657–682`, moved, not rewritten):

```js
export default {
  id: 'lattice.eq3', version: '1.0.0', label: '3-band eq', role: 'insert',
  params: [
    { id: 'low',  label: 'low',  min: -24, max: 12, def: 0, unit: 'db', origin: 0 },
    { id: 'mid',  label: 'mid',  min: -24, max: 12, def: 0, unit: 'db', origin: 0 },
    { id: 'high', label: 'high', min: -24, max: 12, def: 0, unit: 'db', origin: 0 },
    { id: 'lowf', label: 'low / mid',  min: 40,   max: 1000,  def: 200,  log: true, unit: 'hz' },
    { id: 'highf', label: 'mid / high', min: 1000, max: 12000, def: 3000, log: true, unit: 'hz' },
  ],
  dsp: { kind: 'graph', build(ac) {
    const low = new BiquadFilterNode(ac, { type: 'lowshelf' }), mid = new BiquadFilterNode(ac, { type: 'peaking' })
    const high = new BiquadFilterNode(ac, { type: 'highshelf' })
    low.connect(mid).connect(high)
    return { input: low, output: high,
      param: { low: low.gain, mid: mid.gain, high: high.gain, lowf: low.frequency, highf: high.frequency },
      derive(p) { /* mid.frequency = √(lowf·highf); mid.Q from octave gap — as stereo.js:672–676 */ } }
  } },
}
```

The node, the rack unit, lane use, automation (`param.low` is a real AudioParam, scheduled ahead) and the auto-generated knobs all come from this one object. `APP_PARAMS.eq3` and the `eq` entry in `UNITS` disappear.

Stage 2, the same EQ written by a user in Faust:

```faust
import("stdfaust.lib");
low   = hslider("low[unit:dB]", 0, -24, 12, 0.1) : si.smoo;
mid   = hslider("mid[unit:dB]", 0, -24, 12, 0.1) : si.smoo;
high  = hslider("high[unit:dB]", 0, -24, 12, 0.1) : si.smoo;
lowf  = hslider("low / mid[unit:Hz][scale:log]", 200, 40, 1000, 1) : si.smoo;
highf = hslider("mid / high[unit:Hz][scale:log]", 3000, 1000, 12000, 1) : si.smoo;
fc = sqrt(lowf * highf);
eq = fi.low_shelf(low, lowf) : fi.peak_eq(mid, fc, highf - lowf) : fi.high_shelf(high, highf);
process = eq, eq;   // stereo
```

The host reads the Faust JSON, turns each `hslider` into a param (`scale:log` → `log: true`), and the rest is identical to the built-in.

### Worked example 2 — the reverb

The built-in stays a graph plugin, because a `ConvolverNode` is native, fast and export-safe. It also shows the parts of the spec that the EQ doesn't need:

```js
{
  id: 'lattice.reverb', version: '1.0.0', role: 'send',          // placed as a send: fxbus routers
  params: [ mix (the send amount, owned by the host), size (log, s), predelay, tone, lowcut (log, hz), width ],
  tail: (p) => p.size * 1.25 + p.predelay,
  dsp: { kind: 'graph', build(ac) {
    // fxbus.js makeReverb, unchanged: predelay → lowcut → two convolver slots
    return { input, output,
      param: { predelay: pre.delayTime, lowcut: lowcut.frequency },     // automatable at audio rate
      set: { size, tone, width },   // "rebuild" params: regenerate the IR, cross-fade (debounced 90 ms)
      dispose }
  } },
}
```

Two things this makes explicit that are implicit today:
- **Some params are rebuild params, not AudioParams.** Their automation stays step-wise, and the spec says so (`smooth: 'rebuild'`).
- **`role: 'send'` lets the host decide** whether it is a shared send (today's `GLOBAL_REVERB`), a per-node send (`rv_<node>`), or a lane effect with a dry path (`laneFx.js:24–41`), instead of three code paths.

A user-made algorithmic reverb in Faust would be a `role: 'send'` plugin with `process = re.zita_rev1_stereo(…)` or `re.jpverb(…)`, and gets the same routing.

### Effort and order, summarised

| Stage | Unlocks | Effort | Main risk |
|---|---|---|---|
| 1 Unified spec | sample-accurate automation, any fx anywhere, sidechain, presets | L | refactor of working audio; null-test every type |
| 2a Faust editor + hot reload | user effects and synths | L | compile UX, denormals, 6 MB lazy load |
| 2b Grid editor → Faust | patch-cable DSP for non-coders | XL | UX scope; compile latency |
| 3 WAM2 host/export | third-party plugins, interop | M | arbitrary JS; offline render support |
| 4 Sharing + CPU budget | plugin library, forks | L | abuse, runaway CPU; review load |

**What I'd not do:** run user JS in the shared worklet scope; put plugins in iframes (breaks export and adds latency); require COOP/COEP just for plugins (single-threaded WASM doesn't need SAB); invent a DSP language before Faust has been tried with real users.
