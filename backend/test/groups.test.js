// test/groups.test.js —— 用户组 + 实体可见性：内核层（schema/迁移/仓储/工具函数）
// 与路由接入层（routes/groups.js、routes/_visibility.js 及四类实体的门禁/过滤）。
// 内核层只测仓储与工具函数，不起 HTTP；可见性过滤在四类仓储 list 函数上做真实查询断言。
// 路由层用进程内 express + app.listen(0) 起服务（与 exam-program.test.js 同款模式，无 CSRF 中间件，
// 故请求不带 Origin 头），断言 HTTP 状态码与错误体 code/reason。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
require('./_testdb')('groups');
const db = require('../database/db');
const groupsRepo = require('../repositories/groups');
const resourceAccess = require('../repositories/resourceAccess');
const access = require('../utils/access');
const problemsRepo = require('../repositories/problems');
const examsRepo = require('../repositories/exams');
const contestsRepo = require('../repositories/contests');
const problemSetsRepo = require('../repositories/problem-sets');

// 打桩判题入队：必须在 require 路由之前改写（routes/submissions 在加载时就解构了引用），
// 否则成员的成功提交会在本进程内真的拉起沙箱判题，与断言竞争状态。
const judge = require('../services/judge');
judge.enqueueSubmission = () => {};

// 测试库会跨次运行保留（_testdb 只固定路径），前后都清一遍测试数据保证可重复运行
function purge() {
  db.prepare('DELETE FROM resource_group_access').run();
  for (const g of db.prepare("SELECT id FROM groups WHERE kind = 'custom'").all()) {
    db.prepare('DELETE FROM user_groups WHERE group_id = ?').run(g.id);
    db.prepare('DELETE FROM groups WHERE id = ?').run(g.id);
  }
  db.prepare("DELETE FROM problems WHERE title LIKE 'gp-%'").run();
  db.prepare("DELETE FROM contests WHERE title LIKE 'gp-%'").run();
  db.prepare("DELETE FROM exams WHERE title LIKE 'gp-%'").run();
  db.prepare('DELETE FROM problem_set_items WHERE set_id IN (SELECT id FROM problem_sets WHERE title LIKE ?)', 'gp-%').run();
  db.prepare("DELETE FROM problem_sets WHERE title LIKE 'gp-%'").run();
  for (const u of db.prepare("SELECT id FROM users WHERE username LIKE 'gp%'").all()) {
    db.prepare('DELETE FROM user_groups WHERE user_id = ?').run(u.id);
    db.prepare("DELETE FROM groups WHERE kind = 'personal' AND owner_id = ?").run(u.id);
  }
  db.prepare("DELETE FROM users WHERE username LIKE 'gp%'").run();
}

function createUser(username, role) {
  return db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES (?, 'h', ?, ?)")
    .run(username, username, role).lastInsertRowid;
}

const isInvalidState = (e) => e.reason === 'ERR_INVALID_STATE' && e.code === 2;

