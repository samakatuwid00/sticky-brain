'use strict'

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { paths } = require('../config')

// Claude Code: a session file named <pid>.json written by Claude Code itself. Verified shape:
// { pid, sessionId, cwd, startedAt, updatedAt, version, kind, entrypoint, name, status }
//
// `status` is read off a running install (2.1.220) and is NOT documented in the local docs
// mirror as far as this project checked. Treating it as a contract is inference; it can change
// in a point release. `alive()` is what the board actually trusts.

function alive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but belongs to someone else — still alive.
    return err.code === 'EPERM'
  }
}

function detect () {
  return { installed: fs.existsSync(paths.sessions), path: paths.sessions }
}

async function read () {
  let names
  try {
    names = await fsp.readdir(paths.sessions)
  } catch (err) {
    // A directory that does not exist at all means Claude Code is not installed. Anything else is
    // the board's primary agent being unreadable, which is a real fault and not an empty list.
    if (err.code === 'ENOENT') return { ok: true, installed: false, path: paths.sessions, items: [] }
    return { ok: false, installed: true, path: paths.sessions, error: err.code || 'unreadable', items: [] }
  }

  const items = []
  let unparsed = 0

  for (const name of names) {
    if (!name.endsWith('.json')) continue
    let raw
    try {
      raw = await fsp.readFile(path.join(paths.sessions, name), 'utf8')
    } catch { unparsed++; continue }

    let s
    try { s = JSON.parse(raw) } catch { unparsed++; continue }
    if (!s || typeof s.pid !== 'number') { unparsed++; continue }

    const running = alive(s.pid)
    items.push({
      id: s.sessionId || String(s.pid),
      // SB: which agent a row came from — always the adapter's key. The renderer draws it as a
      // badge, and the reveal handler hands the row back to this adapter's open().
      agent: 'claude',
      pid: s.pid,
      // SB: sessionId travels beside `id` because `id` falls back to the pid when the file has
      // no sessionId, and the redirect handler must be able to tell those two apart.
      sessionId: s.sessionId || null,
      name: s.name || String(s.pid),
      cwd: s.cwd || '',
      startedAt: s.startedAt || null,
      updatedAt: s.updatedAt || null,
      version: s.version || null,
      // The file's own word is only believed while the process is alive.
      status: running ? (s.status === 'busy' ? 'busy' : 'idle') : 'stale'
    })
  }

  return { ok: true, installed: true, path: paths.sessions, items, unparsed }
}

// Only a Claude Code row has a pid whose ancestor chain leads to a terminal window. A live process
// that genuinely owns no window (a hook, a headless run) falls back to its folder.
function open (row) {
  return { action: 'focus-pid', pid: Number(row && row.pid), cwd: (row && row.cwd) || null, fallback: 'folder' }
}

module.exports = {
  key: 'claude',
  kind: 'agent',
  label: 'Claude Code',
  badge: 'CC',
  hint: 'Claude Code (~/.claude/sessions)',
  // Sort tie-break at equal status: a Claude Code row's liveness is verified against a real pid,
  // and the stronger claim belongs higher.
  rank: 0,
  detect,
  read,
  open
}
