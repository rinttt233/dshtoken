/* ============================================================================
 * page.js — standalone Token statistics page (slot `main`, key `dshtoken`).
 *
 * Owned by client-page. This fragment is concatenated after shared.js and
 * chart.js in one factory scope:
 *   - top level: `var` + function declarations only, all names prefixed;
 *   - no import/export; no DOM work at load time (only inside event handlers);
 *   - colors: only --dsw-alias-* tokens or color-mix() of them;
 *   - every optional field/prop is guarded; API failure renders an error box.
 *
 * Data flow:
 *   meta / status / stats / titles from the Host API via dshtokenApi.
 *   Prefs persisted with dshtokenUsePersisted, all dates computed with
 *   meta.timezoneOffsetMinutes (never the browser timezone).
 * ========================================================================== */

/* ---------------------------------------------------------------- i18n --- */

var DSHTOKEN_I18N_PAGE = {
  zh: {
    'page.title': 'Token 统计',
    'page.desc': '按时间范围汇总本机会话的 Provider 上报用量；费用由可编辑价格表估算。',
    'page.refresh': '刷新',
    'page.rebuild': '重建索引',
    'page.rebuildHint': '重新扫描全部会话（后台进行，期间继续使用旧索引）',
    'page.rebuildStarted': '已开始重建索引',
    'page.autoRefresh': '自动刷新',
    'page.autoRefreshHint': '页面可见时每 15 秒刷新一次，切到后台会暂停',
    'page.settings': '设置',
    'page.indexed': '已索引 {indexed}/{total} 个会话',
    'page.indexing': '正在扫描 {scanned}/{total}',
    'page.indexIdle': '索引准备中',
    'page.indexErrors': '{count} 个错误',
    'page.indexErrorsTitle': '扫描错误',
    'page.indexReady': '索引就绪',
    'page.partial': '部分会话尚未完成索引，当前统计可能不完整。',
    'page.partialRunning': '索引构建中：已扫描 {scanned}/{total} 个会话，数据会持续更新。',
    'page.range': '范围',
    'page.loading': '加载中…',
    'page.error.meta': '读取索引元数据失败',
    'page.error.stats': '读取统计失败',
    'page.error.rank': '读取排行失败',
    'page.card.tokens': '总 Tokens',
    'page.card.tokensSub': '{requests} 次请求',
    'page.card.cost': '估算花费',
    'page.card.costSub': '未定价 {tokens} tokens',
    'page.card.costSubPriced': '全部用量均已定价',
    'page.card.cacheHit': '缓存命中率',
    'page.card.cacheHitSub': '命中 {hit} / 输入 {input}',
    'page.card.avg': '日均 Tokens',
    'page.card.avgSub': '共 {days} 天',
    'page.card.peak': '峰值时段',
    'page.card.peakSub': '{tokens} tokens · {cost}',
    'page.card.empty': '—',
    'page.budget.title': '本月预算',
    'page.budget.titleAttr': '预算按本月（统计时区）估算费用计算，与上方日期范围无关',
    'page.budget.remaining': '剩余 {amount}',
    'page.budget.over': '已超出预算 {amount}',
    'page.budget.used': '已用 {pct}',
    'page.budget.filterHint': '预算按当前模型筛选计算',
    'page.balance.label': '账户余额',
    'page.balance.bonus': '赠送',
    'page.balance.title': '官方 DeepSeek 账户余额，与本地估算费用相互独立',
    'page.session.hint': '会话维度：柱高为总量，悬停柱子查看会话列表；单击展开、双击跳转会话。',
    'page.unpriced': '{count} 个模型未定价，费用不完整',
    'page.unpricedHint': '点击打开价格设置',
    'page.filter.preset': '时间范围',
    'page.preset.today': '今天',
    'page.preset.yesterday': '昨天',
    'page.preset.last7': '近 7 天',
    'page.preset.last30': '近 30 天',
    'page.preset.thisMonth': '本月',
    'page.preset.lastMonth': '上月',
    'page.preset.custom': '自定义',
    'page.filter.from': '开始日期',
    'page.filter.to': '结束日期',
    'page.filter.bucket': '粒度',
    'page.bucket.auto': '自动',
    'page.bucket.hour': '小时',
    'page.bucket.day': '天',
    'page.bucket.week': '周',
    'page.bucket.month': '月',
    'page.filter.metric': '指标',
    'page.metric.tokens': 'Tokens',
    'page.metric.cost': 'CNY',
    'page.filter.groupBy': '分组',
    'page.group.category': '按类别',
    'page.group.provider': '按 APIKey',
    'page.group.model': '按模型',
    'page.group.session': '按会话',
    'page.filter.models': '模型',
    'page.models.all': '全选',
    'page.models.clear': '清空',
    'page.models.none': '没有可筛选的模型',
    'page.models.noneHint': '未选择任何模型时显示全部',
    'page.models.summary': '{checked}/{total}',
    'page.filter.includeSubagents': '子代理单独列出',
    'page.filter.includeSubagents.hint': '勾选时子代理会话单独成行；取消勾选时子代理消耗合并到所属主会话，合计不变。',
    'page.filter.subagentsMerged': '已合并 {count} 个子代理会话',
    'page.filter.reset': '重置筛选',
    'page.drill.back': '返回',
    'page.drill.selection': '框选范围',
    'page.chart.title': '用量趋势',
    'page.chart.hint': '点击柱体可下钻到该时间段；在图表上拖动可框选时间范围。',
    'page.chart.empty': '所选范围内暂无用量',
    'page.chart.missing': '图表组件未就绪',
    'page.details.title': '明细',
    'page.details.count': '{count} 个时间段',
    'page.details.empty': '所选范围内没有明细',
    'page.details.export': '导出 CSV',
    'page.details.copy': '复制 TSV',
    'page.details.copied': '已复制到剪贴板',
    'page.details.copyFailed': '复制失败',
    'page.details.exported': '已导出 CSV',
    'page.details.exportFailed': '导出失败',
    'page.col.range': '时间范围',
    'page.col.total': '合计',
    'page.col.cost': '费用',
    'page.rank.sessions': 'Top 会话',
    'page.rank.models': 'Top 模型',
    'page.rank.empty': '暂无可排行的数据',
    'page.rank.unknownSession': '会话 {id}',
    'page.rank.openTitle': '打开该会话',
    'page.settings.title': '统计设置',
    'page.settings.prices': '模型价格（{currency} / 百万 tokens）',
    'page.settings.pricesHint': '留空表示未定价：该模型只统计 tokens，不计费用。',
    'page.settings.model': '模型',
    'page.settings.hit': '命中',
    'page.settings.miss': '未命中',
    'page.settings.write': '写入',
    'page.settings.out': '输出',
    'page.settings.peakMultiplier': '峰时倍率',
    'page.settings.status': '状态',
    'page.settings.unpriced': '未定价',
    'page.settings.priced': '已定价',
    'page.settings.peak': '峰谷计价',
    'page.settings.peakEnabled': '启用峰谷计价',
    'page.settings.peakDays': '峰时工作日',
    'page.settings.peakWindows': '峰时窗口',
    'page.settings.window': '窗口 {index}',
    'page.settings.peakStart': '开始',
    'page.settings.peakEnd': '结束',
    'page.settings.holidays': '节假日（YYYY-MM-DD，每行一个）',
    'page.settings.holidaysHint': '节假日整天按空闲时段计价。',
    'page.settings.restore': '恢复默认价格',
    'page.settings.restored': '已恢复默认值，保存后生效',
    'page.settings.noDefaults': '没有可用的默认配置',
    'page.settings.budget': '月度预算',
    'page.settings.budgetUnit': 'CNY / 月',
    'page.settings.budgetHint': '0 = 关闭预算提醒。预算按本月（统计时区）估算费用计算，并沿用当前模型 / 子代理筛选。',
    'page.settings.json': '价格 / 峰谷 JSON',
    'page.settings.jsonPlaceholder': '{"prices":{"provider/model":{"hit":0.02,"miss":1,"write":0,"out":4,"peakMultiplier":2}},"peak":{"enabled":true}}',
    'page.settings.import': '导入 JSON',
    'page.settings.export': '导出 JSON',
    'page.settings.jsonError': 'JSON 解析失败：{message}',
    'page.settings.jsonImported': '已导入到编辑区，确认后保存',
    'page.settings.save': '保存',
    'page.settings.saving': '保存中…',
    'page.settings.saved': '已保存',
    'page.settings.saveFailed': '保存失败：{message}',
    'page.settings.note': '口径说明',
    'page.note.cost': '费用为按可编辑价格表估算的参考值，不是账单。',
    'page.note.unpriced': '未定价模型只统计 tokens，不计费用。',
    'page.note.provider': 'APIKey 维度按 Provider 路由（供应商 key）归并。',
    'page.note.usage': '用量来自 Provider 上报的 token 统计；缓存命中从输入中拆分展示。',
    'page.weekday.1': '一',
    'page.weekday.2': '二',
    'page.weekday.3': '三',
    'page.weekday.4': '四',
    'page.weekday.5': '五',
    'page.weekday.6': '六',
    'page.weekday.7': '日',
    'page.action.rebuildFailed': '重建索引失败：{message}'
  },
  en: {
    'page.title': 'Token statistics',
    'page.desc': 'Provider-reported usage of local sessions over a time range; cost is estimated from an editable price table.',
    'page.refresh': 'Refresh',
    'page.rebuild': 'Rebuild index',
    'page.rebuildHint': 'Rescan every session in the background; the old index keeps serving meanwhile',
    'page.rebuildStarted': 'Index rebuild started',
    'page.autoRefresh': 'Auto refresh',
    'page.autoRefreshHint': 'Refresh every 15s while the page is visible; paused in background tabs',
    'page.settings': 'Settings',
    'page.indexed': '{indexed}/{total} sessions indexed',
    'page.indexing': 'Scanning {scanned}/{total}',
    'page.indexIdle': 'Index warming up',
    'page.indexErrors': '{count} errors',
    'page.indexErrorsTitle': 'Scan errors',
    'page.indexReady': 'Index ready',
    'page.partial': 'Some sessions are not indexed yet; these numbers may be incomplete.',
    'page.partialRunning': 'Building the index: scanned {scanned}/{total} sessions; data keeps updating.',
    'page.range': 'Range',
    'page.loading': 'Loading…',
    'page.error.meta': 'Failed to load index metadata',
    'page.error.stats': 'Failed to load statistics',
    'page.error.rank': 'Failed to load rankings',
    'page.card.tokens': 'Total tokens',
    'page.card.tokensSub': '{requests} requests',
    'page.card.cost': 'Estimated cost',
    'page.card.costSub': 'Unpriced {tokens} tokens',
    'page.card.costSubPriced': 'All usage is priced',
    'page.card.cacheHit': 'Cache hit rate',
    'page.card.cacheHitSub': '{hit} hit / {input} input',
    'page.card.avg': 'Avg tokens/day',
    'page.card.avgSub': '{days} days',
    'page.card.peak': 'Peak bucket',
    'page.card.peakSub': '{tokens} tokens · {cost}',
    'page.card.empty': '—',
    'page.budget.title': 'Monthly budget',
    'page.budget.titleAttr': 'Budget is month-to-date (statistics timezone) and independent of the date range above',
    'page.budget.remaining': '{amount} remaining',
    'page.budget.over': 'Over budget by {amount}',
    'page.budget.used': 'Used {pct}',
    'page.budget.filterHint': 'Budget follows the active model filter',
    'page.balance.label': 'Account balance',
    'page.balance.bonus': 'Bonus',
    'page.balance.title': 'Official DeepSeek account balance; independent of the estimated cost on this page',
    'page.session.hint': 'Session mode: bar height is the bucket total; hover a bar to list sessions; click to expand a row, double-click to open the session.',
    'page.unpriced': '{count} unpriced models; cost is incomplete',
    'page.unpricedHint': 'Open price settings',
    'page.filter.preset': 'Date range',
    'page.preset.today': 'Today',
    'page.preset.yesterday': 'Yesterday',
    'page.preset.last7': 'Last 7 days',
    'page.preset.last30': 'Last 30 days',
    'page.preset.thisMonth': 'This month',
    'page.preset.lastMonth': 'Last month',
    'page.preset.custom': 'Custom',
    'page.filter.from': 'Start date',
    'page.filter.to': 'End date',
    'page.filter.bucket': 'Granularity',
    'page.bucket.auto': 'Auto',
    'page.bucket.hour': 'Hour',
    'page.bucket.day': 'Day',
    'page.bucket.week': 'Week',
    'page.bucket.month': 'Month',
    'page.filter.metric': 'Metric',
    'page.metric.tokens': 'Tokens',
    'page.metric.cost': 'CNY',
    'page.filter.groupBy': 'Group by',
    'page.group.category': 'Category',
    'page.group.provider': 'API key',
    'page.group.model': 'Model',
    'page.group.session': 'Session',
    'page.filter.models': 'Models',
    'page.models.all': 'Select all',
    'page.models.clear': 'Clear',
    'page.models.none': 'No models to filter',
    'page.models.noneHint': 'With no model selected, all models are shown',
    'page.models.summary': '{checked}/{total}',
    'page.filter.includeSubagents': 'Subagents as separate rows',
    'page.filter.includeSubagents.hint': 'When checked, subagent sessions are listed as separate rows; when unchecked their usage is merged into the owning main session and totals stay unchanged.',
    'page.filter.subagentsMerged': '{count} subagent sessions merged',
    'page.filter.reset': 'Reset filters',
    'page.drill.back': 'Back',
    'page.drill.selection': 'Selected range',
    'page.chart.title': 'Usage trend',
    'page.chart.hint': 'Click a bar to drill into that bucket; drag across the chart to select a time range.',
    'page.chart.empty': 'No usage in the selected range',
    'page.chart.missing': 'Chart component is not available',
    'page.details.title': 'Breakdown',
    'page.details.count': '{count} time buckets',
    'page.details.empty': 'No breakdown rows in the selected range',
    'page.details.export': 'Export CSV',
    'page.details.copy': 'Copy TSV',
    'page.details.copied': 'Copied to clipboard',
    'page.details.copyFailed': 'Copy failed',
    'page.details.exported': 'CSV exported',
    'page.details.exportFailed': 'Export failed',
    'page.col.range': 'Time range',
    'page.col.total': 'Total',
    'page.col.cost': 'Cost',
    'page.rank.sessions': 'Top sessions',
    'page.rank.models': 'Top models',
    'page.rank.empty': 'Nothing to rank yet',
    'page.rank.unknownSession': 'Session {id}',
    'page.rank.openTitle': 'Open this session',
    'page.settings.title': 'Statistics settings',
    'page.settings.prices': 'Model prices ({currency} per 1M tokens)',
    'page.settings.pricesHint': 'Leave blank to keep a model unpriced: tokens are counted, cost is not.',
    'page.settings.model': 'Model',
    'page.settings.hit': 'Hit',
    'page.settings.miss': 'Miss',
    'page.settings.write': 'Write',
    'page.settings.out': 'Out',
    'page.settings.peakMultiplier': 'Peak ×',
    'page.settings.status': 'Status',
    'page.settings.unpriced': 'Unpriced',
    'page.settings.priced': 'Priced',
    'page.settings.peak': 'Peak pricing',
    'page.settings.peakEnabled': 'Enable peak pricing',
    'page.settings.peakDays': 'Peak weekdays',
    'page.settings.peakWindows': 'Peak windows',
    'page.settings.window': 'Window {index}',
    'page.settings.peakStart': 'Start',
    'page.settings.peakEnd': 'End',
    'page.settings.holidays': 'Holidays (YYYY-MM-DD, one per line)',
    'page.settings.holidaysHint': 'Holidays are billed at idle rates for the whole day.',
    'page.settings.restore': 'Restore defaults',
    'page.settings.restored': 'Defaults loaded; save to apply',
    'page.settings.noDefaults': 'No default configuration available',
    'page.settings.budget': 'Monthly budget',
    'page.settings.budgetUnit': 'CNY / month',
    'page.settings.budgetHint': '0 disables the budget alert. Month-to-date estimated cost in the statistics timezone, using the current model/subagent filters.',
    'page.settings.json': 'Prices / peak JSON',
    'page.settings.jsonPlaceholder': '{"prices":{"provider/model":{"hit":0.02,"miss":1,"write":0,"out":4,"peakMultiplier":2}},"peak":{"enabled":true}}',
    'page.settings.import': 'Import JSON',
    'page.settings.export': 'Export JSON',
    'page.settings.jsonError': 'JSON parse failed: {message}',
    'page.settings.jsonImported': 'Imported into the editor; save to apply',
    'page.settings.save': 'Save',
    'page.settings.saving': 'Saving…',
    'page.settings.saved': 'Saved',
    'page.settings.saveFailed': 'Save failed: {message}',
    'page.settings.note': 'Method notes',
    'page.note.cost': 'Cost is an estimate from the editable price table, not a bill.',
    'page.note.unpriced': 'Unpriced models count tokens only, with no cost.',
    'page.note.provider': 'The API key dimension groups usage by provider route.',
    'page.note.usage': 'Usage comes from provider-reported tokens; cache hits are split out of the input.',
    'page.weekday.1': 'Mon',
    'page.weekday.2': 'Tue',
    'page.weekday.3': 'Wed',
    'page.weekday.4': 'Thu',
    'page.weekday.5': 'Fri',
    'page.weekday.6': 'Sat',
    'page.weekday.7': 'Sun',
    'page.action.rebuildFailed': 'Rebuild failed: {message}'
  }
};

