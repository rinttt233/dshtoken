// Session indexer for @local/dshtoken.
//
// The guest services are all optional and are looked up through `ctx.get()`:
//   sessionQuery       — listSessions() / readSession(id)
//   sessionPersistence — list() / stat(id) (cheap cache invalidation keys)
//   sessions           — live store fallback
//
// The scan runs in the background, newest-first, sequential and yields between
// sessions so the HTTP event loop stays responsive. A scan is single-flight and
// the previous snapshot keeps being served until the new one is complete.
// Live `session/event` callbacks are buffered while a scan is running and are
// applied (guarded by per-entry lastSeq) right after the fold, so an append that
// lands mid-read is never lost and never double counted.
//
// No sibling lib imports here: http.js loads each module with a cache-busting
// query; store functions come in as parameters.

const MAX_ERRORS = 20

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function toInt(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

function str(value) {
  return typeof value === 'string' ? value : ''
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function usageObject(value) {
  return isPlainObject(value) ? value : null
}

/** Best-effort billed usage of an `assistant/attempt` (retry) event. */
function attemptUsage(data) {
  if (!isPlainObject(data)) return null
  if (isPlainObject(data.usage)) return data.usage
  const stream = Array.isArray(data.stream) ? data.stream : []
  for (let i = stream.length - 1; i >= 0; i--) {
    const item = stream[i]
    if (!isPlainObject(item) || item.type !== 'chunk') continue
    if (isPlainObject(item.chunk) && item.chunk.type === 'usage' && isPlainObject(item.chunk.usage)) {
      return item.chunk.usage
    }
  }
  return null
}

function token(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function toRecord(time, provider, model, usage) {
  // Record layout follows CONTRACT.md. In the installed DSH `inputTokens` is the
  // UNCACHED prompt input (see lib/cost.js for the verified semantics); it is
  // stored verbatim here so the cost engine owns the interpretation.
  return [
    token(time),
    provider || '',
    model || '',
    token(usage.inputTokens),
    token(usage.cacheReadTokens),
    token(usage.cacheWriteTokens),
    token(usage.outputTokens),
    token(usage.reasoningTokens),
  ]
}

function advance(target, seq, inherited) {
  if (inherited) return false
  if (seq <= target.lastSeq) return false
  target.lastSeq = seq
  return true
}

/**
 * Fold one event into `target` ({ records, lastProvider, lastModel, lastSeq }).
 * Events with seq < inheritedEventCount belong to the parent prefix: they are
 * never counted, but their request header/context still supplies the provider
 * and model attribution for the first own record. Records with seq <= lastSeq
 * are ignored (live double-count guard).
 */
function applyOne(target, event, floor) {
  if (!isPlainObject(event)) return false
  const seq = Number(event.seq)
  if (!Number.isFinite(seq)) return false
  const data = isPlainObject(event.data) ? event.data : {}
  const inherited = seq < floor
  if (event.type === 'request/header') {
    const config = isPlainObject(data.header) ? data.header.config : undefined
    if (isPlainObject(config)) {
      if (str(config.provider)) target.lastProvider = config.provider
      if (str(config.model)) target.lastModel = config.model
    }
    return advance(target, seq, inherited)
  }
  if (event.type === 'request/context') {
    if (str(data.provider)) target.lastProvider = data.provider
    if (str(data.model)) target.lastModel = data.model
    return advance(target, seq, inherited)
  }
  if (inherited) return false
  if (seq <= target.lastSeq) return false
  if (event.type === 'assistant/message') {
    const usage = usageObject(data.usage)
    if (usage) target.records.push(toRecord(event.time, target.lastProvider, target.lastModel, usage))
  } else if (event.type === 'assistant/attempt') {
    const usage = attemptUsage(data)
    if (usage) target.records.push(toRecord(event.time, target.lastProvider, target.lastModel, usage))
  }
  target.lastSeq = seq
  return true
}

/**
 * Pure fold used by the indexer and by tests. `initial` may carry a previous
 * fold state; the returned records array is a fresh copy.
 */
export function foldEvents(events, inheritedEventCount, initial) {
  const base = isPlainObject(initial) ? initial : {}
  const target = {
    records: Array.isArray(base.records) ? base.records.slice() : [],
    lastProvider: typeof base.lastProvider === 'string' ? base.lastProvider : '',
    lastModel: typeof base.lastModel === 'string' ? base.lastModel : '',
    lastSeq: Number.isFinite(base.lastSeq) ? base.lastSeq : -1,
  }
  const floor = toInt(inheritedEventCount)
  const list = Array.isArray(events) ? events : []
  for (const event of list) applyOne(target, event, floor)
  return {
    records: target.records,
    lastProvider: target.lastProvider,
    lastModel: target.lastModel,
    lastSeq: target.lastSeq,
  }
}

function skeletonEntry(header) {
  const h = isPlainObject(header) ? header : {}
  return {
    id: str(h.id),
    createdAt: num(h.createdAt),
    cwd: str(h.cwd),
    origin: h.origin === 'subagent' ? 'subagent' : null,
    parentSession: h.parentSession == null ? null : String(h.parentSession),
    delegationDepth: toInt(h.delegationDepth),
    eventCount: 0,
    sizeBytes: 0,
    lastSeq: -1,
    lastProvider: '',
    lastModel: '',
    records: [],
  }
}

function makeEntry(header, inheritedEventCount, events, cacheInfo) {
  const h = isPlainObject(header) ? header : {}
  const folded = foldEvents(events, inheritedEventCount)
  const info = isPlainObject(cacheInfo) ? cacheInfo : {}
  const eventCount = numericOrNull(info.eventCount)
  const sizeBytes = numericOrNull(info.sizeBytes)
  const entry = {
    id: str(h.id),
    createdAt: num(h.createdAt),
    cwd: str(h.cwd),
    origin: h.origin === 'subagent' ? 'subagent' : null,
    parentSession: h.parentSession == null ? null : String(h.parentSession),
    delegationDepth: toInt(h.delegationDepth),
    // 0 means "unknown" here: never store events.length as an eventCount, the
    // cache matcher must not mistake a local fallback for a persistence key.
    eventCount: eventCount !== null ? eventCount : 0,
    sizeBytes: sizeBytes !== null ? sizeBytes : 0,
    lastSeq: folded.lastSeq,
    lastProvider: folded.lastProvider,
    lastModel: folded.lastModel,
    records: folded.records,
  }
  // Revisions are only comparable within one persistence service instance, so
  // they live in memory and are stripped before the index is written.
  if (info.revision !== undefined) entry.revision = info.revision
  return entry
}

function numericOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function revisionOf(snapshot) {
  if (!isPlainObject(snapshot)) return null
  const revision = snapshot.revision
  return typeof revision === 'string' || typeof revision === 'number' ? revision : null
}

/** Cache-key fields a persistence snapshot/listing entry actually provides. */
export function cacheInfoOf(snapshot) {
  if (!isPlainObject(snapshot)) return {}
  const info = {}
  const eventCount = numericOrNull(snapshot.eventCount)
  const sizeBytes = numericOrNull(snapshot.sizeBytes)
  const revision = revisionOf(snapshot)
  if (eventCount !== null) info.eventCount = eventCount
  if (sizeBytes !== null) info.sizeBytes = sizeBytes
  if (revision !== null) info.revision = revision
  return info
}

function mergeCacheInfo(first, second) {
  const merged = { ...(first || {}) }
  const over = isPlainObject(second) ? second : {}
  for (const key of Object.keys(over)) {
    if (over[key] !== undefined) merged[key] = over[key]
  }
  return merged
}

function applyCacheInfo(entry, info) {
  if (!isPlainObject(entry) || !isPlainObject(info)) return
  if (info.eventCount !== undefined) entry.eventCount = info.eventCount
  if (info.sizeBytes !== undefined) entry.sizeBytes = info.sizeBytes
  if (info.revision !== undefined) entry.revision = info.revision
}

/**
 * Decide whether a cached index entry is unchanged relative to a persistence
 * snapshot. Returns true (reuse), false (definitely changed -> re-read) or null
 * (the snapshot does not carry a field strong enough to validate -> caller may
 * try one `sessionPersistence.stat(id)`, otherwise it must re-read).
 *
 * Matching rules, strongest available first:
 *  - both sides carry `sizeBytes` and a positive `sizeBytes`: sizes must match,
 *    and `eventCount` must also match when both sides carry it;
 *  - otherwise unknown.
 * A missing field is NEVER a match. A revision acts as a veto only when both
 * sides carry one (a loaded-from-disk revision is stripped, see start()).
 */
export function cacheMatch(cached, snapshot) {
  if (!isPlainObject(cached) || !isPlainObject(snapshot)) return null
  const size = numericOrNull(snapshot.sizeBytes)
  if (size === null || size <= 0) return null
  const cachedSize = numericOrNull(cached.sizeBytes)
  if (cachedSize === null || cachedSize <= 0) return null
  const eventCount = numericOrNull(snapshot.eventCount)
  const cachedEventCount = numericOrNull(cached.eventCount)
  if (eventCount !== null && cachedEventCount !== null && cachedEventCount !== eventCount) {
    return false
  }
  if (cachedSize !== size) return false
  const cachedRevision = revisionOf(cached)
  const snapshotRevision = revisionOf(snapshot)
  if (cachedRevision !== null && snapshotRevision !== null && cachedRevision !== snapshotRevision) {
    return false
  }
  return true
}

function sessionIdOf(session) {
  if (!session || typeof session !== 'object') return ''
  if (session.id !== undefined && session.id !== null) return str(session.id)
  const header = session.header
  return isPlainObject(header) ? str(header.id) : ''
}

function yieldToLoop() {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Per-scan cache-validation counters, surfaced by debug/probe. */
function emptyCacheStats() {
  return {
    list: 0,
    listSnapshots: 0,
    listWithEventCount: 0,
    listWithPositiveSize: 0,
    hits: 0,
    misses: 0,
    missing: 0,
    forced: 0,
    unvalidated: 0,
    statHits: 0,
    statMisses: 0,
    statUnavailable: 0,
    reReads: 0,
  }
}

/**
 * Create the session indexer. All guest services are optional; when none is
 * available the index stays empty and status reports services:false.
 */
export function createIndexer({ ctx, store, log }) {
  const logger = typeof log === 'function' ? log : () => {}
  const state = {
    alive: true,
    started: false,
    scanning: false,
    sessions: {},
    generatedAt: 0,
    indexBytes: 0,
    running: false,
    scanned: 0,
    total: 0,
    startedAt: 0,
    finishedAt: null,
    lastScanMs: 0,
    errors: [],
    liveBuffer: new Map(),
    cache: emptyCacheStats(),
  }
  let scanningPromise = null
  let pendingRebuild = false

  function service(name) {
    try {
      return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  function pushError(sessionId, error) {
    const message = String((error && (error.message || error.stack)) || error)
    state.errors.push({ sessionId: String(sessionId || ''), error: message })
    if (state.errors.length > MAX_ERRORS) state.errors.shift()
  }

  function hasReadSource() {
    const query = service('sessionQuery')
    if (query && typeof query.readSession === 'function') return true
    const persistence = service('sessionPersistence')
    return !!(persistence && typeof persistence.open === 'function')
  }

  async function persistenceSnapshotMap() {
    const persistence = service('sessionPersistence')
    if (!persistence || typeof persistence.list !== 'function') return new Map()
    try {
      const snapshots = await persistence.list()
      const map = new Map()
      for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
        const header = snapshot && snapshot.header
        const id = header ? str(header.id) : ''
        if (id) map.set(id, snapshot)
      }
      return map
    } catch {
      return new Map()
    }
  }

  async function listSessions() {
    const query = service('sessionQuery')
    if (query && typeof query.listSessions === 'function') {
      const records = await query.listSessions()
      // One persistence listing gives eventCount+sizeBytes for every stored
      // session, so cache validation needs no per-session stat() round trip.
      const snapshotMap = await persistenceSnapshotMap()
      return (Array.isArray(records) ? records : []).map((record) => {
        const header = (record && record.header) || {}
        const id = str(header.id)
        return { id, header, snapshot: snapshotMap.get(id) }
      })
    }
    const persistence = service('sessionPersistence')
    if (persistence && typeof persistence.list === 'function') {
      const snapshots = await persistence.list()
      return (Array.isArray(snapshots) ? snapshots : []).map((snapshot) => ({
        id: str(snapshot && snapshot.header && snapshot.header.id),
        header: (snapshot && snapshot.header) || {},
        snapshot,
      }))
    }
    const sessions = service('sessions')
    if (sessions && typeof sessions.list === 'function') {
      const live = sessions.list()
      return (Array.isArray(live) ? live : []).map((session) => ({
        id: sessionIdOf(session),
        header: (session && session.header) || {},
        snapshot: undefined,
      }))
    }
    return []
  }

  async function statOf(sessionId) {
    const persistence = service('sessionPersistence')
    if (!persistence || typeof persistence.stat !== 'function') return undefined
    try {
      return await persistence.stat(sessionId)
    } catch {
      return undefined
    }
  }

  async function readLog(sessionId) {
    const query = service('sessionQuery')
    if (query && typeof query.readSession === 'function') {
      const snapshot = await query.readSession(sessionId)
      if (!snapshot) return null
      return {
        session: snapshot.session || {},
        inheritedEventCount: toInt(snapshot.inheritedEventCount),
        events: Array.isArray(snapshot.events) ? snapshot.events : [],
      }
    }
    const persistence = service('sessionPersistence')
    if (persistence && typeof persistence.open === 'function') {
      const handle = await persistence.open(sessionId, 'read')
      try {
        const result = await handle.read()
        return {
          session: (handle && handle.header) || {},
          inheritedEventCount: toInt(handle && handle.inheritedEventCount),
          events: Array.isArray(result && result.events) ? result.events : [],
        }
      } finally {
        try {
          await handle.close()
        } catch {
          /* read handle close is best effort */
        }
      }
    }
    return null
  }

  function drainLiveBuffer(target) {
    if (!state.liveBuffer || state.liveBuffer.size === 0) return
    for (const [id, buffer] of state.liveBuffer) {
      let entry = target[id]
      if (!entry) {
        entry = skeletonEntry({ ...(buffer.header || {}), id })
        target[id] = entry
      }
      const events = buffer.events
        .slice()
        .sort((a, b) => num(a && a.seq) - num(b && b.seq))
      for (const event of events) applyOne(entry, event, buffer.floor)
    }
    state.liveBuffer.clear()
  }

  async function doScan(force) {
    const startedAt = Date.now()
    state.running = true
    state.scanning = true
    state.startedAt = startedAt
    state.finishedAt = null
    state.scanned = 0
    state.total = 0
    state.errors = []
    state.liveBuffer = new Map()
    state.cache = emptyCacheStats()
    const previous = state.sessions

    const items = await listSessions()
    if (!state.alive) return
    items.sort((a, b) => num(b.header && b.header.createdAt) - num(a.header && a.header.createdAt))
    state.total = items.length
    state.cache.list = items.length
    for (const item of items) {
      if (!isPlainObject(item.snapshot)) continue
      state.cache.listSnapshots += 1
      if (numericOrNull(item.snapshot.eventCount) !== null) state.cache.listWithEventCount += 1
      if ((numericOrNull(item.snapshot.sizeBytes) || 0) > 0) state.cache.listWithPositiveSize += 1
    }
    const next = {}

    for (const item of items) {
      if (!state.alive) return
      const id = str(item.id)
      if (!id) {
        state.scanned += 1
        continue
      }
      const cached = previous[id]
      let cacheInfo = cacheInfoOf(item.snapshot)
      let statSnapshot
      try {
        let matched = false
        if (cached && !force) {
          const verdict = cacheMatch(cached, item.snapshot)
          if (verdict === true) {
            matched = true
            state.cache.hits += 1
            // Keep the entry's persisted key in sync with what the listing
            // actually provides (a snapshot may omit one of the fields).
            applyCacheInfo(cached, cacheInfo)
          } else if (verdict === null) {
            // The listing cannot validate this entry: one cheap per-session
            // stat() is the only fallback (never match on a missing field).
            state.cache.unvalidated += 1
            statSnapshot = await statOf(id)
            if (statSnapshot) {
              const statInfo = cacheInfoOf(statSnapshot)
              cacheInfo = mergeCacheInfo(cacheInfo, statInfo)
              if (cacheMatch(cached, statSnapshot) === true) {
                matched = true
                state.cache.statHits += 1
                state.cache.hits += 1
                applyCacheInfo(cached, statInfo)
              } else {
                state.cache.statMisses += 1
              }
            } else {
              state.cache.statUnavailable += 1
            }
          }
          if (!matched) state.cache.misses += 1
        } else if (cached) {
          state.cache.forced += 1
        } else {
          state.cache.missing += 1
        }

        if (matched) {
          next[id] = cached
        } else {
          // Persist the best cache key available: if the listing carried no
          // positive sizeBytes, one stat() supplies it for the next warm scan.
          if ((numericOrNull(cacheInfo.sizeBytes) || 0) <= 0) {
            if (statSnapshot === undefined) statSnapshot = await statOf(id)
            cacheInfo = mergeCacheInfo(cacheInfo, cacheInfoOf(statSnapshot))
          }
          state.cache.reReads += 1
          const log = await readLog(id)
          if (log) next[id] = makeEntry(log.session || item.header, log.inheritedEventCount, log.events, cacheInfo)
          else if (cached) next[id] = cached
          else next[id] = skeletonEntry(item.header)
        }
      } catch (error) {
        pushError(id, error)
        if (cached) next[id] = cached
        else next[id] = skeletonEntry(item.header)
      }
      state.scanned += 1
      await yieldToLoop()
      if (!state.alive) return
    }

    // Apply buffered live events, then swap synchronously: no live callback can
    // interleave between the merge and the snapshot swap.
    drainLiveBuffer(next)
    state.sessions = next
    state.generatedAt = Date.now()
    state.finishedAt = state.generatedAt
    state.lastScanMs = state.generatedAt - startedAt
    state.scanning = false

    try {
      // Strip in-memory revisions: a revision token is only comparable inside
      // one persistence service instance, so a persisted one must not validate
      // a cache entry after a DSH restart.
      const persisted = {}
      for (const sessionId of Object.keys(next)) {
        const entry = next[sessionId]
        persisted[sessionId] =
          entry && entry.revision !== undefined ? { ...entry, revision: undefined } : entry
      }
      const bytes = await store.writeIndex({
        version: 1,
        generatedAt: state.generatedAt,
        sessions: persisted,
      })
      state.indexBytes = bytes
    } catch (error) {
      logger('warn', 'failed to write index cache', String((error && error.message) || error))
    }
    // Only report the scan as finished once the cache is on disk, so status
    // polling never observes a "done" scan with a stale indexBytes.
    state.running = false
  }

  function runScan(force) {
    if (scanningPromise) {
      if (force) pendingRebuild = true
      return scanningPromise
    }
    scanningPromise = (async () => {
      try {
        await doScan(force)
      } catch (error) {
        pushError('*', error)
        logger('error', 'scan failed', String((error && error.stack) || error))
      } finally {
        state.running = false
        state.scanning = false
        // A failed scan leaves the old snapshot in place; still apply the live
        // events that arrived while it ran so no usage is lost.
        drainLiveBuffer(state.sessions)
        scanningPromise = null
        if (pendingRebuild && state.alive) {
          pendingRebuild = false
          void runScan(true)
        }
      }
    })()
    return scanningPromise
  }

  async function start() {
    if (state.started) return
    state.started = true
    try {
      const cached = await store.readIndex()
      if (cached && isPlainObject(cached.sessions)) {
        // A revision token from disk is not comparable with this process'
        // persistence service instance, so strip it before it can veto a hit.
        const loaded = {}
        for (const id of Object.keys(cached.sessions)) {
          const entry = cached.sessions[id]
          if (!isPlainObject(entry)) continue
          if (entry.revision === undefined) loaded[id] = entry
          else {
            const copy = { ...entry }
            delete copy.revision
            loaded[id] = copy
          }
        }
        // Live events applied while the cache was loading win over the disk copy.
        state.sessions = Object.assign({}, loaded, state.sessions)
        state.generatedAt = num(cached.generatedAt)
        state.indexBytes = await store.indexFileSize()
      }
    } catch (error) {
      logger('warn', 'failed to read index cache', String((error && error.message) || error))
    }
    void runScan(false)
  }

  function rebuild() {
    void runScan(true)
    return { started: true }
  }

  function status() {
    const ids = Object.keys(state.sessions)
    let records = 0
    for (const id of ids) {
      const entry = state.sessions[id]
      if (entry && Array.isArray(entry.records)) records += entry.records.length
    }
    return {
      running: !!state.running,
      scanned: num(state.scanned),
      total: num(state.total),
      startedAt: num(state.startedAt),
      finishedAt: state.finishedAt == null ? null : state.finishedAt,
      lastScanMs: num(state.lastScanMs),
      sessions: ids.length,
      records,
      indexBytes: num(state.indexBytes),
      errors: state.errors.slice(0, MAX_ERRORS),
      version: 1,
      services: {
        sessionQuery: !!service('sessionQuery'),
        sessionPersistence: !!service('sessionPersistence'),
      },
    }
  }

  function snapshot() {
    return { generatedAt: state.generatedAt, sessions: state.sessions }
  }

  async function ensureSession(id) {
    const sessionId = str(id)
    if (!sessionId) return null
    const entry = state.sessions[sessionId]
    // A live session is kept current by the `session/event` feed, so its entry
    // is authoritative and a stat/log re-read would only add cost.
    if (entry && isLiveSession(sessionId)) return entry
    if (entry && state.scanning) return entry
    if (entry && !hasReadSource()) return entry
    let snapshotStat = await statOf(sessionId)
    if (entry && (!snapshotStat || cacheMatch(entry, snapshotStat) === true)) return entry
    try {
      const log = await readLog(sessionId)
      if (!log) return entry || null
      const fresh = makeEntry(
        log.session || (entry && { id: sessionId, cwd: entry.cwd, createdAt: entry.createdAt }) || {},
        log.inheritedEventCount,
        log.events,
        snapshotStat,
      )
      if (fresh.id) {
        if (!state.scanning) state.sessions[sessionId] = fresh
        return fresh
      }
    } catch (error) {
      logger('warn', 'on-demand session read failed', sessionId, String((error && error.message) || error))
    }
    return entry || null
  }

  function isLiveSession(sessionId) {
    const sessions = service('sessions')
    if (!sessions || typeof sessions.get !== 'function') return false
    try {
      return !!sessions.get(sessionId)
    } catch {
      return false
    }
  }

  function applyLive(session, event) {
    if (!state.alive || !isPlainObject(event)) return
    const id = sessionIdOf(session)
    if (!id) return
    const floor = toInt(session && session.inheritedEventCount)
    if (state.scanning) {
      let buffer = state.liveBuffer.get(id)
      if (!buffer) {
        buffer = { events: [], floor, header: session && session.header }
        state.liveBuffer.set(id, buffer)
      }
      buffer.events.push(event)
      return
    }
    let entry = state.sessions[id]
    if (!entry) {
      entry = skeletonEntry({ ...((session && session.header) || {}), id })
      state.sessions[id] = entry
    }
    applyOne(entry, event, floor)
  }

  function dispose() {
    state.alive = false
    state.scanning = false
    if (state.liveBuffer) state.liveBuffer.clear()
  }

  function cacheStats() {
    return {
      ...state.cache,
      lastScanMs: num(state.lastScanMs),
      running: !!state.running,
      indexedSessions: Object.keys(state.sessions).length,
    }
  }

  function fieldShape(value) {
    if (value === undefined) return 'absent'
    if (value === null) return 'null'
    if (typeof value === 'number' || typeof value === 'string') {
      return typeof value + ':' + String(value).slice(0, 64)
    }
    return typeof value
  }

  function snapshotShape(snapshot) {
    if (!isPlainObject(snapshot)) return null
    const header = isPlainObject(snapshot.header) ? snapshot.header : {}
    return {
      keys: Object.keys(snapshot),
      id: header.id === undefined ? null : String(header.id),
      eventCount: fieldShape(snapshot.eventCount),
      sizeBytes: fieldShape(snapshot.sizeBytes),
      revision: fieldShape(snapshot.revision),
      formatStatus: fieldShape(snapshot.formatStatus),
      locationKind:
        snapshot.location && typeof snapshot.location === 'object'
          ? String(snapshot.location.kind)
          : 'absent',
    }
  }

  /**
   * Diagnostic probe (debug endpoint with `{ probe: true }`): reports exactly
   * which cache-key fields the persistence listing/stat actually provide, plus
   * the last scan's cache-validation counters. One listing + one stat() call.
   */
  async function probe() {
    const persistence = service('sessionPersistence')
    const out = {
      available: !!persistence,
      services: {
        sessionQuery: !!service('sessionQuery'),
        sessionPersistence: !!persistence,
      },
      cache: cacheStats(),
      list: null,
      stat: null,
    }
    if (!persistence) return out
    let samples = []
    if (typeof persistence.list === 'function') {
      try {
        const listed = await persistence.list()
        samples = Array.isArray(listed) ? listed : []
        out.list = {
          count: samples.length,
          withEventCount: samples.filter((snapshot) => numericOrNull(snapshot && snapshot.eventCount) !== null)
            .length,
          withPositiveSizeBytes: samples.filter(
            (snapshot) => (numericOrNull(snapshot && snapshot.sizeBytes) || 0) > 0,
          ).length,
          withRevision: samples.filter(
            (snapshot) => isPlainObject(snapshot) && snapshot.revision !== undefined,
          ).length,
          withHeader: samples.filter(
            (snapshot) => isPlainObject(snapshot) && isPlainObject(snapshot.header),
          ).length,
          sample: samples.length ? snapshotShape(samples[0]) : null,
        }
      } catch (error) {
        out.list = { error: String((error && error.message) || error) }
      }
    }
    const first = samples.find(
      (snapshot) => isPlainObject(snapshot) && isPlainObject(snapshot.header) && str(snapshot.header.id),
    )
    if (first && typeof persistence.stat === 'function') {
      try {
        out.stat = snapshotShape(await persistence.stat(str(first.header.id)))
      } catch (error) {
        out.stat = { error: String((error && error.message) || error) }
      }
    }
    return out
  }

  return { start, rebuild, status, snapshot, ensureSession, applyLive, dispose, cacheStats, probe }
}
