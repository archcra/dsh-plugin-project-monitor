/**
 * 录入文本解析：把人类写法变成结构化字段。
 *
 * 三类入口共用这里：
 *   1. 快捷行  `横向课题B / 设备验收 / 其他 / 钱老师 / 10/20 / 高 / 30%`
 *   2. 批量粘贴（每行一条，逗号或制表符分隔，值可乱序、可省略）
 *   3. 表单里的日期/进度输入框
 *
 * 设计原则：**宁可报错也不要猜错**。日期能识别就识别，识别不了就明确说"无法识别"
 * 并回显原文；进度超范围、类别拼错也一律报错而不是默默丢弃。
 */
import {
  CATEGORIES,
  PRIORITIES,
  STATUSES,
  normalizeProgress,
} from './tasks.mjs';

/* ------------------------------------------------------------ 基础工具 */

/** 全角转半角、去零宽字符、压缩空白。 */
export function normalizeText(input) {
  return String(input ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .trim();
}

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 解析中文数字（支持 十/十五/二十/二十三 这类写法）。 */
export function parseCnNumber(text) {
  const s = normalizeText(text);
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (!/^[零〇一二两三四五六七八九十]+$/.test(s)) return null;
  if (s === '十') return 10;
  const idx = s.indexOf('十');
  if (idx < 0) {
    let n = 0;
    for (const ch of s) n = n * 10 + CN_DIGITS[ch];
    return n;
  }
  const tens = idx === 0 ? 1 : CN_DIGITS[s.slice(0, idx)];
  const onesRaw = s.slice(idx + 1);
  const ones = onesRaw ? CN_DIGITS[onesRaw] : 0;
  if (tens === undefined || ones === undefined) return null;
  return tens * 10 + ones;
}

const WD = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 七: 7 };

