# dsh Cache-Aware Compaction 插件 v0.1 — 实施计划（build 会话输入）

> 生成：2026-08-15，plan 阶段产出（pro 会话）
> 依赖文档（build 会话先 read 再动手）：
> - `dsh_cache_aware_compaction_plan_input_2026-08-15.md`（背景/动机/成本公式）
> - `dsh_cache_aware_compaction_recon.md`（源码侦察笔记，含行号证据）
> 本计划是决策完备的：build 会话（flash）只实现、不做设计决策；偏离本计划处必须记录原因。

---

## 0. 已拍板决策（不可再议，除非发现问题并回贴原因）

| # | 决策 | 拍板方 |
|---|---|---|
| D1 | 冷压行为 = 配置开关 `coldMode: transcribe \| refuse`，默认 `transcribe`（转录式自动压缩） | 用户 2026-08-15 |
| D2 | 冷热状态按 `(provider, model)` 隔离记忆 | 用户 2026-08-15 |
| D3 | 覆盖方式 = 子类化 `BasicCompactionEngine`，在 agent preset 中替换 `compaction-basic` 行（不并存） | 源码确证 + 侦察笔记 §1.3 |
| D4 | v0.1 不做峰谷调度、动态摘要大小、retainRatio 动态调整、pro/flash 混用策略 | 输入文档 §4 |
| D5 | plan/build 双会话分工、设计文档落盘桥接、压缩纪律 | 输入文档 §6 |

## 1. 目标与成功标准

**目标**：压缩触发时自动选择压缩模式——前缀缓存热时维持 dsh 默认前缀重放压缩（命中缓存）；冷时改用转录式压缩（专用摘要提示 + 扁平化转录，不重放全 miss 的前缀）。

**成功标准（全部量化可验收）**：
1. 热场景：带插件行为与不带插件**逐字节等价**（走同一前缀重放调用，成本相同）。
2. 冷场景（强制或实测）：压缩调用输入从重放 `U(1−R)` 降为转录文本 `T`，且 `T < U(1−R)`（M3 用 usage 事件实测比值）。
3. 冷场景摘要质量不劣化：输出仍是 8 段 checkpoint，替换消息校验通过（摘要 < 被压区间），会话可正常续跑（M3 headless 续跑任务验证）。
4. `refuse` 模式下冷压被跳过（有日志、无压缩事务），且 context-overflow 时不拒绝（见 §7）。
5. `/compact` 手动命令、overflow 恢复、tool-result pruner 均与新引擎兼容（M1/M3 验证）。
6. 模型切换后冷热判定归零重判（M3 实证，见 §10.3）。

## 2. 架构总览

```
agent/pre-step (下一步)
  └─ CacheAwareCompactionEngine.compactIfNeeded(agent, trigger, signal)   [覆盖]
       ├─ refuse 决策（仅 pressure 触发时可能提前 return null）
       └─ super.compactIfNeeded(...)  →  阈值/保留/剪枝/区间选择 = 全部基类逻辑不变
             └─ compactSurfaceRegion → regionDependencies().summarize = this.summarize  [覆盖]
                  ├─ decide(agent) === hot  → super.summarize(...)      （dsh 默认前缀重放）
                  └─ decide(agent) === cold → transcribeSummarize(...)  （转录式，本插件新增）
                       └─ ctx.llm.stream({system: 转录专用提示, messages: [转录+指令], purpose: "compaction"})
                          → 返回与基类 summarizeWithLlm 相同信封 → 替换事务零改动
```

要点：
- **只覆盖两个方法**：`compactIfNeeded`（策略入口）与 `summarize`（模式分派）。范围选择、事务、落盘、稳定性校验、摘要大小校验全部复用基类。
- 服务名仍是 `"compaction"`（基类 `dsh-compaction/lib/index.js:179`），`/compact`（inject `"compaction"`）与 overflow 恢复自动走新引擎。
- 热路径调用 `super.summarize` → 与不带插件完全一致（成功标准 1）。

## 3. 包设计

### 3.1 包信息

