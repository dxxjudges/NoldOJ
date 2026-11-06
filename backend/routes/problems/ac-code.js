// routes/problems/ac-code.js —— 「AC 后公开代码」入口：题目页展示其他用户的通过代码
const express = require('express');
const { optionalAuth } = require('../../middleware/auth');
const { problemVisibilityError } = require('../../utils/visibility');
const { visibilityDeniedMessage, canView } = require('../_visibility');
const { sendNotFound, sendForbidden } = require('../../utils/apiErrors');
const repo = require('../../repositories/problems');

const router = express.Router();

// 仅返回作者已开启「公开代码」的 AC 提交（本人自己的提交始终可见，便于回看）
router.get('/:id/ac-submissions', optionalAuth, (req, res) => {
  const problem = repo.getProblemById(req.params.id);
  if (!problem) {
    return sendNotFound(res, 'Problem not found.');
  }
  const verr = problemVisibilityError(problem, req);
  if (verr) {
    return res.status(403).json(verr);
  }
  if (!canView(req, 'problem', problem.id)) {
    return sendForbidden(res, visibilityDeniedMessage('problem'));
  }
  const submissions = repo.listAcceptedSubmissions(problem.id, req.user ? req.user.id : null);
  res.json({ submissions });
});

module.exports = router;
