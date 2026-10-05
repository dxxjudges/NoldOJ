# 部署文档

本文档面向需要在 Windows 上部署 NoldOJ 的运维/管理员，覆盖从零部署、配置、反向代理、环境变量、备份与升级、常见问题。
功能说明与架构见 [README.md](README.md)，贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全前提见 [SECURITY.md](SECURITY.md)。

## 1. 环境要求

| 依赖 | 版本要求 | 用途 |
|------|---------|------|
| **Windows** | 10 及以上 | 运行平台（Node 24 官方构建最低 Win10；沙箱运行器最低 Win8+） |
| **Node.js** | >= 24.x（需内置 `node:sqlite`） | 后端服务与依赖 |
| **MinGW (g++)** | 任意版本，需在 `PATH` 中 | 编译 `sandbox_runner.exe` 判题沙箱 |
| **Git** | 任意版本 | 拉取代码与升级（可选，`start.bat` 会尝试 `git pull`） |
| Python 3 / JDK | 可选 | Python / Java 判题 |
| Ollama | 可选 | AI 代码安全审查 / AI 提示 / 测试数据生成 |

> 生产部署请先阅读 [SECURITY.md](SECURITY.md) 的威胁模型：**不要**在存有核心机密的主力机上公网暴露运行。

## 2. 部署步骤

### 2.1 获取代码

```batch
git clone https://gitee.com/dxx114514/NoldOJ.git
cd NoldOJ
```

GitHub 镜像：https://github.com/dxxjudges/NoldOJ

### 2.2 编译判题沙箱

```batch
cd backend\sandbox
build.bat
cd ..\..
```

`build.bat` 内部执行
`g++ -O2 -static -o sandbox_runner.exe sandbox_runner.cpp -lpsapi -luserenv`，
要求 g++ 已在 `PATH` 中。`start.bat` 每次启动也会自动重新编译。

> 未编译时 Windows **默认 fail-closed 拒绝判题**（不静默裸跑）。只有显式设置 `NoldOJ_ALLOW_NO_SANDBOX=1`
> 才回退到不安全的传统模式，**仅限本地开发**。

### 2.3 安装依赖

```batch
cd backend
npm ci
cd ..
```

`npm ci` 依据 `backend/package-lock.json` 锁定版本，生产环境建议用它；`start.bat` 在检测到依赖缺失时会自动执行 `npm install`。

### 2.4 配置 `config/` 目录

```batch
copy example-config\* config\
```

然后按需编辑（`config/` 已被 `.gitignore` 忽略，**不会提交密钥**）：

| 文件 | 是否必须 | 说明 |
|------|---------|------|
| `config/ai.txt` | 按需 | AI 安全审查 / AI 提示 / 测试数据生成的开关与地址（`SECURITY_*`、`HINT_*`、`TESTDATA_*`）、`CODE_LENGTH_LIMIT` |
| `config/email.txt` | 按需 | `EMAIL_ENABLED`、`RESEND_API_KEY`、`EMAIL_FROM`（注册验证/找回密码） |
| `config/cors.txt` | 按需 | `CORS_RESTRICTED`，生产保持 `true`（仅白名单源可携带凭据） |
| `config/register.txt` | 按需 | `REGISTER_ENABLED`，也可由超管面板热切换 |
| `config/judge.txt` | 自动 | `MAX_THREADS` 判题并发，缺失时按 CPU 核数自动（`(核数+1)/2`，最小 1） |
| `config/captcha.txt` | 自动 | `CAPTCHA_ENABLED`，缺失时默认开启 |
| `config/jwt.txt` | 自动 | JWT 签名密钥，缺失时首次启动自动生成强随机密钥 |
| `config/security.txt` | 可选 | `CONTACT=` 安全联系地址，缺失时回退仓库地址 |

> `config/` 下的密钥文件启动时会在 Windows 上用 `icacls` 收紧 ACL（仅当前用户 / SYSTEM / Administrators）。

### 2.5 初始化数据库与初始管理员口令

首次启动时 `initDB()` 自动创建 `backend/data/NoldOJ.db` 并执行全部 schema 与后续迁移，**无需手工建库**。

- **默认行为（推荐用于生产）**：初始管理员 `admin` 的口令为**随机生成**，仅在启动日志
  `log/<时间戳>/server.log` 中显示**一次**，请立即登录并修改。
- **自动化/测试环境**：可通过环境变量显式指定初始口令：

  ```batch
  set NoldOJ_INIT_ADMIN_PASSWORD=你的口令
  ```

  该变量**只在数据库首次初始化时生效**，日志不回显明文；数据库已存在时设置它不会重置任何口令。
  **生产环境建议不设置**（保持随机口令），避免环境变量泄露导致管理员口令泄露。

