// routes/daily.js —— 每日一题 + 打卡
const express = require('express');
const repo = require('../repositories/daily');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { sendNotFound } = require('../utils/apiErrors');

const router = express.Router();

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

router.get('/today', optionalAuth, (req, res) => {
  const day = todayUtc();
  const daily = repo.getOrCreate(day);
  if (!daily) return sendNotFound(res, 'No daily problem available.');
  const problem = repo.getProblem(daily.problem_id);
  if (!problem) return sendNotFound(res, 'Daily problem not found.');
  const solved = req.user ? repo.hasAcceptedOnDay(req.user.id, problem.id, day) : false;
  const checkedIn = req.user ? repo.isCheckedIn(req.user.id, day) : false;
  res.json({
    day,
    problem,
    solved,
    checked_in: checkedIn,
    streak: req.user ? repo.streak(req.user.id, day) : 0
  });
});

router.post('/checkin', requireAuth, (req, res) => {
  const day = todayUtc();
  const daily = repo.getOrCreate(day);
  if (!daily) return sendNotFound(res, 'No daily problem available.');
  // 必须当天通过该题才能打卡
  if (!repo.hasAcceptedOnDay(req.user.id, daily.problem_id, day)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '请先通过今日题目后再打卡。' });
  }
  repo.checkin(req.user.id, day, daily.problem_id);
  res.json({ checked_in: true, day, streak: repo.streak(req.user.id, day) });
});

module.exports = router;
