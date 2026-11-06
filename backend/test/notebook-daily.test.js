const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
require('./_testdb')('notebook-daily');
const db = require('../database/db');
const notebook = require('../repositories/notebook');
const daily = require('../repositories/daily');

describe('错题本', () => {
  let me;
  let other;
  let wrongProblem;
  let solvedProblem;
  let dismissedProblem;

  function addSubmission(userId, problemId, status, createdAt) {
    const id = db.findNextId('submissions');
    db.prepare(`INSERT INTO submissions (id, user_id, problem_id, language, source_code, status, score, created_at)
      VALUES (?, ?, ?, 'cpp', 'int main(){}', ?, ?, ?)`).run(id, userId, problemId, status, status === 'accepted' ? 100 : 0, createdAt);
    return id;
  }

  before(async () => {
    await db.initDB();
    db.prepare("DELETE FROM users WHERE username IN ('nb_me', 'nb_other')").run();
    me = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('nb_me', 'h', 'user')").run().lastInsertRowid;
    other = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('nb_other', 'h', 'user')").run().lastInsertRowid;
    const p1 = db.prepare("INSERT INTO problems (title, description) VALUES ('错题本题 A', 'd')").run().lastInsertRowid;
    const p2 = db.prepare("INSERT INTO problems (title, description) VALUES ('错题本题 B', 'd')").run().lastInsertRowid;
    const p3 = db.prepare("INSERT INTO problems (title, description) VALUES ('错题本题 C', 'd')").run().lastInsertRowid;
    wrongProblem = p1;
    solvedProblem = p2;
    dismissedProblem = p3;
    addSubmission(me, p1, 'wrong_answer', '2026-01-01 10:00:00');
    addSubmission(me, p2, 'wrong_answer', '2026-01-01 11:00:00');
    addSubmission(me, p2, 'accepted', '2026-01-01 12:00:00');
    addSubmission(me, p3, 'wrong_answer', '2026-01-01 13:00:00');
  });

  after(() => {
    db.prepare('DELETE FROM notebook_marks').run();
    db.prepare('DELETE FROM submissions WHERE problem_id IN (?, ?, ?)').run(wrongProblem, solvedProblem, dismissedProblem);
    db.prepare('DELETE FROM problems WHERE id IN (?, ?, ?)').run(wrongProblem, solvedProblem, dismissedProblem);
    db.prepare("DELETE FROM users WHERE username IN ('nb_me', 'nb_other')").run();
  });

  it('自动收录「有提交但尚未 AC」的题目，已 AC 的不收录', () => {
    assert.equal(notebook.countWrong(me), 2);
    const items = notebook.listWrong(me, 20, 0);
    const ids = items.map(i => i.problem_id);
    assert.ok(ids.includes(wrongProblem));
    assert.ok(ids.includes(dismissedProblem));
    assert.ok(!ids.includes(solvedProblem));
    const first = items.find(i => i.problem_id === wrongProblem);
    assert.equal(first.attempt_count, 1);
    assert.equal(first.last_status, 'wrong_answer');
  });

  it('他人错题集与本人隔离', () => {
    assert.equal(notebook.countWrong(other), 0);
    assert.deepEqual(notebook.listWrong(other, 20, 0), []);
  });

  it('标记 mastered 后仍保留，笔记可回读', () => {
    notebook.upsert(me, wrongProblem, 'mastered', '边界没判');
    const mark = notebook.getMark(me, wrongProblem);
    assert.equal(mark.status, 'mastered');
    assert.equal(mark.note, '边界没判');
    const item = notebook.listWrong(me, 20, 0).find(i => i.problem_id === wrongProblem);
    assert.equal(item.mark_status, 'mastered');
    assert.equal(item.note, '边界没判');
    assert.equal(notebook.countWrong(me), 2);
  });

  it('dismissed 后从错题集移除', () => {
    notebook.upsert(me, dismissedProblem, 'dismissed', '');
    assert.equal(notebook.countWrong(me), 1);
    assert.ok(!notebook.listWrong(me, 20, 0).some(i => i.problem_id === dismissedProblem));
  });

  it('upsert 幂等（重复写入不产生重复行）', () => {
    notebook.upsert(me, wrongProblem, 'mastered', '改过的笔记');
    notebook.upsert(me, wrongProblem, 'mastered', '改过的笔记');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM notebook_marks WHERE user_id = ? AND problem_id = ?').get(me, wrongProblem).c, 1);
    assert.equal(notebook.getMark(me, wrongProblem).note, '改过的笔记');
  });
});

describe('每日一题', () => {
  let user;
  let problem;

  before(async () => {
    await db.initDB();
    db.prepare("DELETE FROM users WHERE username = 'daily_user'").run();
    user = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('daily_user', 'h', 'user')").run().lastInsertRowid;
    problem = db.prepare("INSERT INTO problems (title, description) VALUES ('每日题', 'd')").run().lastInsertRowid;
    db.prepare('DELETE FROM daily_problems').run();
    db.prepare('DELETE FROM daily_checkins').run();
  });

  after(() => {
    db.prepare('DELETE FROM daily_problems').run();
    db.prepare('DELETE FROM daily_checkins').run();
    db.prepare('DELETE FROM submissions WHERE problem_id = ?').run(problem);
    db.prepare('DELETE FROM problems WHERE id = ?').run(problem);
    db.prepare("DELETE FROM users WHERE username = 'daily_user'").run();
  });

  it('同一天选题确定且落库复用', () => {
    const a = daily.getOrCreate('2026-02-01');
    const b = daily.getOrCreate('2026-02-01');
    assert.ok(a);
    assert.equal(a.problem_id, b.problem_id);
    const row = db.prepare('SELECT problem_id FROM daily_problems WHERE day = ?').get('2026-02-01');
    assert.equal(row.problem_id, a.problem_id);
  });

  it('不同日期独立选题（不覆盖历史记录）', () => {
    const a = daily.getOrCreate('2026-02-01');
    const b = daily.getOrCreate('2026-02-02');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM daily_problems').get().c, 2);
    assert.ok(b.problem_id > 0);
    assert.ok(a.problem_id > 0);
  });

  it('hasAcceptedOnDay 只认当天非考试 AC', () => {
    const id = db.findNextId('submissions');
    db.prepare(`INSERT INTO submissions (id, user_id, problem_id, language, source_code, status, created_at)
      VALUES (?, ?, ?, 'cpp', 'int main(){}', 'accepted', '2026-02-01 08:00:00')`).run(id, user, problem);
    assert.equal(daily.hasAcceptedOnDay(user, problem, '2026-02-01'), true);
    assert.equal(daily.hasAcceptedOnDay(user, problem, '2026-02-02'), false);
  });

  it('checkin 幂等，streak 只统计连续日期', () => {
    daily.checkin(user, '2026-02-01', problem);
    daily.checkin(user, '2026-02-01', problem);
    assert.equal(daily.isCheckedIn(user, '2026-02-01'), true);
    assert.equal(daily.streak(user, '2026-02-01'), 1);

    daily.checkin(user, '2026-02-02', problem);
    assert.equal(daily.streak(user, '2026-02-02'), 2);
    // 中间断档：2-04 打卡后，连续天数从 2-04 重新计数
    daily.checkin(user, '2026-02-04', problem);
    assert.equal(daily.streak(user, '2026-02-04'), 1);
  });

  it('prevDay 跨月回退正确', () => {
    assert.equal(daily.prevDay('2026-03-01'), '2026-02-28');
    assert.equal(daily.prevDay('2026-01-01'), '2025-12-31');
  });
});
