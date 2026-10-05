const express = require('express');
const contestsRepo = require('../repositories/contests');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const { parsePageLimit } = require('../utils/pagination');
const { isStaff } = require('../utils/roles');
const { buildUpdates } = require('../utils/db');
const { buildUserProblemMap, acceptedTotals, compareByScore, buildStandings, standingsPayload } = require('../utils/standings');
const { createRateLimit } = require('../middleware/ratelimit');

// R9-3: 一键查重限流（每分钟最多 5 次）
const plagiarismRateLimit = createRateLimit({ windowMs: 60000, max: 5 });

const { sendNotFound } = require('../utils/apiErrors');

const router = express.Router();

// 公开比赛列表保持匿名可访问；挂 optionalAuth 以便识别登录用户角色
router.get('/', optionalAuth, (req, res) => {
  const { page = 1, limit = 50, search = '' } = req.query;
  const { page: pageNum, limit: limitNum, offset } = parsePageLimit(page, limit, 50, 100);
  let where = '';
  const params = [];
  const fuzzy = search ? '%' + search.replace(/\s+/g, '') + '%' : null;
  // 隐藏比赛仅对 teacher/admin/su 可见
  if (!req.user || !isStaff(req.user.role)) {
    where = 'WHERE c.is_hidden = 0';
  }
  if (search) {
    const cond = "REPLACE(c.title, ' ', '') LIKE ? OR REPLACE(c.description, ' ', '') LIKE ?";
    where = where ? `${where} AND (${cond})` : `WHERE (${cond})`;
    params.push(fuzzy, fuzzy);
  }
  const total = contestsRepo.countList(where, params);
  const contests = contestsRepo.list(where, params, limitNum, offset);
  res.json({ total, page: pageNum, limit: limitNum, contests });
});

router.get('/:id', optionalAuth, (req, res) => {
  const contest = contestsRepo.getWithCreator(req.params.id);
  if (!contest) {
    return sendNotFound(res, 'Contest not found.');
  }
  // 隐藏比赛仅对管理角色可见
  if (contest.is_hidden && !(req.user && isStaff(req.user.role))) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Contest not found.' });
  }
  const staff = !!req.user && isStaff(req.user.role);
  let problems;
  const hiddenFilter = staff ? '' : ' AND p.is_hidden = 0';
  if (staff) {
    problems = contestsRepo.listStaffProblems(contest.id);
  } else {
    // 未开始前不泄露题目列表（防止提前预习题目）
    const now = Date.now();
    const started = !contest.start_time || new Date(contest.start_time).getTime() <= now;
    if (!started) {
      problems = [];
    } else {
      problems = contestsRepo.listProblems(contest.id, hiddenFilter);
    }
  }
  const participantCount = contestsRepo.countParticipants(contest.id);
  res.json({ ...contest, problems, participant_count: participantCount });
});

router.post('/', requireAuth, requireRole('teacher'), (req, res) => {
  const { title, description, start_time, end_time, is_virtual, freeze_minutes, is_hidden } = req.body;
  if (!title || !start_time || !end_time) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'title, start_time, and end_time are required.' });
  }
  // R9-25: end_time 必须在 start_time 之后，且两者必须是合法时间
  const startMs = new Date(start_time).getTime();
  const endMs = new Date(end_time).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'end_time must be after start_time.' });
  }
  const fm = Math.max(0, parseInt(freeze_minutes) || 0);
  const result = contestsRepo.insert(title, description || '', start_time, end_time, is_virtual ? 1 : 0, fm, is_hidden ? 1 : 0, req.user.id);
  const contest = contestsRepo.get(result.lastInsertRowid);
  res.status(201).json(contest);
});

