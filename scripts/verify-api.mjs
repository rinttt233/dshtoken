// End-to-end HTTP smoke test for the @local/dshtoken Host API.
//
// Usage:
//   node scripts/verify-api.mjs [origin]
//   DSH_TOKEN_API_ORIGIN=http://127.0.0.1:<port> node scripts/verify-api.mjs
//
// The origin is the Web GUI URL shown in the DSH runtime context (the port changes
// between DSH restarts). Resolution order: argv[2] → DSH_TOKEN_API_ORIGIN →
// http://127.0.0.1:52404.
//
// The plugin's route is unauthenticated by design (the webserver enforces no
// server-wide auth; only the SPA fallback checks the session cookie), so a plain
// loopback POST from Node exercises the same handler the browser uses.

const ORIGIN = (process.argv[2] || process.env.DSH_TOKEN_API_ORIGIN || 'http://127.0.0.1:52404').replace(/\/+$/, '')
const API = ORIGIN + '/dshtoken/api/'

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    failures++
    console.log(`  ✗ ${label}${detail === undefined ? '' : ' — ' + JSON.stringify(detail)}`)
  }
}

async function call(method, payload = {}, timeoutMs = 120_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(API + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const text = await response.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error(`${method}: non-JSON HTTP ${response.status}: ${text.slice(0, 200)}`)
    }
    return { status: response.status, json }
  } finally {
    clearTimeout(timer)
  }
}

async function callOk(method, payload, timeoutMs) {
  const { status, json } = await call(method, payload, timeoutMs)
  if (!json || json.ok !== true) {
    throw new Error(`${method}: HTTP ${status} → ${JSON.stringify(json && json.error)}`)
  }
  return json.value
}

function isPart(part) {
  return (
    part &&
    typeof part.tokens === 'number' &&
    typeof part.cost === 'number' &&
    typeof part.miss === 'number' &&
    typeof part.hit === 'number' &&
    typeof part.write === 'number' &&
    typeof part.out === 'number' &&
    typeof part.requests === 'number'
  )
}

const startedAt = Date.now()

/* ---------------------------------------------------------------- status --- */
console.log('\n[status]')
const status = await callOk('status', {})
console.log('  raw:', JSON.stringify(status).slice(0, 400))
check('status envelope', status && typeof status === 'object')
check('running is boolean', typeof status.running === 'boolean')
check('scanned/total numbers', typeof status.scanned === 'number' && typeof status.total === 'number')
check('scanned <= total', status.scanned <= Math.max(status.total, status.scanned))
check('services reported', !!status.services)

// First run scans hundreds of compressed logs in the background; wait for a usable
// index but do not fail when it is only partial yet.
let waited = 0
let latest = status
while ((latest.scanned === 0 || latest.running) && waited < 180_000) {
  await new Promise((resolve) => setTimeout(resolve, 2000))
  waited += 2000
  latest = await callOk('status', {})
  process.stdout.write(`\r  waiting for index… ${latest.scanned}/${latest.total}${latest.running ? ' running' : ''}   `)
}
process.stdout.write('\n')
console.log('  index:', JSON.stringify({ scanned: latest.scanned, total: latest.total, records: latest.records, running: latest.running, errors: (latest.errors || []).length }))
check('index has sessions', latest.scanned > 0, latest)

/* ------------------------------------------------------------------ meta --- */
console.log('\n[meta]')
const meta = await callOk('meta', {})
check('timezone offset', typeof meta.timezoneOffsetMinutes === 'number')
check('currency', typeof meta.currency === 'string')
check('models array', Array.isArray(meta.models))
check('providers array', Array.isArray(meta.providers))
check('cwds array', Array.isArray(meta.cwds))
check('sessions summary', meta.sessions && typeof meta.sessions.indexed === 'number')
check('config + defaults', !!meta.config && !!meta.defaults)
console.log('  models:', (meta.models || []).length, 'providers:', (meta.providers || []).length)
if ((meta.models || []).length) {
  console.log('  sample models:', meta.models.slice(0, 4).map((m) => `${m.key}${m.priced ? '' : ' (unpriced)'}`).join(', '))
}

/* ----------------------------------------------------------------- stats --- */
const now = Date.now()
const from = now - 30 * 86400000
const to = now + 60000

