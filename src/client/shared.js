/* ============================================================================
 * shared.js — shared runtime for the @local/dshtoken Client half.
 *
 * Everything here evaluates INSIDE the single module factory scope produced by
 * scripts/build-client.mjs. Rules for every fragment file:
 *   - use `var` and `function` declarations only at fragment top level;
 *   - no import/export; no DOM work at load time (only inside components/apply);
 *   - prefix every top-level identifier with the owning file prefix.
 * This file owns: constants, i18n plumbing, host API client, formatters, date
 * helpers, hooks, and the shared UI primitives used by chart/page/dock.
 * ========================================================================== */

var DSHTOKEN_NS = 'dshtoken';
var DSHTOKEN_PANEL = 'dshtoken';
var DSHTOKEN_API = '/dshtoken/api';

/* ---------------------------------------------------------------- i18n --- */

/* Shared keys. Chart/page/dock fragments own DSHTOKEN_I18N_CHART / _PAGE / _DOCK
 * and must prefix their own keys (`chart.`, `page.`, `dock.`). */
var DSHTOKEN_I18N = {
  zh: {
    'panel.title': 'Token 统计',
    'common.refresh': '刷新',
    'common.close': '关闭',
    'common.cancel': '取消',
    'common.save': '保存',
    'common.reset': '恢复默认',
    'common.loading': '加载中…',
    'common.retry': '重试',
    'common.empty': '暂无数据',
    'common.total': '合计',
    'common.tokens': 'Tokens',
    'common.cost': '估算花费',
    'common.cacheHit': '缓存命中',
    'common.other': '其他',
    'common.all': '全部',
    'common.yes': '是',
    'common.no': '否',
    'common.unknown': '未知',
    'common.error': '出错了',
    'cat.hit': '缓存命中',
    'cat.miss': '未命中输入',
    'cat.write': '缓存写入',
    'cat.out': '输出',
    'cat.reasoning': '推理（含在输出内）'
  },
  en: {
    'panel.title': 'Token statistics',
    'common.refresh': 'Refresh',
    'common.close': 'Close',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.reset': 'Reset to defaults',
    'common.loading': 'Loading…',
    'common.retry': 'Retry',
    'common.empty': 'No data',
    'common.total': 'Total',
    'common.tokens': 'Tokens',
    'common.cost': 'Estimated cost',
    'common.cacheHit': 'Cache hit',
    'common.other': 'Other',
    'common.all': 'All',
    'common.yes': 'Yes',
    'common.no': 'No',
    'common.unknown': 'Unknown',
    'common.error': 'Something went wrong',
    'cat.hit': 'Cache hit',
    'cat.miss': 'Uncached input',
    'cat.write': 'Cache write',
    'cat.out': 'Output',
    'cat.reasoning': 'Reasoning (inside output)'
  }
};

var DSHTOKEN_DICTS = { zh: {}, en: {} };
var DSHTOKEN_ACTIVE_LOCALE = 'zh';

function dshtokenIsZh(localeId) {
  return typeof localeId === 'string' && localeId.toLowerCase().indexOf('zh') === 0;
}

function dshtokenMergeDicts(parts) {
  var merged = { zh: {}, en: {} };
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];
    if (!part) continue;
    for (var lang in part) {
      if (!Object.prototype.hasOwnProperty.call(part, lang)) continue;
      if (!merged[lang]) merged[lang] = {};
      var dict = part[lang] || {};
      for (var key in dict) {
        if (Object.prototype.hasOwnProperty.call(dict, key)) merged[lang][key] = dict[key];
      }
    }
  }
  return merged;
}

function dshtokenSetDicts(dicts) {
  DSHTOKEN_DICTS = dicts || { zh: {}, en: {} };
}

function dshtokenSetActiveLocale(localeId) {
  DSHTOKEN_ACTIVE_LOCALE = dshtokenIsZh(localeId) ? 'zh' : 'en';
}

/** Translate with the active locale (used outside slot components, e.g. label thunks). */
function dshtokenT(key, vars) {
  var lang = DSHTOKEN_ACTIVE_LOCALE;
  var dict = DSHTOKEN_DICTS[lang] || {};
  var text = dict[key];
  if (text == null) text = (DSHTOKEN_DICTS.zh || {})[key];
  if (text == null) text = key;
  if (vars) {
    for (var name in vars) {
      if (Object.prototype.hasOwnProperty.call(vars, name)) {
        text = text.split('{' + name + '}').join(String(vars[name]));
      }
    }
  }
  return text;
}

