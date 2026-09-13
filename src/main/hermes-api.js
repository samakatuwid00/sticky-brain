'use strict'

const http = require('http')

// SB: a client for Hermes Agent's local backend, which the Live Sessions & Task Launch plan asks
// the board to talk to. Three things about that backend were checked against the running install
// before any of this was written, and all three shape the code below:
//
//  1. THE PORT IS NOT FIXED. The plan names http://localhost:9119. The desktop shell actually
//     starts the backend with `serve --host 127.0.0.1 --port 0`
//     (apps/desktop/electron/backend-command.ts) and learns the real port from a ready-file it
//     unlinks the moment it has read it (backend-ready.ts, main.ts). Measured here the backend was
//     on 127.0.0.1:51095 and nothing on disk named that number. So 9119 is tried FIRST — it is
//     what the plan specifies, and what a fixed-port or remote deployment would answer on — and
//     when nothing is there the listening ports of the running Hermes/Python processes are swept
//     and probed instead. STICKY_BRAIN_HERMES_API overrides both.
//
//  2. EVERY /api/ ROUTE IS BEHIND A SESSION TOKEN. hermes_cli/web_server.py mints it per launch
//     from HERMES_DASHBOARD_SESSION_TOKEN (or a random one) and the desktop shell injects it into
//     the backend's environment. It is not written anywhere Sticky Brain can read, so unless the
//     board is started with that variable — or STICKY_BRAIN_HERMES_TOKEN — in its OWN environment,
//     /api/sessions answers 401. Measured here: 401.
//
//     A 401 is therefore reported as "reachable but unauthorised", never as "no live sessions".
//     Turning an unanswered question into a confident empty list is the exact failure this board
//     exists to avoid.
//
//  3. POST /api/sessions DOES NOT EXIST in this build. `/openapi.json` on the running backend
//     (Hermes Agent 0.19.1) declares GET only for `/api/sessions`; the chat surface the desktop
//     app drives is the `/api/ws` WebSocket, not a REST create-a-session call. The POST the plan
//     describes is still attempted — a later build, or a differently-configured gateway, may well
//     accept it — but a 404/405 is recognised as "this build has no such endpoint" and the caller
//     falls back rather than reporting a launch that never happened.

const PLAN_PORT = 9119

// A working base is re-verified at most this often; a miss is not re-swept more often than that.
// The board polls every 5s, and neither a port sweep nor a probe belongs on that cadence.
const TTL_OK = 60 * 1000
const TTL_FAIL = 30 * 1000

let cache = { at: 0, result: null }
let inFlight = null

function token () {
  return process.env.HERMES_DASHBOARD_SESSION_TOKEN ||
    process.env.STICKY_BRAIN_HERMES_TOKEN || null
}

// `X-Hermes-Session-Token` is the header web_server.py prefers; the Bearer form is the legacy path
// it still accepts. Sending both costs nothing and survives either build.
function headers (payload) {
  const h = { Accept: 'application/json' }
  const tok = token()
  if (tok) {
    h['X-Hermes-Session-Token'] = tok
    h.Authorization = 'Bearer ' + tok
  }
  if (payload) {
    h['Content-Type'] = 'application/json'
    h['Content-Length'] = payload.length
  }
  return h
}

function request (base, route, opts) {
  const { method = 'GET', body = null, timeout = 2500 } = opts || {}
  return new Promise(resolve => {
    let url
    try { url = new URL(route, base) } catch { return resolve({ ok: false, status: 0, error: 'bad base url: ' + base }) }
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method,
      headers: headers(payload),
      timeout
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch {}
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json,
          text
        })
      })
    })
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', err => resolve({ ok: false, status: 0, error: err.message }))
    if (payload) req.write(payload)
    req.end()
  })
}

// The candidate list, cheapest and most-specified first. The port sweep is delegated to
// hermes-runtime so there is exactly one place that shells out to enumerate processes.
async function candidates () {
  const out = []
  const explicit = (process.env.STICKY_BRAIN_HERMES_API || '').trim()
  if (explicit) out.push(explicit.replace(/\/+$/, ''))
  out.push('http://127.0.0.1:' + PLAN_PORT)
  // Required lazily: hermes-runtime does not import this module, but keeping the require here
  // documents that the dependency runs one way only.
  const runtime = require('./hermes-runtime')
  for (const port of await runtime.hermesListeningPorts()) {
    const base = 'http://127.0.0.1:' + port
    if (!out.includes(base)) out.push(base)
  }
  return out
}

