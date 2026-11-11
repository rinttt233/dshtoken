// Offline self-test for the @local/dshtoken Host half.
//
//   node scripts/host-selftest.mjs        exit 0 = pass, 1 = failures
//
// Covers the pure Host logic (foldEvents, cost engine, bucket plan, aggregation,
// meta/session values, config merge), the gzip config/index persistence in an
// isolated temp `$DSH_HOME`, and the HTTP router wired to fake Host services
// (so scan -> cache -> stats/session/titles/live-feed data flow runs end to end).
//
// NOT covered offline (the Lead verifies these live in DSH):
//   - the real `sessionQuery` / `sessionPersistence` backends and real compressed
//     session logs (shapes are faked here from the inspected type contract);
//   - the mounted `webServer` prefix route and same-origin browser fetch;
//   - the `session/event` dispatch scope of the real Cordis context.

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// Isolate plugin storage before any lib module reads $DSH_HOME.
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dshtoken-selftest-'))

const store = await import('../lib/store.js')
const cost = await import('../lib/cost.js')
const aggregate = await import('../lib/aggregate.js')
const scan = await import('../lib/scan.js')
const http = await import('../lib/http.js')

const DAY = 86400000
const HOUR = 3600000
const OFFSET = 480 * 60000
const T = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s)
const SH = (y, mo, d, h = 0, mi = 0, s = 0) => T(y, mo, d, h, mi, s) - OFFSET

const defaults = cost.DEFAULT_CONFIG
const freshConfig = (overrides) => store.mergeConfig(overrides || {}, defaults)
const eq = (actual, expected, label) => assert.deepStrictEqual(actual, expected, label)
const close = (actual, expected, label) => {
  assert.ok(
    typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9,
    (label || 'value') + ': expected ' + expected + ', got ' + actual,
  )
}

