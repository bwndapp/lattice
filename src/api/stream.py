"""A track's stream: what's playing, as data, for anything that wants to follow along
(TouchDesigner, Max, a visualiser, a lighting rig).

The browser playing the track publishes; anything else listens. The server only relays: it
keeps nothing, parses nothing, and a listener that can't keep up loses frames instead of
holding up the others.

    publish   ws  /api/stream/pub/{key}      the browser (one at a time: a new one takes over);
                                             text frames are data, binary frames audio
    listen    ws  /api/stream/{key}          anyone holding the key, as many as like
    audio     GET /api/stream/{key}/audio.wav   the sound itself, as an endless WAV
              ws  /api/stream/{key}/audio       the same, as raw PCM frames
    look      GET /api/stream/{key}/status   is anyone publishing, how many listening
    read      GET /api/stream/{key}/guide    everything above, as one page to hand an agent

(draft: /preview/api/stream/...). The key is random and long, made in the browser when the
stream is switched on: holding it is what lets you listen. Messages are JSON text frames —
see frontend/src/stream.js for what's in them.
"""

import asyncio
import json
import re
import struct

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse, StreamingResponse

router = APIRouter()

KEY = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
QUEUE = 240  # frames a listener may fall behind by (about four seconds) before it starts losing them
AUDIO_QUEUE = 48  # audio chunks (about 40 ms each) a listener may fall behind by: two seconds


class Room:
    def __init__(self):
        self.pub: WebSocket | None = None
        self.subs: dict[WebSocket, asyncio.Queue] = {}
        # the sound: 16-bit little-endian PCM, interleaved, at whatever rate the browser runs
        self.audio_subs: dict[object, asyncio.Queue] = {}
        self.fmt = {"rate": 48000, "channels": 2, "bits": 16}
        self.fmt_known = asyncio.Event()


rooms: dict[str, Room] = {}


def _room(key: str) -> Room:
    if not KEY.match(key):
        raise HTTPException(404, "no such stream")
    return rooms.setdefault(key, Room())


def _tidy(key: str):
    room = rooms.get(key)
    if room and room.pub is None and not room.subs and not room.audio_subs:
        rooms.pop(key, None)


def _say(room: Room, text: str):
    for q in room.subs.values():
        if q.full():
            try:
                q.get_nowait()  # the oldest goes: a listener wants now, not four seconds ago
            except asyncio.QueueEmpty:
                pass
        q.put_nowait(text)


def _pour(room: Room, chunk: bytes):
    for q in room.audio_subs.values():
        if q.full():
            try:
                q.get_nowait()  # behind: drop the oldest, so it stays near now
            except asyncio.QueueEmpty:
                pass
        q.put_nowait(chunk)


def _wav_header(fmt: dict) -> bytes:
    """A WAV header for a stream with no end: the sizes say 'as long as it goes'."""
    ch, rate, bits = fmt["channels"], fmt["rate"], fmt["bits"]
    block = ch * bits // 8
    return (b"RIFF" + struct.pack("<I", 0xFFFFFFFF) + b"WAVE"
            + b"fmt " + struct.pack("<IHHIIHH", 16, 1, ch, rate, rate * block, block, bits)
            + b"data" + struct.pack("<I", 0xFFFFFFFF))


@router.get("/{key}/status")
async def status(key: str):
    room = rooms.get(key) if KEY.match(key) else None
    return {
        "live": bool(room and room.pub),
        "listeners": len(room.subs) if room else 0,
        "audio": bool(room and room.fmt_known.is_set() and room.pub),
        "audioListeners": len(room.audio_subs) if room else 0,
    }


