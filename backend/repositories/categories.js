// repositories/categories.js —— 题目分类域数据访问层（P1：db.prepare 不再散落在路由层）
const db = require('../database/db');

function listCategoriesWithCount() {
  const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order, id').all();
  for (const cat of categories) {
    const count = db.prepare('SELECT COUNT(*) as c FROM problem_categories WHERE category_id = ?').get(cat.id).c;
    cat.problem_count = count;
  }
  return categories;
}

function getCategory(id) {
  return db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
}

function findCategory(id) {
  return db.prepare('SELECT id FROM categories WHERE id = ?').get(id);
}

function findByName(name) {
  return db.prepare('SELECT id FROM categories WHERE name = ?').get(name);
}

function insertCategory(name, description, sort_order) {
  return db.prepare('INSERT INTO categories (name, description, sort_order) VALUES (?, ?, ?)').run(
    name, description || '', sort_order || 0
  );
}

// 动态 SET 片段由路由层 buildUpdates 生成，此处整体拼接执行
function updateCategory(id, u) {
  db.prepare(`UPDATE categories SET ${u.clause} WHERE id = ?`).run(...u.values, id);
}

function deleteProblemCategories(categoryId) {
  db.prepare('DELETE FROM problem_categories WHERE category_id = ?').run(categoryId);
}

function deleteCategory(id) {
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
}

function findProblem(id) {
  return db.prepare('SELECT id FROM problems WHERE id = ?').get(id);
}

function addProblem(problemId, categoryId) {
  db.prepare('INSERT OR IGNORE INTO problem_categories (problem_id, category_id) VALUES (?, ?)').run(problemId, categoryId);
}

function removeProblem(problemId, categoryId) {
  db.prepare('DELETE FROM problem_categories WHERE problem_id = ? AND category_id = ?').run(problemId, categoryId);
}

// 分类下的题目 id：分类接口要按"当前用户可见的题目"统计（见 routes/categories.js）
function listProblemIds(categoryId) {
  return db.prepare('SELECT problem_id FROM problem_categories WHERE category_id = ? ORDER BY problem_id')
    .all(categoryId).map(r => r.problem_id);
}

module.exports = {
  listCategoriesWithCount, getCategory, findCategory, findByName, insertCategory, updateCategory,
  deleteProblemCategories, deleteCategory, findProblem, addProblem, removeProblem, listProblemIds
};
