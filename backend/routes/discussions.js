const express = require('express');
const discussionsRepo = require('../repositories/discussions');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const { isAdminOrSu } = require('../utils/roles');
const { buildUpdates } = require('../utils/db');
const { sanitizeText } = require('../utils/securityHelpers');

const { sendNotFound } = require('../utils/apiErrors');

const router = express.Router();

const MAX_TITLE_LENGTH = 200;
const MAX_CONTENT_LENGTH = 10000;

// 讨论详情（含回复，最多两层楼中楼）
router.get('/:id', optionalAuth, (req, res) => {
  const disc = discussionsRepo.getWithAuthor(req.params.id);
  if (!disc) {
    return sendNotFound(res, 'Discussion not found.');
  }
  // 比赛讨论锁定的处理
  if (disc.contest_id) {
    const contest = discussionsRepo.getContestMeta(disc.contest_id);
    if (contest) {
      // 10.3: 隐藏比赛相关讨论仅 staff 可见
      if (contest.is_hidden && (!req.user || !['admin', 'su', 'teacher'].includes(req.user.role))) {
        return sendNotFound(res, 'Discussion not found.');
      }
      if (new Date(contest.end_time).getTime() > Date.now() && !disc.is_official) {
        // 比赛进行中且非官方公告，普通用户不可见
        if (!req.user || !['admin', 'su', 'teacher'].includes(req.user.role)) {
          return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '比赛进行中暂不开放讨论。' });
        }
      }
    }
  }
  // 一级回复（R9-10: 加 LIMIT 防全量物化撑爆内存）
  const replies = discussionsRepo.listTopReplies(disc.id);
  // 二级回复（R9-10: IN 占位符数量上限）
  const replyIds = replies.map(r => r.id).slice(0, 500);
  let children = [];
  if (replyIds.length > 0) {
    children = discussionsRepo.listChildReplies(replyIds);
  }
  // 组织树形结构: 用 Map 按 parent_id 分组，O(n) 而非 O(n*m)
  const childrenByParent = new Map();
  for (const c of children) {
    const list = childrenByParent.get(c.parent_id) || [];
    list.push(c);
    childrenByParent.set(c.parent_id, list);
  }
  const tree = replies.map(r => ({ ...r, children: childrenByParent.get(r.id) || [] }));
  res.json({ ...disc, replies: tree });
});

// 创建讨论（登录用户）
router.post('/', requireAuth, (req, res) => {
  const { problem_id, contest_id, title, content } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Title is required.' });
  }
  if (String(title).length > MAX_TITLE_LENGTH) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `Title must be at most ${MAX_TITLE_LENGTH} characters.` });
  }
  if (!content || !content.trim()) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Content is required.' });
  }
  if (String(content).length > MAX_CONTENT_LENGTH) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `Content must be at most ${MAX_CONTENT_LENGTH} characters.` });
  }
  if (!problem_id && !contest_id) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'problem_id or contest_id is required.' });
  }
  // D-L10: 校验关联实体存在，避免 FK 500
  if (problem_id && !discussionsRepo.problemExists(problem_id)) {
    return sendNotFound(res, 'Problem not found.');
  }
  if (contest_id && !discussionsRepo.contestExists(contest_id)) {
    return sendNotFound(res, 'Contest not found.');
  }
  // 10.3: 隐藏比赛不允许普通用户创建讨论
  if (contest_id) {
    const c = discussionsRepo.getContestHidden(contest_id);
    if (c && c.is_hidden && !['admin', 'su', 'teacher'].includes(req.user.role)) {
      return sendNotFound(res, 'Contest not found.');
    }
  }
  // 比赛进行中：禁止非官方讨论
  if (contest_id) {
    const contest = discussionsRepo.getContestEndTime(contest_id);
    if (contest && new Date(contest.end_time).getTime() > Date.now()) {
      if (!['admin', 'su', 'teacher'].includes(req.user.role)) {
        return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '比赛进行中暂不开放讨论。' });
      }
    }
  }
  const isOfficial = ['admin', 'su', 'teacher'].includes(req.user.role) ? (req.body.is_official ? 1 : 0) : 0;
  const result = discussionsRepo.insert(
    problem_id || null, contest_id || null, sanitizeText(title).trim(), sanitizeText(content).trim(), req.user.id, isOfficial
  );
  const disc = discussionsRepo.get(result.lastInsertRowid);
  res.status(201).json(disc);
});

