// repositories/aiHint.js —— AI 思路提示域数据访问层（P1：db.prepare 不再散落在路由层）
const db = require('../database/db');

function getProblem(id) {
  return db.prepare('SELECT * FROM problems WHERE id = ?').get(id);
}

// 计算用户对该题已提交但未 AC 的次数（用于门槛）
function countFailedAttempts(userId, problemId) {
  const row = db.prepare(`
    SELECT COUNT(*) as c FROM submissions
    WHERE user_id = ? AND problem_id = ? AND exam_id IS NULL
      AND status IN ('wrong_answer','time_limit_exceeded','memory_limit_exceeded','runtime_error','compile_error')
  `).get(userId, problemId);
  return row?.c || 0;
}

// 取用户最近一次提交（供 AI 参考）
function getLastSubmission(userId, problemId) {
  return db.prepare(`
    SELECT source_code, language FROM submissions
    WHERE user_id = ? AND problem_id = ? AND exam_id IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(userId, problemId);
}

module.exports = { getProblem, countFailedAttempts, getLastSubmission };
