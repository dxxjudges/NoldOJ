// utils/standings.js ——「每题最佳成绩排行榜」共享组装逻辑（纯函数：结果行 → 榜单结构，无路由/DB 依赖）
//
// 使用方（原三处各自维护一份雷同的榜单构建逻辑，已合并到本模块）：
//   1. routes/contests.js          GET /api/v1/contests/:id/leaderboard       —— 多人榜 + 封榜时间窗
//   2. routes/virtual-contests.js  GET /api/v1/virtual-contests/:id/ranking   —— 单人榜（只返回自己）
//   3. routes/exams/leaderboard.js GET /api/v1/exams/:id/leaderboard          —— 每人最佳一次交卷 + 封榜
//
// 三处差异（字段名、封榜行为、额外字段）由调用方传参保留，本模块不强行抹平：
//   - 封榜：比赛榜与考试榜都在 SQL 层截断提交（contests 拼时间窗、exams 走 utils/examWindow），
//     本模块只负责产出带封榜状态的榜单外壳占位（无数据时 leaderboard 为空）
//   - 每题明细只存在于比赛榜与虚拟榜（{ score, time_used, status }）；
//     考试榜按人取最佳一次整行（{ total_score, max_score, attempts, status, submitted_at }）
//   - SQL 查询仍留在各 repositories 中原样不动，这里只做「结果行 → 榜单结构」的 JS 组装

// 把一条提交并入「每题最佳成绩」映射：
// AC 优先 → 同 AC 比分数 → 同分数比用时，防止 AC 被同分更快的 WA 顶成 0 分
function applyBest(problems, s) {
  const cur = problems[s.problem_id];
  if (!cur) {
    problems[s.problem_id] = { score: s.score, time_used: s.time_used, status: s.status };
    return;
  }
  const curAc = cur.status === 'accepted';
  const newAc = s.status === 'accepted';
  if ((newAc && !curAc) ||
      (newAc === curAc && (s.score > cur.score || (s.score === cur.score && s.time_used < cur.time_used)))) {
    problems[s.problem_id] = { score: s.score, time_used: s.time_used, status: s.status };
  }
}

// 单个用户：submissions 聚合行 → problems[problem_id] = { score, time_used, status }（虚拟比赛榜用）
function buildProblemMap(rows) {
  const problems = {};
  for (const s of rows) {
    applyBest(problems, s);
  }
  return problems;
}

// 多个用户：按 user_id 分组（比赛榜用），每行含 user_id/username/nickname 与该用户的 problems 映射
function buildUserProblemMap(rows) {
  const userMap = {};
  for (const s of rows) {
    if (!userMap[s.user_id]) {
      userMap[s.user_id] = { user_id: s.user_id, username: s.username, nickname: s.nickname, total_score: 0, total_time: 0, problems: {} };
    }
    applyBest(userMap[s.user_id].problems, s);
  }
  return userMap;
}

// 总分/总用时只累计已 AC 的题目（未通过的题不计入名次）
function acceptedTotals(problems, problemIds) {
  let total_score = 0;
  let total_time = 0;
  for (const pid of problemIds) {
    const p = problems[pid];
    if (p && p.status === 'accepted') {
      total_score += p.score;
      total_time += p.time_used;
    }
  }
  return { total_score, total_time };
}

// 每人取最佳一次交卷记录：分数降序，同分先交卷者靠前（考试榜用）
function pickBestAttempts(rows) {
  const best = new Map();
  for (const r of rows) {
    const cur = best.get(r.user_id);
    if (!cur || r.total_score > cur.total_score ||
        (r.total_score === cur.total_score && String(r.submitted_at) < String(cur.submitted_at))) {
      best.set(r.user_id, r);
    }
  }
  return best;
}

// 榜单通用排序：总分降序，同分再走 tieBreak（比赛比用时升序，考试比交卷时间升序）
function compareByScore(a, b, tieBreak) {
  return (b.total_score - a.total_score) || (tieBreak ? tieBreak(a, b) : 0);
}

// 排序并统一补齐 rank（1 起）。入参不被改动，返回新数组 + 新对象
function buildStandings(entries, compare) {
  const sorted = compare ? [...entries].sort(compare) : [...entries];
  return sorted.map((e, i) => ({ ...e, rank: i + 1 }));
}

// 榜单外壳 { leaderboard, problem_ids, frozen?, freeze_at? }（contests 与 virtual-contests 共用）：
// 封榜占位（空榜 + 封榜状态）与正常响应共用同一形状；无封榜概念的调用方不传 frozen/freeze_at，
// 这两个键不会写入对象；exams 响应字段不同，外壳仍由其自行组装。
function standingsPayload({ leaderboard = [], problem_ids = [], frozen, freeze_at }) {
  const payload = { leaderboard, problem_ids };
  if (frozen !== undefined) payload.frozen = frozen;
  if (freeze_at !== undefined) payload.freeze_at = freeze_at;
  return payload;
}

module.exports = {
  buildProblemMap,
  buildUserProblemMap,
  acceptedTotals,
  pickBestAttempts,
  compareByScore,
  buildStandings,
  standingsPayload
};
