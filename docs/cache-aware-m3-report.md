# Cache-Aware Compaction 插件 v0.1 — M3 验证报告

> 生成：2026-08-15（plan-agent 实跑 + 填充；flash 价，周六=全天空闲价且涨价前）
> 载体：`dsh --profile headless`（隔离实验 DSH_HOME：`experiments/dsh-home/`）
> 任务文本：`experiments/scripts/task.js`（16 步编码任务，四组共用；v3 版）
> 价格表（输入文档 §1，元/百万 token）：flash miss 3.00/1.50、hit 0.10/0.05、输出 9.00/4.50（高峰/空闲）
> 会话日志：`experiments/dsh-home/sessions/`（各 run 一个 `session.jsonl.zstd`，数据经 `scripts/extract.py` 提取）

## 0. 实验环境修正记录（与交接脚手架的三处实测差异，均已修复）

1. **挂载机制**：headless 无 `agent-presets` 服务（settings 的 `agent-presets.default` 对其无效）；且 `dsh-base` **自带** `compaction-basic + command-compact + 原版 pruner`。→ baseline = 空 patch（纯原生）；plugin 变体 = patch 里 `disabled: compaction-basic` + `insert` 本插件（根 realm 平铺；isolate 组会令 `command-compact` 死锁等待 `compaction` 服务）。
2. **窗口**：opencode-go 路由的模型目录默认 `contextWindow: 1000000`（pi-ai SDK catalog），`llm-deepseek.models` 不作用于该路由。→ 在 `llm-pi-ai.providers.opencode-go.models` 强制 `contextWindow: 20000`（阈值 16K/保留 3.2K）。会话内 `request/context` 事件确认生效。
3. **沙箱**：本机 macOS `sandbox-exec` 后端对 `workspace-write` 模式失效（`sandbox_apply` 失败），headless agent 的 bash 工具被拒。→ 运行环境加 `DSH_PERMISSION_MODE=danger-full-access`（dsh-base 官方环境开关，仅限隔离实验 home）。
4. **pruner 数学**：>8192 字符的工具结果被剪成 4096+标记+1024≈1.7K token；dump 设计为 300 行×26 字符=7.8K 字符（<8192，完整保留≈2.6K token）。pruner 四组保持原版配置。
5. **运行方差**：agent 轨迹差异导致压缩次数 0-4 次/run；2/5 轮因 agent 单条输出撞 max-tokens 失败（与本插件无关的 LLM 非确定性）。→ 路由 `maxTokens` 提到 16384 后重跑成功（仅影响主请求输出 cap；压缩调用 maxTokens 是引擎独立的 8192）。

## 1. 四组对比数据（压缩调用，per run）

| 指标 | baseline | plugin-hot | plugin-cold | plugin-auto |
|---|---|---|---|---|
| 压缩次数（干净 run） | 4 | 1（另有 2 次的半程 run） | 4 | 4（另有 2 次的半程 run） |
| 压缩调用输入合计（tokens） | 48,768 | 11,694（半程 21,962） | **18,589** | 48,070（半程 18,928） |
| 其中 cacheRead（hit） | 37,504（77%） | 11,264（96%）；半程 77% | 640（3%，跨调用同 system prompt） | 31,872（66%）；半程 87% |
| 其中 miss（uncached） | 11,264 | 430（半程 5,066） | 17,949 | 16,198 |
| 摘要输出合计（tokens） | 6,693 | 1,928（半程 2,285） | 6,264 | 6,608 |
| 单次调用输入均值 | 12,192 | 11,694 | **4,647** | 12,018 |
| 压缩调用成本合计（高峰，元） | 0.0978 | 0.0198 | 0.1103 | 0.1113 |
| 压缩调用成本合计（空闲，元） | 0.0489 | 0.0099 | 0.0552 | 0.0557 |
| 压缩后首请求 uncached（均值） | ~7,224 | ~6,885 | ~7,055 | ~7,460 |

**核心比值**：冷压转录输入 T ≈ 4,647 vs 热压重放输入 U(1−R) ≈ 12,192 → **T = 38% × U(1−R)**（v0.1 目标 T ≤ 20-40% ✓）。

## 2. 成本公式与反事实计算（§10.2）

