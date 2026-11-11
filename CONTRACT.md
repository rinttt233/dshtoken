# @local/dshtoken — build contract

Read this file completely before writing code. It is the single source of truth for
the Host API, the data model, and the Client fragment interfaces. Do not change
another owner's file.

Plugin package: this repository's checkout (installed into a DSH `desktop` profile).
Package name: `@local/dshtoken`. Client bundle id must equal the package name.

## Ownership / write scopes

| Owner | Files | Scope |
|---|---|---|
| Lead | `index.js`, `package.json`, `cordis.patch.yml`, `icon.svg`, `locale/*.json`, `scripts/*`, `src/client/shared.js`, `src/client/main.js`, `README.md`, `CONTRACT.md` | shell, build, shared client runtime, install/verify |
| host | `lib/store.js`, `lib/cost.js`, `lib/scan.js`, `lib/aggregate.js`, `lib/http.js`, `scripts/host-selftest.mjs`, `scripts/fixtures/**` | all Host logic |
| client-page | `src/client/page.js` | standalone statistics page |
| client-chart | `src/client/chart.js` | SVG bar chart component |
| client-dock | `src/client/dock.js` | composer usage chip replacement |

Only edit files you own. Never run `plugin_manager`, never reinstall, never edit
`index.js`, `src/client/shared.js`, or `src/client/main.js`.

## Environment facts (already verified by the Lead)

- DSH is a desktop profile; the Web GUI is served by the Host `webServer` service.
  A profile plugin reaches the browser with a same-origin `fetch` to a
  `webServer.register({kind:'prefix', path})` route — this exact pattern already
  ships in this profile (`dsh-prompt-optimizer`). Do not use `connection.rpc`.
- The Host shell (`index.js`) re-imports `lib/http.js` (and its siblings) with a
  cache-busting query on every request when lib file mtimes change, so **Host code
  edits are live on the next HTTP request**. Only `index.js` needs a DSH restart.
- A Client change needs `node scripts/build-client.mjs` and one page refresh.
- `sessionQuery` (Host service) enumerates and reads session logs, including
  persisted/live sessions; `sessionPersistence.stat(id)` gives `eventCount` +
  `sizeBytes` for cache invalidation.
- Session logs are gzip/zstd-compressed JSONL of typed events. Reading all 333
  sessions is a one-time heavy scan: do it in the background, write an index cache
  under `$DSH_HOME/plugin-data/dshtoken/`, and report progress.

## Record and usage semantics

Provider usage is recorded on `assistant/message` events as
`TokenUsage { inputTokens, outputTokens, totalTokens?, cacheReadTokens?,
cacheWriteTokens?, reasoningTokens? }`.

- **`inputTokens` is the UNCACHED prompt input in this DSH build** (the adapter maps
  it from provider `usage.input` after subtracting cached and cache-write tokens;
  verified against the live corpus: `totalTokens === inputTokens + outputTokens +
  cacheReadTokens + cacheWriteTokens` on 100 % of sampled records, and
  `cacheReadTokens > inputTokens` in 99 % of them). Therefore:
  `uncachedInput = inputTokens` (do not subtract `cacheReadTokens` again), and the
  Part total is `inputTokens + cacheRead + cacheWrite + output`.
- `reasoningTokens` is a subset of `outputTokens` (do not add it again).
- Provider/model for an `assistant/message` is the latest preceding
  `request/header` (`data.header.config.provider/model`) or `request/context`
  (`data.provider/model`), whichever is later in the log.
- Only own events count: skip events with `seq < inheritedEventCount`. A forked
  session inherits its parent's prefix; counting it again would double spend.
  `sessionQuery.readSession(id)` returns `{ session, inheritedEventCount, events }`.
- `assistant/attempt` events carry no `usage` field, but a retried attempt may have
  a `usage` stream chunk inside `data.stream` (`{type:'chunk', chunk:{type:'usage',
  usage}}`). Best effort: take the last such sample as one billed attempt.
- Timestamps are `event.time` (epoch ms).

## Record and index data model

A usage record is a compact array (JSON-stable):

