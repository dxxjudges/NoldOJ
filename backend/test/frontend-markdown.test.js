/**
 * frontend/js/markdown.js —— renderMarkdown() 前端 Markdown 渲染器
 *
 * 关注三类行为：
 *  1) 安全：HTML 转义、javascript: 伪协议拒绝、属性上下文注入（引号）阻断、
 *     无 DOMPurify 时的 fail-closed 降级；
 *  2) 结构：标题/列表/表格/代码块/引用/任务列表/分隔线/公式/嵌入块的渲染结果；
 *  3) 与 DOMPurify 的契约：输出统一过清洗、白名单放行 iframe、无 DOMPurify 时转义降级。
 *
 * DOMPurify 依赖说明：生产环境由 js/purify.min.js 提供（依赖真实 DOM，Node 无法加载，
 * 仓库也未引入 jsdom）。结构类断言使用一个“透传”桩；安全类断言分两层——
 *   - markdown.js 自身的防御（escapeHtml / escapeAttr / fixUrl）与 DOMPurify 无关，用无桩路径断言；
 *   - DOMPurify 层用一个模拟其核心白名单行为的桩（剥离 script/style 与 on* 事件属性）断言。
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadMarkdown } = require('./_frontend-harness');

/** 透传桩：只记录调用，不改动 HTML —— 用于断言结构化渲染 */
function passthroughPurify() {
  const calls = [];
  return {
    calls,
    sanitize(html, cfg) { calls.push({ html, cfg }); return String(html); },
  };
}

/**
 * 最小 DOMPurify 仿真：模拟其白名单的两个核心后果
 *  - <script>/<style> 整段（含内容）被删除
 *  - on* 事件属性（含无引号形式）被删除
 * 注意：这是**桩**，断言的是 markdown.js 是否把这些危险片段送到了清洗函数、
 * 以及清洗结果是否已无事件属性；真实保证由浏览器端的 DOMPurify 提供。
 */