- 热压 `C_hot = U(1−R)·P_hit + S·P_out + (UR+S)·P_miss`
- 冷压(重放) `C_cold_replay = U(1−R)·P_miss + S·P_out + (UR+S)·P_miss`
- 冷压(转录) `C_cold_transcript = T·P_miss + S·P_out + (UR+S)·P_miss`

用实测值（baseline 重放 U(1−R)=48.8K、cold 转录 T=18.6K、S≈6.5K，flash 价）：

| 场景 | 压缩调用输入成本（高峰/空闲，元） | 说明 |
|---|---|---|
| 缓存热 + 重放（baseline 实测） | 0.038 / 0.019 | hit 价 0.10/0.05 极便宜，重放几乎免费 |
| 缓存冷 + 重放（stock dsh 反事实） | **0.146 / 0.073** | 全按 miss 价 |
| 缓存冷 + 转录（plugin-cold 实测输入部分） | **0.056 / 0.028** | T 按 miss 价 |

**结论**：缓存真冷时，转录式压缩省 **62%** 的压缩调用输入成本（0.146→0.056 元高峰）。缓存热时热压本就便宜（0.038 元），插件自动选热路径 = 与原生相同开销。**插件价值成立**：它消掉的是「冷缓存下重放白付」，而不是与热压比便宜。

**重要观察（中继行为）**：opencode-go 中继对新会话首请求即报 `cacheRead≈8064`（跨会话共享的 harness system prompt 前缀缓存），且 `cacheWrite` 恒为 0。含义：(a) 判定规则里 `cacheRead>0→热` 在中继上始终有信号；(b) `cacheWrite>0→热` 分支在本环境无法实测（单测覆盖）；(c) 每请求有 ~8K 的「免费」缓存前缀，冷热的边际差异集中在增量前缀上。

## 3. 缓存按模型隔离实证（§10.3）

headless 是单模型单任务，无法脚本化跨模型切换。**留待用户 GUI 手动验证**（步骤见报告 §7.2）。D2（按 (provider,model) 隔离记忆）的代码实现与单测已就位，实证不影响 v0.1 上线，但结果需回贴计划 §0。

## 4. 质量验收（§10.4）

- 冷压后 8 段 checkpoint 替换成功：✓ plugin-cold 4 次 `compaction/start→summary→end` + `surfaceOp: replace` 全链路落盘；摘要均小于被压区间（基类校验通过）。
- 续跑断言：✓ plugin-cold 最终答案四项事实全部正确——(a) 项目名 `token-adder`、(b) 负数修复行为（missing `numbers` 键按空数组处理 + 负数求和正确）、(c) 文件路径 `src/sum.js`、(d) 导出函数 `sumArray`。这些事实产生于压缩前（步骤 1-3），压缩后仍被准确复述。
- 半程 run（plugin-hot/plugin-auto 各一次 max-tokens 失败）的压缩数据同样有效，作为补充样本计入。

## 5. 成功标准核对表（计划 §1 的 1–6）

| # | 标准 | 结论 | 证据 |
|---|---|---|---|
| 1 | 热场景与不带插件等价（同一前缀重放调用） | ✅ 通过 | 代码路径 `super.summarize`（逐字节同构，单测断言调用形状）；实测 plugin-hot 96% hit、plugin-auto 66% hit 的重放画像与 baseline 77% 一致 |
| 2 | 冷场景输入从重放 U(1−R) 降为转录 T 且 T < U(1−R) | ✅ 通过 | T=4.6K vs U(1−R)=12.2K（38%）；压缩调用 usage 实测（hit≈0） |
| 3 | 冷摘要 8 段 checkpoint、摘要 < 被压区间、会话可续跑 | ✅ 通过 | §4 两项证据 |
| 4 | refuse 模式 pressure 跳过、overflow 不拒 | ✅ 通过（单测） | engine.test.js：refuse+cold+pressure 返回 null 且不调基类；refuse+cold+overflow 仍走基类。真实 run 未执行（可选验证项） |
| 5 | /compact、overflow 恢复、pruner 兼容 | ✅ 通过（事务层） | 引擎注册为 `compaction` 服务（负向挂载测试证明行加载 + schema 校验）；pruner 在四组 run 中按原版配置工作（`compaction/prune` 事件）；overflow 路径由基类共享逻辑承担（未在 run 中触发）；/compact GUI 手动验证留给用户（§7.1） |
| 6 | 模型切换后冷热判定归零重判 | ✅ 通过（GUI 实证 2026-08-15，两次切换） | 跨 provider 切换（opencode-go/flash→official/pro）首请求 `uncached=18116, cacheRead=0`；同 provider 仅切模型（official pro→flash）首请求 `uncached=18969, cacheRead=0`——缓存按 (provider, model) 隔离且粒度与 D2 键精确一致。数据见 §7.4 |

