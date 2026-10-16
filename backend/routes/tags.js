const express = require('express');
const tagsRepo = require('../repositories/tags');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const { buildUpdates } = require('../utils/db');
const { isStaff } = require('../utils/roles');
const { filterViewableIds } = require('../utils/access');
const { visibilityDeniedMessage, canView } = require('./_visibility');

const { sendNotFound, sendForbidden } = require('../utils/apiErrors');

const router = express.Router();

// R9-6: 标签颜色必须严格 hex（#RRGGBB），前端直接拼进 style 属性，
// 否则可注入 CSS/事件属性（XSS）。name 同理做长度上限。
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
function validateColor(color) {
  if (color === undefined || color === null) return '#6366f1';
  if (!HEX_COLOR.test(String(color))) throw Object.assign(new Error('Tag color must be a #RRGGBB hex color.'), { code: 400 });
  return String(color);
}

// 标签/分类的题目计数是否需要按可见性重算：teacher/admin/su 本就能看到全部题目
function isStaffUser(user) {
  return !!(user && isStaff(user.role));
}

router.get('/', optionalAuth, (req, res) => {
  const tags = tagsRepo.listTagsWithCount();
  // 实体可见性（用户组）：problem_count 只统计当前用户可见的题目（组可见题的题目数不外泄）
  if (!isStaffUser(req.user)) {
    for (const tag of tags) {
      tag.problem_count = filterViewableIds('problem', tagsRepo.listProblemIds(tag.id), req.user).length;
    }
  }
  res.json(tags);
});

router.post('/', requireAuth, requireRole('teacher'), (req, res) => {
  const { name, color } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Tag name is required.' });
  }
  if (String(name).trim().length > 50) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Tag name too long.' });
  }
  const existing = tagsRepo.findByName(name.trim());
  if (existing) {
    return res.status(409).json({ code: 2, reason: 'ERR_CONFLICT', message: 'Tag already exists.' });
  }
  let safeColor;
  try { safeColor = validateColor(color); }
  catch (e) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: e.message });
  }
  const result = tagsRepo.insertTag(name.trim(), safeColor);
  const tag = tagsRepo.getTag(result.lastInsertRowid);
  res.status(201).json(tag);
});

router.delete('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const tag = tagsRepo.getTag(req.params.id);
  if (!tag) {
    return sendNotFound(res, 'Tag not found.');
  }
  tagsRepo.deleteProblemTags(tag.id);
  tagsRepo.deleteTag(tag.id);
  res.json({ message: 'Tag deleted.' });
});

router.put('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const tag = tagsRepo.getTag(req.params.id);
  if (!tag) {
    return sendNotFound(res, 'Tag not found.');
  }
  const { name, color } = req.body;
  if (name !== undefined) {
    const existing = tagsRepo.findByNameExcluding(name.trim(), tag.id);
    if (existing) {
      return res.status(409).json({ code: 2, reason: 'ERR_CONFLICT', message: 'Tag name already exists.' });
    }
  }
  if (color !== undefined) {
    try { validateColor(color); }
    catch (e) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: e.message });
    }
  }
  const updatesAndVals = buildUpdates([
    { key: 'name', value: name !== undefined ? String(name).trim().slice(0, 50) : undefined },
    { key: 'color', value: color }
  ]);
  if (updatesAndVals.count === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  tagsRepo.updateTag(tag.id, updatesAndVals);
  const updated = tagsRepo.getTag(tag.id);
  res.json(updated);
});

router.post('/problem/:problemId', requireAuth, requireRole('teacher'), (req, res) => {
  const problem = tagsRepo.getProblem(req.params.problemId);
  if (!problem) {
    return sendNotFound(res, 'Problem not found.');
  }
  const { tag_ids } = req.body;
  if (!Array.isArray(tag_ids)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'tag_ids array is required.' });
  }
  tagsRepo.setProblemTags(problem.id, tag_ids);
  res.json({ message: 'Tags updated.' });
});

// 组可见题的标签：不可见即 403（否则可借标签反推题目标题与存在性）
router.get('/problem/:problemId', optionalAuth, (req, res) => {
  if (!canView(req, 'problem', parseInt(req.params.problemId, 10))) {
    return sendForbidden(res, visibilityDeniedMessage('problem'));
  }
  const tags = tagsRepo.listProblemTags(req.params.problemId);
  res.json(tags);
});

router.get('/:id', optionalAuth, (req, res) => {
  const tag = tagsRepo.getTag(req.params.id);
  if (!tag) {
    return sendNotFound(res, 'Tag not found.');
  }
  // 实体可见性（用户组）：标签本身是元数据，但 problem_count 会暴露组可见题的题目数
  if (!isStaffUser(req.user)) {
    tag.problem_count = filterViewableIds('problem', tagsRepo.listProblemIds(tag.id), req.user).length;
  }
  res.json(tag);
});

module.exports = router;