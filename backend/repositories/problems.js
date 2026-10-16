// repositories/problems.js —— 题目域数据访问层（P1：db.prepare 不再散落在路由层）
const fs = require('fs');
const path = require('path');
const db = require('../database/db');

const EXAM_PROBLEM_ID_BASE = db.EXAM_PROBLEM_ID_BASE;

// ── 题目主记录 ───────────────────────────────────────
function getProblemById(id) {
  return db.prepare('SELECT * FROM problems WHERE id = ?').get(id);
}

// 占用/存在性检查（重编号 clash、查重任务前置检查）
function getProblemId(id) {
  return db.prepare('SELECT id FROM problems WHERE id = ?').get(id);
}

function countTestCases(problemId) {
  return db.prepare('SELECT COUNT(*) as c FROM test_cases WHERE problem_id = ?').get(problemId).c;
}

function findNextId(table) {
  return db.findNextId(table);
}

// ── 列表（GET /）：过滤与排序片段在此拼接（动态 SQL 收口到数据访问层）──
function listProblems(filters) {
  const { search, tag, tags, category, difficulty, sort, order, isManager, limit, offset } = filters;
  let where = 'WHERE p.is_public = 1 AND p.exam_id IS NULL';
  const params = [];
  if (!isManager) {
    where += ' AND p.is_hidden = 0';
  }

  // 实体可见性（用户组）：utils/access.js 生成的条件对象 { sql, params }，别名固定为 p；
  // 路由层注入，缺省时不追加任何条件（旧调用方行为不变）
  const vis = filters.visibilityFilter;
  if (vis && vis.sql) {
    where += ` AND (${vis.sql})`;
    params.push(...(vis.params || []));
  }

  if (search) {
    const fuzzy = '%' + search.replace(/\s+/g, '') + '%';
    where += ` AND (REPLACE(p.title, ' ', '') LIKE ? OR REPLACE(p.description, ' ', '') LIKE ? OR REPLACE(IFNULL(p.provider, ''), ' ', '') LIKE ?)`;
    params.push(fuzzy, fuzzy, fuzzy);
  }

  // 兼容单标签 tag 与多标签 tags（逗号分隔，OR 逻辑）
  const tagList = [];
  if (tag) tagList.push(tag);
  if (tags) tagList.push(...tags.split(',').map(s => s.trim()).filter(Boolean));
  if (tagList.length > 0) {
    const placeholders = tagList.map(() => '?').join(',');
    where += ` AND p.id IN (SELECT pt.problem_id FROM problem_tags pt JOIN tags t ON pt.tag_id = t.id WHERE t.name IN (${placeholders}))`;
    params.push(...tagList);
  }

  if (category) {
    where += ' AND p.id IN (SELECT pc.problem_id FROM problem_categories pc JOIN categories c ON pc.category_id = c.id WHERE c.name = ?)';
    params.push(category);
  }

  if (difficulty !== '' && difficulty !== null && difficulty !== undefined) {
    const d = parseInt(difficulty);
    if (!isNaN(d) && d >= 0 && d <= 5) {
      where += ' AND p.difficulty = ?';
      params.push(d);
    }
  }

  // 排序：默认按 id 升序；支持 created_at / accept_rate / submissions
  const ord = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  let orderClause = 'ORDER BY p.id ASC';
  if (sort === 'created_at') {
    orderClause = `ORDER BY p.created_at ${ord}, p.id ${ord}`;
  } else if (sort === 'submissions') {
    orderClause = `ORDER BY sub_count ${ord}, p.id ${ord}`;
  } else if (sort === 'accept_rate') {
    orderClause = `ORDER BY ac_rate ${ord}, p.id ${ord}`;
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM problems p ${where}`).get(...params).c;
  const problems = db.prepare(`
    SELECT p.id, p.title, p.problem_type, p.time_limit, p.memory_limit, p.is_public, p.is_hidden, p.difficulty, p.created_at,
      COALESCE(agg.sub_count, 0) as sub_count,
      COALESCE(agg.ac_count, 0) as ac_count,
      CASE WHEN COALESCE(agg.sub_count, 0) > 0
        THEN COALESCE(agg.ac_count, 0) * 1.0 / agg.sub_count
        ELSE 0 END as ac_rate
    FROM problems p
    LEFT JOIN (
      SELECT problem_id,
        COUNT(*) as sub_count,
        SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) as ac_count
      FROM submissions
      GROUP BY problem_id
    ) agg ON agg.problem_id = p.id
    ${where} ${orderClause} LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return { total, problems };
}

