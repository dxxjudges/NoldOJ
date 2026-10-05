// repositories/favorites.js —— 题目收藏域数据访问层（P1：db.prepare 不再散落在路由层）
const db = require('../database/db');

// 隐藏开关读取（收藏列表接口的隐私校验）
function getUserFavoritesPrivacy(targetId) {
  return db.prepare('SELECT id, hide_favorites FROM users WHERE id = ?').get(targetId);
}

function countByUser(userId) {
  return db.prepare('SELECT COUNT(*) as c FROM user_favorites WHERE user_id = ?').get(userId).c;
}

function listByUser(viewerId, targetId, limit, offset) {
  return db.prepare(`
    SELECT f.problem_id, p.title, p.difficulty, p.problem_type, f.created_at,
      EXISTS(SELECT 1 FROM submissions s WHERE s.problem_id = p.id AND s.user_id = ? AND s.status = 'accepted') as solved
    FROM user_favorites f
    JOIN problems p ON p.id = f.problem_id
    WHERE f.user_id = ?
    ORDER BY f.created_at DESC
    LIMIT ? OFFSET ?
  `).all(viewerId, targetId, limit, offset);
}

// R9-10: IN 占位符数量上限由路由层截断后传入
function listFavoriteStatus(userId, ids) {
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`SELECT problem_id FROM user_favorites WHERE user_id = ? AND problem_id IN (${placeholders})`)
    .all(userId, ...ids);
}

function problemExists(problemId) {
  return db.prepare('SELECT id FROM problems WHERE id = ?').get(problemId);
}

function insert(userId, problemId) {
  db.prepare('INSERT OR IGNORE INTO user_favorites (user_id, problem_id) VALUES (?, ?)').run(userId, problemId);
}

function remove(userId, problemId) {
  db.prepare('DELETE FROM user_favorites WHERE user_id = ? AND problem_id = ?').run(userId, problemId);
}

module.exports = { getUserFavoritesPrivacy, countByUser, listByUser, listFavoriteStatus, problemExists, insert, remove };
