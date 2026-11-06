// repositories/messages.js —— 私信数据访问层
// 一对一私信：每条消息一行，删除按「发送方/接收方」分别软删，双方都删后物理清理。
const db = require('../database/db');

function insert(senderId, receiverId, content) {
  return db.prepare(`
    INSERT INTO messages (sender_id, receiver_id, content)
    VALUES (?, ?, ?)
  `).run(senderId, receiverId, content);
}

function getById(id) {
  return db.prepare(`
    SELECT m.*,
      su.username AS sender_username, su.nickname AS sender_nickname,
      ru.username AS receiver_username, ru.nickname AS receiver_nickname
    FROM messages m
    JOIN users su ON su.id = m.sender_id
    JOIN users ru ON ru.id = m.receiver_id
    WHERE m.id = ?
  `).get(id);
}

// 会话列表：每位对端取「当前用户未删除的最新一条」作为摘要，并带该对端的未读数
function listConversations(userId) {
  const pairs = db.prepare(`
    SELECT CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END AS peer_id,
      MAX(id) AS last_id
    FROM messages
    WHERE (sender_id = ? OR receiver_id = ?)
      AND NOT (sender_id = ? AND deleted_by_sender = 1)
      AND NOT (receiver_id = ? AND deleted_by_receiver = 1)
    GROUP BY peer_id
    ORDER BY last_id DESC
  `).all(userId, userId, userId, userId, userId);
  if (pairs.length === 0) return [];

  const lastIds = pairs.map(p => p.last_id);
  const lastRows = db.prepare(`
    SELECT * FROM messages WHERE id IN (${lastIds.map(() => '?').join(',')})
  `).all(...lastIds);
  const lastMap = new Map(lastRows.map(r => [r.id, r]));

  const peerIds = pairs.map(p => p.peer_id);
  const peers = db.prepare(`
    SELECT id, username, nickname, role FROM users WHERE id IN (${peerIds.map(() => '?').join(',')})
  `).all(...peerIds);
  const peerMap = new Map(peers.map(u => [u.id, u]));

  const unreadRows = db.prepare(`
    SELECT sender_id AS peer_id, COUNT(*) AS c FROM messages
    WHERE receiver_id = ? AND is_read = 0 AND deleted_by_receiver = 0
    GROUP BY sender_id
  `).all(userId);
  const unreadMap = new Map(unreadRows.map(r => [r.peer_id, r.c]));

  return pairs.map(p => {
    const last = lastMap.get(p.last_id) || {};
    const peer = peerMap.get(p.peer_id) || {};
    return {
      peer: {
        id: p.peer_id,
        username: peer.username || '',
        nickname: peer.nickname || '',
        role: peer.role || 'user'
      },
      last_message: {
        id: p.last_id,
        sender_id: last.sender_id,
        receiver_id: last.receiver_id,
        content: last.content || '',
        is_read: last.is_read || 0,
        created_at: last.created_at || null
      },
      unread: unreadMap.get(p.peer_id) || 0
    };
  });
}

// 与某用户的历史消息：按 id 倒序取最近 limit 条后还原为升序；beforeId 用于向上翻页
function history(userId, peerId, { limit = 30, beforeId = null } = {}) {
  let sql = `
    SELECT * FROM messages
    WHERE ((sender_id = ? AND receiver_id = ? AND deleted_by_sender = 0)
        OR (sender_id = ? AND receiver_id = ? AND deleted_by_receiver = 0))`;
  const params = [userId, peerId, peerId, userId];
  if (beforeId) {
    sql += ' AND id < ?';
    params.push(beforeId);
  }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params).reverse();
}

function unreadTotal(userId) {
  return db.prepare(`
    SELECT COUNT(*) AS c FROM messages
    WHERE receiver_id = ? AND is_read = 0 AND deleted_by_receiver = 0
  `).get(userId).c;
}

function unreadFrom(userId, peerId) {
  return db.prepare(`
    SELECT COUNT(*) AS c FROM messages
    WHERE receiver_id = ? AND sender_id = ? AND is_read = 0 AND deleted_by_receiver = 0
  `).get(userId, peerId).c;
}

function markConversationRead(userId, peerId) {
  return db.prepare(`
    UPDATE messages SET is_read = 1
    WHERE receiver_id = ? AND sender_id = ? AND is_read = 0 AND deleted_by_receiver = 0
  `).run(userId, peerId);
}

function markRead(id, userId) {
  return db.prepare('UPDATE messages SET is_read = 1 WHERE id = ? AND receiver_id = ?').run(id, userId);
}

// 软删：只删自己这一侧；双方都删掉后清理物理行
function softDelete(id, userId) {
  const row = db.prepare('SELECT sender_id, receiver_id FROM messages WHERE id = ?').get(id);
  if (!row) return false;
  if (row.sender_id === userId) {
    db.prepare('UPDATE messages SET deleted_by_sender = 1 WHERE id = ?').run(id);
  } else if (row.receiver_id === userId) {
    db.prepare('UPDATE messages SET deleted_by_receiver = 1 WHERE id = ?').run(id);
  } else {
    return false;
  }
  db.prepare('DELETE FROM messages WHERE id = ? AND deleted_by_sender = 1 AND deleted_by_receiver = 1').run(id);
  return true;
}

module.exports = {
  insert,
  getById,
  listConversations,
  history,
  unreadTotal,
  unreadFrom,
  markConversationRead,
  markRead,
  softDelete
};
