// routes/groups.js —— 用户组管理（admin/su）+ 我的组（任意登录用户）
// 数据与判定全部下沉到 repositories/groups.js、repositories/resourceAccess.js、utils/access.js，
// 本文件只做鉴权、参数校验与响应编排；系统组（personal / all_users）的保护语义由仓储抛
// ERR_INVALID_STATE，这里统一转成 400/403，系统组改不动也删不掉。
const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const groupsRepo = require('../repositories/groups');
const usersRepo = require('../repositories/users');
const { getResourceGroups, listGroupResourceRefs, deleteGroupResourceRefs } = require('../repositories/resourceAccess');
const problemsRepo = require('../repositories/problems');
const contestsRepo = require('../repositories/contests');
const examsRepo = require('../repositories/exams');
const problemSetsRepo = require('../repositories/problem-sets');

const { sendNotFound, sendForbidden } = require('../utils/apiErrors');

const router = express.Router();

// 实体类型 → 可见性列写入函数：force 删组时把受影响实体回退为 public
const setVisibilityByType = {
  problem: problemsRepo.setVisibility,
  contest: contestsRepo.setVisibility,
  exam: examsRepo.setVisibility,
  problem_set: problemSetsRepo.setVisibility
};

// 实体类型 → 英文名词：409 提示里要讲清"哪些类型、多少个实体"会被影响，前端原样 toast
const resourceNoun = {
  problem: 'problem',
  contest: 'contest',
  exam: 'exam',
  problem_set: 'problem set'
};

const NOT_FOUND = 'Group not found.';
const MEMBERS_PAGE_SIZE = 20;
const MEMBERS_MAX_LIMIT = 100;

// 组视图：字段与前端管理台契约逐字对齐（id/name/description/kind/owner_id/member_count/resource_count）
function groupView(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    owner_id: row.owner_id,
    member_count: row.member_count || 0,
    resource_count: row.resource_count || 0
  };
}

// 取带统计字段的单组视图：listGroups 是唯一带 member_count / resource_count 的仓储查询，
// 组管理是低频操作，直接在结果里定位，避免为此新增一条统计 SQL
function groupViewById(id) {
  return groupView(groupsRepo.listGroups().find(g => String(g.id) === String(id)));
}

// 路径参数 → 组 id；非法值与不存在的组都按"未找到"处理，避免把脏 id 带进 SQL
function findGroupParam(raw) {
  const id = parseInt(raw, 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  const group = groupsRepo.getGroup(id);
  return group ? { id: group.id, row: group } : null;
}

// 仓储抛出的受约束错误 → HTTP 语义：
// ERR_NOT_FOUND → 404；ERR_INVALID_STATE（改不动/加不进系统组等）→ 400，错误体保持同构的 code/reason
function failWithRepoError(res, err, notFoundMessage) {
  if (err && err.reason === 'ERR_NOT_FOUND') return sendNotFound(res, notFoundMessage);
  if (err && err.reason === 'ERR_INVALID_STATE') {
    return res.status(400).json({ code: 2, reason: 'ERR_INVALID_STATE', message: String(err.message || 'Invalid state.') });
  }
  throw err;
}

// 分页校验：page / limit 必须是正整数，limit 上限 100；非法值返回 null 由调用方转 400
// （不做静默钳制，避免"以为按 500 条查、实际只回了 100 条"的错觉）
function parseMembersPaging(query) {
  const read = (raw) => {
    if (raw === undefined || raw === null || raw === '') return null;
    const s = String(raw).trim();
    if (!/^\d+$/.test(s)) return NaN;
    const n = Number(s);
    return Number.isSafeInteger(n) && n >= 1 ? n : NaN;
  };
  const page = read(query.page);
  const limit = read(query.limit);
  if (Number.isNaN(page) || Number.isNaN(limit)) return null;
  const p = page || 1;
  const l = Math.min(limit || MEMBERS_PAGE_SIZE, MEMBERS_MAX_LIMIT);
  return { page: p, limit: l, offset: (p - 1) * l };
}

// force=1 时把"因本组消失而再无任何可见组"的实体回退为 public，
// 否则实体停留在 visibility='groups' 却一个组都不绑定 → 除 staff 外谁都看不到（实体失踪）
function revertOrphanedResources(refs) {
  let reverted = 0;
  const seen = new Set();
  for (const ref of refs) {
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (getResourceGroups(ref.type, ref.id).length > 0) continue;
    const writer = setVisibilityByType[ref.type];
    if (!writer) continue;
    writer(ref.id, 'public');
    reverted++;
  }
  return reverted;
}

function describeRefs(refs) {
  const byType = new Map();
  for (const ref of refs) {
    byType.set(ref.type, (byType.get(ref.type) || 0) + 1);
  }
  return Array.from(byType.entries())
    .map(([type, count]) => `${resourceNoun[type] || type}: ${count}`)
    .join(', ');
}

// 全部组（管理台用）：仅管理员，含系统组 + 成员数 / 已绑定实体数
router.get('/', requireAuth, requireRole('admin'), (req, res) => {
  res.json({ groups: groupsRepo.listGroups().map(groupView) });
});

// 我的组（任意登录用户）：自己加入的组（含系统组），只回最小字段
router.get('/mine', requireAuth, (req, res) => {
  const groups = groupsRepo.listUserGroups(req.user.id).map(g => ({
    id: g.id,
    name: g.name,
    description: g.description,
    kind: g.kind
  }));
  res.json({ groups });
});

// 新建自定义组（系统组由触发器维护，不接受手工创建）
router.post('/', requireAuth, requireRole('admin'), (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'name is required.' });
  }
  const description = req.body && req.body.description !== undefined ? String(req.body.description) : '';
  let group;
  try {
    group = groupsRepo.createGroup({ name, description, kind: 'custom', owner_id: req.user.id });
  } catch (err) {
    return failWithRepoError(res, err, NOT_FOUND);
  }
  res.status(201).json({ group: groupViewById(group.id) });
});

