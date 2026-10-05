# 安全政策

感谢你关注 NoldOJ 的安全。本文档说明本项目的威胁模型、支持版本、已实现的安全特性、漏洞报告方式与响应预期。
部署相关的操作细节见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)，功能与架构说明见 [README.md](README.md)。

## 威胁模型与部署前提

> ⚠️ 引自 README 安全警告：
>
> 本项目基于 Windows 原生 Job Objects 实现沙箱隔离，旨在提供轻量级的本地判题环境。但 Windows 桌面系统并非为绝对隔离设计，
> **请勿在存有核心机密或敏感数据的个人主力机上以公网暴露的形式运行本项目**。建议部署在虚拟机或专用测试机中。

具体而言：

- **用户提交的代码是不可信输入**，会在你的服务器上被编译并执行。判题沙箱（`sandbox_runner.exe`）与 OJ 服务运行在同一台
  Windows 主机上，依靠低完整性级别 + Job Object + 受限令牌/AppContainer 约束进程，**不是**虚拟机或容器级隔离。
  沙箱逃逸、Windows 内核/驱动漏洞、错误配置（如显式设置 `NoldOJ_ALLOW_NO_SANDBOX=1` 关闭沙箱）都可能导致越权。
- **服务持有敏感数据**：用户口令（bcrypt 加盐存储）、JWT 签名密钥（`config/jwt.txt`）、邮件与 AI 服务 API Key
  （`config/email.txt`、`config/ai.txt`）。这些文件位于 `config/` 目录，已被 `.gitignore` 忽略，且启动时会在 Windows 上
  用 `icacls` 收紧 ACL（仅当前用户 / SYSTEM / Administrators 可访问）。请勿把这些文件打包外发或提交到任何仓库。
- **公网暴露会放大风险**：暴力破解、扫描、自动化注册、资源耗尽等威胁在公网持续存在。若必须公网部署，请同时做到：
  置于 HTTPS 反向代理之后（`COOKIE_SECURE=true` + `TRUST_PROXY=1`）、保持验证码开启、不要设置 `NoldOJ_CAPTCHA_DEBUG`、
  保持 `CORS_RESTRICTED=true`、及时升级到最新版本。
- **建议的部署形态**：虚拟机 / 专用测试机 / 内网环境；不与存有核心机密的主力机共用。

## 支持版本

| 版本 | 是否提供安全修复 |
|------|------------------|
| `main` 分支最新提交 / 最新发布版本 | ✅ 是 |
| 当前大版本的较早发布（如 v2.1.x） | ✅ 视影响面 cherry-pick |
| 已停止维护的旧版本（v1.x、v2.0.0 等） | ❌ 否，请升级 |

- 运行环境要求 **Node.js >= 24**（内置 `node:sqlite`）；低于该版本不提供安全兼容性修复。
- 安全修复会合入 `main`，并在 README「更新日志」中记录；升级步骤见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。
- 历史版本中的已知问题不会在旧版本分支上回溯修补，升级是唯一受支持的修复方式。

## 已实现的安全特性

**判题沙箱**

- **三层安全架构**：低完整性级别（Low IL，强制 workDir 降级、禁止写高完整性对象）+ Job Object
  （`CREATE_SUSPENDED` 绑定杜绝竞态逃逸、`KILL_ON_JOB_CLOSE` 整树秒杀、禁用 `BREAKAWAY` 防脱离、CPU/内存/进程数限制）
  + 受限令牌（禁用 Administrators 等特权组、剥离 `SeDebugPrivilege`/`SeImpersonatePrivilege` 等高危特权）；
  以管理员/服务运行时额外尝试 AppContainer 文件系统与网络隔离（容器令牌在独立子进程构建，API 崩溃时安全回退受限令牌）。
- **fail-closed 默认**：Windows 上 `sandbox_runner.exe` 未编译时**默认拒绝判题**，不静默裸跑；
  只有显式设置 `NoldOJ_ALLOW_NO_SANDBOX=1` 才回退到不安全的传统模式（仅限本地开发）。
