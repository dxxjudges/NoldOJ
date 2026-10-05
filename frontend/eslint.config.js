// frontend/ 专用 ESLint 10 flat config。
// 调用方式（backend/package.json 的 lint:frontend）：
//   cd ../frontend && eslint .
// flat config 的 basePath = 本文件所在目录(frontend/)，只有切到 frontend 目录下运行，
// ../frontend 才不会被判定为“basePath 之外的文件”而被整体忽略。
// 依赖（eslint / @eslint/js / globals）安装在 backend/node_modules，
// Node 的相对 require 以本文件所在目录为基准，故用 ../backend/node_modules/* 解析。
const js = require('../backend/node_modules/@eslint/js');
const globals = require('../backend/node_modules/globals');

module.exports = [
  {
    // 只 lint 自研 JS（frontend/js 下非压缩文件）。
    // 三方库与构建产物全部跳过：
    //  - **/*.min.js     压缩产物（echarts / purify / diff / socket.io / xlsx…）
    //  - js/katex/**     KaTeX 发行包
    //  - js/xlsx*        SheetJS 发行包
    //  - js/codemirror*  CodeMirror 发行包（若存在）
    //  - js/tailwind.js  Tailwind Play CDN 构建产物
    //  - js/wordcloud2.js 第三方 wordcloud2 库
    ignores: [
      '**/*.min.js',
      'js/katex/**',
      'js/xlsx*',
      'js/codemirror*',
      'js/tailwind.js',
      'js/wordcloud2.js',
    ],
  },
  js.configs.recommended,
  {
    // 本配置文件自身（CommonJS）
    files: ['eslint.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      // 页面里全部以 <script> 标签（非 module）引入，按 script 解析
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.node,
        // ── 跨 <script> 文件共享的应用全局（no-undef 的显式声明）──────
        // 全站采用“多个非模块 script 共享全局作用域”的老式结构：api.js 定义、
        // admin.js / 各页面 script 与 HTML 内联 onclick 调用。这里逐个列出，
        // 拼错的名字仍会被 no-undef 抓出。
        apiCall: false,
        escapeHtml: false,
        showToast: false,
        getUser: false,
        setUser: false,
        getToken: false,
        setToken: false,
        clearToken: false,
        refreshUser: false,
        renderNav: false,
        roleBadge: false,
        localInputToIso: false,
        renderMathDefaults: false,
        renderMarkdown: false,
        // ── 由三方 <script> 注入的全局 ───────────────────────────
        DOMPurify: false, // js/purify.min.js
        XLSX: false, // js/xlsx.full.min.js
        io: false, // js/socket.io-client.min.js
        renderMathInElement: false, // js/katex/contrib/auto-render.min.js
      },
    },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        // 豁免理由：script 顶层声明的函数/常量就是本页的“全局 API”，
        // 由 HTML 内联 onclick/onchange 或其它 <script> 文件调用（如 admin.html → admin.js），
        // 在本文件内“看起来没人用”属误报。只检查函数内的局部变量。
        vars: 'local',
      }],
      // 与 backend/eslint.config.js 保持一致：代码库大量 `try { ... } catch {}` 是有意的
      // “尽力而为”降级路径，空 catch 放行；空 if/while/函数块仍报错
      'no-empty': ['error', { allowEmptyCatch: true }],
      // 上面 languageOptions.globals 里显式声明的跨文件全局，会再被 no-redeclare 当作
      // “内置全局”与 api.js/markdown.js 里的真实 function 声明比对，产生误报。
      // 关掉 builtinGlobals 分支，源码内同一文件重复声明仍会报错。
      'no-redeclare': ['error', { builtinGlobals: false }],
      // 老式浏览器/诊断惯用法豁免（均写明原因）：
      //  - no-console: 浏览器端 console.warn/error 是既有诊断手段，无副作用
      'no-console': 'off',
      //  - no-prototype-builtins: 代码里直调 obj.hasOwnProperty(...)；
      //    这些对象是 localStorage 解析结果/用户输入对象，不继承可被污染的原型，
      //    改写成 Object.prototype.hasOwnProperty.call 属纯风格改动，故豁免
      'no-prototype-builtins': 'off',
    },
  },
];
