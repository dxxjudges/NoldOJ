// repositories/virtual-contests.js —— 虚拟比赛域数据访问层（P1：db.prepare 不再散落在路由层）
const db = require('../database/db');

function getContest(id) {
  return db.prepare('SELECT * FROM contests WHERE id = ?').get(id);
}

function findForUser(contestId, userId) {
  return db.prepare('SELECT id FROM virtual_contests WHERE contest_id = ? AND user_id = ?').get(contestId, userId);
}

function insert(contest_id, user_id, start_time, end_time, status) {
  return db.prepare(
    'INSERT INTO virtual_contests (contest_id, user_id, start_time, end_time, status) VALUES (?, ?, ?, ?, ?)'
  ).run(contest_id, user_id, start_time, end_time, status);
}

function get(id) {
  return db.prepare('SELECT * FROM virtual_contests WHERE id = ?').get(id);
}

// ownership 校验并入 SQL，未授权与不存在统一返回 404，防 ID 枚举
function getOwned(id, userId) {
  return db.prepare(`
    SELECT vc.* FROM virtual_contests vc
    WHERE vc.id = ? AND (vc.user_id = ? OR EXISTS(
      SELECT 1 FROM users u WHERE u.id = ? AND u.role IN ('admin', 'su')
    ))
  `).get(id, userId, userId);
}

// 题目列表
function listContestProblems(contestId) {
  return db.prepare(`
    SELECT cp.problem_id, cp.alias, p.title, p.time_limit, p.memory_limit
    FROM contest_problems cp JOIN problems p ON cp.problem_id = p.id
    WHERE cp.contest_id = ?
    ORDER BY cp.alias
  `).all(contestId);
}

// 我在本次虚拟比赛的提交
function listSubmissions(vcId) {
  return db.prepare(`
    SELECT s.id, s.problem_id, s.status, s.score, s.time_used, s.created_at
    FROM submissions s
    WHERE s.virtual_contest_id = ?
    ORDER BY s.id DESC
  `).all(vcId);
}

function listContestProblemIds(contestId) {
  return db.prepare('SELECT problem_id FROM contest_problems WHERE contest_id = ?').all(contestId);
}

function listRankingSubmissions(vcId, problemIds) {
  const placeholders = problemIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT s.user_id, s.problem_id, s.score, s.time_used, s.status, u.username, u.nickname
    FROM submissions s LEFT JOIN users u ON s.user_id = u.id
    WHERE s.virtual_contest_id = ? AND s.problem_id IN (${placeholders})
      AND s.status IN ('accepted', 'wrong_answer', 'time_limit_exceeded', 'memory_limit_exceeded', 'runtime_error', 'skipped')
  `).all(vcId, ...problemIds);
}

function getUserBrief(userId) {
  return db.prepare('SELECT username, nickname FROM users WHERE id = ?').get(userId);
}

function listMine(userId) {
  return db.prepare(`
    SELECT vc.id, vc.contest_id, vc.start_time, vc.end_time, vc.status, vc.created_at,
           c.title as contest_title
    FROM virtual_contests vc LEFT JOIN contests c ON vc.contest_id = c.id
    WHERE vc.user_id = ?
    ORDER BY vc.id DESC
  `).all(userId);
}

module.exports = {
  getContest, findForUser, insert, get, getOwned, listContestProblems,
  listSubmissions, listContestProblemIds, listRankingSubmissions, getUserBrief, listMine
};
