// services/notifications.js —— 通知投递（落库 + Socket 实时推送）
// 各业务域只调用本模块，不直接拼 notifications 表 / socket 事件。
const repo = require('../repositories/notifications');
const { emitNotification } = require('./socket');

// 给单个用户发通知；失败不影响调用方主流程（通知是尽力而为的旁路）
function notifyUser(userId, { type = 'system', title, content = '', link = '' }) {
  if (!userId || !title) return null;
  try {
    const result = repo.insert(userId, type, title, content, link);
    const row = repo.getById(result.lastInsertRowid, userId);
    if (row) emitNotification(userId, row);
    return row;
  } catch {
    return null;
  }
}

// 给全体用户发通知（公告/系统广播）：只落库，在线用户已由 emitAnnouncement 收到公告事件
function notifyAllUsers({ type = 'system', title, content = '', link = '' }) {
  if (!title) return;
  try {
    repo.insertAllUsers(type, title, content, link);
  } catch {
    // 批量通知失败不影响公告创建
  }
}

module.exports = { notifyUser, notifyAllUsers };
