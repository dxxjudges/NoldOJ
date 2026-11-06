// routes/messages.js —— 私信（会话列表 / 历史 / 发送 / 已读 / 删除）
const express = require('express');
const repo = require('../repositories/messages');
const usersRepo = require('../repositories/users');
const { sendMessage } = require('../services/messages');
const { requireAuth } = require('../middleware/auth');
const { parsePageLimit } = require('../utils/pagination');
const { createRateLimit } = require('../middleware/ratelimit');
const { sendNotFound, sendForbidden } = require('../utils/apiErrors');

const router = express.Router();

// 发信限流：每分钟最多 30 条，避免刷屏
const sendLimit = createRateLimit({ windowMs: 60000, max: 30 });

const MAX_CONTENT = 2000;

function sendInvalid(res, message) {
  return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message });
}

function resolvePeer(username) {
  const found = usersRepo.findUserByUsername(String(username || '').trim());
  return found ? usersRepo.get(found.id) : null;
}

// 会话列表：?page&size
router.get('/', requireAuth, (req, res) => {
  const { page = 1, size = 20 } = req.query;
  const { page: pageNum, limit, offset } = parsePageLimit(page, size, 20, 100);
  const all = repo.listConversations(req.user.id);
  res.json({
    total: all.length,
    page: pageNum,
    size: limit,
    unread: repo.unreadTotal(req.user.id),
    conversations: all.slice(offset, offset + limit)
  });
});

// 未读角标（导航信封图标用）；必须放在 /:username 之前，否则会被当成用户名
router.get('/unread-count', requireAuth, (req, res) => {
  res.json({ unread: repo.unreadTotal(req.user.id) });
});

// 与某用户的历史消息：?limit&before_id
router.get('/:username', requireAuth, (req, res) => {
  const peer = resolvePeer(req.params.username);
  if (!peer) {
    return sendNotFound(res, 'User not found.');
  }
  const beforeId = parseInt(req.query.before_id, 10);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  res.json({
    peer: { id: peer.id, username: peer.username || req.params.username, nickname: peer.nickname || '' },
    messages: repo.history(req.user.id, peer.id, {
      limit,
      beforeId: Number.isInteger(beforeId) && beforeId > 0 ? beforeId : null
    }),
    unread: repo.unreadFrom(req.user.id, peer.id)
  });
});

// 发送：body { to | receiver_id, content }
router.post('/', requireAuth, sendLimit, (req, res) => {
  const body = req.body || {};
  const content = String(body.content || '').trim();
  if (!content) {
    return sendInvalid(res, 'Message content is required.');
  }
  if (content.length > MAX_CONTENT) {
    return sendInvalid(res, `Message content exceeds ${MAX_CONTENT} characters.`);
  }

  let peer;
  if (body.to) {
    peer = resolvePeer(body.to);
  } else {
    const receiverId = parseInt(body.receiver_id, 10);
    if (!Number.isInteger(receiverId)) {
      return sendInvalid(res, 'Receiver is required.');
    }
    peer = usersRepo.get(receiverId);
  }
  if (!peer) {
    return sendNotFound(res, 'User not found.');
  }
  if (peer.id === req.user.id) {
    return sendInvalid(res, 'Cannot send a message to yourself.');
  }
  if (peer.banned) {
    return sendForbidden(res, '该用户已被封禁，无法接收私信。');
  }

  const row = sendMessage(req.user.id, peer.id, content);
  res.status(201).json({ message: 'Message sent.', data: row });
});

// 把与某用户的会话全部标记已读
router.put('/:username/read', requireAuth, (req, res) => {
  const peer = resolvePeer(req.params.username);
  if (!peer) {
    return sendNotFound(res, 'User not found.');
  }
  repo.markConversationRead(req.user.id, peer.id);
  res.json({ message: 'Conversation marked as read.', unread: repo.unreadTotal(req.user.id) });
});

// 删除单条（仅自己一侧）
router.delete('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return sendInvalid(res, 'Invalid message id.');
  }
  const row = repo.getById(id);
  if (!row || (row.sender_id !== req.user.id && row.receiver_id !== req.user.id)) {
    return sendNotFound(res, 'Message not found.');
  }
  repo.softDelete(id, req.user.id);
  res.json({ message: 'Message deleted.' });
});

module.exports = router;