// 列表批量取标签
function getProblemTagRows(ids) {
  const qmarks = ids.map(() => '?').join(',');
  return db.prepare(`
      SELECT pt.problem_id, t.id, t.name, t.color FROM tags t
      JOIN problem_tags pt ON t.id = pt.tag_id
      WHERE pt.problem_id IN (${qmarks})
    `).all(...ids);
}

// 列表批量取分类
function getProblemCategoryRows(ids) {
  const qmarks = ids.map(() => '?').join(',');
  return db.prepare(`
      SELECT pc.problem_id, c.id, c.name, c.description FROM categories c
      JOIN problem_categories pc ON c.id = pc.category_id
      WHERE pc.problem_id IN (${qmarks})
    `).all(...ids);
}

function getProblemCategories(problemId) {
  return db.prepare(`
    SELECT c.id, c.name, c.description FROM categories c
    JOIN problem_categories pc ON c.id = pc.category_id
    WHERE pc.problem_id = ?
  `).all(problemId);
}

function getProblemTags(problemId) {
  return db.prepare(`
    SELECT t.id, t.name, t.color FROM tags t
    JOIN problem_tags pt ON t.id = pt.tag_id
    WHERE pt.problem_id = ?
  `).all(problemId);
}

function findContestProblem(problemId) {
  return db.prepare('SELECT id FROM contest_problems WHERE problem_id = ?').get(problemId);
}

// ── 样例（R12-1 多样例）────────────────────────────────
function getSamples(problemId) {
  return db.prepare('SELECT input, output, note FROM problem_samples WHERE problem_id = ? ORDER BY sort_order, id').all(problemId);
}

// 全量替换某题样例; 并双写首条到旧 sample_input/sample_output 字段(兼容旧客户端/搜索)
function replaceSamples(problemId, samples) {
  db.prepare('DELETE FROM problem_samples WHERE problem_id = ?').run(problemId);
  const ins = db.prepare('INSERT INTO problem_samples (problem_id, input, output, note, sort_order) VALUES (?, ?, ?, ?, ?)');
  samples.forEach((s, i) => ins.run(problemId, s.input, s.output, s.note, i + 1));
  const first = samples[0] || { input: '', output: '' };
  db.prepare('UPDATE problems SET sample_input = ?, sample_output = ? WHERE id = ?').run(first.input, first.output, problemId);
}

function updateLegacySampleFields(problemId, input, output) {
  db.prepare('UPDATE problems SET sample_input = ?, sample_output = ?, updated_at = datetime(\'now\') WHERE id = ?').run(input, output, problemId);
}

function getLegacySampleFields(problemId) {
  return db.prepare('SELECT sample_input, sample_output FROM problems WHERE id = ?').get(problemId);
}

