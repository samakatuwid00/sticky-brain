// Fixture checks for every source adapter, the registry, the snapshot and the platform layer.
//
//   node build/check-sources.js          (or: npm run check)
//
// Plain Node, no dependencies, nothing installed required: every path the sources read is pointed
// at test/fixtures/ (or a temp copy of it) through the STICKY_BRAIN_* overrides BEFORE any source
// module loads. A second pass re-runs this file as a child process playing a stranger's machine —
// nothing installed, a non-Windows platform — with child_process trapped, to prove that such a
// machine gets a clean "not installed" board and that nothing is ever spawned.
//
// The one check that needs Python (the real hermes-sessions.py against a SQLite built from
// test/fixtures/hermes/state.sql) is skipped, not failed, when no Python is available.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')

const ROOT = path.join(__dirname, '..')
const FIX = path.join(ROOT, 'test', 'fixtures')
const SRC = path.join(ROOT, 'src', 'main')
const STRANGER = process.argv.includes('--stranger')

const results = []
async function check (name, fn) {
  try {
    await fn()
    results.push(['PASS', name])
  } catch (err) {
    results.push(['FAIL', name, err && err.message ? err.message.split('\n')[0] : String(err)])
  }
}
function skip (name, why) { results.push(['SKIP', name, why]) }

function report () {
  for (const [status, name, note] of results) console.log(status.padEnd(4), name + (note ? ' — ' + note : ''))
  const failed = results.filter(r => r[0] === 'FAIL').length
  const passed = results.filter(r => r[0] === 'PASS').length
  const skipped = results.filter(r => r[0] === 'SKIP').length
  console.log(`${STRANGER ? '[stranger] ' : ''}${passed} passed, ${failed} failed, ${skipped} skipped`)
  return failed
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-check-'))
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} }

// Nothing from the caller's own configuration may leak into a fixture run.
for (const k of Object.keys(process.env)) if (k.startsWith('STICKY_BRAIN_')) delete process.env[k]
delete process.env.HERMES_DASHBOARD_SESSION_TOKEN

/* ---------------------------------------------------------------- stranger machine (child) ---- */

async function strangerMain () {
  // Trap every way of starting a process BEFORE the sources load — they destructure at require.
  const cp = require('child_process')
  const spawned = []
  for (const fn of ['execFile', 'spawn', 'exec', 'execFileSync', 'spawnSync', 'execSync']) {
    cp[fn] = (...args) => { spawned.push(fn + ' ' + args[0]); throw new Error('spawn trapped: ' + args[0]) }
  }

  const empty = path.join(TMP, 'nothing-here')
  process.env.STICKY_BRAIN_PLATFORM = 'linux'
  process.env.STICKY_BRAIN_USER_DATA = path.join(empty, 'user-data')
  process.env.STICKY_BRAIN_CLAUDE = path.join(empty, 'claude')
  process.env.STICKY_BRAIN_HERMES = path.join(empty, 'hermes')
  process.env.STICKY_BRAIN_DATA = path.join(empty, 'data')

  const platform = require(path.join(SRC, 'platform'))
  const runtime = require(path.join(SRC, 'hermes-runtime'))
  const snapshot = require(path.join(SRC, 'snapshot'))
  const registry = require(path.join(SRC, 'sources'))

  await check('platform: non-Windows reports no Windows capabilities', () => {
    assert.strictEqual(platform.isWin, false)
    for (const cap of ['processList', 'windowFocus', 'listeningPorts', 'powershell']) {
      assert.strictEqual(platform.supports(cap), false, cap)
    }
  })
  await check('platform: PowerShell / tasklist answer unsupported instead of spawning', async () => {
    for (const r of [await platform.powershell('Write-Output 1'), await platform.powershellCommand('1'), await platform.tasklist()]) {
      assert.strictEqual(r.ok, false)
      assert.strictEqual(r.unsupported, true)
      assert.strictEqual(r.mode, 'unsupported')
      assert.match(r.error, /not supported on this OS \(linux\)/)
    }
  })
  await check('hermes-runtime: process and port sweeps are empty, not errors', async () => {
    assert.deepStrictEqual(await runtime.processes(), [])
    assert.deepStrictEqual(await runtime.hermesListeningPorts(), [])
    assert.strictEqual(await runtime.desktopRunning(), false)
  })
  await check('detect: every adapter reports not installed on an empty machine', () => {
    for (const a of registry.list()) {
      const d = registry.detect(a)
      if (a.key === 'inbox') continue // local mode: the inbox folder is the app's own, created at start
      assert.strictEqual(d.installed, false, a.key)
    }
  })
  await check('snapshot: nothing installed is a clean board — no source errors', async () => {
    const snap = await snapshot.build()
    assert.deepStrictEqual(snap.sources.map(s => s.key), ['sessions', 'inbox', 'backlogs', 'evidence'])
    for (const s of snap.sources) assert.strictEqual(s.ok, true, s.key + ': ' + s.error)
    const installed = Object.fromEntries(snap.sources.map(s => [s.key, s.installed]))
    assert.deepStrictEqual(installed, { sessions: false, inbox: true, backlogs: false, evidence: false })
    assert.strictEqual(snap.okCount, snap.detectedCount)
    assert.strictEqual(snap.live.items.length, 0)
    for (const a of Object.values(snap.live.byAgent)) {
      assert.strictEqual(a.installed, false, a.key)
      assert.strictEqual(a.ok, true, a.key)
      assert.strictEqual(a.error, null, a.key)
    }
    assert.match(snap.sources[0].hint, /Claude Code.*Hermes Agent/)
  })
  await check('nothing was spawned on the stranger machine', () => {
    assert.deepStrictEqual(spawned, [])
  })
}

