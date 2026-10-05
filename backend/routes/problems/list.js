// routes/problems/list.js —— 题目公开查询（列表 / 详情）
const express = require('express');
const { optionalAuth } = require('../../middleware/auth');
const { parsePageLimit } = require('../../utils/pagination');
const { isStaff } = require('../../utils/roles');
// 题目可见性校验与提交接口共用（原为本文件私有，导致 POST /submissions 绕过校验）
const { problemVisibilityError } = require('../../utils/visibility');
const repo = require('../../repositories/problems');
const { sanitizeProblem } = require('./helpers');

const { sendNotFound } = require('../../utils/apiErrors');

const router = express.Router();

router.get('/', optionalAuth, (req, res) => {
  const { page = 1, limit = 50, search = '', tag = '', tags = '', category = '', difficulty = '', sort = '', order = 'desc' } = req.query;
  const { page: pageNum, limit: limitNum, offset } = parsePageLimit(page, limit, 50, 100);
  // 隐藏题目仅对 teacher/admin/su 可见；管理角色可加 include_hidden=1 在列表中查看
  const isManager = !!(req.user && isStaff(req.user.role));
  const { total, problems } = repo.listProblems({
    search, tag, tags, category, difficulty, sort, order, isManager, limit: limitNum, offset
  });

  if (problems.length > 0) {
    const ids = problems.map(p => p.id);
    // 一次批量取标签
    const tagRows = repo.getProblemTagRows(ids);
    const tagsByProblem = new Map();
    for (const r of tagRows) {
      const list = tagsByProblem.get(r.problem_id) || [];
      list.push({ id: r.id, name: r.name, color: r.color });
      tagsByProblem.set(r.problem_id, list);
    }
    // 一次批量取分类
    const catRows = repo.getProblemCategoryRows(ids);
    const catsByProblem = new Map();
    for (const r of catRows) {
      const list = catsByProblem.get(r.problem_id) || [];
      list.push({ id: r.id, name: r.name, description: r.description });
      catsByProblem.set(r.problem_id, list);
    }
    for (const problem of problems) {
      const ac = problem.ac_count || 0;
      const sub = problem.sub_count || 0;
      problem.accept_rate = sub > 0 ? Math.round((ac / sub) * 1000) / 10 : 0;
      problem.tags = tagsByProblem.get(problem.id) || [];
      problem.categories = catsByProblem.get(problem.id) || [];
    }
  }

  res.json({ total, page: pageNum, limit: limitNum, problems });
});

// 题目可见性校验 problemVisibilityError 已抽到 utils/visibility.js（提交接口共用）

// 作者/管理视图: 保留 spj_code 与 scoring_script，用于题目编辑回显
// （fullProblem 恒等包装已移除，直接返回数据库对象）

router.get('/:id', optionalAuth, (req, res) => {
  const problem = repo.getProblemById(req.params.id);
  if (!problem) {
    return sendNotFound(res, 'Problem not found.');
  }
  const isManager = !!(req.user && isStaff(req.user.role));
  // R9-2/R10-2: 隐藏题/非公开题可见性统一校验
  const verr = problemVisibilityError(problem, req);
  if (verr) {
    return res.status(403).json(verr);
  }
  // 管理角色或创建者返回完整视图（含 spj_code/scoring_script），其余走公开脱敏视图
  const isOwner = !!(req.user && req.user.id === problem.created_by);
  const result = (isManager || isOwner) ? problem : sanitizeProblem(problem);
  // D-I2: 测试点数量仅对管理角色/作者可见，不对普通用户暴露
  if (isManager || isOwner) {
    result.test_cases_count = repo.countTestCases(problem.id);
  }
  const cats = repo.getProblemCategories(problem.id);
  result.categories = cats;
  const tags = repo.getProblemTags(problem.id);
  result.tags = tags;
  // R12-1: 多样例。新表为准; 兼容旧数据(表空但旧字段非空)构造单元素数组
  let samples = repo.getSamples(problem.id);
  if (samples.length === 0 && ((problem.sample_input || '') !== '' || (problem.sample_output || '') !== '')) {
    samples = [{ input: problem.sample_input || '', output: problem.sample_output || '', note: '' }];
  }
  result.samples = samples;
  res.json(result);
});

module.exports = router;
