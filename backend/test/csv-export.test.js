// test/csv-export.test.js —— CSV 工具（转义/BOM/下载头）与试卷成绩单导出路由
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
require('./_testdb')('csv-export');
const db = require('../database/db');
const { toCsv, sendCsv } = require('../utils/csv');

function createUser(username, role) {
  return db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES (?, 'h', ?, ?)")
    .run(username, username, role).lastInsertRowid;
}

describe('CSV 工具', () => {
  it('包含逗号/引号/换行的单元格会被正确转义', () => {
    const csv = toCsv([
      ['a,b', 'c"d'],
      ['x\ny', 'plain']
    ]);
    assert.equal(csv, '"a,b","c""d"\r\n"x\ny",plain');
  });

  it('以 = + - @ 开头的单元格加单引号，防止 Excel 公式注入', () => {
    assert.equal(toCsv([['=SUM(A1)']]), "'=SUM(A1)");
    assert.equal(toCsv([['@cmd']]), "'@cmd");
  });

  it('sendCsv 输出带 UTF-8 BOM 且文件名同时提供 ASCII 回退与 filename*', () => {
    const headers = {};
    let body = null;
    const res = {
      setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
      send: (b) => { body = b; }
    };
    sendCsv(res, '成绩单.csv', [['用户名', '张三']]);
    assert.match(headers['content-type'], /text\/csv/);
    assert.match(headers['content-disposition'], /filename\*=UTF-8''/);
    assert.ok(body.startsWith('\uFEFF'));
    assert.ok(body.includes('张三'));
  });
});

describe('试卷成绩单导出', () => {
  let server;
  let base;
  let examId;
  let teacherTok;
  let studentTok;
  let otherTok;
  let studentId;
  let questionId;

  const get = (path, token) => fetch(`${base}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });

  before(async () => {
    await db.initDB();
    db.prepare("DELETE FROM users WHERE username IN ('cs_teacher', 'cs_student', 'cs_other')").run();
    const teacher = createUser('cs_teacher', 'teacher');
    studentId = createUser('cs_student', 'user');
    createUser('cs_other', 'user');

    examId = db.prepare(`
      INSERT INTO exams (title, total_score, is_public, is_hidden, leaderboard_enabled, creator_id)
      VALUES ('cs-成绩单试卷', 10, 1, 0, 1, ?)
    `).run(teacher).lastInsertRowid;
    questionId = db.prepare(`
      INSERT INTO exam_questions (exam_id, question_type, title, score, sort_order)
      VALUES (?, 'choice', '第一题', 10, 0)
    `).run(examId).lastInsertRowid;
    const sub = db.prepare(`
      INSERT INTO exam_submissions (exam_id, user_id, status, total_score, max_score, submitted_at)
      VALUES (?, ?, 'graded', 8, 10, '2026-03-01 10:00:00')
    `).run(examId, studentId).lastInsertRowid;
    db.prepare(`
      INSERT INTO exam_answers (submission_id, question_id, score, max_score, is_correct, grading_status)
      VALUES (?, ?, 8, 10, 0, 'human_graded')
    `).run(sub, questionId);

    const { generateAccessToken } = require('../utils/tokens');
    teacherTok = generateAccessToken(teacher);
    studentTok = generateAccessToken(studentId);
    otherTok = generateAccessToken(db.prepare("SELECT id FROM users WHERE username = 'cs_other'").get().id);

    const app = express();
    app.use('/api/v1/exams', require('../routes/exams'));
    server = await new Promise(resolve => {
      const s = app.listen(0, () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}/api/v1/exams`;
  });

  after(() => {
    if (server) server.close();
    db.prepare('DELETE FROM exams WHERE id = ?').run(examId);
    db.prepare("DELETE FROM users WHERE username IN ('cs_teacher', 'cs_student', 'cs_other')").run();
  });

  it('教师默认导出全员成绩总表', async () => {
    const r = await get(`/${examId}/export.csv?scope=all`, teacherTok);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    const text = await r.text();
    assert.ok(text.includes('排名'));
    assert.ok(text.includes('cs_student'));
    assert.ok(text.includes('8'));
  });

  it('学生只能导出本人成绩单（含逐题明细）', async () => {
    const mine = await get(`/${examId}/export.csv?scope=mine`, studentTok);
    assert.equal(mine.status, 200);
    const text = await mine.text();
    assert.ok(text.includes('第一题'));
    assert.ok(text.includes('我的成绩单') || text.includes('成绩单'));

    const all = await get(`/${examId}/export.csv?scope=all`, studentTok);
    assert.equal(all.status, 403);
  });

  it('未交卷用户导出本人成绩单返回 404', async () => {
    const r = await get(`/${examId}/export.csv?scope=mine`, otherTok);
    assert.equal(r.status, 404);
  });
});
