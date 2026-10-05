// routes/problems/crud.js —— 题目 CRUD 与重编号（创建/编辑/删除/改号）
const express = require('express');
const path = require('path');
const fs = require('fs');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { buildUpdates } = require('../../utils/db');
const { sanitizeLog } = require('../../utils/securityHelpers');
const config = require('../../config/config');
const repo = require('../../repositories/problems');
const { normalizeSamples, normalizeTolerance } = require('./helpers');

const { sendNotFound } = require('../../utils/apiErrors');
const { logError } = require('../../utils/logger');

const router = express.Router();

router.post('/', requireAuth, requireRole('teacher'), (req, res) => {
  const { title, description, background, input_desc, output_desc, hint, time_limit, memory_limit, problem_type, compare_mode, real_number_tolerance, spj_code, allowed_languages, is_public, provider, sample_input, sample_output, subtask_mode, difficulty, is_hidden } = req.body;
  if (!title) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Title is required.' });
  }
  // D-M11: 拒绝超范围资源限制配置（与判题端硬上限一致）
  if (time_limit !== undefined && time_limit !== null && (!Number.isInteger(Number(time_limit)) || Number(time_limit) < 1 || Number(time_limit) > 10000)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'time_limit 必须在 1~10000 ms 之间。' });
  }
  if (memory_limit !== undefined && memory_limit !== null && (!Number.isInteger(Number(memory_limit)) || Number(memory_limit) < 1 || Number(memory_limit) > 1024)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'memory_limit 必须在 1~1024 MB 之间（判题端硬上限 1024MB）。' });
  }
  const newId = repo.findNextId('problems');
  const newTolerance = normalizeTolerance(real_number_tolerance);
  if (newTolerance === null) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'real_number_tolerance 必须是 {absolute, relative} 且为 0~1e9 的有限数值。' });
  }
  // R12-1: samples 数组存在时以首条双写旧字段, 全量入新表
  let samples = normalizeSamples(req.body.samples);
  if (samples === null && req.body.samples !== undefined) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'samples 必须为 [{input,output,note}] 数组。' });
  }
  const first = samples && samples[0] ? samples[0] : null;
  repo.insertProblem({
    id: newId,
    title,
    description: description || '',
    background: background || '',
    input_desc: input_desc || '',
    output_desc: output_desc || '',
    hint: hint || '',
    time_limit: time_limit || 1000,
    memory_limit: memory_limit || 256,
    problem_type: problem_type || 'traditional',
    compare_mode: compare_mode || 'text_strict',
    real_number_tolerance: JSON.stringify(newTolerance || { absolute: 0.001, relative: 0.001 }),
    spj_code: spj_code || '',
    allowed_languages: JSON.stringify(allowed_languages || []),
    is_public: is_public !== undefined ? (is_public ? 1 : 0) : 1,
    provider: provider || '',
    created_by: req.user.id,
    sample_input: first ? first.input : (sample_input || ''),
    sample_output: first ? first.output : (sample_output || ''),
    subtask_mode: subtask_mode || 'simple',
    difficulty: difficulty !== undefined ? parseInt(difficulty) || 0 : 0,
    is_hidden: is_hidden !== undefined ? (is_hidden ? 1 : 0) : 0
  });
  if (samples && samples.length > 0) repo.replaceSamples(newId, samples);
  const problem = repo.getProblemById(newId);
  res.status(201).json(problem);
});

router.put('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const problem = repo.getProblemById(req.params.id);
  if (!problem) {
    return sendNotFound(res, 'Problem not found.');
  }
  // 试卷内编程题只允许经试卷接口（exams.js）编辑，防止绕过试卷改题/改测试数据
  if (problem.exam_id) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '试卷内编程题请通过试卷编辑接口修改。' });
  }
  const inContest = repo.findContestProblem(problem.id);
  if (inContest) {
    return res.status(400).json({ code: 2, reason: 'ERR_INVALID_STATE', message: 'Cannot edit a problem that is part of a contest.' });
  }

  const fields = ['title', 'description', 'background', 'input_desc', 'output_desc', 'hint', 'time_limit', 'memory_limit', 'problem_type', 'compare_mode', 'real_number_tolerance', 'spj_code', 'allowed_languages', 'is_public', 'provider', 'sample_input', 'sample_output', 'subtask_mode', 'difficulty', 'is_hidden'];
  // 防御纵深：列名仅允许合法标识符，杜绝任何注入 SQL SET 子句的可能
  for (const field of fields) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `Invalid field: ${field}` });
    }
  }
  // D-M11: 更新时同样拒绝超范围资源限制
  const bodyTl = req.body.time_limit;
  const bodyMl = req.body.memory_limit;
  if (bodyTl !== undefined && bodyTl !== null && (!Number.isInteger(Number(bodyTl)) || Number(bodyTl) < 1 || Number(bodyTl) > 10000)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'time_limit 必须在 1~10000 ms 之间。' });
  }
  if (bodyMl !== undefined && bodyMl !== null && (!Number.isInteger(Number(bodyMl)) || Number(bodyMl) < 1 || Number(bodyMl) > 1024)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'memory_limit 必须在 1~1024 MB 之间（判题端硬上限 1024MB）。' });
  }
  const transformValue = (field, value) => {
    if (field === 'real_number_tolerance' || field === 'allowed_languages') return JSON.stringify(value);
    if (field === 'is_public' || field === 'is_hidden') return value ? 1 : 0;
    if (field === 'difficulty') return parseInt(value) || 0;
    return value;
  };
  // R12-1: samples 必须先校验再落库。原先放在 UPDATE 之后，
  // 一旦 samples 非法就返回 400，但其它字段已经提交 —— 客户端认为整次编辑失败，
  // 实际上题目已被改成一半（半次更新）。
  const samples = normalizeSamples(req.body.samples);
  if (samples === null && req.body.samples !== undefined) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'samples 必须为 [{input,output,note}] 数组。' });
  }
  if (req.body.real_number_tolerance !== undefined && req.body.real_number_tolerance !== null
      && normalizeTolerance(req.body.real_number_tolerance) === null) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'real_number_tolerance 必须是 {absolute, relative} 且为 0~1e9 的有限数值。' });
  }
  const u = buildUpdates(fields.map(f => ({ key: f, value: req.body[f], transform: v => transformValue(f, v) })), { touchUpdatedAt: true });
  if (u.count === 0 && req.body.samples === undefined) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  if (u.count > 0) {
    repo.updateProblem(problem.id, u);
  }
  // samples 数组存在即全量替换(含空数组=清空样例); 否则旧字段变化时同步回新表首条
  if (samples !== null) {
    repo.replaceSamples(problem.id, samples);
    // 同步旧字段到返回视图
    const first = samples[0] || { input: '', output: '' };
    repo.updateLegacySampleFields(problem.id, first.input, first.output);
  } else if (req.body.sample_input !== undefined || req.body.sample_output !== undefined) {
    const cur = repo.getLegacySampleFields(problem.id);
    repo.replaceSamples(problem.id, [{ input: cur.sample_input || '', output: cur.sample_output || '', note: '' }]);
  }

  const updated = repo.getProblemById(problem.id);
  res.json(updated);
});

