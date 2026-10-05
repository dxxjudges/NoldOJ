/**
 * frontend/js/api.js —— 全站共用的前端运行时（导航渲染 / 请求封装 / toast / 分页 / 工具函数）
 *
 * 重点覆盖：
 *  1) 无障碍（aria）：renderNav 产出的导航语义、当前页标记、移动菜单折叠态、修改密码模态；
 *  2) 安全：escapeHtml 覆盖引号（属性上下文 XSS）、renderNav 对昵称的转义、
 *     showToast 以 textContent 落文本（此前 87 处 alert → showToast 迁移的回归护栏）；
 *  3) 纯函数：statusText / statusColor / roleBadge / localInputToIso；
 *  4) 轻量 DOM 交互：toggleMobileMenu 同步 aria-expanded、未读公告角标、renderPagination。
 *
 * 加载方式见 ./_frontend-harness.js：脚本顶层就访问 document/localStorage，
 * 不能直接 require，故在 vm 沙箱 + 最小 DOM 桩里求值。
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadScript, FakeElement, textOf, findById } = require('./_frontend-harness');

/** 每个用例用独立沙箱加载，避免 let/单例状态串味 */
function fresh(opts) { return loadScript('api.js', opts); }

/** 取出所有 aria-* 属性的 name=value 列表 */
function ariaAttrs(html) {
  const out = [];
  const re = /(aria-[a-z]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1] + '=' + m[2]);
  return out;
}

/** 取出所有 role="..." 的值 */
function roles(html) {
  return (html.match(/role="[^"]*"/g) || []).map((s) => s.slice(6, -1));
}

describe('api.js escapeHtml', () => {
  it('转义 5 个 HTML 元字符（含引号）', () => {
    const { escapeHtml } = fresh();
    assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  });

  it('null / undefined / 数字安全处理', () => {
    const { escapeHtml } = fresh();
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(''), '');
    assert.equal(escapeHtml(0), '0');
    assert.equal(escapeHtml(123), '123');
  });

  it('引号转义阻断属性闭合（存储型 XSS 护栏）', () => {
    const { escapeHtml } = fresh();
    assert.equal(
      escapeHtml('a" onmouseover="alert(1)'),
      'a&quot; onmouseover=&quot;alert(1)'
    );
  });

  it('& 先于其它实体转义，不会二次编码', () => {
    const { escapeHtml } = fresh();
    assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  });
});

describe('api.js 状态与角色映射', () => {
  it('statusText 覆盖全部评测状态', () => {
    const { statusText } = fresh();
    assert.equal(statusText('accepted'), '通过');
    assert.equal(statusText('wrong_answer'), '答案错误');
    assert.equal(statusText('time_limit_exceeded'), '时间超限');
    assert.equal(statusText('memory_limit_exceeded'), '内存超限');
    assert.equal(statusText('runtime_error'), '运行错误');
    assert.equal(statusText('compile_error'), '编译错误');
    assert.equal(statusText('system_error'), '系统错误');
    assert.equal(statusText('pending'), '等待中');
    assert.equal(statusText('judging'), '评测中');
    assert.equal(statusText('skipped'), '已跳过');
  });

  it('statusText 未知状态原样返回（不吞信息）', () => {
    const { statusText } = fresh();
    assert.equal(statusText('weird_status'), 'weird_status');
  });

  it('statusColor 已知状态返回色板类，未知回落到灰色', () => {
    const { statusColor } = fresh();
    assert.ok(statusColor('accepted').includes('text-green-600'));
    assert.ok(statusColor('wrong_answer').includes('text-red-600'));
    assert.ok(statusColor('time_limit_exceeded').includes('text-orange-600'));
    assert.ok(statusColor('memory_limit_exceeded').includes('text-purple-600'));
    assert.ok(statusColor('compile_error').includes('text-yellow-600'));
    const fallback = statusColor('nope');
    assert.ok(fallback.includes('text-gray-600'), fallback);
    assert.equal(fallback, statusColor(undefined));
  });

  it('roleBadge 四种角色有徽章，未知角色返回空串', () => {
    const { roleBadge } = fresh();
    for (const [role, kw] of [['user', '用户'], ['teacher', '教师'], ['admin', '管理员'], ['su', '超级管理员']]) {
      const html = roleBadge(role);
      assert.ok(html.startsWith('<span class='), role);
      assert.ok(html.includes(kw), role + ' → ' + kw);
    }
    assert.equal(roleBadge('guest'), '');
    assert.equal(roleBadge(undefined), '');
  });
});