/* ------------------------------------------------------------------------ fixture run (main) ---- */

function copyDir (from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name)
    const b = path.join(to, e.name)
    if (e.isDirectory()) copyDir(a, b)
    else fs.copyFileSync(a, b)
  }
}

function findPython () {
  const { execFileSync } = require('child_process')
  const tries = [process.env.PYTHON, 'python3', 'python'].filter(Boolean)
  for (const py of tries) {
    try {
      execFileSync(py, ['-c', 'import sqlite3, json'], { stdio: 'ignore', timeout: 15000, windowsHide: true })
      return py
    } catch {}
  }
  return null
}

async function main () {
  // Temp copies where the check needs to add something the fixture cannot hold statically: a
  // session file for a pid that is certainly alive (this one), and a BOM-prefixed inbox record.
  const claudeDir = path.join(TMP, 'claude')
  copyDir(path.join(FIX, 'claude'), claudeDir)
  fs.writeFileSync(path.join(claudeDir, 'sessions', process.pid + '.json'), JSON.stringify({
    pid: process.pid, sessionId: 'fixture-live-session', cwd: '/work/alpha/app',
    startedAt: Date.now() - 60000, name: 'live fixture session', status: 'busy', version: '2.1.220'
  }))
  const inboxDir = path.join(TMP, 'inbox')
  copyDir(path.join(FIX, 'data', 'inbox'), inboxDir)
  const sample = fs.readFileSync(path.join(inboxDir, '2026-09-01T0900-sample.md'), 'utf8')
  fs.writeFileSync(path.join(inboxDir, '2026-09-04T0800-bom.md'),
    String.fromCharCode(0xFEFF) + sample.replace('2026-09-01T09:00', '2026-09-04T08:00').replace('Fixture pending task', 'BOM-prefixed task'))

  process.env.STICKY_BRAIN_USER_DATA = path.join(TMP, 'user-data')
  process.env.STICKY_BRAIN_CLAUDE = claudeDir
  process.env.STICKY_BRAIN_HERMES = path.join(TMP, 'no-hermes')
  process.env.STICKY_BRAIN_DATA = path.join(TMP, 'data')
  process.env.STICKY_BRAIN_INBOX = inboxDir
  process.env.STICKY_BRAIN_BOARD_INBOX = inboxDir
  process.env.STICKY_BRAIN_BACKLOGS = path.join(FIX, 'data', 'backlog.md')
  process.env.STICKY_BRAIN_EVIDENCE = path.join(FIX, 'data', 'evidence.md')
  process.env.STICKY_BRAIN_PROJECTS = path.join(FIX, 'data', 'projects.json')

  const registry = require(path.join(SRC, 'sources'))
  const sessions = require(path.join(SRC, 'sources', 'sessions'))
  const hermes = require(path.join(SRC, 'sources', 'hermes'))
  const snapshot = require(path.join(SRC, 'snapshot'))
  const platform = require(path.join(SRC, 'platform'))

  /* registry */
  await check('registry: built-in adapters, in board order', () => {
    assert.deepStrictEqual(registry.list('agent').map(a => a.key), ['claude', 'hermes'])
    assert.deepStrictEqual(registry.list('data').map(a => a.key), ['inbox', 'backlogs', 'evidence'])
    for (const a of registry.list()) {
      for (const fn of ['detect', 'read', 'open']) assert.strictEqual(typeof a[fn], 'function', a.key + '.' + fn)
      assert.ok(a.label && a.hint, a.key + ' label/hint')
    }
  })
  await check('registry: rejects malformed and duplicate adapters', () => {
    assert.throws(() => registry.register({ key: 'x', kind: 'agent', detect () {}, read () {} }), /open/)
    assert.throws(() => registry.register({ key: 'x', kind: 'nope', detect () {}, read () {}, open () {} }), /kind/)
    assert.throws(() => registry.register({ ...registry.get('claude') }), /already registered/)
  })
  await check('registry: a throwing adapter reads as a failure, never a crash', async () => {
    const bad = { key: 'bad', kind: 'agent', detect () { throw new Error('boom') }, async read () { throw new Error('kaput') }, open () { return null } }
    assert.deepStrictEqual(registry.detect(bad), { installed: false, path: null, error: 'boom' })
    const r = await registry.read(bad)
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.error, 'kaput')
    assert.deepStrictEqual(r.items, [])
  })
  await check('registry: open hints come from the adapter that owns the row', () => {
    assert.deepStrictEqual(registry.openHint({ agent: 'claude', pid: 42, cwd: '/w' }),
      { action: 'focus-pid', pid: 42, cwd: '/w', fallback: 'folder' })
    assert.deepStrictEqual(registry.openHint({ agent: 'hermes', pid: 7, sessionId: 's1', cwd: '' }),
      { action: 'focus-pid', pid: 7, cwd: null, sessionId: 's1', fallback: 'hermes-desktop' })
    assert.deepStrictEqual(registry.openHint({ agent: 'hermes', pid: null, sessionId: 's2' }),
      { action: 'hermes-desktop', sessionId: 's2' })
    assert.strictEqual(registry.openHint({ agent: 'nobody-registered-this' }), null)
    assert.strictEqual(registry.get('backlogs').open().action, 'file')
  })

  /* claude-code */
  const claude = registry.get('claude')
  await check('claude: detects the fixture sessions dir', () => {
    assert.deepStrictEqual(claude.detect(), { installed: true, path: path.join(claudeDir, 'sessions') })
  })
  await check('claude: reads pid files — live, dead, unparsable, non-json ignored', async () => {
    const r = await claude.read()
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.unparsed, 1)
    assert.strictEqual(r.items.length, 2)
    const byId = Object.fromEntries(r.items.map(x => [x.id, x]))
    assert.strictEqual(byId['fixture-live-session'].status, 'busy')
    assert.strictEqual(byId['fixture-live-session'].pid, process.pid)
    assert.strictEqual(byId['fixture-dead-session'].status, 'stale')
    for (const x of r.items) assert.strictEqual(x.agent, 'claude')
  })

  /* hermes */
  await check('hermes: missing state.db is not installed, and not read', async () => {
    assert.strictEqual(hermes.detect().installed, false)
    const r = await hermes.read()
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.installed, false)
    assert.deepStrictEqual(r.items, [])
  })
  const raw = JSON.parse(fs.readFileSync(path.join(FIX, 'hermes', 'reader-output.json'), 'utf8'))
  const NOW = 1757570400000
  await check('hermes: reader output becomes prefixed rows', () => {
    const rows = hermes.toRows(raw, NOW)
    assert.strictEqual(rows.length, 9)
    assert.strictEqual(rows[1].id, 'hermes:20250911_090000_bbbbbb')
    assert.strictEqual(rows[1].sessionId, '20250911_090000_bbbbbb')
    assert.strictEqual(rows[2].name, 'hermes cccccc')
    assert.strictEqual(rows[0].status, 'stale')
    assert.strictEqual(rows[2].status, 'busy')
  })
  await check('hermes: live filter grades on evidence and cuts the saved tail', () => {
    const rows = hermes.toRows(raw, NOW)
    const ev = {
      pids: new Map([['20250911_090000_bbbbbb', 4242]]),
      procs: { desktop: false, agent: true },
      active: new Set(['20250911_092000_dddddd']),
      backend: null
    }
    const g = hermes.grade(rows, ev, NOW)
    assert.deepStrictEqual([g.live, g.saved, g.hidden, g.items.length], [3, 6, 2, hermes.MAX_SAVED + 3])
    const by = Object.fromEntries(g.items.map(x => [x.sessionId, x]))
    assert.deepStrictEqual([by['20250911_090000_bbbbbb'].liveBy, by['20250911_090000_bbbbbb'].pid, by['20250911_090000_bbbbbb'].status], ['process', 4242, 'idle'])
    assert.deepStrictEqual([by['20250911_091500_cccccc'].liveBy, by['20250911_091500_cccccc'].status], ['recent', 'busy'])
    assert.deepStrictEqual([by['20250911_092000_dddddd'].liveBy, by['20250911_092000_dddddd'].status], ['api', 'idle'])
    assert.strictEqual(by['20250911_080000_aaaaaa'].status, 'saved')
  })
  await check('hermes: no evidence means nothing is called live', () => {
    const g = hermes.grade(hermes.toRows(raw, NOW), hermes.noEvidence(), NOW)
    assert.deepStrictEqual([g.live, g.saved, g.hidden], [0, 9, 5])
  })
  const py = findPython()
  if (!py) {
    skip('hermes: hermes-sessions.py against a fixture SQLite', 'no python with sqlite3 on PATH')
  } else {
    await check('hermes: hermes-sessions.py against a fixture SQLite (' + py + ')', async () => {
      const db = path.join(TMP, 'state.db')
      require('child_process').execFileSync(py, ['-c',
        'import sqlite3, sys; c = sqlite3.connect(sys.argv[1]); c.executescript(open(sys.argv[2], encoding="utf-8").read()); c.commit(); c.close()',
        db, path.join(FIX, 'hermes', 'state.sql')], { timeout: 15000, windowsHide: true })
      // A window wide enough that the fixture's 2025 timestamps are inside it.
      const out = await hermes.runReader(db, 1e10, 10, py)
      assert.strictEqual(out.ok, true, out.error)
      assert.deepStrictEqual(out.items.map(x => x.id), ['20250911_090000_bbbbbb', '20250911_080000_aaaaaa'])
      assert.strictEqual(out.items[0].lastAt, 1757569800500)
      assert.strictEqual(out.items[1].title, 'older chat')
      assert.strictEqual(out.items[1].endedAt, 1757566000000)
      assert.strictEqual(out.items[1].pinned, true)
      const rows = hermes.toRows(out, NOW)
      assert.strictEqual(rows[1].status, 'stale')
    })
  }

  /* data adapters */
  await check('inbox: pending records, BOM, receipts, unparsed, done/ skipped', async () => {
    const r = await registry.read(registry.get('inbox'))
    assert.strictEqual(r.ok, true)
    assert.deepStrictEqual(r.items.map(x => x.task), ['BOM-prefixed task', 'Fixture pending task'])
    assert.strictEqual(r.items[0].createdLocal, '2026-09-04T08:00')
    assert.strictEqual(r.items[1].project, 'alpha')
    assert.strictEqual(r.items[1].followUps, 'a follow-up line')
    assert.strictEqual(r.items[1].unresolved, 'an open question')
    assert.strictEqual(r.receipts, 1)
    assert.strictEqual(r.unparsed, 1)
    assert.ok(r.items[0].id.startsWith('inbox:'))
  })
  await check('backlogs: bullets and table rows, struck and ✅ items closed', async () => {
    const r = await registry.read(registry.get('backlogs'))
    assert.strictEqual(r.ok, true)
    assert.deepStrictEqual(r.groups.map(g => [g.heading, g.items.map(i => i.text)]), [
      ['Getting started', ['First open item', 'Second open item with alias and code']],
      ['Table group', ['Table open row']]
    ])
    assert.deepStrictEqual([r.total, r.closed], [3, 3])
  })
  await check('evidence: summary table by project', async () => {
    const r = await registry.read(registry.get('evidence'))
    assert.strictEqual(r.ok, true)
    assert.deepStrictEqual(r.byProject.alpha, { branch: 'main', dirty: 2, flagged: false })
    assert.strictEqual(r.byProject.beta.flagged, true)
    assert.strictEqual(r.lastScan, '2026-09-11 09:00')
  })

  /* aggregate + snapshot */
  await check('sessions: agents merged, projects mapped, missing agent not installed', async () => {
    const r = await sessions.read()
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.installed, true)
    assert.deepStrictEqual(r.items.map(x => x.status), ['busy', 'stale'])
    assert.strictEqual(r.items[0].project, 'alpha')
    assert.strictEqual(r.byAgent.claude.count, 2)
    assert.deepStrictEqual([r.byAgent.hermes.installed, r.byAgent.hermes.ok, r.byAgent.hermes.error], [false, true, null])
  })
  await check('snapshot: registry-driven sources, byAgent, repo chips, pending, backlog', async () => {
    const snap = await snapshot.build()
    assert.deepStrictEqual(snap.sources.map(s => [s.key, s.ok, s.installed]), [
      ['sessions', true, true], ['inbox', true, true], ['backlogs', true, true], ['evidence', true, true]
    ])
    assert.deepStrictEqual([snap.okCount, snap.detectedCount], [4, 4])
    assert.deepStrictEqual(Object.keys(snap.live.byAgent), ['claude', 'hermes'])
    assert.strictEqual(snap.live.busy, 1)
    assert.deepStrictEqual(snap.live.items[0].repo, { branch: 'main', dirty: 2, flagged: false })
    assert.strictEqual(snap.live.hermes, snap.live.byAgent.hermes)
    assert.deepStrictEqual([snap.pending.total, snap.pending.receipts], [2, 1])
    assert.deepStrictEqual([snap.backlog.total, snap.backlog.groupCount, snap.backlog.closed], [3, 2, 3])
    assert.strictEqual(snap.counts.known, 2 + 2 + 3)
  })

  /* a new agent plugs in without touching core */
  await check('plug-in: a registered agent lands in LIVE; a broken one is reported beside it', async () => {
    registry.register({
      key: 'fixture-agent', kind: 'agent', label: 'Fixture Agent', hint: 'the fixture agent',
      detect: () => ({ installed: true, path: '/fixture' }),
      read: async () => ({ ok: true, path: '/fixture', items: [{ id: 'fx:1', name: 'plugged in', status: 'idle', cwd: '/work/beta/x', startedAt: Date.now() }] }),
      open: row => ({ action: 'focus-pid', pid: 0, cwd: row.cwd, fallback: 'folder' })
    })
    registry.register({
      key: 'fixture-broken', kind: 'agent', label: 'Broken Agent',
      detect: () => ({ installed: true, path: '/broken' }),
      read: async () => { throw new Error('adapter exploded') },
      open: () => null
    })
    const snap = await snapshot.build()
    const row = snap.live.items.find(x => x.id === 'fx:1')
    assert.ok(row, 'plugged-in row present')
    assert.deepStrictEqual([row.agent, row.project], ['fixture-agent', 'beta'])
    assert.strictEqual(snap.live.byAgent['fixture-agent'].badge, 'FI')
    assert.deepStrictEqual([snap.live.byAgent['fixture-broken'].ok, snap.live.byAgent['fixture-broken'].error], [false, 'adapter exploded'])
    // One broken agent beside working ones leaves the LIVE source up.
    assert.strictEqual(snap.sources[0].ok, true)
    assert.match(snap.sources[0].hint, /the fixture agent/)
    assert.strictEqual(registry.openHint(row).action, 'focus-pid')
  })

  /* platform (this OS) */
  await check('platform: capabilities match this OS (' + platform.platform + ')', () => {
    assert.strictEqual(platform.supports('windowFocus'), process.platform === 'win32')
    assert.strictEqual(platform.supports('no-such-capability'), false)
    const u = platform.unsupported('doing a thing')
    assert.deepStrictEqual([u.ok, u.mode, u.status], [false, 'unsupported', 'UNSUPPORTED'])
  })

  /* stranger machine */
  await check('stranger machine: nothing installed, non-Windows, nothing spawned', () => {
    const { spawnSync } = require('child_process')
    const env = { ...process.env }
    for (const k of Object.keys(env)) if (k.startsWith('STICKY_BRAIN_')) delete env[k]
    const r = spawnSync(process.execPath, [__filename, '--stranger'], { env, encoding: 'utf8', timeout: 60000, windowsHide: true })
    const out = (r.stdout || '') + (r.stderr || '')
    for (const line of out.trim().split(/\r?\n/)) console.log('  | ' + line)
    assert.strictEqual(r.status, 0, 'stranger pass exited ' + r.status)
  })
}

;(STRANGER ? strangerMain() : main())
  .catch(err => results.push(['FAIL', 'harness', err && err.stack ? err.stack : String(err)]))
  .then(() => {
    const failed = report()
    cleanup()
    process.exit(failed ? 1 : 0)
  })
