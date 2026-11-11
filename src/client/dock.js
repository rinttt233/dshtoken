/* ============================================================================
 * dock.js — replacement for the shipped `usage` composer dock control.
 *
 * Registers into `conversation.composer.dock` (id 'usage', order 1, priority
 * -10) from main.js. It shows the current session's token total and cache-hit
 * rate as a chip; clicking it opens a small dialog with the session breakdown,
 * timestamps, today / all-time totals and a jump button to the statistics page.
 *
 * Data comes from the Host API only: `session` on mount / sessionId change /
 * dialog open / ~5s while the dialog is open and visible, plus the shared
 * `subscribeStatsChanged` signal. No Host services are touched here.
 * ========================================================================== */

var DSHTOKEN_I18N_DOCK = {
  zh: {
    'dock.title': '会话 Token 用量',
    'dock.chipTitle': '查看会话 Token 用量统计',
    'dock.tokens': 'tokens',
    'dock.open': '打开 Token 统计',
    'dock.placeholder': '—',
    'dock.requests': '请求次数',
    'dock.firstTime': '首次使用',
    'dock.lastTime': '最近使用',
    'dock.today': '今日',
    'dock.allTime': '累计',
    'dock.unpriced': '部分模型未定价，花费不含其 token',
    'dock.noSession': '未选择会话',
    'dock.notFound': '该会话暂无用量数据'
  },
  en: {
    'dock.title': 'Session token usage',
    'dock.chipTitle': 'View session token usage',
    'dock.tokens': 'tokens',
    'dock.open': 'Open token statistics',
    'dock.placeholder': '—',
    'dock.requests': 'Requests',
    'dock.firstTime': 'First used',
    'dock.lastTime': 'Last used',
    'dock.today': 'Today',
    'dock.allTime': 'All time',
    'dock.unpriced': 'Some models are unpriced; cost excludes their tokens',
    'dock.noSession': 'No session selected',
    'dock.notFound': 'No usage recorded for this session yet'
  }
};

/* The `session` endpoint does not carry the statistics timezone, so the config
 * endpoint is read once per page (cached module-wide) and reused by every dock
 * instance. Failure falls back to Asia/Shanghai / CNY. */
var DshTokenDockConfigCache = null;
var DshTokenDockConfigPromise = null;

function DshTokenDockReadConfig() {
  if (DshTokenDockConfigCache) return Promise.resolve(DshTokenDockConfigCache);
  if (DshTokenDockConfigPromise) return DshTokenDockConfigPromise;

  function normalize(value) {
    var config = value && value.config ? value.config : value || {};
    var minutes =
      config && isFinite(config.timezoneOffsetMinutes) ? Number(config.timezoneOffsetMinutes) : 480;
    var currency =
      config && typeof config.currency === 'string' && config.currency ? config.currency : 'CNY';
    if (!DshTokenDockConfigCache) {
      DshTokenDockConfigCache = { offsetMinutes: minutes, currency: currency };
    }
    return DshTokenDockConfigCache;
  }

  function fallback() {
    if (!DshTokenDockConfigCache) {
      DshTokenDockConfigCache = { offsetMinutes: 480, currency: 'CNY' };
    }
    return DshTokenDockConfigCache;
  }

  var promise;
  try {
    promise = Promise.resolve(dshtokenApi('config', {})).then(normalize, fallback);
  } catch (error) {
    return Promise.resolve(fallback());
  }
  DshTokenDockConfigPromise = promise;
  return promise;
}

function DshTokenDockNum(value) {
  var next = Number(value);
  return isFinite(next) ? next : 0;
}

/** Small summary card used inside the usage dialog. */
function DshTokenDockStat(props) {
  return h(
    'div',
    { className: 'dsht-card', style: { flex: '1 1 0', minWidth: 0 } },
    h('div', { className: 'dsht-card-label' }, props.label || ''),
    h('div', { className: 'dsht-card-value', style: { overflowWrap: 'anywhere' } }, props.value || ''),
    props.sub ? h('div', { className: 'dsht-card-sub' }, props.sub) : null
  );
}

/* ========================================================================== */

