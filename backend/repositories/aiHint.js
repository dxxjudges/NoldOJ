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

// 比赛进行中禁止 AI 提示：返回用户参与的、包含该题的进行中比赛（无则 null）。
// 真实比赛看 contest_participants + 比赛时间窗；虚拟比赛看该用户自己的 virtual_contests 时间窗。
function findActiveContest(userId, problemId) {
  const now = Date.now();
  const contests = db.prepare(`
    SELECT c.id, c.title, c.start_time, c.end_time FROM contest_problems cp
    JOIN contests c ON c.id = cp.contest_id
    WHERE cp.problem_id = ?
  `).all(problemId);
  for (const c of contests) {
    const s = new Date(c.start_time).getTime();
    const e = new Date(c.end_time).getTime();
    if (Number.isNaN(s) || Number.isNaN(e) || now < s || now > e) continue;
    const joined = db.prepare('SELECT 1 FROM contest_participants WHERE contest_id = ? AND user_id = ?').get(c.id, userId);
    if (joined) return { contest_id: c.id, title: c.title, end_time: c.end_time, virtual: false };
  }
  const virtuals = db.prepare(`
    SELECT vc.contest_id, c.title, vc.end_time FROM virtual_contests vc
    JOIN contests c ON c.id = vc.contest_id
    JOIN contest_problems cp ON cp.contest_id = vc.contest_id
    WHERE vc.user_id = ? AND cp.problem_id = ? AND vc.status = 'running'
  `).all(userId, problemId);
  for (const v of virtuals) {
    const e = new Date(v.end_time).getTime();
    if (!Number.isNaN(e) && now <= e) return { contest_id: v.contest_id, title: v.title, end_time: v.end_time, virtual: true };
  }
  return null;
}

module.exports = { getProblem, countFailedAttempts, getLastSubmission, findActiveContest };
