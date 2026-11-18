// services/homeworkProgram.js —— 作业编程题：判题分数折算与判题完成后回填
// 与原试卷编程题（services/examProgram.js）共用「原生分 → 题分」折算逻辑，
// 区别是作业按题记录，直接更新 homework_submissions 单行。
const db = require('../database/db');
const examProgram = require('./examProgram');

// 判题结束（终态）后回填该次编程题作答的得分。
// 通过 homework_submissions.code_submission_id 定位；作业/题目已删除时静默返回 false。
function writeBackAfterJudge(codeSubmissionId) {
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(codeSubmissionId);
  if (!sub || !sub.homework_id) return false;
  if (examProgram.NON_TERMINAL.has(sub.status)) return false;

  const row = db.prepare('SELECT * FROM homework_submissions WHERE code_submission_id = ?').get(codeSubmissionId);
  if (!row) return false;
  const question = db.prepare('SELECT * FROM homework_questions WHERE id = ?').get(row.question_id);
  if (!question) return false;

  const result = examProgram.scoreFromSubmission(question, sub);
  if (result.pending) return false;

  db.prepare(`
    UPDATE homework_submissions
    SET score = ?, max_score = ?, is_correct = ?, grading_status = 'graded', graded_at = datetime('now')
    WHERE id = ?
  `).run(result.score, Number(question.score) || 0, result.correct ? 1 : 0, row.id);
  return true;
}

module.exports = { writeBackAfterJudge };