const failures = []
let passed = 0
function section(title) {
  console.log('[selftest] ' + title)
}
async function test(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push({ name, error })
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fixturePath = join(HERE, 'fixtures', 'fold-sessions.json')
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
const toMs = (value) => (typeof value === 'string' ? Date.parse(value) : value)
for (const session of fixture.sessions) {
  for (const event of session.events) event.time = toMs(event.time)
  if (session.header && typeof session.header.createdAt === 'string') {
    session.header.createdAt = toMs(session.header.createdAt)
  }
}

// ---------------------------------------------------------------------------
// foldEvents
// ---------------------------------------------------------------------------

section('foldEvents (inherited prefix, provider switch, missing header, retries)')

const recordedUsage = {
  type: 'assistant/message',
  seq: 90,
  time: SH(2025, 1, 6, 10, 0),
  data: { usage: { inputTokens: 10, outputTokens: 1 } },
}

for (const session of fixture.sessions) {
  await test('fold fixture "' + session.name + '"', () => {
    const folded = scan.foldEvents(session.events, session.inheritedEventCount || 0)
    eq(folded.records.length, session.expect.records, 'records')
    eq(
      folded.records.map((record) => record[1]),
      session.expect.providers,
      'providers',
    )
    eq(
      folded.records.map((record) => record[2]),
      session.expect.models,
      'models',
    )
    eq(folded.lastSeq, session.expect.lastSeq, 'lastSeq')
    if (session.expect.input !== undefined) eq(folded.records[0][3], session.expect.input, 'input')
    if (session.expect.inputs !== undefined) {
      eq(
        folded.records.map((record) => record[3]),
        session.expect.inputs,
        'inputs',
      )
    }
    if (session.expect.lastProvider !== undefined) {
      eq(folded.lastProvider, session.expect.lastProvider, 'lastProvider')
      eq(folded.lastModel, session.expect.lastModel, 'lastModel')
    }
    for (const record of folded.records) {
      eq(record.length, 8, 'record arity')
      assert.ok(Number.isFinite(record[0]), 'record timestamp is a number')
    }
  })
}

await test('incremental fold equals a single fold', () => {
  const events = fixture.sessions[0].events
  const head = scan.foldEvents(events.slice(0, 2), 0)
  const tail = scan.foldEvents(events, 0, head)
  const full = scan.foldEvents(events, 0)
  eq(tail, full)
})

await test('fold ignores events at or below lastSeq (live double-count guard)', () => {
  const folded = scan.foldEvents([recordedUsage], 0, {
    records: [],
    lastProvider: 'deepseek-official',
    lastModel: 'deepseek-flash',
    lastSeq: 90,
  })
  eq(folded.records.length, 0)
  eq(folded.lastSeq, 90)
})

await test('fold keeps provider/model attribution from inherited header events', () => {
  const folded = scan.foldEvents(fixture.sessions[1].events, 2)
  eq(folded.records.length, 1)
  eq(folded.records[0][1], 'deepseek-official')
  eq(folded.records[0][2], 'deepseek-flash')
})

await test('fold skips malformed events instead of throwing', () => {
  const folded = scan.foldEvents([null, {}, { seq: 'x' }, recordedUsage], 0)
  eq(folded.records.length, 1)
})

// ---------------------------------------------------------------------------
// Cost engine
// ---------------------------------------------------------------------------

section('cost engine (prices, peak windows, parts)')

await test('DEFAULT_CONFIG matches the contract defaults', () => {
  eq(defaults.version, 1)
  eq(defaults.currency, 'CNY')
  eq(defaults.timezoneOffsetMinutes, 480)
  const flash = defaults.prices['deepseek-official/deepseek-flash']
  eq({ hit: flash.hit, miss: flash.miss, write: flash.write, out: flash.out }, { hit: 0.02, miss: 1, write: 0, out: 4 })
  eq(flash.peakMultiplier, 2)
  const pro = defaults.prices['deepseek-official/deepseek-v4-pro']
  eq({ hit: pro.hit, miss: pro.miss, write: pro.write, out: pro.out }, { hit: 0.15, miss: 4.5, write: 0, out: 13.5 })
  eq(defaults.peak.enabled, true)
  eq(defaults.peak.days, [1, 2, 3, 4, 5])
  eq(defaults.peak.windows, [
    { start: 540, end: 720 },
    { start: 840, end: 1080 },
  ])
  eq(defaults.peak.holidays, [])
  eq(defaults.prefs, {})
  assert.ok(Object.isFrozen(defaults) && Object.isFrozen(defaults.prices))
})

await test('resolvePrice: exact, provider wildcard, model wildcard, unpriced', () => {
  const cfg = freshConfig({
    prices: {
      'a/b': { hit: 1, miss: 2, write: 3, out: 4 },
      'c/*': { hit: 5 },
      '*/m': { hit: 6 },
    },
  })
  eq(cost.resolvePrice(cfg, 'a', 'b').hit, 1)
  eq(cost.resolvePrice(cfg, 'c', 'anything').hit, 5)
  eq(cost.resolvePrice(cfg, 'q', 'm').hit, 6)
  eq(cost.resolvePrice(cfg, 'unknown', 'x'), null)
  eq(cost.resolvePrice(cfg, '', ''), null)
  eq(cost.resolvePrice(defaults, 'deepseek-official', 'deepseek-flash').miss, 1)
  eq(cost.resolvePrice(defaults, 'deepseek-official', 'deepseek-v4-flash').miss, 1)
  eq(
    cost.resolvePrice(defaults, 'deepseek-official', 'deepseek-v4-flash-vision-exp').out,
    4,
  )
})

await test('isPeak: window minutes, weekday, holiday, disabled, timezone', () => {
  const cfg = freshConfig()
  eq(cost.isPeak(SH(2025, 1, 6, 8, 59), cfg), false, '08:59')
  eq(cost.isPeak(SH(2025, 1, 6, 9, 0), cfg), true, '09:00 inclusive')
  eq(cost.isPeak(SH(2025, 1, 6, 10, 0), cfg), true, '10:00')
  eq(cost.isPeak(SH(2025, 1, 6, 11, 59), cfg), true, '11:59')
  eq(cost.isPeak(SH(2025, 1, 6, 12, 0), cfg), false, '12:00 exclusive')
  eq(cost.isPeak(SH(2025, 1, 6, 13, 59), cfg), false, '13:59')
  eq(cost.isPeak(SH(2025, 1, 6, 14, 0), cfg), true, '14:00 inclusive')
  eq(cost.isPeak(SH(2025, 1, 6, 17, 59), cfg), true, '17:59')
  eq(cost.isPeak(SH(2025, 1, 6, 18, 0), cfg), false, '18:00 exclusive')
  eq(cost.isPeak(SH(2025, 1, 4, 10, 0), cfg), false, 'Saturday')
  eq(cost.isPeak(SH(2025, 1, 5, 10, 0), cfg), false, 'Sunday')
  eq(cost.isPeak(SH(2025, 1, 7, 10, 0), cfg), true, 'Tuesday')
  const holiday = freshConfig({ peak: { holidays: ['2025-01-06'] } })
  eq(cost.isPeak(SH(2025, 1, 6, 10, 0), holiday), false, 'holiday')
  eq(cost.isPeak(SH(2025, 1, 7, 10, 0), holiday), true, 'non-holiday weekday')
  const disabled = freshConfig({ peak: { enabled: false } })
  eq(cost.isPeak(SH(2025, 1, 6, 10, 0), disabled), false, 'disabled')
  const utc = freshConfig({ timezoneOffsetMinutes: 0 })
  eq(cost.isPeak(T(2025, 1, 6, 10, 0), utc), true, 'offset 0 uses UTC wall clock')
  eq(cost.isPeak(SH(2025, 1, 6, 10, 0), utc), false, 'SH 10:00 is 02:00 UTC')
})

const flashPeakRecord = [
  SH(2025, 1, 6, 10, 0),
  'deepseek-official',
  'deepseek-flash',
  1000000,
  400000,
  0,
  200000,
  50000,
]
const flashIdleRecord = [
  SH(2025, 1, 6, 13, 0),
  'deepseek-official',
  'deepseek-flash',
  500000,
  0,
  0,
  100000,
  0,
]

await test('recordPart: exact peak/idle/unpriced costs', () => {
  const peakPart = cost.recordPart(flashPeakRecord, freshConfig())
  eq(peakPart.tokens, 1600000)
  eq({ miss: peakPart.miss, hit: peakPart.hit, write: peakPart.write, out: peakPart.out }, {
    miss: 1000000,
    hit: 400000,
    write: 0,
    out: 200000,
  })
  eq(peakPart.reasoning, 50000)
  eq(peakPart.requests, 1)
  close(peakPart.cost, 3.616, 'peak flash cost')

  close(cost.recordPart(flashIdleRecord, freshConfig()).cost, 0.9, 'idle flash cost')

  const unpriced = cost.recordPart(
    [SH(2025, 1, 6, 10, 0), 'lgd-claude', 'claude-opus-5-5', 100000, 0, 0, 20000, 0],
    freshConfig(),
  )
  eq(unpriced.cost, 0)
  eq(unpriced.tokens, 120000)

  const weird = cost.recordPart([SH(2025, 1, 6, 10, 0), 'deepseek-official', 'deepseek-flash', 100, 500, 0, 10, 0], freshConfig())
  eq(weird.miss, 100, 'inputTokens is already uncached input, even when cacheRead is larger')
  eq(weird.tokens, 610)

  const defaultMultiplier = freshConfig({ prices: { 'x/y': { hit: 1, miss: 1, out: 1 } } })
  close(
    cost.recordPart([SH(2025, 1, 6, 10, 0), 'x', 'y', 1000, 0, 0, 1000, 0], defaultMultiplier).cost,
    0.004,
    'missing peakMultiplier defaults to 2',
  )
})

await test('emptyPart/addPart/dimCost helpers', () => {
  const empty = cost.emptyPart()
  eq(empty, { tokens: 0, cost: 0, miss: 0, hit: 0, write: 0, out: 0, reasoning: 0, requests: 0 })
  const a = cost.recordPart(flashPeakRecord, freshConfig())
  const b = cost.recordPart(flashIdleRecord, freshConfig())
  cost.addPart(empty, a)
  cost.addPart(empty, b)
  eq(empty.requests, 2)
  eq(empty.tokens, 2200000)
  close(empty.cost, 4.516, 'addPart cost')

  close(
    cost.dimCost(freshConfig(), 'deepseek-official', 'deepseek-flash', {
      miss: 600000,
      hit: 400000,
      write: 0,
      out: 200000,
    }),
    1.408,
    'dimCost uses idle rates',
  )
  eq(cost.dimCost(freshConfig(), 'nope', 'nope', { miss: 1 }), 0)
})

// ---------------------------------------------------------------------------
// Config merge (pure) and validation via store
// ---------------------------------------------------------------------------

section('config merge + validation')

await test('mergeConfig fills defaults and treats prices as a whole-map replacement', () => {
  const full = freshConfig()
  eq(full.currency, 'CNY')
  eq(full.timezoneOffsetMinutes, 480)
  eq(full.prices['deepseek-official/deepseek-flash'].miss, 1)
  const partial = freshConfig({ currency: 'USD' })
  eq(partial.currency, 'USD')
  eq(partial.prices['deepseek-official/deepseek-flash'].hit, 0.02)
  const replaced = freshConfig({ prices: { 'a/b': { hit: 1 } } })
  eq(Object.keys(replaced.prices), ['a/b'])
  eq(replaced.prices['a/b'], { hit: 1, miss: 0, write: 0, out: 0 })
  eq(defaults.prices['deepseek-official/deepseek-flash'].hit, 0.02, 'defaults untouched')
  replaced.prices['a/b'].hit = 99
  eq(defaults.prices['deepseek-official/deepseek-flash'].hit, 0.02)
  const peak = freshConfig({ peak: { enabled: false } })
  eq(peak.peak.enabled, false)
  eq(peak.peak.days, [1, 2, 3, 4, 5], 'unspecified peak fields keep defaults')
  eq(freshConfig().currency, 'CNY')
  const prefs = freshConfig({ prefs: { view: 'week' } })
  eq(prefs.prefs, { view: 'week' })
})

await test('dataDir uses $DSH_HOME/plugin-data/dshtoken', () => {
  eq(store.dataDir(), join(process.env.DSH_HOME, 'plugin-data', 'dshtoken'))
})

// ---------------------------------------------------------------------------
// Bucket plan (via aggregate on an empty snapshot)
// ---------------------------------------------------------------------------

section('bucket plan (hour/day/week/month, clipping, auto, limits)')

const EMPTY_SNAPSHOT = { generatedAt: 7, sessions: {} }
function planFor(from, to, overrides) {
  const cfg = freshConfig()
  const query = aggregate.normalizedQuery({ from, to, ...(overrides || {}) }, cfg)
  return aggregate.aggregate(EMPTY_SNAPSHOT, cfg, query, cost)
}

await test('auto granularity thresholds', () => {
  const base = T(2025, 1, 1)
  eq(planFor(base, base + 2 * DAY).bucket, 'hour')
  eq(planFor(base, base + 2 * DAY + 1).bucket, 'day')
  eq(planFor(base, base + 62 * DAY).bucket, 'day')
  eq(planFor(base, base + 62 * DAY + 1).bucket, 'week')
  eq(planFor(base, base + 400 * DAY).bucket, 'week')
  eq(planFor(base, base + 400 * DAY + 1).bucket, 'month')
})

await test('hour buckets are aligned to the statistics timezone and clipped', () => {
  const from = SH(2025, 1, 6, 10, 30)
  const to = SH(2025, 1, 6, 12, 30)
  const value = planFor(from, to, { bucket: 'hour' })
  eq(value.bucket, 'hour')
  eq(value.buckets.map((bucket) => [bucket.t0, bucket.t1]), [
    [from, SH(2025, 1, 6, 11, 0)],
    [SH(2025, 1, 6, 11, 0), SH(2025, 1, 6, 12, 0)],
    [SH(2025, 1, 6, 12, 0), to],
  ])
})

await test('day buckets are local midnights', () => {
  const from = SH(2025, 1, 6, 10, 30)
  const to = SH(2025, 1, 8, 0, 0)
  const value = planFor(from, to, { bucket: 'day' })
  eq(value.buckets.map((bucket) => [bucket.t0, bucket.t1]), [
    [from, SH(2025, 1, 7, 0, 0)],
    [SH(2025, 1, 7, 0, 0), to],
  ])
})

await test('week buckets start on Monday and survive year boundaries', () => {
  const from = SH(2025, 1, 8, 12, 0) // Wednesday
  const to = SH(2025, 1, 20, 0, 0) // Monday
  eq(planFor(from, to, { bucket: 'week' }).buckets.map((bucket) => [bucket.t0, bucket.t1]), [
    [from, SH(2025, 1, 13, 0, 0)],
    [SH(2025, 1, 13, 0, 0), to],
  ])

  const sunday = SH(2025, 1, 12, 12, 0) // Sunday belongs to the week starting Jan 6
  eq(planFor(sunday, SH(2025, 1, 14, 0, 0), { bucket: 'week' }).buckets.map((bucket) => [bucket.t0, bucket.t1]), [
    [sunday, SH(2025, 1, 13, 0, 0)],
    [SH(2025, 1, 13, 0, 0), SH(2025, 1, 14, 0, 0)],
  ])

  // Week of 2024-12-31 starts Monday 2024-12-30, so the first boundary is Jan 6.
  eq(
    planFor(SH(2024, 12, 31, 12, 0), SH(2025, 1, 7, 0, 0), { bucket: 'week' }).buckets.map(
      (bucket) => [bucket.t0, bucket.t1],
    ),
    [
      [SH(2024, 12, 31, 12, 0), SH(2025, 1, 6, 0, 0)],
      [SH(2025, 1, 6, 0, 0), SH(2025, 1, 7, 0, 0)],
    ],
  )
})

await test('month buckets are calendar months (January, year boundary)', () => {
  const from = SH(2025, 1, 15, 12, 0)
  const to = SH(2025, 3, 10, 0, 0)
  eq(planFor(from, to, { bucket: 'month' }).buckets.map((bucket) => [bucket.t0, bucket.t1]), [
    [from, SH(2025, 2, 1, 0, 0)],
    [SH(2025, 2, 1, 0, 0), SH(2025, 3, 1, 0, 0)],
    [SH(2025, 3, 1, 0, 0), to],
  ])

  eq(
    planFor(SH(2024, 12, 15), SH(2025, 2, 10), { bucket: 'month' }).buckets.map((bucket) => [
      bucket.t0,
      bucket.t1,
    ]),
    [
      [SH(2024, 12, 15), SH(2025, 1, 1)],
      [SH(2025, 1, 1), SH(2025, 2, 1)],
      [SH(2025, 2, 1), SH(2025, 2, 10)],
    ],
  )

  const january = planFor(SH(2025, 1, 10), SH(2025, 2, 1), { bucket: 'month' })
  eq(january.buckets.length, 1)
  eq([january.buckets[0].t0, january.buckets[0].t1], [SH(2025, 1, 10), SH(2025, 2, 1)])
})

await test('1000 buckets allowed, 1001 rejected with too-many-buckets', () => {
  const from = SH(2025, 1, 1)
  eq(planFor(from, from + 1000 * HOUR, { bucket: 'hour' }).buckets.length, 1000)
  assert.throws(
    () => planFor(from, from + 1001 * HOUR, { bucket: 'hour' }),
    (error) => error && error.code === 'too-many-buckets',
  )
})

await test('normalizedQuery defaults, filters and validation', () => {
  const from = SH(2025, 1, 1)
  const to = SH(2025, 1, 2)
  eq(aggregate.normalizedQuery({ from, to }, freshConfig()), {
    from,
    to,
    bucket: 'auto',
    groupBy: 'category',
    metric: 'tokens',
    models: [],
    providers: [],
    cwds: [],
    includeSubagents: true,
  })
  const shaped = aggregate.normalizedQuery(
    {
      from,
      to,
      bucket: 'week',
      groupBy: 'model',
      metric: 'cost',
      models: [' a/b ', 'a/b', 'c/d', ''],
      providers: ['p'],
      cwds: ['D:/x'],
      includeSubagents: false,
    },
    freshConfig(),
  )
  eq(shaped.models, ['a/b', 'c/d'])
  eq(shaped.providers, ['p'])
  eq(shaped.cwds, ['D:/x'])
  eq(shaped.includeSubagents, false)
  for (const bad of [
    {},
    { from, to: from },
    { from, to, bucket: 'year' },
    { from, to, groupBy: 'cwd' },
    { from, to, metric: 'requests' },
    { from, to, models: 'a/b' },
    { from, to, models: [1] },
  ]) {
    assert.throws(
      () => aggregate.normalizedQuery(bad, freshConfig()),
      (error) => error && error.code === 'bad-request',
      'invalid query should be rejected: ' + JSON.stringify(bad),
    )
  }
})

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

section('aggregation (category/provider/model/session, filters, top-N, unpriced)')

function entryOf(id, records, extra) {
  return {
    id,
    createdAt: records.length ? records[0][0] - 1000 : 0,
    cwd: 'D:/game/dsh',
    origin: null,
    parentSession: null,
    delegationDepth: 0,
    eventCount: records.length,
    sizeBytes: 1000,
    lastSeq: records.length,
    lastProvider: '',
    lastModel: '',
    records,
    ...(extra || {}),
  }
}
function snapshotOf(entries) {
  const sessions = {}
  for (const entry of entries) sessions[entry.id] = entry
  return { generatedAt: T(2025, 1, 8), sessions }
}

const flashPeak = [
  SH(2025, 1, 6, 10, 0),
  'deepseek-official',
  'deepseek-flash',
  1000000,
  400000,
  0,
  200000,
  50000,
]
const flashIdle = [SH(2025, 1, 6, 13, 0), 'deepseek-official', 'deepseek-flash', 500000, 0, 0, 100000, 0]
const opusRecord = [SH(2025, 1, 4, 10, 0), 'lgd-claude', 'claude-opus-5-5', 100000, 0, 0, 20000, 0]
const proRecord = [SH(2025, 1, 7, 10, 0), 'deepseek-official', 'deepseek-v4-pro', 1000000, 0, 0, 100000, 0]

const dataset = snapshotOf([
  entryOf('s1', [flashPeak, flashIdle]),
  entryOf('s2', [opusRecord], { cwd: 'D:/work/other', origin: 'subagent', delegationDepth: 1 }),
  entryOf('s3', [proRecord]),
])
const JAN = { from: SH(2025, 1, 1), to: SH(2025, 2, 1) }

function statsOf(snapshot, overrides) {
  const cfg = freshConfig()
  const query = aggregate.normalizedQuery({ ...JAN, ...(overrides || {}) }, cfg)
  return aggregate.aggregate(snapshot, cfg, query, cost)
}

function breakdownOf(snapshot, overrides, limit) {
  const cfg = freshConfig()
  const query = aggregate.normalizedQuery({ ...JAN, ...(overrides || {}) }, cfg)
  return aggregate.sessionBreakdown(snapshot, cfg, query, cost, limit)
}

section('bucketSessions: per-session breakdown (pure)')

await test('sessions sorted by tokens with labels and real ids', () => {
  const value = breakdownOf(dataset, { metric: 'tokens' })
  eq(value.from, JAN.from)
  eq(value.to, JAN.to)
  eq(value.metric, 'tokens')
  eq(value.currency, 'CNY')
  eq(
    value.sessions.map((row) => row.key),
    ['s1', 's3', 's2'],
  )
  eq(value.sessionCount, 3)
  eq(value.truncated, false)
  const [first, second, third] = value.sessions
  eq(first.tokens, 2200000)
  eq(first.label, 'dsh', 'label is the cwd basename')
  eq(second.tokens, 1100000)
  eq(second.label, 'dsh')
  eq(third.tokens, 120000)
  eq(third.label, 'other')
  eq(first.miss, 1500000)
  eq(first.hit, 400000)
  eq(first.out, 300000)
  eq(first.reasoning, 50000)
  eq(first.requests, 2)
  close(first.cost, 4.516, 's1 cost')
  close(second.cost, 11.7, 's3 cost')
  eq(third.cost, 0, 'unpriced session costs 0')
  for (const row of value.sessions) eq(typeof row.title, 'string', 'title is always a string')
  // total equals the sum of all rows when nothing is truncated
  eq(value.total.tokens, 3420000)
  close(value.total.cost, 16.216, 'total cost')
  for (const row of value.sessions) {
    eq(row.tokens, row.miss + row.hit + row.write + row.out, 'row tokens decompose')
  }
  eq(value.total.miss, 2600000)
  eq(value.total.hit, 400000)
  eq(value.total.out, 420000)
  eq(value.total.requests, 4)
  const sum = value.sessions.reduce(
    (acc, row) => {
      acc.tokens += row.tokens
      acc.cost += row.cost
      acc.requests += row.requests
      acc.miss += row.miss
      acc.hit += row.hit
      acc.write += row.write
      acc.out += row.out
      acc.reasoning += row.reasoning
      return acc
    },
    { tokens: 0, cost: 0, requests: 0, miss: 0, hit: 0, write: 0, out: 0, reasoning: 0 },
  )
  for (const field of Object.keys(sum)) {
    close(sum[field], value.total[field], 'sum of rows equals total.' + field)
  }
  eq(value.notes.timezoneOffsetMinutes, 480)
  eq(value.notes.unpricedModels, [{ key: 'lgd-claude/claude-opus-5-5', tokens: 120000 }])
  eq(value.notes.partial, false)
})

await test('sessions sorted by cost (metric only changes ranking)', () => {
  const value = breakdownOf(dataset, { metric: 'cost' })
  eq(
    value.sessions.map((row) => row.key),
    ['s3', 's1', 's2'],
  )
  eq(value.metric, 'cost')
  eq(value.sessions[0].cost, 11.7)
  eq(value.sessions[1].cost, 4.516)
  eq(value.sessions[2].cost, 0)
  eq(value.total.tokens, 3420000, 'totals are metric independent')
})

await test('limit/truncation and tie-breaking', () => {
  const limited = breakdownOf(dataset, {}, 2)
  eq(limited.sessionCount, 3)
  eq(limited.truncated, true)
  eq(limited.sessions.length, 2)
  eq(
    limited.sessions.map((row) => row.key),
    ['s1', 's3'],
  )
  eq(limited.total.tokens, 3420000, 'total still covers the whole range')

  // limit is clamped to 1..200 and defaults to 60.
  eq(breakdownOf(dataset, {}, 0).sessions.length, 1)
  eq(breakdownOf(dataset, {}, 999).sessions.length, 3)
  eq(breakdownOf(dataset, {}, null).sessions.length, 3)
  const many = snapshotOf(
    Array.from({ length: 70 }, (_, i) =>
      entryOf('sess-' + String(i).padStart(2, '0'), [
        [SH(2025, 1, 6, 10, 0), 'deepseek-official', 'deepseek-flash', 1000, 0, 0, 0, 0],
      ]),
    ),
  )
  eq(breakdownOf(many, {}, undefined).sessions.length, 60, 'default limit is 60')
  const capped = breakdownOf(many, {}, 500)
  eq(capped.sessions.length, 70)
  eq(capped.truncated, false)
  eq(breakdownOf(many, {}, 60).truncated, true)
  // Equal metric + equal requests falls back to key ascending.
  const tie = breakdownOf(many, {}, 3)
  eq(
    tie.sessions.map((row) => row.key),
    ['sess-00', 'sess-01', 'sess-02'],
  )
})

await test('filters apply exactly like stats', () => {
  // s2 is a subagent with no parentSession, so with merge mode it falls back to
  // its own id and the totals stay identical to includeSubagents:true.
  const noSubagents = breakdownOf(dataset, { includeSubagents: false })
  eq(
    noSubagents.sessions.map((row) => row.key),
    ['s1', 's3', 's2'],
  )
  eq(noSubagents.sessionCount, 3)
  eq(noSubagents.total.tokens, 3420000)
  close(noSubagents.total.cost, 16.216)
  eq(noSubagents.notes.subagentsMerged, 0, 'unresolvable subagent falls back to self')

  const onlyOpus = breakdownOf(dataset, { providers: ['lgd-claude'] })
  eq(
    onlyOpus.sessions.map((row) => row.key),
    ['s2'],
  )
  eq(onlyOpus.total.tokens, 120000)
  eq(onlyOpus.total.cost, 0)
  eq(onlyOpus.notes.unpricedModels, [{ key: 'lgd-claude/claude-opus-5-5', tokens: 120000 }])

  const flashOnly = breakdownOf(dataset, { models: ['deepseek-official/deepseek-flash'] })
  eq(
    flashOnly.sessions.map((row) => row.key),
    ['s1'],
  )
  eq(flashOnly.total.tokens, 2200000)
  eq(flashOnly.total.requests, 2)

  const cwd = breakdownOf(dataset, { cwds: ['D:/work/other'] })
  eq(
    cwd.sessions.map((row) => row.key),
    ['s2'],
  )
})

await test('empty range returns a zero Part and no rows', () => {
  const value = breakdownOf(dataset, { from: SH(2025, 2, 1), to: SH(2025, 2, 2) })
  eq(value.sessions, [])
  eq(value.sessionCount, 0)
  eq(value.truncated, false)
  eq(value.total, {
    tokens: 0,
    cost: 0,
    miss: 0,
    hit: 0,
    write: 0,
    out: 0,
    reasoning: 0,
    requests: 0,
  })
  eq(value.notes.unpricedModels, [])
})

await test('category grouping totals/summary/cache-hit/peak bucket', () => {
  const value = statsOf(dataset)
  eq(value.bucket, 'day')
  eq(value.groupBy, 'category')
  eq(value.dims.map((dim) => dim.key), ['hit', 'miss', 'write', 'out'])
  for (const dim of value.dims) eq(dim.kind, 'category')
  eq(value.totals.tokens, 3420000)
  close(value.totals.cost, 16.216, 'total cost')
  eq(value.totals.miss, 2600000)
  eq(value.totals.hit, 400000)
  eq(value.totals.out, 420000)
  eq(value.totals.requests, 4)
  eq(value.summary.totalTokens, 3420000)
  close(value.summary.totalCost, 16.216, 'summary cost')
  eq(value.summary.unpricedTokens, 120000)
  eq(value.summary.pricedTokens, 3300000)
  close(value.summary.cacheHitRate, 400000 / 3000000, 'cache hit rate')
  eq(value.summary.requests, 4)
  eq(value.summary.sessions, 3)
  eq(value.summary.days, 31)
  close(value.summary.avgPerDayTokens, 3420000 / 31, 'avg per day')
  eq(value.summary.peakBucket.t0, SH(2025, 1, 6, 0, 0))
  eq(value.summary.peakBucket.tokens, 2200000)
  eq(value.notes.partial, false)
  eq(value.notes.filters, {
    models: [],
    providers: [],
    includeSubagents: true,
    cwds: [],
  })
  // every Part has the full shape
  eq(Object.keys(value.buckets[0].total), [
    'tokens',
    'cost',
    'miss',
    'hit',
    'write',
    'out',
    'reasoning',
    'requests',
  ])
})

await test('category byDim splits tokens and cost per category', () => {
  const value = statsOf(dataset, { bucket: 'month' })
  eq(value.buckets.length, 1)
  const byDim = value.buckets[0].byDim
  eq(byDim.miss.tokens, 2600000)
  eq(byDim.hit.tokens, 400000)
  eq(byDim.out.tokens, 420000)
  eq(byDim.write, undefined, 'zero category dims are omitted')
  close(byDim.miss.cost + byDim.hit.cost + byDim.out.cost, 16.216, 'category cost split sums to total')
  close(byDim.miss.cost, 2.0 + 0.5 + 9.0, 'miss category cost')
  close(byDim.hit.cost, 0.008 * 2 + 0, 'hit category cost')
  eq(byDim.out.tokens, value.totals.out)
})

await test('provider/model/session grouping and top-N __other merging', () => {
  const provider = statsOf(dataset, { groupBy: 'provider', bucket: 'month' })
  eq(
    provider.dims.map((dim) => dim.key),
    ['deepseek-official', 'lgd-claude'],
  )
  eq(provider.dims[0].kind, 'provider')
  eq(provider.buckets[0].byDim['deepseek-official'].tokens, 3300000)
  eq(provider.buckets[0].byDim['lgd-claude'].tokens, 120000)
  close(provider.buckets[0].byDim['deepseek-official'].cost, 16.216, 'provider cost')

  const model = statsOf(dataset, { groupBy: 'model', bucket: 'month' })
  eq(
    model.dims.map((dim) => dim.key),
    [
      'deepseek-official/deepseek-flash',
      'deepseek-official/deepseek-v4-pro',
      'lgd-claude/claude-opus-5-5',
    ],
  )
  eq(model.dims[2].kind, 'model')

  const session = statsOf(dataset, { groupBy: 'session', bucket: 'month' })
  eq(
    session.dims.map((dim) => dim.key),
    ['s1', 's3', 's2'],
  )
  eq(session.dims[0].label, 'dsh', 'session label is the cwd basename')
  eq(session.dims[2].label, 'other')
  eq(session.dims[0].kind, 'session')

  // metric only affects dimension ranking
  const byCost = statsOf(
    snapshotOf([
      entryOf('a', [[SH(2025, 1, 6, 13, 0), 'deepseek-official', 'deepseek-v4-pro', 1000000, 0, 0, 0, 0]]),
      entryOf('b', [[SH(2025, 1, 6, 13, 0), 'deepseek-official', 'deepseek-flash', 1000000, 0, 0, 100000, 0]]),
    ]),
    { groupBy: 'model', metric: 'cost', bucket: 'month' },
  )
  eq(byCost.dims[0].key, 'deepseek-official/deepseek-v4-pro', 'cost ranking favours the expensive model')
  const byTokens = statsOf(
    snapshotOf([
      entryOf('a', [[SH(2025, 1, 6, 13, 0), 'deepseek-official', 'deepseek-v4-pro', 1000000, 0, 0, 0, 0]]),
      entryOf('b', [[SH(2025, 1, 6, 13, 0), 'deepseek-official', 'deepseek-flash', 1000000, 0, 0, 100000, 0]]),
    ]),
    { groupBy: 'model', metric: 'tokens', bucket: 'month' },
  )
  eq(byTokens.dims[0].key, 'deepseek-official/deepseek-flash')

  // 25 models -> top 20 + __other
  const manyModels = []
  for (let i = 0; i < 25; i++) {
    manyModels.push([SH(2025, 1, 6, 13, 0), 'p', 'm' + i, 1000, 0, 0, 0, 0])
  }
  const manyModelsValue = statsOf(snapshotOf([entryOf('s', manyModels)]), { groupBy: 'model', bucket: 'month' })
  eq(manyModelsValue.dims.length, 21)
  eq(manyModelsValue.dims[20].key, '__other')
  eq(manyModelsValue.dims[20].kind, 'model')
  eq(manyModelsValue.dims[20].label, 'other')
  eq(manyModelsValue.buckets[0].byDim.__other.tokens, 5000)

  // 14 sessions -> top 12 + __other
  const manySessions = []
  for (let i = 0; i < 14; i++) {
    manySessions.push(
      entryOf('sess-' + i, [
        [SH(2025, 1, 6, 13, 0), 'deepseek-official', 'deepseek-flash', 1000, 0, 0, 0, 0],
      ]),
    )
  }
  const manySessionsValue = statsOf(snapshotOf(manySessions), { groupBy: 'session', bucket: 'month' })
  eq(manySessionsValue.dims.length, 13)
  eq(manySessionsValue.dims[12].key, '__other')
  eq(manySessionsValue.buckets[0].byDim.__other.tokens, 2000)
})

await test('filters (models, providers, cwds, includeSubagents) apply before aggregation', () => {
  const onlyFlash = statsOf(dataset, { models: ['deepseek-official/deepseek-flash'] })
  eq(onlyFlash.totals.tokens, 2200000)
  close(onlyFlash.totals.cost, 4.516, 'flash filtered cost')
  eq(onlyFlash.summary.requests, 2)
  eq(onlyFlash.summary.sessions, 1)
  eq(onlyFlash.notes.filters.models, ['deepseek-official/deepseek-flash'])

  const onlyOpus = statsOf(dataset, { providers: ['lgd-claude'] })
  eq(onlyOpus.totals.tokens, 120000)
  eq(onlyOpus.totals.cost, 0)
  eq(onlyOpus.summary.unpricedTokens, 120000)
  eq(onlyOpus.summary.pricedTokens, 0)
  eq(onlyOpus.notes.unpricedModels, [{ key: 'lgd-claude/claude-opus-5-5', tokens: 120000 }])
  eq(onlyOpus.summary.totalCost, 0, 'unpriced records contribute 0 cost')

  // s2 is a subagent with no parentSession, so merge mode folds nothing and the
  // totals must stay identical to includeSubagents:true (the old drop bug).
  const noSubagents = statsOf(dataset, { includeSubagents: false })
  eq(noSubagents.totals.tokens, 3420000)
  close(noSubagents.totals.cost, 16.216, 'no-subagent cost')
  eq(noSubagents.summary.sessions, 3)
  eq(noSubagents.notes.subagentsMerged, 0)
  eq(noSubagents.notes.filters.includeSubagents, false)

  const cwd = statsOf(dataset, { cwds: ['D:/work/other'] })
  eq(cwd.totals.tokens, 120000)
  eq(cwd.summary.sessions, 1)

  const combined = statsOf(dataset, {
    providers: ['deepseek-official'],
    models: ['deepseek-official/deepseek-v4-pro'],
  })
  eq(combined.totals.tokens, 1100000)
  close(combined.totals.cost, 11.7, 'combined filter cost')
})

await test('bucket assignment keeps records in their local buckets', () => {
  const jan6 = statsOf(dataset, {
    from: SH(2025, 1, 6, 0, 0),
    to: SH(2025, 1, 7, 0, 0),
    bucket: 'day',
  })
  eq(jan6.buckets.length, 1)
  eq(jan6.totals.tokens, 2200000)
  eq(jan6.summary.peakBucket.t0, SH(2025, 1, 6, 0, 0))

  const emptyDay = statsOf(dataset, {
    from: SH(2025, 1, 9, 0, 0),
    to: SH(2025, 1, 10, 0, 0),
    bucket: 'day',
  })
  eq(emptyDay.buckets.length, 1)
  eq(emptyDay.totals.tokens, 0)
  eq(emptyDay.summary.peakBucket, null)
  eq(emptyDay.dims.length, 4)
})

await test('notes unpricedModels is filtered and sorted', () => {
  const value = statsOf(dataset)
  eq(value.notes.unpricedModels.length, 1)
  eq(value.notes.indexProgress, { scanned: 0, total: 0, running: false })
})

// ---------------------------------------------------------------------------
// Subagent merge mode (includeSubagents:false folds subagents into their owner)
// ---------------------------------------------------------------------------

section('subagent merge into owner (includeSubagents:false)')

const mergeTime = SH(2025, 1, 6, 10, 0)
function mergeRecord(id, tokens) {
  return [mergeTime, 'deepseek-official', 'deepseek-flash', tokens, 0, 0, 0, 0]
}
function mergeEntry(id, records, extra) {
  return entryOf(id, records, extra)
}

// main-a < sub-a1 < sub-a2 (two-level chain), main-a < fork-a (ordinary fork),
// orphan-sub (parent never indexed), cycle-a <-> cycle-b (no non-subagent ancestor).
const mergeSnapshot = snapshotOf([
  mergeEntry('main-a', [mergeRecord('main-a', 1000)]),
  mergeEntry('sub-a1', [mergeRecord('sub-a1', 200)], {
    origin: 'subagent',
    delegationDepth: 1,
    parentSession: 'main-a',
  }),
  mergeEntry('sub-a2', [mergeRecord('sub-a2', 300)], {
    origin: 'subagent',
    delegationDepth: 2,
    parentSession: 'sub-a1',
  }),
  mergeEntry('fork-a', [mergeRecord('fork-a', 400)], { parentSession: 'main-a', origin: null }),
  mergeEntry('orphan-sub', [mergeRecord('orphan-sub', 50)], {
    origin: 'subagent',
    delegationDepth: 1,
    parentSession: 'missing-parent',
  }),
  mergeEntry('cycle-a', [mergeRecord('cycle-a', 10)], {
    origin: 'subagent',
    delegationDepth: 1,
    parentSession: 'cycle-b',
  }),
  mergeEntry('cycle-b', [mergeRecord('cycle-b', 20)], {
    origin: 'subagent',
    delegationDepth: 1,
    parentSession: 'cycle-a',
  }),
])

function mergeStats(includeSubagents, groupBy) {
  return statsOf(mergeSnapshot, { includeSubagents, groupBy: groupBy || 'session' })
}
function mergeBreakdown(includeSubagents, limit) {
  return breakdownOf(mergeSnapshot, { includeSubagents }, limit)
}

await test('merge keeps every totals field identical to includeSubagents:true', () => {
  for (const groupBy of ['category', 'provider', 'model', 'session']) {
    const withSubs = mergeStats(true, groupBy)
    const merged = mergeStats(false, groupBy)
    eq(merged.totals.tokens, withSubs.totals.tokens, groupBy + ' tokens')
    close(merged.totals.cost, withSubs.totals.cost, groupBy + ' cost')
    eq(merged.totals.requests, withSubs.totals.requests, groupBy + ' requests')
    eq(merged.totals.miss, withSubs.totals.miss, groupBy + ' miss')
    eq(merged.totals.hit, withSubs.totals.hit, groupBy + ' hit')
    eq(merged.summary.totalTokens, withSubs.summary.totalTokens)
    eq(merged.summary.totalCost, withSubs.summary.totalCost)
  }
  eq(mergeStats(true).totals.tokens, 1980)
  eq(mergeStats(false).totals.tokens, 1980, 'nothing dropped')
  eq(mergeStats(true).notes.subagentsMerged, 0, 'no merge count when listing subagents')
})

await test('owner attribution walks the parentSession chain to the nearest main session', () => {
  const merged = mergeStats(false)
  eq(merged.notes.subagentsMerged, 2, 'sub-a1 + sub-a2 folded into main-a')
  // owners: main-a (main + sub-a1 + sub-a2 = 1500), fork-a (400), orphan (50),
  // cycle-a (10), cycle-b (20) -> 5 distinct owners; subagents listed = 7 rows.
  eq(merged.summary.sessions, 5)
  eq(mergeStats(true).summary.sessions, 7)
  const dims = new Map(merged.dims.map((dim) => [dim.key, dim]))
  assert.ok(dims.has('main-a'), 'main-a row exists')
  eq(dims.has('sub-a1'), false, 'subagent row folded away')
  eq(dims.has('sub-a2'), false)
  eq(dims.has('fork-a'), true, 'ordinary fork stays its own owner row')
  eq(dims.has('orphan-sub'), true, 'unresolved parent falls back to self')
  eq(dims.has('cycle-a'), true, 'cycle falls back to self')
  const mainBucket = merged.buckets.reduce((sum, bucket) => sum + Number(bucket.byDim['main-a']?.tokens || 0), 0)
  eq(mainBucket, 1500, 'main-a row = main + both tributary subagents')
  const forkTokens = merged.buckets.reduce((sum, bucket) => sum + Number(bucket.byDim['fork-a']?.tokens || 0), 0)
  eq(forkTokens, 400, 'fork not merged into main')
  // The with-subagents view keeps the subagent rows separate with their own tokens.
  const withSubs = mergeStats(true)
  const subTokens = withSubs.buckets.reduce(
    (sum, bucket) => sum + Number(bucket.byDim['sub-a1']?.tokens || 0) + Number(bucket.byDim['sub-a2']?.tokens || 0),
    0,
  )
  eq(subTokens, 500)
})

await test('sessionBreakdown merges rows, counts owners and keeps totals', () => {
  const withSubs = mergeBreakdown(true)
  const merged = mergeBreakdown(false)
  eq(withSubs.sessions.length, 7)
  eq(merged.sessions.length, 5)
  eq(merged.sessionCount, 5)
  eq(merged.total.tokens, withSubs.total.tokens)
  close(merged.total.cost, withSubs.total.cost)
  eq(merged.notes.subagentsMerged, 2)
  eq(withSubs.notes.subagentsMerged, 0)
  const mainRow = merged.sessions.find((row) => row.key === 'main-a')
  assert.ok(mainRow, 'main-a row present')
  eq(mainRow.tokens, 1500)
  eq(mainRow.requests, 3)
  eq(mainRow.label, 'dsh', 'owner label uses owner cwd')
  eq(merged.sessions.some((row) => row.key === 'sub-a1' || row.key === 'sub-a2'), false)
  eq(merged.sessions.some((row) => row.key === 'fork-a'), true, 'fork row stays separate')
  // Sum of merged rows equals the total (nothing lost).
  const sum = merged.sessions.reduce((acc, row) => acc + row.tokens, 0)
  eq(sum, merged.total.tokens)
})

await test('cycle, deep chain (64-hop cap) and missing parent stay safe', () => {
  // Cycle: neither node has a non-subagent ancestor -> both fall back to self.
  const cycle = breakdownOf(mergeSnapshot, { includeSubagents: false })
  eq(cycle.sessions.find((row) => row.key === 'cycle-a').tokens, 10)
  eq(cycle.sessions.find((row) => row.key === 'cycle-b').tokens, 20)
  eq(cycle.notes.subagentsMerged, 2, 'cycle fallbacks are not counted as merged')

  // A 70-hop subagent chain: beyond the 64-hop cap the tail falls back to self
  // but every record must still appear in the totals exactly once.
  const deep = []
  for (let i = 0; i < 70; i += 1) {
    deep.push(
      entryOf('deep-' + String(i).padStart(2, '0'), [
        [mergeTime, 'deepseek-official', 'deepseek-flash', 10, 0, 0, 0, 0],
      ], {
        origin: 'subagent',
        delegationDepth: 1,
        parentSession: i === 0 ? 'deep-root' : 'deep-' + String(i - 1).padStart(2, '0'),
      }),
    )
  }
  deep.push(entryOf('deep-root', [[mergeTime, 'deepseek-official', 'deepseek-flash', 1, 0, 0, 0, 0]]))
  const deepSnapshot = snapshotOf(deep)
  const deepWith = statsOf(deepSnapshot, { includeSubagents: true })
  const deepMerged = statsOf(deepSnapshot, { includeSubagents: false })
  eq(deepMerged.totals.tokens, deepWith.totals.tokens, 'deep chain totals identical')
  eq(deepMerged.totals.tokens, 701)
  eq(deepMerged.notes.subagentsMerged, 64, 'only the 64 resolvable hops are merged')
  eq(deepMerged.summary.sessions, deepWith.summary.sessions - 64)
})

// ---------------------------------------------------------------------------
// meta / sessionSummary
// ---------------------------------------------------------------------------

section('meta + sessionSummary')

await test('meta lists providers/models/cwds and session counts', () => {
  const value = aggregate.meta(dataset, freshConfig(), cost)
  eq(value.generatedAt, T(2025, 1, 8))
  eq(value.timezoneOffsetMinutes, 480)
  eq(value.currency, 'CNY')
  eq(value.timeRange, { from: SH(2025, 1, 4, 10, 0), to: SH(2025, 1, 7, 10, 0) })
  eq(
    value.providers.map((row) => row.key),
    ['deepseek-official', 'lgd-claude'],
  )
  eq(value.providers[0].tokens, 3300000)
  eq(value.providers[0].priced, true)
  eq(value.providers[1].priced, false)
  eq(
    value.models.map((row) => row.key),
    [
      'deepseek-official/deepseek-flash',
      'deepseek-official/deepseek-v4-pro',
      'lgd-claude/claude-opus-5-5',
    ],
  )
  eq(value.models[0].provider, 'deepseek-official')
  eq(value.models[0].model, 'deepseek-flash')
  eq(value.models[2].priced, false)
  eq(
    value.cwds.map((row) => row.path),
    ['D:/game/dsh', 'D:/work/other'],
  )
  eq(value.sessions, { indexed: 3, total: 3, withUsage: 3 })
  assert.ok(value.config && value.defaults)
  eq(aggregate.meta(EMPTY_SNAPSHOT, freshConfig(), cost).timeRange, null)
})

await test('sessionSummary for a known session', () => {
  const value = aggregate.sessionSummary(dataset, freshConfig(), cost, 's1')
  eq(value.found, true)
  eq(value.sessionId, 's1')
  eq(value.cwd, 'D:/game/dsh')
  eq(value.tokens.tokens, 2200000)
  eq(value.tokens.requests, 2)
  close(value.tokens.cost, 4.516, 'session cost')
  close(value.cacheHitRate, 400000 / 1900000, 'session cache hit rate')
  eq(value.firstTime, SH(2025, 1, 6, 10, 0))
  eq(value.lastTime, SH(2025, 1, 6, 13, 0))
  eq(value.models.length, 1)
  eq(value.models[0].key, 'deepseek-official/deepseek-flash')
  eq(value.models[0].tokens, 2200000)
  eq(value.unpricedTokens, 0)
  eq(value.global.all.tokens, 3420000)
  close(value.global.all.cost, 16.216, 'global all cost')
  assert.ok(Number.isFinite(value.global.today.tokens))
  eq(value.global.today.tokens <= value.global.all.tokens, true)
})

await test('sessionSummary for unpriced and unknown sessions', () => {
  const unpriced = aggregate.sessionSummary(dataset, freshConfig(), cost, 's2')
  eq(unpriced.found, true)
  eq(unpriced.unpricedTokens, 120000)
  eq(unpriced.tokens.cost, 0)

  const missing = aggregate.sessionSummary(dataset, freshConfig(), cost, 'nope')
  eq(missing.found, false)
  eq(missing.sessionId, 'nope')
  eq(missing.tokens, {
    tokens: 0,
    cost: 0,
    miss: 0,
    hit: 0,
    write: 0,
    out: 0,
    reasoning: 0,
    requests: 0,
  })
  eq(missing.models, [])
  eq(missing.global, { today: { tokens: 0, cost: 0 }, all: { tokens: 0, cost: 0 } })
})

// ---------------------------------------------------------------------------
// Store I/O (isolated temp DSH_HOME)
// ---------------------------------------------------------------------------

section('store I/O (config validation, atomic gzip index)')

await test('writeConfig/readConfig round trip and bad-config rejection', async () => {
  const patch = {
    currency: 'USD',
    timezoneOffsetMinutes: 60,
    prices: { 'a/b': { hit: 0.5, miss: 1, write: 0, out: 2, peakMultiplier: 3 } },
    peak: {
      enabled: false,
      days: [6, 7],
      windows: [{ start: 0, end: 60 }],
      holidays: ['2025-05-01'],
    },
    prefs: { view: 'week' },
  }
  const written = await store.writeConfig(patch, defaults)
  eq(written.currency, 'USD')
  eq(written.timezoneOffsetMinutes, 60)
  eq(written.prices, { 'a/b': { hit: 0.5, miss: 1, write: 0, out: 2, peakMultiplier: 3 } })
  eq(written.peak.days, [6, 7])
  eq(written.peak.holidays, ['2025-05-01'])
  eq(written.prefs, { view: 'week' })
  eq((await store.readConfig(defaults)).currency, 'USD')
  eq(defaults.currency, 'CNY', 'DEFAULT_CONFIG untouched')

  for (const invalid of [
    { prices: 5 },
    { prices: { 'a/b': 'cheap' } },
    { prices: { 'a/b': { hit: -1 } } },
    { timezoneOffsetMinutes: 'x' },
    { timezoneOffsetMinutes: 99999 },
    { currency: '' },
    { peak: { days: [0] } },
    { peak: { windows: [{ start: 10, end: 5 }] } },
    { peak: { holidays: ['01/01/2025'] } },
    { unknown: 1 },
  ]) {
    await assert.rejects(
      () => store.writeConfig(invalid, defaults),
      (error) => error && error.code === 'bad-config',
      'invalid patch should be rejected: ' + JSON.stringify(invalid),
    )
  }
})

await test('writeIndex/readIndex round trip, corruption tolerant', async () => {
  const index = {
    version: 1,
    generatedAt: 12345,
    sessions: { 's-1': { id: 's-1', records: [[1, 'p', 'm', 2, 0, 0, 3, 0]] } },
  }
  const bytes = await store.writeIndex(index)
  assert.ok(bytes > 0)
  assert.ok((await store.indexFileSize()) > 0)
  const read = await store.readIndex()
  eq(read.generatedAt, 12345)
  eq(read.sessions, index.sessions)
  eq(read.version, 1)

  await writeFile(join(store.dataDir(), 'index.json.gz'), 'not a gzip file')
  eq(await store.readIndex(), null)

  await writeFile(join(store.dataDir(), 'index.json.gz'), JSON.stringify({ version: 2, sessions: {} }))
  eq(await store.readIndex(), null)
})

// ---------------------------------------------------------------------------
// HTTP router (fake req/res, empty services)
// ---------------------------------------------------------------------------

section('HTTP router (envelope, method dispatch, errors, body cap)')

function makeReq(method, url, body) {
  const chunks =
    body === undefined || body === null
      ? []
      : [Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const stream = Readable.from(chunks)
  stream.method = method
  stream.url = url
  return stream
}

function makeRes() {
  const chunks = []
  const res = {
    statusCode: 0,
    headers: {},
    headersSent: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers || {}
      this.headersSent = true
      return this
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk))
      return this
    },
  }
  return {
    res,
    body() {
      const text = Buffer.concat(chunks).toString('utf8')
      return text ? JSON.parse(text) : null
    },
  }
}

