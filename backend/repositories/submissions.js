// repositories/submissions.js —— 提交域数据访问层（P1：db.prepare 不再散落在路由层）
const db = require('../database/db');

// ── 提交记录列表（GET /）──
function countList(where, params) {
  return db.prepare(`SELECT COUNT(*) as c FROM submissions s LEFT JOIN users u ON s.user_id = u.id ${where}`).get(...params).c;
}

function listPage(where, params, limit, offset) {
  return db.prepare(`
    SELECT s.id, s.user_id, s.problem_id, s.language, s.status, s.score, s.time_used, s.memory_used, s.created_at,
           u.username, p.title as problem_title
    FROM submissions s
    LEFT JOIN users u ON s.user_id = u.id
    LEFT JOIN problems p ON s.problem_id = p.id
    ${where} ORDER BY s.id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
}

// ── 提交详情（GET /:id 与 GET /:id/detail 共用）──
function findByIdWithProblem(id) {
  return db.prepare(`
    SELECT s.*, u.username, p.title as problem_title, p.time_limit, p.memory_limit
    FROM submissions s
    LEFT JOIN users u ON s.user_id = u.id
    LEFT JOIN problems p ON s.problem_id = p.id
    WHERE s.id = ?
  `).get(id);
}

function listDetails(submissionId) {
  return db.prepare(`
    SELECT sd.*, tg.subtask_id as group_subtask_id, tg.score as group_score
    FROM submission_details sd
    LEFT JOIN test_groups tg ON sd.group_id = tg.id
    WHERE sd.submission_id = ?
    ORDER BY COALESCE(sd.group_id, 0), sd.id
  `).all(submissionId);
}

function listTestGroups(problemId) {
  return db.prepare('SELECT id, subtask_id, score FROM test_groups WHERE problem_id = ? ORDER BY id').all(problemId);
}

function listFiles(submissionId) {
  return db.prepare('SELECT filename, content FROM submission_files WHERE submission_id = ? ORDER BY id').all(submissionId);
}

// ── 提交前校验（POST /）──
function findPendingByUser(userId) {
  return db.prepare("SELECT id FROM submissions WHERE user_id = ? AND status IN ('pending_review','pending','running','compiling','judging') LIMIT 1").get(userId);
}

function findProblemById(problemId) {
  return db.prepare('SELECT * FROM problems WHERE id = ?').get(problemId);
}

function findExamById(examId) {
  return db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
}

function findExamProgramQuestion(examId, problemId) {
  return db.prepare("SELECT id FROM exam_questions WHERE exam_id = ? AND problem_id = ? AND question_type = 'program'").get(examId, problemId);
}

function countExamSubmissions(examId, userId) {
  return db.prepare('SELECT COUNT(*) as c FROM exam_submissions WHERE exam_id = ? AND user_id = ?').get(examId, userId).c;
}

function countAttemptSubmissions(examId, userId, examAttempt, problemId) {
  return db.prepare('SELECT COUNT(*) as c FROM submissions WHERE exam_id = ? AND user_id = ? AND exam_attempt = ? AND problem_id = ?')
    .get(examId, userId, examAttempt, problemId).c;
}

function findEnabledLanguage(language) {
  return db.prepare('SELECT id FROM languages WHERE name = ? AND is_enabled = 1').get(language);
}

// ── 比赛 / 虚拟比赛（POST /）──
function findVirtualContestById(virtualContestId) {
  return db.prepare('SELECT * FROM virtual_contests WHERE id = ?').get(virtualContestId);
}

function isProblemInContest(contestId, problemId) {
  return db.prepare('SELECT 1 FROM contest_problems WHERE contest_id = ? AND problem_id = ?').get(contestId, problemId);
}

function findContestById(contestId) {
  return db.prepare('SELECT * FROM contests WHERE id = ?').get(contestId);
}

function findContestParticipant(contestId, userId) {
  return db.prepare('SELECT id FROM contest_participants WHERE contest_id = ? AND user_id = ?').get(contestId, userId);
}

function insertContestParticipant(contestId, userId) {
  db.prepare('INSERT INTO contest_participants (contest_id, user_id) VALUES (?, ?)').run(contestId, userId);
}

function findUserVirtualContest(contestId, userId) {
  return db.prepare('SELECT id FROM virtual_contests WHERE contest_id = ? AND user_id = ?').get(contestId, userId);
}

function insertVirtualContest(contestId, userId, startSeconds, endSeconds, status) {
  return db.prepare('INSERT INTO virtual_contests (contest_id, user_id, start_time, end_time, status) VALUES (?, ?, datetime(?, \'unixepoch\'), datetime(?, \'unixepoch\'), ?)').run(
    contestId, userId,
    startSeconds,
    endSeconds,
    status
  );
}

// 提交行与多文件行必须同生共死：文件写入失败时不得留下缺文件的提交记录（事务内无 await，单连接不会被其他请求串入）
// 失败 ROLLBACK 后 throw，由路由层的 try/catch 透传给 Express 错误中间件（与改造前一致）
function insertSubmissionWithFiles(payload) {
  const { userId, problemId, language, sourceCode, answerData, virtualContestId, examId, examAttempt, files } = payload;
  try {
    db.exec('BEGIN');
    const newId = db.findNextId('submissions');
    db.prepare('INSERT INTO submissions (id, user_id, problem_id, language, source_code, answer_data, status, virtual_contest_id, exam_id, exam_attempt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      newId, userId, problemId, language, sourceCode, answerData, 'pending_review', virtualContestId,
      examId, examAttempt
    );

    // 写入多文件记录
    if (files.length > 0) {
      const insFile = db.prepare('INSERT INTO submission_files (submission_id, filename, content) VALUES (?, ?, ?)');
      for (const f of files) insFile.run(newId, f.filename, f.content);
    }
    db.exec('COMMIT');
    return newId;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原始错误（外层已 rethrow） */ }
    throw err;
  }
}

// ── 判题放行 / 状态流转（reviewCode 回调与短代码直通）──
function markPending(id) {
  db.prepare("UPDATE submissions SET status = 'pending' WHERE id = ?").run(id);
}

function markSystemError(id) {
  db.prepare("UPDATE submissions SET status = 'system_error' WHERE id = ?").run(id);
}

// ── Diff View（GET /:id/diff）──
function findForDiff(id) {
  return db.prepare('SELECT id, user_id, problem_id, source_code, status FROM submissions WHERE id = ?').get(id);
}

function findPrevSubmission(userId, problemId, submissionId) {
  return db.prepare(`
    SELECT id, source_code FROM submissions
    WHERE user_id = ? AND problem_id = ? AND id < ?
    ORDER BY id DESC LIMIT 1
  `).get(userId, problemId, submissionId);
}

function findFirstWrongAnswerDetail(submissionId) {
  return db.prepare(`
      SELECT sd.stdout, sd.test_case_id, tc.output_data, tc.output_file, tc.problem_id
      FROM submission_details sd
      LEFT JOIN test_cases tc ON sd.test_case_id = tc.id
      WHERE sd.submission_id = ? AND sd.status = 'wrong_answer'
      ORDER BY sd.id LIMIT 1
    `).get(submissionId);
}

// ── 重判 / 删除 ──
function findSubmissionById(id) {
  return db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
}

function resetForRejudge(id) {
  db.prepare("UPDATE submissions SET status = 'pending_rejudge', score = 0, time_used = 0, memory_used = 0 WHERE id = ?").run(id);
}

function clearDetails(submissionId) {
  db.prepare('DELETE FROM submission_details WHERE submission_id = ?').run(submissionId);
}

function deleteSubmission(id) {
  db.prepare('DELETE FROM submissions WHERE id = ?').run(id);
}

module.exports = {
  countList,
  listPage,
  findByIdWithProblem,
  listDetails,
  listTestGroups,
  listFiles,
  findPendingByUser,
  findProblemById,
  findExamById,
  findExamProgramQuestion,
  countExamSubmissions,
  countAttemptSubmissions,
  findEnabledLanguage,
  findVirtualContestById,
  isProblemInContest,
  findContestById,
  findContestParticipant,
  insertContestParticipant,
  findUserVirtualContest,
  insertVirtualContest,
  insertSubmissionWithFiles,
  markPending,
  markSystemError,
  findForDiff,
  findPrevSubmission,
  findFirstWrongAnswerDetail,
  findSubmissionById,
  resetForRejudge,
  clearDetails,
  deleteSubmission
};
