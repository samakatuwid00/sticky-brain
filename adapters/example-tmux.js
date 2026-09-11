'use strict'

/* Sticky Brain adapter template — tmux sessions as LIVE rows.

   To use it, copy this file into the board's adapters folder and restart the board:

     <userData>/adapters/          (tray menu: Open adapters folder)
     or wherever STICKY_BRAIN_ADAPTERS / config.json "adapters" points

   Every *.js file there is loaded at start-up. A file exports one adapter or an array of them.
   The full contract is documented at the top of src/main/sources/index.js; the short version:

     key       unique id, and the `agent` value on every row this adapter returns
     kind      must be 'agent' — folder adapters feed the LIVE list
     label     human name, shown on hover and in error lines
     badge     two letters for the row badge (optional, derived from label otherwise)
     hint      what provides this source, for the "not set up" line
     rank      tie-break at equal status, lower sorts first (built-ins use 0 and 1; default 50)
     detect()  sync and cheap — a stat, never a spawn. { installed, path }
     read()    async. { ok, path, items: [{ id, name, status, cwd, pid?, startedAt?, updatedAt? }] }
               status is busy | idle | saved | stale
     open(row) how a click opens the row, e.g. { action: 'focus-pid', pid, cwd, fallback: 'folder' }

   If anything here throws, rejects, or takes longer than a few seconds, the board shows
   "tmux sessions unreadable — <why>" under LIVE and carries on. It never takes the board down —
   but the file does run with full Node access in the board's main process, so only install
   adapters you have read. */

const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

// tmux puts its server socket at $TMUX_TMPDIR/tmux-<uid>/default. Its existence is the cheap,
// spawn-free "is tmux here" that detect() needs. No uid (Windows) means no tmux.
function socketPath () {
  if (typeof process.getuid !== 'function') return null
  return path.join(process.env.TMUX_TMPDIR || '/tmp', 'tmux-' + process.getuid(), 'default')
}

// One line per session, tab-separated, in the order FIELDS names them.
const FIELDS = ['session_name', 'session_created', 'session_attached', 'session_activity', 'pane_current_path', 'pane_pid']
const FORMAT = FIELDS.map(f => '#{' + f + '}').join('\t')

// A session that printed anything in the last 30 seconds is working.
const BUSY_MS = 30 * 1000

// Exported so the fixture check can test it without tmux.
function parse (stdout, now) {
  const rows = []
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue
    const [name, created, attached, activity, cwd, pid] = line.split('\t')
    const updatedAt = Number(activity) * 1000 || null
    rows.push({
      id: 'tmux:' + name,
      name,
      status: updatedAt && now - updatedAt < BUSY_MS ? 'busy' : 'idle',
      cwd: cwd || '',
      pid: Number(pid) || null,
      startedAt: Number(created) * 1000 || null,
      updatedAt,
      attached: Number(attached) > 0
    })
  }
  return rows
}

module.exports = {
  key: 'tmux',
  kind: 'agent',
  label: 'tmux',
  badge: 'TX',
  hint: 'tmux (a running tmux server)',
  rank: 60,

  detect () {
    const p = socketPath()
    return { installed: !!p && fs.existsSync(p), path: p }
  },

  read () {
    return new Promise(resolve => {
      execFile('tmux', ['list-sessions', '-F', FORMAT], { timeout: 3000 }, (err, stdout, stderr) => {
        // "no server running" is tmux's way of saying zero sessions, not a failure.
        if (err && /no server running/i.test(String(stderr))) return resolve({ ok: true, path: socketPath(), items: [] })
        if (err) return resolve({ ok: false, path: socketPath(), error: String(stderr || err.message).trim() })
        resolve({ ok: true, path: socketPath(), items: parse(stdout, Date.now()) })
      })
    })
  },

  // The pane's shell pid, walked up to the terminal emulator by the board's focus helper. An
  // attached session is found through its client; a detached one has no window, so its folder opens.
  open (row) {
    return { action: 'focus-pid', pid: row.pid, cwd: row.cwd, fallback: 'folder' }
  },

  parse
}
