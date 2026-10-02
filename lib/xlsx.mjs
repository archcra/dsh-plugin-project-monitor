/**
 * 极简 OOXML(.xlsx) 读写器 —— 只依赖 lib/zip.mjs 与 Node 内置模块。
 *
 * 读：取某张工作表为「二维单元数组」，支持共享字符串、内联字符串、公式缓存值、
 *     布尔值，以及按单元格数字格式识别出的日期（还原为 `YYYY-MM-DD` 字符串）。
 * 写：从结构化行列生成合规工作簿，支持字体/填充/边框/数字格式（日期、百分比）。
 *
 * 之所以自己实现：仪表板必须能在任何 Node 环境跑起来，不引入第三方依赖。
 */
import { readZip, writeZip } from './zip.mjs';

/* ------------------------------------------------------------------ 错误 */

export class XlsxError extends Error {}

/* ------------------------------------------------------------ 日期序列号 */

const DAY_MS = 86400000;
// Excel 的 1900 日期系统：序列号 1 = 1900-01-01；含著名的 1900 闰年 bug，
// 因此以 1899-12-30 为原点可用纯数学覆盖 1900-03-01 之后的全部日期。
const EPOCH_UTC = Date.UTC(1899, 11, 30);

/** 日期串（YYYY-MM-DD 或 ISO）→ Excel 序列号。 */
export function dateToSerial(value) {
  const s = typeof value === 'string' ? value : formatDate(value);
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) throw new XlsxError(`无法解析日期: ${value}`);
  return Math.round((Date.UTC(y, m - 1, d) - EPOCH_UTC) / DAY_MS);
}

/** Excel 序列号 → `YYYY-MM-DD`。 */
export function serialToDate(serial) {
  const ms = EPOCH_UTC + Math.round(serial) * DAY_MS;
  return formatDate(new Date(ms));
}

/** Date | 时间戳 | 日期串 → `YYYY-MM-DD`。 */
export function formatDate(value) {
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }
  if (typeof value === 'number') return serialToDate(value);
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(value));
  if (!m) throw new XlsxError(`无法解析日期: ${value}`);
  return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/* --------------------------------------------------------------- 读取 */

const BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function decodeXml(s) {
  return s.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g, (all, hex, dec, named) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (dec) return String.fromCodePoint(Number(dec));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named];
  });
}

/** 取出 `<tag ...>inner</tag>`；找不到返回 null。 */
function tagText(xml, tag) {
  const open = xml.indexOf(`<${tag}`);
  if (open < 0) return null;
  const gt = xml.indexOf('>', open);
  if (gt < 0) return null;
  if (xml[gt - 1] === '/') return '';
  const close = xml.indexOf(`</${tag}>`, gt);
  if (close < 0) return '';
  return xml.slice(gt + 1, close);
}

/** 取出 `<tag ...>` 开标签的完整文本，便于继续解析属性。 */
function findOpenTag(xml, tag, from = 0) {
  return xml.indexOf(`<${tag}`, from);
}

function attr(openTagText, name) {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(openTagText);
  return m ? m[1] : null;
}

function cellRefToCol(ref) {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return null;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>|(<si\b[^>]*\/>)/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[1] === undefined) {
      out.push('');
      continue;
    }
    // 一个 <si> 里可能有多个 <t>（富文本分片），全部拼接。
    const texts = [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1]));
    out.push(texts.join(''));
  }
  return out;
}

function parseDateFmtIds(stylesXml) {
  const ids = new Set(BUILTIN_DATE_FMT);
  if (!stylesXml) return ids;
  const numFmts = tagText(stylesXml, 'numFmts');
  if (numFmts) {
    const re = /<numFmt\b[^>]*\/?>/g;
    let m;
    while ((m = re.exec(numFmts))) {
      const code = attr(m[0], 'formatCode');
      if (!code) continue;
      // 去掉颜色/条件段与转义，再看是否含日期占位符。
      const cleaned = code
        .replace(/\[[^\]]*\]/g, '')
        .replace(/"[^"]*"/g, '')
        .replace(/\\./g, '');
      if (/[ymdhs]/i.test(cleaned)) ids.add(Number(attr(m[0], 'numFmtId')));
    }
  }
  return ids;
}

function parseDateStyleIndexes(stylesXml) {
  const dateFmtIds = parseDateFmtIds(stylesXml);
  const cellXfs = tagText(stylesXml, 'cellXfs');
  const out = new Set();
  if (!cellXfs) return out;
  const re = /<xf\b[^>]*?\/?>/g;
  let m;
  let idx = 0;
  while ((m = re.exec(cellXfs))) {
    const id = Number(attr(m[0], 'numFmtId') ?? 0);
    if (dateFmtIds.has(id)) out.add(idx);
    idx += 1;
  }
  return out;
}

