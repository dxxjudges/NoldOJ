// routes/notebook.js —— 错题本：自动收录未 AC 的题，可标记已掌握/忽略并记笔记
const express = require('express');
const repo = require('../repositories/notebook');
const { requireAuth } = require('../middleware/auth');
const { parsePageLimit } = require('../utils/pagination');
const { visibilityFilterFor } = require('./_visibility');
const { sanitizeText } = require('../utils/securityHelpers');
const { sendNotFound } = require('../utils/apiErrors');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const { page = 1, size = 20 } = req.query;
  const { page: pageNum, limit: sizeNum, offset } = parsePageLimit(page, size, 20, 50);
  // 实体可见性（用户组）：错题本带出题目标题，组外题不得出现
  const visibilityFilter = visibilityFilterFor(req, 'problem');
  const total = repo.countWrong(req.user.id, visibilityFilter);
  const items = repo.listWrong(req.user.id, sizeNum, offset, visibilityFilter);
  res.json({ total, page: pageNum, size: sizeNum, items });
});

// 更新标记（status=mastered/dismissed，note=笔记）
router.put('/:problemId', requireAuth, (req, res) => {
  const pid = parseInt(req.params.problemId, 10);
  if (!Number.isInteger(pid)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Invalid problem id.' });
  }
  if (!repo.problemExists(pid)) {
    return sendNotFound(res, 'Problem not found.');
  }
  const { status, note } = req.body || {};
  if (status !== undefined && !['mastered', 'dismissed'].includes(status)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: "status must be 'mastered' or 'dismissed'." });
  }
  const existing = repo.getMark(req.user.id, pid);
  const nextStatus = status || existing?.status || 'mastered';
  const nextNote = note !== undefined
    ? sanitizeText(String(note ?? '').slice(0, 2000))
    : (existing?.note || '');
  repo.upsert(req.user.id, pid, nextStatus, nextNote);
  res.json({ problem_id: pid, status: nextStatus, note: nextNote });
});

// 从错题本移除 = 标记 dismissed（不删除提交历史，重新未 AC 也不会再次自动出现在列表）
router.delete('/:problemId', requireAuth, (req, res) => {
  const pid = parseInt(req.params.problemId, 10);
  if (!Number.isInteger(pid)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Invalid problem id.' });
  }
  const existing = repo.getMark(req.user.id, pid);
  repo.upsert(req.user.id, pid, 'dismissed', existing?.note || '');
  res.json({ problem_id: pid, status: 'dismissed' });
});

module.exports = router;
