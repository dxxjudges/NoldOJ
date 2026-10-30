// 试卷/比赛统计接口测试：教师始终可看、stats_public 开关控制学生可见性、
// 聚合口径（每人最佳一次/逐题均分正确率/封榜时间窗）。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
require('./_testdb')('exam-stats');

const config = require('../config/config');
config.rateLimit.submissions.max = 500;

const db = require('../database/db');
const express = require('express');
const examRoutes = require('../routes/exams');
const contestRoutes = require('../routes/contests');
const { generateAccessToken } = require('../utils/tokens');

describe('Exam & contest statistics', () => {
  let server;
  let base;
  let teacherId, stu1Id, stu2Id, stu3Id, stu4Id;
  let teacherTok, stu1Tok;
  let examId;
  let contestId, p1Id, p2Id;
  const min = 60 * 1000;

  async function api(method, p, token, body) {
    const res = await fetch(base + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  }

  function sqliteUtc(ms) {
    return new Date(ms).toISOString().replace('T', ' ').substring(0, 19);
  }

  // 直接落库交卷（含逐题答题记录），用于构造统计样本
  function addExamSubmission(userId, totalScore, submittedAt, answers = []) {
    const sid = db.prepare(`
      INSERT INTO exam_submissions (exam_id, user_id, status, total_score, max_score, submitted_at)
      VALUES (?, ?, 'graded', ?, 100, ?)
    `).run(examId, userId, totalScore, submittedAt).lastInsertRowid;
    const stmt = db.prepare(`
      INSERT INTO exam_answers (submission_id, question_id, answer, score, max_score, is_correct, is_subjective, grading_status)
      VALUES (?, ?, '', ?, ?, ?, 0, 'ai_graded')
    `);
    for (const a of answers) stmt.run(sid, a.qid, a.score, a.max, a.correct ? 1 : 0);
    return sid;
  }

  let q1Id, q2Id;
  const t0 = sqliteUtc(Date.now() - 10 * min);

  before(async () => {
    await db.initDB();

    teacherId = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES ('st_teacher', 'hash', 'Stat Teacher', 'teacher')").run().lastInsertRowid;
    stu1Id = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES ('st_stu1', 'hash', 'Stat One', 'user')").run().lastInsertRowid;
    stu2Id = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES ('st_stu2', 'hash', 'Stat Two', 'user')").run().lastInsertRowid;
    stu3Id = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES ('st_stu3', 'hash', 'Stat Three', 'user')").run().lastInsertRowid;
    stu4Id = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES ('st_stu4', 'hash', 'Stat Four', 'user')").run().lastInsertRowid;
    teacherTok = generateAccessToken(teacherId);
    stu1Tok = generateAccessToken(stu1Id);

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/v1/exams', examRoutes);
    app.use('/api/v1/contests', contestRoutes);
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;

    // 试卷：两道客观题（60 + 40）
    const created = await api('POST', '/api/v1/exams', teacherTok, {
      title: '统计测试卷',
      pass_score: 60,
      start_time: new Date(Date.now() - 60 * min).toISOString(),
      end_time: new Date(Date.now() + 60 * min).toISOString(),
      questions: [
        { question_type: 'choice', title: '第一题', options: ['A', 'B'], correct_answer: 'A', score: 60 },
        { question_type: 'fill_blank', title: '第二题', correct_answer: 'x', score: 40 }
      ]
    });
    assert.equal(created.status, 201);
    examId = created.data.id;
    const qs = db.prepare('SELECT id FROM exam_questions WHERE exam_id = ? ORDER BY sort_order').all(examId);
    q1Id = qs[0].id;
    q2Id = qs[1].id;

    // 三次最佳答案：90 / 60 / 100（第三个学生有两次尝试，只取最佳）
    addExamSubmission(stu1Id, 90, t0, [
      { qid: q1Id, score: 60, max: 60, correct: true },
      { qid: q2Id, score: 30, max: 40, correct: false }
    ]);
    addExamSubmission(stu2Id, 60, t0, [
      { qid: q1Id, score: 40, max: 60, correct: false },
      { qid: q2Id, score: 20, max: 40, correct: false }
    ]);
    addExamSubmission(stu3Id, 50, t0);
    addExamSubmission(stu3Id, 100, t0, [
      { qid: q1Id, score: 60, max: 60, correct: true },
      { qid: q2Id, score: 40, max: 40, correct: true }
    ]);

    // 比赛：两题，已结束且封榜（结束前 30 分钟封榜）
    p1Id = db.prepare("INSERT INTO problems (title, description, time_limit, memory_limit) VALUES ('比赛题一', 'd', 1000, 128)").run().lastInsertRowid;
    p2Id = db.prepare("INSERT INTO problems (title, description, time_limit, memory_limit) VALUES ('比赛题二', 'd', 1000, 128)").run().lastInsertRowid;
    const c = await api('POST', '/api/v1/contests', teacherTok, {
      title: '统计测试赛',
      start_time: new Date(Date.now() - 120 * min).toISOString(),
      end_time: new Date(Date.now() - 60 * min).toISOString(),
      freeze_minutes: 30
    });
    assert.equal(c.status, 201);
    contestId = c.data.id;
    db.prepare('INSERT INTO contest_problems (contest_id, problem_id, sort_order, alias) VALUES (?, ?, 1, ?)').run(contestId, p1Id, 'A');
    db.prepare('INSERT INTO contest_problems (contest_id, problem_id, sort_order, alias) VALUES (?, ?, 2, ?)').run(contestId, p2Id, 'B');
    db.prepare('INSERT INTO contest_participants (contest_id, user_id) VALUES (?, ?)').run(contestId, stu1Id);
    db.prepare('INSERT INTO contest_participants (contest_id, user_id) VALUES (?, ?)').run(contestId, stu2Id);

    const insSub = db.prepare(`
      INSERT INTO submissions (user_id, problem_id, language, source_code, status, score, time_used, created_at)
      VALUES (?, ?, 'cpp', 'int main(){}', ?, ?, ?, ?)
    `);
    // 封榜前（计入）：stu1 对 p1 一次 WA + 一次 AC，stu2 对 p2 一次 AC
    insSub.run(stu1Id, p1Id, 'wrong_answer', 0, 20, sqliteUtc(Date.now() - 110 * min));
    insSub.run(stu1Id, p1Id, 'accepted', 100, 10, sqliteUtc(Date.now() - 100 * min));
    insSub.run(stu2Id, p2Id, 'accepted', 100, 15, sqliteUtc(Date.now() - 105 * min));
    // 封榜后（不计入）：stu2 对 p1 的 AC
    insSub.run(stu2Id, p1Id, 'accepted', 100, 5, sqliteUtc(Date.now() - 80 * min));
  });

  after(() => {
    try {
      if (examId) {
        db.prepare('DELETE FROM exam_answers WHERE submission_id IN (SELECT id FROM exam_submissions WHERE exam_id = ?)').run(examId);
        db.prepare('DELETE FROM exam_submissions WHERE exam_id = ?').run(examId);
        db.prepare('DELETE FROM exam_questions WHERE exam_id = ?').run(examId);
        db.prepare('DELETE FROM exams WHERE id = ?').run(examId);
      }
      if (contestId) {
        db.prepare('DELETE FROM submissions WHERE problem_id IN (?, ?)').run(p1Id, p2Id);
        db.prepare('DELETE FROM contest_participants WHERE contest_id = ?').run(contestId);
        db.prepare('DELETE FROM contest_problems WHERE contest_id = ?').run(contestId);
        db.prepare('DELETE FROM contests WHERE id = ?').run(contestId);
        db.prepare('DELETE FROM problems WHERE id IN (?, ?)').run(p1Id, p2Id);
      }
      db.prepare('DELETE FROM users WHERE id IN (?, ?, ?, ?, ?)').run(teacherId, stu1Id, stu2Id, stu3Id, stu4Id);
    } finally {
      if (server) server.close();
    }
  });

  it('试卷统计：默认仅教师可看，学生 403', async () => {
    const r = await api('GET', `/api/v1/exams/${examId}/stats`, stu1Tok);
    assert.equal(r.status, 403);
    assert.match(r.data.message, /统计未公开/);

    const anon = await api('GET', `/api/v1/exams/${examId}/stats`);
    assert.equal(anon.status, 403);
  });

  it('试卷统计：教师可看，聚合口径正确（最佳一次/均分/分布/逐题）', async () => {
    const r = await api('GET', `/api/v1/exams/${examId}/stats`, teacherTok);
    assert.equal(r.status, 200);
    assert.equal(r.data.stats_public, false);
    assert.equal(r.data.summary.participants, 3);
    assert.equal(r.data.summary.submissions, 4);
    assert.equal(r.data.summary.average, 83.3);
    assert.equal(r.data.summary.median, 90);
    assert.equal(r.data.summary.highest, 100);
    assert.equal(r.data.summary.lowest, 60);
    assert.equal(r.data.summary.full_score_count, 1);
    assert.equal(r.data.summary.pass_count, 3);
    assert.equal(r.data.summary.pass_rate, 100);
    assert.equal(r.data.summary.graded, 3);

    const dist = Object.fromEntries(r.data.distribution.map(d => [d.label, d.count]));
    assert.equal(dist['100%'], 1);
    assert.equal(dist['90–99%'], 1);
    assert.equal(dist['60–69%'], 1);

    const q1 = r.data.questions.find(q => q.question_id === q1Id);
    assert.equal(q1.answered, 3);
    assert.equal(q1.average_score, 53.3);
    assert.equal(q1.correct_count, 2);
    assert.equal(q1.correct_rate, 66.7);
    const q2 = r.data.questions.find(q => q.question_id === q2Id);
    assert.equal(q2.answered, 3);
    assert.equal(q2.average_score, 30);
    assert.equal(q2.correct_rate, 33.3);

    // 不泄露个人明细
    assert.equal(Object.hasOwn(r.data, 'leaderboard'), false);
    assert.equal(JSON.stringify(r.data).includes('Stat One'), false);
  });

  it('试卷统计：打开 stats_public 后学生可看', async () => {
    const upd = await api('PUT', `/api/v1/exams/${examId}`, teacherTok, { stats_public: true });
    assert.equal(upd.status, 200);
    assert.equal(upd.data.stats_public, 1);

    const r = await api('GET', `/api/v1/exams/${examId}/stats`, stu1Tok);
    assert.equal(r.status, 200);
    assert.equal(r.data.stats_public, true);
    assert.equal(r.data.summary.participants, 3);
  });

  it('试卷统计：封榜期间只统计封榜时刻前交卷', async () => {
    db.prepare('UPDATE exams SET manual_frozen = 1, manual_frozen_at = ? WHERE id = ?')
      .run(sqliteUtc(Date.now() - 5 * min), examId);
    // 封榜后的新交卷不计入
    addExamSubmission(stu4Id, 80, sqliteUtc(Date.now()));

    const r = await api('GET', `/api/v1/exams/${examId}/stats`, teacherTok);
    assert.equal(r.status, 200);
    assert.equal(r.data.frozen, true);
    assert.equal(r.data.summary.participants, 3);
    assert.equal(r.data.summary.submissions, 4);

    db.prepare('UPDATE exams SET manual_frozen = 0, manual_frozen_at = NULL WHERE id = ?').run(examId);
    const after = await api('GET', `/api/v1/exams/${examId}/stats`, teacherTok);
    assert.equal(after.data.frozen, false);
    assert.equal(after.data.summary.participants, 4);
    assert.equal(after.data.summary.submissions, 5);
  });

  it('比赛统计：默认仅教师可看；封榜截断与逐题通过率正确', async () => {
    const denied = await api('GET', `/api/v1/contests/${contestId}/stats`, stu1Tok);
    assert.equal(denied.status, 403);
    assert.match(denied.data.message, /统计未公开/);

    const r = await api('GET', `/api/v1/contests/${contestId}/stats`, teacherTok);
    assert.equal(r.status, 200);
    assert.equal(r.data.frozen, true);
    assert.equal(r.data.summary.participant_count, 2);
    assert.equal(r.data.summary.active_users, 2);
    assert.equal(r.data.summary.submissions, 3);
    assert.equal(r.data.summary.accepted_submissions, 2);
    assert.equal(r.data.summary.solved_all, 0);
    assert.equal(r.data.summary.average_solved, 1);

    const p1 = r.data.problems.find(p => p.problem_id === p1Id);
    assert.equal(p1.alias, 'A');
    assert.equal(p1.attempts, 2);
    assert.equal(p1.users, 1);
    assert.equal(p1.accepted_users, 1);
    assert.equal(p1.accept_rate, 100);
    const p2 = r.data.problems.find(p => p.problem_id === p2Id);
    assert.equal(p2.attempts, 1);
    assert.equal(p2.accept_rate, 100);
  });

  it('比赛统计：打开 stats_public 后学生可看', async () => {
    const upd = await api('PUT', `/api/v1/contests/${contestId}`, teacherTok, { stats_public: true });
    assert.equal(upd.status, 200);
    assert.equal(upd.data.stats_public, 1);

    const r = await api('GET', `/api/v1/contests/${contestId}/stats`, stu1Tok);
    assert.equal(r.status, 200);
    assert.equal(r.data.stats_public, true);
    assert.equal(r.data.summary.active_users, 2);
  });
});
