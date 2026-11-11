# @local/dshtoken — DSH Token 统计

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

一个独立的 DSH Web 插件：把会话日志里 provider 上报的 token 用量聚合成**独立统计页**，
支持日期范围柱状图、单柱时间跨度调节、按类别 / APIKey（provider 路由）/ 模型 / 会话拆分、
token 与 CNY 估算花费切换、模型筛选，并在对话底部的用量控件里提供跳转入口。

- 纯本地：只读会话日志 + 本机 JSON 配置，不联网、不上报。
- 不动官方组件：统计页是独立页面；底部用量控件按官方文档允许的方式（同 id + 同 order +
  更低 priority）替换，读数与官方一致并增加跳转按钮。
- 主题/语言跟随宿主（light/dark + 中文/English）。

## 功能

**统计页**（左侧栏 Token 统计图标进入）
- 日期范围：今天 / 昨天 / 近 7 天 / 近 30 天 / 本月 / 上月 / 自定义；图上可拖选一段区间。
- 单柱跨度：自动 / 1 小时 / 1 天 / 1 周 / 1 月。
- 拆分维度：类别（缓存命中 / 未命中输入 / 缓存写入 / 输出）、APIKey（provider 路由）、
  模型、会话；点柱子可下钻到该时间桶，面包屑返回。
- 「按会话」模式：柱高为该时间桶的总消耗（单色），**悬停柱子弹出会话列表**——按消耗量
  从高到低排序、默认折叠、点「展开全部」可滚轮滚动查看全部；**单击会话行展开明细、
  双击直接跳转到该会话**。图例会隐藏并显示操作提示。
- 指标：Tokens 数 / CNY 估算花费。
- 模型筛选：多选勾选，只统计勾选的模型（对所有视图生效）。
- 汇总卡片：总 token、估算花费、缓存命中率、日均 token、峰值时间桶；未定价模型会提示
  费用口径不完整。
- 月度预算：设置里填「月度预算（CNY）」，页面出现预算卡片（本月已用 / 剩余 / 进度条），
  ≥80% 显示警告色、≥100% 显示「已超出预算」。
- 官方账户余额：已登录 DeepSeek 官方账号时，标题栏显示「账户余额 + 赠送余额」；
  未登录/不可用时静默隐藏（与本地估算费用相互独立）。
- 明细表（每个时间桶一行）+ CSV 导出 / 复制；Top 会话（点击跳到会话）与 Top 模型排行。
- 自动刷新（仅页面可见时）、索引进度条、重建索引、记住上次筛选。
- 模型可用工具：`token_stats`（可以直接问「这周花了多少 token / 多少钱」）。

**对话底部用量控件**
- 显示当前会话 token 总量 · 缓存命中率（与官方读数口径一致）。
- 展开后的统计弹窗：分类明细（token + 费用）、请求数、首末时间、今日/累计，以及
  「打开 Token 统计 →」跳转按钮。

**价格与口径设置**（统计页右上角齿轮）
- 每个模型的单价（元 / 百万 token）：缓存命中 / 未命中输入 / 缓存写入 / 输出，以及峰时倍数。
- 峰谷时段：默认工作日 09:00–12:00、14:00–18:00（北京时间）为高峰，其余（含周末/节假日）为空闲；
  可改时段、工作日与节假日。
- 恢复默认、导入/导出价格 JSON。

## 数据来源与口径

- token 用量来自会话日志中 `assistant/message` 携带的 provider usage：
  `inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens / reasoningTokens`。
  本 DSH 构建里 `inputTokens` 是**未命中缓存的输入**（已剔除缓存命中/写入部分），因此
  「未命中输入 = inputTokens」，总量 = 未命中 + 缓存命中 + 缓存写入 + 输出（与 provider
  `totalTokens` 一致）。
- 只统计会话自身事件（fork 子会话不重复统计继承的历史）；可按会话拆分查看子代理：
  勾选「子代理单独列出」时子代理会话单独成行，取消勾选时子代理消耗**合并到所属主会话**，
  合计（总量/费用/请求数）保持不变，只是不再单列。
- 「APIKey」等于 provider 路由（每个 provider 配置一把 `apiKeyEnv`）。
- **花费是估算不是账单**：日志里没有账单金额，费用 = 用量 × 可编辑价格表。默认只给
  DeepSeek 官方模型（`deepseek-official/*`）内置官方价，其它网关/第三方模型默认**不计算费用**，
  只统计 token，并在页面里提示未定价；在设置里填好单价即可计入。
- 首次打开页面会在后台扫描历史会话（本机约 311 个会话、数百 MB 压缩日志），约 1–2 分钟，
  显示进度；索引缓存到 `$DSH_HOME/plugin-data/dshtoken/index.json.gz`（按会话文件大小增量
  校验），之后每次启动/热加载只需 ~1 秒，只重读有变化的会话。

## 安装

仓库：[github.com/rinttt233/dshtoken](https://github.com/rinttt233/dshtoken)（MIT）。

```bash
git clone https://github.com/rinttt233/dshtoken.git
```

然后在 DSH 里把 clone 出来的目录作为本地 bundle 装入当前 profile（desktop）：

```text
plugin_manager  install_bundle  target = <你的 clone 路径>/dshtoken
```

例如 Windows 上 clone 到 `D:\dshtoken` 后，target 就是 `D:\dshtoken`。
安装是 **link** 方式（不是复制），所以之后 `git pull` 更新源码即可；覆盖已安装版本后
Host 侧需要重启 DSH、Client 侧刷新页面。

Host 侧改动需要重启 DSH；Client 侧改动只需刷新页面。安装后左侧栏出现「Token 统计」图标，
对话底部出现 token 用量控件。

## 卸载

```text
plugin_manager  remove_bundle  target = @local/dshtoken
```

可选：删除 `$DSH_HOME/plugin-data/dshtoken/`（索引缓存与价格配置）。

## 开发

```text
node scripts/build-client.mjs           # src/client/*.js → dist/client.js（单文件、无依赖）
node scripts/check-fragment.mjs <file>  # 单片段语法检查
node scripts/host-selftest.mjs          # Host 纯函数自测（54 项）
node scripts/verify-api.mjs <origin>    # Host HTTP 端到端冒烟测试
```

`verify-api.mjs` 的 origin 是 DSH Web GUI 地址（端口每次重启会变，可在 DSH 运行时上下文里看到），
也可以写进环境变量：`DSH_TOKEN_API_ORIGIN=http://127.0.0.1:<port> node scripts/verify-api.mjs`。

`dist/client.js` 是构建产物，仓库里保留它以便直接安装；改 `src/client/*.js` 后必须重新
`node scripts/build-client.mjs` 再刷新页面。

结构：

```text
index.js               Host 薄壳：注册 /dshtoken/api，按 lib 文件 mtime 动态重载业务逻辑
lib/                   Host：store(磁盘/配置) cost(价格/峰谷) scan(索引) aggregate(聚合) http(接口)
src/client/shared.js   共享运行时（i18n / API / 格式化 / hooks / 基础 UI / 主题 CSS）
src/client/chart.js    SVG 堆叠柱状图
src/client/page.js     统计页
src/client/dock.js     底部用量控件（替换官方 usage）
src/client/main.js     入口：语言、样式、slot 注册
scripts/build-client.mjs  把 5 个片段拼成一个 __ModuleLoader__ bundle
```

`CONTRACT.md` 是 Host API、数据模型与各片段接口的完整契约。
