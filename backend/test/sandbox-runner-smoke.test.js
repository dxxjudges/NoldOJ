// CI 冒烟测试（P0-1）：sandbox_runner 的 workDir 与判题元数据分离
// 背景：runner 曾用 dirName(metaFile)（= tempDir 根）当 workDir 做降标/授权，
// 把元数据与并发提交目录一并暴露，推翻 executor 的“元数据放 workDir 之外防伪造”设计。
// 本测试用与 executor.js runCodeSandboxed 完全相同的布局（meta 为 workDir 的兄弟文件）
// 断言：1) 正常运行元数据写在 workDir 之外且退出码正确；2) meta 位于 workDir 内时拒绝执行。
// 由 CI 的 windows-latest job 调用（ubuntu 无该运行器，自动 skip）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const isWin = process.platform === 'win32';
const exe = path.join(__dirname, '..', 'sandbox', 'sandbox_runner.exe');
const skip = !isWin ? '仅 Windows 平台'
  : (!fs.existsSync(exe) ? '缺 sandbox_runner.exe（先运行 sandbox\\build.bat）' : false);

function run(cwd, meta) {
  // where.exe 为无参数依赖的系统自带 exe，验证过的 executor 风格调用形态（参数各自独立、含空格会被 quoteCmdArg 正确包裹）
  return spawnSync(exe, ['3000', '64', '16', meta, 'where.exe', 'where.exe'], {
    cwd, encoding: 'utf8', timeout: 30000, windowsHide: true
  });
}

test('P0-1: 正常运行 — meta 写在 workDir 之外、退出码 0', { skip }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'noldoj-smoke-'));
  try {
    const workDir = path.join(base, 'work');
    fs.mkdirSync(workDir);
    const meta = path.join(base, 'run.meta.json'); // workDir 的兄弟位置（executor 真实布局）
    const r = run(workDir, meta);
    assert.ok(fs.existsSync(meta), `meta 应写在 workDir 之外。stderr: ${r.stderr || ''} stdout: ${r.stdout || ''}`);
    assert.ok(!path.resolve(meta).startsWith(path.resolve(workDir) + path.sep), 'meta 不应位于 workDir 内');
    const j = JSON.parse(fs.readFileSync(meta, 'utf8'));
    assert.equal(j.exit_code, 0, `exit_code 应为 0: ${JSON.stringify(j)}`);
    assert.ok(j.time_used >= 0, 'time_used 应有效');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('P0-1: 防伪造自检 — meta 位于 workDir 内时拒绝执行 (SYSTEM_ERROR)', { skip }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'noldoj-smoke2-'));
  try {
    const workDir = path.join(base, 'work');
    fs.mkdirSync(workDir);
    const meta = path.join(workDir, 'in.meta.json'); // 故意放进 workDir
    const r = run(workDir, meta);
    assert.ok(fs.existsSync(meta), '应写出 SYSTEM_ERROR 元数据');
    const j = JSON.parse(fs.readFileSync(meta, 'utf8'));
    assert.equal(j.exit_code, -1, JSON.stringify(j));
    assert.equal(j.signal, 'SYSTEM_ERROR', JSON.stringify(j));
    assert.notEqual(r.status, 0, 'runner 应以非 0 退出');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
