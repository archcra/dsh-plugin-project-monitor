/**
 * 宿主半侧（plugin/index.js）的集成测试。
 *
 * 做法：用真实 DSH 运行时里的 `@deepseek-ai/schemastery`（由 scripts/vendor.mjs
 * 从 app.asar 本地化），以一个假的 cordis 上下文调用 `apply()`，直接驱动注册出来
 * 的 HTTP 路由。覆盖迁移 → 视图 → 新增 → 改期/改进度 → 完成 → 删除/恢复 →
 * 解析 → 导出。每个用例使用独立的临时数据目录，互不干扰。
 *
 * 读不到 DSH 应用包时自动跳过（例如未安装桌面端的机器）。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.dirname(HERE);
const WORKSPACE = path.dirname(PLUGIN);
const TRACKER = path.join(WORKSPACE, 'project-tracker.xlsx');
const ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';

/**
 * 包内模块一律用绝对 file URL 导入：本环境的 ESM 解析器对 `../` 上越包边界的
 * 说明符会丢掉一段路径，绝对 URL 不受影响。
 */
const url = (rel) => pathToFileURL(path.join(PLUGIN, rel)).href;
const INDEX_URL = url('index.js');
const XLSX_URL = url('lib/xlsx.mjs');

const haveDsH = fs.existsSync(ASAR);
const skip = haveDsH ? false : '未找到 DSH 应用包（app.asar），跳过宿主集成测试';

/** 确保宿主半侧需要的 `@deepseek-ai/schemastery` 已本地化（见 scripts/vendor.mjs）。 */
function setupRuntimeDeps() {
  execFileSync(process.execPath, [path.join(PLUGIN, 'scripts', 'vendor.mjs')], { stdio: 'pipe' });
}

if (haveDsH) setupRuntimeDeps();
const mod = await import(INDEX_URL);

/* ------------------------------------------------------------- 夹具 */

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pm-host-'));
}

/** 假 res：记录状态码、响应头与响应体。 */
function fakeRes() {
  const state = { status: 0, headers: null, body: '' };
  return {
    state,
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers;
    },
    end(chunk) {
      if (chunk) state.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    },
  };
}

/** 假 cordis 上下文：收集 disposer、记录日志、捕获注册的路由。 */
function fakeCtx() {
  const routes = [];
  const disposers = [];
  const logs = [];
  return {
    routes,
    disposers,
    logs,
    webServer: {
      register(route) {
        routes.push(route);
        return () => {
          const i = routes.indexOf(route);
          if (i >= 0) routes.splice(i, 1);
        };
      },
    },
    effect(fn, label) {
      const dispose = fn();
      disposers.push({ dispose, label });
      return dispose;
    },
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
    },
    get: () => undefined,
    on: () => () => {},
  };
}

/** 可注入请求体的假 req。 */
function fakeReq(url, method = 'GET', body) {
  const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  return {
    url,
    method,
    async *[Symbol.asyncIterator]() {
      if (payload) yield payload;
    },
  };
}

/** 驱动已注册的路由，返回 { res, json, status }。 */
async function call(ctx, pathname, { method = 'GET', body } = {}) {
  const route = ctx.routes[0];
  assert.ok(route, '未注册任何路由');
  const res = fakeRes();
  await route.handler(fakeReq(pathname, method, body), res);
  let json = null;
  try {
    json = JSON.parse(res.state.body);
  } catch {
    json = null;
  }
  return { res, json, status: res.state.status };
}

/** 按 Config 真实解析一份配置（cordis 交给 apply 的就是这种普通对象）。 */
function makeConfig(values = {}) {
  return new mod.Config(values);
}

/** 起一个带独立数据目录的宿主实例。 */
function boot(dir, extra = {}) {
  const ctx = fakeCtx();
  const config = makeConfig({
    dataDir: dir,
    exportWorkbook: path.join(dir, 'dashboard.xlsx'),
    // legacyWorkbook 留空 = 让插件自动探测；确需屏蔽时显式传一个不存在的路径
    cacheTtlMs: 0,
    ...extra,
  });
  mod.apply(ctx, config);
  return { ctx, config };
}

/** 等迁移/首次导出这类后台工作落定。 */
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/** 轮询 /view 直到迁移完成或超时。 */
async function waitForMigration(ctx, min = 1) {
  for (let i = 0; i < 60; i++) {
    const { json } = await call(ctx, '/project-monitor/api/view');
    if (json?.view?.total >= min) return json;
    await settle(25);
  }
  const { json } = await call(ctx, '/project-monitor/api/view');
  return json;
}

