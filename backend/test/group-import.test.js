// test/group-import.test.js —— 用户组 Excel 批量导入（POST /api/v1/groups/:id/import）
// 前端已把 xlsx 解析成结构化 users 数组，后端只做整单校验 + 逐行事务：
// 已注册用户直接入组，未注册用户用 default_password 建号（role 恒为 user）后入组。
// 进程内 express + app.listen(0) 起服务（与 exam-program.test.js 同款模式，无 CSRF 中间件，
// 故请求不带 Origin 头），断言 HTTP 状态码、错误体 code/reason 与库内真实落库结果。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
require('./_testdb')('group-import');

const bcrypt = require('bcryptjs');
const db = require('../database/db');
const express = require('express');
const groupsRepo = require('../repositories/groups');
const { generateAccessToken } = require('../utils/tokens');

const PASSWORD = 'Gi@2024pass';

// 测试库跨次运行保留（_testdb 只固定路径），前后各清一遍，保证可重复运行
function purge() {
  for (const g of db.prepare("SELECT id FROM groups WHERE kind = 'custom'").all()) {
    db.prepare('DELETE FROM user_groups WHERE group_id = ?').run(g.id);
    db.prepare('DELETE FROM groups WHERE id = ?').run(g.id);
  }
  for (const u of db.prepare("SELECT id FROM users WHERE username LIKE 'gi%'").all()) {
    db.prepare('DELETE FROM user_groups WHERE user_id = ?').run(u.id);
    db.prepare("DELETE FROM groups WHERE kind = 'personal' AND owner_id = ?").run(u.id);
  }
  db.prepare("DELETE FROM users WHERE username LIKE 'gi%'").run();
}

function createUser(username, role) {
  return db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES (?, 'h', ?, ?)")
    .run(username, username, role).lastInsertRowid;
}

const usernameOf = (name) => db.prepare('SELECT * FROM users WHERE username = ?').get(name);
const memberRows = (groupId, username) => db.prepare(`
  SELECT ug.* FROM user_groups ug JOIN users u ON u.id = ug.user_id
  WHERE ug.group_id = ? AND u.username = ?
`).all(groupId, username);

