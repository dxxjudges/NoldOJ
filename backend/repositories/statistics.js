// repositories/statistics.js —— 个人数据看板数据访问层（P1：db.prepare 不再散落在路由层）
const db = require('../database/db');

// 提交日历：最近 365 天，每天提交数 + AC 数
function getCalendarRows(uid, startStr) {
  return db.prepare(`
    SELECT substr(created_at, 1, 10) as d,
      COUNT(*) as submits,
      SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) as acs
    FROM submissions WHERE user_id = ? AND exam_id IS NULL AND created_at >= ?
    GROUP BY substr(created_at, 1, 10)
  `).all(uid, startStr);
}

// 语言分布：按语言统计提交数与 AC 数
function getLanguageRows(uid) {
  return db.prepare(`
    SELECT language,
      COUNT(*) as submits,
      SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) as acs
    FROM submissions WHERE user_id = ? AND exam_id IS NULL
    GROUP BY language ORDER BY submits DESC
  `).all(uid);
}

// 难度分布：AC 的题目按难度（去重）分布
function getDifficultyRows(uid) {
  return db.prepare(`
    SELECT p.difficulty, COUNT(*) as c
    FROM (SELECT DISTINCT problem_id FROM submissions WHERE user_id = ? AND exam_id IS NULL AND status = 'accepted') ac
    JOIN problems p ON p.id = ac.problem_id
    GROUP BY p.difficulty ORDER BY p.difficulty
  `).all(uid);
}

// 概览计数
function getOverview(uid) {
  return {
    totalAccepted: db.prepare("SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND exam_id IS NULL AND status = 'accepted'").get(uid).c,
    totalSubmits: db.prepare('SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND exam_id IS NULL').get(uid).c,
    totalProblems: db.prepare("SELECT COUNT(DISTINCT problem_id) as c FROM submissions WHERE user_id = ? AND exam_id IS NULL AND status = 'accepted'").get(uid).c,
    totalFavorites: db.prepare('SELECT COUNT(*) as c FROM user_favorites WHERE user_id = ?').get(uid).c,
    achievements: db.prepare('SELECT COUNT(*) as c FROM user_achievements WHERE user_id = ?').get(uid).c
  };
}

// 隐藏开关读取（看板接口的隐私校验）
function getUserDashboardPrivacy(targetId) {
  return db.prepare('SELECT id, hide_dashboard FROM users WHERE id = ?').get(targetId);
}

// 提交云图：按题目统计提交次数，用于词云渲染
// visibilityFilter（用户组维度）由路由层注入：utils/access.js 生成 { sql, params }，别名 p；
// 缺省不追加条件，旧调用方行为不变（staff 的条件为空串，同样不过滤）
function getWordcloud(filters) {
  const vis = filters && filters.visibilityFilter;
  let where = 'WHERE p.is_public = 1 AND p.is_hidden = 0';
  const params = [];
  if (vis && vis.sql) {
    where += ` AND (${vis.sql})`;
    params.push(...(vis.params || []));
  }
  return db.prepare(`
    SELECT p.id, p.title,
           COUNT(s.id) as submission_count,
           SUM(CASE WHEN s.status = 'accepted' THEN 1 ELSE 0 END) as accepted_count
    FROM problems p
    JOIN submissions s ON s.problem_id = p.id
    ${where}
    GROUP BY p.id
    ORDER BY submission_count DESC
    LIMIT 200
  `).all(...params);
}

module.exports = { getCalendarRows, getLanguageRows, getDifficultyRows, getOverview, getUserDashboardPrivacy, getWordcloud };