async function apiCall(app, method, payload) {
  const res = makeRes()
  await app.handle(makeReq('POST', '/dshtoken/api/' + method, payload === undefined ? {} : payload), res.res)
  return { status: res.res.statusCode, body: res.body() }
}

async function waitIdle(app) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (!app.status().running) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('background scan did not finish in time')
}

await test('status/meta/stats/config/debug/rebuild with no guest services', async () => {
  // Start from a clean plugin-data dir: earlier store tests intentionally wrote
  // a custom config and a corrupt index there.
  for (const file of ['config.json', 'index.json.gz']) {
    await rm(join(store.dataDir(), file), { force: true })
  }
  const ctx = { get: () => undefined, on: () => () => {} }
  const app = await http.createApp({ ctx, version: 'selftest-empty', log: () => {} })
  try {
    await waitIdle(app)

    const status = await apiCall(app, 'status')
    eq(status.status, 200)
    eq(status.body.ok, true)
    eq(status.body.value.running, false)
    eq(status.body.value.services, { sessionQuery: false, sessionPersistence: false })
    eq(status.body.value.version, 1)
    eq(status.body.value.sessions, 0)
    eq(status.body.value.records, 0)
    eq(status.body.value.errors, [])
    eq(typeof status.body.value.finishedAt, 'number')

    const meta = await apiCall(app, 'meta')
    eq(meta.body.ok, true)
    eq(meta.body.value.timezoneOffsetMinutes, 480)
    eq(meta.body.value.currency, 'CNY')
    eq(meta.body.value.sessions, { indexed: 0, total: 0, withUsage: 0 })
    eq(meta.body.value.providers, [])
    eq(meta.body.value.models, [])
    eq(meta.body.value.timeRange, null)
    eq(meta.body.value.defaults.prices['deepseek-official/deepseek-flash'].miss, 1)

    const from = SH(2025, 1, 1)
    const to = SH(2025, 1, 2)
    const stats = await apiCall(app, 'stats', { from, to, bucket: 'hour', groupBy: 'category' })
    eq(stats.body.ok, true)
    eq(stats.body.value.bucket, 'hour')
    eq(stats.body.value.buckets.length, 24)
    eq(stats.body.value.dims.map((dim) => dim.key), ['hit', 'miss', 'write', 'out'])
    eq(stats.body.value.totals.tokens, 0)
    eq(stats.body.value.summary.peakBucket, null)
    eq(stats.body.value.notes.partial, false)
    eq(stats.body.value.notes.indexProgress, { scanned: 0, total: 0, running: false })

    const config = await apiCall(app, 'config')
    eq(config.body.ok, true)
    eq(config.body.value.config.currency, 'CNY')
    eq(config.body.value.defaults.currency, 'CNY')
    eq(config.body.value.config.prices['deepseek-official/deepseek-flash'].hit, 0.02)

    const invalidConfig = await apiCall(app, 'config', { patch: { prices: 5 } })
    eq(invalidConfig.body.ok, false)
    eq(invalidConfig.body.error.code, 'bad-config')

    const debug = await apiCall(app, 'debug')
    eq(debug.body.ok, true)
    eq(debug.body.value.services, { sessionQuery: false, sessionPersistence: false })
    eq(debug.body.value.index.sessions, 0)
    eq(debug.body.value.config.currency, 'CNY')

    const rebuild = await apiCall(app, 'rebuild')
    eq(rebuild.body.ok, true)
    eq(rebuild.body.value, { started: true })
    await waitIdle(app)

    const session = await apiCall(app, 'session', { sessionId: 'missing' })
    eq(session.body.ok, true)
    eq(session.body.value.found, false)
    eq(session.body.value.sessionId, 'missing')
    eq(session.body.value.tokens.tokens, 0)

    const titles = await apiCall(app, 'titles', { ids: ['missing'] })
    eq(titles.body.ok, true)
    eq(titles.body.value, {})

    const noSession = await apiCall(app, 'session', {})
    eq(noSession.body.ok, false)
    eq(noSession.body.error.code, 'bad-request')

    const badIds = await apiCall(app, 'titles', { ids: 'x' })
    eq(badIds.body.ok, false)
    eq(badIds.body.error.code, 'bad-request')
  } finally {
    await app.dispose()
  }
})

