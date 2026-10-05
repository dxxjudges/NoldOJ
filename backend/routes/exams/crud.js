// routes/exams/crud.js —— 试卷 CRUD 与时间窗（列表/详情/创建/更新/删除）
const express = require('express');
const { requireAuth, requireRole, optionalAuth } = require('../../middleware/auth');
const { parsePageLimit } = require('../../utils/pagination');
const { sanitizeText } = require('../../utils/securityHelpers');
const { normalizeExamTime, validateExamWindow, examWindowState, toSqliteUtc } = require('../../utils/examWindow');
const { startAttempt } = require('../../utils/examAttempts');
const repo = require('../../repositories/exams');
const { clampInt } = require('./helpers');
const { normalizeProgramQuestion } = require('./questions');

const { sendNotFound } = require('../../utils/apiErrors');

const router = express.Router();

// 获取试卷列表
router.get('/', optionalAuth, (req, res) => {
  const { page = 1, limit = 20, search = '' } = req.query;
  const { page: pageNum, limit: limitNum, offset } = parsePageLimit(page, limit, 20, 100);

  const isStaff = !!req.user && ['teacher', 'admin', 'su'].includes(req.user.role);
  const { total, exams } = repo.listExams({ isStaff, search, limit: limitNum, offset });

  res.json({ total, page: pageNum, limit: limitNum, exams });
});

// 获取试卷详情
router.get('/:id', optionalAuth, (req, res) => {
  const exam = repo.getExamDetail(req.params.id);

  if (!exam) {
    return sendNotFound(res, 'Exam not found.');
  }

  const isStaffUser = !!req.user && ['teacher', 'admin', 'su'].includes(req.user.role);

  if (exam.is_hidden && !isStaffUser) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Exam not found.' });
  }
  // 私有试卷：与列表页（WHERE e.is_public=1）、交卷（POST /:id/submit）保持一致，
  // 否则匿名用户可直链读取 is_public=0 试卷的全部题干与选项
  if (!exam.is_public && !isStaffUser) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Exam is not public.' });
  }

  // 时间窗：开考前对考生不可见（教师/管理员可预览）；结束后仍可查看结果
  if (examWindowState(exam) === 'not_started' && !isStaffUser) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '考试尚未开始。' });
  }

  // 获取题目（不含答案，除非是教师+且有查询参数 show_answers=true）
  const showAnswers = req.query.show_answers === 'true' && isStaffUser;

  const questions = repo.listExamQuestionsForDetail(exam.id, showAnswers);

  // 如果已登录，获取用户提交记录
  let userSubmission = null;
  let currentAttempt = 1;
  let attemptStartedAt = null;
  if (req.user) {
    const attemptCount = repo.countUserSubmissions(exam.id, req.user.id);
    currentAttempt = attemptCount + 1;
    userSubmission = repo.getLastUserSubmission(exam.id, req.user.id);
    // 首次进入即起算作答时限（刷新不重置）；教师/管理员不计时
    if (exam.time_limit > 0 && !isStaffUser) {
      attemptStartedAt = startAttempt(exam.id, req.user.id, currentAttempt);
    }
  }

  // 编程题：下发内部题目配置；教师 show_answers 时附题目全文与测试数据；考生附当前 attempt 的提交状态
  const programQuestions = questions.filter(q => q.question_type === 'program');
  if (programQuestions.length > 0) {
    for (const q of programQuestions) {
      const p = q.problem_id ? repo.getProblem(q.problem_id) : null;
      const program = {
        problem_id: q.problem_id || null,
        description: p ? p.description : '',
        background: p ? p.background : '',
        input_desc: p ? p.input_desc : '',
        output_desc: p ? p.output_desc : '',
        hint: p ? p.hint : '',
        time_limit: p ? p.time_limit : 1000,
        memory_limit: p ? p.memory_limit : 256,
        allowed_languages: (() => {
          try { return JSON.parse(p ? p.allowed_languages : '[]'); } catch { return []; }
        })()
      };
      if (showAnswers && q.problem_id) {
        program.groups = repo.listTestGroups(q.problem_id);
        program.testcases = repo.listProgramTestcases(q.problem_id);
        program.problem = p;
      }
      if (req.user && q.problem_id) {
        const mine = repo.getMyProgramSubmission(exam.id, req.user.id, q.problem_id, currentAttempt);
        program.attempt_no = currentAttempt;
        program.my_submission = mine || null;
      }
      q.program = program;
    }
  }

  res.json({
    ...exam,
    questions,
    user_submission: userSubmission,
    current_attempt: currentAttempt,
    // 服务端计时锚点：前端用 (server_now - attempt_started_at) 计算剩余时间，
    // 避免依赖客户端时钟，也使刷新页面无法重置倒计时
    attempt_started_at: attemptStartedAt,
    server_now: new Date().toISOString()
  });
});

