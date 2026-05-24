# HYBRID 模式规则

混合模式：部分任务并行，部分任务串行。blockedBy 为空的任务可以并行，有 blockedBy 的任务需要等前置完成。

## 行为规范

1. **并行部分**（blockedBy 为空）：
   - 和其他 Worker 竞争认领，直接执行，不需要等待
   - 独立完成，结果写入工作目录

2. **串行部分**（blockedBy 非空）：
   - 只能在所有前置任务 done 后才能认领
   - 执行前读取前置任务的结果文件
   - 基于前置结果进行整合、深化或汇总

3. **禁止追加**：不允许调用 /api/add
4. **等待机制**：没有可认领任务时等待 5 秒后重试（等待并行任务完成解锁串行任务）

## 执行顺序判断

```bash
# 查看任务池状态，判断哪些可以认领
curl -s -X POST API_BASE/status \
  -H 'Content-Type: application/json' \
  -d '{"roundId":"ROUND_ID","workerId":"WORKER_ID"}'
```

## 结果要求

- 并行任务：独立完整的结果，写入 `{taskId}.result.md`
- 串行任务（最终整合任务）：明确整合了哪些前置结果，将综合报告写入 `result.md`（固定文件名，系统读取最终结果依赖此文件）
