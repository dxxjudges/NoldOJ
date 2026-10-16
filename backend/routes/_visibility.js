// routes/_visibility.js —— 实体可见性（用户组维度）子路由工厂 + 门禁助手
// 四类实体（题目/比赛/试卷/题单）共用同一套读写语义，工厂化避免四份重复实现：
//   GET /:id/visibility  requireAuth —— 任何登录用户可读（管理台回填可见范围）
//   PUT /:id/visibility  requireAuth —— 仅管理员（canManageVisibility：admin/su）可写
// 判定语义（public/groups/staff 放行）全部来自 utils/access.js，本文件只做参数校验与编排。
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { isStaff } = require('../utils/roles');
const { canViewResource, canManageVisibility, visibilitySqlCondition } = require('../utils/access');
const { RESOURCE_TABLES, getResourceGroups, setResourceGroups } = require('../repositories/resourceAccess');
const { getGroup } = require('../repositories/groups');
const { sendNotFound, sendForbidden } = require('../utils/apiErrors');

// 实体类型 → 主表别名：各实体路由的 SQL 里实体表就用这些别名，可见性条件按同一别名生成，
// 路由层拼 where 时直接 `AND (${sql})`，避免出现两处别名写法。
const RESOURCE_ALIAS = {
  problem: 'p',
  contest: 'c',
  exam: 'e',
  problem_set: 'ps'
};

// 实体类型 → 英文名词/404 文案：403 文案前端会原样 toast，必须是英文短句
const RESOURCE_NOUN = {
  problem: 'problem',
  contest: 'contest',
  exam: 'exam',
  problem_set: 'problem set'
};

function visibilityNotFoundMessage(resourceType) {
  const noun = RESOURCE_NOUN[resourceType] || resourceType;
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} not found.`;
}

function visibilityDeniedMessage(resourceType) {
  return `You do not have permission to view this ${RESOURCE_NOUN[resourceType] || resourceType}.`;
}

// 单实体可见性（详情类路由统一用它做门禁判定；teacher/admin/su 由 utils/access.js 放行）
function canView(req, resourceType, resourceId) {
  return canViewResource(req.user, resourceType, resourceId);
}

// 列表类路由的可见性过滤条件：{ sql, params }；staff 时 sql 为空串（调用方跳过追加）
function visibilityFilterFor(req, resourceType) {
  return visibilitySqlCondition(resourceType, RESOURCE_ALIAS[resourceType], {
    userId: req.user ? req.user.id : null,
    staff: !!(req.user && isStaff(req.user.role))
  });
}

// 可见性子路由工厂。findResource / setVisibility 由各实体传入（取自对应仓储，
// db.prepare 不落在路由层）；tableName 用于装配期自检，避免把 problem 的读写接到 exams 表上。
function makeVisibilityRouter({ resourceType, tableName, findResource, setVisibility }) {
  if (!RESOURCE_TABLES[resourceType]) {
    throw new Error(`未知的资源类型 "${resourceType}"`);
  }
  if (tableName !== RESOURCE_TABLES[resourceType]) {
    throw new Error(`可见性子路由表名不匹配: ${resourceType} → ${tableName}`);
  }
  if (typeof findResource !== 'function' || typeof setVisibility !== 'function') {
    throw new Error(`makeVisibilityRouter 需要 findResource 与 setVisibility: ${resourceType}`);
  }

  const router = express.Router();

  router.get('/:id/visibility', requireAuth, (req, res) => {
    const resource = findResource(req.params.id);
    if (!resource) {
      return sendNotFound(res, visibilityNotFoundMessage(resourceType));
    }
    res.json({
      visibility: resource.visibility || 'public',
      groups: getResourceGroups(resourceType, resource.id)
    });
  });

  router.put('/:id/visibility', requireAuth, (req, res) => {
    // 先判角色再看实体存在性：非管理员一律 403，不借错误码探测实体是否存在
    if (!canManageVisibility(req.user)) {
      return sendForbidden(res, 'Only administrators can change visibility.');
    }
    const resource = findResource(req.params.id);
    if (!resource) {
      return sendNotFound(res, visibilityNotFoundMessage(resourceType));
    }

    const { visibility, group_ids } = req.body || {};
    if (visibility !== 'public' && visibility !== 'groups') {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: "visibility must be 'public' or 'groups'." });
    }

    const groupIds = [];
    if (visibility === 'groups') {
      if (!Array.isArray(group_ids) || group_ids.length === 0) {
        return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'group_ids is required when visibility is groups.' });
      }
      for (const raw of group_ids) {
        const gid = Number(raw);
        if (!Number.isInteger(gid) || gid <= 0) {
          return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'group_ids must be an array of group ids.' });
        }
        if (!getGroup(gid)) {
          // 不静默丢弃：前端勾了却没生效会得到"看似收窄实则仍公开"的实体
          return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `Group ${gid} not found.` });
        }
        if (!groupIds.includes(gid)) groupIds.push(gid);
      }
    }

    // 先清绑定再改可见性：中途失败只会让实体更严格（可见组更少），不会意外放开可见范围
    const groups = setResourceGroups(resourceType, resource.id, groupIds);
    setVisibility(resource.id, visibility);
    res.json({ visibility, groups });
  });

  return router;
}

module.exports = {
  RESOURCE_ALIAS, RESOURCE_NOUN,
  makeVisibilityRouter, visibilityFilterFor, visibilityNotFoundMessage, visibilityDeniedMessage, canView
};