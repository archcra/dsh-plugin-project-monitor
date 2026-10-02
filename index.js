/**
 * project-monitor —— DSH 插件（宿主半侧）
 *
 * 插件自己拥有事项数据：权威存储是 `$DSH_HOME/project-monitor/tasks.json`
 * （原子写 + 事件流水 + 每日备份），Excel 只是导出的投影。
 *
 * 接口（前缀 `/project-monitor/api`）：
 *   GET    /view            列表视图：搜索/筛选/排序/分页 + 分级分组 + 指标 + 项目维度
 *   GET    /meta            枚举候选值、可选项目/负责人、存储统计
 *   GET    /summary         今日摘要（markdown）
 *   GET    /health          自检
 *   POST   /parse           解析录入文本（quick | paste | date），只解析不落库
 *   POST   /tasks           新增一条
 *   POST   /tasks/bulk      批量新增（支持 items 数组或 text 粘贴文本）
 *   PATCH  /tasks/:ref      更新一条（支持 updatedAt 乐观并发）
 *   DELETE /tasks/:ref      软删除一条
 *   POST   /tasks/update    批量更新
 *   POST   /tasks/delete    批量软删除
 *   POST   /tasks/restore   撤销软删除
 *   POST   /export          重新生成 Excel 导出（Tasks + Dashboard）
 */
import fs from 'node:fs';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';

import { createHash } from 'node:crypto';
import { readSheet, sheetNames } from './lib/xlsx.mjs';
import { renderSummary } from './lib/dashboard.mjs';
import { StoreError, defaultDataDir, openStore } from './lib/store.mjs';
import {
  CATEGORIES,
  PRIORITIES,
  STATUSES,
  isIsoDate,
  todayIso,
} from './lib/tasks.mjs';
import { buildMetrics, buildProjects, buildView, decorate } from './lib/read.mjs';
import { buildWorkbook } from './lib/export.mjs';
import { parseDate, parsePaste, parseQuickLine } from './lib/query.mjs';

/** loader 诊断里显示的名字。 */
export const name = 'project-monitor';

/** 需要 host-webserver 提供路由表。 */
export const inject = ['webServer'];

/**
 * 客户端 bundle 指纹。
 *
 * 宿主给插件 bundle 发的是 `cache-control: immutable`，改完 client.js 刷新页面
 * **不会**重新拉取，很容易误判成"改动没生效"。把内容指纹显示在面板上，就能一眼
 * 判断页面上跑的是不是最新代码。
 */
function clientFingerprint() {
  try {
    const file = new URL('./client.js', import.meta.url);
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 8);
  } catch {
    return null;
  }
}

const ROUTE_PREFIX = '/project-monitor/api';

export const Config = z.object({
  dataDir: z.string().default('')
    .description('数据目录；留空表示 $DSH_HOME/project-monitor'),
  tasksSheet: z.string().default('Tasks').description('迁移用工作簿的工作表名'),
  dashboardSheet: z.string().default('Dashboard').description('导出工作簿里看板表名'),
  summaryDir: z.string().default('daily-summaries').description('每日摘要目录（相对导出目录）'),
  exportWorkbook: z.string().default('').description('Excel 导出路径；留空表示 <数据目录>/dashboard.xlsx'),
  legacyWorkbook: z.string().default('').description('首次迁移来源；留空表示自动探测 project-tracker.xlsx'),
  topGreen: z.number().step(1).min(1).default(10).description('绿色分组最多列出条数'),
  cacheTtlMs: z.number().step(100).min(0).default(2000).description('视图缓存毫秒数'),
  writeFiles: z.boolean().default(true).description('是否写出 Excel 导出与每日摘要'),
  todayOverride: z.string().default('').description('基准日期 YYYY-MM-DD；留空表示系统当天'),
});

/* ------------------------------------------------------------ 小工具 */

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req, limitBytes = 512 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new StoreError('请求体过大', 'PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new StoreError('请求体不是合法 JSON', 'BAD_JSON');
  }
}

