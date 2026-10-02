/**
 * 事项领域模型（权威数据）。
 *
 * 这里定义插件**自己拥有**的数据结构，与 Excel 无关：xlsx 只是由它派生出来的
 * 导出投影。字段命名尽量贴近原来的 Tasks 表，便于迁移与对照。
 *
 * 时间戳一律 ISO-8601 字符串（可读、可 diff、跨时区无歧义）；只有 `due` / `start`
 * 是「日历日期」`YYYY-MM-DD`，因为它们表达的是日期而不是时刻。
 */
import { classify, daysBetween } from './dashboard.mjs';

export const CATEGORIES = ['申报', '结题', '经费', '汇报', '其他'];
export const STATUSES = ['未开始', '进行中', '待审核', '已完成'];
export const PRIORITIES = ['高', '中', '低'];

/**
 * 状态别名：历史数据（旧 Excel 的 Status 下拉里有「已逾期」）与常见误写。
 * 键一律映射到 STATUSES 中的合法值。
 */
export const STATUS_ALIASES = {
  已逾期: '进行中',
  逾期: '进行中',
  超期: '进行中',
  进行: '进行中',
  在做: '进行中',
  未开始做: '未开始',
  待开始: '未开始',
  完成: '已完成',
  已完结: '已完成',
  待审: '待审核',
  审核中: '待审核',
};

/** 类别别名。 */
export const CATEGORY_ALIASES = {
  报销: '经费',
  财务: '经费',
  报告: '汇报',
  申报书: '申报',
  立项: '申报',
  验收: '结题',
};

/** 优先级别名。 */
export const PRIORITY_ALIASES = { 紧急: '高', 重要: '高', 普通: '中', 较低: '低', 不急: '低' };
export const DONE = '已完成';
export const SCHEMA_VERSION = 1;

/** 中文字段名，用于校验报错信息。 */
const LABELS = {
  name: '事项名称',
  project: '项目名称',
  category: '类别',
  owner: '负责人',
  priority: '优先级',
  status: '状态',
  progress: '进度',
  start: '开始日期',
  due: '截止日期',
  notes: '备注',
};

export function nowIso(now = new Date()) {
  return now.toISOString();
}

