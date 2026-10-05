// repositories/exams.js —— 试卷域数据访问层（P1：db.prepare 不再散落在路由层）
// 整体事务封装：createExamWithQuestions（建卷）、replaceExamQuestions（试题全量替换）、
// deleteExamCascade（删卷五连删）、createSubmissionWithAnswers（交卷），失败 ROLLBACK 后 throw。
const db = require('../database/db');
const examProgram = require('../services/examProgram');
const { sanitizeText } = require('../utils/securityHelpers');

const EXAM_PROBLEM_ID_BASE = db.EXAM_PROBLEM_ID_BASE;

// ── 试卷列表（GET /）：可见性过滤与搜索条件在此拼接（动态 SQL 收口到数据访问层）──
function listExams({ isStaff, search, limit, offset }) {
  let where = '';
  const params = [];

  if (!isStaff) {
    where = 'WHERE e.is_public = 1 AND e.is_hidden = 0';
  }

  if (search) {
    const cond = "REPLACE(e.title, ' ', '') LIKE ?";
    where = where ? `${where} AND (${cond})` : `WHERE (${cond})`;
    params.push('%' + search.replace(/\s+/g, '') + '%');
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM exams e ${where}`).get(...params).c;

  const exams = db.prepare(`
    SELECT e.*, u.username as creator_name,
      (SELECT COUNT(*) FROM exam_questions WHERE exam_id = e.id) as question_count,
      (SELECT COUNT(*) FROM exam_submissions WHERE exam_id = e.id) as submission_count
    FROM exams e LEFT JOIN users u ON e.creator_id = u.id
    ${where}
    ORDER BY e.id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return { total, exams };
}

// ── 试卷读取 ──
function getExam(id) {
  return db.prepare('SELECT * FROM exams WHERE id = ?').get(id);
}

function getExamDetail(id) {
  return db.prepare(`
    SELECT e.*, u.username as creator_name
    FROM exams e LEFT JOIN users u ON e.creator_id = u.id
    WHERE e.id = ?
  `).get(id);
}

// ── 试题读取 ──
function listExamQuestionsRaw(examId) {
  return db.prepare('SELECT * FROM exam_questions WHERE exam_id = ?').all(examId);
}

// 详情页：教师 show_answers 时下发全文（含答案），考生只下发安全列
function listExamQuestionsForDetail(examId, withAnswers) {
  if (withAnswers) {
    return db.prepare(`
      SELECT * FROM exam_questions WHERE exam_id = ? ORDER BY sort_order
    `).all(examId);
  }
  return db.prepare(`
    SELECT id, exam_id, question_type, title, options, score, sort_order, is_subjective, problem_id
    FROM exam_questions WHERE exam_id = ? ORDER BY sort_order
  `).all(examId);
}

function isProblemOwnedByExam(problemId, examId) {
  return db.prepare('SELECT id FROM problems WHERE id = ? AND exam_id = ?').get(problemId, examId);
}

function getProblem(problemId) {
  return db.prepare('SELECT * FROM problems WHERE id = ?').get(problemId);
}

function listTestGroups(problemId) {
  return db.prepare('SELECT subtask_id, score FROM test_groups WHERE problem_id = ? ORDER BY id').all(problemId);
}

function listProgramTestcases(problemId) {
  return db.prepare(`
    SELECT tc.input_data as input, tc.output_data as output, tc.score, tc.sort_order, IFNULL(g.subtask_id, '') as subtask
    FROM test_cases tc LEFT JOIN test_groups g ON g.id = tc.group_id
    WHERE tc.problem_id = ? ORDER BY tc.sort_order, tc.id
  `).all(problemId);
}

// 考生当前 attempt 下该题的代码提交：详情页只下发展示列
function getMyProgramSubmission(examId, userId, problemId, attempt) {
  return db.prepare(`
    SELECT id, status, score, created_at FROM submissions
    WHERE exam_id = ? AND user_id = ? AND problem_id = ? AND exam_attempt = ?
    ORDER BY id DESC LIMIT 1
  `).get(examId, userId, problemId, attempt);
}

// 交卷：程序题折算分需要整行（problem_id / score / status）
function getProgramAttemptSubmission(examId, userId, problemId, attempt) {
  return db.prepare(`
    SELECT * FROM submissions
    WHERE exam_id = ? AND user_id = ? AND problem_id = ? AND exam_attempt = ?
    ORDER BY id DESC LIMIT 1
  `).get(examId, userId, problemId, attempt);
}

// ── 考生提交统计（详情页 / 交卷共用）──
function countUserSubmissions(examId, userId) {
  return db.prepare('SELECT COUNT(*) as c FROM exam_submissions WHERE exam_id = ? AND user_id = ?').get(examId, userId).c;
}

function getLastUserSubmission(examId, userId) {
  return db.prepare(`
    SELECT * FROM exam_submissions WHERE exam_id = ? AND user_id = ?
    ORDER BY submitted_at DESC LIMIT 1
  `).get(examId, userId);
}

// ── 交卷：判分循环（计算）留在路由层，落库事务（4/4）在此整体封装 ──
// BEGIN 与 COMMIT 之间只有 DB 写入，无 res 调用；失败 ROLLBACK 后 throw（路由层转 500）
function createSubmissionWithAnswers({ examId, userId, maxScore, rows, totalScore, finalStatus }) {
  db.exec('BEGIN');
  try {
    // 创建提交记录
    const submissionResult = db.prepare(`
      INSERT INTO exam_submissions (exam_id, user_id, status, max_score)
      VALUES (?, ?, 'submitted', ?)
    `).run(examId, userId, maxScore);

    const submissionId = submissionResult.lastInsertRowid;

    // 处理每道题的答案
    const answerStmt = db.prepare(`
      INSERT INTO exam_answers (submission_id, question_id, answer, score, max_score, is_correct, is_subjective, grading_status, code_submission_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const a of rows) {
      answerStmt.run(
        submissionId, a.question_id, a.answer, a.score, a.max_score,
        a.is_correct, a.is_subjective, a.grading_status, a.code_submission_id
      );
    }

    // 更新提交状态：有主观题或程序题判题中 → grading，否则 graded
    db.prepare('UPDATE exam_submissions SET total_score = ?, status = ?, ai_graded = ? WHERE id = ?')
      .run(totalScore, finalStatus, finalStatus === 'graded' ? 1 : 0, submissionId);

    db.exec('COMMIT');
    return submissionId;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原始错误（外层已 rethrow） */ }
    throw e;
  }
}

// ── 试卷更新 ──
function updateExamBase(id, v) {
  db.prepare(`
    UPDATE exams SET
      title = COALESCE(?, title),
      description = COALESCE(?, description),
      time_limit = COALESCE(?, time_limit),
      pass_score = COALESCE(?, pass_score),
      max_attempts = COALESCE(?, max_attempts),
      show_answer = COALESCE(?, show_answer),
      is_public = COALESCE(?, is_public),
      is_hidden = COALESCE(?, is_hidden),
      allow_ai_grading = COALESCE(?, allow_ai_grading),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    v.title,
    v.description,
    v.time_limit,
    v.pass_score,
    v.max_attempts,
    v.show_answer,
    v.is_public,
    v.is_hidden,
    v.allow_ai_grading,
    id
  );
}

// 时间窗 / 排行榜设置 / 手动封解榜状态机（取值由路由层算好后整体写入）
function updateExamWindow(id, v) {
  db.prepare(`
    UPDATE exams SET
      start_time = ?, end_time = ?, freeze_minutes = ?,
      leaderboard_enabled = ?, leaderboard_view_incomplete = ?,
      manual_frozen = ?, manual_frozen_at = ?, unfrozen = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    v.start_time,
    v.end_time,
    v.freeze_minutes,
    v.leaderboard_enabled,
    v.leaderboard_view_incomplete,
    v.manual_frozen,
    v.manual_frozen_at,
    v.unfrozen,
    id
  );
}

// ── 排行榜 ──
function hasUserSubmission(examId, userId) {
  return db.prepare('SELECT 1 as x FROM exam_submissions WHERE exam_id = ? AND user_id = ? LIMIT 1').get(examId, userId);
}

// 封榜时只统计封榜时刻前的交卷；教师/管理员不入榜
function getLeaderboardRows(examId, freezeAt) {
  let sql = `
    SELECT es.user_id, es.total_score, es.max_score, es.submitted_at, es.status, u.username, u.nickname,
      (SELECT COUNT(*) FROM exam_submissions x WHERE x.exam_id = es.exam_id AND x.user_id = es.user_id) as attempts
    FROM exam_submissions es JOIN users u ON u.id = es.user_id
    WHERE es.exam_id = ? AND u.role = 'user'`;
  const params = [examId];
  if (freezeAt) {
    sql += ' AND es.submitted_at <= ?';
    params.push(freezeAt);
  }
  return db.prepare(sql).all(...params);
}

// ── 事务（1/4）：创建试卷 ──
// 建卷全链路原子（试卷行 + 题目 + 内部编程题 + 总分）：事务替代原"失败补偿删除"——
// 补偿自身失败会留下孤儿试卷。BEGIN→COMMIT 之间无 await，单连接不会被其他请求串入。
// 失败 ROLLBACK 后 throw，由路由层转 400（与改造前一致）
function createExamWithQuestions({ exam, start, end, freezeMinutes, creatorId, questions }) {
  let examId;
  try {
    db.exec('BEGIN');
    db.exec('PRAGMA defer_foreign_keys = ON');
    const result = db.prepare(`
      INSERT INTO exams (title, description, time_limit, pass_score, max_attempts, show_answer, is_public, is_hidden, allow_ai_grading,
        start_time, end_time, freeze_minutes, leaderboard_enabled, leaderboard_view_incomplete, creator_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sanitizeText(exam.title).trim(),
      sanitizeText(exam.description || ''),
      exam.time_limit || 0,
      exam.pass_score || 0,
      exam.max_attempts || 1,
      exam.show_answer ? 1 : 0,
      exam.is_public !== false ? 1 : 0,
      exam.is_hidden ? 1 : 0,
      exam.allow_ai_grading !== false ? 1 : 0,
      start,
      end,
      freezeMinutes,
      exam.leaderboard_enabled === false ? 0 : 1,
      exam.leaderboard_view_incomplete ? 1 : 0,
      creatorId
    );

    examId = result.lastInsertRowid;

    // 创建题目
    if (questions.length > 0) {
      const stmt = db.prepare(`
        INSERT INTO exam_questions (exam_id, question_type, title, options, correct_answer, score, sort_order, is_subjective, ai_grading_prompt, problem_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      let totalScore = 0;
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        let problemId = null;
        if (q.question_type === 'program') {
          problemId = upsertProgramProblem(examId, null, q, creatorId);
        }
        stmt.run(
          examId,
          q.question_type,
          q.question_type === 'program' ? q.title : sanitizeText(q.title),
          q.question_type === 'program' ? '[]' : JSON.stringify(q.options || []),
          q.correct_answer || '',
          q.score || 0,
          q.sort_order || i,
          q.is_subjective ? 1 : 0,
          q.ai_grading_prompt || '',
          problemId
        );
        totalScore += q.score || 0;
      }

      // 更新总分
      db.prepare('UPDATE exams SET total_score = ? WHERE id = ?').run(totalScore, examId);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原始错误（外层已 rethrow） */ }
    throw e;
  }
  return examId;
}

// ── 事务（2/4）：试题全量替换 ──
// 试题全量替换必须原子（先删后插 + 删旧编程题 + 总分更新）：
// 原实现失败时直接 400 不补偿，非编程题已删而新题未插会留下残卷。
// 失败 ROLLBACK 后 throw，由路由层转 400（与改造前一致）
function replaceExamQuestions(examId, questions, creatorId, existing) {
  const existingByPid = new Map();
  for (const x of existing) {
    if (x.question_type === 'program' && x.problem_id) existingByPid.set(x.problem_id, x);
  }

  try {
    db.exec('BEGIN');
    db.exec('PRAGMA defer_foreign_keys = ON');
    // 1) 非编程题：先删后插（保持原有全量替换语义，旧答题记录随之级联清理）
    db.prepare("DELETE FROM exam_questions WHERE exam_id = ? AND question_type != 'program'").run(examId);

    const stmt = db.prepare(`
      INSERT INTO exam_questions (exam_id, question_type, title, options, correct_answer, score, sort_order, is_subjective, ai_grading_prompt, problem_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updStmt = db.prepare(`
      UPDATE exam_questions SET title = ?, score = ?, sort_order = ? WHERE id = ?
    `);

    let totalScore = 0;
    const keptPids = new Set();

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (q.question_type === 'program') {
        const matched = q.problem_id ? existingByPid.get(q.problem_id) : null;
        const problemId = upsertProgramProblem(
          examId,
          matched ? matched.problem_id : q.problem_id,
          q,
          creatorId
        );
        keptPids.add(problemId);
        if (matched) {
          updStmt.run(q.title, q.score, q.sort_order ?? matched.sort_order ?? i, matched.id);
        } else {
          stmt.run(examId, 'program', q.title, '[]', '', q.score, q.sort_order || i, 0, '', problemId);
        }
      } else {
        stmt.run(
          examId,
          q.question_type,
          sanitizeText(q.title),
          JSON.stringify(q.options || []),
          q.correct_answer || '',
          q.score || 0,
          q.sort_order || i,
          q.is_subjective ? 1 : 0,
          q.ai_grading_prompt || '',
          null
        );
      }
      totalScore += q.score || 0;
    }

    // 2) 未出现在新列表中的编程题：连同内部题目一起删除（级联清理测试数据/代码提交/答题记录）
    for (const x of existing) {
      if (x.question_type !== 'program') continue;
      if (x.problem_id && keptPids.has(x.problem_id)) continue;
      if (x.problem_id) {
        db.prepare('DELETE FROM problems WHERE id = ? AND exam_id = ?').run(x.problem_id, examId);
      } else {
        db.prepare('DELETE FROM exam_questions WHERE id = ?').run(x.id);
      }
    }

    db.prepare('UPDATE exams SET total_score = ?, updated_at = datetime(\'now\') WHERE id = ?').run(totalScore, examId);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原始错误（外层已 rethrow） */ }
    throw e;
  }
}

// ── 事务（3/4）：删除试卷 ──
// 五连删必须原子：否则中途失败会留下半套试卷（答案/交卷行已删而试卷仍在）
// 失败 ROLLBACK 后 throw，由 Express 错误中间件转 500（与改造前一致）
function deleteExamCascade(examId) {
  try {
    db.exec('BEGIN');
    db.exec('PRAGMA defer_foreign_keys = ON');
    db.prepare('DELETE FROM exam_answers WHERE submission_id IN (SELECT id FROM exam_submissions WHERE exam_id = ?)').run(examId);
    db.prepare('DELETE FROM exam_submissions WHERE exam_id = ?').run(examId);
    db.prepare('DELETE FROM exam_questions WHERE exam_id = ?').run(examId);
    // 试卷内编程题（级联清理其代码提交/测试数据/答题记录；须先于 exam 行删除）
    db.prepare('DELETE FROM problems WHERE exam_id = ?').run(examId);
    db.prepare('DELETE FROM exams WHERE id = ?').run(examId);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原始错误（外层已 rethrow） */ }
    throw err;
  }
}

// ── 提交详情 / 列表（GET /:id/submission/:sid、GET /:id/submissions）──
function getSubmissionForUser(sid, userId) {
  return db.prepare(`
    SELECT es.*, e.title as exam_title, e.show_answer, e.total_score as exam_total_score
    FROM exam_submissions es
    JOIN exams e ON e.id = es.exam_id
    WHERE es.id = ? AND es.user_id = ?
  `).get(sid, userId);
}

// 教师查看他人提交：ownership 并入 SQL
function getSubmissionWithExam(sid, examId) {
  return db.prepare(`
    SELECT es.*, e.title as exam_title, e.show_answer, e.total_score as exam_total_score
    FROM exam_submissions es
    JOIN exams e ON e.id = es.exam_id
    WHERE es.id = ? AND es.exam_id = ?
  `).get(sid, examId);
}

function listSubmissionAnswers(sid) {
  return db.prepare(`
    SELECT ea.*, eq.title as question_title, eq.question_type, eq.options, eq.correct_answer, eq.is_subjective
    FROM exam_answers ea
    JOIN exam_questions eq ON eq.id = ea.question_id
    WHERE ea.submission_id = ?
    ORDER BY eq.sort_order
  `).all(sid);
}

function countSubmissionsByExam(examId) {
  return db.prepare('SELECT COUNT(*) as c FROM exam_submissions WHERE exam_id = ?').get(examId).c;
}

function listSubmissionsByExam(examId, limit, offset) {
  return db.prepare(`
    SELECT es.*, u.username, u.nickname
    FROM exam_submissions es
    JOIN users u ON u.id = es.user_id
    WHERE es.exam_id = ?
    ORDER BY es.submitted_at DESC
    LIMIT ? OFFSET ?
  `).all(examId, limit, offset);
}

// ── 批改（教师人工批改 / AI 批改共用的提交读取）──
function findSubmissionInExam(sid, examId) {
  return db.prepare('SELECT * FROM exam_submissions WHERE id = ? AND exam_id = ?').get(sid, examId);
}

function listAnswersBySubmission(sid) {
  return db.prepare('SELECT * FROM exam_answers WHERE submission_id = ?').all(sid);
}

function gradeAnswerHuman(score, comment, answerId) {
  db.prepare(`
    UPDATE exam_answers SET score = ?, is_correct = CASE WHEN ? >= max_score THEN 1 ELSE 0 END, human_comment = ?, grading_status = 'human_graded', graded_at = datetime('now')
    WHERE id = ?
  `).run(score, score, comment, answerId);
}

function updateSubmissionHumanGrade(sid, totalScore, graderId) {
  db.prepare(`
    UPDATE exam_submissions SET total_score = ?, status = 'graded', human_graded = 1, graded_at = datetime('now'), graded_by = ?
    WHERE id = ?
  `).run(totalScore, graderId, sid);
}

function listPendingSubjectiveAnswers(sid) {
  return db.prepare(`
    SELECT ea.*, eq.title as question_title, eq.question_type, eq.correct_answer, eq.ai_grading_prompt
    FROM exam_answers ea
    JOIN exam_questions eq ON eq.id = ea.question_id
    WHERE ea.submission_id = ? AND ea.is_subjective = 1 AND ea.grading_status = 'pending'
  `).all(sid);
}

function gradeAnswerAi(score, comment, answerId) {
  db.prepare(`
    UPDATE exam_answers SET score = ?, is_correct = CASE WHEN ? >= max_score THEN 1 ELSE 0 END, ai_comment = ?, grading_status = 'ai_graded', graded_at = datetime('now')
    WHERE id = ?
  `).run(score, score, comment, answerId);
}

function sumAnswerScores(sid) {
  return db.prepare('SELECT SUM(score) as total FROM exam_answers WHERE submission_id = ?').get(sid).total;
}

function updateSubmissionAiGrade(sid, totalScore, status, aiGraded, graderId) {
  db.prepare(`
    UPDATE exam_submissions SET total_score = ?, status = ?, ai_graded = ?, graded_by = ?,
      graded_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END
    WHERE id = ?
  `).run(totalScore, status, aiGraded, graderId, aiGraded, sid);
}

// ── 试卷内编程题（内部题目 + 测试数据，仅供建卷/换题事务调用）──
// 试卷内编程题的题目 id 分配（EXAM_PROBLEM_ID_BASE 起的独立号段）
function nextExamProblemId() {
  const row = db.prepare('SELECT MAX(id) as m FROM problems WHERE id >= ?').get(EXAM_PROBLEM_ID_BASE);
  return Math.max(EXAM_PROBLEM_ID_BASE, (row?.m || 0) + 1);
}

// 启用语言清单（供路由层 normalizeProgramQuestion 过滤 allowed_languages）
function enabledLanguageNames() {
  return new Set(db.prepare('SELECT name FROM languages WHERE is_enabled = 1').all().map(r => r.name));
}

// 创建或更新试卷内编程题的 problems 行 + 测试数据（inline 落库，不写磁盘）
function upsertProgramProblem(examId, existingProblemId, norm, creatorId) {
  let problemId = existingProblemId;
  if (problemId) {
    const cur = isProblemOwnedByExam(problemId, examId);
    if (!cur) throw new Error('problem_id 不属于该试卷。');
    db.prepare(`
      UPDATE problems SET title = ?, description = ?, background = ?, input_desc = ?, output_desc = ?, hint = ?,
        time_limit = ?, memory_limit = ?, allowed_languages = ?, updated_at = datetime('now')
      WHERE id = ? AND exam_id = ?
    `).run(
      norm.title || 'Program', norm.problem.description, norm.problem.background,
      norm.problem.input_desc, norm.problem.output_desc, norm.problem.hint,
      norm.problem.time_limit, norm.problem.memory_limit, norm.problem.allowed_languages,
      problemId, examId
    );
  } else {
    problemId = nextExamProblemId();
    db.prepare(`
      INSERT INTO problems (id, title, description, background, input_desc, output_desc, hint, time_limit, memory_limit,
        problem_type, compare_mode, allowed_languages, subtask_mode, is_public, is_hidden, created_by, exam_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'traditional', 'text_strict', ?, 'simple', 0, 1, ?, ?)
    `).run(
      problemId, norm.title || 'Program', norm.problem.description, norm.problem.background,
      norm.problem.input_desc, norm.problem.output_desc, norm.problem.hint,
      norm.problem.time_limit, norm.problem.memory_limit, norm.problem.allowed_languages,
      creatorId, examId
    );
  }

  // 全量替换测试数据；带 subtask 的测试点建组（组分 = 组内测试点分之和）
  db.prepare('DELETE FROM test_cases WHERE problem_id = ?').run(problemId);
  db.prepare('DELETE FROM test_groups WHERE problem_id = ?').run(problemId);
  const groupIds = new Map();
  const insGroup = db.prepare('INSERT INTO test_groups (problem_id, subtask_id, score, aggregator, dependency) VALUES (?, ?, ?, ?, ?)');
  const insCase = db.prepare('INSERT INTO test_cases (problem_id, group_id, input_data, output_data, score, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
  norm.testcases.forEach((tc, i) => {
    let groupId = null;
    if (tc.subtask) {
      if (!groupIds.has(tc.subtask)) {
        const g = insGroup.run(problemId, tc.subtask, 0, 'sum', '[]');
        groupIds.set(tc.subtask, g.lastInsertRowid);
      }
      groupId = groupIds.get(tc.subtask);
    }
    insCase.run(problemId, groupId, tc.input, tc.output, tc.score, i + 1);
  });
  // 组分回填 = 组内测试点分之和（判题端分组计分的展示口径）
  for (const gid of groupIds.values()) {
    const sum = db.prepare('SELECT COALESCE(SUM(score), 0) as s FROM test_cases WHERE group_id = ?').get(gid).s;
    db.prepare('UPDATE test_groups SET score = ? WHERE id = ?').run(sum, gid);
  }
  return problemId;
}

// 题目变更后的汇总刷新：同步 program 答题满分/折算分，并重算各次提交总分与试卷总分
function refreshExamScores(examId) {
  const answers = db.prepare(`
    SELECT ea.id as answer_id, ea.code_submission_id, ea.grading_status, eq.id as question_id, eq.question_type
    FROM exam_answers ea
    JOIN exam_submissions es ON es.id = ea.submission_id
    JOIN exam_questions eq ON eq.id = ea.question_id
    WHERE es.exam_id = ? AND eq.question_type = 'program'
  `).all(examId);
  const updAnswer = db.prepare('UPDATE exam_answers SET score = ?, max_score = ?, is_correct = ?, grading_status = ?, graded_at = datetime(\'now\') WHERE id = ?');
  for (const a of answers) {
    const q = db.prepare('SELECT * FROM exam_questions WHERE id = ?').get(a.question_id);
    if (!q) continue;
    if (a.code_submission_id) {
      const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(a.code_submission_id);
      const r = examProgram.scoreFromSubmission(q, sub);
      if (r.pending) continue; // 判题中：保持 pending，判完由 judge 回填
      updAnswer.run(r.score, q.score, r.correct ? 1 : 0, 'ai_graded', a.answer_id);
      continue;
    }
    db.prepare('UPDATE exam_answers SET max_score = ?, score = 0, is_correct = 0 WHERE id = ?').run(q.score, a.answer_id);
  }
  const subs = db.prepare('SELECT id FROM exam_submissions WHERE exam_id = ?').all(examId);
  for (const s of subs) examProgram.recomputeExamSubmission(s.id);
  db.prepare(`
    UPDATE exam_submissions SET max_score = (SELECT COALESCE(SUM(score), 0) FROM exam_questions WHERE exam_id = ?)
    WHERE exam_id = ?
  `).run(examId, examId);
}

module.exports = {
  listExams,
  getExam,
  getExamDetail,
  listExamQuestionsRaw,
  listExamQuestionsForDetail,
  isProblemOwnedByExam,
  getProblem,
  listTestGroups,
  listProgramTestcases,
  getProgramAttemptSubmission,
  getMyProgramSubmission,
  countUserSubmissions,
  getLastUserSubmission,
  createSubmissionWithAnswers,
  updateExamBase,
  updateExamWindow,
  hasUserSubmission,
  getLeaderboardRows,
  createExamWithQuestions,
  replaceExamQuestions,
  deleteExamCascade,
  getSubmissionForUser,
  getSubmissionWithExam,
  listSubmissionAnswers,
  countSubmissionsByExam,
  listSubmissionsByExam,
  findSubmissionInExam,
  listAnswersBySubmission,
  gradeAnswerHuman,
  updateSubmissionHumanGrade,
  listPendingSubjectiveAnswers,
  gradeAnswerAi,
  sumAnswerScores,
  updateSubmissionAiGrade,
  enabledLanguageNames,
  refreshExamScores
};
