// routes/homeworks/report.js —— 作业排行榜 / 统计 / CSV 导出
// 口径：仅 role='user' 进入榜单；每人每题取最高分，总分 = 各题最高分之和；同分按最后提交早者靠前。
const express = require('express');
const { optionalAuth } = require('../../middleware/auth');
const { sendCsv } = require('../../utils/csv');
const repo = require('../../repositories/homeworks');
const { guardHomework } = require('./crud');

const { sendNotFound, sendForbidden } = require('../../utils/apiErrors');

const router = express.Router();

const DIST_LABELS = [
  '0–9%', '10–19%', '20–29%', '30–39%', '40–49%', '50–59%',
  '60–69%', '70–79%', '80–89%', '90–99%', '100%'
];

function avg(nums) {
  if (nums.length === 0) return 0;
  return Math.round(nums.reduce((s, n) => s + Number(n || 0), 0) / nums.length * 10) / 10;
}

function median(sorted) {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2 * 10) / 10;
}

function rate(part, total) {
  return total > 0 ? Math.round(part * 1000 / total) / 10 : 0;
}

function rankedRows(homeworkId) {
  const rows = repo.listLeaderboardRows(homeworkId);
  let lastScore = null;
  let lastRank = 0;
  return rows.map((r, i) => {
    const score = Number(r.total_score) || 0;
    const rank = lastScore !== null && score === lastScore ? lastRank : i + 1;
    lastScore = score;
    lastRank = rank;
    return { ...r, total_score: score, rank };
  });
}

// 排行榜
router.get('/:id/leaderboard', optionalAuth, (req, res) => {
  const ctx = guardHomework(req, res);
  if (!ctx) return;
  const { homework } = ctx;
  if (!homework.leaderboard_enabled) {
    return sendNotFound(res, 'Leaderboard not found.');
  }

  const ranked = rankedRows(homework.id);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const leaderboard = ranked.slice(0, limit).map(r => ({
    rank: r.rank,
    user_id: r.user_id,
    username: r.username,
    nickname: r.nickname || '',
    total_score: r.total_score,
    max_score: Number(homework.total_score) || 0,
    answered_questions: r.answered_questions,
    attempts: r.attempts,
    submitted_at: r.submitted_at
  }));
  const my = req.user ? (leaderboard.find(x => x.user_id === req.user.id) || null) : null;

  res.json({
    homework_id: homework.id,
    title: homework.title,
    total_score: homework.total_score,
    start_time: homework.start_time || null,
    end_time: homework.end_time || null,
    leaderboard,
    my
  });
});

// 统计：教师始终可看，stats_public=1 时学生可看
router.get('/:id/stats', optionalAuth, (req, res) => {
  const ctx = guardHomework(req, res);
  if (!ctx) return;
  const { homework, staff } = ctx;
  if (!staff && !homework.stats_public) {
    return sendForbidden(res, '统计未公开，仅教师可见。');
  }

  const questions = repo.listQuestionsRaw(homework.id);
  const best = repo.listBestByUserQuestion(homework.id);
  const allAnswers = repo.listAnswerRows(homework.id);
  const totals = repo.listLeaderboardRows(homework.id).map(r => Number(r.total_score) || 0).sort((a, b) => a - b);
  const denom = Number(homework.total_score) || 0;

  const distribution = DIST_LABELS.map(label => ({ label, count: 0 }));
  for (const s of totals) {
    const pct = denom > 0 ? (s / denom) * 100 : 0;
    const idx = pct >= 100 ? 10 : Math.max(0, Math.min(9, Math.floor(pct / 10)));
    distribution[idx].count += 1;
  }

  const perQuestion = questions.map(q => {
    const qBest = best.filter(b => b.question_id === q.id);
    const qAll = allAnswers.filter(a => a.question_id === q.id);
    const answered = qBest.length;
    const fullMarks = qBest.filter(b => Number(q.score) > 0 && Number(b.best_score) >= Number(q.score)).length;
    const pendingUsers = new Set(qAll.filter(a => a.grading_status === 'pending').map(a => a.user_id)).size;
    return {
      question_id: q.id,
      title: q.title,
      question_type: q.question_type,
      score: q.score,
      max_submissions: q.max_submissions,
      answered,
      attempts: qAll.length,
      average_best_score: avg(qBest.map(b => b.best_score)),
      full_marks: fullMarks,
      correct_rate: rate(fullMarks, answered),
      pending_users: pendingUsers
    };
  });

  const passScore = Number(homework.pass_score) || 0;
  const passCount = passScore > 0 ? totals.filter(s => s >= passScore).length : 0;

  res.json({
    homework_id: homework.id,
    title: homework.title,
    total_score: homework.total_score,
    pass_score: homework.pass_score,
    stats_public: !!homework.stats_public,
    start_time: homework.start_time || null,
    end_time: homework.end_time || null,
    summary: {
      participants: repo.countParticipants(homework.id),
      submissions: repo.countAllSubmissions(homework.id),
      average: avg(totals),
      median: median(totals),
      highest: totals.length ? totals[totals.length - 1] : 0,
      lowest: totals.length ? totals[0] : 0,
      full_score_count: denom > 0 ? totals.filter(s => s >= denom).length : 0,
      pass_count: passCount,
      pass_rate: passScore > 0 ? rate(passCount, totals.length) : 0,
      pending_grading: repo.countPendingGrading(homework.id)
    },
    distribution,
    questions: perQuestion
  });
});

// CSV 导出：教师导出全员总表；学生导出本人逐题明细
router.get('/:id/export.csv', optionalAuth, (req, res) => {
  const ctx = guardHomework(req, res);
  if (!ctx) return;
  const { homework, staff } = ctx;

  const requestedAll = String(req.query.scope || '') === 'all';
  if (!staff && requestedAll) {
    return sendForbidden(res, '仅教师可导出全员成绩单。');
  }
  const wantAll = staff && String(req.query.scope || 'all') !== 'mine';

  if (wantAll) {
    const ranked = rankedRows(homework.id);
    const rows = [
      ['排名', '用户名', '昵称', '总分', '满分', '已答题数', '提交次数', '最后提交'],
      ...ranked.map(r => [
        r.rank, r.username, r.nickname || '', r.total_score, Number(homework.total_score) || 0,
        r.answered_questions, r.attempts, r.submitted_at || ''
      ])
    ];
    return sendCsv(res, `${homework.title}-作业成绩总表.csv`, rows);
  }

  const best = repo.listBestByUserQuestion(homework.id).filter(b => b.user_id === req.user.id);
  if (best.length === 0) {
    return sendNotFound(res, '你还没有提交记录，暂无成绩单。');
  }
  const bestMap = new Map(best.map(b => [b.question_id, b]));
  const questions = repo.listQuestionsRaw(homework.id);
  const total = best.reduce((s, b) => s + (Number(b.best_score) || 0), 0);
  const rows = [
    ['作业', homework.title],
    ['用户名', req.user.username],
    ['昵称', req.user.nickname || ''],
    ['总分', total],
    ['满分', Number(homework.total_score) || 0],
    [],
    ['序号', '题目', '题型', '满分', '最高分', '提交次数', '最后提交']
  ];
  questions.forEach((q, i) => {
    const b = bestMap.get(q.id);
    rows.push([
      i + 1, q.title, q.question_type, q.score,
      b ? b.best_score : 0, b ? b.attempts : 0, b ? b.last_at : '未作答'
    ]);
  });
  return sendCsv(res, `${homework.title}-我的作业成绩单.csv`, rows);
});

module.exports = router;
