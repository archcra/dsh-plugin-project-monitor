/**
 * 权威存储：JSON 快照 + 追加式事件流水 + 每日备份。
 *
 * 关键纪律：
 *   - **所有写入串行化**（单写者队列），避免并发 mutation 互相覆盖；
 *   - **原子落盘**（同目录临时文件 + rename），避免半截 JSON；
 *   - 删除是**软删除**（`deletedAt`），可撤销；
 *   - 事件流水只追加，永不改写；快照损坏时可用于人工修复与排障。
 *
 * 数据目录默认 `$DSH_HOME/project-monitor/`：
 *
 *     tasks.json          权威快照
 *     events.ndjson       变更流水
 *     backups/YYYY-MM-DD.json
 *     dashboard.xlsx      导出投影（由 export.mjs 写）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DONE,
  SCHEMA_VERSION,
  createRecord,
  normalizeTaskInput,
  nowIso,
  todayIso,
} from './tasks.mjs';

const BACKUP_KEEP = 14;

export class StoreError extends Error {
  constructor(message, code = 'STORE_ERROR') {
    super(message);
    this.code = code;
  }
}

/** 默认数据目录：`$DSH_HOME/project-monitor`（DSH_HOME 未设置时退到 `~/.dsh`）。 */
export function defaultDataDir(env = process.env) {
  const home = env.DSH_HOME && env.DSH_HOME.trim() ? env.DSH_HOME.trim() : path.join(os.homedir(), '.dsh');
  return path.join(home, 'project-monitor');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new StoreError(`读取 ${file} 失败：${err.message}`, 'STORE_UNREADABLE');
  }
}

/** 原子写：同目录临时文件 + rename（同分区 rename 是原子操作）。 */
function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不影响主流程 */ }
    throw err;
  }
}

function emptySnapshot() {
  return { schemaVersion: SCHEMA_VERSION, nextSeq: 0, migratedFrom: null, tasks: [] };
}

/**
 * 打开（或创建）存储。
 *
 * @param {object} options
 * @param {string} [options.dir] 数据目录
 * @param {Date}   [options.now] 便于测试注入时间
 */