router.put('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const contest = contestsRepo.get(req.params.id);
  if (!contest) {
    return sendNotFound(res, 'Contest not found.');
  }
  const { title, description, start_time, end_time, is_virtual, freeze_minutes, is_hidden } = req.body;
  const u = buildUpdates([
    { key: 'title', value: title },
    { key: 'description', value: description },
    { key: 'start_time', value: start_time },
    { key: 'end_time', value: end_time },
    { key: 'is_virtual', value: is_virtual, transform: v => v ? 1 : 0 },
    { key: 'freeze_minutes', value: freeze_minutes, transform: v => Math.max(0, parseInt(v) || 0) },
    { key: 'is_hidden', value: is_hidden, transform: v => v ? 1 : 0 }
  ]);

  if (u.count === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  // R9-25: 若更新了时间，合并检查 end_time > start_time
  if (u.set.some(s => s.startsWith('start_time =') || s.startsWith('end_time ='))) {
    const mergedStart = u.fields.includes('start_time') ? start_time : contest.start_time;
    const mergedEnd = u.fields.includes('end_time') ? end_time : contest.end_time;
    const sMs = new Date(mergedStart).getTime();
    const eMs = new Date(mergedEnd).getTime();
    if (Number.isNaN(sMs) || Number.isNaN(eMs) || eMs <= sMs) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'end_time must be after start_time.' });
    }
  }
  contestsRepo.update(contest.id, u);
  const updated = contestsRepo.get(contest.id);
  res.json(updated);
});

router.post('/:id/problems', requireAuth, requireRole('teacher'), (req, res) => {
  const contest = contestsRepo.get(req.params.id);
  if (!contest) {
    return sendNotFound(res, 'Contest not found.');
  }
  const { problem_id, alias } = req.body;
  if (!problem_id) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'problem_id is required.' });
  }
  const problem = contestsRepo.findProblem(problem_id);
  if (!problem) {
    return sendNotFound(res, 'Problem not found.');
  }
  const existing = contestsRepo.findContestProblem(contest.id, problem_id);
  if (existing) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Problem already in contest.' });
  }
  const maxOrder = contestsRepo.maxSortOrder(contest.id);
  contestsRepo.insertContestProblem(contest.id, problem_id, maxOrder + 1, alias || '');
  res.status(201).json({ message: 'Problem added to contest.' });
});

router.delete('/:id/problems/:pid', requireAuth, requireRole('teacher'), (req, res) => {
  const contest = contestsRepo.get(req.params.id);
  if (!contest) {
    return sendNotFound(res, 'Contest not found.');
  }
  const existing = contestsRepo.findContestProblem(contest.id, req.params.pid);
  if (!existing) {
    return sendNotFound(res, 'Problem not in contest.');
  }
  contestsRepo.deleteContestProblem(contest.id, req.params.pid);
  res.json({ message: 'Problem removed from contest.' });
});

router.delete('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const contest = contestsRepo.get(req.params.id);
  if (!contest) {
    return sendNotFound(res, 'Contest not found.');
  }
  // 三张表同生共死：事务整体封装在 repositories/contests.js 的 deleteCascade 中
  contestsRepo.deleteCascade(contest.id);
  res.json({ message: 'Contest deleted.' });
});

router.post('/:id/invite', requireAuth, requireRole('teacher'), (req, res) => {
  const contest = contestsRepo.get(req.params.id);
  if (!contest) {
    return sendNotFound(res, 'Contest not found.');
  }
  const { user_id } = req.body;
  if (!user_id) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'user_id is required.' });
  }
  const user = contestsRepo.getUser(user_id);
  if (!user) {
    return sendNotFound(res, 'User not found.');
  }
  const existing = contestsRepo.findParticipant(contest.id, user_id);
  if (existing) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'User already in contest.' });
  }
  contestsRepo.inviteParticipant(contest.id, user_id, req.user.id);
  res.status(201).json({ message: `${user.username} has been invited.` });
});

router.post('/:id/join', requireAuth, (req, res) => {
  const contest = contestsRepo.get(req.params.id);
  if (!contest) {
    return sendNotFound(res, 'Contest not found.');
  }
  // 10.3: 隐藏比赛不允许普通用户报名（仅 staff 可见/可操作）
  if (contest.is_hidden && !isStaff(req.user.role)) {
    return sendNotFound(res, 'Contest not found.');
  }
  const existing = contestsRepo.findParticipant(contest.id, req.user.id);
  if (existing) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Already joined this contest.' });
  }
  contestsRepo.joinParticipant(contest.id, req.user.id);
  res.json({ message: 'Joined contest.' });
});

