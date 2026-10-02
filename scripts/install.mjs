#!/usr/bin/env node
/**
 * project-monitor 安装预检 + 引导（默认只读，不改动任何 DSH 文件）。
 *
 *   node scripts/install.mjs                  # 体检 + 打印安装指引
 *   node scripts/install.mjs --patch-file     # 额外打印可直接粘贴到
 *                                             # ~/.dsh/profiles/desktop/cordis.patch.yml 的行
 *   node scripts/install.mjs --check-only     # 仅体检，失败时退出码非 0
 *
 * 实际的安装动作交给 DSH 自己完成（GUI「插件 → 添加插件」或 CLI
 * `dsh plugin --profile desktop add <绝对路径>`），因为 profile 的
 * package.json / pnpm-lock 应由 DSH 的插件管理器写入。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.dirname(HERE);
// 引擎模块用绝对 file URL 导入：本环境 ESM 解析器对 `../` 上越包边界的说明符
// 会丢一段路径，绝对 URL 不受影响。
const LIB = pathToFileURL(path.join(PLUGIN_DIR, 'lib')).href;
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE = process.env.DSH_PROFILE || 'desktop';
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE);
const APP = '/Applications/DeepSeek Harness.app/Contents/Resources';
const CLI = path.join(APP, 'runtime', 'cli', 'bin', 'dsh');

const args = process.argv.slice(2);
const wantPatchFile = args.includes('--patch-file');
const checkOnly = args.includes('--check-only');

const problems = [];
const notes = [];

function ok(label, detail = '') {
  console.log(`  ✔ ${label}${detail ? `  ${detail}` : ''}`);
}
function bad(label, detail = '') {
  console.log(`  ✖ ${label}${detail ? `  ${detail}` : ''}`);
  problems.push(label);
}
function warn(label, detail = '') {
  console.log(`  ! ${label}${detail ? `  ${detail}` : ''}`);
  notes.push(label);
}

/* ------------------------------------------------------------ 1. 插件自身 */

console.log('\n[1/5] 插件包');
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'));
  ok('package.json 可读', `${pkg.name}@${pkg.version}`);
} catch (err) {
  bad('package.json 不可读', err.message);
}

if (pkg) {
  for (const f of ['index.js', 'client.js', 'lib/cli.mjs', 'lib/dashboard.mjs', 'lib/xlsx.mjs', 'lib/zip.mjs',
                  'cordis.patch.yml', 'scheduling/run-daily-summary.sh']) {
    if (fs.existsSync(path.join(PLUGIN_DIR, f))) ok(`存在 ${f}`);
    else bad(`缺少 ${f}`);
  }
  if (pkg.dsh?.client?.platform === 'web') ok('dsh.client.platform = web（浏览器半侧会被挂载）');
  else bad('dsh.client.platform 缺失或不是 web');
  if (pkg.dsh?.bundle?.patch) ok(`dsh.bundle.patch = ${pkg.dsh.bundle.patch}`);
  else warn('未声明 dsh.bundle.patch，安装后需要在 profile 里手动加行');
}

/* --------------------------------------------------------- 2. 引擎自检 */

console.log('\n[2/5] 引擎自检（读写 xlsx 零依赖）');
try {
  const { writeXlsx, readSheet } = await import(`${LIB}/xlsx.mjs`);
  const buf = writeXlsx({
    sheetName: 'T',
    widths: [10],
    rows: [[{ v: 'ok' }], [{ v: { date: '2026-09-30' }, style: { fmt: 'date' } }]],
  });
  const rows = readSheet(buf, 'T');
  if (rows[1][0]?.date === '2026-09-30') ok('xlsx 读写往返');
  else bad('xlsx 读写往返结果不符');
} catch (err) {
  bad('xlsx 引擎自检失败', err.message);
}

// 运行时依赖是否已本地化（宿主半侧 import '@deepseek-ai/schemastery'）
for (const dep of ['@deepseek-ai/schemastery/package.json', '@deepseek-ai/cosmokit/package.json']) {
  if (fs.existsSync(path.join(PLUGIN_DIR, 'node_modules', dep))) ok(`运行时依赖已就绪 ${dep.split('/')[1]}`);
  else {
    try {
      execFileSync(process.execPath, [path.join(HERE, 'vendor.mjs')], { stdio: 'pipe' });
      ok(`已自动补齐运行时依赖 ${dep.split('/')[1]}`);
    } catch (err) {
      bad(`运行时依赖缺失且无法自动补齐 ${dep}`, String(err.message).slice(0, 120));
    }
  }
}

/* ------------------------------------------------------ 3. 数据源可见性 */

