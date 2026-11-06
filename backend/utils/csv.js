// utils/csv.js —— CSV 导出（成绩单/排行榜）
// 统一处理转义、UTF-8 BOM（Excel 打开中文不乱码）、下载响应头（含中文文件名）。

function escapeCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  // CSV 注入防护：以 = + - @ 等开头的单元格会被 Excel 当公式执行，前置单引号转义
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function toCsv(rows) {
  return rows.map(row => row.map(escapeCell).join(',')).join('\r\n');
}

// filename 为中文/原始文件名；ASCII 回退名用于不支持 filename* 的旧客户端
function sendCsv(res, filename, rows) {
  const body = '\uFEFF' + toCsv(rows) + '\r\n';
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '') || 'export.csv';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  res.send(body);
}

module.exports = { escapeCell, toCsv, sendCsv };