function DshTokenUsageDock(props) {
  var t = dshtokenUseT(props);
  var visible = dshtokenUseVisible();

  var openPair = React.useState(false);
  var open = !!openPair[0];
  var setOpen = openPair[1];

  var statePair = React.useState(function () {
    return { sessionId: '', value: null, error: null, loading: false };
  });
  var state = statePair[0] || { sessionId: '', value: null, error: null, loading: false };
  var setState = statePair[1];

  var cfgPair = React.useState(function () {
    return { offsetMinutes: 480, currency: 'CNY' };
  });
  var cfg = cfgPair[0] || { offsetMinutes: 480, currency: 'CNY' };
  var setCfg = cfgPair[1];

  var seqRef = React.useRef(0);
  var mountedRef = React.useRef(true);
  var loadRef = React.useRef(null);

  var rawSessionId = props ? props.sessionId : null;
  if (
    (rawSessionId == null || rawSessionId === '') &&
    props &&
    props.session &&
    typeof props.session.id === 'string'
  ) {
    rawSessionId = props.session.id;
  }
  var sessionId = typeof rawSessionId === 'string' ? rawSessionId : '';

  // Injected keys may arrive spread on props (top-level) or nested under
  // props.inject; accept both so navigation never silently disappears.
  var inject = props && props.inject && typeof props.inject === 'object'
    ? props.inject
    : props && typeof props.openStats === 'function'
      ? props
      : null;
  var subscribe =
    inject && typeof inject.subscribeStatsChanged === 'function' ? inject.subscribeStatsChanged : null;

  /* --- fetch -------------------------------------------------------------
   * `quiet` refreshes keep the current values visible; a normal load shows the
   * loading state (placeholders on the chip until data arrives). Stale
   * responses are dropped via seqRef; nothing is written after unmount. */
  function load(quiet) {
    seqRef.current += 1;
    var id = seqRef.current;
    if (!sessionId) {
      setState({ sessionId: '', value: null, error: null, loading: false });
      return;
    }
    if (!quiet) {
      setState(function (prev) {
        var keep = prev && prev.sessionId === sessionId ? prev.value : null;
        return { sessionId: sessionId, value: keep, error: null, loading: true };
      });
    }
    var request;
    try {
      request = dshtokenApi('session', { sessionId: sessionId });
    } catch (error) {
      if (mountedRef.current && id === seqRef.current) {
        setState({ sessionId: sessionId, value: null, error: error || new Error('request failed'), loading: false });
      }
      return;
    }
    Promise.resolve(request)
      .then(
        function (value) {
          if (!mountedRef.current || id !== seqRef.current) return;
          setState({ sessionId: sessionId, value: value || null, error: null, loading: false });
        },
        function (error) {
          if (!mountedRef.current || id !== seqRef.current) return;
          setState(function (prev) {
            var keep = prev && prev.sessionId === sessionId ? prev.value : null;
            return {
              sessionId: sessionId,
              value: keep,
              error: error || new Error('request failed'),
              loading: false
            };
          });
        }
      )
      .catch(function () {
        /* defensive: never let a refresh chain escape as an unhandled rejection */
      });
  }
  loadRef.current = load;

  /* --- effects ------------------------------------------------------------ */

  /* Track mount state so late responses are ignored after unmount. */
  React.useEffect(function () {
    mountedRef.current = true;
    return function () {
      mountedRef.current = false;
      seqRef.current += 1;
    };
  }, []);

  /* Statistics timezone / currency for timestamp formatting, once per mount. */
  React.useEffect(function () {
    var alive = true;
    DshTokenDockReadConfig()
      .then(
        function (next) {
          if (!alive || !next) return;
          setCfg(function (prev) {
            if (prev && prev.offsetMinutes === next.offsetMinutes && prev.currency === next.currency) {
              return prev;
            }
            return next;
          });
        },
        function () {
          /* keep the 480-minute default */
        }
      )
      .catch(function () {
        /* ignore */
      });
    return function () {
      alive = false;
    };
  }, []);

  /* Initial load and every session switch. */
  React.useEffect(
    function () {
      if (!sessionId) {
        seqRef.current += 1;
        setState({ sessionId: '', value: null, error: null, loading: false });
        return undefined;
      }
      loadRef.current(false);
      return undefined;
    },
    [sessionId]
  );

  /* Refresh once whenever the dialog is opened. */
  React.useEffect(
    function () {
      if (open) loadRef.current(true);
      return undefined;
    },
    [open]
  );

  /* Live updates signalled by the rest of the plugin (page edits, rebuilds). */
  React.useEffect(
    function () {
      if (!subscribe) return undefined;
      var unsubscribe = null;
      try {
        unsubscribe = subscribe(function () {
          loadRef.current(true);
        });
      } catch (error) {
        unsubscribe = null;
      }
      return function () {
        if (typeof unsubscribe !== 'function') return;
        try {
          unsubscribe();
        } catch (error) {
          /* ignore */
        }
      };
    },
    [subscribe]
  );

  /* ~5s polling only while the dialog is open and the document is visible. */
  dshtokenUseInterval(
    function () {
      if (open) loadRef.current(true);
    },
    5000,
    open && visible && !!sessionId
  );

  /* --- derived view state ------------------------------------------------- */

  var matches = state.sessionId === sessionId;
  var value = matches ? state.value : null;
  var failure = matches ? state.error : null;
  var pending = !matches || !!state.loading;
  var hasData = !!(value && value.found !== false);
  var chipReady = !!(sessionId && hasData && !pending && !failure);

  var tokenPart = hasData && value.tokens ? value.tokens : {};
  var hit = DshTokenDockNum(tokenPart.hit);
  var miss = DshTokenDockNum(tokenPart.miss);
  var write = DshTokenDockNum(tokenPart.write);
  var out = DshTokenDockNum(tokenPart.out);
  var reasoning = DshTokenDockNum(tokenPart.reasoning);
  var totalTokens = DshTokenDockNum(tokenPart.tokens) || hit + miss + write + out;
  var totalCost = DshTokenDockNum(tokenPart.cost);
  var cacheHitRate = DshTokenDockNum(value ? value.cacheHitRate : 0);
  var requests = DshTokenDockNum(tokenPart.requests);
  var firstTime = DshTokenDockNum(value ? value.firstTime : 0);
  var lastTime = DshTokenDockNum(value ? value.lastTime : 0);
  var unpricedTokens = DshTokenDockNum(value ? value.unpricedTokens : 0);
  var globalPart = (value && value.global) || {};
  var todayPart = globalPart.today || {};
  var allPart = globalPart.all || {};
  var offsetMs = dshtokenOffsetMs(cfg.offsetMinutes);

  var chipTokensText = chipReady
    ? dshtokenFmtTokens(DshTokenDockNum(tokenPart.tokens) || totalTokens)
    : t('dock.placeholder');
  var chipRateText = chipReady ? dshtokenFmtPct(cacheHitRate) : t('dock.placeholder');

  /* --- handlers ----------------------------------------------------------- */

  function handleToggle() {
    setOpen(function (prev) {
      return !prev;
    });
  }

  function handleClose() {
    setOpen(false);
  }

  function handleOpenStats() {
    try {
      if (inject && typeof inject.openStats === 'function') inject.openStats();
    } catch (error) {
      /* navigation failures must not break the composer chip */
    }
    setOpen(false);
  }

  function handleRetry() {
    loadRef.current(false);
  }

  function renderMetaRow(key, label, valueText) {
    return h(
      'div',
      {
        key: key,
        className: 'dsht-row dsht-row-nowrap',
        style: { justifyContent: 'space-between', alignItems: 'baseline', gap: 10, fontSize: 12 }
      },
      h('span', { className: 'dsht-muted' }, label),
      h(
        'span',
        { className: 'dsht-mono', style: { textAlign: 'right', minWidth: 0, overflowWrap: 'anywhere' } },
        valueText
      )
    );
  }

  function timeText(ms) {
    return ms > 0 ? dshtokenFmtDateTime(ms, offsetMs) : t('dock.placeholder');
  }

  function renderGlobalRow(key, label, part) {
    var item = part || {};
    var tokensValue = DshTokenDockNum(item.tokens);
    var costValue = DshTokenDockNum(item.cost);
    return renderMetaRow(
      key,
      label,
      dshtokenFmtTokens(tokensValue) +
        ' ' +
        t('dock.tokens') +
        ' · ' +
        dshtokenFmtCost(costValue, cfg.currency)
    );
  }

  function renderBreakdown() {
    var rows = [
      ['hit', t('cat.hit'), hit, false],
      ['miss', t('cat.miss'), miss, false],
      ['write', t('cat.write'), write, false],
      ['out', t('cat.out'), out, false],
      ['reasoning', t('cat.reasoning'), reasoning, true]
    ];
    return h(
      'div',
      { className: 'dsht-table-wrap' },
      h(
        'table',
        { className: 'dsht-table' },
        h(
          'tbody',
          null,
          rows.map(function (row) {
            return h(
              'tr',
              { key: row[0] },
              h(
                'td',
                { className: row[3] ? 'dsht-cell-left dsht-muted' : 'dsht-cell-left' },
                row[1]
              ),
              h('td', { className: row[3] ? 'dsht-mono dsht-muted' : 'dsht-mono' }, dshtokenFmtInt(row[2]))
            );
          })
        )
      )
    );
  }

  /* --- dialog body -------------------------------------------------------- */

  var bodyChildren = [];

  if (failure) {
    bodyChildren.push(
      h(DshErrorBox, {
        key: 'error',
        error: failure,
        onRetry: handleRetry,
        retryLabel: t('common.retry')
      })
    );
  }

  if (!sessionId) {
    bodyChildren.push(
      h('div', { key: 'no-session', className: 'dsht-muted' }, t('dock.noSession'))
    );
  } else if (!hasData) {
    bodyChildren.push(
      h(
        'div',
        { key: 'status', className: 'dsht-muted' },
        pending ? t('common.loading') : t('dock.notFound')
      )
    );
  }

  if (hasData) {
    var dataChildren = [];

    dataChildren.push(
      h(
        'div',
        {
          key: 'summary',
          className: 'dsht-row',
          style: { gap: 8, alignItems: 'stretch', flexWrap: 'nowrap' }
        },
        h(DshTokenDockStat, {
          key: 'tokens',
          label: t('common.tokens'),
          value: dshtokenFmtInt(totalTokens)
        }),
        h(DshTokenDockStat, {
          key: 'cost',
          label: t('common.cost'),
          value: dshtokenFmtCost(totalCost, cfg.currency)
        }),
        h(DshTokenDockStat, {
          key: 'cache',
          label: t('common.cacheHit'),
          value: dshtokenFmtPct(cacheHitRate)
        })
      )
    );

    dataChildren.push(h('div', { key: 'breakdown' }, renderBreakdown()));

    dataChildren.push(
      h(
        'div',
        {
          key: 'meta',
          className: 'dsht-col',
          style: { gap: 6, borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 8 }
        },
        renderMetaRow('requests', t('dock.requests'), dshtokenFmtInt(requests)),
        renderMetaRow('first', t('dock.firstTime'), timeText(firstTime)),
        renderMetaRow('last', t('dock.lastTime'), timeText(lastTime))
      )
    );

    dataChildren.push(
      h(
        'div',
        {
          key: 'global',
          className: 'dsht-col',
          style: { gap: 6, borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 8 }
        },
        renderGlobalRow('today', t('dock.today'), todayPart),
        renderGlobalRow('all', t('dock.allTime'), allPart)
      )
    );

    if (unpricedTokens > 0) {
      dataChildren.push(
        h(
          'div',
          { key: 'unpriced', className: 'dsht-hint dsht-warn' },
          t('dock.unpriced') + ' · ' + dshtokenFmtTokens(unpricedTokens) + ' ' + t('dock.tokens')
        )
      );
    }

    bodyChildren.push(
      h(
        'div',
        { key: 'data', className: 'dsht-col', style: { gap: 12 } },
        dataChildren
      )
    );
  }

  var dialog = h(
    DshDialog,
    {
      open: open,
      title: t('dock.title'),
      width: '460px',
      onClose: handleClose,
      closeLabel: t('common.close'),
      footer: h(
        'div',
        { className: 'dsht-row', style: { gap: 8, justifyContent: 'flex-end', width: '100%' } },
        h(
          'button',
          { type: 'button', className: 'dsht-btn', onClick: handleClose },
          t('common.close')
        ),
        h(
          'button',
          { type: 'button', className: 'dsht-btn dsht-btn-primary', onClick: handleOpenStats },
          t('dock.open')
        )
      )
    },
    h('div', { className: 'dsht-col', style: { gap: 12 } }, bodyChildren)
  );

  /* --- chip --------------------------------------------------------------- */

  var chip = h(
    'button',
    {
      type: 'button',
      className: 'dsht-dock',
      'data-composer-stat': 'usage',
      'aria-expanded': open,
      'aria-haspopup': 'dialog',
      title: t('dock.chipTitle'),
      'aria-label': t('dock.chipTitle'),
      onClick: handleToggle
    },
    h('span', { className: 'dsht-dock-tokens' }, chipTokensText + ' ' + t('dock.tokens')),
    h('span', { className: 'dsht-dock-sep' }, '·'),
    h('span', { className: 'dsht-dock-rate' }, chipRateText)
  );

  return h(React.Fragment, null, chip, dialog);
}
