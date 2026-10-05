const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const usersRepo = require('../repositories/users');
const config = require('../config/config');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const { sanitizeLog, sanitizeText } = require('../utils/securityHelpers');
const { parsePageLimit } = require('../utils/pagination');
const { isValidRole, canManage, isAdminOrSu } = require('../utils/roles');
const { buildUpdates } = require('../utils/db');
const { generateAccessToken } = require('../utils/tokens');
const { isStrongPassword } = require('../utils/validation');

const { sendNotFound } = require('../utils/apiErrors');
const { logInfo } = require('../utils/logger');

const router = express.Router();

// 结构化审计日志: 记录敏感管理操作（操作者 → 目标），脱敏后输出
function audit(operator, action, target) {
  const t = target ? `${sanitizeLog(target.username)}(id=${target.id})` : 'n/a';
  logInfo('AUDIT', `${sanitizeLog(action)}: operator=${sanitizeLog(operator.username)}(id=${operator.id}) -> target=${t} at ${new Date().toISOString()}`);
}

// R12-3: 注册开关查询/热切换 (仅超管)。写在 /:id 之前避免被通配路由吞掉
router.get('/register-enabled', requireAuth, requireRole('su'), (req, res) => {
  res.json({ enabled: config.register.enabled });
});
router.put('/register-enabled', requireAuth, requireRole('su'), (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'enabled 必须为布尔值。' });
  }
  try {
    const content = '# 是否允许访客自行注册 (R12-3)\n# true = 开放注册 / false = 仅管理员创建账号\nREGISTER_ENABLED=' + (enabled ? 'true' : 'false') + '\n';
    fs.writeFileSync(config.register.path, content, 'utf8');
  } catch (err) {
    return res.status(500).json({ code: 2, reason: 'ERR_INTERNAL', message: '写入配置失败: ' + sanitizeLog(String(err.message || err)) });
  }
  config.register.enabled = enabled; // 热更新内存态
  audit(req.user, enabled ? '开启自行注册' : '关闭自行注册', null);
  res.json({ enabled });
});

// 公开排行榜。show_hidden=1 需要登录且 admin/su（optionalAuth 保持公开访问，同时对隐私分支显式认证）
router.get('/rating', optionalAuth, (req, res) => {
  const { page = 1, limit = 50, show_hidden = '' } = req.query;
  const { page: pageNum, limit: limitNum, offset } = parsePageLimit(page, limit, 50, 100);
  let where = 'WHERE hide_rating = 0';
  if (show_hidden === '1') {
    if (!req.user || !isAdminOrSu(req.user.role)) {
      return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'show_hidden requires admin or su role.' });
    }
    where = '';
  }
  const total = usersRepo.countUsers(where);
  const users = usersRepo.listRating(where, limitNum, offset);
  res.json({ total, page: pageNum, limit: limitNum, users });
});

// 公开用户资料 API（所有人可访问）
// 返回隐私开关，供前端决定是否展示成就/看板/收藏入口
router.get('/:id/profile', (req, res) => {
  // hide_rating 一并返回：与 hide_achievements / hide_dashboard / hide_favorites 一样，
  // 由前端据此决定是否展示 Rating（排行榜本身已过滤，个人页此前漏了这一项）
  const user = usersRepo.getProfile(req.params.id);
  if (!user) {
    return sendNotFound(res, 'User not found.');
  }
  res.json(user);
});

router.get('/me', requireAuth, (req, res) => {
  const user = usersRepo.getMe(req.user.id);
  res.json(user);
});

// 功能9：我的虚拟比赛列表
router.get('/me/virtual-contests', requireAuth, (req, res) => {
  const { myVirtualContests } = require('./virtual-contests');
  myVirtualContests(req, res);
});

router.put('/me', requireAuth, (req, res) => {
  const { nickname, signature, bio, hide_rating, hide_achievements, hide_dashboard, hide_favorites, preferred_language } = req.body;
  // 10.3: preferred_language 必须是已启用语言名之一，且限长，防止任意值/超长字符串入库
  if (preferred_language !== undefined && preferred_language !== null && preferred_language !== '') {
    const lang = String(preferred_language).slice(0, 32);
    const exists = usersRepo.findEnabledLanguage(lang);
    if (!exists) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'preferred_language 必须是已启用的语言。' });
    }
    if (preferred_language !== lang) req.body.preferred_language = lang;
  }
  const u = buildUpdates([
    { key: 'nickname', value: nickname, transform: v => sanitizeText(String(v ?? '').slice(0, 50)) },
    { key: 'signature', value: signature, transform: v => sanitizeText(String(v ?? '').slice(0, 1000)) },
    { key: 'bio', value: bio, transform: v => sanitizeText(String(v ?? '').slice(0, 100000)) },
    { key: 'hide_rating', value: hide_rating, transform: v => v ? 1 : 0 },
    { key: 'hide_achievements', value: hide_achievements, transform: v => v ? 1 : 0 },
    { key: 'hide_dashboard', value: hide_dashboard, transform: v => v ? 1 : 0 },
    { key: 'hide_favorites', value: hide_favorites, transform: v => v ? 1 : 0 },
    { key: 'preferred_language', value: req.body.preferred_language }
  ], { touchUpdatedAt: true });
  if (u.count === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  usersRepo.updateMe(req.user.id, u);
  const user = usersRepo.getMeSettings(req.user.id);
  res.json(user);
});