var DSHTOKEN_LOCALE_REV = 0;
var DSHTOKEN_LOCALE_LISTENERS = [];

/** Called by main.js on locale/change; keeps translate + hooks in sync. */
function dshtokenNotifyLocale(localeId) {
  dshtokenSetActiveLocale(localeId);
  DSHTOKEN_LOCALE_REV++;
  var listeners = DSHTOKEN_LOCALE_LISTENERS.slice();
  for (var i = 0; i < listeners.length; i++) {
    try {
      listeners[i]();
    } catch (error) {
      /* ignore */
    }
  }
}

function dshtokenUseLocaleRevision() {
  var pair = React.useState(DSHTOKEN_LOCALE_REV);
  React.useEffect(function () {
    function listener() {
      pair[1](DSHTOKEN_LOCALE_REV);
    }
    DSHTOKEN_LOCALE_LISTENERS.push(listener);
    return function () {
      var index = DSHTOKEN_LOCALE_LISTENERS.indexOf(listener);
      if (index >= 0) DSHTOKEN_LOCALE_LISTENERS.splice(index, 1);
    };
  }, []);
  return pair[0];
}

/** Returns the slot-bound translate function, or a locale-reactive fallback. */
function dshtokenUseT(props) {
  dshtokenUseLocaleRevision();
  if (props && typeof props.t === 'function') return props.t;
  return dshtokenT;
}

/* ------------------------------------------------------------- host API --- */

function dshtokenApi(method, payload) {
  var controller = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = controller
    ? setTimeout(function () {
        try {
          controller.abort();
        } catch (error) {
          /* ignore */
        }
      }, 30000)
    : null;
  var text = JSON.stringify(payload || {});
  return fetch(DSHTOKEN_API + '/' + encodeURIComponent(method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: text,
    credentials: 'same-origin',
    signal: controller ? controller.signal : undefined
  })
    .then(function (response) {
      return response.json().catch(function () {
        return { ok: false, error: { code: 'bad-json', details: 'HTTP ' + response.status } };
      });
    })
    .then(function (result) {
      if (!result || result.ok !== true) {
        var info = (result && result.error) || {};
        var error = new Error(String(info.details || info.code || 'request failed'));
        error.code = info.code || 'error';
        throw error;
      }
      return result.value;
    })
    .finally(function () {
      if (timer) clearTimeout(timer);
    });
}

/* ----------------------------------------------------------- formatters --- */

function dshtokenTrimNumber(value, digits) {
  if (!isFinite(value)) return '0';
  var text = value.toFixed(digits);
  if (text.indexOf('.') >= 0) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return text;
}

function dshtokenFmtInt(value) {
  var n = Math.round(Number(value) || 0);
  var negative = n < 0;
  var digits = String(Math.abs(n));
  var out = '';
  var count = 0;
  for (var i = digits.length - 1; i >= 0; i--) {
    out = digits[i] + out;
    count++;
    if (count % 3 === 0 && i > 0) out = ',' + out;
  }
  return (negative ? '-' : '') + out;
}

/** Compact token count: 999 / 12.3k / 4.56M / 1.02B */
function dshtokenFmtTokens(value) {
  var n = Number(value) || 0;
  var abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1000000) return dshtokenTrimNumber(n / 1000, abs < 10000 ? 2 : 1) + 'k';
  if (abs < 1000000000) return dshtokenTrimNumber(n / 1000000, abs < 10000000 ? 2 : 1) + 'M';
  return dshtokenTrimNumber(n / 1000000000, 2) + 'B';
}

/** Cost in CNY: 0 / ¥0.0012 / ¥1.24 / ¥1,234 */
function dshtokenFmtCost(value, currency) {
  var n = Number(value) || 0;
  var abs = Math.abs(n);
  var sign = n < 0 ? '-' : '';
  var unit = currency || 'CNY';
  var symbol = unit === 'CNY' ? '¥' : unit === 'USD' ? '$' : '';
  var body;
  if (abs === 0) body = '0';
  else if (abs < 0.01) body = dshtokenTrimNumber(abs, 4);
  else if (abs < 1) body = dshtokenTrimNumber(abs, 3);
  else if (abs < 1000) body = dshtokenTrimNumber(abs, 2);
  else body = dshtokenFmtInt(abs);
  return sign + symbol + body;
}

