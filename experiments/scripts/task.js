/**
 * M3 实验任务文本（四组对比共用同一份）。
 *
 * v3（2026-08-15 plan-agent 修正，基于 v1/v2 的实测发现）：
 * - headless 的 base 组合自带完整压缩栈（compaction-basic + command-compact
 *   + 原版 pruner 8192/4096/1024），baseline 无需任何 patch；plugin 变体仅
 *   disable compaction-basic 并插入本插件。pruner 四组保持原版（可比性）。
 * - pruner 剪裁数学：任何 >8192 字符的 tool result 都被剪成 4096+标记+1024
 *   ≈ 1.7K token；因此 dump 设计为 300 行 × 26 字符 = 7.8K 字符 < 8192，
 *   完整保留 ≈ 2.7K token/个（字符级确定，与 tokenizer 比例无关）。
 * - 窗口 20K / 阈值 80%=16K / 保留 16%=3.2K：6 个 dump（16.2K）+ 会话文本
 *   （3-6K）→ 表面在第 5-6 个 dump 后跨过 16K 触发恰好一次压力压缩；
 *   压缩调用输入（shadowed = 表面−3.2K）恒 ≤ 20K 窗口。
 * - 最终答案要求复述压缩前的事实（项目名/修复行为/文件路径/函数名）
 *   = §10.4 续跑质量断言。
 */
// 复现者：把 M3_TASKS_DIR 环境变量指向本仓库 experiments/tasks（或直接改文件里的占位路径）。
const TASKS_DIR = process.env.M3_TASKS_DIR ?? "<your-path>/experiments/tasks";
export const M3_TASK = `Work in the repository at ${TASKS_DIR}/repo.

Step 1: Read README.md in the parent directory (${TASKS_DIR}/README.md) and report in one line what the project is called and what it does.
Step 2: Read src/sum.js and config.json. Report the exact name of the exported function and the numbers in the config.
Step 3: The README mentions a known bug: "returns 0 for negative numbers when the config file is missing the numbers key". Fix src/sum.js so that a missing "numbers" key in config.json is handled by treating it as an empty array, and the function must correctly sum arrays containing negative numbers.
Step 4: Generate a diagnostic dump: run  python3 -c "print('\\n'.join(f'entry {i} value ' + 'data' * 3 for i in range(300)))" > dump1.txt  and then cat dump1.txt.
Step 5: Read src/main.js and explain in two sentences what it imports.
Step 6: Generate a second diagnostic dump: run  python3 -c "print('\\n'.join(f'record {i} payload ' + 'info' * 3 for i in range(300)))" > dump2.txt  and then cat dump2.txt.
Step 7: Write a small test script test/run.js that imports sumArray, asserts sumArray([1, -2, 3]) === 2 and sumArray([]) === 0, and prints PASS. Run it with node test/run.js.
Step 8: Generate a third diagnostic dump: run  python3 -c "print('\\n'.join(f'item {i} body ' + 'meta' * 3 for i in range(300)))" > dump3.txt  and then cat dump3.txt.
Step 9: Run node -e "console.log(require('node:path').basename(process.cwd()))" and report the output in one line.
Step 10: Generate a fourth diagnostic dump: run  python3 -c "print('\\n'.join(f'line {i} text ' + 'more' * 3 for i in range(300)))" > dump4.txt  and then cat dump4.txt.
Step 11: Run node test/run.js again and confirm it still prints PASS.
Step 12: Generate a fifth diagnostic dump: run  python3 -c "print('\\n'.join(f'field {i} note ' + 'fldr' * 3 for i in range(300)))" > dump5.txt  and then cat dump5.txt.
Step 13: Run ls -la src and report the file list in one line.
Step 14: Generate a sixth diagnostic dump: run  python3 -c "print('\\n'.join(f'cell {i} data ' + 'blob' * 3 for i in range(300)))" > dump6.txt  and then cat dump6.txt.
Step 15: Run node test/run.js one final time and confirm it still prints PASS.
Step 16: In your final answer, state ALL of the following exactly: (a) the project name, (b) the fixed behavior for negative numbers, (c) the exact path of the file you changed, (d) the exact name of the exported function in src/sum.js.`;