/** 本地日历日期 YYYY-MM-DD（按系统时区，避免 UTC 偏移把日期挪一天）。 */
export function todayIso(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 是否为合法的日历日期串（同时拒绝 2026-02-31 这类不存在的日期）。 */
export function isIsoDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function clean(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/** 把用户输入（`30%` / `0.3` / `30`）规整为 0–1 数值；无法识别返回 null。 */
export function normalizeProgress(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (value > 1) return value <= 100 ? value / 100 : null;
    return value < 0 ? null : value;
  }
  const text = clean(value).replace(/[％%]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const num = Number(text);
  if (!Number.isFinite(num) || num < 0) return null;
  if (num > 100) return null;
  return num > 1 ? num / 100 : num;
}

/**
 * 校验并规范化一条事项的输入。返回 `{ ok, record, errors }`。
 * 只做「形状与取值」校验；Task_ID 与时间戳由 store 负责分配。
 */
export function normalizeTaskInput(input = {}) {
  const errors = [];
  const name = clean(input.name ?? input.Task_Name);
  const project = clean(input.project ?? input.Project_Name);
  if (!name) errors.push(`缺少${LABELS.name}`);
  if (!project) errors.push(`缺少${LABELS.project}`);

  // 历史上出现过的写法（含旧 Excel 下拉里的「已逾期」）走别名映射，避免整行被拒。
  const alias = { ...STATUS_ALIASES, ...CATEGORY_ALIASES, ...PRIORITY_ALIASES };
  const coercions = [];
  const pick = (value, allowed, label, fallback) => {
    const text = clean(value);
    if (!text) return fallback;
    if (allowed.includes(text)) return text;
    const mapped = alias[text];
    if (mapped && allowed.includes(mapped)) {
      coercions.push(`${label}「${text}」已按「${mapped}」处理`);
      return mapped;
    }
    errors.push(`${label}「${text}」非法，应为：${allowed.join(' / ')}`);
    return fallback;
  };

  const category = pick(input.category ?? input.Category, CATEGORIES, LABELS.category, '其他');
  const priority = pick(input.priority ?? input.Priority, PRIORITIES, LABELS.priority, '中');
  const status = pick(input.status ?? input.Status, STATUSES, LABELS.status, '未开始');

  const start = clean(input.start ?? input.Start_Date) || null;
  const due = clean(input.due ?? input.Due_Date) || null;
  if (start && !isIsoDate(start)) errors.push(`${LABELS.start}「${start}」不是 YYYY-MM-DD 日期`);
  if (due && !isIsoDate(due)) errors.push(`${LABELS.due}「${due}」不是 YYYY-MM-DD 日期`);
  if (start && due && isIsoDate(start) && isIsoDate(due) && daysBetween(start, due) < 0) {
    errors.push(`${LABELS.due}早于${LABELS.start}`);
  }

  const rawProgress = input.progress ?? input.Progress;
  let progress = normalizeProgress(rawProgress);
  if (rawProgress !== null && rawProgress !== undefined && rawProgress !== '' && progress === null) {
    errors.push(`${LABELS.progress}「${rawProgress}」无法识别，请用 0–100 或 0–1`);
    progress = null;
  }
  // 状态与进度保持一致：未开始=0，已完成=1，进行中至少留 0 默认。
  if (status === DONE) progress = 1;
  else if (status === '未开始') progress = 0;
  else if (progress === null) progress = 0;

  const record = {
    name,
    project,
    category,
    owner: clean(input.owner ?? input.Owner) || null,
    start: isIsoDate(start) ? start : null,
    due: isIsoDate(due) ? due : null,
    status,
    priority,
    progress,
    notes: clean(input.notes ?? input.Notes) || null,
  };
  return { ok: errors.length === 0, record, errors, coercions };
}

/** 生成下一个可用的 Task_ID（T-001 起，取现有最大值 +1，不复用空洞）。 */
export function nextTaskId(tasks) {
  let max = 0;
  for (const t of tasks ?? []) {
    const m = /^T-(\d+)$/.exec(String(t.id ?? ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `T-${String(max + 1).padStart(3, '0')}`;
}

/**
 * 派生出提醒级别与剩余天数（用户可见的读模型）。
 *
 * - 已完成 → `{ level: null, days: null }`（不参与预警）
 * - 没有截止日期 → `{ level: 'unscheduled', days: null }`
 * - 其余 → 复用 dashboard.mjs 的 `classify`，保证与导出、摘要口径完全一致
 */
export function alertOf(task, today) {
  if (task.status === DONE) return { level: null, days: null };
  if (!isIsoDate(task.due)) return { level: 'unscheduled', days: null };
  const { level, days } = classify(task.due, today);
  return { level, days };
}

/** 生成一条新记录（补齐 id 与时间戳）。 */
export function createRecord(input, tasks, now = new Date()) {
  const { record } = normalizeTaskInput(input);
  const ts = nowIso(now);
  return { id: nextTaskId(tasks), ...record, createdAt: ts, updatedAt: ts, completedAt: record.status === DONE ? ts : null, deletedAt: null };
}

/** 把存储里的记录投影成 Excel / 摘要所需的 Tasks 表行对象。 */
export function toTaskRow(task) {
  return {
    Task_ID: task.id,
    Project_Name: task.project,
    Task_Name: task.name,
    Category: task.category,
    Owner: task.owner ?? '',
    Start_Date: task.start,
    Due_Date: task.due,
    Status: task.status,
    Priority: task.priority,
    Progress: typeof task.progress === 'number' ? task.progress : null,
    Notes: task.notes ?? '',
  };
}
