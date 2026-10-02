/**
 * project-monitor 引擎与 CLI 的回归测试（node --test，无第三方依赖）。
 *
 *   node --test plugin/test/
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

// 引擎模块用绝对 file URL 导入：本环境的 ESM 解析器对 `../` 上越包边界的
// 说明符会丢掉一段路径（`../lib/x.mjs` 被解析到包外），绝对 URL 不受影响。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = pathToFileURL(path.join(HERE, '..', 'lib')).href;
const {
  analyze,
  buildDashboardRows,
  buildDashboardWorkbook,
  classify,
  loadTasks,
  renderSummary,
  reportFromWorkbook,
} = await import(`${LIB}/dashboard.mjs`);
const { dateToSerial, readSheet, serialToDate, sheetNames, writeXlsx } = await import(`${LIB}/xlsx.mjs`);
const { readZip, writeZip } = await import(`${LIB}/zip.mjs`);

const PLUGIN = path.dirname(HERE);
const CLI = path.join(PLUGIN, 'scripts', 'project-monitor.mjs');
const WORKSPACE = path.dirname(PLUGIN);
const TRACKER = path.join(WORKSPACE, 'project-tracker.xlsx');

const HEADER = ['Task_ID', 'Project_Name', 'Task_Name', 'Category', 'Owner', 'Start_Date',
  'Due_Date', 'Status', 'Priority', 'Progress', 'Notes'];

function sheetFrom(records) {
  const rows = [HEADER.map((v) => ({ v }))];
  for (const r of records) rows.push(r.map((v) => ({ v })));
  return rows;
}

/** 把 `{ v }` 测试数据拆成 readSheet 风格的单元值（日期用 `{ date }`）。 */
function cellsFrom(rows) {
  return rows.map((r) => r.map((c) => (c && typeof c === 'object' && 'v' in c ? c.v : c)));
}

/** 从 CLI 输出里取出 JSON 正文（跳过 `已写入:` 之类的尾注）。 */
function parseJsonOutput(out) {
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  return JSON.parse(out.slice(start, end + 1));
}

function tmpWorkbook(records, sheetName = 'Tasks') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-test-'));
  const file = path.join(dir, 'tracker.xlsx');
  fs.writeFileSync(file, writeXlsx({ sheetName, widths: [10, 20, 20, 10, 10, 12, 12, 10, 10, 10, 24], rows: sheetFrom(records) }));
  return file;
}

/* ------------------------------------------------------------------ zip */

test('zip 读写往返（deflate）', () => {
  const buf = writeZip([
    { name: 'a.txt', data: 'hello 世界' },
    { name: 'nested/b.xml', data: '<x/>' },
  ]);
  const entries = readZip(buf);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'a.txt');
  assert.equal(entries[0].data.toString('utf8'), 'hello 世界');
  assert.equal(entries[1].data.toString('utf8'), '<x/>');
});

/* ----------------------------------------------------------------- xlsx */

test('xlsx 日期序列号往返', () => {
  for (const d of ['1900-03-01', '1970-01-01', '2026-09-30', '2026-10-03', '2099-12-31']) {
    assert.equal(serialToDate(dateToSerial(d)), d);
  }
});

test('xlsx 写出后可被自己读回（含日期/百分比/样式）', () => {
  const buf = writeXlsx({
    sheetName: 'Dashboard',
    widths: [12, 20],
    rows: [
      [{ v: '标签', style: { bold: true, bg: '1F4E79', color: 'FFFFFF' } }, { v: '值' }],
      [{ v: 'T-001' }, { v: { date: '2026-10-03' }, style: { fmt: 'date' } }],
      [{ v: '进度' }, { v: 0.6, style: { fmt: 'percent' } }],
      [{ v: null }, { v: '中文 & <转义>' }],
    ],
  });
  assert.deepEqual(sheetNames(buf), ['Dashboard']);
  const rows = readSheet(buf, 'Dashboard');
  assert.equal(rows[0][0], '标签');
  assert.deepEqual(rows[1][1], { date: '2026-10-03' });
  assert.equal(rows[2][1], 0.6);
  assert.equal(rows[3][1], '中文 & <转义>');
});

