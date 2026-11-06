const express = require('express');
const contestsRepo = require('../repositories/contests');
const { makeVisibilityRouter, visibilityFilterFor, visibilityDeniedMessage, canView } = require('./_visibility');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const { parsePageLimit } = require('../utils/pagination');
const { isStaff } = require('../utils/roles');
const { buildUpdates } = require('../utils/db');
const { buildUserProblemMap, mergeBest, acceptedTotals, compareByScore, buildStandings, standingsPayload } = require('../utils/standings');
const { sendCsv } = require('../utils/csv');
const { createRateLimit } = require('../middleware/ratelimit');
const crypto = require('crypto');

// R9-3: 一键查重限流（每分钟最多 5 次）
const plagiarismRateLimit = createRateLimit({ windowMs: 60000, max: 5 });

const { sendNotFound, sendForbidden } = require('../utils/apiErrors');

const router = express.Router();

// 比赛封榜状态：freeze_minutes>0 且已过冻结时刻且未手动解冻（结束后仍需手动解冻，与榜单行为一致）
function resolveContestFreeze(contest, nowMs = Date.now()) {
  const startMs = new Date(contest.start_time).getTime();
  const endMs = new Date(contest.end_time).getTime();
  const durMin = (endMs - startMs) / 60000;
  if ((contest.freeze_minutes || 0) > 0 && !contest.unfrozen && contest.freeze_minutes < durMin) {
    const freezeAt = new Date(endMs - contest.freeze_minutes * 60000);
    if (nowMs >= freezeAt.getTime()) return { frozen: true, freezeAt };
  }
  return { frozen: false, freezeAt: null };
}

// 比赛时间字符串 → SQLite UTC 文本（与 submissions.created_at 同格式），供榜单/统计时间窗过滤
function toSqliteUtc(d) {
  if (!d) return null;
  const date = new Date(d);
  if (isNaN(date.getTime())) return null;
  return date.toISOString().replace('T', ' ').substring(0, 19);
}

// 榜单计算（排行榜接口与 CSV 导出共用）：时间窗/封榜过滤 + 组队聚合 + 排序补齐名次
function computeContestStandings(contest) {
  const { frozen, freezeAt } = resolveContestFreeze(contest);
  const freezeAtIso = freezeAt ? freezeAt.toISOString() : null;
  const contestProblems = contestsRepo.listProblemIds(contest.id);
  const problemIds = contestProblems.map(p => p.problem_id);
  if (problemIds.length === 0) {
    return { frozen, freezeAtIso, problemIds: [], leaderboard: [] };
  }

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

  let entries;
  if (contest.team_mode) {
    // 组队榜：队员成绩逐题取队伍内最优，未组队者保持个人条目
    const memberRows = contestsRepo.listTeamMemberRows(contest.id);
    const teamMap = {};
    for (const t of contestsRepo.listTeams(contest.id)) {
      teamMap[t.id] = { team_id: t.id, team_name: t.name, problems: {}, members: [] };
    }
    const userTeam = {};
    for (const m of memberRows) {
      userTeam[m.user_id] = m.team_id;
      if (teamMap[m.team_id]) {
        teamMap[m.team_id].members.push({ user_id: m.user_id, username: m.username, nickname: m.nickname });
      }
    }
    for (const u of Object.values(userMap)) {
      const tid = userTeam[u.user_id];
      if (tid && teamMap[tid]) mergeBest(teamMap[tid].problems, u.problems);
    }
    entries = Object.values(teamMap)
      .filter(t => t.members.length > 0)
      .map(t => {
        const totals = acceptedTotals(t.problems, problemIds);
        return {
          team_id: t.team_id, team_name: t.team_name, username: t.team_name, nickname: '',
          is_team: true, members: t.members,
          total_score: totals.total_score, total_time: totals.total_time, problems: t.problems
        };
      });
    for (const u of Object.values(userMap)) {
      if (userTeam[u.user_id]) continue;
      const totals = acceptedTotals(u.problems, problemIds);
      entries.push({ user_id: u.user_id, username: u.username, nickname: u.nickname, total_score: totals.total_score, total_time: totals.total_time, problems: u.problems });
    }
  } else {
    entries = Object.values(userMap).map(u => {
      const totals = acceptedTotals(u.problems, problemIds);
      return { user_id: u.user_id, username: u.username, nickname: u.nickname, total_score: totals.total_score, total_time: totals.total_time, problems: u.problems };
    });
  }

  // 排序：总分降序 → 同分用时升序，随后统一补齐 rank
  const leaderboard = buildStandings(entries, (a, b) => compareByScore(a, b, (x, y) => x.total_time - y.total_time));
  return { frozen, freezeAtIso, problemIds, leaderboard };
}

