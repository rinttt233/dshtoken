// Pure aggregation over the in-memory index snapshot.
//
// Receives the cost module as a parameter so sibling lib modules stay free of
// relative imports (http.js loads each one with a cache-busting query).
//
// Everything here is synchronous and single-pass over the records that fall in
// the requested range: stats requests never re-read session logs.

const DAY_MS = 86400000
const HOUR_MS = 3600000
const MINUTE_MS = 60000
const PER_MILLION = 1e6

const MAX_BUCKETS = 1000
const AUTO_HOUR_MAX_DAYS = 2
const AUTO_DAY_MAX_DAYS = 62
const AUTO_WEEK_MAX_DAYS = 400

const CATEGORY_KEYS = ['hit', 'miss', 'write', 'out']
const BUCKET_VALUES = ['auto', 'hour', 'day', 'week', 'month']
const GROUP_VALUES = ['category', 'provider', 'model', 'session']
const METRIC_VALUES = ['tokens', 'cost']

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function str(value) {
  return typeof value === 'string' ? value : ''
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function zero() {
  return { tokens: 0, cost: 0, miss: 0, hit: 0, write: 0, out: 0, reasoning: 0, requests: 0 }
}

function fail(code, details) {
  const error = new Error(details || code)
  error.code = code
  return error
}

function mod(value, base) {
  return ((value % base) + base) % base
}

function baseName(path) {
  const text = str(path).replace(/[\\/]+$/, '')
  const index = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  return index >= 0 ? text.slice(index + 1) : text
}

function stringList(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw fail('bad-request', field + ' must be an array of strings')
  const seen = new Set()
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') throw fail('bad-request', field + ' entries must be strings')
    const text = item.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/** Validate + normalize a `stats` request body into a stable query object. */
export function normalizedQuery(body, config) {
  const src = isPlainObject(body) ? body : {}
  const from = Number(src.from)
  const to = Number(src.to)
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw fail('bad-request', 'from and to are required epoch-millisecond numbers')
  }
  if (to <= from) throw fail('bad-request', 'to must be greater than from')
  const bucket = src.bucket === undefined || src.bucket === null || src.bucket === '' ? 'auto' : src.bucket
  if (!BUCKET_VALUES.includes(bucket)) throw fail('bad-request', 'bucket must be auto|hour|day|week|month')
  const groupBy = src.groupBy === undefined || src.groupBy === null || src.groupBy === '' ? 'category' : src.groupBy
  if (!GROUP_VALUES.includes(groupBy)) {
    throw fail('bad-request', 'groupBy must be category|provider|model|session')
  }
  const metric = src.metric === undefined || src.metric === null || src.metric === '' ? 'tokens' : src.metric
  if (!METRIC_VALUES.includes(metric)) throw fail('bad-request', 'metric must be tokens|cost')
  return {
    from,
    to,
    bucket,
    groupBy,
    metric,
    models: stringList(src.models, 'models'),
    providers: stringList(src.providers, 'providers'),
    cwds: stringList(src.cwds, 'cwds'),
    includeSubagents: src.includeSubagents === undefined ? true : !!src.includeSubagents,
  }
}

function autoBucket(spanMs) {
  if (spanMs <= AUTO_HOUR_MAX_DAYS * DAY_MS) return 'hour'
  if (spanMs <= AUTO_DAY_MAX_DAYS * DAY_MS) return 'day'
  if (spanMs <= AUTO_WEEK_MAX_DAYS * DAY_MS) return 'week'
  return 'month'
}

function alignedStart(bucket, t, offsetMs) {
  if (bucket === 'hour') return Math.floor((t + offsetMs) / HOUR_MS) * HOUR_MS - offsetMs
  if (bucket === 'day') return Math.floor((t + offsetMs) / DAY_MS) * DAY_MS - offsetMs
  if (bucket === 'week') {
    // Local day numbers; Monday-start: epoch day 0 (1970-01-01) was a Thursday.
    const day = Math.floor((t + offsetMs) / DAY_MS)
    return (day - mod(day + 3, 7)) * DAY_MS - offsetMs
  }
  const wall = new Date(t + offsetMs)
  return Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), 1) - offsetMs
}

