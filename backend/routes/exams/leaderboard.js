// routes/exams/leaderboard.js —— 试卷排行榜（完成门槛 + 封榜过滤 + 最佳一次尝试）
const express = require('express');
const { optionalAuth } = require('../../middleware/auth');
const { fromSqliteUtc, toSqliteUtc, resolveFreeze } = require('../../utils/examWindow');
const { pickBestAttempts, compareByScore, buildStandings } = require('../../utils/standings');
const repo = require('../../repositories/exams');
const { visibilityDeniedMessage, canView } = require('../_visibility');
const { clampInt } = require('./helpers');

const { sendNotFound, sendForbidden } = require('../../utils/apiErrors');

const router = express.Router();

// 排行榜：完成门槛 + 封榜过滤 + 每人最佳一次尝试排名（仅考生入榜）
router.get('/:id/leaderboard', optionalAuth, (req, res) => {
  const exam = repo.getExam(req.params.id);
  if (!exam) {
    return sendNotFound(res, 'Exam not found.');
  }
  const staff = !!req.user && ['teacher', 'admin', 'su'].includes(req.user.role);
  if (exam.is_hidden && !staff) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Exam not found.' });
  }
  if (!exam.is_public && !staff) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Exam is not public.' });
  }
  // 实体可见性（用户组）：组外用户不得读榜（含题目 id 与排名）
  if (!canView(req, 'exam', exam.id)) {
    return sendForbidden(res, visibilityDeniedMessage('exam'));
  }
  if (!exam.leaderboard_enabled) {
    return sendNotFound(res, 'Leaderboard not found.');
  }
  // 完成门槛：有交卷记录=已完成；未完成者（含匿名）仅在教师放开时可看
  const finished = req.user
    ? repo.hasUserSubmission(exam.id, req.user.id)
    : null;
  if (!staff && !finished && !exam.leaderboard_view_incomplete) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '完成考试后可查看排行榜。' });
  }

  const fz = resolveFreeze(exam);

  const rows = repo.getLeaderboardRows(exam.id, fz.frozen && fz.freeze_at ? toSqliteUtc(fz.freeze_at) : null);

  // 每人取最佳一次：分数降序，同分先交卷者靠前（选优与名次组装共用 utils/standings）
  const best = pickBestAttempts(rows);
  // 排序：总分降序 → 同分先交卷者靠前，buildStandings 统一补齐 rank
  const ranked = buildStandings(best.values(), (a, b) =>
    compareByScore(a, b, (x, y) => String(x.submitted_at).localeCompare(String(y.submitted_at)))
  );

  const toIso = (s) => {
    const d = fromSqliteUtc(s);
    return d ? d.toISOString() : null;
  };
  const entryOf = (r) => ({
    rank: r.rank,
    user_id: r.user_id,
    username: r.username,
    nickname: r.nickname || '',
    total_score: r.total_score,
    max_score: r.max_score,
    attempts: r.attempts,
    status: r.status,
    submitted_at: toIso(r.submitted_at)
  });

  const limit = clampInt(req.query.limit, 1, 200, 100);
  const leaderboard = ranked.slice(0, limit).map(entryOf);
  let my = null;
  if (req.user) {
    const idx = ranked.findIndex(r => r.user_id === req.user.id);
    if (idx >= 0) my = entryOf(ranked[idx]);
  }

  res.json({
    exam_id: exam.id,
    title: exam.title,
    total_score: exam.total_score,
    start_time: exam.start_time || null,
    end_time: exam.end_time || null,
    freeze_minutes: exam.freeze_minutes || 0,
    frozen: !!fz.frozen,
    freeze_at: fz.freeze_at,
    freeze_source: fz.source,
    manual_frozen: !!exam.manual_frozen,
    unfrozen: !!exam.unfrozen,
    view_incomplete: !!exam.leaderboard_view_incomplete,
    leaderboard,
    my
  });
});

module.exports = router;
