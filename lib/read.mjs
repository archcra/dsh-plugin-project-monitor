/**
 * 读模型：过滤、搜索、排序、分级分组、指标。
 *
 * 与 store 分开的理由：store 只管「权威数据怎么落地」，这里只管「用户看到的形状」。
 * 分级口径复用 tasks.alertOf → dashboard.classify，保证面板、Excel 导出、每日摘要
 * 三处对"逾期几天"的理解完全一致。
 */
import { DONE, alertOf, isIsoDate } from './tasks.mjs';

const PRIORITY_RANK = { 高: 0, 中: 1, 低: 2 };

/** 分级展示顺序与标题。 */
export const GROUP_ORDER = [
  ['overdue', '已逾期'],
  ['red', '3 天内到期'],
  ['orange', '4–7 天内到期'],
  ['yellow', '8–30 天内到期'],
  ['green', '30 天以上'],
  ['unscheduled', '未设截止日期'],
  ['done', '已完成'],
];

const SORTS = {
  due: (a, b) => compareDue(a, b),
  priority: (a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) || compareDue(a, b),
  progress: (a, b) => (a.progress ?? 0) - (b.progress ?? 0) || compareDue(a, b),
  created: (a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')),
  updated: (a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')),
  name: (a, b) => String(a.name).localeCompare(String(b.name), 'zh'),
};

function compareDue(a, b) {
  // 无截止日的排在最后
  const av = isIsoDate(a.due) ? a.due : '9999-12-31';
  const bv = isIsoDate(b.due) ? b.due : '9999-12-31';
  return av.localeCompare(bv) || (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) || String(a.id).localeCompare(String(b.id));
}

/** 给记录补上派生字段（days / level / done）。 */
export function decorate(task, today) {
  const { level, days } = alertOf(task, today);
  return { ...task, level, days, done: task.status === DONE };
}

function matchesText(task, needle) {
  if (!needle) return true;
  const hay = [task.name, task.project, task.owner, task.notes, task.category, task.id]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return needle
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

/**
 * 生成列表视图。
 *
 * @param {Array} tasks 原始记录
 * @param {string} today 基准日期
 * @param {object} [opts]
 * @param {string} [opts.search] 全文搜索（空格分词，全部命中）
 * @param {string} [opts.project] 按项目过滤
 * @param {string} [opts.owner] 按负责人过滤
 * @param {string} [opts.status] 按状态过滤：未开始/进行中/待审核/已完成/active（未完成）
 * @param {string} [opts.level] 按分级过滤（overdue/red/.../unscheduled）
 * @param {string} [opts.sort] due|priority|progress|created|updated|name
 * @param {number} [opts.limit] 0 表示不截断
 * @param {number} [opts.offset]
 */
export function buildView(tasks, today, opts = {}) {
  const decorated = tasks.map((t) => decorate(t, today));
  const search = String(opts.search ?? '').trim();

  let rows = decorated.filter((t) => {
    if (opts.project && t.project !== opts.project) return false;
    if (opts.owner && (t.owner ?? '') !== opts.owner) return false;
    if (opts.status === 'active') {
      if (t.done) return false;
    } else if (opts.status && t.status !== opts.status) return false;
    if (opts.level && t.level !== opts.level) return false;
    return matchesText(t, search);
  });

  const sortKey = SORTS[opts.sort] ? opts.sort : 'due';
  rows = rows.sort(SORTS[sortKey]);

  const total = rows.length;
  const offset = Math.max(0, Number(opts.offset) || 0);
  const limit = opts.limit === undefined ? 200 : Math.max(0, Number(opts.limit) || 0);
  const page = limit === 0 ? rows.slice(offset) : rows.slice(offset, offset + limit);

  // 按级别取全部匹配项，再在级别内分页。
  //
  // 曾经的做法是"先分页、再从当页切分组"，结果是：total 报 18，而「30 天以上」
  // 写着 12 项却只给出 1 条（被页大小截断）——面板明明说还有 11 条，却一条都到不了。
  // 现在分组永远基于完整匹配集，分页只在级别内部生效（`itemTotal` 是未分页的总数）。
  const groups = GROUP_ORDER.map(([id, label]) => {
    const matched = rows.filter((t) => (id === 'done' ? t.done : !t.done && t.level === id));
    return {
      id,
      label,
      count: matched.length,
      itemTotal: matched.length,
      items: limit === 0 ? matched : matched.slice(0, limit),
    };
  });

  return {
    today,
    total,
    matched: total,
    offset,
    limit,
    hasMore: offset + page.length < total,
    sort: sortKey,
    items: page,
    groups,
    facets: {
      projects: unique(tasks.map((t) => t.project)),
      owners: unique(tasks.map((t) => t.owner).filter(Boolean)),
      statuses: unique(tasks.map((t) => t.status)),
    },
    counts: countByLevel(decorated),
  };
}

function unique(values) {
  return [...new Set(values.filter((v) => v !== null && v !== undefined && String(v).trim() !== ''))].sort((a, b) =>
    String(a).localeCompare(String(b), 'zh'),
  );
}

/** 各分级计数（含未设截止日期与已完成）。 */
export function countByLevel(decorated) {
  const counts = { overdue: 0, red: 0, orange: 0, yellow: 0, green: 0, unscheduled: 0, done: 0 };
  for (const t of decorated) {
    if (t.done) counts.done += 1;
    else if (t.level) counts[t.level] = (counts[t.level] ?? 0) + 1;
  }
  return counts;
}

/** 顶部指标（与 Dashboard.xlsx 汇总区一致）。 */
export function buildMetrics(decorated, today) {
  const active = decorated.filter((t) => !t.done);
  return {
    today,
    total: decorated.length,
    done: decorated.filter((t) => t.done).length,
    doing: decorated.filter((t) => t.status === '进行中').length,
    undone: active.length,
    overdue: active.filter((t) => t.level === 'overdue').length,
    red: active.filter((t) => t.level === 'red').length,
    dueIn7: active.filter((t) => t.days !== null && t.days >= 0 && t.days <= 7).length,
    dueIn30: active.filter((t) => t.days !== null && t.days >= 0 && t.days <= 30).length,
    unscheduled: active.filter((t) => t.level === 'unscheduled').length,
  };
}

/** 项目维度汇总（按 逾期+红 降序）。 */
export function buildProjects(decorated) {
  const byProject = new Map();
  for (const t of decorated) {
    const key = t.project ?? '（未命名项目）';
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(t);
  }
  return [...byProject.entries()]
    .map(([name, items]) => {
      const act = items.filter((t) => !t.done);
      const cnt = (lv) => act.filter((t) => t.level === lv).length;
      const pool = act.length ? act : items;
      const nearest = pool
        .map((t) => t.due)
        .filter((d) => isIsoDate(d))
        .sort()[0] ?? null;
      return {
        name,
        total: items.length,
        done: items.filter((t) => t.done).length,
        overdue: cnt('overdue'),
        red: cnt('red'),
        orange: cnt('orange'),
        yellow: cnt('yellow'),
        worst: cnt('overdue') + cnt('red'),
        nearest,
      };
    })
    .sort((a, b) => b.worst - a.worst || String(a.nearest ?? '9999').localeCompare(String(b.nearest ?? '9999')));
}
