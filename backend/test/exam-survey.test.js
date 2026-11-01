// 问卷/匿名问卷集成测试：
// 覆盖 创建时问卷落库与排行榜强制关闭、匿名仅在问卷模式生效、编程题拦截、
// 交卷只写标记+匿名作答（不写 exam_submissions/exam_answers）、重复提交拦截、
// 匿名不下发提交时刻与名单、统计聚合口径、学生统计开关、问卷排行榜 404。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
require('./_testdb')('exam-survey');

const config = require('../config/config');
config.rateLimit.submissions.max = 500;

const db = require('../database/db');
const express = require('express');
const examRoutes = require('../routes/exams');
const { generateAccessToken } = require('../utils/tokens');

describe('Exam survey / anonymous survey', () => {
  let server;
  let base;
  let teacherId, stu1Id, stu2Id;
  let teacherTok, stu1Tok, stu2Tok;
  let surveyId, anonId, normalId;
  let q1Id, q2Id, q3Id;

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
    try { data = await res.json(); } catch { /* 非 JSON 响应（如 204）按 null 处理 */ }
    return { status: res.status, data };
  }

  const questions = () => [
    { question_type: 'choice', title: '你最喜欢的语言？', options: ['C++', 'Python', 'Java'], correct_answer: 'A', score: 10 },
    { question_type: 'true_false', title: '你用过 NoldOJ 吗？', correct_answer: 'true', score: 10 },
    { question_type: 'fill_blank', title: '想说的话', correct_answer: '', score: 10, is_subjective: true }
  ];

  before(async () => {
    await db.initDB();

    teacherId = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES ('sv_teacher', 'h', 'Survey Teacher', 'teacher')").run().lastInsertRowid;
    stu1Id = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES ('sv_stu1', 'h', 'Survey One', 'user')").run().lastInsertRowid;
    stu2Id = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES ('sv_stu2', 'h', 'Survey Two', 'user')").run().lastInsertRowid;
    teacherTok = generateAccessToken(teacherId);
    stu1Tok = generateAccessToken(stu1Id);
    stu2Tok = generateAccessToken(stu2Id);

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/v1/exams', examRoutes);
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;

    // 匿名问卷（排行榜开关故意传 true，应被强制关闭）
    const anon = await api('POST', '/api/v1/exams', teacherTok, {
      title: '匿名问卷',
      is_survey: true,
      is_anonymous: true,
      leaderboard_enabled: true,
      questions: questions()
    });
    assert.equal(anon.status, 201);
    anonId = anon.data.id;
    const qs = db.prepare('SELECT id FROM exam_questions WHERE exam_id = ? ORDER BY sort_order').all(anonId);
    q1Id = qs[0].id;
    q2Id = qs[1].id;
    q3Id = qs[2].id;

    // 非匿名问卷
    const named = await api('POST', '/api/v1/exams', teacherTok, {
      title: '实名问卷',
      is_survey: true,
      questions: questions()
    });
    assert.equal(named.status, 201);
    surveyId = named.data.id;

    // 普通试卷（对照：问卷开关关闭时行为不变）
    const normal = await api('POST', '/api/v1/exams', teacherTok, {
      title: '普通试卷',
      leaderboard_enabled: true,
      questions: [{ question_type: 'choice', title: '1+1=?', options: ['1', '2'], correct_answer: 'B', score: 10 }]
    });
    assert.equal(normal.status, 201);
    normalId = normal.data.id;
  });

  after(() => {
    try {
      db.prepare('DELETE FROM exams WHERE id IN (?, ?, ?)').run(surveyId, anonId, normalId);
      db.prepare('DELETE FROM users WHERE id IN (?, ?, ?)').run(teacherId, stu1Id, stu2Id);
    } finally {
      if (server) server.close();
    }
  });

  it('创建问卷：落库正确、排行榜强制关闭、匿名仅在问卷模式生效', async () => {
    const anon = await api('GET', `/api/v1/exams/${anonId}`, teacherTok);
    assert.equal(anon.status, 200);
    assert.equal(anon.data.is_survey, 1);
    assert.equal(anon.data.is_anonymous, 1);
    assert.equal(anon.data.leaderboard_enabled, 0);

    const named = await api('GET', `/api/v1/exams/${surveyId}`, teacherTok);
    assert.equal(named.data.is_survey, 1);
    assert.equal(named.data.is_anonymous, 0);
    assert.equal(named.data.leaderboard_enabled, 0);

    // 非问卷 + 匿名 → 匿名字段被归零
    const noSurvey = await api('POST', '/api/v1/exams', teacherTok, {
      title: '非问卷带匿名',
      is_anonymous: true,
      questions: [{ question_type: 'fill_blank', title: 'x', correct_answer: 'y', score: 5 }]
    });
    assert.equal(noSurvey.status, 201);
    assert.equal(noSurvey.data.is_survey, 0);
    assert.equal(noSurvey.data.is_anonymous, 0);
    db.prepare('DELETE FROM exams WHERE id = ?').run(noSurvey.data.id);
  });

  it('问卷不支持编程题：创建/更新均 400', async () => {
    const created = await api('POST', '/api/v1/exams', teacherTok, {
      title: '问卷带编程题',
      is_survey: true,
      questions: [{ question_type: 'program', title: '写代码', score: 10 }]
    });
    assert.equal(created.status, 400);
    assert.match(created.data.message, /问卷模式不支持编程题/);

    // 既有普通试卷切换为问卷时，携带编程题同样拒绝（先校验再动库）
    const upd = await api('PUT', `/api/v1/exams/${normalId}`, teacherTok, {
      is_survey: true,
      questions: [{ question_type: 'program', title: '写代码', score: 10 }]
    });
    assert.equal(upd.status, 400);
    assert.match(upd.data.message, /问卷模式不支持编程题/);
    const stillNormal = await api('GET', `/api/v1/exams/${normalId}`, teacherTok);
    assert.equal(stillNormal.data.is_survey, 0);
  });

  it('问卷交卷：不写个人提交/答题记录，只写标记与匿名作答；重复提交 400', async () => {
    const res = await api('POST', `/api/v1/exams/${anonId}/submit`, stu1Tok, {
      answers: [
        { question_id: q1Id, answer: 'B' },
        { question_id: q2Id, answer: 'true' },
        { question_id: q3Id, answer: '加油' }
      ]
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.survey, true);
    assert.equal(res.data.anonymous, true);
    assert.equal(res.data.submitted_at, null);

    // 无个人提交记录
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM exam_submissions WHERE exam_id = ?').get(anonId).c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM exam_answers a JOIN exam_submissions s ON s.id = a.submission_id WHERE s.exam_id = ?').get(anonId).c, 0);
    // 标记 + 匿名作答各就位
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM exam_survey_submissions WHERE exam_id = ?').get(anonId).c, 1);
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM exam_survey_answers WHERE exam_id = ?').get(anonId).c, 3);

    // 重复提交拦截
    const again = await api('POST', `/api/v1/exams/${anonId}/submit`, stu1Tok, { answers: [{ question_id: q1Id, answer: 'A' }] });
    assert.equal(again.status, 400);
    assert.equal(again.data.reason, 'ERR_ALREADY_SUBMITTED');
  });

  it('匿名问卷：详情不下发提交时刻，教师名单为空，统计不含个人身份', async () => {
    const detail = await api('GET', `/api/v1/exams/${anonId}`, stu1Tok);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.survey_submitted, true);
    assert.equal(detail.data.survey_submitted_at, null);

    const list = await api('GET', `/api/v1/exams/${anonId}/submissions`, teacherTok);
    assert.equal(list.status, 200);
    assert.equal(list.data.survey, true);
    assert.equal(list.data.anonymous, true);
    assert.equal(list.data.total, 1);
    assert.deepEqual(list.data.submissions, []);

    const stats = await api('GET', `/api/v1/exams/${anonId}/stats`, teacherTok);
    assert.equal(stats.status, 200);
    assert.equal(stats.data.is_survey, true);
    assert.equal(stats.data.is_anonymous, true);
    assert.equal(stats.data.summary.participants, 1);
    assert.equal(JSON.stringify(stats.data).includes('Survey One'), false);
    const dist = Object.fromEntries(stats.data.questions[0].distribution.map(d => [d.label, d.count]));
    assert.equal(dist['B. Python'], 1);
  });

  it('问卷统计：学生默认 403，打开 stats_public 后可看；分布聚合正确', async () => {
    // 第二名学生提交（同一份问卷）
    const submit2 = await api('POST', `/api/v1/exams/${anonId}/submit`, stu2Tok, {
      answers: [
        { question_id: q1Id, answer: 'B' },
        { question_id: q2Id, answer: 'false' }
      ]
    });
    assert.equal(submit2.status, 201);

    const denied = await api('GET', `/api/v1/exams/${anonId}/stats`, stu2Tok);
    assert.equal(denied.status, 403);

    const upd = await api('PUT', `/api/v1/exams/${anonId}`, teacherTok, { stats_public: true });
    assert.equal(upd.status, 200);

    const stats = await api('GET', `/api/v1/exams/${anonId}/stats`, stu2Tok);
    assert.equal(stats.status, 200);
    assert.equal(stats.data.summary.participants, 2);
    const q1 = stats.data.questions.find(q => q.question_id === q1Id);
    const q1Dist = Object.fromEntries(q1.distribution.map(d => [d.label, d.count]));
    assert.equal(q1Dist['B. Python'], 2);
    assert.equal(q1.answered, 2);
    const q2 = stats.data.questions.find(q => q.question_id === q2Id);
    const q2Dist = Object.fromEntries(q2.distribution.map(d => [d.label, d.count]));
    assert.equal(q2Dist['正确'], 1);
    assert.equal(q2Dist['错误'], 1);
    const q3 = stats.data.questions.find(q => q.question_id === q3Id);
    assert.equal(q3.answered, 1);
    assert.deepEqual(q3.distribution, []);
  });

  it('问卷排行榜：即使开关为 true 也返回 404', async () => {
    const lb = await api('GET', `/api/v1/exams/${anonId}/leaderboard`, teacherTok);
    assert.equal(lb.status, 404);
  });

  it('非匿名问卷：详情返回提交时刻，教师可见提交名单', async () => {
    const detail = await api('GET', `/api/v1/exams/${surveyId}`, teacherTok);
    const namedQ = db.prepare('SELECT id FROM exam_questions WHERE exam_id = ? ORDER BY sort_order LIMIT 1').get(surveyId).id;
    assert.equal(detail.data.is_anonymous, 0);

    const res = await api('POST', `/api/v1/exams/${surveyId}/submit`, stu2Tok, {
      answers: [{ question_id: namedQ, answer: 'A' }]
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.anonymous, false);
    assert.equal(typeof res.data.submitted_at, 'string');

    const mine = await api('GET', `/api/v1/exams/${surveyId}`, stu2Tok);
    assert.equal(mine.data.survey_submitted, true);
    assert.equal(typeof mine.data.survey_submitted_at, 'string');

    const list = await api('GET', `/api/v1/exams/${surveyId}/submissions`, teacherTok);
    assert.equal(list.status, 200);
    assert.equal(list.data.survey, true);
    assert.equal(list.data.anonymous, false);
    assert.equal(list.data.total, 1);
    assert.equal(list.data.submissions[0].username, 'sv_stu2');
  });

  it('普通试卷不受问卷逻辑影响：无 survey 标记、排行榜可用', async () => {
    const detail = await api('GET', `/api/v1/exams/${normalId}`, teacherTok);
    assert.equal(detail.data.is_survey, 0);
    assert.equal(detail.data.survey_submitted, false);

    const lb = await api('GET', `/api/v1/exams/${normalId}/leaderboard`, teacherTok);
    assert.equal(lb.status, 200);
    assert.equal(lb.data.leaderboard.length, 0);
  });
});
