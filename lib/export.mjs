/**
 * Excel 导出投影：由权威存储派生出可读的 .xlsx。
 *
 * 这个文件**永远是可丢弃的**——删掉、改坏、覆盖都不影响数据，重新导出即可。
 * 输出两张表：
 *
 *   Tasks      全部事项（含已完成与未设截止日期的），带下拉校验，供人工查看/交接
 *   Dashboard  与 monitor-dashboard.xlsx 同构的预警看板（指标 + 五级清单 + 项目维度）
 *
 * 分级口径来自 read.mjs / tasks.alertOf，因此导出件、面板、每日摘要三处一致。
 */
import { writeXlsx } from './xlsx.mjs';
import { buildDashboardRows } from './dashboard.mjs';
import { CATEGORIES, PRIORITIES, STATUSES } from './tasks.mjs';

const TASK_HEADERS = ['Task_ID', 'Project_Name', 'Task_Name', 'Category', 'Owner', 'Start_Date',
  'Due_Date', 'Status', 'Priority', 'Progress', 'Notes'];
const TASK_WIDTHS = [10, 30, 30, 12, 12, 12, 12, 12, 10, 10, 36];

const HEADER_STYLE = { bg: '1F4E79', color: 'FFFFFF', bold: true, border: true };

/** 导出时的行序：未完成在前按截止日，已完成在后按完成时间倒序。 */
export function orderForExport(tasks) {
  const active = tasks.filter((t) => t.status !== '已完成');
  const done = tasks.filter((t) => t.status === '已完成');
  const byDue = (a, b) =>
    String(a.due ?? '9999-12-31').localeCompare(String(b.due ?? '9999-12-31')) ||
    String(a.id).localeCompare(String(b.id));
  active.sort(byDue);
  done.sort((a, b) => String(b.completedAt ?? b.updatedAt ?? '').localeCompare(String(a.completedAt ?? a.updatedAt ?? '')));
  return [...active, ...done];
}

/** Tasks 工作表（含表头与分组样式）。 */
export function buildTasksSheet(tasks) {
  const header = TASK_HEADERS.map((h) => ({ v: h, style: HEADER_STYLE }));
  const rows = [header];
  for (const t of orderForExport(tasks)) {
    const done = t.status === '已完成';
    const style = done ? { border: true, color: '808080' } : { border: true };
    rows.push([
      { v: t.id, style },
      { v: t.project, style },
      { v: t.name, style },
      { v: t.category, style },
      { v: t.owner ?? '', style },
      t.start ? { v: { date: t.start }, style: { ...style, fmt: 'date' } } : { v: '', style },
      t.due ? { v: { date: t.due }, style: { ...style, fmt: 'date' } } : { v: '', style },
      { v: t.status, style },
      { v: t.priority, style },
      { v: typeof t.progress === 'number' ? t.progress : null, style: { ...style, fmt: 'percent' } },
      { v: t.notes ?? '', style },
    ]);
  }
  return { name: 'Tasks', widths: TASK_WIDTHS, rows };
}

/** 从已装饰的读模型生成 Dashboard 工作表所需的 report 形状。 */
export function toDashReport({ decorated, metrics, projects, today }) {
  const groups = {};
  for (const id of ['overdue', 'red', 'orange', 'yellow', 'green']) {
    groups[id] = decorated
      .filter((t) => !t.done && t.level === id)
      .map((t) => ({
        Task_ID: t.id,
        Project_Name: t.project,
        Task_Name: t.name,
        Owner: t.owner ?? '',
        due: t.due,
        days: t.days,
        Status: t.status,
        Priority: t.priority,
        Progress: t.progress,
        Notes: t.notes ?? '',
      }))
      .sort((a, b) => String(a.due).localeCompare(String(b.due)));
  }
  return {
    today,
    groups,
    metrics,
    projects: projects.map((p) => ({ ...p, orange: p.orange, yellow: p.yellow })),
    // 存储是权威数据，不存在「日期列是文本」「Task_ID 重复」这类历史问题，
    // 但布局函数会读这两个字段，因此显式给空数组。
    invalid: [],
    duplicates: [],
    topGreen: 10,
  };
}

/**
 * 生成完整导出工作簿。
 *
 * @param {object} view 由 read.mjs 生成的读模型
 * @param {object} view.decorated 已补 days/level/done 的记录
 * @param {object} view.metrics
 * @param {Array}  view.projects
 * @param {string} view.today
 * @param {Array}  tasks 原始记录（Tasks 表用）
 */
export function buildWorkbook(view, tasks) {
  const report = toDashReport(view);
  return writeXlsx({
    sheets: [
      buildTasksSheet(tasks),
      {
        name: 'Dashboard',
        widths: [12, 30, 30, 12, 13, 11, 10, 10, 10, 38],
        rows: buildDashboardRows(report, { tasksSheet: 'Tasks', topGreen: 10 }),
      },
    ],
  });
}

/** 供 UI 展示的下拉候选值（与 Excel 校验保持一致）。 */
export const ENUMS = { categories: CATEGORIES, statuses: STATUSES, priorities: PRIORITIES };
