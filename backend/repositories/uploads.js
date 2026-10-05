// repositories/uploads.js —— 文件上传域数据访问层（P1：db.prepare 不再散落在路由层）
const db = require('../database/db');

function countFiles() {
  return db.prepare('SELECT COUNT(*) as c FROM uploaded_files').get().c;
}

function listFiles(limit, offset) {
  return db.prepare(`
    SELECT f.*, u.username
    FROM uploaded_files f LEFT JOIN users u ON f.user_id = u.id
    ORDER BY f.id DESC LIMIT ? OFFSET ?
  `).all(limit, offset);
}

// 获取用户自定义限制
function getUserUploadLimits(userId) {
  return db.prepare('SELECT max_file_size, max_storage FROM users WHERE id = ?').get(userId);
}

function getUserUsedStorage(userId) {
  return db.prepare('SELECT COALESCE(SUM(size), 0) as total FROM uploaded_files WHERE user_id = ?').get(userId).total;
}

function insertFile(userId, filename, original_name, mime_type, size) {
  db.prepare('INSERT INTO uploaded_files (user_id, filename, original_name, mime_type, size) VALUES (?, ?, ?, ?, ?)').run(
    userId, filename, original_name, mime_type, size
  );
}

function getFile(id) {
  return db.prepare('SELECT * FROM uploaded_files WHERE id = ?').get(id);
}

function deleteFile(id) {
  db.prepare('DELETE FROM uploaded_files WHERE id = ?').run(id);
}

module.exports = { countFiles, listFiles, getUserUploadLimits, getUserUsedStorage, insertFile, getFile, deleteFile };