describe('用户组批量导入（路由接入层）', () => {
  let server;
  let base;
  let suTok, adminTok, userTok;
  let suId;
  let groupId;

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
    try { data = await res.json(); } catch { /* 无 JSON 响应体 */ }
    return { status: res.status, data };
  }

  const import_ = (users, extra = {}) => api('POST', `/api/v1/groups/${groupId}/import`, suTok, { users, ...extra });

  before(async () => {
    await db.initDB();
    purge();

    suId = createUser('gi_su', 'su');
    const adminId = createUser('gi_admin', 'admin');
    const userId = createUser('gi_user', 'user');
    createUser('gi_target1', 'user');
    createUser('gi_target2', 'user');
    suTok = generateAccessToken(suId);
    adminTok = generateAccessToken(adminId);
    userTok = generateAccessToken(userId);

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/v1/groups', require('../routes/groups'));
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;

    const created = await api('POST', '/api/v1/groups', suTok, { name: 'gi-导入目标组', description: '批量导入测试' });
    groupId = created.data.group.id;
  });

  after(() => {
    try {
      if (server) server.close();
      purge();
    } catch {
      // 清理失败不掩盖用例断言（after 阶段已无返回值可断言）
    }
  });

  it('su 导入已注册用户进自定义组：200 / added=1 / registered=0 / 成员表可查', async () => {
    // 全部账号都已注册 → 不需要 default_password
    const r = await import_([{ username: 'gi_target1' }]);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(Object.keys(r.data).sort(), ['added', 'failed', 'registered', 'skipped', 'total']);
    assert.equal(r.data.total, 1);
    assert.equal(r.data.added, 1);
    assert.equal(r.data.registered, 0, '已注册用户不该触发建号');
    assert.equal(r.data.skipped, 0);
    assert.deepEqual(r.data.failed, []);
    assert.equal(memberRows(groupId, 'gi_target1').length, 1, 'user_groups 应有 1 行');
    assert.ok(groupsRepo.listGroupMembers(groupId, { limit: 50, offset: 0 }).members.some(m => m.username === 'gi_target1'));
    assert.equal(usernameOf('gi_target1').nickname, 'gi_target1', '已注册用户资料不被导入改动');
  });

  it('未注册用户 + 合规默认密码：自动注册并入组，密码可用且角色恒为 user', async () => {
    const r = await import_(
      [{ username: 'gi_new_1', nickname: '新同学一' }, { username: 'gi_new_1b' }],
      { default_password: PASSWORD, role: 'su' }
    );
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.total, 2);
    assert.equal(r.data.added, 2);
    assert.equal(r.data.registered, 2, '两个未注册账号都应建号');
    assert.equal(r.data.skipped, 0);
    assert.deepEqual(r.data.failed, []);

    const created = usernameOf('gi_new_1');
    assert.ok(created, '账号应被自动创建');
    assert.equal(created.role, 'user', '请求体里的 role 字段被忽略，角色恒为 user');
    assert.equal(created.nickname, '新同学一');
    assert.equal(bcrypt.compareSync(PASSWORD, created.password_hash), true, '新账号密码应等于 default_password');
    // 昵称缺省时与用户名相同
    const second = usernameOf('gi_new_1b');
    assert.equal(second.nickname, 'gi_new_1b');
    assert.equal(second.role, 'user');
    assert.equal(bcrypt.compareSync(PASSWORD, second.password_hash), true);
    // 逐行事务的另一半：建号与入组同事务，两个账号都必须已在组内
    assert.equal(memberRows(groupId, 'gi_new_1').length, 1);
    assert.equal(memberRows(groupId, 'gi_new_1b').length, 1);
    // 自动注册只落在 user 角色上，没有顺带造出管理角色
    assert.equal(db.prepare("SELECT COUNT(*) as c FROM users WHERE username LIKE 'gi_new%' AND role <> 'user'").get().c, 0);
  });

  it('文件内重复 username 去重：保留首次出现，total 按去重后计', async () => {
    const r = await import_(
      [{ username: 'gi_dup', nickname: '首次昵称' }, { username: 'gi_dup', nickname: '第二次昵称' }],
      { default_password: PASSWORD }
    );
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.total, 1, '同一 username 两行只算一行');
    assert.equal(r.data.added, 1);
    assert.equal(r.data.registered, 1);
    assert.deepEqual(r.data.failed, []);
    assert.equal(usernameOf('gi_dup').nickname, '首次昵称', '保留首次出现的那一行');
    assert.equal(memberRows(groupId, 'gi_dup').length, 1);
  });

  it('已在组内的用户再次导入：skipped=1 / added=0，不算失败', async () => {
    const r = await import_([{ username: 'gi_target1' }]);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.total, 1);
    assert.equal(r.data.added, 0, '重复导入不新增成员');
    assert.equal(r.data.registered, 0);
    assert.equal(r.data.skipped, 1, '已在组内计入 skipped');
    assert.deepEqual(r.data.failed, [], '已在组内不是失败');
    assert.equal(memberRows(groupId, 'gi_target1').length, 1, '成员关系不重复');
  });

  it('存在未注册账号却缺 default_password：400 ERR_INVALID_ARGUMENT 且不落库', async () => {
    const r = await import_([{ username: 'gi_target2' }, { username: 'gi_nopw_1' }, { username: 'gi_nopw_2' }]);
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.equal(r.data.code, 1);
    assert.equal(r.data.reason, 'ERR_INVALID_ARGUMENT');
    assert.match(r.data.message, /2 个账号尚未注册/);
    assert.match(r.data.message, /默认密码/);
    assert.equal(usernameOf('gi_nopw_1'), undefined, '整单被拒不应留下任何账号');
    assert.equal(usernameOf('gi_nopw_2'), undefined);
    assert.equal(memberRows(groupId, 'gi_nopw_1').length, 0);
    // 已注册的那一行也不该被部分执行
    assert.equal(memberRows(groupId, 'gi_target2').length, 0, '整单级失败时一行都不执行');
  });

  it('default_password 不满足强度（过短 / 纯字母）：400 且不落库', async () => {
    const short = await import_([{ username: 'gi_weakpw_1' }], { default_password: 'Ab1' });
    assert.equal(short.status, 400, JSON.stringify(short.data));
    assert.equal(short.data.reason, 'ERR_INVALID_ARGUMENT');
    assert.match(short.data.message, /至少 8 位/);

    const letters = await import_([{ username: 'gi_weakpw_2' }], { default_password: 'abcdefghijkl' });
    assert.equal(letters.status, 400);
    assert.equal(letters.data.reason, 'ERR_INVALID_ARGUMENT');
    assert.match(letters.data.message, /至少 8 位/);

    assert.equal(usernameOf('gi_weakpw_1'), undefined);
    assert.equal(usernameOf('gi_weakpw_2'), undefined);
    assert.equal(memberRows(groupId, 'gi_weakpw_1').length, 0);
    // 强度判定复用的是 utils/validation 的 isStrongPassword：字母 + 符号合规
    const ok = await import_([{ username: 'gi_strongpw' }], { default_password: 'abcdefgh' + '@' });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.registered, 1);
  });

  it('users 形状与条数：非数组 / 空数组 / 超 500 行 → 400，恰好 500 行 → 200', async () => {
    const notArray = await api('POST', `/api/v1/groups/${groupId}/import`, suTok, { users: 'gi_target1' });
    assert.equal(notArray.status, 400);
    assert.equal(notArray.data.reason, 'ERR_INVALID_ARGUMENT');

    const empty = await import_([]);
    assert.equal(empty.status, 400);
    assert.equal(empty.data.reason, 'ERR_INVALID_ARGUMENT');

    const over = await import_(Array.from({ length: 501 }, (_, i) => ({ username: `gi_bulk_${i}` })));
    assert.equal(over.status, 400, JSON.stringify(over.data));
    assert.equal(over.data.reason, 'ERR_INVALID_ARGUMENT');
    assert.match(over.data.message, /500/);
    assert.equal(db.prepare("SELECT COUNT(*) as c FROM users WHERE username LIKE 'gi_bulk%'").get().c, 0, '超限整单不建号');

    // 上限边界：500 行全部合法入参路径（用户名非法 → 行级 failed），整单 200 且 total=500
    const atLimit = await import_(Array.from({ length: 500 }, (_, i) => ({ username: `非法 用户 ${i}` })));
    assert.equal(atLimit.status, 200, JSON.stringify(atLimit.data).slice(0, 200));
    assert.equal(atLimit.data.total, 500);
    assert.equal(atLimit.data.added, 0);
    assert.equal(atLimit.data.failed.length, 500);
  });

  it('非法 username（空格 / 中文）行级失败，其余行照常成功（部分成功）', async () => {
    const before = groupsRepo.listGroupMembers(groupId, { limit: 200, offset: 0 }).total;
    const r = await import_(
      [{ username: 'gi_new_3' }, { username: '张 三' }, { username: 'gi_new_4' }, { username: '' }],
      { default_password: PASSWORD }
    );
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.total, 4, '非法行也计入 total（逐行处理，不中断）');
    assert.equal(r.data.added, 2, '合法行照常入组');
    assert.equal(r.data.registered, 2);
    assert.equal(r.data.skipped, 0);
    assert.deepEqual(r.data.failed.map(f => f.username).sort(), ['', '张 三'].sort());
    for (const f of r.data.failed) assert.equal(typeof f.reason, 'string');
    assert.equal(r.data.failed.length, 2);
    assert.match(r.data.failed.find(f => f.username === '张 三').reason, /用户名不合法/);
    assert.equal(usernameOf('gi_new_3') === undefined, false, '合法行仍被创建');
    assert.equal(usernameOf('gi_new_4') === undefined, false);
    assert.equal(usernameOf('张 三'), undefined, '非法用户名不得落库');
    assert.equal(groupsRepo.listGroupMembers(groupId, { limit: 200, offset: 0 }).total, before + 2);
  });

  it('目标组为系统组（all_users / 个人组）→ 403；组不存在 → 404', async () => {
    const allUsersId = groupsRepo.getAllUsersGroup().id;
    const personalId = groupsRepo.getPersonalGroup(suId).id;
    for (const [gid, label] of [[allUsersId, '所有用户组'], [personalId, '个人组']]) {
      const r = await api('POST', `/api/v1/groups/${gid}/import`, suTok, { users: [{ username: 'gi_target2' }], default_password: PASSWORD });
      assert.equal(r.status, 403, `${label} 导入应 403`);
      assert.equal(r.data.code, 6);
      assert.equal(r.data.reason, 'ERR_FORBIDDEN');
      assert.match(r.data.message, /系统组/);
    }
    // 系统组成员关系未被改动（个人组仍只有 owner 本身）
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM user_groups WHERE group_id = ?').get(personalId).c, 1);

    const missing = await api('POST', '/api/v1/groups/99999999/import', suTok, { users: [{ username: 'gi_target2' }] });
    assert.equal(missing.status, 404);
    assert.equal(missing.data.reason, 'ERR_NOT_FOUND');
    const dirty = await api('POST', '/api/v1/groups/not-a-number/import', suTok, { users: [{ username: 'gi_target2' }] });
    assert.equal(dirty.status, 404, '非法 id 与不存在同口径');
  });

  it('鉴权：匿名 401 / admin 403 / 普通 user 403（与 POST /api/v1/users 同一门槛）', async () => {
    const body = { users: [{ username: 'gi_locked' }], default_password: PASSWORD };
    const anon = await api('POST', `/api/v1/groups/${groupId}/import`, undefined, body);
    assert.equal(anon.status, 401);
    assert.equal(anon.data.reason, 'ERR_UNAUTHORIZED');

    for (const [tok, who] of [[adminTok, 'admin'], [userTok, '普通用户']]) {
      const r = await api('POST', `/api/v1/groups/${groupId}/import`, tok, body);
      assert.equal(r.status, 403, `${who} 调用应 403`);
      assert.equal(r.data.code, 6);
      assert.equal(r.data.reason, 'ERR_FORBIDDEN');
    }
    assert.equal(usernameOf('gi_locked'), undefined, '越权调用不得建号');
    assert.equal(memberRows(groupId, 'gi_locked').length, 0);
  });

  it('事务原子性：加入组失败时整行回滚，账号不得被留下', async () => {
    // 注入一次性故障：让首行的 user_groups INSERT 抛错，模拟"建号成功但入组失败"这一最危险的中间态，
    // 同时保留后续行的正常写入，用来验证"单行失败不中断整单"
    const realPrepare = db.prepare;
    let armed = true;
    db.prepare = (sql) => {
      if (armed && typeof sql === 'string' && sql.includes('INSERT OR IGNORE INTO user_groups')) {
        armed = false;
        return { run: () => { throw new Error('injected user_groups insert failure'); } };
      }
      return realPrepare(sql);
    };
    let r;
    try {
      r = await import_([{ username: 'gi_atomic_1' }, { username: 'gi_target2' }], { default_password: PASSWORD });
    } finally {
      db.prepare = realPrepare;
    }
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.total, 2);
    assert.equal(r.data.registered, 0, '失败行不计入 registered');
    assert.equal(r.data.added, 1, '故障行之后的正常行仍应成功（整单不中断）');
    assert.equal(r.data.failed.length, 1);
    assert.equal(r.data.failed[0].username, 'gi_atomic_1');
    assert.match(r.data.failed[0].reason, /injected user_groups insert failure/);
    assert.equal(r.data.failed[0].reason.length <= 201, true, '失败原因被截断为短文本');

    // 关键断言：账号既没被创建，触发器建的组与成员关系也一并回滚
    assert.equal(usernameOf('gi_atomic_1'), undefined, '入组失败时账号必须回滚，不能留下孤儿账号');
    assert.equal(db.prepare("SELECT COUNT(*) as c FROM groups WHERE kind='personal' AND name='gi_atomic_1'").get().c, 0);
    assert.equal(memberRows(groupId, 'gi_atomic_1').length, 0);
    assert.equal(memberRows(groupId, 'gi_target2').length, 1, '同单其它行不受影响');
    // 事务已正常收尾：后续导入照常工作
    const again = await import_([{ username: 'gi_atomic_1' }], { default_password: PASSWORD });
    assert.equal(again.status, 200, JSON.stringify(again.data));
    assert.equal(again.data.registered, 1);
    assert.equal(usernameOf('gi_atomic_1').role, 'user');
  });
});

