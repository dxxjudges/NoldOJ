const { runScoringScript } = require('../../sandbox/scorer');

// 魔法数字常量: 评分规则 / 日志截断 / 资源限制
const MAX_GROUP_EVAL_ITERATIONS = 100;

function statusToConstant(status) {
  if (status === 'accepted') return 1;
  if (status === 'time_limit_exceeded') return 3;
  if (status === 'memory_limit_exceeded') return 4;
  if (status === 'skipped') return 0;
  return 2;
}

function topoSortGroups(groups) {
  const groupMap = {};
  for (const g of groups) groupMap[g.id] = g;

  const validIds = new Set(Object.keys(groupMap).map(Number));

  const visited = new Set();
  const visiting = new Set();
  const order = [];

  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) return;
    visiting.add(id);
    const g = groupMap[id];
    if (g) {
      let deps = [];
      try { deps = JSON.parse(g.dependency || '[]'); } catch { /* 依赖配置非法时按无依赖处理 */ }
      for (const d of deps) {
        if (validIds.has(Number(d))) visit(d);
      }
    }
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  }

  for (const g of groups) visit(g.id);
  return order;
}

// 提交/分组级状态归并。原先只会产出 accepted / time_limit_exceeded / wrong_answer，
// 导致测试点的 runtime_error、memory_limit_exceeded、system_error 全被降级成
// "答案错误"——教师误删 .out 时学生会看到 WA 而不是 system_error。
// skipped 是依赖跳过，不参与失败状态选择。
const FAILURE_STATUS_ORDER = ['system_error', 'memory_limit_exceeded', 'time_limit_exceeded', 'runtime_error', 'wrong_answer'];
function aggregateFailureStatus(items) {
  for (const s of FAILURE_STATUS_ORDER) {
    if (items.some(x => x.status === s)) return s;
  }
  return 'wrong_answer';
}

function evaluateSimple(problem, tcResults) {
  const hasScript = problem.scoring_script && problem.scoring_script.trim();

  if (!hasScript) {
    let totalScore = 0, maxTime = 0, maxMem = 0, allPassed = true;
    for (const tc of tcResults) {
      totalScore += tc.score;
      maxTime = Math.max(maxTime, tc.timeUsed);
      maxMem = Math.max(maxMem, tc.memoryUsed);
      if (tc.status !== 'accepted') allPassed = false;
    }
    return {
      score: allPassed ? totalScore : tcResults.filter(t => t.status === 'accepted').reduce((s, t) => s + t.score, 0),
      status: allPassed ? 'accepted' : aggregateFailureStatus(tcResults),
      time: maxTime,
      memory: maxMem
    };
  }

  const context = {};
  for (const tc of tcResults) {
    context[`@status${tc.tcId}`] = statusToConstant(tc.status);
    context[`@score${tc.tcId}`] = tc.score;
    context[`@time${tc.tcId}`] = tc.timeUsed;
    context[`@memory${tc.tcId}`] = tc.memoryUsed;
  }

  context['@total_score'] = 0;
  context['@final_status'] = 2;
  context['@final_time'] = 0;
  context['@final_memory'] = 0;

  const result = runScoringScript(problem.scoring_script, context);

  return {
    score: result.total_score,
    status: result.final_status,
    time: result.final_time,
    memory: result.final_memory
  };
}

