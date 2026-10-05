const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { createRateLimit } = require('../../middleware/ratelimit');
const { enqueueSubmission } = require('../../services/judge');
const { reviewCode, CODE_LENGTH_LIMIT } = require('../../services/security');
const { sanitizeLog, banUserAndRevoke } = require('../../utils/securityHelpers');
const { parsePageLimit } = require('../../utils/pagination');
const { checkExamWindow } = require('../../utils/examWindow');
const { problemVisibilityError } = require('../../utils/visibility');
const { checkExamTimeLimit, startAttempt, SUBMIT_GRACE_MS } = require('../../utils/examAttempts');
const config = require('../../config/config');
const repo = require('../../repositories/submissions');

const { sendNotFound } = require('../../utils/apiErrors');
const { logInfo, logError } = require('../../utils/logger');

const router = express.Router();
const rateLimit = createRateLimit(config.rateLimit.submissions);

router.get('/', requireAuth, (req, res) => {
  const { page = 1, limit = 50, user_id, problem_id, status, score_min, score_max, username } = req.query;
  const { page: pageNum, limit: limitNum, offset } = parsePageLimit(page, limit, 50, 100);
  let where = 'WHERE s.exam_id IS NULL';
  const params = [];

  // 用户筛选：普通用户固定只能看自己的提交，杜绝通过 user_id 参数越权查看他人
  if (req.user.role === 'user') {
    where += ' AND s.user_id = ?';
    params.push(req.user.id);
  } else if (user_id) {
    where += ' AND s.user_id = ?';
    params.push(parseInt(user_id));
  } else if (username) {
    // 转义 LIKE 通配符，防止 % _ 被当作模式匹配（避免越权用 % 匹配所有用户）
    const esc = String(username).replace(/[\\%_]/g, m => `\\${m}`);
    where += ' AND u.username LIKE ? ESCAPE ?';
    params.push(`%${esc}%`, '\\');
  }

  if (problem_id) {
    where += ' AND s.problem_id = ?';
    params.push(parseInt(problem_id));
  }
  if (status) {
    where += ' AND s.status = ?';
    params.push(status);
  }
  // 分数段筛选
  if (score_min !== undefined && score_min !== '') {
    where += ' AND s.score >= ?';
    params.push(parseFloat(score_min));
  }
  if (score_max !== undefined && score_max !== '') {
    where += ' AND s.score <= ?';
    params.push(parseFloat(score_max));
  }

  const total = repo.countList(where, params);
  const submissions = repo.listPage(where, params, limitNum, offset);

  res.json({ total, page: pageNum, limit: limitNum, submissions });
});

router.get('/:id', requireAuth, (req, res) => {
  const submission = repo.findByIdWithProblem(req.params.id);

  if (!submission) {
    return sendNotFound(res, 'Submission not found.');
  }

  if (req.user.role === 'user' && submission.user_id !== req.user.id) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot view other users\' submissions.' });
  }

  const details = repo.listDetails(submission.id);

  const testGroups = repo.listTestGroups(submission.problem_id);

  const files = repo.listFiles(submission.id);
  const canViewCode = req.user.role !== 'user' || submission.user_id === req.user.id;

  res.json({
    ...submission,
    source_code: canViewCode ? submission.source_code : '[HIDDEN]',
    details,
    test_groups: testGroups,
    files: canViewCode ? files : (files.map(f => ({ filename: f.filename, content: '[HIDDEN]' })))
  });
});

// 根据语言推断默认主文件名
function defaultFilename(language) {
  const map = { c: 'main.c', cpp: 'main.cpp', python3: 'main.py', java: 'Main.java', javascript: 'main.js' };
  return map[language] || 'main.txt';
}

