const express = require('express');
const os = require('os');
const fs = require('fs');
const statusRepo = require('../repositories/status');
const config = require('../config/config');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const BOOT_TIME = Date.now();
const START_MEM = process.memoryUsage().rss;

// 功能16：系统运行状态仪表盘（admin+）
// GET /api/v1/system/status
router.get('/status', requireAuth, (req, res) => {
  if (!['admin', 'su'].includes(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '仅管理员可查看系统状态。' });
  }

  const uptimeMs = Date.now() - BOOT_TIME;
  const mem = process.memoryUsage();
  const dbSize = (() => {
    try { return fs.statSync(config.database.path).size; } catch { return 0; }
  })();

  const counts = statusRepo.getSystemCounts();

  // 判题队列：最近处理中的提交
  const queue = statusRepo.getJudgeQueue();

  const today = new Date().toISOString().slice(0, 10);
  const todayStats = statusRepo.getTodayStats(today);

  res.json({
    ok: true,
    ts: Date.now(),
    uptime_ms: uptimeMs,
    started_at: new Date(BOOT_TIME).toISOString(),
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.arch()} (${os.release()})`,
    cpu_cores: os.cpus().length,
    cpu_model: os.cpus()[0]?.model || '',
    loadavg: os.loadavg(),
    totalmem: os.totalmem(),
    freemem: os.freemem(),
    memory: {
      rss: mem.rss,
      heap_total: mem.heapTotal,
      heap_used: mem.heapUsed,
      start_rss: START_MEM
    },
    node: process.version,
    db_size: dbSize,
    counts,
    today_stats: {
      submits: todayStats.today_submits,
      accepted: todayStats.today_ac,
      new_users: todayStats.today_users
    },
    queue
  });
});

module.exports = router;