// ── 题目写入 ─────────────────────────────────────────
function insertProblem(p) {
  db.prepare(`INSERT INTO problems (id, title, description, background, input_desc, output_desc, hint, time_limit, memory_limit, problem_type, compare_mode, real_number_tolerance, spj_code, allowed_languages, is_public, provider, created_by, sample_input, sample_output, subtask_mode, difficulty, is_hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    p.id,
    p.title,
    p.description,
    p.background,
    p.input_desc,
    p.output_desc,
    p.hint,
    p.time_limit,
    p.memory_limit,
    p.problem_type,
    p.compare_mode,
    p.real_number_tolerance,
    p.spj_code,
    p.allowed_languages,
    p.is_public,
    p.provider,
    p.created_by,
    p.sample_input,
    p.sample_output,
    p.subtask_mode,
    p.difficulty,
    p.is_hidden
  );
}

function insertImportedProblem(p) {
  db.prepare(`INSERT INTO problems (id, title, description, background, input_desc, output_desc, hint, time_limit, memory_limit, problem_type, compare_mode, real_number_tolerance, spj_code, scoring_script, allowed_languages, is_public, provider, created_by, sample_input, sample_output, subtask_mode, difficulty, is_hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    p.id,
    p.title,
    p.description,
    p.background,
    p.input_desc,
    p.output_desc,
    p.hint,
    p.time_limit,
    p.memory_limit,
    p.problem_type,
    p.compare_mode,
    p.real_number_tolerance,
    p.spj_code,
    p.scoring_script,
    p.allowed_languages,
    p.is_public,
    p.provider,
    p.created_by,
    p.sample_input,
    p.sample_output,
    p.subtask_mode,
    p.difficulty,
    p.is_hidden
  );
}

// 动态 SET 片段由路由层 buildUpdates 生成，此处整体拼接执行
function updateProblem(id, u) {
  db.prepare(`UPDATE problems SET ${u.clause} WHERE id = ?`).run(...u.values, id);
}

// 实体可见性（用户组维度）：仅由 routes/_visibility.js 的 PUT 写入，值受 CHECK 约束
function setVisibility(id, visibility) {
  db.prepare("UPDATE problems SET visibility = ?, updated_at = datetime('now') WHERE id = ?").run(visibility, id);
}

function deleteTestCases(problemId) {
  db.prepare('DELETE FROM test_cases WHERE problem_id = ?').run(problemId);
}

function deleteTestGroups(problemId) {
  db.prepare('DELETE FROM test_groups WHERE problem_id = ?').run(problemId);
}

function deleteSamples(problemId) {
  db.prepare('DELETE FROM problem_samples WHERE problem_id = ?').run(problemId);
}

function deleteProblem(id) {
  db.prepare('DELETE FROM problems WHERE id = ?').run(id);
}

// ── 题目重编号（admin/su）：将题目 id 改到指定的空位置。
// 需要同步所有引用 problem_id 的表 + 磁盘 testdata 目录，全在事务内完成。
// 使用 defer_foreign_keys 将外键校验推迟到 COMMIT（SQLite 3.23+，node:sqlite 自带新版）。
// 磁盘目录迁移 + 数据库改号整体事务化；失败 ROLLBACK、还原目录后 rethrow（响应逻辑留在路由层）。
function rekeyProblem(oldId, newId, oldDir, newDir) {
  try {
    db.exec('BEGIN');
    db.exec('PRAGMA defer_foreign_keys = ON');

    // 1) 磁盘目录改名（先于数据库提交，若失败回滚前还原）
    if (fs.existsSync(oldDir)) {
      fs.renameSync(oldDir, newDir);
    }

    // 2) 引用 problem_id 的所有表同步更新
    const refTables = [
      'test_groups', 'test_cases', 'submissions', 'problem_set_items',
      'problem_set_progress', 'contest_problems', 'problem_solutions',
      'problem_tags', 'problem_categories', 'discussions', 'user_favorites',
      'problem_samples',
      // plagiarism_tasks.problem_id 也有 FK(schema.sql)，遗漏会导致 COMMIT 时
      // FOREIGN KEY constraint failed → 已查重过的题目重编号必定 500
      'plagiarism_tasks',
      // exam_questions.problem_id 同理（试卷内编程题）
      'exam_questions'
    ];
    for (const t of refTables) {
      db.prepare(`UPDATE ${t} SET problem_id = ? WHERE problem_id = ?`).run(newId, oldId);
    }

    // 3) test_cases 中存绝对路径的 input_file/output_file 需重写旧目录前缀（相对路径不受影响）
    const oldPrefix = oldDir + path.sep;
    const newPrefix = newDir + path.sep;
    const tcRows = db.prepare('SELECT id, input_file, output_file FROM test_cases WHERE problem_id = ?').all(newId);
    const rewriteTc = db.prepare('UPDATE test_cases SET input_file = ?, output_file = ? WHERE id = ?');
    for (const tc of tcRows) {
      const inF = tc.input_file && path.isAbsolute(tc.input_file) && tc.input_file.startsWith(oldPrefix)
        ? newPrefix + tc.input_file.slice(oldPrefix.length) : tc.input_file;
      const outF = tc.output_file && path.isAbsolute(tc.output_file) && tc.output_file.startsWith(oldPrefix)
        ? newPrefix + tc.output_file.slice(oldPrefix.length) : tc.output_file;
      if (inF !== tc.input_file || outF !== tc.output_file) {
        rewriteTc.run(inF, outF, tc.id);
      }
    }

    // 4) 更新 problems 主键
    db.prepare('UPDATE problems SET id = ? WHERE id = ?').run(newId, oldId);

    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原始错误（外层已 rethrow） */ }
    // 回滚后还原磁盘目录
    if (fs.existsSync(newDir) && !fs.existsSync(oldDir)) {
      try { fs.renameSync(newDir, oldDir); } catch { /* 目录还原尽力而为，原错误已 rethrow */ }
    }
    throw err;
  }
}

