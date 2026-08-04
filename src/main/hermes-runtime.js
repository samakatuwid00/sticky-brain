'use strict'

const fs = require('fs')
const { execFile, spawn } = require('child_process')
const { paths } = require('./config')

// SB: everything the board needs to know about Hermes as a set of RUNNING THINGS, as opposed to
// sources/hermes.js which knows it as a SQLite archive. Three questions live here:
//
//   * which Hermes processes exist right now (so a session row can stop claiming to be live
//     merely because state.db remembers it);
//   * which chat session ids map to a real pid (processes.json is the only file on this machine
//     that answers that, and it is what makes "no pid records" a solvable problem rather than an
//     apology);
//   * where the Hermes Desktop App is, so a saved session has somewhere honest to open.
//
// Everything that shells out is cached. The board polls every 5s and none of these answers change
// on that timescale.

// tasklist is ~50ms and gives image name + pid for everything. One sweep answers "is the desktop
// app up", "is the CLI up" and "is that pid still there" at once.
const TABLE_TTL = 15 * 1000
// A listening-port sweep is the expensive one (PowerShell start-up dominates), and the backend's
// port does not move while it is up.
const PORTS_TTL = 60 * 1000

let table = { at: 0, rows: null, pending: null }
let ports = { at: 0, list: [], pending: null }
let cli = { at: 0, path: null, pending: null }

// The desktop app is Hermes.exe out of the packaged Electron build; the CLI is hermes.exe out of
// the venv's Scripts folder. Both are literally "hermes" to a name match, so they are told apart
// by their executable name, not by a substring test.
const DESKTOP_IMAGE = 'hermes.exe'
const AGENT_IMAGES = ['hermes.exe', 'python.exe', 'pythonw.exe']

function parseTasklist (stdout) {
  const rows = []
  for (const line of String(stdout || '').split(/\r?\n/)) {
    // "Hermes.exe","18344","Console","1","150,000 K" — the first two fields are all that is wanted,
    // and a quoted CSV with no embedded quotes parses safely by hand.
    const m = /^"([^"]*)","(\d+)"/.exec(line.trim())
    if (m) rows.push({ image: m[1].toLowerCase(), pid: Number(m[2]) })
  }
  return rows
}

function processes () {
  const now = Date.now()
  if (table.rows && (now - table.at) < TABLE_TTL) return Promise.resolve(table.rows)
  if (table.pending) return table.pending
  table.pending = new Promise(resolve => {
    execFile('tasklist.exe', ['/fo', 'csv', '/nh'],
      { windowsHide: true, timeout: 6000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        const previous = table.rows
        table.pending = null
        // A failed sweep must not read as "nothing is running" — the previous answer is kept if
        // there is one, and an empty list is never cached, so the next poll tries again.
        const rows = err && !stdout ? [] : parseTasklist(stdout)
        if (rows.length) table = { at: Date.now(), rows, pending: null }
        resolve(rows.length ? rows : (previous || []))
      })
  })
  return table.pending
}

async function pidsFor (image) {
  const want = image.toLowerCase()
  return (await processes()).filter(r => r.image === want).map(r => r.pid)
}

// SB: the desktop app and the CLI are BOTH hermes.exe, and tasklist reports no path, so this
// cannot tell them apart on its own and does not pretend to. It is used for one thing only —
// "is there any hermes.exe to focus" — and the focus helper in index.js resolves the ambiguity for
// free by picking the process that owns a visible titled window. Only the desktop build owns one.
async function desktopPids () {
  return pidsFor(DESKTOP_IMAGE)
}

async function desktopRunning () {
  return (await desktopPids()).length > 0
}

// Any Hermes-side interpreter at all. A `hermes chat` session is a python.exe out of the venv, and
// tasklist does not report paths, so this is deliberately the weaker claim it looks like: "some
// Hermes-ish process exists", used only to corroborate a session that spoke seconds ago.
async function agentRunning () {
  const rows = await processes()
  return rows.some(r => AGENT_IMAGES.includes(r.image))
}

function pidAlive (pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}

