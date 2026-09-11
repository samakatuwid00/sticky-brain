'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const { isWin } = require('./platform')

const home = os.homedir()

const claudeDir = process.env.STICKY_BRAIN_CLAUDE || path.join(home, '.claude')

// SB: Hermes Agent is the board's second agent. Its per-user root is %LOCALAPPDATA%\hermes —
// checked on this machine: `~/.hermes` does not exist, and `~/AppData/Local/hermes/hermes-agent`
// is the installed package, not a second data root.
const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
const hermesDir = process.env.STICKY_BRAIN_HERMES || path.join(localAppData, 'hermes')

/* ---- Local-first data, with the Second Brain vault as an optional override ----

   With nothing configured, the inbox, the backlog and done/ live in the app's own data folder
   (<userData>/data), seeded with a small sample on first run by local-data.js. Nothing outside
   the app is needed for a useful board.

   Pointing the board at a Second Brain vault is configuration, not code:

     STICKY_BRAIN_VAULT=<dir>    or   <userData>/config.json  { "vault": "<dir>" }

   and each path can be overridden on its own (env beats config.json beats the default):

     STICKY_BRAIN_DATA          dataDir       local data folder (default <userData>/data)
     STICKY_BRAIN_INBOX         inbox         pending records folder
     STICKY_BRAIN_BOARD_INBOX   boardInbox    quick-capture folder
     STICKY_BRAIN_BACKLOGS      backlogs      backlog Markdown file
     STICKY_BRAIN_EVIDENCE      evidence      Project Change Evidence Markdown file
     STICKY_BRAIN_PROJECTS      projects      projects.json (session cwd -> project name)
     STICKY_BRAIN_INBOX_HOOK    inboxHook     sb-inbox.ps1 receipt writer

   Everything resolves lazily: index.js moves userData for a dev run AFTER this module is loaded,
   and the paths have to follow it. */

// Plain `node` (build/check-sessions.js) loads this module too, where `require('electron')` is
// only a path string — so the app is reached for lazily and a missing one is survivable.
function userDataDir () {
  try { return require('electron').app.getPath('userData') } catch {
    // STICKY_BRAIN_USER_DATA only applies outside Electron — build/check-sources.js uses it to keep
    // a test run away from the real ~/.sticky-brain.
    const env = (process.env.STICKY_BRAIN_USER_DATA || '').trim()
    return env ? path.resolve(env) : path.join(home, '.sticky-brain')
  }
}

let fileCache = { dir: null, value: {} }
function fileConfig () {
  const dir = userDataDir()
  if (fileCache.dir === dir) return fileCache.value
  const file = path.join(dir, 'config.json')
  let value = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object') value = parsed
  } catch (err) {
    // A broken config.json is reported and ignored rather than taking the board down with it.
    if (err.code !== 'ENOENT') console.error('[config] ignoring ' + file + ':', err.message)
  }
  fileCache = { dir, value }
  return value
}

function setting (envName, key) {
  const env = process.env[envName]
  if (env && env.trim()) return path.resolve(env.trim())
  const v = fileConfig()[key]
  return typeof v === 'string' && v.trim() ? path.resolve(userDataDir(), v.trim()) : null
}

const vault = () => setting('STICKY_BRAIN_VAULT', 'vault')
const dataDir = () => setting('STICKY_BRAIN_DATA', 'dataDir') || path.join(userDataDir(), 'data')
const mode = () => (vault() ? 'vault' : 'local')

// Own override first, then the vault layout if a vault is configured, then the local layout.
function pick (envName, key, inVault, local) {
  const own = setting(envName, key)
  if (own) return own
  const v = vault()
  return v ? inVault(v) : local(dataDir())
}

// The design's states frame named `.claude/pending/captures.json` for group B. No such file
// exists. Pending capture records are one Markdown file each under the vault's `.inbox/`.
const paths = {
  sessions: path.join(claudeDir, 'sessions'),
  get inbox () {
    return pick('STICKY_BRAIN_INBOX', 'inbox', v => path.join(v, '.inbox'), d => path.join(d, 'inbox'))
  },
  // SB: round 3 · the board's OWN capture folder. Quick-capture used to write into .inbox/, and
  // the Telegram-gateway consolidate cron (.automation/sb-autoconsolidate.py, hard-wired to
  // .inbox/) folded those records into the wiki at 10:00 and emptied the board. Nothing but the
  // board reads or retires this folder. Same sb-inbox .md format, so the parser is shared.
  // Local mode has no cron to hide from, so captures land in the one inbox folder.
  get boardInbox () {
    return pick('STICKY_BRAIN_BOARD_INBOX', 'boardInbox', v => path.join(v, '.board-inbox'), () => paths.inbox)
  },
  get backlogs () {
    return pick('STICKY_BRAIN_BACKLOGS', 'backlogs', v => path.join(v, 'wiki', 'Open Backlogs.md'), d => path.join(d, 'backlog.md'))
  },
  get evidence () {
    return pick('STICKY_BRAIN_EVIDENCE', 'evidence', v => path.join(v, 'wiki', 'Project Change Evidence.md'), d => path.join(d, 'evidence.md'))
  },
  get projects () {
    return pick('STICKY_BRAIN_PROJECTS', 'projects', v => path.join(v, '.automation', 'projects.json'), d => path.join(d, 'projects.json'))
  },
  // The vault's sanctioned receipt writer. null in local mode: mark-done then retires records
  // itself by moving them to done/ (see markDone in index.js).
  get inboxHook () {
    return pick('STICKY_BRAIN_INBOX_HOOK', 'inboxHook', v => path.join(v, '.automation', 'sb-inbox.ps1'), () => null)
  },
  // Hermes keeps sessions in SQLite, not in a folder of JSON files — see sources/hermes.js.
  hermesState: path.join(hermesDir, 'state.db'),
  hermesPython: isWin
    ? path.join(hermesDir, 'hermes-agent', 'venv', 'Scripts', 'python.exe')
    : path.join(hermesDir, 'hermes-agent', 'venv', 'bin', 'python'),
  // SB: Hermes's own register of processes IT launched. Verified shape — a list of records
  // carrying `session_key` (the chat session id, same `<date>_<time>_<hex>` form state.db uses),
  // `pid` and `pid_scope`. It is the only file on this machine that maps a Hermes session to a
  // real process id, and it is what lets the LIVE list stop guessing (see sources/sessions.js).
  hermesProcesses: path.join(hermesDir, 'processes.json'),
  // SB: the Hermes Desktop App's packaged Electron binary. Checked on this machine — five
  // Hermes.exe processes run from here, one of which owns the window.
  hermesDesktopExe: path.join(hermesDir, 'hermes-agent', 'apps', 'desktop', 'release',
    'win-unpacked', 'Hermes.exe')
}

module.exports = { home, isWin, claudeDir, hermesDir, paths, vault, dataDir, mode, userDataDir }