/* ============================================================ 基础 */

test('宿主插件导出 name / inject / Config / apply', { skip }, async () => {
  assert.equal(mod.name, 'project-monitor');
  assert.deepEqual(mod.inject, ['webServer']);
  assert.ok(mod.Config, '缺少 Config 导出');
  assert.equal(typeof mod.apply, 'function');
});

test('register 被调用，路由前缀为 /project-monitor/api', { skip }, async () => {
  const { ctx } = boot(tmpDir());
  assert.equal(ctx.routes.length, 1);
  assert.equal(ctx.routes[0].kind, 'prefix');
  assert.equal(ctx.routes[0].path, '/project-monitor/api');
  assert.equal(ctx.disposers.length, 1);
  ctx.disposers[0].dispose();
  assert.equal(ctx.routes.length, 0);
});

/* ======================================================== 空存储起步 */

test('空存储：/view 结构完整但为空', { skip }, async () => {
  const { ctx } = boot(tmpDir(), { legacyWorkbook: '/nonexistent/blocked.xlsx' });
  await settle();
  const { status, json } = await call(ctx, '/project-monitor/api/view');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.view.total, 0);
  assert.equal(json.metrics.total, 0);
  assert.equal(json.view.groups.length, 7, '七个分组（含未设截止日期与已完成）');
  assert.deepEqual(json.projects, []);
});

test('/health 报告数据目录与存储统计', { skip }, async () => {
  const dir = tmpDir();
  const { ctx } = boot(dir);
  await settle();
  const { status, json } = await call(ctx, '/project-monitor/api/health');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.dataDir, dir);
  assert.equal(json.store.total, 0);
  assert.ok(json.store.snapshotFile.endsWith('tasks.json'));
});

/* ============================================================ 录入 */

