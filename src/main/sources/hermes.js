'use strict'

const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const { paths } = require('../config')

// Hermes Agent sessions, for the same LIVE list Claude Code sessions land in.
//
// Where they live: NOT a directory of JSON files. `~/.hermes/` does not exist on this machine,
// `%LOCALAPPDATA%\hermes\sessions\` holds only `request_dump_*.json` API captures, and
// `hermes sessions --help` describes itself as managing "the SQLite session store". The store is
// `%LOCALAPPDATA%\hermes\state.db`, table `sessions` — verified against a running install.
//
// Two things that table does NOT have, and the board must not pretend otherwise:
//
//  1. No pid. A Hermes row therefore cannot drive the focus-the-terminal walk that Feature 1
//     does for Claude Code; index.js reports that plainly instead of guessing.
//  2. No `status` and no `updated_at`. Recency is derived from the newest `messages` row for the
//     session, which is the same thing `hermes sessions list` prints as "Last Active".
//
// Reading it needs SQLite, and this project has no runtime dependencies: Electron 33 ships Node
// 20.18, whose `require('node:sqlite')` throws ERR_UNKNOWN_BUILTIN_MODULE (that builtin arrived in
// Node 22.5). Rather than add a native addon that has to be rebuilt against every Electron bump,
// the read is delegated to hermes-sessions.py running on Hermes's own bundled CPython — present by
// definition wherever there are Hermes sessions to read, and `sqlite3` is in the stdlib.

// A session that has not been touched in this long is not "live" in any useful sense. Claude Code
// needs no equivalent because its sessions directory only ever holds current files, while state.db
// is a permanent archive — measured here, an unwindowed read returned 14 Hermes rows against 1
// Claude Code row, which is a scrollback of the day rather than a board of what is running.
const WINDOW_SECONDS = 2 * 60 * 60
const MAX_ROWS = 15

// SB: status is INFERRED from recency, and is weaker than Claude Code's own `status` field.
// A Hermes session sitting at its prompt one second after answering still looks 'busy' here.
// The board's honest claim is "was doing something very recently", not "is mid-turn".
//
// There is deliberately no recency-based 'stale': a Hermes session goes stale only by recording an
// `ended_at`. Claude Code's 'stale' means something real — a file left behind by a process that
// died — whereas an old row in state.db means only "old", and the window above already answers that.
const BUSY_MS = 90 * 1000

// The store is written continuously and the board polls every 5s. Re-running Python on every poll
// would spawn a process 12 times a minute for a file that usually has not changed, so the result
// is cached against the mtimes of the database and its WAL sidecars — a WAL-mode commit lands in
// `state.db-wal` and leaves `state.db` itself untouched, so all three have to be watched.
let cache = { key: null, raw: null }
let inFlight = null

function stamp () {
  let key = ''
  for (const ext of ['', '-wal', '-shm']) {
    try { key += fs.statSync(paths.hermesState + ext).mtimeMs + ':' } catch { key += '-:' }
  }
  return key
}

// Hermes's own venv first: if there are Hermes sessions to read, that interpreter is there. A bare
// `python.exe` is the fallback — execFile resolves it on PATH, and any CPython reads the same file
// just as well; if there is none, the spawn fails and runReader reports that rather than reporting
// an empty session list.
function pythonPath () {
  return fs.existsSync(paths.hermesPython) ? paths.hermesPython : 'python.exe'
}

// SB: External child processes (Python) cannot read inside app.asar — they need the
// unpacked copy. In dev mode __dirname is a real filesystem path, so the replace is a no-op.
const SCRIPT = path.join(__dirname, 'hermes-sessions.py')
  .replace('app.asar', 'app.asar.unpacked')

function runReader () {
  return new Promise(resolve => {
    const py = pythonPath()
    if (!py) return resolve({ ok: false, error: 'no python to read the hermes store with' })
    execFile(py, [SCRIPT, paths.hermesState, String(WINDOW_SECONDS), String(MAX_ROWS)],
      { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim()
        if (!out) {
          // The script is written to always print one JSON object, so silence means Python itself
          // never ran — a missing interpreter, not a missing session.
          return resolve({
            ok: false,
            error: err ? (err.killed ? 'reader timed out' : String(err.message).split('\n')[0]) : 'reader produced no output',
            stderr: String(stderr || '').trim() || null
          })
        }
        try { resolve(JSON.parse(out.split(/\r?\n/).pop())) } catch (e) {
          resolve({ ok: false, error: 'unparsable reader output' })
        }
      })
  })
}

function statusFor (s, now) {
  if (s.endedAt) return 'stale'
  const last = s.lastAt || s.startedAt || 0
  return (now - last) <= BUSY_MS ? 'busy' : 'idle'
}

function nameFor (s) {
  if (s.title) return s.title
  // The id is `<date>_<time>_<hex>`; the hex tail is what `hermes chat --resume` accepts and what
  // `hermes sessions list` shows, so it is the part worth putting on screen.
  const tail = String(s.id || '').split('_').pop()
  return 'hermes ' + (tail || 'session')
}

// Only the reader's raw payload is cached, never the finished rows. `status` is a function of the
// clock as well as of the data, and a session that stops writing also stops changing the file
// mtimes — so a cached 'busy' row would have stayed 'busy' for as long as its session stayed quiet,
// which is precisely backwards.
function toRows (raw) {
  const now = Date.now()
  return (raw.items || []).map(s => ({
    // Prefixed so a Hermes id can never collide with a Claude Code sessionId or pid in the
    // renderer's keying, while `sessionId` keeps the raw value `hermes chat --resume` wants.
    id: 'hermes:' + s.id,
    agent: 'hermes',
    pid: null,
    sessionId: s.id,
    name: nameFor(s),
    cwd: s.cwd || '',
    startedAt: s.startedAt,
    updatedAt: s.lastAt,
    // SB: carried through now rather than only being consumed by statusFor — sessions.js re-decides
    // live-vs-saved against the running processes, and "the store says this session ended" is the
    // one piece of that decision the store itself can settle.
    endedAt: s.endedAt || null,
    version: s.model || null,
    origin: s.source || null,
    messageCount: s.messageCount,
    toolCallCount: s.toolCallCount,
    gitBranch: s.gitBranch || null,
    status: statusFor(s, now)
  }))
}

async function read () {
  // No Hermes on the machine is not an error the board should shout about — it is simply a
  // second agent that is not installed. `ok: true` with nothing in it.
  if (!fs.existsSync(paths.hermesState)) {
    return { ok: true, installed: false, path: paths.hermesState, items: [] }
  }

  const key = stamp()
  if (cache.key === key && cache.raw) {
    return { ok: true, installed: true, path: paths.hermesState, items: toRows(cache.raw) }
  }
  if (inFlight) return inFlight

  inFlight = (async () => {
    const raw = await runReader()
    if (!raw || raw.ok !== true) {
      // A failed read must not be reported as "no sessions" — that is the exact lie this whole
      // board exists to avoid. It carries its own error, and nothing is cached, so the next poll
      // simply tries again.
      if (raw && raw.stderr) console.error('[hermes] reader stderr:', raw.stderr)
      return {
        ok: false,
        installed: true,
        path: paths.hermesState,
        error: (raw && raw.error) || 'unreadable',
        items: []
      }
    }
    cache = { key, raw }
    return { ok: true, installed: true, path: paths.hermesState, items: toRows(raw) }
  })()

  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}

module.exports = { read, WINDOW_SECONDS }
