/**
 * 录入解析与权威存储的回归测试。
 *
 * 重点覆盖最容易静默出错的地方：日期自然语言解析、越界进度、乱序粘贴、
 * 存储的原子写/串行化/软删除、迁移幂等。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { writeXlsx } from '../lib/xlsx.mjs';

// 引擎与存储用绝对 file URL 导入：本环境 ESM 解析器对上越包边界的 `../` 会丢一段路径。
const LIB = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib')).href;
const {
  alertOf, createRecord, isIsoDate, nextTaskId, normalizeProgress, normalizeTaskInput, toTaskRow,
} = await import(`${LIB}/tasks.mjs`);
const { classifyToken, normalizeText, parseCnNumber, parseDate, parsePaste, parseQuickLine } = await import(`${LIB}/query.mjs`);
const { openStore, defaultDataDir, StoreError } = await import(`${LIB}/store.mjs`);
const { buildMetrics, buildProjects, buildView, decorate } = await import(`${LIB}/read.mjs`);
const { buildTasksSheet, orderForExport } = await import(`${LIB}/export.mjs`);
const { readSheet, sheetNames } = await import(`${LIB}/xlsx.mjs`);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pm-store-'));
}

/* ============================================================ 日期解析 */

test('日期解析：ISO / 斜杠 / 点号 / 中文数字', () => {
  const base = '2026-09-30';
  assert.equal(parseDate('2026-10-20', base).date, '2026-10-20');
  assert.equal(parseDate('2026/10/20', base).date, '2026-10-20');
  assert.equal(parseDate('2026.10.20', base).date, '2026-10-20');
  assert.equal(parseDate('10/20', base).date, '2026-10-20');
  assert.equal(parseDate('10月20日', base).date, '2026-10-20');
  assert.equal(parseDate('十月二十日', base).date, '2026-10-20');
  assert.equal(parseDate('10月5号', base).date, '2026-10-05');
});

test('日期解析：未来优先（缺省年份）', () => {
  // 12 月的基准下，1/5 应指明年
  assert.equal(parseDate('1/5', '2026-12-20').date, '2027-01-05');
  // 同月内已过去的日期同样顺延到明年
  assert.equal(parseDate('9/1', '2026-09-30').date, '2027-09-01');
});

test('日期解析：相对日与周几', () => {
  const base = '2026-09-30'; // 周三
  assert.equal(parseDate('今天', base).date, '2026-09-30');
  assert.equal(parseDate('明天', base).date, '2026-10-01');
  assert.equal(parseDate('后天', base).date, '2026-10-02');
  assert.equal(parseDate('3天后', base).date, '2026-10-03');
  assert.equal(parseDate('三天以后', base).date, '2026-10-03');
  assert.equal(parseDate('两周后', base).date, '2026-10-14');
  assert.equal(parseDate('周五', base).date, '2026-10-02');
  assert.equal(parseDate('下周一', base).date, '2026-10-05');
  assert.equal(parseDate('下周五', base).date, '2026-10-09');
  assert.equal(parseDate('星期日', base).date, '2026-10-04');
  assert.equal(parseDate('下个月', base).date, '2026-10-01');
  assert.equal(parseDate('月底', base).date, '2026-09-30');
});

test('日期解析：非法输入明确报错而非猜日期', () => {
  for (const bad of ['下个月初', '月底前', '越快越好', '待定', '2026-02-31', '13/45']) {
    const r = parseDate(bad, '2026-09-30');
    assert.equal(r.ok, false, `${bad} 不应被解析成功`);
    assert.ok(r.reason.includes('无法识别') || r.reason.includes('不是有效日期'), r.reason);
  }
});

test('isIsoDate 拒绝不存在的日期', () => {
  assert.ok(isIsoDate('2026-02-28'));
  assert.ok(isIsoDate('2028-02-29'));
  assert.ok(!isIsoDate('2026-02-29'));
  assert.ok(!isIsoDate('2026-13-01'));
  assert.ok(!isIsoDate('2026-1-1'));
});

