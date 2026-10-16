// repositories/users.js —— 用户域数据访问层（P1：db.prepare 不再散落在路由层）
// 含删用户的 18 连删事务；磁盘文件删除留在路由层（事务提交成功后执行）
const db = require('../database/db');
const { RESOURCE_TABLES, deleteGroupResourceRefs } = require('./resourceAccess');

function countUsers(where, params = []) {
  return db.prepare(`SELECT COUNT(*) as c FROM users ${where}`).get(...params).c;
}

function listRating(where, limit, offset) {
  return db.prepare(`
    SELECT id, username, nickname, role, rating, created_at
    FROM users ${where} ORDER BY rating DESC, created_at ASC LIMIT ? OFFSET ?
  `).all(limit, offset);
}

function listUsers(where, params, limit, offset) {
  return db.prepare(`SELECT id, username, nickname, email, role, banned, rating, hide_rating, created_at FROM users ${where} ORDER BY id LIMIT ? OFFSET ?`).all(...params, limit, offset);
}

function getProfile(id) {
  return db.prepare('SELECT id, username, nickname, role, signature, bio, rating, hide_rating, hide_achievements, hide_dashboard, hide_favorites, created_at FROM users WHERE id = ?').get(id);
}

function getMe(id) {
  return db.prepare('SELECT id, username, nickname, role, signature, bio, rating, preferred_language, submit_lock_exempt, hide_rating, hide_achievements, hide_dashboard, hide_favorites, created_at FROM users WHERE id = ?').get(id);
}

function findEnabledLanguage(name) {
  return db.prepare('SELECT name FROM languages WHERE name = ? AND is_enabled = 1').get(name);
}

// 动态 SET 片段由路由层 buildUpdates 生成，此处整体拼接执行
function updateMe(id, u) {
  db.prepare(`UPDATE users SET ${u.clause} WHERE id = ?`).run(...u.values, id);
}

function getMeSettings(id) {
  return db.prepare('SELECT id, username, nickname, role, signature, bio, rating, hide_rating, hide_achievements, hide_dashboard, hide_favorites, preferred_language FROM users WHERE id = ?').get(id);
}

