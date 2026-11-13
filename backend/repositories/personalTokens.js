// repositories/personalTokens.js —— 私人访问令牌数据访问层
const db = require('../database/db');
const { generateToken, scopesToJson } = require('../utils/personalTokens');

function create(userId, name, scopes, expiresAt) {
  const { token, prefix, hash } = generateToken();
  const info = db.prepare(
    'INSERT INTO personal_access_tokens (user_id, name, token_prefix, token_hash, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, name, prefix, hash, scopesToJson(scopes), expiresAt);
  return { id: info.lastInsertRowid, token, prefix };
}

function listByUser(userId) {
  return db.prepare(
    'SELECT id, name, token_prefix, scopes, expires_at, last_used_at, created_at FROM personal_access_tokens WHERE user_id = ? ORDER BY id DESC'
  ).all(userId);
}

function countByUser(userId) {
  return db.prepare('SELECT COUNT(*) AS c FROM personal_access_tokens WHERE user_id = ?').get(userId)?.c || 0;
}

// 同一前缀可能命中多行（前缀只覆盖部分随机位），调用方需逐行比对摘要
function findByPrefix(prefix) {
  return db.prepare(
    'SELECT id, user_id, token_hash, name, token_prefix, scopes, expires_at, last_used_at, created_at FROM personal_access_tokens WHERE token_prefix = ?'
  ).all(prefix);
}

// 节流写入：距上次使用超过 60 秒才更新，避免高频请求不断同步写库
function touchLastUsed(id) {
  db.prepare(
    "UPDATE personal_access_tokens SET last_used_at = datetime('now') WHERE id = ? AND (last_used_at IS NULL OR last_used_at = '' OR last_used_at < datetime('now', '-60 seconds'))"
  ).run(id);
}

// 带 user_id 条件，防止越权吊销他人令牌
function revoke(id, userId) {
  return db.prepare('DELETE FROM personal_access_tokens WHERE id = ? AND user_id = ?').run(id, userId);
}

module.exports = { create, listByUser, countByUser, findByPrefix, touchLastUsed, revoke };