router.post('/', requireAuth, rateLimit, async (req, res) => {
  const { problem_id, language, source_code, code, answer_data, files, virtual_contest_id, contest_id } = req.body;

  if (!problem_id) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'problem_id is required.' });
  }
  if (!language) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'language is required.' });
  }

  if (req.user.role !== 'su' && !req.user.submit_lock_exempt) {
    const pending = repo.findPendingByUser(req.user.id);
    if (pending) {
      return res.status(429).json({ code: 4, reason: 'ERR_SUBMIT_LIMIT_EXCEEDED', message: '您有尚未完成的提交，请等待评测完成后再提交。' });
    }
  }

  const problem = repo.findProblemById(problem_id);
  if (!problem) {
    return sendNotFound(res, 'Problem not found.');
  }

  // ── 可见性校验（与 GET /problems/:id 保持一致）──
  // 试卷内编程题（problem.exam_id 非空）的 is_public=0/is_hidden=1 是建卷时的固定写法，
  // 其可见性由下方 exam 分支判定；其余题目一律走统一校验，
  // 否则赛前的比赛题、隐藏题只要猜到 id 就能提交并回读测试数据。
  if (!problem.exam_id) {
    const verr = problemVisibilityError(problem, req);
    if (verr) return res.status(403).json(verr);
  }

  // ── 试卷编程题提交校验 ──
  let examAttempt = null;
  if (problem.exam_id) {
    const exam = repo.findExamById(problem.exam_id);
    if (!exam) {
      return sendNotFound(res, 'Exam not found.');
    }
    if (Number(req.body.exam_id) !== problem.exam_id) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'exam_id 与题目不匹配。' });
    }
    if (!exam.is_public) {
      return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Exam is not public.' });
    }
    if (exam.is_hidden && !['teacher', 'admin', 'su'].includes(req.user.role)) {
      return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Exam not found.' });
    }
    // 时间窗门禁：开考前/结束后禁止提交代码（教师/管理员放行）
    const winMsg = checkExamWindow(exam, req.user);
    if (winMsg) {
      return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: winMsg });
    }
    const inExam = repo.findExamProgramQuestion(exam.id, problem_id);
    if (!inExam) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '该题不是此试卷的编程题。' });
    }
    if (virtual_contest_id || contest_id) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '考试题不支持比赛提交。' });
    }
    // 尝试号 = 已交卷次数 + 1（交卷前的作答归属于即将创建的那次尝试）
    const attemptCount = repo.countExamSubmissions(exam.id, req.user.id);
    if (exam.max_attempts > 0 && attemptCount >= exam.max_attempts) {
      return res.status(400).json({ code: 1, reason: 'ERR_MAX_ATTEMPTS', message: '考试尝试次数已用尽，无法再提交代码。' });
    }
    examAttempt = attemptCount + 1;
    // 作答时限服务端强制（刷新前端倒计时无效）；首次提交时若尚无起始时刻则现起算
    startAttempt(exam.id, req.user.id, examAttempt);
    const timeMsg = checkExamTimeLimit(exam, req.user, examAttempt, { graceMs: SUBMIT_GRACE_MS });
    if (timeMsg) {
      return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: timeMsg });
    }
    // 每次尝试每题仅 1 次提交（teacher+ 可重复提交以便调试）
    if (req.user.role === 'user') {
      const used = repo.countAttemptSubmissions(exam.id, req.user.id, examAttempt, problem_id);
      if (used > 0) {
        return res.status(400).json({ code: 1, reason: 'ERR_ALREADY_SUBMITTED', message: '本场考试该题只能提交一次。' });
      }
    }
  } else if (req.body.exam_id) {
    // 普通题禁止携带 exam_id，防止伪造隔离标记把提交从全站记录里藏掉
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'exam_id 仅用于试卷内编程题。' });
  }

  // 功能9：虚拟比赛提交校验
  let effectiveVirtualContestId = virtual_contest_id || null;
  if (virtual_contest_id) {
    const vc = repo.findVirtualContestById(virtual_contest_id);
    if (!vc) {
      return sendNotFound(res, 'Virtual contest not found.');
    }
    if (vc.user_id !== req.user.id) {
      return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '无权向他人虚拟比赛提交。' });
    }
    if (new Date(vc.end_time).getTime() < Date.now()) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '虚拟比赛已结束，无法提交。' });
    }
    // 题目必须在原比赛的题目列表中
    const inContest = repo.isProblemInContest(vc.contest_id, problem_id);
    if (!inContest) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '此题目不在该虚拟比赛中。' });
    }
  }

  // 直接比赛提交校验（非虚拟比赛）
  if (contest_id && !virtual_contest_id) {
    const contest = repo.findContestById(contest_id);
    if (!contest) {
      return sendNotFound(res, 'Contest not found.');
    }
    // 检查比赛是否正在进行
    const now = Date.now();
    const startTime = new Date(contest.start_time).getTime();
    const endTime = new Date(contest.end_time).getTime();
    if (now < startTime) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '比赛尚未开始。' });
    }
    if (now > endTime) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '比赛已结束。' });
    }
    // 检查题目是否在比赛中
    const inContest = repo.isProblemInContest(contest_id, problem_id);
    if (!inContest) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '此题目不在该比赛中。' });
    }
    // 检查用户是否已加入比赛
    const participant = repo.findContestParticipant(contest_id, req.user.id);
    if (!participant) {
      // 自动加入比赛
      repo.insertContestParticipant(contest_id, req.user.id);
    }
    // 查找或创建该用户在此比赛的虚拟参赛记录，用于关联提交
    let vc = repo.findUserVirtualContest(contest_id, req.user.id);
    if (!vc) {
      // 创建虚拟参赛记录（比赛进行中创建的视为实时参赛）
      const result = repo.insertVirtualContest(
        contest_id, req.user.id,
        Math.floor(startTime / 1000),
        Math.floor(endTime / 1000),
        'active'
      );
      effectiveVirtualContestId = result.lastInsertRowid;
    } else {
      effectiveVirtualContestId = vc.id;
    }
  }

  // 兼容三种格式：files 数组 / code（旧别名）/ source_code（旧字段）
  let normalizedFiles = [];
  let mainCode = source_code || code || '';
  if (Array.isArray(files) && files.length > 0) {
    normalizedFiles = files.map(f => ({ filename: f.filename || defaultFilename(language), content: f.content || '' }));
    mainCode = normalizedFiles[0].content;
  } else if (mainCode) {
    normalizedFiles = [{ filename: defaultFilename(language), content: mainCode }];
  }

  if (problem.problem_type !== 'submit_answer' && normalizedFiles.length === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'source_code is required for this problem type.' });
  }

  if (mainCode && mainCode.length > CODE_LENGTH_LIMIT) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `源代码超过 ${CODE_LENGTH_LIMIT} 字符限制。` });
  }

  // R9-15: 多文件提交的每个文件都要限长 + 文件数量上限，防止灌 10MB junk
  if (normalizedFiles.length > 50) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '文件数量不能超过 50 个。' });
  }
  for (const f of normalizedFiles) {
    if (f.content.length > CODE_LENGTH_LIMIT) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `文件 ${f.filename} 超过 ${CODE_LENGTH_LIMIT} 字符限制。` });
    }
    if (String(f.filename).length > 128) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '文件名过长。' });
    }
  }

  const allowed = JSON.parse(problem.allowed_languages || '[]');
  if (allowed.length > 0 && !allowed.includes(language)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `Language '${language}' is not allowed for this problem.` });
  }

  const langCheck = repo.findEnabledLanguage(language);
  if (!langCheck) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `Language '${language}' is not available.` });
  }

  const newId = repo.insertSubmissionWithFiles({
    userId: req.user.id,
    problemId: problem_id,
    language,
    sourceCode: mainCode,
    answerData: answer_data || '',
    virtualContestId: effectiveVirtualContestId,
    examId: problem.exam_id || null,
    examAttempt: examAttempt || 0,
    files: normalizedFiles
  });

  res.status(201).json({
    submission_id: newId,
    message: 'Submission received and queued for judging.'
  });

  if (mainCode && mainCode.length >= 50) {
    reviewCode(mainCode, language).then(result => {
      if (!result.safe) {
        logInfo('Security', `Malicious code detected in submission #${newId} by user #${req.user.id}: ${sanitizeLog(result.reason)}`);
        // D-M4: 仅正则命中 + AI 双重确认才永久封号；仅拦截不封号，避免误伤
        if (result.confirmed) banUserAndRevoke(req.user.id);
        repo.markSystemError(newId);
      } else {
        repo.markPending(newId);
        enqueueSubmission(newId);
      }
    }).catch(e => {
      logError('INDEX', 'Async security review error:', sanitizeLog(String(e && e.message)));
      // Fail-Closed: 审查服务异常时不放行，标记 system_error 由管理员处理
      repo.markSystemError(newId);
    });
  } else {
    repo.markPending(newId);
    enqueueSubmission(newId);
  }
});