// 实体可见性（用户组维度）：GET/PUT /:id/visibility
router.use(makeVisibilityRouter({
  resourceType: 'contest',
  tableName: 'contests',
  findResource: contestsRepo.get,
  setVisibility: contestsRepo.setVisibility
}));

// 公开比赛列表保持匿名可访问；挂 optionalAuth 以便识别登录用户角色
router.get('/', optionalAuth, (req, res) => {
  const { page = 1, limit = 50, search = '' } = req.query;
  const { page: pageNum, limit: limitNum, offset } = parsePageLimit(page, limit, 50, 100);
  let where = '';
  const params = [];
  const fuzzy = search ? '%' + search.replace(/\s+/g, '') + '%' : null;
  // 隐藏比赛仅对 teacher/admin/su 可见
  const staff = !!req.user && isStaff(req.user.role);
  if (!staff) {
    where = 'WHERE c.is_hidden = 0';
    // 实体可见性（用户组）：staff 条件为空 → 不过滤；其余按 public ∪ 命中绑定组过滤
    const vis = visibilityFilterFor(req, 'contest');
    if (vis.sql) {
      where += ` AND (${vis.sql})`;
      params.push(...vis.params);
    }
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
  // 实体可见性（用户组）：visibility='groups' 的比赛仅绑定组成员与 staff 可见
  if (!canView(req, 'contest', contest.id)) {
    return sendForbidden(res, visibilityDeniedMessage('contest'));
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
  const { title, description, start_time, end_time, is_virtual, freeze_minutes, is_hidden, stats_public, team_mode, max_team_size } = req.body;
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
  const maxTeamSize = Math.min(10, Math.max(1, parseInt(max_team_size) || 3));
  const result = contestsRepo.insert(title, description || '', start_time, end_time, is_virtual ? 1 : 0, fm, is_hidden ? 1 : 0, req.user.id, stats_public ? 1 : 0, team_mode ? 1 : 0, maxTeamSize);
  const contest = contestsRepo.get(result.lastInsertRowid);
  res.status(201).json(contest);
});

router.put('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const contest = contestsRepo.get(req.params.id);
  if (!contest) {
    return sendNotFound(res, 'Contest not found.');
  }
  const { title, description, start_time, end_time, is_virtual, freeze_minutes, is_hidden, stats_public, team_mode, max_team_size } = req.body;
  const u = buildUpdates([
    { key: 'title', value: title },
    { key: 'description', value: description },
    { key: 'start_time', value: start_time },
    { key: 'end_time', value: end_time },
    { key: 'is_virtual', value: is_virtual, transform: v => v ? 1 : 0 },
    { key: 'freeze_minutes', value: freeze_minutes, transform: v => Math.max(0, parseInt(v) || 0) },
    { key: 'is_hidden', value: is_hidden, transform: v => v ? 1 : 0 },
    { key: 'stats_public', value: stats_public, transform: v => v ? 1 : 0 },
    { key: 'team_mode', value: team_mode, transform: v => v ? 1 : 0 },
    { key: 'max_team_size', value: max_team_size, transform: v => Math.min(10, Math.max(1, parseInt(v) || 3)) }
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
  // 通知中心：告知被邀请者（失败不影响邀请本身）
  try {
    const { notifyUser } = require('../services/notifications');
    notifyUser(user_id, {
      type: 'contest',
      title: `你被邀请参加比赛「${contest.title}」`,
      content: `邀请人：${req.user.username}`,
      link: `/pages/contest.html?id=${contest.id}`
    });
  } catch {
    // 尽力而为
  }
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
  // 实体可见性（用户组）：组外用户不得报名（否则可借参赛名单探测组内比赛）
  if (!canView(req, 'contest', contest.id)) {
    return sendForbidden(res, visibilityDeniedMessage('contest'));
  }
  const existing = contestsRepo.findParticipant(contest.id, req.user.id);
  if (existing) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Already joined this contest.' });
  }
  contestsRepo.joinParticipant(contest.id, req.user.id);
  res.json({ message: 'Joined contest.' });
});

// ── 比赛组队（仅 team_mode=1 的比赛可用）──
function contestTeamError(req, res) {
  const contest = contestsRepo.get(req.params.id);
  if (!contest) {
    sendNotFound(res, 'Contest not found.');
    return null;
  }
  if (contest.is_hidden && !isStaff(req.user.role)) {
    sendNotFound(res, 'Contest not found.');
    return null;
  }
  if (!canView(req, 'contest', contest.id)) {
    sendForbidden(res, visibilityDeniedMessage('contest'));
    return null;
  }
  if (!contest.team_mode) {
    res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'This contest is not in team mode.' });
    return null;
  }
  return contest;
}

