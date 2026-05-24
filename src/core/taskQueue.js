// 任务池模块：文件锁 + 原子读写
// 任务池文件：.myteams/tasks/queue.json
// 锁文件：    .myteams/tasks/queue.lock
// 结果文件：  .myteams/tasks/{id}.result.json

import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * 整合/汇总类任务的识别正则。
 * 仅匹配明确表示"整合多个子任务产出"语义的词，避免误伤"发布"/"上传"等普通任务。
 * 使用范围：/api/claim 整合任务保护、/api/add blockedBy 自动补全与涌现标记。
 */
export const SUMMARY_RE = /整合|汇总|综合报告|总结报告/;

const TYPE_META = {
  emerged:   { label: '涌现', icon: '✦' },
  challenge: { label: '挑战', icon: '⚔' },
  normal:    { label: null,   icon: null },
};

function resolveTypeMeta(type) {
  return TYPE_META[type] ?? TYPE_META.normal;
}

const RETRY_INTERVAL = 15;   // ms，等锁时的轮询间隔
const LOCK_TIMEOUT   = 5000; // ms，超过这个时间强制清锁（防进程崩溃后死锁）

export class TaskQueue {
  constructor(baseDir) {
    this.dir       = join(baseDir, 'tasks');
    this.queueFile = join(this.dir, 'queue.json');
    this.lockFile  = join(this.dir, 'queue.lock');
    mkdirSync(this.dir, { recursive: true });
    if (!existsSync(this.queueFile)) writeFileSync(this.queueFile, '[]');
  }

  // ── 公开 API ────────────────────────────────────────────────────

  /** 批量初始化任务，保留 id 和 blockedBy */
  init(tasks) {
    return this._withLock(() => {
      const queue = tasks.map((t, i) => {
        const type = t.type || 'normal';
        const { label, icon } = resolveTypeMeta(type);
        return {
          id:          t.id ?? String(i + 1),
          description: t.description ?? t.task ?? '',
          status:      'pending',
          blockedBy:   t.blockedBy ?? [],
          meta:        t.meta ?? {},
          type,
          label,
          icon,
          claimedBy:   null,
          claimedAt:   null,
          result:      null,
          doneAt:      null,
        };
      });
      this._write(queue);
      return queue;
    });
  }

  /** Worker 认领一个 pending 且依赖已满足的任务 */
  claim(workerId) {
    return this._withLock(() => {
      const queue = this._read();
      const doneIds = new Set(queue.filter(t => t.status === 'done').map(t => t.id));
      const task = queue.find(t => {
        if (t.status !== 'pending') return false;
        // blockedBy: 所有前置任务必须已 done
        if (t.blockedBy?.length) return t.blockedBy.every(id => doneIds.has(id));
        return true;
      });
      if (!task) return null;
      task.status    = 'claimed';
      task.claimedBy = workerId;
      task.claimedAt = Date.now();
      this._write(queue);
      return { ...task };
    });
  }

  /** 释放所有 claimed 任务回 pending（暂停时使用） */
  releaseAllClaimed() {
    return this._withLock(() => {
      const queue = this._read();
      const released = [];
      for (const task of queue) {
        if (task.status === 'claimed') {
          task.status    = 'pending';
          task.claimedBy = null;
          task.claimedAt = null;
          released.push(task.id);
        }
      }
      if (released.length) this._write(queue);
      return released;
    });
  }

  /** 释放已认领的任务，重置回 pending（供整合任务保护机制使用） */
  release(taskId) {
    return this._withLock(() => {
      const queue = this._read();
      const task = queue.find(t => t.id === taskId);
      if (!task || task.status !== 'claimed') return false;
      task.status    = 'pending';
      task.claimedBy = null;
      task.claimedAt = null;
      this._write(queue);
      return true;
    });
  }

  /** 检查是否有 pending 且依赖已满足的任务（不认领，只查询） */
  hasAvailable() {
    const queue = this._read();
    const doneIds = new Set(queue.filter(t => t.status === 'done').map(t => t.id));
    return queue.some(t => {
      if (t.status !== 'pending') return false;
      if (t.blockedBy?.length) return t.blockedBy.every(id => doneIds.has(id));
      return true;
    });
  }

  /** Worker 完成任务，写回结果 */
  complete(taskId, result) {
    return this._withLock(() => {
      const queue = this._read();
      const task = queue.find(t => t.id === taskId);
      if (!task) return false;
      task.status = 'done';
      task.result = result;
      task.doneAt = Date.now();
      this._write(queue);
      return true;
    });
  }

