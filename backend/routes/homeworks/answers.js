// routes/homeworks/answers.js —— 逐题提交 / 批改 / 作答列表
const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { createRateLimit } = require('../../middleware/rateLimit');
const { isStaff } = require('../../utils/roles');
const { clampInt, normalizeAnswer } = require('../exams/helpers');
const repo = require('../../repositories/homeworks');
const { guardHomework, homeworkWindowError } = require('./crud');

const { sendNotFound } = require('../../utils/apiErrors');

const router = express.Router();

const ANSWER_MAX_LENGTH = 20000;
// 逐题提交限流（按用户，30 次/分钟），防止刷作答行
const submitLimit = createRateLimit({ windowMs: 60000, max: 30, key: (req) => String(req.user ? req.user.id : '') });

// 逐题提交（客观题自动判分，主观题进入待批改，编程题请走 POST /submissions）
router.post('/:id/questions/:qid/submit', requireAuth, submitLimit, (req, res) => {
  const ctx = guardHomework(req, res);
  if (!ctx) return;
  const { homework } = ctx;
  const staff = isStaff(req.user.role);

  const winMsg = homeworkWindowError(homework, req.user);
  if (winMsg) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: winMsg });
  }

  const question = repo.getQuestion(req.params.qid);
  if (!question || question.homework_id !== homework.id) {
    return sendNotFound(res, 'Question not found.');
  }
  if (question.question_type === 'program') {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '编程题请通过代码提交作答。' });
  }

  const used = repo.countUserAttempts(homework.id, question.id, req.user.id);
  if (!staff && question.max_submissions > 0 && used >= question.max_submissions) {
    return res.status(400).json({ code: 1, reason: 'ERR_MAX_SUBMISSIONS', message: '该题提交次数已用尽。' });
  }

  const raw = req.body ? req.body.answer : '';
  const answerText = raw === null || raw === undefined ? '' : String(raw);
  if (answerText.length > ANSWER_MAX_LENGTH) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `答案超过 ${ANSWER_MAX_LENGTH} 字符限制。` });
  }

  // 题型校验与判分
  const type = question.question_type;
  if (type === 'choice') {
    const parsed = (() => {
      try { return JSON.parse(question.options || '[]'); } catch { return []; }
    })();
    const options = Array.isArray(parsed) ? parsed : [];
    const letter = answerText.trim().toUpperCase();
    const maxLetter = String.fromCharCode(64 + options.length);
    if (letter.length !== 1 || letter < 'A' || letter > maxLetter) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '选择题答案必须是有效选项。' });
    }
  }

  const isSubjective = type === 'long_answer' || (type === 'fill_blank' && question.is_subjective);
  let score = 0;
  let isCorrect = 0;
  let gradingStatus = 'pending';

  if (!isSubjective) {
    const userAnswer = normalizeAnswer(type, answerText);
    const correctAnswer = normalizeAnswer(type, question.correct_answer);
    if (userAnswer === correctAnswer && userAnswer !== '') {
      score = Number(question.score) || 0;
      isCorrect = 1;
    }
    gradingStatus = 'graded';
  }
  if (isSubjective && !answerText.trim()) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '答案不能为空。' });
  }

  const attemptNo = used + 1;
  const result = repo.createAnswer({
    homeworkId: homework.id,
    questionId: question.id,
    userId: req.user.id,
    attemptNo,
    answer: answerText,
    score,
    maxScore: question.score,
    isCorrect,
    isSubjective,
    gradingStatus
  });

  res.status(201).json({
    answer_id: result.lastInsertRowid,
    attempt_no: attemptNo,
    attempts_used: attemptNo,
    remaining: question.max_submissions > 0 ? Math.max(0, question.max_submissions - attemptNo) : null,
    score,
    max_score: Number(question.score) || 0,
    is_correct: !!isCorrect,
    grading_status: gradingStatus
  });
});

// 教师查看某题作答（可过滤 pending/graded）
router.get('/:id/questions/:qid/answers', requireAuth, requireRole('teacher'), (req, res) => {
  const homework = repo.getHomework(req.params.id);
  if (!homework) return sendNotFound(res, 'Homework not found.');
  const question = repo.getQuestion(req.params.qid);
  if (!question || question.homework_id !== homework.id) {
    return sendNotFound(res, 'Question not found.');
  }
  const status = req.query.status === 'pending' || req.query.status === 'graded' ? req.query.status : null;
  const limit = clampInt(req.query.limit, 1, 500, 200);
  const offset = clampInt(req.query.offset, 0, 1000000, 0);
  const answers = repo.listAnswersByQuestion(question.id, { gradingStatus: status, limit, offset });
  res.json({ question: { id: question.id, title: question.title, question_type: question.question_type, score: question.score }, answers });
});

// 教师批改主观题
router.put('/:id/answers/:aid/grade', requireAuth, requireRole('teacher'), (req, res) => {
  const homework = repo.getHomework(req.params.id);
  if (!homework) return sendNotFound(res, 'Homework not found.');
  const answer = repo.findAnswerById(req.params.aid);
  if (!answer || answer.homework_id !== homework.id) {
    return sendNotFound(res, 'Answer not found.');
  }
  if (!answer.is_subjective) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '客观题由系统自动判分，无需批改。' });
  }
  const score = Number(req.body ? req.body.score : NaN);
  if (!Number.isFinite(score) || score < 0 || score > (Number(answer.max_score) || 0)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '分数需在 0 到该题满分之间。' });
  }
  const comment = String((req.body && req.body.comment) || '').slice(0, 2000);
  repo.gradeAnswer(answer.id, score, comment, req.user.id);
  const updated = repo.findAnswerById(answer.id);
  res.json({ answer: updated });
});

// 教师批改总览：列出该作业的作答（默认只看待批改）
router.get('/:id/grading', requireAuth, requireRole('teacher'), (req, res) => {
  const homework = repo.getHomework(req.params.id);
  if (!homework) return sendNotFound(res, 'Homework not found.');
  const limit = clampInt(req.query.limit, 1, 500, 100);
  const offset = clampInt(req.query.offset, 0, 1000000, 0);
  const onlyPending = req.query.status !== 'all';
  const total = repo.countGradingRows(homework.id, onlyPending);
  const rows = repo.listGradingRows(homework.id, { onlyPending, limit, offset });
  res.json({ total, limit, offset, answers: rows });
});

module.exports = router;
