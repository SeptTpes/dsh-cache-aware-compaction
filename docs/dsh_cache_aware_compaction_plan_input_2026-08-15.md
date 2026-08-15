# dsh Cache-Aware Compaction 插件 — Plan 输入文档

> 生成日期：2026-08-15（DeepSeek 涨价前 2 天）
> 用途：作为 dsh 上第一个项目（plan=pro / build=flash）的 plan 阶段输入。
> 性质：本机 dsh 0.1.0-rc.6 源码侦察情报 + 设计方向 + 待确认风险清单。
> 接手方：dsh agent（新会话，无此前对话上下文，本文档自包含）

---

## 0. 任务一句话

为 dsh（DeepSeek Harness）写一个「缓存感知的压缩插件」：压缩前判定当前前缀缓存冷热——缓存热时维持 dsh 默认的前缀重放压缩（命中缓存、几乎免费），缓存冷时改用转录式压缩（避免重放大段前缀却全 miss 的白付），从而在 DeepSeek 涨价后最大化压缩成本效率。

## 1. 背景与动机（为什么做）

- DeepSeek API 2026-08-17 00:00（北京时间）起涨价并引入峰谷定价（高峰=工作日 9-12、14-18 点，空闲=高峰一半价）：
  - v4-flash：miss 输入 3.00（高峰）/1.50（空闲），hit 输入 0.10/0.05，输出 9.00/4.50（元/百万 token）
  - v4-pro：miss 输入 9.00/4.50，hit 输入 0.30/0.15，输出 27.00/13.50
- 压缩成本一般化公式（U=压缩时已用、R=保留比例、S=摘要输出）：
  - dsh 热压：C = U(1−R)·P_hit + S·P_out + (UR+S)·P_miss（压缩调用走 hit，几乎免费）
  - dsh 冷压：C = U(1−R)·P_miss + S·P_out + (UR+S)·P_miss（压缩调用全 miss，贵）
  - 例（100万窗口/已用80万/摘要8万/flash高峰）：热压 ≈1.50 元，冷压 ≈3.36 元，差 1.86 元/次
- 结论：**冷热是压缩成本的最大变量**，dsh 默认实现对此无感知（冷时也前缀重放 = 白付）。

## 2. 已确认情报（源码侦察结果，可直接信任）

### 2.1 dsh 安装与本机源码位置
- 版本：@deepseek-ai/dsh 0.1.0-rc.6（bin: `~/.local/bin/dsh` → `../lib/node_modules/@deepseek-ai/dsh/lib/bin.js`）
- 子包源码：本机安装的 dsh 0.1.0-rc.6（npm 公开包）
- 关键包：
  - `dsh-compaction-basic/` —— 压缩引擎本体（主攻对象）
  - `dsh-command-compact/` —— `/compact` 手动命令
  - `dsh-token-meter/` —— token 计量与 usage 投影
  - `dsh-session/` —— 会话事件日志（append-only）
  - `dsh-client-ui-conversation/` —— 对话 UI 的 StatsLine（显示「缓存命中 %」）
  - `dsh-cordis-host-runner/` —— cordis 宿主

### 2.2 dsh 压缩机制（已读源码确认）
- 触发：上下文达窗口 80%（`DEFAULT_THRESHOLD_RATIO = .8`，`dsh-compaction-basic/lib/index.js:13`）；另有过载恢复触发（context-overflow）
- 保留尾部：`DEFAULT_RETAIN_RATIO = .16`（窗口 16% 原文保留不压，index.js:15）
- 压缩调用构造（`buildSummarizationInput`，index.js:648）：`system + tools + 被压缩区间原始消息 + COMPACTION_INSTRUCTION(最后一条 user)` —— 与被压缩前最后一次请求前缀逐字一致 → 命中热缓存（注释明言 "genuine prefix of the last routed request, so the provider's KV cache is reused"）
- 压缩指令：`COMPACTION_INSTRUCTION`（index.js:217），强制 8 段式结构化 checkpoint（Primary Request / Key Technical Concepts / Files and Code / Errors and Fixes / Pending Jobs / Current Work / Next Step / Critical Context）
- 落地：`<compacted-summary>` 摘要消息 **替换**（surfaceOp: op:"replace"）被压缩区间；校验摘要必须小于被压缩内容
- 压缩后首条消息：前缀在 checkpoint 处断裂 → 全 miss（成本 = UR+S）

### 2.3 可替换的钩子点（插件方案的地基）
- `BasicCompactionEngine`（dsh-compaction-basic/lib/index.js:962 export default）
- `regionDependencies()`（index.js:953-959）把 `summarize` 注入压缩事务：
  ```js
  summarize: (input, owner, abort) => this.summarize(input, owner, abort)
  ```
- `summarize()`（index.js:840-844）→ `summarizeWithLlm()`（index.js:267）——**压缩调用的完整构造与执行都在这里**，替换 summarize 即可改变"怎么压"
- `summarizeCompaction()`（index.js:549）通过 `dependencies.summarize` 动态分发
- 插件配置：`BasicCompactionConfig` 已支持 `thresholdRatio` / `retainRatio` / `summarizationProvider` / `summarizationModel` / `modelPolicies`（index.js:16-41）——**压缩调用可用独立模型**（如主对话 pro、压缩用 flash，输出 27→9 元）