describe('api.js localInputToIso', () => {
  it('datetime-local 值转 ISO8601（UTC），且与本地墙钟时刻一致', () => {
    const { localInputToIso } = fresh();
    for (const v of ['2024-03-05T10:30', '2026-12-31T23:59', '2024-01-01T00:00']) {
      const iso = localInputToIso(v);
      assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, v + ' → ' + iso);
      // 时区无关断言：转成毫秒后应等于 Date.parse 的本地墙钟毫秒
      assert.equal(Date.parse(iso), Date.parse(v), v);
    }
  });

  it('空值 / 非法值返回 null（而非 Invalid Date）', () => {
    const { localInputToIso } = fresh();
    assert.equal(localInputToIso(''), null);
    assert.equal(localInputToIso(null), null);
    assert.equal(localInputToIso(undefined), null);
    assert.equal(localInputToIso('not-a-date'), null);
  });
});

describe('api.js renderNav: 无障碍语义', () => {
  it('导航容器带 role=navigation 与中文 aria-label', () => {
    const { renderNav } = fresh();
    const nav = renderNav('problems');
    assert.ok(nav.includes('<nav role="navigation" aria-label="主导航"'), '主导航应声明 role/label');
    assert.ok(nav.includes('id="mobileMenu" role="navigation" aria-label="移动导航"'), '移动导航应独立命名');
  });

  it('活动项带 aria-current="page"，非活动项不带', () => {
    const { renderNav } = fresh();
    const nav = renderNav('problems');
    // 桌面 + 移动两处导航各标记一次
    assert.equal((nav.match(/aria-current="page"/g) || []).length, 2);
    const marked = /aria-current="page"[\s\S]{0,200}?>([^<]*)</.exec(nav.replace(/<a [^>]*aria-current="page"[^>]*>/g, ''));
    assert.ok(marked === null || marked[1].length > 0);
    // 题库被标记，而“提交记录”没有
    const problemLink = /<a href="\/pages\/problems\.html"[^>]*>题库<\/a>/.exec(nav);
    assert.ok(problemLink, '应存在题库链接');
    assert.ok(problemLink[0].includes('aria-current="page"'), problemLink[0]);
    const otherLink = /<a href="\/pages\/submissions\.html"[^>]*>提交记录<\/a>/.exec(nav);
    assert.ok(otherLink && !otherLink[0].includes('aria-current'), '非活动项不应带 aria-current');
  });

  it('aria-current 只落在 activePage 上：换页后标记跟着换', () => {
    const { renderNav } = fresh();
    const nav = renderNav('submissions');
    const subLink = /<a href="\/pages\/submissions\.html"[^>]*>提交记录<\/a>/.exec(nav);
    assert.ok(subLink[0].includes('aria-current="page"'), subLink[0]);
    const probLink = /<a href="\/pages\/problems\.html"[^>]*>题库<\/a>/.exec(nav);
    assert.ok(!probLink[0].includes('aria-current'));
  });

  it('activePage 为空/未知时不误标任何项', () => {
    const { renderNav } = fresh();
    assert.equal((renderNav('').match(/aria-current="page"/g) || []).length, 0);
    assert.equal((renderNav('no-such-page').match(/aria-current="page"/g) || []).length, 0);
  });

  it('移动菜单折叠按钮带 aria-expanded 与 aria-controls', () => {
    const { renderNav } = fresh();
    const nav = renderNav('index');
    const btn = /<button id="mobileMenuBtn"[^>]*>/.exec(nav);
    assert.ok(btn, '应存在移动菜单按钮');
    assert.ok(btn[0].includes('aria-expanded="false"'), btn[0]);
    assert.ok(btn[0].includes('aria-controls="mobileMenu"'), btn[0]);
    assert.ok(btn[0].includes('aria-label="切换导航菜单"'), btn[0]);
  });

  it('纯图标按钮补了中文 aria-label（主题切换 / 公告）', () => {
    const { renderNav } = fresh();
    const nav = renderNav('index');
    assert.ok(/<button onclick="toggleDarkMode\(\)" aria-label="切换深色模式"/.test(nav), '主题切换按钮');
    assert.ok(/<a href="\/pages\/announcements\.html" onclick="clearAnnouncementUnread\(\)" aria-label="公告"/.test(nav), '公告铃铛');
  });

  it('修改密码模态声明 dialog + aria-modal，标题被 aria-labelledby 关联', () => {
    const { renderNav } = fresh();
    const nav = renderNav('index');
    assert.ok(nav.includes('<div id="passwordModal" role="dialog" aria-modal="true" aria-labelledby="passwordModalTitle"'), nav.slice(0, 200));
    assert.ok(nav.includes('<h3 id="passwordModalTitle"'), '应有模态标题元素');
    // 关联的 id 必须真实存在，否则读屏软件取不到名字
    const ref = /aria-labelledby="([^"]+)"/.exec(nav)[1];
    assert.ok(nav.includes(`id="${ref}"`), 'aria-labelledby 指向的 id 必须存在: ' + ref);
  });

  it('模态内两个密码输入框有 aria-label（placeholder 不是可访问名）', () => {
    const { renderNav } = fresh();
    const nav = renderNav('index');
    assert.ok(/id="oldPwd"[^>]*aria-label="当前密码"/.test(nav));
    assert.ok(/id="newPwd"[^>]*aria-label="新密码"/.test(nav));
  });

  it('aria 属性无重复声明冲突（同一元素同名 aria-* 只出现一次）', () => {
    const { renderNav } = fresh();
    const nav = renderNav('admin');
    for (const tag of nav.match(/<(nav|button|a|div|span|input|h3)\b[^>]*>/g) || []) {
      for (const name of ['aria-label', 'aria-current', 'aria-expanded', 'aria-modal', 'aria-labelledby', 'aria-controls']) {
        const n = (tag.match(new RegExp(name + '\\s*=', 'g')) || []).length;
        assert.ok(n <= 1, tag.slice(0, 160) + ' 内 ' + name + ' 出现 ' + n + ' 次');
      }
    }
  });

  it('导航区只出现预期的 role 取值（不引入无意义 role）', () => {
    const { renderNav } = fresh();
    const nav = renderNav('admin');
    const seen = new Set(roles(nav));
    assert.deepEqual(Array.from(seen).sort(), ['dialog', 'navigation']);
    // aria-* 取值一律为语义名，不出现布尔/空值
    for (const pair of ariaAttrs(nav)) {
      assert.ok(/=[^\s]+$/.test(pair), pair + ' 的取值不应为空');
    }
  });
});