function nextBoundary(bucket, t0, offsetMs) {
  if (bucket === 'hour') return t0 + HOUR_MS
  if (bucket === 'day') return t0 + DAY_MS
  if (bucket === 'week') return t0 + 7 * DAY_MS
  const wall = new Date(t0 + offsetMs)
  return Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 1) - offsetMs
}

/**
 * Effective granularity plus contiguous, clipped bucket edges covering
 * [query.from, query.to). Throws code 'too-many-buckets' above 1000 buckets.
 */
function bucketPlan(query, config) {
  const offsetMs = num(config.timezoneOffsetMinutes) * MINUTE_MS
  const bucket = query.bucket === 'auto' ? autoBucket(query.to - query.from) : query.bucket
  const buckets = []
  let cursor = alignedStart(bucket, query.from, offsetMs)
  while (cursor < query.to) {
    const next = nextBoundary(bucket, cursor, offsetMs)
    if (!(next > cursor)) break
    const t0 = Math.max(cursor, query.from)
    const t1 = Math.min(next, query.to)
    if (t1 > t0) {
      buckets.push({ t0, t1 })
      if (buckets.length > MAX_BUCKETS) {
        throw fail('too-many-buckets', 'the selected range needs more than ' + MAX_BUCKETS + ' buckets')
      }
    }
    cursor = next
  }
  return { bucket, buckets }
}

function isSubagent(entry) {
  if (!entry) return false
  if (entry.origin === 'subagent') return true
  return num(entry.delegationDepth) > 0
}

const MAX_OWNER_HOPS = 64

/**
 * Resolve one session's merge owner: the nearest ancestor via `parentSession`
 * whose entry is not a subagent. Ordinary forks (parentSession set but neither
 * `origin: 'subagent'` nor a positive delegationDepth) are NOT subagents and
 * therefore stay their own owner. The walk is cycle-safe (visited set, hop cap)
 * and falls back to the session's own id when no non-subagent ancestor is
 * reachable, so records can never be lost.
 */
function resolveOwnerId(id, sessions, cache) {
  const hit = cache.get(id)
  if (hit !== undefined) return hit
  const entry = sessions[id]
  if (!isSubagent(entry)) {
    cache.set(id, id)
    return id
  }
  const path = [id]
  const visited = new Set(path)
  let cursor = id
  let owner = null
  for (let hop = 0; hop < MAX_OWNER_HOPS; hop += 1) {
    const current = sessions[cursor]
    const parent = current && current.parentSession != null ? String(current.parentSession) : ''
    if (!parent || visited.has(parent)) break
    const parentEntry = sessions[parent]
    if (!parentEntry) break
    if (!isSubagent(parentEntry)) {
      owner = parent
      path.push(parent)
      break
    }
    visited.add(parent)
    path.push(parent)
    cursor = parent
  }
  if (owner === null) {
    // Unresolvable (cycle, missing parent, hop cap): stay its own owner. Do NOT
    // cache the intermediate path under the fallback, those sessions may still
    // resolve to a real ancestor when visited on their own.
    cache.set(id, id)
    return id
  }
  for (const visitedId of path) cache.set(visitedId, owner)
  return owner
}

function findBucket(buckets, t) {
  let low = 0
  let high = buckets.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const bucket = buckets[mid]
    if (t < bucket.t0) high = mid - 1
    else if (t >= bucket.t1) low = mid + 1
    else return mid
  }
  return -1
}

function bump(part, tokens, cost, miss, hit, write, out, reasoning) {
  part.tokens += tokens
  part.cost += cost
  part.miss += miss
  part.hit += hit
  part.write += write
  part.out += out
  part.reasoning += reasoning
  part.requests += 1
}

function addInto(target, source) {
  target.tokens += source.tokens
  target.cost += source.cost
  target.miss += source.miss
  target.hit += source.hit
  target.write += source.write
  target.out += source.out
  target.reasoning += source.reasoning
  target.requests += source.requests
  return target
}

function hasValue(part) {
  return part.tokens > 0 || part.cost > 0
}

function getPart(map, key) {
  let part = map.get(key)
  if (!part) {
    part = zero()
    map.set(key, part)
  }
  return part
}