- 名称：`@septtpes/dsh-compaction-cache-aware`，version `0.1.0`，**本地包不发布 npm**
- `package.json`：`"type": "module"`、`"main": "lib/index.js"`、`"types": "lib/types/index.d.ts"`
- peerDependencies（照抄 result-pruner 先例，`dsh-compaction-tool-result-pruner/package.json`）：
  `@deepseek-ai/cordis ^4.0.1`、`@deepseek-ai/schemastery ^3.18.1`(dependencies)、
  `@deepseek-ai/dsh-compaction ^0.1.0-rc.6`、`@deepseek-ai/dsh-compaction-basic ^0.1.0-rc.6`、
  `@deepseek-ai/dsh-llm ^0.1.0-rc.6`
- 测试：`node:test`（`node --test`），纯逻辑单测不需要启动 dsh

### 3.2 文件清单（全部新建）

```
dsh-compaction-cache-aware/
├── package.json
├── lib/
│   ├── index.js          # CacheAwareCompactionEngine（Service 子类 + 导出）
│   ├── config.js         # Config schema、own/base key 剥离、own 配置解析
│   ├── decision.js       # 纯函数：冷热判定（可单测）
│   ├── transcript.js     # 纯函数：消息 → 扁平化转录文本（可单测）
│   └── types/index.d.ts  # 公开类型
└── test/
    ├── config.test.js    # schema 校验、key 剥离、默认值
    ├── decision.test.js  # 判定规则全分支（含 cachePolicy 覆盖）
    └── transcript.test.js# 各 block 类型渲染、图片占位、空消息
```

### 3.3 类骨架

```js
// lib/index.js
export class CacheAwareCompactionEngine extends BasicCompactionEngine {
  // inject 继承基类: ["llm", "tokenMeter", "sessions"]
  // Config 重新声明（见 §3.4）
  constructor(ctx, config = {}) {
    const { base, own } = splitConfig(config);   // config.js
    super(ctx, base);                            // 基类解析/校验全部 base key，注册 auto 触发
    this.own = resolveOwnConfig(own);
  }
  compactIfNeeded(agent, trigger, signal) { /* §7 */ }
  async summarize(input, agent, signal) { /* §5/§6 分派 */ }
  async transcribeSummarize(input, agent, signal) { /* §6 */ }
  decide(agent) { /* §4，调 decision.js */ }
}
```

**关键机制（config.js `splitConfig`）**：基类 `resolveConfig` 会严格拒绝未知 key（`validateKeys`，`dsh-compaction-basic/lib/index.js:57,183-184`），所以**先把自有 key（`coldMode`/`cachePolicy`）剥离，其余传给 `super(ctx, rest)`**。基类构造器签名 `constructor(ctx, config = {})`（index.js:765-769），内部完成 `this.config = resolveConfig(config)` 与 `auto` 触发注册。

### 3.4 Config schema（`lib/config.js`）

`schemastery` `z.object`，字段 = **base 全部 key（类型逐字照抄 `dsh-compaction-basic/lib/index.js:714-759`）+ 自有 key**：

base key（照抄，含 `modelPolicies` 数组结构 `provider/model + 7 个策略键`）：
`thresholdRatio, retainRatio, retainTokens, summarizationProvider, summarizationModel, maxTokens, compactionRetries, maxOverflowRetries, modelPolicies, auto`

自有 key：

```js
coldMode:    z.union([z.const("transcribe"), z.const("refuse")]).default("transcribe")
cachePolicy: z.union([z.const("auto"), z.const("hot"), z.const("cold")]).default("auto")
```

`cachePolicy` 语义：**实验/测试覆盖**（M3 A/B 依赖它）。`auto` = 按 §4 规则；`hot`/`cold` = 强制走对应路径（`coldMode` 仍生效：`cachePolicy: cold + coldMode: refuse` → 拒绝）。

### 3.5 可观测性

- 每次决策一条日志（`this.ctx.logger.info`）：
  `cache-aware compaction: route={provider}/{model} trigger={trigger} decision={hot|cold} coldMode={...} cachePolicy={...} lastUsage={cacheRead,cacheWrite,uncachedInput}`