// ── 测试点 / 分组 ────────────────────────────────────
function getMaxSortOrder(problemId) {
  const row = db.prepare('SELECT MAX(sort_order) as m FROM test_cases WHERE problem_id = ?').get(problemId);
  return row?.m || 0;
}

function insertTestCaseFiles(problemId, inputFile, outputFile, sortOrder) {
  db.prepare('INSERT INTO test_cases (problem_id, input_file, output_file, sort_order) VALUES (?, ?, ?, ?)').run(
    problemId, inputFile, outputFile, sortOrder
  );
}

function insertTestCaseInGroup(problemId, groupId, inputFile, outputFile, sortOrder) {
  db.prepare('INSERT INTO test_cases (problem_id, group_id, input_file, output_file, sort_order) VALUES (?, ?, ?, ?, ?)').run(
    problemId, groupId, inputFile, outputFile, sortOrder
  );
}

function insertTestCaseText(problemId, inputData, outputData, sortOrder) {
  db.prepare('INSERT INTO test_cases (problem_id, input_data, output_data, sort_order) VALUES (?, ?, ?, ?)').run(
    problemId, inputData, outputData, sortOrder
  );
}

function insertTestCase(problemId, inputData, outputData, score, timeLimit, memoryLimit, sortOrder) {
  db.prepare('INSERT INTO test_cases (problem_id, input_data, output_data, score, time_limit, memory_limit, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    problemId, inputData, outputData, score, timeLimit, memoryLimit, sortOrder
  );
}

function insertTestCaseWithGroup(problemId, groupId, inputData, outputData, score, timeLimit, memoryLimit, sortOrder) {
  db.prepare('INSERT INTO test_cases (problem_id, group_id, input_data, output_data, score, time_limit, memory_limit, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    problemId, groupId, inputData, outputData, score, timeLimit, memoryLimit, sortOrder
  );
}

function insertImportedTestCase(t) {
  db.prepare('INSERT INTO test_cases (problem_id, input_data, output_data, score, sort_order, group_id, time_limit, memory_limit, input_file, output_file) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    t.problem_id,
    t.input_data,
    t.output_data,
    t.score,
    t.sort_order,
    t.group_id,
    t.time_limit,
    t.memory_limit,
    t.input_file,
    t.output_file
  );
}

function listTestCases(problemId) {
  return db.prepare('SELECT * FROM test_cases WHERE problem_id = ? ORDER BY sort_order, id').all(problemId);
}

function listTestCasesWithGroups(problemId) {
  return db.prepare('SELECT tc.*, tg.subtask_id FROM test_cases tc LEFT JOIN test_groups tg ON tc.group_id = tg.id WHERE tc.problem_id = ? ORDER BY tc.sort_order, tc.id').all(problemId);
}

