// routes/homeworks/crud.js —— 作业列表 / 详情 / 创建 / 更新 / 删除
const express = require('express');
const { requireAuth, requireRole, optionalAuth } = require('../../middleware/auth');
const { parsePageLimit } = require('../../utils/pagination');
const { sanitizeText } = require('../../utils/securityHelpers');
const { normalizeHomeworkTime, validateHomeworkWindow, homeworkWindowState } = require('../../utils/homeworkWindow');
const { visibilityFilterFor, visibilityDeniedMessage, canView } = require('../_visibility');
const { isStaff } = require('../../utils/roles');
const repo = require('../../repositories/homeworks');

const { sendNotFound, sendForbidden } = require('../../utils/apiErrors');

const router = express.Router();

const QUESTION_TYPES = ['choice', 'true_false', 'fill_blank', 'long_answer', 'program'];

// 作业时间窗门禁（教师/管理员放行）
function homeworkWindowError(homework, user) {
  const state = homeworkWindowState(homework);
  if (!state || state === 'running') return null;
  if (user && isStaff(user.role)) return null;
  return state === 'not_started' ? '作业尚未开始。' : '作业已截止。';
}

// 详情/提交/榜单/统计共用的可见性门禁；返回 { homework, staff } 或 null（已写响应）
function guardHomework(req, res) {
  const homework = repo.getHomeworkDetail(req.params.id);
  if (!homework) {
    sendNotFound(res, 'Homework not found.');
    return null;
  }
  const staff = !!req.user && isStaff(req.user.role);
  if (homework.is_hidden && !staff) {
    res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Homework not found.' });
    return null;
  }
  if (!homework.is_public && !staff) {
    res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Homework is not public.' });
    return null;
  }
  if (!canView(req, 'homework', homework.id)) {
    sendForbidden(res, visibilityDeniedMessage('homework'));
    return null;
  }
  return { homework, staff };
}

// 题库题目 → 作业编程题：仅允许公开、非隐藏、未归档的普通题目
function normalizeQuestions(questions) {
  if (!Array.isArray(questions)) return [];
  if (questions.length > 200) throw new Error('题目数量不能超过 200 道。');
  return questions.map((raw, i) => {
    const q = raw || {};
    const type = String(q.question_type || '');
    if (!QUESTION_TYPES.includes(type)) throw new Error(`第 ${i + 1} 题题型非法。`);
    const title = sanitizeText(q.title || '').trim();
    if (!title) throw new Error(`第 ${i + 1} 题缺少题干。`);
    const score = Number(q.score);
    if (!Number.isFinite(score) || score < 0) throw new Error(`第 ${i + 1} 题分值非法。`);
    const maxSubmissions = parseInt(q.max_submissions, 10);
    const max = Number.isFinite(maxSubmissions) && maxSubmissions > 0 ? maxSubmissions : 0;

    const out = {
      id: Number.isInteger(q.id) ? q.id : undefined,
      question_type: type,
      title,
      options: [],
      correct_answer: String(q.correct_answer ?? ''),
      score,
      sort_order: Number.isInteger(q.sort_order) ? q.sort_order : i,
      is_subjective: 0,
      max_submissions: max,
      problem_id: null
    };

    if (type === 'choice') {
      const options = Array.isArray(q.options) ? q.options.map(o => String(o)) : [];
      if (options.length < 2) throw new Error(`第 ${i + 1} 题（选择题）至少需要 2 个选项。`);
      if (!out.correct_answer) throw new Error(`第 ${i + 1} 题（选择题）缺少正确答案。`);
      out.options = options;
    } else if (type === 'true_false') {
      if (!out.correct_answer) throw new Error(`第 ${i + 1} 题（判断题）缺少正确答案。`);
    } else if (type === 'fill_blank') {
      out.is_subjective = q.is_subjective ? 1 : 0;
      if (!out.is_subjective && !out.correct_answer) throw new Error(`第 ${i + 1} 题（填空题）缺少正确答案。`);
    } else if (type === 'long_answer') {
      out.is_subjective = 1;
    } else if (type === 'program') {
      const pid = Number(q.problem_id);
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`第 ${i + 1} 题（编程题）未选择题目。`);
      if (!repo.getUsableProblem(pid)) throw new Error(`第 ${i + 1} 题关联的题目不存在或不可用（需公开、非隐藏）。`);
      out.problem_id = pid;
    }
    return out;
  });
}

function parseWindow(body) {
  const start = normalizeHomeworkTime(body.start_time);
  const end = normalizeHomeworkTime(body.end_time);
  validateHomeworkWindow(start, end);
  return { start, end };
}

// 列表
router.get('/', optionalAuth, (req, res) => {
  const { page = 1, limit = 20, search = '' } = req.query;
  const { page: pageNum, limit: limitNum, offset } = parsePageLimit(page, limit, 20, 100);
  const staff = !!req.user && isStaff(req.user.role);
  const { total, homeworks } = repo.listHomeworks({
    isStaff: staff,
    search: String(search || ''),
    limit: limitNum,
    offset,
    visibilityFilter: visibilityFilterFor(req, 'homework')
  });
  res.json({ total, page: pageNum, limit: limitNum, homeworks });
});