test('中文数字解析', () => {
  assert.equal(parseCnNumber('十'), 10);
  assert.equal(parseCnNumber('十五'), 15);
  assert.equal(parseCnNumber('二十'), 20);
  assert.equal(parseCnNumber('二十三'), 23);
  assert.equal(parseCnNumber('3'), 3);
  assert.equal(parseCnNumber('abc'), null);
});

test('normalizeText 处理全角与零宽字符', () => {
  assert.equal(normalizeText('１０月２０日'), '10月20日');
  assert.equal(normalizeText('　进行中　'), '进行中');
  assert.equal(normalizeText('张\u200b老师'), '张老师');
});

/* ========================================================== 快捷行解析 */

test('快捷行：位置参数', () => {
  const r = parseQuickLine('横向课题B / 设备验收 / 其他 / 钱老师 / 2026-10-20 / 高 / 30%', '2026-09-30');
  assert.ok(r.ok, r.errors.join('；'));
  assert.equal(r.record.project, '横向课题B');
  assert.equal(r.record.name, '设备验收');
  assert.equal(r.record.category, '其他');
  assert.equal(r.record.owner, '钱老师');
  assert.equal(r.record.due, '2026-10-20');
  assert.equal(r.record.priority, '高');
  assert.equal(r.record.progress, 0.3);
});

test('快捷行：字段乱序也能归位（且 10/8 不被切碎）', () => {
  const r = parseQuickLine('甲项目 / 报奖材料 / 10/8 / 高 / 李老师 / 结题', '2026-09-30');
  assert.ok(r.ok, r.errors.join('；'));
  assert.equal(r.record.due, '2026-10-08', '10/8 必须整体解析为日期，不能被分隔符切碎');
  assert.equal(r.record.priority, '高');
  assert.equal(r.record.owner, '李老师');
  assert.equal(r.record.category, '结题');
});

test('快捷行：最少只需项目 + 事项', () => {
  const r = parseQuickLine('甲项目 / 写总结', '2026-09-30');
  assert.ok(r.ok);
  assert.equal(r.record.name, '写总结');
  assert.equal(r.record.due, undefined);
});

test('快捷行：缺少必填项与非法取值都报错', () => {
  const missing = parseQuickLine('只有项目名', '2026-09-30');
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => e.includes('无法区分')), missing.errors.join('；'));

  // 两段但第二段为空 → 视为缺少事项名
  const half = parseQuickLine('甲项目 / ', '2026-09-30');
  assert.equal(half.ok, false);

  const badDate = parseQuickLine('甲 / 乙 / 下个月初', '2026-09-30');
  assert.equal(badDate.ok, false);
  assert.ok(badDate.errors.some((e) => e.includes('无法识别日期')), badDate.errors.join('；'));

  const badProgress = parseQuickLine('甲 / 乙 / 150%', '2026-09-30');
  assert.equal(badProgress.ok, false);
  assert.ok(badProgress.errors.some((e) => e.includes('进度')), badProgress.errors.join('；'));
});

test('快捷行：额外纯文本按 负责人 → 备注 归位', () => {
  const r = parseQuickLine('甲项目 / 中期检查 / 王老师 / 10/15 / 需要合作单位数据', '2026-09-30');
  assert.ok(r.ok, r.errors.join('；'));
  assert.equal(r.record.owner, '王老师');
  assert.equal(r.record.notes, '需要合作单位数据');
  assert.equal(r.record.due, '2026-10-15');
});

test('classifyToken 区分枚举/日期/进度/文本', () => {
  assert.deepEqual(classifyToken('高', '2026-09-30'), { kind: 'priority', value: '高', raw: '高' });
  assert.equal(classifyToken('结题', '2026-09-30').kind, 'category');
  assert.equal(classifyToken('待审核', '2026-09-30').kind, 'status');
  assert.equal(classifyToken('30%', '2026-09-30').kind, 'progress');
  assert.equal(classifyToken('10/20', '2026-09-30').kind, 'date');
  assert.equal(classifyToken('赵老师', '2026-09-30').kind, 'text');
  assert.equal(classifyToken('下个月初', '2026-09-30').kind, 'invalid');
});