test('读取真实 tracking 工作簿的 Tasks 表', () => {
  const buf = fs.readFileSync(TRACKER);
  assert.ok(sheetNames(buf).includes('Tasks'));
  const rows = readSheet(buf, 'Tasks');
  assert.equal(rows[0][0], 'Task_ID');
  assert.equal(rows[0][6], 'Due_Date');
  const { tasks } = loadTasks(rows);
  assert.ok(tasks.length >= 6, `期望至少 6 条任务，实际 ${tasks.length}`);
  assert.equal(tasks[0].Task_ID, 'T-001');
  assert.equal(tasks[0].due, '2026-10-03');
});

test('缺失工作表时明确报错', () => {
  const buf = writeXlsx({ sheetName: 'Only', rows: [[{ v: 1 }]] });
  assert.throws(() => readSheet(buf, 'Tasks'), /不存在工作表/);
});

/* ------------------------------------------------------------- 分级规则 */

test('预警分级边界：逾期/红/橙/黄/绿', () => {
  const today = '2026-09-30';
  assert.deepEqual(classify('2026-09-29', today), { level: 'overdue', days: -1 });
  assert.deepEqual(classify('2026-09-30', today), { level: 'red', days: 0 });
  assert.deepEqual(classify('2026-10-03', today), { level: 'red', days: 3 });
  assert.deepEqual(classify('2026-10-04', today), { level: 'orange', days: 4 });
  assert.deepEqual(classify('2026-10-07', today), { level: 'orange', days: 7 });
  assert.deepEqual(classify('2026-10-08', today), { level: 'yellow', days: 8 });
  assert.deepEqual(classify('2026-10-30', today), { level: 'yellow', days: 30 });
  assert.deepEqual(classify('2026-10-31', today), { level: 'green', days: 31 });
});

test('已完成任务不参与预警统计', () => {
  const tasks = [
    { Task_ID: 'T-1', Project_Name: 'P', Task_Name: 'A', Owner: 'o', Due_Date: '2026-09-01', due: '2026-09-01', Status: '已完成', Priority: '高', Progress: 1 },
    { Task_ID: 'T-2', Project_Name: 'P', Task_Name: 'B', Owner: 'o', Due_Date: '2026-09-01', due: '2026-09-01', Status: '进行中', Priority: '高', Progress: 0.5 },
  ];
  const report = analyze({ tasks, today: '2026-09-30' });
  assert.equal(report.metrics.total, 2);
  assert.equal(report.metrics.done, 1);
  assert.equal(report.groups.overdue.length, 1);
  assert.equal(report.groups.overdue[0].Task_ID, 'T-2');
});

test('Due_Date 异常与重复 Task_ID 被单独收集', () => {
  const rows = cellsFrom([
    HEADER,
    ['T-1', 'P', 'A', '结题', 'o', null, { date: '2026-10-01' }, '进行中', '高', 0.5, ''],
    ['T-2', 'P', 'B', '结题', 'o', null, null, '进行中', '高', 0.5, ''],
    ['T-1', 'P', 'C', '结题', 'o', null, { date: '2026-10-02' }, '进行中', '中', 0.1, ''],
  ]);
  const { tasks, invalid, duplicates } = loadTasks(rows);
  assert.equal(tasks.length, 2);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].row, 3);
  assert.deepEqual(duplicates, ['T-1']);
});

test('空行与“—”占位行被忽略', () => {
  const rows = cellsFrom([
    HEADER,
    new Array(11).fill(null),
    ['—', '—', '—', null, null, null, null, null, null, null, null],
  ]);
  const { tasks, invalid } = loadTasks(rows);
  assert.equal(tasks.length, 0);
  assert.equal(invalid.length, 0);
});