/** 探测旧工作簿（首次迁移来源）：显式配置 > 进程工作目录 > 数据目录。 */
function discoverLegacy(config, dataDir) {
  const explicit = String(config.legacyWorkbook ?? '').trim();
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.resolve(explicit);
  const names = ['project-tracker.xlsx', 'tracker.xlsx'];
  // 顺序很重要：从**离数据目录最近的地方**往外找。数据目录优先，其次它的父目录
  // （旧工作簿通常就躺在数据目录旁边），最后才是进程工作目录。
  const roots = [dataDir, path.dirname(dataDir), process.cwd()];
  const seen = new Set();
  for (const root of roots) {
    const abs = path.resolve(root);
    if (seen.has(abs)) continue;
    seen.add(abs);
    // 1) 直接命中
    for (const n of names) {
      const direct = path.join(abs, n);
      if (fs.existsSync(direct)) return direct;
    }
    // 2) 一级子目录
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      for (const n of names) {
        const candidate = path.join(abs, entry.name, n);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

/** 读旧工作簿的 Tasks 表为行对象数组（迁移用）。 */
function readLegacyRows(file, sheetName) {
  const buf = fs.readFileSync(file);
  const names = sheetNames(buf);
  const sheet = names.includes(sheetName) ? sheetName : names[0];
  const rows = readSheet(buf, sheet);
  if (!rows.length) return [];
  const header = (rows[0] ?? []).map((c) => String(c ?? '').trim());
  const at = (name) => header.indexOf(name);
  const cols = {
    id: at('Task_ID'), project: at('Project_Name'), name: at('Task_Name'), category: at('Category'),
    owner: at('Owner'), start: at('Start_Date'), due: at('Due_Date'), status: at('Status'),
    priority: at('Priority'), progress: at('Progress'), notes: at('Notes'),
  };
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const get = (key) => {
      const idx = cols[key];
      if (idx === undefined || idx < 0) return null;
      const cell = row[idx];
      if (cell === null || cell === undefined) return null;
      if (typeof cell === 'object' && cell.date) return cell.date;
      return cell;
    };
    const id = get('id');
    const taskName = get('name');
    const project = get('project');
    if (![id, taskName, project].some((v) => v !== null && String(v).trim() !== '' && String(v).trim() !== '—')) continue;
    out.push({
      Task_ID: id === null ? '' : String(id),
      Project_Name: project === null ? '' : String(project),
      Task_Name: taskName === null ? '' : String(taskName),
      Category: get('category'),
      Owner: get('owner'),
      Start_Date: get('start'),
      Due_Date: get('due'),
      Status: get('status'),
      Priority: get('priority'),
      Progress: get('progress'),
      Notes: get('notes'),
    });
  }
  return out;
}

/* ------------------------------------------------------------ 提供者 */

/**
 * 建立数据提供者：打开存储、必要时迁移、派生读模型、导出 Excel。
 *
 * 注意：cordis 传给 `apply(ctx, config)` 的是**已按 Config 校验/填默认值后的普通
 * 对象**（取值形如 `config.tasksSheet`），不是响应式句柄，切勿写 `.get()`。
 */
function createProvider(ctx, config) {
  const dataDir = String(config.dataDir ?? '').trim() || defaultDataDir();
  const store = openStore({ dir: dataDir });

  const exportPath = String(config.exportWorkbook ?? '').trim()
    ? path.resolve(String(config.exportWorkbook).trim())
    : path.join(dataDir, 'dashboard.xlsx');
  const summarySetting = String(config.summaryDir ?? 'daily-summaries');
  const summaryDir = path.isAbsolute(summarySetting)
    ? summarySetting
    : path.join(path.dirname(exportPath), summarySetting);

  const stamp = () => {
    const raw = String(config.todayOverride ?? '').trim();
    return isIsoDate(raw) ? raw : todayIso();
  };

  let viewCache = null;
  let viewCachedAt = 0;
  let exportedAt = null;
  let exportError = null;
  let migration = { migrated: 0, skipped: 'pending' };

  /** 已装饰 + 打分级的全部记录（带缓存）。 */
  function decoratedTasks({ force = false } = {}) {
    const today = stamp();
    const ttl = Number(config.cacheTtlMs ?? 0);
    if (!force && ttl > 0 && viewCache && Date.now() - viewCachedAt < ttl && viewCache.today === today) {
      return viewCache.decorated;
    }
    const decorated = store.allTasks().map((t) => decorate(t, today));
    viewCache = { decorated, today };
    viewCachedAt = Date.now();
    return decorated;
  }

  function currentView() {
    const today = stamp();
    const decorated = decoratedTasks();
    return {
      today,
      decorated,
      metrics: buildMetrics(decorated, today),
      projects: buildProjects(decorated),
      tasks: store.allTasks(),
    };
  }

  function invalidate() {
    viewCache = null;
    viewCachedAt = 0;
  }

  /** renderSummary 需要的 report 形状（键为级别，值为 Tasks 表风格行）。 */
  function groupShape(decorated) {
    const out = {};
    for (const level of ['overdue', 'red', 'orange', 'yellow', 'green']) {
      out[level] = decorated
        .filter((t) => !t.done && t.level === level)
        .sort((a, b) => String(a.due).localeCompare(String(b.due)))
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
        }));
    }
    return out;
  }

  function reportShape({ today, decorated, metrics, projects }) {
    return {
      today,
      metrics,
      groups: groupShape(decorated),
      projects,
      active: decorated.filter((t) => !t.done),
      urgent: decorated
        .filter((t) => !t.done && t.days !== null)
        .sort((a, b) => a.days - b.days)
        .slice(0, 3),
      invalid: [],
      duplicates: [],
      topGreen: config.topGreen,
    };
  }

  function summaryText() {
    const current = currentView();
    return renderSummary(reportShape(current), {
      storePath: store.snapshotFile,
      workbookPath: exportPath,
      tasksSheet: 'Tasks',
      dashboardSheet: config.dashboardSheet,
    });
  }

  /** 导出 Excel（Tasks + Dashboard）并写每日摘要。 */
  function exportFiles(current) {
    const written = [];
    if (!config.writeFiles) return { written, exportedAt };
    const { decorated, metrics, projects, today, tasks } = current;
    const buf = buildWorkbook({ decorated, metrics, projects, today }, tasks);
    fs.mkdirSync(path.dirname(exportPath), { recursive: true });
    const tmp = `${exportPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, exportPath);
    written.push(exportPath);

    const summary = renderSummary(reportShape(current), {
      storePath: store.snapshotFile,
      workbookPath: exportPath,
      tasksSheet: 'Tasks',
      dashboardSheet: config.dashboardSheet,
    });
    fs.mkdirSync(summaryDir, { recursive: true });
    const header = `<!-- project-monitor 自动生成 ${new Date().toISOString()} -->\n\n`;
    const dated = path.join(summaryDir, `${today}.md`);
    fs.writeFileSync(dated, header + summary);
    fs.writeFileSync(path.join(summaryDir, 'latest.md'), header + summary);
    written.push(dated, path.join(summaryDir, 'latest.md'));
    exportedAt = new Date().toISOString();
    return { written, exportedAt, summary };
  }

  /** 首次启动迁移：空存储时从旧工作簿导入，幂等。 */
  async function bootstrap() {
    try {
      const legacy = discoverLegacy(config, dataDir);
      if (!legacy) {
        migration = { migrated: 0, skipped: 'no-legacy-workbook', file: null };
        return migration;
      }
      migration = await store.migrateFromWorkbook(legacy, (file) => readLegacyRows(file, config.tasksSheet));
      migration.file = legacy;
      if (migration.migrated) {
        invalidate();
        ctx.logger?.info?.(`project-monitor: 已从 ${legacy} 迁移 ${migration.migrated} 条事项到 ${dataDir}`);
      }
      return migration;
    } catch (err) {
      migration = { migrated: 0, skipped: 'error', error: err.message };
      ctx.logger?.warn?.(`project-monitor: 迁移失败（存储仍可用）：${err.message}`);
      return migration;
    }
  }

  return {
    store,
    dataDir,
    exportPath,
    summaryDir,
    config,
    stamp,
    currentView,
    invalidate,
    summaryText,
    exportFiles,
    bootstrap,
    getMigration: () => migration,
    getExportState: () => ({ exportedAt, exportError }),
    setExportError: (err) => { exportError = err?.message ?? null; },
  };
}

/* ------------------------------------------------------------ 路由 */

/** 注册 /project-monitor/api 下的全部路由。 */
export function apply(ctx, config) {
  const provider = createProvider(ctx, config);

  // 首次迁移 + 首次导出在后台完成：接口可用性不依赖它，失败只记录日志。
  provider
    .bootstrap()
    .then(() => {
      if (!config.writeFiles) return;
      try {
        provider.exportFiles(provider.currentView());
      } catch (err) {
        provider.setExportError(err);
        ctx.logger?.warn?.(`project-monitor: 首次导出失败：${err.message}`);
      }
    })
    .catch((err) => ctx.logger?.warn?.(`project-monitor: 初始化失败：${err.message}`));

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const route = url.pathname.slice(ROUTE_PREFIX.length) || '/';
          const q = url.searchParams;
          const method = req.method ?? 'GET';
          const refMatch = /^\/tasks\/(.+)$/.exec(route);
          const ref = refMatch ? decodeURIComponent(refMatch[1]) : null;

          try {
            /* ---------------------------------------------------- 读 */

            if (route === '/health') {
              return json(res, 200, {
                ok: true,
                dataDir: provider.dataDir,
                store: provider.store.stats(),
                exportPath: provider.exportPath,
                exportExists: fs.existsSync(provider.exportPath),
                migration: provider.getMigration(),
                today: provider.stamp(),
              });
            }

            if (route === '/meta') {
              const tasks = provider.store.allTasks();
              const opts = (key) => [...new Set(tasks.map((t) => t[key]).filter(Boolean))]
                .sort((a, b) => String(a).localeCompare(String(b), 'zh'));
              return json(res, 200, {
                ok: true,
                today: provider.stamp(),
                enums: { categories: CATEGORIES, statuses: STATUSES, priorities: PRIORITIES },
                projects: opts('project'),
                owners: opts('owner'),
                build: clientFingerprint(),
                store: provider.store.stats(),
                migration: provider.getMigration(),
                exportPath: provider.exportPath,
              });
            }

            if ((route === '/view' || route === '/') && method === 'GET') {
              const current = provider.currentView();
              const view = buildView(current.tasks, current.today, {
                search: q.get('search') ?? '',
                project: q.get('project') ?? '',
                owner: q.get('owner') ?? '',
                status: q.get('status') ?? '',
                level: q.get('level') ?? '',
                sort: q.get('sort') ?? 'due',
                limit: q.has('limit') ? Number(q.get('limit')) : 200,
                offset: q.has('offset') ? Number(q.get('offset')) : 0,
              });
              return json(res, 200, {
                ok: true,
                today: current.today,
                view,
                metrics: current.metrics,
                projects: current.projects,
                store: provider.store.stats(),
                migration: provider.getMigration(),
                exportPath: provider.exportPath,
                exportedAt: provider.getExportState().exportedAt,
                build: clientFingerprint(),
              });
            }

            if (route === '/summary') {
              return json(res, 200, { ok: true, today: provider.stamp(), summary: provider.summaryText() });
            }

            /* ------------------------------------------------ 解析预览 */

            if (route === '/parse' && method === 'POST') {
              const body = await readBody(req);
              const base = isIsoDate(body.today) ? body.today : provider.stamp();
              const text = typeof body.text === 'string' ? body.text : '';
              if (body.mode === 'date') {
                const parsed = parseDate(text, base);
                return json(res, 200, {
                  ok: parsed.ok, mode: 'date', base,
                  date: parsed.date ?? null,
                  error: parsed.ok ? null : parsed.reason,
                });
              }
              if (body.mode === 'paste' || text.includes('\n')) {
                const parsed = parsePaste(text, base);
                return json(res, 200, { ok: true, mode: 'paste', base, ...parsed });
              }
              const parsed = parseQuickLine(text, base);
              return json(res, 200, { ok: parsed.ok, mode: 'quick', base, ...parsed });
            }

            /* -------------------------------------------------- 写 */

            if (route === '/tasks' && method === 'POST') {
              const body = await readBody(req);
              const created = await provider.store.create(body.task ?? body, { by: body.by ?? 'ui' });
              provider.invalidate();
              return json(res, 201, { ok: true, task: created });
            }

            if (route === '/tasks/bulk' && method === 'POST') {
              const body = await readBody(req);
              const base = isIsoDate(body.today) ? body.today : provider.stamp();
              let items = Array.isArray(body.items) ? body.items : null;
              const warnings = [];
              if (!items) {
                const parsed = parsePaste(body.text ?? '', base);
                items = parsed.rows.filter((r) => r.ok).map((r) => r.record);
                for (const row of parsed.rows.filter((r) => !r.ok)) {
                  warnings.push(`第 ${row.line} 行：${row.errors.join('、')} —— ${row.raw}`);
                }
                if (body.requireAll && warnings.length) {
                  return json(res, 422, {
                    ok: false, code: 'VALIDATION',
                    error: '存在无法解析的行，未写入任何数据', warnings,
                  });
                }
              }
              if (!items.length) {
                return json(res, 422, { ok: false, code: 'EMPTY', error: '没有可写入的事项', warnings });
              }
              const created = await provider.store.createMany(items, { by: body.by ?? 'ui' });
              provider.invalidate();
              return json(res, 201, { ok: true, created: created.length, tasks: created, warnings });
            }

            if (route === '/tasks/update' && method === 'POST') {
              const body = await readBody(req);
              const updated = await provider.store.updateMany(body.refs ?? [], body.patch ?? {}, { by: body.by ?? 'ui' });
              provider.invalidate();
              return json(res, 200, { ok: true, updated: updated.length, tasks: updated });
            }

            if (route === '/tasks/delete' && method === 'POST') {
              const body = await readBody(req);
              const removed = [];
              for (const r of body.refs ?? []) removed.push(await provider.store.remove(r, { by: body.by ?? 'ui' }));
              provider.invalidate();
              return json(res, 200, { ok: true, removed: removed.length, tasks: removed });
            }

            if (route === '/tasks/restore' && method === 'POST') {
              const body = await readBody(req);
              const restored = [];
              for (const r of body.refs ?? []) restored.push(await provider.store.restore(r, { by: body.by ?? 'ui' }));
              provider.invalidate();
              return json(res, 200, { ok: true, restored: restored.length, tasks: restored });
            }

            if (ref && method === 'PATCH') {
              const body = await readBody(req);
              const expected = body.expectedUpdatedAt;
              if (expected) {
                const existing = provider.store.findByRef(ref);
                if (existing && existing.updatedAt !== expected) {
                  return json(res, 409, {
                    ok: false, code: 'CONFLICT',
                    error: '这条事项已被其他操作修改，请刷新后重试',
                    task: existing,
                  });
                }
              }
              const updated = await provider.store.update(ref, body.patch ?? body, { by: body.by ?? 'ui' });
              provider.invalidate();
              return json(res, 200, { ok: true, task: updated });
            }

            if (ref && method === 'DELETE') {
              const removed = await provider.store.remove(ref, { by: 'ui' });
              provider.invalidate();
              return json(res, 200, { ok: true, task: removed });
            }

            /* ------------------------------------------------ 导出 */

            if (route === '/export' && method === 'POST') {
              const current = provider.currentView();
              const result = provider.exportFiles(current);
              return json(res, 200, { ok: true, ...result, metrics: current.metrics });
            }

            return json(res, 404, { ok: false, code: 'NOT_FOUND', error: `未知接口 ${route}` });
          } catch (err) {
            const code = err instanceof StoreError ? err.code : (err.code ?? 'ERROR');
            const status = code === 'NOT_FOUND' ? 404
              : code === 'VALIDATION' || code === 'BAD_JSON' || code === 'EMPTY' ? 422
                : code === 'PAYLOAD_TOO_LARGE' ? 413
                  : 500;
            if (status >= 500) ctx.logger?.warn?.(err);
            return json(res, status, { ok: false, code, error: String(err.message ?? err) });
          }
        },
      }),
    'project-monitor: dashboard api',
  );

  ctx.logger?.info?.(
    `project-monitor 已挂载: ${ROUTE_PREFIX} → 数据目录 ${provider.dataDir}` +
      (config.writeFiles ? `（导出到 ${provider.exportPath}）` : '（只读，不写文件）'),
  );
}
