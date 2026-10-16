// repositories/groups.js —— 用户组域数据访问层（P1：db.prepare 不再散落在路由层）
// 系统组（personal / all_users）由数据库触发器（trg_users_default_groups）+ initDB 回填维护，
// 本仓储提供幂等补齐入口（迁移回填、测试直接 INSERT users 时都会走到），并在入口处拦住
// 破坏系统组的写操作：改名 / 删除 / 改成员关系一律抛 ERR_INVALID_STATE，由路由层转 400。
const db = require('../database/db');
const { deleteGroupResourceRefs } = require('./resourceAccess');

const SYSTEM_KINDS = new Set(['personal', 'all_users']);
const ALL_USERS_GROUP_NAME = '所有用户';
const ALL_USERS_GROUP_DESC = '系统默认组，所有注册用户自动加入';
const PERSONAL_GROUP_DESC = '个人组';

// 组统计子查询（成员数 / 已绑定实体数）——组列表与"我的组"共用
const GROUP_STATS_SQL = `
      (SELECT COUNT(*) FROM user_groups ug2 WHERE ug2.group_id = g.id) as member_count,
      (SELECT COUNT(DISTINCT rga2.resource_type || ':' || rga2.resource_id)
         FROM resource_group_access rga2 WHERE rga2.group_id = g.id) as resource_count
`;

// 受约束错误：与路由层错误响应体同构（code/reason），路由层可直接透传
function invalidState(message) {
  const err = new Error(message);
  err.code = 2;
  err.reason = 'ERR_INVALID_STATE';
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.code = 3;
  err.reason = 'ERR_NOT_FOUND';
  return err;
}

// 系统组判定（personal / all_users 不可改名、不可删除，成员关系不可手工增删）
function isSystemGroup(kind) {
  return SYSTEM_KINDS.has(String(kind || ''));
}

// ── 系统组（全体组 / 个人组）──
// 全体组（全局唯一）：不存在则补建（幂等）
function getAllUsersGroup() {
  return db.prepare("SELECT * FROM groups WHERE kind = 'all_users' LIMIT 1").get();
}

function ensureAllUsersGroup() {
  const cur = getAllUsersGroup();
  if (cur) return cur;
  db.prepare(`
    INSERT OR IGNORE INTO groups (name, description, kind, owner_id, created_at)
    VALUES (?, ?, 'all_users', NULL, datetime('now'))
  `).run(ALL_USERS_GROUP_NAME, ALL_USERS_GROUP_DESC);
  return getAllUsersGroup();
}

function getPersonalGroup(userId) {
  return db.prepare("SELECT * FROM groups WHERE kind = 'personal' AND owner_id = ?").get(userId);
}

// 个人组（每人唯一一个，name=username）：不存在则补建（幂等）
function ensurePersonalGroup(userId, username) {
  const cur = getPersonalGroup(userId);
  if (cur) return cur;
  const name = username || db.prepare('SELECT username FROM users WHERE id = ?').get(userId)?.username;
  if (!name) throw notFound('用户不存在。');
  db.prepare(`
    INSERT OR IGNORE INTO groups (name, description, kind, owner_id, created_at)
    VALUES (?, ?, 'personal', ?, datetime('now'))
  `).run(name, PERSONAL_GROUP_DESC, userId);
  return getPersonalGroup(userId);
}

// 默认入组双保险：个人组 + 全体组（幂等，重复调用不产生重复组/成员）
function ensureDefaultMembership(userId) {
  const personal = ensurePersonalGroup(userId);
  const all = ensureAllUsersGroup();
  const insMember = db.prepare("INSERT OR IGNORE INTO user_groups (user_id, group_id, joined_at) VALUES (?, ?, datetime('now'))");
  insMember.run(userId, personal.id);
  if (all) insMember.run(userId, all.id);
  return { personal, all };
}