function get(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getAdmin(id) {
  return db.prepare('SELECT id, username, nickname, role, banned, created_at, updated_at FROM users WHERE id = ?').get(id);
}

function setRating(id, rating) {
  db.prepare('UPDATE users SET rating = ?, updated_at = datetime(\'now\') WHERE id = ?').run(rating, id);
}

function setHideRating(id, hideRating) {
  db.prepare('UPDATE users SET hide_rating = ?, updated_at = datetime(\'now\') WHERE id = ?').run(hideRating, id);
}

function setSubmitLockExempt(id, exempt) {
  db.prepare("UPDATE users SET submit_lock_exempt = ?, updated_at = datetime('now') WHERE id = ?").run(exempt, id);
}

function setUploadLimits(id, maxFileSize, maxStorage) {
  db.prepare("UPDATE users SET max_file_size = ?, max_storage = ?, updated_at = datetime('now') WHERE id = ?").run(maxFileSize, maxStorage, id);
}

function setRole(id, role) {
  db.prepare('UPDATE users SET role = ?, updated_at = datetime(\'now\') WHERE id = ?').run(role, id);
}

function ban(id) {
  db.prepare('UPDATE users SET banned = 1, updated_at = datetime(\'now\') WHERE id = ?').run(id);
  db.prepare("UPDATE users SET force_logout_at = datetime('now') WHERE id = ?").run(id);
  db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(id);
}

function unban(id) {
  db.prepare('UPDATE users SET banned = 0, updated_at = datetime(\'now\') WHERE id = ?').run(id);
}

function forceLogout(id) {
  db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(id);
  db.prepare("UPDATE users SET force_logout_at = datetime('now') WHERE id = ?").run(id);
}

function resetPassword(id, hash) {
  db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?').run(hash, id);
  db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(id);
  // 与 force-logout 一致：否则已签发的 access token 在过期前仍可用旧密码继续操作
  db.prepare("UPDATE users SET force_logout_at = datetime('now') WHERE id = ?").run(id);
}

function findUserByUsername(username) {
  return db.prepare('SELECT id FROM users WHERE username = ?').get(username);
}

function countSuperAdmins() {
  return db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'su'").get().c;
}

function createUser(username, hash, nickname, role) {
  const newId = db.findNextId('users');
  db.prepare('INSERT INTO users (id, username, password_hash, nickname, role) VALUES (?, ?, ?, ?, ?)').run(newId, username, hash, nickname, role);
  return newId;
}

// 18 条连删必须原子：中途失败（FK 意外/语句错误）不得留下"令牌已吊销而账号仍在"等残缺状态。
// BEGIN→COMMIT 之间全为同步语句、无 await，单连接不会被其他请求串入事务。
function deleteUserCascade(target) {
  try {
    db.exec('BEGIN');
    db.exec('PRAGMA defer_foreign_keys = ON');
    db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(target.id);
    // 清理该用户作为作者/创建者的依赖数据（FK 已开启，需在删除前处理，避免 500）
    db.prepare('DELETE FROM discussion_replies WHERE author_id = ?').run(target.id);
    db.prepare('DELETE FROM discussions WHERE author_id = ?').run(target.id);
    db.prepare('DELETE FROM articles WHERE author_id = ?').run(target.id); // problem_solutions 级联
    db.prepare('DELETE FROM announcements WHERE author_id = ?').run(target.id);
    db.prepare('DELETE FROM problem_sets WHERE creator_id = ?').run(target.id); // items/progress 级联
    db.prepare('UPDATE problems SET created_by = NULL WHERE created_by = ?').run(target.id);
    db.prepare('UPDATE contests SET created_by = NULL WHERE created_by = ?').run(target.id);
    // 清理试卷系统关联数据（exams.creator_id 无 CASCADE 且为 NOT NULL）
    db.prepare('DELETE FROM exam_answers WHERE submission_id IN (SELECT id FROM exam_submissions WHERE exam_id IN (SELECT id FROM exams WHERE creator_id = ?) OR user_id = ?)').run(target.id, target.id);
    db.prepare('DELETE FROM exam_submissions WHERE exam_id IN (SELECT id FROM exams WHERE creator_id = ?) OR user_id = ?').run(target.id, target.id);
    db.prepare('DELETE FROM exam_questions WHERE exam_id IN (SELECT id FROM exams WHERE creator_id = ?)').run(target.id);
    db.prepare('DELETE FROM exams WHERE creator_id = ?').run(target.id);
    db.prepare('DELETE FROM submissions WHERE user_id = ?').run(target.id); // submission_details 级联
    db.prepare('DELETE FROM uploaded_files WHERE user_id = ?').run(target.id);
    // 用户组：成员关系与个人组一并清理（组表间无外键，必须手工收尾）
    // 顺序：先取个人组 id → 清该用户在所有组的成员行 → 每个个人组先清实体绑定（并把
    // 只绑在它上面的实体回退为 public，否则实体停留在 visibility='groups' 却无组可命中 → 实体失踪）→ 再删组行
    const personalGroups = db.prepare("SELECT id FROM groups WHERE kind = 'personal' AND owner_id = ?").all(target.id);
    db.prepare('DELETE FROM user_groups WHERE user_id = ?').run(target.id);
    for (const g of personalGroups) {
      for (const ref of deleteGroupResourceRefs(g.id)) {
        // 表名只来自 RESOURCE_TABLES 固定白名单（resource_type 有 CHECK 约束），不存在注入面
        const table = RESOURCE_TABLES[ref.type];
        // 仍有其它绑定组时保持 visibility='groups'，只有"删完无组可命中"才回退为 public
        if (!table) continue;
        const bound = db.prepare(`SELECT COUNT(*) as c FROM resource_group_access WHERE resource_type = ? AND resource_id = ?`).get(ref.type, ref.id).c;
        if (bound === 0) {
          db.prepare(`UPDATE ${table} SET visibility = 'public' WHERE id = ?`).run(ref.id);
        }
      }
      db.prepare('DELETE FROM groups WHERE id = ?').run(g.id);
    }
    // 10.3: 清理该用户邮箱的验证码记录（防止遗留隐私数据）
    if (target.email) db.prepare('DELETE FROM email_codes WHERE email = ?').run(target.email);
    db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原始错误（外层已 rethrow） */ }
    throw err;
  }
}

// R9-20: 先取待删文件清单（读操作，留在路由层）
function listUserFiles(userId) {
  return db.prepare('SELECT filename FROM uploaded_files WHERE user_id = ?').all(userId);
}

module.exports = {
  countUsers, listRating, listUsers, getProfile, getMe, findEnabledLanguage, updateMe, getMeSettings,
  get, getAdmin, setRating, setHideRating, setSubmitLockExempt, setUploadLimits, setRole,
  ban, unban, forceLogout, resetPassword, findUserByUsername, countSuperAdmins, createUser,
  deleteUserCascade, listUserFiles
};