test('新增：合法输入返回 201 并出现在视图里', { skip }, async () => {
  const dir = tmpDir();
  const { ctx } = boot(dir, { todayOverride: '2026-09-30' });
  await settle();
  const created = await call(ctx, '/project-monitor/api/tasks', {
    method: 'POST',
    body: { name: '提交结题报告', project: '国自然面上', due: '2026-10-03', priority: '高', owner: '张老师' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.task.id, 'T-001');
  assert.equal(created.json.task.progress, 0);

  const { json } = await call(ctx, '/project-monitor/api/view');
  assert.equal(json.view.total, 1);
  const item = json.view.items[0];
  assert.equal(item.name, '提交结题报告');
  assert.equal(item.level, 'red');
  assert.equal(item.days, 3);
  assert.ok(fs.existsSync(path.join(dir, 'tasks.json')));
  assert.ok(fs.existsSync(path.join(dir, 'events.ndjson')));
});

test('新增：非 ISO 日期被拒（存储只接受权威格式）', { skip }, async () => {
  const { ctx } = boot(tmpDir(), { todayOverride: '2026-09-30' });
  await settle();
  const bad = await call(ctx, '/project-monitor/api/tasks', {
    method: 'POST',
    body: { name: '中期检查', project: '乙项目', due: '10/7' },
  });
  assert.equal(bad.status, 422);
  assert.match(bad.json.error, /YYYY-MM-DD/);
});

test('新增：非法输入返回 422 且错误信息可读，不落库', { skip }, async () => {
  const { ctx } = boot(tmpDir());
  await settle();
  const bad = await call(ctx, '/project-monitor/api/tasks', {
    method: 'POST',
    body: { name: '', project: 'p', category: '报奖' },
  });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.ok, false);
  assert.match(bad.json.error, /事项名称/);
  assert.match(bad.json.error, /报奖/);
  const { json } = await call(ctx, '/project-monitor/api/view');
  assert.equal(json.view.total, 0);
});

test('PATCH 单条：改进度与状态；过期 updatedAt 触发 409', { skip }, async () => {
  const { ctx } = boot(tmpDir());
  await settle();
  const { json: c } = await call(ctx, '/project-monitor/api/tasks', {
    method: 'POST',
    body: { name: '中期检查', project: '乙项目', due: '2026-10-07' },
  });
  const id = c.task.id;

  const ok = await call(ctx, `/project-monitor/api/tasks/${id}`, {
    method: 'PATCH',
    body: { patch: { progress: '80%', status: '进行中' } },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.task.progress, 0.8);

  const conflict = await call(ctx, `/project-monitor/api/tasks/${id}`, {
    method: 'PATCH',
    body: { patch: { priority: '高' }, expectedUpdatedAt: '1999-01-01T00:00:00.000Z' },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, 'CONFLICT');

  const missing = await call(ctx, '/project-monitor/api/tasks/T-999', { method: 'PATCH', body: { patch: {} } });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, 'NOT_FOUND');
});

test('完成、删除、恢复', { skip }, async () => {
  const { ctx } = boot(tmpDir());
  await settle();
  const { json: c } = await call(ctx, '/project-monitor/api/tasks', {
    method: 'POST',
    body: { name: '写总结', project: '甲项目', due: '2026-10-20' },
  });
  const id = c.task.id;

  const done = await call(ctx, `/project-monitor/api/tasks/${id}`, { method: 'PATCH', body: { patch: { status: '已完成' } } });
  assert.equal(done.json.task.progress, 1);
  assert.ok(done.json.task.completedAt);

  const viewDone = await call(ctx, '/project-monitor/api/view');
  assert.equal(viewDone.json.metrics.done, 1);
  assert.equal(viewDone.json.metrics.overdue, 0, '已完成不参与预警');

  const del = await call(ctx, `/project-monitor/api/tasks/${id}`, { method: 'DELETE' });
  assert.ok(del.json.task.deletedAt, '删除应为软删除');
  const afterDelete = await call(ctx, '/project-monitor/api/view');
  assert.equal(afterDelete.json.view.total, 0);

  const restore = await call(ctx, '/project-monitor/api/tasks/restore', { method: 'POST', body: { refs: [id] } });
  assert.equal(restore.status, 200);
  assert.equal(restore.json.restored, 1);
  const afterRestore = await call(ctx, '/project-monitor/api/view');
  assert.equal(afterRestore.json.view.total, 1);
});

test('批量：新增、同一 patch 批量更新、批量删除', { skip }, async () => {
  const { ctx } = boot(tmpDir());
  await settle();
  const bulk = await call(ctx, '/project-monitor/api/tasks/bulk', {
    method: 'POST',
    body: {
      items: [
        { name: 'a', project: '甲', due: '2026-10-01' },
        { name: 'b', project: '甲', due: '2026-10-02' },
      ],
    },
  });
  assert.equal(bulk.status, 201);
  assert.equal(bulk.json.created, 2);

  const upd = await call(ctx, '/project-monitor/api/tasks/update', {
    method: 'POST',
    body: { refs: ['T-001', 'T-002'], patch: { owner: '赵老师' } },
  });
  assert.equal(upd.json.updated, 2);
  assert.ok(upd.json.tasks.every((t) => t.owner === '赵老师'));

  const del = await call(ctx, '/project-monitor/api/tasks/delete', { method: 'POST', body: { refs: ['T-001'] } });
  assert.equal(del.json.removed, 1);
  const view = await call(ctx, '/project-monitor/api/view');
  assert.equal(view.json.view.total, 1);
});

/* ======================================================== 解析预览 */

test('/parse：快捷行、粘贴、日期三种模式，且不落库', { skip }, async () => {
  const { ctx } = boot(tmpDir(), { todayOverride: '2026-09-30' });
  await settle();

  const quick = await call(ctx, '/project-monitor/api/parse', {
    method: 'POST',
    body: { mode: 'quick', text: '横向课题B / 设备验收 / 其他 / 钱老师 / 10/20 / 高 / 30%' },
  });
  assert.equal(quick.json.ok, true);
  assert.equal(quick.json.record.due, '2026-10-20');
  assert.equal(quick.json.record.progress, 0.3);
  assert.equal(quick.json.base, '2026-09-30');

  const paste = await call(ctx, '/project-monitor/api/parse', {
    method: 'POST',
    body: { mode: 'paste', text: '甲,写总结,2026-10-10\n乙,验收,下个月初' },
  });
  assert.equal(paste.json.okCount, 1);
  assert.equal(paste.json.badCount, 1);
  assert.match(paste.json.rows[1].errors.join('；'), /无法识别日期/);

  const date = await call(ctx, '/project-monitor/api/parse', {
    method: 'POST',
    body: { mode: 'date', text: '下周五' },
  });
  assert.equal(date.json.ok, true);
  assert.equal(date.json.date, '2026-10-09');

  const badDate = await call(ctx, '/project-monitor/api/parse', {
    method: 'POST',
    body: { mode: 'date', text: '越快越好' },
  });
  assert.equal(badDate.json.ok, false);
  assert.match(badDate.json.error, /无法识别/);

  const view = await call(ctx, '/project-monitor/api/view');
  assert.equal(view.json.view.total, 0, '解析不得写库');
});

test('/tasks/bulk 支持粘贴文本、回传逐行告警，requireAll 时整批拒绝', { skip }, async () => {
  const { ctx } = boot(tmpDir(), { todayOverride: '2026-09-30' });
  await settle();
  const res = await call(ctx, '/project-monitor/api/tasks/bulk', {
    method: 'POST',
    body: { text: '甲\t写总结\t2026-10-10\n乙\t验收\t下个月初' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.created, 1);
  assert.equal(res.json.warnings.length, 1);

  const strict = await call(ctx, '/project-monitor/api/tasks/bulk', {
    method: 'POST',
    body: { text: '丙\t评审\t下个月初', requireAll: true },
  });
  assert.equal(strict.status, 422);
  const view = await call(ctx, '/project-monitor/api/view');
  assert.equal(view.json.view.total, 1, 'requireAll 失败时不应写入');
});

/* ======================================================== 视图筛选 */

test('/view 支持搜索、筛选、排序与分页', { skip }, async () => {
  const { ctx } = boot(tmpDir(), { todayOverride: '2026-09-30' });
  await settle();
  await call(ctx, '/project-monitor/api/tasks/bulk', {
    method: 'POST',
    body: {
      items: [
        { name: '提交结题报告', project: '国自然面上', owner: '张老师', due: '2026-10-03', priority: '高' },
        { name: '经费执行率核对', project: '横向课题A', owner: '赵老师', due: '2026-09-29', priority: '高' },
        { name: '发表论文标注审核', project: '国自然面上', owner: '张老师', due: '2026-11-10', priority: '低' },
      ],
    },
  });

  const overdue = await call(ctx, '/project-monitor/api/view?level=overdue');
  assert.equal(overdue.json.view.total, 1);
  assert.equal(overdue.json.view.items[0].name, '经费执行率核对');

  const search = await call(ctx, `/project-monitor/api/view?search=${encodeURIComponent('经费')}`);
  assert.equal(search.json.view.total, 1);

  const owner = await call(ctx, `/project-monitor/api/view?owner=${encodeURIComponent('张老师')}`);
  assert.equal(owner.json.view.total, 2);

  const byPriority = await call(ctx, '/project-monitor/api/view?sort=priority');
  assert.equal(byPriority.json.view.items[0].priority, '高');
  assert.equal(byPriority.json.view.sort, 'priority');

  const paged = await call(ctx, '/project-monitor/api/view?limit=2&offset=0');
  assert.equal(paged.json.view.items.length, 2);
  assert.equal(paged.json.view.total, 3, 'total 是匹配总数而非页大小');
  assert.equal(paged.json.view.hasMore, true);

  const { counts } = paged.json.view;
  assert.equal(counts.overdue, 1);
  assert.equal(counts.red, 1);
  assert.equal(counts.green, 1);

  assert.deepEqual(paged.json.view.facets.projects.slice().sort(), ['国自然面上', '横向课题A'].sort());
});

/* ============================================================ 迁移 */

test('首次启动：在数据目录旁自动探测并迁移旧工作簿', { skip }, async () => {
  // discoverLegacy 会依次看「进程工作目录」与「数据目录」及其一级子目录；
  // 这里把旧工作簿放在数据目录旁边，检验自动探测（无需显式配置）。
  const dir = tmpDir();
  const workdir = path.join(dir, 'work');
  const dataDir = path.join(workdir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(TRACKER, path.join(workdir, 'project-tracker.xlsx'));

  const { ctx } = boot(dataDir);
  const view = await waitForMigration(ctx, 6);
  assert.ok(view.view.total >= 6, `期望自动迁移出至少 6 条，实际 ${view.view.total}`);
  assert.equal(view.migration.migrated >= 6, true);
  assert.equal(view.migration.file, path.join(workdir, 'project-tracker.xlsx'));

  const health = await call(ctx, '/project-monitor/api/health');
  assert.ok(health.json.store.total >= 6);
});

test('迁移：显式指定工作簿；旧状态「已逾期」被规整为「进行中」', { skip }, async () => {
  const { ctx } = boot(tmpDir(), { legacyWorkbook: TRACKER });
  const view = await waitForMigration(ctx, 6);
  assert.equal(view.migration.migrated >= 6, true);

  const hit = await call(ctx, `/project-monitor/api/view?search=${encodeURIComponent('经费执行率核对')}`);
  assert.equal(hit.json.view.total, 1);
  assert.equal(hit.json.view.items[0].status, '进行中', '旧状态应被规整（逾期由截止日派生）');
  assert.equal(hit.json.view.items[0].level, 'overdue');
});

/* ============================================================ 导出 */

test('/export 写出 Tasks + Dashboard 两张表并落盘摘要', { skip }, async () => {
  const dir = tmpDir();
  const { ctx } = boot(dir, { legacyWorkbook: TRACKER });
  await waitForMigration(ctx, 6);
  const res = await call(ctx, '/project-monitor/api/export', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.ok(res.json.written.length >= 3, JSON.stringify(res.json.written));

  const { sheetNames, readSheet } = await import(XLSX_URL);
  const buf = fs.readFileSync(path.join(dir, 'dashboard.xlsx'));
  assert.deepEqual(sheetNames(buf), ['Tasks', 'Dashboard']);
  const dash = readSheet(buf, 'Dashboard');
  assert.equal(dash[0][0], '总任务数');
  assert.equal(typeof dash[1][0], 'number');
  const tasks = readSheet(buf, 'Tasks');
  assert.equal(tasks[0][0], 'Task_ID');
  assert.ok(tasks.length > 1);

  const latest = fs.readFileSync(path.join(dir, 'daily-summaries', 'latest.md'), 'utf8');
  assert.match(latest, /事项进展摘要/);
});

test('导出路径与摘要目录可配置（用于对外交付）', { skip }, async () => {
  const dir = tmpDir();
  const out = path.join(dir, 'out', 'monitor.xlsx');
  const { ctx } = boot(path.join(dir, 'data'), {
    legacyWorkbook: TRACKER,
    exportWorkbook: out,
    summaryDir: path.join(dir, 'out', 'summaries'),
  });
  await waitForMigration(ctx, 6);
  const res = await call(ctx, '/project-monitor/api/export', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.ok(fs.existsSync(out));
  assert.ok(fs.existsSync(path.join(dir, 'out', 'summaries', 'latest.md')));
});

test('/summary 返回 markdown 摘要', { skip }, async () => {
  const { ctx } = boot(tmpDir(), { legacyWorkbook: TRACKER });
  await waitForMigration(ctx, 6);
  const { json } = await call(ctx, '/project-monitor/api/summary');
  assert.match(json.summary, /## 事项进展摘要/);
  assert.match(json.summary, /预警分布/);
});

/* ========================================================== 只读模式 */

test('writeFiles=false：不写导出文件，但数据仍可写', { skip }, async () => {
  const dir = tmpDir();
  const { ctx } = boot(path.join(dir, 'data'), {
    legacyWorkbook: TRACKER,
    writeFiles: false,
    exportWorkbook: path.join(dir, 'never.xlsx'),
  });
  await settle();
  const created = await call(ctx, '/project-monitor/api/tasks', {
    method: 'POST',
    body: { name: '只读模式新增', project: '甲' },
  });
  assert.equal(created.status, 201, '只读指的是不写导出文件，数据仍应可写');

  const exp = await call(ctx, '/project-monitor/api/export', { method: 'POST' });
  assert.deepEqual(exp.json.written, []);
  assert.ok(!fs.existsSync(path.join(dir, 'never.xlsx')));
  assert.ok(!fs.existsSync(path.join(dir, 'daily-summaries')));
});

/* ============================================================ 兜底 */

test('未知子路径返回 404', { skip }, async () => {
  const { ctx } = boot(tmpDir());
  await settle();
  const { status, json } = await call(ctx, '/project-monitor/api/nope');
  assert.equal(status, 404);
  assert.equal(json.ok, false);
});

test('请求体不是 JSON 时返回 422 而非崩溃', { skip }, async () => {
  const { ctx } = boot(tmpDir());
  await settle();
  const { status, json } = await call(ctx, '/project-monitor/api/tasks', {
    method: 'POST',
    body: '{ 不是 json',
  });
  assert.equal(status, 422);
  assert.equal(json.code, 'BAD_JSON');
});

test('数据目录不可写时给出明确错误而不是静默丢数据', { skip }, async () => {
  const dir = tmpDir();
  const readOnly = path.join(dir, 'ro');
  fs.mkdirSync(readOnly, { recursive: true });
  fs.chmodSync(readOnly, 0o500); // 只读目录
  try {
    const { ctx } = boot(readOnly);
    await settle();
    const res = await call(ctx, '/project-monitor/api/tasks', {
      method: 'POST',
      body: { name: '写不进去', project: '甲' },
    });
    assert.equal(res.status, 500);
    assert.equal(res.json.ok, false);
  } finally {
    fs.chmodSync(readOnly, 0o700);
  }
});
