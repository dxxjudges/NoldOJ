/**
 * 黑盒: 管理员重置密码后，用户能否用新密码登录（带验证码）
 *
 * 审计修复（CI 假绿）: 原实现步骤 3-6 只 console.log 不断言，结尾无条件
 * process.exit(0)，登录流程坏掉时测试也永远绿。现在每步关键结果都断言，
 * 任一失败 exit(1)。运行前置: 服务已启动 + NoldOJ_CAPTCHA_DEBUG=1（或
 * config/captcha_answers.json 可读）。
 */

const BASE = process.env.BASE || 'http://localhost:3000';
const fs = require('fs');
const path = require('path');

const ANSWERS_FILE = path.join(__dirname, '..', '..', 'config', 'captcha_answers.json');

const failures = [];
function check(cond, msg) {
  if (cond) {
    console.log('    \u2713 ' + msg);
  } else {
    console.error('    \u2717 ' + msg);
    failures.push(msg);
  }
}

function getCaptchaText(captchaId) {
  try {
    const content = fs.readFileSync(ANSWERS_FILE, 'utf8');
    const answers = JSON.parse(content);
    return answers[captchaId] || null;
  } catch {
    return null;
  }
}

async function getCaptcha() {
  const r = await fetch(`${BASE}/api/v1/auth/captcha`);
  const data = await r.json();
  const { id, svg } = data;
  // 优先用 debug 模式响应的 code；否则回退 captcha_answers.json dump；最后解析 <text>（旧版）
  let code = data.code || null;
  if (!code) {
    for (let i = 0; i < 20; i++) {
      code = getCaptchaText(id);
      if (code) break;
      await new Promise(r => setTimeout(r, 50));
    }
  }
  if (!code && svg) {
    const matches = [...svg.matchAll(/<text[^>]*>\s*([^<]+?)\s*<\/text>/g)];
    code = matches.map(m => m[1].trim()).join('') || null;
  }
  return { id, code, svg };
}

async function loginWithCaptcha(username, password) {
  // 登录限流为每 IP 10 次/60s 固定窗口；前序测试（security 的限流用例）会耗尽额度，
  // 这里对 429 等待窗口清空后重试（最多 16×5s=80s，覆盖一个完整窗口）
  for (let attempt = 0; ; attempt++) {
    const captcha = await getCaptcha();
    const res = await fetch(`${BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password,
        captcha_id: captcha.id,
        captcha_code: captcha.code || ''
      })
    });
    if (res.status === 429 && attempt < 16) {
      console.log(`    登录限流 429，等待窗口清空后重试 (${attempt + 1}/16)...`);
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }
    const data = await res.json();
    return { res, data, captcha };
  }
}

async function main() {
  console.log('\n=== 黑盒: 重置密码后登录流程 (带验证码) ===\n');

  // 1. admin 登录
  console.log('[1] admin 登录...');
  const adminLogin = await loginWithCaptcha('admin', 'admin123');
  console.log('    状态:', adminLogin.res.status);
  if (!adminLogin.data.access_token) {
    console.error('admin 登录失败:', adminLogin.data);
    console.error('提示: 需要服务已启动且 NoldOJ_CAPTCHA_DEBUG=1（或 NoldOJ_INIT_ADMIN_PASSWORD=admin123）');
    process.exit(1);
  }
  const token = adminLogin.data.access_token;
  // server.js 的 CSRF 中间件: 带 Bearer/凭据的非 GET 请求必须携带 Origin
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: BASE };
  console.log('    OK\n');

  // 2. 创建测试用户 testreset / Test@123（已存在则复用，并先把口令重置回 Test@123 保证可重复运行）
  console.log('[2] 创建/准备测试用户 testreset...');
  const createUser = await fetch(`${BASE}/api/v1/users`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ username: 'testreset', password: 'Test@123', nickname: 'TestReset' })
  });
  const createData = await createUser.json().catch(() => ({}));
  let userId = createData.user?.id;
  let reused = false;
  if (!userId) {
    const userList = await fetch(`${BASE}/api/v1/users?search=testreset`, { headers: auth });
    const ud = await userList.json().catch(() => ({}));
    userId = ud.users?.find(u => u.username === 'testreset')?.id;
    reused = !!userId;
    console.log('    用户已存在, id:', userId);
  }
  check(!!userId, '测试用户就绪 (id=' + userId + ')');
  if (!userId) {
    console.log('=== 测试终止 ===\n');
    process.exit(1);
  }
  if (reused) {
    const fixRes = await fetch(`${BASE}/api/v1/users/${userId}/reset-password`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ new_password: 'Test@123' })
    });
    console.log('    预置口令重置状态:', fixRes.status);
  }
  console.log();

  // 3. 用原始密码登录（重置前基线）
  console.log('[3] 用原始密码 Test@123 登录（基线）...');
  const origLogin = await loginWithCaptcha('testreset', 'Test@123');
  console.log('    状态:', origLogin.res.status);
  check(!!origLogin.data.access_token, '重置前可用原密码登录');
  console.log();

  // 4. admin 重置密码
  console.log('[4] admin 重置密码为 NewPass@456...');
  const resetRes = await fetch(`${BASE}/api/v1/users/${userId}/reset-password`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ new_password: 'NewPass@456' })
  });
  const resetData = await resetRes.json().catch(() => ({}));
  console.log('    状态:', resetRes.status, resetData);
  check(resetRes.status === 200, '重置密码接口返回 200');
  console.log();

  // 5. 用新密码登录 — 关键断言（原 bug: 重置后无法登录）
  console.log('[5] 用新密码 NewPass@456 登录（关键）...');
  const newPwdLogin = await loginWithCaptcha('testreset', 'NewPass@456');
  console.log('    状态:', newPwdLogin.res.status);
  check(!!newPwdLogin.data.access_token, '重置后新密码可登录');
  console.log();

  // 6. 模拟前端: 错误密码消耗验证码后，刷新验证码重试
  console.log('[6] 错误密码 → 验证码消耗 → 新验证码 + 新密码重试...');
  const wrongLogin = await loginWithCaptcha('testreset', 'WrongPassword');
  console.log('    错误密码状态:', wrongLogin.res.status, wrongLogin.data.message || '');
  check(!wrongLogin.data.access_token, '错误密码被拒绝且不发 token');
  const retryLogin = await loginWithCaptcha('testreset', 'NewPass@456');
  console.log('    重试状态:', retryLogin.res.status, retryLogin.data.message || '');
  check(!!retryLogin.data.access_token, '消耗验证码后换新验证码重试成功');
  console.log();

  // 清理（尽力而为，不参与断言）
  console.log('[清理] 删除测试用户...');
  const del = await fetch(`${BASE}/api/v1/users/${userId}`, { method: 'DELETE', headers: auth });
  console.log('    删除状态:', del.status);

  console.log(`=== 结果: ${failures.length === 0 ? '全部通过' : failures.length + ' 项失败: ' + failures.join('; ')} ===\n`);
  process.exit(failures.length ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