function dshtokenFmtPct(ratio) {
  var n = Number(ratio) || 0;
  if (n <= 0) return '0%';
  var pct = n * 100;
  // Never round a sub-100% value up to "100%": only an exact full ratio reads as
  // 100%, everything else keeps enough decimals to stay visibly below it.
  if (pct >= 100 - 1e-9) return '100%';
  if (pct >= 99) {
    var floor99 = Math.floor(pct * 100) / 100;
    if (floor99 >= 100) floor99 = 99.99;
    return dshtokenTrimNumber(floor99, 2) + '%';
  }
  return dshtokenTrimNumber(pct, pct < 10 ? 2 : 1) + '%';
}

/* ---------------------------------------------------------- date helpers --- */

/** Offset of the statistics timezone (default Asia/Shanghai = UTC+8). */
function dshtokenOffsetMs(timezoneOffsetMinutes) {
  var minutes = typeof timezoneOffsetMinutes === 'number' ? timezoneOffsetMinutes : 480;
  return minutes * 60000;
}

function dshtokenStartOfDay(ms, offsetMs) {
  return Math.floor((Number(ms) + offsetMs) / 86400000) * 86400000 - offsetMs;
}

function dshtokenStartOfMonth(ms, offsetMs) {
  var shifted = new Date(Number(ms) + offsetMs);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - offsetMs;
}

function dshtokenPad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function dshtokenFmtDate(ms, offsetMs) {
  var d = new Date(Number(ms) + offsetMs);
  return d.getUTCFullYear() + '-' + dshtokenPad2(d.getUTCMonth() + 1) + '-' + dshtokenPad2(d.getUTCDate());
}

function dshtokenFmtTime(ms, offsetMs) {
  var d = new Date(Number(ms) + offsetMs);
  return dshtokenPad2(d.getUTCHours()) + ':' + dshtokenPad2(d.getUTCMinutes());
}

function dshtokenFmtDateTime(ms, offsetMs) {
  return dshtokenFmtDate(ms, offsetMs) + ' ' + dshtokenFmtTime(ms, offsetMs);
}

/** Label for one chart bucket. bucket ∈ hour|day|week|month */
function dshtokenFmtBucketLabel(t0, bucket, offsetMs) {
  var d = new Date(Number(t0) + offsetMs);
  if (bucket === 'hour') return dshtokenPad2(d.getUTCHours()) + ':00';
  if (bucket === 'month') return d.getUTCFullYear() + '-' + dshtokenPad2(d.getUTCMonth() + 1);
  return dshtokenPad2(d.getUTCMonth() + 1) + '-' + dshtokenPad2(d.getUTCDate());
}

function dshtokenFmtBucketRange(t0, bucket, offsetMs) {
  var end = t0;
  if (bucket === 'hour') end = Number(t0) + 3600000;
  else if (bucket === 'day') end = Number(t0) + 86400000;
  else if (bucket === 'week') end = Number(t0) + 7 * 86400000;
  else if (bucket === 'month') {
    var shifted = new Date(Number(t0) + offsetMs);
    end = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1) - offsetMs;
  }
  if (bucket === 'hour') return dshtokenFmtDateTime(t0, offsetMs) + ' – ' + dshtokenFmtTime(end, offsetMs);
  return dshtokenFmtDate(t0, offsetMs) + ' – ' + dshtokenFmtDate(end - 1, offsetMs);
}

/** `<input type="date">` value → epoch ms (local midnight, or next midnight when `end`). */
function dshtokenParseDateInput(value, offsetMs, end) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  var parts = value.split('-');
  var ms = Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])) - offsetMs;
  return end ? ms + 86400000 : ms;
}

function dshtokenFmtInputDate(ms, offsetMs) {
  return dshtokenFmtDate(ms, offsetMs);
}

function dshtokenAddDays(ms, days) {
  return Number(ms) + days * 86400000;
}