/* ------------------------------------------------------- 仪表板与摘要 */

test('Dashboard 行布局与 monitor-dashboard 对齐（汇总/分组/项目）', () => {
  const report = reportFromWorkbook(fs.readFileSync(TRACKER), { today: '2026-09-30' });
  const rows = buildDashboardRows(report, { tasksSheet: 'Tasks', topGreen: 10 });
  assert.equal(rows[0][0].v, '总任务数');
  assert.equal(rows[0][7].v, '基准日期');
  assert.equal(rows[1][0].v, 6);
  assert.deepEqual(rows[1][7].v, { date: '2026-09-30' });
  assert.match(String(rows[2][0].v), /基准日期 2026-09-30/);
  const flat = rows.map((r) => (r[0] ? String(r[0].v) : ''));
  assert.ok(flat.some((t) => t.startsWith('【已逾期】共 1 项') || t.startsWith('【已逾期】 共 1 项')));
  assert.ok(flat.some((t) => t.includes('【项目维度汇总】')));
  const overdue = rows.find((r) => r[0] && String(r[0].v) === 'T-004');
  assert.equal(overdue[4].v.date, '2026-09-29');
  assert.equal(overdue[5].v, -1);
  assert.match(String(overdue[9].v), /⚠ 已逾期 1 天/);
  const overdueStyle = overdue[0].style;
  assert.equal(overdueStyle.bg, 'FFC7CE');
  assert.equal(overdueStyle.color, '9C0006');
  assert.equal(overdueStyle.bold, true);
});

test('生成的工作簿能被重新读回且分级配色保留', () => {
  const report = reportFromWorkbook(fs.readFileSync(TRACKER), { today: '2026-09-30' });
  const buf = buildDashboardWorkbook(report);
  const rows = readSheet(buf, 'Dashboard');
  assert.equal(rows[1][3], 1);
  assert.deepEqual(rows[1][7], { date: '2026-09-30' });
  assert.ok(rows.some((r) => r[0] === 'T-001'));
});

test('摘要包含指标、紧迫任务、逾期明细与项目表', () => {
  const report = reportFromWorkbook(fs.readFileSync(TRACKER), { today: '2026-09-30' });
  const md = renderSummary(report, { workbookPath: '/tmp/x.xlsx' });
  // storePath 优先：权威存储是 tasks.json，Excel 只能以"导出投影"身份出现
  const md2 = renderSummary(report, { storePath: '/home/pm/tasks.json', workbookPath: '/tmp/x.xlsx' });
  assert.match(md2, /数据源：`\/home\/pm\/tasks\.json`（权威存储）/);
  assert.match(md2, /导出投影 `\/tmp\/x\.xlsx`/);
  assert.match(md, /## 事项进展摘要（基准日期 2026-09-30）/);
  assert.match(md, /已逾期 \*\*1\*\*/);
  assert.match(md, /T-004 经费执行率核对/);
  assert.match(md, /\| 横向课题A \| 1 \| 1 \| 0 \| 0 \| 0 \| 2026-09-29 \|/);
  const text = renderSummary(report, { mode: 'text' });
  assert.ok(!text.includes('**'));
});

/* ------------------------------------------------------------------ CLI */

/**
 * 执行 CLI。进度提示走 stderr（`已从 … 迁移 …`），因此默认把两路合并返回，
 * 需要区分时传 `stderr: true` 取 `{ stdout, stderr }`。
 */
function runCli(args, opts = {}) {
  const { stderr = false, ...rest } = opts;
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...rest });
  const status = r.status ?? (r.error ? 1 : 0);
  if (stderr) {
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status };
  }
  if (status !== 0) {
    const err = new Error(`CLI 退出码 ${status}`);
    err.status = status;
    err.stdout = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    err.stderr = r.stderr ?? '';
    throw err;
  }
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

/** 建一个临时数据目录，并把旧工作簿作为显式迁移来源。 */
function cliFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-cli-'));
  return { dir, data: path.join(dir, 'data'), export: path.join(dir, 'out', 'monitor.xlsx') };
}