router.put('/:id/rating', requireAuth, requireRole('su'), (req, res) => {
  const { rating } = req.body;
  // D-L8: Number.isFinite 拦截 NaN/Infinity（typeof NaN === 'number'）
  if (typeof rating !== 'number' || !Number.isFinite(rating)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'rating must be a finite number.' });
  }
  const user = usersRepo.get(req.params.id);
  if (!user) {
    return sendNotFound(res, 'User not found.');
  }
  usersRepo.setRating(req.params.id, Math.round(rating));
  res.json({ message: 'Rating updated.', rating: Math.round(rating) });
});

router.put('/:id/hide-rating', requireAuth, requireRole('admin'), (req, res) => {
  const { hide_rating } = req.body;
  const target = usersRepo.get(req.params.id);
  if (!target) {
    return sendNotFound(res, 'User not found.');
  }
  if (!canManage(req.user, target)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot modify a user with equal or higher privileges (except yourself).' });
  }
  usersRepo.setHideRating(req.params.id, hide_rating ? 1 : 0);
  res.json({ message: 'Hide rating updated.', hide_rating: hide_rating ? 1 : 0 });
});

router.put('/:id/submit-lock-exempt', requireAuth, requireRole('su'), (req, res) => {
  const { submit_lock_exempt } = req.body;
  const target = usersRepo.get(req.params.id);
  if (!target) {
    return sendNotFound(res, 'User not found.');
  }
  usersRepo.setSubmitLockExempt(req.params.id, submit_lock_exempt ? 1 : 0);
  res.json({ message: 'Submit lock exempt updated.', submit_lock_exempt: submit_lock_exempt ? 1 : 0 });
});

router.put('/:id/upload-limits', requireAuth, requireRole('su'), (req, res) => {
  const { max_file_size, max_storage } = req.body;
  const target = usersRepo.get(req.params.id);
  if (!target) {
    return sendNotFound(res, 'User not found.');
  }
  const fileSize = (typeof max_file_size === 'number' && max_file_size >= 0) ? Math.floor(max_file_size) : 0;
  const storage = (typeof max_storage === 'number' && max_storage >= 0) ? Math.floor(max_storage) : 0;
  usersRepo.setUploadLimits(req.params.id, fileSize, storage);
  res.json({ message: 'Upload limits updated.', max_file_size: fileSize, max_storage: storage });
});

router.get('/', requireAuth, requireRole('admin'), (req, res) => {
  const { page = 1, limit = 50, search = '', role = '' } = req.query;
  const { page: pageNum, limit: limitNum, offset } = parsePageLimit(page, limit, 50, 100);
  let where = 'WHERE 1=1';
  const params = [];
  if (search) {
    // 转义 LIKE 通配符，防止 % _ \ 被当作模式匹配
    const esc = String(search).replace(/[\\%_]/g, m => `\\${m}`);
    where += ' AND (username LIKE ? ESCAPE ? OR nickname LIKE ? ESCAPE ?)';
    params.push(`%${esc}%`, '\\', `%${esc}%`, '\\');
  }
  if (role) {
    where += ' AND role = ?';
    params.push(role);
  }
  const total = usersRepo.countUsers(where, params);
  const users = usersRepo.listUsers(where, params, limitNum, offset);
  res.json({ total, page: pageNum, limit: limitNum, users });
});

router.get('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const user = usersRepo.getAdmin(req.params.id);
  if (!user) {
    return sendNotFound(res, 'User not found.');
  }
  res.json(user);
});

router.put('/:id/role', requireAuth, requireRole('su'), (req, res) => {
  const { role } = req.body;
  if (!isValidRole(role)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Invalid role.' });
  }
  const user = usersRepo.get(req.params.id);
  if (!user) {
    return sendNotFound(res, 'User not found.');
  }
  if (user.id === req.user.id) {
    return res.status(400).json({ code: 2, reason: 'ERR_INVALID_STATE', message: 'Cannot change your own role.' });
  }
  if (user.role === 'su' && role !== 'su') {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot demote another super administrator.' });
  }
  usersRepo.setRole(req.params.id, role);
  audit(req.user, 'change-role', { ...user, username: user.username, id: user.id });
  res.json({ message: 'Role updated.', user: { id: user.id, username: user.username, role } });
});