  /** Worker 发现新子任务，追加到队列（支持 blockedBy 依赖） */
  add(description, blockedBy = [], addedBy = '', emerged = false, emergeReason = '', type = 'normal') {
    return this._withLock(() => {
      const queue = this._read();
      // 在已有任务 ID 基础上递增，保持任务池内 ID 连贯
      const maxId = queue.reduce((max, t) => {
        const n = parseInt(t.id, 10);
        return isNaN(n) ? max : Math.max(max, n);
      }, 0);
      const id = String(maxId + 1);
      const resolvedType = type !== 'normal' ? type : (emerged ? 'emerged' : 'normal');
      const { label, icon } = resolveTypeMeta(resolvedType);
      queue.push({
        id,
        description,
        status:    'pending',
        blockedBy: blockedBy || [],
        type:      resolvedType,
        label,
        icon,
        claimedBy: null,
        claimedAt: null,
        result:    null,
        doneAt:    null,
        addedBy,
        emerged,
        emergeReason,
      });
      this._write(queue);
      return id;
    });
  }

  /**
   * 将超时未完成的 claimed 任务释放回 pending
   * @param {number} timeoutMs 超时阈值，默认 10 分钟
   * @returns {string[]} 被释放的 taskId 列表
   */
  releaseStale(timeoutMs = 10 * 60 * 1000) {
    return this._withLock(() => {
      const queue = this._read();
      const now = Date.now();
      const released = [];
      for (const task of queue) {
        if (task.status === 'claimed' && task.claimedAt && now - task.claimedAt > timeoutMs) {
          task.status    = 'pending';
          task.claimedBy = null;
          task.claimedAt = null;
          released.push(task.id);
        }
      }
      if (released.length) this._write(queue);
      return released;
    });
  }

  /** 更新任务的 blockedBy 字段（用于动态补全整合任务的依赖关系） */
  updateBlockedBy(taskId, blockedBy) {
    return this._withLock(() => {
      const queue = this._read();
      const task = queue.find(t => t.id === taskId);
      if (!task) return false;
      task.blockedBy = blockedBy;
      this._write(queue);
      return true;
    });
  }

  /** 读取当前队列快照（无锁，用于状态查询） */
  snapshot() {
    try { return JSON.parse(readFileSync(this.queueFile, 'utf8')); }
    catch { return []; }
  }

  /** 是否全部完成 */
  isAllDone() {
    return this.snapshot().every(t => t.status === 'done');
  }

  /** 还有没有 pending 或 claimed 的任务 */
  hasWork() {
    return this.snapshot().some(t => t.status === 'pending' || t.status === 'claimed');
  }

  // ── 内部 ────────────────────────────────────────────────────────

  _read() {
    try { return JSON.parse(readFileSync(this.queueFile, 'utf8')); }
    catch { return []; }
  }

  _write(queue) {
    writeFileSync(this.queueFile, JSON.stringify(queue, null, 2));
  }

  /** 文件锁：O_EXCL 原子创建，失败则轮询重试 */
  _withLock(fn) {
    const deadline = Date.now() + LOCK_TIMEOUT;

    const tryLock = () => {
      // 检查是否有超时的僵尸锁
      if (existsSync(this.lockFile)) {
        try {
          const stat = readFileSync(this.lockFile, 'utf8');
          const ts = parseInt(stat, 10);
          if (Date.now() - ts > LOCK_TIMEOUT) {
            unlinkSync(this.lockFile); // 强制清除僵尸锁
          }
        } catch { /* 锁文件已被其他进程删除，正常 */ }
      }

      try {
        // O_EXCL：文件不存在时原子创建，存在则抛错
        const fd = openSync(this.lockFile, 'wx');
        writeFileSync(fd, String(Date.now()));
        closeSync(fd);
        return true; // 拿到锁
      } catch {
        return false; // 锁被占用
      }
    };

    const releaseLock = () => {
      try { unlinkSync(this.lockFile); } catch { /* 已被清除 */ }
    };

    // 同步轮询（Node.js 单线程，spawn 的子进程通过文件竞争）
    const poll = () => {
      if (tryLock()) return;
      if (Date.now() > deadline) throw new Error('TaskQueue: 获取锁超时');
      // 同步等待：用忙等 + Atomics（在 Worker thread 中）或递归
      // 这里用同步 sleep 模拟（适合低并发场景）
      const start = Date.now();
      while (Date.now() - start < RETRY_INTERVAL) { /* busy wait */ }
      poll();
    };

    poll();
    try {
      return fn();
    } finally {
      releaseLock();
    }
  }
}