// 详情
router.get('/:id', optionalAuth, (req, res) => {
  const ctx = guardHomework(req, res);
  if (!ctx) return;
  const { homework, staff } = ctx;

  const winMsg = homeworkWindowError(homework, req.user);
  if (winMsg && !staff) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: winMsg });
  }

  const rawQuestions = repo.listQuestionsRaw(homework.id);
  const questions = staff
    ? rawQuestions.map(q => {
      const problem = q.problem_id ? repo.getUsableProblem(q.problem_id) : null;
      return { ...q, problem, problem_title: problem ? problem.title : null };
    })
    : repo.listQuestionsForStudent(homework.id);

  let my = [];
  if (req.user && !staff) {
    my = repo.listMyQuestionStats(homework.id, req.user.id);
  }

  // 每题已用提交次数（学生视角），用于前端显示剩余次数
  const mineMap = new Map(my.map(m => [m.question_id, m]));
  const withProgress = questions.map(q => {
    const m = mineMap.get(q.id);
    const attemptsUsed = m ? m.attempts : 0;
    return {
      ...q,
      attempts_used: attemptsUsed,
      remaining: q.max_submissions > 0 ? Math.max(0, q.max_submissions - attemptsUsed) : null,
      my_best_score: m ? m.best_score : 0,
      my_last_answer: m ? m.last_answer : '',
      my_last_status: m ? m.last_status : null,
      my_last_score: m ? m.last_score : 0,
      my_comment: m ? m.comment : ''
    };
  });

  res.json({
    ...homework,
    visibility: homework.visibility || 'public',
    questions: withProgress,
    window_state: homeworkWindowState(homework),
    server_now: new Date().toISOString(),
    pending_grading: staff ? repo.countPendingGrading(homework.id) : undefined
  });
});

// 创建
router.post('/', requireAuth, requireRole('teacher'), (req, res) => {
  const { title, description, pass_score, is_public, is_hidden, leaderboard_enabled, stats_public, questions } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'title is required.' });
  }

  let win;
  let normalized;
  try {
    win = parseWindow(req.body || {});
    normalized = normalizeQuestions(questions);
  } catch (e) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: e.message });
  }

  try {
    const id = repo.createHomeworkWithQuestions({
      homework: { title, description, pass_score, is_public, is_hidden, leaderboard_enabled, stats_public },
      start: win.start,
      end: win.end,
      creatorId: req.user.id,
      questions: normalized
    });
    res.status(201).json(repo.getHomework(id));
  } catch (e) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: e.message });
  }
});

// 更新
router.put('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const homework = repo.getHomework(req.params.id);
  if (!homework) {
    return sendNotFound(res, 'Homework not found.');
  }
  const has = (k) => Object.prototype.hasOwnProperty.call(req.body || {}, k);

  let effectiveStart = homework.start_time;
  let effectiveEnd = homework.end_time;
  try {
    if (has('start_time')) effectiveStart = normalizeHomeworkTime(req.body.start_time);
    if (has('end_time')) effectiveEnd = normalizeHomeworkTime(req.body.end_time);
    validateHomeworkWindow(effectiveStart, effectiveEnd);
  } catch (e) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: e.message });
  }

  let normalized = null;
  if (has('questions')) {
    try {
      normalized = normalizeQuestions(req.body.questions);
    } catch (e) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: e.message });
    }
  }

  try {
    repo.updateHomework(req.params.id, {
      title: has('title') ? sanitizeText(req.body.title).trim() : undefined,
      description: has('description') ? sanitizeText(req.body.description) : undefined,
      start_time: effectiveStart,
      end_time: effectiveEnd,
      pass_score: has('pass_score') ? Number(req.body.pass_score) || 0 : undefined,
      is_public: has('is_public') ? !!req.body.is_public : undefined,
      is_hidden: has('is_hidden') ? !!req.body.is_hidden : undefined,
      leaderboard_enabled: has('leaderboard_enabled') ? !!req.body.leaderboard_enabled : undefined,
      stats_public: has('stats_public') ? !!req.body.stats_public : undefined
    });
    if (normalized !== null) repo.replaceHomeworkQuestions(req.params.id, normalized);
  } catch (e) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: e.message });
  }

  res.json(repo.getHomework(req.params.id));
});

// 删除
router.delete('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const homework = repo.getHomework(req.params.id);
  if (!homework) {
    return sendNotFound(res, 'Homework not found.');
  }
  repo.deleteHomeworkCascade(req.params.id);
  res.json({ message: 'Homework deleted.' });
});

module.exports = router;
module.exports.guardHomework = guardHomework;
module.exports.homeworkWindowError = homeworkWindowError;