function newInviteCode() {
  return crypto.randomBytes(6).toString('hex').slice(0, 8).toUpperCase();
}

function joinContestAsParticipant(contest, userId) {
  if (!contestsRepo.findParticipant(contest.id, userId)) {
    contestsRepo.joinParticipant(contest.id, userId);
  }
}

router.post('/:id/teams', requireAuth, (req, res) => {
  const contest = contestTeamError(req, res);
  if (!contest) return;
  const name = String(req.body.name ?? '').trim();
  if (!name || name.length > 40) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '队伍名称需为 1-40 个字符。' });
  }
  if (contestsRepo.findUserTeam(contest.id, req.user.id)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '你已在该比赛的某个队伍中。' });
  }
  if (contestsRepo.findTeamByName(contest.id, name)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '该队名已被使用。' });
  }
  let created = null;
  for (let i = 0; i < 5 && !created; i++) {
    try {
      created = contestsRepo.insertTeam(contest.id, name, newInviteCode(), req.user.id);
    } catch {
      // 邀请码撞车：换一个再试（UNIQUE 约束兜底）
    }
  }
  if (!created) {
    return res.status(500).json({ code: 1, reason: 'ERR_INTERNAL', message: 'Failed to create team.' });
  }
  const team = contestsRepo.findTeamById(created.lastInsertRowid);
  contestsRepo.addTeamMember(team.id, contest.id, req.user.id);
  joinContestAsParticipant(contest, req.user.id);
  res.status(201).json({ ...team, members: contestsRepo.teamMembers(team.id), is_owner: true });
});

router.post('/:id/teams/join', requireAuth, (req, res) => {
  const contest = contestTeamError(req, res);
  if (!contest) return;
  const code = String(req.body.invite_code ?? '').trim().toUpperCase();
  if (!code) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'invite_code is required.' });
  }
  const team = contestsRepo.findTeamByCode(code);
  if (!team || team.contest_id !== contest.id) {
    return sendNotFound(res, 'Invite code not found.');
  }
  if (contestsRepo.findUserTeam(contest.id, req.user.id)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '你已在该比赛的某个队伍中。' });
  }
  // 队伍人数上限受比赛配置约束
  if (contestsRepo.countTeamMembers(team.id) >= (contest.max_team_size || 3)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '队伍人数已满。' });
  }
  contestsRepo.addTeamMember(team.id, contest.id, req.user.id);
  joinContestAsParticipant(contest, req.user.id);
  res.json({ ...team, members: contestsRepo.teamMembers(team.id), is_owner: team.owner_id === req.user.id });
});

