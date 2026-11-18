// routes/homeworks/index.js —— 作业域路由组装
const express = require('express');
const repo = require('../../repositories/homeworks');
const { makeVisibilityRouter } = require('../_visibility');

const crud = require('./crud');
const answers = require('./answers');
const report = require('./report');

const router = express.Router();

// 实体可见性（用户组维度）：GET/PUT /:id/visibility
router.use(makeVisibilityRouter({
  resourceType: 'homework',
  tableName: 'homeworks',
  findResource: repo.getHomework,
  setVisibility: repo.setVisibility
}));

router.use(crud);
router.use(answers);
router.use(report);

module.exports = router;