router.get('/:id/participants', requireAuth, requireRole('teacher'), (req, res) => {
  const contest = contestsRepo.get(req.params.id);
  if (!contest) {
    return sendNotFound(res, 'Contest not found.');
  }
  const participants = contestsRepo.listParticipants(contest.id);
  res.json({ total: participants.length, participants });
});

router.delete('/:id/participants/:uid', requireAuth, requireRole('teacher'), (req, res) => {
  const contest = contestsRepo.get(req.params.id);
  if (!contest) {
    return sendNotFound(res, 'Contest not found.');
  }
  contestsRepo.removeParticipant(contest.id, req.params.uid);
  res.json({ message: 'Participant removed.' });
});

router.get('/:id/leaderboard', optionalAuth, (req, res) => {
  const contest = contestsRepo.get(req.params.id);
  if (!contest) {
    return sendNotFound(res, 'Contest not found.');
  }
  // 10.3: 隐藏比赛排行榜仅 staff 可见
  if (contest.is_hidden && !(req.user && isStaff(req.user.role))) {
    return sendNotFound(res, 'Contest not found.');
  }

  // 判断冻结状态: freeze_minutes>0 且当前时间已过冻结时刻 且 未手动解冻
  let frozen = false;
  let freezeAt = null;
  if (contest.freeze_minutes > 0 && !contest.unfrozen) {
    const startMs = new Date(contest.start_time).getTime();
    const endMs = new Date(contest.end_time).getTime();
    const durMin = (endMs - startMs) / 60000;
    if (contest.freeze_minutes < durMin) {
      freezeAt = new Date(endMs - contest.freeze_minutes * 60000);
      if (Date.now() >= freezeAt.getTime()) {
        frozen = true;
      }
    }
  }

  // 仅参赛者可查看完整排行榜；教师/管理员/站长放行；非参赛者只返回冻结状态，不泄露排名
  const staff = !!req.user && isStaff(req.user.role);
  const participant = req.user
    ? contestsRepo.findParticipant(contest.id, req.user.id)
    : null;
  const freezeAtIso = freezeAt ? freezeAt.toISOString() : null;
  // 封榜占位：非参赛者/无题目的空榜，只回传封榜状态，不泄露任何排名
  const frozenState = standingsPayload({ frozen, freeze_at: freezeAtIso });
  if (!staff && !participant) {
    return res.json(frozenState);
  }
  const contestProblems = contestsRepo.listProblemIds(contest.id);
  if (contestProblems.length === 0) return res.json(frozenState);

  const problemIds = contestProblems.map(p => p.problem_id);

  const toSqliteUtc = (d) => {
    if (!d) return null;
    const date = new Date(d);
    if (isNaN(date.getTime())) return null;
    return date.toISOString().replace('T', ' ').substring(0, 19);
  };

  // 比赛时间窗口过滤：只统计比赛起止时间范围内的提交；冻结期间只统计到冻结时刻
  let timeFilter = '';
  const params = [...problemIds];

  const startUtc = toSqliteUtc(contest.start_time);
  if (startUtc) {
    timeFilter += ' AND s.created_at >= ?';
    params.push(startUtc);
  }

  if (frozen && freezeAt) {
    timeFilter += ' AND s.created_at <= ?';
    params.push(toSqliteUtc(freezeAt));
  } else if (contest.end_time) {
    const endUtc = toSqliteUtc(contest.end_time);
    if (endUtc) {
      timeFilter += ' AND s.created_at <= ?';
      params.push(endUtc);
    }
  }

  // 榜单仅统计已报名参赛的用户
  timeFilter += ' AND s.user_id IN (SELECT user_id FROM contest_participants WHERE contest_id = ?)';
  params.push(contest.id);

  const submissions = contestsRepo.getLeaderboardSubmissions(problemIds, timeFilter, params);

  // 提交聚合行 → 每题最佳成绩映射（按用户分组）；选优/累计/排序/名次统一走 utils/standings
  const userMap = buildUserProblemMap(submissions);

  const entries = Object.values(userMap).map(u => {
    const totals = acceptedTotals(u.problems, problemIds);
    return { user_id: u.user_id, username: u.username, nickname: u.nickname, total_score: totals.total_score, total_time: totals.total_time, problems: u.problems };
  });

  // 排序：总分降序 → 同分用时升序，随后统一补齐 rank
  const leaderboard = buildStandings(entries, (a, b) => compareByScore(a, b, (x, y) => x.total_time - y.total_time));

  res.json(standingsPayload({ leaderboard, problem_ids: problemIds, frozen, freeze_at: freezeAtIso }));
});