function getTestCase(problemId, tcId) {
  return db.prepare('SELECT * FROM test_cases WHERE id = ? AND problem_id = ?').get(tcId, problemId);
}

function setTestCaseGroup(tcId, groupId) {
  db.prepare('UPDATE test_cases SET group_id = ? WHERE id = ?').run(groupId, tcId);
}

// 动态 SET 片段由路由层 buildUpdates 生成，此处整体拼接执行
function updateTestCase(id, u) {
  db.prepare(`UPDATE test_cases SET ${u.clause} WHERE id = ?`).run(...u.values, id);
}

function updateTestCasesByProblem(problemId, u) {
  db.prepare(`UPDATE test_cases SET ${u.clause} WHERE problem_id = ?`).run(...u.values, problemId);
}

function deleteTestCase(tcId) {
  db.prepare('DELETE FROM test_cases WHERE id = ?').run(tcId);
}

function updateScoringScript(problemId, scoringScript) {
  db.prepare("UPDATE problems SET scoring_script = ?, updated_at = datetime('now') WHERE id = ?").run(scoringScript, problemId);
}

function listTestGroups(problemId) {
  return db.prepare('SELECT * FROM test_groups WHERE problem_id = ? ORDER BY id').all(problemId);
}

function getTestGroup(id) {
  return db.prepare('SELECT * FROM test_groups WHERE id = ?').get(id);
}

function getTestGroupOfProblem(problemId, groupId) {
  return db.prepare('SELECT * FROM test_groups WHERE id = ? AND problem_id = ?').get(groupId, problemId);
}

function insertTestGroup(problemId, subtaskId, score, aggregator, dependency, scoringScript) {
  return db.prepare('INSERT INTO test_groups (problem_id, subtask_id, score, aggregator, dependency, scoring_script) VALUES (?, ?, ?, ?, ?, ?)').run(
    problemId,
    subtaskId,
    score,
    aggregator,
    dependency,
    scoringScript
  );
}

// 动态 SET 片段由路由层 buildUpdates 生成，此处整体拼接执行
function updateTestGroup(id, u) {
  db.prepare(`UPDATE test_groups SET ${u.clause} WHERE id = ?`).run(...u.values, id);
}

function findTestGroupBySubtask(problemId, subtaskId) {
  return db.prepare('SELECT id FROM test_groups WHERE problem_id = ? AND subtask_id = ?').get(problemId, subtaskId);
}

function clearTestCasesGroup(groupId) {
  db.prepare('UPDATE test_cases SET group_id = NULL WHERE group_id = ?').run(groupId);
}

function listGroupDependencies(problemId) {
  return db.prepare('SELECT id, dependency FROM test_groups WHERE problem_id = ? AND dependency IS NOT NULL').all(problemId);
}

function updateGroupDependency(groupId, dependency) {
  db.prepare('UPDATE test_groups SET dependency = ? WHERE id = ?').run(dependency, groupId);
}

function deleteTestGroup(id) {
  db.prepare('DELETE FROM test_groups WHERE id = ?').run(id);
}

// ── 题解 ─────────────────────────────────────────────
function listSolutions(problemId) {
  return db.prepare(`
    SELECT ps.id, ps.article_id, ps.sort_order, ps.show_after_contest, ps.created_at,
           a.title as article_title, a.content as article_content, a.is_published,
           u.username as author_name
    FROM problem_solutions ps
    LEFT JOIN articles a ON ps.article_id = a.id
    LEFT JOIN users u ON a.author_id = u.id
    WHERE ps.problem_id = ? ORDER BY ps.sort_order
  `).all(problemId);
}

function getArticle(id) {
  return db.prepare('SELECT id FROM articles WHERE id = ?').get(id);
}

function linkSolution(problemId, articleId, sortOrder, showAfterContest) {
  db.prepare('INSERT INTO problem_solutions (problem_id, article_id, sort_order, show_after_contest) VALUES (?, ?, ?, ?)').run(
    problemId, articleId, sortOrder, showAfterContest
  );
}

function unlinkSolution(solutionId, problemId) {
  db.prepare('DELETE FROM problem_solutions WHERE id = ? AND problem_id = ?').run(solutionId, problemId);
}

