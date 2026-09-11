'use strict'

const fs = require('fs')
const path = require('path')
const registry = require('./index')

/* Third-party agent adapters, loaded from a folder — <userData>/adapters/ unless config.js says
   otherwise. Each *.js file exports one adapter, or an array of them, in the shape documented in
   sources/index.js, and is registered through the same register() the built-ins use. The file
   adapters/example-tmux.js in the repository is a commented template.

   Only `kind: 'agent'` is taken. The data sources (inbox, backlog, evidence) are drawn by renderer
   code keyed on their names, so a third-party one would have nowhere to appear.

   Isolation is light-touch, and all of it is try/catch: an adapter runs in the main process with
   full Node access, like any Electron plugin, so only load what you would run yourself. What IS
   guaranteed is that a bad adapter cannot take the board down:

     a file that fails to load or register -> a stand-in adapter that reads as broken
     a detect() / read() / open() that throws -> handled by the registry, as for built-ins
     a read() that never settles              -> timed out, read as broken

   Each of those is drawn as its own "unreadable" line under LIVE, beside the agents that work.
   A synchronous infinite loop cannot be interrupted from the thread it is blocking; only a worker
   could, and that is more machinery than a local board needs. */

const READ_TIMEOUT_MS = 4000

const message = err => String(err && err.message ? err.message : err).split('\n')[0]

// The adapter itself stays the prototype, so its own properties and `this` are untouched.
function guarded (adapter, ms) {
  const g = Object.create(adapter)
  g.external = true
  g.read = function () {
    let timer
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('read() gave no answer in ' + ms + 'ms')), ms)
    })
    return Promise.race([Promise.resolve().then(() => adapter.read()), timeout])
      .finally(() => clearTimeout(timer))
  }
  return g
}

function standIn (file, error) {
  const name = path.basename(file, '.js')
  return {
    key: 'ext:' + name,
    kind: 'agent',
    label: name + ' adapter',
    external: true,
    broken: true,
    detect: () => ({ installed: true, path: file }),
    read: async () => ({ ok: false, path: file, error: 'failed to load — ' + error }),
    open: () => null
  }
}

// -> [{ file, ok, keys?, error? }], one per *.js file, in name order. A missing folder is the
// normal case and answers [].
function loadDir (dir, opts) {
  const ms = (opts && opts.readTimeoutMs) || READ_TIMEOUT_MS
  let names
  try {
    names = fs.readdirSync(dir)
  } catch (err) {
    return err.code === 'ENOENT' ? [] : [{ file: dir, ok: false, error: message(err) }]
  }

  const results = []
  for (const name of names.filter(n => n.endsWith('.js')).sort()) {
    const file = path.join(dir, name)
    const keys = []
    try {
      const exported = require(file)
      const list = Array.isArray(exported) ? exported : [exported]
      if (!list.length || !list[0]) throw new Error('the file exports no adapter')
      for (const a of list) {
        if (!a || a.kind !== 'agent') {
          throw new Error("only kind: 'agent' adapters load from a folder" + (a && a.key ? ' (' + a.key + ' is ' + a.kind + ')' : ''))
        }
      }
      for (const a of list) {
        registry.register(guarded(a, ms))
        keys.push(a.key)
      }
      results.push({ file, ok: true, keys })
    } catch (err) {
      const error = message(err)
      try { registry.register(standIn(file, error)) } catch {}
      results.push({ file, ok: false, keys, error })
    }
  }
  return results
}

module.exports = { loadDir, READ_TIMEOUT_MS }