router.get('/:id/teams/mine', requireAuth, (req, res) => {
  const contest = contestTeamError(req, res);
  if (!contest) return;
  const team = contestsRepo.findUserTeam(contest.id, req.user.id);
  if (!team) return res.json({ team: null });
  res.json({
    team: { ...team, is_owner: team.owner_id === req.user.id, members: contestsRepo.teamMembers(team.id) },
    max_team_size: contest.max_team_size || 3
  });
});

router.get('/:id/teams', optionalAuth, (req, res) => {
  const contest = contestsRepo.get(req.params.id);
  if (!contest) return sendNotFound(res, 'Contest not found.');
  if (contest.is_hidden && !(req.user && isStaff(req.user.role))) {
    return sendNotFound(res, 'Contest not found.');
  }
  if (!canView(req, 'contest', contest.id)) {
    return sendForbidden(res, visibilityDeniedMessage('contest'));
  }
  if (!contest.team_mode) return res.json({ team_mode: false, max_team_size: 0, teams: [] });
  const staff = !!req.user && isStaff(req.user.role);
  const myTeam = req.user ? contestsRepo.findUserTeam(contest.id, req.user.id) : null;
  const teams = contestsRepo.listTeams(contest.id).map((t) => {
    const member = req.user ? contestsRepo.teamMembers(t.id).find((m) => m.user_id === req.user.id) : null;
    // 邀请码只回给队长/队员与 staff，避免任何人可观榜即拉陌生人入队
    const revealCode = staff || (myTeam && myTeam.id === t.id) || member;
    return {
      id: t.id,
      name: t.name,
      owner_id: t.owner_id,
      member_count: t.member_count,
      invite_code: revealCode ? t.invite_code : null,
      members: contestsRepo.teamMembers(t.id).map((m) => ({ user_id: m.user_id, username: m.username, nickname: m.nickname }))
    };
  });
  res.json({ team_mode: true, max_team_size: contest.max_team_size || 3, teams });
});

// 退出队伍：队长退出则解散整队（成员一并移除）
router.delete('/:id/teams/mine', requireAuth, (req, res) => {
  const contest = contestTeamError(req, res);
  if (!contest) return;
  const team = contestsRepo.findUserTeam(contest.id, req.user.id);
  if (!team) return sendNotFound(res, 'You are not in a team.');
  if (team.owner_id === req.user.id) {
    contestsRepo.deleteTeam(team.id);
    return res.json({ message: '队伍已解散。', dissolved: true });
  }
  contestsRepo.removeTeamMember(contest.id, req.user.id);
  res.json({ message: '已退出队伍。', dissolved: false });
});

// 解散队伍（队长或 staff）
router.delete('/:id/teams/:tid', requireAuth, (req, res) => {
  const contest = contestsRepo.get(req.params.id);
  if (!contest) return sendNotFound(res, 'Contest not found.');
  const team = contestsRepo.findTeamById(req.params.tid);
  if (!team || team.contest_id !== contest.id) {
    return sendNotFound(res, 'Team not found.');
  }
  if (team.owner_id !== req.user.id && !isStaff(req.user.role)) {
    return sendForbidden(res, 'Only the team owner can dissolve this team.');
  }
  contestsRepo.deleteTeam(team.id);
  res.json({ message: '队伍已解散。' });
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
  // 实体可见性（用户组）：组外用户不得读榜（含题目 id 与排名）
  if (!canView(req, 'contest', contest.id)) {
    return sendForbidden(res, visibilityDeniedMessage('contest'));
  }

  // 判断冻结状态: freeze_minutes>0 且当前时间已过冻结时刻 且 未手动解冻
  const { frozen, freezeAt } = resolveContestFreeze(contest);
  const freezeAtIso = freezeAt ? freezeAt.toISOString() : null;

  // 仅参赛者可查看完整排行榜；教师/管理员/站长放行；非参赛者只返回冻结状态，不泄露排名
  const staff = !!req.user && isStaff(req.user.role);
  const participant = req.user
    ? contestsRepo.findParticipant(contest.id, req.user.id)
    : null;
  // 封榜占位：非参赛者/无题目的空榜，只回传封榜状态，不泄露任何排名
  const frozenState = standingsPayload({ frozen, freeze_at: freezeAtIso });
  if (!staff && !participant) {
    return res.json(frozenState);
  }
  if (contestsRepo.listProblemIds(contest.id).length === 0) return res.json(frozenState);

  const { problemIds, leaderboard } = computeContestStandings(contest);

  res.json(standingsPayload({ leaderboard, problem_ids: problemIds, frozen, freeze_at: freezeAtIso }));
});