async function statsCase(label, body) {
  console.log(`\n[stats: ${label}]`)
  const value = await callOk('stats', body)
  check('from/to echoed', value.from === body.from && value.to === body.to)
  check('effective bucket', ['hour', 'day', 'week', 'month'].includes(value.bucket))
  check('dims array', Array.isArray(value.dims))
  check('buckets array', Array.isArray(value.buckets))
  check('totals Part', isPart(value.totals))
  check('summary numbers', value.summary && typeof value.summary.totalTokens === 'number' && typeof value.summary.totalCost === 'number')
  for (const bucket of value.buckets || []) {
    if (bucket.t0 >= bucket.t1) throw new Error(`${label}: bucket t0>=t1`)
    if (!isPart(bucket.total)) throw new Error(`${label}: bucket.total is not a Part`)
    if (typeof bucket.byDim !== 'object' || bucket.byDim === null) throw new Error(`${label}: bucket.byDim missing`)
  }
  if ((value.buckets || []).length) {
    const first = value.buckets[0]
    console.log(`  buckets: ${value.buckets.length}, first: ${new Date(first.t0).toISOString()} → total tokens ${first.total.tokens}`)
  }
  console.log('  dims:', (value.dims || []).map((d) => `${d.kind}:${d.key}`).slice(0, 8).join(', '))
  console.log('  totals:', JSON.stringify({ tokens: value.totals.tokens, cost: value.totals.cost, requests: value.totals.requests }))
  return value
}

const cat = await statsCase('category/day', { from, to, bucket: 'day', groupBy: 'category', metric: 'tokens' })
const prov = await statsCase('provider/day', { from, to, bucket: 'day', groupBy: 'provider', metric: 'tokens' })
const model = await statsCase('model/day/cost', { from, to, bucket: 'day', groupBy: 'model', metric: 'cost' })
const sess = await statsCase('session/week', { from, to, bucket: 'week', groupBy: 'session', metric: 'tokens' })

if ((meta.models || []).length) {
  const keys = meta.models.map((m) => m.key)
  const filtered = await statsCase('category/day/filtered-models', { from, to, bucket: 'day', groupBy: 'category', metric: 'tokens', models: keys.slice(0, 1) })
  check('model filter respected', filtered.totals.tokens <= cat.totals.tokens + 1e-6, { filtered: filtered.totals.tokens, all: cat.totals.tokens })
}

check('category dims are the four buckets', (cat.dims || []).map((d) => d.key).join(',') === 'hit,miss,write,out', cat.dims)
check('totals.tokens equals parts sum',
  Math.abs((cat.totals.miss + cat.totals.hit + cat.totals.write + cat.totals.out) - cat.totals.tokens) < 1e-6,
  cat.totals)
check('bucket tokens sum equals totals',
  Math.abs((cat.buckets || []).reduce((sum, b) => sum + b.total.tokens, 0) - cat.totals.tokens) < 1e-6,
  { sum: (cat.buckets || []).reduce((sum, b) => sum + b.total.tokens, 0), total: cat.totals.tokens })
check('provider/session dims capped', (prov.dims || []).length <= 21 && (sess.dims || []).length <= 13, { prov: prov.dims.length, sess: sess.dims.length })
check('partial/notes shape', cat.notes && typeof cat.notes.partial === 'boolean' && Array.isArray(cat.notes.unpricedModels))

/* ----------------------------------------------------------------- config --- */
console.log('\n[config]')
const config = await callOk('config', {})
check('config value', !!config.config && !!config.defaults)
check('prices object', config.config.prices && typeof config.config.prices === 'object')
check('peak config', config.config.peak && Array.isArray(config.config.peak.windows))
const priceKeys = Object.keys(config.config.prices || {})
console.log('  default prices:', priceKeys.join(', ') || '(none)')
// Round-trip a harmless preference patch (no price mutation).
const patched = await callOk('config', { patch: { prefs: { ...(config.config.prefs || {}), __verify: Date.now() } } })
check('config patch round-trip', patched.config.prefs && patched.config.prefs.__verify > 0)
await callOk('config', { patch: { prefs: { ...(patched.config.prefs || {}) } } })

/* ---------------------------------------------------------------- session --- */
const firstSessionDim = (sess.dims || []).find((d) => d.kind === 'session' && d.key !== '__other')
if (firstSessionDim) {
  console.log('\n[session]', firstSessionDim.key)
  const session = await callOk('session', { sessionId: firstSessionDim.key })
  check('found session', session.found === true, session)
  check('session tokens object', session.tokens && typeof session.tokens.tokens === 'number' && typeof session.tokens.cost === 'number')
  check('global today/all', session.global && session.global.today && session.global.all)
  check('models list', Array.isArray(session.models))
} else {
  console.log('\n[session] skipped (no session dimension in range)')
}

/* ----------------------------------------------------------------- titles --- */
console.log('\n[titles]')
const ids = (sess.dims || []).filter((d) => d.kind === 'session' && d.key !== '__other').map((d) => d.key).slice(0, 3)
const titles = await callOk('titles', { ids })
check('titles object', titles && typeof titles === 'object')
check('titles keys are session ids', Object.keys(titles).every((id) => ids.includes(id)), Object.keys(titles))

/* ------------------------------------------------------------------ debug --- */
console.log('\n[debug]')
const debug = await callOk('debug', {})
check('debug object', !!debug && typeof debug === 'object')

/* ------------------------------------------------------------------- done --- */
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
console.log(`\n${failures === 0 ? '✓ API smoke test passed' : `✗ ${failures} check(s) failed`} in ${elapsed}s`)
process.exitCode = failures === 0 ? 0 : 1
