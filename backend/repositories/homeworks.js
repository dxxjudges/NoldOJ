// repositories/homeworks.js —— 作业域数据访问层
// 设计要点：
//   - 作业题目与试卷同构（choice/true_false/fill_blank/long_answer/program），但「逐题提交、逐题判分」；
//   - 每次提交写一行 homework_submissions（attempt_no 递增），成绩取每题最高分；
//   - program 题关联题库题目，代码提交记在 submissions.homework_id / homework_question_id，
//     判题完成后由 services/homeworkProgram.js 回填得分。
// 事务（建作业 / 替换题目 / 删除作业）失败 ROLLBACK 后 throw，由路由层转 400/500。
const db = require('../database/db');
const { sanitizeText } = require('../utils/securityHelpers');

// ── 列表 ──
function listHomeworks({ isStaff, search, limit, offset, visibilityFilter }) {
  let where = '';
  const params = [];

  if (!isStaff) {
    where = 'WHERE h.is_public = 1 AND h.is_hidden = 0';
  }

  if (visibilityFilter && visibilityFilter.sql) {
    where = where ? `${where} AND (${visibilityFilter.sql})` : `WHERE ${visibilityFilter.sql}`;
    params.push(...(visibilityFilter.params || []));
  }

  if (search) {
    const cond = "REPLACE(h.title, ' ', '') LIKE ?";
    where = where ? `${where} AND (${cond})` : `WHERE (${cond})`;
    params.push('%' + search.replace(/\s+/g, '') + '%');
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM homeworks h ${where}`).get(...params).c;
  const homeworks = db.prepare(`
    SELECT h.*, u.username as creator_name,
      (SELECT COUNT(*) FROM homework_questions WHERE homework_id = h.id) as question_count,
      (SELECT COUNT(DISTINCT user_id) FROM homework_submissions WHERE homework_id = h.id) as participant_count
    FROM homeworks h LEFT JOIN users u ON h.creator_id = u.id
    ${where}
    ORDER BY h.id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return { total, homeworks };
}

// ── 作业读取 ──
function getHomework(id) {
  return db.prepare('SELECT * FROM homeworks WHERE id = ?').get(id);
}

function getHomeworkDetail(id) {
  return db.prepare(`
    SELECT h.*, u.username as creator_name
    FROM homeworks h LEFT JOIN users u ON h.creator_id = u.id
    WHERE h.id = ?
  `).get(id);
}

function setVisibility(id, visibility) {
  db.prepare('UPDATE homeworks SET visibility = ? WHERE id = ?').run(visibility, id);
}

// ── 题目读取 ──
function listQuestionsRaw(homeworkId) {
  return db.prepare('SELECT * FROM homework_questions WHERE homework_id = ? ORDER BY sort_order, id').all(homeworkId);
}

// 学生视图：不下发标准答案，只给作答所需的字段
function listQuestionsForStudent(homeworkId) {
  return db.prepare(`
    SELECT q.id, q.homework_id, q.question_type, q.title, q.options, q.score, q.sort_order,
           q.is_subjective, q.max_submissions, q.problem_id,
           p.title as problem_title, p.time_limit, p.memory_limit
    FROM homework_questions q LEFT JOIN problems p ON p.id = q.problem_id
    WHERE q.homework_id = ?
    ORDER BY q.sort_order, q.id
  `).all(homeworkId);
}

function getQuestion(id) {
  return db.prepare('SELECT * FROM homework_questions WHERE id = ?').get(id);
}

// 作业内编程题可用的题库题目：未归档、公开且非隐藏，避免学生无法通过可见性校验
function getUsableProblem(problemId) {
  return db.prepare(`
    SELECT id, title, description, background, input_desc, output_desc, hint,
           time_limit, memory_limit, allowed_languages, problem_type, is_public, is_hidden, exam_id, visibility
    FROM problems
    WHERE id = ? AND exam_id IS NULL AND is_public = 1 AND is_hidden = 0 AND visibility = 'public'
  `).get(problemId);
}

// ── 作答统计 ──
function countUserAttempts(homeworkId, questionId, userId) {
  return db.prepare('SELECT COUNT(*) as c FROM homework_submissions WHERE homework_id = ? AND question_id = ? AND user_id = ?')
    .get(homeworkId, questionId, userId).c;
}

// 学生逐题进度：提交次数、最高分、最近一次状态与答案
function listMyQuestionStats(homeworkId, userId) {
  const stats = db.prepare(`
    SELECT question_id, COUNT(*) as attempts,
           MAX(score) as best_score,
           MAX(submitted_at) as last_submitted_at,
           MAX(CASE WHEN grading_status = 'pending' THEN 1 ELSE 0 END) as has_pending
    FROM homework_submissions
    WHERE homework_id = ? AND user_id = ?
    GROUP BY question_id
  `).all(homeworkId, userId);
  const latest = db.prepare(`
    SELECT s.* FROM homework_submissions s
    JOIN (
      SELECT question_id, MAX(id) as mid FROM homework_submissions
      WHERE homework_id = ? AND user_id = ? GROUP BY question_id
    ) t ON t.mid = s.id
  `).all(homeworkId, userId);
  const latestMap = new Map(latest.map(r => [r.question_id, r]));
  return stats.map(r => {
    const last = latestMap.get(r.question_id) || null;
    return {
      ...r,
      last_answer: last ? last.answer : '',
      last_status: last ? last.grading_status : null,
      last_score: last ? last.score : 0,
      comment: last ? last.comment : ''
    };
  });
}

// ── 创建 / 更新 / 删除 ──
function createHomeworkWithQuestions({ homework, start, end, creatorId, questions }) {
  try {
    db.exec('BEGIN');
    db.exec('PRAGMA defer_foreign_keys = ON');
    const result = db.prepare(`
      INSERT INTO homeworks (title, description, start_time, end_time, pass_score, is_public, is_hidden,
        leaderboard_enabled, stats_public, creator_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sanitizeText(homework.title).trim(),
      sanitizeText(homework.description || ''),
      start,
      end,
      Number(homework.pass_score) || 0,
      homework.is_public !== false ? 1 : 0,
      homework.is_hidden ? 1 : 0,
      homework.leaderboard_enabled !== false ? 1 : 0,
      homework.stats_public ? 1 : 0,
      creatorId
    );
    const homeworkId = result.lastInsertRowid;

    let totalScore = 0;
    if (questions.length > 0) {
      const stmt = db.prepare(`
        INSERT INTO homework_questions (homework_id, question_type, title, options, correct_answer, score,
          sort_order, is_subjective, max_submissions, problem_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        stmt.run(
          homeworkId,
          q.question_type,
          sanitizeText(q.title),
          q.question_type === 'choice' ? JSON.stringify(q.options || []) : '[]',
          q.correct_answer || '',
          Number(q.score) || 0,
          Number.isInteger(q.sort_order) ? q.sort_order : i,
          q.is_subjective ? 1 : 0,
          Math.max(0, parseInt(q.max_submissions, 10) || 0),
          q.question_type === 'program' ? q.problem_id : null
        );
        totalScore += Number(q.score) || 0;
      }
    }
    db.prepare('UPDATE homeworks SET total_score = ? WHERE id = ?').run(totalScore, homeworkId);
    db.exec('COMMIT');
    return homeworkId;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原始错误 */ }
    throw e;
  }
}

