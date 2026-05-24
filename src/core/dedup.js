/**
 * 服务端任务去重模块
 *
 * 使用与 Worker 相同的 Agent（runAgent）判断新任务是否与已有任务重复。
 * 只做 JSON 判断，不执行任何工具调用。
 */

import { writeFileSync, unlinkSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runAgent } from './agent.js';

/**
 * 判断新任务是否与现有任务重复
 *
 * @param {string} newDescription  - 新任务描述
 * @param {Array}  existingTasks   - 现有任务列表 [{id, description, status}]
 * @returns {Promise<{duplicate: boolean, duplicateOf: string|null, reason: string}>}
 */
export async function checkDuplicate(newDescription, existingTasks) {
  // 对比队列中所有任务（包括 done）：已完成的方向同样不应重复覆盖
  const candidates = existingTasks;

  if (candidates.length === 0) {
    return { duplicate: false, duplicateOf: null, reason: '无已有任务' };
  }

  const taskList = candidates
    .map(t => `#${t.id}[${t.status}]: ${t.description.slice(0, 120)}`)
    .join('\n');

  const systemPrompt = '你是任务去重判断器。只输出 JSON，不输出任何其他内容。';
  const userPrompt = `判断「新任务」与「已有任务」的重叠情况，给出处理建议。

【特殊规则：整合/汇总类任务】
整合任务是元任务（meta-task），其目的是读取已有调研结果并生成最终报告，与调研任务的研究对象不同，不应被调研任务拦截。
- 新任务是整合任务 AND 已有任务中没有整合任务 → 必须判为 none（放行）
- 新任务是整合任务 AND 已有任务中已有整合任务 → 必须判为 duplicate

识别整合任务的信号词：「整合」「汇总」「综合报告」「最终报告」「生成报告」「发布」「产出报告」「总结产出」等关键词出现且描述中包含"读取已完成结果"或"生成最终报告"之类的意图。

【普通任务判断标准】
- duplicate（完全重复）：核心研究/执行对象完全相同，即使措辞不同。
- overlap（部分重叠）：与某个已有任务有交叉，但新任务还有独立的差异部分值得单独执行。此时提供裁剪后只保留差异部分的新描述。
- none（不重叠）：与所有已有任务都无实质重叠。

示例：
- "工程落地案例研究" vs "工程落地路径与最佳实践" → duplicate（同一研究对象）
- "AI应用实践（含钓鱼项目和BML）" vs 已有"AI钓鱼项目深度分析" → overlap，裁剪为"BML比价机制AI化实践"
- "涌现理论基础" vs "工程设计模式" → none
- "整合汇总：读取所有结果生成综合报告" vs 已有6个调研任务（无整合任务） → none（整合任务元任务，不与调研任务重叠）
- "整合汇总：读取所有结果生成综合报告" vs 已有整合任务 → duplicate

已有任务：
${taskList}

新任务：
${newDescription.slice(0, 300)}

输出格式（只输出这个 JSON，不要有任何其他文字）：
{"result": "duplicate|overlap|none", "duplicateOf": "最相似任务的taskId或null", "trimmedDescription": "仅当result=overlap时填写，裁剪后只保留差异部分的完整任务描述（至少50字）", "reason": "一句话说明"}`;

  // 写临时 system prompt 文件
  const tmpFile = join(tmpdir(), `dedup-${Date.now()}.md`);
  writeFileSync(tmpFile, systemPrompt);

  let output = '';
  try {
    await runAgent({
      agentName: 'dedup',
      prompt: userPrompt,
      systemPromptFile: tmpFile,
      ws: null,
      abortControllers: new Map(),
      onText: t => { output += t; },
    });
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }

  // 解析输出中的 JSON：找所有候选的 {...} 块，从最后一个开始尝试（LLM 可能先输出思考文字再输出 JSON）
  const allMatches = [...output.matchAll(/\{[\s\S]*?\}/g)];
  // 也尝试贪婪匹配（防止 trimmedDescription 内容含花括号导致非贪婪截断）
  const greedyMatch = output.match(/\{[\s\S]*\}/);
  const jsonCandidates = greedyMatch ? [greedyMatch[0], ...allMatches.map(m => m[0]).reverse()] : allMatches.map(m => m[0]).reverse();

  for (const candidate of jsonCandidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed.result || parsed.duplicate !== undefined) {
        const result = parsed.result || (parsed.duplicate ? 'duplicate' : 'none');
        return {
          result,
          duplicate: result === 'duplicate',
          duplicateOf: parsed.duplicateOf || null,
          trimmedDescription: parsed.trimmedDescription || null,
          reason: parsed.reason || '',
        };
      }
    } catch {}
  }

  // 解析失败，保守处理：认为不重复，让任务通过；记录原始 output 方便排查
  const failMsg = `[dedup] 解析去重结果失败\noutput: ${output.slice(0, 400)}`;
  console.warn(failMsg);
  try { appendFileSync(join(process.env.HOME, '.teams', 'server.log'), `${new Date().toISOString()} [WARN] ${failMsg}\n`); } catch {}
  return { result: 'none', duplicate: false, duplicateOf: null, trimmedDescription: null, reason: '解析失败，默认放行' };
}