describe('api.js renderNav: 角色可见性与内容安全', () => {
  // api.js 的 localStorage 键名：'user' / 'access_token'（非 NoldOJ_ 前缀）
  const userKey = (role, nickname = 'n') => ({ user: JSON.stringify({ id: 1, username: 'u', role, nickname }) });
  function navAs(role) {
    return fresh({ storage: userKey(role) });
  }

  it('未登录只给登录/注册入口，不泄露昵称区', () => {
    const { renderNav } = fresh();
    const nav = renderNav('index');
    assert.ok(nav.includes('>登录</a>'));
    assert.ok(nav.includes('>注册</a>'));
    assert.ok(!nav.includes('id="nav-rating"'), '未登录不应出现评分徽章');
    assert.ok(!nav.includes('>退出</button>'));
  });

  it('普通用户看不到教师专属入口（管理/图床）与超管入口（语言）', () => {
    const { renderNav } = navAs('user');
    const nav = renderNav('admin');
    assert.ok(!nav.includes('/pages/admin.html'), '普通用户不应有管理入口');
    assert.ok(!nav.includes('/pages/upload.html'), '普通用户不应有图床入口');
    assert.ok(!nav.includes('/pages/languages.html'), '普通用户不应有语言入口');
  });

  it('教师可见管理/图航入口，但仍看不到语言入口', () => {
    const { renderNav } = navAs('teacher');
    const nav = renderNav('index');
    assert.ok(nav.includes('/pages/admin.html'), '教师应有管理入口');
    assert.ok(nav.includes('/pages/upload.html'), '教师应有图床入口');
    assert.ok(!nav.includes('/pages/languages.html'), '教师不应有语言入口');
  });

  it('su 可见全部入口（含语言）', () => {
    const { renderNav } = navAs('su');
    const nav = renderNav('index');
    assert.ok(nav.includes('/pages/languages.html'));
    assert.ok(nav.includes('/pages/admin.html'));
    assert.ok(nav.includes('/pages/upload.html'));
  });

  it('admin 视为教师（可见管理/图床），但非 su', () => {
    const { renderNav } = navAs('admin');
    const nav = renderNav('index');
    assert.ok(nav.includes('/pages/admin.html'));
    assert.ok(!nav.includes('/pages/languages.html'));
  });

  it('已登录时展示昵称与评分徽章', () => {
    const api = navAs('user');
    api.setUser({ id: 1, username: 'u', nickname: '小明', role: 'user', rating: 1720 });
    const nav = api.renderNav('index');
    assert.ok(nav.includes('小明'));
    assert.ok(nav.includes('R:1720'), '评分徽章');
    assert.ok(nav.includes('>退出</button>'));
  });

  it('昵称中的 HTML 被转义（导航区存储型 XSS 护栏）', () => {
    const api = fresh();
    api.setUser({ id: 1, username: 'u', nickname: '<img src=x onerror=alert(1)>', role: 'user' });
    const nav = api.renderNav('index');
    assert.ok(!nav.includes('<img src=x onerror'), '昵称不得原样插入: ');
    assert.ok(nav.includes('&lt;img src=x onerror=alert(1)&gt;'), nav.slice(nav.indexOf('onerror') - 80, nav.indexOf('onerror') + 60));
  });

  it('用户名含引号时属性不被闭合', () => {
    const api = fresh();
    api.setUser({ id: 1, username: 'a" autofocus onfocus="alert(1)', nickname: 'n', role: 'user' });
    const nav = api.renderNav('index');
    assert.ok(!nav.includes('onfocus="alert(1)"'), '不应产生真实事件属性');
  });

  it('renderNav 抛错时降级为最小导航，且仍带导航语义', () => {
    const api = fresh();
    const orig = api.getUser;
    api.getUser = () => { throw new Error('boom'); };
    const nav = api.renderNav('index');
    api.getUser = orig;
    assert.ok(nav.includes('<nav role="navigation" aria-label="主导航"'), nav);
    assert.ok(nav.includes('NoldOJ'));
  });
});

