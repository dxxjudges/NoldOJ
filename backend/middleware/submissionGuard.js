const config = require('../config/config');

// 代码提交总开关（超管可热切换）：关闭后判题提交与 IDE 运行/审查一律拒绝。
// 放在 requireAuth 之后，未登录请求仍先得到 401，不泄露开关状态。
function requireSubmissionsEnabled(req, res, next) {
  if (config.submission.enabled) return next();
  return res.status(403).json({
    code: 2,
    reason: 'ERR_SUBMISSION_DISABLED',
    message: '代码提交已被管理员暂时关闭，请稍后再试。'
  });
}

module.exports = { requireSubmissionsEnabled };