// 创建试卷
router.post('/', requireAuth, requireRole('teacher'), (req, res) => {
  const { title, description, time_limit, pass_score, max_attempts, show_answer, is_public, is_hidden, allow_ai_grading,
    start_time, end_time, freeze_minutes, leaderboard_enabled, leaderboard_view_incomplete, questions } = req.body;

  if (!title) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'title is required.' });
  }

  // 时间窗校验（须同时设置或同时留空）
  let st;
  let et;
  try {
    st = normalizeExamTime(start_time);
    et = normalizeExamTime(end_time);
    validateExamWindow(st, et);
  } catch (e) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: e.message });
  }

  // 题目预校验（编程题在此解析 ZIP/inline 测试数据），失败直接 400，避免建出半套试卷
  let normalizedQuestions = [];
  if (Array.isArray(questions) && questions.length > 0) {
    try {
      normalizedQuestions = questions.map(q => (q && q.question_type === 'program') ? normalizeProgramQuestion(q) : q);
    } catch (e) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: e.message });
    }
  }

  // 建卷事务整体封装在 repo.createExamWithQuestions（试卷行 + 题目 + 内部编程题 + 总分原子）
  let examId;
  try {
    examId = repo.createExamWithQuestions({
      exam: {
        title,
        description,
        time_limit,
        pass_score,
        max_attempts,
        show_answer,
        is_public,
        is_hidden,
        allow_ai_grading,
        leaderboard_enabled,
        leaderboard_view_incomplete
      },
      start: st,
      end: et,
      freezeMinutes: clampInt(freeze_minutes, 0, 10080, 0),
      creatorId: req.user.id,
      questions: normalizedQuestions
    });
  } catch (e) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: e.message });
  }

  const exam = repo.getExam(examId);
  res.status(201).json(exam);
});

// 更新试卷
router.put('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const exam = repo.getExam(req.params.id);
  if (!exam) {
    return sendNotFound(res, 'Exam not found.');
  }

  const { title, description, time_limit, pass_score, max_attempts, show_answer, is_public, is_hidden, allow_ai_grading, questions } = req.body;
  const has = (k) => Object.prototype.hasOwnProperty.call(req.body, k);

  // 时间窗：先算出生效值并校验，失败不动库（未提供则沿用原值）
  let effStart = exam.start_time;
  let effEnd = exam.end_time;
  try {
    if (has('start_time')) effStart = normalizeExamTime(req.body.start_time);
    if (has('end_time')) effEnd = normalizeExamTime(req.body.end_time);
    validateExamWindow(effStart, effEnd);
  } catch (e) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: e.message });
  }

  repo.updateExamBase(req.params.id, {
    title: title !== undefined ? sanitizeText(title).trim() : null,
    description: description !== undefined ? sanitizeText(description) : null,
    time_limit: time_limit !== undefined ? time_limit : null,
    pass_score: pass_score !== undefined ? pass_score : null,
    max_attempts: max_attempts !== undefined ? max_attempts : null,
    show_answer: show_answer !== undefined ? (show_answer ? 1 : 0) : null,
    is_public: is_public !== undefined ? (is_public ? 1 : 0) : null,
    is_hidden: is_hidden !== undefined ? (is_hidden ? 1 : 0) : null,
    allow_ai_grading: allow_ai_grading !== undefined ? (allow_ai_grading ? 1 : 0) : null
  });

  // 时间窗 / 排行榜设置 / 手动封解榜状态机：
  // 封榜动作（manual_frozen=1）强制解除手动解榜标记；解榜动作清空快照锚点
  const newManualFrozen = has('manual_frozen') ? (req.body.manual_frozen ? 1 : 0) : (exam.manual_frozen || 0);
  let newUnfrozen = has('unfrozen') ? (req.body.unfrozen ? 1 : 0) : (exam.unfrozen || 0);
  if (newManualFrozen) newUnfrozen = 0;
  let newFrozenAt = exam.manual_frozen_at || null;
  if (has('manual_frozen')) {
    newFrozenAt = newManualFrozen ? toSqliteUtc(Date.now()) : null;
  }
  repo.updateExamWindow(req.params.id, {
    start_time: effStart,
    end_time: effEnd,
    freeze_minutes: has('freeze_minutes') ? clampInt(req.body.freeze_minutes, 0, 10080, 0) : (exam.freeze_minutes || 0),
    leaderboard_enabled: has('leaderboard_enabled') ? (req.body.leaderboard_enabled ? 1 : 0) : (exam.leaderboard_enabled || 1),
    leaderboard_view_incomplete: has('leaderboard_view_incomplete') ? (req.body.leaderboard_view_incomplete ? 1 : 0) : (exam.leaderboard_view_incomplete || 0),
    manual_frozen: newManualFrozen,
    manual_frozen_at: newFrozenAt,
    unfrozen: newUnfrozen
  });

  // 如果提供了题目：非编程题全量替换；编程题按 problem_id diff（保留已判答题记录）
  if (Array.isArray(questions)) {
    // 预校验（编程题解析测试数据 + problem_id 归属），失败不动库
    let normalized;
    try {
      normalized = questions.map(q => (q && q.question_type === 'program') ? normalizeProgramQuestion(q) : q);
    } catch (e) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: e.message });
    }
    for (const q of normalized) {
      if (q.question_type === 'program' && q.problem_id) {
        const owned = repo.isProblemOwnedByExam(q.problem_id, req.params.id);
        if (!owned) {
          return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'problem_id 不属于该试卷。' });
        }
      }
    }

    const existing = repo.listExamQuestionsRaw(req.params.id);

    try {
      // 试题全量替换事务整体封装在 repo.replaceExamQuestions（先删后插 + 删旧编程题 + 总分更新原子）
      repo.replaceExamQuestions(req.params.id, normalized, exam.creator_id, existing);
    } catch (e) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: e.message });
    }

    // 题分/测试数据可能已变：同步 program 答题满分与折算分，重算各次提交
    repo.refreshExamScores(req.params.id);
  }

  const updated = repo.getExam(req.params.id);
  res.json(updated);
});

// 删除试卷
router.delete('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const exam = repo.getExam(req.params.id);
  if (!exam) {
    return sendNotFound(res, 'Exam not found.');
  }

  // 五连删事务整体封装在 repo.deleteExamCascade；失败 throw 经 Express 错误中间件转 500
  repo.deleteExamCascade(req.params.id);

  res.json({ message: 'Exam deleted.' });
});

module.exports = router;
