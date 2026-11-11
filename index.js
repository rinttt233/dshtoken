// @local/dshtoken — Host half (thin, stable shell).
//
// This file is loaded once by the DSH profile loader. It deliberately contains no
// statistics logic: every request to /dshtoken/api/* lazily (re)loads lib/http.js
// from the workspace directory with a cache-busting query derived from the lib
// files' mtimes. Editing lib/*.js therefore takes effect on the next request
// WITHOUT restarting DSH, which keeps the development loop usable in a live
// desktop session.
//
// Keep this file small and correct: a change here needs a real DSH restart.

import { stat } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'dshtoken'

const API_PREFIX = '/dshtoken/api'
// Resolve the implementation directory next to THIS file, so a checkout works from
// any location (and on any platform) without configuration.
const IMPL_DIR = fileURLToPath(new URL('./lib/', import.meta.url)).replace(/[\\/]+$/, '')
const IMPL_FILES = ['http.js', 'scan.js', 'store.js', 'aggregate.js', 'cost.js']

function logOf(ctx) {
  return (level, ...args) => {
    try {
      const base = ctx.logger || console
      const fn = (base && base[level]) || (level === 'error' ? console.error : console.log)
      fn.call(base, '[dshtoken]', ...args)
    } catch {
      /* logging must never break the request path */
    }
  }
}

export function apply(ctx) {
  const log = logOf(ctx)
  const state = { app: null, version: '', loading: null }

  async function versionOf() {
    let version = ''
    for (const file of IMPL_FILES) {
      const info = await stat(`${IMPL_DIR}/${file}`).catch(() => null)
      version += `${file}:${info ? Math.round(info.mtimeMs) + ':' + info.size : 'missing'};`
    }
    return version
  }

  async function loadApp() {
    const version = await versionOf()
    if (state.app && state.version === version) return state.app
    if (state.loading) return state.loading
    state.loading = (async () => {
      if (state.app) {
        try {
          await state.app.dispose()
        } catch (error) {
          log('warn', 'previous impl dispose failed', String((error && error.stack) || error))
        }
        state.app = null
      }
      const url = pathToFileURL(`${IMPL_DIR}/http.js`).href + '?v=' + encodeURIComponent(version)
      const mod = await import(url)
      if (typeof mod.createApp !== 'function') {
        throw new Error('lib/http.js does not export createApp()')
      }
      const app = await mod.createApp({ ctx, version, log })
      state.app = app
      state.version = version
      log('info', 'statistics host logic loaded', version)
      return app
    })().finally(() => {
      state.loading = null
    })
    return state.loading
  }

  ctx.inject(['webServer'], (scope) => {
    scope.effect(
      () => {
        const disposeRoute = scope.webServer.register({
          kind: 'prefix',
          path: API_PREFIX,
          handler: async (req, res) => {
            try {
              if (req.method !== 'POST') {
                res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: false, error: { code: 'method', details: 'POST only' } }))
                return
              }
              const app = await loadApp()
              await app.handle(req, res)
            } catch (error) {
              log('error', 'request failed', String((error && error.stack) || error))
              try {
                res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
                res.end(
                  JSON.stringify({
                    ok: false,
                    error: { code: 'internal', details: String((error && error.message) || error) },
                  }),
                )
              } catch {
                /* response may already be closed */
              }
            }
          },
        })
        void loadApp().catch((error) => log('error', 'initial load failed', String((error && error.stack) || error)))
        return () => {
          try {
            disposeRoute()
          } catch {
            /* already disposed */
          }
          if (state.app) {
            Promise.resolve(state.app.dispose()).catch(() => {})
            state.app = null
          }
        }
      },
      'dshtoken: http api',
    )
  })
}
