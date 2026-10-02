#!/usr/bin/env node
/**
 * project-monitor CLI —— 不启动 DSH 也能看板、录入与导出。
 *
 * 权威数据是插件自己的存储（`$DSH_HOME/project-monitor/tasks.json`），Excel 只是
 * 由它导出的投影，因此这里的默认行为是「读存储」，而不是「读表格」。
 *
 *   node lib/cli.mjs                            # 打印今日摘要并刷新导出件
 *   node lib/cli.mjs list --level overdue       # 看清单
 *   node lib/cli.mjs add 甲项目 / 写总结 / 10/20  # 快捷录入
 *   node lib/cli.mjs export                     # 只重新生成 Excel + 摘要文件
 *   node lib/cli.mjs check                      # 体检
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderSummary } from './dashboard.mjs';
import { openStore, defaultDataDir } from './store.mjs';
import { todayIso } from './tasks.mjs';
import { buildMetrics, buildProjects, buildView, decorate } from './read.mjs';
import { buildWorkbook } from './export.mjs';
import { parsePaste, parseQuickLine } from './query.mjs';
import { readSheet, sheetNames } from './xlsx.mjs';

const HELP = `project-monitor —— 事项进度管理

用法:
  node lib/cli.mjs [list|add|export|check|summary] [参数] [选项]

子命令:
  summary（默认）       打印今日摘要，并刷新 Excel 导出与摘要文件
  list                 列出事项（支持筛选/搜索/排序）
  add <快捷行>          新增事项；加 --paste 时按多行文本批量解析
  export               只重新生成 Excel（Tasks + Dashboard）与摘要文件
  check                体检：存储状态 + 数据问题 + 各级计数

list 选项:
  --search TEXT        全文搜索（项目/事项/负责人/备注）
  --project NAME       按项目筛选
  --owner NAME         按负责人筛选
  --status STATUS      未开始|进行中|待审核|已完成|active（未完成）
  --level LEVEL        overdue|red|orange|yellow|green|unscheduled|done
  --sort KEY           due|priority|progress|created|updated|name
  --limit N            最多列出条数（默认 50，0 = 全部）

add 选项:
  --paste              参数按多行文本批量解析（逐行报告）

全局选项:
  --dir DIR            数据目录（默认 $DSH_HOME/project-monitor）
  --today DATE         基准日期 YYYY-MM-DD（默认系统当天）
  --json / --text      输出格式
  --quiet              不打印正文
  --export PATH        Excel 导出路径
  --summary-dir DIR    摘要目录
  --no-write           不写任何文件
  --legacy PATH        首次迁移来源工作簿（存储为空时才导入）
  -h, --help           显示本帮助
`;

function parseArgs(argv) {
  const opts = {
    command: null,
    positional: [],
    dir: null,
    today: null,
    json: false,
    text: false,
    quiet: false,
    exportPath: null,
    summaryDir: null,
    noWrite: false,
    search: '',
    project: '',
    owner: '',
    status: '',
    level: '',
    sort: 'due',
    limit: 50,
    paste: false,
    legacy: null,
  };
  const valueFlags = {
    '--dir': 'dir', '--today': 'today', '--export': 'exportPath', '--summary-dir': 'summaryDir',
    '--legacy': 'legacy',
    '--search': 'search', '--project': 'project', '--owner': 'owner', '--status': 'status',
    '--level': 'level', '--sort': 'sort',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      if (!opts.command) opts.command = arg;
      else opts.positional.push(arg);
      continue;
    }
    if (Object.hasOwn(valueFlags, arg)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`选项 ${arg} 缺少取值`);
      opts[valueFlags[arg]] = value;
      continue;
    }
    if (arg === '--limit') {
      const value = argv[++i];
      if (value === undefined) throw new Error('选项 --limit 缺少取值');
      opts.limit = Number(value);
      continue;
    }
    switch (arg) {
      case '--json': opts.json = true; break;
      case '--text': opts.text = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--no-write': opts.noWrite = true; break;
      case '--paste': opts.paste = true; break;
      case '-h':
      case '--help': opts.help = true; break;
      default: throw new Error(`未知选项 ${arg}`);
    }
  }
  return opts;
}

/**
 * 首次使用时从旧工作簿迁移（与宿主同构，就近优先）。
 * 幂等：存储非空、已迁移过、或找不到文件都不动作。
 */
