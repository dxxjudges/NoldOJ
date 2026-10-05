// routes/exams/index.js —— 试卷域路由组装（原 routes/exams.js 拆分后的入口）
// module.exports 保持为单个 express Router（server.js 与测试均按 require('../routes/exams') 取用）
const express = require('express');

const crud = require('./crud');
const leaderboard = require('./leaderboard');
const submissions = require('./submissions');
const grading = require('./grading');

const router = express.Router();

// 各分组内部路由注册顺序与原文件一致；分组间不存在同 method+path 的路由，挂载顺序不影响匹配
router.use(crud);
router.use(leaderboard);
router.use(submissions);
router.use(grading);

module.exports = router;
