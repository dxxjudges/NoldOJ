const express = require('express');
const announcementsRepo = require('../repositories/announcements');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const { emitAnnouncement } = require('../services/socket');
const { parsePageLimit } = require('../utils/pagination');
const { isAdminOrSu } = require('../utils/roles');
const { buildUpdates } = require('../utils/db');
const { sanitizeText } = require('../utils/securityHelpers');

const { sendNotFound } = require('../utils/apiErrors');

const router = express.Router();

// 列表（公开读取）支持 type 过滤与分页，置顶排前
router.get('/', (req, res) => {
  const { type = 'global', page = 1, size = 10 } = req.query;
  const { page: pageNum, limit: sizeNum, offset } = parsePageLimit(page, size, 10, 50);

  let where = 'WHERE a.type = ?';
  // 比赛公告由专用接口返回，此处仅返回全局公告
  const params = [type === 'contest' ? 'global' : type];

  const total = announcementsRepo.countList(where, params);
  const items = announcementsRepo.list(where, params, sizeNum, offset);

  res.json({ total, page: pageNum, size: sizeNum, announcements: items });
});

// 详情
router.get('/:id', optionalAuth, (req, res) => {
  const a = announcementsRepo.getWithAuthor(req.params.id);
  if (!a) {
    return sendNotFound(res, 'Announcement not found.');
  }
  // 10.3: 隐藏比赛的公告仅 staff 可见
  if (a.type === 'contest' && a.contest_id) {
    const contest = announcementsRepo.getContestHidden(a.contest_id);
    if (contest && contest.is_hidden && (!req.user || !['admin', 'su', 'teacher'].includes(req.user.role))) {
      return sendNotFound(res, 'Announcement not found.');
    }
  }
  res.json(a);
});

// 创建（admin/teacher）
router.post('/', requireAuth, requireRole('teacher'), (req, res) => {
  const { title, content, type = 'global', contest_id = null, pinned = 0 } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Title is required.' });
  }
  if (!content || !content.trim()) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Content is required.' });
  }
  if (type === 'contest' && !contest_id) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'contest_id is required for contest announcements.' });
  }
  // D-L9: 校验比赛存在，避免悬挂公告
  if (type === 'contest' && !announcementsRepo.findContest(contest_id)) {
    return sendNotFound(res, 'Contest not found.');
  }
  const result = announcementsRepo.insert(
    sanitizeText(title).trim(), sanitizeText(content).trim(), type, type === 'contest' ? contest_id : null, pinned ? 1 : 0, req.user.id
  );
  const ann = announcementsRepo.get(result.lastInsertRowid);
  // 广播新公告给所有在线用户
  if (ann.type === 'global') {
    emitAnnouncement(ann);
  }
  res.status(201).json(ann);
});

// 更新（作者或 admin）
router.put('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const ann = announcementsRepo.get(req.params.id);
  if (!ann) {
    return sendNotFound(res, 'Announcement not found.');
  }
  if (req.user.id !== ann.author_id && !isAdminOrSu(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot edit others\' announcements.' });
  }
  const { title, content, type, contest_id, pinned } = req.body;
  // R9-9: type 必须在 schema CHECK 允许值内，contest 类型需 contest_id 存在
  if (type !== undefined && !['global', 'contest'].includes(type)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: "type must be 'global' or 'contest'." });
  }
  if (type === 'contest') {
    if (!contest_id) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'contest_id is required for contest announcements.' });
    }
    if (!announcementsRepo.findContest(contest_id)) {
      return sendNotFound(res, 'Contest not found.');
    }
  }
  const u = buildUpdates([
    { key: 'title', value: title !== undefined ? sanitizeText(title).trim() : undefined },
    { key: 'content', value: content !== undefined ? sanitizeText(content).trim() : undefined },
    { key: 'pinned', value: pinned, transform: v => v ? 1 : 0 }
  ], { touchUpdatedAt: true });
  // type 联动 contest_id 属于特例，单独追加
  if (type !== undefined) {
    u.set.push('type = ?', 'contest_id = ?');
    u.values.push(type, type === 'contest' ? contest_id : null);
  }
  if (u.set.length === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  announcementsRepo.update(ann.id, u);
  const updated = announcementsRepo.get(ann.id);
  res.json(updated);
});

// 删除（作者或 admin）
router.delete('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const ann = announcementsRepo.get(req.params.id);
  if (!ann) {
    return sendNotFound(res, 'Announcement not found.');
  }
  if (req.user.id !== ann.author_id && !isAdminOrSu(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot delete others\' announcements.' });
  }
  announcementsRepo.remove(ann.id);
  res.json({ message: 'Announcement deleted.' });
});

module.exports = router;
