const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
require('./_testdb')('homeworks');
const db = require('../database/db');
const repo = require('../repositories/homeworks');
const homeworkProgram = require('../services/homeworkProgram');
const { homeworkWindowState } = require('../utils/homeworkWindow');

describe('Homework System', () => {
  let teacherId;
  let studentA;
  let studentB;
  let problemId;
  let hwId;
  let choiceQ;
  let longQ;
  let programQ;

  const HW_TITLE = '作业自动化测试';

  before(async () => {
    await db.initDB();
    db.prepare("DELETE FROM users WHERE username IN ('hw_test_teacher', 'hw_test_student_a', 'hw_test_student_b')").run();
    db.prepare('DELETE FROM homeworks WHERE title = ?').run(HW_TITLE);

    teacherId = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES ('hw_test_teacher', 'hash', 'HW Teacher', 'teacher')").run().lastInsertRowid;
    studentA = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES ('hw_test_student_a', 'hash', 'A', 'user')").run().lastInsertRowid;
    studentB = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES ('hw_test_student_b', 'hash', 'B', 'user')").run().lastInsertRowid;

    problemId = db.prepare(`
      INSERT INTO problems (title, description, is_public, is_hidden, visibility)
      VALUES ('作业测试编程题', '用于作业回填测试', 1, 0, 'public')
    `).run().lastInsertRowid;
    db.prepare('INSERT INTO test_cases (problem_id, score, sort_order) VALUES (?, 5, 1)').run(problemId);
    db.prepare('INSERT INTO test_cases (problem_id, score, sort_order) VALUES (?, 5, 2)').run(problemId);

    hwId = repo.createHomeworkWithQuestions({
      homework: { title: HW_TITLE, description: 'desc', pass_score: 30 },
      start: null,
      end: null,
      creatorId: teacherId,
      questions: [
        { question_type: 'choice', title: '选择题', options: ['甲', '乙'], correct_answer: 'A', score: 10, max_submissions: 2 },
        { question_type: 'long_answer', title: '大题', score: 20, is_subjective: 1 },
        { question_type: 'program', title: '编程题', score: 100, problem_id: problemId }
      ]
    });
    const list = repo.listQuestionsRaw(hwId);
    choiceQ = list.find(q => q.question_type === 'choice');
    longQ = list.find(q => q.question_type === 'long_answer');
    programQ = list.find(q => q.question_type === 'program');
  });

  after(() => {
    repo.deleteHomeworkCascade(hwId);
    db.prepare('DELETE FROM submissions WHERE problem_id = ?').run(problemId);
    db.prepare('DELETE FROM problems WHERE id = ?').run(problemId);
    db.prepare('DELETE FROM users WHERE id IN (?, ?, ?)').run(teacherId, studentA, studentB);
  });

  it('创建作业：题目落库、总分按题分求和、每题提交上限保留', () => {
    assert.ok(hwId > 0);
    const hw = repo.getHomework(hwId);
    assert.equal(hw.title, HW_TITLE);
    assert.equal(Number(hw.total_score), 130);
    assert.equal(repo.listQuestionsRaw(hwId).length, 3);
    assert.equal(choiceQ.max_submissions, 2);
    assert.equal(longQ.max_submissions, 0, '未指定时默认 0=无限');
    assert.equal(programQ.problem_id, problemId);
  });

  it('每题提交计数：用于提交次数上限判断', () => {
    repo.createAnswer({ homeworkId: hwId, questionId: choiceQ.id, userId: studentA, attemptNo: 1, answer: 'A', score: 10, maxScore: 10, isCorrect: 1, isSubjective: 0, gradingStatus: 'graded' });
    repo.createAnswer({ homeworkId: hwId, questionId: choiceQ.id, userId: studentA, attemptNo: 2, answer: 'B', score: 0, maxScore: 10, isCorrect: 0, isSubjective: 0, gradingStatus: 'graded' });
    assert.equal(repo.countUserAttempts(hwId, choiceQ.id, studentA), 2);
    assert.equal(repo.countUserAttempts(hwId, choiceQ.id, studentB), 0);
  });

  it('逐题进度：返回最高分、最近一次作答与待批改状态', () => {
    const stats = repo.listMyQuestionStats(hwId, studentA);
    const c = stats.find(s => s.question_id === choiceQ.id);
    assert.equal(c.attempts, 2);
    assert.equal(Number(c.best_score), 10);
    assert.equal(c.last_answer, 'B');
    assert.equal(c.has_pending, 0);
  });

  it('主观题批改：写入分数/评语后待批改清零', () => {
    const ans = repo.createAnswer({ homeworkId: hwId, questionId: longQ.id, userId: studentB, attemptNo: 1, answer: '我的作答', score: 0, maxScore: 20, isCorrect: 0, isSubjective: 1, gradingStatus: 'pending' });
    assert.equal(repo.countPendingGrading(hwId), 1);

    repo.gradeAnswer(ans.lastInsertRowid, 18, '思路正确', teacherId);
    const graded = repo.findAnswerById(ans.lastInsertRowid);
    assert.equal(graded.grading_status, 'graded');
    assert.equal(Number(graded.score), 18);
    assert.equal(graded.comment, '思路正确');
    assert.equal(repo.countPendingGrading(hwId), 0);
  });

  it('排行榜：每题取最高分求和，同分按最后提交早者靠前', () => {
    repo.createAnswer({ homeworkId: hwId, questionId: longQ.id, userId: studentA, attemptNo: 1, answer: 'A 的作答', score: 15, maxScore: 20, isCorrect: 0, isSubjective: 1, gradingStatus: 'graded' });
    // studentA 目前：choice 10 + long 15 = 25；studentB：long 18
    let rows = repo.listLeaderboardRows(hwId);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].user_id, studentA);
    assert.equal(Number(rows[0].total_score), 25);
    assert.equal(Number(rows[1].total_score), 18);

    // studentB 再做对选择题后总分 28，反超
    repo.createAnswer({ homeworkId: hwId, questionId: choiceQ.id, userId: studentB, attemptNo: 1, answer: 'A', score: 10, maxScore: 10, isCorrect: 1, isSubjective: 0, gradingStatus: 'graded' });
    rows = repo.listLeaderboardRows(hwId);
    assert.equal(rows[0].user_id, studentB);
    assert.equal(Number(rows[0].total_score), 28);
  });

  it('统计口径：最佳成绩按人按题聚合，参与者只统计 user', () => {
    const best = repo.listBestByUserQuestion(hwId);
    assert.equal(best.filter(b => b.user_id === studentA).length, 2);
    assert.equal(repo.countParticipants(hwId), 2);
    assert.equal(repo.countAllSubmissions(hwId), 5);
  });

  it('编程题判题回填：按测试点比例折算题分并置为 graded', () => {
    const subId = db.findNextId('submissions');
    db.prepare(`INSERT INTO submissions (id, user_id, problem_id, language, source_code, status, score, homework_id, homework_question_id)
      VALUES (?, ?, ?, 'cpp', 'int main(){}', 'accepted', 5, ?, ?)`).run(subId, studentB, problemId, hwId, programQ.id);
    const row = db.prepare(`INSERT INTO homework_submissions (homework_id, question_id, user_id, attempt_no, answer, score, max_score, is_correct, is_subjective, grading_status, code_submission_id)
      VALUES (?, ?, ?, 1, ?, 0, 100, 0, 0, 'pending', ?)`).run(hwId, programQ.id, studentB, String(subId), subId);

    assert.equal(homeworkProgram.writeBackAfterJudge(subId), true);
    const after = repo.findAnswerById(row.lastInsertRowid);
    assert.equal(after.grading_status, 'graded');
    assert.equal(Number(after.score), 50, 'AC 50% × 题分 100');

    // 非终态不回填
    db.prepare("UPDATE submissions SET status = 'running' WHERE id = ?").run(subId);
    assert.equal(homeworkProgram.writeBackAfterJudge(subId), false);
  });

  it('题目增量替换：保留的题保留作答，移除的题级联清理作答', () => {
    const before = repo.listAnswerRows(hwId).length;
    const keptAnswerCount = repo.listAnswerRows(hwId).filter(r => r.question_id === choiceQ.id).length;
    repo.replaceHomeworkQuestions(hwId, [
      { id: choiceQ.id, question_type: 'choice', title: '选择题（改）', options: ['甲', '乙'], correct_answer: 'A', score: 12, max_submissions: 0 }
    ]);
    const afterRows = repo.listAnswerRows(hwId);
    assert.equal(afterRows.length, keptAnswerCount, '只保留未删除题目的作答');
    assert.ok(before > afterRows.length);
    assert.equal(Number(repo.getHomework(hwId).total_score), 12);

    // 复原题目，避免影响后续删除断言
    repo.replaceHomeworkQuestions(hwId, [
      { id: choiceQ.id, question_type: 'choice', title: '选择题', options: ['甲', '乙'], correct_answer: 'A', score: 10, max_submissions: 2 }
    ]);
  });

  it('时间窗判定：只设截止时间也可用，越界分别返回 not_started / ended', () => {
    assert.equal(homeworkWindowState({ start_time: null, end_time: null }), null);
    assert.equal(homeworkWindowState({ start_time: '2099-01-01T00:00:00.000Z', end_time: null }), 'not_started');
    assert.equal(homeworkWindowState({ start_time: null, end_time: '2000-01-01T00:00:00.000Z' }), 'ended');
    assert.equal(homeworkWindowState({ start_time: '2000-01-01T00:00:00.000Z', end_time: '2099-01-01T00:00:00.000Z' }), 'running');
  });

  it('删除作业：级联清理题目与作答，并解除代码提交的作业关联', () => {
    const sub = db.prepare('SELECT id FROM submissions WHERE homework_id = ? LIMIT 1').get(hwId);
    assert.ok(sub);
    repo.deleteHomeworkCascade(hwId);
    assert.equal(repo.getHomework(hwId), undefined);
    assert.equal(repo.listQuestionsRaw(hwId).length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM homework_submissions WHERE homework_id = ?').get(hwId).c, 0);
    const cleared = db.prepare('SELECT homework_id FROM submissions WHERE id = ?').get(sub.id);
    assert.equal(cleared.homework_id, null);
  });
});
