// test/personal-tokens.test.js —— 私人令牌：工具/仓储层 + PAT 鉴权与 scope 路由层
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
require('./_testdb')('personal-tokens');
const express = require('express');
const db = require('../database/db');
const repo = require('../repositories/personalTokens');
const { generateAccessToken } = require('../utils/tokens');
const {
  generateToken,
  hashToken,
  verifyHash,
  normalizeScopes,
  expiresAtFromDays,
  PAT_PREFIX
} = require('../utils/personalTokens');

function createUser(username, role = 'user') {
  const info = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES (?, 'h', ?, ?)")
    .run(username, username, role);
  return info.lastInsertRowid;
}

describe('私人令牌（工具层）', () => {
  it('生成令牌带固定前缀，摘要不等于明文且可校验', () => {
    const { token, prefix, hash } = generateToken();
    assert.ok(token.startsWith(PAT_PREFIX));
    assert.equal(token.length, PAT_PREFIX.length + 32);
    assert.ok(prefix.length >= PAT_PREFIX.length);
    assert.notEqual(hash, token);
    assert.equal(hash, hashToken(token));
    assert.equal(verifyHash(token, hash), true);
    assert.equal(verifyHash(token + 'x', hash), false);
    assert.equal(verifyHash(token, 'deadbeef'), false);
  });

  it('scope 规范化拒绝未知值与空数组', () => {
    assert.deepEqual(normalizeScopes(['read', 'READ', 'submit']), ['read', 'submit']);
    assert.equal(normalizeScopes(['read', 'admin']), null);
    assert.equal(normalizeScopes([]), null);
    assert.equal(normalizeScopes('read'), null);
  });

  it('0 天表示永久（NULL），正天数生成 UTC 过期时间', () => {
    assert.equal(expiresAtFromDays(0), null);
    const expiresAt = expiresAtFromDays(30);
    assert.match(expiresAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const ms = Date.parse(expiresAt.replace(' ', 'T') + 'Z');
    assert.ok(ms > Date.now() + 29 * 86400000);
  });
});

describe('私人令牌（仓储层）', () => {
  let alice;
  let bob;

  before(async () => {
    await db.initDB();
    db.prepare("DELETE FROM personal_access_tokens").run();
    db.prepare("DELETE FROM users WHERE username IN ('pat_repo_alice', 'pat_repo_bob')").run();
    alice = createUser('pat_repo_alice');
    bob = createUser('pat_repo_bob');
  });

  after(() => {
    db.prepare('DELETE FROM personal_access_tokens').run();
    db.prepare("DELETE FROM users WHERE username IN ('pat_repo_alice', 'pat_repo_bob')").run();
  });

  it('永久令牌 expires_at 为空，列表不暴露摘要', () => {
    const created = repo.create(alice, 'cli', ['read', 'submit'], null);
    const rows = repo.listByUser(alice);
    const row = rows.find(r => r.id === created.id);
    assert.equal(row.expires_at, null);
    assert.equal(row.name, 'cli');
    assert.equal(row.token_hash, undefined);
    assert.equal(row.token, undefined);
    assert.equal(repo.countByUser(alice), 1);
  });

  it('按前缀可查到候选行，吊销受 user_id 约束', () => {
    const created = repo.create(alice, 'to-revoke', ['read'], null);
    const candidates = repo.findByPrefix(created.prefix);
    assert.ok(candidates.some(r => r.id === created.id));

    // 他人不能吊销
    assert.equal(repo.revoke(created.id, bob).changes, 0);
    assert.equal(repo.countByUser(alice), 2);
    // 本人可以吊销
    assert.equal(repo.revoke(created.id, alice).changes, 1);
    assert.equal(repo.countByUser(alice), 1);
  });
});

describe('私人令牌（HTTP 鉴权与 scope）', () => {
  let server;
  let base;
  let alice;
  let aliceJwt;
  let bobId;
  let bobJwt;

  const req = (path, opts = {}) => fetch(`${base}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const auth = token => ({ Authorization: `Bearer ${token}` });

  before(async () => {
    await db.initDB();
    db.prepare("DELETE FROM personal_access_tokens").run();
    db.prepare("DELETE FROM users WHERE username LIKE 'pat_http_%'").run();
    alice = createUser('pat_http_alice');
    aliceJwt = generateAccessToken(alice);
    // 独立用户用于参数校验与 tokeninfo，避免撞上创建令牌的每小时限流计数
    bobId = createUser('pat_http_bob');
    bobJwt = generateAccessToken(bobId);

    const { requireAuth, optionalAuth } = require('../middleware/auth');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/users/me/tokens', require('../routes/tokens'));
    app.use('/api/v1/auth', require('../routes/auth'));
    app.get('/api/v1/users/me', requireAuth, (req, res) => res.json({ id: req.user.id, authType: req.authType }));
    app.put('/api/v1/users/me', requireAuth, (req, res) => res.json({ ok: true }));
    app.get('/api/v1/problems', requireAuth, (req, res) => res.json({ ok: true }));
    app.post('/api/v1/submissions', requireAuth, (req, res) => res.json({ ok: true }));
    app.post('/api/v1/ide/run', requireAuth, (req, res) => res.json({ ok: true }));
    app.post('/api/v1/exams/1/submit', requireAuth, (req, res) => res.json({ ok: true }));
    app.post('/api/v1/articles', requireAuth, (req, res) => res.json({ ok: true }));
    app.get('/api/v1/optional', optionalAuth, (req, res) => res.json({ id: req.user ? req.user.id : null }));

    server = await new Promise(resolve => {
      const s = app.listen(0, () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
  });

  after(() => {
    if (server) server.close();
    db.prepare('DELETE FROM personal_access_tokens').run();
    db.prepare("DELETE FROM users WHERE username LIKE 'pat_http_%'").run();
  });

  async function createViaHttp(payload, jwt = aliceJwt) {
    const res = await req('/users/me/tokens', {
      method: 'POST',
      headers: auth(jwt),
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    assert.equal(res.status, 201, text);
    return JSON.parse(text);
  }

  it('登录会话创建令牌，列表不返回明文', async () => {
    const created = await createViaHttp({ name: 'read-only', expires_in_days: 7, scopes: ['read'] });
    assert.ok(created.token.startsWith(PAT_PREFIX));
    assert.equal(created.permanent, false);

    const list = await req('/users/me/tokens', { headers: auth(aliceJwt) });
    const body = await list.json();
    assert.equal(body.tokens.length, 1);
    assert.equal(body.tokens[0].token, undefined);
    assert.equal(body.tokens[0].token_hash, undefined);
    assert.deepEqual(body.tokens[0].scopes, ['read']);
  });

  it('read 令牌可读不可提交；submit 令牌可进入提交路由', async () => {
    const readToken = (await createViaHttp({ name: 'read', expires_in_days: 0, scopes: ['read'] })).token;
    const readMe = await req('/users/me', { headers: auth(readToken) });
    assert.equal(readMe.status, 200);
    assert.equal((await readMe.json()).authType, 'pat');

    const denied = await req('/submissions', { method: 'POST', headers: auth(readToken), body: '{}' });
    assert.equal(denied.status, 403);
    assert.match((await denied.json()).message, /submit/);

    const submitToken = (await createViaHttp({ name: 'submit', expires_in_days: 30, scopes: ['read', 'submit'] })).token;
    assert.equal((await req('/submissions', { method: 'POST', headers: auth(submitToken), body: '{}' })).status, 200);
    assert.equal((await req('/ide/run', { method: 'POST', headers: auth(submitToken), body: '{}' })).status, 200);
    assert.equal((await req('/exams/1/submit', { method: 'POST', headers: auth(submitToken), body: '{}' })).status, 200);
  });

  it('write 与 account 分别控制业务写操作和个人资料', async () => {
    const writeToken = (await createViaHttp({ name: 'write', expires_in_days: 30, scopes: ['read', 'write'] })).token;
    assert.equal((await req('/articles', { method: 'POST', headers: auth(writeToken), body: '{}' })).status, 200);
    // 没有 account scope，不能改个人资料
    const profileDenied = await req('/users/me', { method: 'PUT', headers: auth(writeToken), body: '{}' });
    assert.equal(profileDenied.status, 403);
    assert.match((await profileDenied.json()).message, /account/);

    const accountToken = (await createViaHttp({ name: 'account', expires_in_days: 30, scopes: ['read', 'account'] })).token;
    assert.equal((await req('/users/me', { method: 'PUT', headers: auth(accountToken), body: '{}' })).status, 200);
    // 但 account 不含 write
    assert.equal((await req('/articles', { method: 'POST', headers: auth(accountToken), body: '{}' })).status, 403);
  });

  it('PAT 不能管理令牌，也不能走 change-password 类凭证接口', async () => {
    const token = (await createViaHttp({ name: 'self', expires_in_days: 0, scopes: ['read', 'write', 'account', 'submit'] })).token;
    const list = await req('/users/me/tokens', { headers: auth(token) });
    assert.equal(list.status, 403);
    const create = await req('/users/me/tokens', { method: 'POST', headers: auth(token), body: JSON.stringify({ name: 'x', scopes: ['read'] }) });
    assert.equal(create.status, 403);
  });

  it('过期令牌 401，吊销后 401', async () => {
    const expired = repo.create(alice, 'expired', ['read'], '2000-01-01 00:00:00');
    const expiredRes = await req('/problems', { headers: auth(expired.token) });
    assert.equal(expiredRes.status, 401);

    const live = (await createViaHttp({ name: 'revoked', expires_in_days: 0, scopes: ['read'] })).token;
    assert.equal((await req('/problems', { headers: auth(live) })).status, 200);
    const revokeRes = await req(`/users/me/tokens/${repo.listByUser(alice).find(r => r.name === 'revoked').id}`, {
      method: 'DELETE',
      headers: auth(aliceJwt)
    });
    assert.equal(revokeRes.status, 200);
    assert.equal((await req('/problems', { headers: auth(live) })).status, 401);
  });

  it('optionalAuth 下 PAT 有效则识别，scope 不足则退化为匿名', async () => {
    const readToken = (await createViaHttp({ name: 'opt-read', expires_in_days: 0, scopes: ['read'] })).token;
    const ok = await req('/optional', { headers: auth(readToken) });
    assert.equal((await ok.json()).id, alice);

    const submitOnly = (await createViaHttp({ name: 'opt-submit', expires_in_days: 0, scopes: ['submit'] })).token;
    const anon = await req('/optional', { headers: auth(submitOnly) });
    assert.equal((await anon.json()).id, null);
  });

  it('tokeninfo 返回凭据类型、用户、权限范围与到期信息，且不受 scope 限制', async () => {
    // 仅 submit 权限的令牌也能自检（tokeninfo 不要求 read）
    const pat = await createViaHttp({ name: 'info', expires_in_days: 0, scopes: ['submit'] }, bobJwt);
    const res = await req('/auth/tokeninfo', { headers: auth(pat.token) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.auth_type, 'pat');
    assert.equal(body.user.id, bobId);
    assert.equal(body.user.username, 'pat_http_bob');
    assert.equal(body.token.id, pat.id);
    assert.equal(body.token.name, 'info');
    assert.deepEqual(body.token.scopes, ['submit']);
    assert.equal(body.token.expires_at, null);
    assert.equal(body.token.permanent, true);
    assert.equal(body.token.expired, false);
    assert.equal(body.token.prefix, pat.prefix);

    // JWT 会话调用返回 auth_type=jwt、token=null
    const jwtRes = await req('/auth/tokeninfo', { headers: auth(bobJwt) });
    const jwtBody = await jwtRes.json();
    assert.equal(jwtRes.status, 200);
    assert.equal(jwtBody.auth_type, 'jwt');
    assert.equal(jwtBody.token, null);
    assert.equal(jwtBody.user.id, bobId);

    // 过期令牌无法通过鉴权
    const expired = repo.create(bobId, 'info-expired', ['read'], '2000-01-01 00:00:00');
    assert.equal((await req('/auth/tokeninfo', { headers: auth(expired.token) })).status, 401);
  });

  it('参数校验：未知 scope、空名称、非法天数均 400', async () => {
    for (const payload of [
      { name: '', scopes: ['read'] },
      { name: 'bad', scopes: ['admin'] },
      { name: 'bad', scopes: ['read'], expires_in_days: -1 },
      { name: 'bad', scopes: ['read'], expires_in_days: 1.5 }
    ]) {
      const res = await req('/users/me/tokens', { method: 'POST', headers: auth(bobJwt), body: JSON.stringify(payload) });
      assert.equal(res.status, 400, JSON.stringify(payload));
    }
  });
});
