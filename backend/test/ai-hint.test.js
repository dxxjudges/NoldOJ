const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
require('./_testdb')('ai-hint');
const db = require('../database/db');
const aiHintRepo = require('../repositories/aiHint');

describe('AI 提示在比赛期间禁用', () => {
  let user;
  let outsider;
  let problem;
  let otherProblem;
  let runningContest;
  let endedContest;

  const hour = 3600 * 1000;
  const iso = (ms) => new Date(ms).toISOString();

  before(async () => {
    await db.initDB();
    db.prepare("DELETE FROM users WHERE username IN ('ah_user', 'ah_outsider')").run();
    user = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('ah_user', 'h', 'user')").run().lastInsertRowid;
    outsider = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('ah_outsider', 'h', 'user')").run().lastInsertRowid;
    problem = db.prepare("INSERT INTO problems (title, description) VALUES ('AI提示题', 'd')").run().lastInsertRowid;
    otherProblem = db.prepare("INSERT INTO problems (title, description) VALUES ('非比赛题', 'd')").run().lastInsertRowid;

    runningContest = db.prepare('INSERT INTO contests (title, start_time, end_time, created_by) VALUES (?, ?, ?, ?)')
      .run('进行中比赛', iso(Date.now() - hour), iso(Date.now() + hour), user).lastInsertRowid;
    endedContest = db.prepare('INSERT INTO contests (title, start_time, end_time, created_by) VALUES (?, ?, ?, ?)')
      .run('已结束比赛', iso(Date.now() - 3 * hour), iso(Date.now() - 2 * hour), user).lastInsertRowid;

    db.prepare('INSERT INTO contest_problems (contest_id, problem_id, sort_order) VALUES (?, ?, 1)').run(runningContest, problem);
    db.prepare('INSERT INTO contest_problems (contest_id, problem_id, sort_order) VALUES (?, ?, 1)').run(endedContest, problem);
    db.prepare('INSERT INTO contest_participants (contest_id, user_id) VALUES (?, ?)').run(runningContest, user);
    db.prepare('INSERT INTO contest_participants (contest_id, user_id) VALUES (?, ?)').run(endedContest, user);
  });

  after(() => {
    db.prepare('DELETE FROM virtual_contests WHERE user_id IN (?, ?)').run(user, outsider);
    db.prepare('DELETE FROM contests WHERE id IN (?, ?)').run(runningContest, endedContest);
    db.prepare('DELETE FROM problems WHERE id IN (?, ?)').run(problem, otherProblem);
    db.prepare("DELETE FROM users WHERE username IN ('ah_user', 'ah_outsider')").run();
  });

  it('参赛者在进行中的比赛里请求该题提示 → 命中禁用', () => {
    const hit = aiHintRepo.findActiveContest(user, problem);
    assert.ok(hit);
    assert.equal(hit.contest_id, runningContest);
    assert.equal(hit.title, '进行中比赛');
    assert.equal(hit.virtual, false);
  });

  it('非参赛者不受比赛限制', () => {
    assert.equal(aiHintRepo.findActiveContest(outsider, problem), null);
  });

  it('比赛之外的题目不受限', () => {
    assert.equal(aiHintRepo.findActiveContest(user, otherProblem), null);
  });

  it('比赛结束后恢复可用', () => {
    // 只有已结束的比赛包含 otherProblem，此时不应命中
    db.prepare('INSERT INTO contest_problems (contest_id, problem_id, sort_order) VALUES (?, ?, 1)').run(endedContest, otherProblem);
    assert.equal(aiHintRepo.findActiveContest(user, otherProblem), null);
  });

  it('虚拟比赛进行中同样禁用', () => {
    db.prepare('INSERT INTO virtual_contests (contest_id, user_id, start_time, end_time, status) VALUES (?, ?, ?, ?, ?)')
      .run(endedContest, user, iso(Date.now() - hour), iso(Date.now() + hour), 'running');
    const hit = aiHintRepo.findActiveContest(user, otherProblem);
    assert.ok(hit);
    assert.equal(hit.virtual, true);
    // 虚拟比赛已结束（end_time 过去）则不再命中
    db.prepare('UPDATE virtual_contests SET start_time = ?, end_time = ? WHERE user_id = ?')
      .run(iso(Date.now() - 2 * hour), iso(Date.now() - hour), user);
    const after = aiHintRepo.findActiveContest(user, otherProblem);
    assert.equal(after, null);
  });
});
