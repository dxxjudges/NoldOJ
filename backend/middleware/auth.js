const jwt = require('jsonwebtoken');
const config = require('../config/config');
const db = require('../database/db');
const { ROLE_HIERARCHY } = require('../utils/roles');
const patRepo = require('../repositories/personalTokens');
const { isPatToken, verifyHash, parseScopes, PAT_PREFIX_LEN } = require('../utils/personalTokens');

// JWT / 私人令牌统一鉴权中间件

const USER_FIELDS = 'id, username, nickname, role, banned, force_logout_at, submit_lock_exempt';

function authError(status, code, reason, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.reason = reason;
  return err;
}

function sendAuthError(res, err) {
  return res.status(err.status || 401).json({
    code: err.code || 5,
    reason: err.reason || 'ERR_UNAUTHORIZED',
    message: err.message
  });
}

function getBannedMessage() {
  return 'Account has been banned.';
}

function resolveJwt(token) {
  const payload = jwt.verify(token, config.jwt.accessSecret, { algorithms: ['HS256'] });
  const user = db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(payload.userId);
  if (!user) {
    throw authError(401, 5, 'ERR_UNAUTHORIZED', 'User not found.');
  }
  if (user.banned) {
    throw authError(403, 6, 'ERR_FORBIDDEN', getBannedMessage());
  }
  if (user.force_logout_at && payload.iat) {
    const forceTime = Math.floor(new Date(user.force_logout_at + 'Z').getTime() / 1000);
    if (payload.iat < forceTime) {
      throw authError(401, 5, 'ERR_UNAUTHORIZED', 'You have been logged out.');
    }
  }
  return { user, authType: 'jwt', scopes: null };
}

function resolvePat(token) {
  const candidates = patRepo.findByPrefix(token.slice(0, PAT_PREFIX_LEN));
  for (const row of candidates) {
    if (!verifyHash(token, row.token_hash)) continue;
    if (row.expires_at) {
      const expiresMs = Date.parse(`${row.expires_at.replace(' ', 'T')}Z`);
      if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
        throw authError(401, 5, 'ERR_UNAUTHORIZED', 'Token has expired.');
      }
    }
    const user = db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(row.user_id);
    if (!user) {
      throw authError(401, 5, 'ERR_UNAUTHORIZED', 'User not found.');
    }
    if (user.banned) {
      throw authError(403, 6, 'ERR_FORBIDDEN', getBannedMessage());
    }
    patRepo.touchLastUsed(row.id); // 内部按 60 秒节流，避免每请求同步写库
    const scopes = parseScopes(row.scopes);
    return {
      user,
      authType: 'pat',
      scopes,
      tokenId: row.id,
      patToken: {
        id: row.id,
        name: row.name,
        prefix: row.token_prefix,
        scopes,
        expires_at: row.expires_at || null,
        permanent: !row.expires_at,
        last_used_at: row.last_used_at || null,
        created_at: row.created_at
      }
    };
  }
  throw authError(401, 5, 'ERR_UNAUTHORIZED', 'Invalid or expired token.');
}

function authenticate(token) {
  return isPatToken(token) ? resolvePat(token) : resolveJwt(token);
}

// 请求的规范化完整路径（baseUrl + path，去掉尾部斜杠）
function requestPath(req) {
  return `${req.baseUrl || ''}${req.path || ''}`.replace(/\/+$/, '') || '/';
}

// 私人令牌的权限判定：null=无需限制；'forbidden'=禁止 PAT 访问；其余为所需 scope
function requiredPatScope(req) {
  const full = requestPath(req);
  const method = req.method.toUpperCase();

  // 凭据自检接口无需任何 scope：任何有效令牌都可以查询自己
  if (full === '/api/v1/auth/tokeninfo') return null;

  // 凭证签发/管理类接口一律只允许登录会话，防止 PAT 自我提权或换出 JWT
  if (full === '/api/v1/users/me/tokens' || full.startsWith('/api/v1/users/me/tokens/')) return 'forbidden';
  if (full === '/api/v1/auth/change-password') return 'forbidden';
  if (full === '/api/v1/users/sudo-login') return 'forbidden';
  if (/^\/api\/v1\/users\/\d+\/reset-password$/.test(full)) return 'forbidden';

  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return 'read';
  // 本人账户相关的写操作统一归入 account（令牌管理已在上面按 forbidden 拦截）
  if (full === '/api/v1/users/me' || full.startsWith('/api/v1/users/me/')) return 'account';
  if (method === 'POST' && full === '/api/v1/submissions') return 'submit';
  if (/^\/api\/v1\/ide(\/|$)/.test(full) && method !== 'GET') return 'submit';
  if (method === 'POST' && /^\/api\/v1\/exams\/\d+\/submit$/.test(full)) return 'submit';
  return 'write';
}

function denyPat(req, res, auth) {
  const needed = requiredPatScope(req);
  if (needed === 'forbidden') {
    res.status(403).json({
      code: 6,
      reason: 'ERR_FORBIDDEN',
      message: 'This endpoint requires a login session; personal access tokens cannot be used here.'
    });
    return true;
  }
  if (needed && !auth.scopes.includes(needed)) {
    res.status(403).json({
      code: 6,
      reason: 'ERR_FORBIDDEN',
      message: `Token missing required scope: ${needed}.`
    });
    return true;
  }
  return false;
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ code: 5, reason: 'ERR_UNAUTHORIZED', message: 'Missing or invalid authorization header.' });
  }
  const token = authHeader.slice(7);
  let auth;
  try {
    auth = authenticate(token);
  } catch (err) {
    return sendAuthError(res, err);
  }
  if (auth.authType === 'pat' && denyPat(req, res, auth)) return;
  req.user = auth.user;
  req.authType = auth.authType;
  req.patScopes = auth.scopes;
  req.patToken = auth.patToken || null;
  next();
}

function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }
  const token = authHeader.slice(7);
  try {
    const auth = authenticate(token);
    // PAT 在公开/可选鉴权路由上权限不足时退化为匿名，而不是报错
    if (auth.authType === 'pat') {
      const needed = requiredPatScope(req);
      if (needed === 'forbidden' || (needed && !auth.scopes.includes(needed))) {
        req.user = null;
        req.authType = null;
        req.patScopes = null;
        req.patToken = null;
        return next();
      }
    }
    req.user = auth.user;
    req.authType = auth.authType;
    req.patScopes = auth.scopes;
    req.patToken = auth.patToken || null;
  } catch {
    req.user = null;
    req.authType = null;
    req.patScopes = null;
    req.patToken = null;
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ code: 5, reason: 'ERR_UNAUTHORIZED', message: 'Authentication required.' });
    }
    // 要求同时满足所有传入角色（取其中最低门槛），user 满足所有额外要求
    const levels = roles.map(r => ROLE_HIERARCHY.indexOf(r)).filter(i => i >= 0);
    if (levels.length === 0) return next();
    const minLevel = Math.min(...levels);
    const userLevel = ROLE_HIERARCHY.indexOf(req.user.role);
    if (userLevel < minLevel) {
      return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Insufficient permissions.' });
    }
    next();
  };
}

module.exports = { requireAuth, optionalAuth, requireRole };
