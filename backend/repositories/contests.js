// repositories/contests.js —— 比赛域数据访问层（P1：db.prepare 不再散落在路由层）
// 含删比赛三连删事务
const db = require('../database/db');

function countList(where, params) {
  return db.prepare(`SELECT COUNT(*) as c FROM contests c ${where}`).get(...params).c;
}

function list(where, params, limit, offset) {
  return db.prepare(`
    SELECT c.*, u.username as creator_name,
      (SELECT COUNT(*) FROM contest_problems WHERE contest_id = c.id) as problem_count
    FROM contests c LEFT JOIN users u ON c.created_by = u.id
    ${where}
    ORDER BY c.id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
}

function getWithCreator(id) {
  return db.prepare('SELECT c.*, u.username as creator_name FROM contests c LEFT JOIN users u ON c.created_by = u.id WHERE c.id = ?').get(id);
}

function get(id) {
  return db.prepare('SELECT * FROM contests WHERE id = ?').get(id);
}

function findContest(id) {
  return db.prepare('SELECT id FROM contests WHERE id = ?').get(id);
}

function listStaffProblems(contestId) {
  return db.prepare(`
    SELECT cp.sort_order, cp.alias, p.id, p.title, p.time_limit, p.memory_limit, p.is_public
    FROM contest_problems cp JOIN problems p ON cp.problem_id = p.id
    WHERE cp.contest_id = ? ORDER BY cp.sort_order
  `).all(contestId);
}

// hiddenFilter 片段（' AND p.is_hidden = 0' 或空串）由路由层按角色计算
function listProblems(contestId, hiddenFilter) {
  return db.prepare(`
      SELECT cp.sort_order, cp.alias, p.id, p.title, p.time_limit, p.memory_limit
      FROM contest_problems cp JOIN problems p ON cp.problem_id = p.id
      WHERE cp.contest_id = ?${hiddenFilter} ORDER BY cp.sort_order
    `).all(contestId);
}

function countParticipants(contestId) {
  return db.prepare('SELECT COUNT(*) as c FROM contest_participants WHERE contest_id = ?').get(contestId).c;
}

function insert(title, description, start_time, end_time, is_virtual, freeze_minutes, is_hidden, created_by) {
  return db.prepare('INSERT INTO contests (title, description, start_time, end_time, is_virtual, freeze_minutes, is_hidden, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    title, description, start_time, end_time, is_virtual, freeze_minutes, is_hidden, created_by
  );
}

// 动态 SET 片段由路由层 buildUpdates 生成，此处整体拼接执行
function update(id, u) {
  db.prepare(`UPDATE contests SET ${u.clause} WHERE id = ?`).run(...u.values, id);
}

function findProblem(id) {
  return db.prepare('SELECT id FROM problems WHERE id = ?').get(id);
}

function findContestProblem(contestId, problemId) {
  return db.prepare('SELECT id FROM contest_problems WHERE contest_id = ? AND problem_id = ?').get(contestId, problemId);
}

function maxSortOrder(contestId) {
  return db.prepare('SELECT MAX(sort_order) as m FROM contest_problems WHERE contest_id = ?').get(contestId)?.m || 0;
}

function insertContestProblem(contestId, problemId, sort_order, alias) {
  db.prepare('INSERT INTO contest_problems (contest_id, problem_id, sort_order, alias) VALUES (?, ?, ?, ?)').run(contestId, problemId, sort_order, alias);
}

function deleteContestProblem(contestId, problemId) {
  db.prepare('DELETE FROM contest_problems WHERE contest_id = ? AND problem_id = ?').run(contestId, problemId);
}

// 三张表同生共死：中途失败不得留下"题与人已删、比赛行还在"的残缺比赛
function deleteCascade(contestId) {
  try {
    db.exec('BEGIN');
    db.exec('PRAGMA defer_foreign_keys = ON');
    db.prepare('DELETE FROM contest_problems WHERE contest_id = ?').run(contestId);
    db.prepare('DELETE FROM contest_participants WHERE contest_id = ?').run(contestId);
    db.prepare('DELETE FROM contests WHERE id = ?').run(contestId);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原始错误（外层已 rethrow） */ }
    throw err;
  }
}

function getUser(id) {
  return db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
}

function findParticipant(contestId, userId) {
  return db.prepare('SELECT id FROM contest_participants WHERE contest_id = ? AND user_id = ?').get(contestId, userId);
}

function inviteParticipant(contestId, userId, invitedBy) {
  db.prepare('INSERT INTO contest_participants (contest_id, user_id, invited_by) VALUES (?, ?, ?)').run(contestId, userId, invitedBy);
}

function joinParticipant(contestId, userId) {
  db.prepare('INSERT INTO contest_participants (contest_id, user_id) VALUES (?, ?)').run(contestId, userId);
}

function listParticipants(contestId) {
  return db.prepare(`
    SELECT cp.user_id, u.username, u.nickname, u.role, cp.joined_at, inv.username as invited_by_name
    FROM contest_participants cp
    LEFT JOIN users u ON cp.user_id = u.id
    LEFT JOIN users inv ON cp.invited_by = inv.id
    WHERE cp.contest_id = ? ORDER BY cp.joined_at
  `).all(contestId);
}

function removeParticipant(contestId, userId) {
  db.prepare('DELETE FROM contest_participants WHERE contest_id = ? AND user_id = ?').run(contestId, userId);
}

// timeFilter 片段与 params（含 problemIds）由路由层按冻结/时间窗拼好后传入
function getLeaderboardSubmissions(problemIds, timeFilter, params) {
  const placeholders = problemIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT s.user_id, s.problem_id, s.score, s.time_used, s.status, u.username, u.nickname
    FROM submissions s
    LEFT JOIN users u ON s.user_id = u.id
    WHERE s.problem_id IN (${placeholders})
      AND s.status IN ('accepted', 'wrong_answer', 'time_limit_exceeded', 'memory_limit_exceeded', 'runtime_error', 'skipped')
      ${timeFilter}
  `).all(...params);
}

