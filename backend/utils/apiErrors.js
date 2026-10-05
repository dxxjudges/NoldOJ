// 统一 404 响应（审计 P2: 未找到错误码字面量常量化，全库仅此处出现该码）。
// 响应体结构与历史实现逐字一致: { code: 3, reason: <未找到错误码>, message }。
function sendNotFound(res, message = 'Not found.') {
  return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message });
}

module.exports = { sendNotFound };
