# Cache-Aware Compaction 插件 — 源码侦察笔记（plan 阶段输入）

> 生成：2026-08-15，dsh 0.1.0-rc.6 源码实测（checkout: `~/.local/lib/node_modules/@deepseek-ai/dsh/`）
> 作用：回答 plan 输入文档 §3 的四个待侦察项；build 会话可信任本文档。

---

## 结论速览

| 输入文档 §3 待侦察项 | 结论 |
|---|---|
| 1. 插件注册与覆盖机制 | **已确证**：agent preset 组合文件按包名加载插件；覆盖 = 子类化 `BasicCompactionEngine` 并在预设中用它替换 `compaction-basic` 行 |
| 2. 冷热信号获取 | **已确证**：`assistant/message` 事件携带 `usage.cacheReadTokens`；压缩发生在下一步的 `agent/pre-step`，上一步 usage 已落盘，时序可行 |
| 3. headless 验证闭环 | **已确证**：`dsh --profile headless "task"` 单任务跑完退出，session 落盘 `~/.dsh/sessions/` |
| 4. 缓存按模型隔离 | **待实证**（非阻塞）：建议在 M3 用 headless 做一次模型切换实验，看 `cacheReadTokens` 是否归零 |

---

## 1. 插件注册与覆盖机制（最大风险项 → 已解）

### 1.1 cordis 插件形态（以现成插件为模板）

`dsh-compaction-tool-result-pruner/lib/index.js` 是现成先例，形态：

```js
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

var ToolResultPruner = class extends Service {
  static inject = ["tokenMeter"];           // 依赖注入
  static Config = z.object({ ... });        // schemastery 配置 schema
  constructor(ctx, config = {}) { super(ctx, "toolResultPruner"); ... }
};
```

要点：包名 `@deepseek-ai/dsh-xxx`；package.json `type: module`、`main: lib/index.js`、peerDependencies 声明 cordis 与 dsh 子包。

### 1.2 插件如何被加载：agent preset（不是全局 config 文件）

- 内置预设：`<dsh>/config/agent-presets/{standard,code,cordis}/agent.cordis.yml`
- 用户自定义预设：`~/.dsh/.agent-presets/<preset-id>/agent.cordis.yml`
  （`dsh-agent-presets/lib/index.js:146,160`：`COMPOSITION_FILE = "agent.cordis.yml"`、`USER_PRESET_DIR = ".agent-presets"`）