describe('api.js showToast: 迁移护栏', () => {
  it('消息以 textContent 落文本，不走 innerHTML', () => {
    const api = fresh();
    const payload = '<img src=x onerror=alert(1)>';
    api.showToast(payload, 'error');
    const box = findById(api.__dom.document.body, 'toastContainer');
    assert.ok(box, '应创建 toastContainer');
    assert.equal(box.children.length, 1);
    const toast = box.children[0];
    assert.equal(toast.textContent, payload, '原文应作为纯文本保留');
    assert.equal(toast.innerHTML, '', '不得用 innerHTML 注入（会打开 XSS 面）');
  });

  it('四种类型映射到对应底色，未知类型回落 info', () => {
    const cases = [['info', 'bg-indigo-600'], ['success', 'bg-green-600'], ['warning', 'bg-yellow-600'], ['error', 'bg-red-600']];
    for (const [type, cls] of cases) {
      const api2 = fresh();
      api2.showToast('m', type);
      const box = findById(api2.__dom.document.body, 'toastContainer');
      assert.ok(box.children[0].className.includes(cls), type + ' → ' + cls);
    }
    const api3 = fresh();
    api3.showToast('m', 'no-such-type');
    const box = findById(api3.__dom.document.body, 'toastContainer');
    assert.ok(box.children[0].className.includes('bg-indigo-600'));
  });

  it('消息里的换行通过 pre-line 保留显示', () => {
    const api = fresh();
    api.showToast('line1\nline2');
    const box = findById(api.__dom.document.body, 'toastContainer');
    assert.equal(box.children[0].style.whiteSpace, 'pre-line');
  });

  it('已有 toastContainer 时复用而非重复创建', () => {
    const container = new FakeElement('div');
    container.setAttribute('id', 'toastContainer');
    const api = fresh({ elements: { toastContainer: container } });
    api.showToast('a');
    api.showToast('b');
    assert.equal(container.children.length, 2);
  });

  it('toast 挂起后由定时器移除（4s 消失动画）', () => {
    const api = fresh();
    api.showToast('m');
    assert.equal(api.__dom.timers.timeout, 1, '应挂一个消失定时器');
  });
});

