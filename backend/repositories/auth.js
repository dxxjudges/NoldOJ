// repositories/auth.js —— 认证域数据访问层（P1：db.prepare 不再散落在路由层）
// 含 4 段多语句事务：reset-password 三写 / change-password 三写 / register 双写 / refresh 消费+签发
const db = require('../database/db');
const { generateAccessToken, generateRefreshToken } = require('../utils/tokens');

function getUserAuth(username) {
  return db.prepare('SELECT id, username, email, email_verified FROM users WHERE username = ?').get(username);
}

function getUserForLogin(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getUserRefreshInfo(id) {
  return db.prepare('SELECT id, banned, force_logout_at FROM users WHERE id = ?').get(id);
}

function findUserByEmail(email) {
  return db.prepare('SELECT id FROM users WHERE email = ?').get(email);
}

function findUserByUsername(username) {
  return db.prepare('SELECT id FROM users WHERE username = ?').get(username);
}

function listActiveRefreshTokens(userId, prefix) {
  return db.prepare('SELECT * FROM refresh_tokens WHERE user_id = ? AND token_prefix = ? AND expires_at > datetime(\'now\')').all(userId, prefix);
}

function listRefreshTokenHashes(userId) {
  return db.prepare('SELECT id, token_hash FROM refresh_tokens WHERE user_id = ?').all(userId);
}

function deleteRefreshToken(id) {
  db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(id);
}

function deleteRefreshTokensByUser(userId) {
  db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(userId);
}

// 三写原子：口令已改而令牌未吊销 = 旧会话仍可刷新，属安全不一致状态
function resetPassword(userId, hash) {
  try {
    db.exec('BEGIN');
    db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, userId);
    // 重置后强制所有会话下线
    db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(userId);
    db.prepare("UPDATE users SET force_logout_at = datetime('now') WHERE id = ?").run(userId);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原始错误（外层已 rethrow） */ }
    throw err;
  }
}

// 三写原子：改密 + 吊销旧会话必须同生共死
function changePassword(userId, hash) {
  try {
    db.exec('BEGIN');
    db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, userId);
    // D-L2: 修改密码同时吊销旧 access token（否则最长 15 分钟仍有效）
    db.prepare("UPDATE users SET force_logout_at = datetime('now') WHERE id = ?").run(userId);
    db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(userId);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原始错误（外层已 rethrow） */ }
    throw err;
  }
}

// 用户行与首个 refresh token 同生共死：插入中途失败不得留下无会话的半注册账号
function registerUser(username, hash, safeNickname, email, emailVerified) {
  let newId;
  let accessToken;
  let refreshToken;
  try {
    db.exec('BEGIN');
    newId = db.findNextId('users');
    db.prepare('INSERT INTO users (id, username, password_hash, nickname, role, email, email_verified) VALUES (?, ?, ?, ?, ?, ?, ?)').run(newId, username, hash, safeNickname, 'user', email || '', emailVerified);
    accessToken = generateAccessToken(newId);
    refreshToken = generateRefreshToken(newId);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原始错误（外层已 rethrow） */ }
    throw err;
  }
  return { id: newId, accessToken, refreshToken };
}

// 原子消费该 refresh token: 并发刷新时后到者 delete 影响 0 行，判定为已使用
// 消费旧 token 与签发新 token（generateRefreshToken 含库写）同生共死：
// 中途失败会发出库中不存在的 cookie，导致下次刷新必然 401。
function rotateRefreshToken(userId, tokenId) {
  try {
    db.exec('BEGIN');
    const del = db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(tokenId);
    if (del.changes === 0) {
      db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(userId);
      db.exec('COMMIT');
      return { alreadyUsed: true };
    }
    const accessToken = generateAccessToken(userId);
    const refreshToken = generateRefreshToken(userId);
    db.exec('COMMIT');
    return { accessToken, refreshToken };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原始错误（外层已 rethrow） */ }
    throw e;
  }
}

module.exports = {
  getUserAuth, getUserForLogin, getUserById, getUserRefreshInfo,
  findUserByEmail, findUserByUsername,
  listActiveRefreshTokens, listRefreshTokenHashes, deleteRefreshToken, deleteRefreshTokensByUser,
  resetPassword, changePassword, registerUser, rotateRefreshToken
};
