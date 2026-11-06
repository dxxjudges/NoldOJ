const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
require('./_testdb')('contest-teams');
const db = require('../database/db');
const contestsRepo = require('../repositories/contests');
const { buildUserProblemMap, mergeBest, acceptedTotals } = require('../utils/standings');

describe('比赛组队', () => {
  let contest;
  let owner;
  let mate;
  let outsider;
  let teamId;

  before(async () => {
    await db.initDB();
    db.prepare("DELETE FROM users WHERE username IN ('tm_owner', 'tm_mate', 'tm_outsider')").run();
    owner = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('tm_owner', 'h', 'user')").run().lastInsertRowid;
    mate = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('tm_mate', 'h', 'user')").run().lastInsertRowid;
    outsider = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('tm_outsider', 'h', 'user')").run().lastInsertRowid;
    contest = contestsRepo.insert('组队赛', '', '2026-03-10 10:00:00', '2026-03-10 15:00:00', 0, 0, 0, owner, 0, 1, 3).lastInsertRowid;
  });

  after(() => {
    db.prepare('DELETE FROM contest_teams WHERE contest_id = ?').run(contest);
    db.prepare('DELETE FROM contests WHERE id = ?').run(contest);
    db.prepare("DELETE FROM users WHERE username IN ('tm_owner', 'tm_mate', 'tm_outsider')").run();
  });

  it('创建队伍：邀请码唯一、队长为创建者', () => {
    const res = contestsRepo.insertTeam(contest, 'Alpha', 'AAA111', owner);
    teamId = res.lastInsertRowid;
    const team = contestsRepo.findTeamById(teamId);
    assert.equal(team.contest_id, contest);
    assert.equal(team.owner_id, owner);
    assert.equal(team.invite_code, 'AAA111');
    // 邀请码撞车时 UNIQUE 约束生效
    assert.throws(() => contestsRepo.insertTeam(contest, 'Beta', 'AAA111', mate));
  });

  it('加队/查队/人数统计', () => {
    contestsRepo.addTeamMember(teamId, contest, owner);
    contestsRepo.addTeamMember(teamId, contest, mate);
    const team = contestsRepo.findUserTeam(contest, owner);
    assert.ok(team);
    assert.equal(contestsRepo.countTeamMembers(teamId), 2);
    assert.equal(contestsRepo.findUserTeam(contest, mate).id, teamId);
    assert.equal(contestsRepo.findUserTeam(contest, outsider), undefined);
    const members = contestsRepo.teamMembers(teamId);
    assert.equal(members.length, 2);
    assert.ok(members.some(m => m.user_id === mate));
  });

  it('同一比赛一人只能在一个队伍（(contest_id,user_id) 主键）', () => {
    assert.throws(() => contestsRepo.addTeamMember(teamId, contest, mate));
  });

  it('邀请码全局查找，可从队伍名查重', () => {
    assert.equal(contestsRepo.findTeamByCode('AAA111').id, teamId);
    assert.ok(contestsRepo.findTeamByName(contest, 'Alpha'));
    assert.equal(contestsRepo.findTeamByName(contest, '不存在'), undefined);
  });

  it('退出成员 / 转让队长 / 解散', () => {
    contestsRepo.removeTeamMember(contest, mate);
    assert.equal(contestsRepo.findUserTeam(contest, mate), undefined);
    contestsRepo.transferOwner(teamId, owner);
    assert.equal(contestsRepo.findTeamById(teamId).owner_id, owner);
    // 解散队伍时成员记录级联删除
    contestsRepo.deleteTeam(teamId);
    assert.equal(contestsRepo.findTeamById(teamId), undefined);
    assert.equal(contestsRepo.listTeamMemberRows(contest).length, 0);
  });

  it('组队榜聚合：队伍内每题取最优，未组队者个人参赛', () => {
    const rows = [
      { user_id: owner, username: 'owner', nickname: 'O', problem_id: 1, score: 100, time_used: 30, status: 'accepted' },
      { user_id: owner, username: 'owner', nickname: 'O', problem_id: 2, score: 0, time_used: 0, status: 'wrong_answer' },
      { user_id: mate, username: 'mate', nickname: 'M', problem_id: 1, score: 100, time_used: 10, status: 'accepted' },
      { user_id: mate, username: 'mate', nickname: 'M', problem_id: 2, score: 100, time_used: 40, status: 'accepted' },
      { user_id: outsider, username: 'outsider', nickname: 'X', problem_id: 1, score: 100, time_used: 5, status: 'accepted' }
    ];
    const userMap = buildUserProblemMap(rows);
    const teamProblems = {};
    mergeBest(teamProblems, userMap[owner].problems);
    mergeBest(teamProblems, userMap[mate].problems);

    // 同题 AB 各自 AC：保留用时更短的
    assert.equal(teamProblems[1].time_used, 10);
    // owner 的 WA 不会压过 mate 的 AC
    assert.equal(teamProblems[2].status, 'accepted');
    const totals = acceptedTotals(teamProblems, [1, 2]);
    assert.equal(totals.total_score, 200);
    assert.equal(totals.total_time, 50);
    // 未组队者的个人成绩不受影响
    assert.equal(acceptedTotals(userMap[outsider].problems, [1]).total_score, 100);
  });
});
