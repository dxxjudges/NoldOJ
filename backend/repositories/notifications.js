// repositories/notifications.js —— 通知中心数据访问层
const db = require('../database/db');

function insert(userId, type, title, content, link) {
  return db.prepare(`
    INSERT INTO notifications (user_id, type, title, content, link)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, type || 'system', title, content || '', link || '');
}

// 全体用户批量通知（公告、系统消息）：一次 INSERT ... SELECT，避免逐用户循环
function insertAllUsers(type, title, content, link) {
  return db.prepare(`
    INSERT INTO notifications (user_id, type, title, content, link)
    SELECT id, ?, ?, ?, ? FROM users
  `).run(type || 'system', title, content || '', link || '');
}

function getById(id, userId) {
  return db.prepare('SELECT * FROM notifications WHERE id = ? AND user_id = ?').get(id, userId);
}

function count(userId, unreadOnly) {
  const where = unreadOnly ? 'AND is_read = 0' : '';
  return db.prepare(`SELECT COUNT(*) as c FROM notifications WHERE user_id = ? ${where}`).get(userId).c;
}

function list(userId, limit, offset, unreadOnly) {
  const where = unreadOnly ? 'AND is_read = 0' : '';
  return db.prepare(`
    SELECT * FROM notifications
    WHERE user_id = ? ${where}
    ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(userId, limit, offset);
}

function unreadCount(userId) {
  return db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_read = 0').get(userId).c;
}

function markRead(id, userId) {
  return db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(id, userId);
}

function markAllRead(userId) {
  return db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(userId);
}

function remove(id, userId) {
  return db.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?').run(id, userId);
}

module.exports = { insert, insertAllUsers, getById, count, list, unreadCount, markRead, markAllRead, remove };