/* --------------------------------------------------------------- hooks --- */

/** Run fn(deps…) whenever deps change; returns {data,error,loading,reload,setData}. */
function dshtokenUseAsync(fn, deps) {
  var initial = { data: null, error: null, loading: true };
  var statePair = React.useState(initial);
  var state = statePair[0];
  var setState = statePair[1];
  var seqRef = React.useRef(0);
  var run = React.useCallback(
    function () {
      var id = ++seqRef.current;
      setState(function (prev) {
        return { data: prev.data, error: null, loading: true };
      });
      Promise.resolve()
        .then(fn)
        .then(
          function (value) {
            if (id === seqRef.current) setState({ data: value, error: null, loading: false });
          },
          function (error) {
            if (id === seqRef.current) setState({ data: null, error: error, loading: false });
          }
        );
    },
    deps || []
  );
  React.useEffect(function () {
    run();
  }, [run]);
  return {
    data: state.data,
    error: state.error,
    loading: state.loading,
    reload: run,
    setData: function (value) {
      setState({ data: value, error: null, loading: false });
    }
  };
}

function dshtokenUsePersisted(key, initial) {
  var storageKey = 'dshtoken.' + key;
  var pair = React.useState(function () {
    try {
      var raw = window.localStorage.getItem(storageKey);
      return raw == null ? initial : JSON.parse(raw);
    } catch (error) {
      return initial;
    }
  });
  var value = pair[0];
  var setValue = pair[1];
  var update = React.useCallback(
    function (next) {
      setValue(function (prev) {
        var resolved = typeof next === 'function' ? next(prev) : next;
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(resolved));
        } catch (error) {
          /* quota / private mode */
        }
        return resolved;
      });
    },
    [storageKey]
  );
  return [value, update];
}

function dshtokenUseInterval(callback, delay, enabled) {
  var ref = React.useRef(callback);
  ref.current = callback;
  React.useEffect(
    function () {
      if (!enabled || !delay) return undefined;
      var timer = window.setInterval(function () {
        ref.current();
      }, delay);
      return function () {
        window.clearInterval(timer);
      };
    },
    [delay, enabled]
  );
}

/** True while the document is visible; used to pause polling in background tabs. */
function dshtokenUseVisible() {
  var pair = React.useState(function () {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden';
  });
  React.useEffect(function () {
    function onChange() {
      pair[1](document.visibilityState !== 'hidden');
    }
    document.addEventListener('visibilitychange', onChange);
    return function () {
      document.removeEventListener('visibilitychange', onChange);
    };
  }, []);
  return pair[0];
}

/* ------------------------------------------------------- UI primitives --- */