function autoMigrate(store, dir, explicit) {
  const names = ['project-tracker.xlsx', 'tracker.xlsx'];
  if (explicit) {
    const abs = path.resolve(explicit);
    if (!fs.existsSync(abs)) {
      return Promise.resolve({ migrated: 0, skipped: 'workbook-missing', file: abs });
    }
    return store.migrateFromWorkbook(abs, readLegacyRows, { by: 'cli' }).then((r) => ({ ...r, file: abs }));
  }
  const roots = [dir, path.dirname(dir), process.cwd()];
  const seen = new Set();
  let file = null;
  for (const root of roots) {
    const abs = path.resolve(root);
    if (seen.has(abs)) continue;
    seen.add(abs);
    for (const n of names) {
      if (fs.existsSync(path.join(abs, n))) { file = path.join(abs, n); break; }
    }
    if (file) break;
  }
  if (!file) return Promise.resolve({ migrated: 0, skipped: 'no-legacy-workbook', file: null });
  return store.migrateFromWorkbook(file, readLegacyRows, { by: 'cli' }).then((r) => ({ ...r, file }));
}

/** 读旧工作簿的 Tasks 表为行对象数组（迁移用，与宿主同构）。 */
function readLegacyRows(file, sheetName = 'Tasks') {
  const buf = fs.readFileSync(file);
  const names = sheetNames(buf);
  const sheet = names.includes(sheetName) ? sheetName : names[0];
  const rows = readSheet(buf, sheet);
  if (!rows.length) return [];
  const header = (rows[0] ?? []).map((c) => String(c ?? '').trim());
  const cols = {
    id: header.indexOf('Task_ID'), project: header.indexOf('Project_Name'), name: header.indexOf('Task_Name'),
    category: header.indexOf('Category'), owner: header.indexOf('Owner'), start: header.indexOf('Start_Date'),
    due: header.indexOf('Due_Date'), status: header.indexOf('Status'), priority: header.indexOf('Priority'),
    progress: header.indexOf('Progress'), notes: header.indexOf('Notes'),
  };
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const get = (key) => {
      const idx = cols[key];
      if (idx === undefined || idx < 0) return null;
      const cell = row[idx];
      if (cell === null || cell === undefined) return null;
      return typeof cell === 'object' && cell.date ? cell.date : cell;
    };
    out.push({
      Task_ID: get('id') ?? '', Project_Name: get('project') ?? '', Task_Name: get('name') ?? '',
      Category: get('category'), Owner: get('owner'), Start_Date: get('start'), Due_Date: get('due'),
      Status: get('status'), Priority: get('priority'), Progress: get('progress'), Notes: get('notes'),
    });
  }
  return out;
}

/** 由存储生成读模型（与宿主面板、Excel 导出共用同一套口径）。 */
function readModel(store, today) {
  const decorated = store.allTasks().map((t) => decorate(t, today));
  return { today, decorated, metrics: buildMetrics(decorated, today), projects: buildProjects(decorated) };
}

/** renderSummary 需要的 report 形状。 */
function reportShape(model, topGreen = 10) {
  const groups = {};
  for (const level of ['overdue', 'red', 'orange', 'yellow', 'green']) {
    groups[level] = model.decorated
      .filter((t) => !t.done && t.level === level)
      .sort((a, b) => String(a.due).localeCompare(String(b.due)))
      .map((t) => ({
        Task_ID: t.id, Project_Name: t.project, Task_Name: t.name, Owner: t.owner ?? '',
        due: t.due, days: t.days, Status: t.status, Priority: t.priority,
        Progress: t.progress, Notes: t.notes ?? '',
      }));
  }
  return {
    today: model.today,
    metrics: model.metrics,
    groups,
    projects: model.projects,
    active: model.decorated.filter((t) => !t.done),
    urgent: model.decorated.filter((t) => !t.done && t.days !== null).sort((a, b) => a.days - b.days).slice(0, 3),
    invalid: [],
    duplicates: [],
    topGreen,
  };
}

function summaryOf(model, opts) {
  const exportPath = opts.exportPath
    ? path.resolve(opts.exportPath)
    : path.join(opts.dir ?? defaultDataDir(), 'dashboard.xlsx');
  return renderSummary(reportShape(model), {
    storePath: path.join(opts.dir ?? defaultDataDir(), 'tasks.json'),
    workbookPath: exportPath,
    tasksSheet: 'Tasks',
    dashboardSheet: 'Dashboard',
    mode: opts.text ? 'text' : 'markdown',
  });
}

