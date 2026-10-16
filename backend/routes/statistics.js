const express = require('express');
const statisticsRepo = require('../repositories/statistics');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { visibilityFilterFor } = require('./_visibility');
const { canViewUserData } = require('../utils/roles');

const { sendNotFound } = require('../utils/apiErrors');

const router = express.Router();

function getStatsData(uid) {
  // 提交日历：最近 365 天，每天提交数 + AC 数
  const calStart = new Date();
  calStart.setUTCDate(calStart.getUTCDate() - 364);
  const startStr = calStart.toISOString().slice(0, 10);
  const calRows = statisticsRepo.getCalendarRows(uid, startStr);
  const calMap = new Map(calRows.map(r => [r.d, { submits: r.submits, acs: r.acs || 0 }]));
  const calendar = [];
  for (let i = 0; i <= 364; i++) {
    const d = new Date(calStart);
    d.setUTCDate(calStart.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    const v = calMap.get(key);
    calendar.push({ date: key, submits: v ? v.submits : 0, acs: v ? v.acs : 0 });
  }

  // 语言分布：按语言统计提交数与 AC 数
  const langRows = statisticsRepo.getLanguageRows(uid);
  const languages = langRows.map(r => ({ language: r.language, submits: r.submits, acs: r.acs || 0 }));

  // 难度分布：AC 的题目按难度（去重）分布
  const diffRows = statisticsRepo.getDifficultyRows(uid);
  const difficulty = diffRows.map(r => ({ difficulty: r.difficulty, count: r.c }));

  // 概览
  const { totalAccepted, totalSubmits, totalProblems, totalFavorites, achievements } = statisticsRepo.getOverview(uid);

  return {
    overview: { totalAccepted, totalSubmits, totalProblems, totalFavorites, achievements },
    calendar,
    languages,
    difficulty
  };
}

// 个人数据看板：提交日历 / 语言分布 / 难度分布
// 无 user_id 参数 = 本人；带 user_id 查看他人（受 hide_dashboard 隐私开关约束，admin/su 除外）
router.get('/me/stats', requireAuth, (req, res) => {
  const rawUid = req.query.user_id;
  const targetId = rawUid !== undefined && rawUid !== '' ? parseInt(String(rawUid), 10) : req.user.id;
  if (!Number.isInteger(targetId)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Invalid user_id.' });
  }
  const target = statisticsRepo.getUserDashboardPrivacy(targetId);
  if (!target) {
    return sendNotFound(res, 'User not found.');
  }
  if (!canViewUserData(req.user, target, 'hide_dashboard')) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '该用户已对其它用户隐藏看板。' });
  }
  res.json(getStatsData(targetId));
});

// 提交云图：按题目统计提交次数，用于词云渲染
// 实体可见性（用户组）：匿名可访问，但词云只统计当前用户可见的题目
router.get('/wordcloud', optionalAuth, (req, res) => {
  const rows = statisticsRepo.getWordcloud({ visibilityFilter: visibilityFilterFor(req, 'problem') });
  res.json(rows);
});

module.exports = router;