- `refuse` 跳过时 `ctx.logger.warn`，附原因与「会话将继续增长」提示。
- v0.1 不写 session 自定义事件（附录 C 列为 v0.2 候选）。

## 4. 冷热判定规范（`lib/decision.js`，纯函数）

```
输入: agent, cachePolicy, now?（v0.1 不用 now）
输出: { decision: "hot" | "cold", key: {provider, model} | null, sample: usageBucket | null, reason }
```

1. `cachePolicy !== "auto"` → 直接返回对应 decision（reason = "policy-override"）。
2. 路由 key = `agent.session.requestHeader()?.config` 的 `{provider, model}`；无则回退 `agent.options.{provider, model}`；仍无 → `decision: "hot"`（reason = "no-route"；基类 summarize 届时会抛自己的 no-target 错误）。
3. 从 `agent.session.events` **倒序**扫描，取第一条满足「`event.type === "assistant/message"` 且 `event.data.message.source.provider/model === key`」的事件（usage 归因：assistant 消息的 `message.source` 携带 provider/model，`dsh-agent-loop/lib/index.js:642-648`）。
4. 判定：`sample.usage` 的 `cacheReadTokens > 0 || cacheWriteTokens > 0` → `hot`；两者皆 0 → `cold`；**没有样本**（该模型还没出过回复）→ `hot`（reason = "no-sample"；会话尚小，保守走默认）。
5. 时序依据：压缩在下一步 `agent/pre-step` 触发，上一步 `assistant/message` 已落盘（侦察笔记 §2.2）。**无状态推导、跨重启安全**（每次从 session log 现算，不存内存状态）。

理由注释（写进代码注释）：`cacheWrite > 0` 也判热——首次请求写入了前缀缓存，紧接的重放调用会命中；若只看 `cacheRead > 0` 会把「写入后必然命中」误判为冷。

## 5. 热路径

`summarize()` 内 `decide() === "hot"` → `return super.summarize(input, agent, signal)`。**零改动**，与不带插件逐字节等价。`cachePolicy: "hot"` 强制此路径（实验对照用）。

## 6. 冷路径：转录式压缩（`lib/transcript.js` + `transcribeSummarize`）

### 6.1 输入转换

`summarize` 的 `input` 已是基类 `buildSummarizationInput` 的产物：`{system?, tools?, messages: [被压区间消息…]}`（消息由 `deriveEventMessage` 投影：user/message、assistant/message、tool/result 三类，`dsh-session/lib/index.js:278-287`）。

`renderTranscript(messages)` 输出单段文本：

```
[user] <text>
[assistant] <text>
[assistant → tool call: name(argsJson)]
[tool result] <text>
```

block 渲染表（`lib/transcript.js` 实现 + 单测）：

| block.type | 渲染 |
|---|---|
| `text` | 原文（trim 保留） |
| `tool-call` | `[tool call: {name}({JSON.stringify(arguments)})]` |
| `tool-result` | `[tool result] {text}`（其 content 是 blocks，递归渲染；`contentHasImage` → 追加 `[image omitted]`） |
| `image` / 未知 | `[image omitted]` / `[block: {type}]`（绝不 throw，宁可信息降级） |

消息无内容或空 → 跳过。转录文本上限保护：若转录文本估算 token > `input` 重放估算 token（用 `this.ctx.tokenMeter.estimateMessage` 或保守 `chars/3`），**放弃转录、退回 `super.summarize`** 并 warn（此时转录不划算——防摘要区内容极少而工具输出巨大的退化场景；M3 实测若永不触发可加单元级断言覆盖）。

### 6.2 压缩调用

```
target 解析 = 复刻 summarizeWithLlm 优先级（dsh-compaction-basic/lib/index.js:268-278）:
  configured(summarizationProvider/Model 非空) > 最近 requestHeader().config > agent.options > 抛错
policy 解析 = 复刻 resolveTargetPolicy（index.js:83-99，~15 行）:
  取 modelPolicies 精确匹配 override，maxTokens/summarization* 逐项回退 this.config 顶层值
调用 = ctx.llm.stream({
  provider: target.provider, model: target.model,
  system: TRANSCRIPT_SYSTEM_PROMPT,          // 专用摘要提示（见 6.3）
  messages: [createUserMessage(转录文本 + "\n\n" + CHECKPOINT_INSTRUCTION)],
  maxTokens: policy.maxTokens,
  sessionId: agent.session.id,
  purpose: "compaction",
  ...(signal && {signal})
})
```

