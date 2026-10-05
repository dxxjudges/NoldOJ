const express = require('express');
const virtualContestsRepo = require('../repositories/virtual-contests');
const { requireAuth } = require('../middleware/auth');
const { buildProblemMap, acceptedTotals, buildStandings, standingsPayload } = require('../utils/standings');

const { sendNotFound } = require('../utils/apiErrors');

const router = express.Router();

// 工具：判断是否已结束
function isContestEnded(contest) {
  return new Date(contest.end_time).getTime() < Date.now();
}

// 工具：把 Date 转成 "YYYY-MM-DD HH:MM:SS" 本地时间字符串（与原比赛存储方式一致）
function formatLocal(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 发起虚拟参加 (登录用户)
// 挂在 contests 路由下: POST /api/v1/contests/:id/virtual-start
function virtualStart(req, res) {
  const contest = virtualContestsRepo.getContest(req.params.id);
  if (!contest) {
    return sendNotFound(res, 'Contest not found.');
  }
  // 10.3: 隐藏比赛不允许普通用户虚拟参加（仅 staff 可见/可操作）
  if (contest.is_hidden && !['admin', 'su', 'teacher'].includes(req.user.role)) {
    return sendNotFound(res, 'Contest not found.');
  }
  if (!isContestEnded(contest)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '比赛尚未结束，无法虚拟参加。' });
  }
  // 同一用户同一比赛只能虚拟参加一次
  const existing = virtualContestsRepo.findForUser(contest.id, req.user.id);
  if (existing) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '你已经虚拟参加过此比赛。', virtual_contest_id: existing.id });
  }
  const durationMs = new Date(contest.end_time).getTime() - new Date(contest.start_time).getTime();
  const now = new Date();
  const startTimeStr = formatLocal(now);
  const endTimeStr = formatLocal(new Date(now.getTime() + durationMs));
  const result = virtualContestsRepo.insert(contest.id, req.user.id, startTimeStr, endTimeStr, 'running');
  const vc = virtualContestsRepo.get(result.lastInsertRowid);
  res.status(201).json(vc);
}

// 虚拟比赛详情（题目+剩余时间+提交）
// ownership 校验并入 SQL，未授权与不存在统一返回 404，防 ID 枚举
router.get('/:id', requireAuth, (req, res) => {
  const vc = virtualContestsRepo.getOwned(req.params.id, req.user.id);
  if (!vc) {
    return sendNotFound(res, 'Virtual contest not found.');
  }
  const contest = virtualContestsRepo.getContest(vc.contest_id);
  if (!contest) {
    return sendNotFound(res, 'Original contest not found.');
  }
  // 题目列表
  const problems = virtualContestsRepo.listContestProblems(contest.id);
  // 我在本次虚拟比赛的提交
  const submissions = virtualContestsRepo.listSubmissions(vc.id);

  // 状态仅在内存中推导，不写入数据库（避免 GET 触发状态变更）
  const status = new Date(vc.end_time).getTime() < Date.now() ? 'finished' : vc.status;

  res.json({
    ...vc,
    status,
    contest,
    problems,
    submissions,
    remaining_ms: Math.max(0, new Date(vc.end_time).getTime() - Date.now())
  });
});

// 虚拟比赛排行榜（只返回自己）
router.get('/:id/ranking', requireAuth, (req, res) => {
  const vc = virtualContestsRepo.getOwned(req.params.id, req.user.id);
  if (!vc) {
    return sendNotFound(res, 'Virtual contest not found.');
  }
  const contestProblems = virtualContestsRepo.listContestProblemIds(vc.contest_id);
  const problemIds = contestProblems.map(p => p.problem_id);
  if (problemIds.length === 0) return res.json({ leaderboard: [], problem_ids: [] });

  const submissions = virtualContestsRepo.listRankingSubmissions(vc.id, problemIds);

  // 构造单个用户的排行榜数据：每题最佳成绩映射 + 已 AC 累计，组装逻辑与比赛榜共用 utils/standings
  const problemsMap = buildProblemMap(submissions);
  const totals = acceptedTotals(problemsMap, problemIds);
  const user = virtualContestsRepo.getUserBrief(vc.user_id);
  const leaderboard = buildStandings([{
    user_id: vc.user_id,
    username: user.username,
    nickname: user.nickname,
    total_score: totals.total_score,
    total_time: totals.total_time,
    problems: problemsMap
  }]);
  res.json(standingsPayload({ leaderboard, problem_ids: problemIds }));
});

// 我的虚拟比赛列表 (挂在 /my 路由下)
function myVirtualContests(req, res) {
  const items = virtualContestsRepo.listMine(req.user.id);
  // 状态仅在内存中推导，不落库
  const updated = items.map(it => {
    const status = new Date(it.end_time).getTime() < Date.now() ? 'finished' : it.status;
    return { ...it, status };
  });
  res.json({ virtual_contests: updated });
}

module.exports = { router, virtualStart, myVirtualContests };