```
[t, provider, model, inputTokens, cacheRead, cacheWrite, output, reasoning]
```

- `t`: epoch ms (event.time)
- `provider`, `model`: strings (may be `''` when the log has no header yet)
- `inputTokens`: total prompt tokens (`0` when absent)
- `cacheRead`, `cacheWrite`, `output`, `reasoning`: `0` when absent

Index entry per session (JSON, keyed by session id):

```jsonc
{
  "id": "session-…",
  "createdAt": 1700000000000,        // header.createdAt
  "cwd": "D:/game/dsh",             // header.cwd or ""
  "origin": "subagent",             // header.origin or null
  "parentSession": null,            // header.parentSession or null
  "delegationDepth": 0,
  "eventCount": 1234,               // cache key from sessionPersistence.stat
  "sizeBytes": 456789,              // cache key from sessionPersistence.stat
  "lastSeq": 1233,                  // last folded seq
  "lastProvider": "deepseek-official",
  "lastModel": "deepseek-flash",
  "records": [[t, provider, model, input, cacheRead, cacheWrite, output, reasoning], …]
}
```

Index file: `$DSH_HOME/plugin-data/dshtoken/index.json.gz` (gzip JSON):
`{ version: 1, generatedAt, sessions: { [id]: entry } }`.
Config file: `$DSH_HOME/plugin-data/dshtoken/config.json`:
same directory convention as `dsh-plugin-iot-thinking`
(`process.env.DSH_HOME || join(homedir(), '.dsh')`, then `plugin-data/dshtoken`).

## Cost model

Prices are CNY per **one million tokens**, edited in the UI. `undefined`/missing
price ⇒ that model contributes **0 cost** and is reported as unpriced (only tokens
are counted). Non-official models are unpriced by default, exactly as requested.

Config shape (defaults come from `lib/cost.js > DEFAULT_CONFIG`):

```jsonc
{
  "version": 1,
  "currency": "CNY",
  "timezoneOffsetMinutes": 480,          // Asia/Shanghai; used for buckets AND peak windows
  "prices": {
    "deepseek-official/deepseek-flash": { "hit": 0.02, "miss": 1, "write": 0, "out": 4, "peakMultiplier": 2 },
    "deepseek-official/deepseek-v4-pro": { "hit": 0.15, "miss": 4.5, "write": 0, "out": 13.5, "peakMultiplier": 2 }
  },
  "peak": {
    "enabled": true,
    "days": [1, 2, 3, 4, 5],             // ISO weekday, 1 = Monday; weekends idle
    "windows": [                          // minutes of day in the statistics timezone
      { "start": 540, "end": 720 },       // 09:00–12:00
      { "start": 840, "end": 1080 }       // 14:00–18:00
    ],
    "holidays": []                        // 'YYYY-MM-DD' local dates treated as idle
  },
  "prefs": {}                             // free-form; the UI may persist view state here
}
```

Official DeepSeek rates (used for the built-in defaults; idle rates, peak = ×2):
`deepseek-flash`: hit 0.02 / miss 1 / out 4; `deepseek-v4-pro`: hit 0.15 /
miss 4.5 / out 13.5. Peak windows above are the official peak definition; other
times, weekends and listed holidays are idle. `deepseek-v4-flash` and
`deepseek-v4-flash-vision-exp` are legacy alias names billed as Flash: include the
same defaults for them when convenient.

Cost of one record:

```
peak = isPeak(t, config.peak, config.timezoneOffsetMinutes) ? (price.peakMultiplier ?? 2) : 1
cost = (uncachedInput * price.miss + cacheRead * price.hit
        + cacheWrite * (price.write ?? 0) + output * price.out) / 1e6 * peak
```

Price lookup: exact `provider/model` → `provider/*` → `*/model` → unpriced.
(`*/model` is only present when the user explicitly configures it.)

`isPeak(t)`: convert `t` to statistics-timezone wall clock; local weekday must be in
`peak.days`; local date must not be in `peak.holidays`; local minute-of-day must
fall in one `[start, end)` window.

## Bucket rules