- **不带** 会话 system/tools —— 与主对话前缀不同构，注定 miss，这正是冷路径要的（省重放钱）。
- 输出收集与基类一致：`BlockAssembler` 流式 push、`finishError` 终态校验、`summaryText` 只留 text block、空摘要抛错——**信封返回与 `summarizeWithLlm` 完全一致**（`{summary, rawOutput, llmStreamCall: true, provider, model, maxTokens, usage?}`，对齐 index.js:307-315），确保 `summarizeCompaction`/`commitCompactionBody` 零改动可用。

### 6.3 提示词（两条常量，写死在 lib/index.js 或独立文件）

- `TRANSCRIPT_SYSTEM_PROMPT`：说明「你是 AI 编码助手的压缩引擎；输入是对话的扁平化转录（含工具调用与结果），把它浓缩成结构化 checkpoint 供另一模型续跑」。
- `CHECKPOINT_INSTRUCTION`：**8 段结构文本逐字复制** `COMPACTION_INSTRUCTION`（`dsh-compaction-basic/lib/index.js:218-253`，未导出 → 复制进本包，文件头注释标明来源行号与「dsh 升级时对照」），仅把开头一句从「the conversation ABOVE」微调为「the transcript ABOVE」；「If the conversation already contains a <compacted-summary> block」合并规则句保持不变（转录中也会带上旧 checkpoint 文本）。
- 输出仍必须是同样的 8 段 Markdown → `frameSummary`/替换消息/大小校验逻辑不变（成功标准 3）。

## 7. refuse 路径（`compactIfNeeded` 覆盖）

```js
async compactIfNeeded(agent, trigger, signal) {
  const decision = this.decide(agent);
  if (decision.decision === "cold"
      && this.own.coldMode === "refuse"
      && trigger === "pressure") {
    this.ctx.logger.warn(`cache-aware compaction: skipping cold compaction (coldMode=refuse); session will keep growing until overflow`);
    return null;                       // 跳过本步压缩，无事务、无日志事件副作用
  }
  return super.compactIfNeeded(agent, trigger, signal);   // 其余情形全走基类
}
```

- **overflow（`trigger === "context-overflow"`）永不拒绝**：拒绝会让请求永远卡在窗口溢出错误；此时无论冷热都走 `super`（cold 会落到转录式——「宁可转录也要求得进度」）。
- 基类 pre-step 处理器对 `null` 的处理就是「无事发生」（index.js:782-783），安全。
- refuse 语义（写给用户文档）：省下压缩调用成本，但上下文继续增长直到 overflow 强制压缩；是产品策略而非省钱策略。

## 8. 挂载与启用（M1 操作手册，build 会话按此执行并修正细节）

1. **安装本地包**到 web profile：`dsh plugin --profile web add file:<包目录绝对路径>` —— **已实测可行（2026-08-15，build 会话回写）**。要点：
   - 前置：`pnpm` 必须在 PATH 上（本机缺失，`npm install -g pnpm` 安装 v11 即可）；`dsh plugin` 把剩余参数原样转发给 profile 目录里的 pnpm（`dsh/lib/bin.js:96-99`、`plugin-*.js`）。
   - 路径用绝对路径最稳；相对 `file:./x` 会被锚定到调用时 cwd（`anchorPathSpec`，`plugin-*.js:90-94`）。
   - 安装形态 = 物理拷贝（`nodeLinker: hoisted` 从 pnpm store 硬链接），**不是 symlink**，因此包内对 `@deepseek-ai/*` 的裸导入沿 `~/.dsh/profiles/web/node_modules` 父目录回退到 flat fallback `~/.dsh/profiles/node_modules`（dsh 维护的闭包 symlink，含全部 in-box 依赖）解析成功——无需额外配置。
   - 预期告警（无害）：`declares no dsh.bundle — installed as a plain dependency`（本插件是 agent-preset 行插件，不是 profile bundle）；peerDependencies 告警同理可忽略。
   - 验证：`node --input-type=module -e "import('@septtpes/dsh-compaction-cache-aware')"` 在 profile 目录下可解析；`dsh plugin` 已实测 exit 0。
   - 若 pnpm 不在 PATH，报错 `dsh: pnpm not found on PATH — install pnpm to manage profile plugins`，此时无需改用 `pnpm --dir`（等价），装 pnpm 即可。
