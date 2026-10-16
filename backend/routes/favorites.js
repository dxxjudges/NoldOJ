const express = require('express');
const favoritesRepo = require('../repositories/favorites');
const { requireAuth } = require('../middleware/auth');
const { parsePageLimit } = require('../utils/pagination');
const { visibilityFilterFor } = require('./_visibility');
const { canViewUserData } = require('../utils/roles');

const { sendNotFound } = require('../utils/apiErrors');

const router = express.Router();

// 收藏列表（我的收藏 + 分页）
// 无 user_id 参数 = 本人；带 user_id 查看他人（受 hide_favorites 隐私开关约束，admin/su 除外）
router.get('/', requireAuth, (req, res) => {
  const { page = 1, size = 20 } = req.query;
  const rawUid = req.query.user_id;
  const targetId = rawUid !== undefined && rawUid !== '' ? parseInt(String(rawUid), 10) : req.user.id;
  if (!Number.isInteger(targetId)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Invalid user_id.' });
  }
  const target = favoritesRepo.getUserFavoritesPrivacy(targetId);
  if (!target) {
    return sendNotFound(res, 'User not found.');
  }
  if (!canViewUserData(req.user, target, 'hide_favorites')) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '该用户已对其它用户隐藏收藏。' });
  }
  const { page: pageNum, limit: sizeNum, offset } = parsePageLimit(page, size, 20, 50);
  // 实体可见性（用户组）：收藏项会带出题目标题，越权题目不得出现在他人收藏列表里
  // （staff 条件为空 → 不过滤）
  const visibilityFilter = visibilityFilterFor(req, 'problem');
  const total = favoritesRepo.countByUser(targetId, { visibilityFilter });
  const items = favoritesRepo.listByUser(req.user.id, targetId, sizeNum, offset, visibilityFilter);
  res.json({ total, page: pageNum, size: sizeNum, favorites: items });
});

// 检查是否已收藏（批量，ids=1,2,3）
router.get('/status', requireAuth, (req, res) => {
  let ids = String(req.query.ids || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n));
  // R9-10: IN 占位符数量上限（SQLite MAX_VARIABLE_NUMBER 约 999），截断到 500
  if (ids.length > 500) ids = ids.slice(0, 500);
  if (ids.length === 0) return res.json({ favorites: {} });
  const rows = favoritesRepo.listFavoriteStatus(req.user.id, ids);
  const fav = {};
  rows.forEach(r => fav[r.problem_id] = true);
  res.json({ favorites: fav });
});

// 收藏
router.post('/:problemId', requireAuth, (req, res) => {
  const pid = parseInt(req.params.problemId, 10);
  if (!Number.isInteger(pid)) return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Invalid problem id.' });
  const p = favoritesRepo.problemExists(pid);
  if (!p) return sendNotFound(res, 'Problem not found.');
  favoritesRepo.insert(req.user.id, pid);
  res.json({ favorited: true });
});

// 取消收藏
router.delete('/:problemId', requireAuth, (req, res) => {
  const pid = parseInt(req.params.problemId, 10);
  favoritesRepo.remove(req.user.id, pid);
  res.json({ favorited: false });
});

module.exports = router;