// repositories/status.js —— 系统运行状态数据访问层（P1：db.prepare 不再散落在路由层）
const db = require('../database/db');

function getSystemCounts() {
  return {
    users: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    problems: db.prepare('SELECT COUNT(*) as c FROM problems').get().c,
    submissions: db.prepare('SELECT COUNT(*) as c FROM submissions WHERE exam_id IS NULL').get().c,
    testCases: db.prepare('SELECT COUNT(*) as c FROM test_cases').get().c,
    // 安全审核队列不滤试卷提交：漏审比多审代价高
    pendingReview: db.prepare("SELECT COUNT(*) as c FROM submissions WHERE status = 'pending_review'").get().c
  };
}

// 判题队列：最近处理中的提交
function getJudgeQueue() {
  return db.prepare(`
    SELECT id, user_id, problem_id, language, status, created_at
    FROM submissions
    WHERE status IN ('pending','running','compiling','judging','pending_rejudge')
    ORDER BY id DESC LIMIT 20
  `).all();
}

function getTodayStats(today) {
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM submissions WHERE date(created_at) = ? AND exam_id IS NULL) as today_submits,
      (SELECT COUNT(*) FROM submissions WHERE date(created_at) = ? AND status = 'accepted' AND exam_id IS NULL) as today_ac,
      (SELECT COUNT(*) FROM users WHERE date(created_at) = ?) as today_users
  `).get(today, today, today);
}

module.exports = { getSystemCounts, getJudgeQueue, getTodayStats };
