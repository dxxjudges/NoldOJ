// repositories/notebook.js —— 错题本数据访问层
// 错题集合 = 本人非 AC 提交过的题目中「尚无 AC」的题；notebook_marks 只保存人工标记。
const db = require('../database/db');

function countWrong(userId, visibilityFilter) {
  const cond = visibilityFilter && visibilityFilter.sql ? ` AND (${visibilityFilter.sql})` : '';
  const params = [userId];
  if (visibilityFilter && visibilityFilter.sql) params.push(...(visibilityFilter.params || []));
  return db.prepare(`
    SELECT COUNT(*) as c FROM (
      SELECT p.id
      FROM submissions s
      JOIN problems p ON p.id = s.problem_id
      LEFT JOIN notebook_marks m ON m.user_id = s.user_id AND m.problem_id = s.problem_id
      WHERE s.user_id = ? AND s.exam_id IS NULL
        AND (m.status IS NULL OR m.status <> 'dismissed')
        ${cond}
      GROUP BY p.id
      HAVING SUM(CASE WHEN s.status = 'accepted' THEN 1 ELSE 0 END) = 0
    )
  `).get(...params).c;
}

function listWrong(userId, limit, offset, visibilityFilter) {
  const cond = visibilityFilter && visibilityFilter.sql ? ` AND (${visibilityFilter.sql})` : '';
  const params = [userId];
  if (visibilityFilter && visibilityFilter.sql) params.push(...(visibilityFilter.params || []));
  return db.prepare(`
    SELECT p.id as problem_id, p.title, p.difficulty,
      COUNT(s.id) as attempt_count,
      (SELECT s2.status FROM submissions s2
        WHERE s2.user_id = ? AND s2.problem_id = p.id AND s2.exam_id IS NULL
        ORDER BY s2.id DESC LIMIT 1) as last_status,
      m.status as mark_status, m.note, m.updated_at
    FROM submissions s
    JOIN problems p ON p.id = s.problem_id
    LEFT JOIN notebook_marks m ON m.user_id = s.user_id AND m.problem_id = s.problem_id
    WHERE s.user_id = ? AND s.exam_id IS NULL
      AND (m.status IS NULL OR m.status <> 'dismissed')
      ${cond}
    GROUP BY p.id
    HAVING SUM(CASE WHEN s.status = 'accepted' THEN 1 ELSE 0 END) = 0
    ORDER BY MAX(s.id) DESC
    LIMIT ? OFFSET ?
  `).all(userId, ...params, limit, offset);
}

function getMark(userId, problemId) {
  return db.prepare('SELECT * FROM notebook_marks WHERE user_id = ? AND problem_id = ?').get(userId, problemId);
}

function upsert(userId, problemId, status, note) {
  return db.prepare(`
    INSERT INTO notebook_marks (user_id, problem_id, status, note, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, problem_id) DO UPDATE SET
      status = excluded.status, note = excluded.note, updated_at = datetime('now')
  `).run(userId, problemId, status, note || '');
}

function problemExists(problemId) {
  return db.prepare('SELECT id FROM problems WHERE id = ?').get(problemId);
}

module.exports = { countWrong, listWrong, getMark, upsert, problemExists };
