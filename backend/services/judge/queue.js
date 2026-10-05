const db = require('../../database/db');
const config = require('../../config/config');
const { sanitizeLog } = require('../../utils/securityHelpers');
const { logError, logWarn } = require('../../utils/logger');
const { judgeSubmission, rejudgePrevStatus } = require('./pipeline');

const judgeQueue = [];
const queuedIds = new Set();
const runningIds = new Set(); // 正在判题的提交，防 rejudge 对运行中任务重复入队（D-M1）
const maxThreads = config.judge.maxThreads;
const runningJobs = new Set();

// 判题进行中收到的 rejudge 请求：等当前这一轮结束后必须再跑一次
const rejudgeRequested = new Set();

// 并发判题池：最多同时运行 maxThreads 条提交，各自独立判题线程
async function runOne(submissionId) {
  try {
    await judgeSubmission(submissionId);
  } catch (err) {
    logError('QUEUE', `Judge error for submission ${submissionId}:`, sanitizeLog(String(err && err.message || err)));
    db.prepare("UPDATE submissions SET status = 'system_error' WHERE id = ?").run(submissionId);
  } finally {
    // 本轮判题期间若又收到 rejudge 请求（路由层已清空详情、置 pending_rejudge），
    // 必须重新入队，否则该次 rejudge 会静默丢失，提交停留在"已判完但没有测试点详情"的中间态。
    const again = rejudgeRequested.delete(submissionId);
    // 再次入队时保留 prevStatus 供下一轮使用；否则本轮结束后清掉
    if (!again) rejudgePrevStatus.delete(submissionId);
    runningIds.delete(submissionId);
    if (again) {
      queuedIds.add(submissionId);
      judgeQueue.push(submissionId);
    }
  }
}

function pumpQueue() {
  while (runningJobs.size < maxThreads && judgeQueue.length > 0) {
    const submissionId = judgeQueue.shift();
    queuedIds.delete(submissionId);
    runningIds.add(submissionId);
    const job = runOne(submissionId);
    runningJobs.add(job);
    // runOne 内部已 catch，这里只回收槽位；单独 catch 是为了避免 .finally() 派生的
    // Promise 变成 unhandledRejection → server.js 直接 process.exit(1)
    job.then(() => {}, () => {}).finally(() => {
      runningJobs.delete(job);
      pumpQueue();
    });
  }
}

function enqueueSubmission(submissionId, prevStatus) {
  // prevStatus 必须在任何早退之前落表：否则"正在排队/正在判题"时被丢弃，
  // judgeSubmission 会读到 pending_rejudge → wasCompileError=false → CE 重复扣 Rating
  if (prevStatus) rejudgePrevStatus.set(submissionId, prevStatus);
  if (runningIds.has(submissionId)) {
    rejudgeRequested.add(submissionId);
    return;
  }
  if (queuedIds.has(submissionId)) return;
  queuedIds.add(submissionId);
  judgeQueue.push(submissionId);
  pumpQueue();
}

// 服务重启后恢复中断的判题任务（内存队列随进程死亡而丢失，需重置中断态重新入队）
// R9-4: 纳入 pending_review——AI 安全审查属建议性（正常路径是放行后重新判题），
// 若进程在审查窗口内崩溃重启，该行必须重新入队判题，否则提交锁让该用户永久无法再提交。
function recoverInterruptedSubmissions() {
  const rows = db.prepare("SELECT id FROM submissions WHERE status IN ('pending','pending_review','pending_rejudge','running','compiling','judging')").all();
  for (const r of rows) {
    try {
      db.prepare('DELETE FROM submission_details WHERE submission_id = ?').run(r.id);
    } catch (e) {
      // 残留上一轮详情会出现重复/串行的测试点行，必须可见
      logWarn('QUEUE', `清理旧评测详情失败 (submission ${r.id}): ${e && e.message}`);
    }
    enqueueSubmission(r.id);
  }
  return rows.length;
}

module.exports = { enqueueSubmission, recoverInterruptedSubmissions };
