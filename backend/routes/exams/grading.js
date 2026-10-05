// routes/exams/grading.js —— 批改试卷（教师人工批改 + AI 批改辅助）
const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const repo = require('../../repositories/exams');

const { sendNotFound } = require('../../utils/apiErrors');
const { logError } = require('../../utils/logger');

const router = express.Router();

// 批改试卷（教师或 AI）
router.post('/:id/grade/:sid', requireAuth, requireRole('teacher'), (req, res) => {
  const submission = repo.findSubmissionInExam(req.params.sid, req.params.id);
  if (!submission) {
    return sendNotFound(res, 'Submission not found.');
  }

  const { answers } = req.body;
  if (!Array.isArray(answers)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'answers array is required.' });
  }

  let totalScore = 0;

  // 获取当前所有答案（包含客观题得分）
  const allAnswers = repo.listAnswersBySubmission(req.params.sid);
  const answerMap = {};
  allAnswers.forEach(a => { answerMap[a.id] = a; });

  // 先计算客观题得分
  allAnswers.forEach(a => {
    if (!a.is_subjective) {
      totalScore += a.score;
    }
  });

  // 更新主观题得分
  answers.forEach(a => {
    const answer = answerMap[a.answer_id];
    if (!answer || !answer.is_subjective) return;

    const s = Number(a.score) || 0;
    repo.gradeAnswerHuman(s, a.comment || '', a.answer_id);
    totalScore += s;
  });

  // 更新提交记录
  repo.updateSubmissionHumanGrade(req.params.sid, totalScore, req.user.id);

  res.json({ total_score: totalScore, status: 'graded' });
});

// AI 批改试卷
router.post('/:id/ai-grade/:sid', requireAuth, requireRole('teacher'), async (req, res) => {
  const submission = repo.findSubmissionInExam(req.params.sid, req.params.id);
  if (!submission) {
    return sendNotFound(res, 'Submission not found.');
  }

  const exam = repo.getExam(req.params.id);
  if (!exam.allow_ai_grading) {
    return res.status(400).json({ code: 1, reason: 'ERR_AI_GRADING_DISABLED', message: '此试卷未启用 AI 评分。' });
  }

  // 检查 AI 是否启用
  const config = require('../../config/config');
  const { aiEnabled, aiChat } = require('../../services/aiClient');
  const aiCfg = config.ai?.hint || config.ai?.security;
  if (!aiEnabled(aiCfg)) {
    return res.status(503).json({ code: 5, reason: 'ERR_AI_UNAVAILABLE', message: 'AI 服务未启用。' });
  }

  // 获取待评分的主观题答案
  const pendingAnswers = repo.listPendingSubjectiveAnswers(req.params.sid);

  if (pendingAnswers.length === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_NO_PENDING', message: '没有待评分的主观题。' });
  }

  const failedAnswerIds = [];
  for (const answer of pendingAnswers) {
    try {
      const prompt = answer.ai_grading_prompt ||
        `你是一位严格的老师。请根据参考答案评判学生的回答。

题目：${answer.question_title}
参考答案：${answer.correct_answer || '无'}
学生回答：${answer.answer}
满分：${answer.max_score}分

请给出评分（0-${answer.max_score}）和简短评语。
格式：{"score": 分数, "comment": "评语"}`;

      const aiResult = await aiChat('你是一位严格的计算机与算法试卷批改教师。请按照要求客观公正评判。', prompt, { cfg: aiCfg });
      let score = 0;
      let comment = '';

      try {
        // 尝试解析 JSON
        const parsed = JSON.parse(aiResult);
        score = Math.min(Math.max(0, Number(parsed.score) || 0), answer.max_score);
        comment = parsed.comment || '';
      } catch {
        // 解析失败时从文本中提取分数：优先取"得分/评分/score"引导的数字，
        // 否则直接取第一个数字很容易抓到题号、满分或年份，导致评分严重偏离
        const named = aiResult.match(/(?:得分|分数|评分|score)\s*[：:=是为]?\s*(\d+(?:\.\d+)?)/i);
        const anyNum = aiResult.match(/(\d+(?:\.\d+)?)/);
        let parsedScore = named ? parseFloat(named[1]) : (anyNum ? parseFloat(anyNum[1]) : 0);
        if (!isFinite(parsedScore)) parsedScore = 0;
        score = Math.min(Math.max(0, parsedScore), answer.max_score);
        comment = aiResult;
      }

      repo.gradeAnswerAi(score, comment, answer.id);
    } catch (err) {
      logError('AI Grading', 'Error:', err.message);
      // 单题失败不能拖垮整批，但必须记录下来：否则这些题仍是 pending，
      // 却会被下面无条件写成 status='graded' / ai_graded=1，教师再也看不到待批改入口
      failedAnswerIds.push(answer.id);
    }
  }

  // 更新提交状态（只有全部待评分题目成功才标记为已评完）
  const allGraded = failedAnswerIds.length === 0;
  const totalScore = repo.sumAnswerScores(req.params.sid) || 0;
  repo.updateSubmissionAiGrade(
    req.params.sid,
    totalScore,
    allGraded ? 'graded' : 'grading',
    allGraded ? 1 : 0,
    req.user.id
  );

  res.json({
    total_score: totalScore,
    status: allGraded ? 'graded' : 'grading',
    failed_answers: failedAnswerIds.length
  });
});

module.exports = router;
