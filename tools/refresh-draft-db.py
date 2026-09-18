#!/usr/bin/env python3
"""Make the preview database a copy of the live one.

Preview (/preview/) and live (/) share their code but not their data: live reads data.db,
preview reads data-draft.db. This copies live over preview so what you see on preview is
what people actually saved — and keeps the old preview file beside it, timestamped, in case
something was only ever saved there.

Live is opened read-only and never written. Run it yourself:

    ! python3 tools/refresh-draft-db.py
"""
import shutil
import sqlite3
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
LIVE = HERE / "data.db"
DRAFT = HERE / "data-draft.db"


def count(path, read_only=True):
    if not path.exists():
        return None
    uri = f"file:{path}?mode=ro" if read_only else str(path)
    conn = sqlite3.connect(uri, uri=read_only)
    try:
        return (conn.execute("SELECT COUNT(*) FROM tracks").fetchone()[0],
                conn.execute("SELECT COUNT(*) FROM track_versions").fetchone()[0])
    except sqlite3.Error:
        return None
    finally:
        conn.close()


def main():
    if not LIVE.exists():
        sys.exit(f"no live database at {LIVE}")
    before, live = count(DRAFT), count(LIVE)
    print(f"live    {live[0]} tracks, {live[1]} saves")
    print(f"preview {before[0] if before else 0} tracks, {before[1] if before else 0} saves")

    if DRAFT.exists():
        kept = DRAFT.with_name(f"{DRAFT.name}.before-refresh-{int(time.time())}")
        shutil.copy2(DRAFT, kept)
        print(f"kept the old preview database as {kept.name}")

    # the backup API rather than a file copy: it takes a consistent snapshot even if
    # something is reading or writing live at the moment
    src = sqlite3.connect(f"file:{LIVE}?mode=ro", uri=True)
    dst = sqlite3.connect(str(DRAFT))
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()

    after = count(DRAFT)
    print(f"preview is now {after[0]} tracks, {after[1]} saves — the same as live")
    print("nothing was written to data.db")


if __name__ == "__main__":
    main()
