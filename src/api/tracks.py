"""Shared Strudel tracks. Mounted at /api/tracks (draft: /preview/api/tracks).

Anyone can browse public tracks and open unlisted ones by link; saving, liking
and forking need a blue wind sign-in. Ownership is keyed on the SSO `sub`.
"""
import secrets
import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from incubator_lib import db, db_path, sso_user

router = APIRouter()

MAX_CODE = 100_000
MAX_TITLE = 80
VISIBILITIES = ("public", "unlisted", "private")
SORTS = {
    "new": "t.updated_at DESC",
    "top": "t.likes DESC, t.plays DESC, t.updated_at DESC",
    "played": "t.plays DESC, t.updated_at DESC",
}

_ready: set = set()


def _conn():
    """A connection for this request's env (draft/live), with the schema in place."""
    conn = db()
    path = str(db_path())
    if path not in _ready:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS tracks (
              id TEXT PRIMARY KEY,
              owner_sub TEXT NOT NULL,
              author TEXT NOT NULL,
              title TEXT NOT NULL,
              code TEXT NOT NULL,
              visibility TEXT NOT NULL DEFAULT 'public',
              forked_from TEXT,
              likes INTEGER NOT NULL DEFAULT 0,
              plays INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS tracks_owner ON tracks(owner_sub);
            CREATE INDEX IF NOT EXISTS tracks_vis_updated ON tracks(visibility, updated_at);
            CREATE TABLE IF NOT EXISTS likes (
              track_id TEXT NOT NULL,
              sub TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              PRIMARY KEY (track_id, sub)
            );
            """
        )
        conn.commit()
        _ready.add(path)
    return conn


def _err(msg, status):
    return JSONResponse({"error": msg}, status_code=status)


def _author(user):
    return (user.get("name") or user.get("given_name") or "anon").strip()[:60] or "anon"


def _public(row, user=None, liked=False, with_code=True):
    t = dict(row)
    t["is_owner"] = bool(user and user.get("sub") == t["owner_sub"])
    t["liked"] = bool(liked)
    t.pop("owner_sub", None)
    if not with_code:
        t.pop("code", None)
    return t


def _validate(body, partial=False):
    out = {}
    if "title" in body or not partial:
        title = str(body.get("title") or "").strip()[:MAX_TITLE]
        out["title"] = title or "untitled"
    if "code" in body or not partial:
        code = body.get("code")
        if not isinstance(code, str) or not code.strip():
            return None, "code is empty"
        if len(code) > MAX_CODE:
            return None, f"code is over {MAX_CODE // 1000} KB"
        out["code"] = code
    if "visibility" in body or not partial:
        vis = body.get("visibility") or "public"
        if vis not in VISIBILITIES:
            return None, "visibility must be public, unlisted or private"
        out["visibility"] = vis
    return out, None


@router.get("")
def list_tracks(request: Request, q: str = "", sort: str = "new", view: str = "explore",
                limit: int = 50, offset: int = 0):
    """view: explore (public), mine (all of yours), liked (tracks you liked)."""
    user = sso_user(request)
    limit = max(1, min(limit, 100))
    offset = max(0, offset)
    where, params = [], []
    join = ""
    if view == "mine":
        if not user:
            return _err("sign in", 401)
        where.append("t.owner_sub = ?")
        params.append(user["sub"])
    elif view == "liked":
        if not user:
            return _err("sign in", 401)
        join = "JOIN likes lk ON lk.track_id = t.id AND lk.sub = ?"
        params.append(user["sub"])
        where.append("(t.visibility != 'private' OR t.owner_sub = ?)")
        params.append(user["sub"])
    else:
        where.append("t.visibility = 'public'")
    if q.strip():
        where.append("(t.title LIKE ? OR t.author LIKE ?)")
        like = f"%{q.strip()[:80]}%"
        params += [like, like]
    my_like = "EXISTS(SELECT 1 FROM likes l WHERE l.track_id = t.id AND l.sub = ?)"
    sql = (
        f"SELECT t.*, {my_like} AS my_like FROM tracks t {join} "
        f"WHERE {' AND '.join(where)} ORDER BY {SORTS.get(sort, SORTS['new'])} LIMIT ? OFFSET ?"
    )
    conn = _conn()
    try:
        rows = conn.execute(sql, [user["sub"] if user else ""] + params + [limit, offset]).fetchall()
    finally:
        conn.close()
    return {"tracks": [_public({k: r[k] for k in r.keys() if k != "my_like"}, user, r["my_like"], with_code=False)
                       for r in rows]}


@router.get("/{track_id}")
def get_track(track_id: str, request: Request):
    user = sso_user(request)
    conn = _conn()
    try:
        row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
        if not row or (row["visibility"] == "private" and not (user and user["sub"] == row["owner_sub"])):
            return _err("track not found", 404)
        liked = bool(user) and conn.execute(
            "SELECT 1 FROM likes WHERE track_id = ? AND sub = ?", (track_id, user["sub"])).fetchone() is not None
        parent = None
        if row["forked_from"]:
            p = conn.execute("SELECT id, title, author, visibility FROM tracks WHERE id = ?",
                             (row["forked_from"],)).fetchone()
            if p and p["visibility"] != "private":
                parent = {"id": p["id"], "title": p["title"], "author": p["author"]}
    finally:
        conn.close()
    return {**_public(row, user, liked), "parent": parent}


@router.post("")
async def create_track(request: Request):
    user = sso_user(request)
    if not user:
        return _err("sign in to save tracks", 401)
    body = await request.json()
    data, error = _validate(body)
    if error:
        return _err(error, 400)
    forked_from = body.get("forked_from") or None
    now = int(time.time())
    track_id = secrets.token_urlsafe(6)
    conn = _conn()
    try:
        if forked_from and not conn.execute("SELECT 1 FROM tracks WHERE id = ?", (forked_from,)).fetchone():
            forked_from = None
        conn.execute(
            "INSERT INTO tracks (id, owner_sub, author, title, code, visibility, forked_from, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (track_id, user["sub"], _author(user), data["title"], data["code"], data["visibility"],
             forked_from, now, now),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
    finally:
        conn.close()
    return _public(row, user)


@router.put("/{track_id}")
async def update_track(track_id: str, request: Request):
    user = sso_user(request)
    if not user:
        return _err("sign in", 401)
    data, error = _validate(await request.json(), partial=True)
    if error:
        return _err(error, 400)
    conn = _conn()
    try:
        row = conn.execute("SELECT owner_sub FROM tracks WHERE id = ?", (track_id,)).fetchone()
        if not row:
            return _err("track not found", 404)
        if row["owner_sub"] != user["sub"]:
            return _err("not your track", 403)
        data["author"] = _author(user)
        data["updated_at"] = int(time.time())
        sets = ", ".join(f"{k} = ?" for k in data)
        conn.execute(f"UPDATE tracks SET {sets} WHERE id = ?", [*data.values(), track_id])
        conn.commit()
        row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
        liked = conn.execute("SELECT 1 FROM likes WHERE track_id = ? AND sub = ?",
                             (track_id, user["sub"])).fetchone() is not None
    finally:
        conn.close()
    return _public(row, user, liked)


@router.delete("/{track_id}")
def delete_track(track_id: str, request: Request):
    user = sso_user(request)
    if not user:
        return _err("sign in", 401)
    conn = _conn()
    try:
        row = conn.execute("SELECT owner_sub FROM tracks WHERE id = ?", (track_id,)).fetchone()
        if not row:
            return _err("track not found", 404)
        if row["owner_sub"] != user["sub"]:
            return _err("not your track", 403)
        conn.execute("DELETE FROM likes WHERE track_id = ?", (track_id,))
        conn.execute("DELETE FROM tracks WHERE id = ?", (track_id,))
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.post("/{track_id}/like")
def toggle_like(track_id: str, request: Request):
    user = sso_user(request)
    if not user:
        return _err("sign in to like tracks", 401)
    conn = _conn()
    try:
        row = conn.execute("SELECT owner_sub, visibility FROM tracks WHERE id = ?", (track_id,)).fetchone()
        if not row or (row["visibility"] == "private" and row["owner_sub"] != user["sub"]):
            return _err("track not found", 404)
        cur = conn.execute("DELETE FROM likes WHERE track_id = ? AND sub = ?", (track_id, user["sub"]))
        liked = cur.rowcount == 0
        if liked:
            conn.execute("INSERT INTO likes (track_id, sub, created_at) VALUES (?,?,?)",
                         (track_id, user["sub"], int(time.time())))
        conn.execute("UPDATE tracks SET likes = (SELECT COUNT(*) FROM likes WHERE track_id = ?) WHERE id = ?",
                     (track_id, track_id))
        conn.commit()
        likes = conn.execute("SELECT likes FROM tracks WHERE id = ?", (track_id,)).fetchone()["likes"]
    finally:
        conn.close()
    return {"liked": liked, "likes": likes}


@router.post("/{track_id}/play")
def count_play(track_id: str):
    conn = _conn()
    try:
        conn.execute("UPDATE tracks SET plays = plays + 1 WHERE id = ? AND visibility != 'private'", (track_id,))
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}