function toIso(dt) {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function utcOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function addDays(iso, days) {
  return toIso(new Date(utcOf(iso) + days * 86400000));
}

/** 该月的最后一天。 */
function endOfMonth(iso) {
  const [y, m] = iso.split('-').map(Number);
  return toIso(new Date(Date.UTC(y, m, 0)));
}

function isoWeekday(iso) {
  const wd = new Date(utcOf(iso)).getUTCDay(); // 0=周日
  return wd === 0 ? 7 : wd;
}

/* ------------------------------------------------------------ 日期解析 */

/**
 * 解析日期表达。返回 `{ ok: true, date, matched }` 或 `{ ok: false, reason }`。
 *
 * 支持：`2026-10-20`、`2026/10/20`、`2026.10.20`、`10/20`、`10-20`、`10月20日`、
 * `今天/明天/后天/大后天`、`N天后`、`下周X/周X/星期X/礼拜X`、`下个月`、`月底/月底最后一天`。
 *
 * 缺省的年份按「未来优先」补：`1/5` 在 12 月时指明年 1 月 5 日。
 */
export function parseDate(input, baseDate) {
  const s = normalizeText(input);
  if (!s) return { ok: false, reason: '空日期' };
  const base = /^\d{4}-\d{2}-\d{2}$/.test(baseDate ?? '') ? baseDate : toIso(new Date());

  // 1) 完整日期
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) {
    const iso = `${m[1]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
    const [y, mo, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
      return { ok: false, reason: `${s} 不是有效日期` };
    }
    return { ok: true, date: iso, matched: s };
  }

  // 2) 中文月日
  m = /^(\d{1,2}|[零〇一二两三四五六七八九十]+)\s*月\s*(\d{1,2}|[零〇一二两三四五六七八九十]+)\s*[日号]?$/.exec(s);
  if (m) {
    const mo = parseCnNumber(m[1]);
    const d = parseCnNumber(m[2]);
    return resolveMonthDay(mo, d, base, s);
  }

  // 3) 纯月日（未来优先）
  m = /^(\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return resolveMonthDay(Number(m[1]), Number(m[2]), base, s);

  // 4) 相对日
  const offsets = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3, 昨天: -1, 前天: -2 };
  if (s in offsets) return { ok: true, date: addDays(base, offsets[s]), matched: s };

  m = /^(\d+|[零〇一二两三四五六七八九十]+)\s*天\s*(后|以后|之后)$/.exec(s);
  if (m) {
    const n = parseCnNumber(m[1]);
    if (n === null) return { ok: false, reason: `无法解析天数「${m[1]}」` };
    return { ok: true, date: addDays(base, n), matched: s };
  }

  m = /^(\d+|[零〇一二两三四五六七八九十]+)\s*(周|星期|礼拜)\s*(后|以后|之后)$/.exec(s);
  if (m) {
    const n = parseCnNumber(m[1]);
    if (n === null) return { ok: false, reason: `无法解析周数「${m[1]}」` };
    return { ok: true, date: addDays(base, n * 7), matched: s };
  }

  // 5) 周几（本周剩余 / 下周）
  m = /^(下{0,3}|本|这)?\s*(周|星期|礼拜)\s*([一二三四五六日天七])$/.exec(s);
  if (m) {
    const prefix = m[1] ?? '';
    const target = WD[m[3]];
    if (target === undefined) return { ok: false, reason: `无法识别星期「${m[3]}」` };
    const cur = isoWeekday(base);
    let delta = target - cur;
    if (prefix.startsWith('下')) delta += 7 * prefix.length;
    else if (delta < 0) delta += 7; // 本周已过则顺延到下周
    return { ok: true, date: addDays(base, delta), matched: s };
  }

  // 6) 下个月 / 下下个月
  m = /^(下{1,3})\s*个?\s*月$/.exec(s);
  if (m) {
    const n = m[1].length;
    const [y, mo] = base.split('-').map(Number);
    const dt = new Date(Date.UTC(y, mo - 1 + n, 1));
    return { ok: true, date: toIso(dt), matched: s };
  }

  // 7) 月底
  if (/^(这个?月)?\s*月底(最后一天)?$/.test(s) || s === '月末') {
    return { ok: true, date: endOfMonth(base), matched: s };
  }

  return { ok: false, reason: `无法识别日期「${s}」` };
}

function resolveMonthDay(month, day, base, raw) {
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > 31) {
    return { ok: false, reason: `${raw} 不是有效日期` };
  }
  const [by] = base.split('-').map(Number);
  const iso = `${by}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const dt = new Date(Date.UTC(by, month - 1, day));
  if (dt.getUTCDate() !== day) return { ok: false, reason: `${raw} 不是有效日期` };
  // 未来优先：已过去则算明年
  return { ok: true, date: utcOf(iso) < utcOf(base) ? `${by + 1}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : iso, matched: raw };
}

/* -------------------------------------------------------- 字段识别 */

const CANCEL_WORDS = new Set(['无', '暂无', '没有', '-', '—']);

function matchEnum(token, allowed) {
  const t = normalizeText(token);
  if (!t) return null;
  for (const value of allowed) if (t === value) return value;
  // 宽容匹配：用户写「未开始 」/「进行中。」这类带标点的情况
  const stripped = t.replace(/[。，,.\s]/g, '');
  for (const value of allowed) if (stripped === value) return value;
  return null;
}

/** 识别 token 的语义类型；识别不出返回 `{ kind: 'text' }`。 */
export function classifyToken(token, baseDate) {
  const raw = normalizeText(token);
  if (!raw) return { kind: 'empty' };

  if (/^\d{1,3}\s*[%％]$/.test(raw)) {
    const value = normalizeProgress(raw);
    return value === null ? { kind: 'invalid', reason: `进度「${raw}」超出 0–100%` } : { kind: 'progress', value, raw };
  }

  const category = matchEnum(raw, CATEGORIES);
  if (category) return { kind: 'category', value: category, raw };

  const status = matchEnum(raw, STATUSES);
  if (status) return { kind: 'status', value: status, raw };

  const priority = matchEnum(raw, PRIORITIES);
  if (priority) return { kind: 'priority', value: priority, raw };

  if (CANCEL_WORDS.has(raw)) return { kind: 'cancel' };

  // 日期（放在枚举之后：避免「中」这类单字与日期规则冲突）
  const date = parseDate(raw, baseDate);
  if (date.ok) return { kind: 'date', value: date.date, raw };

  // 疑似日期但没解析出来 —— 明确报错，绝不当作人名
  if (/[月日号周星期天]|\d[-/.]\d/.test(raw) && !/^[\u4e00-\u9fa5]{2,4}$/.test(raw)) {
    return { kind: 'invalid', reason: date.reason };
  }
  if (/[月日号]|周[一二三四五六日天]/.test(raw)) {
    return { kind: 'invalid', reason: date.reason };
  }

  return { kind: 'text', value: raw, raw };
}

/* ---------------------------------------------------------- 快捷行解析 */

/**
 * 快捷行分隔符。
 *
 * 注意：斜杠**必须带空格**才算分隔符，否则 `10/8`、`2026/10/20` 这类日期会被切碎。
 * 竖线/分号/制表符没有这个歧义，带不带空格都认。
 */
const SEP_RE = /\s+(?:\/|｜|\||;|；)\s*|\s*(?:｜|\||;|；|\t)\s*|\t+/;

/**
 * 解析快捷行。位置固定，便于肌肉记忆：
 *
 *   项目 / 事项 [/ 类别] [/ 负责人] [/ 截止日] [/ 优先级] [/ 进度] [/ 状态] [/ 备注]
 *
 * 第 3 段起若本身是日期/进度/优先级/类别/状态，会自动归位（不要求严格顺序）。
 */
export function parseQuickLine(input, baseDate) {
  const parts = normalizeText(input).split(SEP_RE).map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length === 0) return { ok: false, errors: ['没有输入内容'], record: null };
  if (parts.length === 1) {
    // 单段时允许用空格分隔「项目 事项」两段；只有一个词则明确报错，
    // 否则「只有一个字段」会被当成项目名静默入库。
    const halves = parts[0].split(/\s+/).filter(Boolean);
    if (halves.length >= 2) parts.splice(0, 1, halves[0], halves.slice(1).join(' '));
    else {
      return {
        ok: false,
        record: { project: parts[0], name: '' },
        errors: ['只有一个词，无法区分「项目」和「事项」——请用 / 分隔，例如：甲项目 / 写总结'],
      };
    }
  }

  const errors = [];
  const out = { project: parts[0] ?? '', name: parts[1] ?? '' };
  if (!out.project) errors.push('缺少项目名称');
  if (!out.name) errors.push('缺少事项名称');

  const leftovers = [];
  for (const token of parts.slice(2)) {
    const c = classifyToken(token, baseDate);
    switch (c.kind) {
      case 'category': out.category = c.value; break;
      case 'status': out.status = c.value; break;
      case 'priority': out.priority = c.value; break;
      case 'progress': out.progress = c.value; break;
      case 'date':
        if (out.due === undefined) out.due = c.value;
        else if (out.start === undefined) out.start = c.value;
        else errors.push(`多出一个日期「${c.raw}」`);
        break;
      case 'invalid': errors.push(c.reason); break;
      case 'text': leftovers.push(c.value); break;
      default: break;
    }
  }

  // 剩下的纯文本按出现顺序补 owner → notes
  if (leftovers.length) out.owner = leftovers[0];
  if (leftovers.length > 1) out.notes = leftovers.slice(1).join(' ');

  return { ok: errors.length === 0, record: errors.length === 0 ? out : out, errors };
}

/**
 * 解析批量粘贴：每行一条，值可乱序。
 *
 * 分隔符优先用制表符（从 Excel 复制），否则用逗号/斜杠。
 * 每行独立返回结果，便于前端逐行标红。
 */
export function parsePaste(text, baseDate) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sep = line.includes('\t') ? /\t/ : /(?:,|，|\/|｜|\|)/;
    const parts = line.split(sep).map((p) => normalizeText(p)).filter((p) => p !== '');
    if (!parts.length) continue;

    const errors = [];
    const out = {};
    const leftovers = [];
    for (const token of parts) {
      // 前两个无法识别的文本按「项目 → 事项」填充
      const c = classifyToken(token, baseDate);
      switch (c.kind) {
        case 'category':
          if (out.category) leftovers.push(token); else out.category = c.value;
          break;
        case 'status':
          if (out.status) leftovers.push(token); else out.status = c.value;
          break;
        case 'priority':
          if (out.priority) leftovers.push(token); else out.priority = c.value;
          break;
        case 'progress':
          if (typeof out.progress === 'number') leftovers.push(token); else out.progress = c.value;
          break;
        case 'date':
          if (out.due === undefined) out.due = c.value;
          else if (out.start === undefined) out.start = c.value;
          else errors.push(`多出一个日期「${c.raw}」`);
          break;
        case 'invalid': errors.push(c.reason); break;
        case 'text': leftovers.push(c.value); break;
        case 'cancel': break;
        default: break;
      }
    }
    if (leftovers[0]) out.project = leftovers[0];
    if (leftovers[1]) out.name = leftovers[1];
    if (leftovers[2]) out.owner = leftovers[2];
    if (leftovers.length > 3) out.notes = leftovers.slice(3).join(' ');

    if (!out.project) errors.push('缺少项目名称');
    if (!out.name) errors.push('缺少事项名称');
    if (!out.due) errors.push('缺少截止日期');
    rows.push({ line: i + 1, raw: line, ok: errors.length === 0, record: out, errors });
  }
  const bad = rows.filter((r) => !r.ok).length;
  return { rows, okCount: rows.length - bad, badCount: bad };
}
