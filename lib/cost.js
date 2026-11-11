// Cost engine for @local/dshtoken.
//
// Pure functions over the JSON-stable usage record:
//   [t, provider, model, inputTokens, cacheRead, cacheWrite, output, reasoning]
//
// Prices are CNY per 1,000,000 tokens. A missing price means "unpriced": the
// record still contributes tokens but costs 0 (it is reported as unpriced).
//
// IMPORTANT — usage semantics of the installed DSH (verified offline against all
// 38,636 usage records in the real session corpus):
//   `inputTokens` is the UNCACHED prompt input (prompt_tokens - cacheRead -
//   cacheWrite), NOT the total prompt: `totalTokens === inputTokens +
//   outputTokens + cacheReadTokens + cacheWriteTokens` holds for 100% of records
//   and cacheRead exceeds inputTokens in 99.2% of them. Therefore the billed
//   "miss" tokens are inputTokens itself; do NOT subtract cacheRead again.
// The part counters add up to TokenUsage.totalTokens:
//   tokens = miss(input) + hit(cacheRead) + write(cacheWrite) + out(output).
//
// NOTE: this module must not import a sibling lib file: http.js loads every
// module with a cache-busting query, and a relative import would pin a stale
// copy. Keep it dependency-free (node builtins not even needed here).

const PER_MILLION = 1e6

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function str(value) {
  return typeof value === 'string' ? value : ''
}