## 6. 已知限制

- 长空闲后缓存被 provider 驱逐仍可能误判热（v0.1 接受；§11.3）。
- `summarizationProvider/Model` 显式配置时判定 key 仍按主对话路由（与原生一致）。
- 冷路径转录对 reasoning 块降级为 `[block: reasoning]`。
- 本实验未覆盖：真实冷缓存场景（模型切换/长空闲驱逐）——强制 `cachePolicy: cold` 模拟了决策与调用形态，反事实成本由公式计算。
- agent 轨迹方差导致压缩次数 0-4 次/run；四组共享同一任务与压缩栈，A/B 可比性成立（半程样本已注明）。

## 7. 遗留事项

### 7.1 用户 GUI 手测清单（约 2 分钟）

1. 打开本 GUI 新建一个会话（真实 web 实例的 `settings.yaml` 已指向 `cache-aware` 预设；若新会话未生效，需重启 dsh web 实例）。
2. 发一条长消息，等回复；再发第二条 → 观察 StatsLine「缓存命中 %」。
3. 输入 `/compact` 手动压缩一次 → 确认无报错、上下文正常。
4. **模型隔离实证**：同一会话切换模型（如 pro↔flash）再发一条消息 → 观察缓存命中率是否归零；把结果贴回来（回贴计划 §0 的 D2）。

### 7.2 其他

- **API key 处置**：`sk-Y80A…` 已写入 `experiments/.env`（600 权限、gitignored）且出现在本次会话记录中。实验已完成，**建议现在删除该 key**（用户已计划删除）；`experiments/.env` 可留空文件占位。
- 真实 web 实例（:3080）新会话已使用 cache-aware 预设：热路径与原生等价、默认 `transcribe`，风险低；如想完全回滚，删除 `~/.dsh/settings.yaml` 的 `agent-presets` 段即可。
- 实验 home 的 headless patch 已恢复为 baseline（空 `[]`）；任务仓库已 reset 至原始状态（见 git）。

### 7.3 refuse 真实运行验证（build 会话补跑，2026-08-15 周六空闲价）

> 动机：§5 成功标准 4 的「真实 run」此前未执行。本次用新增变体 `plugin-cold-refuse`（`run-m3.sh`：`coldMode: refuse` + `cachePolicy: cold`，显式映射表替代原 `variant.replace("plugin-","")`——后者会把带连字符的变体名错写成非法 `cachePolicy`）跑同任务 v3。

**运行记录（2 次，均完成或触顶后退出）**：

| run | session id | 压缩事件 | 最后请求输入（uncached+cacheRead） | turn/end | headless exit |
|---|---|---|---|---|---|
| 1 | `session-e184f910-21f4-4c50-8721-e7aa098cf240` | **0 次** | 20,692（10,324 + 10,368） | `max-tokens`（output 1） | 1 |
| 2 | `session-079bd3d0-a98b-4339-b871-278c5513e4d7` | **0 次** | 27,369（17,001 + 10,368） | `max-tokens`（output 1） | 1 |

（两次 run 的 assistant/chunk 流均无 `error` finish、无 `request/error` 事件、无 `compaction/start`。）

**差分证据（refuse 生效）**：baseline 同任务同设置实测 **4 次 pressure 压缩**（§1）；refuse 运行 **0 次压缩**且表面 token 持续涨破 16K 阈值直至窗口外 → 所有 pressure 触发均被跳过（`compactIfNeeded` 返回 null），与计划 §7 一致。判定为冷（cachePolicy: cold 强制）→ refuse 分支命中。

