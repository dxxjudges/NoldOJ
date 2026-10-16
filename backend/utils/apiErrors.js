// 统一 404 响应（审计 P2: 未找到错误码字面量常量化，全库仅此处出现该码）。
// 响应体结构与历史实现逐字一致: { code: 3, reason: <未找到错误码>, message }。
function sendNotFound(res, message = 'Not found.') {
  return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message });
}

// 统一 403 响应：与 requireRole / utils/visibility.js 的错误体同构
// （code 6 / ERR_FORBIDDEN），供用户组与实体可见性门禁复用，避免各路由各写一份字面量。
function sendForbidden(res, message = 'Insufficient permissions.') {
  return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message });
}

module.exports = { sendNotFound, sendForbidden };