router.get('/:id/detail', requireAuth, (req, res) => {
  const submission = repo.findByIdWithProblem(req.params.id);
  if (!submission) {
    return sendNotFound(res, 'Submission not found.');
  }
  if (req.user.role === 'user' && submission.user_id !== req.user.id) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Access denied.' });
  }
  const details = repo.listDetails(submission.id);
  const testGroups = repo.listTestGroups(submission.problem_id);
  res.json({ submission, details, test_groups: testGroups });
});

// 代码 Diff View：返回同用户同题的上一次提交代码 + 当前代码；WA 时附带期望/实际输出
router.get('/:id/diff', requireAuth, (req, res) => {
  const submission = repo.findForDiff(req.params.id);
  if (!submission) {
    return sendNotFound(res, 'Submission not found.');
  }
  if (req.user.role === 'user' && submission.user_id !== req.user.id) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Access denied.' });
  }

  const prev = repo.findPrevSubmission(submission.user_id, submission.problem_id, submission.id);

  const result = {
    prev_id: prev ? prev.id : null,
    prev_code: prev ? prev.source_code : null,
    curr_code: submission.source_code
  };

  // WA 时附带首个 WA 测试点的期望输出 vs 实际输出
  if (submission.status === 'wrong_answer') {
    const waDetail = repo.findFirstWrongAnswerDetail(submission.id);
    if (waDetail) {
      let expected = waDetail.output_data || '';
      if (!expected && waDetail.output_file) {
        try {
          // D-L5(读取侧)/D-H2: 与判题端 readTestdata 同款包含校验，
          // 只允许读取 problems 目录内文件，杜绝历史脏数据 output_file 指向任意路径被回读。
          // 允许绝对路径（上传/zip 落库形式）但解析后必须仍在 problemsRoot 内；
          // 相对路径（导入落库的纯文件名）以 problemDir（problems/<id>/）为基准解析，
          // 与判题端/导出侧基准一致（9.4）。
          const problemsRoot = config.problemsDir;
          const problemDir = waDetail.problem_id ? path.join(problemsRoot, String(waDetail.problem_id)) : problemsRoot;
          const resolved = path.isAbsolute(waDetail.output_file)
            ? path.normalize(waDetail.output_file)
            : path.resolve(problemDir, waDetail.output_file);
          if (resolved !== problemsRoot && !resolved.startsWith(problemsRoot + path.sep)) {
            // 越界路径：不回读
          } else {
            const stat = fs.statSync(resolved);
            if (stat.size <= 16 * 1024 * 1024) expected = fs.readFileSync(resolved, 'utf8');
          }
        } catch {
          // 读取失败/文件缺失时保持空串兜底，不影响响应
        }
      }
      result.expected_output = expected;
      result.actual_output = waDetail.stdout || '';
      result.wa_test_case_id = waDetail.test_case_id;
    }
  }

  res.json(result);
});

router.post('/:id/rejudge', requireAuth, requireRole('teacher'), (req, res) => {
  const submission = repo.findSubmissionById(req.params.id);
  if (!submission) {
    return sendNotFound(res, 'Submission not found.');
  }
  const prevStatus = submission.status;
  repo.resetForRejudge(submission.id);
  repo.clearDetails(submission.id);
  enqueueSubmission(submission.id, prevStatus);
  res.json({ message: 'Submission queued for re-judge.' });
});

router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const submission = repo.findSubmissionById(req.params.id);
  if (!submission) {
    return sendNotFound(res, 'Submission not found.');
  }
  repo.clearDetails(submission.id);
  repo.deleteSubmission(submission.id);
  res.json({ message: 'Submission deleted.' });
});

module.exports = router;
