// HTTP API entry for @local/dshtoken.
//
// The plugin shell (index.js) re-imports this file with a cache-busting query on
// every request when lib mtimes change, and this file imports its siblings the
// same way so they hot-reload too. Sibling modules never import each other; the
// store/cost/aggregate/scan modules are passed around as objects instead.
//
// createApp({ ctx, version, log }) -> { handle(req, res), dispose(), status() }

const MAX_BODY = 2 * 1024 * 1024 // 2 MiB
const API_PREFIX = '/dshtoken/api'
const TITLE_BATCH = 8
const TITLE_CACHE_LIMIT = 2000

const DAY_MS = 86400000
const TOOL_NAME = 'token_stats'
const TOOL_RANGES = ['today', 'yesterday', 'last7', 'last30', 'thisMonth', 'lastMonth', 'all']
const MAX_TOOL_BUCKETS = 62
const MAX_TOOL_DIMS = 12
const BALANCE_TIMEOUT_MS = 6000
const BALANCE_SUCCESS_TTL_MS = 60000
const BALANCE_FAILURE_TTL_MS = 10000
const BALANCE_CLIENT = { version: 'dshtoken/1.0.0', locale: 'zh', timezoneOffsetSeconds: 8 * 3600 }

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function str(value) {
  return typeof value === 'string' ? value : ''
}

function localDayStart(nowMs, offsetMs) {
  return Math.floor((nowMs + offsetMs) / DAY_MS) * DAY_MS - offsetMs
}

function localMonthStart(nowMs, offsetMs) {
  const wall = new Date(nowMs + offsetMs)
  return Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), 1) - offsetMs
}

function addMonths(monthStartMs, delta, offsetMs) {
  const wall = new Date(monthStartMs + offsetMs)
  return Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + delta, 1) - offsetMs
}

function parseLocalDate(text, offsetMs) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ''))
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const ms = Date.UTC(year, month - 1, day) - offsetMs
  const check = new Date(ms + offsetMs)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null
  }
  return ms
}

/**
 * Resolve the `token_stats` range presets and explicit YYYY-MM-DD overrides into
 * an epoch-ms [from, to) interval in the statistics timezone. Pure; exposed for
 * the self-test. `all` is resolved by the caller from the index time bounds.
 */
export function toolRange(args, config, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now()
  const offsetMs =
    (Number.isFinite(Number(config && config.timezoneOffsetMinutes))
      ? Number(config.timezoneOffsetMinutes)
      : 480) * 60000
  const dayStart = localDayStart(now, offsetMs)
  const range = typeof (args && args.range) === 'string' && TOOL_RANGES.includes(args.range) ? args.range : 'last7'
  let from
  let to
  switch (range) {
    case 'today':
      from = dayStart
      to = dayStart + DAY_MS
      break
    case 'yesterday':
      from = dayStart - DAY_MS
      to = dayStart
      break
    case 'last7':
      from = dayStart - 6 * DAY_MS
      to = dayStart + DAY_MS
      break
    case 'last30':
      from = dayStart - 29 * DAY_MS
      to = dayStart + DAY_MS
      break
    case 'thisMonth':
      from = localMonthStart(now, offsetMs)
      to = dayStart + DAY_MS
      break
    case 'lastMonth':
      to = localMonthStart(now, offsetMs)
      from = addMonths(to, -1, offsetMs)
      break
    case 'all':
      // Placeholder span; the caller replaces it with the index time bounds
      // when no explicit from/to override is supplied.
      from = dayStart - 29 * DAY_MS
      to = dayStart + DAY_MS
      break
    default:
      return { error: 'invalid range: ' + range }
  }
  const fromText = args && args.from
  if (fromText !== undefined && fromText !== null && fromText !== '') {
    const parsed = parseLocalDate(fromText, offsetMs)
    if (parsed === null) return { error: 'invalid from date (expected YYYY-MM-DD)' }
    from = parsed
  }
  const toText = args && args.to
  if (toText !== undefined && toText !== null && toText !== '') {
    const parsed = parseLocalDate(toText, offsetMs)
    if (parsed === null) return { error: 'invalid to date (expected YYYY-MM-DD)' }
    to = parsed + DAY_MS // inclusive day -> exclusive next midnight
  }
  if (!(to > from)) return { error: 'to must be after from' }
  return { from, to, offsetMs, range }
}