/* --------------------------------------------------------------- styles --- */

var DshTokenPageCss = `
.dsht-page-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}
.dsht-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:10px}
.dsht-cols2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
@media (max-width:900px){.dsht-cols2{grid-template-columns:minmax(0,1fr)}}
.dsht-budget .dsht-progress{margin-top:6px}
.dsht-budget .dsht-hint{margin-top:2px}
.dsht-budget-over .dsht-progress-inner{background:var(--dsw-alias-state-error-primary)}
.dsht-budget-warn .dsht-progress-inner{background:var(--dsw-alias-state-warn-primary)}
.dsht-budget-over .dsht-card-sub{color:var(--dsw-alias-state-error-primary)}
.dsht-budget-warn .dsht-card-sub{color:var(--dsw-alias-state-warn-primary)}
.dsht-hintbar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent);color:var(--dsw-alias-label-secondary);font-size:12px}
.dsht-toggle-box{width:14px;height:14px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;background:var(--dsw-alias-bg-layer-1);padding:0}
.dsht-toggle-box[data-on="1"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-layer-1)}
.dsht-filterbar{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:11px 13px}
.dsht-filter-group{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dsht-filter-label{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsht-date-input{width:128px}
.dsht-price-input{width:76px;text-align:right}
.dsht-textarea{height:auto;min-height:64px;width:100%;padding:6px 8px;resize:vertical;line-height:1.45;font-family:inherit}
.dsht-rank{display:flex;flex-direction:column;gap:1px}
.dsht-rank-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;gap:8px;padding:5px 6px;border-radius:8px;background:transparent;border:0;font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary);text-align:left;width:100%;cursor:default}
button.dsht-rank-row{cursor:pointer}
button.dsht-rank-row:hover{background:var(--dsw-alias-bg-layer-2)}
button.dsht-rank-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsht-rank-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dsht-rank-value{font-variant-numeric:tabular-nums;white-space:nowrap}
.dsht-rank-sub{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.dsht-rank-more{font-size:11px;color:var(--dsw-alias-label-secondary);padding:4px 6px}
.dsht-table tfoot td{border-top:1px solid var(--dsw-alias-border-l1);font-weight:600}
.dsht-settings-stack{display:flex;flex-direction:column;gap:12px}
.dsht-note-list{margin:0;padding-left:16px;display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsht-model-row{display:flex;align-items:center;gap:8px;width:100%;padding:5px 6px;border-radius:7px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;text-align:left;cursor:pointer}
.dsht-model-row:hover{background:var(--dsw-alias-bg-layer-2)}
.dsht-model-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.dsht-crumb{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;font-size:11px}
.dsht-crumb-item{color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}
.dsht-crumb-sep{color:var(--dsw-alias-label-secondary);opacity:.6}
`;

/* ------------------------------------------------------------ constants --- */

var DshTokenPagePresets = ['today', 'yesterday', 'last7', 'last30', 'thisMonth', 'lastMonth', 'custom'];
var DshTokenPageBuckets = ['auto', 'hour', 'day', 'week', 'month'];
var DshTokenPageMetrics = ['tokens', 'cost'];
var DshTokenPageGroups = ['category', 'provider', 'model', 'session'];
var DshTokenPageWeekdays = [1, 2, 3, 4, 5, 6, 7];

/* -------------------------------------------------------------- helpers --- */

function DshTokenPageOwn(object, key) {
  return !!object && Object.prototype.hasOwnProperty.call(object, key);
}

function DshTokenPageNum(value) {
  var number = Number(value);
  return isFinite(number) ? number : 0;
}

function DshTokenPageToNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  var number = Number(value);
  return isFinite(number) ? number : null;
}

/** Nullable number clamped to >= 0, null stays null (used for editable prices). */
function DshTokenPageNonNegative(value) {
  var number = DshTokenPageToNumber(value);
  if (number === null) return null;
  return number < 0 ? 0 : number;
}

function DshTokenPagePad2(number) {
  var value = Math.round(Number(number) || 0);
  if (value < 0) value = 0;
  return value < 10 ? '0' + value : String(value);
}

function DshTokenPageUnique(list) {
  var seen = {};
  var out = [];
  if (!Array.isArray(list)) return out;
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    var key = typeof item === 'string' ? item : String(item);
    if (!key || DshTokenPageOwn(seen, key)) continue;
    seen[key] = true;
    out.push(key);
  }
  return out;
}

function DshTokenPageEmptyPart() {
  return { tokens: 0, cost: 0, miss: 0, hit: 0, write: 0, out: 0, reasoning: 0, requests: 0 };
}

/** Normalize a Part from any Host response; never throws on missing fields. */
function DshTokenPagePart(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  var miss = DshTokenPageNum(raw.miss);
  var hit = DshTokenPageNum(raw.hit);
  var write = DshTokenPageNum(raw.write);
  var out = DshTokenPageNum(raw.out);
  var tokens = raw.tokens === null || raw.tokens === undefined ? miss + hit + write + out : DshTokenPageNum(raw.tokens);
  return {
    tokens: tokens,
    cost: DshTokenPageNum(raw.cost),
    miss: miss,
    hit: hit,
    write: write,
    out: out,
    reasoning: DshTokenPageNum(raw.reasoning),
    requests: DshTokenPageNum(raw.requests)
  };
}

function DshTokenPagePartMerge(target, part) {
  target.tokens += part.tokens;
  target.cost += part.cost;
  target.miss += part.miss;
  target.hit += part.hit;
  target.write += part.write;
  target.out += part.out;
  target.reasoning += part.reasoning;
  target.requests += part.requests;
  return target;
}

function DshTokenPageSummary(value) {
  var summary = value && value.summary && typeof value.summary === 'object' ? value.summary : {};
  var notes = value && value.notes && typeof value.notes === 'object' ? value.notes : {};
  var unpriced = Array.isArray(notes.unpricedModels) ? notes.unpricedModels : [];
  var days = DshTokenPageNum(summary.days);
  return {
    totalTokens: DshTokenPageNum(summary.totalTokens),
    totalCost: DshTokenPageNum(summary.totalCost),
    pricedTokens: DshTokenPageNum(summary.pricedTokens),
    unpricedTokens: DshTokenPageNum(summary.unpricedTokens),
    cacheHitRate: DshTokenPageNum(summary.cacheHitRate),
    requests: DshTokenPageNum(summary.requests),
    sessions: DshTokenPageNum(summary.sessions),
    days: days > 0 ? days : 1,
    avgPerDayTokens: DshTokenPageNum(summary.avgPerDayTokens),
    peakBucket: summary.peakBucket && typeof summary.peakBucket === 'object' ? summary.peakBucket : null,
    unpricedModels: unpriced,
    partial: !!notes.partial,
    indexProgress: notes.indexProgress && typeof notes.indexProgress === 'object' ? notes.indexProgress : null,
    filters: notes.filters && typeof notes.filters === 'object' ? notes.filters : null
  };
}

/** Range for a date preset, computed in the statistics timezone. */
function DshTokenPageRangeForPreset(preset, nowMs, offsetMs, custom) {
  var day = 86400000;
  var todayStart = dshtokenStartOfDay(nowMs, offsetMs);
  var from = todayStart - 6 * day;
  var to = todayStart + day;
  if (preset === 'today') return { from: todayStart, to: todayStart + day };
  if (preset === 'yesterday') return { from: todayStart - day, to: todayStart };
  if (preset === 'last7') return { from: todayStart - 6 * day, to: todayStart + day };
  if (preset === 'last30') return { from: todayStart - 29 * day, to: todayStart + day };
  if (preset === 'thisMonth') {
    from = dshtokenStartOfMonth(nowMs, offsetMs);
    to = dshtokenStartOfMonth(from + 32 * day, offsetMs);
    return { from: from, to: to };
  }
  if (preset === 'lastMonth') {
    to = dshtokenStartOfMonth(nowMs, offsetMs);
    from = dshtokenStartOfMonth(to - day, offsetMs);
    return { from: from, to: to };
  }
  if (custom && typeof custom === 'object') {
    var customFrom = dshtokenParseDateInput(custom.from, offsetMs, false);
    var customTo = dshtokenParseDateInput(custom.to, offsetMs, true);
    if (customFrom !== null && customTo !== null && customTo > customFrom) return { from: customFrom, to: customTo };
    if (customFrom !== null) return { from: customFrom, to: customFrom + day };
  }
  return { from: todayStart - 6 * day, to: todayStart + day };
}

function DshTokenPageRangeText(from, to, offsetMs) {
  if (!isFinite(from) || !isFinite(to) || to <= from) return '—';
  if (to - from <= 2 * 86400000) {
    return dshtokenFmtDateTime(from, offsetMs) + ' – ' + dshtokenFmtDateTime(to, offsetMs);
  }
  return dshtokenFmtDate(from, offsetMs) + ' – ' + dshtokenFmtDate(to - 1, offsetMs);
}

function DshTokenPageDimLabel(t, dim) {
  if (!dim || typeof dim !== 'object') return '';
  var key = dim.key === null || dim.key === undefined ? '' : String(dim.key);
  if (key === '__other') return t('common.other');
  if (dim.kind === 'category' || key === 'hit' || key === 'miss' || key === 'write' || key === 'out') {
    return t('cat.' + key);
  }
  if (dim.label) return String(dim.label);
  return key;
}

function DshTokenPageFallbackColor(key, index) {
  var category = {
    hit: 'var(--dsw-alias-state-success-primary)',
    miss: 'color-mix(in srgb,var(--dsw-alias-brand-primary) 82%,var(--dsw-alias-label-primary))',
    write: 'color-mix(in srgb,var(--dsw-alias-state-warn-primary) 78%,var(--dsw-alias-brand-primary))',
    out: 'color-mix(in srgb,var(--dsw-alias-brand-primary) 52%,var(--dsw-alias-label-secondary))'
  };
  if (DshTokenPageOwn(category, key)) return category[key];
  var percents = [70, 45, 88, 30, 58, 78, 38, 95, 25, 64, 52, 84];
  var position = Math.abs(Math.round(Number(index) || 0)) % percents.length;
  return 'color-mix(in srgb,var(--dsw-alias-brand-primary) ' + percents[position] + '%,var(--dsw-alias-label-secondary))';
}

/** Chart dim color: prefer the chart's own helper so the legend matches the bars. */
function DshTokenPageDimColor(key, index, kind) {
  if (typeof DshChartDimColor === 'function') {
    try {
      var color = DshChartDimColor(key, index, kind);
      if (typeof color === 'string' && color) return color;
    } catch (error) {
      /* fall through to the local palette */
    }
  }
  return DshTokenPageFallbackColor(key, index);
}

/** Aggregate every bucket's byDim into one Part per dimension key. */
function DshTokenPageAggregateDims(value) {
  var map = {};
  if (!value || !Array.isArray(value.buckets)) return map;
  for (var i = 0; i < value.buckets.length; i++) {
    var bucket = value.buckets[i];
    if (!bucket || typeof bucket !== 'object') continue;
    var byDim = bucket.byDim && typeof bucket.byDim === 'object' ? bucket.byDim : null;
    if (!byDim) continue;
    for (var key in byDim) {
      if (!DshTokenPageOwn(byDim, key)) continue;
      var part = DshTokenPagePart(byDim[key]);
      if (!map[key]) {
        map[key] = DshTokenPageEmptyPart();
        DshTokenPagePartMerge(map[key], part);
      } else {
        DshTokenPagePartMerge(map[key], part);
      }
    }
  }
  return map;
}

/** Flat rows for the details table: one normalized Part per bucket. */
function DshTokenPageBuildRows(value) {
  var rows = [];
  if (!value || !Array.isArray(value.buckets)) return rows;
  for (var i = 0; i < value.buckets.length; i++) {
    var bucket = value.buckets[i];
    if (!bucket || typeof bucket !== 'object') continue;
    rows.push({
      t0: DshTokenPageNum(bucket.t0),
      t1: DshTokenPageNum(bucket.t1),
      part: DshTokenPagePart(bucket.total)
    });
  }
  return rows;
}

