# 贡献指南

感谢你对 NoldOJ 的关注！本文档说明开发环境、代码规范、测试流程与 PR 要求。
提交前请先通读 [README.md](README.md)（功能、架构、配置与测试章节）。

## 环境要求

| 依赖 | 版本要求 | 用途 |
|------|---------|------|
| **Node.js** | >= 24.x（需内置 node:sqlite） | 运行后端服务与测试 |
| **MinGW (g++)** | 任意版本 | 编译 Windows 判题沙箱 `sandbox_runner.exe` |
| **Git** | 任意版本 | 克隆仓库与提交 |
| **操作系统** | Windows 10 及以上 | 判题沙箱为 Windows 专属实现（Node 24 官方构建最低 Win10） |
| Python 3 / JDK | 任意版本 | 可选，多语言判题 |
| Ollama | 任意版本 | 可选，AI 代码安全审查 / AI 提示 / 测试数据生成 |

> Linux / macOS 上可以跑 `npm run lint` 与大部分单测（`sandbox.test.js` 在无 g++ 的环境会自动跳过真实编译用例），
> 但**沙箱真实编译、Windows 判题路径、黑盒登录测试必须在 Windows 上验证**。

## 获取代码

主仓库托管在 Gitee：

```batch
git clone https://gitee.com/dxx114514/NoldOJ.git
cd NoldOJ\backend
npm ci
```

GitHub 镜像：https://github.com/dxxjudges/NoldOJ

> `start.bat` 首次启动时若检测到依赖缺失会自动执行 `npm install`，手动开发环境建议直接用 `npm ci` 锁定版本。

## 分支与提交规范

- 仓库目前只维护 `main` 分支；如需开发较大改动，可从 `main` 切出短生命周期分支，合并后删除。
- Commit message 使用**中文**，采用 Conventional Commits 前缀，可带作用域：
  - `feat(exams): 试卷排行榜（时间窗/封榜）`
  - `fix(sandbox): 残留的 WINOJ_* 环境变量改为 NoldOJ_*`
  - `docs: 按全站文档审计修正仓库内过时内容`
  - `chore:` / `refactor:` / `test:` / `ci:` 同理
- **原子提交**：一个提交只做一件事；功能、缺陷修复、文档调整分开提交，不要混在一个提交里。
- 不要提交被 `.gitignore` 忽略的内容（`config/`、`log/`、`data/`、`backend/data/`、`node_modules/` 等），
  **任何密钥、口令、真实邮箱配置严禁入库**。
- 不要 commit / push 未经本人确认的改动；推送前先自测。

## 开发流程

1. 改代码（后端在 `backend/`，前端在 `frontend/`）。
2. 静态检查与单元测试：

   ```batch
   cd backend
   npm run lint
   npm test
   ```

3. 起服务跑黑盒测试（**另开一个窗口**，验证码需调试模式）：

   ```batch
   cd backend
   set NoldOJ_CAPTCHA_DEBUG=1
   npm start
   ```

   服务就绪后回到原窗口：

   ```batch
   cd backend
   npm run test:server
   ```

   > `NoldOJ_CAPTCHA_DEBUG=1` 仅限测试环境，**生产 / 日常运行严禁设置**。
   > 新初始化的数据库 admin 口令为随机生成；黑盒测试需要固定口令时可另设
   > `NoldOJ_INIT_ADMIN_PASSWORD=admin123`（同样仅测试环境使用）。

4. 全绿后再提交。CI（`.github/workflows/test.yml`）会在 push / PR 上跑
   `npm ci` + `npm run lint` + `npm test`，并另起服务跑 `npm run test:server`。

### 测试数据与测试隔离

- 需要数据库的测试自动使用 `%TEMP%\NoldOJ-test\` 下的**独立库**，**不读写生产库** `backend/data/NoldOJ.db`，
  测试中断也不会留下脏数据。
- 不要在测试里写死生产路径；新测试请复用 `backend/test/_testdb.js` 的隔离库工具。
- `sandbox.test.js` 会真实调用 g++ 编译 C++，未安装 MinGW 的环境自动跳过这 3 个用例。
- 黑盒测试用例统计：`security.test.js` 24 项 + `reset-login.test.js` 6 项断言。

## 前端约定

- `frontend/` 是**零构建**目录：纯静态 HTML / CSS / JS，改完刷新页面即生效，没有打包 / 编译步骤，也不要引入需要构建的工具链。
- 目录划分：`frontend/pages/` 页面（全中文界面）、`frontend/js/` 公共 JS（API 封装、Markdown 渲染、导航栏）、`frontend/css/` 全局样式（含暗色模式覆盖）。
- Markdown 渲染统一走 `renderMarkdown` + DOMPurify 消毒，公式用 KaTeX；新增用户输入的渲染路径必须经过消毒。
- 暗色模式：新增 UI 需同时适配亮 / 暗两套配色。
- ESLint 只覆盖后端，规则文件在 `backend/eslint.config.js`（`eslint:recommended`；空 catch 允许、未用变量 `_` 前缀豁免），前端 JS 暂未纳入 lint，请保持与既有代码风格一致。

## PR 要求

- `npm run lint` 与 `npm test` **全绿**（本地与 CI 一致），涉及判题/沙箱的改动另需在 Windows 上跑通 `npm run test:server`。
- PR 描述必须包含：
  - **动机**：解决了什么问题 / 为什么需要这个改动；
  - **验证方式**：怎么测的（跑哪些测试、手工验证步骤、截图/日志）。
- 关联相关 issue；只改与主题相关的文件，不做无关重构。
- 文档同步：改动了行为（环境变量、配置项、测试数量、目录结构）请同步更新 `README.md` 及 `docs/` 下相关文档。

## 问题反馈

- 功能缺陷与需求：GitHub Issues → https://github.com/dxxjudges/NoldOJ/issues
- **安全漏洞请勿公开提交 issue**，按 [SECURITY.md](SECURITY.md) 的私下渠道报告。
- 使用与部署问题可先查 [README 常见问题](README.md#常见问题) 与 `docs/support.html`。
