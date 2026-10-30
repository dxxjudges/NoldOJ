// routes/exams/stats.js —— 试卷数据统计（教师始终可看；stats_public=1 时学生可看）
// 口径与排行榜一致：仅学生（role='user'）计入；每人取最佳一次尝试；封榜期间只统计封榜前交卷。
// 仅输出聚合数据，不下发任何个人成绩/答案，避免借统计页泄露排名细节。
const express = require('express');
const { optionalAuth } = require('../../middleware/auth');
const { resolveFreeze, toSqliteUtc } = require('../../utils/examWindow');
const { pickBestAttempts } = require('../../utils/standings');
const { isStaff } = require('../../utils/roles');
const repo = require('../../repositories/exams');
const { visibilityDeniedMessage, canView } = require('../_visibility');

const { sendNotFound, sendForbidden } = require('../../utils/apiErrors');

const router = express.Router();

// 分数区间（按满分百分比，11 档：0–9% … 90–99%、100%）
const DIST_LABELS = [
  '0–9%', '10–19%', '20–29%', '30–39%', '40–49%', '50–59%',
  '60–69%', '70–79%', '80–89%', '90–99%', '100%'
];

function avg(nums) {
  if (nums.length === 0) return 0;
  return Math.round(nums.reduce((s, n) => s + n, 0) / nums.length * 10) / 10;
}

function median(sorted) {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2 * 10) / 10;
}

// 百分比（保留 1 位小数），分母为 0 时返回 0
function rate(part, total) {
  return total > 0 ? Math.round(part * 1000 / total) / 10 : 0;
}

router.get('/:id/stats', optionalAuth, (req, res) => {
  const exam = repo.getExam(req.params.id);
  if (!exam) {
    return sendNotFound(res, 'Exam not found.');
  }
  const staff = !!req.user && isStaff(req.user.role);
  // 隐藏/私有试卷与详情页同口径：非 staff 一律不可探测
  if (exam.is_hidden && !staff) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Exam not found.' });
  }
  if (!exam.is_public && !staff) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Exam is not public.' });
  }
  // 实体可见性（用户组）：组外用户不得查看统计
  if (!canView(req, 'exam', exam.id)) {
    return sendForbidden(res, visibilityDeniedMessage('exam'));
  }
  // 统计开关：教师/管理员始终可看；学生仅在开关打开时可看
  if (!staff && !exam.stats_public) {
    return sendForbidden(res, '统计未公开，仅教师可见。');
  }

  const fz = resolveFreeze(exam);
  const cutoff = fz.frozen && fz.freeze_at ? toSqliteUtc(fz.freeze_at) : null;
  const rows = repo.getExamStatsRows(exam.id, cutoff);
  // 每人取最佳一次交卷（与排行榜选优规则共用 utils/standings）
  const bestRows = [...pickBestAttempts(rows).values()];
  const answers = repo.listAnswersForSubmissions(bestRows.map(r => r.id));

  const scores = bestRows.map(r => Number(r.total_score) || 0).sort((a, b) => a - b);
  const denom = Number(exam.total_score) > 0
    ? Number(exam.total_score)
    : (rows.length > 0 ? Number(rows[0].max_score) || 0 : 0);

  // 分数分布：按满分百分比分档
  const distribution = DIST_LABELS.map(label => ({ label, count: 0 }));
  for (const s of scores) {
    const pct = denom > 0 ? (s / denom) * 100 : 0;
    const idx = pct >= 100 ? 10 : Math.max(0, Math.min(9, Math.floor(pct / 10)));
    distribution[idx].count += 1;
  }

  const status = { submitted: 0, grading: 0, graded: 0 };
  for (const r of bestRows) {
    if (status[r.status] !== undefined) status[r.status] += 1;
  }

  const passScore = Number(exam.pass_score) || 0;
  const passCount = passScore > 0 ? scores.filter(s => s >= passScore).length : 0;

  // 逐题：答题人数/均分/满分人数/正确率/待批改数
  const questions = repo.listExamQuestionsForDetail(exam.id, false).map(q => {
    const qa = answers.filter(a => a.question_id === q.id);
    const answered = qa.length;
    const correctCount = qa.filter(a => a.is_correct === 1).length;
    const fullMarks = qa.filter(a => Number(a.score) >= Number(a.max_score) && Number(a.max_score) > 0).length;
    return {
      question_id: q.id,
      title: q.title,
      question_type: q.question_type,
      score: q.score,
      answered,
      average_score: avg(qa.map(a => Number(a.score) || 0)),
      full_marks: fullMarks,
      correct_count: correctCount,
      correct_rate: rate(correctCount, answered),
      pending: qa.filter(a => a.grading_status === 'pending').length
    };
  });

  res.json({
    exam_id: exam.id,
    title: exam.title,
    total_score: exam.total_score,
    pass_score: exam.pass_score,
    start_time: exam.start_time || null,
    end_time: exam.end_time || null,
    stats_public: !!exam.stats_public,
    frozen: !!fz.frozen,
    freeze_at: fz.freeze_at,
    freeze_source: fz.source,
    summary: {
      participants: bestRows.length,
      submissions: rows.length,
      submitted: status.submitted,
      grading: status.grading,
      graded: status.graded,
      average: avg(scores),
      median: median(scores),
      highest: scores.length ? scores[scores.length - 1] : 0,
      lowest: scores.length ? scores[0] : 0,
      full_score_count: denom > 0 ? scores.filter(s => s >= denom).length : 0,
      pass_count: passCount,
      pass_rate: passScore > 0 ? rate(passCount, scores.length) : 0
    },
    distribution,
    questions
  });
});

module.exports = router;
