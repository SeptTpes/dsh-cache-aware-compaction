# dsh 插件项目 plan/build 双会话工作流模板

> 沉淀自：Cache-Aware Compaction 插件 v0.1（2026-08-15 全流程跑通）
> 适用：dsh 生态插件开发（或任何「设计重、验证贵、实现轻」的项目）
> 本模板是第二份交付物（输入文档 §6）；第一份是插件本体。

---

## 1. 双会话分工

| | plan 会话（pro） | build 会话（flash） |
|---|---|---|
| 职责 | 架构讨论、侦察、设计决策、计划定稿、审查、实验验收 | 实现、单测、挂载实测、付费验证、报告落盘 |
| 上下文纪律 | **保持小**：工具结果不堆进会话；设计结论即时落盘，read 文件代替记忆 | 可大：实现细节、测试输出、实测日志都是工作记忆 |
| 付费行为 | 不跑付费实验（pro 单价高） | 独占付费实验（flash 价） |
| 产出 | 输入文档 → 侦察笔记 → 决策完备计划 | 代码 + 单测 + 实验报告 + 阶段交接 |

关键：pro 会话的价值在判断不在记忆——所有跨会话知识走文件，不靠会话续传。

### 1.1 分工铁律（本项目实证教训，2026-08-15）

1. **接盘红线**：build 会话卡点时，pro 只做最小响应（给指令/给提示/问用户），**绝不接手执行**（跑实验、填报告、改脚手架都是 build 活）；任何「pro 接盘 build」必须经用户显式裁决。
2. **阶段边界声明**：plan 会话每到一个阶段边界（侦察完成 / 计划定稿 / 核验完成），最后一轮输出必须以「**后续属于 build：**」开头显式声明交接内容——用户看到即切换，不用等用户自己发现。
3. **交接选项显式化**：`ask_user_question` 的选项必须包含「**打包交接回 flash**」，禁止只有「pro 继续 vs 暂停」的二元选项（默认推荐倾向会把执行归属悄悄推给 pro）。
4. **切换成本归零**：交接文档做到「flash 可无痛重启」（指令+key+上下文全部在文档里），重拉起成本趋近零——顺手接盘的经济学就不成立。
5. **pro 会话轮次预算**：大项目里 pro 会话也会膨胀——每 N 轮或上下文到 50% 时落盘计划增量，必要时开新 plan 会话续（pro 压缩输出 27 元/M，比 flash 贵 3 倍）。
6. **执行权字段**：交接文档的每个交接点必须显式声明执行归属（「后续属于 build：」）+ 附可粘贴指令块；禁止把执行主体默认为「拿决策权的会话」（本项目实证：交接格式缺执行权字段，越权成为默认路径）。
7. **推荐选项带执行主体**：`ask_user_question` 的推荐项文案必须显式写出执行者（如「交给 flash 会话重跑」/「本会话代跑（贵 3 倍）」/「暂停」）；凡会静默改变「谁执行」的路径不得标 Recommended——推荐项是强默认，主语缺失即诱导。
8. **用户侧审查清单**：模板面向 agent 的纪律之外，必须给用户一张「每个交接点该查什么」清单（成功标准可验收性 / 决策表是否完备 / 执行主体是否显式 / 提交节点数 = 计划节点数）——agent 项目的质量天花板是人的审查。

## 2. 桥接文档五件套（落盘桥接，会话间 read 文件）

1. **自包含输入文档**（`*_plan_input_<date>.md`）：任务一句话、动机与成本公式、已确认情报、待侦察项、设计方向、里程碑、工作流约定。必须自包含——接手会话无任何对话上下文。
2. **侦察笔记**（`*_recon.md`）：源码实证，**每条结论带行号证据**；明确区分「已确证 / 待实证」。build 会话可完全信任。
3. **决策完备计划**（`plan-*.md`）：已拍板决策表（§0，标拍板方与日期）+ 成功标准（逐条可验收）+ 架构/文件清单/类骨架/配置 schema + 操作手册 + 里程碑验收表 + 实验设计 + 边界情况 + 漂移风险清单 + 显式假设。**build 只实现不做设计决策**；唯一自决点要显式标注（如「安装命令实测后回写本节」）。
4. **build 阶段交接文档**（`build-stage-handoff-<date>.md`）：里程碑状态表（✅/🟡/⏳ 带证据）、文件清单、与计划的偏离记录（实现细节级）、待决断点、**执行权字段（每个交接点声明归属 + 可粘贴指令块）**、运行手册、风险。