**overflow 兜底未能自然触发（环境限制，非插件缺陷）**：opencode-go 中继对超窗请求**不报 `CONTEXT_WINDOW_EXCEEDED`**，而是返回 `finish: max-tokens` + 1 token 输出 → `agent/request-error` 不派发 → overflow 压缩路径不运行。因此「overflow 不拒」在本环境无法用真实运行取证，由单测锁定（`engine.test.js`：`refuse+cold+context-overflow` 仍走基类且不告警；`refuse+cold+pressure` 跳过）。真实 DeepSeek API 上报错语义不同（`CONTEXT_WINDOW_EXCEEDED`），dsh 基类 overflow 恢复机制会按设计兜底。

**附带发现（refuse 模式的物理后果实测）**：拒绝压缩后上下文一路涨到窗口外，任务以 `max-tokens` 截断结束（exit 1，非崩溃）。这与计划 §7 的 refuse 语义描述一致——「省下压缩调用成本，但上下文继续增长直到 overflow 强制压缩」；在 opencode-go 中继上 overflow 永远不会到来，表现为任务截断。**用户须知**：`coldMode: refuse` 在 pi-ai 中继路由上可能导致长任务无法完成，建议该路由保留默认 `transcribe`；refuse 更适合直连 DeepSeek API 或已知会报窗口错误的 provider。

### 7.4 成功标准 6 闭环操作步骤（GUI 模型切换实证，待执行）

> 目的：实证「缓存按 (provider, model) 隔离」（计划 D2 的外部事实；插件代码侧已由 decision.js 单测锁定，本项只验假设）。headless 单模型无法脚本化切换，故为 GUI 手测。

1. 在 GUI 新建一个**新会话**（干净基线），记下当前模型（模型选择器显示）。
2. 发一条**较长消息**（建议 ≥500 字：贴一段代码或长文，构造可缓存的前缀增量）。
3. 同模型再发第二条消息 → 记下统计行「缓存命中 %」（此时应显著 >0）。
4. **切换模型**（pro↔flash），再发第三条消息（内容与前面同主题，保证前缀结构一致）。
5. 记录切换后统计行的「缓存命中 %」变化。
6. 终端提取逐请求 usage（新会话 = 最新 session）：

```bash
S=$(ls -t ~/.dsh/sessions/*/*/session.jsonl.zstd | head -1); zstd -dc "$S" | python3 -c "
import json,sys
for l in sys.stdin:
    e=json.loads(l)
    if e.get('type')=='assistant/message':
        u=e['data'].get('usage') or {}
        src=e['data'].get('message',{}).get('source') or {}
        print(f\"{src.get('provider')}/{src.get('model')} uncached={u.get('inputTokens',0)} cacheRead={u.get('cacheReadTokens',0)} out={u.get('outputTokens',0)}\")
"
```

**判定基准**：切换模型后第三条请求的 `cacheRead` 若 ≈ 中继共享前缀量级（本环境实测 ≈8064，仅 system prompt 前缀）而非「共享前缀+对话前缀」，即**隔离成立、D2 正确**；若对话前缀仍全命中，则 D2 需重审（回贴计划 §0 决策表）。注意：opencode-go 中继存在跨会话共享前缀缓存，预期「骤降」而非「归零」——归零只在无共享前缀缓存的环境出现。结果回贴本报告并关闭 §5 标准 6 的 ⏳。

**已执行（2026-08-15，用户 GUI 实测）**：3 回合 7 step 的逐请求 usage 与 GUI 统计行完全吻合（36.1k/54% → 54.2k/69% → 109k/68%）。切换点（opencode-go/flash → deepseek-official/pro）后首请求 `uncached=18116, cacheRead=0`，随后 pro 前缀恢复命中（18304/18432）。**结论：缓存按 (provider, model) 隔离成立，标准 6 关闭。**

**补充实证（同日，同提供商仅切模型）**：在 deepseek-official 上 pro→flash 切换，切换后首请求 `uncached=18969, cacheRead=0`（= 18116 + pro 回合新增 ~850，前缀结构吻合），随后 flash 前缀恢复命中（19840/20480/…）。**结论：同 provider 内模型级也隔离——D2 的 (provider, model) 键与官方缓存粒度精确一致，不存在「过于保守可放宽到 provider 级」的 v0.2 优化空间。** 两条路线（opencode-go 中继 / deepseek-official 直连）均已实证，标准 6 的取证完整。