function formatTokens(value) {
  const n = num(value)
  const abs = Math.abs(n)
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(Math.round(n))
}

function formatMoney(value) {
  return '¥' + (Math.round(num(value) * 100) / 100).toFixed(2)
}

function formatPercent(value) {
  return (num(value) * 100).toFixed(1) + '%'
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error((label || 'operation') + ' timed out after ' + ms + 'ms')), ms)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function mapWallets(wallets) {
  if (!Array.isArray(wallets)) return []
  const out = []
  for (const wallet of wallets) {
    if (!isPlainObject(wallet)) continue
    const currency = str(wallet.currency)
    if (currency !== 'CNY' && currency !== 'USD') continue
    const balance = typeof wallet.balance === 'string' ? wallet.balance : String(wallet.balance)
    out.push({ currency, balance })
  }
  return out
}

function compactToolDims(value) {
  const totals = new Map()
  for (const bucket of value.buckets || []) {
    const byDim = bucket && bucket.byDim
    if (!isPlainObject(byDim)) continue
    for (const key of Object.keys(byDim)) {
      const part = byDim[key]
      let row = totals.get(key)
      if (!row) {
        row = { key, tokens: 0, cost: 0 }
        totals.set(key, row)
      }
      row.tokens += num(part.tokens)
      row.cost += num(part.cost)
    }
  }
  const labels = new Map()
  for (const dim of value.dims || []) labels.set(dim.key, dim.label)
  const metric = value.metric
  return [...totals.values()]
    .sort((a, b) => {
      const delta = metric === 'cost' ? b.cost - a.cost : b.tokens - a.tokens
      return delta !== 0 ? delta : b.tokens - a.tokens
    })
    .slice(0, MAX_TOOL_DIMS)
    .map((row) => ({ key: row.key, label: labels.get(row.key) || row.key, tokens: row.tokens, cost: row.cost }))
}

function renderTokenStats(args, value) {
  try {
    if (!isPlainObject(value) || value.ok !== true) {
      return [
        {
          type: 'text',
          text: 'Token statistics unavailable: ' + String((value && value.error) || 'unknown error'),
        },
      ]
    }
    const lines = []
    lines.push(
      'Token statistics — ' +
        value.range +
        ' (bucket ' +
        value.bucket +
        ', group by ' +
        value.groupBy +
        ', metric ' +
        value.metric +
        ')',
    )
    lines.push(
      'Totals: ' +
        formatTokens(value.totals.tokens) +
        ' tokens · ' +
        formatMoney(value.totals.cost) +
        ' · ' +
        Math.round(num(value.totals.requests)) +
        ' requests',
    )
    lines.push(
      'Summary: cache hit ' +
        formatPercent(value.summary.cacheHitRate) +
        ' · sessions ' +
        Math.round(num(value.summary.sessions)) +
        ' · avg/day ' +
        formatTokens(value.summary.avgPerDayTokens),
    )
    if (Array.isArray(value.dims) && value.dims.length > 0) {
      lines.push('By ' + value.groupBy + ':')
      for (const dim of value.dims) {
        lines.push('  ' + dim.label + ': ' + formatTokens(dim.tokens) + ' tokens · ' + formatMoney(dim.cost))
      }
    }
    const unpriced = value.notes && Array.isArray(value.notes.unpricedModels) ? value.notes.unpricedModels : []
    if (unpriced.length > 0) {
      lines.push('Unpriced models: ' + unpriced.map((entry) => entry.key).join(', '))
    }
    return [{ type: 'text', text: lines.join('\n') }]
  } catch (error) {
    return [{ type: 'text', text: 'Token statistics render failed: ' + messageOf(error) }]
  }
}