await test('HTTP errors: unknown method, non-POST, bad JSON, too-many-buckets, body cap', async () => {
  const ctx = { get: () => undefined, on: () => () => {} }
  const app = await http.createApp({ ctx, version: 'selftest-errors', log: () => {} })
  try {
    await waitIdle(app)

    const unknown = await apiCall(app, 'bogus')
    eq(unknown.status, 404)
    eq(unknown.body.ok, false)
    eq(unknown.body.error.code, 'unknown-method')

    const res = makeRes()
    await app.handle(makeReq('GET', '/dshtoken/api/status'), res.res)
    eq(res.res.statusCode, 405)
    eq(res.body().error.code, 'method')

    const badJsonRes = makeRes()
    await app.handle(makeReq('POST', '/dshtoken/api/status', 'not json'), badJsonRes.res)
    eq(badJsonRes.res.statusCode, 400)
    eq(badJsonRes.body().error.code, 'bad-json')

    const from = SH(2025, 1, 1)
    const tooMany = await apiCall(app, 'stats', { from, to: from + 1001 * HOUR, bucket: 'hour' })
    eq(tooMany.status, 200)
    eq(tooMany.body.ok, false)
    eq(tooMany.body.error.code, 'too-many-buckets')

    const badQuery = await apiCall(app, 'stats', { from, to: from })
    eq(badQuery.status, 400)
    eq(badQuery.body.error.code, 'bad-request')

    const bigRes = makeRes()
    await app.handle(makeReq('POST', '/dshtoken/api/status', Buffer.alloc(2 * 1024 * 1024 + 16)), bigRes.res)
    eq(bigRes.res.statusCode, 413)
    eq(bigRes.body().error.code, 'body-too-large')

    await app.dispose()
    const afterDispose = await apiCall(app, 'status')
    eq(afterDispose.status, 503)
    eq(afterDispose.body.ok, false)
  } finally {
    await app.dispose()
  }
})

