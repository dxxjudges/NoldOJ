// 作业时间窗（纯函数，无数据库依赖）
// 与试卷不同：开始/截止时间允许只设其一（作业通常只设截止时间）。
// 时间统一 ISO8601（UTC）存储；null=不限。
const { normalizeExamTime } = require('./examWindow');

function normalizeHomeworkTime(v) {
  return normalizeExamTime(v);
}

// 同时设置时必须「截止晚于开始」；只设其一时始终合法
function validateHomeworkWindow(start, end) {
  if (start !== null && end !== null && Date.parse(end) <= Date.parse(start)) {
    throw new Error('截止时间必须晚于开始时间。');
  }
}

// 窗口状态：null=未设时间窗；'not_started' | 'running' | 'ended'
function homeworkWindowState(homework, nowMs = Date.now()) {
  const s = homework.start_time ? Date.parse(homework.start_time) : NaN;
  const e = homework.end_time ? Date.parse(homework.end_time) : NaN;
  if (Number.isNaN(s) && Number.isNaN(e)) return null;
  if (!Number.isNaN(s) && nowMs < s) return 'not_started';
  if (!Number.isNaN(e) && nowMs > e) return 'ended';
  return 'running';
}

// 时间窗门禁：开考前/截止后禁止作答（教师/管理员放行）；返回 403 文案或 null
function checkHomeworkWindow(homework, user, nowMs = Date.now()) {
  const state = homeworkWindowState(homework, nowMs);
  if (!state || state === 'running') return null;
  if (user && ['teacher', 'admin', 'su'].includes(user.role)) return null;
  return state === 'not_started' ? '作业尚未开始。' : '作业已截止。';
}

module.exports = {
  normalizeHomeworkTime,
  validateHomeworkWindow,
  homeworkWindowState,
  checkHomeworkWindow
};