// The sessions endpoint doubles as the identity probe: a Hermes backend answers it with 200 or
// with 401, and anything that is neither (a refused connection, a 404 from some unrelated server)
// is not the thing being looked for. The swept candidates are already restricted to ports owned by
// Hermes/Python processes, so this is a narrower test than it looks.
async function probe (base) {
  const r = await request(base, '/api/sessions', { timeout: 2000 })
  if (r.ok) return { ok: true, base, authorized: true, status: r.status, items: rowsOf(r.json) }
  if (r.status === 401 || r.status === 403) {
    return {
      ok: true,
      base,
      authorized: false,
      status: r.status,
      items: [],
      error: 'hermes backend is up but refused the session token — start Sticky Brain with ' +
        'HERMES_DASHBOARD_SESSION_TOKEN set to read live sessions from it'
    }
  }
  return null
}

function firstBool (obj, keys) {
  for (const k of keys) {
    if (typeof obj[k] === 'boolean') return obj[k]
  }
  return null
}

// SB: the response shape is UNVERIFIED — the endpoint answers 401 on this machine, so nothing here
// was ever seen. Several plausible spellings of the list and of the "is it running" flag are
// accepted, and a row carrying none of them gets `active: null`, which every caller must read as
// "unknown" and never as "live". No field is invented into existence.
function rowsOf (json) {
  const list = Array.isArray(json) ? json
    : (json && Array.isArray(json.sessions)) ? json.sessions
      : (json && Array.isArray(json.items)) ? json.items : []
  return list.map(x => ({
    id: String((x && (x.id || x.session_id || x.sessionId)) || ''),
    active: x ? firstBool(x, ['active', 'is_active', 'running', 'is_running', 'live']) : null
  })).filter(x => x.id)
}

// { ok, base, authorized, items, error }. `ok: false` means no Hermes backend answered anywhere,
// which is a normal state — the desktop app may simply not be running.
async function read () {
  const now = Date.now()
  if (cache.result && (now - cache.at) < (cache.result.ok ? TTL_OK : TTL_FAIL)) return cache.result
  if (inFlight) return inFlight

  inFlight = (async () => {
    let result = { ok: false, base: null, authorized: false, items: [], error: 'no hermes backend answered' }
    // A known-good base is retried on its own before the whole list is walked again.
    const list = cache.result && cache.result.base
      ? [cache.result.base, ...(await candidates()).filter(b => b !== cache.result.base)]
      : await candidates()
    for (const base of list) {
      const hit = await probe(base)
      if (hit) { result = hit; break }
    }
    cache = { at: Date.now(), result }
    return result
  })()

  try { return await inFlight } finally { inFlight = null }
}

// SB: the plan's task dispatch. See note 3 at the top — on Hermes 0.19.1 this returns
// `unsupported`, and index.js treats that as "use the next launcher", not as a failure to report.
//
// SB: when POST /api/sessions returns 404/405 (unsupported), the Hermes build doesn't expose
// that endpoint and won't until it's upgraded. Caching this avoids the full port-sweep + HTTP
// probe cycle on every subsequent click — the read() call alone takes 2-5s via PowerShell.
const UNSUPPORTED_TTL = 5 * 60 * 1000  // 5 minutes — safe across app lifetime
let unsupportedAt = 0

async function startTask (task) {
  // Fast-path: if the last POST was unsupported, skip the expensive read() + probe cycle.
  if (unsupportedAt && (Date.now() - unsupportedAt) < UNSUPPORTED_TTL) {
    return { ok: false, reason: 'unsupported', detail: 'cached — POST /api/sessions is unsupported' }
  }

  const state = await read()
  if (!state.ok) return { ok: false, reason: 'offline', detail: state.error }
  if (!state.authorized) return { ok: false, reason: 'unauthorized', detail: state.error }

  const r = await request(state.base, '/api/sessions', {
    method: 'POST',
    timeout: 8000,
    body: {
      prompt: task.prompt,
      skills: task.skills,
      cwd: task.cwd || undefined,
      source: 'sticky-brain'
    }
  })
  if (r.ok) { unsupportedAt = 0; return { ok: true, base: state.base, session: r.json } }
  if (r.status === 404 || r.status === 405) {
    unsupportedAt = Date.now()
    return { ok: false, reason: 'unsupported', detail: 'this hermes build exposes GET /api/sessions only' }
  }
  if (r.status === 401 || r.status === 403) {
    return { ok: false, reason: 'unauthorized', detail: 'the backend refused the session token' }
  }
  return {
    ok: false,
    reason: 'error',
    detail: r.error || ('hermes backend answered ' + (r.status || 0))
  }
}

module.exports = { read, startTask, request, PLAN_PORT }