describe('api.js 公告未读角标', () => {
  function withBadge(unread) {
    const badge = new FakeElement('span');
    badge.setAttribute('id', 'annBadge');
    badge.classList.add('hidden');
    return fresh({
      elements: { annBadge: badge },
      storage: { NoldOJ_ann_unread: String(unread) },
    });
  }

  it('未读数 >0 时展示，超过 99 显示 99+', () => {
    const badgeEl = new FakeElement('span');
    badgeEl.setAttribute('id', 'annBadge');
    badgeEl.classList.add('hidden');
    const api = withBadge(5);
    api.updateAnnouncementBadge();
    assert.equal(textOf(findById(api.__dom.document.body, 'annBadge')), '5');
    assert.ok(!findById(api.__dom.document.body, 'annBadge').classList.contains('hidden'));

    const api2 = withBadge(150);
    api2.updateAnnouncementBadge();
    assert.equal(textOf(findById(api2.__dom.document.body, 'annBadge')), '99+');
  });

  it('未读数为 0 时隐藏角标', () => {
    const api = withBadge(0);
    api.updateAnnouncementBadge();
    assert.ok(findById(api.__dom.document.body, 'annBadge').classList.contains('hidden'));
  });

  it('clearAnnouncementUnread 归零并落 storage', () => {
    const api = withBadge(7);
    api.clearAnnouncementUnread();
    assert.equal(api.localStorage.getItem('NoldOJ_ann_unread'), '0');
    assert.ok(findById(api.__dom.document.body, 'annBadge').classList.contains('hidden'));
  });
});

describe('api.js toggleMobileMenu: aria-expanded 同步', () => {
  function withMenu(hidden) {
    const btn = new FakeElement('button');
    btn.setAttribute('id', 'mobileMenuBtn');
    btn.setAttribute('aria-expanded', 'false');
    const menu = new FakeElement('div');
    menu.setAttribute('id', 'mobileMenu');
    if (hidden) menu.classList.add('hidden');
    return fresh({ elements: { mobileMenuBtn: btn, mobileMenu: menu } });
  }

  it('展开菜单时 aria-expanded 同步为 true', () => {
    const api = withMenu(true);
    api.toggleMobileMenu();
    const btn = findById(api.__dom.document.body, 'mobileMenuBtn');
    const menu = findById(api.__dom.document.body, 'mobileMenu');
    assert.ok(!menu.classList.contains('hidden'), '菜单应展开');
    assert.equal(btn.getAttribute('aria-expanded'), 'true');
  });

  it('收起菜单时 aria-expanded 同步为 false', () => {
    const api = withMenu(false);
    api.toggleMobileMenu();
    const btn = findById(api.__dom.document.body, 'mobileMenuBtn');
    assert.equal(btn.getAttribute('aria-expanded'), 'false');
  });

  it('重复切换后 aria-expanded 与实际 class 状态一致', () => {
    const api = withMenu(true);
    const btn = findById(api.__dom.document.body, 'mobileMenuBtn');
    const menu = findById(api.__dom.document.body, 'mobileMenu');
    for (let i = 0; i < 4; i++) api.toggleMobileMenu();
    assert.equal(btn.getAttribute('aria-expanded'), String(!menu.classList.contains('hidden')));
  });

  it('菜单元素缺失时不抛错', () => {
    const api = fresh();
    assert.doesNotThrow(() => api.toggleMobileMenu());
  });
});

