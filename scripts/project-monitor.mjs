#!/usr/bin/env node
/**
 * project-monitor CLI 入口（薄包装）。
 *
 * 真正的实现位于 ../lib/cli.mjs —— 之所以拆成两层：本环境的 ESM 解析器对
 * 「向上越出包的相对说明符」会丢一段路径（`../lib/x.mjs` 被解析到包外），
 * 而同级 `./x.mjs` 始终精确，因此实现必须与它依赖的引擎处于同一目录。
 *
 * 用法与全部选项见 `node lib/cli.mjs --help` 或 plugin/README.md。
 */
import { main } from '../lib/cli.mjs';

// 必须显式调用并把返回码作为进程退出码——只 import 会让所有错误码都变成 0。
try {
  const code = await main(process.argv.slice(2));
  if (typeof code === 'number' && code !== 0) process.exit(code);
} catch (err) {
  process.stderr.write(`错误: ${err.message}\n`);
  process.exit(1);
}
