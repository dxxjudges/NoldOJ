// routes/problems/testdata.js —— 测试数据上传/管理（测试点、分组、评分脚本）
const express = require('express');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { buildUpdates } = require('../../utils/db');
const { sanitizeLog } = require('../../utils/securityHelpers');
const config = require('../../config/config');
const repo = require('../../repositories/problems');
const { upload, assertInsideProblemDir } = require('./helpers');

const { sendNotFound } = require('../../utils/apiErrors');
const { logError } = require('../../utils/logger');

const router = express.Router();

router.post('/:id/testdata', requireAuth, requireRole('teacher'), upload.array('files', 100), (req, res) => {
  // 清理 multer 临时文件（含异常路径），避免磁盘残留
  const cleanupFiles = () => {
    if (!req.files) return;
    for (const f of req.files) {
      try { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch { /* 临时上传文件清理尽力而为 */ }
    }
  };

  const problem = repo.getProblemById(req.params.id);
  if (!problem) {
    cleanupFiles();
    return sendNotFound(res, 'Problem not found.');
  }
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No files uploaded.' });
  }

  const problemDir = path.join(config.problemsDir, String(problem.id));
  fs.mkdirSync(problemDir, { recursive: true });

  try {
    // R9-25: 100×200MB 可写 ~20GB/请求，限制总大小
    const MAX_TESTDATA_TOTAL_BYTES = 200 * 1024 * 1024;
    let totalBytes = 0;
    for (const f of req.files) totalBytes += f.size || 0;
    if (totalBytes > MAX_TESTDATA_TOTAL_BYTES) {
      throw new Error(`Total testdata size exceeds ${MAX_TESTDATA_TOTAL_BYTES} bytes`);
    }

    const pairs = {};
    for (const file of req.files) {
      const match = file.originalname.match(/^(.+)\.(in|out)$/);
      if (!match) continue;
      // 文件名消毒: 只允许安全字符，且必须是纯文件名（防止 ../ 路径穿越）
      let name = path.basename(match[1]).replace(/[<>:"/\\|?*]/g, '_').replace(/^\.+/, '');
      const ext = match[2];
      if (!name) name = 'case';
      if (!pairs[name]) pairs[name] = {};
      const destPath = path.join(problemDir, `${name}.${ext}`);
      fs.renameSync(file.path, destPath);
      pairs[name][ext] = destPath;
    }

    let order = repo.getMaxSortOrder(problem.id);
    let count = 0;

    for (const files of Object.values(pairs)) {
      order++;
      repo.insertTestCaseFiles(problem.id, files.in || '', files.out || '', order);
      count++;
    }

    res.json({ message: `Uploaded ${count} test case(s).` });
  } finally {
    cleanupFiles();
  }
});

router.post('/:id/testdata-zip', requireAuth, requireRole('teacher'), upload.single('file'), (req, res) => {
  const problem = repo.getProblemById(req.params.id);
  if (!problem) {
    return sendNotFound(res, 'Problem not found.');
  }
  if (!req.file) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No file uploaded.' });
  }
  if (!req.file.originalname.endsWith('.zip')) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'File must be a .zip file.' });
  }

  const problemDir = path.join(config.problemsDir, String(problem.id));
  fs.mkdirSync(problemDir, { recursive: true });

  try {
    const zip = new AdmZip(req.file.path);
    const entries = zip.getEntries();

    // Zip Bomb 防御: 限制条目数量与解压后总大小
    const MAX_ZIP_ENTRIES = 1000;
    const MAX_ZIP_TOTAL_BYTES = 500 * 1024 * 1024; // 500MB
    let totalBytes = 0;
    if (entries.length > MAX_ZIP_ENTRIES) {
      throw new Error(`ZIP contains too many entries (max ${MAX_ZIP_ENTRIES})`);
    }

    const rootScript = [];
    const subtasks = {};
    const rootTestCases = {};

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      totalBytes += entry.header.size;
      if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
        throw new Error(`ZIP total uncompressed size exceeds ${MAX_ZIP_TOTAL_BYTES} bytes`);
      }
      const entryPath = entry.entryName.replace(/\\/g, '/'); // 归一化反斜杠，防 Windows 风格路径穿越
      const parts = entryPath.split('/').filter(p => p);
      if (parts.length === 0) continue;
      // Zip Slip 防御: 拒绝含 .. / 空段 / 绝对路径 / 危险字符的条目
      if (path.isAbsolute(entryPath) || parts.some(p => p === '..' || p === '.')) {
        continue;
      }
      if (!parts.every(p => /^[\w.-]+$/.test(p))) {
        continue; // 仅允许安全文件名（子任务名/用例名最终拼入磁盘路径）
      }

      const fileName = parts[parts.length - 1];
      // 仅允许文本类数据文件，防止 zip 内藏任意二进制/脚本被写入磁盘
      const extOk = /\.(in|out|ans|txt)$/i.test(fileName) || fileName.toLowerCase() === 'script.txt' || fileName.toLowerCase() === 'require.txt';
      if (!extOk) continue;

      if (parts.length === 1) {
        if (fileName.toLowerCase() === 'script.txt') {
          rootScript.push(entry.getData().toString('utf8'));
        } else {
          const match = fileName.match(/^(.+)\.(in|out|ans)$/);
          if (match) {
            const name = match[1];
            const ext = match[2] === 'ans' ? 'out' : match[2];
            if (!rootTestCases[name]) rootTestCases[name] = {};
            rootTestCases[name][ext] = entry.getData().toString('utf8');
          }
        }
      } else {
        const subtaskName = parts[0];
        if (!subtasks[subtaskName]) {
          subtasks[subtaskName] = { require: [], script: [], testCases: {} };
        }

        if (fileName.toLowerCase() === 'require.txt') {
          const content = entry.getData().toString('utf8');
          const deps = content.split(/[\s\n]+/).filter(s => s.trim());
          subtasks[subtaskName].require.push(...deps);
        } else if (fileName.toLowerCase() === 'script.txt') {
          subtasks[subtaskName].script.push(entry.getData().toString('utf8'));
        } else {
          const match = fileName.match(/^(.+)\.(in|out|ans)$/);
          if (match) {
            const name = match[1];
            const ext = match[2] === 'ans' ? 'out' : match[2];
            if (!subtasks[subtaskName].testCases[name]) subtasks[subtaskName].testCases[name] = {};
            subtasks[subtaskName].testCases[name][ext] = entry.getData().toString('utf8');
          }
        }
      }
    }

    repo.deleteTestCases(problem.id);
    repo.deleteTestGroups(problem.id);

    let order = 0;
    let count = 0;

    if (rootScript.length > 0) {
      repo.updateScoringScript(problem.id, rootScript.join('\n'));
    }

    for (const [subtaskName, subtaskData] of Object.entries(subtasks)) {
      const depIds = [];
      for (const depName of subtaskData.require) {
        const depGroup = repo.findTestGroupBySubtask(problem.id, depName);
        if (depGroup) depIds.push(depGroup.id);
      }

      const groupResult = repo.insertTestGroup(
        problem.id,
        subtaskName,
        0,
        'sum',
        JSON.stringify(depIds),
        subtaskData.script.join('\n')
      );
      const groupId = groupResult.lastInsertRowid;

      for (const [name, files] of Object.entries(subtaskData.testCases)) {
        order++;
        const inputPath = path.join(problemDir, `${subtaskName}_${name}.in`);
        const outputPath = path.join(problemDir, `${subtaskName}_${name}.out`);
        assertInsideProblemDir(problemDir, inputPath);
        assertInsideProblemDir(problemDir, outputPath);
        if (files.in) fs.writeFileSync(inputPath, files.in);
        if (files.out) fs.writeFileSync(outputPath, files.out);
        repo.insertTestCaseInGroup(problem.id, groupId, inputPath, outputPath, order);
        count++;
      }
    }

    for (const [name, files] of Object.entries(rootTestCases)) {
      order++;
      const inputPath = path.join(problemDir, `${name}.in`);
      const outputPath = path.join(problemDir, `${name}.out`);
      assertInsideProblemDir(problemDir, inputPath);
      assertInsideProblemDir(problemDir, outputPath);
      if (files.in) fs.writeFileSync(inputPath, files.in);
      if (files.out) fs.writeFileSync(outputPath, files.out);
      repo.insertTestCaseFiles(problem.id, inputPath, outputPath, order);
      count++;
    }

    fs.unlinkSync(req.file.path);
    res.json({ message: `Imported ${count} test case(s) from ${Object.keys(subtasks).length} subtask(s).` });
  } catch (err) {
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    logError('problems', 'ZIP import failed:', sanitizeLog(String(err && err.message || err)));
    res.status(500).json({ code: 2, reason: 'ERR_INVALID_STATE', message: 'ZIP 数据导入失败，请检查文件格式。' });
  }
});