- 组合文件是「行列表」：每行 `{id, name(包名), config, disabled}`；`cordis:group` + `isolate` 声明私有 realm。
- 压缩相关段（以 code 预设 `agent.cordis.yml:144-162` 为准）：

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true          # "compaction" 服务名在此 realm 内
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
```

- 第三方插件包安装位置：`dsh plugin --profile <name> <pnpm args>` → `~/.dsh/profiles/<name>/node_modules`
  （实测本机 `~/.dsh/profiles/web/node_modules` 即主 dsh node_modules 的符号链接森林 + 独立安装目录）
- 本机 dsh home = `~/.dsh/`（`dsh-home-paths/lib/index.js:65-66`：`$DSH_HOME` > `~/.dsh`）

### 1.3 覆盖方式：子类替换（官方钩子）

`BasicCompactionEngine`（`dsh-compaction-basic/lib/index.js:742`）：

- `class BasicCompactionEngine extends CompactionEngine`，`super(ctx, "compaction")` 在基类（`dsh-compaction/lib/index.js:179`）——服务名 `"compaction"`
- 类注释（index.js:738-740）明言：**"`summarize()` is the sole subclass customization hook"**
- `_registerAutomaticCompaction()`（index.js:775）中注释：**"`compactIfNeeded` stays dynamically dispatched so subclass overrides are honored at event time"** → 子类可覆盖 `compactIfNeeded`（做「拒绝压缩」类策略）
- `summarize(input, agent, signal)`（index.js:840）→ `summarizeWithLlm()`（index.js:267）：构造 `system+tools+区间原始消息+COMPACTION_INSTRUCTION`，走 `ctx.llm.stream({purpose:"compaction", sessionId})`，前缀重放命中 KV 缓存
- `regionDependencies()`（index.js:953-959）返回 `{meter, summarize}` —— summarize 绑定的是 `this.summarize` 方法（动态派发，子类覆盖生效）；**summarize 不走 `ctx.get` 服务查找**（区别于 pruner）
- 替换方案：自定义包 `extends BasicCompactionEngine`，覆盖 `summarize()`（冷压转录式）与 `compactIfNeeded()`（可选拒绝策略），在预设中**用它替换 `compaction-basic` 行**（不要两行并存注册同名服务）
- 兼容性验证：`dsh-command-compact/lib/index.js:8` inject `["commands","compaction"]`，调 `ctx.compaction.compactNow()` → 子类注册为 `"compaction"` 后 `/compact` 自动走我们的引擎（手动压缩也受益于模式选择，建议 manual 也走同一决策）

### 1.4 压缩触发与事务（确认文档 §2.2）

- 自动触发：`ctx.on("agent/pre-step")`（index.js:780）→ `compactIfNeeded(agent,"pressure",signal)`；`ctx.on("agent/request-error")` 捕获 `CONTEXT_WINDOW_EXCEEDED_CODE` → overflow 恢复（index.js:802）
- 阈值 80%（`DEFAULT_THRESHOLD_RATIO=.8`，index.js:13）、保留尾 16%（`DEFAULT_RETAIN_RATIO=.16`，index.js:15）、摘要 maxTokens 默认 8192
- 事务：`compactSurfaceRegion`（index.js:418）→ `prepareCompaction` → `summarizeCompaction`（index.js:549，经 `dependencies.summarize` 动态派发）→ 校验摘要 < shadowed → `compaction/summary` + `user/message`(surfaceOp replace) → `compaction/end`
- 配置（`BasicCompactionConfig`，index.js:17-31）：`thresholdRatio/retainRatio/retainTokens/summarizationProvider/summarizationModel/maxTokens/compactionRetries/maxOverflowRetries/modelPolicies/auto` —— 压缩可指定独立 provider/model（文档 §2.3 的零代码杠杆成立）

---

## 2. 冷热信号获取（已确证）

### 2.1 usage 事件

- `dsh-agent-loop/lib/index.js:650-658`：每步完成时 `session.append("assistant/message", {turn, step, message, usage: assembler.usage})`
- usage 桶（`dsh-token-meter/lib/types/usage-projection.js:9-16`）：`uncachedInputTokens / outputTokens / cacheReadTokens / cacheWriteTokens`
- token-meter 还有 `totals`（会话累计）与 `last`（最近一次 {turn, step, buckets}）投影；UI StatsLine 读 totals

### 2.2 时序（关键）

- 压缩在 **下一步的** `agent/pre-step`（waterfall 中间件，`dsh-agent-loop/lib/index.js:501`）触发 → 此时上一步 `assistant/message`（含 usage）已落盘 → **压缩事务前读最近 usage 可行**
- 插件内两种取法：
  - 扫 `agent.session.events` 取最近一条 `assistant/message` 的 `data.usage`
  - 用注入的 `ctx.tokenMeter` / sessionProjections 的 `last`
- 判定规则 v0.1：最近 usage `cacheReadTokens > 0` → 热；否则冷。若按模型隔离记忆（见 §4），key 为 `provider/model`（可取自 `agent.session.requestHeader().config`）

### 2.3 成本模型（确认文档 §1）

- 热压调用前缀重放 → hit 价；冷压调用前缀重放 → 全 miss。差价 = `U(1−R)·(P_miss − P_hit)`
- 转录式冷压：把重放输入 `U(1−R)` 换成转录文本 T（T << U(1−R)），冷压调用成本从 `U(1−R)·P_miss + S·P_out` 降为 `T·P_miss + S·P_out`
- 压缩后主请求 `(UR+S)·P_miss` 无论如何要付（消息已变，缓存重建）——这是压缩的固有成本，与冷热无关
- 参考思路：开源项目 opencode（Apache-2.0）压缩实现的 renderTranscript（专用摘要提示 + 扁平化转录）

---

## 3. headless 验证闭环（已确证）

- 用法：`dsh --profile headless "task"`（`dsh-headless/README.zh.md`）
- 单任务：创建新持久化 Agent → 提交任务 → 等 idle → flush → 打印最后一条 assistant 文本 → 退出码 0
- session 落盘 `~/.dsh/sessions/`（jsonl 持久化），可回放 usage 事件做成本对比
- M3 实验设计（建议）：
  1. 同一任务跑两遍（第二遍同会话续跑 → 热）分别记录 compression 前后 usage
  2. 带/不带插件各跑同场景，对比「压缩调用成本 + 总成本」
  3. 模型切换实验（实证 §4）

---

## 4. 待实证项（plan 里保留为实验步骤，不阻塞 M1/M2）

- 缓存按 provider/model 隔离：DeepSeek 按模型隔离缓存（文档推断）；headless 中跑「请求 A 模型 → 切 B 模型 → 同前缀请求」，观察 `cacheReadTokens`
- 插件本地开发安装路径：`pnpm add file:<path>` / `dsh plugin --profile web add <path>`（build 阶段验证哪种最稳）
- 自定义 preset 的生效路径：`~/.dsh/.agent-presets/<id>/agent.cordis.yml` 是否需要在 settings 里选择（`dsh-agent-presets` settings namespace；build 阶段验证）

---

## 附：关键文件索引

- `dsh-compaction-basic/lib/index.js` — 引擎本体（962 行，上文所有 index.js 行号均指此文件）
- `dsh-compaction/lib/index.js:177-179` — 基类，服务名 `"compaction"`
- `dsh-compaction-tool-result-pruner/lib/index.js` — 插件先例（ctx.get 可选服务模式）
- `dsh-agent-loop/lib/index.js:501,650` — pre-step 派发点 / assistant-message usage 落盘点
- `dsh-agent-presets/lib/index.js:146,160` — 预设发现机制
- `dsh-token-meter/lib/types/usage-projection.js` — usage 桶结构
- `config/agent-presets/code/agent.cordis.yml:144-162` — 压缩预设段（插件注册模板）