describe('api.js renderPagination', () => {
  function container() {
    const el = new FakeElement('div');
    el.setAttribute('id', 'pg');
    return el;
  }

  it('总页数为 0 或 1 时不渲染任何按钮', () => {
    for (const total of [0, 1]) {
      const el = container();
      fresh({ elements: { pg: el } }).renderPagination('pg', total, 1, 'load');
      assert.equal(el.innerHTML, '', 'total=' + total);
    }
  });

  it('页码窗口为当前页 ±2，超出部分用省略号', () => {
    const el = container();
    fresh({ elements: { pg: el } }).renderPagination('pg', 20, 10, 'load');
    assert.ok(el.innerHTML.includes('>8</button>'));
    assert.ok(el.innerHTML.includes('>12</button>'));
    assert.ok(el.innerHTML.includes('>...</span>'), '应出现省略号');
    assert.ok(el.innerHTML.includes('>20</button>'), '应直达末页');
  });

  it('当前页按钮被高亮，且带 aria-current="page"', () => {
    const el = container();
    fresh({ elements: { pg: el } }).renderPagination('pg', 5, 3, 'load');
    assert.ok(/<button onclick="load\(3\)" aria-current="page" class="[^"]*bg-indigo-600[^"]*"/.test(el.innerHTML), el.innerHTML);
    // 非当前页不得带 aria-current
    const other = /<button onclick="load\(2\)"[^>]*>/.exec(el.innerHTML);
    assert.ok(other && !other[0].includes('aria-current'), other && other[0]);
  });

  it('首页禁用“上一页”，末页禁用“下一页”（仅样式不改变行为）', () => {
    const first = container();
    fresh({ elements: { pg: first } }).renderPagination('pg', 5, 1, 'load');
    assert.ok(first.innerHTML.includes('opacity-50 pointer-events-none'));

    const last = container();
    fresh({ elements: { pg: last } }).renderPagination('pg', 5, 5, 'load');
    assert.ok(last.innerHTML.includes('下一页'), '末页仍输出下一页按钮');
  });

  it('容器不存在时静默返回', () => {
    assert.doesNotThrow(() => fresh().renderPagination('missing-el', 10, 1, 'load'));
  });

  it('页码回调名被原样内联进 onclick', () => {
    const el = container();
    fresh({ elements: { pg: el } }).renderPagination('pg', 3, 1, 'loadSubmissions');
    assert.ok(el.innerHTML.includes('onclick="loadSubmissions(1)"'), el.innerHTML);
    assert.ok(el.innerHTML.includes('onclick="loadSubmissions(2)"'), el.innerHTML);
  });
});

