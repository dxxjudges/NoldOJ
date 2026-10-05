// 统一日志出口（审计 P2: 三套日志统一）。
// 输出格式与原 src/server.js 逐字一致: [ts] [LEVEL] [TAG] msg，底层走 console.log(stdout)。
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
// 默认 INFO（DEBUG 静默）；设 NoldOJ_DEBUG=1 时放开 DEBUG 级。
const CURRENT_LEVEL = LOG_LEVELS[process.env.NoldOJ_DEBUG === '1' ? 'DEBUG' : 'INFO'];

function ts() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function log(level, tag, ...args) {
  if (LOG_LEVELS[level] < CURRENT_LEVEL) return;
  const prefix = `[${ts()}] [${level}] [${tag}]`;
  console.log(prefix, ...args);
}

// 各级日志与 console.* 同构（可变参数），迁移裸 console 调用时输出分隔与底层一致。
function logInfo(tag, ...args) { log('INFO', tag, ...args); }
function logWarn(tag, ...args) { log('WARN', tag, ...args); }
function logError(tag, ...args) { log('ERROR', tag, ...args); }
function logDebug(tag, ...args) { log('DEBUG', tag, ...args); }

module.exports = { ts, log, logInfo, logWarn, logError, logDebug };