describe('用户组与实体可见性（内核层）', () => {
  let memberId;
  let outsiderId;
  let teacherId;
  let adminId;
  let member;
  let outsider;
  let teacher;
  let admin;
  let customGroupId;
  let otherGroupId;
  let pubProblemId;
  let grpProblemId;
  let pubContestId;
  let grpContestId;
  let pubExamId;
  let grpExamId;
  let pubSetId;
  let grpSetId;

  before(async () => {
    await db.initDB();
    purge();

    memberId = createUser('gp_member', 'user');
    outsiderId = createUser('gp_outsider', 'user');
    teacherId = createUser('gp_teacher', 'teacher');
    adminId = createUser('gp_admin', 'admin');
    member = { id: memberId, role: 'user' };
    outsider = { id: outsiderId, role: 'user' };
    teacher = { id: teacherId, role: 'teacher' };
    admin = { id: adminId, role: 'admin' };

    customGroupId = groupsRepo.createGroup({ name: 'gp_集训队', description: '仅测试', kind: 'custom', owner_id: adminId }).id;
    otherGroupId = groupsRepo.createGroup({ name: 'gp_对照组', description: '', kind: 'custom', owner_id: adminId }).id;
    groupsRepo.addMember(customGroupId, memberId);

    pubProblemId = db.prepare("INSERT INTO problems (title, created_by) VALUES ('gp-公开题', ?)").run(adminId).lastInsertRowid;
    grpProblemId = db.prepare("INSERT INTO problems (title, visibility, created_by) VALUES ('gp-组内题', 'groups', ?)").run(adminId).lastInsertRowid;
    pubContestId = db.prepare("INSERT INTO contests (title, start_time, end_time, created_by) VALUES ('gp-公开赛', '2020-01-01 00:00:00', '2030-01-01 00:00:00', ?)").run(adminId).lastInsertRowid;
    grpContestId = db.prepare("INSERT INTO contests (title, start_time, end_time, visibility, created_by) VALUES ('gp-组内赛', '2020-01-01 00:00:00', '2030-01-01 00:00:00', 'groups', ?)").run(adminId).lastInsertRowid;
    pubExamId = db.prepare('INSERT INTO exams (title, creator_id) VALUES (?, ?)').run('gp-公开卷', adminId).lastInsertRowid;
    grpExamId = db.prepare("INSERT INTO exams (title, visibility, creator_id) VALUES ('gp-组内卷', 'groups', ?)").run(adminId).lastInsertRowid;
    pubSetId = db.prepare('INSERT INTO problem_sets (title, creator_id) VALUES (?, ?)').run('gp-公开题单', adminId).lastInsertRowid;
    grpSetId = db.prepare("INSERT INTO problem_sets (title, visibility, creator_id) VALUES ('gp-组内题单', 'groups', ?)").run(adminId).lastInsertRowid;

    // 组内实体统一绑定到 customGroupId
    resourceAccess.setResourceGroups('problem', grpProblemId, [customGroupId]);
    resourceAccess.setResourceGroups('contest', grpContestId, [customGroupId]);
    resourceAccess.setResourceGroups('exam', grpExamId, [customGroupId]);
    resourceAccess.setResourceGroups('problem_set', grpSetId, [customGroupId]);
  });

  after(() => {
    purge();
  });

  it('schema：存量实体默认 visibility=public，CHECK 约束生效', () => {
    assert.equal(problemsRepo.getProblemById(pubProblemId).visibility, 'public');
    assert.equal(db.prepare('SELECT visibility FROM contests WHERE id = ?').get(grpContestId).visibility, 'groups');
    assert.equal(db.prepare('SELECT visibility FROM exams WHERE id = ?').get(pubExamId).visibility, 'public');
    assert.equal(db.prepare('SELECT visibility FROM problem_sets WHERE id = ?').get(grpSetId).visibility, 'groups');
    assert.throws(() => db.prepare("UPDATE problems SET visibility = 'nope' WHERE id = ?").run(pubProblemId));
    assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_users_default_groups'").get().sql.includes('users'), true);
  });

  it('触发器：INSERT users 后自动入个人组 + 所有用户组，个人组名=username', () => {
    const uid = createUser('gp_trigger_probe', 'user');
    const mine = groupsRepo.listUserGroups(uid);
    assert.equal(mine.length, 2, '新用户应恰好自动入 2 个组');
    const personal = mine.find(g => g.kind === 'personal');
    const all = mine.find(g => g.kind === 'all_users');
    assert.ok(personal, '缺少个人组');
    assert.ok(all, '缺少所有用户组');
    assert.equal(personal.name, 'gp_trigger_probe');
    assert.equal(personal.owner_id, uid);
    assert.equal(all.owner_id, null);
    // 直接 INSERT users 也走触发器（不是注册接口专属路径）
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM user_groups WHERE user_id = ?').get(uid).c, 2);
  });

  it('触发器：users.id 被复用时不因个人组唯一索引冲突而失败，且组名跟随新用户名', () => {
    const uid = createUser('gp_reuse_old', 'user');
    const personalId = groupsRepo.listUserGroups(uid).find(g => g.kind === 'personal').id;
    // users.id 非 AUTOINCREMENT：删号后重建会取回同一个 id
    db.prepare('DELETE FROM user_groups WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM groups WHERE id = ?').run(personalId);
    db.prepare('DELETE FROM users WHERE id = ?').run(uid);
    const reused = db.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, 'gp_reuse_new', 'h')").run(uid).lastInsertRowid;
    assert.equal(reused, uid);
    const personal = db.prepare('SELECT * FROM groups WHERE kind = ? AND owner_id = ?').get('personal', uid);
    assert.equal(personal.name, 'gp_reuse_new', '个人组名应同步为新用户名');
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM user_groups WHERE user_id = ?').get(uid).c, 2);
  });

  it('回填幂等：ensureDefaultMembership 重复调用不产生重复组/成员', () => {
    const uid = createUser('gp_idempotent_probe', 'user');
    const groupsBefore = groupsRepo.countGroups();
    const personalBefore = db.prepare("SELECT COUNT(*) as c FROM groups WHERE kind='personal' AND owner_id = ?").get(uid).c;
    for (let i = 0; i < 3; i++) groupsRepo.ensureDefaultMembership(uid);
    assert.equal(groupsRepo.countGroups(), groupsBefore, '重复调用不应新建组');
    assert.equal(db.prepare("SELECT COUNT(*) as c FROM groups WHERE kind='personal' AND owner_id = ?").get(uid).c, personalBefore);
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM user_groups WHERE user_id = ?').get(uid).c, 2);
    // 幂等入口同时兼容"直接给 id"的调用方式（用户名回查 users 表）
    const { personal, all } = groupsRepo.ensureDefaultMembership(memberId);
    assert.equal(personal.kind, 'personal');
    assert.equal(all.kind, 'all_users');
    assert.equal(groupsRepo.ensureAllUsersGroup().id, groupsRepo.getAllUsersGroup().id);
  });

  it('组仓储：create/list/get/count/listUserGroups/listGroupMembers', () => {
    const created = groupsRepo.createGroup({ name: 'gp_改名测试', description: 'd', owner_id: adminId });
    assert.equal(created.kind, 'custom');
    assert.equal(groupsRepo.getGroup(created.id).name, 'gp_改名测试');
    assert.equal(groupsRepo.updateGroup(created.id, { name: 'gp_改名后', description: 'd2' }).name, 'gp_改名后');
    assert.ok(groupsRepo.countGroups() >= 4);

    const all = groupsRepo.listGroups();
    const target = all.find(g => g.id === customGroupId);
    assert.equal(target.member_count, 1);
    assert.equal(target.resource_count, 4, '四类实体各绑定 1 条 → 4 个可见实体');
    assert.equal(target.owner_name, 'gp_admin');

    const mine = groupsRepo.listUserGroups(memberId).map(g => g.id);
    assert.ok(mine.includes(customGroupId));
    assert.ok(mine.includes(all.find(g => g.kind === 'personal' && g.owner_id === memberId).id));

    const members = groupsRepo.listGroupMembers(customGroupId, { limit: 10, offset: 0 });
    assert.equal(members.total, 1, '成员分页带总数');
    assert.equal(members.members.length, 1);
    assert.equal(members.members[0].username, 'gp_member');
    const page2 = groupsRepo.listGroupMembers(customGroupId, { limit: 10, offset: 1 });
    assert.equal(page2.total, 1, '总数不受 offset 影响');
    assert.equal(page2.members.length, 0);
  });

  it('canViewResource 矩阵：public 全体可见 / groups 仅成员与 staff 可见 / 匿名不可见', () => {
    for (const type of ['problem', 'contest', 'exam', 'problem_set']) {
      const pubId = { problem: pubProblemId, contest: pubContestId, exam: pubExamId, problem_set: pubSetId }[type];
      const grpId = { problem: grpProblemId, contest: grpContestId, exam: grpExamId, problem_set: grpSetId }[type];

      assert.equal(access.canViewResource(null, type, pubId), true, `${type} public 对游客可见`);
      assert.equal(access.canViewResource(member, type, pubId), true);
      assert.equal(access.canViewResource(teacher, type, pubId), true);

      assert.equal(access.canViewResource(null, type, grpId), false, `${type} groups 对匿名不可见`);
      assert.equal(access.canViewResource(member, type, grpId), true, `${type} groups 对成员可见`);
      assert.equal(access.canViewResource(outsider, type, grpId), false, `${type} groups 对非成员不可见`);
      assert.equal(access.canViewResource(teacher, type, grpId), true, `${type} groups 对 teacher 可见`);
      assert.equal(access.canViewResource(admin, type, grpId), true, `${type} groups 对 admin 可见`);

      assert.equal(access.canViewResource(member, type, 99999999), false, `${type} 实体不存在视为不可见`);
    }
    assert.throws(() => access.canViewResource(member, 'article', 1), /未知的资源类型/);
  });

  it('visibilitySqlCondition 在 problems 仓储 listProblems 上真实可用', () => {
    const base = { isManager: false, limit: 100, offset: 0 };
    const idsOf = (res) => res.problems.map(p => p.id);

    const asMember = problemsRepo.listProblems({ ...base, visibilityFilter: access.visibilitySqlCondition('problem', 'p', { userId: memberId }) });
    assert.ok(idsOf(asMember).includes(pubProblemId));
    assert.ok(idsOf(asMember).includes(grpProblemId), '组内成员能看到组内题');
    assert.equal(asMember.total, idsOf(asMember).length, 'total 与列表口径一致');

    const asOutsider = problemsRepo.listProblems({ ...base, visibilityFilter: access.visibilitySqlCondition('problem', 'p', { userId: outsiderId }) });
    assert.ok(idsOf(asOutsider).includes(pubProblemId));
    assert.ok(!idsOf(asOutsider).includes(grpProblemId), '非成员看不到组内题');

    const asAnon = problemsRepo.listProblems({ ...base, visibilityFilter: access.visibilitySqlCondition('problem', 'p', { userId: null }) });
    assert.deepEqual(idsOf(asAnon), [pubProblemId], '匿名只看到 public');

    const asStaff = problemsRepo.listProblems({ ...base, visibilityFilter: access.visibilitySqlCondition('problem', 'p', { userId: teacherId, staff: true }) });
    assert.equal(asStaff.visibilityFilter, undefined);
    assert.equal(idsOf(asStaff).length, 2, 'staff 条件为空 → 不过滤');
  });

  it('visibilitySqlCondition 在 exams 仓储 listExams 上真实可用', () => {
    const base = { isStaff: false, limit: 100, offset: 0 };
    const idsOf = (res) => res.exams.map(e => e.id);

    const asMember = examsRepo.listExams({ ...base, visibilityFilter: access.visibilitySqlCondition('exam', 'e', { userId: memberId }) });
    assert.ok(idsOf(asMember).includes(pubExamId));
    assert.ok(idsOf(asMember).includes(grpExamId));

    const asOutsider = examsRepo.listExams({ ...base, visibilityFilter: access.visibilitySqlCondition('exam', 'e', { userId: outsiderId }) });
    assert.ok(!idsOf(asOutsider).includes(grpExamId));
    assert.equal(asOutsider.total, 1);

    const asStaff = examsRepo.listExams({ ...base, visibilityFilter: access.visibilitySqlCondition('exam', 'e', { userId: teacherId, staff: true }) });
    assert.equal(idsOf(asStaff).length, 2);
  });

  it('visibilitySqlCondition 在 contests / problem_sets 仓储 list 上真实可用', () => {
    // contests.list/countList 模板里没有写死 WHERE，where 需自带 WHERE 前缀；
    // problem_sets.list/countList 模板里已写死 WHERE，where 只给条件片段（既有 API 差异）
    const cWhere = access.visibilitySqlCondition('contest', 'c', { userId: memberId });
    const cRows = contestsRepo.list(`WHERE 1=1 AND (${cWhere.sql})`, cWhere.params, 100, 0);
    assert.deepEqual(cRows.map(c => c.id).sort((a, b) => a - b), [pubContestId, grpContestId].sort((a, b) => a - b));
    assert.equal(contestsRepo.countList(`WHERE 1=1 AND (${cWhere.sql})`, cWhere.params), 2);

    const cOut = access.visibilitySqlCondition('contest', 'c', { userId: outsiderId });
    assert.deepEqual(contestsRepo.list(`WHERE 1=1 AND (${cOut.sql})`, cOut.params, 100, 0).map(c => c.id), [pubContestId]);
    const cStaff = access.visibilitySqlCondition('contest', 'c', { userId: teacherId, staff: true });
    assert.equal(cStaff.sql, '');
    assert.equal(contestsRepo.list('WHERE 1=1', cStaff.params, 100, 0).length, 2);

    const pWhere = access.visibilitySqlCondition('problem_set', 'ps', { userId: memberId });
    const pRows = problemSetsRepo.list(`1=1 AND (${pWhere.sql})`, pWhere.params, 100, 0);
    assert.deepEqual(pRows.map(p => p.id).sort((a, b) => a - b), [pubSetId, grpSetId].sort((a, b) => a - b));
    assert.equal(problemSetsRepo.countList(`1=1 AND (${pWhere.sql})`, pWhere.params), 2);

    const pOut = access.visibilitySqlCondition('problem_set', 'ps', { userId: outsiderId });
    assert.deepEqual(problemSetsRepo.list(`1=1 AND (${pOut.sql})`, pOut.params, 100, 0).map(p => p.id), [pubSetId]);
  });

  it('filterViewableIds 兜底筛选 + canManageVisibility + viewTypeOf', () => {
    const ids = [pubProblemId, grpProblemId];
    assert.deepEqual(access.filterViewableIds('problem', ids, member), ids);
    assert.deepEqual(access.filterViewableIds('problem', ids, outsider), [pubProblemId]);
    assert.deepEqual(access.filterViewableIds('problem', ids, null), [pubProblemId]);
    assert.deepEqual(access.filterViewableIds('problem', ids, teacher), ids);
    assert.deepEqual(access.filterViewableIds('problem', [], member), []);
    assert.deepEqual(access.filterViewableIds('problem', [99999999], member), [], '实体不存在被剔除');

    assert.equal(access.canManageVisibility(admin), true);
    assert.equal(access.canManageVisibility({ role: 'su' }), true);
    assert.equal(access.canManageVisibility(teacher), false);
    assert.equal(access.canManageVisibility(member), false);
    assert.equal(access.canManageVisibility(null), false);

    assert.equal(access.viewTypeOf('problems'), 'problem');
    assert.equal(access.viewTypeOf('PROBLEM'), 'problem');
    assert.equal(access.viewTypeOf('problem_sets'), 'problem_set');
    assert.equal(access.viewTypeOf('exams'), 'exam');
    assert.equal(access.viewTypeOf('contests'), 'contest');
    assert.equal(access.viewTypeOf('articles'), null);
    assert.equal(access.tableForType('exam'), 'exams');
    assert.deepEqual(access.RESOURCE_TYPES, ['problem', 'contest', 'exam', 'problem_set']);
    assert.deepEqual(access.RESOURCE_TYPES, resourceAccess.RESOURCE_TYPES, '资源类型单点定义，勿两处漂移');
    assert.equal(resourceAccess.RESOURCE_TABLES.problem_set, 'problem_sets');
  });

  it('系统组保护：改名 / 删除 / 移出成员全部抛 ERR_INVALID_STATE', () => {
    const all = groupsRepo.getAllUsersGroup();
    const personal = db.prepare("SELECT * FROM groups WHERE kind='personal' AND owner_id = ?").get(memberId);

    assert.equal(groupsRepo.isSystemGroup('personal'), true);
    assert.equal(groupsRepo.isSystemGroup('all_users'), true);
    assert.equal(groupsRepo.isSystemGroup('custom'), false);

    assert.throws(() => groupsRepo.updateGroup(all.id, { name: '改名' }), isInvalidState);
    assert.throws(() => groupsRepo.updateGroup(personal.id, { name: '改名' }), isInvalidState);
    assert.throws(() => groupsRepo.deleteGroup(all.id), isInvalidState);
    assert.throws(() => groupsRepo.deleteGroup(personal.id), isInvalidState);
    assert.throws(() => groupsRepo.removeMember(all.id, memberId), isInvalidState);
    assert.throws(() => groupsRepo.removeMember(personal.id, memberId), isInvalidState);
    assert.equal(groupsRepo.getAllUsersGroup().name, '所有用户');
    assert.equal(groupsRepo.getGroup(personal.id).name, 'gp_member', '系统组名未被改动');

    // 个人组只允许 owner 本人加入；owner 重复加入为幂等 no-op
    assert.throws(() => groupsRepo.addMember(personal.id, outsiderId), isInvalidState);
    assert.equal(groupsRepo.addMember(personal.id, memberId), 0);
    assert.equal(groupsRepo.addMember(personal.id, memberId), 0);
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM user_groups WHERE group_id = ?').get(personal.id).c, 1);

    assert.throws(() => groupsRepo.deleteGroup(99999999), (e) => e.reason === 'ERR_NOT_FOUND');
  });

  it('自定义组成员可增删，删除组时一并清理成员与实体绑定', () => {
    const g = groupsRepo.createGroup({ name: 'gp_待删组', owner_id: adminId }).id;
    groupsRepo.addMember(g, outsiderId);
    resourceAccess.setResourceGroups('problem', pubProblemId, [g]);
    const refs = resourceAccess.deleteGroupResourceRefs(g);
    assert.deepEqual(refs, [{ type: 'problem', id: pubProblemId }], '删组返回受影响的实体清单');
    assert.deepEqual(resourceAccess.getResourceGroups('problem', pubProblemId), []);

    resourceAccess.setResourceGroups('problem', pubProblemId, [g]);
    groupsRepo.addMember(g, outsiderId);
    assert.equal(groupsRepo.addMember(g, outsiderId), 0, '重复加入幂等');
    assert.equal(groupsRepo.removeMember(g, outsiderId), 1);
    assert.equal(groupsRepo.removeMember(g, outsiderId), 0);

    assert.equal(groupsRepo.deleteGroup(g), 1);
    assert.equal(groupsRepo.getGroup(g), undefined);
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM resource_group_access WHERE group_id = ?').get(g).c, 0);
    assert.deepEqual(resourceAccess.getResourceGroups('problem', pubProblemId), []);
  });

  it('setResourceGroups 整体替换 / 去重 / 忽略不存在的组，listResourceGroupIds 批量读取', () => {
    const first = resourceAccess.setResourceGroups('problem', pubProblemId, [customGroupId, otherGroupId]);
    assert.deepEqual(first.map(g => g.id), [customGroupId, otherGroupId]);
    assert.equal(first[0].name, 'gp_集训队');

    const replaced = resourceAccess.setResourceGroups('problem', pubProblemId, [otherGroupId]);
    assert.deepEqual(replaced.map(g => g.id), [otherGroupId], '整体替换：旧绑定应被清除');

    const dedup = resourceAccess.setResourceGroups('problem', pubProblemId, [customGroupId, customGroupId, otherGroupId, 99999999]);
    assert.deepEqual(dedup.map(g => g.id), [customGroupId, otherGroupId], '去重且忽略不存在的组');

    const rows = resourceAccess.listResourceGroupIds('problem', [pubProblemId, grpProblemId]);
    assert.equal(rows.length, 3, '两题共 3 条绑定');
    assert.deepEqual(rows.filter(r => r.resource_id === grpProblemId).map(r => r.group_id), [customGroupId]);
    assert.deepEqual(resourceAccess.listResourceGroupIds('problem', []), []);
    assert.deepEqual(
      resourceAccess.listResourceGroupIds('problem', pubProblemId).map(r => ({ resource_id: r.resource_id, group_id: r.group_id })),
      dedup.map(g => ({ resource_id: pubProblemId, group_id: g.id }))
    );

    assert.deepEqual(resourceAccess.setResourceGroups('problem', pubProblemId, []), []);
    assert.deepEqual(resourceAccess.listResourceGroupIds('problem', [pubProblemId]), []);
    assert.throws(() => resourceAccess.setResourceGroups('article', 1, []), /未知的资源类型/);

    // 恢复绑定，保证后续 canViewResource 断言仍成立
    resourceAccess.setResourceGroups('problem', pubProblemId, [customGroupId]);
  });

  it('触发器（另一种创建顺序）：全体组晚于用户创建时先只入个人组，ensureDefaultMembership 幂等补齐第 2 条', () => {
    // 模拟"全体组尚未存在"：先建用户、后补全体组（initDB 建初始 admin 时就是这个顺序）
    const allUsers = groupsRepo.getAllUsersGroup();
    const priorMembers = db.prepare('SELECT user_id FROM user_groups WHERE group_id = ?').all(allUsers.id).map(r => r.user_id);
    db.prepare('DELETE FROM user_groups WHERE group_id = ?').run(allUsers.id);
    db.prepare('DELETE FROM groups WHERE id = ?').run(allUsers.id);
    assert.equal(groupsRepo.getAllUsersGroup(), undefined, '全体组已移除');

    const uid = createUser('gp_order_probe', 'user');
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM user_groups WHERE user_id = ?').get(uid).c, 1, '全体组不存在时只入个人组');
    assert.equal(groupsRepo.listUserGroups(uid).filter(g => g.kind === 'personal').length, 1);

    // 幂等补齐入口建全体组 + 补第 2 条成员关系（spec 的顺序敏感兜底方案）
    const { personal, all } = groupsRepo.ensureDefaultMembership(uid);
    assert.equal(personal.name, 'gp_order_probe');
    assert.equal(all.name, '所有用户');
    assert.equal(all.owner_id, null);
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM user_groups WHERE user_id = ?').get(uid).c, 2);
    groupsRepo.ensureDefaultMembership(uid);
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM user_groups WHERE user_id = ?').get(uid).c, 2, '重复补齐幂等');

    // 全体组补建后，后续新注册用户由触发器一次拿满 2 个 membership
    const uid2 = createUser('gp_order_probe2', 'user');
    assert.equal(groupsRepo.listUserGroups(uid2).length, 2);

    // 复原既有用户的全体组成员关系，保持共享测试库一致
    const newAllId = groupsRepo.getAllUsersGroup().id;
    for (const old of priorMembers) {
      if (old === uid || old === uid2) continue;
      db.prepare("INSERT OR IGNORE INTO user_groups (user_id, group_id, joined_at) VALUES (?, ?, datetime('now'))").run(old, newAllId);
    }
  });
});

