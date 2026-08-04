"""Dump Hermes Agent's live-ish sessions as one JSON object on stdout.

Sticky Brain has no runtime dependencies and Electron 33 ships Node 20, which has no
`node:sqlite` (that landed in Node 22.5). Hermes keeps its sessions in a SQLite database
-- `hermes sessions --help` calls it "the SQLite session store" -- so the only ways to read
it are a native SQLite addon or a subprocess. A subprocess it is: Hermes installs its own
CPython venv, and every CPython has `sqlite3` in the stdlib, so this script runs wherever
Hermes itself runs, with nothing to install and nothing to rebuild against Electron.

Usage:  python hermes-sessions.py <state.db path> [window_seconds] [limit]

Always exits 0 and always prints one JSON object, so the caller never has to interpret a
stack trace: {"ok": true, "items": [...]} or {"ok": false, "error": "..."}.
"""

import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time

# Read-only first. A read-only connection can still fail on a WAL database when SQLite
# wants to recover the log, so the fallback copies the db plus its -wal/-shm sidecars to
# temp and reads the copy. Copying is the slow path, not the normal one.
SIDECARS = ("", "-wal", "-shm")


def connect(db):
    try:
        uri = "file:" + db.replace("?", "%3f").replace("#", "%23") + "?mode=ro"
        con = sqlite3.connect(uri, uri=True, timeout=2.0)
        con.execute("select count(*) from sessions").fetchone()
        return con, False
    except Exception:
        pass
    tmp = os.path.join(tempfile.gettempdir(), "sticky-brain-hermes-state.db")
    for ext in SIDECARS:
        try:
            os.remove(tmp + ext)
        except OSError:
            pass
    for ext in SIDECARS:
        if os.path.exists(db + ext):
            shutil.copy2(db + ext, tmp + ext)
    return sqlite3.connect(tmp, timeout=2.0), True


# `sessions` carries no pid and no updated_at. Recency therefore comes from the newest row
# in `messages` for that session, which is what `hermes sessions list` shows as "Last Active".
QUERY = """
select s.id, s.source, s.title, s.display_name, s.model, s.cwd, s.git_branch,
       s.git_repo_root, s.started_at, s.ended_at, s.end_reason,
       s.message_count, s.tool_call_count, s.pinned,
       (select max(m.timestamp) from messages m where m.session_id = s.id) as last_at
  from sessions s
 where s.archived = 0
   and coalesce((select max(m.timestamp) from messages m where m.session_id = s.id),
                s.started_at) >= ?
 order by coalesce(last_at, s.started_at) desc
 limit ?
"""


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "no database path given"}))
        return
    db = sys.argv[1]
    window = float(sys.argv[2]) if len(sys.argv) > 2 else 21600.0
    limit = int(sys.argv[3]) if len(sys.argv) > 3 else 25

    if not os.path.exists(db):
        print(json.dumps({"ok": False, "error": "ENOENT", "path": db}))
        return

    try:
        # The window is anchored on the newest activity in the store rather than on the
        # wall clock. The two agree in normal use; anchoring this way keeps a machine whose
        # clock has drifted from silently reporting an empty session list.
        con, copied = connect(db)
        con.row_factory = sqlite3.Row
        newest = con.execute(
            "select max(coalesce((select max(m.timestamp) from messages m"
            " where m.session_id = s.id), s.started_at)) from sessions s"
        ).fetchone()[0]
        anchor = max(time.time(), newest or 0)
        rows = con.execute(QUERY, (anchor - window, limit)).fetchall()
        con.close()
    except Exception as err:  # noqa: BLE001 - the caller wants the text, not a traceback
        print(json.dumps({"ok": False, "error": "%s: %s" % (type(err).__name__, err)}))
        return

    # Hermes stores epoch seconds as REAL; the board works in milliseconds throughout.
    def ms(v):
        return None if v is None else int(v * 1000)

    items = []
    for r in rows:
        items.append(
            {
                "id": r["id"],
                "source": r["source"],
                "title": r["title"] or r["display_name"] or None,
                "model": r["model"],
                "cwd": r["cwd"] or "",
                "gitBranch": r["git_branch"],
                "gitRepoRoot": r["git_repo_root"],
                "startedAt": ms(r["started_at"]),
                "endedAt": ms(r["ended_at"]),
                "endReason": r["end_reason"],
                "lastAt": ms(r["last_at"]),
                "messageCount": r["message_count"] or 0,
                "toolCallCount": r["tool_call_count"] or 0,
                "pinned": bool(r["pinned"]),
            }
        )

    print(json.dumps({"ok": True, "path": db, "copied": copied, "items": items}))


main()
