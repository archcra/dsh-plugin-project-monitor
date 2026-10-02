/**
 * project-monitor 引擎：把 project-tracker.xlsx 的 Tasks 表变成
 *   1) 按 monitor-dashboard.xlsx 样式的 Dashboard 工作簿内容
 *   2) 一份可直接转述的中文 markdown 摘要
 *
 * 分级规则与样式沿用 project-monitor skill / monitor-dashboard.xlsx：
 *   已逾期 D<0 → 红底深红字加粗；红 0–3 天；橙 4–7 天；黄 8–30 天；绿 >30 天。
 *   「已完成」不参与预警统计；Due_Date 为空/非日期的行排除出统计并单独提示。
 */
import { formatDate, readSheet, writeXlsx } from './xlsx.mjs';

export const TASK_COLUMNS = [
  'Task_ID', 'Project_Name', 'Task_Name', 'Category', 'Owner',
  'Start_Date', 'Due_Date', 'Status', 'Priority', 'Progress', 'Notes',
];

/** 每个预警级别的配色（背景 / 字色），与 monitor-dashboard.xlsx 一致。 */
export const LEVEL_COLORS = {
  overdue: { bg: 'FFC7CE', fg: '9C0006' },
  red: { bg: 'FFC7CE', fg: '9C0006' },
  orange: { bg: 'FFD8A8', fg: 'B35C00' },
  yellow: { bg: 'FFEB9C', fg: '9C6500' },
  green: { bg: 'C6EFCE', fg: '006100' },
};

export const LEVEL_LABELS = {
  overdue: '已逾期',
  red: '3 天内到期（红色）',
  orange: '4–7 天内到期（橙色）',
  yellow: '8–30 天内到期（黄色）',
  green: '30 天以上（绿色）',
};

const DARK_BG = '1F4E79';
const DARK_FG = 'FFFFFF';
const LIST_WIDTHS = [12, 30, 30, 12, 13, 11, 10, 10, 10, 38];
const LIST_HEADERS = ['Task_ID', 'Project_Name', 'Task_Name', 'Owner', 'Due_Date', '剩余天数', 'Status', 'Priority', 'Progress', 'Notes'];
const PRIORITY_RANK = { 高: 0, 中: 1, 低: 2 };

export const DONE_STATUS = '已完成';

/* ------------------------------------------------------------ 读取 Tasks */

function cellValue(cell) {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'object' && cell.date) return cell.date;
  return cell;
}

/** 读取 Tasks 工作表为任务记录数组，收集日期异常行与重复 Task_ID。 */
export function loadTasks(rows, { sheetName = 'Tasks' } = {}) {
  const tasks = [];
  const invalid = [];
  const seen = new Map();
  for (let i = 1; i < rows.length; i++) {
    const raw = rows[i] || [];
    const rec = {};
    TASK_COLUMNS.forEach((key, c) => {
      rec[key] = cellValue(raw[c]);
    });
    const identity = [rec.Task_ID, rec.Project_Name, rec.Task_Name]
      .some((v) => v !== null && String(v).trim() !== '' && String(v).trim() !== '—');
    if (!identity) continue;

    const due = rec.Due_Date;
    if (typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(String(due))) {
      invalid.push({ row: i + 1, ...rec, sheetName });
      continue;
    }
    rec.due = due;
    rec.start = typeof rec.Start_Date === 'string' ? rec.Start_Date : null;
    tasks.push(rec);
    const key = String(rec.Task_ID ?? '');
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k).sort();
  return { tasks, invalid, duplicates };
}

/* -------------------------------------------------------------- 分级 */

/** 按 Due_Date 与基准日期的天数差分级。 */
export function classify(due, today) {
  const d = daysBetween(today, due);
  if (d < 0) return { level: 'overdue', days: d };
  if (d <= 3) return { level: 'red', days: d };
  if (d <= 7) return { level: 'orange', days: d };
  if (d <= 30) return { level: 'yellow', days: d };
  return { level: 'green', days: d };
}