test('CLI summary：空存储也能跑，并写出 Excel 与当日摘要', () => {
  const { data, export: out } = cliFixture();
  const stdout = runCli(['summary', '--dir', data, '--today', '2026-09-30', '--export', out]);
  assert.match(stdout, /事项进展摘要（基准日期 2026-09-30）/);
  assert.match(stdout, /已写入/);
  assert.ok(fs.existsSync(out));
  assert.ok(fs.existsSync(path.join(path.dirname(out), 'daily-summaries', '2026-09-30.md')));
  assert.ok(fs.existsSync(path.join(path.dirname(out), 'daily-summaries', 'latest.md')));

  // 导出的工作簿必须含 Tasks + Dashboard 两张表
  const buf = fs.readFileSync(out);
  assert.deepEqual(sheetNames(buf), ['Tasks', 'Dashboard']);
  assert.equal(readSheet(buf, 'Tasks')[0][0], 'Task_ID');
});

test('CLI 首次运行自动迁移旧工作簿，且幂等', () => {
  const { dir, data, export: out } = cliFixture();
  const legacy = path.join(dir, 'project-tracker.xlsx');
  fs.copyFileSync(TRACKER, legacy);

  const first = runCli(['check', '--dir', data, '--legacy', legacy, '--today', '2026-09-30']);
  assert.match(first, /已从 .* 迁移 6 条事项/);
  assert.match(first, /分级: 逾期 1 ｜ 红 1 ｜ 橙 1 ｜ 黄 2 ｜ 绿 1/);

  const second = runCli(['check', '--dir', data, '--legacy', legacy, '--today', '2026-09-30']);
  assert.doesNotMatch(second, /迁移/, '第二次不应重复导入');
  assert.match(second, /快照: .*（6 条/);

  // 数据落在数据目录，而不是工作簿
  assert.ok(fs.existsSync(path.join(data, 'tasks.json')));
  assert.ok(fs.existsSync(path.join(data, 'events.ndjson')));
});

test('CLI add：快捷行录入，非法输入退出码 2', () => {
  const { data } = cliFixture();
  const out = runCli(['add', '横向课题B / 设备验收 / 其他 / 钱老师 / 10/20 / 高 / 30%', '--dir', data, '--today', '2026-09-30']);
  assert.match(out, /已新增 T-001/);
  assert.match(out, /截止 2026-10-20/);

  const list = runCli(['list', '--dir', data, '--today', '2026-09-30']);
  assert.match(list, /T-001/);
  assert.match(list, /横向课题B/);
  assert.match(list, /剩20天/);

  let code = 0;
  let stderr = '';
  try {
    runCli(['add', '只有一个字段', '--dir', data, '--today', '2026-09-30'], { stdio: 'pipe' });
  } catch (err) {
    code = err.status;
    stderr = err.stderr;
  }
  assert.equal(code, 2);
  assert.match(stderr, /无法录入/);
});

test('CLI add --paste：逐行报告，坏行不阻断好行', () => {
  const { data } = cliFixture();
  const text = '甲项目,写总结,2026-10-10\n乙项目,验收,下个月初';
  let code = 0;
  let stdout = '';
  try {
    stdout = runCli(['add', text, '--paste', '--dir', data, '--today', '2026-09-30']);
  } catch (err) {
    code = err.status;
    stdout = err.stdout;
  }
  assert.equal(code, 3, '存在坏行时应以 3 结束，但好行已写入');
  assert.match(stdout, /将新增 1 条/);
  assert.match(stdout, /无法识别日期/);
  const list = runCli(['list', '--dir', data, '--today', '2026-09-30']);
  assert.match(list, /写总结/);
  assert.doesNotMatch(list, /验收/);
});