console.log('\n[3/5] 数据源');
const candidates = [
  path.join(PLUGIN_DIR, '..', 'project-tracker.xlsx'),
  path.join(process.cwd(), 'project-tracker.xlsx'),
];
let workbook = candidates.find((p) => fs.existsSync(p));
if (workbook) {
  workbook = path.resolve(workbook);
  ok('找到 project-tracker.xlsx', workbook);
  try {
    const { readSheet } = await import(`${LIB}/xlsx.mjs`);
    const { loadTasks } = await import(`${LIB}/dashboard.mjs`);
    const rows = readSheet(fs.readFileSync(workbook), 'Tasks');
    const { tasks, invalid, duplicates } = loadTasks(rows);
    ok(`Tasks 表解析成功`, `任务 ${tasks.length} 条`);
    if (invalid.length) warn(`${invalid.length} 行 Due_Date 异常（会列入「需修正」）`);
    if (duplicates.length) warn(`Task_ID 重复：${duplicates.join('、')}`);
  } catch (err) {
    bad('Tasks 表解析失败', err.message);
  }
} else {
  warn('未找到 project-tracker.xlsx', candidates.join(' | '));
}

/* ------------------------------------------------------- 4. DSH 运行时 */

console.log('\n[4/5] DSH 运行时与 profile');
let runtimeVersion = null;
try {
  const p = JSON.parse(fs.readFileSync(path.join(APP, 'app.asar.unpacked', '..', '..', 'package.json'), 'utf8'));
  runtimeVersion = p.version;
} catch {
  /* 读不到就算了，下面还有别的来源 */
}
try {
  const runtimeJson = JSON.parse(fs.readFileSync(path.join(APP, 'runtime', 'primary-runtime', 'runtime.json'), 'utf8'));
  runtimeVersion = runtimeVersion ?? runtimeJson.desktopVersion;
} catch {
  /* 忽略 */
}
if (runtimeVersion) ok('DSH 版本', runtimeVersion);
else warn('读不到 DSH 版本，跳过 peerDependencies 版本核对');

if (runtimeVersion) {
  const mismatched = Object.entries(pkg?.peerDependencies ?? {})
    .filter(([dep]) => dep === '@deepseek-ai/dsh' || dep.startsWith('@deepseek-ai/dsh-'))
    .filter(([, range]) => {
      // 简化判定：范围里出现与 runtime 完全一致的字符串即视为匹配
      // （DSH 用 semver 逐范围核对，预发布版本参与匹配）。
      const cleaned = String(range).replace(/^[\^~>=<\s]+/, '');
      return cleaned !== runtimeVersion;
    });
  if (mismatched.length === 0) ok('peerDependencies 中的 dsh-* 范围与本机版本一致');
  else warn('以下 peer 范围需要人工确认', mismatched.map(([d, r]) => `${d}@${r}`).join(', '));
}

if (fs.existsSync(PROFILE_DIR)) ok('profile 目录存在', PROFILE_DIR);
else bad('profile 目录不存在（先启动一次 DeepSeek Harness Desktop）', PROFILE_DIR);

const profilePkg = path.join(PROFILE_DIR, 'package.json');
if (fs.existsSync(profilePkg)) {
  try {
    const p = JSON.parse(fs.readFileSync(profilePkg, 'utf8'));
    const bundles = p.dsh?.profile?.bundles ?? [];
    ok('profile bundles', bundles.join(', ') || '（空）');
  } catch (err) {
    warn('profile package.json 解析失败', err.message);
  }
}
const patchFile = path.join(PROFILE_DIR, 'cordis.patch.yml');
if (fs.existsSync(patchFile)) {
  const text = fs.readFileSync(patchFile, 'utf8');
  if (text.includes('project-monitor')) ok('cordis.patch.yml 已包含 project-monitor 行');
  else warn('cordis.patch.yml 尚未包含 project-monitor 行（安装后会自动加入）');
}

/* --------------------------------------------------------- 5. 安装路径 */

console.log('\n[5/5] 安装方式\n');
const rows = [
  ['GUI（推荐）', '侧栏 → 插件 → 添加插件 → 填入下面的绝对路径 → 安装 → 立即启用'],
  ['CLI（先完全退出桌面端）', `${CLI} plugin --profile ${PROFILE} add ${PLUGIN_DIR}`],
  ['手动 patch 行', `把 name 改为 'file:${PLUGIN_DIR}' 后插入 profile 的 cordis.patch.yml`],
];
for (const [how, what] of rows) {
  console.log(`  · ${how}\n      ${what}`);
}
console.log(`\n  插件绝对路径: ${PLUGIN_DIR}`);
console.log(`  profile 目录: ${PROFILE_DIR}`);
console.log('  安装后：侧栏出现「事项进展」面板；浏览器 bundle 由 dsh.client 自动提供。');
console.log('  每天早晨的摘要见 plugin/README.md「每天早晨的摘要」一节（launchd 或 DSH Schedule 实验包）。\n');

if (wantPatchFile) {
  console.log('可直接粘贴到 profile cordis.patch.yml 的行：\n');
  console.log('- insert:');
  console.log('    - id: project-monitor');
  console.log(`      name: 'file:${PLUGIN_DIR}'`);
  console.log('      config:');
  console.log(`        workbook: ${workbook ?? 'project-tracker.xlsx'}`);
  console.log('        baseDir: \'\'');
  console.log('        writeFiles: true\n');
}

if (problems.length) {
  console.log(`预检发现 ${problems.length} 个问题：${problems.join('；')}\n`);
} else {
  console.log(`预检通过${notes.length ? `（${notes.length} 条提醒）` : ''}。\n`);
}

if (checkOnly && problems.length) process.exit(1);