function evaluateWithGroups(problem, groups, tcResults) {
  const tcsByGroup = {};
  for (const tc of tcResults) {
    const gid = tc.groupId || 0;
    if (!tcsByGroup[gid]) tcsByGroup[gid] = [];
    tcsByGroup[gid].push(tc);
  }

  const groupResults = {};
  const completedGroups = new Set();

  const pendingGroups = new Set(groups.map(g => g.id));
  let iterations = 0;

  while (pendingGroups.size > 0 && iterations < MAX_GROUP_EVAL_ITERATIONS) {
    iterations++;
    let madeProgress = false;

    for (const group of groups) {
      if (!pendingGroups.has(group.id)) continue;

      let deps = [];
      try { deps = JSON.parse(group.dependency || '[]'); } catch { /* 依赖配置非法时按无依赖处理 */ }
      const depsMet = deps.every(d => completedGroups.has(d));

      if (!depsMet) continue;

      pendingGroups.delete(group.id);

      const groupTCs = tcsByGroup[group.id] || [];
      const hasScript = group.scoring_script && group.scoring_script.trim();

      const allSkipped = groupTCs.length > 0 && groupTCs.every(tc => tc.status === 'skipped');

      if (allSkipped) {
        groupResults[group.id] = {
          score: 0,
          status: 'skipped',
          time: 0,
          memory: 0,
          maxScore: group.score
        };
        completedGroups.add(group.id);
        madeProgress = true;
        continue;
      }

      if (hasScript) {
        const context = {};
        for (const tc of groupTCs) {
          context[`@status${tc.tcId}`] = statusToConstant(tc.status);
          context[`@score${tc.tcId}`] = tc.score;
          context[`@time${tc.tcId}`] = tc.timeUsed;
          context[`@memory${tc.tcId}`] = tc.memoryUsed;
        }

        context['@total_score'] = 0;
        context['@final_status'] = 2;
        context['@final_time'] = 0;
        context['@final_memory'] = 0;

        const result = runScoringScript(group.scoring_script, context);
        groupResults[group.id] = {
          score: result.total_score,
          status: result.final_status,
          time: result.final_time,
          memory: result.final_memory,
          maxScore: group.score
        };
      } else {
        let score = 0, maxTime = 0, maxMem = 0, allPassed = true, allSkipped = true;
        for (const tc of groupTCs) {
          if (tc.status !== 'skipped') allSkipped = false;
          score += tc.score;
          maxTime = Math.max(maxTime, tc.timeUsed);
          maxMem = Math.max(maxMem, tc.memoryUsed);
          if (tc.status !== 'accepted') allPassed = false;
        }
        groupResults[group.id] = {
          score: allPassed ? score : 0,
          status: allSkipped ? 'skipped' : (allPassed ? 'accepted' : aggregateFailureStatus(groupTCs)),
          time: maxTime,
          memory: maxMem,
          maxScore: group.score
        };
      }

      // Keep individual test case scores for display
      // Final score is calculated from group results, not individual test case scores

      completedGroups.add(group.id);
      madeProgress = true;
    }

    if (!madeProgress) break;
  }

  for (const gid of pendingGroups) {
    groupResults[gid] = { score: 0, status: 'system_error', time: 0, memory: 0, maxScore: 0 };
  }

  const hasProblemScript = problem.scoring_script && problem.scoring_script.trim();

  // 未分组测试点（group_id 为空 → key 0）不属于任何 test_group，上面的遍历覆盖不到，
  // 必须单独归并，否则它们被实际执行了却不参与总分与状态判定。
  const ungroupedTCs = tcsByGroup[0] || [];
  let ungroupedResult = null;
  if (ungroupedTCs.length > 0) {
    const passed = ungroupedTCs.filter(t => t.status === 'accepted');
    const allUngroupedPassed = passed.length === ungroupedTCs.length;
    ungroupedResult = {
      score: allUngroupedPassed
        ? ungroupedTCs.reduce((s, t) => s + t.score, 0)
        : passed.reduce((s, t) => s + t.score, 0),
      status: allUngroupedPassed ? 'accepted' : aggregateFailureStatus(ungroupedTCs),
      time: ungroupedTCs.reduce((m, t) => Math.max(m, t.timeUsed), 0),
      memory: ungroupedTCs.reduce((m, t) => Math.max(m, t.memoryUsed), 0)
    };
  }

  if (hasProblemScript) {
    const context = {};
    for (const [gid, gr] of Object.entries(groupResults)) {
      context[`@status${gid}`] = statusToConstant(gr.status);
      context[`@score${gid}`] = gr.score;
      context[`@time${gid}`] = gr.time;
      context[`@memory${gid}`] = gr.memory;
    }
    // 未分组测试点以 0 号"组"暴露（test_groups.id 从 1 自增，不会冲突）
    if (ungroupedResult) {
      context['@status0'] = statusToConstant(ungroupedResult.status);
      context['@score0'] = ungroupedResult.score;
      context['@time0'] = ungroupedResult.time;
      context['@memory0'] = ungroupedResult.memory;
    }
    context['@total_score'] = 0;
    context['@final_status'] = 2;
    context['@final_time'] = 0;
    context['@final_memory'] = 0;

    const result = runScoringScript(problem.scoring_script, context);
    return { score: result.total_score, status: result.final_status, time: result.final_time, memory: result.final_memory };
  }

  const allResults = Object.values(groupResults);
  if (ungroupedResult) allResults.push(ungroupedResult);

  let totalScore = 0, maxTime = 0, maxMem = 0, allPassed = true;
  for (const gr of allResults) {
    totalScore += gr.score;
    maxTime = Math.max(maxTime, gr.time);
    maxMem = Math.max(maxMem, gr.memory);
    if (gr.status !== 'accepted') allPassed = false;
  }

  return {
    score: totalScore,
    status: allPassed ? 'accepted' : aggregateFailureStatus(allResults),
    time: maxTime,
    memory: maxMem
  };
}

module.exports = { evaluateSimple, evaluateWithGroups, topoSortGroups };