// ── 仓储层守卫 ──────────────────────────────────────────────
describe('用户组批量导入（仓储层）', () => {
  before(async () => {
    await db.initDB();
    purge();
  });

  after(() => purge());

  it('目标组不存在抛 ERR_NOT_FOUND，系统组抛 ERR_INVALID_STATE', () => {
    assert.throws(
      () => groupsRepo.importMembersIntoGroup({ groupId: 99999999, entries: [{ username: 'gi_repo_1' }] }),
      (e) => e.reason === 'ERR_NOT_FOUND'
    );
    const allUsers = groupsRepo.getAllUsersGroup();
    const personal = groupsRepo.getPersonalGroup(createUser('gi_repo_owner', 'user'));
    for (const gid of [allUsers.id, personal.id]) {
      assert.throws(
        () => groupsRepo.importMembersIntoGroup({ groupId: gid, entries: [{ username: 'gi_repo_1' }] }),
        (e) => e.reason === 'ERR_INVALID_STATE' && e.code === 2
      );
    }
    assert.equal(usernameOf('gi_repo_1'), undefined);
  });

  it('limit 参数截断超量行，缺省参数不抛错', () => {
    const gid = groupsRepo.createGroup({ name: 'gi-仓储组' }).id;
    const entries = Array.from({ length: 5 }, (_, i) => ({ username: `gi_repo_bulk_${i}` }));
    const capped = groupsRepo.importMembersIntoGroup({ groupId: gid, entries, passwordHash: 'h', limit: 2 });
    assert.equal(capped.total, 2, '超过 limit 的行不再处理');
    assert.equal(capped.added, 2);
    assert.equal(capped.registered, 2);
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM users WHERE username LIKE ?').get('gi_repo_bulk%').c, 2);
    assert.deepEqual(groupsRepo.importMembersIntoGroup({ groupId: gid }), { total: 0, added: 0, registered: 0, skipped: 0, failed: [] });
  });
});