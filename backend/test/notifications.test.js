const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
require('./_testdb')('notifications');
const db = require('../database/db');
const repo = require('../repositories/notifications');
const { notifyUser, notifyAllUsers } = require('../services/notifications');

describe('通知中心', () => {
  let alice;
  let bob;

  before(async () => {
    await db.initDB();
    db.prepare("DELETE FROM users WHERE username IN ('nt_alice', 'nt_bob')").run();
    alice = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('nt_alice', 'h', 'user')").run().lastInsertRowid;
    bob = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('nt_bob', 'h', 'user')").run().lastInsertRowid;
    db.prepare('DELETE FROM notifications').run();
  });

  after(() => {
    db.prepare('DELETE FROM notifications').run();
    db.prepare("DELETE FROM users WHERE username IN ('nt_alice', 'nt_bob')").run();
  });

  it('notifyUser 写入一条未读通知并返回该行', () => {
    const row = notifyUser(alice, { type: 'judge', title: '题目通过', content: '提交 #1 结果：通过', link: '/pages/submission.html?id=1' });
    assert.ok(row);
    assert.equal(row.user_id, alice);
    assert.equal(row.title, '题目通过');
    assert.equal(row.is_read, 0);
    assert.equal(repo.unreadCount(alice), 1);
  });

  it('缺少标题或用户时静默丢弃（不产生脏数据）', () => {
    assert.equal(notifyUser(null, { title: 'x' }), null);
    assert.equal(notifyUser(alice, { title: '' }), null);
    assert.equal(repo.count(alice), 1);
  });

  it('list / count / unread 只返回本人数据', () => {
    notifyUser(alice, { type: 'system', title: '第二条' });
    const rows = repo.list(alice, 10, 0, false);
    assert.equal(rows.length, 2);
    assert.equal(repo.count(alice, true), 2);
    assert.equal(repo.count(bob, false), 0);
    assert.deepEqual(repo.list(bob, 10, 0, false), []);
  });

  it('markRead 只作用于本人，重复标记不报错', () => {
    const row = repo.list(alice, 1, 0, true)[0];
    repo.markRead(row.id, alice);
    assert.equal(repo.unreadCount(alice), 1);
    repo.markRead(row.id, alice);
    assert.equal(repo.unreadCount(alice), 1);
    // 他人无法把这条标为已读
    repo.markRead(row.id, bob);
    assert.equal(repo.unreadCount(alice), 1);
  });

  it('markAllRead 清空本人未读', () => {
    repo.markAllRead(alice);
    assert.equal(repo.unreadCount(alice), 0);
    assert.equal(repo.count(alice, true), 0);
  });

  it('remove 仅删除本人通知', () => {
    const row = repo.list(alice, 1, 0, false)[0];
    repo.remove(row.id, alice);
    assert.equal(repo.count(alice, false), 1);
    repo.remove(row.id, bob);
    assert.equal(repo.count(alice, false), 1);
  });

  it('notifyAllUsers 为每个用户各写一条（含新注册用户）', () => {
    notifyAllUsers({ type: 'announcement', title: '新公告：维护通知', content: '今晚停机', link: '/pages/announcement.html?id=1' });
    // nt_alice 还剩 1 条旧通知 + 1 条新公告
    assert.equal(repo.count(alice, false), 2);
    assert.equal(repo.count(bob, false), 1);
    const bobRow = repo.list(bob, 10, 0, false)[0];
    assert.equal(bobRow.title, '新公告：维护通知');
    assert.equal(bobRow.type, 'announcement');
  });

  it('分页参数生效（按 id 倒序）', () => {
    const firstPage = repo.list(alice, 1, 0, false);
    const secondPage = repo.list(alice, 1, 1, false);
    assert.equal(firstPage.length, 1);
    assert.equal(secondPage.length, 1);
    assert.ok(firstPage[0].id > secondPage[0].id);
  });
});
