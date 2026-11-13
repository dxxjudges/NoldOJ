// 私人访问令牌管理（仅允许登录会话，PAT 本身不得管理令牌）
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { createRateLimit } = require('../middleware/ratelimit');
const { sanitizeText } = require('../utils/securityHelpers');
const { sendNotFound } = require('../utils/apiErrors');
const repo = require('../repositories/personalTokens');
const {
  MAX_TOKENS_PER_USER,
  MAX_EXPIRES_DAYS,
  normalizeScopes,
  parseScopes,
  expiresAtFromDays
} = require('../utils/personalTokens');

const router = express.Router();

const createLimit = createRateLimit({
  windowMs: 3600000,
  max: 10,
  key: req => String(req.user?.id || '')
});

function requireJwtSession(req, res, next) {
  if (req.authType === 'pat') {
    return res.status(403).json({
      code: 6,
      reason: 'ERR_FORBIDDEN',
      message: 'This endpoint requires a login session; personal access tokens cannot be used here.'
    });
  }
  next();
}

router.use(requireAuth, requireJwtSession);

// 令牌列表：不返回摘要/明文
router.get('/', (req, res) => {
  const tokens = repo.listByUser(req.user.id).map(row => ({
    id: row.id,
    name: row.name,
    prefix: row.token_prefix,
    scopes: parseScopes(row.scopes),
    expires_at: row.expires_at || null,
    permanent: !row.expires_at,
    last_used_at: row.last_used_at || null,
    created_at: row.created_at
  }));
  res.json({ tokens });
});

router.post('/', createLimit, (req, res) => {
  const name = sanitizeText(String(req.body?.name ?? ''), 50).trim();
  if (!name) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '令牌名称不能为空。' });
  }

  const days = req.body?.expires_in_days === undefined ? 30 : req.body.expires_in_days;
  if (!Number.isInteger(days) || days < 0 || days > MAX_EXPIRES_DAYS) {
    return res.status(400).json({
      code: 1,
      reason: 'ERR_INVALID_ARGUMENT',
      message: `expires_in_days 必须是 0（永久）到 ${MAX_EXPIRES_DAYS} 之间的整数。`
    });
  }

  const scopes = normalizeScopes(req.body?.scopes);
  if (!scopes) {
    return res.status(400).json({
      code: 1,
      reason: 'ERR_INVALID_ARGUMENT',
      message: 'scopes 必须包含至少一个合法值：read / submit / write / account。'
    });
  }

  if (repo.countByUser(req.user.id) >= MAX_TOKENS_PER_USER) {
    return res.status(400).json({
      code: 1,
      reason: 'ERR_INVALID_ARGUMENT',
      message: `每人最多只能创建 ${MAX_TOKENS_PER_USER} 个令牌，请先吊销不再使用的令牌。`
    });
  }

  const expiresAt = expiresAtFromDays(days);
  const created = repo.create(req.user.id, name, scopes, expiresAt);
  const createdAt = new Date().toISOString().slice(0, 19).replace('T', ' ');

  // 明文只在此处返回一次，禁止缓存
  res.status(201).set('Cache-Control', 'no-store').json({
    id: created.id,
    name,
    token: created.token,
    prefix: created.prefix,
    scopes,
    expires_at: expiresAt,
    permanent: !expiresAt,
    created_at: createdAt
  });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '无效的令牌 ID。' });
  }
  const result = repo.revoke(id, req.user.id);
  if (result.changes === 0) {
    return sendNotFound(res, 'Token not found.');
  }
  res.json({ revoked: true, id });
});

module.exports = router;