/** Ranked dims (excluding __other) by the requested metric. */
function DshTokenPageRankRows(value, metric) {
  var dims = value && Array.isArray(value.dims) ? value.dims : [];
  var aggregated = DshTokenPageAggregateDims(value);
  var list = [];
  for (var i = 0; i < dims.length; i++) {
    var dim = dims[i];
    if (!dim || typeof dim !== 'object') continue;
    var key = dim.key === null || dim.key === undefined ? '' : String(dim.key);
    if (!key || key === '__other') continue;
    var part = aggregated[key];
    if (!part) continue;
    list.push({ key: key, dim: dim, part: part, value: metric === 'cost' ? part.cost : part.tokens });
  }
  list.sort(function (a, b) {
    if (b.value !== a.value) return b.value - a.value;
    if (b.part.tokens !== a.part.tokens) return b.part.tokens - a.part.tokens;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return list;
}

function DshTokenPageStatsBody(from, to, bucket, groupBy, metric, models, includeSubagents) {
  var body = {
    from: from,
    to: to,
    bucket: bucket,
    groupBy: groupBy,
    metric: metric,
    includeSubagents: !!includeSubagents
  };
  if (models && models.length) body.models = models.slice();
  return body;
}

function DshTokenPageFileNameStamp(from, offsetMs) {
  try {
    return dshtokenFmtInputDate(from, offsetMs);
  } catch (error) {
    return 'range';
  }
}

function DshTokenPageCellText(value, delimiter) {
  var text = value === null || value === undefined ? '' : String(value);
  if (delimiter === ',') {
    if (/[",\n\r]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
    return text;
  }
  return text.replace(/\t/g, ' ').replace(/[\n\r]+/g, ' ');
}

/** Build the CSV/TSV payload from normalized rows. */
function DshTokenPageTableText(rows, totalPart, t, offsetMs, bucket, delimiter) {
  var lines = [];
  var header = [
    t('page.col.range'),
    t('cat.miss'),
    t('cat.hit'),
    t('cat.write'),
    t('cat.out'),
    t('page.col.total'),
    t('page.col.cost')
  ];
  lines.push(header.map(function (cell) {
    return DshTokenPageCellText(cell, delimiter);
  }).join(delimiter));
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var part = row.part;
    var cells = [
      dshtokenFmtBucketRange(row.t0, bucket, offsetMs),
      part.miss,
      part.hit,
      part.write,
      part.out,
      part.tokens,
      Math.round(part.cost * 1e6) / 1e6
    ];
    lines.push(cells.map(function (cell) {
      return DshTokenPageCellText(cell, delimiter);
    }).join(delimiter));
  }
  if (totalPart && rows.length) {
    var totals = [
      t('common.total'),
      totalPart.miss,
      totalPart.hit,
      totalPart.write,
      totalPart.out,
      totalPart.tokens,
      Math.round(totalPart.cost * 1e6) / 1e6
    ];
    lines.push(totals.map(function (cell) {
      return DshTokenPageCellText(cell, delimiter);
    }).join(delimiter));
  }
  return lines.join('\n');
}

/* DOM helpers are only ever called from event handlers (never at load time). */

function DshTokenPageDownload(filename, text, mime) {
  try {
    if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') return false;
    var blob = new Blob(['\ufeff' + text], { type: mime || 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () {
      try {
        URL.revokeObjectURL(url);
      } catch (error) {
        /* ignore */
      }
    }, 1200);
    return true;
  } catch (error) {
    return false;
  }
}

function DshTokenPageCopyFallback(text) {
  try {
    if (typeof document === 'undefined') return false;
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '0';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try {
      ok = document.execCommand ? document.execCommand('copy') : false;
    } catch (error) {
      ok = false;
    }
    document.body.removeChild(area);
    return !!ok;
  } catch (error) {
    return false;
  }
}

function DshTokenPageCopyText(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).then(function () {
        return true;
      }, function () {
        return DshTokenPageCopyFallback(text);
      });
    }
  } catch (error) {
    /* fall through */
  }
  return Promise.resolve(DshTokenPageCopyFallback(text));
}

/* ------------------------------------------------------------- settings --- */

function DshTokenPageEmptyPrice() {
  return { hit: null, miss: null, write: null, out: null, peakMultiplier: null };
}

function DshTokenPageNormalizePrice(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  var row = DshTokenPageEmptyPrice();
  row.hit = DshTokenPageToNumber(raw.hit);
  row.miss = DshTokenPageToNumber(raw.miss);
  row.write = DshTokenPageToNumber(raw.write);
  row.out = DshTokenPageToNumber(raw.out);
  row.peakMultiplier = DshTokenPageToNumber(raw.peakMultiplier);
  return row;
}

function DshTokenPageClonePrice(row) {
  var clone = DshTokenPageEmptyPrice();
  if (!row || typeof row !== 'object') return clone;
  clone.hit = DshTokenPageToNumber(row.hit);
  clone.miss = DshTokenPageToNumber(row.miss);
  clone.write = DshTokenPageToNumber(row.write);
  clone.out = DshTokenPageToNumber(row.out);
  clone.peakMultiplier = DshTokenPageToNumber(row.peakMultiplier);
  return clone;
}

function DshTokenPagePricePriced(row) {
  if (!row || typeof row !== 'object') return false;
  return (
    DshTokenPageToNumber(row.hit) !== null ||
    DshTokenPageToNumber(row.miss) !== null ||
    DshTokenPageToNumber(row.write) !== null ||
    DshTokenPageToNumber(row.out) !== null
  );
}

function DshTokenPageNormalizePricesMap(raw) {
  var prices = {};
  if (!raw || typeof raw !== 'object') return prices;
  for (var key in raw) {
    if (!DshTokenPageOwn(raw, key)) continue;
    prices[key] = DshTokenPageNormalizePrice(raw[key]);
  }
  return prices;
}

/** Build the clean price map for the config patch; unpriced rows are omitted. */
function DshTokenPageCleanPrices(prices) {
  var clean = {};
  if (!prices || typeof prices !== 'object') return clean;
  for (var key in prices) {
    if (!DshTokenPageOwn(prices, key)) continue;
    if (!key) continue;
    var row = prices[key];
    if (!DshTokenPagePricePriced(row)) continue;
    var hit = DshTokenPageNonNegative(row.hit);
    var miss = DshTokenPageNonNegative(row.miss);
    var write = DshTokenPageNonNegative(row.write);
    var out = DshTokenPageNonNegative(row.out);
    var peak = DshTokenPageNonNegative(row.peakMultiplier);
    clean[key] = {
      hit: hit === null ? 0 : hit,
      miss: miss === null ? 0 : miss,
      write: write === null ? 0 : write,
      out: out === null ? 0 : out,
      peakMultiplier: peak === null ? 2 : peak
    };
  }
  return clean;
}

function DshTokenPageMinutesToTime(minutes) {
  var value = DshTokenPageToNumber(minutes);
  if (value === null) return '';
  value = Math.round(value);
  if (value < 0) value = 0;
  if (value > 1439) value = 1439;
  return DshTokenPagePad2(Math.floor(value / 60)) + ':' + DshTokenPagePad2(value % 60);
}

function DshTokenPageTimeToMinutes(text) {
  if (typeof text !== 'string') return null;
  var match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  var hours = Number(match[1]);
  var minutes = Number(match[2]);
  if (!isFinite(hours) || !isFinite(minutes) || minutes > 59) return null;
  var total = hours * 60 + minutes;
  if (total < 0 || total > 1440) return null;
  return total;
}

function DshTokenPageNormalizePeak(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  var days = [];
  if (Array.isArray(raw.days)) {
    for (var i = 0; i < raw.days.length; i++) {
      var day = Number(raw.days[i]);
      if (day >= 1 && day <= 7 && Math.floor(day) === day && days.indexOf(day) < 0) days.push(day);
    }
    days.sort(function (a, b) {
      return a - b;
    });
  }
  var windows = [];
  if (Array.isArray(raw.windows)) {
    for (var j = 0; j < raw.windows.length; j++) {
      var window = raw.windows[j] && typeof raw.windows[j] === 'object' ? raw.windows[j] : {};
      windows.push({
        start: DshTokenPageToNumber(window.start),
        end: DshTokenPageToNumber(window.end)
      });
    }
  }
  while (windows.length < 2) windows.push({ start: null, end: null });
  var holidays = [];
  if (Array.isArray(raw.holidays)) {
    for (var k = 0; k < raw.holidays.length; k++) {
      var holiday = raw.holidays[k] === null || raw.holidays[k] === undefined ? '' : String(raw.holidays[k]).trim();
      if (holiday) holidays.push(holiday);
    }
  }
  return {
    enabled: !!raw.enabled,
    days: days,
    windows: windows,
    holidays: holidays
  };
}

function DshTokenPageClonePeak(peak) {
  var normalized = DshTokenPageNormalizePeak(peak);
  return {
    enabled: normalized.enabled,
    days: normalized.days.slice(),
    windows: normalized.windows.map(function (window) {
      return { start: DshTokenPageToNumber(window.start), end: DshTokenPageToNumber(window.end) };
    }),
    holidays: normalized.holidays.slice()
  };
}

/** Clean peak payload for the config patch. */
function DshTokenPageCleanPeak(peak) {
  var normalized = DshTokenPageNormalizePeak(peak);
  var windows = [];
  for (var i = 0; i < normalized.windows.length; i++) {
    var window = normalized.windows[i];
    var start = DshTokenPageToNumber(window.start);
    var end = DshTokenPageToNumber(window.end);
    if (start === null || end === null) continue;
    start = Math.round(start);
    end = Math.round(end);
    if (start < 0) start = 0;
    if (end > 1440) end = 1440;
    if (end <= start) continue;
    windows.push({ start: start, end: end });
  }
  var holidays = [];
  for (var j = 0; j < normalized.holidays.length; j++) {
    var holiday = String(normalized.holidays[j] || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(holiday) && holidays.indexOf(holiday) < 0) holidays.push(holiday);
  }
  holidays.sort();
  return {
    enabled: !!normalized.enabled,
    days: normalized.days.slice(),
    windows: windows,
    holidays: holidays
  };
}

/** Shallow copy of one config prefs object (never mutates the source). */
function DshTokenPageClonePrefs(prefs) {
  var copy = {};
  if (!prefs || typeof prefs !== 'object') return copy;
  for (var key in prefs) {
    if (DshTokenPageOwn(prefs, key)) copy[key] = prefs[key];
  }
  return copy;
}

function DshTokenPageConfigPrefs(config) {
  if (!config || typeof config !== 'object') return null;
  return config.prefs && typeof config.prefs === 'object' ? config.prefs : null;
}

/** Monthly budget (CNY) from config.prefs.budgetMonthly; 0 when unset/invalid. */
function DshTokenPageBudgetFromConfig(config) {
  var prefs = DshTokenPageConfigPrefs(config);
  var value = DshTokenPageNonNegative(prefs ? prefs.budgetMonthly : null);
  return value === null ? 0 : value;
}

/** Current calendar month-to-date in the statistics timezone: [monthStart, now). */
function DshTokenPageMonthRange(nowMs, offsetMs) {
  return { from: dshtokenStartOfMonth(nowMs, offsetMs), to: nowMs };
}

/** "12.34" + 'CNY' → '¥12.34'; malformed values degrade to their raw string. */
function DshTokenPageWalletAmount(entry) {
  if (!entry || typeof entry !== 'object') return '';
  var currency = typeof entry.currency === 'string' ? entry.currency.toUpperCase() : '';
  var number = DshTokenPageToNumber(entry.balance);
  if (number !== null) return dshtokenFmtCost(number, currency || 'CNY');
  var raw = entry.balance === null || entry.balance === undefined ? '' : String(entry.balance).trim();
  return raw;
}

function DshTokenPageWalletTexts(list, limit) {
  var out = [];
  if (!Array.isArray(list)) return out;
  for (var i = 0; i < list.length && out.length < limit; i++) {
    var text = DshTokenPageWalletAmount(list[i]);
    if (text) out.push(text);
  }
  return out;
}

/**
 * Normalized balance display data for the header chip.
 * Returns null unless the Host says available with at least one wallet.
 */
function DshTokenPageBalanceParts(value) {
  if (!value || typeof value !== 'object' || value.available !== true) return null;
  var wallets = DshTokenPageWalletTexts(value.wallets, 2);
  if (!wallets.length) return null;
  return { wallets: wallets, bonus: DshTokenPageWalletTexts(value.bonusWallets, 2) };
}

/* --------------------------------------------------- session hover list --- */

var DshTokenPageSessionCacheLimit = 40;

function DshTokenPageIsRealSessionId(value) {
  if (typeof value !== 'string') return false;
  var id = value.trim();
  return !!id && id !== '__other';
}

/** Rows array of a bucketSessions response (malformed values degrade to []). */
function DshTokenPageSessionRows(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.sessions)) return [];
  var rows = [];
  for (var i = 0; i < value.sessions.length; i++) {
    var row = value.sessions[i];
    if (row && typeof row === 'object') rows.push(row);
  }
  return rows;
}

/** Normalize a bucketSessions response for one cache entry. */
function DshTokenPageSessionResult(value) {
  var rows = DshTokenPageSessionRows(value);
  var total = value && value.total && typeof value.total === 'object' ? value.total : null;
  var sessionCount = value && typeof value.sessionCount === 'number' ? value.sessionCount : rows.length;
  return {
    rows: rows,
    total: total,
    sessionCount: sessionCount,
    truncated: !!(value && value.truncated)
  };
}

function DshTokenPageDraftFromConfig(config, defaults) {
  var source = config && typeof config === 'object' ? config : {};
  var fallback = defaults && typeof defaults === 'object' ? defaults : {};
  var prices = DshTokenPageNormalizePricesMap(source.prices && typeof source.prices === 'object' ? source.prices : fallback.prices);
  var peakSource = source.peak && typeof source.peak === 'object' ? source.peak : fallback.peak;
  var prefsSource = DshTokenPageConfigPrefs(source) || DshTokenPageConfigPrefs(fallback);
  var prefs = DshTokenPageClonePrefs(prefsSource);
  var budgetValue = DshTokenPageNonNegative(prefs.budgetMonthly);
  return {
    prices: prices,
    peak: DshTokenPageNormalizePeak(peakSource),
    prefs: prefs,
    budgetMonthly: budgetValue === null ? 0 : budgetValue
  };
}

/* --------------------------------------------------------- presentation --- */

function DshTokenPageCard(props) {
  return h(
    'div',
    { className: 'dsht-card' },
    h('div', { className: 'dsht-card-label' }, props.label || ''),
    h('div', { className: 'dsht-card-value', title: props.title || '' }, props.value === null || props.value === undefined ? '' : String(props.value)),
    props.sub ? h('div', { className: 'dsht-card-sub', title: props.subTitle || '' }, props.sub) : null
  );
}

function DshTokenPageIconButton(props) {
  return h(
    'button',
    {
      type: 'button',
      className: 'dsht-btn dsht-btn-ghost',
      onClick: props.onClick,
      disabled: !!props.disabled,
      title: props.title || props.label || '',
      'aria-label': props.title || props.label || ''
    },
    h(DshIcon, { name: props.icon || 'info', size: 14 }),
    props.label ? h('span', null, props.label) : null
  );
}

/** Toggle rendered as a single button (role=switch via aria-pressed). */
function DshTokenPageToggle(props) {
  var checked = !!props.checked;
  return h(
    'button',
    {
      type: 'button',
      className: 'dsht-btn' + (checked ? ' is-active' : ''),
      'aria-pressed': checked,
      'aria-label': props.label || '',
      title: props.title || props.label || '',
      onClick: function () {
        if (props.onChange) props.onChange(!checked);
      }
    },
    h('span', { className: 'dsht-check dsht-toggle-box', 'data-on': checked ? '1' : '0', 'aria-hidden': true },
      checked ? h(DshIcon, { name: 'check', size: 10, strokeWidth: 2.4 }) : null
    ),
    h('span', null, props.label || '')
  );
}