test('CLI list：搜索、筛选、排序与 JSON 输出', () => {
  const { data } = cliFixture();
  runCli(['add', '国自然面上 / 提交结题报告 / 2026-10-03', '--dir', data, '--today', '2026-09-30']);
  runCli(['add', '横向课题A / 经费执行率核对 / 2026-09-29', '--dir', data, '--today', '2026-09-30']);
  runCli(['add', '国自然面上 / 发表论文标注审核 / 2026-11-10', '--dir', data, '--today', '2026-09-30']);

  const overdue = runCli(['list', '--level', 'overdue', '--dir', data, '--today', '2026-09-30']);
  assert.match(overdue, /经费执行率核对/);
  assert.doesNotMatch(overdue, /提交结题报告/);

  const search = runCli(['list', '--search', '经费', '--dir', data, '--today', '2026-09-30']);
  assert.match(search, /共 1 项/);

  const json = JSON.parse(runCli(['list', '--json', '--dir', data, '--today', '2026-09-30']));
  assert.equal(json.view.total, 3);
  assert.equal(json.metrics.red, 1);
  assert.equal(json.metrics.overdue, 1);
  assert.equal(json.view.counts.green, 1, '绿色计数在 view.counts 里');
  assert.equal(json.view.counts.overdue, 1);
});

test('CLI check：无异常时退出码 0，有未设截止日时退出码 3', () => {
  const { data } = cliFixture();
  runCli(['add', '甲 / 有截止日 / 2026-10-10', '--dir', data, '--today', '2026-09-30']);
  const ok = runCli(['check', '--dir', data, '--today', '2026-09-30']);
  assert.match(ok, /数据体检：无异常/);

  runCli(['add', '甲 / 没设截止日', '--dir', data, '--today', '2026-09-30']);
  let code = 0;
  let stdout = '';
  try {
    stdout = runCli(['check', '--dir', data, '--today', '2026-09-30']);
  } catch (err) {
    code = err.status;
    stdout = err.stdout;
  }
  assert.equal(code, 3);
  assert.match(stdout, /未设截止日期/);
});

test('CLI export 与 summary 分离：export 只写文件', () => {
  const { data, export: out } = cliFixture();
  runCli(['add', '甲 / 写总结 / 2026-10-10', '--dir', data, '--today', '2026-09-30']);
  const printed = runCli(['export', '--dir', data, '--today', '2026-09-30', '--export', out]);
  assert.match(printed, /已写入/);
  assert.ok(fs.existsSync(out));

  const quiet = runCli(['export', '--dir', data, '--today', '2026-09-30', '--export', out, '--quiet']);
  assert.equal(quiet.trim(), '', '--quiet 不应打印任何内容');
});

test('CLI --no-write：只看不写', () => {
  const { dir, data, export: out } = cliFixture();
  runCli(['add', '甲 / 写总结 / 2026-10-10', '--dir', data, '--today', '2026-09-30']);
  runCli(['summary', '--dir', data, '--today', '2026-09-30', '--export', out, '--no-write']);
  assert.ok(!fs.existsSync(out));
  assert.ok(!fs.existsSync(path.join(dir, 'out')));
});

test('CLI --today 覆盖基准日期', () => {
  const { data } = cliFixture();
  runCli(['add', '甲 / 写总结 / 2026-10-10', '--dir', data, '--today', '2026-10-01']);
  const early = runCli(['list', '--dir', data, '--today', '2026-10-01']);
  assert.match(early, /剩9天/);
  const late = runCli(['list', '--dir', data, '--today', '2026-10-20']);
  assert.match(late, /逾期10天/);
});

test('CLI 参数错误：未知子命令与非法日期都以 2 结束', () => {
  const { data } = cliFixture();
  const bad = (args) => {
    try {
      runCli(args, { stdio: 'pipe' });
      return 0;
    } catch (err) {
      return err.status;
    }
  };
  assert.equal(bad(['nosuch', '--dir', data]), 2);
  assert.equal(bad(['list', '--dir', data, '--today', '2026/10/01']), 2);
});