@router.get("/{key}/audio.wav")
async def audio_wav(key: str):
    """The sound as one endless WAV: open it in VLC, ffmpeg, OBS, a browser's <audio>."""
    room = _room(key)
    try:
        await asyncio.wait_for(room.fmt_known.wait(), timeout=3)
    except asyncio.TimeoutError:
        pass  # nobody's sending sound yet: start with the usual format, sound arrives when it does
    q: asyncio.Queue = asyncio.Queue(maxsize=AUDIO_QUEUE)
    token = object()
    room.audio_subs[token] = q

    async def body():
        try:
            yield _wav_header(room.fmt)
            while True:
                yield await q.get()
        finally:
            room.audio_subs.pop(token, None)
            _tidy(key)

    return StreamingResponse(body(), media_type="audio/wav", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


GUIDE = """# Lattice stream

Live data from a track playing in Lattice (a browser music studio): every sound as it
starts, plus the master output's spectrum and energy many times a second, as JSON text
messages over a websocket. The sound itself is here too, lossless, when the stream node's
`audio` setting is on: see Audio below.

Status right now: {status}
Audio right now: {audio}

## Connect

    {ws}

A plain websocket; anyone with this address can listen, as many at once as like. Nothing
needs to be sent. Messages arrive only while the stream is switched on in Lattice (the
stream node); a `status` message says when that changes. If the socket drops, reconnect.

Check without connecting: GET {http}/status  ->  {{"live": true, "listeners": 2}}

## Messages

Every message is one JSON object with a `type`.

### hit: a sound starting

Sent the moment the sound is heard (timed to the audio, not the scheduler).

    {{"type": "hit", "t": 1763130000123, "cycle": 12.5, "dur": 0.25,
     "node": "pattern3f2a1", "nodeName": "drums", "inst": "c8f2a", "instName": "kick",
     "sound": "bd", "note": 36, "freq": 65.406, "velocity": 1, "gain": 0.9, "pan": 0.5}}

- t: when it sounds, epoch ms
- cycle: where in the song, in bars from the start (12.5 = halfway through bar 13)
- dur: length in seconds
- node / nodeName: the part on the patch that played it
- inst / instName: the instrument (a row of a pattern), when there is one
- sound: sample or synth name (null for some synths)
- note: MIDI note number (60 = middle C), as written; may be fractional; null if unpitched
- freq: Hz after the track's tuning; null if unpitched
- velocity, gain: 0 ... 1 (gain can go above 1); pan: 0 left, 0.5 centre, 1 right

### frame: the master output, measured

Sent 15, 30 or 60 times a second while the stream is on (set on the stream node). The
browser slows this down when the Lattice tab is in the background; hits are not affected.

    {{"type": "frame", "t": 1763130000140, "playing": true, "bpm": 140, "beats": 4,
     "cycle": 12.51, "bar": 13, "beat": 3,
     "rms": 0.21, "peak": 0.74, "db": -13.6,
     "bands": {{"sub": 0.62, "bass": 0.71, "lowmid": 0.48, "mid": 0.44,
               "highmid": 0.37, "presence": 0.30, "air": 0.18}},
     "centroid": 1840, "flux": 0.12, "spectrum": [0.31, 0.44, ...],
     "wave": [0.0, 0.12, 0.31, ...],
     "levels": {{"inst": {{"kick": 0.9, "hat": 0.0, "bass": 0.55}},
                "node": {{"drums": 0.9, "bass": 0.55}}}}}}

- playing, bpm, beats (per bar)
- cycle (bars from the start, fractional), bar and beat (both counted from 1)
- rms, peak: level, linear 0 ... 1; db: rms in dBFS
- bands: energy per range, 0 ... 1 (sub 20-60 Hz, bass 60-250, lowmid 250-500,
  mid 500-2k, highmid 2k-4k, presence 4k-6k, air 6k-20k)
- centroid: brightness, Hz
- flux: 0 ... 1, how much the spectrum rose since the last frame; spikes on every hit
- spectrum: 16, 32 or 64 values 0 ... 1, log-spaced 20 Hz ... 20 kHz, low to high
- wave: 128 values -1 ... 1, the master's waveform over about 21 ms, starting on a rising
  zero crossing so a scope drawn from it holds still
- levels: how loud each instrument (inst) and each part on the patch (node) is right now,
  0 ... 1, keyed by name. Worked out from the notes, not measured: it jumps to the note's
  velocity x gain when it's heard, holds while the note lasts, and falls away over about
  0.15 s after. Everything that plays is always listed (0 while silent), so channels don't
  come and go. A name used twice gets "#id" added.

Bands and spectrum map -100 ... -10 dBFS onto 0 ... 1: silence is 0, a loud kick's low
end is near 1.

### transport: play or stop

    {{"type": "transport", "t": 1763130000000, "playing": true, "bpm": 140, "beats": 4}}

### status: from the relay

    {{"type": "status", "live": true}}

live false: Lattice stopped streaming (switched off, tab closed). Stay connected; it
picks up again when it comes back.

## Audio: the sound itself

Lossless: 16-bit PCM, stereo, at the browser's rate (usually 48000 Hz), exactly what the
master output plays (after its safety limiter). Only while the stream node's `audio`
setting is on, and only while Lattice is open and streaming. About 1.5 Mbit/s.

### As an endless WAV over HTTP (simplest)

    {http}/audio.wav

Open it like any audio URL: it starts with a WAV header that says "no end" and keeps
going. Allow a second or so of buffering; a slow listener skips ahead rather than falling
behind.

    ffplay -fflags nobuffer {http}/audio.wav            # listen
    ffmpeg -i {http}/audio.wav -c copy take.wav         # record
    vlc {http}/audio.wav                                 # listen
    OBS: Media Source, untick "Local File", input = the URL above

### As raw PCM over a websocket (for code)

    {ws}/audio

First a text frame: {{"type": "audio-format", "encoding": "s16le", "rate": 48000,
"channels": 2, "live": true}}. Then binary frames, each about 40 ms of interleaved samples
(L R L R …), little-endian signed 16-bit. Divide by 32768 for -1 ... 1.

    import asyncio, json, websockets, numpy as np, sounddevice as sd

    async def main():
        async with websockets.connect("{ws}/audio") as ws:
            fmt = json.loads(await ws.recv())
            out = sd.OutputStream(samplerate=fmt["rate"], channels=fmt["channels"], dtype="int16")
            out.start()
            async for chunk in ws:
                out.write(np.frombuffer(chunk, dtype="<i2").reshape(-1, fmt["channels"]))

    asyncio.run(main())

### TouchDesigner

The cleanest, lowest-latency way to get Lattice's sound into TouchDesigner is a virtual
audio device: route the browser's output to BlackHole (Mac) or VB-Cable (Windows) and read
it with an Audio Device In CHOP. Use this stream's hits and frames alongside it for the
exact events. To pull the sound over the network instead (Lattice on another machine), run
ffmpeg or the Python above on the TouchDesigner machine and play it into that same
virtual device.

## Python

    import asyncio, json, websockets

    async def main():
        async for ws in websockets.connect("{ws}"):
            try:
                async for raw in ws:
                    m = json.loads(raw)
                    if m["type"] == "hit":
                        print(m["instName"] or m["sound"], m["note"])
                    elif m["type"] == "frame":
                        pass  # m["bands"]["bass"], m["spectrum"], ...
            except websockets.ConnectionClosed:
                continue

    asyncio.run(main())

## TouchDesigner

1. Add a WebSocket DAT; set Network Address to the address above; Active on.
2. In its callbacks DAT:

        import json
        def onReceiveText(dat, rowIndex, message):
            m = json.loads(message)
            if m['type'] == 'frame':
                for i, k in enumerate(m['bands']):
                    op('energy').par['value' + str(i)] = m['bands'][k]
            elif m['type'] == 'hit':
                op('hits').appendRow([m['instName'] or m['sound'], m['note'], m['velocity']])
            return

   (`energy`: a Constant CHOP with 7 channels; `hits`: a Table DAT.) For the spectrum,
   write `m['spectrum']` into a Script CHOP or a Table DAT and convert with DAT to CHOP.
3. Waveform: write `m['wave']` into a Script CHOP (one channel, 128 samples) for a scope.
   Levels: one Constant CHOP channel per name in `m['levels']['inst']`, so "bass" can
   drive a scale, "kick" a flash, and so on.

## Notes

- One Lattice tab publishes a track at a time. The address stays the same until someone
  makes a new link in Lattice, which cuts off the old one.
- A slow listener loses old frames rather than falling behind (about 4 s of buffer).
- Timestamps are the publishing browser's clock.
"""


@router.get("/{key}/guide", response_class=PlainTextResponse)
async def guide(key: str, request: Request):
    if not KEY.match(key):
        raise HTTPException(404, "no such stream")
    h = request.headers
    proto = h.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip()
    host = h.get("x-forwarded-host", h.get("host", request.url.netloc)).split(",")[0].strip()
    path = request.url.path[: -len("/guide")]
    room = rooms.get(key)
    status = "live" if room and room.pub else "not streaming at the moment (switch it on in Lattice)"
    audio = "on" if room and room.pub and room.fmt_known.is_set() else "off (set the stream node's audio to on)"
    return GUIDE.format(
        audio=audio,
        ws=f"{'wss' if proto == 'https' else 'ws'}://{host}{path}",
        http=f"{proto}://{host}{path}",
        status=status,
    )


@router.websocket("/pub/{key}")
async def publish(ws: WebSocket, key: str):
    if not KEY.match(key):
        await ws.close(code=4404)
        return
    await ws.accept()
    room = _room(key)
    old, room.pub = room.pub, ws
    if old is not None:
        try:
            await old.close(code=4409)  # another tab took over
        except Exception:
            pass
    _say(room, json.dumps({"type": "status", "live": True}))
    await ws.send_text(json.dumps({"type": "listeners", "n": len(room.subs)}))
    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                if room.pub is ws:
                    _pour(room, msg["bytes"])
                continue
            text = msg.get("text")
            if text is None:
                continue
            if '"audio-format"' in text[:64]:
                # what the sound is, before any of it: kept for whoever opens it later
                try:
                    f = json.loads(text)
                    room.fmt = {"rate": int(f["rate"]), "channels": int(f["channels"]), "bits": 16}
                    room.fmt_known.set()
                except (ValueError, KeyError, TypeError):
                    pass
            _say(room, text)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        if room.pub is ws:
            room.pub = None
            _say(room, json.dumps({"type": "status", "live": False}))
        _tidy(key)


@router.websocket("/{key}/audio")
async def listen_audio(ws: WebSocket, key: str):
    """The sound as raw PCM: a text frame saying its format, then binary frames of it."""
    if not KEY.match(key):
        await ws.close(code=4404)
        return
    await ws.accept()
    room = _room(key)
    q: asyncio.Queue = asyncio.Queue(maxsize=AUDIO_QUEUE)
    room.audio_subs[ws] = q
    await ws.send_text(json.dumps({"type": "audio-format", "encoding": "s16le", **{k: room.fmt[k] for k in ("rate", "channels")}, "live": room.pub is not None}))

    async def pump():
        while True:
            await ws.send_bytes(await q.get())

    async def drain():
        while True:
            await ws.receive()

    tasks = [asyncio.create_task(pump()), asyncio.create_task(drain())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in tasks:
            t.cancel()
        room.audio_subs.pop(ws, None)
        _tidy(key)


@router.websocket("/{key}")
async def listen(ws: WebSocket, key: str):
    if not KEY.match(key):
        await ws.close(code=4404)
        return
    await ws.accept()
    room = _room(key)
    q: asyncio.Queue = asyncio.Queue(maxsize=QUEUE)
    room.subs[ws] = q
    await ws.send_text(json.dumps({"type": "status", "live": room.pub is not None}))
    if room.pub is not None:
        try:
            await room.pub.send_text(json.dumps({"type": "listeners", "n": len(room.subs)}))
        except Exception:
            pass

    async def pump():
        while True:
            await ws.send_text(await q.get())

    async def drain():
        # a listener has nothing to say, but reading is how a closed socket is noticed
        while True:
            await ws.receive_text()

    tasks = [asyncio.create_task(pump()), asyncio.create_task(drain())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in tasks:
            t.cancel()
        room.subs.pop(ws, None)
        if room.pub is not None:
            try:
                await room.pub.send_text(json.dumps({"type": "listeners", "n": len(room.subs)}))
            except Exception:
                pass
        _tidy(key)