// 改名 / 改描述：系统组不可改（403）
router.put('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const target = findGroupParam(req.params.id);
  if (!target) {
    return sendNotFound(res, NOT_FOUND);
  }
  if (groupsRepo.isSystemGroup(target.row.kind)) {
    return sendForbidden(res, 'System groups cannot be modified.');
  }
  const { name, description } = req.body || {};
  if (name === undefined && description === undefined) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'name or description is required.' });
  }
  try {
    groupsRepo.updateGroup(target.id, { name, description });
  } catch (err) {
    return failWithRepoError(res, err, NOT_FOUND);
  }
  res.json({ group: groupViewById(target.id) });
});

// 删组：仍有实体绑定且未 force → 409 ERR_INVALID_STATE（message 列出受影响类型与数量）；
// force=1 → 先把受影响实体回退为 public，再删组（成员关系与绑定一并清理）
router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const target = findGroupParam(req.params.id);
  if (!target) {
    return sendNotFound(res, NOT_FOUND);
  }
  if (groupsRepo.isSystemGroup(target.row.kind)) {
    return sendForbidden(res, 'System groups cannot be deleted.');
  }
  const force = String(req.query.force || '') === '1';
  const refs = listGroupResourceRefs(target.id);
  if (refs.length > 0 && !force) {
    return res.status(409).json({
      code: 2,
      reason: 'ERR_INVALID_STATE',
      message: `This group is still assigned to ${refs.length} resource(s) (${describeRefs(refs)}). Retry with force=1 to make them public and delete the group.`
    });
  }
  let reverted = 0;
  try {
    if (refs.length > 0) {
      deleteGroupResourceRefs(target.id);
      reverted = revertOrphanedResources(refs);
    }
    groupsRepo.deleteGroup(target.id);
  } catch (err) {
    return failWithRepoError(res, err, NOT_FOUND);
  }
  res.json({
    message: reverted > 0
      ? `Group deleted. ${reverted} resource(s) were reset to public.`
      : 'Group deleted.'
  });
});

// 组成员分页：带 total（与 members 同一口径）
router.get('/:id/members', requireAuth, requireRole('admin'), (req, res) => {
  const target = findGroupParam(req.params.id);
  if (!target) {
    return sendNotFound(res, NOT_FOUND);
  }
  const paging = parseMembersPaging(req.query);
  if (!paging) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'page and limit must be positive integers.' });
  }
  const { total, members } = groupsRepo.listGroupMembers(target.id, { limit: paging.limit, offset: paging.offset });
  res.json({
    total,
    members: members.map(m => ({ id: m.id, username: m.username, nickname: m.nickname, role: m.role }))
  });
});

// 加成员：全体组成员由触发器/回填维护 → 403；个人组只有 owner 本人可加
// （他人加入由仓储抛 ERR_INVALID_STATE → 400，避免把个人组变成公共容器）
router.post('/:id/members', requireAuth, requireRole('admin'), (req, res) => {
  const target = findGroupParam(req.params.id);
  if (!target) {
    return sendNotFound(res, NOT_FOUND);
  }
  if (target.row.kind === 'all_users') {
    return sendForbidden(res, 'System group membership cannot be changed manually.');
  }
  const userId = parseInt((req.body || {}).user_id, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'user_id is required.' });
  }
  if (!usersRepo.get(userId)) {
    return sendNotFound(res, 'User not found.');
  }
  try {
    groupsRepo.addMember(target.id, userId);
  } catch (err) {
    return failWithRepoError(res, err, NOT_FOUND);
  }
  res.json({ message: 'Member added.' });
});

// 移出成员：系统组成员关系由触发器/回填维护，一律 403
router.delete('/:id/members/:userId', requireAuth, requireRole('admin'), (req, res) => {
  const target = findGroupParam(req.params.id);
  if (!target) {
    return sendNotFound(res, NOT_FOUND);
  }
  if (groupsRepo.isSystemGroup(target.row.kind)) {
    return sendForbidden(res, 'System group membership cannot be changed manually.');
  }
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Invalid user id.' });
  }
  try {
    groupsRepo.removeMember(target.id, userId);
  } catch (err) {
    return failWithRepoError(res, err, NOT_FOUND);
  }
  res.json({ message: 'Member removed.' });
});

module.exports = router;