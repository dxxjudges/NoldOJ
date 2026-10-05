const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// 魔法数字常量: 评分规则 / 日志截断 / 资源限制
const SPJ_TIMEOUT_MS = 1000;

function compareTextStrict(expected, actual) {
  // Windows 下 C/C++(MSVC 文本模式)、Java 输出 CRLF，Python/Node 输出 LF；
  // 而期望文件的换行风格取决于数据来源（AI 生成已归一化为 LF，ZIP/.out 上传则原样落盘）。
  // trimEnd() 只去字符串最末尾，行中间的 \r 去不掉，必须先统一分隔符，
  // 否则同一份数据无法同时满足各语言（整题全 WA）。
  const normalize = (s) => String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
  return normalize(expected) === normalize(actual);
}

function compareTextRelaxed(expected, actual) {
  const normalize = (s) => s.replace(/\r\n/g, '\n').replace(/\t/g, ' ').replace(/ +/g, ' ').replace(/^ +| +$/gm, '').replace(/\n{2,}/g, '\n').trimEnd();
  return normalize(expected) === normalize(actual);
}

function compareRealNumber(expected, actual, tolerance) {
  const expectedLines = expected.trim().split(/\s+/);
  const actualLines = actual.trim().split(/\s+/);
  if (expectedLines.length !== actualLines.length) return false;
  for (let i = 0; i < expectedLines.length; i++) {
    const e = parseFloat(expectedLines[i]);
    const a = parseFloat(actualLines[i]);
    if (isNaN(e) || isNaN(a)) {
      if (expectedLines[i] !== actualLines[i]) return false;
      continue;
    }
    const absErr = Math.abs(e - a);
    const relErr = e !== 0 ? absErr / Math.abs(e) : absErr;
    if (absErr > tolerance.absolute && relErr > tolerance.relative) return false;
  }
  return true;
}

// 比较器三态结果：ok=判定通过；!ok=判定不通过（该算学生的错）；
// checkerError=比较器自身故障（SPJ 抛错/超时/输出无法解析、容差配置非法）。
// 后者绝不能落成"答案错误"，否则教师写错的 SPJ 会让全站提交静默变 WA 且无从排查。
function compareOutputSync(expected, actual, problem) {
  const mode = problem.compare_mode;
  if (mode === 'text_relaxed') return { ok: compareTextRelaxed(expected, actual), checkerError: null };
  if (mode === 'real_number') {
    let tolerance = { absolute: 0.001, relative: 0.001 };
    if (problem.real_number_tolerance !== undefined && problem.real_number_tolerance !== null && problem.real_number_tolerance !== '') {
      try { tolerance = JSON.parse(problem.real_number_tolerance); } catch {
        return { ok: false, checkerError: 'real_number_tolerance 不是合法 JSON，无法比对。' };
      }
      const a = Number(tolerance && tolerance.absolute);
      const r = Number(tolerance && tolerance.relative);
      if (!isFinite(a) || !isFinite(r) || a < 0 || r < 0) {
        return { ok: false, checkerError: 'real_number_tolerance 结构非法，无法比对。' };
      }
      tolerance = { absolute: a, relative: r };
    }
    return { ok: compareRealNumber(expected, actual, tolerance), checkerError: null };
  }
  return { ok: compareTextStrict(expected, actual), checkerError: null };
}

async function compareOutputEx(expected, actual, problem) {
  if (problem.compare_mode === 'spj') {
    const r = await runSPJEx(problem.spj_code, expected, actual);
    if (r.error) return { ok: false, checkerError: r.error };
    return { ok: r.pass, checkerError: null };
  }
  return compareOutputSync(expected, actual, problem);
}

// 对外保持原签名：非 SPJ 模式同步返回布尔（现有单测与调用方依赖这一点），SPJ 返回 Promise
function compareOutput(expected, actual, problem) {
  if (problem.compare_mode === 'spj') {
    return compareOutputEx(expected, actual, problem).then(r => r.ok);
  }
  return compareOutputSync(expected, actual, problem).ok;
}

