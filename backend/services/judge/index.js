// services/judge/index.js —— 判题服务门面：
// 调用方（server.js / routes/submissions / test/*）统一 require('../services/judge')，
// 内部按职责拆分为 compare / scoring / runner / pipeline / queue 五个模块。
const { judgeSubmission } = require('./pipeline');
const { enqueueSubmission, recoverInterruptedSubmissions } = require('./queue');
const { compareOutput, compareOutputEx } = require('./compare');

module.exports = { judgeSubmission, enqueueSubmission, compareOutput, compareOutputEx, recoverInterruptedSubmissions };
