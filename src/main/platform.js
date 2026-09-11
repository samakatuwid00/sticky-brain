'use strict'

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

const CAPS = {
  // tasklist: image name + pid for every process.
  processList: isWin,
  // Win32 EnumWindows / SetForegroundWindow through PowerShell (the session-click focus walk).
  windowFocus: isWin,
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

module.exports = {
  platform: PLATFORM,
  isWin,
  supports,
  unsupported,
  powershell,
  powershellCommand,
  tasklist,
  which,
  spawnDetached
}