// SB: processes.json is Hermes's own register of processes it launched, and every record carries
// the chat `session_key` that launched it plus that process's `pid`. Verified shape on this
// machine. `pid_scope` is 'host' for a pid on this machine — a sandboxed or remote record's pid
// means nothing to process.kill here, so it is skipped rather than tested.
//
// This is the ONLY hard, per-session liveness evidence available without the backend's session
// token, and it is one-directional: a session that appears here with a live pid is certainly
// running, while a session that does not appear here has merely not been proven to be.
function sessionPids () {
  let raw
  try { raw = fs.readFileSync(paths.hermesProcesses, 'utf8') } catch { return new Map() }
  let list
  try { list = JSON.parse(raw) } catch { return new Map() }
  if (!Array.isArray(list)) return new Map()

  const out = new Map()
  for (const rec of list) {
    if (!rec || typeof rec !== 'object') continue
    if (rec.pid_scope && rec.pid_scope !== 'host') continue
    const key = rec.session_key || rec.sessionKey
    const pid = Number(rec.pid)
    if (!key || !Number.isInteger(pid) || pid <= 0) continue
    if (!pidAlive(pid)) continue
    // Newest wins if one session left several live processes behind — any of them proves the
    // session, and the pid is only ever used as a window to walk up to.
    out.set(String(key), pid)
  }
  return out
}

// Listening TCP ports owned by a Hermes-side process. Used only to find the backend, whose port is
// ephemeral (see hermes-api.js). Get-NetTCPConnection is a cmdlet, so this one genuinely needs
// PowerShell; the output is a bare comma-separated list so nothing has to be JSON-parsed.
const PORT_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$want = @{}',
  "foreach ($p in Get-Process -Name hermes, python, pythonw) { $want[[int]$p.Id] = $true }",
  '$found = @()',
  'foreach ($c in Get-NetTCPConnection -State Listen) {',
  '  if ($want.ContainsKey([int]$c.OwningProcess)) { $found += [int]$c.LocalPort }',
  '}',
  "Write-Output ('SBPORTS ' + (($found | Sort-Object -Unique) -join ','))"
].join('\n')

function hermesListeningPorts () {
  const now = Date.now()
  if (ports.list.length && (now - ports.at) < PORTS_TTL) return Promise.resolve(ports.list)
  if (ports.pending) return ports.pending
  ports.pending = new Promise(resolve => {
    const encoded = Buffer.from(PORT_SCRIPT, 'utf16le').toString('base64')
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 10000 },
      (err, stdout) => {
        ports.pending = null
        const line = String(stdout || '').split(/\r?\n/).find(l => l.startsWith('SBPORTS '))
        if (!line) return resolve(ports.list)
        const list = line.slice('SBPORTS '.length).split(',')
          .map(s => Number(s.trim()))
          .filter(n => Number.isInteger(n) && n > 0)
        ports = { at: Date.now(), list, pending: null }
        resolve(list)
      })
  })
  return ports.pending
}

// where.exe applies PATHEXT, so this resolves hermes.exe, hermes.cmd or hermes.bat alike.
function cliPath () {
  const now = Date.now()
  if (cli.path !== null && (now - cli.at) < 5 * 60 * 1000) return Promise.resolve(cli.path)
  if (cli.pending) return cli.pending
  cli.pending = new Promise(resolve => {
    execFile('where.exe', ['hermes'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      const hit = err ? null : (String(stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || null)
      cli = { at: Date.now(), path: hit, pending: null }
      resolve(hit)
    })
  })
  return cli.pending
}

function desktopExe () {
  try { return fs.existsSync(paths.hermesDesktopExe) ? paths.hermesDesktopExe : null } catch { return null }
}

// Starting the desktop app, for when there is no window to focus. Detached and unref'd so the app
// outlives the board — Sticky Brain is not its parent in any meaningful sense, and a tray app that
// takes another application down with it would be a surprise.
//
// `hermes desktop` is the fallback rather than the first choice: it was checked, and it
// rebuilds/relaunches the Electron app, which is a much heavier thing to do than starting the
// binary that is already built.
async function launchDesktop () {
  const exe = desktopExe()
  if (exe) {
    try {
      const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false })
      child.on('error', err => console.error('[hermes] desktop launch failed:', err.message))
      child.unref()
      return { ok: true, how: 'exe', path: exe }
    } catch (err) {
      console.error('[hermes] desktop launch threw:', err && err.message)
    }
  }
  const bin = await cliPath()
  if (!bin) return { ok: false, error: 'the Hermes Desktop App was not found and hermes is not on PATH' }
  try {
    const child = spawn(bin, ['desktop'], { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', err => console.error('[hermes] `hermes desktop` failed:', err.message))
    child.unref()
    return { ok: true, how: 'cli' }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) }
  }
}

module.exports = {
  processes,
  desktopPids,
  desktopRunning,
  agentRunning,
  sessionPids,
  pidAlive,
  hermesListeningPorts,
  cliPath,
  desktopExe,
  launchDesktop,
  DESKTOP_IMAGE
}
