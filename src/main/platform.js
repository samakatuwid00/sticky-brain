'use strict'

const fs = require('fs')
const path = require('path')
const { execFile, spawn } = require('child_process')

/* Every OS-specific spawn the board makes goes through here, and nowhere else.

   The board's window-focus helper is Win32 through PowerShell, its process sweep is tasklist, and
   its port sweep is a PowerShell cmdlet. None of those exist on macOS or Linux, and spawning a
   binary that is not there turns "this OS cannot do that" into a confusing ENOENT somewhere far
   from the click that caused it. So each capability is named, asked about with supports(), and a
   caller on an OS without it gets `unsupported()` — a result shaped like any other failure, with
   words the renderer can show — instead of a spawn.

   STICKY_BRAIN_PLATFORM overrides process.platform. It exists for build/check-sources.js, which
   has to prove the non-Windows paths never spawn while running on Windows. */

const PLATFORM = (process.env.STICKY_BRAIN_PLATFORM || process.platform).trim()
const isWin = PLATFORM === 'win32'
const isMac = PLATFORM === 'darwin'
const isLinux = PLATFORM === 'linux'

// A binary on PATH, found with one stat per PATH entry — never a spawn, so asking costs nothing on
// a machine that does not have it. Used to decide a capability before anything is started.
function onPath (name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const p = path.join(dir, name)
    try { if (fs.statSync(p).isFile()) return p } catch {}
  }
  return null
}

const CAPS = {
  // tasklist: image name + pid for every process.
  processList: isWin,
  // Bringing a session's window forward. Windows: EnumWindows / SetForegroundWindow through
  // PowerShell (the session-click focus walk in index.js). macOS: System Events through osascript,
  // best-effort. Linux: xdotool, and only under X11 with xdotool installed — Wayland has no
  // cross-app focus call at all, so there it stays unsupported.
  windowFocus: isWin || isMac || (isLinux && !!process.env.DISPLAY && !!onPath('xdotool')),
  // Get-NetTCPConnection through PowerShell (finding the Hermes backend's ephemeral port).
  listeningPorts: isWin,
  // Running a .ps1 hook such as the vault's sb-inbox.ps1.
  powershell: isWin
}

function supports (cap) {
  return CAPS[cap] === true
}

function unsupported (what) {
  return {
    ok: false,
    unsupported: true,
    status: 'UNSUPPORTED',
    mode: 'unsupported',
    error: (what || 'this action') + ' is not supported on this OS (' + PLATFORM + ')'
  }
}

