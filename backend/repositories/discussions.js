// repositories/discussions.js —— 讨论区数据访问层（P1：db.prepare 不再散落在路由层）
const db = require('../database/db');

function getWithAuthor(id) {
  return db.prepare(`
    SELECT d.*, u.username, u.nickname, u.role
    FROM discussions d LEFT JOIN users u ON d.author_id = u.id
    WHERE d.id = ?
  `).get(id);
}

function getContestMeta(id) {
  return db.prepare('SELECT is_hidden, end_time FROM contests WHERE id = ?').get(id);
}

// 一级回复（R9-10: 加 LIMIT 防全量物化撑爆内存）
function listTopReplies(discussionId) {
  return db.prepare(`
    SELECT r.id, r.discussion_id, r.parent_id, r.content, r.created_at,
           u.username, u.nickname, u.role, u.id as user_id
    FROM discussion_replies r LEFT JOIN users u ON r.author_id = u.id
    WHERE r.discussion_id = ? AND r.parent_id IS NULL
    ORDER BY r.id ASC
    LIMIT 1000
  `).all(discussionId);
}

// 二级回复（R9-10: IN 占位符数量上限由路由层截断后传入）
function listChildReplies(replyIds) {
  const placeholders = replyIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT r.id, r.discussion_id, r.parent_id, r.content, r.created_at,
           u.username, u.nickname, u.role, u.id as user_id
    FROM discussion_replies r LEFT JOIN users u ON r.author_id = u.id
    WHERE r.parent_id IN (${placeholders})
    ORDER BY r.id ASC
  `).all(...replyIds);
}

function problemExists(id) {
  return db.prepare('SELECT id FROM problems WHERE id = ?').get(id);
}

function contestExists(id) {
  return db.prepare('SELECT id FROM contests WHERE id = ?').get(id);
}

function getContestHidden(id) {
  return db.prepare('SELECT is_hidden FROM contests WHERE id = ?').get(id);
}

function getContestEndTime(id) {
  return db.prepare('SELECT end_time FROM contests WHERE id = ?').get(id);
}

function get(id) {
  return db.prepare('SELECT * FROM discussions WHERE id = ?').get(id);
}

function insert(problem_id, contest_id, title, content, author_id, is_official) {
  return db.prepare(
    'INSERT INTO discussions (problem_id, contest_id, title, content, author_id, is_official) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(problem_id, contest_id, title, content, author_id, is_official);
}

// 动态 SET 片段由路由层 buildUpdates 生成，此处整体拼接执行
function update(id, u) {
  db.prepare(`UPDATE discussions SET ${u.clause} WHERE id = ?`).run(...u.values, id);
}

function deleteReplies(discussionId) {
  db.prepare('DELETE FROM discussion_replies WHERE discussion_id = ?').run(discussionId);
}

function remove(id) {
  db.prepare('DELETE FROM discussions WHERE id = ?').run(id);
}

function getParentReply(parentId, discussionId) {
  return db.prepare('SELECT id, parent_id FROM discussion_replies WHERE id = ? AND discussion_id = ?').get(parentId, discussionId);
}

function insertReply(discussion_id, parent_id, content, author_id) {
  return db.prepare(
    'INSERT INTO discussion_replies (discussion_id, parent_id, content, author_id) VALUES (?, ?, ?, ?)'
  ).run(discussion_id, parent_id, content, author_id);
}

function getReplyWithAuthor(id) {
  return db.prepare(`
    SELECT r.*, u.username, u.nickname, u.role
    FROM discussion_replies r LEFT JOIN users u ON r.author_id = u.id
    WHERE r.id = ?
  `).get(id);
}

function getReply(id, discussionId) {
  return db.prepare('SELECT * FROM discussion_replies WHERE id = ? AND discussion_id = ?').get(id, discussionId);
}

// 级联删除该回复的所有直接子回复
function deleteReplyChildren(replyId) {
  db.prepare('DELETE FROM discussion_replies WHERE parent_id = ?').run(replyId);
}

function deleteReply(id) {
  db.prepare('DELETE FROM discussion_replies WHERE id = ?').run(id);
}

function setPinned(id, pinned) {
  db.prepare("UPDATE discussions SET pinned = ?, updated_at = datetime('now') WHERE id = ?").run(pinned, id);
}

function setLocked(id, locked) {
  db.prepare("UPDATE discussions SET locked = ?, updated_at = datetime('now') WHERE id = ?").run(locked, id);
}

function setOfficial(id, is_official) {
  db.prepare("UPDATE discussions SET is_official = ?, updated_at = datetime('now') WHERE id = ?").run(is_official, id);
}

module.exports = {
  getWithAuthor, getContestMeta, listTopReplies, listChildReplies,
  problemExists, contestExists, getContestHidden, getContestEndTime,
  get, insert, update, deleteReplies, remove,
  getParentReply, insertReply, getReplyWithAuthor, getReply, deleteReplyChildren, deleteReply,
  setPinned, setLocked, setOfficial
};