/* ========================================================== 批量粘贴 */

test('批量粘贴：制表符与逗号皆可', () => {
  const text = [
    '甲项目\t结题报告\t结题\t张老师\t2026-10-03\t进行中\t高\t60%',
    '乙项目,中期检查,汇报,李老师,2026-10-07,进行中,中,40%',
    '丙项目,设备验收,,,2026-10-15,,,0',
  ].join('\n');
  const r = parsePaste(text, '2026-09-30');
  assert.equal(r.rows.length, 3);
  assert.equal(r.okCount, 3, JSON.stringify(r.rows.map((x) => x.errors)));
  assert.equal(r.rows[0].record.project, '甲项目');
  assert.equal(r.rows[0].record.due, '2026-10-03');
  assert.equal(r.rows[0].record.progress, 0.6);
  assert.equal(r.rows[1].record.category, '汇报');
  assert.equal(r.rows[2].record.name, '设备验收');
});

test('批量粘贴：坏行不影响好行，并给出原因', () => {
  const text = ['甲项目,写总结,2026-10-10', '乙项目,验收,下个月初', '丙项目,评审'].join('\n');
  const r = parsePaste(text, '2026-09-30');
  assert.equal(r.okCount, 1);
  assert.equal(r.badCount, 2);
  const bad = r.rows.filter((x) => !x.ok);
  assert.ok(bad[0].errors.some((e) => e.includes('无法识别日期')), JSON.stringify(bad[0].errors));
  assert.ok(bad[1].errors.some((e) => e.includes('截止日期')), JSON.stringify(bad[1].errors));
});

/* ============================================================ 字段规范化 */

test('normalizeProgress 接受三种写法并拒绝越界', () => {
  assert.equal(normalizeProgress('30%'), 0.3);
  assert.equal(normalizeProgress('0.3'), 0.3);
  assert.equal(normalizeProgress(30), 0.3);
  assert.equal(normalizeProgress(1), 1);
  assert.equal(normalizeProgress('100%'), 1);
  assert.equal(normalizeProgress('150%'), null);
  assert.equal(normalizeProgress('abc'), null);
  assert.equal(normalizeProgress(''), null);
});