/** 写导出件：Excel（Tasks + Dashboard）+ 当日摘要。 */
function writeExports(store, model, opts) {
  const exportPath = opts.exportPath
    ? path.resolve(opts.exportPath)
    : path.join(opts.dir ?? defaultDataDir(), 'dashboard.xlsx');
  const summaryDir = opts.summaryDir
    ? path.resolve(opts.summaryDir)
    : path.join(path.dirname(exportPath), 'daily-summaries');

  const buf = buildWorkbook(
    { decorated: model.decorated, metrics: model.metrics, projects: model.projects, today: model.today },
    store.allTasks(),
  );
  fs.mkdirSync(path.dirname(exportPath), { recursive: true });
  const tmp = `${exportPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, exportPath);

  const md = summaryOf(model, { ...opts, exportPath });
  fs.mkdirSync(summaryDir, { recursive: true });
  const header = `<!-- project-monitor 自动生成 ${new Date().toISOString()} -->\n\n`;
  const dated = path.join(summaryDir, `${model.today}.md`);
  fs.writeFileSync(dated, header + md);
  fs.writeFileSync(path.join(summaryDir, 'latest.md'), header + md);

  return { written: [exportPath, dated, path.join(summaryDir, 'latest.md')], exportPath, summaryDir, summary: md };
}

/* ------------------------------------------------------------ 输出 */

/** 中文按两个字宽计算，避免表格错位。 */
function visualWidth(text) {
  const s = String(text ?? '');
  let w = 0;
  for (const ch of s) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60]/.test(ch) ? 2 : 1;
  return w;
}

function pad(text, width) {
  const s = String(text ?? '');
  return s + ' '.repeat(Math.max(0, width - visualWidth(s)));
}

function printList(store, model, opts) {
  const view = buildView(store.allTasks(), model.today, {
    search: opts.search,
    project: opts.project,
    owner: opts.owner,
    status: opts.status,
    level: opts.level,
    sort: opts.sort,
    limit: opts.limit,
    offset: 0,
  });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ today: model.today, metrics: model.metrics, view }, null, 2)}\n`);
    return;
  }
  if (!view.total) {
    process.stdout.write('（没有符合条件的事项）\n');
    return;
  }
  process.stdout.write(`共 ${view.total} 项（基准日期 ${model.today}）\n\n`);
  const header = ['编号', '项目', '事项', '负责人', '截止', '剩余', '状态', '优先级', '进度'];
  const rows = view.items.map((t) => [
    t.id,
    t.project ?? '',
    t.name ?? '',
    t.owner ?? '',
    t.due ?? '—',
    t.done ? '已完成' : t.days === null ? '未设截止' : t.days < 0 ? `逾期${-t.days}天` : `剩${t.days}天`,
    t.status,
    t.priority ?? '',
    typeof t.progress === 'number' ? `${Math.round(t.progress * 100)}%` : '—',
  ]);
  const widths = header.map((_, i) => Math.max(visualWidth(header[i]), ...rows.map((r) => visualWidth(r[i]))));
  const line = (cells) => cells.map((c, i) => pad(c, widths[i])).join('  ');
  process.stdout.write(`${line(header)}\n${widths.map((w) => '─'.repeat(w)).join('  ')}\n`);
  for (const r of rows) process.stdout.write(`${line(r)}\n`);
  if (view.hasMore) {
    process.stdout.write(`\n… 还有 ${view.total - view.items.length} 项未显示（--limit 0 可全部列出）\n`);
  }
}

/* ---------------------------------------------------------- 子命令 */

async function cmdAdd(store, model, opts) {
  const text = opts.positional.join(' ').trim();
  if (!text) throw new Error('add 需要内容，例如：add "甲项目 / 写总结 / 10/20"');

  if (opts.paste) {
    const parsed = parsePaste(text, model.today);
    const ok = parsed.rows.filter((r) => r.ok);
    if (!opts.quiet) {
      if (ok.length) {
        process.stdout.write(`将新增 ${ok.length} 条：\n`);
        for (const r of ok) {
          process.stdout.write(`  ✔ ${r.record.project} / ${r.record.name}${r.record.due ? ` / ${r.record.due}` : ''}\n`);
        }
      }
      for (const r of parsed.rows.filter((x) => !x.ok)) {
        process.stdout.write(`  ✖ 第 ${r.line} 行：${r.errors.join('、')} —— ${r.raw}\n`);
      }
    }
    if (!ok.length) return 2;
    const created = await store.createMany(ok.map((r) => r.record), { by: 'cli' });
    if (!opts.quiet) process.stdout.write(`已新增 ${created.length} 条：${created.map((t) => t.id).join('、')}\n`);
    return parsed.badCount ? 3 : 0;
  }

  const parsed = parseQuickLine(text, model.today);
  if (!parsed.ok) {
    process.stderr.write(`无法录入：${parsed.errors.join('、')}\n`);
    process.stderr.write('提示：格式为「项目 / 事项 / 类别 / 负责人 / 截止日 / 优先级 / 进度」，只有前两项是必填\n');
    return 2;
  }
  const task = await store.create(parsed.record, { by: 'cli' });
  if (!opts.quiet) {
    process.stdout.write(`已新增 ${task.id}：${task.project} / ${task.name}${task.due ? ` / 截止 ${task.due}` : ''}\n`);
  }
  return 0;
}

