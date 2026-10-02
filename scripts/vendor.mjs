#!/usr/bin/env node
/**
 * project-monitor —— 运行时依赖本地化（vendor）。
 *
 * 宿主半侧 `index.js` 需要 `@deepseek-ai/schemastery`（DSH 的配置校验库，其自身
 * 依赖 `@deepseek-ai/cosmokit`）。profile 的 pnpm 以 `autoInstallPeers: false`
 * 运行，因此不能假定这两个包会出现在 profile 的 node_modules 里；从已安装的
 * DSH 应用包里把它们链接进本插件的 node_modules，插件即完全自包含。
 *
 *   node scripts/vendor.mjs            # 缺失时补齐（幂等）
 *   node scripts/vendor.mjs --force    # 强制重写
 *   node scripts/vendor.mjs --check     # 只检查，缺失时退出码 1
 *
 * 只读 app.asar，只写本插件的 node_modules/。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractTo, listEntries } from './asar.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.dirname(HERE);
const MODULES_DIR = path.join(PLUGIN_DIR, 'node_modules');

const APP_CANDIDATES = [
  process.env.DSH_ASAR,
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
].filter(Boolean);

const PACKAGES = {
  '@deepseek-ai/schemastery': 'schemastery',
  '@deepseek-ai/cosmokit': 'cosmokit',
};

const args = process.argv.slice(2);
const force = args.includes('--force');
const checkOnly = args.includes('--check');

function findAsar() {
  return APP_CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
}

/** 该包在本插件 node_modules 里是否已可用。 */
function installed(spec) {
  const pkg = path.join(MODULES_DIR, spec, 'package.json');
  if (!fs.existsSync(pkg)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkg, 'utf8')).version ?? '?';
  } catch {
    return null;
  }
}

function main() {
  const missing = Object.keys(PACKAGES).filter((spec) => force || !installed(spec));
  if (!missing.length) {
    const versions = Object.keys(PACKAGES).map((s) => `${s}@${installed(s)}`).join(', ');
    process.stdout.write(`已就绪: ${versions}\n`);
    return 0;
  }

  if (checkOnly) {
    process.stderr.write(`缺少运行时依赖: ${missing.join(', ')}（运行 node scripts/vendor.mjs 补齐）\n`);
    return 1;
  }

  const asar = findAsar();
  if (!asar) {
    process.stderr.write(
      '错误: 找不到 DSH 应用包 app.asar。请用 DSH_ASAR 指定，或让 DSH 桌面端自行解析该依赖。\n' +
        `已尝试: ${APP_CANDIDATES.join(', ')}\n`,
    );
    return 2;
  }

  for (const spec of missing) {
    const dirName = PACKAGES[spec];
    // lib/index.js 是主机半侧唯一的入口；顺带取 package.json 与 cjs 版本。
    const entries = listEntries(`/dsh/node_modules/${spec}/`, asar).filter((p) =>
      p.startsWith(`/dsh/node_modules/${spec}/`),
    );
    if (!entries.length) {
      process.stderr.write(`错误: 应用包中找不到 ${spec}\n`);
      return 2;
    }
    extractTo(entries, MODULES_DIR, asar);
    const version = installed(spec);
    process.stdout.write(`已补齐 ${spec}@${version ?? '?'} → ${path.join(MODULES_DIR, spec)}（${entries.length} 个文件）\n`);
    if (!version) {
      process.stderr.write(`错误: ${dirName} 提取后仍读不到 package.json\n`);
      return 2;
    }
  }
  return 0;
}

const code = main();
if (code) process.exit(code);
