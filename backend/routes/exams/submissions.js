// routes/exams/submissions.js —— 考生交卷 / 提交详情 / 提交列表（判分计算与落库事务）
const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { parsePageLimit } = require('../../utils/pagination');
const { checkExamWindow } = require('../../utils/examWindow');
const { checkExamTimeLimit, SUBMIT_GRACE_MS } = require('../../utils/examAttempts');
const examProgram = require('../../services/examProgram');
const repo = require('../../repositories/exams');
const { normalizeAnswer } = require('./helpers');

const { sendNotFound } = require('../../utils/apiErrors');
const { logError } = require('../../utils/logger');

const router = express.Router();

// 提交试卷
router.post('/:id/submit', requireAuth, (req, res) => {
  const exam = repo.getExam(req.params.id);
  if (!exam) {
    return sendNotFound(res, 'Exam not found.');
  }

  if (!exam.is_public) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Exam is not public.' });
  }
  if (exam.is_hidden && !['teacher', 'admin', 'su'].includes(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Exam not found.' });
  }

  // 时间窗门禁：开考前/结束后禁止交卷（教师/管理员放行）
  const winMsg = checkExamWindow(exam, req.user);
  if (winMsg) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: winMsg });
  }

  // 检查尝试次数；当前尝试号 = 已提交次数 + 1（程序题代码按此号归属）
  const attemptCount = repo.countUserSubmissions(exam.id, req.user.id);
  if (exam.max_attempts > 0 && attemptCount >= exam.max_attempts) {
    return res.status(400).json({ code: 1, reason: 'ERR_MAX_ATTEMPTS', message: '已达到最大尝试次数。' });
  }
  const attempt = attemptCount + 1;

  // 作答时限（time_limit）服务端强制：仅靠前端倒计时刷新即可重置，这里按
  // exam_attempts 里记录的起始时刻兜底；教师/管理员放行
  const timeMsg = checkExamTimeLimit(exam, req.user, attempt, { graceMs: SUBMIT_GRACE_MS });
  if (timeMsg) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: timeMsg });
  }

  const { answers } = req.body;
  if (!Array.isArray(answers)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'answers is required.' });
  }

  // 获取题目
  const questions = repo.listExamQuestionsRaw(exam.id);
  const questionMap = {};
  questions.forEach(q => { questionMap[q.id] = q; });

  // 归集答题：客户端条目 + 所有程序题（服务端兜底补全；程序题分数一律服务端折算，防伪造）
  const entries = [];
  const seen = new Set();
  for (const a of answers) {
    if (!a || seen.has(a.question_id)) continue;
    seen.add(a.question_id);
    entries.push(a);
  }
  for (const q of questions) {
    if (q.question_type === 'program' && !seen.has(q.id)) {
      entries.push({ question_id: q.id });
      seen.add(q.id);
    }
  }
  if (entries.length === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'answers is required.' });
  }

  // 程序题：取当前尝试下该生该题的代码提交
  const programSubs = new Map();
  for (const q of questions) {
    if (q.question_type !== 'program') continue;
    const sub = repo.getProgramAttemptSubmission(exam.id, req.user.id, q.problem_id, attempt);
    if (sub) programSubs.set(q.id, sub);
  }

  let result;
  try {
    // 处理每道题的答案：逐题计分后组装答题行，落库事务整体封装在 repo（BEGIN→COMMIT 之间无 res）
    const rows = [];
    let totalScore = 0;
    let hasSubjective = false;
    let hasPendingProgram = false;

    for (const a of entries) {
      const question = questionMap[a.question_id];
      if (!question) continue;

      if (question.question_type === 'program') {
        const sub = programSubs.get(question.id) || null;
        const r = examProgram.scoreFromSubmission(question, sub);
        let score = 0;
        let correct = 0;
        let gradingStatus;
        if (r.pending) {
          hasPendingProgram = true;
          gradingStatus = 'pending';
        } else {
          score = r.score;
          correct = r.correct ? 1 : 0;
          gradingStatus = 'ai_graded';
        }
        totalScore += score;
        rows.push({
          question_id: question.id,
          answer: sub ? String(sub.id) : '',
          score,
          max_score: question.score,
          is_correct: correct,
          is_subjective: 0,
          grading_status: gradingStatus,
          code_submission_id: sub ? sub.id : null
        });
        continue;
      }

      const isSubjective = question.question_type === 'long_answer' ||
                           (question.question_type === 'fill_blank' && question.is_subjective);

      let score = 0;
      let isCorrect = 0;
      let gradingStatus;

      if (!isSubjective) {
        // 客观题自动评分（规范化对比）
        const userAnswer = normalizeAnswer(question.question_type, a.answer);
        const correctAnswer = normalizeAnswer(question.question_type, question.correct_answer);

        if (question.question_type === 'choice' || question.question_type === 'true_false' || question.question_type === 'fill_blank') {
          if (userAnswer === correctAnswer) {
            score = question.score;
            isCorrect = 1;
          }
        }
        gradingStatus = 'ai_graded';
      } else {
        // 主观题：等待评分
        hasSubjective = true;
        gradingStatus = 'pending';
      }

      totalScore += score;
      rows.push({
        question_id: question.id,
        answer: a.answer || '',
        score,
        max_score: question.score,
        is_correct: isCorrect,
        is_subjective: isSubjective ? 1 : 0,
        grading_status: gradingStatus,
        code_submission_id: null
      });
    }

    // 更新提交状态：有主观题或程序题判题中 → grading，否则 graded
    const finalStatus = (hasSubjective || hasPendingProgram) ? 'grading' : 'graded';

    const submissionId = repo.createSubmissionWithAnswers({
      examId: exam.id,
      userId: req.user.id,
      maxScore: exam.total_score,
      rows,
      totalScore,
      finalStatus
    });

    result = {
      submission_id: submissionId,
      status: finalStatus,
      total_score: totalScore,
      max_score: exam.total_score,
      has_subjective: hasSubjective,
      has_pending_program: hasPendingProgram
    };
  } catch (e) {
    logError('EXAM', 'submit failed:', e && e.message);
    return res.status(500).json({ code: 1, reason: 'ERR_INTERNAL', message: 'Submit failed.' });
  }

  res.status(201).json(result);
});

