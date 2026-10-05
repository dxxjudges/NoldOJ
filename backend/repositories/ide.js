// repositories/ide.js —— 在线运行域数据访问层（P1：db.prepare 不再散落在路由层）
const db = require('../database/db');

function listEnabledLanguages() {
  return db.prepare('SELECT name, display_name, extension FROM languages WHERE is_enabled = 1').all();
}

function findEnabledLanguage(name) {
  return db.prepare('SELECT id FROM languages WHERE name = ? AND is_enabled = 1').get(name);
}

function insertRun(userId, language, source_code, stdin) {
  return db.prepare('INSERT INTO ide_runs (user_id, language, source_code, stdin, status) VALUES (?, ?, ?, ?, ?)')
    .run(userId, language, source_code, stdin || '', 'pending');
}

function getRun(id) {
  return db.prepare('SELECT * FROM ide_runs WHERE id = ?').get(id);
}

module.exports = { listEnabledLanguages, findEnabledLanguage, insertRun, getRun };
