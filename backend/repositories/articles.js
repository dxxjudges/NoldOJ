// repositories/articles.js —— 文章/题解域数据访问层（P1：db.prepare 不再散落在路由层）
const db = require('../database/db');

function countList(where, params) {
  return db.prepare(`SELECT COUNT(*) as c FROM articles a ${where}`).get(...params).c;
}

function list(where, params, limit, offset) {
  return db.prepare(`
    SELECT a.id, a.title, a.author_id, a.provider, a.is_published, a.is_hidden, a.created_at, a.updated_at,
           u.username, u.nickname
    FROM articles a LEFT JOIN users u ON a.author_id = u.id
    ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
}

function getWithAuthor(id) {
  return db.prepare(`
    SELECT a.*, u.username, u.nickname
    FROM articles a LEFT JOIN users u ON a.author_id = u.id
    WHERE a.id = ?
  `).get(id);
}

function get(id) {
  return db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
}

function insert(title, content, author_id, provider, is_published, is_hidden) {
  return db.prepare('INSERT INTO articles (title, content, author_id, provider, is_published, is_hidden) VALUES (?, ?, ?, ?, ?, ?)').run(
    title, content, author_id, provider, is_published, is_hidden
  );
}

// 动态 SET 片段由路由层 buildUpdates 生成，此处整体拼接执行
function update(id, u) {
  db.prepare(`UPDATE articles SET ${u.clause} WHERE id = ?`).run(...u.values, id);
}

function deleteSolutions(articleId) {
  db.prepare('DELETE FROM problem_solutions WHERE article_id = ?').run(articleId);
}

function remove(id) {
  db.prepare('DELETE FROM articles WHERE id = ?').run(id);
}

module.exports = { countList, list, getWithAuthor, get, insert, update, deleteSolutions, remove };