router.delete('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const problem = repo.getProblemById(req.params.id);
  if (!problem) {
    return sendNotFound(res, 'Problem not found.');
  }
  // 试卷内编程题随试卷一起删除（exams.js 级联），禁止单独删
  if (problem.exam_id) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '试卷内编程题请通过试卷删除接口移除。' });
  }
  const inContest = repo.findContestProblem(problem.id);
  if (inContest) {
    return res.status(400).json({ code: 2, reason: 'ERR_INVALID_STATE', message: 'Cannot delete a problem that is part of a contest.' });
  }
  try {
    repo.deleteTestCases(problem.id);
    repo.deleteTestGroups(problem.id);
    repo.deleteSamples(problem.id);
    repo.deleteProblem(problem.id);
    // R11-?: 同步清理磁盘 testdata 目录，避免删题后残留孤儿目录
    const problemDir = path.join(config.problemsDir, String(problem.id));
    try {
      if (fs.existsSync(problemDir)) fs.rmSync(problemDir, { recursive: true, force: true });
    } catch (e) {
      logError('CRUD', `Failed to remove problem testdata dir for ${problem.id}:`, sanitizeLog(String(e.message || e)));
    }
    res.json({ message: 'Problem deleted.' });
  } catch (e) {
    logError('CRUD', `Failed to delete problem ${problem.id}:`, sanitizeLog(String(e.message || e)));
    res.status(500).json({ code: 1, reason: 'ERR_INTERNAL', message: 'Failed to delete problem.' });
  }
});

// 题目重编号（admin/su）：将题目 id 改到指定的空位置。
// 需要同步所有引用 problem_id 的表 + 磁盘 testdata 目录，全在事务内完成。
// 使用 defer_foreign_keys 将外键校验推迟到 COMMIT（SQLite 3.23+，node:sqlite 自带新版）。
router.put('/:id/reindex', requireAuth, requireRole('admin'), (req, res) => {
  const problem = repo.getProblemById(req.params.id);
  if (!problem) {
    return sendNotFound(res, 'Problem not found.');
  }
  // 试卷内编程题占用 EXAM_PROBLEM_ID_BASE 号段，不允许改到普通号段（反之亦然）
  if (problem.exam_id || Number(req.body.new_id) >= repo.EXAM_PROBLEM_ID_BASE) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '试卷内编程题与题库题目不可跨号段重编号。' });
  }
  const newId = Number(req.body.new_id);
  if (!Number.isInteger(newId) || newId < 1 || String(newId) !== String(req.body.new_id)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'new_id 必须是正整数。' });
  }
  if (newId === problem.id) {
    return res.status(400).json({ code: 2, reason: 'ERR_INVALID_STATE', message: '目标编号与当前编号相同。' });
  }
  // 目标编号必须为空位置（不能被其它题目占用）
  const clash = repo.getProblemId(newId);
  if (clash) {
    return res.status(400).json({ code: 2, reason: 'ERR_INVALID_STATE', message: `编号 ${newId} 已被占用。` });
  }

  // 磁盘 testdata 目录迁移
  const oldDir = path.join(config.problemsDir, String(problem.id));
  const newDir = path.join(config.problemsDir, String(newId));
  if (fs.existsSync(newDir)) {
    return res.status(409).json({ code: 2, reason: 'ERR_INVALID_STATE', message: `目标目录 ${newId} 已存在，无法迁移测试数据。` });
  }

  try {
    repo.rekeyProblem(problem.id, newId, oldDir, newDir);
  } catch (err) {
    logError('problems', 'reindex failed:', sanitizeLog(String(err && err.message || err)));
    return res.status(500).json({ code: 2, reason: 'ERR_INVALID_STATE', message: '重编号失败，请重试。' });
  }

  const updated = repo.getProblemById(newId);
  res.json({ ...updated, old_id: problem.id });
});

module.exports = router;