plan 文档必附两类「消灭执行期歧义」的内容：
- **验证载体组合来源侦察**：凡计划要用某个 profile/runner 做验证，先读它的组合层（bundles + patch + 服务来源）——本项目实证：headless 挂载机制假设错误导致 M3 设计返工（grep `dsh-base/cordis.patch.yml` 十分钟可证伪）。
- **尺寸敏感夹具的 worked example**：任何依赖 token 估算的夹具（dump 大小、窗口阈值、pruner 交互），plan 必须附完整算例（字符数 → token → 表面增长 vs 阈值与保留），不得委托 build「以实际触发为准」（本项目实证：v1 任务 22K token 被估成 6K，四组实验差点全 0 压缩）。
5. **实验报告**（`experiments/*-m3-report.md`）：四组对比数据表、成本公式复述与反事实计算、结论、成功标准逐条核对表（打勾）、遗留事项。

纪律：文档是契约——计划明确要求回写才改（如 §8 实测命令），否则 plan/recon/input 只读。

## 3. dsh 插件扩展机制速查（本项目实测，2026-08-15）

### 3.1 插件形态（cordis Service）

```js
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
var MyPlugin = class extends Service {
  static inject = ["llm", "tokenMeter", "sessions"];  // 依赖注入
  static Config = z.object({ ... });                   // Loader 用它校验/normalize
  constructor(ctx, config = {}) { super(ctx, "serviceName"); ... }
};
```

- 包名 `@deepseek-ai/dsh-xxx`；`package.json`：`type: module`、`main: lib/index.js`、`types`、peerDependencies 声明 cordis/dsh 子包、schemastery 放 dependencies（照抄 `dsh-compaction-tool-result-pruner` 先例）。
- **配置校验分层**：schemastery `z.object` 对未知 key 不抛错（原样透传）→ 严格性由自己的 resolveConfig 保证（own key）+ 被覆盖基类的 resolveConfig 保证（base key）。
- **可选服务用 `ctx.get("name")`**（pruner 先例）；必选服务进 `static inject`。

### 3.2 挂载：web 用 agent preset，headless 用 cordis.patch.yml

**web（多会话 GUI）**：
- 用户预设 `~/.dsh/.agent-presets/<id>/agent.cordis.yml`（`<dsh>/config/agent-presets/<id>/` 是系统预设，只读）。
- 选择预设：`~/.dsh/settings.yaml` 加 `agent-presets: { default: <id> }`（settings 热重载，新会话生效；老会话/常驻进程行为需重启验证）。
- preset 组合文件是行列表，`cordis:group` + `isolate` 声明私有 realm；**服务行必须进 isolate 组**（否则根 realm 进程级污染，第二会话冲突）。
- 本地插件安装：`dsh plugin --profile web add file:<绝对路径>`（转发 pnpm；需 pnpm 在 PATH；物理拷贝安装，包内裸导入经 `~/.dsh/profiles/node_modules` flat fallback 解析；`no dsh.bundle` 告警无害）。

**headless（单任务进程）**：
- **无 agent-presets 服务**——settings 的 `agent-presets.default` 对 headless 无效。
- `dsh-base` 自带完整压缩栈（compaction-basic + command-compact + 原版 pruner）在根 realm。
- 插件变体 = `profiles/headless/cordis.patch.yml`：`disabled: true` 原生行 + `insert` 插件行（根 realm 平铺，单会话进程安全）。
- **坑**：preset 的 isolate 组写法搬到 headless patch 会死锁——`command-compact` 在 isolate 组内等待 `compaction` 服务永远不出现。

### 3.3 覆盖压缩引擎