### 2.4 会话事件结构（冷热判定的潜在信号源）
- `assistant/message` 事件携带 `usage`（`input/cacheRead/cacheWrite/output/reasoning`），见 dsh-token-meter/lib/types/usage-projection.js
- `request/header` 事件记录 system/tools/config（dsh-agent-loop/lib/index.js:702-718，header 变更时追加 "change" 事件）
- `request/context` 事件记录 provider/model/contextWindow 变更（dsh-agent-loop/lib/index.js:720-726）——**模型切换是显式事件**（DeepSeek 缓存按模型隔离，切换模型 = 缓存全失效，本点按模型服务架构推断，待实证）
- token-meter 的 projection 有 `totals`（会话级累计）与 `last`（最近一次）——UI StatsLine 用 totals 显示会话级命中率

### 2.5 参考：转录式压缩（冷缓存时的备选方案）
- 思路来源：开源项目 opencode（Apache-2.0）的压缩实现
- 关键差异：压缩请求 = 专用摘要 system prompt + 折叠区间**转录文本**（renderTranscript，`[user]/[assistant]/[tool result]` 扁平化，compact.go:624）——与主对话前缀不同构 → 不命中缓存（冷热皆 miss）
- reasonix 参数（可借鉴）：触发 0.85 窗口、尾部 clamp(10%, 32K, 96K)、pinned system+首条 user(≤1500 tok)、摘要上限 16K、foldEconomics 最小 400 tok 才值得压
- 启示：**热时用 dsh 式前缀重放、冷时用转录式压缩** = 双模式压缩

## 3. 待侦察/未确认（plan 阶段必须解决，按优先级）

1. **[最大风险] 插件注册与覆盖机制**：cordis 插件如何声明、如何启用（dsh 配置）、如何替换/覆盖 `BasicCompactionEngine`（或在其外层注入自己的 summarize）。侦察路径：dsh-cordis-host-runner、dsh 的 config 目录、README.zh.md 的插件章节；参考同生态插件（dsh-compaction-tool-result-pruner 是现成先例，看它怎么挂）。
2. **冷热信号获取**：插件内能否订阅 session 事件流、在压缩事务前拿到最近一次 usage（cacheRead）；时序是否可行（压缩在 step 边界，最近 usage 应可读）。侦察路径：dsh-session 的事件订阅 API、token-meter 的 projection 读取方式。
3. **验证闭环**：dsh-headless 的用法（脚本化跑会话）；如何对比「带/不带插件」同场景压缩成本。侦察路径：dsh-headless 包、README。
4. 缓存按模型隔离的实证：在 dsh 里切换一次模型，看 StatsLine 命中率是否归零。

## 4. 设计方向（MVP v0.1）

**目标**：压缩触发时自动选择压缩模式，最小改动、可验证。

- **冷热判定规则（v0.1 简化版）**：读最近一次调用的 usage —— `cacheRead ≈ 0 且输入较大` → 冷；`cacheRead > 0` → 热。冷时再按 idle 时长兜底（dsh 无此数据则跳过）。
- **决策**：
  - 热 → 维持 dsh 默认（前缀重放，命中缓存）
  - 冷 → 转录式压缩（复用 reasonix renderTranscript 思路：专用摘要提示 + 扁平化转录；注意转录内容要含被压缩区间的完整信息）+ 或直接拒绝压缩并提示用户（更保守，v0.1 可选）
- **不做（v0.2+）**：峰谷调度、动态摘要大小、retainRatio 动态调整、模型隔离下的 pro/flash 混用策略
- **零代码杠杆（先于插件启用）**：`summarizationModel` 配置压缩专用模型；`thresholdRatio`/`retainRatio` 调参

## 5. 里程碑

- M1：插件注册 + 钩子触发跑通（最小环：写一个只打日志的插件，确认 dsh 加载并能在压缩前执行）
- M2：冷热判定逻辑（读最近 usage → 判定 → 决策）
- M3：headless 对比验证（同场景带/不带插件，记录压缩成本差异，输出数据）

## 6. 工作流约定（本项目的运行方式）

- plan 阶段：pro 会话（上下文保持小：架构讨论+设计文档；pro 单价高，别让工具结果堆进去）
- build 阶段：flash 会话（实现+测试；压缩按 flash 价）
- 桥接：设计文档落盘，build 会话 read 文件
- 压缩纪律（对两个会话都适用）：缓存热时压缩（当天会话内）、优先 18:00 后（空闲价）、摘要宁小勿大、少压
- 本项目完成后，产出两份资产：插件 + 跑通的 plan/build 工作流模板

## 7. 后续提问参考（dsh 接手后建议先回答）

1. 插件注册机制：cordis 插件最小清单？如何覆盖 BasicCompactionEngine？
2. 冷热信号：压缩事务前能否拿到最近 usage？时序？
3. headless：如何脚本化跑一个带压缩的会话？
4. 配置：dsh 的插件配置写在哪个文件？schema 长什么样？

---

*附：转录式压缩思路参考开源项目 opencode（Apache-2.0）；本插件实现为独立原创 JS。*
