/* ============================================================================
 * chart.js — pure-SVG stacked bar chart for the @local/dshtoken statistics page.
 *
 * Everything here evaluates INSIDE the single module factory scope produced by
 * scripts/build-client.mjs (same scope as shared.js, page.js, dock.js, main.js):
 *   - `var` and `function` declarations only at fragment top level;
 *   - no import/export, no DOM work at load time, no third-party packages.
 *
 * Factory-scope names provided to page.js / main.js:
 *   DSHTOKEN_I18N_CHART             chart.* dictionary (zh + en)
 *   DshTokenChart(props)            the chart component (mounted by page.js)
 *   DshChartDimColor(key, i, kind)  stable theme-token color for one stacked dim
 *                                   (string CSS color usable for legend swatches)
 *
 * The chart draws stacked bars straight into SVG; it only measures its own
 * container width (ResizeObserver, cleaned up on unmount) and never reads page
 * DOM. All strings come from the `t` returned by dshtokenUseT(props), so the
 * component keeps working when page.js does not pass `props.t`.
 * ========================================================================== */

var DSHTOKEN_I18N_CHART = {
  zh: {
    'chart.loading': '正在加载图表…',
    'chart.emptyHint': '当前时间范围内没有使用记录',
    'chart.ariaBase': 'Token 用量柱状图',
    'chart.aria': 'Token 用量柱状图：{count} 个时间桶，按 {metric} 计量',
    'chart.allTotal': '全部分组（含隐藏）',
    'chart.share': '占比',
    'chart.sess.loading': '加载中…',
    'chart.sess.error': '无法加载会话列表',
    'chart.sess.empty': '该时间桶没有会话',
    'chart.sess.expand': '展开全部 {count} 个会话',
    'chart.sess.collapse': '收起',
    'chart.sess.requests': '请求',
    'chart.sess.panel': '会话列表',
    'chart.sess.openHint': '双击打开会话'
  },
  en: {
    'chart.loading': 'Loading chart…',
    'chart.emptyHint': 'No usage recorded in this range',
    'chart.ariaBase': 'Token usage bar chart',
    'chart.aria': 'Token usage bar chart: {count} time buckets, measured in {metric}',
    'chart.allTotal': 'All series (incl. hidden)',
    'chart.share': 'Share',
    'chart.sess.loading': 'Loading…',
    'chart.sess.error': 'Unable to load session list',
    'chart.sess.empty': 'No sessions in this bucket',
    'chart.sess.expand': 'Show all {count} sessions',
    'chart.sess.collapse': 'Collapse',
    'chart.sess.requests': 'Requests',
    'chart.sess.panel': 'Session list',
    'chart.sess.openHint': 'Double-click to open'
  }
};

var DSHCHART_DEFAULT_HEIGHT = 320;
var DSHCHART_MIN_LABEL_GAP = 56;

/* Series palette source: only theme tokens, mixed with the brand color so the
 * series follow the light/dark theme automatically (no literal hex palette). */
var DSHCHART_SERIES_TOKENS = [
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-label-primary'
];
var DSHCHART_SERIES_WEIGHTS = [72, 58, 44, 30, 16];

/* Session mode draws a single non-stacked bar per bucket with one token color. */
var DSHCHART_SESSION_COLOR = 'color-mix(in srgb,var(--dsw-alias-brand-primary) 86%,var(--dsw-alias-label-primary))';
var DSHCHART_SESSION_COLLAPSED = 8;
var DSHCHART_SESSION_CLOSE_MS = 200;

var DSHCHART_CSS = `
.dsht-chart{position:relative;width:100%;min-width:0;color:var(--dsw-alias-label-primary)}
.dsht-chart>svg{display:block;width:100%;height:100%;overflow:visible;touch-action:pan-y;cursor:crosshair}
.dsht-chart.is-dragging>svg{cursor:col-resize;user-select:none}
.dsht-chart svg text{font-family:inherit;font-size:10.5px;font-variant-numeric:tabular-nums;user-select:none}
.dsht-chart-hl{pointer-events:none}
.dsht-chart-selection{pointer-events:none}
.dsht-chart-tip{position:absolute;z-index:9;pointer-events:none;box-sizing:border-box;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-overlay);box-shadow:0 10px 26px color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);font-size:11px;line-height:1.5}
.dsht-chart-tip-head{font-weight:600;margin-bottom:4px;white-space:nowrap}
.dsht-chart-tip-rows{display:flex;flex-direction:column;gap:1px}
.dsht-chart-tip-cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:12px;row-gap:1px}
.dsht-chart-tip-row{display:flex;align-items:center;gap:6px;min-width:0;white-space:nowrap}
.dsht-chart-tip-swatch{width:8px;height:8px;border-radius:2px;flex:0 0 auto}
.dsht-chart-tip-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}
.dsht-chart-tip-val{font-variant-numeric:tabular-nums;text-align:right}
.dsht-chart-tip-share{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);min-width:32px;text-align:right}
.dsht-chart-tip-total{margin-top:5px;padding-top:5px;border-top:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 70%,transparent);font-weight:600}
.dsht-chart-tip-all{margin-top:2px;color:var(--dsw-alias-label-secondary);font-weight:400}
.dsht-chart-skeleton{height:100%;display:flex;align-items:center;justify-content:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsht-chart-empty{height:100%;display:flex;align-items:center;justify-content:center}
.dsht-chart-loading{position:absolute;right:10px;top:8px;z-index:6;display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;pointer-events:none}
.dsht-chart-sess{position:absolute;z-index:10;display:flex;flex-direction:column;box-sizing:border-box;pointer-events:auto;overflow:hidden;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 10px 26px color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);color:var(--dsw-alias-label-primary);font-size:11px;line-height:1.45}
.dsht-chart-sess-head{display:flex;align-items:center;gap:8px;padding:6px 9px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 70%,transparent);font-weight:600;white-space:nowrap;flex:0 0 auto}
.dsht-chart-sess-range{min-width:0;overflow:hidden;text-overflow:ellipsis}
.dsht-chart-sess-total{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--dsw-alias-brand-primary)}
.dsht-chart-sess-list{flex:1 1 auto;min-height:0;max-height:220px;overflow-y:auto;overscroll-behavior:contain;padding:3px 4px}
.dsht-chart-sess-fallback{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:5px 8px 7px}
.dsht-chart-sess-item{display:block;min-width:0}
.dsht-chart-sess-item.is-inert{opacity:.6}
.dsht-chart-sess-row{display:block;width:100%;box-sizing:border-box;border:0;background:transparent;color:inherit;font-family:inherit;font-size:11px;line-height:1.4;text-align:left;padding:3px 5px;border-radius:6px;cursor:pointer}
.dsht-chart-sess-row:hover{background:var(--dsw-alias-bg-layer-2)}
.dsht-chart-sess-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.dsht-chart-sess-rowline{display:flex;align-items:center;gap:6px;min-width:0}
.dsht-chart-sess-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsht-chart-sess-val{flex:0 0 auto;font-variant-numeric:tabular-nums}
.dsht-chart-sess-share{display:block;height:2px;margin-top:3px;border-radius:1px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dsht-chart-sess-share-bar{display:block;height:100%;border-radius:1px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 70%,transparent)}
.dsht-chart-sess-detail{padding:0 5px 5px;color:var(--dsw-alias-label-secondary);font-size:10.5px;font-variant-numeric:tabular-nums;white-space:normal;overflow-wrap:anywhere}
.dsht-chart-sess-foot{flex:0 0 auto;border-top:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 70%,transparent);padding:2px}
.dsht-chart-sess-more{display:block;width:100%;box-sizing:border-box;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font-family:inherit;font-size:11px;padding:5px;border-radius:6px;cursor:pointer;text-align:center}
.dsht-chart-sess-more:hover{background:var(--dsw-alias-bg-layer-2)}
.dsht-chart-sess-more:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.dsht-chart-sess-note{padding:7px 9px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsht-chart-sess-err{padding:6px 9px 2px;color:var(--dsw-alias-state-error-primary);white-space:nowrap}
`;