function strippingPurify() {
  const calls = [];
  return {
    calls,
    sanitize(html, cfg) {
      calls.push({ html, cfg });
      return String(html)
        .replace(/<\s*(script|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
        .replace(/<\s*\/\s*(script|style)\s*>/gi, '')
        .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    },
  };
}

/** 无 DOMPurify 的 fail-closed 渲染器 */
const renderNoPurify = loadMarkdown(null);
/** 透传渲染器：结构类断言用 */
const renderPass = loadMarkdown(passthroughPurify());

/** 去掉最外层 prose 包裹 div，取内部 HTML，减少断言噪音 */
function inner(html) {
  return html.replace(/^<div class="prose[^"]*">/, '').replace(/<\/div>$/, '');
}

/**
 * 解析单个标签的属性名（只认 key="..." / key='...' 形式）。
 * 若载荷里的引号被正确转义成 &quot;，它就无法闭合属性，故 onerror 不会出现在属性名里。
 */
function attrNames(tagHtml) {
  const names = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"[^"]*"|'[^']*')/g;
  let m;
  while ((m = re.exec(tagHtml)) !== null) names.push(m[1].toLowerCase());
  return names;
}

/** 取第一个 <tag ...> 片段 */
function firstTag(html, tag) {
  const m = new RegExp('<' + tag + '\\b[^>]*>', 'i').exec(html);
  return m ? m[0] : '';
}

describe('renderMarkdown: 安全 — HTML 转义与 fail-closed', () => {
  it('无 DOMPurify 时 fail-closed：<script> 整体被转义，输出不含可执行标签', () => {
    const out = renderNoPurify('<script>alert(1)</script>');
    assert.ok(!/<script/i.test(out), '不应保留可执行 script 标签');
    assert.ok(out.includes('&lt;script&gt;'), 'script 应被转义为文本');
    assert.ok(out.includes('&lt;/script&gt;'));
    // fail-closed 语义：连 markdown 自己生成的标签也一并转义 → 纯文本降级
    assert.ok(out.includes('&lt;p&gt;'));
  });

  it('无 DOMPurify 时 fail-closed：裸 HTML 标签与属性被转义', () => {
    const out = renderNoPurify('<img src=x onerror=alert(1)>');
    assert.ok(!/<img/i.test(out), '裸 img 不应原样透传');
    assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'));
  });

  it('转义覆盖 5 个 HTML 元字符（引号必须转义，属性上下文才不会被闭合）', () => {
    const body = inner(renderPass('a & b < c > d " e \' f'));
    assert.ok(body.includes('a &amp; b &lt; c &gt; d &quot; e &#39; f'), body);
  });

  it('fail-closed 分支对已转义内容再转义一次 → 输出退化为纯文本', () => {
    // 无 DOMPurify 时 sanitizeHtml = escapeHtml，作用于已转义过的输出：
    // 行内文本里的 & 被转义两次（& → &amp; → &amp;amp;），块级标签本身被转义一次（<p> → &lt;p&gt;）。
    // 这正是“宁可显示成文本也不能执行”的降级语义。
    const body = renderNoPurify('x & y');
    assert.ok(body.includes('x &amp;amp; y'), body);
    assert.ok(body.includes('&lt;p&gt;'), '块级标签不应保留为真实标签: ' + body);
  });

  it('图片 alt 内的引号被转义，无法闭合 alt 属性', () => {
    const out = renderPass('![a" onerror="alert(1)](https://e.com/a.png)');
    const img = firstTag(out, 'img');
    assert.ok(img.includes('alt="a&quot; onerror=&quot;alert(1)"'), 'alt 应整体被引号转义: ' + img);
    assert.deepEqual(attrNames(img).sort(), ['alt', 'class', 'src']);
  });

  it('文本中的 * _ 不会被当作 markdown 标记误伤（普通段落）', () => {
    const out = renderPass('a_b_c and 2*3');
    assert.ok(inner(out).includes('a_b_c and 2*3'));
  });
});

describe('renderMarkdown: 安全 — javascript: 伪协议一律拒绝', () => {
  it('链接 javascript: 被 fixUrl 拒绝，href 退化为 /', () => {
    const out = renderPass('[点我](javascript:alert(1))');
    const a = firstTag(out, 'a');
    assert.ok(a.includes('href="/"'), 'href 应被降级为 /: ' + a);
    assert.ok(!/href="javascript:/i.test(out));
  });

  it('链接 javascript: 的大小写与空白变体同样被拒', () => {
    for (const raw of ['JaVaScRiPt:alert(1)', '  javascript:alert(1)']) {
      const out = renderPass('[x](' + raw + ')');
      assert.ok(!/href="[^"]*javascript:/i.test(out), '应拒绝: ' + raw);
      assert.ok(firstTag(out, 'a').includes('href="/"'));
    }
  });

  it('图片 javascript: 被拒，src 退化为 /', () => {
    const out = renderPass('![x](javascript:alert(1))');
    const img = firstTag(out, 'img');
    assert.ok(img.includes('src="/"'), 'src 应被降级为 /: ' + img);
    assert.ok(!/src="[^"]*javascript:/i.test(out));
  });

  it('@[url] 嵌入的 javascript: 被拒，iframe src 退化为 /', () => {
    const out = renderPass('@[url](javascript:alert(1))');
    assert.ok(firstTag(out, 'iframe').includes('src="/"'));
  });

  it('@[audio] / @[video] 的 javascript: 被拒', () => {
    assert.ok(firstTag(renderPass('@[audio](javascript:alert(1))'), 'audio').includes('src="/"'));
    assert.ok(firstTag(renderPass('@[video](javascript:alert(1))'), 'video').includes('src="/"'));
  });

  it('@[office] 非 https 地址被拒，改渲染提示文案而非 iframe', () => {
    const out = renderPass('@[office](http://a/b.docx)');
    assert.ok(out.includes('仅支持公网 https 文档地址'));
    assert.ok(!firstTag(out, 'iframe'), 'http 不应生成 iframe');
  });

  it('合法 http/https/相对路径放行', () => {
    assert.ok(firstTag(renderPass('[x](https://ok.com/a?b=1)'), 'a').includes('href="https://ok.com/a?b=1"'));
    assert.ok(firstTag(renderPass('[x](http://ok.com)'), 'a').includes('href="http://ok.com"'));
    assert.ok(firstTag(renderPass('[x](/pages/problem.html)'), 'a').includes('href="/pages/problem.html"'));
  });

  it('链接 & 被还原后再判协议，不会因 &amp; 前缀绕过白名单', () => {
    // fixUrl 先把 &amp; 还原成 &，保证协议判断看到的是真实 URL
    const out = renderPass('[x](https://ok.com/?a=1&amp;b=2)');
    assert.ok(firstTag(out, 'a').includes('href="https://ok.com/?a=1&amp;b=2"'));
  });
});

