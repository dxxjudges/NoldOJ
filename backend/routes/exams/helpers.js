// routes/exams/helpers.js —— 试卷路由共用纯函数（不碰 db）
function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// 规范化答案（支持判断题 T/F、对/错、1/0、正确/错误）
function normalizeAnswer(type, val) {
  const s = String(val ?? '').trim().toLowerCase();
  if (type === 'true_false') {
    if (['true', 't', '1', '正确', '对', 'v', '√', 'yes', 'y'].includes(s)) return 'true';
    if (['false', 'f', '0', '错误', '错', 'x', '×', 'no', 'n'].includes(s)) return 'false';
  }
  return s;
}

module.exports = { clampInt, normalizeAnswer };
