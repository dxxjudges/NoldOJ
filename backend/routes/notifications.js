// routes/notifications.js —— 通知中心（本人通知的增删查改）
const express = require('express');
const repo = require('../repositories/notifications');
const { requireAuth } = require('../middleware/auth');
const { parsePageLimit } = require('../utils/pagination');
const { sendNotFound } = require('../utils/apiErrors');

const router = express.Router();

// 列表：?page&size&unread=1
router.get('/', requireAuth, (req, res) => {
  const { page = 1, size = 20, unread } = req.query;
  const { page: pageNum, limit: sizeNum, offset } = parsePageLimit(page, size, 20, 50);
  const unreadOnly = String(unread) === '1';
  const total = repo.count(req.user.id, unreadOnly);
  const items = repo.list(req.user.id, sizeNum, offset, unreadOnly);
  res.json({ total, page: pageNum, size: sizeNum, unread: repo.unreadCount(req.user.id), notifications: items });
});

// 未读角标（导航铃铛轮询/初始化用）
router.get('/unread-count', requireAuth, (req, res) => {
  res.json({ unread: repo.unreadCount(req.user.id) });
});

// 全部标记已读
router.put('/read-all', requireAuth, (req, res) => {
  repo.markAllRead(req.user.id);
  res.json({ unread: 0 });
});

// 单条标记已读
router.put('/:id/read', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Invalid notification id.' });
  }
  const row = repo.getById(id, req.user.id);
  if (!row) {
    return sendNotFound(res, 'Notification not found.');
  }
  repo.markRead(id, req.user.id);
  res.json({ message: 'Notification marked as read.', unread: repo.unreadCount(req.user.id) });
});

// 删除（仅本人）
router.delete('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Invalid notification id.' });
  }
  const row = repo.getById(id, req.user.id);
  if (!row) {
    return sendNotFound(res, 'Notification not found.');
  }
  repo.remove(id, req.user.id);
  res.json({ message: 'Notification deleted.' });
});

module.exports = router;