// ---------------------------------------------------------------------------
// HTTP router with fake guest services (scan, cache, live feed)
// ---------------------------------------------------------------------------

section('HTTP + indexer with fake sessionQuery/sessionPersistence')

function fakeSessionLog(id, cwd, events, extra) {
  return {
    session: { id, createdAt: events[0].time - 60000, cwd, ...(extra || {}) },
    inheritedEventCount: 0,
    events,
  }
}

const fakeLogs = {
  'sess-a': fakeSessionLog('sess-a', 'D:/game/dsh', [
    {
      type: 'request/header',
      seq: 0,
      time: SH(2025, 1, 6, 9, 59),
      data: { reason: 'initial', header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } },
    },
    {
      type: 'assistant/message',
      seq: 1,
      time: SH(2025, 1, 6, 10, 0),
      data: { usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 400 } },
    },
  ]),
  'sess-b': fakeSessionLog(
    'sess-b',
    'D:/work/x',
    [
      {
        type: 'request/header',
        seq: 0,
        time: SH(2025, 1, 6, 12, 59),
        data: { reason: 'initial', header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } } },
      },
      {
        type: 'assistant/message',
        seq: 1,
        time: SH(2025, 1, 6, 13, 0),
        data: { usage: { inputTokens: 2000, outputTokens: 300 } },
      },
    ],
    { origin: 'subagent', delegationDepth: 1 },
  ),
  'sess-ondemand': fakeSessionLog('sess-ondemand', 'D:/ondemand', [
    {
      type: 'request/header',
      seq: 0,
      time: SH(2025, 1, 5, 10, 0),
      data: { reason: 'initial', header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } },
    },
    {
      type: 'assistant/message',
      seq: 1,
      time: SH(2025, 1, 5, 10, 1),
      data: { usage: { inputTokens: 500, outputTokens: 50 } },
    },
  ]),
}