// 排行榜 CSV 导出：教师可导出全员（默认），参赛者可导出自己在榜的一行（scope=mine）。
// 数据与 GET /:id/leaderboard 完全同源（computeContestStandings），封榜口径一致。
router.get('/:id/export.csv', optionalAuth, (req, res) => {
  const contest = contestsRepo.get(req.params.id);
  if (!contest) {
    return sendNotFound(res, 'Contest not found.');
  }
  if (contest.is_hidden && !(req.user && isStaff(req.user.role))) {
    return sendNotFound(res, 'Contest not found.');
  }
  if (!canView(req, 'contest', contest.id)) {
    return sendForbidden(res, visibilityDeniedMessage('contest'));
  }

  const staff = !!req.user && isStaff(req.user.role);
  const participant = req.user ? contestsRepo.findParticipant(contest.id, req.user.id) : null;
  if (!staff && !participant) {
    return sendForbidden(res, '仅参赛者可导出该比赛的排行榜。');
  }
  const wantAll = staff && String(req.query.scope || 'all') !== 'mine';

  const { problemIds, leaderboard } = computeContestStandings(contest);
  let entries = leaderboard;
  if (!wantAll) {
    entries = leaderboard.filter(e =>
      e.user_id === req.user.id ||
      (e.is_team && (e.members || []).some(m => m.user_id === req.user.id))
    );
    if (entries.length === 0) {
      return sendNotFound(res, '未找到你在该比赛排行榜中的记录。');
    }
  }

  const header = ['排名', '用户/队伍', '类型', '成员', '总分', '总用时(ms)', ...problemIds.map(id => `题#${id}`)];
  const csvRows = [
    header,
    ...entries.map(e => [
      e.rank,
      e.is_team ? e.team_name : e.username,
      e.is_team ? '队伍' : '个人',
      e.is_team ? (e.members || []).map(m => m.nickname || m.username).join('、') : (e.nickname || ''),
      e.total_score,
      e.total_time,
      ...problemIds.map(pid => {
        const p = e.problems[pid];
        if (!p) return '未提交';
        return p.status === 'accepted' ? `AC ${p.score} (${p.time_used}ms)` : '未通过';
      })
    ])
  ];
  return sendCsv(res, `${contest.title}-${wantAll ? '排行榜' : '我的成绩单'}.csv`, csvRows);
});

