// routes/problems/extras.js —— 讨论、查重、AI 测试点、导入导出等辅助路由
const express = require('express');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { requireAuth, requireRole, optionalAuth } = require('../../middleware/auth');
const { parsePageLimit } = require('../../utils/pagination');
// 题目可见性校验与提交接口共用（原为本文件私有，导致 POST /submissions 绕过校验）
const { problemVisibilityError } = require('../../utils/visibility');
const { sanitizeLog } = require('../../utils/securityHelpers');
const { createRateLimit } = require('../../middleware/ratelimit');
const config = require('../../config/config');
const { aiEnabled, aiChatJSON } = require('../../services/aiClient');
const repo = require('../../repositories/problems');
const { upload, normalizeSamples, normalizeTolerance, safeReadFile } = require('./helpers');
const { logError } = require('../../utils/logger');

// R9-3: 查重任务创建限流（每分钟最多 10 次），防并发堆积耗尽 CPU
const plagiarismRateLimit = createRateLimit({ windowMs: 60000, max: 10 });
// 10.3: AI 测试点生成是昂贵操作（8192 tokens / 90s），限流防资源耗尽
const aiTestdataRateLimit = createRateLimit({ windowMs: 60000, max: 5 });

const { sendNotFound } = require('../../utils/apiErrors');

const router = express.Router();

// 功能8：题目讨论列表
router.get('/:id/discussions', optionalAuth, (req, res) => {
  const { page = 1, size = 20 } = req.query;
  const { page: pageNum, limit: sizeNum, offset } = parsePageLimit(page, size, 20, 50);
  const problem = repo.getProblemById(req.params.id);
  if (!problem) {
    return sendNotFound(res, 'Problem not found.');
  }
  // R10-2: 隐藏题/非公开题不可见性校验，与 GET /:id 保持一致
  const verr = problemVisibilityError(problem, req);
  if (verr) {
    return res.status(403).json(verr);
  }
  const total = repo.countDiscussions(req.params.id);
  const items = repo.listDiscussions(req.params.id, sizeNum, offset);
  res.json({ total, page: pageNum, size: sizeNum, discussions: items });
});

// 功能10：发起查重（admin/teacher，异步）
// POST /api/v1/problems/:id/plagiarism-check  返回 {task_id}
router.post('/:id/plagiarism-check', requireAuth, requireRole('teacher'), plagiarismRateLimit, (req, res) => {
  const problem = repo.getProblemId(req.params.id);
  if (!problem) {
    return sendNotFound(res, 'Problem not found.');
  }
  const { createTask } = require('../../services/plagiarism');
  const taskId = createTask(parseInt(req.params.id), req.user.id);
  res.status(202).json({ task_id: taskId, message: 'Plagiarism check started.' });
});

// 功能10：获取题目最近一次查重报告
// GET /api/v1/problems/:id/plagiarism-report
router.get('/:id/plagiarism-report', requireAuth, requireRole('teacher'), (req, res) => {
  const { getLatestTaskForProblem } = require('../../services/plagiarism');
  const task = getLatestTaskForProblem(parseInt(req.params.id));
  if (!task) {
    return sendNotFound(res, 'No plagiarism task found for this problem.');
  }
  res.json(task);
});

