#!/usr/bin/env python3
"""M3 session extractor: usage + compaction events -> cost table rows.

Usage: python3 extract.py <session.jsonl.zstd> [--json]

Reads a dsh session log (zstd-compressed jsonl), extracts per-run metrics and
computes compaction costs with the DeepSeek 2026-08-17 price table
(元 / 百万 token, input doc §1):
  flash: miss_in 3.00/1.50, hit_in 0.10/0.05, out 9.00/4.50 (peak/idle)
  pro:   miss_in 9.00/4.50, hit_in 0.30/0.15, out 27.00/13.50
Billing assumption (conservative): cacheWrite tokens are billed at miss price;
uncachedInput at miss; cacheRead at hit; output at out.
"""
import json
import sys
import subprocess

PRICES = {
    "deepseek-v4-flash": {"miss": (3.00, 1.50), "hit": (0.10, 0.05), "out": (9.00, 4.50)},
    "deepseek-v4-pro": {"miss": (9.00, 4.50), "hit": (0.30, 0.15), "out": (27.00, 13.50)},
}
DEFAULT_PRICE = PRICES["deepseek-v4-flash"]


def load_events(path):
    if path.endswith(".zstd"):
        raw = subprocess.run(["zstd", "-dc", path], capture_output=True, check=True).stdout
    else:
        raw = open(path, "rb").read()
    return [json.loads(line) for line in raw.decode("utf-8").splitlines() if line.strip()]


def tokens(usage):
    if not usage:
        return {}
    return {
        "uncached": usage.get("inputTokens", 0),
        "cacheRead": usage.get("cacheReadTokens", 0) or 0,
        "cacheWrite": usage.get("cacheWriteTokens", 0) or 0,
        "output": usage.get("outputTokens", 0) or 0,
    }


def call_input_tokens(u):
    """Compaction-call billed input = uncached(miss) + cacheRead(hit) + cacheWrite(miss)."""
    return u["uncached"] + u["cacheRead"] + u["cacheWrite"]


def cost(model, usage, peak=True):
    p = PRICES.get(model, DEFAULT_PRICE)
    idx = 0 if peak else 1
    miss, hit, out = p["miss"][idx], p["hit"][idx], p["out"][idx]
    return {
        "input": (usage["uncached"] + usage["cacheWrite"]) * miss / 1e6 + usage["cacheRead"] * hit / 1e6,
        "output": usage["output"] * out / 1e6,
        "total": (usage["uncached"] + usage["cacheWrite"]) * miss / 1e6 + usage["cacheRead"] * hit / 1e6 + usage["output"] * out / 1e6,
    }


def extract(path):
    events = load_events(path)
    meta = events[0] if events[0]["type"] == "session" else {}
    header = next((e["data"]["header"] for e in events if e["type"] == "request/header"), None)
    route = (header or {}).get("config", {})
    assistant = [e for e in events if e["type"] == "assistant/message"]
    compactions = []
    open_start = None
    for e in events:
        if e["type"] == "compaction/start":
            open_start = e
        elif e["type"] == "compaction/summary" and open_start is not None:
            d = e["data"]
            u = tokens(d.get("usage"))
            compactions.append({
                "seq": e["seq"],
                "startSeq": open_start["seq"],
                "compactionId": d.get("compactionId"),
                "provider": d.get("provider"),
                "model": d.get("model"),
                "maxTokens": d.get("maxTokens"),
                "shadowedTokenCount": d.get("shadowedTokenCount"),
                "shadowedSeqs": len(d.get("shadowedSeqs", [])),
                "llmStreamCall": d.get("llmStreamCall"),
                "usage": u,
                "callInputTokens": call_input_tokens(u),
                "hitTokens": u["cacheRead"],
                "missTokens": u["uncached"] + u["cacheWrite"],
                "cost": {"peak": cost(d.get("model"), u, True), "idle": cost(d.get("model"), u, False)},
            })
        elif e["type"] == "compaction/end":
            open_start = None
    # Post-compaction first assistant message (the checkpoint-broken prefix, all miss).
    post = []
    for c in compactions:
        after = next((a for a in assistant if a["seq"] > c["seq"]), None)
        post.append(None if after is None else {
            "seq": after["seq"],
            "usage": tokens(after["data"].get("usage")),
        })
    return {
        "session": meta.get("id"),
        "agentPreset": meta.get("agentPreset"),
        "cwd": meta.get("cwd"),
        "route": route,
        "assistantCount": len(assistant),
        "assistantTotals": {
            "uncached": sum(tokens(a["data"].get("usage"))["uncached"] for a in assistant),
            "cacheRead": sum(tokens(a["data"].get("usage"))["cacheRead"] for a in assistant),
            "cacheWrite": sum(tokens(a["data"].get("usage"))["cacheWrite"] for a in assistant),
            "output": sum(tokens(a["data"].get("usage"))["output"] for a in assistant),
        },
        "compactions": compactions,
        "postCompaction": post,
    }


def render(result, peak=True):
    label = "peak" if peak else "idle"
    lines = []
    lines.append(f"session: {result['session']}  preset: {result['agentPreset']}")
    lines.append(f"route: {result['route'].get('provider')}/{result['route'].get('model')}")
    lines.append(f"assistant messages: {result['assistantCount']}  totals: {result['assistantTotals']}")
    total_input = total_hit = total_miss = total_out = 0.0
    total_cost = 0.0
    for i, (c, post) in enumerate(zip(result["compactions"], result["postCompaction"]), 1):
        u = c["usage"]
        lines.append(f"compaction #{i}: seq={c['seq']} shadowed={c['shadowedTokenCount']} tokens / {c['shadowedSeqs']} nodes "
                     f"model={c['model']} callInput={c['callInputTokens']} (uncached={u['uncached']}, hit={u['cacheRead']}, "
                     f"write={u['cacheWrite']}) output={u['output']}")
        lines.append(f"  cost[{label}]: input={c['cost'][label]['input']:.4f} 元 output={c['cost'][label]['output']:.4f} 元 "
                     f"total={c['cost'][label]['total']:.4f} 元")
        if post is not None:
            pu = post["usage"]
            lines.append(f"  post-compaction first request: uncached={pu['uncached']} output={pu['output']}")
        total_input += c["callInputTokens"]
        total_hit += c["hitTokens"]
        total_miss += c["missTokens"]
        total_out += u["output"]
        total_cost += c["cost"][label]["total"]
    lines.append(f"TOTAL compaction calls: {len(result['compactions'])}  callInput={total_input} (hit={total_hit}, miss={total_miss})  "
                 f"output={total_out}  cost[{label}]={total_cost:.4f} 元")
    return "\n".join(lines)


if __name__ == "__main__":
    path = sys.argv[1]
    result = extract(path)
    if "--json" in sys.argv:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(render(result, peak="--idle" not in sys.argv))
