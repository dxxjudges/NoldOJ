/**
 * Excel 导入示例文件回归测试
 *
 * 站内三处 Excel 导入各自带一份示例/模板文件（frontend/pages/*.xlsx，由
 * express.static(pagesRoot) 以根路径 /xxx-sample.xlsx 提供）：
 *   - exam-sample.xlsx  → 试卷题目导入（frontend/js/exam-import.js 的 parseRows）
 *   - user-sample.xlsx  → 用户批量导入（frontend/js/admin.js 的 handleExcelImport 表头映射）
 *   - group-sample.xlsx → 用户组成员导入（frontend/js/admin.js 的 handleUserGroupImportFile 表头映射）
 *
 * 本测试确保示例文件不会与解析器脱节：解析器改了列名/规则而示例文件没跟上时
 * 立即失败，而不是等用户在管理面板导入失败才发现。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// SheetJS 官方浏览器构建在 node 下需极简垫片（其初始化会探测 window/document）
global.window = global;
global.self = global;
global.navigator = { userAgent: 'node' };
global.document = { createElement: () => ({}), documentElement: {} };
const X = require('../../frontend/js/xlsx.full.min.js');
const examImport = require('../../frontend/js/exam-import.js');
const { isStrongPassword } = require('../utils/validation');

const PAGES = path.join(__dirname, '..', '..', 'frontend', 'pages');

function readWorkbook(file) {
  const wb = X.read(fs.readFileSync(path.join(PAGES, file)), { type: 'buffer' });
  return { wb, sheets: wb.SheetNames };
}
function sheetRows(wb, name) {
  return X.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: false });
}

// 与 frontend/js/admin.js handleExcelImport 中 HEADER_ALIAS / ROLE_ALIAS 保持一致
const HEADER_ALIAS = {
  username: 'username', '用户名': 'username', '账号': 'username',
  password: 'password', '密码': 'password', '初始密码': 'password',
  nickname: 'nickname', '昵称': 'nickname', '姓名': 'nickname',
  role: 'role', '角色': 'role', '权限': 'role'
};
const ROLE_ALIAS = {
  user: 'user', teacher: 'teacher', admin: 'admin', su: 'su',
  '用户': 'user', '学生': 'user', '教师': 'teacher', '老师': 'teacher',
  '管理员': 'admin', '超级管理员': 'su'
};
// 与 frontend/js/admin.js USER_GROUP_HEADER_ALIAS 保持一致
const GROUP_HEADER_ALIAS = {
  username: 'username', '用户名': 'username', '账号': 'username',
  nickname: 'nickname', '昵称': 'nickname', '姓名': 'nickname'
};
const GROUP_USERNAME_RE = /^[a-zA-Z0-9_.-]+$/;

test('exam-sample.xlsx 可被试卷题目解析器完整解析', () => {
  const { wb, sheets } = readWorkbook('exam-sample.xlsx');
  // 两个导入器都只读 SheetNames[0]，示例文件必须把数据表放在第一个 sheet
  assert.ok(sheets.length >= 2, '应同时包含数据表与填写说明表');
  assert.ok(sheets.includes('填写说明'), '缺少「填写说明」工作表');

  const rows = sheetRows(wb, sheets[0]);
  const parsed = examImport.parseRows(rows);
  assert.deepStrictEqual(parsed.errors, [], '示例文件不应产生解析错误');
  assert.ok(parsed.questions.length >= 3, `示例题目过少：${parsed.questions.length}`);

  // 表头与解析器导出的 HEADER 一致（列名漂移会在这里被抓住）
  const head = rows[0].map(c => String(c).trim());
  assert.deepStrictEqual(head.slice(0, examImport.HEADER.length), examImport.HEADER,
    '示例文件表头与 exam-import.js 的 HEADER 不一致');

  // 覆盖四种题型（枚举与 exam-import.js 的 TYPE_ALIAS 一致），且客观题必须有正确答案
  const types = new Set(parsed.questions.map(q => q.question_type));
  for (const t of ['choice', 'true_false', 'fill_blank', 'long_answer']) {
    assert.ok(types.has(t), `示例缺少题型 ${t}`);
  }
  parsed.questions.filter(q => q.question_type !== 'long_answer').forEach(q => {
    assert.ok(q.correct_answer, `客观题缺少正确答案：${q.title}`);
  });
  parsed.questions.forEach(q => {
    assert.ok(Number(q.score) >= 0, '分值应为非负数');
  });
});

test('user-sample.xlsx 可被用户导入表头映射解析', () => {
  const { wb, sheets } = readWorkbook('user-sample.xlsx');
  assert.ok(sheets.includes('填写说明'), '缺少「填写说明」工作表');

  const rows = sheetRows(wb, sheets[0]);
  const head = rows[0].map(c => String(c).trim().toLowerCase());
  const recognized = head.some(h => HEADER_ALIAS[h]);
  assert.ok(recognized, '首行表头未被识别，导入器会退化为无表头模式');

  const map = {};
  head.forEach((h, i) => { if (HEADER_ALIAS[h]) map[HEADER_ALIAS[h]] = i; });
  assert.notStrictEqual(map.username, undefined, '缺少「用户名」列');
  assert.notStrictEqual(map.password, undefined, '缺少「密码」列');

  const users = rows.slice(1)
    .map(r => ({
      username: String(r[map.username] ?? '').trim(),
      password: String(r[map.password] ?? '').trim(),
      nickname: map.nickname !== undefined ? String(r[map.nickname] ?? '').trim() : '',
      role: ROLE_ALIAS[String(r[map.role] ?? '').trim()] || 'user'
    }))
    .filter(u => u.username && u.password);
  assert.ok(users.length >= 2, `示例账号过少：${users.length}`);

  for (const u of users) {
    assert.match(u.username, /^[a-zA-Z0-9_.-]+$/, `示例用户名不合法：${u.username}`);
    assert.ok(isStrongPassword(u.password), `示例密码不满足强度要求：${u.username}`);
    assert.ok(['user', 'teacher', 'admin', 'su'].includes(u.role), `示例角色非法：${u.role}`);
  }
  // 至少演示两种角色，且不出现默认 user 之外的意外角色混用
  const roles = new Set(users.map(u => u.role));
  assert.ok(roles.size >= 2, '示例应覆盖至少两种角色');

  // 填写说明必须覆盖全部四列
  const readme = sheetRows(wb, sheets.find(s => s === '填写说明')).map(r => String(r[0] || '').trim());
  for (const col of ['用户名', '密码', '昵称', '角色']) {
    assert.ok(readme.includes(col), `填写说明缺少「${col}」行`);
  }
});

test('group-sample.xlsx 可被用户组导入表头映射解析', () => {
  const { wb, sheets } = readWorkbook('group-sample.xlsx');
  // 导入器只读 SheetNames[0]，数据表必须排在第一个
  assert.ok(sheets.length >= 2, '应同时包含数据表与填写说明表');
  assert.strictEqual(sheets[0], '用户组导入', '第一个 sheet 必须是数据表「用户组导入」');
  assert.ok(sheets.includes('填写说明'), '缺少「填写说明」工作表');

  const rows = sheetRows(wb, sheets[0]);
  const head = rows[0].map(c => String(c).trim().toLowerCase());
  const recognized = head.some(h => GROUP_HEADER_ALIAS[h]);
  assert.ok(recognized, '首行表头未被识别，导入器会退化为无表头模式');

  const map = {};
  head.forEach((h, i) => { if (GROUP_HEADER_ALIAS[h]) map[GROUP_HEADER_ALIAS[h]] = i; });
  assert.notStrictEqual(map.username, undefined, '缺少「用户名」列');
  assert.notStrictEqual(map.nickname, undefined, '缺少「昵称」列');

  // 与 admin.js handleUserGroupImportFile 的行级清洗一致：去空行、去重（保留首次）
  const users = rows.slice(1)
    .map(r => ({
      username: String(r[map.username] ?? '').trim(),
      nickname: String(r[map.nickname] ?? '').trim()
    }))
    .filter(u => u.username);
  assert.ok(users.length >= 3, `示例行过少：${users.length}`);
  assert.strictEqual(new Set(users.map(u => u.username)).size, users.length, '示例用户名重复');
  for (const u of users) {
    assert.match(u.username, GROUP_USERNAME_RE, `示例用户名不合法：${u.username}`);
  }
  // 至少一条「尚不存在、导入时自动注册」的示例账号，且昵称列体现该用途
  assert.ok(users.some(u => /新同学|注册/.test(u.nickname)), '缺少体现自动注册用途的示例行');

  // 填写说明必须覆盖两列 + 导入器的关键约定
  const readmeRows = sheetRows(wb, sheets.find(s => s === '填写说明'));
  const readmeKeys = readmeRows.map(r => String(r[0] || '').trim());
  for (const col of ['用户名', '昵称']) {
    assert.ok(readmeKeys.includes(col), `填写说明缺少「${col}」行`);
  }
  const readmeText = readmeRows.map(r => r.map(c => String(c || '')).join(' ')).join('\n');
  for (const kw of ['自动注册', '默认密码', '去重', '超级管理员', '系统组', '失败']) {
    assert.ok(readmeText.includes(kw), `填写说明未覆盖「${kw}」`);
  }
});