function DshTokenPageLegend(props) {
  var t = props.t;
  var dims = props.dims || [];
  var values = props.values || {};
  var active = props.activeSet || {};
  return h(
    'div',
    { className: 'dsht-legend', style: { marginBottom: 8 } },
    dims.map(function (dim, index) {
      var key = dim && dim.key !== null && dim.key !== undefined ? String(dim.key) : 'dim-' + index;
      var isActive = active[key] !== false;
      var label = DshTokenPageDimLabel(t, dim);
      var value = values[key];
      var valueText = value === null || value === undefined
        ? ''
        : props.metric === 'cost'
          ? dshtokenFmtCost(value, props.currency)
          : dshtokenFmtTokens(value);
      return h(
        'button',
        {
          key: key,
          type: 'button',
          className: 'dsht-legend-item',
          'aria-pressed': isActive,
          title: label,
          onClick: function () {
            if (props.onToggle) props.onToggle(key);
          }
        },
        h('span', { className: 'dsht-swatch', style: { background: DshTokenPageDimColor(key, index, dim && dim.kind) } }),
        h('span', null, label),
        valueText ? h('span', { className: 'dsht-legend-value' }, valueText) : null
      );
    })
  );
}

function DshTokenPageDetailsPanel(props) {
  var t = props.t;
  var rows = props.rows || [];
  var bucket = props.bucket || 'day';
  var offsetMs = props.offsetMs;
  var currency = props.currency;
  var totalPart = props.topTotals || null;
  var header = h(
    'div',
    { className: 'dsht-panel-head' },
    h('span', { className: 'dsht-panel-title' }, t('page.details.title')),
    h('span', { className: 'dsht-muted' }, t('page.details.count', { count: rows.length })),
    h('span', { className: 'dsht-grow' }),
    props.flash ? h('span', { className: 'dsht-chip', 'data-tone': 'ok' }, props.flash) : null,
    h(
      'button',
      {
        type: 'button',
        className: 'dsht-btn dsht-btn-ghost',
        onClick: props.onCopy,
        disabled: !rows.length,
        title: t('page.details.copy')
      },
      h(DshIcon, { name: 'copy', size: 13 }),
      h('span', null, t('page.details.copy'))
    ),
    h(
      'button',
      {
        type: 'button',
        className: 'dsht-btn dsht-btn-ghost',
        onClick: props.onExport,
        disabled: !rows.length,
        title: t('page.details.export')
      },
      h(DshIcon, { name: 'download', size: 13 }),
      h('span', null, t('page.details.export'))
    )
  );

  var body;
  if (props.error) {
    body = h(DshErrorBox, { error: props.error, onRetry: props.onRetry, retryLabel: t('common.retry') });
  } else if (props.loading && !rows.length) {
    body = h('div', { className: 'dsht-empty' }, h(DshSpinner, { label: t('common.loading') }));
  } else if (!rows.length) {
    body = h(DshEmpty, { title: t('page.details.empty'), icon: 'chart' });
  } else {
    var headCells = [
      h('th', { key: 'range', className: 'dsht-cell-left' }, t('page.col.range')),
      h('th', { key: 'miss' }, t('cat.miss')),
      h('th', { key: 'hit' }, t('cat.hit')),
      h('th', { key: 'write' }, t('cat.write')),
      h('th', { key: 'out' }, t('cat.out')),
      h('th', { key: 'total' }, t('page.col.total')),
      h('th', { key: 'cost' }, t('page.col.cost'))
    ];
    var bodyRows = rows.map(function (row, index) {
      var part = row.part || DshTokenPageEmptyPart();
      return h(
        'tr',
        { key: String(row.t0) + ':' + index },
        h('td', { className: 'dsht-cell-left dsht-mono' }, dshtokenFmtBucketRange(row.t0, bucket, offsetMs)),
        h('td', { className: 'dsht-mono', title: dshtokenFmtInt(part.miss) }, dshtokenFmtTokens(part.miss)),
        h('td', { className: 'dsht-mono', title: dshtokenFmtInt(part.hit) }, dshtokenFmtTokens(part.hit)),
        h('td', { className: 'dsht-mono', title: dshtokenFmtInt(part.write) }, dshtokenFmtTokens(part.write)),
        h('td', { className: 'dsht-mono', title: dshtokenFmtInt(part.out) }, dshtokenFmtTokens(part.out)),
        h('td', { className: 'dsht-mono', title: dshtokenFmtInt(part.tokens) }, dshtokenFmtTokens(part.tokens)),
        h('td', { className: 'dsht-mono' }, dshtokenFmtCost(part.cost, currency))
      );
    });
    var footerRow = totalPart
      ? h(
          'tfoot',
          null,
          h(
            'tr',
            null,
            h('td', { className: 'dsht-cell-left' }, t('common.total')),
            h('td', { className: 'dsht-mono' }, dshtokenFmtTokens(totalPart.miss)),
            h('td', { className: 'dsht-mono' }, dshtokenFmtTokens(totalPart.hit)),
            h('td', { className: 'dsht-mono' }, dshtokenFmtTokens(totalPart.write)),
            h('td', { className: 'dsht-mono' }, dshtokenFmtTokens(totalPart.out)),
            h('td', { className: 'dsht-mono' }, dshtokenFmtTokens(totalPart.tokens)),
            h('td', { className: 'dsht-mono' }, dshtokenFmtCost(totalPart.cost, currency))
          )
        )
      : null;
    body = h(
      'div',
      { className: 'dsht-table-wrap', style: { maxHeight: 320 } },
      h('table', { className: 'dsht-table' }, h('thead', null, h('tr', null, headCells)), h('tbody', null, bodyRows), footerRow)
    );
  }

  return h('div', { className: 'dsht-panel' }, header, body);
}

function DshTokenPageRankPanel(props) {
  var t = props.t;
  var rows = props.rows || [];
  var body;
  if (props.error) {
    body = h(
      'div',
      null,
      props.errorTitle ? h('div', { className: 'dsht-hint', style: { marginBottom: 6 } }, props.errorTitle) : null,
      h(DshErrorBox, { error: props.error, onRetry: props.onRetry, retryLabel: t('common.retry') })
    );
  } else if (props.loading && !rows.length) {
    body = h('div', { className: 'dsht-empty' }, h(DshSpinner, { label: t('common.loading') }));
  } else if (!rows.length) {
    body = h(DshEmpty, { title: t('page.rank.empty'), icon: 'chart' });
  } else {
    body = h(
      'div',
      { className: 'dsht-rank' },
      rows.map(function (row) {
        var content = [
          h('span', { key: 'swatch', className: 'dsht-swatch', style: { background: row.color } }),
          h('span', { key: 'label', className: 'dsht-rank-label', title: row.title || row.label }, row.label),
          h('span', { key: 'value', className: 'dsht-rank-value' }, row.valueText),
          h('span', { key: 'sub', className: 'dsht-rank-sub' }, row.subText)
        ];
        if (row.clickable && typeof row.onClick === 'function') {
          return h(
            'button',
            {
              key: row.key,
              type: 'button',
              className: 'dsht-rank-row',
              title: (props.openLabel ? props.openLabel + ' · ' : '') + (row.title || row.label),
              'aria-label': (props.openLabel ? props.openLabel + ' ' : '') + row.label,
              onClick: row.onClick
            },
            content
          );
        }
        return h('div', { key: row.key, className: 'dsht-rank-row' }, content);
      })
    );
  }
  return h(
    'div',
    { className: 'dsht-panel' },
    h('div', { className: 'dsht-panel-head' }, h('span', { className: 'dsht-panel-title' }, props.title || '')),
    body
  );
}

function DshTokenPageSettingsDialog(props) {
  if (!props.open) return null;
  var t = props.t;
  var draft = props.draft;
  var models = props.models || [];
  var currency = props.currency || 'CNY';
  var busy = !!props.saving;

  var footer = h(
    'div',
    { className: 'dsht-row', style: { width: '100%' } },
    h(
      'button',
      {
        type: 'button',
        className: 'dsht-btn dsht-btn-ghost',
        onClick: props.onRestore,
        disabled: busy || !props.hasDefaults,
        title: t('page.settings.restore')
      },
      h(DshIcon, { name: 'refresh', size: 13 }),
      h('span', null, t('page.settings.restore'))
    ),
    h('span', { className: 'dsht-grow' }),
    h(
      'button',
      { type: 'button', className: 'dsht-btn', onClick: props.onClose, disabled: busy },
      t('common.cancel')
    ),
    h(
      'button',
      {
        type: 'button',
        className: 'dsht-btn dsht-btn-primary',
        onClick: props.onSave,
        disabled: busy || !draft
      },
      busy ? t('page.settings.saving') : t('page.settings.save')
    )
  );

  var sections = [];

  if (props.error) {
    sections.push(h(DshErrorBox, { key: 'error', error: props.error }));
  }
  if (props.metaError) {
    sections.push(h(DshErrorBox, { key: 'meta-error', error: props.metaError, onRetry: props.onRetryMeta, retryLabel: t('common.retry') }));
  }
  if (!draft) {
    sections.push(h('div', { key: 'loading', className: 'dsht-empty' }, h(DshSpinner, { label: t('common.loading') }), h('div', null, t('page.loading'))));
    return h(
      DshDialog,
      { open: true, title: t('page.settings.title'), onClose: props.onClose, closeLabel: t('common.close'), width: '880px', footer: footer },
      h('div', { className: 'dsht-settings-stack' }, sections)
    );
  }

  var priceFields = ['hit', 'miss', 'write', 'out', 'peakMultiplier'];
  function priceInput(modelKey, field) {
    var row = draft.prices && draft.prices[modelKey] ? draft.prices[modelKey] : DshTokenPageEmptyPrice();
    var value = row[field];
    return h('input', {
      type: 'number',
      min: '0',
      step: field === 'peakMultiplier' ? '0.1' : '0.001',
      className: 'dsht-input dsht-price-input',
      value: value === null || value === undefined ? '' : String(value),
      placeholder: '—',
      'aria-label': t('page.settings.' + field) + ' ' + modelKey,
      onChange: function (event) {
        if (props.onPriceChange) props.onPriceChange(modelKey, field, event.target.value);
      }
    });
  }

  var priceRows = models.map(function (model) {
    var modelKey = model && model.key !== null && model.key !== undefined ? String(model.key) : '';
    if (!modelKey) return null;
    var row = draft.prices && draft.prices[modelKey] ? draft.prices[modelKey] : null;
    var priced = DshTokenPagePricePriced(row);
    var cells = [
      h('td', { key: 'model', className: 'dsht-cell-left dsht-mono' }, modelKey),
      priceFields.map(function (field) {
        return h('td', { key: field, className: 'dsht-cell-actions' }, priceInput(modelKey, field));
      }),
      h(
        'td',
        { key: 'status', className: 'dsht-cell-actions' },
        h('span', { className: 'dsht-chip', 'data-tone': priced ? 'ok' : 'warn' }, priced ? t('page.settings.priced') : t('page.settings.unpriced'))
      )
    ];
    return h('tr', { key: modelKey }, cells);
  });

  var priceTable = h(
    'div',
    { key: 'prices', className: 'dsht-panel' },
    h(
      'div',
      { className: 'dsht-panel-head' },
      h('span', { className: 'dsht-panel-title' }, t('page.settings.prices', { currency: currency }))
    ),
    h('div', { className: 'dsht-hint', style: { marginBottom: 8 } }, t('page.settings.pricesHint')),
    h(
      'div',
      { className: 'dsht-table-wrap', style: { maxHeight: 240 } },
      h(
        'table',
        { className: 'dsht-table' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', { className: 'dsht-cell-left' }, t('page.settings.model')),
            h('th', null, t('page.settings.hit')),
            h('th', null, t('page.settings.miss')),
            h('th', null, t('page.settings.write')),
            h('th', null, t('page.settings.out')),
            h('th', null, t('page.settings.peakMultiplier')),
            h('th', null, t('page.settings.status'))
          )
        ),
        h(
          'tbody',
          null,
          priceRows.length
            ? priceRows
            : h('tr', null, h('td', { colSpan: 7, className: 'dsht-cell-left dsht-muted' }, t('page.models.none')))
        )
      )
    )
  );

  var budgetInput = h('input', {
    type: 'number',
    min: '0',
    step: '1',
    className: 'dsht-input dsht-price-input',
    value: draft.budgetMonthly === null || draft.budgetMonthly === undefined ? '' : String(draft.budgetMonthly),
    placeholder: '0',
    'aria-label': t('page.settings.budget'),
    title: t('page.settings.budget'),
    onChange: function (event) {
      if (props.onBudgetChange) props.onBudgetChange(event.target.value);
    }
  });

  var budgetPanel = h(
    'div',
    { key: 'budget', className: 'dsht-panel' },
    h('div', { className: 'dsht-panel-head' }, h('span', { className: 'dsht-panel-title' }, t('page.settings.budget'))),
    h(
      'div',
      { className: 'dsht-filter-group' },
      budgetInput,
      h('span', { className: 'dsht-hint' }, t('page.settings.budgetUnit'))
    ),
    h('div', { className: 'dsht-hint', style: { marginTop: 6 } }, t('page.settings.budgetHint'))
  );

  var peak = draft.peak || DshTokenPageNormalizePeak(null);
  var weekdayChecks = DshTokenPageWeekdays.map(function (day) {
    var checked = Array.isArray(peak.days) && peak.days.indexOf(day) >= 0;
    return h(
      'span',
      { key: day, className: 'dsht-row', style: { gap: 4 } },
      h(DshCheckbox, {
        checked: checked,
        title: t('page.weekday.' + day),
        onChange: function (next) {
          if (props.onPeakDay) props.onPeakDay(day, !!next);
        }
      }),
      h('span', { className: 'dsht-hint' }, t('page.weekday.' + day))
    );
  });

  var windowRows = (peak.windows || []).map(function (window, index) {
    return h(
      'div',
      { key: 'window-' + index, className: 'dsht-row', style: { gap: 6 } },
      h('span', { className: 'dsht-filter-label' }, t('page.settings.window', { index: index + 1 })),
      h('input', {
        type: 'time',
        className: 'dsht-input',
        value: DshTokenPageMinutesToTime(window.start),
        title: t('page.settings.peakStart'),
        'aria-label': t('page.settings.peakStart') + ' ' + (index + 1),
        onChange: function (event) {
          if (props.onPeakWindow) props.onPeakWindow(index, 'start', event.target.value);
        }
      }),
      h('span', { className: 'dsht-muted' }, '–'),
      h('input', {
        type: 'time',
        className: 'dsht-input',
        value: DshTokenPageMinutesToTime(window.end),
        title: t('page.settings.peakEnd'),
        'aria-label': t('page.settings.peakEnd') + ' ' + (index + 1),
        onChange: function (event) {
          if (props.onPeakWindow) props.onPeakWindow(index, 'end', event.target.value);
        }
      })
    );
  });

  var peakPanel = h(
    'div',
    { key: 'peak', className: 'dsht-panel' },
    h(
      'div',
      { className: 'dsht-panel-head' },
      h('span', { className: 'dsht-panel-title' }, t('page.settings.peak')),
      h('span', { className: 'dsht-grow' }),
      h(DshTokenPageToggle, {
        checked: !!peak.enabled,
        label: t('page.settings.peakEnabled'),
        title: t('page.settings.peakEnabled'),
        onChange: function (next) {
          if (props.onPeakEnabled) props.onPeakEnabled(!!next);
        }
      })
    ),
    h(
      'div',
      { className: 'dsht-filter-group', style: { marginBottom: 8 } },
      h('span', { className: 'dsht-filter-label' }, t('page.settings.peakDays')),
      weekdayChecks
    ),
    h(
      'div',
      { className: 'dsht-filter-group', style: { marginBottom: 8 } },
      h('span', { className: 'dsht-filter-label' }, t('page.settings.peakWindows')),
      windowRows
    ),
    h(
      'div',
      { className: 'dsht-col', style: { gap: 4 } },
      h('span', { className: 'dsht-filter-label' }, t('page.settings.holidays')),
      h('textarea', {
        className: 'dsht-input dsht-textarea',
        rows: 3,
        spellCheck: false,
        placeholder: '2026-01-01\n2026-02-17',
        value: (peak.holidays || []).join('\n'),
        onChange: function (event) {
          if (props.onPeakHolidays) props.onPeakHolidays(event.target.value);
        }
      }),
      h('span', { className: 'dsht-hint' }, t('page.settings.holidaysHint'))
    )
  );

  var jsonPanel = h(
    'div',
    { key: 'json', className: 'dsht-panel' },
    h('div', { className: 'dsht-panel-head' }, h('span', { className: 'dsht-panel-title' }, t('page.settings.json'))),
    h('textarea', {
      className: 'dsht-input dsht-textarea',
      rows: 4,
      spellCheck: false,
      placeholder: t('page.settings.jsonPlaceholder'),
      value: props.jsonText || '',
      onChange: function (event) {
        if (props.onJsonChange) props.onJsonChange(event.target.value);
      }
    }),
    h(
      'div',
      { className: 'dsht-row', style: { marginTop: 8 } },
      h(
        'button',
        { type: 'button', className: 'dsht-btn', onClick: props.onImport, disabled: busy },
        h(DshIcon, { name: 'download', size: 13 }),
        h('span', null, t('page.settings.import'))
      ),
      h(
        'button',
        { type: 'button', className: 'dsht-btn', onClick: props.onExport, disabled: busy || !draft },
        h(DshIcon, { name: 'copy', size: 13 }),
        h('span', null, t('page.settings.export'))
      )
    )
  );

  var noteItems = [
    t('page.note.cost'),
    t('page.note.unpriced'),
    t('page.note.provider'),
    t('page.note.usage')
  ].map(function (text, index) {
    return h('li', { key: index }, text);
  });

  var notePanel = h(
    'div',
    { key: 'note', className: 'dsht-panel' },
    h('div', { className: 'dsht-panel-head' }, h('span', { className: 'dsht-panel-title' }, t('page.settings.note'))),
    h('ul', { className: 'dsht-note-list' }, noteItems)
  );

  sections.push(priceTable);
  sections.push(budgetPanel);
  sections.push(peakPanel);
  sections.push(jsonPanel);
  sections.push(notePanel);

  return h(
    DshDialog,
    {
      open: true,
      title: t('page.settings.title'),
      onClose: props.onClose,
      closeLabel: t('common.close'),
      width: '880px',
      footer: footer
    },
    h('div', { className: 'dsht-settings-stack' }, sections)
  );
}