/* ------------------------------------------------------------- small utils --- */

function DshChartClamp(value, min, max) {
  if (!isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Coerce to a finite non-negative number (negative / NaN / undefined → 0). */
function DshChartNum(value) {
  var n = Number(value);
  return isFinite(n) && n > 0 ? n : 0;
}

function DshChartPartValue(part, metric) {
  if (!part || typeof part !== 'object') return 0;
  return metric === 'cost' ? DshChartNum(part.cost) : DshChartNum(part.tokens);
}

function DshChartFmt(metric, value, currency) {
  if (metric === 'cost') return dshtokenFmtCost(value, currency);
  return dshtokenFmtTokens(value);
}

/** Fire a caller-supplied callback without letting its failure blank the slot. */
function DshChartInvoke(fn, a, b) {
  if (typeof fn !== 'function') return;
  try {
    if (arguments.length > 2) fn(a, b);
    else fn(a);
  } catch (error) {
    try {
      if (typeof console !== 'undefined' && console.error) {
        console.error('[dshtoken] chart callback failed', error);
      }
    } catch (ignored) {
      /* ignore */
    }
  }
}

/** Localized label for one dim: category keys use cat.*, __other uses common.other. */
function DshChartDimLabel(dim, t) {
  var key = dim && dim.key != null ? String(dim.key) : '';
  var kind = dim && dim.kind ? String(dim.kind) : '';
  if (kind === 'category') {
    var translated = t('cat.' + key);
    if (translated && translated !== 'cat.' + key) return translated;
  }
  if (key === '__other') {
    var other = t('common.other');
    if (other && other !== 'common.other') return other;
  }
  if (dim && dim.label != null && String(dim.label) !== '') return String(dim.label);
  return key;
}

/**
 * Stable per-dim CSS color derived exclusively from theme tokens.
 * `index` is the dim's index in the full `dims` array (not the visible subset),
 * so toggling a legend entry never recolors the remaining series.
 * Category keys get fixed semantic colors; provider/model/session series rotate
 * through color-mix() variants of --dsw-alias-brand-primary and the state tokens.
 */
function DshChartDimColor(dimKey, index, kind) {
  var key = dimKey == null ? '' : String(dimKey);
  if (kind === 'category') {
    if (key === 'hit') {
      return 'color-mix(in srgb,var(--dsw-alias-state-success-primary) 72%,var(--dsw-alias-brand-primary))';
    }
    if (key === 'miss') return 'var(--dsw-alias-brand-primary)';
    if (key === 'write') {
      return 'color-mix(in srgb,var(--dsw-alias-state-warn-primary) 68%,var(--dsw-alias-brand-primary))';
    }
    if (key === 'out') {
      return 'color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,var(--dsw-alias-brand-primary))';
    }
  }
  if (key === '__other') {
    return 'color-mix(in srgb,var(--dsw-alias-label-secondary) 58%,transparent)';
  }
  var idx = Math.floor(Math.abs(Number(index)));
  if (!isFinite(idx) || idx < 0) idx = 0;
  var token = DSHCHART_SERIES_TOKENS[idx % DSHCHART_SERIES_TOKENS.length];
  var weight =
    DSHCHART_SERIES_WEIGHTS[Math.floor(idx / DSHCHART_SERIES_TOKENS.length) % DSHCHART_SERIES_WEIGHTS.length];
  return 'color-mix(in srgb,var(--dsw-alias-brand-primary) ' + weight + '%,var(' + token + '))';
}

/**
 * Nice y-scale with 3–5 intervals (4–6 ticks; most data yields 4–5).
 * Token counts use integer steps only, because the shared token formatter
 * rounds to integers; cost may use 1/2/2.5/5 steps so tiny CNY values stay
 * positive on the axis. Returns { max, step, ticks } where ticks[0] === 0.
 */
function DshChartNiceScale(maxValue, metric) {
  var max = Number(maxValue);
  if (!isFinite(max) || max <= 0) return { max: 1, step: 1, ticks: [0, 1] };
  var isTokens = metric !== 'cost';
  var target = 4;
  var mants = [1, 2, 2.5, 5];
  var baseExp = Math.floor(Math.log10(max));
  var eStart = isTokens ? 0 : baseExp - 3;
  var eEnd = isTokens ? 15 : baseExp + 3;
  var best = null;
  for (var e = eStart; e <= eEnd; e++) {
    var magnitude = Math.pow(10, e);
    for (var mi = 0; mi < mants.length; mi++) {
      var step = mants[mi] * magnitude;
      if (!isFinite(step) || step <= 0) continue;
      /* Token axis labels come from dshtokenFmtTokens (integer rounding), so a
       * fractional token step would print duplicates such as "0 0 1 1". A 2.5
       * mantissa is fine once the step is a whole number (25, 250, 2.5k, …). */
      if (isTokens && (step < 1 || Math.abs(step - Math.round(step)) > 1e-9)) continue;
      var intervals = Math.ceil(max / step - 1e-9);
      if (intervals < 2 || intervals > 9) continue;
      var score;
      if (intervals === 4) score = 0;
      else if (intervals === 3) score = 1;
      else if (intervals === 5) score = 2;
      else if (intervals === 2) score = 4;
      else score = 6 + Math.abs(intervals - 4);
      score = score * 10 + (mants[mi] === 5 ? 1 : 0);
      if (!best || score < best.score) best = { step: step, intervals: intervals, score: score };
    }
  }
  if (!best) {
    var fallbackStep = isTokens ? Math.max(1, Math.ceil(max / target)) : max / target;
    var fallbackIntervals = Math.max(1, Math.ceil(max / fallbackStep - 1e-9));
    best = { step: fallbackStep, intervals: fallbackIntervals };
  }
  /* Float noise can make the rounded top a hair below the real max; never let
   * the tallest stack exceed the scaled plot box. */
  var neededIntervals = Math.ceil(max / best.step - 1e-9);
  if (neededIntervals > best.intervals) best.intervals = neededIntervals;
  var ticks = [];
  for (var ti = 0; ti <= best.intervals; ti++) ticks.push(best.step * ti);
  return { max: best.step * best.intervals, step: best.step, ticks: ticks };
}

/** Indices of x labels to render: stride-thinned, first and last always kept. */
function DshChartLabelIndices(count, maxLabels) {
  var out = [];
  if (count <= 0) return out;
  if (maxLabels < 2) maxLabels = 2;
  if (count <= maxLabels) {
    for (var i = 0; i < count; i++) out.push(i);
    return out;
  }
  var step = Math.ceil(count / maxLabels);
  for (var index = 0; index < count; index += step) out.push(index);
  var last = count - 1;
  if (out[out.length - 1] !== last) {
    /* Keeping the last label must not squeeze it next to the previous one:
     * replace the last stride label instead, which leaves a gap of >= step. */
    if (out.length > 1) out[out.length - 1] = last;
    else out.push(last);
  }
  return out;
}

/** End timestamp of one bucket: bucket.t1, else next bucket.t0, else duration. */
function DshChartItemEnd(item, index, items, bucketKind, offsetMs) {
  if (!item) return 0;
  if (item.t1 > item.t0) return item.t1;
  var next = index + 1 < items.length ? items[index + 1] : null;
  if (next && next.t0 > item.t0) return next.t0;
  if (bucketKind === 'hour') return item.t0 + 3600000;
  if (bucketKind === 'week') return item.t0 + 604800000;
  if (bucketKind === 'month') {
    var shifted = new Date(item.t0 + offsetMs);
    return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1) - offsetMs;
  }
  return item.t0 + 86400000;
}

/** Pointer x (client px) → bucket index; -1 outside the plot unless clamped. */
function DshChartPlotIndex(clientX, svg, geom, clampToPlot) {
  if (!svg || !geom || geom.count <= 0 || !(geom.band > 0) || !(geom.plotW > 0)) return -1;
  var rect = null;
  try {
    rect = typeof svg.getBoundingClientRect === 'function' ? svg.getBoundingClientRect() : null;
  } catch (error) {
    rect = null;
  }
  if (!rect || !isFinite(rect.width) || rect.width <= 0) return -1;
  var localX = (Number(clientX) - rect.left) * (geom.width / rect.width);
  var rel = localX - geom.padLeft;
  if (!clampToPlot && (rel < 0 || rel >= geom.plotW)) return -1;
  if (rel < 0) rel = 0;
  if (rel >= geom.plotW) rel = geom.plotW - 1e-6;
  var index = Math.floor(rel / geom.band);
  if (index < 0) index = 0;
  if (index >= geom.count) index = geom.count - 1;
  return index;
}

/** Shape handed to props.onHover (null while nothing is hovered). */
function DshChartHoverInfo(item, visibleDims, metric, currency, bucketKind) {
  var dims = [];
  for (var i = 0; i < visibleDims.length; i++) {
    var dim = visibleDims[i];
    dims.push({ key: dim.key, kind: dim.kind, label: dim.label, index: dim.index, color: dim.color });
  }
  return {
    t0: item.t0,
    t1: item.t1 || 0,
    bucket: bucketKind,
    index: item.index,
    total: item.totalPart,
    value: item.total,
    visibleTotal: item.total,
    byDim: item.byDim,
    dims: dims,
    metric: metric,
    currency: currency
  };
}

/** Rows for the generic (non-session) tooltip: one row per visible dim. */
function DshChartDimRows(hoverItem, dims, metric, currency, t) {
  var rows = [];
  for (var i = 0; i < dims.length; i++) {
    var dim = dims[i];
    var value = hoverItem.values[i];
    var share = hoverItem.total > 0 ? value / hoverItem.total : 0;
    var label = DshChartDimLabel(dim, t);
    rows.push(
      h(
        'div',
        { key: 'tip-dim-' + i, className: 'dsht-chart-tip-row' },
        h('span', { className: 'dsht-chart-tip-swatch', style: { background: dim.color } }),
        h('span', { className: 'dsht-chart-tip-label', title: label }, label),
        h('span', { className: 'dsht-chart-tip-val' }, DshChartFmt(metric, value, currency)),
        h('span', { className: 'dsht-chart-tip-share' }, dshtokenFmtPct(share))
      )
    );
  }
  return rows;
}

/** Total (+ hidden-series) rows shared by the generic tooltip and error fallback. */
function DshChartDimTotalRows(hoverItem, metric, currency, t) {
  var rows = [
    h(
      'div',
      { key: 'tip-total', className: 'dsht-chart-tip-row dsht-chart-tip-total' },
      h('span', { className: 'dsht-chart-tip-label' }, t('common.total')),
      h('span', { className: 'dsht-chart-tip-val' }, DshChartFmt(metric, hoverItem.total, currency))
    )
  ];
  var allValue = DshChartPartValue(hoverItem.totalPart, metric);
  if (allValue > hoverItem.total * 1.000001 + 1e-12) {
    rows.push(
      h(
        'div',
        { key: 'tip-all', className: 'dsht-chart-tip-row dsht-chart-tip-all' },
        h('span', { className: 'dsht-chart-tip-label' }, t('chart.allTotal')),
        h('span', { className: 'dsht-chart-tip-val' }, DshChartFmt(metric, allValue, currency))
      )
    );
  }
  return rows;
}

function DshChartSessionLabel(row) {
  if (!row || typeof row !== 'object') return '';
  if (typeof row.title === 'string' && row.title) return row.title;
  if (typeof row.label === 'string' && row.label) return row.label;
  return row.key == null ? '' : String(row.key);
}

function DshChartSessionValue(row, metric) {
  if (!row || typeof row !== 'object') return 0;
  return metric === 'cost' ? DshChartNum(row.cost) : DshChartNum(row.tokens);
}

/** Inline detail line for one expanded session row. */
function DshChartSessionDetail(row, metric, t) {
  var pieces = [];
  if (metric === 'cost') {
    pieces.push(t('common.tokens') + ' ' + dshtokenFmtTokens(DshChartNum(row && row.tokens)));
  } else {
    pieces.push(t('cat.miss') + ' ' + dshtokenFmtTokens(DshChartNum(row && row.miss)));
    pieces.push(t('cat.hit') + ' ' + dshtokenFmtTokens(DshChartNum(row && row.hit)));
    pieces.push(t('cat.write') + ' ' + dshtokenFmtTokens(DshChartNum(row && row.write)));
    pieces.push(t('cat.out') + ' ' + dshtokenFmtTokens(DshChartNum(row && row.out)));
  }
  pieces.push(t('chart.sess.requests') + ' ' + dshtokenFmtInt(DshChartNum(row && row.requests)));
  return pieces.join(' · ');
}

/* ------------------------------------------------------------- component --- */

function DshTokenChart(props) {
  var p = props || {};
  var t = dshtokenUseT(p);

  var hostRef = React.useRef(null);
  var widthPair = React.useState(0);
  var hoverPair = React.useState(-1);
  var dragPair = React.useState(null);
  var gestureRef = React.useRef(null);
  var hoverRef = React.useRef(-1);
  var rowsExpandedPair = React.useState(false);
  var expandedRowPair = React.useState(null);
  var requestedBucketRef = React.useRef(null);
  var requestedHadRowsRef = React.useRef(false);
  var closeTimerRef = React.useRef(null);

  var width = widthPair[0];
  var setWidth = widthPair[1];
  var hoverState = hoverPair[0];
  var setHoverState = hoverPair[1];
  var dragState = dragPair[0];
  var setDragState = dragPair[1];
  var rowsExpanded = rowsExpandedPair[0];
  var setRowsExpanded = rowsExpandedPair[1];
  var expandedRowKey = expandedRowPair[0];
  var setExpandedRowKey = expandedRowPair[1];
  var isDragging = dragState != null;

  /* Measure the component's own container: ResizeObserver, cleaned up on
   * unmount. Window resize is only a fallback when ResizeObserver is missing. */
  var useMeasureEffect =
    typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect;
  useMeasureEffect(function () {
    var node = hostRef.current;
    if (!node) return undefined;
    function readWidth() {
      var value = 0;
      try {
        if (typeof node.getBoundingClientRect === 'function') {
          var rect = node.getBoundingClientRect();
          value = rect && isFinite(rect.width) && rect.width > 0 ? rect.width : node.clientWidth || 0;
        } else {
          value = node.clientWidth || 0;
        }
      } catch (error) {
        value = 0;
      }
      var next = Math.max(0, Math.round(value * 10) / 10);
      setWidth(function (prev) {
        return Math.abs(prev - next) > 0.4 ? next : prev;
      });
    }
    readWidth();
    var observer = null;
    if (typeof ResizeObserver === 'function') {
      try {
        observer = new ResizeObserver(function () {
          readWidth();
        });
        observer.observe(node);
      } catch (error) {
        observer = null;
      }
    }
    function onWindowResize() {
      readWidth();
    }
    if (!observer && typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('resize', onWindowResize);
    }
    return function () {
      if (observer) {
        try {
          observer.disconnect();
        } catch (error) {
          /* ignore */
        }
      } else if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('resize', onWindowResize);
      }
    };
  }, []);

  /* Escape cancels an in-flight drag selection (never fires a click either). */
  React.useEffect(
    function () {
      if (!isDragging) return undefined;
      function onKeyDown(event) {
        if (event.key !== 'Escape') return;
        var gesture = gestureRef.current;
        if (gesture) {
          gesture.cancelled = true;
          gesture.dragging = false;
          try {
            if (gesture.svg && gesture.svg.releasePointerCapture) {
              gesture.svg.releasePointerCapture(gesture.pointerId);
            }
          } catch (error) {
            /* ignore */
          }
        }
        gestureRef.current = null;
        setDragState(null);
      }
      document.addEventListener('keydown', onKeyDown, true);
      return function () {
        document.removeEventListener('keydown', onKeyDown, true);
      };
    },
    [isDragging]
  );

  /* A pending session-panel close timer must never outlive the component. */
  React.useEffect(
    function () {
      return function () {
        if (closeTimerRef.current) {
          try {
            clearTimeout(closeTimerRef.current);
          } catch (error) {
            /* ignore */
          }
          closeTimerRef.current = null;
        }
      };
    },
    []
  );

  /* Session-mode request bookkeeping resets when the mode changes. */
  React.useEffect(
    function () {
      requestedBucketRef.current = null;
      requestedHadRowsRef.current = false;
    },
    [sessionMode]
  );

  /* ------------------------------------------------------------ derive --- */

  var heightInput = Number(p.height);
  var heightPx = Math.round(
    DshChartClamp(isFinite(heightInput) && heightInput > 0 ? heightInput : DSHCHART_DEFAULT_HEIGHT, 140, 2000)
  );
  var metric = p.metric === 'cost' ? 'cost' : 'tokens';
  var currency = typeof p.currency === 'string' && p.currency ? p.currency : 'CNY';
  var bucketKind = typeof p.bucket === 'string' && p.bucket ? p.bucket : 'day';
  var offsetInput = typeof p.offsetMs === 'number' ? p.offsetMs : NaN;
  var offsetMs = isFinite(offsetInput) ? offsetInput : 480 * 60000;

  var rawBuckets = Array.isArray(p.buckets) ? p.buckets : [];
  var rawDims = Array.isArray(p.dims) ? p.dims : [];
  var activeDims = Array.isArray(p.activeDims) ? p.activeDims : null;

  /* Optional session-mode props (missing/undefined => the classic stacked chart). */
  var sessionMode = p.sessionMode === true;
  var sessionRows = Array.isArray(p.sessionRows) ? p.sessionRows : null;
  var sessionLoading = !!p.sessionLoading;
  var sessionError = !!p.sessionError;
  var hasSessionApi = typeof p.onRequestBucketSessions === 'function';
  var hasSessionRows = hasSessionApi || sessionRows !== null || sessionLoading || sessionError;

  var visibleDims = [];
  for (var dimIndex = 0; dimIndex < rawDims.length && visibleDims.length < 64; dimIndex++) {
    var rawDim = rawDims[dimIndex];
    if (!rawDim || typeof rawDim !== 'object' || rawDim.key == null) continue;
    var dimKey = String(rawDim.key);
    if (activeDims && activeDims.indexOf(dimKey) < 0) continue;
    var dimKind = typeof rawDim.kind === 'string' ? rawDim.kind : '';
    visibleDims.push({
      key: dimKey,
      kind: dimKind,
      label: rawDim.label,
      index: dimIndex,
      color: DshChartDimColor(dimKey, dimIndex, dimKind)
    });
  }

  /* One normalized entry per usable bucket; values are aligned with visibleDims.
   * `total` is the visible stacked value (hidden dims excluded from stack+scale). */
  var items = [];
  var maxTotal = 0;
  var bucketLimit = rawBuckets.length > 1000 ? 1000 : rawBuckets.length;
  for (var bucketIndex = 0; bucketIndex < bucketLimit; bucketIndex++) {
    var rawBucket = rawBuckets[bucketIndex];
    if (!rawBucket || typeof rawBucket !== 'object') continue;
    var t0 = Number(rawBucket.t0);
    if (!isFinite(t0)) continue;
    var t1 = Number(rawBucket.t1);
    var byDim = rawBucket.byDim && typeof rawBucket.byDim === 'object' ? rawBucket.byDim : {};
    var values = [];
    var total = 0;
    for (var valueIndex = 0; valueIndex < visibleDims.length; valueIndex++) {
      var partValue = DshChartPartValue(byDim[visibleDims[valueIndex].key], metric);
      values.push(partValue);
      total += partValue;
    }
    var barValue = total;
    if (sessionMode) {
      /* Session mode: one bar per bucket from the host bucket total; when the
       * host omits `total`, fall back to summing every dim (hidden included) so
       * a missing/empty activeDims list never hides the bars. */
      barValue = DshChartPartValue(rawBucket.total, metric);
      if (!(barValue > 0)) {
        barValue = 0;
        for (var allDimIndex = 0; allDimIndex < rawDims.length; allDimIndex++) {
          var allDim = rawDims[allDimIndex];
          if (!allDim || typeof allDim !== 'object' || allDim.key == null) continue;
          barValue += DshChartPartValue(byDim[String(allDim.key)], metric);
        }
      }
    }
    if (barValue > maxTotal) maxTotal = barValue;
    items.push({
      index: items.length,
      t0: t0,
      t1: isFinite(t1) && t1 > t0 ? t1 : 0,
      byDim: byDim,
      totalPart: rawBucket.total && typeof rawBucket.total === 'object' ? rawBucket.total : null,
      values: values,
      total: total,
      barValue: barValue
    });
  }

  var hasData = items.length > 0 && maxTotal > 0;
  var loading = !!p.loading;
  var showSkeleton = loading && !hasData;
  var scale = DshChartNiceScale(maxTotal, metric);

  /* Ask page.js for the hovered bucket's session rows. Strictly one request per
   * bucket while page.js reports data/loading/error; if rows that once existed
   * disappear again (page cache cleared/evicted) a fresh request is allowed. */
  var hoveredItem = hoverState >= 0 && hoverState < items.length ? items[hoverState] : null;
  var hoveredBucketT0 = hoveredItem ? hoveredItem.t0 : 0;
  React.useEffect(
    function () {
      if (!sessionMode || !hasSessionApi || hoverState < 0 || hoverState >= items.length) return;
      var requestItem = items[hoverState];
      if (!requestItem) return;
      var rowStateAvailable = sessionRows !== null || sessionLoading || sessionError;
      if (requestedBucketRef.current === requestItem.t0) {
        if (rowStateAvailable) {
          requestedHadRowsRef.current = sessionRows !== null;
          return;
        }
        /* Initial request already sent: wait for page.js to report loading/data. */
        if (!requestedHadRowsRef.current) return;
        /* Rows existed before and the page cache lost them: request again. */
        requestedHadRowsRef.current = false;
      } else {
        requestedBucketRef.current = requestItem.t0;
        requestedHadRowsRef.current = false;
      }
      DshChartInvoke(
        p.onRequestBucketSessions,
        requestItem.t0,
        DshChartItemEnd(requestItem, hoverState, items, bucketKind, offsetMs)
      );
    },
    [
      sessionMode,
      hasSessionApi,
      hoverState,
      hoveredBucketT0,
      sessionRows,
      sessionLoading,
      sessionError,
      p.onRequestBucketSessions
    ]
  );

  var content = null;
  var tooltip = null;
  var loadingChip = null;

  if (showSkeleton) {
    var loadingLabel = t('chart.loading');
    content = h(
      'div',
      { className: 'dsht-chart-skeleton', role: 'status', 'aria-label': loadingLabel },
      h(DshSpinner, { label: loadingLabel }),
      h('span', null, loadingLabel)
    );
  } else if (!hasData) {
    var emptyTitle = typeof p.emptyTitle === 'string' && p.emptyTitle ? p.emptyTitle : t('common.empty');
    content = h(
      'div',
      { className: 'dsht-chart-empty' },
      h(DshEmpty, { title: emptyTitle, hint: t('chart.emptyHint'), icon: 'chart' })
    );
  } else if (width > 0) {
    /* ------------------------------------------------------- geometry --- */
    var padTop = 14;
    var padBottom = 26;
    var padRight = 10;
    var tickLabels = [];
    var maxLabelChars = 3;
    for (var tickIndex = 0; tickIndex < scale.ticks.length; tickIndex++) {
      var tickLabel = DshChartFmt(metric, scale.ticks[tickIndex], currency);
      tickLabels.push(tickLabel);
      if (String(tickLabel).length > maxLabelChars) maxLabelChars = String(tickLabel).length;
    }
    var padLeft = DshChartClamp(Math.round(maxLabelChars * 6.4 + 12), 34, 96);
    if (width < 140) padLeft = Math.min(padLeft, Math.max(16, Math.round(width * 0.34)));
    var plotW = width - padLeft - padRight;
    if (plotW < 8) plotW = 8;
    var plotH = heightPx - padTop - padBottom;
    if (plotH < 40) plotH = 40;
    var count = items.length;
    var band = plotW / count;
    /* Wide columns keep a gap between bars; very thin columns (up to 1000
     * buckets) need at least a hairline of width and no crisp snapping. */
    var barW = band >= 4 ? Math.min(band * 0.72, 64) : Math.max(band, 1);
    var barCrisp = band >= 2 ? 'crispEdges' : 'auto';
    var baselineY = padTop + plotH;

    var geom = {
      width: width,
      height: heightPx,
      padLeft: padLeft,
      padTop: padTop,
      padRight: padRight,
      padBottom: padBottom,
      plotW: plotW,
      plotH: plotH,
      band: band,
      count: count,
      baselineY: baselineY
    };

    function yFor(value) {
      return baselineY - (value / scale.max) * plotH;
    }

    /* The session hover panel is mouse-reachable: leaving the svg starts a
     * ~200ms delayed close which entering the panel (or another bar) cancels. */
    function cancelSessionClose() {
      if (closeTimerRef.current) {
        try {
          clearTimeout(closeTimerRef.current);
        } catch (error) {
          /* ignore */
        }
        closeTimerRef.current = null;
      }
    }

    function scheduleSessionClose() {
      if (closeTimerRef.current) return;
      if (typeof setTimeout !== 'function') {
        beginHover(-1);
        return;
      }
      closeTimerRef.current = setTimeout(function () {
        closeTimerRef.current = null;
        beginHover(-1);
      }, DSHCHART_SESSION_CLOSE_MS);
    }

    function closeSessionPanel() {
      cancelSessionClose();
      beginHover(-1);
    }

    function beginHover(index) {
      var next = index >= 0 && index < count ? index : -1;
      if (next >= 0) cancelSessionClose();
      if (hoverRef.current === next) return;
      hoverRef.current = next;
      setHoverState(next);
      setRowsExpanded(false);
      setExpandedRowKey(null);
      var info = next >= 0 ? DshChartHoverInfo(items[next], visibleDims, metric, currency, bucketKind) : null;
      DshChartInvoke(p.onHover, info);
    }

    function onPointerDown(event) {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      var existing = gestureRef.current;
      if (existing && existing.dragging) return;
      var startIndex = DshChartPlotIndex(event.clientX, event.currentTarget, geom, false);
      if (startIndex < 0) return;
      gestureRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startIndex: startIndex,
        svg: event.currentTarget,
        dragging: false,
        cancelled: false
      };
      beginHover(startIndex);
    }

    function onPointerMove(event) {
      var gesture = gestureRef.current;
      if (gesture && gesture.pointerId === event.pointerId) {
        var dx = event.clientX - gesture.startX;
        if (!gesture.dragging && Math.abs(dx) >= 4) {
          gesture.dragging = true;
          try {
            if (gesture.svg && gesture.svg.setPointerCapture) {
              gesture.svg.setPointerCapture(gesture.pointerId);
            }
          } catch (error) {
            /* ignore */
          }
          beginHover(-1);
        }
        if (gesture.dragging) {
          if (event.cancelable) event.preventDefault();
          var dragIndex = DshChartPlotIndex(event.clientX, gesture.svg, geom, true);
          if (dragIndex < 0) dragIndex = gesture.startIndex;
          var dragFrom = Math.min(gesture.startIndex, dragIndex);
          var dragTo = Math.max(gesture.startIndex, dragIndex);
          setDragState(function (prev) {
            if (prev && prev.from === dragFrom && prev.to === dragTo) return prev;
            return { from: dragFrom, to: dragTo };
          });
          return;
        }
      }
      beginHover(DshChartPlotIndex(event.clientX, event.currentTarget, geom, false));
    }

    function releasePointer(gesture) {
      try {
        if (gesture && gesture.svg && gesture.svg.releasePointerCapture) {
          gesture.svg.releasePointerCapture(gesture.pointerId);
        }
      } catch (error) {
        /* ignore */
      }
    }

    function onPointerUp(event) {
      var gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gestureRef.current = null;
      var wasDragging = gesture.dragging;
      if (wasDragging) {
        setDragState(null);
        releasePointer(gesture);
      }
      if (gesture.cancelled) return;
      if (wasDragging) {
        var endIndex = DshChartPlotIndex(event.clientX, gesture.svg, geom, true);
        if (endIndex < 0) endIndex = gesture.startIndex;
        var rangeFrom = Math.min(gesture.startIndex, endIndex);
        var rangeTo = Math.max(gesture.startIndex, endIndex);
        var startItem = items[rangeFrom];
        var endItem = items[rangeTo];
        if (startItem && endItem) {
          DshChartInvoke(
            p.onSelectRange,
            startItem.t0,
            DshChartItemEnd(endItem, rangeTo, items, bucketKind, offsetMs)
          );
        }
        return;
      }
      /* Less than 4px of horizontal movement counts as a click on the column. */
      var clickItem = items[gesture.startIndex];
      if (clickItem) {
        DshChartInvoke(
          p.onPickBucket,
          clickItem.t0,
          DshChartItemEnd(clickItem, gesture.startIndex, items, bucketKind, offsetMs)
        );
      }
    }

    function onPointerCancel(event) {
      var gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gestureRef.current = null;
      gesture.cancelled = true;
      gesture.dragging = false;
      setDragState(null);
    }

    function onLostPointerCapture(event) {
      var gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gestureRef.current = null;
      gesture.dragging = false;
      gesture.cancelled = true;
      setDragState(null);
    }

    function onPointerLeave() {
      if (gestureRef.current) return;
      if (sessionMode) {
        scheduleSessionClose();
        return;
      }
      beginHover(-1);
    }

    /* ----------------------------------------------------- svg content --- */
    var svgChildren = [];
    for (var gridIndex = 0; gridIndex < scale.ticks.length; gridIndex++) {
      var gridY = DshChartClamp(yFor(scale.ticks[gridIndex]), padTop, baselineY);
      if (gridIndex > 0) {
        svgChildren.push(
          h('line', {
            key: 'grid-' + gridIndex,
            x1: padLeft,
            x2: padLeft + plotW,
            y1: gridY,
            y2: gridY,
            stroke: 'color-mix(in srgb,var(--dsw-alias-border-l1) 55%,transparent)',
            strokeWidth: 1,
            shapeRendering: 'crispEdges'
          })
        );
      }
      svgChildren.push(
        h(
          'text',
          {
            key: 'ytick-' + gridIndex,
            x: padLeft - 6,
            y: gridY,
            textAnchor: 'end',
            dominantBaseline: 'middle',
            fill: 'var(--dsw-alias-label-secondary)'
          },
          tickLabels[gridIndex]
        )
      );
    }
    svgChildren.push(
      h('line', {
        key: 'baseline',
        x1: padLeft,
        x2: padLeft + plotW,
        y1: baselineY,
        y2: baselineY,
        stroke: 'var(--dsw-alias-border-l2)',
        strokeWidth: 1,
        shapeRendering: 'crispEdges'
      })
    );

    var hoverIndex = hoverState >= 0 && hoverState < count ? hoverState : -1;
    if (hoverIndex >= 0) {
      svgChildren.push(
        h('rect', {
          key: 'hover-highlight',
          className: 'dsht-chart-hl',
          x: padLeft + hoverIndex * band,
          y: padTop,
          width: band,
          height: plotH,
          fill: 'color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,transparent)'
        })
      );
    }

    for (var barIndex = 0; barIndex < count; barIndex++) {
      var barItem = items[barIndex];
      var columnX = padLeft + barIndex * band;
      var barX = columnX + (band - barW) / 2;
      if (barX < padLeft) barX = padLeft;
      if (sessionMode) {
        /* One single-color, non-stacked bar per bucket (bucket total value). */
        var sessionBarValue = barItem.barValue;
        if (!(sessionBarValue > 0)) continue;
        var sessionBarH = (sessionBarValue / scale.max) * plotH;
        if (!(sessionBarH > 0)) continue;
        var sessionBarY = baselineY - sessionBarH;
        if (sessionBarY < padTop) sessionBarY = padTop;
        var sessionBarRectH = sessionBarH > 0.6 ? sessionBarH : 0.6;
        svgChildren.push(
          h('rect', {
            key: 'bar-' + barIndex,
            x: barX,
            y: sessionBarY,
            width: barW,
            height: sessionBarRectH,
            fill: DSHCHART_SESSION_COLOR,
            shapeRendering: barCrisp
          })
        );
        continue;
      }
      var cursorY = baselineY;
      for (var seriesIndex = 0; seriesIndex < visibleDims.length; seriesIndex++) {
        var seriesValue = barItem.values[seriesIndex];
        if (!(seriesValue > 0)) continue;
        var segmentH = (seriesValue / scale.max) * plotH;
        if (!(segmentH > 0)) continue;
        cursorY -= segmentH;
        var rectY = cursorY < padTop ? padTop : cursorY;
        var rectH = segmentH > 0.6 ? segmentH : 0.6;
        svgChildren.push(
          h('rect', {
            key: 'bar-' + barIndex + '-' + seriesIndex,
            x: barX,
            y: rectY,
            width: barW,
            height: rectH,
            fill: visibleDims[seriesIndex].color,
            shapeRendering: barCrisp
          })
        );
      }
    }

    if (dragState) {
      var selectionFrom = DshChartClamp(Math.min(dragState.from, dragState.to), 0, count - 1);
      var selectionTo = DshChartClamp(Math.max(dragState.from, dragState.to), 0, count - 1);
      svgChildren.push(
        h('rect', {
          key: 'drag-selection',
          className: 'dsht-chart-selection',
          x: padLeft + selectionFrom * band,
          y: padTop,
          width: (selectionTo - selectionFrom + 1) * band,
          height: plotH,
          fill: 'color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)',
          stroke: 'color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent)',
          strokeWidth: 1,
          strokeDasharray: '3 3'
        })
      );
    }

    var maxLabels = Math.max(2, Math.floor(plotW / DSHCHART_MIN_LABEL_GAP));
    var labelIndices = DshChartLabelIndices(count, maxLabels);
    for (var labelIndex = 0; labelIndex < labelIndices.length; labelIndex++) {
      var xIndex = labelIndices[labelIndex];
      var xAnchor = 'middle';
      var xPos = padLeft + xIndex * band + band / 2;
      if (xIndex === 0) {
        xAnchor = 'start';
        xPos = padLeft;
      } else if (xIndex === count - 1) {
        xAnchor = 'end';
        xPos = padLeft + plotW;
      }
      svgChildren.push(
        h(
          'text',
          {
            key: 'xlabel-' + xIndex,
            x: xPos,
            y: heightPx - 8,
            textAnchor: xAnchor,
            fill: 'var(--dsw-alias-label-secondary)'
          },
          dshtokenFmtBucketLabel(items[xIndex].t0, bucketKind, offsetMs)
        )
      );
    }

    var metricText = t(metric === 'cost' ? 'common.cost' : 'common.tokens');
    var ariaLabel = t('chart.aria', { count: count, metric: metricText });
    if (typeof ariaLabel !== 'string' || ariaLabel.indexOf('{') >= 0) {
      ariaLabel = t('chart.ariaBase') + ' · ' + count + ' · ' + metricText;
    }

    content = h(
      'svg',
      {
        role: 'img',
        'aria-label': ariaLabel,
        width: width,
        height: heightPx,
        viewBox: '0 0 ' + width + ' ' + heightPx,
        className: 'dsht-chart-svg',
        onPointerDown: onPointerDown,
        onPointerMove: onPointerMove,
        onPointerUp: onPointerUp,
        onPointerCancel: onPointerCancel,
        onPointerLeave: onPointerLeave,
        onLostPointerCapture: onLostPointerCapture
      },
      svgChildren
    );

    /* --------------------------------------------------------- tooltip --- */
    var genericTooltipFor = function (hoverItem) {
      var twoColumns = visibleDims.length > 8;
      var desiredWidth = twoColumns ? 316 : 244;
      var tipWidth = Math.min(desiredWidth, Math.max(80, width - 16));
      if (tipWidth < 260) twoColumns = false;
      var tipLeft = padLeft + hoverIndex * band + band / 2 + 14;
      if (tipLeft + tipWidth > width - 8) tipLeft = width - tipWidth - 8;
      if (tipLeft < 4) tipLeft = 4;
      var tipRows = DshChartDimRows(hoverItem, visibleDims, metric, currency, t);
      var tipChildren = [
        h(
          'div',
          { key: 'tip-head', className: 'dsht-chart-tip-head' },
          dshtokenFmtBucketRange(hoverItem.t0, bucketKind, offsetMs)
        ),
        h(
          'div',
          {
            key: 'tip-rows',
            className: 'dsht-chart-tip-rows' + (twoColumns ? ' dsht-chart-tip-cols' : '')
          },
          tipRows
        )
      ];
      var totalRows = DshChartDimTotalRows(hoverItem, metric, currency, t);
      for (var totalIndex = 0; totalIndex < totalRows.length; totalIndex++) {
        tipChildren.push(totalRows[totalIndex]);
      }
      var allValue = DshChartPartValue(hoverItem.totalPart, metric);
      var hasHiddenValue = allValue > hoverItem.total * 1.000001 + 1e-12;
      var rowCount = Math.ceil(visibleDims.length / (twoColumns ? 2 : 1));
      var estimateHeight = 30 + rowCount * 17 + 24 + (hasHiddenValue ? 22 : 0);
      var tipTop = Math.max(6, Math.min(padTop + 2, heightPx - estimateHeight - 8));
      return h(
        'div',
        {
          className: 'dsht-chart-tip',
          role: 'tooltip',
          style: { left: tipLeft + 'px', top: tipTop + 'px', width: tipWidth + 'px' }
        },
        tipChildren
      );
    };

    /* Session mode replaces the generic tooltip with an interactive, mouse
     * reachable session list for the hovered bucket. */
    var sessionPanelFor = function (hoverItem) {
      var panelWidth = Math.min(320, Math.max(160, width - 16));
      var panelMaxHeight = Math.max(120, Math.min(300, heightPx - 20));
      var panelLeft = padLeft + hoverIndex * band + band / 2 + 14;
      if (panelLeft + panelWidth > width - 8) panelLeft = width - panelWidth - 8;
      if (panelLeft < 4) panelLeft = 4;
      var panelTop = Math.max(4, Math.min(padTop + 2, heightPx - panelMaxHeight - 4));
      /* In session mode the bar (and therefore the panel total) is the host
       * bucket total; `barValue` already falls back to a byDim sum if needed. */
      var hoverTotal = hoverItem.barValue != null ? hoverItem.barValue : hoverItem.total;

      var renderSessionRow = function (row, rowIndex) {
        var rowKey = row && row.key != null ? String(row.key) : '';
        var label = DshChartSessionLabel(row);
        var value = DshChartSessionValue(row, metric);
        var share = hoverTotal > 0 ? value / hoverTotal : 0;
        var sharePct = DshChartClamp(share * 100, 0, 100);
        var inert = rowKey === '__other';
        var expanded = !inert && expandedRowKey !== null && expandedRowKey === rowKey;
        var rowLine = h(
          'span',
          { key: 'line', className: 'dsht-chart-sess-rowline' },
          h('span', { className: 'dsht-chart-sess-label', title: label }, label),
          h('span', { className: 'dsht-chart-sess-val' }, DshChartFmt(metric, value, currency))
        );
        var shareLine = h(
          'span',
          { key: 'share', className: 'dsht-chart-sess-share' },
          h('span', { className: 'dsht-chart-sess-share-bar', style: { width: sharePct.toFixed(2) + '%' } })
        );
        var itemChildren = [];
        if (inert) {
          itemChildren.push(
            h(
              'div',
              { key: 'row', className: 'dsht-chart-sess-row is-inert', 'aria-disabled': 'true', title: label },
              [rowLine, shareLine]
            )
          );
        } else {
          itemChildren.push(
            h(
              'button',
              {
                key: 'row',
                type: 'button',
                className: 'dsht-chart-sess-row',
                title: label + ' · ' + t('chart.sess.openHint'),
                'aria-expanded': expanded ? 'true' : 'false',
                onClick: function () {
                  setExpandedRowKey(function (previous) {
                    return previous === rowKey ? null : rowKey;
                  });
                },
                onDoubleClick: function () {
                  if (!rowKey || rowKey === '__other') return;
                  DshChartInvoke(p.onOpenSession, rowKey);
                  closeSessionPanel();
                }
              },
              [rowLine, shareLine]
            )
          );
        }
        if (expanded) {
          itemChildren.push(
            h('div', { key: 'detail', className: 'dsht-chart-sess-detail' }, DshChartSessionDetail(row, metric, t))
          );
        }
        return h(
          'div',
          {
            key: 'sess-' + rowIndex + '-' + rowKey,
            className: 'dsht-chart-sess-item' + (inert ? ' is-inert' : '')
          },
          itemChildren
        );
      };

      var panelBody = [];
      if (sessionError) {
        var fallbackChildren = DshChartDimRows(hoverItem, visibleDims, metric, currency, t);
        var fallbackTotals = DshChartDimTotalRows(hoverItem, metric, currency, t);
        for (var fallbackIndex = 0; fallbackIndex < fallbackTotals.length; fallbackIndex++) {
          fallbackChildren.push(fallbackTotals[fallbackIndex]);
        }
        panelBody.push(h('div', { key: 'sess-err', className: 'dsht-chart-sess-err' }, t('chart.sess.error')));
        panelBody.push(
          h('div', { key: 'sess-fallback', className: 'dsht-chart-sess-fallback' }, fallbackChildren)
        );
      } else if (!sessionRows || (!sessionRows.length && sessionLoading)) {
        panelBody.push(h('div', { key: 'sess-loading', className: 'dsht-chart-sess-note' }, t('chart.sess.loading')));
      } else if (!sessionRows.length) {
        panelBody.push(h('div', { key: 'sess-empty', className: 'dsht-chart-sess-note' }, t('chart.sess.empty')));
      } else {
        var allRows = sessionRows;
        var showMore = allRows.length > DSHCHART_SESSION_COLLAPSED;
        var shownRows = rowsExpanded || !showMore ? allRows : allRows.slice(0, DSHCHART_SESSION_COLLAPSED);
        var rowElements = [];
        for (var sessionRowIndex = 0; sessionRowIndex < shownRows.length; sessionRowIndex++) {
          rowElements.push(renderSessionRow(shownRows[sessionRowIndex], sessionRowIndex));
        }
        panelBody.push(h('div', { key: 'sess-list', className: 'dsht-chart-sess-list' }, rowElements));
        if (showMore) {
          panelBody.push(
            h(
              'div',
              { key: 'sess-foot', className: 'dsht-chart-sess-foot' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsht-chart-sess-more',
                  'aria-expanded': rowsExpanded ? 'true' : 'false',
                  onClick: function () {
                    setRowsExpanded(function (previous) {
                      return !previous;
                    });
                  }
                },
                rowsExpanded ? t('chart.sess.collapse') : t('chart.sess.expand', { count: allRows.length })
              )
            )
          );
        }
      }

      return h(
        'div',
        {
          className: 'dsht-chart-sess',
          role: 'group',
          'aria-label': t('chart.sess.panel'),
          style: {
            left: panelLeft + 'px',
            top: panelTop + 'px',
            width: panelWidth + 'px',
            maxHeight: panelMaxHeight + 'px'
          },
          onPointerEnter: cancelSessionClose,
          onPointerLeave: scheduleSessionClose
        },
        h(
          'div',
          { key: 'sess-head', className: 'dsht-chart-sess-head' },
          h(
            'span',
            { className: 'dsht-chart-sess-range' },
            dshtokenFmtBucketRange(hoverItem.t0, bucketKind, offsetMs)
          ),
          h('span', { className: 'dsht-chart-sess-total' }, DshChartFmt(metric, hoverTotal, currency))
        ),
        panelBody
      );
    };

    if (hoverIndex >= 0) {
      var hoverItem = items[hoverIndex];
      if (sessionMode && hasSessionRows) {
        tooltip = sessionPanelFor(hoverItem);
      } else {
        tooltip = genericTooltipFor(hoverItem);
      }
    }

    if (loading) {
      var loadingText = t('chart.loading');
      loadingChip = h(
        'div',
        { className: 'dsht-chart-loading' },
        h(DshSpinner, { label: loadingText, size: 12 }),
        h('span', null, loadingText)
      );
    }
  }

  return h(
    'div',
    {
      ref: hostRef,
      className: 'dsht-chart' + (isDragging ? ' is-dragging' : ''),
      style: { height: heightPx + 'px' },
      'data-dshtoken-chart': '1'
    },
    h(DshStyle, { key: 'style', id: 'chart', css: DSHCHART_CSS }),
    content,
    tooltip,
    loadingChip
  );
}
