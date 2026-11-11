// Persistence for @local/dshtoken: config + gzip index under
// `$DSH_HOME/plugin-data/dshtoken/` (same convention as dsh-plugin-iot-thinking).
//
// NOTE: no relative imports of sibling lib files here — http.js loads each
// module with a cache-busting query and a relative import would go stale.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

const INDEX_FILE = 'index.json.gz'
const CONFIG_FILE = 'config.json'

// Distinct per module instance: http.js hot-reloads sibling modules with a
// cache-busting query, so two store instances can briefly write concurrently.
// The temp name must be unique across instances, not just within one.
const INSTANCE_ID = randomUUID().slice(0, 8)

let ensureDirPromise = null
let tmpCounter = 0

/** Absolute plugin data directory (created lazily by write helpers). */
export function dataDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'plugin-data', 'dshtoken')
}

function indexPath() {
  return join(dataDir(), INDEX_FILE)
}

function configPath() {
  return join(dataDir(), CONFIG_FILE)
}

function ensureDir() {
  const dir = dataDir()
  if (!ensureDirPromise) {
    ensureDirPromise = mkdir(dir, { recursive: true }).catch((error) => {
      ensureDirPromise = null
      throw error
    })
  }
  return ensureDirPromise
}

async function renameWithRetry(from, to) {
  let lastError = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      lastError = error
      // Windows: antivirus/indexers can transiently hold or scan the fresh
      // file, so a replace rename may need a short retry.
      if (error && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY')) {
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
        continue
      }
      throw error
    }
  }
  throw lastError
}

async function atomicWrite(filePath, data) {
  await ensureDir()
  tmpCounter += 1
  const tmp = filePath + '.' + process.pid + '.' + INSTANCE_ID + '.' + tmpCounter + '.tmp'
  try {
    await writeFile(tmp, data)
    await renameWithRetry(tmp, filePath)
  } catch (error) {
    try {
      await unlink(tmp)
    } catch {
      /* nothing to clean up */
    }
    throw error
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function badConfig(details) {
  const error = new Error(details)
  error.code = 'bad-config'
  return error
}

function clonePeak(src, fallback) {
  const peak = isPlainObject(src) ? src : {}
  const base = isPlainObject(fallback) ? fallback : {}
  const days = Array.isArray(peak.days)
    ? peak.days.map((day) => Number(day)).filter((day) => Number.isInteger(day) && day >= 1 && day <= 7)
    : Array.isArray(base.days)
      ? base.days.slice()
      : [1, 2, 3, 4, 5]
  const windows = Array.isArray(peak.windows)
    ? peak.windows
        .filter((window) => isPlainObject(window))
        .map((window) => ({ start: num(window.start), end: num(window.end) }))
        .filter((window) => window.start >= 0 && window.end <= 1440 && window.start < window.end)
    : Array.isArray(base.windows)
      ? base.windows.map((window) => ({ start: num(window.start), end: num(window.end) }))
      : []
  const holidays = Array.isArray(peak.holidays)
    ? peak.holidays.filter((day) => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day))
    : Array.isArray(base.holidays)
      ? base.holidays.slice()
      : []
  return {
    enabled: typeof peak.enabled === 'boolean' ? peak.enabled : base.enabled !== false,
    days,
    windows,
    holidays,
  }
}

function clonePrices(src) {
  const out = {}
  if (!isPlainObject(src)) return out
  for (const key of Object.keys(src)) {
    const entry = src[key]
    if (!isPlainObject(entry)) continue
    const price = {
      hit: num(entry.hit),
      miss: num(entry.miss),
      write: num(entry.write),
      out: num(entry.out),
    }
    if (nonNegativeNumber(entry.peakMultiplier)) price.peakMultiplier = entry.peakMultiplier
    out[key] = price
  }
  return out
}

/**
 * Shallow merge per top-level key over `defaults` (so `prices` replaces the
 * whole map, exactly like the HTTP `config` patch semantics). Both arguments
 * are left untouched. Invalid sub-objects fall back to defaults.
 */
export function mergeConfig(raw, defaults) {
  const base = isPlainObject(defaults) ? defaults : {}
  const over = isPlainObject(raw) ? raw : {}
  return {
    version: 1,
    currency:
      typeof over.currency === 'string' && over.currency.trim()
        ? over.currency.trim().slice(0, 16)
        : typeof base.currency === 'string' && base.currency.trim()
          ? base.currency
          : 'CNY',
    timezoneOffsetMinutes: Number.isFinite(over.timezoneOffsetMinutes)
      ? Math.round(over.timezoneOffsetMinutes)
      : Number.isFinite(base.timezoneOffsetMinutes)
        ? base.timezoneOffsetMinutes
        : 480,
    prices: clonePrices(over.prices !== undefined ? over.prices : base.prices),
    peak: clonePeak(over.peak !== undefined ? over.peak : base.peak, base.peak),
    prefs: isPlainObject(over.prefs) ? { ...over.prefs } : isPlainObject(base.prefs) ? { ...base.prefs } : {},
  }
}

function validatePrices(value) {
  if (!isPlainObject(value)) throw badConfig('prices must be an object')
  for (const key of Object.keys(value)) {
    if (!key.trim()) throw badConfig('price keys must be non-empty "provider/model" strings')
    const entry = value[key]
    if (!isPlainObject(entry)) throw badConfig('price for "' + key + '" must be an object')
    for (const field of ['hit', 'miss', 'write', 'out', 'peakMultiplier']) {
      const fieldValue = entry[field]
      if (fieldValue === undefined || fieldValue === null) continue
      if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue) || fieldValue < 0) {
        throw badConfig('price field "' + field + '" for "' + key + '" must be a non-negative number')
      }
    }
  }
}