router.get('/:id/testdata', requireAuth, requireRole('teacher'), (req, res) => {
  const problem = repo.getProblemById(req.params.id);
  if (!problem) {
    return sendNotFound(res, 'Problem not found.');
  }
  const testCases = repo.listTestCasesWithGroups(problem.id);

  const problemDir = path.join(config.problemsDir, String(problem.id));

  function resolveFilePath(baseDir, storedPath) {
    if (!storedPath) return null;
    // 防路径穿越: 一律 norm 到 baseDir 之下；绝对路径或含 .. 的拒绝
    const resolved = path.resolve(baseDir, storedPath);
    const base = path.resolve(baseDir);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
    return resolved;
  }

  const result = testCases.map(tc => {
    let inputData = tc.input_data || '';
    let outputData = tc.output_data || '';

    const inputPath = resolveFilePath(problemDir, tc.input_file);
    if (!inputData && inputPath && fs.existsSync(inputPath)) {
      try { inputData = fs.readFileSync(inputPath, 'utf8'); } catch { /* 读取失败保持空串兜底 */ }
    }

    const outputPath = resolveFilePath(problemDir, tc.output_file);
    if (!outputData && outputPath && fs.existsSync(outputPath)) {
      try { outputData = fs.readFileSync(outputPath, 'utf8'); } catch { /* 读取失败保持空串兜底 */ }
    }

    return {
      id: tc.id,
      group_id: tc.group_id || null,
      subtask_id: tc.subtask_id || '',
      input_data: inputData,
      output_data: outputData,
      input_file: tc.input_file ? path.basename(tc.input_file) : '',
      output_file: tc.output_file ? path.basename(tc.output_file) : '',
      score: tc.score,
      time_limit: tc.time_limit || null,
      memory_limit: tc.memory_limit || null,
      sort_order: tc.sort_order
    };
  });
  res.json(result);
});

