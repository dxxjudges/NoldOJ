// repositories/tags.js —— 标签域数据访问层（P1：db.prepare 不再散落在路由层）
const db = require('../database/db');

function listTagsWithCount() {
  const tags = db.prepare('SELECT * FROM tags ORDER BY name').all();
  const countStmt = db.prepare('SELECT COUNT(*) as c FROM problem_tags WHERE tag_id = ?');
  for (const tag of tags) {
    tag.problem_count = countStmt.get(tag.id).c;
  }
  return tags;
}

function findByName(name) {
  return db.prepare('SELECT id FROM tags WHERE name = ?').get(name);
}

function findByNameExcluding(name, id) {
  return db.prepare('SELECT id FROM tags WHERE name = ? AND id != ?').get(name, id);
}

function getTag(id) {
  return db.prepare('SELECT * FROM tags WHERE id = ?').get(id);
}

function insertTag(name, color) {
  return db.prepare('INSERT INTO tags (name, color) VALUES (?, ?)').run(name, color);
}

// 动态 SET 片段由路由层 buildUpdates 生成，此处整体拼接执行
function updateTag(id, u) {
  db.prepare(`UPDATE tags SET ${u.clause} WHERE id = ?`).run(...u.values, id);
}

function deleteProblemTags(tagId) {
  db.prepare('DELETE FROM problem_tags WHERE tag_id = ?').run(tagId);
}

function deleteTag(id) {
  db.prepare('DELETE FROM tags WHERE id = ?').run(id);
}

function getProblem(id) {
  return db.prepare('SELECT * FROM problems WHERE id = ?').get(id);
}

// 覆盖式设置题目标签：先清空再按存在性逐个回插
function setProblemTags(problemId, tagIds) {
  db.prepare('DELETE FROM problem_tags WHERE problem_id = ?').run(problemId);
  const insert = db.prepare('INSERT INTO problem_tags (problem_id, tag_id) VALUES (?, ?)');
  for (const tagId of tagIds) {
    const tag = db.prepare('SELECT id FROM tags WHERE id = ?').get(tagId);
    if (tag) {
      insert.run(problemId, tagId);
    }
  }
}

function listProblemTags(problemId) {
  return db.prepare(`
    SELECT t.* FROM tags t
    JOIN problem_tags pt ON t.id = pt.tag_id
    WHERE pt.problem_id = ?
    ORDER BY t.name
  `).all(problemId);
}

// 标签下的题目 id：标签页/详情要按"当前用户可见的题目"统计，SQL 无法直接表达（跨 user_groups）
function listProblemIds(tagId) {
  return db.prepare('SELECT problem_id FROM problem_tags WHERE tag_id = ? ORDER BY problem_id')
    .all(tagId).map(r => r.problem_id);
}

module.exports = {
  listTagsWithCount, findByName, findByNameExcluding, getTag, insertTag, updateTag,
  deleteProblemTags, deleteTag, getProblem, setProblemTags, listProblemTags, listProblemIds
};
