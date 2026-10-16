// routes/problems/solutions.js —— 题解关联（列表/挂载/解除）
const express = require('express');
const { requireAuth, requireRole, optionalAuth } = require('../../middleware/auth');
const { isStaff } = require('../../utils/roles');
// 题目可见性校验与提交接口共用（原为本文件私有，导致 POST /submissions 绕过校验）
const { problemVisibilityError } = require('../../utils/visibility');
const { visibilityDeniedMessage, canView } = require('../_visibility');
const { sendNotFound, sendForbidden } = require('../../utils/apiErrors');
const repo = require('../../repositories/problems');

const router = express.Router();

router.get('/:id/solutions', optionalAuth, (req, res) => {
  const problem = repo.getProblemById(req.params.id);
  if (!problem) {
    return sendNotFound(res, 'Problem not found.');
  }
  // 与 GET /problems/:id 一致的可见性校验：否则隐藏题 / 赛前比赛题可绕过详情页
  // 通过题解列表探测题解（含题解标题），并枚举到对应文章的存在性
  const verr = problemVisibilityError(problem, req);
  if (verr) {
    return res.status(403).json(verr);
  }
  // 实体可见性（用户组）：组内题的题解列表同样只对绑定组成员与 staff 开放
  if (!canView(req, 'problem', problem.id)) {
    return sendForbidden(res, visibilityDeniedMessage('problem'));
  }
  const solutions = repo.listSolutions(problem.id);
  const staff = !!req.user && isStaff(req.user.role);
  if (staff) {
    return res.json(solutions);
  }
  // 非教师只看已发布题解且隐藏未发布文章内容
  const visible = solutions
    .filter(s => s.is_published === 1)
    .map(s => ({ ...s, article_content: undefined }));
  res.json(visible);
});

router.post('/:id/solutions', requireAuth, requireRole('teacher'), (req, res) => {
  const problem = repo.getProblemById(req.params.id);
  if (!problem) {
    return sendNotFound(res, 'Problem not found.');
  }
  const { article_id, sort_order, show_after_contest } = req.body;
  if (!article_id) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'article_id is required.' });
  }
  const article = repo.getArticle(article_id);
  if (!article) {
    return sendNotFound(res, 'Article not found.');
  }
  repo.linkSolution(
    problem.id,
    article_id,
    sort_order || 0,
    show_after_contest ? 1 : 0
  );
  res.status(201).json({ message: 'Solution linked.' });
});

router.delete('/:id/solutions/:sid', requireAuth, requireRole('teacher'), (req, res) => {
  repo.unlinkSolution(req.params.sid, req.params.id);
  res.json({ message: 'Solution removed.' });
});

module.exports = router;