### 2.6 启动服务

方式一（推荐，一键脚本）：

```batch
start.bat
```

`start.bat` 会依次：尝试 `git pull --ff-only` 更新 → 迁移根目录 `problems/` 到 `backend/data/problems/`
→ 检查 Node → 重新编译 `sandbox_runner.exe` → 按需 `npm install` → 创建日志目录 →
启动服务并把全部输出重定向到 `log/<时间戳>/server.log` → 打开 `http://localhost:3000`。

方式二（手动）：

```batch
cd backend
npm start
```

健康检查：`GET /api/v1/health` 返回 `{"ok":true,...}` 即服务就绪。

### 2.7 反向代理要点（nginx / Caddy / Cloudflare Tunnel 等）

1. **`TRUST_PROXY=1`**：只有显式设置该变量（`1` 或 `true`）时，服务才会信任 `X-Forwarded-For` 首跳
   （`app.set('trust proxy', 1)`，只信任 1 跳）。未设置时一律以 socket 地址作为客户端 IP，
   用于限流与审计；设置后请确保代理会**覆写/正确传递** XFF，否则限流键可被伪造。
2. **`COOKIE_SECURE=true`**：对外提供 HTTPS 时必须设置，Access/Refresh Token Cookie 才带 `Secure` 标志；
   纯本地 HTTP 部署保持默认 `false`。
3. **WebSocket**：Socket.io 使用同一端口，反向代理需放行 `Upgrade` / `Connection` 头与长连接。
4. **请求体大小**：上传接口限制 10MB/文件，代理的 `client_max_body_size` 建议 ≥ 10MB。
5. **不要关闭 HTTPS 校验**：不要为了方便把 `CORS_RESTRICTED` 设为 `false` 并暴露公网
   （`false` 会反射任意 Origin 携带凭据调用 API，仅限本地/内网演示）。
6. **端口**：服务监听 `config.port`（`PORT` 环境变量，默认 3000），监听所有网卡；如仅本机访问，
   请在防火墙/代理层限制来源。

## 3. 环境变量表

完整配置说明另见 wiki：https://github.com/dxxjudges/NoldOJ/wiki/Configuration

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | HTTP 监听端口 |
| `DB_PATH` | `backend/data/NoldOJ.db` | SQLite 数据库文件路径 |
| `SANDBOX_TEMP` | 系统临时目录下 `NoldOJ-sandbox` | 沙箱判题临时工作目录（每次判题独立子目录，结束后删除） |
| `NoldOJ_PROBLEMS_DIR` | `backend/data/problems` | 题目测试数据目录（与库同级，便于整体备份） |
| `NoldOJ_JUDGE_THREADS` | `(CPU 核数 + 1) / 2`，最小 1 | 判题并发线程数；`config/judge.txt` 的 `MAX_THREADS=` 优先级高于本变量 |
| `NoldOJ_ALLOW_NO_SANDBOX` | 未设置 | Windows 缺 `sandbox_runner.exe` 时**默认 fail-closed 拒绝判题**；设为 `1` 才允许无沙箱回退（不安全，仅限本地开发） |
| `OJ_LOG_DIR` | `start.bat` 生成的 `log/<时间戳>/` | 运行日志与管理员操作日志（`admin.log`）、沙箱诊断目录 |
| `TRUST_PROXY` | 未设置 | `1`/`true` 时信任 `X-Forwarded-For` 首跳（仅 1 跳），用于反向代理后取真实 IP |
| `COOKIE_SECURE` | `false` | `true` 时 Token Cookie 带 `Secure`，对外 HTTPS 部署必设 |
| `NoldOJ_INIT_ADMIN_PASSWORD` | 未设置 | **仅数据库首次初始化**时指定 admin 初始口令（日志不回显）；生产建议不设＝随机口令 |
| `NoldOJ_CAPTCHA_DEBUG` | 未设置 | 调试用：验证码接口返回 `code` 供自动化作答。**仅测试环境使用，生产/日常运行严禁设置** |
| `NoldOJ_ROOT` | 推导为项目根 | 指定项目根路径，用于沙箱诊断日志 `log/sandbox.log` 定位 |
| `NODE_ENV` | — | 未参与业务逻辑判定，可不设置 |

配置文件（`config/*.txt`）的字段与默认值见 README「配置说明」与 `example-config/`。

## 4. 备份

需要备份的内容：

- **核心（必须）**：`backend/data/` **整目录**
  - `NoldOJ.db`（SQLite 主库）及同名的 `NoldOJ.db-wal` / `NoldOJ.db-shm`（WAL 模式下的预写日志与共享内存文件）；
  - `problems/`（题目测试数据，即 `NoldOJ_PROBLEMS_DIR` 的默认位置）；
