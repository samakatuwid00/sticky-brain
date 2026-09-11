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
//     does for Claude Code — unless processes.json maps it to one (see the live filter below).
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
  if (fs.existsSync(paths.hermesPython)) return paths.hermesPython
  return process.platform === 'win32' ? 'python.exe' : 'python3'
}

// SB: External child processes (Python) cannot read inside app.asar — they need the
// unpacked copy. In dev mode __dirname is a real filesystem path, so the replace is a no-op.
const SCRIPT = path.join(__dirname, 'hermes-sessions.py')
  .replace('app.asar', 'app.asar.unpacked')

// The database, window and interpreter are parameters so build/check-sources.js can run the real
// script against a fixture database; the board always uses the defaults.
function runReader (db, windowSeconds, limit, python) {
  return new Promise(resolve => {
    const py = python || pythonPath()
    if (!py) return resolve({ ok: false, error: 'no python to read the hermes store with' })
    execFile(py, [SCRIPT, db || paths.hermesState, String(windowSeconds || WINDOW_SECONDS), String(limit || MAX_ROWS)],
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
function toRows (raw, now) {
  now = now || Date.now()
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
    // SB: carried through rather than only being consumed by statusFor — grade() re-decides
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

// The store as it is on disk: `{ ok, installed, path, items }`, items being ungraded rows.
async function readStore () {
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

/* ---- SB: the Hermes live filter ---- */

// A Hermes row used to be called live purely because state.db had heard from it within two hours.
// Measured, that made the LIVE list a scrollback: fourteen rows, of which none was running, and
// clicking any of them reached the "hermes records no pid" dead end. state.db is an ARCHIVE — a
// row in it is evidence that a session existed, never that it exists.
//
// So liveness is now decided against the machine, and a row is live only on EVIDENCE:
//
//   'process'  processes.json maps the session id to a pid that answers process.kill(pid, 0).
//              Hard evidence, and it also hands the row a pid — which is what turns "no pid
//              records" from an apology into a window the board can focus.
//   'api'      the local backend was reachable AND authorised AND said so itself. Strongest of
//              the three, and normally unavailable: the backend's session token is minted into
//              its own environment and Sticky Brain cannot read it (see hermes-api.js).
//   'recent'   the session spoke within LIVE_MS and a process of the right kind is running.
//              This is INFERENCE and is labelled as such: it is what keeps the session you are
//              typing in right now on the board, since a plain chat launches no subprocess and
//              therefore leaves no trace in processes.json.
//
// Everything else is 'saved' — real, openable history, and explicitly not a claim that anything
// is running. Nothing is dropped: a saved row still opens, it just opens in the Hermes Desktop App
// rather than pretending to have a terminal.
const LIVE_MS = 90 * 1000

// Saved rows sort below every live one, but the widget is 360px wide and the archive is unbounded,
// so the tail is cut here rather than allowed to push the live list off the bottom. The count of
// what was cut travels with the source so the board can say so instead of quietly shortening.
const MAX_SAVED = 4

function ownerRunning (origin, procs) {
  // `source` in state.db is 'desktop' for a session belonging to the Hermes Desktop App and 'cli'
  // for one belonging to a `hermes chat`. An unrecognised origin gets the weaker any-Hermes test
  // rather than being assumed dead.
  if (origin === 'desktop') return procs.desktop
  if (origin === 'cli') return procs.agent
  return procs.desktop || procs.agent
}

async function evidence () {
  // Required here, not at the top: the runtime and the backend client are only ever consulted
  // when Hermes is installed, so a machine without it never loads either.
  const runtime = require('../hermes-runtime')
  const api = require('../hermes-api')
  // Every one of these is cached inside its own module and none of them is on the 5s poll's
  // critical path more than once a cache period. They are gathered together so one slow answer
  // does not serialise behind another.
  const [pids, desktop, agent, backend] = await Promise.all([
    Promise.resolve().then(() => runtime.sessionPids()).catch(() => new Map()),
    runtime.desktopRunning().catch(() => false),
    runtime.agentRunning().catch(() => false),
    api.read().catch(() => ({ ok: false, authorized: false, items: [] }))
  ])
  const active = new Set()
  if (backend && backend.ok && backend.authorized) {
    for (const row of backend.items || []) if (row.active === true) active.add(row.id)
  }
  return { pids, procs: { desktop, agent }, active, backend }
}

function noEvidence () {
  return { pids: new Map(), procs: { desktop: false, agent: false }, active: new Set(), backend: null }
}

function classify (row, ev, now) {
  // The store's own word about an ended session is final — nothing else needs consulting.
  if (row.endedAt) return { status: 'saved', liveBy: null, pid: null }

  const pid = ev.pids.get(row.sessionId) || null
  if (pid) {
    return { status: (now - (row.updatedAt || 0)) <= LIVE_MS ? 'busy' : 'idle', liveBy: 'process', pid }
  }
  if (ev.active.has(row.sessionId)) {
    return { status: (now - (row.updatedAt || 0)) <= LIVE_MS ? 'busy' : 'idle', liveBy: 'api', pid: null }
  }
  if (row.updatedAt && (now - row.updatedAt) <= LIVE_MS && ownerRunning(row.origin, ev.procs)) {
    return { status: 'busy', liveBy: 'recent', pid: null }
  }
  return { status: 'saved', liveBy: null, pid: null }
}

// Pure: store rows + evidence -> the rows the board shows, and the filter's own accounting.
function grade (rows, ev, now) {
  const graded = rows.map(x => {
    const verdict = classify(x, ev, now)
    return {
      ...x,
      status: verdict.status,
      // SB: a real pid where one exists, so the reveal handler can focus the window instead of
      // reporting that Hermes keeps no pids. Still null for most rows, and honestly so.
      pid: verdict.pid,
      // SB: WHY this row is on the board. 'recent' is inference and the renderer says so.
      liveBy: verdict.liveBy
    }
  })
  const live = graded.filter(x => x.status !== 'saved')
  const saved = graded.filter(x => x.status === 'saved')
  return {
    items: [...live, ...saved.slice(0, MAX_SAVED)],
    // SB: the live filter, shown rather than performed silently. `live` is how many rows carried
    // real evidence, `saved` how much archive was found, `hidden` how much of that archive was
    // cut to keep the widget readable — a shortened list that says it was shortened.
    live: live.length,
    saved: saved.length,
    hidden: Math.max(0, saved.length - MAX_SAVED)
  }
}

/* ---- the adapter ---- */

function detect () {
  return { installed: fs.existsSync(paths.hermesState), path: paths.hermesState }
}

async function read () {
  const store = await readStore()
  if (store.installed === false || store.ok === false) {
    return { ...store, meta: { live: 0, saved: 0, hidden: 0, backend: 'offline' } }
  }
  // Evidence is gathered once per read, not once per row.
  const ev = await evidence()
  const g = grade(store.items, ev, Date.now())
  return {
    ok: true,
    installed: true,
    path: store.path,
    items: g.items,
    meta: {
      live: g.live,
      saved: g.saved,
      hidden: g.hidden,
      // Whether the local backend could be consulted at all. 'unauthorized' is a real answer and
      // is not the same fact as 'offline'.
      backend: ev.backend && ev.backend.ok
        ? (ev.backend.authorized ? 'ok' : 'unauthorized')
        : 'offline'
    }
  }
}

// A session with a live registered process is focused like any other; one without is history, and
// history belongs in the app that can open it — the Hermes Desktop App, started if need be.
function open (row) {
  const sessionId = (row && row.sessionId) || null
  const pid = Number(row && row.pid)
  if (Number.isInteger(pid) && pid > 0) {
    return { action: 'focus-pid', pid, cwd: (row && row.cwd) || null, sessionId, fallback: 'hermes-desktop' }
  }
  return { action: 'hermes-desktop', sessionId }
}

module.exports = {
  key: 'hermes',
  kind: 'agent',
  label: 'Hermes Agent',
  badge: 'HM',
  hint: 'Hermes Agent (state.db)',
  // Below Claude Code at equal status: a Hermes row's liveness is partly inferred.
  rank: 1,
  detect,
  read,
  open,
  // For build/check-sources.js.
  readStore,
  runReader,
  toRows,
  grade,
  noEvidence,
  WINDOW_SECONDS,
  LIVE_MS,
  MAX_SAVED
}