2. **用户预设**：新建 `~/.dsh/.agent-presets/cache-aware/agent.cordis.yml`（模板见附录 B）：复制 `config/agent-presets/code/agent.cordis.yml` 全文，**仅把 `compaction` group 里 `compaction-basic` 行替换为**：

   ```yaml
   - id: compaction-cache-aware
     name: '@septtpes/dsh-compaction-cache-aware'
   ```
   （`command-compact`、`tool-result-pruner` 行原样保留；isolate realm `compaction: true, toolResultPruner: true` 不动——新引擎同 realm，`ctx.get("toolResultPruner")` 继续可见。）
3. **选择预设**：`~/.dsh/settings.yaml` 增加：

   ```yaml
   agent-presets:
     default: cache-aware
   ```
   （机制：`dsh-agent-presets/lib/index.js:793-796,855-856` settings namespace `agent-presets` + schema `{default}`；默认值语义 = 用户层覆盖 host 配置的 `config.default`。）
4. **冒烟**：启动 dsh，看启动日志出现引擎构造；跑一个会压缩的会话，确认决策日志出现（`decision=hot` 为主）；`/compact` 手动压一次。
5. 若 M1 卡在任何一步：错误信息 + 修复结论回写本节（这是本计划唯一留给 build 会话自决的「怎么装」细节，包内代码无此自由度）。

**回滚**：删除 `agent-presets` 设置段（或把 default 改回原预设 id）即可回到原生 `compaction-basic`，无数据迁移。

## 9. 里程碑与验收标准

| 里程碑 | 内容 | 验收（全部可脚本/可观测） |
|---|---|---|
| M0 纯逻辑 | 包脚手架 + config/decision/transcript 三个纯模块 + node:test 单测 | `node --test` 全绿；decision 覆盖 §4 全分支；transcript 覆盖 §6.1 渲染表含图片/未知 block |
| M1 挂载 | §8 步骤 1-4 | dsh 启动日志见引擎；决策日志出现且热场景行为与原生一致；`/compact` 正常 |
| M2 冷路径 | 冷判定 + 转录调用 + refuse 路径 | `cachePolicy: "cold"` 下跑会话：决策日志 `decision=cold`、压缩调用走转录（日志/usage 佐证）、8 段 checkpoint 替换成功、会话续跑；`cachePolicy: cold + coldMode: refuse` 下 pressure 跳过、overflow 仍压 |
| M3 验证 | §10 三个实验 + 数据报告 | 输出成本对比表与结论落盘 `experiments/cache-aware-m3-report.md` |

## 10. M3 验证实验设计（build 会话执行，flash 价）

### 10.1 实验脚本规格

- 载体：`dsh --profile headless "任务文本"`（单任务、跑完退出、session 落盘 `~/.dsh/sessions/`）。
- 任务文本：**同一份**「多步编码任务」（推荐：让 agent 读一个本地 README 并回答多个渐进问题，天然触发多步；步骤数够触发 80% 压缩——先把窗口配小或任务做大，以实际触发为准，用 `compaction/start` 事件确认）。
- 数据采集：跑完后读该 session 的 jsonl 日志（`~/.dsh/sessions/`），提取：
  - 每个 `assistant/message` 的 `usage`（`uncachedInputTokens/cacheReadTokens/cacheWriteTokens/outputTokens`）
  - 每个 `compaction/summary` 的 `provider/model/usage/shadowedTokenCount`（`commitCompactionBody` 落盘这些字段，index.js:589-604）