// 更新作业基本信息（只写传入字段）
function updateHomework(id, v) {
  db.prepare(`
    UPDATE homeworks SET
      title = COALESCE(?, title),
      description = COALESCE(?, description),
      start_time = ?,
      end_time = ?,
      pass_score = COALESCE(?, pass_score),
      is_public = COALESCE(?, is_public),
      is_hidden = COALESCE(?, is_hidden),
      leaderboard_enabled = COALESCE(?, leaderboard_enabled),
      stats_public = COALESCE(?, stats_public),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    v.title === undefined ? null : v.title,
    v.description === undefined ? null : v.description,
    v.start_time === undefined ? null : v.start_time,
    v.end_time === undefined ? null : v.end_time,
    v.pass_score === undefined ? null : v.pass_score,
    v.is_public === undefined ? null : (v.is_public ? 1 : 0),
    v.is_hidden === undefined ? null : (v.is_hidden ? 1 : 0),
    v.leaderboard_enabled === undefined ? null : (v.leaderboard_enabled ? 1 : 0),
    v.stats_public === undefined ? null : (v.stats_public ? 1 : 0),
    id
  );
}

// 题目增量替换：带 id 的更新（保留已有作答），缺失的删除（级联清理作答），无 id 的新增。
function replaceHomeworkQuestions(homeworkId, questions) {
  try {
    db.exec('BEGIN');
    db.exec('PRAGMA defer_foreign_keys = ON');
    const existing = db.prepare('SELECT id FROM homework_questions WHERE homework_id = ?').all(homeworkId);
    const existingIds = new Set(existing.map(r => r.id));
    const kept = new Set();

    const updateStmt = db.prepare(`
      UPDATE homework_questions SET question_type = ?, title = ?, options = ?, correct_answer = ?,
        score = ?, sort_order = ?, is_subjective = ?, max_submissions = ?, problem_id = ?
      WHERE id = ? AND homework_id = ?
    `);
    const insertStmt = db.prepare(`
      INSERT INTO homework_questions (homework_id, question_type, title, options, correct_answer, score,
        sort_order, is_subjective, max_submissions, problem_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let totalScore = 0;
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const qid = Number(q.id);
      const common = [
        q.question_type,
        sanitizeText(q.title),
        q.question_type === 'choice' ? JSON.stringify(q.options || []) : '[]',
        q.correct_answer || '',
        Number(q.score) || 0,
        Number.isInteger(q.sort_order) ? q.sort_order : i,
        q.is_subjective ? 1 : 0,
        Math.max(0, parseInt(q.max_submissions, 10) || 0),
        q.question_type === 'program' ? q.problem_id : null
      ];
      if (qid && existingIds.has(qid)) {
        updateStmt.run(...common, qid, homeworkId);
        kept.add(qid);
      } else {
        insertStmt.run(homeworkId, ...common);
      }
      totalScore += Number(q.score) || 0;
    }

    const dropStmt = db.prepare('DELETE FROM homework_questions WHERE id = ? AND homework_id = ?');
    for (const id of existingIds) {
      if (!kept.has(id)) dropStmt.run(id, homeworkId);
    }

    db.prepare('UPDATE homeworks SET total_score = ?, updated_at = datetime(\'now\') WHERE id = ?').run(totalScore, homeworkId);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原始错误 */ }
    throw e;
  }
}