function dimLabel(groupBy, key, sessions) {
  if (groupBy !== 'session') return key
  const entry = sessions[key]
  const name = baseName(entry && entry.cwd)
  return name || key
}

/** `stats` value: buckets + stacked dims + totals/summary/notes. */
export function aggregate(snapshot, config, query, cost) {
  const plan = bucketPlan(query, config)
  const from = query.from
  const to = query.to
  const tz = num(config.timezoneOffsetMinutes)
  const offsetMs = tz * MINUTE_MS
  const sessions = snapshot && isPlainObject(snapshot.sessions) ? snapshot.sessions : {}

  const buckets = plan.buckets.map((edge) => ({ t0: edge.t0, t1: edge.t1, total: zero(), byDim: {} }))
  const bucketMaps = buckets.map(() => new Map())
  const totals = zero()
  const sessionSet = new Set()
  const unpricedModels = new Map()
  let unpricedTokens = 0

  // Per-minute peak memo: peak boundaries are minute-granular, so this keeps
  // one isPeak() call per local minute instead of one per record.
  const peakCache = new Map()
  const priceCache = new Map()
  const isPeakAt = (t) => {
    const key = Math.floor((t + offsetMs) / MINUTE_MS)
    let value = peakCache.get(key)
    if (value === undefined) {
      value = cost.isPeak(t, config)
      peakCache.set(key, value)
    }
    return value
  }
  const priceAt = (provider, model) => {
    const key = provider + '\u0000' + model
    let price = priceCache.get(key)
    if (price === undefined) {
      price = cost.resolvePrice(config, provider, model)
      priceCache.set(key, price)
    }
    return price
  }
  // When subagents are not listed, their consumption is folded into the nearest
  // non-subagent ancestor instead of being dropped, so totals stay identical
  // between the two modes and only the session rows change.
  const ownerCache = new Map()
  const mergedSubagentIds = new Set()

  for (const id of Object.keys(sessions)) {
    const entry = sessions[id]
    if (!entry || !Array.isArray(entry.records) || entry.records.length === 0) continue
    const cwd = str(entry.cwd)
    if (query.cwds.length && !query.cwds.includes(cwd)) continue
    const sessionId = str(entry.id) || id
    const subagent = isSubagent(entry)
    const groupKey =
      subagent && !query.includeSubagents ? resolveOwnerId(sessionId, sessions, ownerCache) : sessionId
    const records = entry.records
    let countedSubagent = false
    for (let i = 0; i < records.length; i++) {
      const record = records[i]
      if (!Array.isArray(record)) continue
      const t = num(record[0])
      if (!(t >= from && t < to)) continue
      const provider = str(record[1])
      const model = str(record[2])
      if (query.providers.length && !query.providers.includes(provider)) continue
      const modelKey = provider + '/' + model
      if (query.models.length && !query.models.includes(modelKey)) continue

      const input = num(record[3])
      const hit = num(record[4])
      const write = num(record[5])
      const output = num(record[6])
      const reasoning = num(record[7])
      // In this DSH build the logged inputTokens is already the uncached
      // prompt input, so it is the billed miss amount (see lib/cost.js).
      const miss = input
      const tokens = miss + hit + write + output

      const price = priceAt(provider, model)
      let missCost = 0
      let hitCost = 0
      let writeCost = 0
      let outCost = 0
      if (price) {
        const peak = isPeakAt(t)
          ? Number.isFinite(Number(price.peakMultiplier))
            ? Number(price.peakMultiplier)
            : 2
          : 1
        missCost = ((miss * num(price.miss)) / PER_MILLION) * peak
        hitCost = ((hit * num(price.hit)) / PER_MILLION) * peak
        writeCost = ((write * num(price.write)) / PER_MILLION) * peak
        outCost = ((output * num(price.out)) / PER_MILLION) * peak
      } else {
        unpricedTokens += tokens
        unpricedModels.set(modelKey, (unpricedModels.get(modelKey) || 0) + tokens)
      }
      const recordCost = missCost + hitCost + writeCost + outCost

      sessionSet.add(groupKey)
      const index = findBucket(buckets, t)
      if (index < 0) continue
      countedSubagent = true
      const bucket = buckets[index]
      bump(bucket.total, tokens, recordCost, miss, hit, write, output, reasoning)
      bump(totals, tokens, recordCost, miss, hit, write, output, reasoning)

      if (query.groupBy === 'category') {
        const map = bucketMaps[index]
        if (miss > 0) {
          const part = getPart(map, 'miss')
          bump(part, miss, missCost, miss, 0, 0, 0, 0)
        }
        if (hit > 0) {
          const part = getPart(map, 'hit')
          bump(part, hit, hitCost, 0, hit, 0, 0, 0)
        }
        if (write > 0) {
          const part = getPart(map, 'write')
          bump(part, write, writeCost, 0, 0, write, 0, 0)
        }
        if (output > 0) {
          const part = getPart(map, 'out')
          bump(part, output, outCost, 0, 0, 0, output, reasoning)
        }
      } else {
        const key =
          query.groupBy === 'provider'
            ? provider
            : query.groupBy === 'model'
              ? modelKey
              : query.includeSubagents
                ? sessionId
                : groupKey
        const part = getPart(bucketMaps[index], key)
        bump(part, tokens, recordCost, miss, hit, write, output, reasoning)
      }
    }
    // Count a merged subagent session once, and only when it had at least one
    // record inside the range that passed the cwd/model/provider filters.
    if (!query.includeSubagents && groupKey !== sessionId && countedSubagent) {
      mergedSubagentIds.add(sessionId)
    }
  }

  let dims
  if (query.groupBy === 'category') {
    dims = CATEGORY_KEYS.map((key) => ({ key, label: key, kind: 'category' }))
    for (let i = 0; i < buckets.length; i++) {
      const map = bucketMaps[i]
      const byDim = {}
      for (const key of CATEGORY_KEYS) {
        const part = map.get(key)
        if (part && hasValue(part)) byDim[key] = part
      }
      buckets[i].byDim = byDim
    }
  } else {
    const limit = query.groupBy === 'session' ? 12 : 20
    const dimTotals = new Map()
    for (const map of bucketMaps) {
      for (const [key, part] of map) {
        let total = dimTotals.get(key)
        if (!total) {
          total = zero()
          dimTotals.set(key, total)
        }
        addInto(total, part)
      }
    }
    const metricOf = (part) => (query.metric === 'cost' ? part.cost : part.tokens)
    const ranked = [...dimTotals.entries()].sort((a, b) => {
      const delta = metricOf(b[1]) - metricOf(a[1])
      if (delta !== 0) return delta
      const tokenDelta = b[1].tokens - a[1].tokens
      if (tokenDelta !== 0) return tokenDelta
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
    })
    const top = ranked.slice(0, limit)
    const topSet = new Set(top.map((entry) => entry[0]))
    dims = top.map(([key]) => ({ key, label: dimLabel(query.groupBy, key, sessions), kind: query.groupBy }))
    if (ranked.length > limit) dims.push({ key: '__other', label: 'other', kind: query.groupBy })
    for (let i = 0; i < buckets.length; i++) {
      const map = bucketMaps[i]
      const byDim = {}
      let other = null
      for (const [key, part] of map) {
        if (!hasValue(part)) continue
        if (topSet.has(key)) byDim[key] = part
        else {
          if (!other) other = zero()
          addInto(other, part)
        }
      }
      if (other) byDim.__other = other
      buckets[i].byDim = byDim
    }
  }

  let peakBucket = null
  for (const bucket of buckets) {
    if (!peakBucket || bucket.total.tokens > peakBucket.tokens) {
      peakBucket = { t0: bucket.t0, tokens: bucket.total.tokens, cost: bucket.total.cost }
    }
  }
  if (peakBucket && peakBucket.tokens === 0 && peakBucket.cost === 0) peakBucket = null

  const hitDenominator = totals.hit + totals.miss
  const cacheHitRate = hitDenominator > 0 ? totals.hit / hitDenominator : 0
  const days = Math.max(1, Math.ceil((to - from) / DAY_MS))
  const unpricedList = [...unpricedModels.entries()]
    .map(([key, tokens]) => ({ key, tokens }))
    .filter((entry) => entry.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)

  return {
    from,
    to,
    bucket: plan.bucket,
    groupBy: query.groupBy,
    metric: query.metric,
    timezoneOffsetMinutes: tz,
    currency: str(config.currency) || 'CNY',
    buckets,
    dims,
    totals,
    summary: {
      totalTokens: totals.tokens,
      totalCost: totals.cost,
      pricedTokens: Math.max(0, totals.tokens - unpricedTokens),
      unpricedTokens,
      cacheHitRate,
      requests: totals.requests,
      sessions: sessionSet.size,
      days,
      avgPerDayTokens: days > 0 ? totals.tokens / days : 0,
      peakBucket,
    },
    notes: {
      partial: false,
      indexProgress: { scanned: 0, total: 0, running: false },
      unpricedModels: unpricedList,
      subagentsMerged: mergedSubagentIds.size,
      filters: {
        models: query.models.slice(),
        providers: query.providers.slice(),
        includeSubagents: query.includeSubagents,
        cwds: query.cwds.slice(),
      },
    },
    generatedAt: Date.now(),
  }
}