/** sheet 名 → xl/worksheets/sheetN.xml 路径。 */
function worksheetPathFor(wbXml, relsXml, sheetName) {
  if (!wbXml) return null;
  const sheetRe = /<sheet\b[^>]*\/?>/g;
  let m;
  while ((m = sheetRe.exec(wbXml))) {
    if (decodeXml(attr(m[0], 'name') || '') !== sheetName) continue;
    const rid = attr(m[0], 'r:id');
    if (!rid) break;
    const relRe = new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*>`);
    const rel = relRe.exec(relsXml || '');
    if (!rel) break;
    const target = attr(rel[0], 'Target') || '';
    const normalized = target.replace(/^\/?xl\//, '').replace(/^\.\//, '');
    return `xl/${normalized}`;
  }
  return null;
}

/**
 * 把工作簿某张表读成二维单元数组。
 * 每个单元为 `null`（空）、字符串、数字、布尔值，或 `{ date: 'YYYY-MM-DD' }`。
 *
 * @param {Buffer|Uint8Array} buf .xlsx 文件内容
 * @param {string} [sheetName] 默认取第一张表
 * @param {object} [opts]
 * @param {boolean} [opts.rawDates] 为 true 时保留序列号，不转日期串
 */
export function readSheet(buf, sheetName, opts = {}) {
  const entries = readZip(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  const byName = new Map(entries.map((e) => [e.name, e.data.toString('utf8')]));
  const wbXml = byName.get('xl/workbook.xml');
  if (!wbXml) throw new XlsxError('不是 xlsx 工作簿：缺少 xl/workbook.xml');
  const relsXml = byName.get('xl/_rels/workbook.xml.rels');
  const sheetNames = [...wbXml.matchAll(/<sheet\b[^>]*\/?>/g)].map((m) =>
    decodeXml(attr(m[0], 'name') || ''),
  );
  const target = sheetName ?? sheetNames[0];
  if (!sheetNames.includes(target)) {
    throw new XlsxError(`工作簿中不存在工作表「${target}」；现有：${sheetNames.join('、')}`);
  }
  const path = worksheetPathFor(wbXml, relsXml, target);
  const sheetXml = path ? byName.get(path) : null;
  if (!sheetXml) throw new XlsxError(`找不到工作表「${target}」的 XML（${path}）`);

  const shared = parseSharedStrings(byName.get('xl/sharedStrings.xml'));
  const dateStyles = parseDateStyleIndexes(byName.get('xl/styles.xml'));
  const rows = [];
  const rowRe = /<row\b([^>]*)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm;
  while ((rm = rowRe.exec(sheetXml))) {
    const rowAttrs = rm[1] || '';
    const body = rm[2] || '';
    const rIdx = Number(attr(`<row ${rowAttrs}>`, 'r')) || rows.length + 1;
    const cells = [];
    const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    let seq = 0;
    while ((cm = cellRe.exec(body))) {
      const open = `<c ${cm[1] || ''}>`;
      const inner = cm[2] || '';
      const ref = attr(open, 'r');
      const col = ref ? cellRefToCol(ref) : null;
      const at = col ?? seq;
      const type = attr(open, 't');
      const styleIdx = Number(attr(open, 's') ?? 0);
      let value = null;
      if (type === 'inlineStr') {
        const isText = tagText(inner, 'is');
        value = isText === null ? null : [...isText.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1])).join('');
      } else {
        const vText = tagText(inner, 'v');
        if (vText !== null && vText !== '') {
          if (type === 's') value = shared[Number(vText)] ?? null;
          else if (type === 'str') value = decodeXml(vText);
          else if (type === 'b') value = vText === '1';
          else if (type === 'e') value = null;
          else {
            const num = Number(vText);
            value = Number.isFinite(num) ? num : decodeXml(vText);
            if (typeof value === 'number' && dateStyles.has(styleIdx)) {
              value = opts.rawDates ? value : { date: serialToDate(value) };
            }
          }
        }
      }
      cells[at] = value;
      seq = at + 1;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = null;
    rows[rIdx - 1] = cells;
  }
  for (let i = 0; i < rows.length; i++) if (rows[i] === undefined) rows[i] = [];
  return rows;
}

/** 列出工作簿全部工作表名。 */
export function sheetNames(buf) {
  const entries = readZip(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  const wb = entries.find((e) => e.name === 'xl/workbook.xml');
  if (!wb) throw new XlsxError('不是 xlsx 工作簿：缺少 xl/workbook.xml');
  return [...wb.data.toString('utf8').matchAll(/<sheet\b[^>]*\/?>/g)].map((m) =>
    decodeXml(attr(m[0], 'name') || ''),
  );
}

/* --------------------------------------------------------------- 写出 */

function colLetter(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // 去掉 XML 1.0 不允许的控制字符
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

const FONT_KEY = (c) => [c.bold ? 1 : 0, c.italic ? 1 : 0, c.color || '', c.size || 11].join('|');

/** 自定义日期格式的 numFmtId（与 monitor-dashboard.xlsx 的 `yyyy-mm-dd` 一致）。 */
const DATE_FMT_ID = 164;

/**
 * 风格描述对象（全部可选）：
 *   bold, italic, size, color(字体色 RRGGBB), bg(填充色 RRGGBB),
 *   fmt('date' | 'percent' | 'text' | 'general'), border(布尔，默认 true)
 * 写入时自动去重为 font/fill/border/xf 表。
 */
export function styleKey(c = {}) {
  return JSON.stringify([
    c.bold ? 1 : 0,
    c.italic ? 1 : 0,
    c.size || 11,
    c.color || '',
    c.bg || '',
    c.fmt || '',
    c.border === false ? 0 : 1,
  ]);
}

/**
 * 生成 .xlsx（支持多张工作表）。
 *
 * 两种调用方式：
 *   writeXlsx({ sheetName, widths, rows })            // 单表
 *   writeXlsx({ sheets: [{ name, widths, rows }, …] }) // 多表（共用一张样式表）
 *
 * 单元为 `{ v, style }`：`v` 可以是 null / 字符串 / 数字 / 布尔 / `{ date: 'YYYY-MM-DD' }`；
 * `style` 支持 `{ bold, italic, size, color, bg, fmt: 'date'|'percent', border }`。
 *
 * @param {object} spec
 * @param {string} [spec.sheetName] 单表模式的工作表名
 * @param {number[]} [spec.widths] 每列宽度（字符数）
 * @param {Array<Array<object|null>>} [spec.rows]
 * @param {Array<{name: string, widths?: number[], rows?: Array}>} [spec.sheets] 多表模式
 * @returns {Buffer}
 */
export function writeXlsx(spec) {
  const sheets = normalizeSheets(spec);

  // 全工作簿共用一张样式表：字体 / 填充 / 边框 / xf 按需累积。
  const registry = {
    fonts: [{ name: 'Calibri', sz: 11 }],
    fontIdx: new Map([['0|0||11', 0]]),
    fills: ['none', 'gray125'],
    fillIdx: new Map(),
    borders: [null],
    xfs: [{ font: 0, fill: 0, border: 0, numFmt: 0 }],
    xfIdx: new Map(),
  };

  const sheetXmls = sheets.map((sheet) => buildSheetXml(sheet, registry));
  const { fonts, fills, borders, xfs } = registry;

  const fontsXml = fonts
    .map((f) => {
      const parts = [`<sz val="${f.size || 11}"/>`, `<name val="Calibri"/>`];
      if (f.bold) parts.push('<b/>');
      if (f.italic) parts.push('<i/>');
      if (f.color) parts.push(`<color rgb="FF${f.color.toUpperCase()}"/>`);
      return `<font>${parts.join('')}</font>`;
    })
    .join('');
  const fillsXml = fills
    .map((f) =>
      f === 'none'
        ? '<fill><patternFill patternType="none"/></fill>'
        : f === 'gray125'
          ? '<fill><patternFill patternType="gray125"/></fill>'
          : `<fill><patternFill patternType="solid"><fgColor rgb="FF${f.toUpperCase()}"/><bgColor indexed="64"/></patternFill></fill>`,
    )
    .join('');
  const thin = '<left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom>';
  const bordersXml = borders
    .map((b) => (b ? `<border>${thin}</border>` : '<border><left/><right/><top/><bottom/></border>'))
    .join('');
  const xfsXml = xfs
    .map(
      (x) =>
        `<xf numFmtId="${x.numFmt}" fontId="${x.font}" fillId="${x.fill}" borderId="${x.border}" xfId="0"` +
        `${x.numFmt ? ' applyNumberFormat="1"' : ''}${x.font ? ' applyFont="1"' : ''}${x.fill ? ' applyFill="1"' : ''}${x.border ? ' applyBorder="1"' : ''}/>`,
    )
    .join('');

  const stylesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<numFmts count="1"><numFmt numFmtId="${DATE_FMT_ID}" formatCode="yyyy\\-mm\\-dd"/></numFmts>` +
    `<fonts count="${fonts.length}">${fontsXml}</fonts>` +
    `<fills count="${fills.length}">${fillsXml}</fills>` +
    `<borders count="${borders.length}">${bordersXml}</borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="${xfs.length}">${xfsXml}</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`;

  const overrides = sheets
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('');
  const sheetTags = sheets
    .map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');
  const sheetRels = sheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join('');
  const styleRelId = `rId${sheets.length + 1}`;

  return writeZip([
    {
      name: '[Content_Types].xml',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        overrides +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        `</Types>`,
    },
    {
      name: '_rels/.rels',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets>${sheetTags}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        sheetRels +
        `<Relationship Id="${styleRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `</Relationships>`,
    },
    ...sheetXmls.map((xml, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml })),
    { name: 'xl/styles.xml', data: stylesXml },
  ]);
}

/** 把两种调用方式统一成 sheets 数组。 */
function normalizeSheets(spec) {
  const list = Array.isArray(spec?.sheets)
    ? spec.sheets
    : [{ name: spec?.sheetName ?? 'Sheet1', widths: spec?.widths, rows: spec?.rows }];
  if (!list.length) throw new XlsxError('writeXlsx: 至少需要一张工作表');
  const seen = new Set();
  return list.map((sheet) => {
    if (typeof sheet?.name !== 'string' || sheet.name.trim() === '') {
      throw new XlsxError('writeXlsx: 工作表名不能为空');
    }
    if (seen.has(sheet.name)) throw new XlsxError(`writeXlsx: 工作表名重复「${sheet.name}」`);
    seen.add(sheet.name);
    return { name: sheet.name, widths: sheet.widths || [], rows: sheet.rows || [] };
  });
}

/** 生成一张工作表的 XML，并把用到的样式登记进共享 registry。 */
function buildSheetXml(sheet, registry) {
  const { widths, rows } = sheet;
  const { fonts, fontIdx, fills, fillIdx, borders, xfs, xfIdx } = registry;

  const stylePlan = rows.map((row) =>
    (row || []).map((cell) => {
      const st = (cell && cell.style) || {};
      const key = styleKey(st);
      if (xfIdx.has(key)) return xfIdx.get(key);

      const fk = FONT_KEY(st);
      if (!fontIdx.has(fk)) {
        fontIdx.set(fk, fonts.length);
        fonts.push(st);
      }
      let fi = 0;
      if (st.bg) {
        if (!fillIdx.has(st.bg)) {
          fillIdx.set(st.bg, fills.length);
          fills.push(st.bg);
        }
        fi = fillIdx.get(st.bg);
      }
      let bi = 0;
      if (st.border !== false) {
        bi = 1;
        if (borders.length === 1) borders.push(true);
      }
      const numFmt = st.fmt === 'date' ? DATE_FMT_ID : st.fmt === 'percent' ? 9 : 0;
      const idx = xfs.length;
      xfs.push({ font: fontIdx.get(fk), fill: fi, border: bi, numFmt });
      xfIdx.set(key, idx);
      return idx;
    }),
  );

  const xmlRows = rows
    .map((row, r) => {
      const cells = (row || [])
        .map((cell, c) => {
          const v = cell ? cell.v : null;
          if (v === null || v === undefined || v === '') return '';
          const ref = `${colLetter(c)}${r + 1}`;
          const s = stylePlan[r][c];
          const sAttr = s ? ` s="${s}"` : '';
          if (typeof v === 'number' && Number.isFinite(v)) {
            return `<c r="${ref}"${sAttr}><v>${v}</v></c>`;
          }
          if (v && typeof v === 'object' && v.date) {
            return `<c r="${ref}"${sAttr}><v>${dateToSerial(v.date)}</v></c>`;
          }
          if (typeof v === 'boolean') {
            return `<c r="${ref}"${sAttr} t="b"><v>${v ? 1 : 0}</v></c>`;
          }
          if (typeof v === 'object') {
            // 到了这里说明是既没有 date 也不是数字的对象（例如误写成 `{ v: {...} }`）。
            // 静默 String() 会写成 "[object Object]" 这种垃圾数据，必须直接报错。
            throw new XlsxError(
              `writeXlsx: 第 ${r + 1} 行第 ${c + 1} 列的单元值无法写入 Excel：` +
                `期望字符串/数字/布尔/{date}，收到 ${Object.prototype.toString.call(v)}`,
            );
          }
          return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${escapeXml(v)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');

  const cols = widths.length
    ? `<cols>${widths
        .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
        .join('')}</cols>`
    : '';

  const maxCol = Math.max(0, Math.max(...rows.map((r) => (r || []).length), 1) - 1);
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="A1:${colLetter(maxCol)}${Math.max(rows.length, 1)}"/>` +
    `${cols}<sheetData>${xmlRows}</sheetData></worksheet>`
  );
}
