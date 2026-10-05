// routes/exams/questions.js —— 试题负载解析与归一化（编程题 ZIP/inline 测试数据）
// 只做校验/归一化，不落库；失败抛 Error（由调用方转 400）
const AdmZip = require('adm-zip');
const { sanitizeText } = require('../../utils/securityHelpers');
const repo = require('../../repositories/exams');
const { clampInt } = require('./helpers');

// 编程题测试数据上限（防滥用：单点 512KB、总数 500、ZIP base64 7MB）
const MAX_TC_CHARS = 512 * 1024;
const MAX_TC_COUNT = 500;
const MAX_ZIP_B64_CHARS = Math.ceil(7 * 1024 * 1024 * 4 / 3) + 4;

// 解析编程题测试数据：inline 数组与 ZIP base64（*.in + *.out/*.ans，允许一层子目录=subtask）合并返回
function parseProgramTestcases(p) {
  const cases = [];
  if (Array.isArray(p.testcases)) {
    for (const tc of p.testcases) {
      if (!tc || typeof tc !== 'object') continue;
      const input = String(tc.input ?? '');
      const output = String(tc.output ?? '');
      if (input.length > MAX_TC_CHARS || output.length > MAX_TC_CHARS) {
        throw new Error('单个测试点输入/输出不能超过 512KB。');
      }
      cases.push({
        input,
        output,
        score: Math.max(0, Number(tc.score) || 0),
        subtask: tc.subtask ? String(tc.subtask).replace(/[<>:"/\\|?*]/g, '_').slice(0, 64) : ''
      });
    }
  }
  if (p.testcase_zip_base64) {
    const b64 = String(p.testcase_zip_base64);
    if (b64.length > MAX_ZIP_B64_CHARS) {
      throw new Error('测试数据 ZIP 过大（base64 上限约 7MB）。');
    }
    const zip = new AdmZip(Buffer.from(b64, 'base64'));
    const entries = zip.getEntries();
    if (entries.length > 1000) throw new Error('ZIP 条目过多（上限 1000）。');
    let totalBytes = 0;
    const pairs = {};
    const addPair = (name, ext, data, subtask) => {
      const key = subtask + '|' + name;
      if (!pairs[key]) pairs[key] = { subtask, name, input: '', output: '' };
      if (ext === 'in') pairs[key].input = data;
      else pairs[key].output = data;
    };
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      totalBytes += entry.header.size;
      if (totalBytes > 32 * 1024 * 1024) throw new Error('ZIP 解压后总大小超过 32MB。');
      const entryPath = entry.entryName.replace(/\\/g, '/');
      const parts = entryPath.split('/').filter(Boolean);
      if (parts.length === 0 || parts.length > 2) continue;
      // Zip Slip / 脏文件名防御（与题库 testdata-zip 同款）
      if (parts.some(s => s === '..' || s === '.') || !parts.every(s => /^[\w.\-\u4e00-\u9fa5]+$/.test(s))) continue;
      const fileName = parts[parts.length - 1];
      const m = fileName.match(/^(.+)\.(in|out|ans)$/i);
      if (!m) continue;
      const subtask = parts.length === 2 ? parts[0].slice(0, 64) : '';
      const ext = m[2].toLowerCase() === 'in' ? 'in' : 'out';
      let data;
      try { data = entry.getData().toString('utf8'); } catch { continue; }
      if (data.length > MAX_TC_CHARS) throw new Error(`ZIP 内 ${fileName} 超过 512KB。`);
      addPair(m[1].replace(/^\.+/, ''), ext, data, subtask);
    }
    for (const pair of Object.values(pairs)) {
      if (!pair.input && !pair.output) continue;
      cases.push({ input: pair.input, output: pair.output, score: 1, subtask: pair.subtask });
    }
  }
  return cases;
}

// 校验并归一化 program 题目负载（不落库）；失败抛 Error（由调用方转 400）
function normalizeProgramQuestion(q) {
  const p = q.problem;
  if (!p || typeof p !== 'object') {
    throw new Error('编程题缺少 problem 配置。');
  }
  const testcases = parseProgramTestcases(p);
  if (testcases.length === 0) {
    throw new Error('编程题至少需要 1 个测试点（inline 输入输出对或 ZIP 上传）。');
  }
  if (testcases.length > MAX_TC_COUNT) {
    throw new Error(`测试点数量不能超过 ${MAX_TC_COUNT}。`);
  }
  const langs = repo.enabledLanguageNames();
  const allowed = (Array.isArray(p.allowed_languages) ? p.allowed_languages : [])
    .filter(l => typeof l === 'string' && langs.has(l)).slice(0, 20);
  return {
    question_type: 'program',
    title: sanitizeText(q.title || ''),
    score: Math.max(0, Number(q.score) || 0),
    sort_order: q.sort_order,
    problem_id: q.problem_id ? Number(q.problem_id) : null,
    problem: {
      description: sanitizeText(p.description || ''),
      background: sanitizeText(p.background || ''),
      input_desc: sanitizeText(p.input_desc || ''),
      output_desc: sanitizeText(p.output_desc || ''),
      hint: sanitizeText(p.hint || ''),
      time_limit: clampInt(p.time_limit, 1, 10000, 1000),
      memory_limit: clampInt(p.memory_limit, 1, 1024, 256),
      allowed_languages: JSON.stringify(allowed)
    },
    testcases
  };
}

module.exports = { parseProgramTestcases, normalizeProgramQuestion };