// Resolves { ok, stdout, stderr, err } and never rejects. An exec error still carries whatever
// the child printed, because a script that exits non-zero after emitting its answer is common.
function run (file, args, opts) {
  return new Promise(resolve => {
    execFile(file, args, { windowsHide: true, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, err: err || null, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

// -EncodedCommand takes UTF-16LE base64, which sidesteps every layer of cmd/PowerShell quoting and
// is not subject to the machine's script execution policy.
function powershell (script, opts) {
  if (!supports('powershell')) return Promise.resolve(unsupported('PowerShell'))
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return run('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    { timeout: 10000, ...opts })
}

// The -Command form, for invoking a .ps1 with arguments. The caller owns the quoting.
function powershellCommand (command, opts) {
  if (!supports('powershell')) return Promise.resolve(unsupported('PowerShell'))
  return run('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', command],
    { timeout: 15000, ...opts })
}

function tasklist () {
  if (!supports('processList')) return Promise.resolve(unsupported('listing processes'))
  return run('tasklist.exe', ['/fo', 'csv', '/nh'], { timeout: 6000, maxBuffer: 4 * 1024 * 1024 })
}

// where.exe applies PATHEXT, so it resolves hermes.exe, hermes.cmd or hermes.bat alike. `which` is
// the same question on macOS and Linux, and exists on both, so this one is not gated.
async function which (name) {
  const r = await run(isWin ? 'where.exe' : 'which', [name], { timeout: 5000 })
  if (!r.ok) return null
  return r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || null
}

// Detached and unref'd so the child outlives the board. Not OS-specific in itself; kept here so
// there is one place in the main process that starts long-lived children.
function spawnDetached (file, args, opts) {
  try {
    const child = spawn(file, args || [], { detached: true, stdio: 'ignore', ...opts })
    child.on('error', err => console.error('[platform] ' + file + ' failed:', err.message))
    child.unref()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) }
  }
}

/* ---- Window focus off Windows: best-effort, same result shape as the Windows helper ----

   Both answer { status, title?, detail? } with the Windows helper's status words — OK, NOWINDOW,
   DEAD, NOFOCUS, SCRIPTFAIL, UNSUPPORTED — so index.js treats every OS alike after the call.

   The session's pid is the agent's own process, which owns no window; the terminal that does is
   an ancestor. One `ps` sweep gives the parent chain, like the single WMI sweep on Windows. */

async function ancestry (pid) {
  const r = await run('ps', ['-A', '-o', 'pid=,ppid='], { timeout: 4000 })
  if (!r.stdout) return { error: r.err ? String(r.err.message).split('\n')[0] : 'ps printed nothing' }
  const parent = new Map()
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(line)
    if (m) parent.set(Number(m[1]), Number(m[2]))
  }
  if (!parent.has(pid)) return { dead: true }
  const chain = []
  for (let cur = pid, i = 0; i < 12 && cur > 1 && parent.has(cur); i++) {
    chain.push(cur)
    cur = parent.get(cur)
  }
  return { chain }
}

// System Events knows every app process by unix id; the nearest ancestor that is a foreground app
// is the terminal. Needs the Automation permission, which macOS asks for on the first click.
const MAC_FOCUS_PID = [
  'on run argv',
  '  tell application "System Events"',
  '    repeat with p in argv',
  '      set hits to (every process whose unix id is (p as integer) and background only is false)',
  '      if (count of hits) > 0 then',
  '        set frontmost of item 1 of hits to true',
  '        return "OK " & (name of item 1 of hits)',
  '      end if',
  '    end repeat',
  '  end tell',
  '  return "NOWINDOW"',
  'end run'
].join('\n')

function fromOsascript (r) {
  const out = r.stdout.trim()
  if (out.startsWith('OK')) return { status: 'OK', title: out.slice(2).trim() }
  if (out === 'NOWINDOW') return { status: 'NOWINDOW', detail: 'no foreground app in the ancestor chain' }
  const why = (r.stderr.trim() || (r.err && r.err.message) || 'no output').split('\n')[0]
  // -1743 / "not allowed": the Automation permission was refused, not a broken helper.
  if (/-1743|not allowed/i.test(why)) return { status: 'NOFOCUS', detail: why }
  return { status: 'SCRIPTFAIL', detail: why }
}

async function xdotoolFocus (args) {
  const found = await run('xdotool', ['search', '--onlyvisible', ...args], { timeout: 3000 })
  const id = found.stdout.split(/\r?\n/).map(s => s.trim()).find(s => /^\d+$/.test(s))
  if (!id) return null
  const r = await run('xdotool', ['windowactivate', id], { timeout: 3000 })
  return r.ok ? { status: 'OK', title: 'window ' + id } : { status: 'NOFOCUS', detail: (r.stderr.trim() || 'windowactivate failed').split('\n')[0] }
}

async function focusPid (pid) {
  if (!supports('windowFocus') || isWin) return { status: 'UNSUPPORTED', detail: PLATFORM }
  if (!Number.isInteger(pid) || pid <= 0) return { status: 'BADPID', detail: 'pid ' + pid }
  const a = await ancestry(pid)
  if (a.error) return { status: 'SCRIPTFAIL', detail: a.error }
  if (a.dead) return { status: 'DEAD', detail: 'process is gone' }
  if (isMac) return fromOsascript(await run('osascript', ['-e', MAC_FOCUS_PID, ...a.chain.map(String)], { timeout: 8000 }))
  for (const p of a.chain) {
    const hit = await xdotoolFocus(['--pid', String(p)])
    if (hit) return hit
  }
  return { status: 'NOWINDOW', detail: 'no visible window in the ancestor chain: ' + a.chain.join(' <- ') }
}

// An application by name — the Hermes Desktop App, for a saved session with no pid of its own.
// The name is the only value that reaches a script, so it is held to what an app name can be.
async function focusApp (name) {
  if (!supports('windowFocus') || isWin) return { status: 'UNSUPPORTED', detail: PLATFORM }
  if (!/^[A-Za-z0-9 _.-]+$/.test(String(name || ''))) return { status: 'BADNAME', detail: String(name) }
  if (isMac) {
    const r = await run('osascript', ['-e', 'tell application "' + name + '" to activate', '-e', 'return "OK ' + name + '"'], { timeout: 8000 })
    return fromOsascript(r)
  }
  return (await xdotoolFocus(['--name', name])) || { status: 'DEAD', detail: 'no visible ' + name + ' window' }
}

module.exports = {
  platform: PLATFORM,
  isWin,
  supports,
  unsupported,
  powershell,
  powershellCommand,
  tasklist,
  which,
  spawnDetached,
  onPath,
  focusPid,
  focusApp
}
