# @septtpes/dsh-compaction-cache-aware

缓存感知的 dsh 压缩引擎插件：前缀缓存热时维持原生前缀重放压缩，冷时切换转录式压缩。

- 完整背景/原理/验证数据：仓库根目录 [README.md](../README.md)
- 实施计划与设计决策：`../docs/plan-cache-aware-compaction-v0.1.md`

## 安装

```bash
dsh plugin --profile <name> add file:/path/to/dsh-compaction-cache-aware
```

在 agent preset 组合中用它替换 `@deepseek-ai/dsh-compaction-basic` 行（服务名同为 `compaction`，`/compact` 与 pruner 自动兼容）。示例 preset 见 `../examples/agent.cordis.yml`。

## 配置

```yaml
coldMode: transcribe   # 冷缓存行为：transcribe | refuse
cachePolicy: auto      # auto | hot | cold（hot/cold 为实验覆盖）
# base 键（thresholdRatio/retainRatio/summarizationProvider/summarizationModel/
# maxTokens/modelPolicies/auto）与 dsh-compaction-basic 一致，透传基类
```

## 测试

```bash
node --test   # 61 tests（需 dsh 0.1.0-rc.6 依赖可解析）
```

## 许可证

MIT
