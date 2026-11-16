const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
require('./_testdb')('submission-switch');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const db = require('../database/db');
const config = require('../config/config');
const usersRouter = require('../routes/users');
const submissionsRouter = require('../routes/submissions');
const ideRouter = require('../routes/ide');
const { generateAccessToken } = require('../utils/tokens');

const app = express();
app.use(express.json());
app.use('/api/v1/users', usersRouter);
app.use('/api/v1/submissions', submissionsRouter);
app.use('/api/v1/ide', ideRouter);

let server;
let baseUrl;
let suJwt;
let userJwt;
const originalPath = config.submission.path;
const tmpConfig = path.join(os.tmpdir(), `noldoj-submission-${process.pid}.txt`);

function createUser(username, role) {
  const info = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES (?, 'h', ?, ?)")
    .run(username, username, role);
  return info.lastInsertRowid;
}

async function call(method, url, jwt, body) {
  const res = await fetch(baseUrl + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json, text };
}

describe('代码提交总开关', () => {
  before(async () => {
    await db.initDB();
    db.prepare("DELETE FROM users WHERE username IN ('sw_su', 'sw_user')").run();
    const suId = createUser('sw_su', 'su');
    const userId = createUser('sw_user', 'user');
    suJwt = generateAccessToken(suId);
    userJwt = generateAccessToken(userId);

    config.submission.path = tmpConfig;
    config.submission.enabled = true;
    try { fs.unlinkSync(tmpConfig); } catch { /* 不存在则忽略 */ }

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    config.submission.enabled = true;
    config.submission.path = originalPath;
    try { fs.unlinkSync(tmpConfig); } catch { /* 不存在则忽略 */ }
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('默认开启，仅超管可查询', async () => {
    const su = await call('GET', '/api/v1/users/submission-enabled', suJwt);
    assert.equal(su.status, 200);
    assert.equal(su.json.enabled, true);

    const normal = await call('GET', '/api/v1/users/submission-enabled', userJwt);
    assert.equal(normal.status, 403);
  });

  it('非超管不可切换开关', async () => {
    const res = await call('PUT', '/api/v1/users/submission-enabled', userJwt, { enabled: false });
    assert.equal(res.status, 403);
    assert.equal(config.submission.enabled, true);
  });

  it('参数必须是布尔值', async () => {
    const res = await call('PUT', '/api/v1/users/submission-enabled', suJwt, { enabled: 'false' });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 1);
  });

  it('关闭后判题提交与 IDE 运行/审查一律 403', async () => {
    const off = await call('PUT', '/api/v1/users/submission-enabled', suJwt, { enabled: false });
    assert.equal(off.status, 200);
    assert.equal(off.json.enabled, false);
    assert.equal(fs.readFileSync(tmpConfig, 'utf8').includes('SUBMISSION_ENABLED=false'), true);

    const submit = await call('POST', '/api/v1/submissions', userJwt, { problem_id: 1 });
    assert.equal(submit.status, 403);
    assert.equal(submit.json.reason, 'ERR_SUBMISSION_DISABLED');

    const run = await call('POST', '/api/v1/ide/run', userJwt, { language: 'cpp', source_code: 'int main(){}' });
    assert.equal(run.status, 403);
    assert.equal(run.json.reason, 'ERR_SUBMISSION_DISABLED');

    const review = await call('POST', '/api/v1/ide/review', userJwt, { language: 'cpp', source_code: 'x'.repeat(60) });
    assert.equal(review.status, 403);
    assert.equal(review.json.reason, 'ERR_SUBMISSION_DISABLED');
  });

  it('重新开启后请求恢复进入业务校验（不再 403）', async () => {
    const on = await call('PUT', '/api/v1/users/submission-enabled', suJwt, { enabled: true });
    assert.equal(on.status, 200);
    assert.equal(on.json.enabled, true);

    const submit = await call('POST', '/api/v1/submissions', userJwt, {});
    assert.equal(submit.status, 400);
    assert.equal(submit.json.code, 1);

    const run = await call('POST', '/api/v1/ide/run', userJwt, { language: 'not-a-language', source_code: 'x' });
    assert.equal(run.status, 400);
    assert.equal(run.json.code, 1);
  });
});