test('normalizeTaskInput：状态与进度保持一致', () => {
  const done = normalizeTaskInput({ name: 'a', project: 'p', status: '已完成' });
  assert.ok(done.ok);
  assert.equal(done.record.progress, 1);

  const notStarted = normalizeTaskInput({ name: 'a', project: 'p', status: '未开始', progress: '50%' });
  assert.equal(notStarted.record.progress, 0);

  const invalid = normalizeTaskInput({ name: 'a', project: 'p', category: '报奖', priority: '毛毛' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.errors.length, 2);
});

test('normalizeTaskInput：历史/口语写法走别名规整并记录原因', () => {
  const legacy = normalizeTaskInput({ name: 'a', project: 'p', status: '已逾期' });
  assert.ok(legacy.ok, '旧表里的「已逾期」不应让整行失败');
  assert.equal(legacy.record.status, '进行中');
  assert.ok(legacy.coercions.some((c) => c.includes('已逾期')), legacy.coercions.join('；'));

  const spoken = normalizeTaskInput({ name: 'a', project: 'p', priority: '紧急', category: '报销' });
  assert.equal(spoken.record.priority, '高');
  assert.equal(spoken.record.category, '经费');
});

test('normalizeTaskInput：日期与顺序校验', () => {
  const bad = normalizeTaskInput({ name: 'a', project: 'p', start: '2026-10-10', due: '2026-10-01' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('早于')), bad.errors.join('；'));

  const text = normalizeTaskInput({ name: 'a', project: 'p', due: '10月20日' });
  assert.equal(text.ok, false);
  assert.ok(text.errors.some((e) => e.includes('YYYY-MM-DD')));
});

test('nextTaskId 取最大序号递增', () => {
  assert.equal(nextTaskId([]), 'T-001');
  assert.equal(nextTaskId([{ id: 'T-003' }, { id: 'T-011' }]), 'T-012');
});

test('alertOf 与分级口径', () => {
  assert.deepEqual(alertOf({ status: '进行中', due: '2026-09-29' }, '2026-09-30'), { level: 'overdue', days: -1 });
  assert.deepEqual(alertOf({ status: '进行中', due: '2026-10-03' }, '2026-09-30'), { level: 'red', days: 3 });
  assert.deepEqual(alertOf({ status: '进行中', due: '2026-10-31' }, '2026-09-30'), { level: 'green', days: 31 });
  assert.deepEqual(alertOf({ status: '已完成', due: '2026-01-01' }, '2026-09-30'), { level: null, days: null });
  assert.deepEqual(alertOf({ status: '未开始', due: null }, '2026-09-30'), { level: 'unscheduled', days: null });
});

test('toTaskRow 兼容导出所需的 Tasks 表列名', () => {
  const row = toTaskRow({ id: 'T-001', project: 'p', name: 'n', category: '其他', owner: 'o', start: null, due: '2026-10-01', status: '进行中', priority: '高', progress: 0.5, notes: null });
  assert.equal(row.Task_ID, 'T-001');
  assert.equal(row.Due_Date, '2026-10-01');
  assert.equal(row.Notes, '');
});

/* ============================================================== 存储 */

test('存储：写入即落盘，可被新实例读回', async () => {
  const dir = tmpDir();
  const s1 = openStore({ dir });
  const a = await s1.create({ name: '写总结', project: '甲项目', due: '2026-10-10' });
  assert.equal(a.id, 'T-001');
  const b = await s1.create({ name: '验收', project: '甲项目', due: '2026-10-20' });
  assert.equal(b.id, 'T-002');
  await s1.flush();

  const s2 = openStore({ dir });
  const tasks = s2.allTasks();
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].name, '写总结');
  assert.ok(fs.existsSync(path.join(dir, 'tasks.json')));
  assert.ok(fs.existsSync(path.join(dir, 'events.ndjson')));
  const events = fs.readFileSync(path.join(dir, 'events.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'create');
  assert.equal(events[0].seq, 1);
});

test('存储：首次写入前会留一份当日备份', async () => {
  const dir = tmpDir();
  const s = openStore({ dir });
  await s.create({ name: 'a', project: 'p' });
  await s.flush();
  // 第二天再写
  const s2 = openStore({ dir, now: () => new Date('2026-10-02T09:00:00') });
  await s2.create({ name: 'b', project: 'p' });
  await s2.flush();
  const backups = fs.readdirSync(path.join(dir, 'backups'));
  assert.equal(backups.length, 1);
  assert.equal(backups[0], '2026-10-02.json');
  const snap = JSON.parse(fs.readFileSync(path.join(dir, 'backups', '2026-10-02.json'), 'utf8'));
  assert.equal(snap.tasks.length, 1, '备份应是写入前的状态');
});

test('存储：并发写入被串行化，不丢数据', async () => {
  const dir = tmpDir();
  const s = openStore({ dir });
  await Promise.all(Array.from({ length: 25 }, (_, i) => s.create({ name: `任务${i}`, project: '并发项目' })));
  await s.flush();
  const tasks = s.allTasks();
  assert.equal(tasks.length, 25);
  assert.equal(new Set(tasks.map((t) => t.id)).size, 25, 'Task_ID 不应重复');
  const reread = openStore({ dir }).allTasks();
  assert.equal(reread.length, 25, '落盘结果应与内存一致');
});

test('存储：校验失败不写入，错误信息可读', async () => {
  const dir = tmpDir();
  const s = openStore({ dir });
  await assert.rejects(() => s.create({ name: '', project: '' }), (err) => {
    assert.ok(err instanceof StoreError);
    assert.equal(err.code, 'VALIDATION');
    assert.ok(err.message.includes('事项名称'));
    return true;
  });
  await s.flush();
  assert.equal(s.allTasks().length, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'tasks.json')), '没有任何成功写入时不应产生快照');
});

