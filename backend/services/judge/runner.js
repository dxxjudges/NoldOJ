const fs = require('fs');
const path = require('path');
const db = require('../../database/db');
const sandbox = require('../../sandbox/executor');
const config = require('../../config/config');
const { compareOutputEx } = require('./compare');
const { evaluateSimple, evaluateWithGroups, topoSortGroups } = require('./scoring');

// 魔法数字常量: 评分规则 / 日志截断 / 资源限制
const MAX_OUTPUT_LOG_CHARS = 4096;
const MAX_TESTDATA_BYTES = 16 * 1024 * 1024; // 16MB 单测试数据文件上限
// D-M11: 测试点资源硬上限兜底（教师可配置任意值 → 服务端强制封顶，防判题线程被独占）
const MAX_TL_MS = 10000;     // 单测试点 ≤10s
// problem.memory_limit / test_cases.memory_limit 全链路存的是 **MB**
// （executor: memoryLimitMb*1024→KB；sandbox_runner: *1024*1024→bytes；前端默认 256、显示 "MB"）。
// 原先这里写成 1024*1024 并命名为 _KB，等于把封顶放到 1TB —— 形同虚设，
// 而且会成为"MLE 漏判"的根因之一：内存限制被放到天量后 Job Object 永不触发 OOM。
const MAX_ML_MB = 1024; // 单测试点 ≤1024MB

// D-M11: 服务端硬上限钳制（TLE≤10s、MLE≤1024MB）
function clampLimits(tl, ml) {
  const t = Number(tl) > 0 ? Number(tl) : null;
  const m = Number(ml) > 0 ? Number(ml) : null;
  return {
    tl: t === null ? null : Math.min(t, MAX_TL_MS),
    ml: m === null ? null : Math.min(m, MAX_ML_MB)
  };
}

// D-I5: 编译/判题错误信息可能含服务器内部路径，落库前用占位符替换，避免泄露目录结构
function stripInternalPaths(text, workDir) {
  if (!text) return text;
  let out = String(text);
  if (workDir) out = out.split(workDir).join('{sandbox}');
  return out;
}

// 读取测试数据文件，限制单文件大小防止超大用例整读入内存导致 OOM。
// 路径包含校验：测试数据只允许位于 backend/../problems/ 目录内（判题进程以 backend 为 CWD）。
// 允许绝对路径（上传/zip 路由落库形式，path.join(problemDir,…)），但解析后必须仍在 problemsRoot 内；
// 相对路径（导入路由落库的 safeFileName 纯文件名）以 problemDir（problems/<id>/）为基准解析，
// 与导出侧 resolveFilePath 的基准一致（9.4），保证"仅有 input_file 且指向问题子目录相对路径"的用例可读。
// 拒绝越出 problemsRoot 的 .. 穿越，杜绝教师导入 output_file:"../../config/jwt.txt" 等任意文件读取（D-H2）。
const PROBLEMS_ROOT = config.problemsDir;
function readTestdata(filePath, problemDir) {
  if (!filePath) return '';
  const problemsRoot = path.resolve(PROBLEMS_ROOT);
  const base = problemDir ? path.resolve(problemDir) : problemsRoot;
  const resolved = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(base, filePath);
  if (resolved !== problemsRoot && !resolved.startsWith(problemsRoot + path.sep)) {
    throw new Error('Invalid test data path (outside problems directory)');
  }
  try {
    const stat = fs.statSync(resolved);
    if (stat.size > MAX_TESTDATA_BYTES) {
      throw new Error('Test data file exceeds 16MB limit');
    }
    return fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new Error('Failed to read test data: ' + err.message, { cause: err });
  }
}