- 对比配置（同任务文本，各跑一次）：
  1. **baseline**：原生（`agent-presets.default` 改回原值或删除，不带插件）
  2. **plugin-hot**：`cachePolicy: "hot"`（应 ≈ baseline）
  3. **plugin-cold**：`cachePolicy: "cold"`（强制转录）
  4. **plugin-auto**：`cachePolicy: "auto"`（真实验证判定器：新会话首压应为 hot——首请求 cacheWrite>0）
- 输出指标（每次 run）：压缩调用输入 token（= 重放 token 或转录 token）、摘要输出 token、hit/miss 构成；按输入文档 §1 价格表（flash/pro × 高峰/空闲）折算**压缩调用成本**与**总增量成本**（压缩调用 + 压缩后首请求 `(UR+S)·P_miss`），表格 + 结论。

### 10.2 成本公式（复述，供报表引用）

热压 `C_hot = U(1−R)·P_hit + S·P_out + (UR+S)·P_miss`
冷压(重放) `C_cold_replay = U(1−R)·P_miss + S·P_out + (UR+S)·P_miss`
冷压(转录) `C_cold_transcript = T·P_miss + S·P_out + (UR+S)·P_miss`
v0.1 目标：`T` 显著小于 `U(1−R)`（预计转录 ≤ 20-40%）。

### 10.3 缓存按模型隔离实证（输入文档 §3.4）

headless 会话：请求 A（model X，写缓存）→ 同前缀请求 B（model X，应 `cacheReadTokens > 0`）→ 切 model Y 同前缀请求（观察 `cacheReadTokens` 是否归零 / `cacheWriteTokens` 是否重写）。结果记入 M3 报告：**若隔离不成立（Y 命中 X 的缓存），D2 判定粒度需重审**（回贴到本计划 §0 的决策表）。

### 10.4 质量验收

`plugin-cold` 跑完后**续跑一条任务**（同 session 追加消息），断言：agent 能基于 checkpoint 继续（输出含上一任务的关键事实，如文件路径/变量名）→ 成功标准 3。

## 11. 边界情况与失败模式（实现时逐条在单测/手工里覆盖）

1. 无路由（新 agent 从未请求）→ decide hot，基类 summarize 抛 no-target（行为与原生一致）。
2. 首请求后立即压缩：`cacheWrite>0` → hot（§4 规则覆盖；plugin-auto 实验 10.1.4 验证）。
3. 长空闲后压缩：最后一次 usage 可能是热的但缓存已被 provider 驱逐 → 误判 hot、白付重放。**v0.1 接受**（dsh 无 idle 数据；输入文档 §4 明示跳过）；代码注释 + 报告里记为已知限制，v0.2 候选（附录 C）。
4. 转录文本 > 重放输入（工具输出超大、摘要区极小）→ §6.1 上限保护退回重放。
5. 转录摘要不小于 shadowed → 基类 `summarizeCompaction` 现有校验兜底抛错（行为同原生）。
6. 转录输出非 8 段结构/空文本 → `summaryText` + 空摘要校验兜底（同原生）。
7. 压缩调用中途 surface 变更 → 基类稳定性断言兜底（不变）。
8. 多个 agent/会话并发 → 判定纯从各自 session log 推导，无共享可变状态，天然隔离。
9. `summarizationProvider/Model` 显式配置存在时，判定 key 仍按主对话路由（缓存命中的是主对话前缀；若压缩模型 ≠ 对话模型，热压「命中」本就存疑——但行为与原生一致，不额外处理；报告备注）。
10. 自定义 `modelPolicies` 覆盖 maxTokens 等 → 冷路径经复刻的 resolveTargetPolicy 尊重（§6.2），单测覆盖 override 命中/未命中两分支。

## 12. 漂移风险清单（dsh 升级前/后检查；本包依赖 dsh 内部未导出物）

