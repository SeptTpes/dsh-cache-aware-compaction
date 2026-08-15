# dsh-cache-aware-compaction

缓存感知的 dsh（DeepSeek Harness）压缩引擎插件——压缩前判定前缀缓存冷热：**热时维持原生前缀重放**（命中缓存、几乎免费），**冷时切换转录式压缩**（避免重放大段前缀却全 miss 的白付）。

## 为什么需要它

DeepSeek API 2026-08-17 起涨价并引入峰谷定价，缓存命中/未命中输入价差达 **30 倍**（hit 0.10 vs miss 3.00 元/百万 token，flash 高峰价）。dsh 原生压缩（`dsh-compaction-basic`）用「前缀重放」构造压缩调用——缓存热时几乎免费，缓存冷时整段重放按 miss 价付费。本插件在压缩触发时先判定冷热，冷时改用转录式压缩（专用摘要提示 + 扁平化转录），实测把压缩调用输入从重放的 `U(1−R)` 降到转录的 `T ≈ 38% × U(1−R)`，缓存真冷时省 **62%** 的压缩调用输入成本。

## 工作原理

```
压缩触发（agent/pre-step 或 context-overflow）
  └─ 判定：倒序扫描会话日志，取最近一次同 (provider, model) 调用的 usage
       cacheRead > 0 || cacheWrite > 0 → 热；两者皆 0 → 冷
       ├─ 热 → 原生前缀重放（super.summarize，与 stock dsh 逐字节等价）
       └─ 冷 → 转录式压缩（TRANSCRIPT_SYSTEM_PROMPT + 扁平化转录 + 8 段 checkpoint 指令）
                └─ 回退保护：转录估算 ≥ 重放估算时自动退回重放路径
```

- 服务名保持 `"compaction"` → `/compact` 手动命令、上下文溢出恢复、tool-result pruner 全部自动兼容
- 配置：`coldMode: transcribe | refuse`（默认 transcribe）、`cachePolicy: auto | hot | cold`（hot/cold 为实验覆盖）
- 冷热记忆按 `(provider, model)` 隔离——模型切换后判定归零重算（已由 GUI 实测两次切换验证，见 M3 报告 §7.4）
- 只覆盖基类两个钩子（`summarize` / `compactIfNeeded`），范围选择、事务、落盘、稳定性校验全部复用基类

## 验证结论（M3 四组对照实验）

| 指标 | 数值 |
|---|---|
| 冷压转录输入 T vs 热压重放 U(1−R) | 4.6K vs 12.2K（**38%**） |
| 缓存真冷时压缩调用输入成本 | **省 62%**（0.146 → 0.056 元/次，flash 高峰价） |
| 热路径与原生一致性 | 逐字节同构；实测命中画像一致（77% vs 66-96%） |
| 摘要质量 | 8 段 checkpoint 全部落盘；压缩前事实压缩后复述全对 |
| 单测 | 61/61 全绿（config 11 + decision 15 + transcript 18 + engine 17） |
| 模型切换缓存隔离 | 跨 provider 与同 provider 仅切模型，切换后首请求 cacheRead 均归零（实证） |

完整数据与实验方法：`docs/cache-aware-m3-report.md`。

## 安装与启用

前置：本机已安装 dsh（当前针对 `0.1.0-rc.6`，见下方版本说明）。

```bash
# 1. 安装插件到 web profile（本地路径安装）
dsh plugin --profile web add file:/path/to/dsh-cache-aware-compaction/dsh-compaction-cache-aware

# 2. 创建/复制 agent preset（见 examples/agent.cordis.yml 思路）
#    把 compaction 组里的 compaction-basic 行替换为：
#      - id: compaction-cache-aware
#        name: '@septtpes/dsh-compaction-cache-aware'
#        config: { coldMode: transcribe }

# 3. settings.yaml 选择该 preset
#    agent-presets:
#      default: <your-preset-id>
```

headless 环境的挂载方式（cordis.patch.yml `disabled + insert`）与坑位见 `docs/dsh_cache_aware_compaction_recon.md` §1 及实验脚本 `experiments/scripts/run-m3.sh`。

## 配置说明

```yaml
coldMode: transcribe   # 冷缓存时的行为：transcribe=转录式自动压缩；refuse=跳过压缩（仅 pressure；overflow 从不拒绝）
cachePolicy: auto      # auto=按 usage 判定；hot/cold=强制路径（实验/对照用）
# 其余键与 dsh-compaction-basic 完全一致（thresholdRatio/retainRatio/summarizationProvider/
# summarizationModel/maxTokens/modelPolicies/...），透传基类
```

注意：`coldMode: refuse` 在部分中继路由（如 opencode-go）上会导致任务被 max-tokens 截断——该路由的超窗请求不报 `CONTEXT_WINDOW_EXCEEDED`，overflow 兜底永不触发。中继路由建议保留默认 `transcribe`（详见 M3 报告 §7.3）。

## 仓库结构

```
dsh-cache-aware-compaction/
├── dsh-compaction-cache-aware/   # 插件包（lib/ + test/，61 单测）
├── docs/
│   ├── dsh_cache_aware_compaction_plan_input_2026-08-15.md  # 任务输入（自包含）
│   ├── dsh_cache_aware_compaction_recon.md                  # 源码侦察笔记（行号证据）
│   ├── plan-cache-aware-compaction-v0.1.md                  # 决策完备实施计划
│   ├── cache-aware-m3-report.md                             # 四组对照实验报告
│   ├── model-compare-report.md                              # 多模型对照实验（flash/glm/mimo）
│   └── dsh-plugin-plan-build-workflow-template.md           # plan/build 双会话工作流模板
├── experiments/                   # 可复现实验（脚本已参数化路径；需 dsh + API key）
└── LICENSE                        # MIT
```

## 运行测试

```bash
# 在装有 dsh 0.1.0-rc.6 的机器上（依赖从 dsh 安装的 node_modules 解析）：
cd dsh-compaction-cache-aware && node --test
```

版本说明：npm registry 上 `@deepseek-ai/dsh-*` 已发布 `0.1.0-rc.6`（2026-08 复核），本插件的 peerDependencies 对应 `^0.1.0-rc.6`，CI 已启用 push/pull_request 自动触发。本包**未发布 npm**，安装走 `dsh plugin --profile <name> add file:...` 本地路径；若你要发布到 npm，可改用你自己的 scope 包名。

## 许可证

MIT © 2026 SeptTpes