test('存储：批量新增要么全成功要么全不写', async () => {
  const dir = tmpDir();
  const s = openStore({ dir });
  await assert.rejects(
    () => s.createMany([{ name: 'a', project: 'p' }, { name: 'b', project: 'p', category: '报奖' }]),
    /第 2 条/,
  );
  await s.flush();
  assert.equal(s.allTasks().length, 0);
  const ok = await s.createMany([{ name: 'a', project: 'p' }, { name: 'b', project: 'p' }]);
  assert.equal(ok.length, 2);
});

test('存储：更新、软删除、恢复', async () => {
  const dir = tmpDir();
  const s = openStore({ dir });
  const t = await s.create({ name: '写总结', project: '甲', due: '2026-10-10' });

  const updated = await s.update(t.id, { progress: '80%', status: '进行中' });
  assert.equal(updated.progress, 0.8);
  assert.equal(updated.updatedAt >= updated.createdAt, true);

  const done = await s.update(t.id, { status: '已完成' });
  assert.equal(done.progress, 1);
  assert.ok(done.completedAt);

  await s.remove(t.id);
  assert.equal(s.allTasks().length, 0);
  assert.equal(s.snapshot().tasks.length, 1, '软删除仍保留原始记录');
  assert.ok(s.snapshot().tasks[0].deletedAt);

  await s.restore(t.id);
  assert.equal(s.allTasks().length, 1);
  await s.flush();

  const types = fs.readFileSync(path.join(dir, 'events.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).type);
  assert.deepEqual(types, ['create', 'update', 'update', 'delete', 'restore']);
});

test('存储：按名称也能找到并更新；找不到时报 NOT_FOUND', async () => {
  const dir = tmpDir();
  const s = openStore({ dir });
  await s.create({ name: '中期检查材料汇总', project: '乙' });
  const updated = await s.update('中期检查材料汇总', { priority: '高' });
  assert.equal(updated.priority, '高');
  await assert.rejects(() => s.update('不存在的事项', {}), (err) => err.code === 'NOT_FOUND');
});

test('存储：批量更新同一 patch', async () => {
  const dir = tmpDir();
  const s = openStore({ dir });
  const a = await s.create({ name: 'a', project: '甲' });
  const b = await s.create({ name: 'b', project: '甲' });
  const out = await s.updateMany([a.id, b.id], { owner: '赵老师', status: '待审核' });
  assert.equal(out.length, 2);
  assert.ok(out.every((t) => t.owner === '赵老师' && t.status === '待审核'));
});

test('存储：schemaVersion 不匹配时明确拒绝', async () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({ schemaVersion: 99, tasks: [] }));
  assert.throws(() => openStore({ dir }).allTasks(), (err) => err.code === 'STORE_VERSION');
});

test('存储：快照损坏时报 STORE_UNREADABLE', async () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tasks.json'), '{ 这不是 json');
  assert.throws(() => openStore({ dir }).allTasks(), (err) => err.code === 'STORE_UNREADABLE');
});

test('defaultDataDir 跟随 DSH_HOME', () => {
  assert.equal(defaultDataDir({ DSH_HOME: '/tmp/dsh-home' }), '/tmp/dsh-home/project-monitor');
  assert.ok(defaultDataDir({}).endsWith(path.join('.dsh', 'project-monitor')));
});

/* ============================================================== 迁移 */