// 删除作业：先解除代码提交上的作业关联（提交记录本身保留），再级联删除作业/题目/作答
function deleteHomeworkCascade(homeworkId) {
  try {
    db.exec('BEGIN');
    db.prepare('UPDATE submissions SET homework_id = NULL, homework_question_id = NULL WHERE homework_id = ?').run(homeworkId);
    db.prepare("DELETE FROM resource_group_access WHERE resource_type = 'homework' AND resource_id = ?").run(homeworkId);
    db.prepare('DELETE FROM homeworks WHERE id = ?').run(homeworkId);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原始错误 */ }
    throw e;
  }
}

// ── 逐题提交 ──
function createAnswer({ homeworkId, questionId, userId, attemptNo, answer, score, maxScore, isCorrect, isSubjective, gradingStatus, codeSubmissionId }) {
  return db.prepare(`
    INSERT INTO homework_submissions (homework_id, question_id, user_id, attempt_no, answer, score, max_score,
      is_correct, is_subjective, grading_status, code_submission_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    homeworkId, questionId, userId, attemptNo, answer || '',
    Number(score) || 0, Number(maxScore) || 0, isCorrect ? 1 : 0, isSubjective ? 1 : 0,
    gradingStatus, codeSubmissionId || null
  );
}

// 编程题提交的作答行由 repositories/submissions.js 在提交事务内一并写入（避免两次事务）

function findAnswerById(id) {
  return db.prepare('SELECT * FROM homework_submissions WHERE id = ?').get(id);
}

function findAnswerForUser(id, userId) {
  return db.prepare('SELECT * FROM homework_submissions WHERE id = ? AND user_id = ?').get(id, userId);
}

function listAnswersByQuestion(questionId, { gradingStatus = null, limit = 200, offset = 0 } = {}) {
  let sql = `
    SELECT s.*, u.username, u.nickname
    FROM homework_submissions s JOIN users u ON u.id = s.user_id
    WHERE s.question_id = ?`;
  const params = [questionId];
  if (gradingStatus) {
    sql += ' AND s.grading_status = ?';
    params.push(gradingStatus);
  }
  sql += ' ORDER BY s.id ASC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

function countPendingGrading(homeworkId) {
  return db.prepare(`
    SELECT COUNT(*) as c FROM homework_submissions
    WHERE homework_id = ? AND grading_status = 'pending' AND is_subjective = 1
  `).get(homeworkId).c;
}

function gradeAnswer(id, score, comment, graderId) {
  db.prepare(`
    UPDATE homework_submissions
    SET score = ?, comment = ?, grading_status = 'graded', graded_at = datetime('now'), graded_by = ?
    WHERE id = ?
  `).run(Number(score) || 0, comment || '', graderId, id);
}

// 教师批改总览：只取主观题作答，可按是否待批改过滤
function countGradingRows(homeworkId, onlyPending) {
  const sql = `SELECT COUNT(*) as c FROM homework_submissions
    WHERE homework_id = ? AND is_subjective = 1${onlyPending ? " AND grading_status = 'pending'" : ''}`;
  return db.prepare(sql).get(homeworkId).c;
}

function listGradingRows(homeworkId, { onlyPending, limit, offset }) {
  let sql = `
    SELECT s.*, u.username, u.nickname, q.title as question_title, q.score as question_max
    FROM homework_submissions s
    JOIN users u ON u.id = s.user_id
    JOIN homework_questions q ON q.id = s.question_id
    WHERE s.homework_id = ? AND s.is_subjective = 1`;
  if (onlyPending) sql += " AND s.grading_status = 'pending'";
  sql += ' ORDER BY s.id ASC LIMIT ? OFFSET ?';
  return db.prepare(sql).all(homeworkId, limit, offset);
}

function listUserAnswers(homeworkId, userId) {
  return db.prepare(`
    SELECT * FROM homework_submissions WHERE homework_id = ? AND user_id = ?
    ORDER BY id DESC LIMIT 500
  `).all(homeworkId, userId);
}

// ── 排行榜 / 统计 ──
// 每人每题取最高分，总分 = 各题最高分之和；同分按最后提交时间早者靠前。
function listLeaderboardRows(homeworkId) {
  return db.prepare(`
    SELECT u.id as user_id, u.username, u.nickname,
           SUM(b.best_score) as total_score,
           COUNT(b.question_id) as answered_questions,
           SUM(b.attempts) as attempts,
           MAX(b.last_at) as submitted_at
    FROM (
      SELECT user_id, question_id,
             MAX(score) as best_score,
             COUNT(*) as attempts,
             MAX(submitted_at) as last_at
      FROM homework_submissions
      WHERE homework_id = ?
      GROUP BY user_id, question_id
    ) b
    JOIN users u ON u.id = b.user_id
    WHERE u.role = 'user'
    GROUP BY u.id
    ORDER BY total_score DESC, submitted_at ASC, u.id ASC
  `).all(homeworkId);
}

// 每人每题最佳成绩（CSV 明细与统计共用）
function listBestByUserQuestion(homeworkId) {
  return db.prepare(`
    SELECT user_id, question_id, MAX(score) as best_score, COUNT(*) as attempts,
           MAX(submitted_at) as last_at
    FROM homework_submissions WHERE homework_id = ?
    GROUP BY user_id, question_id
  `).all(homeworkId);
}

// 全部作答行（统计按题聚合时用）
function listAnswerRows(homeworkId) {
  return db.prepare(`
    SELECT question_id, user_id, score, grading_status, is_subjective
    FROM homework_submissions WHERE homework_id = ?
  `).all(homeworkId);
}

function countParticipants(homeworkId) {
  return db.prepare(`
    SELECT COUNT(DISTINCT s.user_id) as c
    FROM homework_submissions s JOIN users u ON u.id = s.user_id
    WHERE s.homework_id = ? AND u.role = 'user'
  `).get(homeworkId).c;
}

function countAllSubmissions(homeworkId) {
  return db.prepare('SELECT COUNT(*) as c FROM homework_submissions WHERE homework_id = ?').get(homeworkId).c;
}

module.exports = {
  listHomeworks,
  getHomework,
  getHomeworkDetail,
  setVisibility,
  listQuestionsRaw,
  listQuestionsForStudent,
  getQuestion,
  getUsableProblem,
  countUserAttempts,
  listMyQuestionStats,
  createHomeworkWithQuestions,
  updateHomework,
  replaceHomeworkQuestions,
  deleteHomeworkCascade,
  createAnswer,
  findAnswerById,
  findAnswerForUser,
  listAnswersByQuestion,
  countPendingGrading,
  gradeAnswer,
  countGradingRows,
  listGradingRows,
  listUserAnswers,
  listLeaderboardRows,
  listBestByUserQuestion,
  listAnswerRows,
  countParticipants,
  countAllSubmissions
};