// 获取提交详情
router.get('/:id/submission/:sid', requireAuth, (req, res) => {
  const submission = repo.getSubmissionForUser(req.params.sid, req.user.id);

  if (!submission) {
    // 检查是否是教师+查看他人提交
    if (req.user && ['teacher', 'admin', 'su'].includes(req.user.role)) {
      const sub = repo.getSubmissionWithExam(req.params.sid, req.params.id);
      if (!sub) {
        return sendNotFound(res, 'Submission not found.');
      }
      // 教师可以查看任何提交
      const answers = repo.listSubmissionAnswers(req.params.sid);

      return res.json({ ...sub, answers });
    }
    return sendNotFound(res, 'Submission not found.');
  }

  const answers = repo.listSubmissionAnswers(req.params.sid);

  // 如果不显示答案，隐藏正确答案
  if (!submission.show_answer) {
    answers.forEach(a => {
      delete a.correct_answer;
    });
  }

  res.json({ ...submission, answers });
});

// 获取某试卷的所有提交（教师用）
router.get('/:id/submissions', requireAuth, requireRole('teacher'), (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const { page: pageNum, limit: limitNum, offset } = parsePageLimit(page, limit, 50, 100);

  const total = repo.countSubmissionsByExam(req.params.id);

  const submissions = repo.listSubmissionsByExam(req.params.id, limitNum, offset);

  res.json({ total, page: pageNum, limit: limitNum, submissions });
});

module.exports = router;