/* ---------------------------------------------------------------- page --- */

function DshTokenPage(props) {
  props = props || {};

  /* All hooks are unconditional and declared in a fixed order. */
  var t = dshtokenUseT(props);
  var visible = dshtokenUseVisible();
  // The slot system may spread injected keys onto props (top-level) or nest them
  // under props.inject; accept both, and degrade to an empty face.
  var inject = props.inject && typeof props.inject === 'object'
    ? props.inject
    : props && typeof props.openSession === 'function'
      ? props
      : {};

  var presetStore = dshtokenUsePersisted('page.preset', 'last7');
  var customStore = dshtokenUsePersisted('page.customRange', null);
  var bucketStore = dshtokenUsePersisted('page.bucket', 'auto');
  var metricStore = dshtokenUsePersisted('page.metric', 'tokens');
  var groupStore = dshtokenUsePersisted('page.groupBy', 'category');
  var modelsStore = dshtokenUsePersisted('page.models', null);
  var subagentStore = dshtokenUsePersisted('page.includeSubagents', true);
  var autoStore = dshtokenUsePersisted('page.autoRefresh', true);

  var nowPair = React.useState(function () {
    return Date.now();
  });
  var drillPair = React.useState([]);
  var settingsOpenPair = React.useState(false);
  var activeDimsPair = React.useState(null);
  var flashPair = React.useState(null);
  var actionErrorPair = React.useState(null);
  var rebuildingPair = React.useState(false);
  var modelPopPair = React.useState(false);
  var modelPopAnchorPair = React.useState({ x: 40, y: 120 });
  var draftPair = React.useState(null);
  var settingsErrorPair = React.useState(null);
  var settingsBusyPair = React.useState(false);
  var jsonTextPair = React.useState('');
  var sessionCachePair = React.useState({});
  var sessionHoverPair = React.useState(null);

  var copyTimerRef = React.useRef(0);
  var prevRunningRef = React.useRef(false);
  var lastDimsKeyRef = React.useRef('');
  var reloadRef = React.useRef(null);
  var modelBtnRef = React.useRef(null);
  var sessionCacheRef = React.useRef({});
  var sessionCacheEpochRef = React.useRef(0);
  var sessionHoverRef = React.useRef(null);

  var metaState = dshtokenUseAsync(function () {
    return dshtokenApi('meta', {});
  }, []);
  var statusState = dshtokenUseAsync(function () {
    return dshtokenApi('status', {});
  }, []);
  /* Official account balance is optional: swallow errors and ok:false so the
   * page renders normally while the Host endpoint does not exist yet. */
  var balanceState = dshtokenUseAsync(function () {
    return dshtokenApi('balance', {}).then(
      function (value) {
        return value;
      },
      function () {
        return null;
      }
    );
  }, []);

  /* ---------------------------------------------------- derived settings --- */

  var nowMs = nowPair[0];
  var preset = DshTokenPagePresets.indexOf(presetStore[0]) >= 0 ? presetStore[0] : 'last7';
  var bucket = DshTokenPageBuckets.indexOf(bucketStore[0]) >= 0 ? bucketStore[0] : 'auto';
  var metric = metricStore[0] === 'cost' ? 'cost' : 'tokens';
  var groupBy = DshTokenPageGroups.indexOf(groupStore[0]) >= 0 ? groupStore[0] : 'category';
  var includeSubagents = subagentStore[0] === null || subagentStore[0] === undefined ? true : !!subagentStore[0];
  var autoRefreshOn = autoStore[0] === null || autoStore[0] === undefined ? true : !!autoStore[0];

  var metaValue = metaState.data && typeof metaState.data === 'object' ? metaState.data : null;
  var tzMinutes = metaValue && typeof metaValue.timezoneOffsetMinutes === 'number' ? metaValue.timezoneOffsetMinutes : 480;
  var offsetMs = dshtokenOffsetMs(tzMinutes);
  var currency = metaValue && typeof metaValue.currency === 'string' && metaValue.currency ? metaValue.currency : 'CNY';
  var budgetMonthly = DshTokenPageBudgetFromConfig(metaValue ? metaValue.config : null);

  var metaModels = metaValue && Array.isArray(metaValue.models) ? metaValue.models : [];
  var allModelKeys = [];
  for (var modelIndex = 0; modelIndex < metaModels.length; modelIndex++) {
    var modelEntry = metaModels[modelIndex];
    if (!modelEntry || typeof modelEntry !== 'object') continue;
    var modelKey = modelEntry.key === null || modelEntry.key === undefined ? '' : String(modelEntry.key);
    if (modelKey && allModelKeys.indexOf(modelKey) < 0) allModelKeys.push(modelKey);
  }
  allModelKeys.sort();

  var savedModels = Array.isArray(modelsStore[0]) ? modelsStore[0] : null;
  var selectedModelKeys = savedModels === null ? null : DshTokenPageUnique(savedModels);
  var checkedModelKeys = [];
  if (selectedModelKeys === null) {
    checkedModelKeys = allModelKeys.slice();
  } else {
    for (var checkedIndex = 0; checkedIndex < selectedModelKeys.length; checkedIndex++) {
      if (allModelKeys.indexOf(selectedModelKeys[checkedIndex]) >= 0) checkedModelKeys.push(selectedModelKeys[checkedIndex]);
    }
  }
  var modelsForRequest = null;
  if (selectedModelKeys !== null && allModelKeys.length) {
    var filteredModels = checkedModelKeys.filter(function (key) {
      return allModelKeys.indexOf(key) >= 0;
    });
    if (filteredModels.length && filteredModels.length < allModelKeys.length) {
      modelsForRequest = filteredModels;
    }
  }
  var modelsKey = modelsForRequest ? modelsForRequest.join('\u0001') : '';

  var custom = customStore[0] && typeof customStore[0] === 'object' ? customStore[0] : null;
  var presetRange = DshTokenPageRangeForPreset(preset, nowMs, offsetMs, custom);
  var drill = Array.isArray(drillPair[0]) ? drillPair[0] : [];
  var drillEntry = drill.length ? drill[drill.length - 1] : null;
  var from = drillEntry && isFinite(drillEntry.from) ? DshTokenPageNum(drillEntry.from) : presetRange.from;
  var to = drillEntry && isFinite(drillEntry.to) ? DshTokenPageNum(drillEntry.to) : presetRange.to;
  if (!(to > from)) {
    from = presetRange.from;
    to = presetRange.to;
  }

  var statsState = dshtokenUseAsync(
    function () {
      return dshtokenApi('stats', DshTokenPageStatsBody(from, to, bucket, groupBy, metric, modelsForRequest, includeSubagents));
    },
    [from, to, bucket, groupBy, metric, modelsKey, includeSubagents]
  );

  var rankState = dshtokenUseAsync(
    function () {
      var sessionsRequest = dshtokenApi('stats', DshTokenPageStatsBody(from, to, 'auto', 'session', metric, modelsForRequest, includeSubagents));
      var modelsRequest = dshtokenApi('stats', DshTokenPageStatsBody(from, to, 'auto', 'model', metric, modelsForRequest, includeSubagents));
      return Promise.all([sessionsRequest, modelsRequest]).then(function (list) {
        var sessionsValue = list[0];
        var modelsValue = list[1];
        var ids = [];
        if (sessionsValue && Array.isArray(sessionsValue.dims)) {
          for (var i = 0; i < sessionsValue.dims.length && ids.length < 12; i++) {
            var dim = sessionsValue.dims[i];
            if (!dim || typeof dim !== 'object') continue;
            if (dim.kind !== 'session') continue;
            var id = dim.key === null || dim.key === undefined ? '' : String(dim.key);
            if (id && id !== '__other' && ids.indexOf(id) < 0) ids.push(id);
          }
        }
        if (!ids.length) return { sessions: sessionsValue, models: modelsValue, titles: {} };
        return dshtokenApi('titles', { ids: ids }).then(
          function (titles) {
            return { sessions: sessionsValue, models: modelsValue, titles: titles && typeof titles === 'object' ? titles : {} };
          },
          function () {
            return { sessions: sessionsValue, models: modelsValue, titles: {} };
          }
        );
      });
    },
    [from, to, metric, modelsKey, includeSubagents]
  );

  /* Month-to-date cost for the budget card: one dedicated stats call using the
   * same filters, independent of the page's selected date range. Skipped while
   * the budget is disabled so a zero budget costs no extra request. */
  var budgetRange = DshTokenPageMonthRange(nowMs, offsetMs);
  var budgetState = dshtokenUseAsync(
    function () {
      if (!(budgetMonthly > 0)) return Promise.resolve(null);
      return dshtokenApi('stats', DshTokenPageStatsBody(budgetRange.from, budgetRange.to, 'month', 'category', 'cost', modelsForRequest, includeSubagents));
    },
    [budgetRange.from, budgetRange.to, modelsKey, includeSubagents, budgetMonthly]
  );

  /* ------------------------------------------------------- derived view --- */

  var statsValue = statsState.data && typeof statsState.data === 'object' ? statsState.data : null;
  var statsSummary = DshTokenPageSummary(statsValue);
  var statsDims = statsValue && Array.isArray(statsValue.dims) ? statsValue.dims.filter(function (dim) {
    return dim && typeof dim === 'object';
  }) : [];
  var dimKeys = [];
  for (var dimIndex = 0; dimIndex < statsDims.length; dimIndex++) {
    var currentDim = statsDims[dimIndex];
    var currentKey = currentDim.key === null || currentDim.key === undefined ? '' : String(currentDim.key);
    if (currentKey && dimKeys.indexOf(currentKey) < 0) dimKeys.push(currentKey);
  }
  var dimsKey = dimKeys.join('|');
  var bucketEffective = statsValue && typeof statsValue.bucket === 'string' ? statsValue.bucket : bucket;
  var statsCurrency = statsValue && typeof statsValue.currency === 'string' && statsValue.currency ? statsValue.currency : currency;

  var activeDimsRef = activeDimsPair[0];
  var activeKeys = activeDimsRef === null || !Array.isArray(activeDimsRef)
    ? dimKeys.slice()
    : dimKeys.filter(function (key) {
        return activeDimsRef.indexOf(key) >= 0;
      });
  if (!activeKeys.length) activeKeys = dimKeys.slice();
  var activeSet = {};
  for (var activeIndex = 0; activeIndex < activeKeys.length; activeIndex++) activeSet[activeKeys[activeIndex]] = true;

  var statusValue = statusState.data && typeof statusState.data === 'object' ? statusState.data : null;
  var running = !!(statusValue && statusValue.running);
  var statusProgress = statsSummary.indexProgress;
  var scanned = statusValue && typeof statusValue.scanned === 'number'
    ? statusValue.scanned
    : statusProgress && typeof statusProgress.scanned === 'number' ? statusProgress.scanned : 0;
  var totalSessions = statusValue && typeof statusValue.total === 'number'
    ? statusValue.total
    : statusProgress && typeof statusProgress.total === 'number' ? statusProgress.total : 0;
  var indexedSessions = statusValue && typeof statusValue.sessions === 'number'
    ? statusValue.sessions
    : metaValue && metaValue.sessions && typeof metaValue.sessions.indexed === 'number' ? metaValue.sessions.indexed : 0;
  if (!totalSessions && metaValue && metaValue.sessions && typeof metaValue.sessions.total === 'number') {
    totalSessions = metaValue.sessions.total;
  }
  var scanErrors = statusValue && Array.isArray(statusValue.errors) ? statusValue.errors : [];
  var scanErrorTitle = '';
  for (var errorIndex = 0; errorIndex < scanErrors.length && errorIndex < 5; errorIndex++) {
    var scanError = scanErrors[errorIndex];
    if (!scanError) continue;
    scanErrorTitle += (scanError.sessionId ? String(scanError.sessionId) + ': ' : '') + String(scanError.error || '') + '\n';
  }

  var hasStats = !!statsValue;
  var dimAggregate = DshTokenPageAggregateDims(statsValue);
  var dimValues = {};
  for (var valueIndex = 0; valueIndex < dimKeys.length; valueIndex++) {
    var valueKey = dimKeys[valueIndex];
    var valuePart = dimAggregate[valueKey];
    if (!valuePart) continue;
    dimValues[valueKey] = metric === 'cost' ? valuePart.cost : valuePart.tokens;
  }

  var totalsPart = statsValue && statsValue.totals ? DshTokenPagePart(statsValue.totals) : null;
  var detailRows = DshTokenPageBuildRows(statsValue);
  var rangeText = DshTokenPageRangeText(from, to, offsetMs);

  var rankData = rankState.data && typeof rankState.data === 'object' ? rankState.data : {};
  var rankTitles = rankData.titles && typeof rankData.titles === 'object' ? rankData.titles : {};

  var sessionRankRows = DshTokenPageRankRows(rankData.sessions, metric).slice(0, 6).map(function (item) {
    var info = rankTitles[item.key];
    var sessionTitle = '';
    if (info && typeof info === 'object') sessionTitle = info.title ? String(info.title) : info.cwd ? String(info.cwd) : '';
    else if (typeof info === 'string') sessionTitle = info;
    var shortId = item.key.length > 10 ? item.key.slice(0, 10) + '…' : item.key;
    return {
      key: item.key,
      label: sessionTitle || t('page.rank.unknownSession', { id: shortId }),
      title: item.key,
      color: DshTokenPageDimColor(item.key, 0, 'session'),
      valueText: metric === 'cost' ? dshtokenFmtCost(item.value, statsCurrency) : dshtokenFmtTokens(item.value),
      subText: metric === 'cost' ? dshtokenFmtTokens(item.part.tokens) : dshtokenFmtCost(item.part.cost, statsCurrency),
      clickable: typeof inject.openSession === 'function',
      onClick: function () {
        if (typeof inject.openSession === 'function') inject.openSession(item.key);
      }
    };
  });

  var modelRankRows = DshTokenPageRankRows(rankData.models, metric).slice(0, 8).map(function (item, index) {
    return {
      key: item.key,
      label: DshTokenPageDimLabel(t, item.dim),
      title: item.key,
      color: DshTokenPageDimColor(item.key, index, 'model'),
      valueText: metric === 'cost' ? dshtokenFmtCost(item.value, statsCurrency) : dshtokenFmtTokens(item.value),
      subText: metric === 'cost' ? dshtokenFmtTokens(item.part.tokens) : dshtokenFmtCost(item.part.cost, statsCurrency),
      clickable: false,
      onClick: null
    };
  });

  /* --------------------------------------------------- budget & balance --- */

  var budgetValue = budgetState.data && typeof budgetState.data === 'object' ? budgetState.data : null;
  var budgetMonthSummary = DshTokenPageSummary(budgetValue);
  var budgetMonthTotals = budgetValue && budgetValue.totals ? DshTokenPagePart(budgetValue.totals) : null;
  var budgetMonthCost = budgetValue
    ? budgetMonthSummary.totalCost || (budgetMonthTotals ? budgetMonthTotals.cost : 0)
    : null;
  var budgetPct = budgetMonthly > 0 && budgetMonthCost !== null ? budgetMonthCost / budgetMonthly : 0;
  var budgetOver = budgetMonthCost !== null && budgetPct >= 1;
  var budgetWarn = !budgetOver && budgetPct >= 0.8;
  var budgetCard = null;
  if (budgetMonthly > 0) {
    var budgetValueText;
    var budgetSubText = '';
    if (budgetMonthCost === null) {
      budgetValueText = t('page.card.empty') + ' / ' + dshtokenFmtCost(budgetMonthly, statsCurrency);
      budgetSubText = budgetState.loading ? t('common.loading') : '';
    } else {
      budgetValueText = dshtokenFmtCost(budgetMonthCost, statsCurrency) + ' / ' + dshtokenFmtCost(budgetMonthly, statsCurrency);
      if (budgetOver) {
        budgetSubText = t('page.budget.over', {
          amount: dshtokenFmtCost(Math.max(0, budgetMonthCost - budgetMonthly), statsCurrency)
        });
      } else {
        budgetSubText = t('page.budget.remaining', {
          amount: dshtokenFmtCost(Math.max(0, budgetMonthly - budgetMonthCost), statsCurrency)
        });
      }
    }
    var budgetValueStyle = null;
    if (budgetOver) budgetValueStyle = { color: 'var(--dsw-alias-state-error-primary)' };
    else if (budgetWarn) budgetValueStyle = { color: 'var(--dsw-alias-state-warn-primary)' };
    budgetCard = h(
      'div',
      {
        key: 'budget',
        className: 'dsht-card dsht-budget' + (budgetOver ? ' dsht-budget-over' : budgetWarn ? ' dsht-budget-warn' : ''),
        title: t('page.budget.titleAttr')
      },
      h('div', { className: 'dsht-card-label' }, t('page.budget.title')),
      h('div', { className: 'dsht-card-value', style: budgetValueStyle }, budgetValueText),
      budgetSubText ? h('div', { className: 'dsht-card-sub' }, budgetSubText) : null,
      h(DshProgress, { value: Math.max(0, Math.min(1, budgetPct)) }),
      budgetMonthCost !== null ? h('div', { className: 'dsht-hint' }, t('page.budget.used', { pct: dshtokenFmtPct(budgetPct) })) : null,
      modelsForRequest ? h('div', { className: 'dsht-hint' }, t('page.budget.filterHint')) : null
    );
  }

  var balanceValue = balanceState.data && typeof balanceState.data === 'object' ? balanceState.data : null;
  var balanceParts = DshTokenPageBalanceParts(balanceValue);
  var balanceChip = balanceParts
    ? h(
        'div',
        { className: 'dsht-chip', title: t('page.balance.title') },
        h(DshIcon, { name: 'database', size: 11 }),
        h('span', null, t('page.balance.label') + ' ' + balanceParts.wallets.join(' · ')),
        balanceParts.bonus.length
          ? h('span', { className: 'dsht-muted' }, '· ' + t('page.balance.bonus') + ' ' + balanceParts.bonus.join(' · '))
          : null
      )
    : null;

  /* ---------------------------------------------------- session hover --- */

  var sessionMode = groupBy === 'session';
  var sessionScopeKey = [from, to, bucket, groupBy, dimsKey, metric, modelsKey, includeSubagents ? '1' : '0'].join('|');
  var sessionCache = sessionCachePair[0] && typeof sessionCachePair[0] === 'object' ? sessionCachePair[0] : {};
  var sessionHoverT0 = sessionHoverPair[0];
  var hoveredSessionEntry = sessionMode && sessionHoverT0 !== null && sessionHoverT0 !== undefined
    ? sessionCache[String(sessionHoverT0)] || null
    : null;
  var chartSessionRows = hoveredSessionEntry && hoveredSessionEntry.status === 'ready'
    ? (Array.isArray(hoveredSessionEntry.rows) ? hoveredSessionEntry.rows : [])
    : null;
  var chartSessionLoading = !!(hoveredSessionEntry && hoveredSessionEntry.status === 'loading');
  var chartSessionError = !!(hoveredSessionEntry && hoveredSessionEntry.status === 'error');

  /* ------------------------------------------------------------- hooks --- */

  dshtokenUseInterval(
    function () {
      statusState.reload();
    },
    2000,
    running && visible
  );

  dshtokenUseInterval(
    function () {
      statsState.reload();
      rankState.reload();
      statusState.reload();
      budgetState.reload();
    },
    15000,
    autoRefreshOn && visible
  );

  reloadRef.current = function () {
    statusState.reload();
    statsState.reload();
    rankState.reload();
    budgetState.reload();
    metaState.reload();
  };

  React.useEffect(
    function () {
      var subscribe = typeof inject.subscribeStatsChanged === 'function' ? inject.subscribeStatsChanged : null;
      if (!subscribe) return undefined;
      var dispose = subscribe(function () {
        if (reloadRef.current) reloadRef.current();
      });
      return function () {
        if (typeof dispose === 'function') dispose();
      };
    },
    [inject]
  );

  React.useEffect(
    function () {
      if (!running && prevRunningRef.current) {
        metaState.reload();
        statsState.reload();
        rankState.reload();
        statusState.reload();
        budgetState.reload();
      }
      prevRunningRef.current = running;
    },
    [running]
  );

  React.useEffect(
    function () {
      if (lastDimsKeyRef.current === dimsKey) return;
      lastDimsKeyRef.current = dimsKey;
      setActiveDims(null);
    },
    [dimsKey]
  );

  /* Per-bucket session lists are only valid for the current range/bucket/
   * metric/filters: drop them (and bump the epoch so in-flight responses are
   * ignored) whenever that scope changes. */
  React.useEffect(
    function () {
      resetSessionCache();
    },
    [sessionScopeKey]
  );

  React.useEffect(
    function () {
      if (!settingsOpenPair[0]) return;
      if (draftPair[0] !== null) return;
      if (!metaState.data) return;
      setDraft(DshTokenPageDraftFromConfig(metaState.data.config, metaState.data.defaults));
      setSettingsError(null);
      setJsonText('');
    },
    [settingsOpenPair[0], metaState.data, draftPair[0]]
  );

  React.useEffect(
    function () {
      return function () {
        if (copyTimerRef.current) {
          clearTimeout(copyTimerRef.current);
          copyTimerRef.current = 0;
        }
      };
    },
    []
  );

  /* ----------------------------------------------------------- setters --- */

  var setDrill = drillPair[1];
  var setActiveDims = activeDimsPair[1];
  var setSettingsOpen = settingsOpenPair[1];
  var setModelPopOpen = modelPopPair[1];
  var setModelPopAnchor = modelPopAnchorPair[1];
  var setDraft = draftPair[1];
  var setSettingsError = settingsErrorPair[1];
  var setSettingsBusy = settingsBusyPair[1];
  var setJsonText = jsonTextPair[1];
  var setFlash = flashPair[1];
  var setActionError = actionErrorPair[1];
  var setRebuilding = rebuildingPair[1];
  var setNowMs = nowPair[1];
  var setSessionCache = sessionCachePair[1];
  var setSessionHoverT0 = sessionHoverPair[1];

  function showFlash(text) {
    setFlash(text);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(function () {
      copyTimerRef.current = 0;
      setFlash(null);
    }, 2400);
  }

  function refreshAll() {
    setNowMs(Date.now());
    setActionError(null);
    metaState.reload();
    statusState.reload();
    statsState.reload();
    rankState.reload();
    budgetState.reload();
    balanceState.reload();
  }

  function choosePreset(nextPreset) {
    if (nextPreset === 'custom') {
      var currentCustom = custom && custom.from && custom.to
        ? custom
        : {
            from: dshtokenFmtInputDate(from, offsetMs),
            to: dshtokenFmtInputDate(to - 1, offsetMs)
          };
      customStore[1](currentCustom);
    }
    presetStore[1](nextPreset);
    setDrill([]);
  }

  function changeDateInput(side, value) {
    var next = custom && typeof custom === 'object'
      ? { from: custom.from === undefined ? null : custom.from, to: custom.to === undefined ? null : custom.to }
      : { from: null, to: null };
    next[side] = value;
    customStore[1](next);
    presetStore[1]('custom');
    setDrill([]);
  }

  function chooseBucket(nextBucket) {
    bucketStore[1](nextBucket);
  }

  function chooseMetric(nextMetric) {
    metricStore[1](nextMetric === 'cost' ? 'cost' : 'tokens');
  }

  function chooseGroupBy(nextGroup) {
    groupStore[1](nextGroup);
  }

  function toggleIncludeSubagents(next) {
    subagentStore[1](!!next);
  }

  function toggleAutoRefresh(next) {
    autoStore[1](!!next);
  }

  function resetFilters() {
    presetStore[1]('last7');
    customStore[1](null);
    bucketStore[1]('auto');
    metricStore[1]('tokens');
    groupStore[1]('category');
    modelsStore[1](null);
    subagentStore[1](true);
    setDrill([]);
    setActiveDims(null);
    setNowMs(Date.now());
  }

  function pickBucket(t0, t1) {
    var start = DshTokenPageToNumber(t0);
    var end = DshTokenPageToNumber(t1);
    if (start === null || end === null || end <= start) return;
    if (drill.length >= 12) return;
    var label = dshtokenFmtBucketLabel(start, bucketEffective, offsetMs);
    setDrill(function (previous) {
      return (Array.isArray(previous) ? previous : []).concat([{ from: start, to: end, label: label }]);
    });
  }

  function popDrill() {
    setDrill(function (previous) {
      return Array.isArray(previous) ? previous.slice(0, -1) : [];
    });
  }

  function selectRange(rangeFrom, rangeTo) {
    var start = DshTokenPageToNumber(rangeFrom);
    var end = DshTokenPageToNumber(rangeTo);
    if (start === null || end === null || end <= start) return;
    presetStore[1]('custom');
    customStore[1]({
      from: dshtokenFmtInputDate(start, offsetMs),
      to: dshtokenFmtInputDate(end - 1, offsetMs)
    });
    setDrill([{ from: start, to: end, label: t('page.drill.selection') }]);
  }

  function toggleDim(key) {
    if (!key) return;
    var current = activeKeys.slice();
    var position = current.indexOf(key);
    if (position >= 0) current.splice(position, 1);
    else current.push(key);
    if (!current.length) current = dimKeys.slice();
    setActiveDims(current.length === dimKeys.length ? null : current);
  }

  function selectAllModels() {
    modelsStore[1](allModelKeys.slice());
  }

  function clearModels() {
    modelsStore[1]([]);
  }

  function toggleModel(key) {
    if (!key) return;
    modelsStore[1](function (previous) {
      var base = Array.isArray(previous) ? previous.slice() : allModelKeys.slice();
      var position = base.indexOf(key);
      if (position >= 0) base.splice(position, 1);
      else base.push(key);
      return base;
    });
  }

  function toggleModelPopover() {
    var element = modelBtnRef.current;
    var rect = element && typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null;
    setModelPopAnchor(rect ? { x: rect.left, y: rect.bottom + 6 } : { x: 40, y: 120 });
    setModelPopOpen(function (previous) {
      return !previous;
    });
  }

  function closeModelPopover() {
    setModelPopOpen(false);
  }

  /* ------------------------------------------- session hover list cache --- */

  /** Drop every cached bucket session list and invalidate in-flight responses. */
  function resetSessionCache() {
    sessionCacheEpochRef.current += 1;
    var hadEntries = sessionHoverRef.current !== null;
    var previous = sessionCacheRef.current || {};
    for (var key in previous) {
      if (DshTokenPageOwn(previous, key)) {
        hadEntries = true;
        break;
      }
    }
    sessionCacheRef.current = {};
    sessionHoverRef.current = null;
    if (hadEntries) {
      setSessionCache({});
      setSessionHoverT0(null);
    }
  }

  /** Store one bucket entry, evicting the oldest t0 values beyond the cap. */
  function putBucketSessionEntry(t0, entry) {
    var previous = sessionCacheRef.current || {};
    var next = {};
    var key;
    for (key in previous) {
      if (DshTokenPageOwn(previous, key)) next[key] = previous[key];
    }
    next[String(t0)] = entry;
    var keys = [];
    for (key in next) {
      if (DshTokenPageOwn(next, key)) keys.push(Number(key));
    }
    keys.sort(function (a, b) {
      return a - b;
    });
    while (keys.length > DshTokenPageSessionCacheLimit) {
      delete next[String(keys.shift())];
    }
    sessionCacheRef.current = next;
    setSessionCache(next);
  }

  /** Chart callback: load (or reuse) the session list of one hovered bucket. */
  function requestBucketSessions(t0, t1) {
    if (!sessionMode) return;
    var start = DshTokenPageToNumber(t0);
    var end = DshTokenPageToNumber(t1);
    if (start === null || end === null || end <= start) return;
    sessionHoverRef.current = start;
    setSessionHoverT0(start);
    var cached = sessionCacheRef.current[String(start)];
    if (cached && (cached.status === 'loading' || cached.status === 'ready')) return;
    var epoch = sessionCacheEpochRef.current;
    putBucketSessionEntry(start, {
      status: 'loading',
      rows: [],
      total: null,
      sessionCount: 0,
      truncated: false
    });
    var payload = {
      from: start,
      to: end,
      metric: metric,
      includeSubagents: includeSubagents,
      limit: 200
    };
    if (modelsForRequest && modelsForRequest.length) payload.models = modelsForRequest.slice();
    dshtokenApi('bucketSessions', payload).then(
      function (value) {
        if (sessionCacheEpochRef.current !== epoch) return;
        var normalized = DshTokenPageSessionResult(value);
        putBucketSessionEntry(start, {
          status: 'ready',
          rows: normalized.rows,
          total: normalized.total,
          sessionCount: normalized.sessionCount,
          truncated: normalized.truncated
        });
      },
      function () {
        if (sessionCacheEpochRef.current !== epoch) return;
        putBucketSessionEntry(start, {
          status: 'error',
          rows: [],
          total: null,
          sessionCount: 0,
          truncated: false
        });
      }
    );
  }

  /** Chart callback: double-clicked session row → open it (real ids only). */
  function openSessionFromChart(sessionId) {
    if (!DshTokenPageIsRealSessionId(sessionId)) return;
    if (typeof inject.openSession !== 'function') return;
    try {
      inject.openSession(sessionId);
    } catch (error) {
      /* a chart callback must never blank the slot */
    }
  }

  function startRebuild() {
    if (rebuildingPair[0]) return;
    setRebuilding(true);
    setActionError(null);
    dshtokenApi('rebuild', {}).then(
      function () {
        setRebuilding(false);
        showFlash(t('page.rebuildStarted'));
        statusState.reload();
        metaState.reload();
      },
      function (error) {
        setRebuilding(false);
        setActionError(error || new Error(t('page.action.rebuildFailed', { message: 'unknown' })));
      }
    );
  }

  function openSettings() {
    setModelPopOpen(false);
    setSettingsError(null);
    setJsonText('');
    setDraft(null);
    setSettingsOpen(true);
  }

  function closeSettings() {
    if (settingsBusyPair[0]) return;
    setSettingsOpen(false);
    setSettingsError(null);
    setJsonText('');
  }

  function updateDraftPrices(nextPrices, nextPeak) {
    setDraft(function (previous) {
      if (!previous) return previous;
      return {
        prices: nextPrices === undefined ? previous.prices : nextPrices,
        peak: nextPeak === undefined ? previous.peak : nextPeak,
        prefs: previous.prefs,
        budgetMonthly: previous.budgetMonthly
      };
    });
  }

  /** Monthly budget editor value (blank/negative ⇒ 0 = disabled). */
  function setBudgetValue(text) {
    var value = DshTokenPageNonNegative(text);
    if (value === null) value = 0;
    setDraft(function (previous) {
      if (!previous) return previous;
      return {
        prices: previous.prices,
        peak: previous.peak,
        prefs: previous.prefs,
        budgetMonthly: value
      };
    });
  }

  function setPriceField(modelKey, field, text) {
    if (!draftPair[0] || !modelKey) return;
    var value = DshTokenPageToNumber(text);
    var prices = {};
    var sourcePrices = draftPair[0].prices || {};
    for (var key in sourcePrices) {
      if (DshTokenPageOwn(sourcePrices, key)) prices[key] = DshTokenPageClonePrice(sourcePrices[key]);
    }
    var row = DshTokenPageClonePrice(prices[modelKey]);
    row[field] = value;
    prices[modelKey] = row;
    updateDraftPrices(prices, undefined);
  }

  function setPeakEnabled(enabled) {
    if (!draftPair[0]) return;
    var peak = DshTokenPageClonePeak(draftPair[0].peak);
    peak.enabled = !!enabled;
    updateDraftPrices(undefined, peak);
  }

  function togglePeakDay(day, checked) {
    if (!draftPair[0]) return;
    var peak = DshTokenPageClonePeak(draftPair[0].peak);
    var position = peak.days.indexOf(day);
    if (checked && position < 0) peak.days.push(day);
    if (!checked && position >= 0) peak.days.splice(position, 1);
    peak.days.sort(function (a, b) {
      return a - b;
    });
    updateDraftPrices(undefined, peak);
  }

  function setPeakWindow(index, side, text) {
    if (!draftPair[0]) return;
    var peak = DshTokenPageClonePeak(draftPair[0].peak);
    while (peak.windows.length <= index) peak.windows.push({ start: null, end: null });
    var window = peak.windows[index] && typeof peak.windows[index] === 'object' ? peak.windows[index] : { start: null, end: null };
    window = { start: DshTokenPageToNumber(window.start), end: DshTokenPageToNumber(window.end) };
    window[side] = DshTokenPageTimeToMinutes(text);
    peak.windows[index] = window;
    updateDraftPrices(undefined, peak);
  }

  function setPeakHolidays(text) {
    if (!draftPair[0]) return;
    var peak = DshTokenPageClonePeak(draftPair[0].peak);
    peak.holidays = String(text === null || text === undefined ? '' : text).split(/\r?\n/).map(function (line) {
      return line.trim();
    }).filter(function (line) {
      return !!line;
    });
    updateDraftPrices(undefined, peak);
  }

  function restoreDefaults() {
    var defaults = metaState.data && metaState.data.defaults ? metaState.data.defaults : null;
    if (!defaults) {
      setSettingsError(new Error(t('page.settings.noDefaults')));
      return;
    }
    var defaultsDraft = DshTokenPageDraftFromConfig(defaults, defaults);
    var previousDraft = draftPair[0];
    setDraft({
      prices: defaultsDraft.prices,
      peak: defaultsDraft.peak,
      prefs: previousDraft && previousDraft.prefs ? previousDraft.prefs : defaultsDraft.prefs,
      budgetMonthly: previousDraft ? previousDraft.budgetMonthly : defaultsDraft.budgetMonthly
    });
    setSettingsError(null);
    showFlash(t('page.settings.restored'));
  }

  function exportSettingsJson() {
    if (!draftPair[0]) return;
    try {
      setJsonText(
        JSON.stringify(
          {
            prices: DshTokenPageCleanPrices(draftPair[0].prices),
            peak: DshTokenPageCleanPeak(draftPair[0].peak)
          },
          null,
          2
        )
      );
      setSettingsError(null);
    } catch (error) {
      setSettingsError(error);
    }
  }

  function importSettingsJson() {
    if (!draftPair[0]) return;
    var text = String(jsonTextPair[0] || '').trim();
    if (!text) return;
    try {
      var parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') throw new Error('JSON root must be an object');
      var nextPrices = draftPair[0].prices;
      var nextPeak = draftPair[0].peak;
      if (parsed.prices && typeof parsed.prices === 'object') {
        nextPrices = DshTokenPageNormalizePricesMap(parsed.prices);
      }
      if (parsed.peak && typeof parsed.peak === 'object') {
        nextPeak = DshTokenPageNormalizePeak(parsed.peak);
      }
      setDraft({
        prices: nextPrices,
        peak: nextPeak,
        prefs: draftPair[0].prefs,
        budgetMonthly: draftPair[0].budgetMonthly
      });
      setSettingsError(null);
      showFlash(t('page.settings.jsonImported'));
    } catch (error) {
      setSettingsError(new Error(t('page.settings.jsonError', { message: (error && error.message) || 'JSON' })));
    }
  }

  function saveSettings() {
    if (!draftPair[0] || settingsBusyPair[0]) return;
    setSettingsBusy(true);
    setSettingsError(null);
    /* Merge the budget into the latest live prefs so other pref keys survive. */
    var livePrefs = metaValue && metaValue.config ? DshTokenPageConfigPrefs(metaValue.config) : null;
    var prefs = DshTokenPageClonePrefs(livePrefs || draftPair[0].prefs);
    var budgetValue = DshTokenPageNonNegative(draftPair[0].budgetMonthly);
    prefs.budgetMonthly = budgetValue === null ? 0 : budgetValue;
    var patch = {
      prices: DshTokenPageCleanPrices(draftPair[0].prices),
      peak: DshTokenPageCleanPeak(draftPair[0].peak),
      prefs: prefs
    };
    dshtokenApi('config', { patch: patch }).then(
      function () {
        setSettingsBusy(false);
        setSettingsOpen(false);
        showFlash(t('page.settings.saved'));
        metaState.reload();
        statusState.reload();
        statsState.reload();
        rankState.reload();
        budgetState.reload();
        try {
          if (typeof inject.notifyStatsChanged === 'function') inject.notifyStatsChanged();
        } catch (error) {
          /* notification is best effort */
        }
      },
      function (error) {
        setSettingsBusy(false);
        var message = (error && (error.message || error.code)) || 'unknown';
        setSettingsError(new Error(t('page.settings.saveFailed', { message: String(message) })));
      }
    );
  }

  function exportCsv() {
    if (!detailRows.length) return;
    var text = DshTokenPageTableText(detailRows, totalsPart, t, offsetMs, bucketEffective, ',');
    var filename = 'dshtoken-' + DshTokenPageFileNameStamp(from, offsetMs) + '.csv';
    if (DshTokenPageDownload(filename, text, 'text/csv;charset=utf-8')) {
      showFlash(t('page.details.exported'));
    } else {
      showFlash(t('page.details.exportFailed'));
    }
  }

  function copyTsv() {
    if (!detailRows.length) return;
    var text = DshTokenPageTableText(detailRows, totalsPart, t, offsetMs, bucketEffective, '\t');
    DshTokenPageCopyText(text).then(
      function (ok) {
        showFlash(ok ? t('page.details.copied') : t('page.details.copyFailed'));
      },
      function () {
        showFlash(t('page.details.copyFailed'));
      }
    );
  }

  /* ------------------------------------------------------------ render --- */

  var presetOptions = DshTokenPagePresets.map(function (option) {
    return { value: option, label: t('page.preset.' + option), title: t('page.preset.' + option) };
  });
  var bucketOptions = DshTokenPageBuckets.map(function (option) {
    return { value: option, label: t('page.bucket.' + option), title: t('page.bucket.' + option) };
  });
  var metricOptions = DshTokenPageMetrics.map(function (option) {
    return {
      value: option,
      label: t('page.metric.' + option),
      title: t('page.metric.' + option)
    };
  });
  var groupOptions = DshTokenPageGroups.map(function (option) {
    return { value: option, label: t('page.group.' + option), title: t('page.group.' + option) };
  });

  var checksRows = allModelKeys.map(function (key) {
    var checked = selectedModelKeys === null ? true : checkedModelKeys.indexOf(key) >= 0;
    var metaEntry = null;
    for (var i = 0; i < metaModels.length; i++) {
      if (metaModels[i] && String(metaModels[i].key) === key) {
        metaEntry = metaModels[i];
        break;
      }
    }
    var tokenText = metaEntry && typeof metaEntry.tokens === 'number' ? dshtokenFmtTokens(metaEntry.tokens) : '';
    return h(
      'button',
      {
        key: key,
        type: 'button',
        className: 'dsht-model-row',
        role: 'menuitemcheckbox',
        'aria-checked': checked,
        title: key,
        onClick: function () {
          toggleModel(key);
        }
      },
      h('span', { className: 'dsht-check', 'aria-checked': checked ? 'true' : 'false', 'aria-hidden': true },
        checked ? h(DshIcon, { name: 'check', size: 10, strokeWidth: 2.4 }) : null
      ),
      h('span', { className: 'dsht-model-name' }, key),
      tokenText ? h('span', { className: 'dsht-muted' }, tokenText) : null
    );
  });

  var indexChipTone = running ? undefined : scanErrors.length ? 'warn' : hasStats ? 'ok' : undefined;
  var indexChipLabel;
  if (running) indexChipLabel = scanned || totalSessions ? t('page.indexing', { scanned: scanned, total: totalSessions }) : t('page.indexIdle');
  else if (totalSessions || indexedSessions) indexChipLabel = t('page.indexed', { indexed: indexedSessions, total: totalSessions });
  else indexChipLabel = t('page.indexIdle');
  var indexChip = h(
    'div',
    { className: 'dsht-chip', 'data-tone': indexChipTone, title: scanErrors.length && scanErrorTitle ? t('page.indexErrorsTitle') + '\n' + scanErrorTitle : t('page.indexReady') },
    running
      ? h(DshSpinner, { size: 11 })
      : h('span', { className: 'dsht-swatch', style: { width: 8, height: 8, borderRadius: '50%', background: 'var(--dsw-alias-state-success-primary)' } }),
    h('span', null, indexChipLabel),
    running && totalSessions > 0
      ? h('div', { style: { width: 64 } }, h(DshProgress, { value: scanned / totalSessions }))
      : null,
    scanErrors.length ? h('span', { className: 'dsht-warn' }, '· ' + t('page.indexErrors', { count: scanErrors.length })) : null
  );

  var headerElement = h(
    'div',
    { className: 'dsht-page-head' },
    h(
      'div',
      { className: 'dsht-grow', style: { flex: '1 1 320px', minWidth: 0 } },
      h('h1', { className: 'dsht-title' }, t('page.title')),
      h('p', { className: 'dsht-sub' }, t('page.desc'))
    ),
    h(
      'div',
      { className: 'dsht-row', style: { justifyContent: 'flex-end' } },
      indexChip,
      balanceChip,
      h(DshTokenPageIconButton, {
        icon: 'refresh',
        label: t('page.refresh'),
        title: t('page.refresh'),
        onClick: refreshAll
      }),
      h(DshTokenPageToggle, {
        checked: autoRefreshOn,
        label: t('page.autoRefresh'),
        title: t('page.autoRefreshHint'),
        onChange: toggleAutoRefresh
      }),
      h(
        'button',
        {
          type: 'button',
          className: 'dsht-btn dsht-btn-ghost',
          onClick: startRebuild,
          disabled: rebuildingPair[0] || running,
          title: t('page.rebuildHint')
        },
        rebuildingPair[0] || running
          ? h(DshSpinner, { size: 12 })
          : h(DshIcon, { name: 'database', size: 14 }),
        h('span', null, t('page.rebuild'))
      ),
      h(DshTokenPageIconButton, {
        icon: 'settings',
        title: t('page.settings'),
        onClick: openSettings
      })
    )
  );

  var flashElement = flashPair[0]
    ? h(
        'div',
        { className: 'dsht-row' },
        h(
          'span',
          { className: 'dsht-chip', 'data-tone': 'ok' },
          h(DshIcon, { name: 'check', size: 11 }),
          h('span', null, String(flashPair[0]))
        )
      )
    : null;

  var partialHint = statsSummary.partial
    ? h(
        'div',
        { className: 'dsht-hintbar' },
        h(DshIcon, { name: 'info', size: 13 }),
        h('span', null, t('page.partial'))
      )
    : null;

  var runningHint = running
    ? h(
        'div',
        { className: 'dsht-hintbar' },
        h(DshSpinner, { size: 12 }),
        h('span', { className: 'dsht-grow' }, t('page.partialRunning', { scanned: scanned, total: totalSessions })),
        h('div', { style: { width: 120 } }, h(DshProgress, { value: totalSessions > 0 ? scanned / totalSessions : 0 }))
      )
    : null;

  var unpricedModels = statsSummary.unpricedModels || [];
  var unpricedElement = unpricedModels.length
    ? h(
        'div',
        { className: 'dsht-row' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsht-chip',
            'data-tone': 'warn',
            title: t('page.unpricedHint'),
            style: { cursor: 'pointer', border: '0' },
            onClick: openSettings
          },
          h(DshIcon, { name: 'warn', size: 12 }),
          h('span', null, t('page.unpriced', { count: unpricedModels.length }))
        )
      )
    : null;

  var peakBucketValue = statsSummary.peakBucket && isFinite(statsSummary.peakBucket.t0) ? statsSummary.peakBucket : null;
  var peakLabel = peakBucketValue
    ? dshtokenFmtBucketLabel(peakBucketValue.t0, bucketEffective, offsetMs)
    : t('page.card.empty');
  var peakTitle = peakBucketValue
    ? dshtokenFmtBucketRange(peakBucketValue.t0, bucketEffective, offsetMs)
    : '';

  var cardItems = [
    h(DshTokenPageCard, {
      key: 'tokens',
      label: t('page.card.tokens'),
      value: hasStats ? dshtokenFmtTokens(statsSummary.totalTokens) : t('page.card.empty'),
      title: hasStats ? dshtokenFmtInt(statsSummary.totalTokens) : '',
      sub: t('page.card.tokensSub', { requests: dshtokenFmtInt(statsSummary.requests) })
    }),
    h(DshTokenPageCard, {
      key: 'cost',
      label: t('page.card.cost'),
      value: hasStats ? dshtokenFmtCost(statsSummary.totalCost, statsCurrency) : t('page.card.empty'),
      sub: statsSummary.unpricedTokens > 0
        ? t('page.card.costSub', { tokens: dshtokenFmtTokens(statsSummary.unpricedTokens) })
        : t('page.card.costSubPriced')
    }),
    h(DshTokenPageCard, {
      key: 'cache',
      label: t('page.card.cacheHit'),
      value: hasStats ? dshtokenFmtPct(statsSummary.cacheHitRate) : t('page.card.empty'),
      sub: totalsPart
        ? t('page.card.cacheHitSub', {
            hit: dshtokenFmtTokens(totalsPart.hit),
            input: dshtokenFmtTokens(totalsPart.hit + totalsPart.miss)
          })
        : ''
    }),
    h(DshTokenPageCard, {
      key: 'avg',
      label: t('page.card.avg'),
      value: hasStats ? dshtokenFmtTokens(statsSummary.avgPerDayTokens) : t('page.card.empty'),
      sub: t('page.card.avgSub', { days: dshtokenFmtInt(statsSummary.days) })
    }),
    h(DshTokenPageCard, {
      key: 'peak',
      label: t('page.card.peak'),
      value: peakLabel,
      title: peakTitle,
      sub: peakBucketValue
        ? t('page.card.peakSub', {
            tokens: dshtokenFmtTokens(DshTokenPageNum(peakBucketValue.tokens)),
            cost: dshtokenFmtCost(DshTokenPageNum(peakBucketValue.cost), statsCurrency)
          })
        : ''
    })
  ];
  if (budgetCard) cardItems.push(budgetCard);
  var cardsElement = h('div', { className: 'dsht-cards' }, cardItems);

  var dateInputFrom = dshtokenFmtInputDate(from, offsetMs);
  var dateInputTo = dshtokenFmtInputDate(to - 1, offsetMs);

  var filterElement = h(
    'div',
    { className: 'dsht-filterbar' },
    h(
      'div',
      { className: 'dsht-filter-group' },
      h('span', { className: 'dsht-filter-label' }, t('page.filter.preset')),
      h(DshSegmented, { value: preset, options: presetOptions, onChange: choosePreset, ariaLabel: t('page.filter.preset') }),
      h('input', {
        type: 'date',
        className: 'dsht-input dsht-date-input',
        value: dateInputFrom,
        'aria-label': t('page.filter.from'),
        title: t('page.filter.from'),
        onChange: function (event) {
          changeDateInput('from', event.target.value);
        }
      }),
      h('span', { className: 'dsht-muted' }, '–'),
      h('input', {
        type: 'date',
        className: 'dsht-input dsht-date-input',
        value: dateInputTo,
        'aria-label': t('page.filter.to'),
        title: t('page.filter.to'),
        onChange: function (event) {
          changeDateInput('to', event.target.value);
        }
      }),
      h('span', { className: 'dsht-grow' }),
      h(
        'button',
        { type: 'button', className: 'dsht-btn dsht-btn-ghost', onClick: resetFilters, title: t('page.filter.reset') },
        h(DshIcon, { name: 'refresh', size: 13 }),
        h('span', null, t('page.filter.reset'))
      )
    ),
    h(
      'div',
      { className: 'dsht-filter-group' },
      h('span', { className: 'dsht-filter-label' }, t('page.filter.bucket')),
      h(DshSegmented, { value: bucket, options: bucketOptions, onChange: chooseBucket, ariaLabel: t('page.filter.bucket') }),
      h('span', { className: 'dsht-filter-label' }, t('page.filter.metric')),
      h(DshSegmented, { value: metric, options: metricOptions, onChange: chooseMetric, ariaLabel: t('page.filter.metric') }),
      h('span', { className: 'dsht-filter-label' }, t('page.filter.groupBy')),
      h(DshSegmented, { value: groupBy, options: groupOptions, onChange: chooseGroupBy, ariaLabel: t('page.filter.groupBy') }),
      h('span', { className: 'dsht-grow' }),
      h(
        'button',
        {
          type: 'button',
          ref: modelBtnRef,
          className: 'dsht-btn' + (modelPopPair[0] ? ' is-active' : ''),
          onClick: toggleModelPopover,
          title: t('page.filter.models'),
          'aria-expanded': !!modelPopPair[0]
        },
        h(DshIcon, { name: 'filter', size: 13 }),
        h('span', null, t('page.filter.models') + ' ' + t('page.models.summary', { checked: checkedModelKeys.length, total: allModelKeys.length }))
      ),
      h(DshTokenPageToggle, {
        checked: includeSubagents,
        label: t('page.filter.includeSubagents'),
        title: t('page.filter.includeSubagents.hint'),
        onChange: toggleIncludeSubagents
      }),
      !includeSubagents && statsValue && statsValue.notes && statsValue.notes.subagentsMerged > 0
        ? h('span', {
            className: 'dsht-chip',
            title: t('page.filter.includeSubagents.hint')
          }, t('page.filter.subagentsMerged', { count: statsValue.notes.subagentsMerged }))
        : null
    )
  );

  var modelPopoverElement = h(
    DshPopover,
    {
      open: !!modelPopPair[0],
      x: modelPopAnchorPair[0].x,
      y: modelPopAnchorPair[0].y,
      width: 320,
      onClose: closeModelPopover
    },
    h(
      'div',
      { className: 'dsht-col', style: { gap: 6 } },
      h(
        'div',
        { className: 'dsht-row', style: { justifyContent: 'space-between' } },
        h('span', { className: 'dsht-card-label' }, t('page.filter.models')),
        h(
          'div',
          { className: 'dsht-row' },
          h('button', { type: 'button', className: 'dsht-btn dsht-btn-ghost', onClick: selectAllModels }, t('page.models.all')),
          h('button', { type: 'button', className: 'dsht-btn dsht-btn-ghost', onClick: clearModels }, t('page.models.clear'))
        )
      ),
      allModelKeys.length && !checkedModelKeys.length
        ? h('div', { className: 'dsht-hint', style: { padding: '0 4px' } }, t('page.models.noneHint'))
        : null,
      allModelKeys.length
        ? checksRows
        : h('div', { className: 'dsht-muted', style: { padding: '6px 4px' } }, t('page.models.none'))
    )
  );

  var ChartComponent = typeof DshTokenChart === 'function' ? DshTokenChart : null;
  var chartBody;
  if (statsState.error) {
    chartBody = h('div', { style: { padding: '8px 0' } },
      h('div', { className: 'dsht-hint', style: { marginBottom: 6 } }, t('page.error.stats')),
      h(DshErrorBox, { error: statsState.error, onRetry: statsState.reload, retryLabel: t('common.retry') })
    );
  } else if (!ChartComponent) {
    chartBody = h(DshEmpty, { title: t('page.chart.missing'), icon: 'chart' });
  } else {
    chartBody = h(ChartComponent, {
      t: t,
      buckets: statsValue && Array.isArray(statsValue.buckets) ? statsValue.buckets : [],
      dims: statsDims,
      metric: metric,
      bucket: bucketEffective,
      offsetMs: offsetMs,
      currency: statsCurrency,
      activeDims: sessionMode ? null : activeKeys,
      onToggleDim: toggleDim,
      onPickBucket: pickBucket,
      onSelectRange: selectRange,
      sessionMode: sessionMode,
      sessionRows: chartSessionRows,
      sessionLoading: chartSessionLoading,
      sessionError: chartSessionError,
      onRequestBucketSessions: requestBucketSessions,
      onOpenSession: openSessionFromChart,
      height: 260,
      loading: !!statsState.loading,
      emptyTitle: t('page.chart.empty')
    });
  }

  var breadcrumbElement = null;
  if (drill.length) {
    var crumbs = [];
    var baseLabel = preset === 'custom'
      ? DshTokenPageRangeText(presetRange.from, presetRange.to, offsetMs)
      : t('page.preset.' + preset);
    crumbs.push(h('span', { key: 'base', className: 'dsht-crumb-item', title: baseLabel }, baseLabel));
    for (var crumbIndex = 0; crumbIndex < drill.length; crumbIndex++) {
      crumbs.push(h('span', { key: 'sep-' + crumbIndex, className: 'dsht-crumb-sep' }, '›'));
      crumbs.push(
        h('span', { key: 'crumb-' + crumbIndex, className: 'dsht-crumb-item' }, String(drill[crumbIndex].label || ''))
      );
    }
    breadcrumbElement = h(
      'div',
      { className: 'dsht-row', style: { gap: 6 } },
      h(
        'button',
        { type: 'button', className: 'dsht-btn dsht-btn-ghost', onClick: popDrill, title: t('page.drill.back') },
        h(DshIcon, { name: 'chevron-left', size: 13 }),
        h('span', null, t('page.drill.back'))
      ),
      h('div', { className: 'dsht-crumb' }, crumbs)
    );
  }

  var chartPanel = h(
    'div',
    { className: 'dsht-panel' },
    h(
      'div',
      { className: 'dsht-panel-head' },
      h('span', { className: 'dsht-panel-title' }, t('page.chart.title')),
      h('span', { className: 'dsht-muted dsht-mono' }, t('page.range') + ' ' + rangeText),
      h('span', { className: 'dsht-grow' }),
      breadcrumbElement
    ),
    sessionMode
      ? h('div', { className: 'dsht-hint', style: { marginBottom: 8 } }, t('page.session.hint'))
      : statsDims.length
        ? h(DshTokenPageLegend, {
            dims: statsDims,
            activeSet: activeSet,
            values: dimValues,
            metric: metric,
            currency: statsCurrency,
            onToggle: toggleDim,
            t: t
          })
        : null,
    chartBody,
    h('div', { className: 'dsht-hint', style: { marginTop: 6 } }, t('page.chart.hint'))
  );

  var detailsPanel = h(DshTokenPageDetailsPanel, {
    t: t,
    rows: detailRows,
    topTotals: totalsPart,
    bucket: bucketEffective,
    offsetMs: offsetMs,
    currency: statsCurrency,
    flash: flashPair[0],
    loading: !!statsState.loading,
    error: statsState.error,
    onRetry: statsState.reload,
    onExport: exportCsv,
    onCopy: copyTsv
  });

  var rankLoading = !!rankState.loading;
  var rankSessionsPanel = h(DshTokenPageRankPanel, {
    t: t,
    title: t('page.rank.sessions'),
    openLabel: t('page.rank.openTitle'),
    errorTitle: t('page.error.rank'),
    rows: sessionRankRows,
    loading: rankLoading,
    error: rankState.error,
    onRetry: rankState.reload
  });
  var rankModelsPanel = h(DshTokenPageRankPanel, {
    t: t,
    title: t('page.rank.models'),
    openLabel: t('page.rank.openTitle'),
    errorTitle: t('page.error.rank'),
    rows: modelRankRows,
    loading: rankLoading,
    error: rankState.error,
    onRetry: rankState.reload
  });

  var settingsModels = metaModels.map(function (entry) {
    return entry && typeof entry === 'object' ? entry : null;
  }).filter(function (entry) {
    return !!entry && entry.key !== null && entry.key !== undefined && String(entry.key);
  });

  var settingsDialog = h(DshTokenPageSettingsDialog, {
    open: !!settingsOpenPair[0],
    t: t,
    draft: draftPair[0],
    models: settingsModels,
    currency: currency,
    saving: !!settingsBusyPair[0],
    error: settingsErrorPair[0],
    metaError: !draftPair[0] && metaState.error ? metaState.error : null,
    hasDefaults: !!(metaState.data && metaState.data.defaults),
    jsonText: jsonTextPair[0],
    onClose: closeSettings,
    onSave: saveSettings,
    onRestore: restoreDefaults,
    onImport: importSettingsJson,
    onExport: exportSettingsJson,
    onJsonChange: function (text) {
      setJsonText(text);
    },
    onPriceChange: setPriceField,
    onBudgetChange: setBudgetValue,
    onPeakEnabled: setPeakEnabled,
    onPeakDay: togglePeakDay,
    onPeakWindow: setPeakWindow,
    onPeakHolidays: setPeakHolidays,
    onRetryMeta: metaState.reload
  });

  return h(
    'div',
    { className: 'dsht-page' },
    h(DshStyle, { id: 'dshtoken-page', css: DshTokenPageCss }),
    headerElement,
    flashElement,
    actionErrorPair[0]
      ? h(DshErrorBox, {
          error: actionErrorPair[0],
          onRetry: refreshAll,
          retryLabel: t('common.retry')
        })
      : null,
    metaState.error && !metaValue
      ? h('div', null,
          h('div', { className: 'dsht-hint', style: { marginBottom: 6 } }, t('page.error.meta')),
          h(DshErrorBox, { error: metaState.error, onRetry: metaState.reload, retryLabel: t('common.retry') })
        )
      : null,
    runningHint,
    partialHint,
    cardsElement,
    unpricedElement,
    filterElement,
    modelPopoverElement,
    chartPanel,
    detailsPanel,
    h('div', { className: 'dsht-cols2' }, rankSessionsPanel, rankModelsPanel),
    settingsDialog
  );
}