await test('scan, index cache, stats, session, titles and live feed via fake services', async () => {
  const listed = ['sess-a', 'sess-b']
  let liveHandler = null
  const fakeQuery = {
    async listSessions() {
      return listed.map((id) => ({ header: fakeLogs[id].session, live: false, persisted: true }))
    },
    async readSession(id) {
      const log = fakeLogs[id]
      if (!log) throw new Error('session not found: ' + id)
      return log
    },
    async readTitle(id) {
      return fakeLogs[id] ? { title: 'Title ' + id, eventSeq: 0, updatedAt: 0 } : undefined
    },
  }
  const fakePersistence = {
    async stat(id) {
      const log = fakeLogs[id]
      if (!log) return undefined
      return { header: log.session, eventCount: log.events.length, sizeBytes: 1000 }
    },
    async list() {
      return listed.map((id) => fakePersistence.stat(id))
    },
  }
  const ctx = {
    get(name) {
      if (name === 'sessionQuery') return fakeQuery
      if (name === 'sessionPersistence') return fakePersistence
      return undefined
    },
    on(name, handler) {
      if (name === 'session/event') liveHandler = handler
      return () => {
        liveHandler = null
      }
    },
  }
  const app = await http.createApp({ ctx, version: 'selftest-fake', log: () => {} })
  try {
    await waitIdle(app)

    const status = await apiCall(app, 'status')
    eq(status.body.value.services, { sessionQuery: true, sessionPersistence: true })
    eq(status.body.value.total, 2)
    eq(status.body.value.scanned, 2)
    eq(status.body.value.sessions, 2)
    eq(status.body.value.records, 2)
    assert.ok(status.body.value.indexBytes > 0, 'index cache written')

    const from = SH(2025, 1, 6, 0, 0)
    const to = SH(2025, 1, 7, 0, 0)
    const stats = await apiCall(app, 'stats', { from, to, bucket: 'day', groupBy: 'provider' })
    eq(stats.body.value.totals.tokens, 3900)
    eq(stats.body.value.summary.requests, 2)
    eq(stats.body.value.summary.sessions, 2)
    eq(stats.body.value.dims.map((dim) => dim.key), ['deepseek-official'])

    const noSubagents = await apiCall(app, 'stats', {
      from,
      to,
      bucket: 'day',
      includeSubagents: false,
    })
    eq(noSubagents.body.value.totals.tokens, 3900)

    const session = await apiCall(app, 'session', { sessionId: 'sess-a' })
    eq(session.body.value.found, true)
    eq(session.body.value.title, 'Title sess-a')
    eq(session.body.value.cwd, 'D:/game/dsh')
    eq(session.body.value.tokens.tokens, 1600)
    eq(session.body.value.models[0].key, 'deepseek-official/deepseek-flash')

    const onDemand = await apiCall(app, 'session', { sessionId: 'sess-ondemand' })
    eq(onDemand.body.value.found, true)
    eq(onDemand.body.value.title, 'Title sess-ondemand')
    eq(onDemand.body.value.tokens.tokens, 550)

    const titles = await apiCall(app, 'titles', { ids: ['sess-a', 'sess-b', 'sess-ondemand', 'nope'] })
    eq(titles.body.value, {
      'sess-a': { title: 'Title sess-a', cwd: 'D:/game/dsh' },
      'sess-b': { title: 'Title sess-b', cwd: 'D:/work/x' },
      // the on-demand session read above made this session part of the snapshot
      'sess-ondemand': { title: 'Title sess-ondemand', cwd: 'D:/ondemand' },
    })

    // Live feed: new session + duplicate guard + existing session append.
    assert.equal(typeof liveHandler, 'function')
    const liveSession = {
      id: 'sess-live',
      header: { id: 'sess-live', createdAt: SH(2025, 1, 6, 14, 0), cwd: 'D:/live' },
      inheritedEventCount: 0,
    }
    const liveHeader = {
      type: 'request/header',
      seq: 0,
      time: SH(2025, 1, 6, 14, 0),
      data: { reason: 'initial', header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } },
    }
    const liveMessage = {
      type: 'assistant/message',
      seq: 1,
      time: SH(2025, 1, 6, 14, 1),
      data: { usage: { inputTokens: 1000, outputTokens: 100 } },
    }
    liveHandler(liveSession, liveHeader)
    liveHandler(liveSession, liveMessage)
    liveHandler(liveSession, liveMessage) // duplicate must be ignored
    eq(app.status().sessions, 4) // 2 scanned + on-demand + live
    eq(app.status().records, 4) // 2 scanned + on-demand + live message
    const liveStats = await apiCall(app, 'stats', { from, to, bucket: 'day' })
    eq(liveStats.body.value.totals.tokens, 5000)

    liveHandler(
      { id: 'sess-a', header: fakeLogs['sess-a'].session, inheritedEventCount: 0 },
      { type: 'assistant/message', seq: 2, time: SH(2025, 1, 6, 10, 2), data: { usage: { inputTokens: 100, outputTokens: 10 } } },
    )
    const afterAppend = await apiCall(app, 'session', { sessionId: 'sess-a' })
    eq(afterAppend.body.value.tokens.tokens, 1710)

    const rebuild = await apiCall(app, 'rebuild')
    eq(rebuild.body.value, { started: true })
    await waitIdle(app)
    const rebuilt = await apiCall(app, 'status')
    eq(rebuilt.body.value.running, false)
    eq(rebuilt.body.value.total, 2)
  } finally {
    await app.dispose()
  }
})

// ---------------------------------------------------------------------------
// Index cache validation (warm-start reuse)
// ---------------------------------------------------------------------------

section('index cache validation (warm start, sizeBytes-only listing, stat fallback)')

const WARM_TIME = T(2025, 1, 6, 10, 0)
function warmLog(id, model) {
  return {
    session: { id, createdAt: WARM_TIME - 60000, cwd: 'D:/warm/' + id, isSeeded: false, delegationDepth: 0 },
    inheritedEventCount: 0,
    events: [
      {
        type: 'request/header',
        seq: 0,
        time: WARM_TIME - 1000,
        data: { reason: 'initial', header: { config: { provider: 'deepseek-official', model } } },
      },
      {
        type: 'assistant/message',
        seq: 1,
        time: WARM_TIME,
        data: { usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0 } },
      },
    ],
  }
}

function warmState() {
  return {
    reads: 0,
    sizes: { 'warm-a': 5000, 'warm-b': 6000 },
    listFields: 'size', // 'size' | 'count' | 'both' | 'none'
    statFields: 'both', // 'both' | 'none'
    logs: {
      'warm-a': warmLog('warm-a', 'deepseek-flash'),
      'warm-b': warmLog('warm-b', 'deepseek-v4-pro'),
    },
  }
}

