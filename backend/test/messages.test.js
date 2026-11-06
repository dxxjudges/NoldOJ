// test/messages.test.js —— 私信：仓储层（会话聚合/未读/软删）+ 路由层（发送/读取/已读/越权）
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
require('./_testdb')('messages');
const db = require('../database/db');
const repo = require('../repositories/messages');
const { sendMessage } = require('../services/messages');

function createUser(username, role = 'user') {
  return db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES (?, 'h', ?, ?)")
    .run(username, username, role).lastInsertRowid;
}

describe('私信（仓储层）', () => {
  let alice;
  let bob;

  before(async () => {
    await db.initDB();
    db.prepare("DELETE FROM messages").run();
    db.prepare("DELETE FROM users WHERE username IN ('dm_alice', 'dm_bob')").run();
    alice = createUser('dm_alice');
    bob = createUser('dm_bob');
  });

  after(() => {
    db.prepare('DELETE FROM messages').run();
    db.prepare("DELETE FROM users WHERE username IN ('dm_alice', 'dm_bob')").run();
  });

  it('发送后接收方产生未读数，发送方没有', () => {
    const row = sendMessage(alice, bob, '你好');
    assert.equal(row.sender_id, alice);
    assert.equal(row.receiver_id, bob);
    assert.equal(row.is_read, 0);
    assert.equal(repo.unreadTotal(bob), 1);
    assert.equal(repo.unreadTotal(alice), 0);
  });

  it('会话列表按最新消息排序并带摘要与未读数', () => {
    sendMessage(bob, alice, '在吗');
    const list = repo.listConversations(bob);
    assert.equal(list.length, 1);
    assert.equal(list[0].peer.id, alice);
    assert.equal(list[0].last_message.content, '在吗');
    assert.equal(list[0].unread, 1);
  });

  it('历史按升序返回；只有接收方能把消息标记为已读', () => {
    const rows = repo.history(bob, alice, { limit: 10 });
    assert.deepEqual(rows.map(r => r.content), ['你好', '在吗']);
    assert.equal(repo.unreadTotal(bob), 1);
    // 发送方调用 markRead 不生效
    const unreadRow = rows.find(m => m.sender_id === alice && m.is_read === 0);
    repo.markRead(unreadRow.id, alice);
    assert.equal(repo.getById(unreadRow.id).is_read, 0);
    // 接收方标记整个会话已读
    repo.markConversationRead(bob, alice);
    assert.equal(repo.unreadTotal(bob), 0);
  });

  it('before_id 向上翻页只取更早的消息', () => {
    const latest = repo.history(bob, alice, { limit: 1 })[0];
    const older = repo.history(bob, alice, { limit: 10, beforeId: latest.id });
    assert.equal(older.length, 1);
    assert.equal(older[0].content, '你好');
  });

  it('软删只影响自己一侧，双方都删后物理清理', () => {
    const row = sendMessage(alice, bob, '待删除');
    repo.softDelete(row.id, alice);
    assert.equal(repo.history(alice, bob, { limit: 20 }).some(m => m.id === row.id), false);
    assert.equal(repo.history(bob, alice, { limit: 20 }).some(m => m.id === row.id), true);
    repo.softDelete(row.id, bob);
    assert.equal(repo.getById(row.id), undefined);
  });
});

describe('私信（HTTP 路由）', () => {
  let server;
  let alice;
  let bob;
  let carol;
  let bannedUser;
  let aliceTok;
  let bobTok;
  let carolTok;

  const req = (path, opts = {}) => fetch(`${base}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  let base = '';

  before(async () => {
    await db.initDB();
    db.prepare('DELETE FROM messages').run();
    db.prepare("DELETE FROM users WHERE username IN ('dmr_alice', 'dmr_bob', 'dmr_carol', 'dmr_banned')").run();
    alice = createUser('dmr_alice');
    bob = createUser('dmr_bob');
    carol = createUser('dmr_carol');
    bannedUser = createUser('dmr_banned');
    db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(bannedUser);

    const { generateAccessToken } = require('../utils/tokens');
    aliceTok = generateAccessToken(alice);
    bobTok = generateAccessToken(bob);
    carolTok = generateAccessToken(carol);

    const app = express();
    app.use(express.json());
    app.use('/api/v1/messages', require('../routes/messages'));
    server = await new Promise(resolve => {
      const s = app.listen(0, () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}/api/v1/messages`;
  });

  after(() => {
    if (server) server.close();
    db.prepare('DELETE FROM messages').run();
    db.prepare("DELETE FROM users WHERE username IN ('dmr_alice', 'dmr_bob', 'dmr_carol', 'dmr_banned')").run();
  });

  it('发送成功返回 201，未读数可查询', async () => {
    const r = await req('', {
      method: 'POST',
      body: JSON.stringify({ to: 'dmr_bob', content: '测试消息' })
    });
    // 未带 token 时 401
    assert.equal(r.status, 401);

    const ok = await req('', {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceTok}` },
      body: JSON.stringify({ to: 'dmr_bob', content: '测试消息' })
    });
    assert.equal(ok.status, 201);
    const data = await ok.json();
    assert.equal(data.data.content, '测试消息');

    const unread = await req('/unread-count', { headers: { Authorization: `Bearer ${bobTok}` } });
    assert.equal((await unread.json()).unread, 1);
  });

  it('会话列表与历史接口返回对端信息', async () => {
    const list = await req('', { headers: { Authorization: `Bearer ${bobTok}` } });
    const body = await list.json();
    assert.equal(body.conversations.length, 1);
    assert.equal(body.conversations[0].peer.username, 'dmr_alice');

    const hist = await req('/dmr_alice', { headers: { Authorization: `Bearer ${bobTok}` } });
    const h = await hist.json();
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].content, '测试消息');
    assert.equal(h.unread, 1);
  });

  it('标记已读后未读清零，且第三方读不到别人的会话', async () => {
    const put = await req('/dmr_alice/read', { method: 'PUT', headers: { Authorization: `Bearer ${bobTok}` } });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).unread, 0);

    const peer = await req('/dmr_alice', { headers: { Authorization: `Bearer ${carolTok}` } });
    const body = await peer.json();
    assert.deepEqual(body.messages, []);

    const unreadCarol = await req('/unread-count', { headers: { Authorization: `Bearer ${carolTok}` } });
    assert.equal((await unreadCarol.json()).unread, 0);
  });

  it('不能给自己发信、不能给封禁用户发信、超长内容被拒绝', async () => {
    const self = await req('', {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceTok}` },
      body: JSON.stringify({ to: 'dmr_alice', content: 'hi' })
    });
    assert.equal(self.status, 400);

    const banned = await req('', {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceTok}` },
      body: JSON.stringify({ to: 'dmr_banned', content: 'hi' })
    });
    assert.equal(banned.status, 403);

    const tooLong = await req('', {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceTok}` },
      body: JSON.stringify({ to: 'dmr_bob', content: 'x'.repeat(2001) })
    });
    assert.equal(tooLong.status, 400);
  });

  it('第三方不能删除他人消息', async () => {
    const row = await req('/dmr_alice', { headers: { Authorization: `Bearer ${bobTok}` } });
    const id = (await row.json()).messages[0].id;
    const del = await req(`/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${carolTok}` } });
    assert.equal(del.status, 404);
  });
});
