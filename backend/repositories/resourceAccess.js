// repositories/resourceAccess.js —— 实体可见性绑定（resource_group_access）数据访问层
// 绑定只在实体 visibility='groups' 时生效；判定逻辑见 utils/access.js。
// 实体类型 → 主表名映射在此单点维护，utils/access.js 复用（单向依赖，无循环）。
const db = require('../database/db');

const RESOURCE_TABLES = {
  problem: 'problems',
  contest: 'contests',
  exam: 'exams',
  problem_set: 'problem_sets'
};

const RESOURCE_TYPES = Object.keys(RESOURCE_TABLES);

// 类型白名单：resource_type 有 CHECK 约束，这里先拦一次以给出可读错误
function assertType(type) {
  const t = String(type || '');
  if (!RESOURCE_TYPES.includes(t)) throw new Error(`未知的资源类型 "${type}"`);
  return t;
}

// 规范化组 id 列表：去重 + 丢弃非法值（空数组即"清空绑定"；单个 id 也可直接传）
function normalizeIds(ids) {
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(ids) ? ids : [ids])) {
    if (raw === null || raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

// 整体替换某实体的可见组：先删后插必须原子（中途失败会留下半套绑定）
// 不存在的组 id 直接忽略，避免脏绑定；返回替换后的生效绑定
function setResourceGroups(type, id, groupIds) {
  const t = assertType(type);
  const ids = normalizeIds(groupIds);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM resource_group_access WHERE resource_type = ? AND resource_id = ?').run(t, id);
    const ins = db.prepare('INSERT OR IGNORE INTO resource_group_access (resource_type, resource_id, group_id) VALUES (?, ?, ?)');
    const groupExists = db.prepare('SELECT id FROM groups WHERE id = ?');
    for (const gid of ids) {
      if (groupExists.get(gid)) ins.run(t, id, gid);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原始错误（外层已 rethrow） */ }
    throw e;
  }
  return getResourceGroups(t, id);
}

function getResourceGroups(type, id) {
  return db.prepare(`
    SELECT rga.group_id as id, g.name, g.kind
    FROM resource_group_access rga JOIN groups g ON g.id = rga.group_id
    WHERE rga.resource_type = ? AND rga.resource_id = ?
    ORDER BY g.id ASC
  `).all(assertType(type), id);
}

// 批量读取：一次 IN 查询取回多个实体绑定的组（列表兜底过滤用，避免 N+1）
// 返回 [{ resource_id, group_id }]
function listResourceGroupIds(type, ids) {
  const t = assertType(type);
  const list = normalizeIds(ids);
  if (list.length === 0) return [];
  const placeholders = list.map(() => '?').join(',');
  return db.prepare(`
    SELECT resource_id, group_id FROM resource_group_access
    WHERE resource_type = ? AND resource_id IN (${placeholders})
  `).all(t, ...list);
}

// 只读取某组绑定的实体清单（不改动数据）：路由层删组前要先据此判断"是否仍有实体绑定"、
// 并列出受影响实体（409 提示文案 / force 删除时回退为 public）
function listGroupResourceRefs(groupId) {
  return db.prepare(`
    SELECT resource_type, resource_id FROM resource_group_access
    WHERE group_id = ? ORDER BY resource_type ASC, resource_id ASC
  `).all(groupId).map(r => ({ type: r.resource_type, id: r.resource_id }));
}

// 删组时清理绑定：返回受影响的实体清单 [{ type, id }]，供路由层向操作者回执
function deleteGroupResourceRefs(groupId) {
  const rows = listGroupResourceRefs(groupId);
  db.prepare('DELETE FROM resource_group_access WHERE group_id = ?').run(groupId);
  return rows;
}

module.exports = {
  RESOURCE_TABLES, RESOURCE_TYPES,
  setResourceGroups, getResourceGroups, listResourceGroupIds, listGroupResourceRefs, deleteGroupResourceRefs
};