/**
 * Per-session breakdown for one bucket/range (chart session hover).
 *
 * Pure: one pass over the indexed records in [query.from, query.to), applying
 * exactly the same filters and cost/peak semantics as `aggregate`. Sessions are
 * kept as real ids (never merged into `__other`); `limit` only truncates the
 * returned rows while `total`/`sessionCount` still describe the whole range.
 */
export function sessionBreakdown(snapshot, config, query, cost, limit) {
  const sessions = snapshot && isPlainObject(snapshot.sessions) ? snapshot.sessions : {}
  const rows = new Map()
  const total = zero()
  const unpricedModels = new Map()
  const ownerCache = new Map()
  const mergedSubagentIds = new Set()
  let sessionCount = 0
  const rawLimit = limit === undefined || limit === null ? 60 : Number(limit)
  const maxRows = Math.min(200, Math.max(1, Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 60))

  for (const id of Object.keys(sessions)) {
    const entry = sessions[id]
    if (!entry || !Array.isArray(entry.records) || entry.records.length === 0) continue
    const cwd = str(entry.cwd)
    if (query.cwds.length && !query.cwds.includes(cwd)) continue
    const sessionId = str(entry.id) || id
    const subagent = isSubagent(entry)
    const groupKey =
      subagent && !query.includeSubagents ? resolveOwnerId(sessionId, sessions, ownerCache) : sessionId
    // Owner rows are labelled/attributed with the owner entry's cwd.
    const ownerEntry = groupKey === sessionId ? entry : sessions[groupKey]
    const ownerCwd = groupKey === sessionId ? cwd : str(ownerEntry && ownerEntry.cwd) || cwd
    // Different entries can fold into the same owner row (owner + subagents),
    // so reuse the existing accumulator rather than replacing it.
    let row = rows.get(groupKey) || null
    let countedSubagent = false
    const records = entry.records
    for (let i = 0; i < records.length; i++) {
      const record = records[i]
      if (!Array.isArray(record)) continue
      const t = num(record[0])
      if (!(t >= query.from && t < query.to)) continue
      const provider = str(record[1])
      const model = str(record[2])
      if (query.providers.length && !query.providers.includes(provider)) continue
      const modelKey = provider + '/' + model
      if (query.models.length && !query.models.includes(modelKey)) continue
      if (!row) {
        row = {
          key: groupKey,
          cwd: ownerCwd,
          part: zero(),
        }
        rows.set(groupKey, row)
        sessionCount += 1
      }
      countedSubagent = true
      const part = cost.recordPart(record, config)
      cost.addPart(row.part, part)
      cost.addPart(total, part)
      if (!cost.resolvePrice(config, provider, model)) {
        unpricedModels.set(modelKey, (unpricedModels.get(modelKey) || 0) + part.tokens)
      }
    }
    if (!query.includeSubagents && groupKey !== sessionId && countedSubagent) {
      mergedSubagentIds.add(sessionId)
    }
  }

  const metric = query.metric
  const scored = [...rows.values()].sort((a, b) => {
    const delta = metric === 'cost' ? b.part.cost - a.part.cost : b.part.tokens - a.part.tokens
    if (delta !== 0) return delta
    const requestDelta = b.part.requests - a.part.requests
    if (requestDelta !== 0) return requestDelta
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })
  const truncated = scored.length > maxRows
  const sessionsOut = scored.slice(0, maxRows).map((row) => ({
    key: row.key,
    label: baseName(row.cwd) || row.key,
    title: '',
    tokens: row.part.tokens,
    cost: row.part.cost,
    requests: row.part.requests,
    miss: row.part.miss,
    hit: row.part.hit,
    write: row.part.write,
    out: row.part.out,
    reasoning: row.part.reasoning,
  }))
  const unpricedList = [...unpricedModels.entries()]
    .map(([key, tokens]) => ({ key, tokens }))
    .filter((entry) => entry.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)

  return {
    from: query.from,
    to: query.to,
    metric,
    currency: str(config.currency) || 'CNY',
    total,
    sessions: sessionsOut,
    sessionCount,
    truncated,
    notes: {
      partial: false,
      unpricedModels: unpricedList,
      subagentsMerged: mergedSubagentIds.size,
      timezoneOffsetMinutes: num(config.timezoneOffsetMinutes),
    },
  }
}

