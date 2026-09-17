"""Applying the changes frontend/src/docsync.js sends, on the server's copy of a track.

Deliberately the same three rules, so both sides agree about what an op means:
an object is changed key by key, an array whose items carry an `id` is addressed by id,
and any other array is replaced whole. An op that no longer makes sense (a clip someone
else just deleted) is skipped rather than raised — see the note in docsync.js.
"""


def _is_obj(v):
    return isinstance(v, dict)


def _index(seq, step):
    """Where a path step points into a list: `{"id": ...}` finds it, a number is an index."""
    if _is_obj(step):
        wanted = step.get("id")
        for i, item in enumerate(seq):
            if _is_obj(item) and item.get("id") == wanted:
                return i
        return -1
    try:
        i = int(step)
    except (TypeError, ValueError):
        return -1
    return i if 0 <= i < len(seq) else -1


def _walk(doc, path):
    at = doc
    for step in path:
        if isinstance(at, list):
            i = _index(at, step)
            if i < 0:
                return None
            at = at[i]
        elif _is_obj(at):
            if _is_obj(step):
                return None
            at = at.get(step)
        else:
            return None
        if at is None:
            return None
    return at


def apply_ops(doc, ops):
    """Apply changes in place. Returns how many landed."""
    done = 0
    for op in ops if isinstance(ops, list) else []:
        if not _is_obj(op) or not isinstance(op.get("path"), list):
            continue
        path = op["path"]
        kind = op.get("op")
        if kind == "ord":
            seq = _walk(doc, path)
            ids = op.get("ids")
            if not isinstance(seq, list) or not isinstance(ids, list):
                continue
            by = {x.get("id"): x for x in seq if _is_obj(x)}
            sorted_items = [by[i] for i in ids if i in by]
            for item in seq:
                if not _is_obj(item) or item.get("id") not in ids:
                    sorted_items.append(item)
            seq[:] = sorted_items
            done += 1
            continue
        if kind == "ins":
            seq = _walk(doc, path)
            value = op.get("value")
            if not isinstance(seq, list) or not _is_obj(value):
                continue
            if any(_is_obj(x) and x.get("id") == value.get("id") for x in seq):
                continue
            at = op.get("at")
            at = min(max(at, 0), len(seq)) if isinstance(at, int) else len(seq)
            seq.insert(at, value)
            done += 1
            continue
        if kind not in ("set", "del") or not path:
            continue
        parent = _walk(doc, path[:-1]) if len(path) > 1 else doc
        last = path[-1]
        if isinstance(parent, list):
            i = _index(parent, last)
            if i < 0:
                continue
            if kind == "set":
                parent[i] = op.get("value")
            else:
                parent.pop(i)
            done += 1
        elif _is_obj(parent):
            if _is_obj(last):
                continue
            if kind == "set":
                parent[last] = op.get("value")
                done += 1
            elif last in parent:
                del parent[last]
                done += 1
    return done