function warmCtx(state) {
  const ids = Object.keys(state.logs)
  const snapshotOf = (id) => {
    const snapshot = { header: state.logs[id].session, revision: 'rev-' + state.sizes[id] }
    if (state.listFields === 'size' || state.listFields === 'both') snapshot.sizeBytes = state.sizes[id]
    if (state.listFields === 'count' || state.listFields === 'both') {
      snapshot.eventCount = state.logs[id].events.length
    }
    return snapshot
  }
  return {
    get(name) {
      if (name === 'sessionQuery') {
        return {
          async listSessions() {
            return ids.map((id) => ({ header: state.logs[id].session, live: false, persisted: true }))
          },
          async readSession(id) {
            state.reads += 1
            if (!state.logs[id]) throw new Error('missing log ' + id)
            return state.logs[id]
          },
          async readTitle(id) {
            return state.logs[id] ? { title: 'Warm ' + id, eventSeq: 0, updatedAt: WARM_TIME } : undefined
          },
        }
      }
      if (name === 'sessionPersistence') {
        return {
          async list() {
            return ids.map(snapshotOf)
          },
          async stat(id) {
            if (!state.logs[id]) return undefined
            if (state.statFields === 'none') return undefined
            return {
              header: state.logs[id].session,
              eventCount: state.logs[id].events.length,
              sizeBytes: state.sizes[id],
              revision: 'rev-' + state.sizes[id],
            }
          },
        }
      }
      return undefined
    },
    on() {
      return () => {}
    },
  }
}

async function dropIndexCache() {
  await rm(join(store.dataDir(), 'index.json.gz'), { force: true })
}

await test('cacheMatch uses the strongest available key, never a missing field', () => {
  const header = { id: 's' }
  // both fields present on both sides
  eq(scan.cacheMatch({ eventCount: 5, sizeBytes: 100 }, { header, eventCount: 5, sizeBytes: 100 }), true)
  eq(scan.cacheMatch({ eventCount: 5, sizeBytes: 100 }, { header, eventCount: 6, sizeBytes: 100 }), false)
  // sizeBytes-only listing
  eq(scan.cacheMatch({ eventCount: 5, sizeBytes: 100 }, { header, sizeBytes: 100 }), true)
  eq(scan.cacheMatch({ eventCount: 5, sizeBytes: 100 }, { header, sizeBytes: 101 }), false)
  // unvalidatable: the caller must stat() or re-read
  eq(scan.cacheMatch({ eventCount: 5, sizeBytes: 0 }, { header, sizeBytes: 100 }), null)
  eq(scan.cacheMatch({ eventCount: 5, sizeBytes: 100 }, { header, eventCount: 5 }), null)
  eq(scan.cacheMatch({ eventCount: 5, sizeBytes: 100 }, { header }), null)
  eq(scan.cacheMatch({ eventCount: 0, sizeBytes: 0 }, { header }), null)
  eq(scan.cacheMatch(null, { header, sizeBytes: 100 }), null)
  // revision veto only when both sides carry one
  eq(
    scan.cacheMatch({ eventCount: 5, sizeBytes: 100, revision: 'a' }, { header, eventCount: 5, sizeBytes: 100, revision: 'a' }),
    true,
  )
  eq(
    scan.cacheMatch({ eventCount: 5, sizeBytes: 100, revision: 'a' }, { header, eventCount: 5, sizeBytes: 100, revision: 'b' }),
    false,
  )
  eq(scan.cacheMatch({ eventCount: 5, sizeBytes: 100, revision: 'a' }, { header, eventCount: 5, sizeBytes: 100 }), true)
  eq(scan.cacheInfoOf({ eventCount: 5, sizeBytes: 0, revision: 'r' }), {
    eventCount: 5,
    sizeBytes: 0,
    revision: 'r',
  })
  eq(scan.cacheInfoOf({}), {})
  eq(scan.cacheInfoOf(null), {})
})

await test('warm start reuses the index when the listing only carries sizeBytes', async () => {
  await dropIndexCache()
  const state = warmState()
  state.listFields = 'size'
  const ctx = warmCtx(state)
  const app1 = await http.createApp({ ctx, version: 'selftest-warm-size', log: () => {} })
  try {
    await waitIdle(app1)
    eq(state.reads, 2, 'cold scan reads every session')
    const debug1 = await apiCall(app1, 'debug', { probe: true })
    eq(debug1.body.ok, true)
    eq(debug1.body.value.cache.hits, 0)
    eq(debug1.body.value.cache.reReads, 2)
    const probe = debug1.body.value.probe
    eq(probe.available, true)
    eq(probe.list.count, 2)
    eq(probe.list.withEventCount, 0, 'listing omits eventCount')
    eq(probe.list.withPositiveSizeBytes, 2)
    eq(probe.list.sample.eventCount, 'absent')
    assert.ok(String(probe.list.sample.sizeBytes).startsWith('number:'), 'sizeBytes present: ' + probe.list.sample.sizeBytes)
    assert.ok(probe.stat && String(probe.stat.sizeBytes).startsWith('number:'), 'stat carries sizeBytes')
  } finally {
    await app1.dispose()
  }

  const index = await store.readIndex()
  eq(index.sessions['warm-a'].sizeBytes, 5000, 'listing sizeBytes is persisted')
  eq('revision' in index.sessions['warm-a'], false, 'revision is not persisted')
  assert.ok(index.sessions['warm-a'].records.length > 0, 'records persisted')

  const app2 = await http.createApp({ ctx, version: 'selftest-warm-size', log: () => {} })
  try {
    await waitIdle(app2)
    eq(state.reads, 2, 'warm start must not re-read unchanged sessions')
    const debug2 = await apiCall(app2, 'debug', {})
    eq(debug2.body.value.cache.hits, 2)
    eq(debug2.body.value.cache.reReads, 0)
    eq(debug2.body.value.cache.listWithPositiveSize, 2)
    const status2 = await apiCall(app2, 'status')
    eq(status2.body.value.records, 2)
    assert.ok(status2.body.value.lastScanMs < 5000, 'warm scan is fast: ' + status2.body.value.lastScanMs)
  } finally {
    await app2.dispose()
  }

  // A changed session (sizeBytes differs) is the only one re-read.
  state.sizes['warm-a'] = 7777
  const app3 = await http.createApp({ ctx, version: 'selftest-warm-size', log: () => {} })
  try {
    await waitIdle(app3)
    eq(state.reads, 3, 'only the changed session is re-read')
    const debug3 = await apiCall(app3, 'debug', {})
    eq(debug3.body.value.cache.hits, 1)
    eq(debug3.body.value.cache.misses, 1)
    eq(debug3.body.value.cache.reReads, 1)
  } finally {
    await app3.dispose()
  }
})

await test('warm start falls back to one stat() when the listing omits sizeBytes', async () => {
  await dropIndexCache()
  const state = warmState()
  state.listFields = 'count' // eventCount only, no sizeBytes
  state.statFields = 'both'
  const ctx = warmCtx(state)
  const app1 = await http.createApp({ ctx, version: 'selftest-warm-stat', log: () => {} })
  try {
    await waitIdle(app1)
    eq(state.reads, 2)
  } finally {
    await app1.dispose()
  }
  const index = await store.readIndex()
  eq(index.sessions['warm-a'].sizeBytes, 5000, 'per-read stat() filled the cache key')
  eq(index.sessions['warm-a'].eventCount, 2)
  eq('revision' in index.sessions['warm-a'], false)

  const app2 = await http.createApp({ ctx, version: 'selftest-warm-stat', log: () => {} })
  try {
    await waitIdle(app2)
    eq(state.reads, 2, 'stat fallback validated without re-reading the log')
    const debug2 = await apiCall(app2, 'debug', {})
    eq(debug2.body.value.cache.unvalidated, 2)
    eq(debug2.body.value.cache.statHits, 2)
    eq(debug2.body.value.cache.hits, 2)
    eq(debug2.body.value.cache.reReads, 0)
  } finally {
    await app2.dispose()
  }
})

await test('warm start re-reads when no validation key exists at all', async () => {
  await dropIndexCache()
  const state = warmState()
  state.listFields = 'none'
  state.statFields = 'none'
  const ctx = warmCtx(state)
  const app1 = await http.createApp({ ctx, version: 'selftest-warm-none', log: () => {} })
  try {
    await waitIdle(app1)
    eq(state.reads, 2)
  } finally {
    await app1.dispose()
  }
  const index = await store.readIndex()
  eq(index.sessions['warm-a'].sizeBytes, 0, 'no key available -> stays unknown')
  const app2 = await http.createApp({ ctx, version: 'selftest-warm-none', log: () => {} })
  try {
    await waitIdle(app2)
    eq(state.reads, 4, 'without any key the session must be re-read (never a false hit)')
    const debug2 = await apiCall(app2, 'debug', {})
    eq(debug2.body.value.cache.statUnavailable, 2)
    eq(debug2.body.value.cache.reReads, 2)
  } finally {
    await app2.dispose()
  }
})

// ---------------------------------------------------------------------------
// Balance endpoint + token_stats tool (lib/http.js)
// ---------------------------------------------------------------------------

section('balance endpoint and token_stats agent tool')

await test('toolRange presets and YYYY-MM-DD overrides', () => {
  const config = freshConfig()
  const now = SH(2025, 1, 15, 12, 0) // Wednesday noon in the statistics timezone
  const today = SH(2025, 1, 15, 0, 0)
  eq(http.toolRange({ range: 'today' }, config, now), {
    from: today,
    to: SH(2025, 1, 16, 0, 0),
    offsetMs: 480 * 60000,
    range: 'today',
  })
  eq(http.toolRange({ range: 'yesterday' }, config, now).from, SH(2025, 1, 14, 0, 0))
  eq(http.toolRange({ range: 'yesterday' }, config, now).to, today)
  eq(http.toolRange({ range: 'last7' }, config, now).from, SH(2025, 1, 9, 0, 0))
  eq(http.toolRange({ range: 'last7' }, config, now).to, SH(2025, 1, 16, 0, 0))
  eq(http.toolRange({ range: 'last30' }, config, now).from, SH(2024, 12, 17, 0, 0))
  eq(http.toolRange({ range: 'thisMonth' }, config, now).from, SH(2025, 1, 1, 0, 0))
  eq(http.toolRange({ range: 'lastMonth' }, config, now).from, SH(2024, 12, 1, 0, 0))
  eq(http.toolRange({ range: 'lastMonth' }, config, now).to, SH(2025, 1, 1, 0, 0))
  eq(http.toolRange({}, config, now).range, 'last7', 'default range')
  // Explicit days are inclusive on both ends.
  eq(http.toolRange({ range: 'last7', from: '2025-01-03', to: '2025-01-05' }, config, now), {
    from: SH(2025, 1, 3, 0, 0),
    to: SH(2025, 1, 6, 0, 0),
    offsetMs: 480 * 60000,
    range: 'last7',
  })
  eq(http.toolRange({ from: 'bad' }, config, now).error.startsWith('invalid from'), true)
  eq(http.toolRange({ to: '2025-02-30' }, config, now).error.startsWith('invalid to'), true)
  eq(http.toolRange({ from: '2025-01-05', to: '2025-01-03' }, config, now).error, 'to must be after from')
  // The timezone offset comes from config.
  const utc = freshConfig({ timezoneOffsetMinutes: 0 })
  eq(http.toolRange({ range: 'today' }, utc, T(2025, 1, 15, 12, 0)).from, T(2025, 1, 15, 0, 0))
})