- Range is `[from, to)` in epoch ms; effective granularity is returned in the
  response (`bucket` may be `auto` in the request).
- `auto`: span ≤ 2 days → `hour`; ≤ 62 days → `day`; ≤ 400 days → `week`; else `month`.
- Boundaries are computed in `config.timezoneOffsetMinutes`; week starts Monday;
  month is the calendar month. Buckets are clipped to `[from, to)` and only
  returned when they intersect data potential (return the full range is fine).
- `too-many-buckets` (≤ 1000 allowed) is a 200 response with `ok:false`.

## Host API

All endpoints are `POST /dshtoken/api/<method>` with a JSON body; every response is
`{ "ok": true, "value": … }` or `{ "ok": false, "error": { "code", "details" } }`.
Max body 2 MiB. Unknown method → `ok:false, code:'unknown-method'`. The route
registration and method dispatch live in `lib/http.js`; `http.js` exports
`createApp({ ctx, version, log })` returning `{ handle(req, res), dispose(),
status() }`.

Shared `Part` object used everywhere:

```ts
type Part = {
  tokens: number;      // miss + hit + write + out
  cost: number;        // CNY (0 for unpriced records)
  miss: number;
  hit: number;
  write: number;
  out: number;
  reasoning: number;   // informational only (subset of out)
  requests: number;
}
```

### `status` → body `{}`

```jsonc
{ "running": true, "scanned": 12, "total": 333, "startedAt": 0, "finishedAt": null,
  "lastScanMs": 0, "sessions": 12, "records": 340, "indexBytes": 12345,
  "errors": [{ "sessionId": "…", "error": "…" }], "version": 1,
  "services": { "sessionQuery": true, "sessionPersistence": true } }
```

### `meta` → body `{}`

```jsonc
{ "generatedAt": 0, "timezoneOffsetMinutes": 480, "currency": "CNY",
  "timeRange": { "from": 0, "to": 0 },           // null when no records
  "providers": [{ "key": "deepseek-official", "tokens": 0, "requests": 0, "priced": true }],
  "models": [{ "key": "deepseek-official/deepseek-flash", "provider": "…", "model": "…",
               "tokens": 0, "requests": 0, "priced": true }],
  "cwds": [{ "path": "D:/game/dsh", "tokens": 0 }],
  "sessions": { "indexed": 12, "total": 333, "withUsage": 10 },
  "config": { },                                  // full config
  "defaults": { } }                               // DEFAULT_CONFIG
```

### `stats` → body

```jsonc
{ "from": 0, "to": 0,                       // required epoch ms
  "bucket": "auto",                         // auto|hour|day|week|month
  "groupBy": "category",                    // category|provider|model|session
  "metric": "tokens",                       // tokens|cost (affects dim ranking only)
  "models": ["deepseek-official/deepseek-flash"],  // optional; empty/absent = all
  "providers": ["deepseek-official"],       // optional
  "includeSubagents": true,                 // default true; false = merge subagent rows into their owning main session (totals unchanged)
  "cwds": [] }                              // optional path filter
```

Value:

```jsonc
{ "from": 0, "to": 0, "bucket": "day", "groupBy": "category", "metric": "tokens",
  "timezoneOffsetMinutes": 480, "currency": "CNY",
  "buckets": [{ "t0": 0, "t1": 0,
                "total": Part,
                "byDim": { "<dimKey>": Part } }],
  "dims": [{ "key": "hit", "label": "hit", "kind": "category" },
           { "key": "deepseek-official", "label": "deepseek-official", "kind": "provider" },
           { "key": "session-…", "label": "dsh", "kind": "session" }],
  "totals": Part,
  "summary": {
    "totalTokens": 0, "totalCost": 0, "pricedTokens": 0, "unpricedTokens": 0,
    "cacheHitRate": 0, "requests": 0, "sessions": 0, "days": 1,
    "avgPerDayTokens": 0,
    "peakBucket": { "t0": 0, "tokens": 0, "cost": 0 }    // null when empty
  },
  "notes": {
    "partial": false,
    "indexProgress": { "scanned": 333, "total": 333, "running": false },
    "unpricedModels": [{ "key": "lgd-claude/claude-opus-5-5", "tokens": 0 }],
    "filters": { "models": [], "providers": [], "includeSubagents": true, "cwds": [] }
  },
  "generatedAt": 0 }
```