function validatePeak(value) {
  if (!isPlainObject(value)) throw badConfig('peak must be an object')
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw badConfig('peak.enabled must be a boolean')
  }
  if (value.days !== undefined) {
    if (!Array.isArray(value.days)) throw badConfig('peak.days must be an array')
    for (const day of value.days) {
      if (!Number.isInteger(day) || day < 1 || day > 7) {
        throw badConfig('peak.days entries must be ISO weekdays 1..7')
      }
    }
  }
  if (value.windows !== undefined) {
    if (!Array.isArray(value.windows)) throw badConfig('peak.windows must be an array')
    for (const window of value.windows) {
      if (!isPlainObject(window)) throw badConfig('peak.windows entries must be objects')
      if (
        typeof window.start !== 'number' ||
        typeof window.end !== 'number' ||
        !Number.isFinite(window.start) ||
        !Number.isFinite(window.end) ||
        window.start < 0 ||
        window.end > 1440 ||
        window.start >= window.end
      ) {
        throw badConfig('peak.windows entries need finite 0 <= start < end <= 1440')
      }
    }
  }
  if (value.holidays !== undefined) {
    if (!Array.isArray(value.holidays)) throw badConfig('peak.holidays must be an array')
    for (const day of value.holidays) {
      if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        throw badConfig('peak.holidays entries must be YYYY-MM-DD strings')
      }
    }
  }
}

function validatePatch(patch) {
  if (!isPlainObject(patch)) throw badConfig('patch must be a JSON object')
  for (const key of Object.keys(patch)) {
    const value = patch[key]
    switch (key) {
      case 'version':
        if (value !== 1) throw badConfig('version must be 1')
        break
      case 'currency':
        if (typeof value !== 'string' || !value.trim() || value.trim().length > 16) {
          throw badConfig('currency must be a non-empty string of at most 16 characters')
        }
        break
      case 'timezoneOffsetMinutes':
        if (
          typeof value !== 'number' ||
          !Number.isFinite(value) ||
          value < -1440 ||
          value > 1440
        ) {
          throw badConfig('timezoneOffsetMinutes must be a finite number between -1440 and 1440')
        }
        break
      case 'prices':
        validatePrices(value)
        break
      case 'peak':
        validatePeak(value)
        break
      case 'prefs':
        if (!isPlainObject(value)) throw badConfig('prefs must be an object')
        break
      default:
        throw badConfig('unknown config key "' + key + '"')
    }
  }
}

/** Read config.json merged over `defaults`; missing/corrupt file -> defaults. */
export async function readConfig(defaults) {
  try {
    const raw = await readFile(configPath(), 'utf8')
    const parsed = JSON.parse(raw)
    return mergeConfig(parsed, defaults)
  } catch {
    return mergeConfig({}, defaults)
  }
}

/**
 * Validate `patch`, shallow-merge it over the stored config, persist atomically
 * and return the resulting complete config. Throws Error with code 'bad-config'.
 */
export async function writeConfig(patch, defaults) {
  validatePatch(patch)
  const current = await readConfig(defaults)
  const next = mergeConfig(patch, current)
  await atomicWrite(configPath(), JSON.stringify(next, null, 2) + '\n')
  return next
}

/** Read the gzip index; returns null when missing or unreadable/corrupt. */
export async function readIndex() {
  try {
    const compressed = await readFile(indexPath())
    const raw = await gunzipAsync(compressed)
    const parsed = JSON.parse(raw.toString('utf8'))
    if (!parsed || parsed.version !== 1 || !isPlainObject(parsed.sessions)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Atomically write the gzip index ({ version: 1, generatedAt, sessions }) and
 * return the compressed byte size, for `status.indexBytes`.
 */
export async function writeIndex(index) {
  const payload = {
    version: 1,
    generatedAt: num(index && index.generatedAt),
    sessions: isPlainObject(index && index.sessions) ? index.sessions : {},
  }
  const compressed = await gzipAsync(Buffer.from(JSON.stringify(payload), 'utf8'))
  await atomicWrite(indexPath(), compressed)
  return compressed.length
}

/** Size of the on-disk index in bytes (0 when it does not exist yet). */
export async function indexFileSize() {
  try {
    const info = await stat(indexPath())
    return info.size
  } catch {
    return 0
  }
}
