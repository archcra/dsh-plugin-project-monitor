/**
 * 只读 ASAR 读取工具（用于研究 / 回归测试：从 DSH 应用包里取运行时依赖）。
 *
 * 关键点：asar 头的真实数据基址是 `8 + readUInt32LE(4)`，而不是
 * `16 + readUInt32LE(12)`——后者会短 2 字节并静默损坏每一个提取出的文件。
 *
 *   node scripts/asar.mjs list <子串> [上限]
 *   node scripts/asar.mjs cat <包内绝对路径>
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_ARCHIVE = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';

export function openArchive(archivePath = DEFAULT_ARCHIVE) {
  const archive = fs.readFileSync(archivePath);
  const stringLength = archive.readUInt32LE(12); // JSON 字符串长度（不含对齐填充）
  const json = archive.subarray(16, 16 + stringLength).toString('utf8');
  // 实测：载荷基址 = 8 + UInt32LE(4) = 16 + stringLength + 2（对齐到 4 字节）
  const payloadBase = 8 + archive.readUInt32LE(4);
  const header = JSON.parse(json);
  return { archive, header, payloadBase };
}

function resolveEntry(header, entryPath) {
  let node = header;
  for (const part of entryPath.replace(/^\//, '').split('/')) {
    if (!node?.files?.[part]) return null;
    node = node.files[part];
  }
  return node;
}

export function readEntry(entryPath, archivePath) {
  const { archive, header, payloadBase } = openArchive(archivePath);
  const entry = resolveEntry(header, entryPath);
  if (!entry) throw new Error(`asar 中找不到 ${entryPath}`);
  if (entry.files) throw new Error(`${entryPath} 是目录`);
  const start = payloadBase + Number(entry.offset);
  return archive.subarray(start, start + entry.size);
}

export function listEntries(prefix, archivePath) {
  const { header } = openArchive(archivePath);
  const out = [];
  (function walk(node, base) {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const p = `${base}/${name}`;
      if (value.files) walk(value, p);
      else out.push(p);
    }
  })(header, '');
  return out.filter((p) => p.includes(prefix));
}

/**
 * 把 asar 里的文件提取到目标目录，返回写出的文件列表。
 * 目标相对路径取条目路径中最后一个 `node_modules/` 之后的部分，
 * 因此 `/dsh/node_modules/@scope/pkg/lib/x.js` → `<dest>/@scope/pkg/lib/x.js`。
 * 只用于测试夹具，绝不会写回 app.asar。
 */
export function extractTo(entries, destDir, archivePath) {
  const written = [];
  for (const entry of entries) {
    const marker = 'node_modules/';
    const at = entry.lastIndexOf(marker);
    const rel = at >= 0 ? entry.slice(at + marker.length) : path.basename(entry);
    const target = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, readEntry(entry, archivePath));
    written.push(target);
  }
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [cmd, arg, extra] = process.argv.slice(2);
  if (cmd === 'cat') {
    process.stdout.write(readEntry(arg));
  } else if (cmd === 'list') {
    const list = listEntries(arg ?? '');
    const limit = Number(extra ?? 100);
    process.stdout.write(`${list.slice(0, limit).join('\n')}\n--- total ${list.length}\n`);
  } else {
    process.stderr.write('用法: node scripts/asar.mjs list <子串> [上限] | cat <路径>\n');
    process.exit(2);
  }
}
