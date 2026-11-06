// routes/exams/export.js —— 试卷成绩单 CSV 导出
// 教师可导出全员成绩总表（scope=all）；学生只能导出本人成绩单（scope=mine，含逐题明细）。
// 数据口径与排行榜/统计一致：仅学生（role='user'）、每人取最佳一次尝试、封榜期间截断到冻结时刻。
const express = require('express');
const { optionalAuth } = require('../../middleware/auth');
const { resolveFreeze, toSqliteUtc } = require('../../utils/examWindow');
const { pickBestAttempts, compareByScore, buildStandings } = require('../../utils/standings');
const { isStaff } = require('../../utils/roles');
const { sendCsv } = require('../../utils/csv');
const repo = require('../../repositories/exams');
const { visibilityDeniedMessage, canView } = require('../_visibility');

const { sendNotFound, sendForbidden } = require('../../utils/apiErrors');

const router = express.Router();

// 与详情/统计/排行榜同口径的可见性门禁
function guardExam(req, res) {
  const exam = repo.getExam(req.params.id);
  if (!exam) {
    sendNotFound(res, 'Exam not found.');
    return null;
  }
  const staff = !!req.user && isStaff(req.user.role);
  if (exam.is_hidden && !staff) {
    res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Exam not found.' });
    return null;
  }
  if (!exam.is_public && !staff) {
    res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Exam is not public.' });
    return null;
  }
  if (!canView(req, 'exam', exam.id)) {
    sendForbidden(res, visibilityDeniedMessage('exam'));
    return null;
  }
  return { exam, staff };
}

router.get('/:id/export.csv', optionalAuth, (req, res) => {
  const ctx = guardExam(req, res);
  if (!ctx) return;
  const { exam, staff } = ctx;
  if (exam.is_survey) {
    return sendNotFound(res, 'Survey has no score report.');
  }

  const requestedAll = String(req.query.scope || '') === 'all';
  // 学生不允许导出全员成绩单（避免泄露他人成绩）
  if (!staff && requestedAll) {
    return sendForbidden(res, '仅教师可导出全员成绩单。');
  }
  // 教师默认导出全员；显式 scope=mine 时导出本人成绩单
  const wantAll = staff && String(req.query.scope || 'all') !== 'mine';

  const fz = resolveFreeze(exam);
  const cutoff = fz.frozen && fz.freeze_at ? toSqliteUtc(fz.freeze_at) : null;
  const rows = repo.getLeaderboardRows(exam.id, cutoff);
  const best = pickBestAttempts(rows);

  if (wantAll) {
    // 教师：全员成绩总表（排名 → 总分降序、同分先交卷）
    const ranked = buildStandings(best.values(), (a, b) =>
      compareByScore(a, b, (x, y) => String(x.submitted_at).localeCompare(String(y.submitted_at)))
    );
    const csvRows = [
      ['排名', '用户名', '昵称', '总分', '满分', '状态', '尝试次数', '交卷时间'],
      ...ranked.map(r => [
        r.rank, r.username, r.nickname || '', r.total_score, r.max_score,
        r.status, r.attempts, r.submitted_at || ''
      ])
    ];
    return sendCsv(res, `${exam.title}-成绩总表.csv`, csvRows);
  }

  // 学生：仅本人最佳一次交卷 + 逐题明细
  const mineRows = [...best.values()].filter(r => r.user_id === req.user.id);
  if (mineRows.length === 0) {
    return sendNotFound(res, '你还没有交卷记录，暂无成绩单。');
  }
  const mine = mineRows[0];
  const answers = repo.listAnswersForSubmissions([mine.id]);
  const questions = repo.listExamQuestionsForDetail(exam.id, false);
  const answerMap = new Map(answers.map(a => [a.question_id, a]));

  const csvRows = [
    ['成绩单', exam.title],
    ['用户名', mine.username],
    ['昵称', mine.nickname || ''],
    ['总分', mine.total_score],
    ['满分', mine.max_score],
    ['状态', mine.status],
    ['尝试次数', mine.attempts],
    ['交卷时间', mine.submitted_at || ''],
    [],
    ['序号', '题目', '题型', '满分', '得分', '是否正确', '批改状态']
  ];
  questions.forEach((q, i) => {
    const a = answerMap.get(q.id);
    csvRows.push([
      i + 1,
      q.title,
      q.question_type,
      q.score,
      a ? a.score : 0,
      a ? (a.is_correct === 1 ? '是' : '否') : '未作答',
      a ? a.grading_status : '-'
    ]);
  });

  return sendCsv(res, `${exam.title}-我的成绩单.csv`, csvRows);
});

module.exports = router;
