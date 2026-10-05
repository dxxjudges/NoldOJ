const db = require('../../database/db');
const { emitJudgeStatus, emitContestRanking } = require('../socket');
const { checkAchievements } = require('../achievements');
const examProgram = require('../examProgram');
const { evaluateTestCases } = require('./runner');
const { logWarn, logError } = require('../../utils/logger');

// 魔法数字常量: 评分规则 / 日志截断 / 资源限制
const RATING_DELTA_COMPILE_ERROR = -2;
const RATING_DELTA_ACCEPTED = 10;

// rejudge 任务入队时记录原始状态（在路由层已被改为 pending_rejudge，无法回读），
// 供评分发放去重判断（wasAccepted/wasCompileError）
const rejudgePrevStatus = new Map();

async function judgeSubmission(submissionId) {
  const submission = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
  if (!submission) return;

  // 记录判题前的状态，用于评分发放去重（rejudge 场景：路由层已把状态改为 pending_rejudge，
  // 原始状态需经 rejudgePrevStatus 传入，否则 wasAccepted/wasCompileError 恒为 false）
  const prevStatus = rejudgePrevStatus.get(submissionId) || submission.status;
  const wasAccepted = prevStatus === 'accepted';
  const wasCompileError = prevStatus === 'compile_error';

  db.prepare("UPDATE submissions SET status = 'judging' WHERE id = ?").run(submissionId);
  emitJudgeStatus(submissionId, submission.user_id, 'judging');
  // 每轮判题都从空白详情开始：rejudge 可能发生在上一轮尚未结束时，
  // 若不清理会出现"状态已更新但残留上一轮详情"或重复详情行。
  try {
    db.prepare('DELETE FROM submission_details WHERE submission_id = ?').run(submissionId);
  } catch (e) {
    // 清理失败会与本轮新插详情叠加成重复测试点行，必须可见
    logWarn('JUDGE', `清理旧评测详情失败 (submission ${submissionId}): ${e && e.message}`);
  }

  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(submission.problem_id);
  if (!problem) {
    db.prepare("UPDATE submissions SET status = 'system_error' WHERE id = ?").run(submissionId);
    emitJudgeStatus(submissionId, submission.user_id, 'system_error');
    return;
  }

  const testCases = db.prepare('SELECT * FROM test_cases WHERE problem_id = ? ORDER BY sort_order, id').all(submission.problem_id);
  if (testCases.length === 0) {
    db.prepare("UPDATE submissions SET status = 'accepted', score = 0 WHERE id = ?").run(submissionId);
    emitJudgeStatus(submissionId, submission.user_id, 'accepted');
    // 试卷编程题防御性回填（正常路径下考试题必有测试点，见 exams.js 校验）
    if (problem.exam_id) {
      try { examProgram.writeBackAfterJudge(submissionId); } catch (e) {
        logError('JUDGE', `试卷答题回填失败 (submission ${submissionId}): ${e && e.message}`);
      }
    }
    return;
  }

  const timeLimitMs = problem.time_limit;
  await evaluateTestCases(submission, submission.problem_id, testCases, timeLimitMs);

  try {
    const updated = db.prepare('SELECT status, score FROM submissions WHERE id = ?').get(submissionId);
    if (!updated) return;

    // 推送最终评测状态
    emitJudgeStatus(submissionId, submission.user_id, updated.status);

    // 试卷编程题：回填 exam_answers 折算分并重算试卷提交总分（状态同步为 graded）
    if (problem.exam_id) {
      try {
        examProgram.writeBackAfterJudge(submissionId);
      } catch (e) {
        logError('JUDGE', `试卷答题回填失败 (submission ${submissionId}): ${e && e.message}`);
      }
      // 考试提交完全隔离：不计成就、不发 Rating、不进比赛榜单与题单进度
      return;
    }

    // 成就检查（每次评测结束触发，含非 AC，用于连续做题天数的累计）
    try {
      checkAchievements(submission.user_id, submission.problem_id, submission.language, updated.created_at || submission.created_at);
    } catch (e) {
      logWarn('JUDGE', `成就检查失败 (submission ${submissionId}): ${e && e.message}`);
    }

    if (updated.status === 'compile_error' && !wasCompileError) {
      db.prepare('UPDATE users SET rating = rating + ? WHERE id = ?').run(RATING_DELTA_COMPILE_ERROR, submission.user_id);
    }

    if (updated.status === 'accepted') {
      // R9-12/R10-1: 首 AC 加分竞态——同 (user,problem) 两提交并发判题时，双方都查不到
      // 对方已 AC（都未落库），会双双 +10；且新提交 first_accepted 默认 0，若仅按
      // first_accepted=0 判断则重复 AC 也会再次 +10（可无限刷分）。改为原子占位：
      // 仅当该 (user,problem) 尚无任何 first_accepted=1 时才标记并发放 Rating。
      const claimed = db.prepare(`
        UPDATE submissions SET first_accepted = 1
        WHERE user_id = ? AND problem_id = ? AND status = 'accepted' AND first_accepted = 0
          AND NOT EXISTS (
            SELECT 1 FROM submissions
            WHERE user_id = ? AND problem_id = ? AND first_accepted = 1
          )
      `).run(submission.user_id, submission.problem_id, submission.user_id, submission.problem_id);
      const firstAccepted = claimed.changes > 0 && !wasAccepted;
      if (firstAccepted) {
        db.prepare('UPDATE users SET rating = rating + ? WHERE id = ?').run(RATING_DELTA_ACCEPTED, submission.user_id);
      }
      // 推送比赛排行榜更新（若该题目属于某比赛）
      const contestProblem = db.prepare('SELECT cp.contest_id FROM contest_problems cp WHERE cp.problem_id = ?').get(submission.problem_id);
      if (contestProblem) {
        emitContestRanking(contestProblem.contest_id, {
          user_id: submission.user_id,
          submission_id: submissionId,
          problem_id: submission.problem_id,
          status: 'accepted'
        });
      }
      // 自动更新题单进度（功能7）：将该题所在的题单中标记为已解决
      try {
        const sets = db.prepare('SELECT DISTINCT set_id FROM problem_set_items WHERE problem_id = ?').all(submission.problem_id);
        if (sets.length > 0) {
          const upsert = db.prepare(`
            INSERT INTO problem_set_progress (user_id, set_id, problem_id, solved, solved_at)
            VALUES (?, ?, ?, 1, datetime('now'))
            ON CONFLICT(user_id, set_id, problem_id) DO UPDATE SET solved = 1, solved_at = datetime('now')
          `);
          for (const s of sets) upsert.run(submission.user_id, s.set_id, submission.problem_id);
        }
      } catch (e) {
        logWarn('JUDGE', `题单进度更新失败 (submission ${submissionId}): ${e && e.message}`);
      }
    }
  } catch (e) {
    // 评测后处理（推送/加分/榜单/题单）失败不能吞掉：它直接表现为"判完但分数没动"
    logError('JUDGE', `评测后处理失败 (submission ${submissionId}): ${e && e.message}`);
  }
}

module.exports = { judgeSubmission, rejudgePrevStatus };
