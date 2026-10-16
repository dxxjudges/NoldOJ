// repositories/problem-sets.js —— 题单域数据访问层（P1：db.prepare 不再散落在路由层）
const db = require('../database/db');

function countList(where, params) {
  return db.prepare(`SELECT COUNT(*) as c FROM problem_sets ps WHERE ${where}`).get(...params).c;
}

function list(where, params, limit, offset) {
  return db.prepare(`
    SELECT ps.id, ps.title, ps.description, ps.creator_id, ps.is_public, ps.type, ps.created_at,
           u.username as creator_name,
           (SELECT COUNT(*) FROM problem_set_items WHERE set_id = ps.id) as problem_count
    FROM problem_sets ps LEFT JOIN users u ON ps.creator_id = u.id
    WHERE ${where}
    ORDER BY ps.id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
}

// 若用户已登录，附带每题单进度（批量查询，避免 N+1 DoS）
function countSolvedBySets(userId, setIds) {
  const placeholders = setIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT set_id, COUNT(*) as c FROM problem_set_progress
    WHERE user_id = ? AND set_id IN (${placeholders}) AND solved = 1
    GROUP BY set_id
  `).all(userId, ...setIds);
}

// 我的题单（公开 + 个人私有）
function listMine(userId) {
  return db.prepare(`
    SELECT ps.id, ps.title, ps.description, ps.creator_id, ps.is_public, ps.type, ps.created_at,
           (SELECT COUNT(*) FROM problem_set_items WHERE set_id = ps.id) as problem_count
    FROM problem_sets ps
    WHERE ps.creator_id = ?
    ORDER BY ps.id DESC
  `).all(userId);
}

function getWithCreator(id) {
  return db.prepare(`
    SELECT ps.*, u.username as creator_name
    FROM problem_sets ps LEFT JOIN users u ON ps.creator_id = u.id
    WHERE ps.id = ?
  `).get(id);
}

function listProblems(viewerId, setId) {
  return db.prepare(`
    SELECT psi.sort_order, p.id, p.title, p.difficulty,
      EXISTS(SELECT 1 FROM submissions sub WHERE sub.problem_id = p.id AND sub.user_id = ? AND sub.status = 'accepted') as user_accepted
    FROM problem_set_items psi
    JOIN problems p ON psi.problem_id = p.id
    WHERE psi.set_id = ?
    ORDER BY psi.sort_order
  `).all(viewerId, setId);
}

function get(id) {
  return db.prepare('SELECT id FROM problem_sets WHERE id = ?').get(id);
}

function getRow(id) {
  return db.prepare('SELECT * FROM problem_sets WHERE id = ?').get(id);
}

function listProgress(userId, setId) {
  return db.prepare(`
    SELECT psi.problem_id, COALESCE(p.solved, 0) as solved, p.solved_at
    FROM problem_set_items psi
    LEFT JOIN problem_set_progress p ON p.set_id = psi.set_id AND p.problem_id = psi.problem_id AND p.user_id = ?
    WHERE psi.set_id = ?
    ORDER BY psi.sort_order
  `).all(userId, setId);
}

// 个人题单强制私有（id 由 findNextId 分配）
function createPersonalSet(title, description, creatorId, problemIds) {
  const setId = db.findNextId('problem_sets');
  db.prepare(
    "INSERT INTO problem_sets (id, title, description, creator_id, is_public, type) VALUES (?, ?, ?, ?, 0, 'personal')"
  ).run(setId, title, description, creatorId);
  if (Array.isArray(problemIds) && problemIds.length > 0) {
    const ins = db.prepare('INSERT OR IGNORE INTO problem_set_items (set_id, problem_id, sort_order) VALUES (?, ?, ?)');
    problemIds.forEach((pid, idx) => ins.run(setId, pid, idx));
  }
  return getRow(setId);
}

function createPublicSet(title, description, creatorId, isPublic, problemIds) {
  const setId = db.findNextId('problem_sets');
  db.prepare(
    "INSERT INTO problem_sets (id, title, description, creator_id, is_public, type) VALUES (?, ?, ?, ?, ?, 'public')"
  ).run(setId, title, description, creatorId, isPublic ? 1 : 0);
  if (Array.isArray(problemIds) && problemIds.length > 0) {
    const ins = db.prepare('INSERT OR IGNORE INTO problem_set_items (set_id, problem_id, sort_order) VALUES (?, ?, ?)');
    problemIds.forEach((pid, idx) => ins.run(setId, pid, idx));
  }
  return getRow(setId);
}

// 动态 SET 片段由路由层 buildUpdates 生成，此处整体拼接执行
function update(id, u) {
  db.prepare(`UPDATE problem_sets SET ${u.clause} WHERE id = ?`).run(...u.values, id);
}

// 实体可见性（用户组维度）：仅由 routes/_visibility.js 的 PUT 写入，值受 CHECK 约束
// （problem_sets 表无 updated_at 列，故不触碰更新时间）
function setVisibility(id, visibility) {
  db.prepare('UPDATE problem_sets SET visibility = ? WHERE id = ?').run(visibility, id);
}

function findMissingProblemIds(ids) {
  const existsStmt = db.prepare('SELECT 1 FROM problems WHERE id = ?');
  return ids.filter(id => !existsStmt.get(id));
}

// 覆盖式设置题目列表：DELETE + 批量 INSERT 必须原子
function replaceProblems(setId, ids) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM problem_set_items WHERE set_id = ?').run(setId);
    const ins = db.prepare('INSERT OR IGNORE INTO problem_set_items (set_id, problem_id, sort_order) VALUES (?, ?, ?)');
    ids.forEach((pid, idx) => ins.run(setId, pid, idx));
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原始错误（外层已 rethrow） */ }
    throw e;
  }
}

function deleteSet(setId) {
  db.prepare('DELETE FROM problem_set_progress WHERE set_id = ?').run(setId);
  db.prepare('DELETE FROM problem_set_items WHERE set_id = ?').run(setId);
  db.prepare('DELETE FROM problem_sets WHERE id = ?').run(setId);
}

function getSetItem(setId, problemId) {
  return db.prepare('SELECT problem_id FROM problem_set_items WHERE set_id = ? AND problem_id = ?').get(setId, problemId);
}

function userHasAccepted(userId, problemId) {
  return db.prepare("SELECT id FROM submissions WHERE user_id = ? AND problem_id = ? AND status = 'accepted' LIMIT 1").get(userId, problemId);
}

function recordProgress(userId, setId, problemId) {
  db.prepare(`
    INSERT INTO problem_set_progress (user_id, set_id, problem_id, solved, solved_at)
    VALUES (?, ?, ?, 1, datetime('now'))
    ON CONFLICT(user_id, set_id, problem_id) DO UPDATE SET solved = 1, solved_at = datetime('now')
  `).run(userId, setId, problemId);
}

module.exports = {
  countList, list, countSolvedBySets, listMine, getWithCreator, listProblems,
  get, getRow, listProgress, createPersonalSet, createPublicSet, update, setVisibility,
  findMissingProblemIds, replaceProblems, deleteSet, getSetItem, userHasAccepted, recordProgress
};