Rules:

- `dims` order defines stacked series order; the Client must not reorder it.
- `groupBy: "category"` → keys `hit`, `miss`, `write`, `out` (kind `category`); the
  Client localizes their labels. `reasoning` is never a stacked series.
- `groupBy` provider/model/session → keep the top **20** (12 for session) by the
  requested metric and merge the remainder into `{ "key": "__other", "kind": <same> }`
  (label `other`; the Client localizes `__other`). A bucket's `byDim` may omit keys
  that are zero.
- Every `Part` in `byDim` is the same shape; `cost` is that dimension's cost.
- Records with an unpriced model contribute tokens but `cost = 0`; list those model
  keys in `notes.unpricedModels`.
- All filtering happens on records before aggregation, so `summary`/`totals` honor
  filters.

### `bucketSessions` → body (added after the initial delivery)

```jsonc
{ "from": 0, "to": 0, "metric": "tokens",   // tokens|cost
  "models": [], "providers": [], "cwds": [], // same filters as stats
  "includeSubagents": true,
  "limit": 60 }                              // default 60, clamped 1..200
```

Value: `{ from, to, metric, currency, total: Part, sessionCount, truncated,
sessions: [{ key, label, title, tokens, cost, requests, miss, hit, write, out,
reasoning }], notes: { partial, unpricedModels, timezoneOffsetMinutes } }`.