function cmdCheck(store, model, opts) {
  const stats = store.stats();
  const view = buildView(store.allTasks(), model.today, { limit: 0 });
  const problems = [];
  for (const t of model.decorated) {
    if (!t.due) problems.push(`${t.id} ${t.name}：未设截止日期，不参与预警`);
    if (t.done && t.progress !== 1) problems.push(`${t.id} ${t.name}：已完成但进度不是 100%`);
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ today: model.today, store: stats, metrics: model.metrics, counts: view.counts, problems }, null, 2)}\n`);
  } else {
    process.stdout.write(`存储目录: ${stats.dir}\n`);
    process.stdout.write(`快照: ${stats.snapshotFile}（${stats.total} 条，已删除 ${stats.deleted} 条，事件 seq=${stats.seq}）\n`);
    process.stdout.write(`基准日期: ${model.today}\n`);
    process.stdout.write(`指标: 总 ${model.metrics.total} ｜ 已完成 ${model.metrics.done} ｜ 进行中 ${model.metrics.doing} ｜ 未完成 ${model.metrics.undone}\n`);
    process.stdout.write(`分级: 逾期 ${view.counts.overdue} ｜ 红 ${view.counts.red} ｜ 橙 ${view.counts.orange} ｜ 黄 ${view.counts.yellow} ｜ 绿 ${view.counts.green} ｜ 未设截止 ${view.counts.unscheduled}\n`);
    if (problems.length) {
      process.stdout.write(`\n提醒（${problems.length} 项）：\n${problems.map((p) => `  · ${p}`).join('\n')}\n`);
    } else {
      process.stdout.write('\n数据体检：无异常\n');
    }
  }
  return problems.length ? 3 : 0;
}

/* ---------------------------------------------------------------- main */

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const command = opts.command ?? 'summary';
  if (!['list', 'add', 'export', 'check', 'summary'].includes(command)) {
    process.stderr.write(`未知子命令 ${command}\n\n${HELP}`);
    return 2;
  }

  const dir = opts.dir ? path.resolve(opts.dir) : defaultDataDir();
  let today = null;
  if (opts.today) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.today)) {
      process.stderr.write(`--today 需要 YYYY-MM-DD，收到 ${opts.today}\n`);
      return 2;
    }
    today = opts.today;
  } else {
    today = todayIso();
  }
  opts.dir = dir;

  const store = openStore({ dir });
  // 首次使用：若存储还是空的，尝试从旁边或进程目录里的旧工作簿迁移一次
  const migration = await autoMigrate(store, dir, opts.legacy);
  if (migration.migrated && !opts.quiet) {
    process.stderr.write(`已从 ${migration.file} 迁移 ${migration.migrated} 条事项到 ${dir}\n`);
  }
  const model = readModel(store, today);

  switch (command) {
    case 'list':
      printList(store, model, opts);
      return 0;

    case 'add': {
      const code = await cmdAdd(store, model, opts);
      await store.flush();
      return code;
    }

    case 'export': {
      if (opts.noWrite) {
        process.stderr.write('--no-write 与 export 冲突\n');
        return 2;
      }
      const { written, summary } = writeExports(store, model, opts);
      if (!opts.quiet) {
        process.stdout.write(`${opts.text ? summary : summary}\n\n已写入:\n${written.map((w) => `  · ${w}`).join('\n')}\n`);
      }
      return 0;
    }

    case 'check':
      return cmdCheck(store, model, opts);

    case 'summary':
    default: {
      if (!opts.quiet) process.stdout.write(`${summaryOf(model, opts)}\n`);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ today, dir, metrics: model.metrics, projects: model.projects, items: model.decorated }, null, 2)}\n`);
      }
      // 默认顺带刷新导出件：保持「每天早晨生成摘要」的语义
      if (!opts.noWrite) {
        const { written } = writeExports(store, model, opts);
        if (!opts.quiet && !opts.json) {
          process.stdout.write(`\n已写入:\n${written.map((w) => `  · ${w}`).join('\n')}\n`);
        }
      }
      return 0;
    }
  }
}

export { main };

// 输出被下游提前关闭（例如 `| head`）时安静退出，而不是抛 EPIPE 栈。
process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') process.exit(0);
  throw err;
});

// 直接被 `node lib/cli.mjs` 调用时自动执行；被 wrapper / 测试导入时不执行。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const code = await main();
    if (typeof code === 'number' && code !== 0) process.exit(code);
  } catch (err) {
    process.stderr.write(`错误: ${err.message}\n`);
    process.exit(1);
  }
}