/** `meta` value: filter lists, range, session counts, config snapshot. */
export function meta(snapshot, config, cost) {
  const sessions = snapshot && isPlainObject(snapshot.sessions) ? snapshot.sessions : {}
  const providers = new Map()
  const models = new Map()
  const cwds = new Map()
  let indexed = 0
  let withUsage = 0
  let minTime = Infinity
  let maxTime = -Infinity

  for (const id of Object.keys(sessions)) {
    const entry = sessions[id]
    if (!entry) continue
    indexed += 1
    const records = Array.isArray(entry.records) ? entry.records : []
    if (records.length > 0) withUsage += 1
    const cwd = str(entry.cwd)
    for (const record of records) {
      if (!Array.isArray(record)) continue
      const t = num(record[0])
      const provider = str(record[1])
      const model = str(record[2])
      const input = num(record[3])
      const hit = num(record[4])
      const write = num(record[5])
      const output = num(record[6])
      const tokens = input + hit + write + output
      if (t < minTime) minTime = t
      if (t > maxTime) maxTime = t
      const price = cost.resolvePrice(config, provider, model)
      let providerRow = providers.get(provider)
      if (!providerRow) {
        providerRow = { key: provider, tokens: 0, requests: 0, priced: false }
        providers.set(provider, providerRow)
      }
      providerRow.tokens += tokens
      providerRow.requests += 1
      if (price) providerRow.priced = true
      const modelKey = provider + '/' + model
      let modelRow = models.get(modelKey)
      if (!modelRow) {
        modelRow = { key: modelKey, provider, model, tokens: 0, requests: 0, priced: false }
        models.set(modelKey, modelRow)
      }
      modelRow.tokens += tokens
      modelRow.requests += 1
      if (price) modelRow.priced = true
      if (cwd) {
        let cwdRow = cwds.get(cwd)
        if (!cwdRow) {
          cwdRow = { path: cwd, tokens: 0 }
          cwds.set(cwd, cwdRow)
        }
        cwdRow.tokens += tokens
      }
    }
  }

  const sorted = (map) =>
    [...map.values()].sort((a, b) => b.tokens - a.tokens || String(a.key).localeCompare(String(b.key)))

  return {
    generatedAt: num(snapshot && snapshot.generatedAt),
    timezoneOffsetMinutes: num(config.timezoneOffsetMinutes),
    currency: str(config.currency) || 'CNY',
    timeRange:
      Number.isFinite(minTime) && Number.isFinite(maxTime) && maxTime >= minTime
        ? { from: minTime, to: maxTime }
        : null,
    providers: sorted(providers).map(({ key, tokens, requests, priced }) => ({
      key,
      tokens,
      requests,
      priced,
    })),
    models: sorted(models).map(({ key, provider, model, tokens, requests, priced }) => ({
      key,
      provider,
      model,
      tokens,
      requests,
      priced,
    })),
    cwds: [...cwds.values()].sort((a, b) => b.tokens - a.tokens),
    sessions: { indexed, total: indexed, withUsage },
    config,
    defaults: cost.DEFAULT_CONFIG,
  }
}