var DSHTOKEN_ICON_PATHS = {
  chart: ['M4 20h16', 'M7 20v-6', 'M12 20V6', 'M17 20v-9'],
  refresh: ['M20 11a8 8 0 1 0-2.3 6.3', 'M20 5v6h-6'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'chevron-left': ['M15 6l-6 6 6 6'],
  'chevron-right': ['M9 6l6 6-6 6'],
  download: ['M12 4v11', 'M8 11l4 4 4-4', 'M5 20h14'],
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3H9.8L9.4 5.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.7h4.4l.4-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z'],
  check: ['M5 13l4 4L19 7'],
  filter: ['M4 5h16', 'M7 12h10', 'M10 19h4'],
  external: ['M14 4h6v6', 'M20 4l-8 8', 'M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4'],
  warn: ['M12 3l9 16H3l9-16z', 'M12 9v5', 'M12 17h.01'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v5', 'M12 8h.01'],
  copy: ['M9 9h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z', 'M6 15H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  database: ['M12 8c4.4 0 8-1.1 8-2.5S16.4 3 12 3 4 4.1 4 5.5 7.6 8 12 8z', 'M4 5.5v13C4 19.9 7.6 21 12 21s8-1.1 8-2.5v-13', 'M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5'],
  'arrow-up': ['M12 19V5', 'M6 11l6-6 6 6'],
  'arrow-down': ['M12 5v14', 'M6 13l6 6 6-6']
};

function DshIcon(props) {
  var name = props.name;
  var paths = DSHTOKEN_ICON_PATHS[name] || DSHTOKEN_ICON_PATHS.info;
  var size = props.size || 14;
  var children = paths.map(function (d, index) {
    return h('path', { key: index, d: d });
  });
  return h(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: props.strokeWidth || 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      focusable: 'false',
      style: { display: 'block', flex: '0 0 auto' }
    },
    children
  );
}

function DshSpinner(props) {
  return h('span', {
    className: 'dsht-spin',
    role: 'status',
    'aria-label': (props && props.label) || 'loading',
    style: props && props.size ? { width: props.size, height: props.size } : undefined
  });
}

function DshStyle(props) {
  return h('style', { 'data-dshtoken-style': props.id }, props.css);
}

var DSHTOKEN_REACT_DOM = null;
try {
  DSHTOKEN_REACT_DOM = require('react-dom');
} catch (error) {
  DSHTOKEN_REACT_DOM = null;
}

function DshPortal(props) {
  var canPortal =
    DSHTOKEN_REACT_DOM &&
    typeof DSHTOKEN_REACT_DOM.createPortal === 'function' &&
    typeof document !== 'undefined' &&
    document.body;
  if (!canPortal) return props.children;
  return DSHTOKEN_REACT_DOM.createPortal(props.children, document.body);
}

function DshDialog(props) {
  React.useEffect(
    function () {
      if (!props.open) return undefined;
      function onKeyDown(event) {
        if (event.key === 'Escape') {
          event.stopPropagation();
          if (props.onClose) props.onClose();
        }
      }
      document.addEventListener('keydown', onKeyDown, true);
      return function () {
        document.removeEventListener('keydown', onKeyDown, true);
      };
    },
    [props.open, props.onClose]
  );

  if (!props.open) return null;
  var head = h(
    'div',
    { className: 'dsht-dialog-head' },
    h('div', { className: 'dsht-dialog-title' }, props.title || ''),
    h(
      'button',
      {
        type: 'button',
        className: 'dsht-btn dsht-btn-ghost',
        onClick: props.onClose,
        title: props.closeLabel || 'Close',
        'aria-label': props.closeLabel || 'Close'
      },
      h(DshIcon, { name: 'close', size: 14 })
    )
  );
  return h(
    DshPortal,
    null,
    h(
      'div',
      {
        className: 'dsht-backdrop',
        onMouseDown: function (event) {
          if (event.target === event.currentTarget && props.onClose) props.onClose();
        }
      },
      h(
        'div',
        {
          className: 'dsht-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': props.title || '',
          style: props.width ? { '--dsht-dialog-width': props.width } : undefined
        },
        head,
        h('div', { className: 'dsht-dialog-body' }, props.children),
        props.footer ? h('div', { className: 'dsht-dialog-foot' }, props.footer) : null
      )
    )
  );
}

/**
 * Anchored popover. Props: open, x, y, width, onClose, children, align('left'|'right').
 * Position is fixed to the anchor coordinates supplied by the caller.
 */
function DshPopover(props) {
  var ref = React.useRef(null);
  React.useEffect(
    function () {
      if (!props.open) return undefined;
      function onPointerDown(event) {
        if (ref.current && ref.current.contains(event.target)) return;
        if (props.onClose) props.onClose();
      }
      function onKeyDown(event) {
        if (event.key === 'Escape') {
          if (props.onClose) props.onClose();
        }
      }
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('keydown', onKeyDown, true);
      return function () {
        document.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('keydown', onKeyDown, true);
      };
    },
    [props.open, props.onClose]
  );

  if (!props.open) return null;
  var width = props.width || 200;
  var margin = 8;
  var viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1200;
  var viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 900;
  var left = props.x || 0;
  var top = props.y || 0;
  if (props.align === 'right') left = left - width;
  left = Math.max(margin, Math.min(left, viewportWidth - width - margin));
  if (props.estimateHeight && top + props.estimateHeight > viewportHeight - margin) {
    top = Math.max(margin, viewportHeight - props.estimateHeight - margin);
  }
  return h(
    DshPortal,
    null,
    h(
      'div',
      {
        ref: ref,
        className: 'dsht-pop',
        role: 'menu',
        style: { left: left, top: top, width: width }
      },
      props.children
    )
  );
}

function DshSegmented(props) {
  var options = props.options || [];
  return h(
    'div',
    { className: 'dsht-seg', role: 'group', 'aria-label': props.ariaLabel || '' },
    options.map(function (option) {
      var selected = props.value === option.value;
      return h(
        'button',
        {
          key: option.value,
          type: 'button',
          className: 'dsht-seg-item',
          'aria-pressed': selected,
          title: option.title || option.label,
          onClick: function () {
            if (!selected && props.onChange) props.onChange(option.value);
          }
        },
        option.label
      );
    })
  );
}

function DshCheckbox(props) {
  return h(
    'button',
    {
      type: 'button',
      role: 'checkbox',
      'aria-checked': !!props.checked,
      className: 'dsht-check',
      disabled: props.disabled,
      title: props.title,
      onClick: function () {
        if (!props.disabled && props.onChange) props.onChange(!props.checked);
      }
    },
    props.checked ? h(DshIcon, { name: 'check', size: 10, strokeWidth: 2.4 }) : null
  );
}

function DshProgress(props) {
  var ratio = Math.max(0, Math.min(1, Number(props.value) || 0));
  return h(
    'div',
    {
      className: 'dsht-progress',
      role: 'progressbar',
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': Math.round(ratio * 100)
    },
    h('div', { className: 'dsht-progress-inner', style: { width: (ratio * 100).toFixed(2) + '%' } })
  );
}

function DshEmpty(props) {
  return h(
    'div',
    { className: 'dsht-empty' },
    h(DshIcon, { name: props.icon || 'chart', size: 22 }),
    h('div', { style: { marginTop: 8 } }, props.title || ''),
    props.hint ? h('div', { className: 'dsht-muted', style: { marginTop: 4 } }, props.hint) : null
  );
}

function DshErrorBox(props) {
  var error = props.error;
  var text = (error && (error.message || String(error))) || 'error';
  return h(
    'div',
    { className: 'dsht-error', role: 'alert' },
    h(
      'div',
      { className: 'dsht-row', style: { gap: 6 } },
      h(DshIcon, { name: 'warn', size: 13 }),
      h('span', { style: { flex: '1 1 auto', minWidth: 0, wordBreak: 'break-word' } }, text),
      props.onRetry
        ? h(
            'button',
            { type: 'button', className: 'dsht-btn dsht-btn-ghost', onClick: props.onRetry },
            props.retryLabel || 'Retry'
          )
        : null
    )
  );
}

/* ------------------------------------------------------------- base CSS --- */

var DSHTOKEN_BASE_CSS = `
.dsht-page{height:100%;overflow:auto;padding:18px 22px 40px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;box-sizing:border-box}
.dsht-page *{box-sizing:border-box}
.dsht-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsht-row-nowrap{flex-wrap:nowrap}
.dsht-grow{flex:1 1 auto;min-width:0}
.dsht-col{display:flex;flex-direction:column;gap:12px}
.dsht-title{font-size:18px;font-weight:600;letter-spacing:.01em;margin:0}
.dsht-sub{color:var(--dsw-alias-label-secondary);font-size:12px;margin:0}
.dsht-muted{color:var(--dsw-alias-label-secondary)}
.dsht-mono{font-variant-numeric:tabular-nums}
.dsht-warn{color:var(--dsw-alias-state-warn-primary)}
.dsht-err{color:var(--dsw-alias-state-error-primary)}
.dsht-hint{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsht-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit;line-height:1;cursor:pointer;white-space:nowrap}
.dsht-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dsht-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsht-btn[aria-pressed="true"],.dsht-btn.is-active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dsht-btn:disabled{opacity:.45;cursor:default}
.dsht-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.dsht-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);opacity:.9}
.dsht-btn-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.dsht-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsht-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
.dsht-seg{display:inline-flex;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:2px;gap:2px}
.dsht-seg-item{height:24px;padding:0 10px;border-radius:7px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;font-family:inherit;cursor:pointer;white-space:nowrap}
.dsht-seg-item:hover{color:var(--dsw-alias-label-primary)}
.dsht-seg-item[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsht-seg-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsht-input,.dsht-select{height:28px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit}
.dsht-input:focus-visible,.dsht-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.dsht-input[type="date"]{padding-right:4px}
.dsht-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:11px 13px;display:flex;flex-direction:column;gap:1px;min-width:0}
.dsht-card-label{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsht-card-value{font-size:19px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.dsht-card-sub{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsht-panel{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:14px;min-width:0}
.dsht-panel-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.dsht-panel-title{font-size:13px;font-weight:600}
.dsht-table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
.dsht-table th{text-align:right;font-weight:500;color:var(--dsw-alias-label-secondary);padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap;background:var(--dsw-alias-bg-layer-1);position:sticky;top:0;z-index:1}
.dsht-table th:first-child,.dsht-table td:first-child{text-align:left}
.dsht-table td{text-align:right;padding:5px 8px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 55%,transparent);white-space:nowrap}
.dsht-table tbody tr:hover{background:var(--dsw-alias-bg-layer-2)}
.dsht-table td.dsht-cell-left,.dsht-table th.dsht-cell-left{text-align:left}
.dsht-table td.dsht-cell-actions{text-align:right;white-space:nowrap}
.dsht-table-wrap{overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.dsht-chip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:11px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.dsht-chip[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}
.dsht-chip[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}
.dsht-swatch{width:9px;height:9px;border-radius:3px;flex:0 0 auto}
.dsht-legend{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsht-legend-item{display:inline-flex;align-items:center;gap:5px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;font-family:inherit;cursor:pointer;padding:2px 4px;border-radius:6px}
.dsht-legend-item:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsht-legend-item[aria-pressed="false"]{opacity:.4}
.dsht-legend-value{font-variant-numeric:tabular-nums}
.dsht-empty{padding:26px 16px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;display:flex;flex-direction:column;align-items:center;gap:6px}
.dsht-error{color:var(--dsw-alias-state-error-primary);font-size:12px;padding:8px 10px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.dsht-note{font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:5px}
.dsht-backdrop{position:fixed;inset:0;background:color-mix(in srgb,#000 38%,transparent);z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;animation:dsht-fade .12s ease}
.dsht-dialog{background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;box-shadow:0 18px 48px color-mix(in srgb,#000 32%,transparent);width:min(92vw,var(--dsht-dialog-width,720px));max-height:86vh;display:flex;flex-direction:column;overflow:hidden;color:var(--dsw-alias-label-primary)}
.dsht-dialog-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsht-dialog-title{font-size:14px;font-weight:600;flex:1;min-width:0}
.dsht-dialog-body{padding:14px;overflow:auto}
.dsht-dialog-foot{padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.dsht-pop{position:fixed;z-index:70;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 12px 32px color-mix(in srgb,#000 28%,transparent);padding:6px;max-height:340px;overflow:auto;color:var(--dsw-alias-label-primary)}
.dsht-pop-item{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:7px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-primary);background:transparent;border:0;width:100%;text-align:left;font-family:inherit}
.dsht-pop-item:hover{background:var(--dsw-alias-bg-layer-2)}
.dsht-pop-sep{height:1px;background:var(--dsw-alias-border-l1);margin:4px 6px}
.dsht-check{width:15px;height:15px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;background:var(--dsw-alias-bg-layer-1);color:#fff;padding:0;cursor:pointer}
.dsht-check[aria-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dsht-check:disabled{opacity:.45;cursor:default}
.dsht-progress{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dsht-progress-inner{height:100%;background:var(--dsw-alias-brand-primary);border-radius:3px;transition:width .25s ease}
.dsht-spin{display:inline-block;width:14px;height:14px;border-radius:50%;border:2px solid color-mix(in srgb,var(--dsw-alias-label-secondary) 35%,transparent);border-top-color:var(--dsw-alias-brand-primary);animation:dsht-spin .7s linear infinite;flex:0 0 auto}
@keyframes dsht-spin{to{transform:rotate(360deg)}}
@keyframes dsht-fade{from{opacity:0}to{opacity:1}}
/* composer usage dock chip (replaces the shipped usage control) */
.dsht-dock{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:11px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;font-family:inherit;font-variant-numeric:tabular-nums;cursor:pointer;white-space:nowrap;line-height:1}
.dsht-dock:hover,.dsht-dock[aria-expanded="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsht-dock:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsht-dock-sep{opacity:.5}
`;