function methodOf(req) {
  const raw = req && req.url ? String(req.url) : ''
  let pathname = raw
  const queryIndex = pathname.indexOf('?')
  if (queryIndex >= 0) pathname = pathname.slice(0, queryIndex)
  const hashIndex = pathname.indexOf('#')
  if (hashIndex >= 0) pathname = pathname.slice(0, hashIndex)
  let sub = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : pathname
  sub = sub.replace(/^\/+/, '').replace(/\/+$/, '')
  try {
    return decodeURIComponent(sub)
  } catch {
    return sub
  }
}

function fail(code, details) {
  const error = new Error(details || code)
  error.code = code
  return error
}

function messageOf(error) {
  if (!error) return 'unknown error'
  return String(error.message || error)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      cleanup()
      fn(value)
    }
    const onData = (chunk) => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY) {
        finish(reject, fail('body-too-large', 'request body exceeds 2 MiB'))
        try {
          if (typeof req.destroy === 'function') req.destroy()
        } catch {
          /* stream already closing */
        }
        return
      }
      chunks.push(buffer)
    }
    const onEnd = () => finish(resolve, Buffer.concat(chunks))
    const onError = (error) => finish(reject, error)
    const cleanup = () => {
      if (typeof req.removeListener !== 'function') return
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

function send(res, status, body) {
  try {
    if (res.headersSent) {
      try {
        res.end()
      } catch {
        /* already finished */
      }
      return
    }
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': payload.length,
      'cache-control': 'no-store',
    })
    res.end(payload)
  } catch {
    try {
      res.end()
    } catch {
      /* response may already be closed */
    }
  }
}

function sendError(res, status, code, details) {
  send(res, status, { ok: false, error: { code, details: String(details || code) } })
}

function errorStatus(code) {
  if (code === 'too-many-buckets') return 200 // contract: explicit 200 with ok:false
  if (code === 'unknown-method') return 404
  if (code === 'internal') return 500
  if (code === 'method') return 405
  if (code === 'body-too-large') return 413
  return 400
}

