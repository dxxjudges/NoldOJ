// routes/problems/helpers.js —— 题目路由共用纯函数与上传实例（不碰 db）
const fs = require('fs');
const path = require('path');
const multer = require('multer');

// R9-5: testdata 的 multer 临时文件不能落到公开匿名可读的 /uploads 目录
// （崩溃残留会匿名泄露测试数据/源码 ZIP），改用独立非公开临时目录，
// 由 server.js 启动时统一清理。
const tmpUploadDir = path.join(__dirname, '../../../data/tmp-uploads');
fs.mkdirSync(tmpUploadDir, { recursive: true });
const upload = multer({ dest: tmpUploadDir, limits: { fileSize: 200 * 1024 * 1024 } });

// 纵深防御: 断言文件路径必须位于 baseDir 之内（ZIP 导入写入前调用）
function assertInsideProblemDir(baseDir, filePath) {
  const base = path.resolve(baseDir) + path.sep;
  if (!path.resolve(filePath).startsWith(base)) {
    throw new Error(`ZIP entry escapes problem directory: ${filePath}`);
  }
}

// R12-1: 多样例读写 helpers ─────────────────────────────
// 规范化客户端传入的 samples 数组; 非法结构返回 null(调用方决定报错/忽略)
function normalizeSamples(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') return null;
    const input = typeof s.input === 'string' ? s.input : '';
    const output = typeof s.output === 'string' ? s.output : '';
    const note = typeof s.note === 'string' ? s.note.slice(0, 500) : '';
    if (input.length > 65536 || output.length > 65536) return null;
    out.push({ input, output, note });
  }
  return out;
}

// real_number_tolerance 只接受 {absolute, relative} 且为有限非负数。
// 原先请求体原样 JSON.stringify 落库：compareRealNumber 用
//   if (absErr > tolerance.absolute && relErr > tolerance.relative) return false;
// 传入 1e300 这类超大容差会让两个条件恒假 → 任意答案全部判对（判题口径被静默放空）；
// 传负数/字符串/数组则会让整题恒判错。undefined → 返回 undefined（调用方用默认值）。
function normalizeTolerance(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const num = (v, dflt) => {
    if (v === undefined || v === null) return dflt;
    const n = Number(v);
    if (!isFinite(n) || n < 0 || n > 1e9) return NaN;
    return n;
  };
  const absolute = num(raw.absolute, 0.001);
  const relative = num(raw.relative, 0.001);
  if (!isFinite(absolute) || !isFinite(relative)) return null;
  return { absolute, relative };
}

// 公开脱敏视图: 移除 SPJ 脚本与评分脚本，防止泄露判题逻辑
function sanitizeProblem(p) {
  if (!p) return null;
  const result = { ...p };
  delete result.spj_code;
  delete result.scoring_script;
  return result;
}

// 安全读取 problems 目录内的文件（防路径穿越）
function safeReadFile(baseDir, fileName) {
  try {
    const fp = path.resolve(baseDir, fileName);
    const base = path.resolve(baseDir) + path.sep;
    if (!fp.startsWith(base)) return '';
    return fs.readFileSync(fp, 'utf8');
  } catch { return ''; }
}

module.exports = { upload, assertInsideProblemDir, normalizeSamples, normalizeTolerance, sanitizeProblem, safeReadFile };