- **其他**：根目录 `data/`（上传文件/图床等运行时数据）、`config/`（密钥与开关配置）。

建议流程：

1. **先停服**（关闭 `start.bat` 窗口，或结束 `node backend\src\server.js` 进程），确保 WAL 已合并、文件未被占用；
2. 复制整个 `backend\data\` 目录到备份位置（连同 `-wal`、`-shm` 文件一起复制，否则可能丢失未落盘数据）；
   同时复制根目录 `data\` 与 `config\`；
3. **校验**：停服后运行 `node scripts\migrate-sqlite.js`，它会自动把 `NoldOJ.db` 备份为
   `NoldOJ.db.backup-<时间戳>`，再做 `PRAGMA integrity_check` 与逐表行数统计，全部 PASS 才算备份可用；
4. 备份异地留存。`config/` 下的密钥不在仓库中，丢失将导致 JWT 全部失效、邮件/AI 需重新配置。

恢复：停服 → 用备份覆盖回 `backend/data/`（以及需要时的根 `data/`、`config/`）→ 启动，schema 迁移会在启动时自动执行。

## 5. 升级流程

```batch
:: 1. 停止服务（关闭 start.bat 窗口）
:: 2. 备份 backend/data/ 整目录（见上节）
git pull
cd backend
npm ci
cd ..
cd backend\sandbox
build.bat
cd ..\..
start.bat
```

- `start.bat` 默认会自动 `git pull --ff-only` 与重新编译沙箱；存在本地改动时拉取失败会继续用当前版本启动。
- 数据库 schema **在启动时自动迁移**（新增列/表，幂等），无需手工执行 SQL；务必先停服再升级，避免文件占用。
- 版本跨度较大时（如 sql.js → node:sqlite），请先按 README「数据库迁移」章节操作：停服 → 更新 →
  `node scripts\migrate-sqlite.js` 备份校验 → 启动。
- 升级后检查启动日志中的 WARN（如沙箱未编译、`CORS_RESTRICTED=false` 等高风险状态）。

## 6. 常见问题

**Q: 提交一直显示"评测中" / 日志出现"安全沙箱运行器缺失"？**
A: Windows 上 `sandbox_runner.exe` 未编译时**默认 fail-closed 拒绝判题**（这是预期的安全行为）。执行
`cd backend\sandbox && build.bat` 编译（需 g++/MinGW 在 `PATH` 中），或用 `start.bat` 启动让它自动编译。
本地开发确需无沙箱运行才设置 `NoldOJ_ALLOW_NO_SANDBOX=1`（不安全，**禁止生产使用**）。

**Q: 验证码接口返回 `code` 字段 / 登录不需要验证码？**
A: 你设置了 `NoldOJ_CAPTCHA_DEBUG=1`。该变量**仅用于自动化测试**，**切勿在生产或日常运行中设置**；
排查完请立即移除并重启服务。生产环境验证码开关用 `config/captcha.txt` 的 `CAPTCHA_ENABLED` 控制。

**Q: 反向代理后限流/日志里的 IP 全是代理地址？**
A: 设置 `TRUST_PROXY=1`，并确保代理正确覆写 `X-Forwarded-For`。未设置时服务不读取任何代理头（防伪造）。

**Q: HTTPS 部署后登录态异常/被浏览器拒绝 Cookie？**
A: 对外 HTTPS 请设置 `COOKIE_SECURE=true`；纯 HTTP 本地部署保持 `false`。

**Q: 端口被占用 / 想换端口？**
A: 设置 `PORT=xxxx` 后重启服务；反向代理的上游端口需同步修改。

**Q: 忘记 / 未记录初始管理员口令？**
A: 口令只在首次初始化的启动日志 `log/<时间戳>/server.log` 中显示一次。若已丢失，可在停服后用 SQLite 工具删除
`users` 表中 `username='admin'` 的记录，下次启动会重新创建 admin 并**再次在日志中打印一次性随机口令**；
已有其它超管账号时也可直接用超管在面板中重置。请勿为了方便在生产长期设置 `NoldOJ_INIT_ADMIN_PASSWORD`。

**Q: 数据库文件损坏或需要迁移？**
A: 停服后备份，运行 `node scripts\migrate-sqlite.js` 自动备份 + `PRAGMA integrity_check` + 行数统计；
迁移步骤详见 README「数据库迁移（sql.js → node:sqlite）」。

**Q: 备份后恢复，测试数据丢失？**
A: 确认 `backend/data/problems/` 一并备份与恢复；若题目测试数据被自定义到
`NoldOJ_PROBLEMS_DIR` 指定的位置，该目录也需纳入备份。