function pad2(value) {
  return value < 10 ? '0' + value : String(value)
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

function flashPrice() {
  return { hit: 0.02, miss: 1, write: 0, out: 4, peakMultiplier: 2 }
}

// Official DeepSeek defaults, mirrored verbatim in CONTRACT.md / the client
// settings dialog. `deepseek-v4-flash*` are legacy alias names billed as Flash.
export const DEFAULT_CONFIG = deepFreeze({
  version: 1,
  currency: 'CNY',
  timezoneOffsetMinutes: 480, // Asia/Shanghai; used for buckets AND peak windows
  prices: {
    'deepseek-official/deepseek-flash': flashPrice(),
    'deepseek-official/deepseek-v4-flash': flashPrice(),
    'deepseek-official/deepseek-v4-flash-vision-exp': flashPrice(),
    'deepseek-official/deepseek-v4-pro': { hit: 0.15, miss: 4.5, write: 0, out: 13.5, peakMultiplier: 2 },
  },
  peak: {
    enabled: true,
    days: [1, 2, 3, 4, 5], // ISO weekday, 1 = Monday
    windows: [
      { start: 540, end: 720 }, // 09:00–12:00
      { start: 840, end: 1080 }, // 14:00–18:00
    ],
    holidays: [], // 'YYYY-MM-DD' local dates treated as idle
  },
  prefs: {},
})

/** A Part with every counter at zero (shared shape for aggregate output). */
export function emptyPart() {
  return { tokens: 0, cost: 0, miss: 0, hit: 0, write: 0, out: 0, reasoning: 0, requests: 0 }
}

/**
 * Look a price up by exact `provider/model`, then `provider/*`, then the
 * any-provider wildcard `*` + `/model`. Returns the configured price object or
 * null (unpriced).
 */
export function resolvePrice(config, provider, model) {
  const prices = config && config.prices
  if (!prices || typeof prices !== 'object') return null
  const p = str(provider)
  const m = str(model)
  const candidates = [p + '/' + m, p + '/*', '*/' + m]
  for (const key of candidates) {
    const price = prices[key]
    if (price && typeof price === 'object') return price
  }
  return null
}

/**
 * Peak = statistics-timezone wall clock inside one [start, end) window on a
 * configured ISO weekday that is not a listed holiday.
 */
export function isPeak(t, config) {
  const peak = config && config.peak
  if (!peak || !peak.enabled) return false
  const time = Number(t)
  if (!Number.isFinite(time)) return false
  const days = Array.isArray(peak.days) ? peak.days : []
  if (days.length === 0) return false
  const offsetMs = num(config.timezoneOffsetMinutes) * 60000
  const wall = new Date(time + offsetMs)
  const isoWeekday = wall.getUTCDay() === 0 ? 7 : wall.getUTCDay()
  if (!days.some((day) => Number(day) === isoWeekday)) return false
  const dateKey =
    wall.getUTCFullYear() + '-' + pad2(wall.getUTCMonth() + 1) + '-' + pad2(wall.getUTCDate())
  const holidays = Array.isArray(peak.holidays) ? peak.holidays : []
  if (holidays.includes(dateKey)) return false
  const minute = wall.getUTCHours() * 60 + wall.getUTCMinutes()
  const windows = Array.isArray(peak.windows) ? peak.windows : []
  for (const window of windows) {
    if (!window) continue
    const start = num(window.start)
    const end = num(window.end)
    if (minute >= start && minute < end) return true
  }
  return false
}

/** Cost multiplier for one record: 1 when idle, peakMultiplier at peak. */
function peakFactor(price, t, config) {
  if (!price) return 1
  if (!isPeak(t, config)) return 1
  return Number.isFinite(Number(price.peakMultiplier)) ? Number(price.peakMultiplier) : 2
}

function readRecord(record) {
  const arr = Array.isArray(record) ? record : []
  return {
    t: num(arr[0]),
    provider: str(arr[1]),
    model: str(arr[2]),
    input: num(arr[3]),
    cacheRead: num(arr[4]),
    cacheWrite: num(arr[5]),
    output: num(arr[6]),
    reasoning: num(arr[7]),
  }
}

/** Cost of one priced record in CNY (no rounding). */
function pricedCost(r, price, peak) {
  return (
    ((r.miss * num(price.miss) +
      r.cacheRead * num(price.hit) +
      r.cacheWrite * num(price.write) +
      r.output * num(price.out)) /
      PER_MILLION) *
    peak
  )
}

/** Build the Part for one usage record; unpriced records have cost 0. */
export function recordPart(record, config) {
  const r = readRecord(record)
  // inputTokens is already the uncached prompt size in this DSH build.
  r.miss = r.input
  const part = {
    tokens: r.miss + r.cacheRead + r.cacheWrite + r.output,
    cost: 0,
    miss: r.miss,
    hit: r.cacheRead,
    write: r.cacheWrite,
    out: r.output,
    reasoning: r.reasoning,
    requests: 1,
  }
  const price = resolvePrice(config, r.provider, r.model)
  if (price) part.cost = pricedCost(r, price, peakFactor(price, r.t, config))
  return part
}

/** Accumulate `part` into `target` (both Part shapes) and return `target`. */
export function addPart(target, part) {
  if (!target || typeof target !== 'object') return part ? { ...part } : emptyPart()
  if (!part) return target
  target.tokens = num(target.tokens) + num(part.tokens)
  target.cost = num(target.cost) + num(part.cost)
  target.miss = num(target.miss) + num(part.miss)
  target.hit = num(target.hit) + num(part.hit)
  target.write = num(target.write) + num(part.write)
  target.out = num(target.out) + num(part.out)
  target.reasoning = num(target.reasoning) + num(part.reasoning)
  target.requests = num(target.requests) + num(part.requests)
  return target
}

/**
 * Cost implied by aggregated token counters at idle rates (no peak factor,
 * which is information the aggregate Part does not retain). The aggregate
 * pipeline sums exact per-record `cost` instead; this helper exists for
 * callers that only have counters.
 */
export function dimCost(config, provider, model, parts) {
  const price = resolvePrice(config, provider, model)
  if (!price || !parts) return 0
  return (
    (num(parts.miss) * num(price.miss) +
      num(parts.hit) * num(price.hit) +
      num(parts.write) * num(price.write) +
      num(parts.out) * num(price.out)) /
    PER_MILLION
  )
}