router.post('/:id/ban', requireAuth, requireRole('admin'), (req, res) => {
  const target = usersRepo.get(req.params.id);
  if (!target) {
    return sendNotFound(res, 'User not found.');
  }
  if (!canManage(req.user, target)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot ban a user with equal or higher privileges (except yourself).' });
  }
  usersRepo.ban(target.id);
  audit(req.user, 'ban', target);
  res.json({ message: 'User banned and logged out.' });
});

router.post('/:id/unban', requireAuth, requireRole('admin'), (req, res) => {
  const target = usersRepo.get(req.params.id);
  if (!target) {
    return sendNotFound(res, 'User not found.');
  }
  // 与 force-logout / ban 保持一致：管理员不得解封同级或更高权限的账号（su 账号）
  if (!canManage(req.user, target)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot unban a user with equal or higher privileges (except yourself).' });
  }
  usersRepo.unban(target.id);
  audit(req.user, 'unban', target);
  res.json({ message: 'User unbanned.' });
});

router.post('/:id/force-logout', requireAuth, requireRole('admin'), (req, res) => {
  const target = usersRepo.get(req.params.id);
  if (!target) {
    return sendNotFound(res, 'User not found.');
  }
  if (!canManage(req.user, target)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot force logout a user with equal or higher privileges (except yourself).' });
  }
  usersRepo.forceLogout(target.id);
  audit(req.user, 'force-logout', target);
  res.json({ message: 'User forced to logout.' });
});

router.post('/:id/reset-password', requireAuth, requireRole('su'), (req, res) => {
  const { new_password } = req.body;
  // 与注册/改密一致的强度要求: 至少 8 位，含字母，且含数字或符号；bcrypt 前 72 字节截断防御
  if (!isStrongPassword(new_password)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '密码至少 8 位，且须包含字母与数字或符号。' });
  }
  const user = usersRepo.get(req.params.id);
  if (!user) {
    return sendNotFound(res, 'User not found.');
  }
  const hash = bcrypt.hashSync(new_password, 10);
  usersRepo.resetPassword(req.params.id, hash);
  audit(req.user, 'reset-password', user);
  res.json({ message: 'Password reset successfully.' });
});

router.post('/sudo-login', requireAuth, requireRole('su'), (req, res) => {
  const { user_id } = req.body;
  if (!user_id) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'user_id is required.' });
  }
  const target = usersRepo.get(user_id);
  if (!target) {
    return sendNotFound(res, 'User not found.');
  }
  // 封禁用户不允许 sudo 登录，防止绕过封禁
  if (target.banned) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '该用户已被封禁，无法登录。' });
  }
  const token = generateAccessToken(target.id);
  audit(req.user, 'sudo-login', target);
  res.json({ access_token: token, user: { id: target.id, username: target.username, nickname: target.nickname, role: target.role } });
});

router.post('/', requireAuth, requireRole('su'), (req, res) => {
  const { username, password, nickname, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Username and password are required.' });
  }
  // 与注册接口一致的强度要求
  if (!isStrongPassword(password)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '密码至少 8 位，且须包含字母与数字或符号。' });
  }
  // 与注册接口一致的字符集限制
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Username may only contain letters, digits, underscore, dot and dash.' });
  }
  if (role && !isValidRole(role)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Invalid role.' });
  }
  const existing = usersRepo.findUserByUsername(username);
  if (existing) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Username already exists.' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const newId = usersRepo.createUser(username, hash, nickname || username, role || 'user');
  res.status(201).json({ message: 'User created.', user: { id: newId, username, role: role || 'user' } });
});

router.delete('/:id', requireAuth, requireRole('su'), (req, res) => {
  const target = usersRepo.get(req.params.id);
  if (!target) {
    return sendNotFound(res, 'User not found.');
  }
  // D-L7: 同级（su）不可互删，仅可管理严格低级别
  if (!canManage(req.user, target)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot delete a user with equal or higher privileges.' });
  }
  if (target.role === 'su') {
    const suCount = usersRepo.countSuperAdmins();
    if (suCount <= 1) {
      return res.status(400).json({ code: 2, reason: 'ERR_INVALID_STATE', message: 'Cannot delete the last super administrator.' });
    }
  }
  // R9-20: 先取待删文件清单（读操作留在路由层、位于事务之前）；磁盘删除挪到事务提交之后
  //（DB 原子性优先，单个文件删失败只留磁盘孤儿）
  const uploadDir = path.join(__dirname, '../../data/uploads');
  const files = usersRepo.listUserFiles(target.id);

  // 18 条连删的原子事务整体封装在 repositories/users.js 的 deleteUserCascade 中
  usersRepo.deleteUserCascade(target);

  for (const f of files) {
    try {
      const fp = path.resolve(uploadDir, path.basename(String(f.filename)));
      if (fp.startsWith(uploadDir) && fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch {
      // 磁盘清理尽力而为：事务已提交，失败仅留孤儿文件
    }
  }
  audit(req.user, 'delete-user', target);
  res.json({ message: 'User deleted.' });
});

module.exports = router;
