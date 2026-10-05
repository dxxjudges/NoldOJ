const express = require('express');
const achievementsRepo = require('../repositories/achievements');
const { requireAuth } = require('../middleware/auth');
const { canViewUserData } = require('../utils/roles');

const { sendNotFound } = require('../utils/apiErrors');

const router = express.Router();

// 全部成就 + 指定用户解锁状态
// 无 user_id 参数 = 本人；带 user_id 查看他人（受 hide_achievements 隐私开关约束，admin/su 除外）
router.get('/', requireAuth, (req, res) => {
  const rawUid = req.query.user_id;
  const targetId = rawUid !== undefined && rawUid !== '' ? parseInt(String(rawUid), 10) : req.user.id;
  if (!Number.isInteger(targetId)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Invalid user_id.' });
  }
  const target = achievementsRepo.getUserAchievementPrivacy(targetId);
  if (!target) {
    return sendNotFound(res, 'User not found.');
  }
  if (!canViewUserData(req.user, target, 'hide_achievements')) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '该用户已对其它用户隐藏成就。' });
  }
  const all = achievementsRepo.listAchievements();
  const mineRows = achievementsRepo.listUserAchievements(targetId);
  const mineMap = new Map(mineRows.map(r => [r.achievement_id, r.unlocked_at]));
  const total = all.length;
  const unlocked = mineRows.length;
  res.json({
    total,
    unlocked,
    achievements: all.map(a => ({ ...a, unlocked: mineMap.has(a.id), unlocked_at: mineMap.get(a.id) || null }))
  });
});

module.exports = router;