- **数据隔离**：每次判题使用独立临时目录，结束后暴力删除；沙箱诊断写入 `log/sandbox.log`。

**网络与接口**

- **CSP / 安全响应头**：helmet 提供 Content-Security-Policy 等响应头（`frame-ancestors 'self'` 等）。
- **CORS 白名单**：`config/cors.txt` 的 `CORS_RESTRICTED=true` 时仅白名单源可携带凭据访问 API；
  `false` 会反射任意 Origin，仅供本地/内网演示，启动时会输出 WARN。
- **CSRF / Origin 校验**：带凭据的非 GET 请求必须携带 Origin，缺失直接 403，阻断 DNS rebinding 与无源 CSRF；
  WebSocket 握手同样校验白名单 Origin。
- **限流（固定窗口）**：提交 10 次/60 秒、IDE 运行 20 次/60 秒、注册 1 次/小时/IP，超限返回 429；
  默认只以 socket 地址为限流键，仅在显式 `TRUST_PROXY=1` 时才读取 `X-Forwarded-For` 首跳，防止伪造 XFF 绕过。
- **图形验证码**：登录/注册需通过自绘 SVG 验证码（答案不写入 DOM、一次性使用、5 分钟有效），防自动化攻击。

**认证与输入**

- **双 Token 认证**：15 分钟 Access Token + 7 天 Refresh Token（HttpOnly Cookie）；强制登出按 `force_logout_at` 与
  JWT `iat` 比对立即失效；封禁用户的两种 Token 均被拒绝。
- **上传校验**：源码大小限制（128KB）、上传文件大小/类型校验与伪装检测（黑盒用例覆盖）、教师及以上才有上传权限、
  单用户 2GB 总量限额（超管可调）。
- **XSS 清洗**：前端 `renderMarkdown` + DOMPurify 消毒为第一道防线；服务端 `securityHelpers` 再剥离脚本、事件属性、
  iframe、`javascript:` 等危险结构，即使渲染链路被绕过也不会执行。
- **SQL 注入防护 / 语言可用性检查 / SPJ 逃逸防护 / 登录爆破拦截**：均有对应黑盒测试用例（`backend/test/security.test.js`）。
- **AI 代码安全审查（可选）**：启用后在编译前审查提交代码，检出恶意代码自动封禁并踢出登录；含 14 种提示词注入模式检测。

## 漏洞报告方式

**请勿通过公开渠道报告安全漏洞**，包括但不限于：公开 Issue、讨论区/题解区发帖、Pull Request、社交媒体。

请通过 **Gitee / GitHub 私信维护者**私下联系：

- GitHub：https://github.com/dxxjudges/NoldOJ （Issue 列表：https://github.com/dxxjudges/NoldOJ/issues）
- Gitee：https://gitee.com/dxx114514/NoldOJ
- 站内配置的联系地址：`config/security.txt` 的 `CONTACT=`（缺省回退仓库地址）

报告时请尽量包含：

1. 漏洞类型与影响范围（哪些接口/角色/部署形态受影响）；
2. 复现步骤或最小 PoC（构造的请求、提交的代码、截图/日志）；
3. 你已知的潜在影响与建议的修复方向（可选）；
4. 你的联系方式，便于我们回复与确认。

## 响应预期

| 阶段 | 预期 |
|------|------|
| 收到报告 | **3 个工作日内**确认收到并给出初步判断 |
| 漏洞确认 | 评估影响面与复现，同步修复计划与排期 |
| 修复开发 | 高危一般在确认后 **7 天内**合入 `main`；中危按当期迭代排期；低危进入待办队列 |
| 公告方式 | 修复合入后在 README「**更新日志**」中条目化说明（不披露未修复细节），必要时在仓库 Release / Issue 中同步 |
| 致谢 | 报告人如愿意署名，将在更新日志中致谢 |

在修复发布之前，请配合**不公开披露**细节。若漏洞涉及第三方依赖，我们会升级依赖并在更新日志中注明。
