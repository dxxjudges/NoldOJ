// repositories/announcements.js —— 公告域数据访问层（P1：db.prepare 不再散落在路由层）
const db = require('../database/db');

function countList(where, params) {
  return db.prepare(`SELECT COUNT(*) as c FROM announcements a ${where}`).get(...params).c;
}

function list(where, params, limit, offset) {
  return db.prepare(`
    SELECT a.id, a.title, a.type, a.contest_id, a.pinned, a.author_id, a.created_at, a.updated_at,
           u.username, u.nickname
    FROM announcements a LEFT JOIN users u ON a.author_id = u.id
    ${where} ORDER BY a.pinned DESC, a.id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
}

function getWithAuthor(id) {
  return db.prepare(`
    SELECT a.*, u.username, u.nickname
    FROM announcements a LEFT JOIN users u ON a.author_id = u.id
    WHERE a.id = ?
  `).get(id);
}

function get(id) {
  return db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
}

function findContest(id) {
  return db.prepare('SELECT id FROM contests WHERE id = ?').get(id);
}

function getContestHidden(id) {
  return db.prepare('SELECT is_hidden FROM contests WHERE id = ?').get(id);
}

function insert(title, content, type, contest_id, pinned, author_id) {
  return db.prepare(
    'INSERT INTO announcements (title, content, type, contest_id, pinned, author_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(title, content, type, contest_id, pinned, author_id);
}

// 动态 SET 片段由路由层 buildUpdates 生成，此处整体拼接执行
function update(id, u) {
  db.prepare(`UPDATE announcements SET ${u.set.join(', ')} WHERE id = ?`).run(...u.values, id);
}

function remove(id) {
  db.prepare('DELETE FROM announcements WHERE id = ?').run(id);
}

module.exports = { countList, list, getWithAuthor, get, findContest, getContestHidden, insert, update, remove };
