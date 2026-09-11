'use strict'

const fs = require('fs')
const path = require('path')
const config = require('./config')
const registry = require('./sources')

/* First-run setup: one card at the top of the board, never a screen in front of it.

   On a machine where nothing has been decided yet the board renders as it always does, and the
   card above LIVE shows where the data folder is and which agents were found, each with a toggle.
   "save" writes the choices into config.json; "skip" writes nothing but a marker. Either way the
   card does not come back. Every choice it offers is also plain config.json (see config.js), so
   the card is a shortcut, not the only way in.

   Plain Node, no Electron — build/check-sources.js drives it directly. */

const MARKER = 'setup-done'

const markerFile = () => path.join(config.userDataDir(), MARKER)
const message = err => String(err && err.message ? err.message : err).split('\n')[0]

// Nothing has ever been decided on this machine. An install that predates setup already has
// board-state.json or config.json, and is not asked.
function isFirstRun () {
  const dir = config.userDataDir()
  return !['config.json', MARKER, 'board-state.json'].some(n => fs.existsSync(path.join(dir, n)))
}

function state () {
  return {
    firstRun: isFirstRun(),
    configFile: config.configFile(),
    mode: config.mode(),
    dataDir: config.dataDir(),
    vault: config.vault(),
    adaptersDir: config.paths.adapters,
    // Stand-ins for adapters that failed to load are not something to switch on.
    agents: registry.list('agent').filter(a => !a.broken).map(a => {
      const d = registry.detect(a)
      return { key: a.key, label: a.label || a.key, installed: d.installed, path: d.path, enabled: config.agentEnabled(a.key) }
    })
  }
}

function writeMarker () {
  fs.mkdirSync(config.userDataDir(), { recursive: true })
  fs.writeFileSync(markerFile(), new Date().toISOString(), 'utf8')
}

// patch = { dataDir?, agents?: { <key>: boolean } }. Merged into config.json, never replacing
// keys it does not name. An unreadable config.json is left alone rather than overwritten.
function save (patch) {
  const p = patch || {}
  const file = config.configFile()
  let current = {}
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') return { ok: false, error: 'config.json is unreadable (' + message(err) + ') — left as it is' }
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    return { ok: false, error: 'config.json is not an object — left as it is' }
  }

  const next = { ...current }
  if (typeof p.dataDir === 'string' && p.dataDir.trim()) next.dataDir = path.resolve(p.dataDir.trim())
  if (p.agents && typeof p.agents === 'object') {
    // Only `false` is stored: an agent is on unless config.json says otherwise.
    const agents = { ...(current.agents && typeof current.agents === 'object' ? current.agents : {}) }
    for (const [key, on] of Object.entries(p.agents)) {
      if (!registry.get(key)) continue
      if (on === false) agents[key] = false
      else delete agents[key]
    }
    if (Object.keys(agents).length) next.agents = agents
    else delete next.agents
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
    writeMarker()
  } catch (err) {
    return { ok: false, error: 'could not write ' + file + ' (' + message(err) + ')' }
  }
  config.reload()
  return { ok: true, state: state() }
}

function dismiss () {
  try { writeMarker() } catch (err) { return { ok: false, error: message(err) } }
  return { ok: true, state: state() }
}

module.exports = { state, save, dismiss, isFirstRun }