async function evaluateTestCases(submission, problemId, testCases, timeLimitMs) {
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(problemId);
  if (!problem) return;

  // 9.4: 相对路径 testdata 以本题目目录为基准（与导出侧 resolveFilePath 一致）
  const problemDir = path.join(PROBLEMS_ROOT, String(problemId));

  const updateDetail = db.prepare(`UPDATE submission_details SET status=?, score=?, time_used=?, memory_used=?, stdout=?, stderr=?, exit_code=?, checker_output=? WHERE id=?`);
  const updateSubmission = db.prepare(`UPDATE submissions SET status=?, score=?, time_used=?, memory_used=?, compile_output=? WHERE id=?`);
  const insertDetail = db.prepare('INSERT INTO submission_details (submission_id, test_case_id, group_id, subtask_id, status) VALUES (?, ?, ?, ?, ?)');

  const langConfig = sandbox.loadLanguageConfig();
  const lang = langConfig[submission.language] || { compile: '', run: '', ext: '.txt' };
  let workDir, srcFile, exeFile, isWindows, isMultiFile = false;

  const groups = db.prepare('SELECT * FROM test_groups WHERE problem_id = ? ORDER BY id').all(problemId);
  const hasGroups = groups.length > 0;

  // 检查是否有多文件记录
  const subFiles = db.prepare('SELECT filename, content FROM submission_files WHERE submission_id = ? ORDER BY id').all(submission.id);

  // submit_answer 题型：无需编译运行，直接比较提交的 answer_data 与预期输出
  if (problem.problem_type === 'submit_answer') {
    const tcResults = [];
    for (const tc of testCases) {
      const detail = insertDetail.run(submission.id, tc.id, tc.group_id || null, tc.subtask_id || '', 'running');
      const detailId = detail.lastInsertRowid;
      let expected;
      try {
        expected = tc.output_data || readTestdata(tc.output_file, problemDir);
      } catch (err) {
        updateDetail.run('system_error', 0, 0, 0, '', err.message, -1, '', detailId);
        tcResults.push({ tcId: tc.id, groupId: tc.group_id, subtaskId: tc.subtask_id || '', status: 'system_error', score: 0, timeUsed: 0, memoryUsed: 0, stdout: '', stderr: err.message, exitCode: -1, detailId });
        continue;
      }
      const answer = submission.answer_data || '';
      const cmp = await compareOutputEx(expected, answer, problem);
      // 比较器故障（容差配置非法 / SPJ 出错）不得记成学生的"答案错误"
      const status = cmp.ok ? 'accepted' : (cmp.checkerError ? 'system_error' : 'wrong_answer');
      const checkerError = cmp.checkerError || '';
      updateDetail.run(status, 0, 0, 0, answer.slice(0, MAX_OUTPUT_LOG_CHARS), '', 0, checkerError.slice(0, MAX_OUTPUT_LOG_CHARS), detailId);
      tcResults.push({ tcId: tc.id, groupId: tc.group_id, subtaskId: tc.subtask_id || '', status, score: tc.score, timeUsed: 0, memoryUsed: 0, stdout: answer.slice(0, MAX_OUTPUT_LOG_CHARS), stderr: '', exitCode: 0, detailId, checkerOutput: checkerError });
    }

    let finalScore, finalStatus, finalTime, finalMemory;
    if (hasGroups) {
      const result = evaluateWithGroups(problem, groups, tcResults);
      finalScore = result.score; finalStatus = result.status; finalTime = result.time; finalMemory = result.memory;
    } else {
      const result = evaluateSimple(problem, tcResults);
      finalScore = result.score; finalStatus = result.status; finalTime = result.time; finalMemory = result.memory;
    }
    for (const tc of tcResults) {
      updateDetail.run(tc.status, tc.status === 'accepted' ? tc.score : 0, tc.timeUsed, tc.memoryUsed, tc.stdout || '', tc.stderr || '', typeof tc.exitCode === 'number' ? tc.exitCode : -1, tc.checkerOutput || '', tc.detailId);
    }
    updateSubmission.run(finalStatus, finalScore, finalTime, finalMemory, '', submission.id);
    return;
  }

  try {
    let prepared;
    if (subFiles && subFiles.length > 0) {
      prepared = sandbox.prepareWorkDirMulti(submission.language, subFiles);
      isMultiFile = prepared.isMultiFile;
    } else {
      prepared = sandbox.prepareWorkDir(submission.language, submission.source_code);
    }
    workDir = prepared.workDir;
    srcFile = prepared.srcFile;
    exeFile = prepared.exeFile;
    isWindows = prepared.isWindows;

    const compileResult = sandbox.compile(workDir, srcFile, exeFile, lang, isWindows, isMultiFile);
    if (!compileResult.success) {
      const safeOutput = stripInternalPaths(compileResult.output, workDir);
      const detail = insertDetail.run(submission.id, null, null, '', 'running');
      updateDetail.run('compile_error', 0, 0, 0, '', safeOutput, -1, '', detail.lastInsertRowid);
      updateSubmission.run('compile_error', 0, 0, 0, safeOutput, submission.id);
      sandbox.cleanupWorkDir(workDir);
      return;
    }

    const tcResults = [];

    // 单个测试点的执行与结果落库（分组 / 未分组 / 无分组三种路径共用）
    // 返回该测试点是否 accepted
    const runOneTestCase = async (tc) => {
      const detail = insertDetail.run(submission.id, tc.id, tc.group_id || null, tc.subtask_id || '', 'running');
      const detailId = detail.lastInsertRowid;
      try {
        const stdin = tc.input_data || readTestdata(tc.input_file, problemDir);
        const expected = tc.output_data || readTestdata(tc.output_file, problemDir);
        const { tl: tcTimeLimit, ml: tcMemLimit } = clampLimits(tc.time_limit || timeLimitMs, tc.memory_limit || problem.memory_limit);
        const result = await sandbox.runCode(workDir, srcFile, exeFile, lang, stdin, tcTimeLimit, tcMemLimit, isWindows, problem.problem_type);

        const timeUsed = result.timeUsed;
        const cmp = await compareOutputEx(expected, result.stdout, problem);
        const passed = cmp.ok;
        const checkerError = cmp.checkerError || '';
        let status = passed ? 'accepted' : 'wrong_answer';
        if (result.signal === 'MEMORY_LIMIT') status = 'memory_limit_exceeded';
        // 输出超限是独立状态: 若并入 SIGKILL 分支会被误报成 TLE
        else if (result.signal === 'OUTPUT_LIMIT') status = passed ? 'accepted' : 'wrong_answer';
        else if (result.signal === 'SIGKILL' || timeUsed >= tcTimeLimit) status = 'time_limit_exceeded';
        else if (result.exitCode !== 0) status = 'runtime_error';
        // 比较器自身故障只能归为 system_error；放在最后表示仅在"其它原因都解释不了"时兜底
        else if (checkerError) status = 'system_error';

        const memKB = result.memoryUsed || 0;
        const logOut = (result.stdout || '').slice(0, MAX_OUTPUT_LOG_CHARS);
        const logErr = (result.stderr || '').slice(0, MAX_OUTPUT_LOG_CHARS);
        updateDetail.run(status, 0, timeUsed, memKB, logOut, logErr, result.exitCode, checkerError.slice(0, MAX_OUTPUT_LOG_CHARS), detailId);
        tcResults.push({ tcId: tc.id, groupId: tc.group_id, subtaskId: tc.subtask_id || '', status, score: tc.score, timeUsed, memoryUsed: memKB, stdout: logOut, stderr: logErr, exitCode: result.exitCode, detailId, checkerOutput: checkerError });
        return status === 'accepted';
      } catch (err) {
        const msg = stripInternalPaths(err.message, workDir);
        updateDetail.run('system_error', 0, 0, 0, '', msg, -1, '', detailId);
        tcResults.push({ tcId: tc.id, groupId: tc.group_id, subtaskId: tc.subtask_id || '', status: 'system_error', score: 0, timeUsed: 0, memoryUsed: 0, stdout: '', stderr: msg, exitCode: -1, detailId });
        return false;
      }
    };

    if (hasGroups) {
      const tcMap = new Map();
      for (const tc of testCases) {
        if (!tcMap.has(tc.group_id || 0)) tcMap.set(tc.group_id || 0, []);
        tcMap.get(tc.group_id || 0).push(tc);
      }

      const failedGroups = new Set();
      const topoOrder = topoSortGroups(groups);

      for (const groupId of topoOrder) {
        const group = groups.find(g => g.id === groupId);
        let deps = [];
        try { deps = JSON.parse(group.dependency || '[]'); } catch { /* 依赖配置非法时按无依赖处理 */ }

        const depFailed = deps.some(d => failedGroups.has(d));

        if (depFailed) {
          const groupTCs = tcMap.get(groupId) || [];
          for (const tc of groupTCs) {
            const detail = insertDetail.run(submission.id, tc.id, tc.group_id || null, tc.subtask_id || '', 'skipped');
            const detailId = detail.lastInsertRowid;
            updateDetail.run('skipped', 0, 0, 0, '', '', -1, '', detailId);
            tcResults.push({
              tcId: tc.id,
              groupId: tc.group_id,
              subtaskId: tc.subtask_id || '',
              status: 'skipped',
              score: 0,
              timeUsed: 0,
              memoryUsed: 0,
              stdout: '',
              stderr: '',
              exitCode: -1,
              detailId
            });
          }
          failedGroups.add(groupId);
          continue;
        }

        const groupTCs = tcMap.get(groupId) || [];
        let groupAllAccepted = true;

        for (const tc of groupTCs) {
          if (!(await runOneTestCase(tc))) groupAllAccepted = false;
        }

        if (!groupAllAccepted) {
          failedGroups.add(groupId);
        }
      }

      // 未分组测试点（group_id IS NULL → 聚到 key 0）不属于任何 test_group，
      // 上面的 topoOrder 遍历永远命不中。routes/problems.js 删除分组时会执行
      // `UPDATE test_cases SET group_id = NULL`，新增测试点时若不选分组同样落到 key 0。
      // 若不执行，这些点既不跑也没有详情、更不计分 —— 学生只做剩余分组即可拿满分。
      const ungroupedTCs = tcMap.get(0) || [];
      for (const tc of ungroupedTCs) {
        await runOneTestCase(tc);
      }
    } else {
      for (const tc of testCases) {
        await runOneTestCase(tc);
      }
    }

    if (workDir) sandbox.cleanupWorkDir(workDir);

    let finalScore, finalStatus, finalTime, finalMemory;

    if (hasGroups) {
      const result = evaluateWithGroups(problem, groups, tcResults);
      finalScore = result.score;
      finalStatus = result.status;
      finalTime = result.time;
      finalMemory = result.memory;
    } else {
      const result = evaluateSimple(problem, tcResults);
      finalScore = result.score;
      finalStatus = result.status;
      finalTime = result.time;
      finalMemory = result.memory;
    }

    for (const tc of tcResults) {
      updateDetail.run(tc.status, tc.status === 'accepted' ? tc.score : 0, tc.timeUsed, tc.memoryUsed, tc.stdout || '', tc.stderr || '', typeof tc.exitCode === 'number' ? tc.exitCode : -1, tc.checkerOutput || '', tc.detailId);
    }

    updateSubmission.run(finalStatus, finalScore, finalTime, finalMemory, '', submission.id);
  } catch (err) {
    // 无论编译/判题是否深入，只要建过 workDir 就清理，避免临时文件残留
    if (workDir) sandbox.cleanupWorkDir(workDir);
    updateSubmission.run('system_error', 0, 0, 0, stripInternalPaths(err.message, workDir), submission.id);
  }
}

module.exports = { evaluateTestCases };
