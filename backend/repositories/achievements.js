// repositories/achievements.js —— 成就域数据访问层（P1：db.prepare 不再散落在路由层）
const db = require('../database/db');

// 隐藏开关读取（成就列表接口的隐私校验）
function getUserAchievementPrivacy(targetId) {
  return db.prepare('SELECT id, hide_achievements FROM users WHERE id = ?').get(targetId);
}

function listAchievements() {
  return db.prepare('SELECT * FROM achievements ORDER BY id').all();
}

function listUserAchievements(userId) {
  return db.prepare('SELECT achievement_id, unlocked_at FROM user_achievements WHERE user_id = ?').all(userId);
}

module.exports = { getUserAchievementPrivacy, listAchievements, listUserAchievements };