/** 两个 YYYY-MM-DD 之间的天数（to - from）。 */
export function daysBetween(from, to) {
  const a = Date.parse(`${formatDate(from)}T00:00:00Z`);
  const b = Date.parse(`${formatDate(to)}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

function progressOf(task) {
  const p = task.Progress;
  return typeof p === 'number' && Number.isFinite(p) ? p : null;
}

/* ------------------------------------------------------------- 分析 */

/**
 * 汇总一份完整报告：指标、五个分级分组（各自已排序）、项目维度、异常项。
 * @param {object} input
 * @param {Array} input.tasks loadTasks 的产出
 * @param {string} input.today 基准日期 YYYY-MM-DD
 */
export function analyze({ tasks, today, invalid = [], duplicates = [], topGreen = 10 }) {
  const decorated = tasks.map((t) => {
    const { level, days } = classify(t.due, today);
    return { ...t, level, days, done: t.Status === DONE_STATUS };
  });
  const active = decorated.filter((t) => !t.done);
  const groups = {};
  for (const level of Object.keys(LEVEL_COLORS)) {
    groups[level] = active
      .filter((t) => t.level === level)
      .sort((a, b) =>
        a.due.localeCompare(b.due) ||
        (PRIORITY_RANK[a.Priority] ?? 9) - (PRIORITY_RANK[b.Priority] ?? 9) ||
        String(a.Task_ID).localeCompare(String(b.Task_ID)),
      );
  }

  const metrics = {
    total: decorated.length,
    done: decorated.filter((t) => t.done).length,
    doing: decorated.filter((t) => t.Status === '进行中').length,
    overdue: groups.overdue.length,
    red: groups.red.length,
    dueIn7: active.filter((t) => t.days >= 0 && t.days <= 7).length,
    dueIn30: active.filter((t) => t.days >= 0 && t.days <= 30).length,
    today,
  };

  const projects = new Map();
  for (const t of decorated) {
    const name = t.Project_Name ?? '（未命名项目）';
    if (!projects.has(name)) projects.set(name, []);
    projects.get(name).push(t);
  }
  const projectRows = [...projects.entries()]
    .map(([name, items]) => {
      const act = items.filter((t) => !t.done);
      const count = (lv) => act.filter((t) => t.level === lv).length;
      const nearest = (act.length ? act : items)
        .map((t) => t.due)
        .sort()[0];
      return {
        name,
        total: items.length,
        overdue: count('overdue'),
        red: count('red'),
        orange: count('orange'),
        yellow: count('yellow'),
        nearest,
        worst: count('overdue') + count('red'),
      };
    })
    .sort((a, b) => b.worst - a.worst || a.nearest.localeCompare(b.nearest));

  const urgent = [...active].sort((a, b) => a.days - b.days).slice(0, 3);
  return {
    today,
    decorated,
    active,
    groups,
    metrics,
    projects: projectRows,
    urgent,
    invalid,
    duplicates,
    topGreen,
  };
}

/* ----------------------------------------------- Dashboard 工作簿内容 */

const HEADER_STYLE = { bg: DARK_BG, color: DARK_FG, bold: true };
const LEFT = { border: false };
const CENTER = { border: false };

function cell(v, style) {
  return { v, style };
}

function sectionTitle(text, level) {
  const c = LEVEL_COLORS[level];
  return [cell(text, { bg: c.bg, color: c.fg, bold: true, size: 12, border: false })];
}

function listHeader() {
  return LIST_HEADERS.map((h) =>
    cell(h, { ...HEADER_STYLE, border: true }),
  );
}

function taskRow(task, level) {
  const c = LEVEL_COLORS[level];
  const bold = level === 'overdue';
  let notes = task.Notes;
  if (level === 'overdue') {
    const warn = `⚠ 已逾期 ${-task.days} 天`;
    notes = notes === null || notes === undefined || notes === '' || notes === '—'
      ? warn
      : `${notes} ${warn}`;
  }
  const values = [
    task.Task_ID, task.Project_Name, task.Task_Name, task.Owner,
    { date: task.due }, task.days, task.Status, task.Priority,
    progressOf(task), notes === '—' ? '' : notes,
  ];
  return values.map((v, i) => {
    const fmt = i === 4 ? 'date' : i === 8 ? 'percent' : undefined;
    return cell(v, { bg: c.bg, color: c.fg, bold, fmt, border: false, size: 11 });
  });
}

function blankRow(width = 10) {
  return Array.from({ length: width }, () => cell(null, CENTER));
}

/** 生成 Dashboard 工作表的行内容（单元数组），样式对齐 monitor-dashboard.xlsx。 */
export function buildDashboardRows(report, { tasksSheet = 'Tasks', topGreen = report.topGreen ?? 10 } = {}) {
  const { metrics, groups } = report;
  const rows = [];

  const metricCells = [
    ['总任务数', metrics.total, null],
    ['已完成数', metrics.done, metrics.done > 0 ? 'green' : null],
    ['进行中数', metrics.doing, null],
    ['已逾期数', metrics.overdue, 'overdue'],
    ['3天内到期', metrics.red, 'red'],
    ['7天内到期', metrics.dueIn7, 'orange'],
    ['30天内到期', metrics.dueIn30, 'yellow'],
    ['基准日期', { date: metrics.today }, null],
  ];
  rows.push(metricCells.map(([label]) => cell(label, { ...HEADER_STYLE, border: true })));
  rows.push(
    metricCells.map(([, value, level]) =>
      level
        ? cell(value, { bg: LEVEL_COLORS[level].bg, color: LEVEL_COLORS[level].fg, bold: true, fmt: typeof value === 'object' ? 'date' : undefined, border: true })
        : cell(value, { bold: true, fmt: typeof value === 'object' ? 'date' : undefined, border: true }),
    ),
  );
  rows.push([
    cell(
      `注：基准日期 ${metrics.today}（${tasksSheet} 表）；“X天内到期”为 0–X 天累计；已完成任务不参与预警；分级依据 Due_Date 与基准日期差值。`,
      { italic: true, size: 9, color: '808080', border: false },
    ),
  ]);
  rows.push(blankRow());

  const order = [
    ['overdue', '【已逾期】'],
    ['red', '【3 天内到期（红色）】'],
    ['orange', '【4–7 天内到期（橙色）】'],
    ['yellow', '【8–30 天内到期（黄色）】'],
    ['green', `【30 天以上（绿色，仅列前 ${topGreen} 条）】`],
  ];
  for (const [level, title] of order) {
    const all = groups[level] ?? [];
    const items = level === 'green' ? all.slice(0, topGreen) : all;
    const truncated = level === 'green' && all.length > topGreen;
    rows.push(sectionTitle(`${title} 共 ${all.length} 项${truncated ? `（仅列前 ${topGreen} 条）` : ''}`, level));
    rows.push(listHeader());
    if (items.length === 0) {
      rows.push([cell('（无任务）', { italic: true, color: '808080', border: false })]);
    } else {
      for (const t of items) rows.push(taskRow(t, level));
    }
    rows.push(blankRow());
  }

  rows.push([cell('【项目维度汇总】（按 已逾期数+红色数 降序）', { ...HEADER_STYLE, bold: true, size: 12, border: false })]);
  rows.push(
    ['Project_Name', '总任务数', '已逾期数', '红色数', '橙色数', '黄色数', '最近到期日'].map((h) =>
      cell(h, { ...HEADER_STYLE, border: true }),
    ),
  );
  for (const p of report.projects) {
    const vals = [p.name, p.total, p.overdue, p.red, p.orange, p.yellow, { date: p.nearest }];
    rows.push(
      vals.map((v, i) => {
        const level = { 2: 'overdue', 3: 'red', 4: 'orange', 5: 'yellow' }[i];
        const count = { 2: p.overdue, 3: p.red, 4: p.orange, 5: p.yellow }[i] ?? 0;
        const style = level && count > 0
          ? { bg: LEVEL_COLORS[level].bg, color: LEVEL_COLORS[level].fg, bold: i === 2, border: false }
          : { bold: i === 0, border: false };
        return cell(v, { ...style, fmt: i === 6 ? 'date' : undefined });
      }),
    );
  }

  if (report.invalid.length) {
    rows.push(blankRow());
    rows.push([cell(`【⚠ 需修正】Due_Date 为空或非日期（${report.invalid.length} 行，已排除出预警统计）`, { bg: 'FFC7CE', color: '9C0006', bold: true, border: false })]);
    rows.push(
      ['所在行', 'Task_ID', 'Project_Name', 'Task_Name', 'Owner', 'Due_Date 原值'].map((h) =>
        cell(h, { ...HEADER_STYLE, border: true }),
      ),
    );
    for (const t of report.invalid) {
      rows.push(
        [t.row, t.Task_ID, t.Project_Name, t.Task_Name, t.Owner, t.Due_Date].map((v) =>
          cell(v, { bg: 'FFC7CE', color: '9C0006', border: false }),
        ),
      );
    }
  }
  if (report.duplicates.length) {
    rows.push(blankRow());
    rows.push([cell(`【⚠ Task_ID 重复】${report.duplicates.join('、')}`, { bg: 'FFC7CE', color: '9C0006', bold: true, border: false })]);
  }
  return rows;
}

/** 生成 Dashboard 工作簿（Buffer）。 */
export function buildDashboardWorkbook(report, opts = {}) {
  return writeXlsx({
    sheetName: opts.dashboardSheet ?? 'Dashboard',
    widths: LIST_WIDTHS,
    rows: buildDashboardRows(report, opts),
  });
}

/* ------------------------------------------------------- 中文摘要 */

function pct(p) {
  return p === null ? '—' : `${Math.round(p * 100)}%`;
}

function daysPhrase(days) {
  return days < 0 ? `已逾期 ${-days} 天` : `剩余 ${days} 天`;
}

/**
 * 把记录归一化成摘要渲染统一使用的字段名。
 *
 * 摘要同时服务于两种输入：Tasks 表行（`Task_ID` / `Project_Name` / `Notes` …）与
 * 存储记录（`id` / `project` / `notes` …）。这里一次性归一，避免每个渲染分支
 * 各自兜底——曾经只修了「最紧迫任务」，结果逾期明细与未来 7 天仍打出 undefined。
 */
function asRow(task) {
  if (!task || typeof task !== 'object') return null;
  return {
    id: task.Task_ID ?? task.id ?? '—',
    name: task.Task_Name ?? task.name ?? '—',
    project: task.Project_Name ?? task.project ?? '—',
    owner: task.Owner ?? task.owner ?? '—',
    due: task.due ?? task.Due_Date ?? null,
    days: typeof task.days === 'number' ? task.days : null,
    status: task.Status ?? task.status ?? '—',
    priority: task.Priority ?? task.priority ?? '—',
    progress: task.Progress !== undefined ? task.Progress : task.progress,
    notes: task.Notes ?? task.notes ?? '',
  };
}

/** 渲染 markdown 摘要（与 skill 脚本的 stdout 摘要同构，并补充项目/异常提示）。 */
export function renderSummary(report, { storePath, workbookPath, tasksSheet = 'Tasks', dashboardSheet = 'Dashboard', mode = 'markdown' } = {}) {
  const { metrics, groups, projects, invalid, duplicates, urgent } = report;
  const activeCount = report.active.length;
  const lines = [];
  lines.push(`## 事项进展摘要（基准日期 ${metrics.today}）`);
  lines.push('');
  // 权威数据是插件自己的 JSON 存储；Excel 只是导出投影，别把人引向"要准备表格"
  if (storePath) {
    lines.push(`- 数据源：\`${storePath}\`（权威存储）` + (workbookPath ? `，导出投影 \`${workbookPath}\`` : ''));
  } else if (workbookPath) {
    lines.push(`- 数据源：\`${workbookPath}\`（${tasksSheet} → ${dashboardSheet}）`);
  }
  lines.push(
    `- 总任务 ${metrics.total} 项：已完成 ${metrics.done} ｜ 进行中 ${metrics.doing} ｜ 其他未完成 ${activeCount - metrics.doing}` +
      (invalid.length ? `（另有 ${invalid.length} 行因日期异常未计入）` : ''),
  );
  lines.push(
    `- 预警分布：已逾期 **${metrics.overdue}** ｜ 红(0–3天) ${metrics.red} ｜ 橙(4–7天) ${groups.orange.length} ｜ 黄(8–30天) ${groups.yellow.length} ｜ 绿(>30天) ${groups.green.length}`,
  );
  lines.push('');
  lines.push('### 最紧迫任务');
  if (!urgent.length) {
    lines.push('（没有未完成任务）');
  } else {
    urgent.forEach((raw, i) => {
      const t = asRow(raw);
      lines.push(
        `${i + 1}. **${t.id}** ${t.name}（${t.project} · ${t.owner}）— ${daysPhrase(t.days)}，${t.status}，进度 ${pct(t.progress)}，截止 ${t.due ?? '—'}`,
      );
    });
  }
  lines.push('');
  if (metrics.overdue > 0) {
    lines.push('### 已逾期明细');
    for (const raw of groups.overdue) {
      const t = asRow(raw);
      lines.push(`- ${t.id} ${t.name}（${t.project} · ${t.owner}）— 已逾期 ${-t.days} 天，进度 ${pct(t.progress)}`);
    }
    lines.push('');
  }
  lines.push('### 未来 7 天到期');
  const soon = [...groups.red, ...groups.orange];
  if (!soon.length) lines.push('（无）');
  for (const raw of soon) {
    const t = asRow(raw);
    lines.push(`- ${t.due}（${daysPhrase(t.days)}）${t.id} ${t.name} — ${t.owner}，进度 ${pct(t.progress)}`);
  }
  lines.push('');
  if (projects.length) {
    lines.push('### 项目维度（按 已逾期+红色 降序）');
    lines.push('| 项目 | 总数 | 逾期 | 红 | 橙 | 黄 | 最近到期 |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const p of projects) {
      lines.push(`| ${p.name} | ${p.total} | ${p.overdue} | ${p.red} | ${p.orange} | ${p.yellow} | ${p.nearest} |`);
    }
    lines.push('');
  }
  if (invalid.length) {
    lines.push('### ⚠ 需修正（Due_Date 为空或非日期，已排除出预警统计）');
    for (const raw of invalid) {
      const t = asRow(raw);
      const due = raw.Due_Date ?? raw.due ?? null;
      lines.push(`- 第 ${raw.row ?? '?'} 行：${t.id}（${t.name}，Owner=${t.owner}）Due_Date=${due === null ? '空' : JSON.stringify(due)}`);
    }
    lines.push('');
  }
  if (duplicates.length) {
    lines.push(`### ⚠ Task_ID 重复：${duplicates.join('、')}，请检查唯一性`);
    lines.push('');
  }
  if (mode === 'text') {
    // 纯文本模式：去掉 markdown 记号，便于终端/通知展示。
    return lines
      .join('\n')
      .replace(/\*\*/g, '')
      .replace(/^#+\s*/gm, '')
      .replace(/\|\s*/g, ' | ')
      .replace(/`/g, '');
  }
  return lines.join('\n');
}

/** 一站式：从工作簿 Buffer 生成报告。 */
export function reportFromWorkbook(buf, { today, tasksSheet = 'Tasks', topGreen = 10 } = {}) {
  const rows = readSheet(buf, tasksSheet);
  const { tasks, invalid, duplicates } = loadTasks(rows, { sheetName: tasksSheet });
  return analyze({ tasks, today, invalid, duplicates, topGreen });
}
