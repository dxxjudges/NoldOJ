const express = require('express');
const tagsRepo = require('../repositories/tags');
const { requireAuth, requireRole } = require('../middleware/auth');
const { buildUpdates } = require('../utils/db');

const { sendNotFound } = require('../utils/apiErrors');

const router = express.Router();

// R9-6: 标签颜色必须严格 hex（#RRGGBB），前端直接拼进 style 属性，
// 否则可注入 CSS/事件属性（XSS）。name 同理做长度上限。
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
function validateColor(color) {
  if (color === undefined || color === null) return '#6366f1';
  if (!HEX_COLOR.test(String(color))) throw Object.assign(new Error('Tag color must be a #RRGGBB hex color.'), { code: 400 });
  return String(color);
}

router.get('/', (req, res) => {
  const tags = tagsRepo.listTagsWithCount();
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

router.get('/problem/:problemId', (req, res) => {
  const tags = tagsRepo.listProblemTags(req.params.problemId);
  res.json(tags);
});

router.get('/:id', (req, res) => {
  const tag = tagsRepo.getTag(req.params.id);
  if (!tag) {
    return sendNotFound(res, 'Tag not found.');
  }
  res.json(tag);
});

module.exports = router;