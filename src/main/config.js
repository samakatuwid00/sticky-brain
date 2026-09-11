'use strict'

const os = require('os')
const path = require('path')

const home = os.homedir()

// Overridable so the board can be pointed at a copy of the vault without editing code.
const vaultDir = process.env.STICKY_BRAIN_VAULT || path.join(home, 'Documents', 'Second Brain')
const claudeDir = process.env.STICKY_BRAIN_CLAUDE || path.join(home, '.claude')

// SB: Hermes Agent is the board's second agent. Its per-user root is %LOCALAPPDATA%\hermes —
// checked on this machine: `~/.hermes` does not exist, and `~/AppData/Local/hermes/hermes-agent`
// is the installed package, not a second data root.
const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
const hermesDir = process.env.STICKY_BRAIN_HERMES || path.join(localAppData, 'hermes')

// The design's states frame named `.claude/pending/captures.json` for group B. No such file
// exists. Pending capture records are one Markdown file each under the vault's `.inbox/`.
const paths = {
  sessions: path.join(claudeDir, 'sessions'),
  inbox: path.join(vaultDir, '.inbox'),
  // SB: round 3 · the board's OWN capture folder. Quick-capture used to write into .inbox/, and
  // the Telegram-gateway consolidate cron (.automation/sb-autoconsolidate.py, hard-wired to
  // .inbox/) folded those records into the wiki at 10:00 and emptied the board. Nothing but the
  // board reads or retires this folder. Same sb-inbox .md format, so the parser is shared.
  boardInbox: path.join(vaultDir, '.board-inbox'),
  backlogs: path.join(vaultDir, 'wiki', 'Open Backlogs.md'),
  evidence: path.join(vaultDir, 'wiki', 'Project Change Evidence.md'),
  projects: path.join(vaultDir, '.automation', 'projects.json'),
  // Hermes keeps sessions in SQLite, not in a folder of JSON files — see sources/hermes.js.
  hermesState: path.join(hermesDir, 'state.db'),
  hermesPython: path.join(hermesDir, 'hermes-agent', 'venv', 'Scripts', 'python.exe'),
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

module.exports = { home, vaultDir, claudeDir, hermesDir, paths }