router.post('/:id/testcases', requireAuth, requireRole('teacher'), (req, res) => {
  const problem = repo.getProblemById(req.params.id);
  if (!problem) {
    return sendNotFound(res, 'Problem not found.');
  }
  const { test_cases } = req.body;
  if (!Array.isArray(test_cases) || test_cases.length === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'test_cases array is required.' });
  }

  const maxOrder = repo.getMaxSortOrder(problem.id);
  let order = maxOrder;
  let count = 0;

  for (const tc of test_cases) {
    order++;
    const tl = tc.time_limit ? parseInt(tc.time_limit) : null;
    const ml = tc.memory_limit ? parseInt(tc.memory_limit) : null;
    if (tc.group_id !== undefined && tc.group_id !== null && tc.group_id !== '') {
      repo.insertTestCaseWithGroup(problem.id, tc.group_id, tc.input_data || '', tc.output_data || '', tc.score || 0, tl, ml, order);
    } else {
      repo.insertTestCase(problem.id, tc.input_data || '', tc.output_data || '', tc.score || 0, tl, ml, order);
    }
    count++;
  }

  res.json({ message: `Added ${count} test case(s).` });
});

router.delete('/:id/testcases', requireAuth, requireRole('teacher'), (req, res) => {
  const problem = repo.getProblemById(req.params.id);
  if (!problem) {
    return sendNotFound(res, 'Problem not found.');
  }
  repo.deleteTestCases(problem.id);
  res.json({ message: 'All test cases deleted.' });
});

router.get('/:id/groups', requireAuth, requireRole('teacher'), (req, res) => {
  const problem = repo.getProblemById(req.params.id);
  if (!problem) {
    return sendNotFound(res, 'Problem not found.');
  }
  const groups = repo.listTestGroups(problem.id);
  const result = groups.map(g => ({
    ...g,
    dependency: JSON.parse(g.dependency || '[]')
  }));
  res.json(result);
});

router.post('/:id/groups', requireAuth, requireRole('teacher'), (req, res) => {
  const problem = repo.getProblemById(req.params.id);
  if (!problem) {
    return sendNotFound(res, 'Problem not found.');
  }
  const { subtask_id, score, aggregator, dependency, scoring_script } = req.body;
  if (!subtask_id) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'subtask_id is required.' });
  }
  const result = repo.insertTestGroup(
    problem.id,
    subtask_id,
    score || 0,
    aggregator || 'sum',
    JSON.stringify(dependency || []),
    scoring_script || ''
  );
  const group = repo.getTestGroup(result.lastInsertRowid);
  res.status(201).json({ ...group, dependency: JSON.parse(group.dependency || '[]') });
});

