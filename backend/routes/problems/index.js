// routes/problems/index.js —— 题目域路由组装（原 routes/problems.js 拆分后的入口）
// module.exports 保持为单个 express Router（server.js 与测试均按 require('../routes/problems') 取用）
const express = require('express');

const list = require('./list');
const crud = require('./crud');
const testdata = require('./testdata');
const solutions = require('./solutions');
const extras = require('./extras');

const router = express.Router();

// 各分组内部路由注册顺序与原文件一致；分组间不存在同 method+path 的路由，挂载顺序不影响匹配
router.use(list);
router.use(crud);
router.use(testdata);
router.use(solutions);
router.use(extras);

module.exports = router;