function balanceCtx(accountRef) {
  return {
    get(name) {
      if (name === 'deepseekAccount') return accountRef.value
      return undefined
    },
    on() {
      return () => {}
    },
  }
}

await test('balance endpoint: unavailable, signed-out, ready, null, failed, throwing, empty', async () => {
  async function balanceValue(account, version, calls) {
    const ref = { value: account }
    const app = await http.createApp({ ctx: balanceCtx(ref), version, log: () => {} })
    try {
      let value = null
      for (let i = 0; i < (calls || 1); i += 1) value = (await apiCall(app, 'balance')).body.value
      return { value, ref, app }
    } catch (error) {
      await app.dispose()
      throw error
    }
  }
  async function run(account, version, calls) {
    const { value, app } = await balanceValue(account, version, calls)
    try {
      return value
    } finally {
      await app.dispose()
    }
  }

  eq(await run(undefined, 'selftest-balance-a'), { available: false, reason: 'service-unavailable' })
  eq(
    await run(
      {
        async getState() {
          return { status: 'signed-out' }
        },
        async getBalance() {
          throw new Error('must not be called when signed out')
        },
      },
      'selftest-balance-b',
    ),
    { available: false, reason: 'signed-out' },
  )
  eq(
    await run(
      {
        async getState() {
          return { status: 'credential-stored' }
        },
        async getBalance() {
          return null
        },
      },
      'selftest-balance-c',
    ),
    { available: false, reason: 'signed-out' },
  )
  eq(
    await run(
      {
        async getState() {
          return { status: 'credential-stored' }
        },
        async getBalance() {
          return { status: 'failed' }
        },
      },
      'selftest-balance-d',
    ),
    { available: false, reason: 'query-failed' },
  )
  eq(
    await run(
      {
        async getState() {
          return { status: 'credential-stored' }
        },
        async getBalance() {
          throw new Error('platform down')
        },
      },
      'selftest-balance-e',
    ),
    { available: false, reason: 'error' },
  )
  eq(
    await run(
      {
        async getState() {
          return { status: 'credential-stored' }
        },
        async getBalance() {
          return { status: 'ready', value: [], bonusWallets: [] }
        },
      },
      'selftest-balance-f',
    ),
    { available: false, reason: 'no-wallets' },
  )

  // Ready result + success cache: two calls -> one Platform query.
  let balanceCalls = 0
  const readyAccount = {
    async getState() {
      return { status: 'credential-stored' }
    },
    async getBalance(client) {
      balanceCalls += 1
      eq(client, { version: 'dshtoken/1.0.0', locale: 'zh', timezoneOffsetSeconds: 28800 })
      return {
        status: 'ready',
        value: [
          { currency: 'CNY', balance: '12.34' },
          { currency: 'USD', balance: '1.00' },
        ],
        bonusWallets: [{ currency: 'CNY', balance: '5.00' }],
      }
    },
  }
  const { value, ref, app } = await balanceValue(readyAccount, 'selftest-balance-g', 2)
  try {
    eq(value, {
      available: true,
      wallets: [
        { currency: 'CNY', balance: '12.34' },
        { currency: 'USD', balance: '1.00' },
      ],
      bonusWallets: [{ currency: 'CNY', balance: '5.00' }],
    })
    eq(balanceCalls, 1, 'successful balance is cached for 60s')
    // A failure inside the success TTL still answers from cache.
    ref.value = {
      async getState() {
        return { status: 'credential-stored' }
      },
      async getBalance() {
        return { status: 'failed' }
      },
    }
    eq((await apiCall(app, 'balance')).body.value.available, true)
  } finally {
    await app.dispose()
  }
})

await test('token_stats tool registers, executes, renders and disposes', async () => {
  await dropIndexCache()
  const state = warmState()
  state.listFields = 'size'
  const captured = { definition: null, registerCalls: 0 }
  const baseCtx = warmCtx(state)
  const tools = {
    register(definition) {
      captured.registerCalls += 1
      captured.definition = definition
      return () => {
        if (captured.definition === definition) captured.definition = null
      }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'tools') return tools
      return baseCtx.get(name)
    },
    on: baseCtx.on,
  }
  const app = await http.createApp({ ctx, version: 'selftest-tool', log: () => {} })
  try {
    await waitIdle(app)
    eq(captured.registerCalls, 1)
    assert.ok(captured.definition, 'tool definition captured')
    eq(captured.definition.name, 'token_stats')
    eq(captured.definition.parameters.type, 'object')
    eq(captured.definition.parameters.additionalProperties, false)
    eq(captured.definition.parameters.properties.range.enum.length, 7)
    eq(typeof captured.definition.execute, 'function')
    eq(typeof captured.definition.output.render, 'function')

    // Range "all" uses the index time bounds; both fake sessions have usage.
    const all = await captured.definition.execute({ range: 'all' }, {})
    eq(all.ok, true)
    eq(all.range, 'all')
    eq(all.totals.tokens, 2200)
    eq(all.totals.requests, 2)
    eq(all.groupBy, 'category')
    eq(all.metric, 'tokens')
    assert.ok(Array.isArray(all.dims) && all.dims.length >= 1)
    assert.ok(Array.isArray(all.buckets) && all.buckets.length >= 1)
    assert.ok(all.buckets.length <= 62)

    const explicit = await captured.definition.execute(
      { from: '2025-01-06', to: '2025-01-06', groupBy: 'provider', metric: 'cost' },
      {},
    )
    eq(explicit.ok, true)
    eq(explicit.groupBy, 'provider')
    eq(explicit.metric, 'cost')
    eq(explicit.totals.tokens, 2200)
    assert.ok(explicit.dims.some((dim) => dim.key === 'deepseek-official'))

    // Model filter narrows the result.
    const filtered = await captured.definition.execute({ range: 'all', models: ['deepseek-official/deepseek-flash'] }, {})
    eq(filtered.ok, true)
    eq(filtered.totals.tokens, 1100)

    // Invalid arguments never throw.
    eq((await captured.definition.execute({ from: 'nope' }, {})).ok, false)
    eq((await captured.definition.execute(null, {})).ok, false)

    const rendered = captured.definition.output.render({}, all)
    eq(Array.isArray(rendered), true)
    eq(rendered[0].type, 'text')
    assert.ok(rendered[0].text.includes('Totals:'), rendered[0].text)
    assert.ok(rendered[0].text.includes('By category:'), rendered[0].text)
    const errRendered = captured.definition.output.render({}, { ok: false, error: 'index-unavailable' })
    assert.ok(errRendered[0].text.includes('index-unavailable'))
  } finally {
    await app.dispose()
  }
  eq(captured.definition, null, 'tool disposer unregisters token_stats')
})

await test('token_stats returns index-unavailable without an index', async () => {
  await dropIndexCache()
  const captured = { definition: null }
  const tools = {
    register(definition) {
      captured.definition = definition
      return () => {
        captured.definition = null
      }
    },
  }
  const ctx = {
    get(name) {
      return name === 'tools' ? tools : undefined
    },
    on() {
      return () => {}
    },
  }
  const app = await http.createApp({ ctx, version: 'selftest-tool-empty', log: () => {} })
  try {
    await waitIdle(app)
    const value = await captured.definition.execute({ range: 'today' }, {})
    eq(value, { ok: false, error: 'index-unavailable' })
  } finally {
    await app.dispose()
  }
})

await test('bucketSessions HTTP endpoint: exact shape, titles, empty range, limit', async () => {
  await dropIndexCache()
  const state = warmState()
  state.listFields = 'size'
  const ctx = warmCtx(state)
  const app = await http.createApp({ ctx, version: 'selftest-bucket-sessions', log: () => {} })
  try {
    await waitIdle(app)
    const from = WARM_TIME - 1000
    const to = WARM_TIME + 1000
    const res = await apiCall(app, 'bucketSessions', { from, to, metric: 'tokens' })
    eq(res.status, 200)
    eq(res.body.ok, true)
    const value = res.body.value
    eq(Object.keys(value).sort(), [
      'currency',
      'from',
      'metric',
      'notes',
      'sessionCount',
      'sessions',
      'to',
      'total',
      'truncated',
    ])
    eq(value.from, from)
    eq(value.to, to)
    eq(value.metric, 'tokens')
    eq(value.currency, 'CNY')
    eq(value.total.tokens, 2200)
    eq(value.total.requests, 2)
    eq(value.sessionCount, 2)
    eq(value.truncated, false)
    eq(
      value.sessions.map((row) => row.key),
      ['warm-a', 'warm-b'],
      'equal tokens -> requests desc -> key asc',
    )
    eq(
      value.sessions.map((row) => row.title),
      ['Warm warm-a', 'Warm warm-b'],
      'best-effort titles filled',
    )
    eq(
      value.sessions.map((row) => row.label),
      ['warm-a', 'warm-b'],
      'label is the cwd basename',
    )
    for (const row of value.sessions) {
      eq(Object.keys(row).sort(), [
        'cost',
        'hit',
        'key',
        'label',
        'miss',
        'out',
        'reasoning',
        'requests',
        'title',
        'tokens',
        'write',
      ])
      eq(row.tokens, 1100)
      eq(row.miss, 1000)
      eq(row.hit, 0)
      eq(row.write, 0)
      eq(row.out, 100)
      eq(row.reasoning, 0)
      eq(row.requests, 1)
      eq(typeof row.cost, 'number')
    }
    eq(value.notes.timezoneOffsetMinutes, 480)
    eq(value.notes.partial, false)
    assert.ok(Array.isArray(value.notes.unpricedModels))

    // Empty range: valid body, zero Part, no rows.
    const empty = await apiCall(app, 'bucketSessions', {
      from: WARM_TIME + DAY,
      to: WARM_TIME + 2 * DAY,
      metric: 'cost',
    })
    eq(empty.body.ok, true)
    eq(empty.body.value.sessions, [])
    eq(empty.body.value.sessionCount, 0)
    eq(empty.body.value.truncated, false)
    eq(empty.body.value.total.tokens, 0)

    // limit/truncated over the wire.
    const limited = await apiCall(app, 'bucketSessions', { from, to, limit: 1 })
    eq(limited.body.value.sessions.length, 1)
    eq(limited.body.value.truncated, true)
    eq(limited.body.value.sessionCount, 2)

    // Invalid body -> bad-request envelope.
    const bad = await apiCall(app, 'bucketSessions', { to })
    eq(bad.body.ok, false)
    eq(bad.body.error.code, 'bad-request')
  } finally {
    await app.dispose()
  }
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

// Best-effort cleanup: a just-disposed indexer may still be finishing its last
// index write on Windows, so retry instead of failing the test run.
try {
  await rm(process.env.DSH_HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
} catch (error) {
  console.warn('[selftest] temp cleanup skipped: ' + String((error && error.message) || error))
}

if (failures.length === 0) {
  console.log('[selftest] PASS - ' + passed + ' checks passed')
  process.exit(0)
} else {
  console.error('[selftest] FAIL - ' + passed + ' passed, ' + failures.length + ' failed')
  for (const failure of failures) {
    console.error('  - ' + failure.name)
    console.error(String((failure.error && failure.error.stack) || failure.error))
  }
  process.exit(1)
}