/** `session` value for one session (title is filled in by http.js). */
export function sessionSummary(snapshot, config, cost, sessionId) {
  const sessions = snapshot && isPlainObject(snapshot.sessions) ? snapshot.sessions : {}
  const entry = sessions[sessionId]
  const value = {
    sessionId,
    found: false,
    title: '',
    cwd: '',
    tokens: zero(),
    cacheHitRate: 0,
    firstTime: 0,
    lastTime: 0,
    models: [],
    unpricedTokens: 0,
    global: { today: { tokens: 0, cost: 0 }, all: { tokens: 0, cost: 0 } },
  }
  if (!entry) return value

  value.found = true
  value.cwd = str(entry.cwd)
  const records = Array.isArray(entry.records) ? entry.records : []
  const models = new Map()
  let firstTime = Infinity
  let lastTime = 0
  for (const record of records) {
    if (!Array.isArray(record)) continue
    const part = cost.recordPart(record, config)
    cost.addPart(value.tokens, part)
    const t = num(record[0])
    if (t < firstTime) firstTime = t
    if (t > lastTime) lastTime = t
    const provider = str(record[1])
    const model = str(record[2])
    const key = provider + '/' + model
    let row = models.get(key)
    if (!row) {
      row = { key, tokens: 0, requests: 0, cost: 0 }
      models.set(key, row)
    }
    row.tokens += part.tokens
    row.requests += 1
    row.cost += part.cost
    if (!cost.resolvePrice(config, provider, model)) value.unpricedTokens += part.tokens
  }
  const denominator = value.tokens.hit + value.tokens.miss
  value.cacheHitRate = denominator > 0 ? value.tokens.hit / denominator : 0
  value.firstTime = firstTime === Infinity ? num(entry.createdAt) : firstTime
  value.lastTime = lastTime
  value.models = [...models.values()].sort((a, b) => b.tokens - a.tokens)

  // Global totals: "all" for every indexed session, "today" for the
  // statistics-timezone calendar day that contains Date.now(). Per-minute peak
  // and per-model price memos keep this cheap on the dock's poll path.
  const offsetMs = num(config.timezoneOffsetMinutes) * MINUTE_MS
  const todayStart = Math.floor((Date.now() + offsetMs) / DAY_MS) * DAY_MS - offsetMs
  const peakCache = new Map()
  const priceCache = new Map()
  const peakAt = (t) => {
    const key = Math.floor((t + offsetMs) / MINUTE_MS)
    let value = peakCache.get(key)
    if (value === undefined) {
      value = cost.isPeak(t, config)
      peakCache.set(key, value)
    }
    return value
  }
  const priceFor = (provider, model) => {
    const key = provider + '\u0000' + model
    let price = priceCache.get(key)
    if (price === undefined) {
      price = cost.resolvePrice(config, provider, model)
      priceCache.set(key, price)
    }
    return price
  }
  const totalsOf = (record) => {
    const t = num(record[0])
    const input = num(record[3])
    const hit = num(record[4])
    const write = num(record[5])
    const output = num(record[6])
    // inputTokens is uncached prompt input in this DSH build.
    const miss = input
    const tokens = miss + hit + write + output
    const price = priceFor(str(record[1]), str(record[2]))
    if (!price) return { t, tokens, cost: 0 }
    const peak = peakAt(t)
      ? Number.isFinite(Number(price.peakMultiplier))
        ? Number(price.peakMultiplier)
        : 2
      : 1
    const cost =
      ((miss * num(price.miss) +
        hit * num(price.hit) +
        write * num(price.write) +
        output * num(price.out)) /
        PER_MILLION) *
      peak
    return { t, tokens, cost }
  }
  let allTokens = 0
  let allCost = 0
  let todayTokens = 0
  let todayCost = 0
  for (const id of Object.keys(sessions)) {
    const other = sessions[id]
    if (!other || !Array.isArray(other.records)) continue
    for (const record of other.records) {
      if (!Array.isArray(record)) continue
      const part = totalsOf(record)
      allTokens += part.tokens
      allCost += part.cost
      if (part.t >= todayStart) {
        todayTokens += part.tokens
        todayCost += part.cost
      }
    }
  }
  value.global = {
    today: { tokens: todayTokens, cost: todayCost },
    all: { tokens: allTokens, cost: allCost },
  }
  return value
}