router.put('/:id/groups/:gid', requireAuth, requireRole('teacher'), (req, res) => {
  const group = repo.getTestGroupOfProblem(req.params.id, req.params.gid);
  if (!group) {
    return sendNotFound(res, 'Group not found.');
  }
  const { subtask_id, score, aggregator, dependency, scoring_script } = req.body;
  const u = buildUpdates([
    { key: 'subtask_id', value: subtask_id },
    { key: 'score', value: score },
    { key: 'aggregator', value: aggregator },
    { key: 'dependency', value: dependency, transform: v => JSON.stringify(v) },
    { key: 'scoring_script', value: scoring_script }
  ]);
  if (u.count === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  repo.updateTestGroup(group.id, u);
  const updated = repo.getTestGroup(group.id);
  res.json({ ...updated, dependency: JSON.parse(updated.dependency || '[]') });
});

router.delete('/:id/groups/:gid', requireAuth, requireRole('teacher'), (req, res) => {
  const group = repo.getTestGroupOfProblem(req.params.id, req.params.gid);
  if (!group) {
    return sendNotFound(res, 'Group not found.');
  }
  repo.clearTestCasesGroup(group.id);
  // 从所有分组 dependency JSON 中安全移除该分组 id（避免 REPLACE 字符串误伤 112/121 等）
  const deps = repo.listGroupDependencies(req.params.id);
  for (const d of deps) {
    let arr;
    try { arr = JSON.parse(d.dependency || '[]'); } catch { arr = []; }
    if (Array.isArray(arr) && arr.includes(group.id)) {
      repo.updateGroupDependency(d.id, JSON.stringify(arr.filter(id => id !== group.id)));
    }
  }
  repo.deleteTestGroup(group.id);
  res.json({ message: 'Group deleted.' });
});

router.put('/:id/scoring-script', requireAuth, requireRole('teacher'), (req, res) => {
  const problem = repo.getProblemById(req.params.id);
  if (!problem) {
    return sendNotFound(res, 'Problem not found.');
  }
  const { scoring_script } = req.body;
  repo.updateScoringScript(problem.id, scoring_script || '');
  res.json({ message: 'Scoring script updated.' });
});

router.put('/:id/testcases/:tcid/group', requireAuth, requireRole('teacher'), (req, res) => {
  const tc = repo.getTestCase(req.params.id, req.params.tcid);
  if (!tc) {
    return sendNotFound(res, 'Test case not found.');
  }
  const { group_id } = req.body;
  repo.setTestCaseGroup(tc.id, group_id || null);
  res.json({ message: 'Test case updated.' });
});

router.put('/:id/testcases/:tcid', requireAuth, requireRole('teacher'), (req, res) => {
  const tc = repo.getTestCase(req.params.id, req.params.tcid);
  if (!tc) {
    return sendNotFound(res, 'Test case not found.');
  }
  const { input_data, output_data, score, group_id, sort_order, time_limit, memory_limit } = req.body;
  const u = buildUpdates([
    { key: 'input_data', value: input_data },
    { key: 'output_data', value: output_data },
    { key: 'score', value: score },
    { key: 'group_id', value: group_id, transform: v => v || null },
    { key: 'sort_order', value: sort_order },
    { key: 'time_limit', value: time_limit, transform: v => v ? parseInt(v) : null },
    { key: 'memory_limit', value: memory_limit, transform: v => v ? parseInt(v) : null }
  ]);
  if (u.count === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  repo.updateTestCase(tc.id, u);
  res.json({ message: 'Test case updated.' });
});

router.delete('/:id/testcases/:tcid', requireAuth, requireRole('teacher'), (req, res) => {
  const tc = repo.getTestCase(req.params.id, req.params.tcid);
  if (!tc) {
    return sendNotFound(res, 'Test case not found.');
  }
  repo.deleteTestCase(tc.id);
  res.json({ message: 'Test case deleted.' });
});

router.put('/:id/batch-testcases', requireAuth, requireRole('teacher'), (req, res) => {
  const problem = repo.getProblemById(req.params.id);
  if (!problem) {
    return sendNotFound(res, 'Problem not found.');
  }

  const { score, time_limit, memory_limit } = req.body;
  const notEmpty = v => v !== undefined && v !== null && v !== '';
  const u = buildUpdates([
    { key: 'score', value: notEmpty(score) ? score : undefined },
    { key: 'time_limit', value: notEmpty(time_limit) ? time_limit : undefined, transform: parseInt },
    { key: 'memory_limit', value: notEmpty(memory_limit) ? memory_limit : undefined, transform: parseInt }
  ]);

  if (u.count > 0) {
    repo.updateTestCasesByProblem(problem.id, u);
  }

  const parts = [];
  if (u.count > 0) {
    if (notEmpty(score)) parts.push('分数');
    if (notEmpty(time_limit)) parts.push('时间限制');
    if (notEmpty(memory_limit)) parts.push('内存限制');
  }
  res.json({ message: parts.length > 0 ? parts.join('、') + '已更新。' : '没有需要更新的内容。' });
});

module.exports = router;