/** 与宿主 `readLegacyRows` 同构的读取器：把工作簿 Tasks 表读成行对象。 */
function legacyReader(file) {
  const rows = readSheet(fs.readFileSync(file), 'Tasks');
  const header = (rows[0] ?? []).map((c) => String(c ?? '').trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const obj = {};
    header.forEach((h, c) => {
      const cell = row[c];
      obj[h] = cell !== null && cell !== undefined && typeof cell === 'object' && cell.date ? cell.date : cell;
    });
    out.push(obj);
  }
  return out;
}

function legacyWorkbook(file) {
  const header = ['Task_ID', 'Project_Name', 'Task_Name', 'Category', 'Owner', 'Start_Date', 'Due_Date', 'Status', 'Priority', 'Progress', 'Notes'];
  const toCells = (r) => r.map((v) => {
    // 日期列写成真正的日期单元格（与 openpyxl 产出的旧工作簿一致）
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return { v: { date: v }, style: { fmt: 'date' } };
    }
    return { v };
  });
  const rows = [
    header.map((v) => ({ v })),   // 表头是普通字符串，不要再包一层
    toCells(['T-001', '国家自然科学基金面上项目', '提交结题报告', '结题', '张老师', '2026-09-01', '2026-10-03', '进行中', '高', 0.6, '需先完成经费决算']),
    toCells(['T-004', '横向课题A', '经费执行率核对', '经费', '赵老师', '2026-09-05', '2026-09-29', '已逾期', '高', 0.8, '财务系统数据待导出']),
    toCells(['T-099', '脏数据项目', '日期是文本', '其他', '', null, '下个月初', '进行中', '低', 0.2, '']),
  ];
  const buf = writeXlsx({ sheetName: 'Tasks', widths: [10, 20, 20, 10, 10, 12, 12, 10, 10, 10, 20], rows });
  fs.writeFileSync(file, buf);
  return file;
}

test('迁移：从旧工作簿导入，保留原 Task_ID，坏行只记录不阻断', async () => {
  const dir = tmpDir();
  const wb = legacyWorkbook(path.join(dir, 'project-tracker.xlsx'));
  const s = openStore({ dir: path.join(dir, 'data') });
  const result = await s.migrateFromWorkbook(wb, legacyReader);
  assert.equal(result.migrated, 2, '两条有效记录都要迁移进来（含状态为「已逾期」的那条）');
  assert.equal(result.problems.length, 1, '只有日期为文本的那行算问题');
  assert.match(result.problems[0], /下个月初/);
  const tasks = s.allTasks();
  assert.deepEqual(tasks.map((t) => t.id), ['T-001', 'T-004']);
  assert.equal(tasks[0].name, '提交结题报告');
  assert.equal(tasks[0].due, '2026-10-03');
  assert.equal(tasks[1].status, '进行中', '旧状态「已逾期」应被规整为「进行中」（逾期由截止日派生）');
  await s.flush();
});

test('迁移：幂等（已有数据 / 已迁移 / 文件不存在都不重复导入）', async () => {
  const dir = tmpDir();
  const dataDir = path.join(dir, 'data');
  const wb = legacyWorkbook(path.join(dir, 'project-tracker.xlsx'));
  const reader = legacyReader;

  const s1 = openStore({ dir: dataDir });
  const first = await s1.migrateFromWorkbook(wb, reader);
  assert.equal(first.migrated, 2);
  const second = await s1.migrateFromWorkbook(wb, reader);
  assert.equal(second.migrated, 0);
  assert.equal(second.skipped, 'store-not-empty', '已有数据时不再迁移（比 already-migrated 更准确的因由）');
  await s1.flush();
  assert.equal(openStore({ dir: dataDir }).allTasks().length, 2);

  const s2 = openStore({ dir: tmpDir() });
  const missing = await s2.migrateFromWorkbook('/nope/missing.xlsx', reader);
  assert.equal(missing.skipped, 'workbook-missing');

  const s3 = openStore({ dir: tmpDir() });
  await s3.create({ name: '已有事项', project: 'p' });
  const skipped = await s3.migrateFromWorkbook(wb, reader);
  assert.equal(skipped.skipped, 'store-not-empty');

  // 空存储但已标记迁移过（例如用户清空了事项）→ 不重复导入
  const dataDir2 = tmpDir();
  const s4 = openStore({ dir: dataDir2 });
  await s4.migrateFromWorkbook(wb, reader);
  await s4.flush();
  const snapFile = path.join(dataDir2, 'tasks.json');
  const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  snap.tasks = [];
  fs.writeFileSync(snapFile, JSON.stringify(snap, null, 2));
  const s5 = openStore({ dir: dataDir2 });
  const again = await s5.migrateFromWorkbook(wb, reader);
  assert.equal(again.migrated, 0);
  assert.equal(again.skipped, 'already-migrated');
});