export async function createApp({ ctx, version, log }) {
  const query = '?v=' + encodeURIComponent(String(version == null ? '' : version))
  const [store, cost, aggregate, scan] = await Promise.all([
    import('./store.js' + query),
    import('./cost.js' + query),
    import('./aggregate.js' + query),
    import('./scan.js' + query),
  ])
  const logger = typeof log === 'function' ? log : () => {}
  const indexer = scan.createIndexer({ ctx, store, log: logger })
  const titleCache = new Map()
  const appStartedAt = Date.now()
  let disposed = false
  let offLive = null

  function service(name) {
    try {
      return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  async function configNow() {
    return store.readConfig(cost.DEFAULT_CONFIG)
  }

  async function readTitle(sessionId) {
    if (titleCache.has(sessionId)) return titleCache.get(sessionId)
    const query = service('sessionQuery')
    if (!query || typeof query.readTitle !== 'function') return ''
    try {
      const title = await query.readTitle(sessionId)
      const value = title && typeof title.title === 'string' ? title.title : ''
      if (value) {
        if (titleCache.size >= TITLE_CACHE_LIMIT) titleCache.clear()
        titleCache.set(sessionId, value)
      }
      return value
    } catch {
      return ''
    }
  }

  async function titlesFor(ids) {
    const result = {}
    const snapshot = indexer.snapshot()
    const indexed = []
    for (const id of ids) {
      const entry = snapshot.sessions[id]
      if (!entry) continue
      indexed.push({ id, cwd: typeof entry.cwd === 'string' ? entry.cwd : '' })
    }
    for (let i = 0; i < indexed.length; i += TITLE_BATCH) {
      const batch = indexed.slice(i, i + TITLE_BATCH)
      const titles = await Promise.all(batch.map((item) => readTitle(item.id)))
      for (let j = 0; j < batch.length; j++) {
        result[batch[j].id] = { title: titles[j] || '', cwd: batch[j].cwd }
      }
    }
    return result
  }

  // ---- official DeepSeek account balance (feature 20) ----------------------
  // Cached because the Platform endpoint is remote: successes for 60s, any
  // failure for 10s. Never throws; the Client hides the chip on `available:false`.
  let balanceCache = null // { at, ttl, value }
  let balanceInflight = null

  async function fetchBalance() {
    const account = service('deepseekAccount')
    if (!account) return { available: false, reason: 'service-unavailable' }
    if (typeof account.getState !== 'function' || typeof account.getBalance !== 'function') {
      return { available: false, reason: 'service-unavailable' }
    }
    const state = await withTimeout(account.getState(), BALANCE_TIMEOUT_MS, 'getState')
    if (!state || state.status !== 'credential-stored') {
      return { available: false, reason: 'signed-out' }
    }
    const result = await withTimeout(account.getBalance(BALANCE_CLIENT), BALANCE_TIMEOUT_MS, 'getBalance')
    if (result === null || result === undefined) return { available: false, reason: 'signed-out' }
    if (result.status === 'failed') return { available: false, reason: 'query-failed' }
    if (result.status !== 'ready') return { available: false, reason: 'error' }
    const value = {
      available: true,
      wallets: mapWallets(result.value),
      bonusWallets: mapWallets(result.bonusWallets),
    }
    if (value.wallets.length === 0 && value.bonusWallets.length === 0) {
      return { available: false, reason: 'no-wallets' }
    }
    return value
  }

  async function balanceNow() {
    const now = Date.now()
    if (balanceCache && now - balanceCache.at < balanceCache.ttl) return balanceCache.value
    // Collapse concurrent requests into one Platform query.
    if (balanceInflight) return balanceInflight
    balanceInflight = (async () => {
      let value
      try {
        value = await fetchBalance()
      } catch (error) {
        logger('warn', 'balance query failed', messageOf(error))
        value = { available: false, reason: 'error' }
      }
      balanceCache = {
        at: Date.now(),
        ttl: value.available ? BALANCE_SUCCESS_TTL_MS : BALANCE_FAILURE_TTL_MS,
        value,
      }
      return value
    })().finally(() => {
      balanceInflight = null
    })
    return balanceInflight
  }

  // ---- token_stats agent tool (feature 19) ---------------------------------
  // Read-only: aggregates the in-memory index snapshot through the same
  // normalizedQuery/aggregate pipeline as the HTTP stats endpoint.
  function compactToolValue(value, rangeName) {
    const truncated = (value.buckets || []).length > MAX_TOOL_BUCKETS
    return {
      ok: true,
      range: rangeName,
      from: value.from,
      to: value.to,
      bucket: value.bucket,
      groupBy: value.groupBy,
      metric: value.metric,
      currency: value.currency,
      timezoneOffsetMinutes: value.timezoneOffsetMinutes,
      totals: {
        tokens: value.totals.tokens,
        cost: value.totals.cost,
        requests: value.totals.requests,
      },
      summary: {
        totalTokens: value.summary.totalTokens,
        totalCost: value.summary.totalCost,
        cacheHitRate: value.summary.cacheHitRate,
        sessions: value.summary.sessions,
        avgPerDayTokens: value.summary.avgPerDayTokens,
      },
      buckets: (value.buckets || []).slice(0, MAX_TOOL_BUCKETS).map((bucket) => ({
        t0: bucket.t0,
        tokens: bucket.total.tokens,
        cost: bucket.total.cost,
      })),
      dims: compactToolDims(value),
      notes: {
        partial: !!value.notes.partial,
        unpricedModels: (value.notes.unpricedModels || []).slice(0, 8),
        filters: value.notes.filters,
        ...(truncated ? { bucketsTruncated: true } : {}),
      },
    }
  }

  async function executeTokenStats(args) {
    try {
      if (!isPlainObject(args)) return { ok: false, error: 'invalid-arguments' }
      const config = await configNow()
      const snapshot = indexer.snapshot()
      if (!snapshot || !isPlainObject(snapshot.sessions) || Object.keys(snapshot.sessions).length === 0) {
        return { ok: false, error: 'index-unavailable' }
      }
      const groupBy =
        args.groupBy === 'provider' || args.groupBy === 'model' ? args.groupBy : 'category'
      const metric = args.metric === 'cost' ? 'cost' : 'tokens'
      const rangeName =
        typeof args.range === 'string' && TOOL_RANGES.includes(args.range) ? args.range : 'last7'
      const range = toolRange({ ...args, range: rangeName }, config, Date.now())
      if (range.error) return { ok: false, error: range.error }
      let from = range.from
      let to = range.to
      if (rangeName === 'all' && args.from === undefined && args.to === undefined) {
        const bounds = aggregate.meta(snapshot, config, cost).timeRange
        if (!bounds) return { ok: false, error: 'no-data' }
        from = bounds.from
        to = bounds.to + 1
      }
      const body = {
        from,
        to,
        bucket: 'auto',
        groupBy,
        metric,
        includeSubagents: args.includeSubagents === undefined ? true : !!args.includeSubagents,
      }
      const models = Array.isArray(args.models) ? args.models.filter((item) => typeof item === 'string') : []
      if (models.length > 0) body.models = models
      let query = aggregate.normalizedQuery(body, config)
      let value = aggregate.aggregate(snapshot, config, query, cost)
      // Cap the series at 62 bars by switching to a coarser granularity first.
      if (value.buckets.length > MAX_TOOL_BUCKETS) {
        for (const bucket of ['week', 'month']) {
          const candidateQuery = aggregate.normalizedQuery({ ...body, bucket }, config)
          const candidate = aggregate.aggregate(snapshot, config, candidateQuery, cost)
          if (candidate.buckets.length <= MAX_TOOL_BUCKETS) {
            query = candidateQuery
            value = candidate
            break
          }
        }
      }
      return compactToolValue(value, rangeName)
    } catch (error) {
      logger('warn', 'token_stats tool failed', messageOf(error))
      return { ok: false, error: messageOf(error) }
    }
  }

  const TOKEN_STATS_PARAMETERS = {
    type: 'object',
    properties: {
      range: {
        type: 'string',
        enum: TOOL_RANGES,
        description:
          'Relative range in the statistics timezone: today, yesterday, last7, last30, thisMonth, lastMonth, or all recorded data. Defaults to last7.',
      },
      from: {
        type: 'string',
        description: 'Start date YYYY-MM-DD in the statistics timezone; overrides the range start.',
      },
      to: {
        type: 'string',
        description: 'End date YYYY-MM-DD (inclusive) in the statistics timezone; overrides the range end.',
      },
      groupBy: {
        type: 'string',
        enum: ['category', 'provider', 'model'],
        description: 'Dimension to break the totals down by. Defaults to category.',
      },
      metric: {
        type: 'string',
        enum: ['tokens', 'cost'],
        description: 'Ranking metric for the dimension breakdown. Defaults to tokens.',
      },
      models: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional provider/model keys to include (see the statistics page model list).',
      },
      includeSubagents: {
        type: 'boolean',
        description: 'Whether subagent sessions are included. Defaults to true.',
      },
    },
    additionalProperties: false,
  }

  function buildTokenStatsDefinition() {
    return {
      name: TOOL_NAME,
      description:
        'Read this installation\'s recorded DeepSeek API token usage and estimated CNY cost from the local token index (no network, no writes). Returns totals, cache-hit rate, per-bucket series and a dimension breakdown for a date range; useful for questions like "how many tokens did I use today" or "what did last week cost".',
      parameters: TOKEN_STATS_PARAMETERS,
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', description: 'Whether the query succeeded.' },
            error: { type: 'string', description: 'Failure reason when ok is false.' },
            range: { type: 'string' },
            from: { type: 'number' },
            to: { type: 'number' },
            bucket: { type: 'string' },
            groupBy: { type: 'string' },
            metric: { type: 'string' },
            currency: { type: 'string' },
            totals: {
              type: 'object',
              properties: {
                tokens: { type: 'number' },
                cost: { type: 'number' },
                requests: { type: 'number' },
              },
            },
            summary: { type: 'object' },
            buckets: { type: 'array', items: { type: 'object' } },
            dims: { type: 'array', items: { type: 'object' } },
            notes: { type: 'object' },
          },
          required: ['ok'],
          additionalProperties: true,
        },
        render: (args, value) => renderTokenStats(args, value),
      },
      execute: (args) => executeTokenStats(args),
      isConcurrencySafe: () => true,
    }
  }

  let disposeTool = null
  function registerTokenStatsTool() {
    const tools = service('tools')
    if (!tools || typeof tools.register !== 'function') return
    try {
      const disposer = tools.register(buildTokenStatsDefinition())
      if (typeof disposer === 'function') disposeTool = disposer
      logger('info', 'registered token_stats tool')
    } catch (error) {
      logger('warn', 'failed to register token_stats tool', messageOf(error))
    }
  }

  async function dispatch(method, body) {
    switch (method) {
      case 'status':
        return indexer.status()

      case 'balance':
        return balanceNow()

      case 'meta': {
        const config = await configNow()
        const value = aggregate.meta(indexer.snapshot(), config, cost)
        const status = indexer.status()
        value.sessions.total = status.total || value.sessions.indexed
        return value
      }

      case 'stats': {
        const config = await configNow()
        const query = aggregate.normalizedQuery(body, config)
        const value = aggregate.aggregate(indexer.snapshot(), config, query, cost)
        const status = indexer.status()
        value.notes.indexProgress = {
          scanned: status.scanned,
          total: status.total,
          running: status.running,
        }
        value.notes.partial = !!status.running
        return value
      }

      case 'bucketSessions': {
        // Chart session-hover list: per-session breakdown for one bucket/range.
        const config = await configNow()
        const query = aggregate.normalizedQuery(body, config)
        const value = aggregate.sessionBreakdown(indexer.snapshot(), config, query, cost, body.limit)
        const status = indexer.status()
        value.notes.partial = !!status.running
        // Best-effort titles for at most the first 30 rows, bounded to ~1s so a
        // slow session log never delays the hover list (cache is reused).
        const titleable = value.sessions.slice(0, 30)
        if (titleable.length > 0 && service('sessionQuery')) {
          try {
            const titles = await withTimeout(
              Promise.all(titleable.map((row) => readTitle(row.key))),
              1000,
              'bucketSessions titles',
            )
            for (let i = 0; i < titleable.length; i += 1) {
              if (titles[i]) titleable[i].title = titles[i]
            }
          } catch (error) {
            logger('warn', 'bucketSessions titles skipped', messageOf(error))
          }
        }
        return value
      }

      case 'session': {
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        if (!sessionId) throw fail('bad-request', 'sessionId is required')
        const config = await configNow()
        try {
          await indexer.ensureSession(sessionId)
        } catch (error) {
          logger('warn', 'ensureSession failed', sessionId, messageOf(error))
        }
        const value = aggregate.sessionSummary(indexer.snapshot(), config, cost, sessionId)
        if (value.found) value.title = await readTitle(sessionId)
        return value
      }

      case 'titles': {
        if (!Array.isArray(body.ids)) throw fail('bad-request', 'ids must be an array of strings')
        const ids = []
        const seen = new Set()
        for (const item of body.ids.slice(0, 500)) {
          if (typeof item !== 'string') continue
          const id = item.trim()
          if (!id || seen.has(id)) continue
          seen.add(id)
          ids.push(id)
        }
        return titlesFor(ids)
      }

      case 'config': {
        if (body.patch !== undefined) {
          const config = await store.writeConfig(body.patch, cost.DEFAULT_CONFIG)
          return { config, defaults: cost.DEFAULT_CONFIG }
        }
        const config = await configNow()
        return { config, defaults: cost.DEFAULT_CONFIG }
      }

      case 'rebuild':
        return indexer.rebuild()

      case 'debug': {
        const status = indexer.status()
        const config = await configNow()
        const value = {
          version: 1,
          pluginVersion: String(version == null ? '' : version),
          generatedAt: indexer.snapshot().generatedAt,
          uptimeMs: Date.now() - appStartedAt,
          services: status.services,
          progress: {
            running: status.running,
            scanned: status.scanned,
            total: status.total,
            startedAt: status.startedAt,
            finishedAt: status.finishedAt,
            lastScanMs: status.lastScanMs,
          },
          index: {
            sessions: status.sessions,
            records: status.records,
            bytes: status.indexBytes,
          },
          // Cache-validation counters from the last scan (warm-start health).
          cache: typeof indexer.cacheStats === 'function' ? indexer.cacheStats() : null,
          tools: {
            name: TOOL_NAME,
            service: !!service('tools'),
            registered: typeof disposeTool === 'function',
          },
          balance: {
            service: !!service('deepseekAccount'),
            cached: !!balanceCache,
            cachedTtlMs: balanceCache ? balanceCache.ttl : 0,
            cachedAvailable: balanceCache ? !!balanceCache.value.available : null,
          },
          errors: status.errors,
          config,
          defaults: cost.DEFAULT_CONFIG,
          // Which TokenUsage semantics the numbers use (see lib/cost.js).
          usageSemantics: {
            inputTokens: 'uncached-prompt-input',
            totalTokens: 'inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens',
          },
          node: process.version,
        }
        // `debug` body { probe: true } also reports what sessionPersistence
        // list()/stat() actually provide, for cache-key diagnosis.
        if (body.probe === true && typeof indexer.probe === 'function') {
          value.probe = await indexer.probe()
        }
        return value
      }

      default:
        throw fail('unknown-method', 'unknown method: ' + (method || '(empty)'))
    }
  }

  async function handle(req, res) {
    try {
      if (disposed) {
        sendError(res, 503, 'internal', 'plugin is disposed')
        return
      }
      const method = methodOf(req)
      if (!req || req.method !== 'POST') {
        sendError(res, 405, 'method', 'POST only')
        return
      }
      let raw
      try {
        raw = await readBody(req)
      } catch (error) {
        const code = error && error.code ? String(error.code) : 'internal'
        sendError(res, errorStatus(code), code, messageOf(error))
        return
      }
      let body
      try {
        const text = raw.toString('utf8').trim()
        body = text ? JSON.parse(text) : {}
      } catch {
        sendError(res, 400, 'bad-json', 'request body must be valid JSON')
        return
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendError(res, 400, 'bad-request', 'request body must be a JSON object')
        return
      }
      let value
      try {
        value = await dispatch(method, body)
      } catch (error) {
        const code = error && error.code ? String(error.code) : 'internal'
        if (code === 'internal') logger('error', 'api request failed', messageOf(error))
        sendError(res, errorStatus(code), code, messageOf(error))
        return
      }
      send(res, 200, { ok: true, value })
    } catch (error) {
      logger('error', 'unhandled api error', messageOf(error))
      sendError(res, 500, 'internal', messageOf(error))
    }
  }

  // Subscribe before starting the indexer so appends that land while the cached
  // index is being read are buffered/applied instead of lost.
  try {
    if (ctx && typeof ctx.on === 'function') {
      offLive = ctx.on('session/event', (session, event) => {
        if (disposed) return
        try {
          indexer.applyLive(session, event)
        } catch (error) {
          logger('warn', 'live session event failed', messageOf(error))
        }
      })
    }
  } catch (error) {
    logger('warn', 'failed to subscribe session/event', messageOf(error))
  }

  await indexer.start()
  registerTokenStatsTool()

  async function dispose() {
    disposed = true
    try {
      if (typeof disposeTool === 'function') disposeTool()
    } catch {
      /* the tool registry may already be gone */
    }
    disposeTool = null
    try {
      if (typeof offLive === 'function') offLive()
    } catch {
      /* context may already be disposed */
    }
    offLive = null
    balanceCache = null
    titleCache.clear()
    try {
      indexer.dispose()
    } catch {
      /* indexer teardown must not throw */
    }
  }

  function status() {
    return indexer.status()
  }

  return { handle, dispose, status }
}
