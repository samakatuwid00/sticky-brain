// SB: verification affordance, not a feature. Runs the sessions source outside Electron's window
// so both agents' rows can be read on a terminal:
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe build/check-sessions.js
const path = require('path')
const sessions = require(path.join(__dirname, '..', 'src', 'main', 'sources', 'sessions.js'))

sessions.read().then(r => {
  console.log('ok:', r.ok, '| unparsed:', r.unparsed, '| items:', r.items.length)
  console.log('hermes:', JSON.stringify(r.hermes))
  for (const i of r.items) {
    console.log([
      (i.agent || '?').padEnd(7),
      (i.status || '?').padEnd(6),
      String(i.name).slice(0, 34).padEnd(34),
      String(i.project || '~').slice(0, 16).padEnd(16),
      String(i.version || '-').slice(0, 24).padEnd(24),
      'pid=' + (i.pid == null ? '-' : i.pid),
      'upd=' + (i.updatedAt ? new Date(i.updatedAt).toLocaleTimeString() : '-')
    ].join(' '))
  }
}).catch(e => { console.error('FAIL', e) })
