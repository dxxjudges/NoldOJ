// services/messages.js —— 私信投递（落库 + Socket 实时推送）
const repo = require('../repositories/messages');
const { emitMessage } = require('./socket');

// 发送私信：落库后推给接收者与发送者的 user 房间（发送者多标签页同步，前端按 id 去重）
// 返回持久化后的完整消息行；失败抛错由调用方转成 API 错误。
function sendMessage(senderId, receiverId, content) {
  const result = repo.insert(senderId, receiverId, content);
  const row = repo.getById(result.lastInsertRowid);
  if (row) {
    emitMessage(row.receiver_id, row);
    emitMessage(row.sender_id, row);
  }
  return row;
}

module.exports = { sendMessage };
