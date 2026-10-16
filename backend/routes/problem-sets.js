const express = require('express');
const problemSetsRepo = require('../repositories/problem-sets');
const { makeVisibilityRouter, visibilityFilterFor, visibilityDeniedMessage, canView } = require('./_visibility');
const { filterViewableIds } = require('../utils/access');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { parsePageLimit } = require('../utils/pagination');
const { isStaff, isAdminOrSu } = require('../utils/roles');
const { buildUpdates } = require('../utils/db');

const { sendNotFound, sendForbidden } = require('../utils/apiErrors');
const { logError } = require('../utils/logger');

const router = express.Router();

// 实体可见性（用户组维度）：GET/PUT /:id/visibility
// findResource 用 getRow（整行含 visibility）：get() 只回 { id }，读不到当前可见性
router.use(makeVisibilityRouter({
  resourceType: 'problem_set',
  tableName: 'problem_sets',
  findResource: problemSetsRepo.getRow,
  setVisibility: problemSetsRepo.setVisibility
}));

// 列表（公开题单 + 本人私有题单 + admin/su 全部 + 分页）
router.get('/', optionalAuth, (req, res) => {
  const { page = 1, size = 20 } = req.query;
  const { page: pageNum, limit: sizeNum, offset } = parsePageLimit(page, size, 20, 50);

  // 匿名仅公开；登录用户额外可见本人私有题单；admin/su 可见全部
  // （is_public / creator 两段用括号包住：后续要 AND 可见性条件，OR 优先级更高不加括号会漏过滤）
  const userId = req.user ? req.user.id : null;
  let where;
  let params = [];
  if (userId && isAdminOrSu(req.user.role)) {
    where = '1 = 1';
  } else if (userId) {
    where = '(ps.is_public = 1 OR ps.creator_id = ?)';
    params = [userId];
  } else {
    where = 'ps.is_public = 1';
  }
  // 实体可见性（用户组）：与 canViewResource 口径一致，staff 条件为空 → 不过滤
  const vis = visibilityFilterFor(req, 'problem_set');
  if (vis.sql) {
    where += ` AND (${vis.sql})`;
    params.push(...vis.params);
  }

  const total = problemSetsRepo.countList(where, params);
  const items = problemSetsRepo.list(where, params, sizeNum, offset);

  // 若用户已登录，附带每题单进度（批量查询，避免 N+1 DoS）
  let result = items.map(it => ({ ...it, solved_count: 0 }));
  if (userId && items.length > 0) {
    const ids = items.map(it => it.id);
    const counts = problemSetsRepo.countSolvedBySets(userId, ids);
    const countMap = new Map(counts.map(r => [r.set_id, r.c]));
    for (const it of result) it.solved_count = countMap.get(it.id) || 0;
  }

  res.json({ total, page: pageNum, size: sizeNum, problem_sets: result });
});

// 我的题单（公开 + 个人私有）
router.get('/mine', requireAuth, (req, res) => {
  const items = problemSetsRepo.listMine(req.user.id);
  res.json({ problem_sets: items });
});

// 详情（含题目列表 + 当前用户进度）
router.get('/:id', optionalAuth, (req, res) => {
  const ps = problemSetsRepo.getWithCreator(req.params.id);
  if (!ps) {
    return sendNotFound(res, 'Problem set not found.');
  }
  if (!ps.is_public && (!req.user || !isAdminOrSu(req.user.role)) && req.user?.id !== ps.creator_id) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'This set is private.' });
  }
  // 实体可见性（用户组）：visibility='groups' 的题单仅绑定组成员与 staff 可见
  if (!canView(req, 'problem_set', ps.id)) {
    return sendForbidden(res, visibilityDeniedMessage('problem set'));
  }

  const problems = problemSetsRepo.listProblems(req.user ? req.user.id : 0, ps.id);

  // 题单内的题目逐题过滤：题单本身可见不代表其中每道题都可见（题目可能单独设为组可见）
  const viewable = new Set(filterViewableIds('problem', problems.map(p => p.id), req.user));
  let solvedCount = 0;
  const problemList = problems
    .filter(p => viewable.has(p.id))
    .map(p => {
      const solved = p.user_accepted > 0 ? 1 : 0;
      if (solved) solvedCount++;
      return { id: p.id, title: p.title, difficulty: p.difficulty, sort_order: p.sort_order, solved };
    });

  res.json({
    ...ps,
    problems: problemList,
    solved_count: solvedCount,
    total_count: problemList.length
  });
});

// 进度查询
router.get('/:id/progress', requireAuth, (req, res) => {
  const ps = problemSetsRepo.getRow(req.params.id);
  if (!ps) {
    return sendNotFound(res, 'Problem set not found.');
  }
  // 实体可见性（用户组）：进度项含题目 id，组外用户不得读
  if (!canView(req, 'problem_set', ps.id)) {
    return sendForbidden(res, visibilityDeniedMessage('problem set'));
  }
  const items = problemSetsRepo.listProgress(req.user.id, ps.id);
  const solved = items.filter(i => i.solved).length;
  res.json({ total: items.length, solved, items });
});