// 手动解冻排行榜 (admin)
router.post('/:id/unfreeze', requireAuth, requireRole('admin'), (req, res) => {
  const contest = contestsRepo.get(req.params.id);
  if (!contest) {
    return sendNotFound(res, 'Contest not found.');
  }
  // D-L17: 统一为 UTC ISO 8601（带 Z），与 freeze_at/toISOString 一致，避免前端 new Date() 本地时区解析偏差
  contestsRepo.unfreeze(contest.id, new Date().toISOString());
  const updated = contestsRepo.get(contest.id);
  // 解冻后广播给该比赛房间
  try {
    const { emitContestRanking } = require('../services/socket');
    if (emitContestRanking) emitContestRanking(contest.id, { type: 'unfrozen' });
  } catch {
    // 实时推送尽力而为，失败不影响解榜响应
  }
  res.json(updated);
});

// 比赛内公告
router.get('/:id/announcements', optionalAuth, (req, res) => {
  const contest = contestsRepo.get(req.params.id);
  if (!contest) {
    return sendNotFound(res, 'Contest not found.');
  }
  // 10.3: 隐藏比赛公告仅 staff 可见
  if (contest.is_hidden && !(req.user && isStaff(req.user.role))) {
    return sendNotFound(res, 'Contest not found.');
  }
  const items = contestsRepo.listAnnouncements(req.params.id);
  res.json({ announcements: items });
});

// 功能9：发起虚拟参加
router.post('/:id/virtual-start', requireAuth, (req, res) => {
  const { virtualStart } = require('../routes/virtual-contests');
  virtualStart(req, res);
});

// 功能10：比赛一键全部查重（admin/teacher，异步）
// POST /api/v1/contests/:id/plagiarism-check  对比赛所有题目依次发起查重
router.post('/:id/plagiarism-check', requireAuth, requireRole('teacher'), plagiarismRateLimit, (req, res) => {
  const contest = contestsRepo.findContest(req.params.id);
  if (!contest) {
    return sendNotFound(res, 'Contest not found.');
  }
  const problems = contestsRepo.listProblemIds(req.params.id);
  const { createTask } = require('../services/plagiarism');
  const tasks = [];
  for (const p of problems) {
    const taskId = createTask(p.problem_id, req.user.id);
    tasks.push({ problem_id: p.problem_id, task_id: taskId });
  }
  res.status(202).json({ tasks, total: tasks.length, message: 'Plagiarism checks started for all contest problems.' });
});

// 功能8：比赛讨论列表
router.get('/:id/discussions', optionalAuth, (req, res) => {
  const { page = 1, size = 20 } = req.query;
  const { page: pageNum, limit: sizeNum, offset } = parsePageLimit(page, size, 20, 50);
  const contest = contestsRepo.get(req.params.id);
  if (!contest) {
    return sendNotFound(res, 'Contest not found.');
  }
  // 10.3: 隐藏比赛讨论仅 staff 可见
  if (contest.is_hidden && !(req.user && isStaff(req.user.role))) {
    return sendNotFound(res, 'Contest not found.');
  }
  const total = contestsRepo.countDiscussions(req.params.id);
  const items = contestsRepo.listDiscussions(req.params.id, sizeNum, offset);
  res.json({ total, page: pageNum, size: sizeNum, discussions: items });
});

module.exports = router;
