// utils/access.js —— 实体可见性判定（problems / contests / exams / problem_sets 四类实体共用）
// 语义：实体 visibility='public' 全体可见；'groups' 仅绑定组成员可见（绑定见 resource_group_access）。
//
// 【审计说明】teacher/admin/su 对 visibility='groups' 的实体一律可见：
// 教师侧必须能组卷、选题、设可见范围（题目与试卷是教师的管理对象，若教师本人也被
// 组成员过滤挡住，就无法把实体授权给任何组，等于功能自锁），且与现状保持一致——
// utils/visibility.js 的 problemVisibilityError 对 is_hidden 本就对 staff 放行。
// 可见性收窄只针对普通用户（role='user'），不改变教师/管理员的既有能力。
//
// 本模块只做判定，不改数据；可见性的写入口在路由层（仅管理员，见 canManageVisibility）。
const db = require('../database/db');
const { isStaff, isAdminOrSu } = require('./roles');
const { RESOURCE_TABLES, RESOURCE_TYPES, listResourceGroupIds } = require('../repositories/resourceAccess');

// 资源类型 → 视图名的同值映射（与 RESOURCE_TYPES 一一对应）
const VIEW_TYPES = RESOURCE_TYPES.reduce((acc, type) => {
  acc[type] = type;
  return acc;
}, {});
// 路由资源名 → 资源类型：'problem'、'problems'、'problem_sets' 等写法归一到同一 type
const VIEW_TYPE_ALIASES = {
  problem: VIEW_TYPES.problem,
  problems: VIEW_TYPES.problem,
  contest: VIEW_TYPES.contest,
  contests: VIEW_TYPES.contest,
  exam: VIEW_TYPES.exam,
  exams: VIEW_TYPES.exam,
  problem_set: VIEW_TYPES.problem_set,
  problem_sets: VIEW_TYPES.problem_set,
  problemset: VIEW_TYPES.problem_set,
  problemsets: VIEW_TYPES.problem_set
};

function viewTypeOf(name) {
  return VIEW_TYPE_ALIASES[String(name || '').trim().toLowerCase()] || null;
}

// 资源类型 → 实体主表名（单点定义在 repositories/resourceAccess.js，避免两处漂移）
function tableForType(type) {
  const table = RESOURCE_TABLES[String(type || '')];
  if (!table) throw new Error(`未知的资源类型 "${type}"`);
  return table;
}

function isStaffUser(user) {
  return !!(user && isStaff(user.role));
}

// 用户已加入的组：成员关系一次取回，避免逐实体查库
function groupIdsOfUser(userId) {
  const rows = db.prepare('SELECT group_id FROM user_groups WHERE user_id = ?').all(userId);
  return new Set(rows.map(r => r.group_id));
}

// 单实体可见性：实体不存在视为不可见；public 全体可见；groups 需登录且在绑定组内
// teacher/admin/su 放行（见文件头审计说明）
function canViewResource(user, type, resourceId) {
  const table = tableForType(type);
  const row = db.prepare(`SELECT visibility FROM ${table} WHERE id = ?`).get(resourceId);
  if (!row) return false;
  if (row.visibility !== 'groups') return true;
  if (!user) return false;
  if (isStaffUser(user)) return true;
  return !!db.prepare(`
    SELECT 1 FROM resource_group_access rga
    JOIN user_groups ug ON ug.group_id = rga.group_id
    WHERE rga.resource_type = ? AND rga.resource_id = ? AND ug.user_id = ?
    LIMIT 1
  `).get(type, resourceId, user.id);
}

// 列表过滤用的 SQL 片段：staff 返回空条件（不过滤）；游客只留 public；
// 登录用户为 public ∪ 命中绑定组的实体。alias 为实体表在查询中的别名。
// 返回 { sql, params }，调用方以 ` AND ${sql}` 拼进 WHERE 并展开 params。
function visibilitySqlCondition(type, alias, { userId, staff } = {}) {
  const a = alias || 'res';
  tableForType(type); // 未知类型直接抛错，避免拼出恒假/恒真的条件
  if (staff) return { sql: '', params: [] };
  const publicCond = `${a}.visibility = 'public'`;
  if (!userId) return { sql: `(${publicCond})`, params: [] };
  const existsCond = `EXISTS (
      SELECT 1 FROM resource_group_access rga
      JOIN user_groups ug ON ug.group_id = rga.group_id
      WHERE rga.resource_type = ? AND rga.resource_id = ${a}.id AND ug.user_id = ?
    )`;
  return { sql: `(${publicCond} OR ${existsCond})`, params: [type, userId] };
}

// 兜底过滤：列表已把实体行取出来时，按 ids 批量剔除不可见项（staff 原样返回）
function filterViewableIds(type, ids, user) {
  const list = Array.from(ids || []);
  if (list.length === 0) return [];
  if (isStaffUser(user)) return list;
  const placeholders = list.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, visibility FROM ${tableForType(type)} WHERE id IN (${placeholders})`).all(...list);
  const visibility = new Map(rows.map(r => [r.id, r.visibility]));
  const groupOnly = list.filter(id => visibility.get(id) === 'groups');
  const hit = new Set();
  if (groupOnly.length > 0) {
    const allowed = user ? groupIdsOfUser(user.id) : new Set();
    if (allowed.size > 0) {
      for (const row of listResourceGroupIds(type, groupOnly)) {
        if (allowed.has(row.group_id)) hit.add(row.resource_id);
      }
    }
  }
  return list.filter(id => {
    const vis = visibility.get(id);
    if (!vis) return false; // 实体已不存在：与 canViewResource 口径一致，视为不可见
    return vis !== 'groups' || hit.has(id);
  });
}

// 谁能改可见性：仅管理员（su/admin）
function canManageVisibility(user) {
  return !!(user && isAdminOrSu(user.role));
}

module.exports = {
  RESOURCE_TYPES, VIEW_TYPES, viewTypeOf, tableForType,
  canViewResource, visibilitySqlCondition, filterViewableIds, canManageVisibility
};