// SPJ 执行: 改为子进程模式，彻底消除主进程事件循环阻塞与 vm 逃逸（D-H3/D-M10）。
// 原实现在判题进程内同步 vm.runInContext: 长 SPJ 会卡死单线程事件循环；
// 且 vm 逃逸可触及宿主 realm。现改为 spawn 独立 node 子进程（进程级隔离），
// 子进程内再套一层 vm + JSON 字面量注入保持 realm 隔离，超时/输出超限即 kill。
function runSPJEx(spjCode, expected, actual) {
  return new Promise((resolve) => {
    let tmpDir = null;
    let settled = false;
    let timer = null;
    const finish = (pass, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // SPJ 临时目录清理尽力而为，失败不影响判定结果
      }
      resolve({ pass: !!pass, error: error || null });
    };

    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'NoldOJ-spj-'));
      const dataFile = path.join(tmpDir, 'data.json');
      const wrapperFile = path.join(tmpDir, 'spj.js');

      // vm 逃逸防护沿用原方案: 不注入任何宿主对象，数据序列化为 JSON 字符串字面量
      // 拼进脚本源码，使沙箱内的一切（含构造函数）都属于 vm 的独立 realm。
      // 构造方式: 先对参数做 JSON 编码（stdinJson 等为 JSON 文本），再用 JSON.stringify
      // 把该文本包成 JS 字符串字面量传给 JSON.parse，避免嵌套引号双重转义错误。
      const stdinJson = JSON.stringify('');
      const stdoutJson = JSON.stringify(String(actual ?? ''));
      const answerJson = JSON.stringify(String(expected ?? ''));
      const mkArg = (j) => 'JSON.parse(' + JSON.stringify(j) + ')';
      const argsSrc = [mkArg(stdinJson), mkArg(stdoutJson), mkArg(answerJson)].join(', ');

      const wrapper = [
        'const vm = require("vm");',
        'const fs = require("fs");',
        `const data = JSON.parse(fs.readFileSync(${JSON.stringify(dataFile)}, "utf8"));`,
        'const sandbox = vm.createContext({});',
        `const vmSrc = "(function(stdin, stdout, answer) { " + data.spj + " })(" + ${JSON.stringify(argsSrc)} + ")";`,
        'const script = new vm.Script(vmSrc);',
        'try {',
        `  const result = script.runInContext(sandbox, { timeout: ${SPJ_TIMEOUT_MS} });`,
        '  process.stdout.write(JSON.stringify({ ok: true, pass: (result === true || result === 1 || result === "AC") }));',
        '} catch (e) {',
        '  process.stdout.write(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));',
        '}'
      ].join('\n');
      fs.writeFileSync(wrapperFile, wrapper, 'utf8');
      fs.writeFileSync(dataFile, JSON.stringify({ spj: String(spjCode ?? '') }), 'utf8');

      const proc = spawn(process.execPath, [wrapperFile], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
      let out = '';
      proc.stdout.on('data', (d) => {
        out += d.toString();
        if (out.length > 65536) { try { proc.kill('SIGKILL'); } catch { /* 进程可能已退出，kill 失败可忽略 */ } }
      });

      // 硬超时: 独立 kill 子进程，不阻塞事件循环
      timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* 进程可能已退出，kill 失败可忽略 */ }
        finish(false, 'SPJ 超时未返回结果');
      }, SPJ_TIMEOUT_MS + 1000);

      proc.on('error', () => finish(false, 'SPJ 进程启动失败'));
      proc.on('close', () => {
        const raw = out.trim().split('\n').pop() || '';
        try {
          const j = JSON.parse(raw);
          if (!j || !j.ok) {
            finish(false, 'SPJ 执行出错: ' + String((j && j.error) || 'unknown'));
          } else {
            finish(!!j.pass, null);
          }
        } catch {
          finish(false, 'SPJ 输出无法解析: ' + raw.slice(0, 200));
        }
      });
    } catch (e) {
      finish(false, 'SPJ 执行异常: ' + String((e && e.message) || e));
    }
  });
}

module.exports = { compareOutput, compareOutputEx };
