"""A track's stream: what's playing, as data, for anything that wants to follow along
(TouchDesigner, Max, a visualiser, a lighting rig).

The browser playing the track publishes; anything else listens. The server only relays: it
keeps nothing, parses nothing, and a listener that can't keep up loses frames instead of
holding up the others.

    publish   ws  /api/stream/pub/{key}      the browser (one at a time: a new one takes over)
    listen    ws  /api/stream/{key}          anyone holding the key, as many as like
    look      GET /api/stream/{key}/status   is anyone publishing, how many listening
    read      GET /api/stream/{key}/guide    everything above, as one page to hand an agent

(draft: /preview/api/stream/...). The key is random and long, made in the browser when the
stream is switched on: holding it is what lets you listen. Messages are JSON text frames —
see frontend/src/stream.js for what's in them.
"""

import asyncio
import json
import re

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse

router = APIRouter()

KEY = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
QUEUE = 240  # frames a listener may fall behind by (about four seconds) before it starts losing them


class Room:
    def __init__(self):
        self.pub: WebSocket | None = None
        self.subs: dict[WebSocket, asyncio.Queue] = {}


rooms: dict[str, Room] = {}


def _room(key: str) -> Room:
    if not KEY.match(key):
        raise HTTPException(404, "no such stream")
    return rooms.setdefault(key, Room())


def _tidy(key: str):
    room = rooms.get(key)
    if room and room.pub is None and not room.subs:
        rooms.pop(key, None)


def _say(room: Room, text: str):
    for q in room.subs.values():
        if q.full():
            try:
                q.get_nowait()  # the oldest goes: a listener wants now, not four seconds ago
            except asyncio.QueueEmpty:
                pass
        q.put_nowait(text)


@router.get("/{key}/status")
async def status(key: str):
    room = rooms.get(key) if KEY.match(key) else None
    return {"live": bool(room and room.pub), "listeners": len(room.subs) if room else 0}


GUIDE = """# Lattice stream

Live data from a track playing in Lattice (a browser music studio): every sound as it
starts, plus the master output's spectrum and energy many times a second. It's data, not
audio: JSON text messages over a websocket.

Status right now: {status}

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
    return GUIDE.format(
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
            text = await ws.receive_text()
            _say(room, text)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        if room.pub is ws:
            room.pub = None
            _say(room, json.dumps({"type": "status", "live": False}))
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