// 比赛数据统计：教师始终可看；stats_public=1 时学生可看。
// 与排行榜同口径：只统计参赛者、比赛时间窗内、封榜时截断到冻结时刻；仅输出聚合数据。
router.get('/:id/stats', optionalAuth, (req, res) => {
  const contest = contestsRepo.get(req.params.id);
  if (!contest) {
    return sendNotFound(res, 'Contest not found.');
  }
  const staff = !!req.user && isStaff(req.user.role);
  // 隐藏比赛的统计仅 staff 可见（与排行榜一致）
  if (contest.is_hidden && !staff) {
    return sendNotFound(res, 'Contest not found.');
  }
  // 实体可见性（用户组）：组外用户不得查看统计
  if (!canView(req, 'contest', contest.id)) {
    return sendForbidden(res, visibilityDeniedMessage('contest'));
  }
  // 统计开关：教师/管理员始终可看；学生仅在开关打开时可看
  if (!staff && !contest.stats_public) {
    return sendForbidden(res, '统计未公开，仅教师可见。');
  }

  const { frozen, freezeAt } = resolveContestFreeze(contest);
  const freezeAtIso = freezeAt ? freezeAt.toISOString() : null;
  // 非 staff 过滤隐藏题：统计页不下发学生看不到的题目标题
  const problems = staff
    ? contestsRepo.listStaffProblems(contest.id)
    : contestsRepo.listProblems(contest.id, ' AND p.is_hidden = 0');
  const problemIds = problems.map(p => p.id);

  let submissions = [];
  if (problemIds.length > 0) {
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
    // 仅统计已报名参赛的用户
    timeFilter += ' AND s.user_id IN (SELECT user_id FROM contest_participants WHERE contest_id = ?)';
    params.push(contest.id);

    submissions = contestsRepo.getLeaderboardSubmissions(problemIds, timeFilter, params);
  }

  // 每题：尝试人数/提交数/AC 人数/通过率（按人数而非提交数，避免重复提交刷高分母）
  const detail = problems.map(p => {
    const rows = submissions.filter(s => s.problem_id === p.id);
    const attempted = new Set(rows.map(r => r.user_id)).size;
    const acceptedUsers = new Set(rows.filter(r => r.status === 'accepted').map(r => r.user_id)).size;
    return {
      problem_id: p.id,
      alias: p.alias || '',
      title: p.title,
      attempts: rows.length,
      users: attempted,
      accepted_users: acceptedUsers,
      accept_rate: attempted > 0 ? Math.round(acceptedUsers * 1000 / attempted) / 10 : 0
    };
  });

  const userMap = buildUserProblemMap(submissions);
  const activeUsers = Object.keys(userMap).length;
  let solvedTotal = 0;
  let solvedAll = 0;
  for (const u of Object.values(userMap)) {
    const solved = problemIds.filter(pid => u.problems[pid] && u.problems[pid].status === 'accepted').length;
    solvedTotal += solved;
    if (problemIds.length > 0 && solved === problemIds.length) solvedAll += 1;
  }

  res.json({
    contest_id: contest.id,
    title: contest.title,
    start_time: contest.start_time || null,
    end_time: contest.end_time || null,
    stats_public: !!contest.stats_public,
    frozen: !!frozen,
    freeze_at: freezeAtIso,
    summary: {
      participant_count: contestsRepo.countParticipants(contest.id),
      active_users: activeUsers,
      submissions: submissions.length,
      accepted_submissions: submissions.filter(s => s.status === 'accepted').length,
      solved_all: solvedAll,
      average_solved: activeUsers > 0 ? Math.round(solvedTotal * 10 / activeUsers) / 10 : 0
    },
    problems: detail
  });
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
  // 实体可见性（用户组）：公告与详情页同口径
  if (!canView(req, 'contest', contest.id)) {
    return sendForbidden(res, visibilityDeniedMessage('contest'));
  }
  const items = contestsRepo.listAnnouncements(req.params.id);
  res.json({ announcements: items });
});

// 功能9：发起虚拟参加
router.post('/:id/virtual-start', requireAuth, (req, res) => {
  // 实体可见性（用户组）：虚拟参加会复制整套题目，组外用户不得发起（virtualStart 内再做一次隐藏比赛校验）
  const contest = contestsRepo.get(req.params.id);
  if (!contest) {
    return sendNotFound(res, 'Contest not found.');
  }
  if (!canView(req, 'contest', contest.id)) {
    return sendForbidden(res, visibilityDeniedMessage('contest'));
  }
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
  // 实体可见性（用户组）：讨论列表与详情页同口径
  if (!canView(req, 'contest', contest.id)) {
    return sendForbidden(res, visibilityDeniedMessage('contest'));
  }
  const total = contestsRepo.countDiscussions(req.params.id);
  const items = contestsRepo.listDiscussions(req.params.id, sizeNum, offset);
  res.json({ total, page: pageNum, size: sizeNum, discussions: items });
});

module.exports = router;