// ── 自定义组 ──
function createGroup({ name, description, kind, owner_id } = {}) {
  const groupName = String(name || '').trim();
  if (!groupName) throw invalidState('用户组名称不能为空。');
  const groupKind = kind === undefined || kind === null || kind === '' ? 'custom' : String(kind);
  if (!['custom', 'personal', 'all_users'].includes(groupKind)) throw invalidState('用户组类型非法。');
  if (groupKind === 'personal' && getPersonalGroup(owner_id)) throw invalidState('该用户已拥有个人组。');
  const owner = owner_id === undefined || owner_id === null ? null : owner_id;
  const res = db.prepare(`
    INSERT INTO groups (name, description, kind, owner_id, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(groupName, String(description || ''), groupKind, owner);
  return getGroup(res.lastInsertRowid);
}

// 改名 / 改描述：系统组不可改（个人组名须与用户名一致，全体组为全局唯一组）
function updateGroup(id, { name, description } = {}) {
  const group = getGroup(id);
  if (!group) throw notFound('用户组不存在。');
  if (isSystemGroup(group.kind)) throw invalidState('系统组不可修改。');
  const nextName = name === undefined || name === null ? null : String(name).trim();
  if (nextName !== null && !nextName) throw invalidState('用户组名称不能为空。');
  const nextDesc = description === undefined || description === null ? null : String(description);
  db.prepare('UPDATE groups SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?')
    .run(nextName, nextDesc, id);
  return getGroup(id);
}

// 删除组：系统组不可删；成员关系与实体绑定一并清理（表间无外键，必须手工收尾）
// 路由层若需向操作者回执"影响了哪些实体"，应先调 deleteGroupResourceRefs 取清单
function deleteGroup(id) {
  const group = getGroup(id);
  if (!group) throw notFound('用户组不存在。');
  if (isSystemGroup(group.kind)) throw invalidState('系统组不可删除。');
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM user_groups WHERE group_id = ?').run(id);
    deleteGroupResourceRefs(id);
    db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原始错误（外层已 rethrow） */ }
    throw e;
  }
  return 1;
}

function getGroup(id) {
  return db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
}

// 全部组（含系统组）＋成员数 / 已绑定实体数
function listGroups() {
  return db.prepare(`
    SELECT g.id, g.name, g.description, g.kind, g.owner_id, g.created_at,
      u.username as owner_name,
      ${GROUP_STATS_SQL}
    FROM groups g LEFT JOIN users u ON g.owner_id = u.id
    ORDER BY g.id ASC
  `).all();
}

function countGroups() {
  return db.prepare('SELECT COUNT(*) as c FROM groups').get().c;
}

// 我加入的组（含系统组）＋成员数 / 已绑定实体数
function listUserGroups(userId) {
  return db.prepare(`
    SELECT g.id, g.name, g.description, g.kind, g.owner_id, g.created_at,
      ${GROUP_STATS_SQL}
    FROM groups g JOIN user_groups ug ON ug.group_id = g.id
    WHERE ug.user_id = ?
    ORDER BY g.id ASC
  `).all(userId);
}

// 组成员分页：带总成员数（total 与 members 分页口径一致），与其它 list* 返回结构对齐
function listGroupMembers(groupId, { limit, offset } = {}) {
  const lim = Number.isInteger(limit) && limit > 0 ? limit : 100;
  const off = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  const total = db.prepare('SELECT COUNT(*) as c FROM user_groups WHERE group_id = ?').get(groupId).c;
  const members = db.prepare(`
    SELECT u.id, u.username, u.nickname, u.role, ug.joined_at
    FROM user_groups ug JOIN users u ON u.id = ug.user_id
    WHERE ug.group_id = ?
    ORDER BY ug.joined_at ASC, u.id ASC
    LIMIT ? OFFSET ?
  `).all(groupId, lim, off);
  return { total, members };
}

// ── 成员关系 ──
// 加入组：个人组仅允许 owner 本人加入（他人加入抛 ERR_INVALID_STATE）；
// 返回受影响行数（已是成员则为 0，天然幂等）
function addMember(groupId, userId) {
  const group = getGroup(groupId);
  if (!group) throw notFound('用户组不存在。');
  if (group.kind === 'personal' && String(group.owner_id) !== String(userId)) {
    throw invalidState('个人组仅限本人加入。');
  }
  const res = db.prepare("INSERT OR IGNORE INTO user_groups (user_id, group_id, joined_at) VALUES (?, ?, datetime('now'))")
    .run(userId, groupId);
  return res.changes;
}

// 移出组：系统组成员关系由触发器/回填维护，不允许手工增删
function removeMember(groupId, userId) {
  const group = getGroup(groupId);
  if (!group) throw notFound('用户组不存在。');
  if (isSystemGroup(group.kind)) throw invalidState('系统组成员不可手工移出。');
  const res = db.prepare('DELETE FROM user_groups WHERE group_id = ? AND user_id = ?').run(groupId, userId);
  return res.changes;
}

module.exports = {
  ensureAllUsersGroup, getAllUsersGroup, ensurePersonalGroup, getPersonalGroup, ensureDefaultMembership,
  createGroup, updateGroup, listGroups, getGroup, listUserGroups, listGroupMembers,
  addMember, removeMember, deleteGroup, countGroups, isSystemGroup
};