describe('renderMarkdown: 安全 — onerror 属性载荷被清洗', () => {
  it('图片 URL 里注入 onerror= 时无法闭合属性（引号被转义）', () => {
    const out = renderPass('![x](http://a/b.png" onerror="alert(1))');
    const img = firstTag(out, 'img');
    assert.ok(img.includes('&quot;'), '载荷引号应被转义: ' + img);
    assert.ok(!/onerror="alert/.test(out), '不应出现可执行的 onerror 属性');
    assert.deepEqual(attrNames(img).sort(), ['alt', 'class', 'src']);
  });

  it('原始 HTML 的 onerror 属性经 DOMPurify 桩清洗后消失', () => {
    const p = strippingPurify();
    const r = loadMarkdown(p);
    const out = r('<img src=x onerror=alert(1)>');
    assert.ok(!/\son[a-z]+\s*=/i.test(out), '事件属性应被剥离: ' + out);
    assert.ok(!/alert\(1\)/.test(out));
  });

  it('<script> 原始标签经 DOMPurify 桩清洗后整段消失', () => {
    const p = strippingPurify();
    const r = loadMarkdown(p);
    const out = r('<script>alert(1)</script>');
    assert.ok(!/<script/i.test(out), 'script 应被移除: ' + out);
    assert.ok(!/alert\(1\)/.test(out));
  });

  it('斜体内的 HTML 载荷也走清洗（italics stash 是独立清洗路径）', () => {
    const p = strippingPurify();
    const r = loadMarkdown(p);
    const out = r('*<img onerror=alert(1)>*');
    assert.ok(out.includes('<em'), '斜体本身应保留: ' + out);
    assert.ok(!/\sonerror\s*=/i.test(out), '斜体内的事件属性应被剥离: ' + out);
    // 斜体 stash 独立调用 sanitizeHtml → 至少两次清洗调用（正文一次 + 斜体一次）
    assert.ok(p.calls.length >= 2, '正文与斜体应分别清洗，实际 ' + p.calls.length + ' 次');
  });

  it('多个载荷时清洗函数被逐段调用，危险片段不会漏网', () => {
    const p = strippingPurify();
    const r = loadMarkdown(p);
    const out = r('a <script>x</script> b <img onerror=y> c');
    assert.ok(!/<script/i.test(out));
    assert.ok(!/\sonerror\s*=/i.test(out));
  });
});

describe('renderMarkdown: 与 DOMPurify 的契约', () => {
  it('输出统一过 sanitizeHtml，且显式放行 iframe 及安全属性', () => {
    const p = passthroughPurify();
    const r = loadMarkdown(p);
    r('# hi');
    assert.ok(p.calls.length >= 1, '应调用 DOMPurify.sanitize');
    // cfg 对象在 vm realm 内构造，prototype 不同，不能用 deepStrictEqual，逐字段断言
    const cfg = p.calls[0].cfg;
    assert.equal(cfg.USE_PROFILES.html, true);
    assert.ok(Array.isArray(cfg.ADD_TAGS) && cfg.ADD_TAGS.includes('iframe'), 'iframe 需白名单放行，否则 @[url] 嵌入会被整段剥掉');
    for (const attr of ['allowfullscreen', 'scrolling', 'frameborder', 'width', 'height', 'loading']) {
      assert.ok(cfg.ADD_ATTR.includes(attr), 'ADD_ATTR 应含 ' + attr);
    }
  });

  it('有 DOMPurify 时不会整体转义（fail-closed 分支未被误触发）', () => {
    const out = renderPass('# hi');
    assert.ok(inner(out).includes('<h1'), '有 DOMPurify 时应保留真实标签');
  });
});

describe('renderMarkdown: 块级结构', () => {
  it('标题：1-6 级映射样式，尾部 # 被清理', () => {
    assert.ok(inner(renderPass('# T')).includes('<h1 class="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-6 mb-3">T</h1>'));
    assert.ok(inner(renderPass('## T')).includes('<h2 class="text-xl font-bold'));
    assert.ok(inner(renderPass('### T')).includes('<h3 class="text-lg font-semibold'));
    assert.ok(inner(renderPass('#### T')).includes('<h4 class="text-base font-semibold'));
    assert.ok(inner(renderPass('##### T')).includes('<h5 class="text-sm font-semibold'));
    assert.ok(inner(renderPass('###### T')).includes('<h6 class="text-sm font-medium'));
    assert.ok(inner(renderPass('## Sub ##')).includes('>Sub</h2>'), '尾部 ## 应被剥掉');
  });

  it('无序列表渲染 <ul><li>', () => {
    assert.ok(inner(renderPass('- a\n- b')).includes('<ul><li>a</li><li>b</li></ul>'));
  });

  it('有序列表渲染 <ol>，并识别 ) 作为序号分隔符', () => {
    assert.ok(inner(renderPass('1. x\n2. y')).includes('<ol><li>x</li><li>y</li></ol>'));
    assert.ok(inner(renderPass('1) x\n2) y')).includes('<ol><li>x</li><li>y</li></ol>'));
  });

  it('列表项内两空格缩进的续行并入同一项', () => {
    assert.ok(inner(renderPass('- first\n  continued')).includes('<ul><li>first continued</li></ul>'));
  });

  it('任务列表渲染 disabled checkbox，- [x] 为 checked', () => {
    const out = inner(renderPass('- [ ] todo\n- [x] done'));
    assert.ok(out.includes('<li class="list-none"><input type="checkbox" disabled class="'));
    assert.ok(out.includes('>todo</li>'), '未勾选项不应带 checked');
    assert.ok(out.includes('disabled checked class="'), '已勾选项应带 checked');
  });

  it('表格：表头 + 数据行渲染 thead/tbody', () => {
    const out = inner(renderPass('|a|b|\n|---|---|\n|1|2|'));
    assert.ok(out.includes('<table class="my-3 w-full text-sm border-collapse">'));
    assert.ok(out.includes('<thead><tr><th>a</th><th>b</th></tr></thead>'));
    assert.ok(out.includes('<tbody><tr><td>1</td><td>2</td></tr></tbody>'));
  });

  it('表格：对齐标记 :-- / --: / :-: 映射到 text-align', () => {
    const out = inner(renderPass('| L | R | C |\n|:--|--:|:-:|\n|1|2|3|'));
    assert.ok(out.includes('<th style="text-align:left">L</th>'));
    assert.ok(out.includes('<th style="text-align:right">R</th>'));
    assert.ok(out.includes('<th style="text-align:center">C</th>'));
  });

  it('表格：单元格内支持行内 markdown', () => {
    const out = inner(renderPass('|a|\n|-|\n|**b**|'));
    assert.ok(out.includes('<strong class="text-gray-900 dark:text-gray-100 font-semibold">b</strong>'));
  });

  it('围栏代码块：内容原样保留且被转义，不参与行内规则', () => {
    const out = inner(renderPass('```\nlet a = **b** <i>x</i>;\n```'));
    assert.ok(out.includes('<pre class="my-3 bg-gray-100 dark:bg-gray-800 rounded-lg p-3 text-sm overflow-x-auto">'));
    assert.ok(out.includes('let a = **b** &lt;i&gt;x&lt;/i&gt;;'), '代码块内 * 与 < 都不应被解析');
    assert.ok(!out.includes('<strong'), '代码块内不应产生 <strong>');
  });

  it('已闭合围栏：语言标记被丢弃（Stage 1 占位符 stash 不带 language-*）', () => {
    // 记录既有行为：闭合围栏在 Stage 1 被整块 stash，输出不含 language-* 类。
    const out = inner(renderPass('```js\nvar a=1;\n```'));
    assert.ok(out.includes('<pre class="my-3 bg-gray-100 dark:bg-gray-800 rounded-lg p-3 text-sm overflow-x-auto">'));
    assert.ok(out.includes('<code class="text-gray-700 dark:text-gray-300">var a=1;</code>'), out);
    assert.ok(!out.includes('language-js'), '闭合围栏当前不带语言类');
  });

  it('未闭合围栏：带语言时输出 language-* 类', () => {
    const out = inner(renderPass('```js\nunclosed'));
    assert.ok(out.includes('<code class="language-js text-gray-700 dark:text-gray-300">unclosed</code>'), out);
  });

  it('围栏语言标记被转义，无法注入属性', () => {
    const out = inner(renderPass('```a" onmouseover="x\nunclosed'));
    assert.ok(!/onmouseover="/.test(out), out);
  });

  it('未闭合围栏：剩余内容按代码块渲染，不吞掉后续页面', () => {
    const out = inner(renderPass('```\nunclosed'));
    assert.ok(out.includes('<pre'), '未闭合围栏仍应渲染 pre');
    assert.ok(out.includes('unclosed'));
  });

  it('引用块：内容递归解析，块内换行保留 <br>', () => {
    const out = inner(renderPass('> quote\n> more'));
    assert.ok(out.includes('<blockquote><p>quote<br>more</p></blockquote>'));
  });

  it('分隔线：*** / --- / ___ 都渲染 <hr>，且优先于列表规则', () => {
    for (const raw of ['***', '---', '___', '- - -']) {
      assert.ok(inner(renderPass(raw)).includes('<hr class="my-6">'), raw + ' 应渲染 hr');
    }
  });

  it('段落：非空行内的换行合并为 <br>，第二段带 mt-3', () => {
    assert.ok(inner(renderPass('a\nb')).includes('<p>a<br>b</p>'));
    const out = inner(renderPass('a\n\nb'));
    assert.ok(out.includes('<p>a</p>'));
    assert.ok(out.includes('<p class="mt-3">b</p>'));
  });

  it('整体包在 prose 容器里，供 Tailwind typography 生效', () => {
    const out = renderPass('x');
    assert.ok(out.startsWith('<div class="prose prose-sm dark:prose-invert max-w-none text-left text-gray-700 dark:text-gray-200 leading-relaxed">'));
    assert.ok(out.endsWith('</div>'));
  });

  it('空输入（空串/null/undefined）返回空串', () => {
    assert.equal(renderPass(''), '');
    assert.equal(renderPass(null), '');
    assert.equal(renderPass(undefined), '');
  });

  it('CRLF 与 CR 输入归一化为换行后解析一致', () => {
    const a = inner(renderPass('- a\n- b'));
    assert.equal(inner(renderPass('- a\r\n- b')), a);
    assert.equal(inner(renderPass('- a\r- b')), a);
  });
});

describe('renderMarkdown: 行内与公式', () => {
  it('粗体/斜体/删除线/行内代码', () => {
    const out = inner(renderPass('**b** *i* ~~d~~ `c`'));
    assert.ok(out.includes('<strong class="text-gray-900 dark:text-gray-100 font-semibold">b</strong>'));
    assert.ok(out.includes('<em class="text-gray-800 dark:text-gray-200 italic">i</em>'));
    assert.ok(out.includes('<del class="text-gray-500 dark:text-gray-400">d</del>'));
    assert.ok(out.includes('<code class="bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded text-sm font-mono text-red-600 dark:text-red-400 border border-gray-200 dark:border-gray-600">c</code>'));
  });

  it('链接带 target=_blank 与 rel=noopener noreferrer', () => {
    const a = firstTag(inner(renderPass('[x](https://ok.com)')), 'a');
    assert.ok(a.includes('target="_blank"'));
    assert.ok(a.includes('rel="noopener noreferrer"'));
  });

  it('图片带 alt 与圆角样式类', () => {
    const img = firstTag(inner(renderPass('![alt](https://e.com/a.png)')), 'img');
    assert.ok(img.includes('alt="alt"'));
    assert.ok(img.includes('class="max-w-full rounded-lg my-2 border border-gray-200 dark:border-gray-700"'));
  });

  it('图片先于链接匹配：![a](u) 不被拆成 !<a>', () => {
    const out = inner(renderPass('![a](https://e.com/a.png)'));
    assert.ok(out.includes('<img src="https://e.com/a.png"'), '应为 img: ' + out);
    assert.ok(!out.includes('<a href'), '不应生成链接');
    assert.ok(!out.includes('!'));
  });

  it('行内公式转 \\( \\)，行内代码内的 $ 不被当作公式', () => {
    assert.ok(inner(renderPass('$E=mc^2$')).includes('\\(E=mc^2\\)'));
    assert.ok(inner(renderPass('`$x$`')).includes('<code'), '行内代码应优先');
  });

  it('$5 and $10 不被误判为行内公式（两端空白）', () => {
    const out = inner(renderPass('$5 and $10'));
    assert.ok(out.includes('$5 and $10'), '应原样保留: ' + out);
    assert.ok(!out.includes('\\('));
  });

  it('$$ 展示公式转 \\[ \\]，可跨行且压空白', () => {
    assert.ok(inner(renderPass('$$\nE = mc^2\n$$')).includes('<div class="katex-display my-4 text-center">\\[E = mc^2\\]</div>'));
  });

  it('公式内容被转义，不能注入标签', () => {
    const out = renderPass('$\\lt img src=x onerror=alert(1)>$');
    assert.ok(!/<img/i.test(out), '公式内不应产生真实标签: ' + out);
  });

  it('合法 HTML 标签原样透传（交由末端 DOMPurify 白名单裁决）', () => {
    assert.ok(inner(renderPass('i am <b>bold</b> inline')).includes('<b>bold</b>'));
  });
});

describe('renderMarkdown: 富内容嵌入块', () => {
  it('@[echarts] 合法 JSON → oj-echarts 容器 + 转义后的 data-config', () => {
    const out = inner(renderPass('@[echarts]({"height":300})'));
    assert.ok(out.includes('<div class="my-4 oj-echarts" data-config="{&quot;height&quot;:300}">'));
    assert.ok(out.includes('oj-echarts-loading'), '应带加载占位');
  });

  it('@[echarts] JSON 非法 → 降级为代码块而不是抛错', () => {
    const out = inner(renderPass('@[echarts](not json)'));
    assert.ok(out.includes('[echarts] JSON 配置无效:'), out);
    assert.ok(out.includes('<pre'), '应降级为 pre');
    assert.ok(!out.includes('oj-echarts'));
  });

  it('@[office] https 地址 → Office Online iframe，src 已 URL 编码', () => {
    const out = inner(renderPass('@[office](https://a/b.docx)'));
    const iframe = firstTag(out, 'iframe');
    assert.ok(iframe.includes('src="https://view.officeapps.live.com/op/embed.aspx?src=https%3A%2F%2Fa%2Fb.docx"'), iframe);
    assert.ok(iframe.includes('height="600"'));
  });

  it('@[url] 生成 iframe；@[audio]/@[video] 生成对应媒体标签', () => {
    assert.ok(firstTag(inner(renderPass('@[url](https://a/b)')), 'iframe').includes('src="https://a/b"'));
    assert.ok(firstTag(inner(renderPass('@[audio](https://a/b.mp3)')), 'audio').includes('controls'));
    assert.ok(firstTag(inner(renderPass('@[video](https://a/b.mp4)')), 'video').includes('controls'));
  });

  it('@[mermaid] 内容被转义存进 pre，等待前端增强器渲染', () => {
    const out = inner(renderPass('@[mermaid]\ngraph TD;\nA-->B;\n@[/mermaid]'));
    assert.ok(out.includes('<pre class="oj-mermaid my-4 text-center">'));
    assert.ok(out.includes('graph TD;'));
    assert.ok(!out.includes('-->'), '内容不应被当作 markdown 解析');
  });

  it('@[bilibili] 生成播放器 iframe，BV 号来自受限字符集', () => {
    const out = inner(renderPass('@[bilibili](BV1xx411c7mD)'));
    assert.ok(firstTag(out, 'iframe').includes('player.bilibili.com'));
    assert.ok(firstTag(out, 'iframe').includes('bvid=BV1xx411c7mD'));
  });

  it('嵌入块独占一行时不被包进 <p>', () => {
    const out = inner(renderPass('@[echarts]({"a":1})'));
    assert.ok(!out.includes('<p>'), '不应包 <p>: ' + out);
  });

  it('嵌入块内容不参与行内规则（占位符隔离）', () => {
    const out = inner(renderPass('@[office](https://a/b.docx)'));
    assert.ok(!out.includes('**'), 'iframe src 内的 * 不应产生强调: ' + out);
  });
});

describe('renderMarkdown: 异常兜底', () => {
  it('极端输入不抛错（返回字符串即可）', () => {
    const nasty = [
      ' ', '\\', '`'.repeat(50), '$'.repeat(30), '*'.repeat(40),
      'x'.repeat(10), 'y', '![', '[]()', '@[', '@[echarts](', '```'.repeat(10),
    ];
    for (const raw of nasty) {
      const out = renderPass(raw);
      assert.equal(typeof out, 'string', JSON.stringify(raw) + ' 应返回字符串');
    }
  });

  it('超长单行仍能渲染（无栈溢出/超限）', () => {
    const out = renderPass('a'.repeat(50000));
    assert.ok(out.includes('a'.repeat(1000)));
  });

  it('深层嵌套引用不导致崩溃', () => {
    const out = renderPass('>'.repeat(30) + ' deep');
    assert.equal(typeof out, 'string');
  });
});