const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
require('./_testdb')('public-code');
const db = require('../database/db');
const problemsRepo = require('../repositories/problems');
const submissionsRepo = require('../repositories/submissions');
const usersRepo = require('../repositories/users');

describe('AC 后公开代码', () => {
  let pubUser;
  let privUser;
  let viewer;
  let problem;

  function addSubmission(userId, status, source, extra = {}) {
    const id = db.findNextId('submissions');
    db.prepare(`INSERT INTO submissions (id, user_id, problem_id, language, source_code, status, score, exam_id, created_at)
      VALUES (?, ?, ?, 'cpp', ?, ?, ?, ?, ?)`).run(
      id, userId, problem, source, status, status === 'accepted' ? 100 : 0,
      extra.exam_id || null, extra.created_at || '2026-03-01 10:00:00'
    );
    return id;
  }

  before(async () => {
    await db.initDB();
    db.prepare("DELETE FROM users WHERE username IN ('pc_pub', 'pc_priv', 'pc_viewer')").run();
    pubUser = db.prepare("INSERT INTO users (username, password_hash, role, public_code) VALUES ('pc_pub', 'h', 'user', 1)").run().lastInsertRowid;
    privUser = db.prepare("INSERT INTO users (username, password_hash, role, public_code) VALUES ('pc_priv', 'h', 'user', 0)").run().lastInsertRowid;
    viewer = db.prepare("INSERT INTO users (username, password_hash, role, public_code) VALUES ('pc_viewer', 'h', 'user', 1)").run().lastInsertRowid;
    problem = db.prepare("INSERT INTO problems (title, description) VALUES ('公开代码题', 'd')").run().lastInsertRowid;

    addSubmission(pubUser, 'wrong_answer', 'wa code');
    addSubmission(pubUser, 'accepted', 'pub ac 1', { created_at: '2026-03-01 11:00:00' });
    addSubmission(pubUser, 'accepted', 'pub ac 2', { created_at: '2026-03-01 12:00:00' });
    addSubmission(privUser, 'accepted', 'priv ac', { created_at: '2026-03-01 13:00:00' });
    // 考试提交：即使 AC 也不得出现在公开列表
    addSubmission(pubUser, 'accepted', 'exam ac', { created_at: '2026-03-01 14:00:00', exam_id: 99 });
  });

  after(() => {
    db.prepare('DELETE FROM submissions WHERE problem_id = ?').run(problem);
    db.prepare('DELETE FROM problems WHERE id = ?').run(problem);
    db.prepare("DELETE FROM users WHERE username IN ('pc_pub', 'pc_priv', 'pc_viewer')").run();
  });

  it('登录用户只能看到已公开的 AC，且每人只取最新一条', () => {
    const rows = problemsRepo.listAcceptedSubmissions(problem, viewer);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, pubUser);
    assert.equal(rows[0].id, db.prepare('SELECT MAX(id) m FROM submissions WHERE user_id = ? AND status = ? AND exam_id IS NULL').get(pubUser, 'accepted').m);
  });

  it('作者自己始终能看到自己的 AC（即使关闭公开）', () => {
    const rows = problemsRepo.listAcceptedSubmissions(problem, privUser);
    assert.equal(rows.length, 2);
    assert.ok(rows.some(r => r.user_id === privUser));
  });

  it('匿名查看只返回公开代码，考试提交永不出现', () => {
    const rows = problemsRepo.listAcceptedSubmissions(problem, null);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, pubUser);
    assert.ok(!rows.some(r => r.source_code === 'exam ac'));
  });

  it('findCodeWithOwner 返回状态、考试标记与作者公开开关', () => {
    const acId = db.prepare('SELECT MAX(id) m FROM submissions WHERE user_id = ? AND status = ?').get(privUser, 'accepted').m;
    const row = submissionsRepo.findCodeWithOwner(acId);
    assert.equal(row.status, 'accepted');
    assert.equal(row.exam_id, null);
    assert.equal(row.public_code, 0);
    const examRow = submissionsRepo.findCodeWithOwner(db.prepare("SELECT id FROM submissions WHERE source_code = 'exam ac'").get().id);
    assert.equal(examRow.exam_id, 99);
  });

  it('个人设置读写包含 public_code', () => {
    const before = usersRepo.getMeSettings(pubUser);
    assert.equal(before.public_code, 1);
    db.prepare('UPDATE users SET public_code = 0 WHERE id = ?').run(pubUser);
    assert.equal(usersRepo.getMe(pubUser).public_code, 0);
    db.prepare('UPDATE users SET public_code = 1 WHERE id = ?').run(pubUser);
  });
});