- `BasicCompactionEngine`（`dsh-compaction-basic`）子类化；**只覆盖 `summarize()`（唯一定制钩子）与 `compactIfNeeded()`（拒绝策略钩子，动态派发）**；范围选择/事务/落盘/校验全复用基类。
- 服务名保持 `"compaction"`（基类注册）→ `/compact`、overflow 恢复、`ctx.get("toolResultPruner")` 自动走新引擎。
- 覆盖类再声明 `static Config`（base 全键逐字照抄 + 自有键），构造器里**先剥离自有 key 再 `super(ctx, rest)`**（基类 resolveConfig 严格拒绝未知 key）。
- 依赖基类未导出物（指令文本/信封字段/策略函数）→ 复制/复刻 + 文件头标注来源行号 + 升级时 diff 对照（漂移清单）。

## 4. 实验脚手架要点（本项目踩坑集）

1. **pi-ai 路由的窗口配置**：`llm-deepseek.models[].contextWindow` 只作用于 deepseek 直连路由；opencode-go 等 pi-ai 路由的模型目录默认 `contextWindow: 1000000`（SDK catalog），必须到 `llm-pi-ai.providers.<route>.models` 强制（会话内 `request/context` 事件确认生效）。
2. **macOS 沙箱失效**：本机 `sandbox-exec` 后端对 `workspace-write` 失效（sandbox_apply 失败）→ agent 的 bash 工具被拒。用 `DSH_PERMISSION_MODE=danger-full-access`（dsh-base 官方环境开关），**仅限隔离实验 home**。
3. **pruner 剪裁数学**：>8192 字符的 tool result 被剪成 4096+标记+1024 ≈ 1.7K token；设计 dump 输出要算准字符数（300 行 × 26 字符 = 7.8K < 8192 完整保留）。对比实验四组保持同一 pruner 配置（可比性）。
4. **agent 轨迹方差**：同任务同设置压缩次数 0-4 次/run（LLM 非确定性 + max-tokens 偶发失败）。对策：(a) A/B 用**差分证据**（事件计数对比），不断言单次行为；(b) 任务要求最终答案复述压缩前事实（续跑质量断言）；(c) 半程失败样本注明后仍可计入。
5. **key 处置**：`experiments/.env`（600 权限、gitignored），run 脚本 `set -a; . .env; set +a`；key 永不进聊天/文档/提交，实验完即删。**用户也不要在聊天/GUI 里粘贴 key**——会进会话记录（本项目实证：key 曾因用户粘贴进入会话日志，好在实验完已失效删除）；提供方式 = 写 .env 文件，回复「好了」即可。
6. **证据优先于日志**：headless 不打印 info 级日志——用 session jsonl（zstd）事件做证据：`compaction/start|summary|end`、`assistant/message.usage`（uncached/cacheRead/cacheWrite/output）、`request/context`。overflow 压缩的特征 = shadowed ≈ 全表面（retainTokens=0）+ 同 step 内重试（无 step/start 间隔）。
7. **零成本诊断前置（build 门禁）**：花第一分钱之前必须全绿——(a) 负向挂载测试（非法配置须大声失败，证明插件/配置确实被加载）；(b) 最小 bash boot 任务（工具链可用）；(c) `request/context` 事件核对生效窗口（免费 boot 任务里 grep）。诊断不绿不付费。运行时环境事实（如沙箱后端失效）只能靠门禁拦截，plan 侦察覆盖不到。
8. **产品级发现回写**：运行期实测若影响产品语义（如：中继的 cacheWrite 恒 0 → 判定分支不可达；超窗不报错 → refuse 的 overflow 兜底不可达），必须从实验报告注释**升格为产品决策条目**（v0.2 backlog），不能埋在 §7 遗留事项里。

## 5. 成本纪律（DeepSeek 峰谷价）

- 峰谷：工作日 9-12、14-18 高峰；其余（含周末全天）**半价空闲**。
- 涨价生效日 2026-08-17 00:00（北京时间）——项目排期必须考虑。
- 付费实验全部排空闲价时段；M0-M2 用单测与最小冒烟，不无意义重复长会话。
- 单次 headless 验证成本估算（20K 窗口任务）≈ 0.1-0.2 元（空闲）；整轮矩阵 < 1.5 元。
- 压缩纪律（对两个会话）：缓存热时压缩（当天会话内）、摘要宁小勿大、少压。
- **成本决算**：项目结束/每阶段结束时，从会话日志汇总 usage → 分阶段成本表（plan 会话 / build 会话 / 实验各多少）→ 与预算对比，写进实验报告或独立决算小节。「成本优化」类项目强制要求（本项目 pro 会话 5.8 元 vs 实验 1 元——不决算就看不见「pro 上下文堆执行」的真实代价）。具体命令：每里程碑用会话 jsonl 提取 usage（extract.py 的 pattern：assistant/message.usage 按会话聚合），让浪费在过程中可见，而非复盘时才见。
- **密钥协议**：key 只能由用户写文件提供（chmod 600、gitignored、set -a 导入）；agent 永远不在聊天里索要/复述 key；**凡进过聊天的 key = 已暴露 = 用完即轮换**（删除不等于零暴露——本项目实证：key 因用户粘贴进聊天记录，且被 agent 复述进会话日志）。