// 更新讨论（作者或 admin）
router.put('/:id', requireAuth, (req, res) => {
  const disc = discussionsRepo.get(req.params.id);
  if (!disc) {
    return sendNotFound(res, 'Discussion not found.');
  }
  if (req.user.id !== disc.author_id && !isAdminOrSu(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot edit others\' discussions.' });
  }
  // 锁定后作者不得再改（与回复 PUT /:id 的处理保持一致），否则锁定形同虚设
  if (disc.locked && !['admin', 'su', 'teacher'].includes(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '讨论已被锁定' });
  }
  const { title, content } = req.body;
  if (title !== undefined && String(title).length > MAX_TITLE_LENGTH) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `Title must be at most ${MAX_TITLE_LENGTH} characters.` });
  }
  if (content !== undefined && String(content).length > MAX_CONTENT_LENGTH) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `Content must be at most ${MAX_CONTENT_LENGTH} characters.` });
  }
  const u = buildUpdates([
    { key: 'title', value: title !== undefined ? sanitizeText(title).trim() : undefined },
    { key: 'content', value: content !== undefined ? sanitizeText(content).trim() : undefined }
  ], { touchUpdatedAt: true });
  if (u.count === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  discussionsRepo.update(disc.id, u);
  const updated = discussionsRepo.get(disc.id);
  res.json(updated);
});

// 删除讨论（作者或 admin）
router.delete('/:id', requireAuth, (req, res) => {
  const disc = discussionsRepo.get(req.params.id);
  if (!disc) {
    return sendNotFound(res, 'Discussion not found.');
  }
  if (req.user.id !== disc.author_id && !isAdminOrSu(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot delete others\' discussions.' });
  }
  discussionsRepo.deleteReplies(disc.id);
  discussionsRepo.remove(disc.id);
  res.json({ message: 'Discussion deleted.' });
});

// 创建回复（登录用户）
router.post('/:id/replies', requireAuth, (req, res) => {
  const disc = discussionsRepo.get(req.params.id);
  if (!disc) {
    return sendNotFound(res, 'Discussion not found.');
  }
  if (disc.locked && !['admin', 'su', 'teacher'].includes(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '该讨论已锁定。' });
  }
  const { content, parent_id } = req.body;
  if (!content || !content.trim()) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Content is required.' });
  }
  if (String(content).length > MAX_CONTENT_LENGTH) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `Content must be at most ${MAX_CONTENT_LENGTH} characters.` });
  }
  // 限制最多两层楼中楼
  let parentId = null;
  if (parent_id) {
    const parent = discussionsRepo.getParentReply(parent_id, disc.id);
    if (!parent) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Parent reply not found.' });
    }
    if (parent.parent_id) {
      // 二级回复的回复，挂在原一级回复下
      parentId = parent.parent_id;
    } else {
      parentId = parent.id;
    }
  }
  const result = discussionsRepo.insertReply(
    disc.id, parentId, sanitizeText(content).trim(), req.user.id
  );
  const reply = discussionsRepo.getReplyWithAuthor(result.lastInsertRowid);
  res.status(201).json(reply);
});

// 删除回复（作者或 admin）
router.delete('/:id/replies/:rid', requireAuth, (req, res) => {
  const reply = discussionsRepo.getReply(req.params.rid, req.params.id);
  if (!reply) {
    return sendNotFound(res, 'Reply not found.');
  }
  if (req.user.id !== reply.author_id && !isAdminOrSu(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot delete others\' replies.' });
  }
  // 级联删除该回复的所有直接子回复
  discussionsRepo.deleteReplyChildren(reply.id);
  discussionsRepo.deleteReply(reply.id);
  res.json({ message: 'Reply deleted.' });
});

// 置顶/取消置顶（admin/teacher）
router.put('/:id/pin', requireAuth, requireRole('teacher'), (req, res) => {
  const disc = discussionsRepo.get(req.params.id);
  if (!disc) {
    return sendNotFound(res, 'Discussion not found.');
  }
  const pinned = req.body.pinned ? 1 : 0;
  discussionsRepo.setPinned(disc.id, pinned);
  const updated = discussionsRepo.get(disc.id);
  res.json(updated);
});

// 锁定/解锁（admin/teacher）
router.put('/:id/lock', requireAuth, requireRole('teacher'), (req, res) => {
  const disc = discussionsRepo.get(req.params.id);
  if (!disc) {
    return sendNotFound(res, 'Discussion not found.');
  }
  const locked = req.body.locked ? 1 : 0;
  discussionsRepo.setLocked(disc.id, locked);
  const updated = discussionsRepo.get(disc.id);
  res.json(updated);
});

// 设置/取消官方标记（admin/teacher）
router.put('/:id/official', requireAuth, requireRole('teacher'), (req, res) => {
  const disc = discussionsRepo.get(req.params.id);
  if (!disc) {
    return sendNotFound(res, 'Discussion not found.');
  }
  const is_official = req.body.is_official ? 1 : 0;
  discussionsRepo.setOfficial(disc.id, is_official);
  const updated = discussionsRepo.get(disc.id);
  res.json(updated);
});

module.exports = router;