export function openStore(options = {}) {
  const dir = options.dir ?? defaultDataDir();
  const snapshotFile = path.join(dir, 'tasks.json');
  const eventsFile = path.join(dir, 'events.ndjson');
  const backupsDir = path.join(dir, 'backups');
  const now = () => options.now?.() ?? new Date();

  let data = null;
  let queue = Promise.resolve();

  /* ------------------------------------------------------------ 读取 */

  function load() {
    if (data) return data;
    const parsed = readJson(snapshotFile);
    if (parsed === null) {
      data = emptySnapshot();
      return data;
    }
    if (!Array.isArray(parsed.tasks)) throw new StoreError(`${snapshotFile} 结构异常：缺少 tasks 数组`, 'STORE_CORRUPT');
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      throw new StoreError(
        `${snapshotFile} 的 schemaVersion=${parsed.schemaVersion}，本插件只支持 ${SCHEMA_VERSION}`,
        'STORE_VERSION',
      );
    }
    data = parsed;
    return data;
  }

  const isAlive = (t) => !t.deletedAt;

  /** 全部未删除记录（按截止日、优先级、ID 稳定排序）。 */
  function allTasks() {
    return load().tasks.filter(isAlive);
  }

  function findByRef(ref) {
    const key = String(ref ?? '').trim();
    if (!key) return null;
    const tasks = load().tasks;
    return (
      tasks.find((t) => t.id === key && isAlive(t)) ??
      tasks.find((t) => isAlive(t) && t.name === key) ??
      null
    );
  }

  /* ------------------------------------------------------------ 备份 */

  function backupOnce() {
    if (!fs.existsSync(snapshotFile)) return null;
    const stamp = todayIso(now());
    const target = path.join(backupsDir, `${stamp}.json`);
    if (fs.existsSync(target)) return null; // 每天首次写入前备份一次
    fs.mkdirSync(backupsDir, { recursive: true });
    fs.copyFileSync(snapshotFile, target);
    const old = fs
      .readdirSync(backupsDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    for (const f of old.slice(0, Math.max(0, old.length - BACKUP_KEEP))) {
      try { fs.unlinkSync(path.join(backupsDir, f)); } catch { /* 忽略 */ }
    }
    return target;
  }

  /* ------------------------------------------------------------ 写入 */

  function appendEvent(event) {
    const row = { seq: ++data.nextSeq, at: nowIso(now()), ...event };
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(eventsFile, `${JSON.stringify(row)}\n`);
    } catch {
      // 流水写不进去不应阻断主流程（快照才是权威数据）
    }
    return row;
  }

  function persist(event) {
    appendEvent(event);
    writeFileAtomic(snapshotFile, `${JSON.stringify(data, null, 2)}\n`);
  }

  /** 串行化执行一次 mutation。 */
  function mutate(fn) {
    const run = queue.then(() => {
      load();
      backupOnce();
      return fn();
    });
    // 队列本身永不拒绝，避免一次失败卡死后续写入
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /* ---------------------------------------------------------- 公共 API */

  /** 读原始快照（只读副本），用于导出与测试。 */
  function snapshot() {
    const d = load();
    return { schemaVersion: d.schemaVersion, migratedFrom: d.migratedFrom, tasks: d.tasks.map((t) => ({ ...t })) };
  }

  function stats() {
    const tasks = load().tasks;
    const alive = tasks.filter(isAlive);
    return {
      dir,
      snapshotFile,
      eventsFile,
      backupsDir,
      total: alive.length,
      completed: alive.filter((t) => t.status === DONE).length,
      deleted: tasks.length - alive.length,
      seq: load().nextSeq,
    };
  }

  /** 新增一条。输入先经 normalizeTaskInput 校验，失败抛 StoreError。 */
  function create(input, meta = {}) {
    return mutate(() => {
      const { ok, record, errors } = normalizeTaskInput(input);
      if (!ok) throw new StoreError(errors.join('；'), 'VALIDATION');
      const rec = createRecord(record, allTasks(), now());
      data.tasks.push(rec);
      persist({ type: 'create', id: rec.id, by: meta.by ?? 'plugin', after: rec });
      return { ...rec };
    });
  }

  /**
   * 批量新增（全部成功才写入，避免半批）。
   * @returns {Promise<Array>} 新建记录
   */
  function createMany(inputs, meta = {}) {
    return mutate(() => {
      const drafts = [];
      const errors = [];
      inputs.forEach((input, i) => {
        const { ok, record, errors: rowErrors } = normalizeTaskInput(input);
        if (!ok) errors.push(`第 ${i + 1} 条：${rowErrors.join('、')}`);
        else drafts.push(record);
      });
      if (errors.length) throw new StoreError(errors.join('；'), 'VALIDATION');

      const created = [];
      for (const draft of drafts) {
        const rec = createRecord(draft, [...allTasks(), ...created], now());
        data.tasks.push(rec);
        created.push(rec);
      }
      persist({ type: 'createMany', ids: created.map((t) => t.id), by: meta.by ?? 'plugin' });
      return created.map((t) => ({ ...t }));
    });
  }

  /**
   * 更新一条。支持传入 id 或事项名称（名称需唯一）。
   * @param {string} ref
   * @param {object} patch 只覆盖给出的字段
   */
  function update(ref, patch = {}, meta = {}) {
    return mutate(() => {
      const task = findByRef(ref);
      if (!task) throw new StoreError(`找不到事项「${ref}」`, 'NOT_FOUND');

      const merged = {
        name: patch.name ?? task.name,
        project: patch.project ?? task.project,
        category: patch.category ?? task.category,
        owner: patch.owner === undefined ? task.owner : patch.owner,
        start: patch.start === undefined ? task.start : patch.start,
        due: patch.due === undefined ? task.due : patch.due,
        status: patch.status ?? task.status,
        priority: patch.priority ?? task.priority,
        progress: patch.progress === undefined ? task.progress : patch.progress,
        notes: patch.notes === undefined ? task.notes : patch.notes,
      };
      const { ok, record, errors } = normalizeTaskInput(merged);
      if (!ok) throw new StoreError(errors.join('；'), 'VALIDATION');

      const before = { ...task };
      Object.assign(task, record, { updatedAt: nowIso(now()) });
      if (record.status === DONE && !task.completedAt) task.completedAt = nowIso(now());
      if (record.status !== DONE) task.completedAt = null;

      persist({ type: 'update', id: task.id, by: meta.by ?? 'plugin', patch, before, after: { ...task } });
      return { ...task };
    });
  }

  /** 软删除（可 undo 恢复）。 */
  function remove(ref, meta = {}) {
    return mutate(() => {
      const task = findByRef(ref);
      if (!task) throw new StoreError(`找不到事项「${ref}」`, 'NOT_FOUND');
      const before = { ...task };
      task.deletedAt = nowIso(now());
      task.updatedAt = task.deletedAt;
      persist({ type: 'delete', id: task.id, by: meta.by ?? 'plugin', before });
      return { ...task };
    });
  }

  /** 撤销软删除。 */
  function restore(ref, meta = {}) {
    return mutate(() => {
      const key = String(ref ?? '').trim();
      const task = load().tasks.find((t) => t.id === key && t.deletedAt);
      if (!task) throw new StoreError(`找不到已删除的事项「${ref}」`, 'NOT_FOUND');
      task.deletedAt = null;
      task.updatedAt = nowIso(now());
      persist({ type: 'restore', id: task.id, by: meta.by ?? 'plugin' });
      return { ...task };
    });
  }

  /** 批量更新（同一 patch 应用到多个 ref）。 */
  function updateMany(refs, patch = {}, meta = {}) {
    return mutate(() => {
      const targets = [];
      for (const ref of refs) {
        const task = findByRef(ref);
        if (!task) throw new StoreError(`找不到事项「${ref}」`, 'NOT_FOUND');
        targets.push(task);
      }
      const updated = [];
      for (const task of targets) {
        const merged = {
          name: patch.name ?? task.name,
          project: patch.project ?? task.project,
          category: patch.category ?? task.category,
          owner: patch.owner === undefined ? task.owner : patch.owner,
          start: patch.start === undefined ? task.start : patch.start,
          due: patch.due === undefined ? patch.due : patch.due,
          status: patch.status ?? task.status,
          priority: patch.priority ?? task.priority,
          progress: patch.progress === undefined ? task.progress : patch.progress,
          notes: patch.notes === undefined ? task.notes : patch.notes,
        };
        const { ok, record, errors } = normalizeTaskInput(merged);
        if (!ok) throw new StoreError(`${task.id}：${errors.join('、')}`, 'VALIDATION');
        Object.assign(task, record, { updatedAt: nowIso(now()) });
        if (record.status === DONE && !task.completedAt) task.completedAt = nowIso(now());
        if (record.status !== DONE) task.completedAt = null;
        updated.push({ ...task });
      }
      persist({ type: 'updateMany', ids: updated.map((t) => t.id), by: meta.by ?? 'plugin', patch });
      return updated;
    });
  }

  /**
   * 首次启动迁移：把旧 `project-tracker.xlsx` 的 Tasks 表导入为空存储。
   * 幂等：已有数据、或已迁移过、或文件不存在时都不动作。
   *
   * @param {(file: string) => Array} reader 读表函数（由调用方注入，避免循环依赖）
   */
  function migrateFromWorkbook(file, reader, meta = {}) {
    return mutate(() => {
      if (allTasks().length > 0) return { migrated: 0, skipped: 'store-not-empty' };
      if (load().migratedFrom) return { migrated: 0, skipped: 'already-migrated' };
      if (!file || !fs.existsSync(file)) return { migrated: 0, skipped: 'workbook-missing' };

      const rows = reader(file);
      const created = [];
      const problems = [];
      rows.forEach((row, i) => {
        const input = {
          name: row.Task_Name,
          project: row.Project_Name,
          category: row.Category,
          owner: row.Owner,
          start: row.Start_Date,
          due: row.Due_Date,
          status: row.Status,
          priority: row.Priority,
          progress: row.Progress,
          notes: row.Notes,
        };
        const { ok, record, errors } = normalizeTaskInput(input);
        if (!ok) {
          problems.push(`第 ${i + 2} 行：${errors.join('、')}`);
          return;
        }
        // 迁移时保留原 Task_ID（若形状合法且未被占用）
        const wanted = String(row.Task_ID ?? '').trim();
        const rec = createRecord(record, [...allTasks(), ...created], now());
        if (/^T-\d+$/.test(wanted) && ![...allTasks(), ...created].some((t) => t.id === wanted)) {
          rec.id = wanted;
        }
        data.tasks.push(rec);
        created.push(rec);
      });
      data.migratedFrom = { file, at: nowIso(now()), count: created.length, problems };
      persist({ type: 'migrate', from: file, count: created.length, by: meta.by ?? 'plugin', problems });
      return { migrated: created.length, problems, skipped: null };
    });
  }

  return {
    dir,
    snapshotFile,
    eventsFile,
    backupsDir,
    snapshot,
    stats,
    allTasks,
    findByRef,
    create,
    createMany,
    update,
    updateMany,
    remove,
    restore,
    migrateFromWorkbook,
    /** 等待当前排队的写入全部落盘（测试与优雅退出用）。 */
    flush: () => queue,
  };
}