// ── 讨论 ─────────────────────────────────────────────
function countDiscussions(problemId) {
  return db.prepare('SELECT COUNT(*) as c FROM discussions WHERE problem_id = ?').get(problemId).c;
}

function listDiscussions(problemId, limit, offset) {
  return db.prepare(`
    SELECT d.id, d.title, d.is_official, d.pinned, d.locked, d.created_at, d.updated_at,
           u.username, u.nickname, u.role,
           (SELECT COUNT(*) FROM discussion_replies WHERE discussion_id = d.id) as reply_count
    FROM discussions d LEFT JOIN users u ON d.author_id = u.id
    WHERE d.problem_id = ?
    ORDER BY d.pinned DESC, d.is_official DESC, d.id DESC
    LIMIT ? OFFSET ?
  `).all(problemId, limit, offset);
}

// ── 导出 ─────────────────────────────────────────────
function listProblemTagNames(problemId) {
  return db.prepare(`
    SELECT t.name FROM tags t
    JOIN problem_tags pt ON pt.tag_id = t.id
    WHERE pt.problem_id = ? ORDER BY t.name
  `).all(problemId).map(r => r.name);
}

function listProblemCategoryNames(problemId) {
  return db.prepare(`
    SELECT c.name FROM categories c
    JOIN problem_categories pc ON pc.category_id = c.id
    WHERE pc.problem_id = ? ORDER BY c.name
  `).all(problemId).map(r => r.name);
}

// ── 导入：标签/分类（存在则复用，不存在则创建）──────────
function getTagByName(name) {
  return db.prepare('SELECT id FROM tags WHERE name = ?').get(name);
}

function insertTag(id, name) {
  db.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(id, name);
}

function linkProblemTag(problemId, tagId) {
  db.prepare('INSERT OR IGNORE INTO problem_tags (problem_id, tag_id) VALUES (?, ?)').run(problemId, tagId);
}

function getCategoryByName(name) {
  return db.prepare('SELECT id FROM categories WHERE name = ?').get(name);
}

function insertCategory(id, name) {
  db.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').run(id, name);
}

function linkProblemCategory(problemId, categoryId) {
  db.prepare('INSERT OR IGNORE INTO problem_categories (problem_id, category_id) VALUES (?, ?)').run(problemId, categoryId);
}

module.exports = {
  EXAM_PROBLEM_ID_BASE,
  getProblemById,
  getProblemId,
  countTestCases,
  findNextId,
  listProblems,
  getProblemTagRows,
  getProblemCategoryRows,
  getProblemCategories,
  getProblemTags,
  findContestProblem,
  getSamples,
  replaceSamples,
  updateLegacySampleFields,
  getLegacySampleFields,
  insertProblem,
  insertImportedProblem,
  updateProblem,
  setVisibility,
  deleteTestCases,
  deleteTestGroups,
  deleteSamples,
  deleteProblem,
  rekeyProblem,
  getMaxSortOrder,
  insertTestCaseFiles,
  insertTestCaseInGroup,
  insertTestCaseText,
  insertTestCase,
  insertTestCaseWithGroup,
  insertImportedTestCase,
  listTestCases,
  listTestCasesWithGroups,
  getTestCase,
  setTestCaseGroup,
  updateTestCase,
  updateTestCasesByProblem,
  deleteTestCase,
  updateScoringScript,
  listTestGroups,
  getTestGroup,
  getTestGroupOfProblem,
  insertTestGroup,
  updateTestGroup,
  findTestGroupBySubtask,
  clearTestCasesGroup,
  listGroupDependencies,
  updateGroupDependency,
  deleteTestGroup,
  listSolutions,
  getArticle,
  linkSolution,
  unlinkSolution,
  countDiscussions,
  listDiscussions,
  listProblemTagNames,
  listProblemCategoryNames,
  getTagByName,
  insertTag,
  linkProblemTag,
  getCategoryByName,
  insertCategory,
  linkProblemCategory
};
