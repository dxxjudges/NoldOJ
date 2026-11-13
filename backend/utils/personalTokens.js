// 私人访问令牌工具：生成、摘要、校验、scope 规范化
const crypto = require('crypto');

const PAT_PREFIX = 'noldoj_pat_';
// 24 字节随机 -> base64url 恰好 32 字符
const PAT_RANDOM_BYTES = 24;
// 入库前缀：固定标识 + 13 位随机，用于索引定位候选行
const PAT_PREFIX_LEN = PAT_PREFIX.length + 13;
const SCOPES = ['read', 'submit', 'write', 'account'];
const MAX_TOKENS_PER_USER = 20;
const MAX_EXPIRES_DAYS = 3650;

function isPatToken(token) {
  return typeof token === 'string' && token.startsWith(PAT_PREFIX);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function generateToken() {
  const token = PAT_PREFIX + crypto.randomBytes(PAT_RANDOM_BYTES).toString('base64url');
  return { token, prefix: token.slice(0, PAT_PREFIX_LEN), hash: hashToken(token) };
}

// 摘要均为等长 hex，timingSafeEqual 前仍需校验长度避免抛错
function verifyHash(token, storedHash) {
  const actual = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(String(storedHash || ''), 'hex');
  if (actual.length !== expected.length || expected.length === 0) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// 返回去重后的合法 scope 数组；出现未知 scope 或一个都没选时返回 null
function normalizeScopes(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const raw of input) {
    const scope = String(raw ?? '').trim().toLowerCase();
    if (!SCOPES.includes(scope)) return null;
    if (!out.includes(scope)) out.push(scope);
  }
  return out.length > 0 ? out : null;
}

function parseScopes(json) {
  try {
    const value = JSON.parse(json || '[]');
    return Array.isArray(value) ? value.filter(s => SCOPES.includes(s)) : [];
  } catch {
    return [];
  }
}

function scopesToJson(scopes) {
  return JSON.stringify(scopes);
}

// 0 = 永久（返回 null）；否则返回 UTC 'YYYY-MM-DD HH:MM:SS'
function expiresAtFromDays(days) {
  if (days === 0) return null;
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

module.exports = {
  PAT_PREFIX,
  PAT_PREFIX_LEN,
  SCOPES,
  MAX_TOKENS_PER_USER,
  MAX_EXPIRES_DAYS,
  isPatToken,
  hashToken,
  generateToken,
  verifyHash,
  normalizeScopes,
  parseScopes,
  scopesToJson,
  expiresAtFromDays
};
