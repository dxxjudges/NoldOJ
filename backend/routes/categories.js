const express = require('express');
const categoriesRepo = require('../repositories/categories');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const { buildUpdates } = require('../utils/db');
const { filterViewableIds } = require('../utils/access');
const { isStaff } = require('../utils/roles');

const { sendNotFound } = require('../utils/apiErrors');

const router = express.Router();

router.get('/', optionalAuth, (req, res) => {
  const categories = categoriesRepo.listCategoriesWithCount();
  // 实体可见性（用户组）：problem_count 只统计当前用户可见的题目（组可见题的题目数不外泄）
  if (!(req.user && isStaff(req.user.role))) {
    for (const cat of categories) {
      cat.problem_count = filterViewableIds('problem', categoriesRepo.listProblemIds(cat.id), req.user).length;
    }
  }
  res.json(categories);
});

router.get('/:id', optionalAuth, (req, res) => {
  const category = categoriesRepo.getCategory(req.params.id);
  if (!category) {
    return sendNotFound(res, 'Category not found.');
  }
  // 实体可见性（用户组）：分类本身是元数据，但 problem_count 会暴露组可见题的题目数
  if (!(req.user && isStaff(req.user.role))) {
    category.problem_count = filterViewableIds('problem', categoriesRepo.listProblemIds(category.id), req.user).length;
  }
  res.json(category);
});

router.post('/', requireAuth, requireRole('admin'), (req, res) => {
  const { name, description, sort_order } = req.body;
  if (!name) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Name is required.' });
  }
  const existing = categoriesRepo.findByName(name);
  if (existing) {
    return res.status(409).json({ code: 2, reason: 'ERR_CONFLICT', message: 'Category name already exists.' });
  }
  const result = categoriesRepo.insertCategory(name, description, sort_order);
  const category = categoriesRepo.getCategory(result.lastInsertRowid);
  res.status(201).json(category);
});

router.put('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const category = categoriesRepo.getCategory(req.params.id);
  if (!category) {
    return sendNotFound(res, 'Category not found.');
  }
  const { name, description, sort_order } = req.body;
  const u = buildUpdates([
    { key: 'name', value: name },
    { key: 'description', value: description },
    { key: 'sort_order', value: sort_order }
  ]);
  if (u.count === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  categoriesRepo.updateCategory(category.id, u);
  const updated = categoriesRepo.getCategory(category.id);
  res.json(updated);
});

router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const category = categoriesRepo.getCategory(req.params.id);
  if (!category) {
    return sendNotFound(res, 'Category not found.');
  }
  categoriesRepo.deleteProblemCategories(category.id);
  categoriesRepo.deleteCategory(category.id);
  res.json({ message: 'Category deleted.' });
});

router.post('/:id/problems/:pid', requireAuth, requireRole('teacher'), (req, res) => {
  const { id: categoryId, pid: problemId } = req.params;
  const category = categoriesRepo.findCategory(categoryId);
  if (!category) {
    return sendNotFound(res, 'Category not found.');
  }
  const problem = categoriesRepo.findProblem(problemId);
  if (!problem) {
    return sendNotFound(res, 'Problem not found.');
  }
  categoriesRepo.addProblem(problemId, categoryId);
  res.json({ message: 'Problem added to category.' });
});

router.delete('/:id/problems/:pid', requireAuth, requireRole('teacher'), (req, res) => {
  const { id: categoryId, pid: problemId } = req.params;
  categoriesRepo.removeProblem(problemId, categoryId);
  res.json({ message: 'Problem removed from category.' });
});

module.exports = router;