describe('api.js 路由守卫', () => {
  function withLocation(token, user) {
    const storage = {};
    if (token) storage.access_token = token;
    if (user) storage.user = JSON.stringify(user);
    return fresh({ storage });
  }

  it('无 token 时 requireAuth 跳登录并返回 false', () => {
    const api = withLocation(null);
    assert.equal(api.requireAuth('/pages/login.html'), false);
    assert.equal(api.window.location.href, '/pages/login.html');
  });

  it('无 token 时 requireAuth 默认跳登录页', () => {
    const api = withLocation(null);
    assert.equal(api.requireAuth(), false);
    assert.equal(api.window.location.href, '/pages/login.html');
  });

  it('有 token 时 requireAuth 返回 true 且不跳转', () => {
    const api = withLocation('t', { role: 'user' });
    assert.equal(api.requireAuth(), true);
    assert.equal(api.window.location.href, '');
  });

  it('角色不符时 requireRole 返回 false 并跳回题库', () => {
    const api = withLocation('t', { role: 'user' });
    assert.equal(api.requireRole(['admin', 'su']), false);
    assert.equal(api.window.location.href, '/pages/problems.html');
  });

  it('角色匹配时 requireRole 返回 true', () => {
    const api = withLocation('t', { role: 'su' });
    assert.equal(api.requireRole(['admin', 'su'], '/pages/admin.html'), true);
    assert.equal(api.window.location.href, '');
  });

  it('无 token 时 requireRole 直接 false（不查角色）', () => {
    const api = withLocation(null);
    assert.equal(api.requireRole(['admin']), false);
    assert.equal(api.window.location.href, '/pages/login.html');
  });
});

describe('api.js 令牌与用户存取', () => {
  it('setToken/getToken/clearToken 闭环', () => {
    const api = fresh();
    assert.equal(api.getToken(), null);
    api.setToken('abc');
    assert.equal(api.getToken(), 'abc');
    api.clearToken();
    assert.equal(api.getToken(), null);
  });

  it('setUser/getUser 闭环，且 localStorage 被更新', () => {
    const api = fresh();
    const user = { id: 7, username: 'bob', nickname: 'B', role: 'teacher', rating: 1600 };
    api.setUser(user);
    assert.equal(JSON.parse(api.localStorage.getItem('user')).nickname, 'B');
    // getUser 返回的对象带 vm realm prototype，deepStrictEqual 会因 prototype 不同而失败，故逐字段断言
    const got = api.getUser();
    assert.equal(got.id, 7);
    assert.equal(got.username, 'bob');
    assert.equal(got.role, 'teacher');
    assert.equal(got.rating, 1600);
  });

  it('清除令牌同时清掉缓存的用户', () => {
    const api = fresh();
    api.setToken('t');
    api.setUser({ id: 1, role: 'user' });
    api.clearToken();
    assert.equal(api.localStorage.getItem('user'), null);
    assert.equal(api.getUser(), null);
  });

  it('损坏的 localStorage JSON 会让 getUser 抛错（记录既有行为，不在此改动）', () => {
    // api.js 的 getUser 是裸 JSON.parse，无 try/catch。localStorage.user 被写坏时抛 SyntaxError。
    // 现网不构成崩溃：renderNav() 整段包在 try/catch 里，会降级为最小导航（见上方降级用例）。
    const api = fresh({ storage: { user: '{not json' } });
    // 错误对象在 vm realm 内构造，prototype 与宿主不同，故按 message 匹配而非指定构造函数
    assert.throws(() => api.getUser(), /JSON/);
  });

  it('空 user 键返回 null', () => {
    const api = fresh();
    assert.equal(api.getUser(), null);
  });
});

describe('api.js isTokenExpired', () => {
  /** 构造一个 payload.exp 为 expSeconds 的 JWT（无需签名，本地只解 payload） */
  function jwt(expSeconds) {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '');
    return b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ exp: expSeconds }) + '.sig';
  }

  it('无 token 视为已过期', () => {
    assert.equal(fresh().isTokenExpired(), true);
  });

  it('payload.exp 在未来 → 未过期', () => {
    const api = fresh({ storage: { access_token: jwt(Math.floor(Date.now() / 1000) + 3600) } });
    assert.equal(api.isTokenExpired(), false);
  });

  it('payload.exp 已过 → 过期', () => {
    const api = fresh({ storage: { access_token: jwt(Math.floor(Date.now() / 1000) - 3600) } });
    assert.equal(api.isTokenExpired(), true);
  });

  it('token 不是合法 JWT → fail-closed 视为过期', () => {
    for (const raw of ['garbage', 'a.b.c', '', 'x.y']) {
      const api = fresh({ storage: { access_token: raw } });
      assert.equal(api.isTokenExpired(), true, JSON.stringify(raw) + ' 应视为过期');
    }
  });
});