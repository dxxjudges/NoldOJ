// repositories/languages.js —— 语言域数据访问层（P1：db.prepare 不再散落在路由层）
const db = require('../database/db');

// 公开接口只暴露非敏感字段，不泄露 compile_cmd/run_cmd
function listLanguages() {
  return db.prepare('SELECT id, name, display_name, extension, is_enabled FROM languages ORDER BY id').all();
}

function findByName(name) {
  return db.prepare('SELECT id FROM languages WHERE name = ?').get(name);
}

function findById(id) {
  return db.prepare('SELECT * FROM languages WHERE id = ?').get(id);
}

function insertLanguage(name, display_name, compile_cmd, run_cmd, extension) {
  return db.prepare('INSERT INTO languages (name, display_name, compile_cmd, run_cmd, extension) VALUES (?, ?, ?, ?, ?)')
    .run(name, display_name, compile_cmd || '', run_cmd, extension);
}

// 动态 SET 片段由路由层 buildUpdates 生成，此处整体拼接执行
function updateLanguage(id, u) {
  db.prepare(`UPDATE languages SET ${u.clause} WHERE id = ?`).run(...u.values, id);
}

function deleteLanguage(id) {
  db.prepare('DELETE FROM languages WHERE id = ?').run(id);
}

module.exports = { listLanguages, findByName, findById, insertLanguage, updateLanguage, deleteLanguage };
