# 实验复现指南（M3 四组对照 + refuse 验证）

本目录是 2026-08-15 实测「缓存感知压缩插件」的完整实验装置。**复现前提**：

- 本机安装 dsh 0.1.0-rc.6（实验 home 的插件与 profile 依赖需手工重建，见下）
- 一个可用的 opencode-go（或任意 pi-ai 路由）API key，写入 `experiments/.env`（`OPENCODE_GO_API_KEY=...`，chmod 600，gitignored）
- macOS 注意：若本机 `sandbox-exec` 后端失效（`sandbox_apply` 错误），headless agent 的 bash 会被拒——`run-m3.sh` 已内置 `DSH_PERMISSION_MODE=danger-full-access` 开关，仅在隔离实验 home 生效

## 目录说明

```
experiments/
├── scripts/
│   ├── run-m3.sh      # 四组矩阵 + refuse 变体（baseline|plugin-hot|plugin-cold|plugin-auto|plugin-cold-refuse）
│   ├── task.js        # 16 步任务文本（M3_TASKS_DIR 环境变量可覆盖路径）
│   └── extract.py     # 会话 jsonl.zstd → 成本表（价格表为 2026-08-17 生效价）
├── dsh-home/          # 隔离实验 home（20K 窗口、cache-aware 预设、headless patch 中性态）
│   ├── settings.yaml
│   ├── .agent-presets/cache-aware/agent.cordis.yml
│   └── profiles/headless/cordis.patch.yml
└── tasks/             # 任务夹具（README + repo，跑前由脚本自动 reset）
```

## 重建实验 home（dsh-home 不含 node_modules，需一次初始化）

```bash
cd dsh-cache-aware-compaction
export DSH_HOME="$PWD/experiments/dsh-home"
dsh plugin --profile headless add file:"$PWD/dsh-compaction-cache-aware"
dsh plugin --profile web     add file:"$PWD/dsh-compaction-cache-aware"
```

## 运行

```bash
# 前置：experiments/.env 写 key；pnpm 在 PATH
bash experiments/scripts/run-m3.sh baseline
bash experiments/scripts/run-m3.sh plugin-hot
bash experiments/scripts/run-m3.sh plugin-cold
bash experiments/scripts/run-m3.sh plugin-auto
# 每轮输出末尾即 extract.py 的成本表；会话存 experiments/dsh-home/sessions/
```

## 已知要点（详见 docs/cache-aware-m3-report.md）

- 压缩触发次数受 agent 轨迹方差影响（同任务同设置 0-4 次/run）；结论以**差分证据**（事件计数对比）为准
- opencode-go 中继：跨会话共享 system 前缀缓存（首请求即 cacheRead≈8K）、cacheWrite 恒 0、超窗返回 max-tokens 截断而非 CONTEXT_WINDOW_EXCEEDED（overflow 兜底不可达）
- 全部实验于 2026-08-15/16 周末（空闲价、涨价前）执行