function unfreeze(id, unfrozenAt) {
  db.prepare("UPDATE contests SET unfrozen = 1, unfrozen_at = ? WHERE id = ?").run(unfrozenAt, id);
}

function listAnnouncements(contestId) {
  return db.prepare(`
    SELECT a.id, a.title, a.content, a.pinned, a.author_id, a.created_at, a.updated_at,
           u.username, u.nickname
    FROM announcements a LEFT JOIN users u ON a.author_id = u.id
    WHERE a.type = 'contest' AND a.contest_id = ?
    ORDER BY a.pinned DESC, a.id DESC
  `).all(contestId);
}

function listProblemIds(contestId) {
  return db.prepare('SELECT problem_id FROM contest_problems WHERE contest_id = ?').all(contestId);
}

function countDiscussions(contestId) {
  return db.prepare('SELECT COUNT(*) as c FROM discussions WHERE contest_id = ?').get(contestId).c;
}

function listDiscussions(contestId, limit, offset) {
  return db.prepare(`
    SELECT d.id, d.title, d.is_official, d.pinned, d.locked, d.created_at,
           u.username, u.nickname, u.role,
           (SELECT COUNT(*) FROM discussion_replies WHERE discussion_id = d.id) as reply_count
    FROM discussions d LEFT JOIN users u ON d.author_id = u.id
    WHERE d.contest_id = ?
    ORDER BY d.pinned DESC, d.is_official DESC, d.id DESC
    LIMIT ? OFFSET ?
  `).all(contestId, limit, offset);
}

module.exports = {
  countList, list, getWithCreator, get, findContest, listStaffProblems, listProblems, countParticipants,
  insert, update, findProblem, findContestProblem, maxSortOrder, insertContestProblem, deleteContestProblem,
  deleteCascade, getUser, findParticipant, inviteParticipant, joinParticipant, listParticipants, removeParticipant,
  getLeaderboardSubmissions, unfreeze, listAnnouncements, listProblemIds, countDiscussions, listDiscussions
};