// 功能12：AI 智能测试点生成器（teacher+）
// POST /api/v1/problems/:id/ai-testdata
// body: { samples: 3, edge_cases: 3 }  生成普通样例 + 边界测试点并写入 test_cases
router.post('/:id/ai-testdata', requireAuth, requireRole('teacher'), aiTestdataRateLimit, async (req, res) => {
  const problem = repo.getProblemById(req.params.id);
  if (!problem) {
    return sendNotFound(res, 'Problem not found.');
  }
  if (!aiEnabled(config.ai.testdata)) {
    return res.status(503).json({ code: 2, reason: 'ERR_INVALID_STATE', message: 'AI 服务未启用，请先在 config/ai.txt 中启用。' });
  }
  const samples = Math.min(Math.max(parseInt(req.body.samples) || 3, 1), 10);
  const edgeCases = Math.min(Math.max(parseInt(req.body.edge_cases) || 3, 0), 10);

  const prompt = `你是一位出题专家。请根据下面的题目信息，生成用于在线判题（OJ）的测试点。
题目信息：
- 标题: ${problem.title}
- 描述: ${problem.description}
- 输入格式: ${problem.input_desc}
- 输出格式: ${problem.output_desc}
- 数据范围/提示: ${problem.hint}

要求：
1. 生成 ${samples} 组普通样例（覆盖常规输入）和 ${edgeCases} 组边界测试点（如最小/最大数据、空输入、重复元素、极端情况、可能导致整数溢出的边界等）。
2. 每个测试点包含 input 与 expected_output 两个字段，使用与题目描述一致的输入输出格式。
3. 输入与输出都用纯文本，多行用 \\n 分隔。
4. 只输出一个 JSON 对象，不要包含任何其他文字：
{"test_cases": [{"name": "case1", "input": "...", "expected_output": "..."}]}`;

  try {
    const result = await aiChatJSON(prompt, `请为这道题生成测试点。`, { cfg: config.ai.testdata, numPredict: 8192, timeoutMs: 90000 });
    const cases = Array.isArray(result.test_cases) ? result.test_cases : [];
    if (cases.length === 0) {
      return res.status(500).json({ code: 2, reason: 'ERR_INVALID_STATE', message: 'AI 未返回有效测试点，请重试。' });
    }
    const problemDir = path.join(config.problemsDir, String(problem.id));
    fs.mkdirSync(problemDir, { recursive: true });
    let order = repo.getMaxSortOrder(problem.id);
    let count = 0;
    const saved = [];
    for (const tc of cases) {
      const name = String(tc.name || `ai_${count + 1}`).replace(/[<>:"/\\|?*]/g, '_').slice(0, 50);
      const input = String(tc.input ?? '').replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trimEnd() + '\n';
      const output = String(tc.expected_output ?? '').replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trimEnd() + '\n';
      order++;
      repo.insertTestCaseText(problem.id, input, output, order);
      // 同时写入磁盘文件（与 ZIP 导入一致，便于人工查看/复用）
      try {
        fs.writeFileSync(path.join(problemDir, `${name}.in`), input, 'utf8');
        fs.writeFileSync(path.join(problemDir, `${name}.out`), output, 'utf8');
      } catch {
        // 磁盘副本尽力而为：测试点已入库，缺文件不影响判题（判题读库）
      }
      count++;
      saved.push(name);
    }
    res.json({ message: `AI 生成 ${count} 个测试点并已保存。`, count, cases: saved });
  } catch (err) {
    logError('EXTRAS', `AI testdata error for problem ${problem.id}:`, sanitizeLog(String(err.message || err)));
    res.status(502).json({ code: 2, reason: 'ERR_INVALID_STATE', message: 'AI 测试点生成失败，请检查 AI 服务是否可用。' });
  }
});

// 功能14：导出题目（JSON/ZIP，teacher+）
// GET /api/v1/problems/:id/export?format=json|zip
// 返回完整题目数据（含测试点/标签/分组），zip 模式附带 .in/.out 文件供重新导入
router.get('/:id/export', requireAuth, requireRole('teacher'), (req, res) => {
  const problem = repo.getProblemById(req.params.id);
  if (!problem) {
    return sendNotFound(res, 'Problem not found.');
  }
  const format = (req.query.format || 'zip').toLowerCase();

  const testCases = repo.listTestCases(problem.id);
  const testGroups = repo.listTestGroups(problem.id);
  const tags = repo.listProblemTagNames(problem.id);
  const categories = repo.listProblemCategoryNames(problem.id);

  const bundle = {
    version: 1,
    exported_at: new Date().toISOString(),
    problem: {
      title: problem.title,
      description: problem.description,
      background: problem.background || '',
      input_desc: problem.input_desc,
      output_desc: problem.output_desc,
      hint: problem.hint,
      time_limit: problem.time_limit,
      memory_limit: problem.memory_limit,
      problem_type: problem.problem_type,
      compare_mode: problem.compare_mode,
      real_number_tolerance: problem.real_number_tolerance ? JSON.parse(problem.real_number_tolerance) : { absolute: 0.001, relative: 0.001 },
      spj_code: problem.spj_code,
      scoring_script: problem.scoring_script,
      allowed_languages: problem.allowed_languages ? JSON.parse(problem.allowed_languages) : [],
      is_public: !!problem.is_public,
      is_hidden: !!problem.is_hidden,
      provider: problem.provider,
      sample_input: problem.sample_input,
      sample_output: problem.sample_output,
      samples: repo.getSamples(problem.id),
      subtask_mode: problem.subtask_mode,
      difficulty: problem.difficulty
    },
    tags,
    categories,
    test_groups: testGroups,
    test_cases: testCases.map(tc => ({
      name: `case_${tc.sort_order || tc.id}`,
      input_data: tc.input_data,
      output_data: tc.output_data,
      input_file: tc.input_file && !path.isAbsolute(tc.input_file) ? tc.input_file : '',
      output_file: tc.output_file && !path.isAbsolute(tc.output_file) ? tc.output_file : '',
      score: tc.score,
      time_limit: tc.time_limit,
      memory_limit: tc.memory_limit,
      sort_order: tc.sort_order,
      group_id: tc.group_id
    }))
  };

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="problem_${problem.id}.json"`);
    return res.json(bundle);
  }

  // ZIP 模式：problem.json + 每个测试点写入磁盘文件后打包
  const problemDir = path.join(config.problemsDir, String(problem.id));
  fs.mkdirSync(problemDir, { recursive: true });
  const zip = new AdmZip();
  zip.addFile('problem.json', Buffer.from(JSON.stringify(bundle, null, 2), 'utf8'));
  for (const tc of testCases) {
    const name = `case_${tc.sort_order || tc.id}`;
    const input = tc.input_data || (tc.input_file && safeReadFile(problemDir, tc.input_file)) || '';
    const output = tc.output_data || (tc.output_file && safeReadFile(problemDir, tc.output_file)) || '';
    zip.addFile(`testdata/${name}.in`, Buffer.from(input, 'utf8'));
    zip.addFile(`testdata/${name}.out`, Buffer.from(output, 'utf8'));
  }
  if (testGroups.length > 0) {
    zip.addFile('test_groups.json', Buffer.from(JSON.stringify(testGroups, null, 2), 'utf8'));
  }
  const buf = zip.toBuffer();
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="problem_${problem.id}.zip"`);
  res.send(buf);
});

// 功能15：导入题目（JSON 或 ZIP，teacher+）
// POST /api/v1/problems/import  multipart file=problem.json|problem.zip
router.post('/import', requireAuth, requireRole('teacher'), upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No file uploaded.' });
  }
  const cleanup = () => {
    try {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    } catch {
      // 临时上传文件清理尽力而为
    }
  };
  try {
    const fname = req.file.originalname.toLowerCase();
    let bundle;
    if (fname.endsWith('.zip')) {
      const zip = new AdmZip(req.file.path);
      // Zip Bomb 防御：限制条目数与解压总大小（与 testdata-zip 一致，D-M6）
      const entries = zip.getEntries();
      const MAX_IMPORT_ENTRIES = 2000;
      const MAX_IMPORT_TOTAL_BYTES = 200 * 1024 * 1024;
      let totalBytes = 0;
      for (const e of entries) {
        if (e.isDirectory) continue;
        totalBytes += e.header.size;
        if (entries.length > MAX_IMPORT_ENTRIES || totalBytes > MAX_IMPORT_TOTAL_BYTES) {
          cleanup();
          return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'ZIP 文件过大或条目过多。' });
        }
      }
      const entry = entries.find(e => !e.isDirectory && e.entryName.replace(/\\/g, '/').split('/').pop() === 'problem.json');
      if (!entry) {
        cleanup();
        return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'ZIP 中缺少 problem.json。' });
      }
      bundle = JSON.parse(entry.getData().toString('utf8'));
      if (bundle && bundle.problem) {
        // 从 ZIP 中读取 testdata/ 下的 .in/.out 文件覆盖/补充 inline 测试点
        const tcMap = new Map((bundle.test_cases || []).map(tc => [tc.name, tc]));
        for (const e of entries) {
          if (e.isDirectory) continue;
          const p = e.entryName.replace(/\\/g, '/');
          const m = p.match(/^testdata\/([^/]+)\.(in|out)$/);
          if (!m) continue;
          const name = m[1];
          const ext = m[2];
          const existing = tcMap.get(name) || {};
          if (ext === 'in') existing.input_data = e.getData().toString('utf8');
          else existing.output_data = e.getData().toString('utf8');
          tcMap.set(name, existing);
        }
        bundle.test_cases = Array.from(tcMap.values());
      }
    } else if (fname.endsWith('.json') || fname.endsWith('.json.gz')) {
      bundle = JSON.parse(fs.readFileSync(req.file.path, 'utf8'));
    } else {
      cleanup();
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '仅支持 .zip 或 .json 文件。' });
    }

    if (!bundle || !bundle.problem || !bundle.problem.title) {
      cleanup();
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '文件内容缺少 problem.title。' });
    }
    const p = bundle.problem;
    // 导入包是任意 JSON：容差/资源限制原样落库会把判题口径放空或撑爆判题线程
    const importTolerance = normalizeTolerance(p.real_number_tolerance);
    if (importTolerance === null) {
      cleanup();
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'problem.real_number_tolerance 非法。' });
    }
    const importTl = Math.min(10000, Math.max(1, Number(p.time_limit) || 1000));
    const importMl = Math.min(1024, Math.max(1, Number(p.memory_limit) || 256));
    const newId = repo.findNextId('problems');
    repo.insertImportedProblem({
      id: newId,
      title: p.title,
      description: p.description || '',
      background: p.background || '',
      input_desc: p.input_desc || '',
      output_desc: p.output_desc || '',
      hint: p.hint || '',
      time_limit: importTl,
      memory_limit: importMl,
      problem_type: p.problem_type || 'traditional',
      compare_mode: p.compare_mode || 'text_strict',
      real_number_tolerance: JSON.stringify(importTolerance || { absolute: 0.001, relative: 0.001 }),
      spj_code: p.spj_code || '',
      scoring_script: p.scoring_script || '',
      allowed_languages: JSON.stringify(p.allowed_languages || []),
      is_public: p.is_public !== undefined ? (p.is_public ? 1 : 0) : 1,
      provider: p.provider || '',
      created_by: req.user.id,
      sample_input: p.sample_input || '',
      sample_output: p.sample_output || '',
      subtask_mode: p.subtask_mode || 'simple',
      difficulty: p.difficulty !== undefined ? parseInt(p.difficulty) || 0 : 0,
      is_hidden: p.is_hidden !== undefined ? (p.is_hidden ? 1 : 0) : 0
    });

    // 写入分组（先建分组，便于 test_cases 的 group_id 重映射到新 id，D-M8）
    const groups = bundle.test_groups || [];
    const groupIdMap = {};
    for (const g of groups) {
      const r = repo.insertTestGroup(newId, g.subtask_id || null, g.score || 0, g.aggregator || 'sum', g.dependency || '', g.scoring_script || '');
      groupIdMap[g.id] = r.lastInsertRowid;
    }

    // R12-1: 导入多样例(Array.isArray 校验; 旧格式无 samples 字段则跳过, 旧字段已随 INSERT 写入)
    const importSamples = normalizeSamples(p.samples);
    if (importSamples && importSamples.length > 0) repo.replaceSamples(newId, importSamples);

    // 写入测试点
    // 文件引用消毒：仅允许纯文件名（无分隔符/..），避免穿越 problems 目录（D-H2/D-M8）
    const safeFileName = (f) => {
      if (!f || typeof f !== 'string') return '';
      const base = f.replace(/\\/g, '/').split('/').pop();
      return /^[\w.-]+$/.test(base) ? base : '';
    };
    const tcs = bundle.test_cases || [];
    tcs.forEach((tc, i) => {
      const mappedGroup = tc.group_id != null ? (groupIdMap[tc.group_id] || null) : null;
      repo.insertImportedTestCase({
        problem_id: newId,
        input_data: tc.input_data || '',
        output_data: tc.output_data || '',
        score: tc.score || 0,
        sort_order: tc.sort_order || (i + 1),
        group_id: mappedGroup,
        time_limit: tc.time_limit || null,
        memory_limit: tc.memory_limit || null,
        input_file: (!tc.input_data && tc.input_file) ? safeFileName(tc.input_file) : '',
        output_file: (!tc.output_data && tc.output_file) ? safeFileName(tc.output_file) : ''
      });
    });

    // 标签与分类（存在则复用，不存在则创建）
    for (const name of bundle.tags || []) {
      if (!name) continue;
      let tag = repo.getTagByName(name);
      if (!tag) {
        tag = { id: repo.findNextId('tags') };
        repo.insertTag(tag.id, name);
      }
      repo.linkProblemTag(newId, tag.id);
    }
    for (const name of bundle.categories || []) {
      if (!name) continue;
      let cat = repo.getCategoryByName(name);
      if (!cat) {
        cat = { id: repo.findNextId('categories') };
        repo.insertCategory(cat.id, name);
      }
      repo.linkProblemCategory(newId, cat.id);
    }

    const created = repo.getProblemById(newId);
    cleanup();
    res.status(201).json({ message: `导入成功，新题目 ID: ${newId}`, problem: created });
  } catch (err) {
    logError('EXTRAS', 'Import problem error:', sanitizeLog(String(err.message || err)));
    cleanup();
    res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `导入失败: ${err.message}` });
  }
});

module.exports = router;