// ── 路由接入层 ──────────────────────────────────────────────
describe('用户组与实体可见性（路由接入层）', () => {
  let server;
  let base;
  let adminTok, memberTok, outsiderTok, teacherTok;
  let adminId, memberId, outsiderId;
  let groupId;
  let pubProblemId, grpProblemId;
  let memberSubId;
  let pubContestId, grpContestId;
  let pubExamId, grpExamId;
  let pubSetId, grpSetId;

  // 进程内 api() 助手：与 exam-program.test.js 同款（该模式无 CSRF 中间件，不带 Origin 头）
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

  before(async () => {
    await db.initDB();
    purge();

    const express = require('express');
    const { generateAccessToken } = require('../utils/tokens');
    const groupsRoutes = require('../routes/groups');
    const problemRoutes = require('../routes/problems');
    const contestRoutes = require('../routes/contests');
    const examRoutes = require('../routes/exams');
    const problemSetRoutes = require('../routes/problem-sets');
    const submissionRoutes = require('../routes/submissions');
    const tagRoutes = require('../routes/tags');
    const favoriteRoutes = require('../routes/favorites');
    const statisticRoutes = require('../routes/statistics');

    adminId = createUser('gpr_admin', 'admin');
    memberId = createUser('gpr_member', 'user');
    outsiderId = createUser('gpr_outsider', 'user');
    const teacherId = createUser('gpr_teacher', 'teacher');
    adminTok = generateAccessToken(adminId);
    memberTok = generateAccessToken(memberId);
    outsiderTok = generateAccessToken(outsiderId);
    teacherTok = generateAccessToken(teacherId);

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/v1/groups', groupsRoutes);
    app.use('/api/v1/problems', problemRoutes);
    app.use('/api/v1/contests', contestRoutes);
    app.use('/api/v1/exams', examRoutes);
    app.use('/api/v1/problem-sets', problemSetRoutes);
    app.use('/api/v1/submissions', submissionRoutes);
    app.use('/api/v1/tags', tagRoutes);
    app.use('/api/v1/favorites', favoriteRoutes);
    app.use('/api/v1/statistics', statisticRoutes);
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;

    // 实体：每类各一公开 + 一组内，且 is_public/is_hidden 均保持公开可读，
    // 这样 403 只可能来自用户组可见性，不会被既有 is_public/is_hidden 语义掩盖
    pubProblemId = db.prepare("INSERT INTO problems (title, created_by) VALUES ('gp-路由公开题', ?)").run(adminId).lastInsertRowid;
    grpProblemId = db.prepare("INSERT INTO problems (title, created_by) VALUES ('gp-路由组内题', ?)").run(adminId).lastInsertRowid;
    pubContestId = db.prepare("INSERT INTO contests (title, start_time, end_time, created_by) VALUES ('gp-路由公开赛', '2020-01-01 00:00:00', '2030-01-01 00:00:00', ?)").run(adminId).lastInsertRowid;
    grpContestId = db.prepare("INSERT INTO contests (title, start_time, end_time, created_by) VALUES ('gp-路由组内赛', '2020-01-01 00:00:00', '2030-01-01 00:00:00', ?)").run(adminId).lastInsertRowid;
    pubExamId = db.prepare('INSERT INTO exams (title, creator_id) VALUES (?, ?)').run('gp-路由公开卷', adminId).lastInsertRowid;
    grpExamId = db.prepare('INSERT INTO exams (title, creator_id) VALUES (?, ?)').run('gp-路由组内卷', adminId).lastInsertRowid;
    pubSetId = db.prepare('INSERT INTO problem_sets (title, creator_id) VALUES (?, ?)').run('gp-路由公开题单', adminId).lastInsertRowid;
    grpSetId = db.prepare('INSERT INTO problem_sets (title, creator_id) VALUES (?, ?)').run('gp-路由组内题单', adminId).lastInsertRowid;
    db.prepare('INSERT INTO problem_set_items (set_id, problem_id, sort_order) VALUES (?, ?, 0)').run(pubSetId, grpProblemId);

    // 组内实体统一绑定到"路由组内题"所在的自定义组
    const created = await api('POST', '/api/v1/groups', adminTok, { name: 'gp-路由集训组', description: '路由测试' });
    groupId = created.data.group.id;
    await api('POST', `/api/v1/groups/${groupId}/members`, adminTok, { user_id: memberId });
    for (const [type, id] of [['problems', grpProblemId], ['contests', grpContestId], ['exams', grpExamId], ['problem-sets', grpSetId]]) {
      const r = await api('PUT', `/api/v1/${type}/${id}/visibility`, adminTok, { visibility: 'groups', group_ids: [groupId] });
      assert.equal(r.status, 200, `绑定 ${type} 可见性失败: ${JSON.stringify(r.data)}`);
    }
  });

  after(() => {
    try {
      if (server) server.close();
      purge();
    } catch {
      // 清理失败不掩盖用例断言（after 阶段已无返回值可断言）
    }
  });

  it('路由：建组鉴权（admin 成功 / user 403 / teacher 403），管理员可查全部组', async () => {
    const created = await api('POST', '/api/v1/groups', adminTok, { name: 'gp-路由新建组', description: 'd' });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.group.kind, 'custom');
    assert.equal(created.data.group.name, 'gp-路由新建组');
    assert.equal(created.data.group.owner_id, adminId);
    assert.equal(created.data.group.member_count, 0);
    assert.equal(created.data.group.resource_count, 0);
    // 缺 name → 400
    const bad = await api('POST', '/api/v1/groups', adminTok, { description: 'no name' });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.reason, 'ERR_INVALID_ARGUMENT');

    for (const [tok, who] of [[memberTok, '普通用户'], [teacherTok, '教师']]) {
      const r = await api('POST', '/api/v1/groups', tok, { name: 'gp-越权组' });
      assert.equal(r.status, 403, `${who}建组应 403`);
      assert.equal(r.data.reason, 'ERR_FORBIDDEN');
      const list = await api('GET', '/api/v1/groups', tok);
      assert.equal(list.status, 403, `${who}查全部组应 403`);
    }
    // 匿名：401；su/admin：200 且含系统组与统计字段
    assert.equal((await api('GET', '/api/v1/groups')).status, 401);
    const list = await api('GET', '/api/v1/groups', adminTok);
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.data.groups));
    assert.ok(list.data.groups.some(g => g.kind === 'all_users'), '管理台列表应含系统组');
    const row = list.data.groups.find(g => g.id === groupId);
    assert.equal(row.member_count, 1);
    assert.equal(row.resource_count, 4, '四类实体各绑定 1 条');
  });

  it('路由：改名与成员管理（系统组 403 / 个人组仅 owner / 分页校验）', async () => {
    const allUsersId = groupsRepo.getAllUsersGroup().id;
    const personalId = groupsRepo.getPersonalGroup(memberId).id;

    // 改名 / 删除系统组：403
    for (const gid of [allUsersId, personalId]) {
      const put = await api('PUT', `/api/v1/groups/${gid}`, adminTok, { name: 'gp-改名' });
      assert.equal(put.status, 403);
      assert.equal(put.data.reason, 'ERR_FORBIDDEN');
      const del = await api('DELETE', `/api/v1/groups/${gid}`, adminTok);
      assert.equal(del.status, 403);
      assert.equal(del.data.reason, 'ERR_FORBIDDEN');
      assert.equal(groupsRepo.getGroup(gid).name !== 'gp-改名', true, '系统组名未被改动');
    }

    // 系统组成员关系：加/移一律 403（由触发器与回填维护）
    const addAll = await api('POST', `/api/v1/groups/${allUsersId}/members`, adminTok, { user_id: outsiderId });
    assert.equal(addAll.status, 403);
    const delAll = await api('DELETE', `/api/v1/groups/${allUsersId}/members/${outsiderId}`, adminTok);
    assert.equal(delAll.status, 403);
    assert.equal(delAll.data.reason, 'ERR_FORBIDDEN');

    // 个人组：仅 owner 可加成员；他人加入 400 ERR_INVALID_STATE
    const other = await api('POST', `/api/v1/groups/${personalId}/members`, adminTok, { user_id: outsiderId });
    assert.equal(other.status, 400);
    assert.equal(other.data.reason, 'ERR_INVALID_STATE');
    const owner = await api('POST', `/api/v1/groups/${personalId}/members`, adminTok, { user_id: memberId });
    assert.equal(owner.status, 200);
    assert.equal(owner.data.message, 'Member added.');

    // 自定义组改名 + 移出成员 + 成员分页
    const renamed = await api('PUT', `/api/v1/groups/${groupId}`, adminTok, { name: 'gp-路由集训组2', description: 'd2' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.data.group.name, 'gp-路由集训组2');
    assert.equal(renamed.data.group.description, 'd2');

    const members = await api('GET', `/api/v1/groups/${groupId}/members?page=1&limit=10`, adminTok);
    assert.equal(members.status, 200);
    assert.equal(members.data.total, 1);
    assert.deepEqual(Object.keys(members.data.members[0]).sort(), ['id', 'nickname', 'role', 'username']);
    assert.equal(members.data.members[0].username, 'gpr_member');
    // 非法分页：page=0 / limit=abc → 400
    assert.equal((await api('GET', `/api/v1/groups/${groupId}/members?page=0`, adminTok)).status, 400);
    assert.equal((await api('GET', `/api/v1/groups/${groupId}/members?limit=abc`, adminTok)).status, 400);
    assert.equal((await api('GET', '/api/v1/groups/99999999/members', adminTok)).status, 404);
  });

  it('路由：GET /groups/mine 返回本人全体组 + 个人组 + 自定义组', async () => {
    const mine = await api('GET', '/api/v1/groups/mine', memberTok);
    assert.equal(mine.status, 200);
    assert.ok(Array.isArray(mine.data.groups));
    const ids = mine.data.groups.map(g => g.id);
    assert.ok(ids.includes(groupsRepo.getAllUsersGroup().id), '应含所有用户组');
    assert.ok(ids.includes(groupsRepo.getPersonalGroup(memberId).id), '应含个人组');
    assert.ok(ids.includes(groupId), '应含加入的自定义组');
    assert.deepEqual(Object.keys(mine.data.groups[0]).sort(), ['description', 'id', 'kind', 'name']);

    const adminMine = await api('GET', '/api/v1/groups/mine', adminTok);
    assert.ok(adminMine.data.groups.some(g => g.kind === 'all_users'));
    assert.equal((await api('GET', '/api/v1/groups/mine')).status, 401, '匿名 401');

    const outsider = await api('GET', '/api/v1/groups/mine', outsiderTok);
    assert.equal(outsider.status, 200, '任意登录用户都能查自己的组');
    assert.equal(outsider.data.groups.some(g => g.id === groupId), false, '非成员看不到别人的组');
  });

  it('路由：可见性写入口鉴权与参数校验（teacher 403 / 200 / 空组 400 / 不存在组 400）', async () => {
    // 读：任意登录用户可读
    assert.equal((await api('GET', `/api/v1/problems/${grpProblemId}/visibility`)).status, 401, '匿名读 401');
    const read = await api('GET', `/api/v1/problems/${grpProblemId}/visibility`, memberTok);
    assert.equal(read.status, 200);
    assert.equal(read.data.visibility, 'groups');
    assert.equal(read.data.groups.length, 1);
    assert.deepEqual(Object.keys(read.data.groups[0]).sort(), ['id', 'kind', 'name']);

    // 写：仅 admin/su
    const teacherPut = await api('PUT', `/api/v1/problems/${grpProblemId}/visibility`, teacherTok, { visibility: 'public', group_ids: [] });
    assert.equal(teacherPut.status, 403);
    assert.equal(teacherPut.data.reason, 'ERR_FORBIDDEN');
    const userPut = await api('PUT', `/api/v1/problems/${grpProblemId}/visibility`, memberTok, { visibility: 'public', group_ids: [] });
    assert.equal(userPut.status, 403);
    assert.equal(db.prepare('SELECT visibility FROM problems WHERE id = ?').get(grpProblemId).visibility, 'groups', '越权写入不应落库');

    // 参数校验：枚举 / 空 group_ids / 不存在的组 / 非法 id
    const badEnum = await api('PUT', `/api/v1/problems/${grpProblemId}/visibility`, adminTok, { visibility: 'nope' });
    assert.equal(badEnum.status, 400);
    assert.equal(badEnum.data.reason, 'ERR_INVALID_ARGUMENT');
    const empty = await api('PUT', `/api/v1/problems/${grpProblemId}/visibility`, adminTok, { visibility: 'groups', group_ids: [] });
    assert.equal(empty.status, 400);
    assert.equal(empty.data.reason, 'ERR_INVALID_ARGUMENT');
    const missing = await api('PUT', `/api/v1/problems/${grpProblemId}/visibility`, adminTok, { visibility: 'groups', group_ids: [99999999] });
    assert.equal(missing.status, 400);
    assert.equal(missing.data.reason, 'ERR_INVALID_ARGUMENT');

    // 正常写入：public 会清空绑定，groups 会落绑定
    const toPublic = await api('PUT', `/api/v1/problems/${grpProblemId}/visibility`, adminTok, { visibility: 'public' });
    assert.equal(toPublic.status, 200);
    assert.equal(toPublic.data.visibility, 'public');
    assert.deepEqual(toPublic.data.groups, []);
    const back = await api('PUT', `/api/v1/problems/${grpProblemId}/visibility`, adminTok, { visibility: 'groups', group_ids: [groupId] });
    assert.equal(back.status, 200);
    assert.equal(back.data.groups[0].id, groupId);

    // 实体不存在：404
    assert.equal((await api('GET', '/api/v1/problems/99999999/visibility', adminTok)).status, 404);
    assert.equal((await api('PUT', '/api/v1/contests/99999999/visibility', adminTok, { visibility: 'public' })).status, 404);
  });

  it('路由：题目详情门禁（非成员/匿名 403、成员 200、teacher 200）与旁路（题解/讨论）', async () => {
    const anon = await api('GET', `/api/v1/problems/${grpProblemId}`);
    assert.equal(anon.status, 403);
    assert.equal(anon.data.reason, 'ERR_FORBIDDEN');
    assert.match(anon.data.message, /do not have permission to view this problem/);

    const outsiderRead = await api('GET', `/api/v1/problems/${grpProblemId}`, outsiderTok);
    assert.equal(outsiderRead.status, 403);
    assert.equal(outsiderRead.data.reason, 'ERR_FORBIDDEN');

    const memberRead = await api('GET', `/api/v1/problems/${grpProblemId}`, memberTok);
    assert.equal(memberRead.status, 200, JSON.stringify(memberRead.data));
    assert.equal(memberRead.data.id, grpProblemId);

    // teacher/admin/su 一律可见（utils/access.js 审计口径：教师必须能组卷选题，否则功能自锁）
    assert.equal((await api('GET', `/api/v1/problems/${grpProblemId}`, teacherTok)).status, 200);
    assert.equal((await api('GET', `/api/v1/problems/${grpProblemId}`, adminTok)).status, 200);
    // 公开题对所有人可见（含匿名），既有 is_public/is_hidden 语义未变
    assert.equal((await api('GET', `/api/v1/problems/${pubProblemId}`)).status, 200);

    // 旁路：题解 / 讨论列表同样 403
    for (const p of [`/api/v1/problems/${grpProblemId}/solutions`, `/api/v1/problems/${grpProblemId}/discussions`]) {
      const r = await api('GET', p, outsiderTok);
      assert.equal(r.status, 403, `${p} 应对非成员 403`);
      assert.equal(r.data.reason, 'ERR_FORBIDDEN');
      const m = await api('GET', p, memberTok);
      assert.equal(m.status, 200, `${p} 应对成员放行`);
    }
    // 题目标签接口：组外用户不得反推题目标题
    const tags = await api('GET', `/api/v1/tags/problem/${grpProblemId}`, outsiderTok);
    assert.equal(tags.status, 403);
    assert.equal((await api('GET', `/api/v1/tags/problem/${grpProblemId}`, memberTok)).status, 200);
  });

  it('路由：题目列表过滤（非成员看不到、成员看得到，total 与列表口径一致）', async () => {
    const scope = 'gp-路由'; // 用标题前缀把查询限定在本用例的两道题上
    const asOutsider = await api('GET', `/api/v1/problems?search=${encodeURIComponent(scope)}&limit=100`, outsiderTok);
    assert.equal(asOutsider.status, 200);
    const outsiderIds = asOutsider.data.problems.map(p => p.id);
    assert.ok(outsiderIds.includes(pubProblemId));
    assert.equal(outsiderIds.includes(grpProblemId), false, '非成员列表不应出现组内题');
    assert.equal(asOutsider.data.total, outsiderIds.length, 'total 与列表口径一致');

    const asMember = await api('GET', `/api/v1/problems?search=${encodeURIComponent(scope)}&limit=100`, memberTok);
    const memberIds = asMember.data.problems.map(p => p.id);
    assert.ok(memberIds.includes(grpProblemId), '成员列表应出现组内题');
    assert.equal(asMember.data.total, memberIds.length);
    assert.equal(asMember.data.total, asOutsider.data.total + 1, '总数比非成员恰好多一道组内题');

    const asAnon = await api('GET', `/api/v1/problems?search=${encodeURIComponent(scope)}&limit=100`);
    assert.deepEqual(asAnon.data.problems.map(p => p.id), [pubProblemId], '匿名只看到 public');
    // staff 条件为空 → 不过滤
    const asTeacher = await api('GET', `/api/v1/problems?search=${encodeURIComponent(scope)}&limit=100`, teacherTok);
    assert.ok(asTeacher.data.problems.map(p => p.id).includes(grpProblemId), 'teacher 不被组过滤');
  });

  it('路由：提交路径门禁（非成员 403 / 成员放行；试卷题按所属试卷判定）', async () => {
    const blocked = await api('POST', '/api/v1/submissions', outsiderTok, {
      problem_id: grpProblemId, language: 'cpp', source_code: 'int main(){return 0;}'
    });
    assert.equal(blocked.status, 403, JSON.stringify(blocked.data));
    assert.equal(blocked.data.reason, 'ERR_FORBIDDEN');
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM submissions WHERE problem_id = ?').get(grpProblemId).c, 0, '被拦截的提交不应落库');

    const allowed = await api('POST', '/api/v1/submissions', memberTok, {
      problem_id: grpProblemId, language: 'cpp', source_code: 'int main(){return 0;}'
    });
    assert.equal(allowed.status, 201, JSON.stringify(allowed.data));
    const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(allowed.data.submission_id);
    assert.equal(row.problem_id, grpProblemId);
    memberSubId = row.id;
  });

  it('路由：收藏与词云按可见性过滤（无鉴权中间件的旁路泄露点）', async () => {
    // 成员收藏了组内题；他人查看其收藏列表不得看到题目标题
    assert.equal((await api('POST', `/api/v1/favorites/${grpProblemId}`, memberTok)).status, 200);
    assert.equal((await api('POST', `/api/v1/favorites/${pubProblemId}`, outsiderTok)).status, 200);

    const own = await api('GET', '/api/v1/favorites?size=50', memberTok);
    assert.equal(own.status, 200);
    assert.ok(own.data.favorites.some(f => f.problem_id === grpProblemId), '成员自己的收藏里应有该题');
    const peerView = await api('GET', `/api/v1/favorites?user_id=${memberId}&size=50`, outsiderTok);
    assert.equal(peerView.status, 200);
    assert.equal(peerView.data.favorites.some(f => f.problem_id === grpProblemId), false, '非成员看到的收藏不应含组内题');
    assert.equal(peerView.data.total, peerView.data.favorites.length, 'total 与列表口径一致');
    const staffView = await api('GET', `/api/v1/favorites?user_id=${memberId}&size=50`, adminTok);
    assert.ok(staffView.data.favorites.some(f => f.problem_id === grpProblemId), 'staff 不被组过滤');
    const anonCloud = await api('GET', '/api/v1/statistics/wordcloud');
    assert.equal(anonCloud.status, 200);
    const cloudIds = anonCloud.data.map(r => r.id);
    // 成员提交过这道组内题 → 词云有数据可过滤
    assert.ok(db.prepare('SELECT id FROM submissions WHERE id = ?').get(memberSubId), '成员提交仍在库');
    assert.ok((await api('GET', '/api/v1/statistics/wordcloud', memberTok)).data.map(r => r.id).includes(grpProblemId));
    assert.equal(cloudIds.includes(grpProblemId), false, '匿名词云不应出现组内题');
    assert.ok((await api('GET', '/api/v1/statistics/wordcloud', teacherTok)).data.map(r => r.id).includes(grpProblemId));
  });

  it('路由：比赛门禁（详情/榜/公告/讨论/虚拟参加）与列表过滤', async () => {
    for (const [method, p] of [
      ['GET', `/api/v1/contests/${grpContestId}`],
      ['GET', `/api/v1/contests/${grpContestId}/leaderboard`],
      ['GET', `/api/v1/contests/${grpContestId}/announcements`],
      ['GET', `/api/v1/contests/${grpContestId}/discussions`],
      ['POST', `/api/v1/contests/${grpContestId}/virtual-start`],
      ['POST', `/api/v1/contests/${grpContestId}/join`]
    ]) {
      const r = await api(method, p, outsiderTok);
      assert.equal(r.status, 403, `${method} ${p} 应对非成员 403`);
      assert.equal(r.data.reason, 'ERR_FORBIDDEN', `${method} ${p} 错误体应为 ERR_FORBIDDEN`);
    }
    // 匿名同样 403（不是 404：实体存在但无权访问）
    const anon = await api('GET', `/api/v1/contests/${grpContestId}`);
    assert.equal(anon.status, 403);
    assert.match(anon.data.message, /do not have permission to view this contest/);
    assert.equal((await api('GET', `/api/v1/contests/${grpContestId}`, memberTok)).status, 200);
    assert.equal((await api('GET', `/api/v1/contests/${grpContestId}/announcements`, memberTok)).status, 200);
    assert.equal((await api('GET', `/api/v1/contests/${grpContestId}`, teacherTok)).status, 200);
    assert.equal((await api('GET', `/api/v1/contests/${pubContestId}`)).status, 200);

    const list = await api('GET', '/api/v1/contests?limit=100', outsiderTok);
    const ids = list.data.contests.map(c => c.id);
    assert.ok(ids.includes(pubContestId));
    assert.equal(ids.includes(grpContestId), false, '非成员列表不应出现组内赛');
    const memberList = await api('GET', '/api/v1/contests?limit=100', memberTok);
    assert.ok(memberList.data.contests.map(c => c.id).includes(grpContestId));
    const anonList = await api('GET', '/api/v1/contests?limit=100');
    assert.equal(anonList.data.contests.map(c => c.id).includes(grpContestId), false);
  });

  it('路由：试卷门禁（详情/榜/交卷）与列表过滤', async () => {
    for (const [method, p, body] of [
      ['GET', `/api/v1/exams/${grpExamId}`, undefined],
      ['GET', `/api/v1/exams/${grpExamId}/leaderboard`, undefined],
      ['POST', `/api/v1/exams/${grpExamId}/submit`, { answers: [] }]
    ]) {
      const r = await api(method, p, outsiderTok, body);
      assert.equal(r.status, 403, `${method} ${p} 应对非成员 403`);
      assert.equal(r.data.reason, 'ERR_FORBIDDEN');
    }
    const anon = await api('GET', `/api/v1/exams/${grpExamId}`);
    assert.equal(anon.status, 403);
    assert.match(anon.data.message, /do not have permission to view this exam/);
    assert.equal((await api('GET', `/api/v1/exams/${grpExamId}`, memberTok)).status, 200);
    assert.equal((await api('GET', `/api/v1/exams/${grpExamId}`, teacherTok)).status, 200);
    assert.equal((await api('GET', `/api/v1/exams/${pubExamId}`)).status, 200);

    const list = await api('GET', '/api/v1/exams?limit=100', outsiderTok);
    const ids = list.data.exams.map(e => e.id);
    assert.ok(ids.includes(pubExamId));
    assert.equal(ids.includes(grpExamId), false, '非成员列表不应出现组内卷');
    const memberList = await api('GET', '/api/v1/exams?limit=100', memberTok);
    assert.ok(memberList.data.exams.map(e => e.id).includes(grpExamId));
  });

  it('路由：题单门禁与详情内题目过滤（组不可见的题不进入题单题目列表）', async () => {
    const r = await api('GET', `/api/v1/problem-sets/${grpSetId}`, outsiderTok);
    assert.equal(r.status, 403);
    assert.equal(r.data.reason, 'ERR_FORBIDDEN');
    assert.equal((await api('GET', `/api/v1/problem-sets/${grpSetId}`)).status, 403, '匿名 403');
    assert.equal((await api('GET', `/api/v1/problem-sets/${grpSetId}`, memberTok)).status, 200);

    // 题单本身公开，但内含组可见题：非成员打开题单看不到那道题
    const list = await api('GET', '/api/v1/problem-sets?size=50', outsiderTok);
    assert.ok(list.data.problem_sets.map(s => s.id).includes(pubSetId));
    assert.equal(list.data.problem_sets.map(s => s.id).includes(grpSetId), false, '非成员列表不应出现组内题单');
    const memberList = await api('GET', '/api/v1/problem-sets?size=50', memberTok);
    assert.ok(memberList.data.problem_sets.map(s => s.id).includes(grpSetId));

    const outsiderSet = await api('GET', `/api/v1/problem-sets/${pubSetId}`, outsiderTok);
    assert.equal(outsiderSet.status, 200);
    assert.deepEqual(outsiderSet.data.problems.map(p => p.id), [], '组可见题不应出现在非成员的题单详情里');
    assert.equal(outsiderSet.data.total_count, 0);
    const memberSet = await api('GET', `/api/v1/problem-sets/${pubSetId}`, memberTok);
    assert.deepEqual(memberSet.data.problems.map(p => p.id), [grpProblemId], '成员在题单里应看到那道题');
    assert.equal(memberSet.data.total_count, 1);
  });

  it('路由：删组语义（仍绑定实体 + 无 force → 409；force=1 → 实体回退 public 且组被删）', async () => {
    // 另建一个干净的组并绑定到组内题，避开上面用例对主组的依赖
    const tmp = await api('POST', '/api/v1/groups', adminTok, { name: 'gp-待删组', description: '' });
    const tmpId = tmp.data.group.id;
    await api('POST', `/api/v1/groups/${tmpId}/members`, adminTok, { user_id: outsiderId });
    await api('PUT', `/api/v1/problems/${grpProblemId}/visibility`, adminTok, { visibility: 'groups', group_ids: [groupId, tmpId] });

    const refused = await api('DELETE', `/api/v1/groups/${tmpId}`, adminTok);
    assert.equal(refused.status, 409);
    assert.equal(refused.data.code, 2);
    assert.equal(refused.data.reason, 'ERR_INVALID_STATE');
    assert.match(refused.data.message, /problem: 1/, '提示要讲清受影响实体的类型与数量');
    assert.ok(groupsRepo.getGroup(tmpId), '被拒绝的删除不应动组');

    const forced = await api('DELETE', `/api/v1/groups/${tmpId}?force=1`, adminTok);
    assert.equal(forced.status, 200, JSON.stringify(forced.data));
    assert.equal(groupsRepo.getGroup(tmpId), undefined);
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM user_groups WHERE group_id = ?').get(tmpId).c, 0);
    // 主组仍在 → 题目仍是组可见，不该被回退成 public
    assert.equal(db.prepare('SELECT visibility FROM problems WHERE id = ?').get(grpProblemId).visibility, 'groups');
    assert.deepEqual(resourceAccess.getResourceGroups('problem', grpProblemId).map(g => g.id), [groupId]);

    // 仅绑定该组的实体：force 删除后回退 public（否则实体停留在 groups 却无组可命中 → 失踪）
    const only = await api('POST', '/api/v1/groups', adminTok, { name: 'gp-独占组', description: '' });
    const onlyId = only.data.group.id;
    await api('PUT', `/api/v1/exams/${grpExamId}/visibility`, adminTok, { visibility: 'groups', group_ids: [onlyId] });
    const orphan = await api('DELETE', `/api/v1/groups/${onlyId}?force=1`, adminTok);
    assert.equal(orphan.status, 200);
    assert.match(orphan.data.message, /reset to public/);
    assert.equal(db.prepare('SELECT visibility FROM exams WHERE id = ?').get(grpExamId).visibility, 'public');
    assert.deepEqual(resourceAccess.getResourceGroups('exam', grpExamId), []);
    // 回退后可公开访问（原有交卷/榜单语义也随之恢复）
    assert.equal((await api('GET', `/api/v1/exams/${grpExamId}`)).status, 200);

    // 解掉主组剩余绑定后，普通删除即可（无 force）
    for (const [type, id] of [['problems', grpProblemId], ['contests', grpContestId], ['problem-sets', grpSetId]]) {
      const r = await api('PUT', `/api/v1/${type}/${id}/visibility`, adminTok, { visibility: 'public' });
      assert.equal(r.status, 200);
    }
    assert.deepEqual(resourceAccess.listGroupResourceRefs(groupId), [], '主组已无实体绑定');
    const plain = await api('DELETE', `/api/v1/groups/${groupId}`, adminTok);
    assert.equal(plain.status, 200, JSON.stringify(plain.data));
    assert.equal(groupsRepo.getGroup(groupId), undefined);
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM user_groups WHERE group_id = ?').get(groupId).c, 0, '成员关系一并清理');
    assert.equal((await api('GET', '/api/v1/groups', adminTok)).status, 200);
    // 组被删后，被回退为 public 的题目对所有人可见
    assert.equal((await api('GET', `/api/v1/problems/${grpProblemId}`, outsiderTok)).status, 200);
  });
});