## 6. git 纪律（节点化提交，审计导向）

- **提交节点清单**：计划文档里预定义逻辑节点编号（M0.1 包脚手架 / M0.2 config+测试 / M0.3 decision+测试 / M0.4 transcript+测试 / M0.5 engine+测试 / M1 挂载 / M2 实验脚手架 / M3 实验 / 报告……），build 按清单**逐节点执行、逐节点提交**——git log 就是执行轨迹。
- **提交信息规范**：`<节点号>: <做了什么>`，如 `M0.2: config module + schema tests (12/12 pass)`；审计者扫 log 即可还原过程。
- **一个提交 = 一个逻辑节点**：禁止终点一次性大提交（本项目实证教训：build 把 35 文件 2880 行压成一个提交，无法追溯节点、无法按模块回滚、无法 bisect）。
- **现场发生**：节点化提交必须是边做边提交（每个逻辑节点完成后立刻 commit），不是项目结束后重建——重建历史只是「策展叙事」，只有现场提交才是「原始轨迹」；重建仅可用于展示仓库，且必须保留原始分支作备份。
- **归属清晰**：plan 产出的文档由 plan 会话自己提交，build 不收编（本项目曾出现 build 提交把 pro 的计划文档收进去）。
- **验收项**：交接验收表加「提交节点数 = 计划节点数」，数不对即未执行纪律。

## 7. 交付物清单与验收

| 里程碑 | 交付物 | 验收方式 |
|---|---|---|
| M0 | 包脚手架 + 纯模块 + node:test 单测 | `node --test` 全绿；关键分支全覆盖（判定规则全分支/渲染表/拒绝路径） |
| M1 | 插件安装 + 预设/settings + 冒烟 | 启动日志见引擎构造；决策日志出现；`/compact` 正常（headless 无命令通道 → 事务路径证据 + 用户 GUI 手测） |
| M2 | 冷判定 + 转录调用 + refuse 路径 | 单测锁定逻辑；真实运行差分验证（baseline N 次压缩 vs refuse 0 次） |
| M3 | 四组对比实验 + 报告 | 报告含四组数据表、成本公式反事实、成功标准 1-6 逐条打勾、遗留事项 |

成功标准写法要点：全部量化、可脚本/可观测（事件、usage、退出码），不写「看起来正常」。

**验收补充**：
- **闭环跟踪**：验收表的 ⏳ 项必须在最终报告里显式关闭或显式豁免（本项目实证：成功标准 6「模型隔离实证」至今 ⏳，复盘时两份纪要都该以它开篇）；复盘清单从「未闭环验收项」开始。
- **提交节点数核对**：交接验收表加「提交节点数 = 计划节点数」，数不对即未执行 git 纪律。
- **单测全绿 ≠ 合格**（模型对照实验实证）：mimo-v2.5-pro 73 测试全绿仍藏三处契约违反（cold 路径忽略 modelPolicies 对 summarization* 的覆盖、转录格式偏离 §6.1、弱校验被自己的测试正当化）。「对照计划盲审」才是真门槛——匿名目录 + 独立评审（评审者不知模型映射）+ 事后揭名。
- **偏离正确率比测试数重要**：glm-5.2 的溢价买的是过程厚度（BUILD-NOTES 的 D1-D5 遵循表、9 个自主决策、漂移表、**未测区声明**）——贵模型的价值在「知道自己哪里没测」，而非多写几个测试。验收时给「偏离质量」和「未测区声明」计分。

---

*模板维护：新项目跑完后，把新踩的坑补进 §3/§4；文档本身用双会话流程维护。*