| 依赖点 | 来源 | 缓解 |
|---|---|---|
| `BasicCompactionEngine` 构造器签名 `(ctx, config)` 与 `auto` 触发 | 复用的公开类（导出） | dsh 升级后跑 M1 冒烟 |
| `summarize`/`compactIfNeeded` 可覆盖性 | 类注释明言的钩子 | 同上 |
| base Config key 集（§3.4 照抄清单） | 未导出，逐字复制 | config.test.js 断言「base key 全集 + 自有 key」；升级时对照 `dsh-compaction-basic/lib/index.js:17-38` |
| `resolveTargetPolicy` 语义 | 未导出，复刻 15 行 | decision 无关；单测锁定 override 回退语义 |
| `summarizeWithLlm` 信封字段 | 未导出，按契约复制 | 信封字段以 `summarizeCompaction/commitCompactionBody` 实际读取为准（`summary, rawOutput, llmStreamCall, provider, model, maxTokens, usage`） |
| `COMPACTION_INSTRUCTION` 8 段文本 | 未导出，复制 | 文件头注释标明来源行号；升级时 diff 对照 |
| preset 组合语法 / settings namespace | 公开行为 | M1 冒烟 |

## 13. 显式假设

- A1 DeepSeek 缓存按 (provider, model) 隔离且前缀重放可命中（输入文档 §2.4；M3 10.3 实证，不成立则回看 D2）。
- A2 `assistant/message.usage` 真实反映 provider 计费口径的 cacheRead/cacheWrite（以 UI StatsLine 同源数据为准）。
- A3 压缩调用与主对话共享 sessionId 不影响命中判定；hit/miss 只由消息前缀决定。
- A4 转录式压缩的信息保真度足以支撑续跑（M3 10.4 验证；若质量不达标，回退方案 = 默认 `refuse` 或转录+保留尾部放大）。
- A5 本地包安装路径（§8 步骤 1）与 `dsh plugin` 语法由 M1 实测修正，不阻塞设计。

## 附录 A：关键源码行号索引（侦察笔记已含，速查）

- 引擎类与钩子：`dsh-compaction-basic/lib/index.js` 742（类）、840-844（summarize）、855-902（compactIfNeeded）、953-959（regionDependencies）、775-829（自动触发注册）、267-316（summarizeWithLlm）、648-657（buildSummarizationInput）
- 基类服务名：`dsh-compaction/lib/index.js:177-179`
- usage 落盘：`dsh-agent-loop/lib/index.js:642-658`；pre-step 派发：501-508
- usage 桶：`dsh-token-meter/lib/types/usage-projection.js:9-16`
- 预设机制：`dsh-agent-presets/lib/index.js:146,160,793-796,855-856`
- 预设模板：`config/agent-presets/code/agent.cordis.yml:144-162`
- 插件先例：`dsh-compaction-tool-result-pruner/lib/index.js`（inject/Config 形态）
- 转录参考思路：开源项目 opencode（MIT）的压缩实现——专用摘要提示 + 扁平化转录文本；本插件为独立 JS 实现。

## 附录 B：用户预设文件模板（M1 生成时基于 code 预设全文替换一行）

`~/.dsh/.agent-presets/cache-aware/agent.cordis.yml` = 从 `<dsh>/config/agent-presets/code/agent.cordis.yml` 全文复制，仅将（原 151-152 行）：

```yaml
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
```

替换为：

```yaml
    - id: compaction-cache-aware
      name: '@septtpes/dsh-compaction-cache-aware'
      config:
        coldMode: transcribe     # v0.1 默认；实验时按需改 refuse / 配 cachePolicy
        # cachePolicy: auto      # 实验覆盖: hot | cold
```

## 附录 C：v0.2+ 候选（v0.1 明确不做）

- idle 时长兜底冷热判定（需 session 事件时间戳，待侦察）
- 峰谷调度（推迟压缩到空闲价时段）
- 动态摘要大小 / retainRatio 动态调整
- 决策写入 session 自定义事件（供 UI StatsLine 显示模式与省额）
- `refuse` 的用户可见提示（UI toast/消息注入，v0.1 仅日志）
- pro/flash 混用策略（压缩模型路由的冷热联合优化）