// 创建：教师/管理员可建公开题单；普通用户可建个人私有题单（type='personal'，仅自己可见）
router.post('/', requireAuth, (req, res) => {
  const { title, description = '', is_public = 1, problemIds = [], type = 'public' } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Title is required.' });
  }
  const isTeacher = isStaff(req.user.role);
  if (type === 'personal') {
    // 个人题单强制私有
    const ps = problemSetsRepo.createPersonalSet(title.trim(), description, req.user.id, problemIds);
    return res.status(201).json(ps);
  }
  // 公开题单需教师+
  if (!isTeacher) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '公开题单需要教师或管理员权限。' });
  }
  const ps = problemSetsRepo.createPublicSet(title.trim(), description, req.user.id, is_public, problemIds);
  res.status(201).json(ps);
});

// 更新（作者或 admin；个人题单作者可为普通用户）
router.put('/:id', requireAuth, (req, res) => {
  const ps = problemSetsRepo.getRow(req.params.id);
  if (!ps) {
    return sendNotFound(res, 'Problem set not found.');
  }
  if (req.user.id !== ps.creator_id && !isAdminOrSu(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot edit others\' problem sets.' });
  }
  // 非教师不允许把个人题单改为公开，也不允许改他人创建的公开题单
  if (!isStaff(req.user.role) && ps.type === 'public') {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot edit public problem sets.' });
  }
  const { title, description, is_public } = req.body;
  const u = buildUpdates([
    { key: 'title', value: title !== undefined ? title.trim() : undefined },
    { key: 'description', value: description },
    { key: 'is_public', value: is_public, transform: v => (isStaff(req.user.role) && ps.type !== 'personal') ? (v ? 1 : 0) : 0 }
  ]);
  if (u.count === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  problemSetsRepo.update(ps.id, u);
  const updated = problemSetsRepo.getRow(ps.id);
  res.json(updated);
});

// 设置题目列表（覆盖式；个人题单作者可为普通用户）
router.put('/:id/problems', requireAuth, (req, res) => {
  const ps = problemSetsRepo.getRow(req.params.id);
  if (!ps) {
    return sendNotFound(res, 'Problem set not found.');
  }
  if (req.user.id !== ps.creator_id && !isAdminOrSu(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot modify others\' problem sets.' });
  }
  if (!isStaff(req.user.role) && ps.type === 'public') {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot modify public problem sets.' });
  }
  const { problemIds } = req.body;
  if (!Array.isArray(problemIds)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'problemIds must be an array.' });
  }
  // 强制整数并去重：这些值直接写入 problem_set_items.problem_id
  const ids = [];
  for (const raw of problemIds) {
    const n = Number(raw);
    if (!Number.isInteger(n)) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'problemIds must be an array of problem ids.' });
    }
    if (!ids.includes(n)) ids.push(n);
  }
  // 题目不存在时原先会先 DELETE 全部条目、再在 INSERT 处抛 FK 错 → 500 且题单被清空
  const missing = problemSetsRepo.findMissingProblemIds(ids);
  if (missing.length > 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `Problems not found: ${missing.join(', ')}` });
  }

  try {
    problemSetsRepo.replaceProblems(ps.id, ids);
  } catch (e) {
    logError('PROBLEM-SET', 'update problems failed:', e && e.message);
    return res.status(500).json({ code: 1, reason: 'ERR_INTERNAL', message: 'Failed to update problem list.' });
  }
  res.json({ message: 'Problem list updated.', count: ids.length });
});

// 删除（作者或 admin；个人题单作者可为普通用户）
router.delete('/:id', requireAuth, (req, res) => {
  const ps = problemSetsRepo.getRow(req.params.id);
  if (!ps) {
    return sendNotFound(res, 'Problem set not found.');
  }
  if (req.user.id !== ps.creator_id && !isAdminOrSu(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot delete others\' problem sets.' });
  }
  if (!isStaff(req.user.role) && ps.type === 'public') {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot delete public problem sets.' });
  }
  problemSetsRepo.deleteSet(ps.id);
  res.json({ message: 'Problem set deleted.' });
});

// 标记进度（用户 AC 后由评测系统调用，或前端手动调用）
router.post('/:id/progress/:pid', requireAuth, (req, res) => {
  const ps = problemSetsRepo.get(req.params.id);
  if (!ps) {
    return sendNotFound(res, 'Problem set not found.');
  }
  const item = problemSetsRepo.getSetItem(ps.id, req.params.pid);
  if (!item) {
    return sendNotFound(res, 'Problem not in this set.');
  }
  // 校验用户是否真的 AC
  const ac = problemSetsRepo.userHasAccepted(req.user.id, req.params.pid);
  if (!ac) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'You have not solved this problem.' });
  }
  problemSetsRepo.recordProgress(req.user.id, ps.id, req.params.pid);
  res.json({ message: 'Progress recorded.' });
});

module.exports = router;
