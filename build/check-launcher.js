// SB: verification affordance. Prints the launcher PowerShell that index.js would actually write
// for a given task, so the generated script can be read and run without launching the board:
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe build/check-launcher.js
//
// index.js is an Electron main file and cannot be required outside Electron, so the one function
// under test is lifted out of its source text rather than copied by hand — a copy would drift.
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8')
const skills = /const HERMES_SKILLS = '([^']+)'/.exec(src)[1]
const start = src.indexOf('function launcherScript (')
const end = src.indexOf('\n}', start) + 2
const body = src.slice(start, end)

// eslint-disable-next-line no-new-func
const launcherScript = new Function('HERMES_SKILLS', body + '; return launcherScript')(skills)

const out = process.argv[2] || path.join(require('os').tmpdir(), 'sb-launcher-check.ps1')
const promptFile = process.argv[3] || path.join(require('os').tmpdir(), 'sb-launcher-check.txt')
const cwd = process.argv[4] || process.cwd()
const bin = process.argv[5] || 'hermes'

fs.writeFileSync(out, launcherScript(bin, promptFile, cwd), 'utf8')
console.log('wrote', out)
console.log('--------------------------------')
console.log(fs.readFileSync(out, 'utf8'))