/* ============================================================ 读模型 */

function sampleTasks() {
  return [
    { id: 'T-001', name: '提交结题报告', project: '国自然面上', owner: '张老师', category: '结题', status: '进行中', priority: '高', progress: 0.6, start: '2026-09-01', due: '2026-10-03', notes: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', completedAt: null, deletedAt: null },
    { id: 'T-002', name: '经费执行率核对', project: '横向课题A', owner: '赵老师', category: '经费', status: '进行中', priority: '高', progress: 0.8, start: '2026-09-05', due: '2026-09-29', notes: null, createdAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z', completedAt: null, deletedAt: null },
    { id: 'T-003', name: '写论文', project: '国自然面上', owner: '张老师', category: '其他', status: '已完成', priority: '低', progress: 1, start: null, due: '2026-09-01', notes: null, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z', completedAt: '2026-09-02T00:00:00Z', deletedAt: null },
    { id: 'T-004', name: '无截止日的事', project: '横向课题A', owner: null, category: '其他', status: '未开始', priority: '中', progress: 0, start: null, due: null, notes: null, createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z', completedAt: null, deletedAt: null },
  ];
}

test('读模型：分级、指标与项目维度', () => {
  const today = '2026-09-30';
  const decorated = sampleTasks().map((t) => decorate(t, today));
  const metrics = buildMetrics(decorated, today);
  assert.equal(metrics.total, 4);
  assert.equal(metrics.done, 1);
  assert.equal(metrics.doing, 2);
  assert.equal(metrics.overdue, 1);
  assert.equal(metrics.red, 1);
  assert.equal(metrics.unscheduled, 1);

  const projects = buildProjects(decorated);
  assert.equal(projects[0].name, '横向课题A');
  assert.equal(projects[0].overdue, 1);
  assert.equal(projects[0].total, 2);
  assert.equal(projects[0].done, 0);
});

test('读模型：搜索、筛选、排序、分组与分页', () => {
  const today = '2026-09-30';
  const tasks = sampleTasks();

  const all = buildView(tasks, today, {});
  assert.equal(all.total, 4);
  assert.equal(all.groups.find((g) => g.id === 'overdue').count, 1);
  assert.equal(all.groups.find((g) => g.id === 'done').count, 1);
  assert.equal(all.groups.find((g) => g.id === 'unscheduled').count, 1);
  // 默认按截止日：无截止日的排最后，因此已完成但仍有日期的 T-003 在 T-004 之前
  assert.deepEqual(all.items.map((t) => t.id), ['T-003', 'T-002', 'T-001', 'T-004']);

  const searched = buildView(tasks, today, { search: '经费' });
  assert.equal(searched.total, 1);
  assert.equal(searched.items[0].id, 'T-002');

  const byOwner = buildView(tasks, today, { owner: '赵老师' });
  assert.equal(byOwner.total, 1);

  const active = buildView(tasks, today, { status: 'active' });
  assert.equal(active.total, 3);

  const red = buildView(tasks, today, { level: 'red' });
  assert.equal(red.total, 1);
  assert.equal(red.items[0].name, '提交结题报告');

  const paged = buildView(tasks, today, { limit: 2, offset: 0 });
  assert.equal(paged.items.length, 2);
  assert.equal(paged.hasMore, true);
  assert.equal(paged.total, 4, 'total 应是匹配总数而非页大小');
  // 分页不得截断分组：面板按分组渲染，组内被截断会直接导致"说有 12 项却只显示 1 条"
  assert.equal(paged.groups.find((g) => g.id === 'overdue').count, 1);
  assert.equal(paged.groups.find((g) => g.id === 'done').count, 1);
  assert.equal(
    paged.groups.reduce((n, g) => n + g.count, 0),
    4,
    '各分组 count 之和应等于匹配总数（只有未设截止/已完成/五级全覆盖时成立）',
  );

  const byPriority = buildView(tasks, today, { sort: 'priority' });
  assert.equal(byPriority.items[0].priority, '高');

  assert.deepEqual(all.facets.projects, ['国自然面上', '横向课题A'].sort((a, b) => a.localeCompare(b, 'zh')));
});

test('摘要：紧迫任务支持存储风格字段（回归：曾渲染出 undefined）', async () => {
  const { renderSummary } = await import(`${LIB}/dashboard.mjs`);
  const today = '2026-09-30';
  const decorated = sampleTasks().map((t) => decorate(t, today));
  const active = decorated.filter((t) => !t.done);
  const groups = {};
  for (const level of ['overdue', 'red', 'orange', 'yellow', 'green']) {
    groups[level] = active.filter((t) => t.level === level);
  }
  const md = renderSummary({
    today,
    metrics: buildMetrics(decorated, today),
    groups,
    projects: buildProjects(decorated),
    active,
    urgent: active.filter((t) => t.days !== null).sort((a, b) => a.days - b.days).slice(0, 3),
    invalid: [],
    duplicates: [],
    topGreen: 10,
  });
  assert.doesNotMatch(md, /undefined/, '摘要不得出现 undefined');
  assert.match(md, /\*\*T-002\*\* 经费执行率核对（横向课题A · 赵老师）/);
});

/* ============================================================ 导出 */

test('导出：Tasks 表行为与排序（未完成在前）', () => {
  const tasks = sampleTasks();
  const ordered = orderForExport(tasks);
  assert.deepEqual(ordered.map((t) => t.id), ['T-002', 'T-001', 'T-004', 'T-003'], '未完成按截止日在前、无日期次之、已完成最后');
  const sheet = buildTasksSheet(tasks);
  assert.equal(sheet.name, 'Tasks');
  assert.equal(sheet.rows[0][0].v, 'Task_ID');
  assert.equal(sheet.rows.length, 5);
});

test('导出：工作簿含 Tasks + Dashboard 两张表且可读回', async () => {
  const { buildWorkbook } = await import(`${LIB}/export.mjs`);
  const today = '2026-09-30';
  const tasks = sampleTasks();
  const decorated = tasks.map((t) => decorate(t, today));
  const buf = buildWorkbook(
    { decorated, metrics: buildMetrics(decorated, today), projects: buildProjects(decorated), today },
    tasks,
  );
  assert.deepEqual(sheetNames(buf), ['Tasks', 'Dashboard']);
  const dash = readSheet(buf, 'Dashboard');
  assert.equal(dash[0][0], '总任务数');
  assert.equal(dash[1][3], 1, '已逾期数应为 1');
  assert.deepEqual(dash[1][7], { date: '2026-09-30' });
  const taskSheet = readSheet(buf, 'Tasks');
  assert.equal(taskSheet[0][0], 'Task_ID');
  assert.equal(taskSheet[1][6].date, '2026-09-29', 'Tasks 表按截止日排序，首行应是 T-002');
  assert.ok(taskSheet.some((r) => r[0] === 'T-002'));
});
