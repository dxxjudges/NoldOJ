// repositories/daily.js —— 每日一题数据访问层
// 每日题按 UTC 日期确定性选取：同一天全站同一题，无需人工排期。
const db = require('../database/db');

function hashDay(day) {
  let h = 2166136261;
  for (let i = 0; i < day.length; i++) {
    h ^= day.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// 只从「公开题」中选题：隐藏题/组内题/试卷内题一律排除，避免每日一题泄露不可见题目
function getOrCreate(day) {
  const existing = db.prepare('SELECT * FROM daily_problems WHERE day = ?').get(day);
  if (existing) return existing;
  const candidates = db.prepare(`
    SELECT id FROM problems
    WHERE is_public = 1 AND is_hidden = 0 AND exam_id IS NULL AND visibility = 'public'
    ORDER BY id
  `).all();
  if (candidates.length === 0) return null;
  const picked = candidates[hashDay(day) % candidates.length];
  db.prepare('INSERT OR IGNORE INTO daily_problems (day, problem_id) VALUES (?, ?)').run(day, picked.id);
  return db.prepare('SELECT * FROM daily_problems WHERE day = ?').get(day);
}

function getProblem(problemId) {
  return db.prepare('SELECT id, title, difficulty, time_limit, memory_limit FROM problems WHERE id = ?').get(problemId);
}

function hasAcceptedOnDay(userId, problemId, day) {
  return !!db.prepare(`
    SELECT 1 FROM submissions
    WHERE user_id = ? AND problem_id = ? AND exam_id IS NULL
      AND status = 'accepted' AND date(created_at) = ?
    LIMIT 1
  `).get(userId, problemId, day);
}

function isCheckedIn(userId, day) {
  return !!db.prepare('SELECT 1 FROM daily_checkins WHERE user_id = ? AND day = ?').get(userId, day);
}

function checkin(userId, day, problemId) {
  db.prepare('INSERT OR IGNORE INTO daily_checkins (user_id, day, problem_id) VALUES (?, ?, ?)').run(userId, day, problemId);
}

function prevDay(day) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// 连续打卡天数：从今天（或昨天，今日尚未打卡时）向前连续计数
function streak(userId, today) {
  const rows = db.prepare('SELECT day FROM daily_checkins WHERE user_id = ? ORDER BY day DESC LIMIT 400').all(userId);
  if (rows.length === 0) return 0;
  const latest = rows[0].day;
  const yesterday = prevDay(today);
  if (latest !== today && latest !== yesterday) return 0;
  let count = 1;
  let expected = latest;
  for (let i = 1; i < rows.length; i++) {
    expected = prevDay(expected);
    if (rows[i].day === expected) count++;
    else break;
  }
  return count;
}

module.exports = { getOrCreate, getProblem, hasAcceptedOnDay, isCheckedIn, checkin, streak, prevDay };