- One bucket range is the normal use (the chart passes a single bucket's `t0..t1`).
- Real session ids (never `__other`); sort `metric` DESC → `requests` DESC → key ASC;
  `truncated = sessions.length < sessionCount`.
- `label` is the cwd basename (fallback short id); `title` is best-effort for at
  most the first 30 rows (1 s cap, empty string otherwise).
- Filters and cost semantics match `stats`. Empty range → zero Part and `sessions: []`.

### `session` → body `{ sessionId }`

```jsonc
{ "sessionId": "…", "found": true, "title": "…", "cwd": "…",
  "tokens": { "tokens": 0, "miss": 0, "hit": 0, "write": 0, "out": 0,
              "reasoning": 0, "requests": 0, "cost": 0 },
  "cacheHitRate": 0, "firstTime": 0, "lastTime": 0,
  "models": [{ "key": "provider/model", "tokens": 0, "requests": 0, "cost": 0 }],
  "unpricedTokens": 0,
  "global": { "today": { "tokens": 0, "cost": 0 },
              "all": { "tokens": 0, "cost": 0 } } }
```

If the session is not indexed yet, read it on demand with
`sessionQuery.readSession`; if that fails, return `found:false` with defaults.

### `titles` → body `{ ids: ["…"] }`

`{ "<id>": { "title": "…", "cwd": "…" } }` — unknown ids are omitted.

### `config` → body `{}` (read) or `{ "patch": { … } }` (write)

`{ "config": {…}, "defaults": {…} }`. `patch` is shallow-merged per top-level key
(`prices` replaces the whole map). Invalid patch → `ok:false, code:'bad-config'`.

### `rebuild` → body `{}`

`{ "started": true }` — kicks a full re-scan (single flight, keeps serving the old
index until the new scan finishes; delete stale entries only after success).

### `debug` → body `{}`

Free-form diagnostic object (config without secrets, index summary, last 20 scan
errors, timing). No secrets are stored by this plugin.

## Host module interfaces (host owner)

`lib/http.js` is the entry: `export async function createApp({ ctx, version, log })`.
It loads siblings itself with the same query so they hot-reload too:

```js
const [store, cost, aggregate, scan] = await Promise.all([
  import('./store.js?v=' + version),
  import('./cost.js?v=' + version),
  import('./aggregate.js?v=' + version),
  import('./scan.js?v=' + version),
])
```

Keep sibling modules free of relative imports (they would resolve without the query
and go stale). Pass cross-module functions as parameters instead.

Required exports:

- `lib/store.js`
  - `export function dataDir()`; `export function mergeConfig(raw, defaults)`
  - `export async function readConfig(defaults)`; `export async function writeConfig(patch, defaults)`
  - `export async function readIndex()`; `export async function writeIndex(index)`
    (atomic: tmp file + rename; gzip)
- `lib/cost.js`
  - `export const DEFAULT_CONFIG` (full config object)
  - `export function resolvePrice(config, provider, model)` → `{hit,miss,write,out,peakMultiplier}` | `null`
  - `export function isPeak(t, config)`
  - `export function recordPart(record, config)` → `Part`
  - `export function addPart(target, part)` helper (used by aggregate)
  - `export function dimCost(config, provider, model, parts)`
- `lib/scan.js`
  - `export function foldEvents(events, inheritedEventCount, initial)` → `{ records, lastProvider, lastModel, lastSeq }` (pure; used by tests)
  - `export function createIndexer({ ctx, store, log })` → `{ start(), rebuild(), status(), snapshot(), ensureSession(id), applyLive(session, event), dispose() }`
  - `snapshot()` → `{ generatedAt, sessions: { [id]: entry } }`
  - `ensureSession(id)` → entry | null (on-demand read for the dock)
  - `applyLive` is registered by `http.js` on the `session/event` emit feed.
- `lib/aggregate.js` (pure; receives the index snapshot)
  - `export function normalizedQuery(body, config)` → validated query or throws Error with `code`
  - `export function aggregate(snapshot, config, query, cost)` → the `stats` value
  - `export function meta(snapshot, config, cost)` → the `meta` value
  - `export function sessionSummary(snapshot, config, cost, sessionId)` → the `session` value (minus title/global handling done in http)
  - `export function bucketPlan(query, config)` internally

`http.js` registers `ctx.on('session/event', (session, event) => indexer.applyLive(session, event))`
and disposes it in `dispose()`. Only services reachable via `ctx.get` may be
optional: `sessionQuery`, `sessionPersistence`, `sessions`. Never hard-inject them.

## Client fragments (client owners)

The build concatenates `shared.js`, `chart.js`, `page.js`, `dock.js`, `main.js`
inside one factory function. Rules:

- Use `var` + `function` declarations only at fragment top level (no `const`/`let` at
  top level, no import/export). Prefix top-level names with your file (`DshChart…`,
  `DshTokenPage…`, `DshTokenUsageDock…`).
- React comes from `require('react')`, already bound to `React` and `h`.
  `react-dom` (portal) is available through `DshPortal`; never require other
  packages.
- Do not touch other fragments. No DOM work at load time; inside components fine.
- Text: use the `t` prop (`var t = dshtokenUseT(props)`) and add keys under your own
  `DSHTOKEN_I18N_<FILE>` dictionary (`zh` + `en`). Shared `common.*` and `cat.*`
  keys already exist.
- Colors: only theme tokens (`--dsw-alias-*`) or `color-mix(...)` of tokens. Chart
  series colors: derive them from `--dsw-alias-brand-primary` and the state tokens
  with `color-mix` so light/dark follow automatically.
- Accessibility: buttons have `type="button"`, icon-only controls get
  `title`/`aria-label`, dialogs expose `role="dialog"` + `aria-modal`
  (`DshDialog` does this).
- Every component must survive missing `props.t`/`props.inject` and render an
  error/empty state instead of throwing (a thrown slot entry blanks the slot).

Shared helpers available in the factory scope (from `shared.js`):

```
constants   DSHTOKEN_NS, DSHTOKEN_PANEL, DSHTOKEN_API
i18n        DSHTOKEN_I18N, dshtokenMergeDicts, dshtokenT, dshtokenUseT,
            dshtokenUseLocaleRevision, dshtokenSetDicts, dshtokenNotifyLocale
api         dshtokenApi(method, payload) → Promise<value>  (throws Error with .code)
format      dshtokenFmtInt, dshtokenFmtTokens, dshtokenFmtCost(value, currency),
            dshtokenFmtPct
dates       dshtokenOffsetMs(minutes), dshtokenStartOfDay(ms, off),
            dshtokenStartOfMonth(ms, off), dshtokenFmtDate, dshtokenFmtTime,
            dshtokenFmtDateTime, dshtokenFmtBucketLabel(t0, bucket, off),
            dshtokenFmtBucketRange(t0, bucket, off), dshtokenParseDateInput(value, off, end),
            dshtokenFmtInputDate(ms, off), dshtokenAddDays(ms, days)
hooks       dshtokenUseAsync(fn, deps) → {data,error,loading,reload,setData}
            dshtokenUsePersisted(key, initial) → [value, setValue]
            dshtokenUseInterval(cb, delay, enabled)
            dshtokenUseVisible() → boolean
ui          DshIcon({name,size}), DshSpinner, DshStyle({id,css}), DshPortal,
            DshDialog({open,title,onClose,children,footer,width,closeLabel}),
            DshPopover({open,x,y,width,align,onClose,children}),
            DshSegmented({value,options:[{value,label,title}],onChange,ariaLabel}),
            DshCheckbox({checked,onChange,title,disabled}), DshProgress({value}),
            DshEmpty({title,hint,icon}), DshErrorBox({error,onRetry,retryLabel})
css         DSHTOKEN_BASE_CSS is already installed by main.js; reuse its classes
            (.dsht-page, .dsht-row, .dsht-col, .dsht-panel, .dsht-card, .dsht-btn,
            .dsht-input, .dsht-select, .dsht-table, .dsht-table-wrap, .dsht-chip,
            .dsht-legend*, .dsht-pop*, .dsht-dialog*, .dsht-empty, .dsht-error,
            .dsht-muted, .dsht-mono, .dsht-warn, .dsht-hint, .dsht-dock…)
```

### `chart.js` — required component

`function DshTokenChart(props)` — pure SVG stacked bar chart, no DOM reads beyond
its own container; mounted by `page.js`.

Props:

```js
{
  buckets,            // stats value.buckets
  dims,               // stats value.dims
  metric,             // 'tokens' | 'cost'
  bucket,             // effective bucket: hour|day|week|month
  offsetMs,           // config.timezoneOffsetMinutes * 60000
  currency,           // 'CNY'
  activeDims,         // string[] of dim keys currently visible
  onToggleDim(key),
  onPickBucket(t0, t1),   // click a bar
  onSelectRange(from, to),// drag-select a time range
  height,             // px number
  loading,            // boolean
  emptyTitle,         // string (already translated)
  onHover(info|null), // optional, {t0,bucket,total,byDim,dims,metric,currency}
  // session mode (groupBy 'session'): one single-color bar per bucket, and an
  // interactive hover list instead of the stacked tooltip.
  sessionMode,        // boolean
  sessionRows,        // array|null: [{key,label,title,tokens,cost,requests,miss,hit,write,out,reasoning}]
  sessionLoading,     // boolean
  sessionError,       // boolean
  onRequestBucketSessions(t0, t1),
  onOpenSession(sessionId)  // double-click a session row
}
```

Requirements: auto y-scale with 4–5 “nice” ticks; stacked segments per visible dim;
x labels thinned so they never overlap (use `bucket` formatter); tooltip on hover
(via `DshPopover` or an absolutely positioned div inside the container, must not
overflow the chart); vertical drag selection with a translucent overlay that calls
`onSelectRange` on release (minimum 4px movement, otherwise treat as click);
clicking a bar calls `onPickBucket`; empty/loading states; keyboard focusable bars
are optional but the chart must not throw on empty buckets. Export the i18n dict as
`DSHTOKEN_I18N_CHART` with keys prefixed `chart.`.

### `page.js` — required component

`function DshTokenPage(props)` — the standalone page (`main` slot). Receives
`props.t` (locale-bound translate) and `props.inject`
`{ openSession(id), openStats(), notifyStatsChanged(), subscribeStatsChanged(fn) }`.

Content requirements (feature 1–21 of the approved plan):

1. Header: title, index status chip (indexed/total sessions, progress bar while
   running, rebuild button), refresh, auto-refresh toggle, settings button.
2. Summary cards: total tokens, estimated cost, cache-hit rate, avg tokens/day,
   peak bucket; unpriced-model warning chip when cost is incomplete.
3. Filter bar: date presets (today / yesterday / last 7 days / last 30 days / this
   month / last month / custom), two `<input type="date">` fields, bucket toggle
   (auto / hour / day / week / month), metric toggle (tokens / cost), group-by
   toggle (category / API key=provider / model / session), model multi-select
   filter (checkbox list from `meta.models`, “全选/清空”, shows only checked models),
   include-subagents toggle, reset filters.
4. Chart: `DshTokenChart`; legend with per-dim toggle + values; bucket range
   tooltip; click-to-drill (push `{from,to}` onto a breadcrumb stack and reload);
   drag-select sets the custom range; breadcrumb back.
5. Details table: one row per bucket with miss/hit/write/out/total/cost columns,
   CSV export + copy; sortable not required.
6. Rankings panel: top sessions (click → `props.inject.openSession(id)`), top
   models; token/cost values.
7. Settings dialog: price table editor (one row per provider/model from
   `meta.models`; fields hit/miss/write/out + peakMultiplier; unpriced models show
   “未定价” and become editable), peak settings (enabled, windows as `HH:mm`,
   weekday checkboxes, holidays list), restore defaults, import/export price JSON
   (textarea or file input is fine), save through `dshtokenApi('config', {patch})`.
   After a price save, refresh stats so cost columns update.
8. Index progress: while `status.running`, show `scanned/total` and keep polling
   (e.g. every 2s); when `notes.partial` show a partial-data hint.
9. Persist view preferences (date preset/range, bucket, metric, groupBy, checked
   models, includeSubagents, auto-refresh) with `dshtokenUsePersisted`, and restore
   them on mount. Remember the last drill path is not required.
10. All dates use `meta.timezoneOffsetMinutes`; never the browser timezone.
11. All strings through `t`; export `DSHTOKEN_I18N_PAGE` (`page.*` keys).

### `dock.js` — required component

`function DshTokenUsageDock(props)` — replaces the shipped `usage` control in
`conversation.composer.dock`. Props: `props.t`, `props.sessionId`, and
`props.inject { openStats(), openSession(id), notifyStatsChanged() }`.

Requirements:

- Root element: `<button className="dsht-dock" data-composer-stat="usage"
  aria-expanded={open}>` showing the session token total and cache-hit rate
  (`dshtokenFmtTokens`, `dshtokenFmtPct`), separated by `·`. While loading/before
  the first response show `·`/`—` placeholders; never throw.
- Click toggles a statistics dialog (`DshDialog`, width ~460px) anchored nowhere
  (centered is fine) that loads `dshtokenApi('session', {sessionId})`:
  - header: 会话用量 / session usage, total tokens + estimated cost + cache hit;
  - breakdown rows: cache hit / uncached input / cache write / output / reasoning
    (tokens + cost), requests, first/last timestamp;
  - today + all-time rows from `value.global`;
  - unpriced hint when `unpricedTokens > 0`;
  - footer primary button “打开 Token 统计” → `props.inject.openStats()` then close;
- Refresh on open, when `sessionId` changes, and every ~5s while the dialog stays
  open and the document is visible; subscribe `props.inject.subscribeStatsChanged`
  if provided.
- Set `title`/`aria-label` from `t`; export `DSHTOKEN_I18N_DOCK` (`dock.*` keys).

## Verification available to you

- `node scripts/check-fragment.mjs src/client/<your file>` — syntax check.
- `node scripts/build-client.mjs` — full parse check + bundle (only meaningful once
  all five fragments exist; run it when you think it's done).
- Host: `node --check lib/<file>.js` per file, and `node scripts/host-selftest.mjs`
  (host owner writes it) exercising pure folds/aggregation against fixtures.
  You cannot call the live DSH services from a plain node process; only pure
  functions are testable there.
- Never install the bundle yourself; the Lead installs and runs end-to-end HTTP
  tests. Report exactly what you verified and what you could not.
