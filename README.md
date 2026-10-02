# project-monitor —— 事项进度管理插件

一个**自己拥有数据**的事项管理器：用户在面板里录入与推进事项，插件负责分级预警与
每日摘要。Excel 只是随时可再生的导出物，用户不需要知道它的存在。

```
用户
 └─ DSH 侧栏「事项进展」面板 ──HTTP──> 插件宿主半侧 ──> 权威存储（JSON，原子写）
                                        │                 $DSH_HOME/project-monitor/
                                        ├─ 导出投影 ──> dashboard.xlsx（Tasks + Dashboard）
                                        └─ 每日摘要 ──> daily-summaries/<日期>.md
```

## 数据在哪

| 路径 | 作用 |
|---|---|
| `$DSH_HOME/project-monitor/tasks.json` | **权威数据**（原子写：临时文件 + rename） |
| `$DSH_HOME/project-monitor/events.ndjson` | 变更流水，只追加，用于审计与排障 |
| `$DSH_HOME/project-monitor/backups/<日期>.json` | 每天首次写入前自动备份，保留 14 份 |
| `$DSH_HOME/project-monitor/dashboard.xlsx` | 导出投影：`Tasks`（全量）+ `Dashboard`（看板） |
| `$DSH_HOME/project-monitor/daily-summaries/<日期>.md` | 每天早晨的摘要 |

导出物**可以随时删掉**，`export` 会重新生成；删它不会丢任何数据。

## 录入方式（面板内）

| 方式 | 用法 |
|---|---|
| **快捷行** | `项目 / 事项 / 类别 / 负责人 / 截止日 / 优先级 / 进度` —— 只有前两项必填，字段乱序也能归位 |
| **批量粘贴** | 每行一条（可直接从表格复制），值可乱序；**先预览再确认**，坏行逐行标红且不阻断好行 |
| **表单** | 需要填全字段时展开；项目名/负责人带历史值自动补全 |

日期一律支持自然写法：`2026-10-20`、`10/20`、`10月20日`、`明天`、`3天后`、`下周五`、
`下个月`、`月底`；进度支持 `30%` / `0.3` / `30`。**识别不了就报错**，不会猜也不会静默丢弃。

列表里可以：勾选完成、`+7天` 顺延、改进度、编辑、删除（软删除，**可撤销**），
再配合搜索、项目/负责人/状态筛选、六级分级筛选与排序。

## 安装到 DSH

**全新安装零配置**：不需要任何本地 Excel。装好即用空存储，直接在面板录入；
Excel 只在两种情况下出现——附近碰巧有旧 `project-tracker.xlsx` 时自动迁移一次，
以及你主动点「导出 Excel」时生成投影文件。

### 方式一：从 GitCode / npm 安装（推荐给其他用户）

- **GUI**：侧栏 **插件 → 添加插件** → 粘贴仓库地址（如 `https://gitcode.com/Holibut/dsh-plugin-project-monitor`）
  或 npm 包名 → 安装 → 立即启用（任意可访问的 git 地址均可，安装器底层是 pnpm）
- **CLI**（需先完全退出桌面端）：
  ```bash
  /Applications/DeepSeek\ Harness.app/Contents/Resources/runtime/cli/bin/dsh plugin --profile desktop add <仓库地址或包名>
  ```

> 已知问题（宿主 0.2.0-rc.2 实测）：远程安装可能**只装包不插行**，装完没激活。
> 往 profile 的 `cordis.patch.yml` 追加一行即可（行 id 用包名，与 `client.js` 的 bundle id 对齐）：
>
> ```yaml
> - id: project-monitor
>   name: project-monitor
>   config: {}
> ```

### 方式二：从本地路径安装（开发者）

```bash
node plugin/scripts/install.mjs      # 预检并打印与你机器匹配的安装指引
```

- **GUI**：侧栏 **插件 → 添加插件** → 粘贴 `plugin/` 的绝对路径 → 安装 → 立即启用
- **CLI**：同上，`dsh plugin --profile desktop add <plugin 绝对路径>`

### 发布指引（维护者）

1. `cd plugin && git init && git add -A && git commit -m "project-monitor v1.0.0"`（`.gitignore` 已排除 `node_modules/`）
2. 在 GitCode 建仓库（`https://gitcode.com/Holibut/dsh-plugin-project-monitor`）并 push；用户即可用**方式一**安装
   ```bash
   git remote add origin https://gitcode.com/Holibut/dsh-plugin-project-monitor.git
   git push -u origin main
   ```
3. 若要发 npm：先在 `package.json` 补 `repository` 字段，然后 `npm publish`
   （`private` 已移除，`files` 白名单只发布清单内文件）
4. 面板端数据与配置都在 `$DSH_HOME/project-monitor/`，与仓库无关，升级插件不丢数据

## 宿主接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/project-monitor/api/view` | 列表视图：`search/project/owner/status/level/sort/limit/offset` |
| GET | `/project-monitor/api/meta` | 枚举候选值、可选项目/负责人、存储统计、迁移状态 |
| GET | `/project-monitor/api/summary` | 今日摘要（markdown） |
| GET | `/project-monitor/api/health` | 自检：数据目录、存储统计、导出路径 |
| POST | `/project-monitor/api/parse` | 解析录入文本（`quick`/`paste`/`date`），**不落库** |
| POST | `/project-monitor/api/tasks` | 新增一条 |
| POST | `/project-monitor/api/tasks/bulk` | 批量新增（`items` 数组或 `text` 粘贴文本） |
| PATCH | `/project-monitor/api/tasks/:ref` | 更新一条（支持 `expectedUpdatedAt` 乐观并发，冲突返回 409） |
| DELETE | `/project-monitor/api/tasks/:ref` | 软删除 |
| POST | `/project-monitor/api/tasks/update` | 批量更新（同一 patch） |
| POST | `/project-monitor/api/tasks/delete` / `restore` | 批量软删除 / 撤销 |
| POST | `/project-monitor/api/export` | 重新生成 Excel 与摘要文件 |

`ref` 可以是 `Task_ID`，也可以是唯一的**事项名称**。

配置（`cordis.patch.yml` 的行 `config`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `$DSH_HOME/project-monitor` | 数据目录 |
| `exportWorkbook` | `<dataDir>/dashboard.xlsx` | Excel 导出路径 |
| `summaryDir` | `<导出目录>/daily-summaries` | 摘要目录 |
| `legacyWorkbook` | 自动探测 | 首次迁移来源；留空表示自动找 |
| `writeFiles` | `true` | 关掉即不写任何导出文件（只读模式） |
| `cacheTtlMs` | `2000` | 视图缓存毫秒数 |
| `todayOverride` | 空 | 基准日期固定值，便于复现历史视图 |

## 改完客户端代码后为什么"看不到变化"

宿主给插件 bundle 发的是 `cache-control: immutable`，所以**改完 `client.js` 刷新页面不会
重新拉取**，看起来就像改动没生效。判断与解决办法：

1. **看面板标题旁的指纹**：标题右侧会显示 `build <8位>`。把这个值和服务端对一下
   （`curl` 或浏览器打开 `/project-monitor/api/meta` 看 `build` 字段）。两者不一致时，
   面板会直接红字提示"页面上的插件代码是旧的"，因为宿主换了新代码而页面还在跑旧的。
2. **硬刷新**：`Cmd + Shift + R`（开发者工具打开并勾选 Disable cache 更稳）。
3. **还是旧的就重启桌面端**：重启一定会加载新的模块代次。

桌面端没有浏览器控制台——所以布局测量结果直接显示在面板上：

```
布局 滚动区669 面板673 视口873 顶200 底873 内容1204 容器DIV.xxx · 可滚动
        ↑可用高  ↑面板高  ↑视口  ↑面板顶 ↑容器底 ↑内容高   ↑最近的有界祖先
```

"内容 > 滚动区"时列表应能滚动；若"面板顶 + 面板高 > 容器底"，说明高度被算大了、
会被容器裁掉（这种现象是"看不全但也没有滚动条"）。

## 每天早晨的摘要（走 DSH 官方 Schedule）

官方调度器是**默认关闭**的实验性组合包，先启用它：

1. 侧栏 **插件 → 官方**，找到 **Schedule**（`@deepseek-ai/dsh-experimental-schedule-bundle`），启用；
2. **重启桌面端**，让 `schedule_*` 工具挂上；
3. 创建每日提醒（可以直接对我说，或自己用工具）：

```
schedule_create
  title:  事项进展摘要
  prompt: 刷新 project-monitor 看板并汇报今日摘要
  daily:  { time: "08:00:00", time_zone: "Asia/Shanghai" }
  # 也可以更精细：cron: { expression: "0 8 * * 1-5", time_zone: "Asia/Shanghai" }  # 仅工作日
```

到点时宿主把这条 prompt 作为**一条消息投进原会话**，我（Agent）会读存储、刷新 Excel、
汇报当天摘要——摘要既进对话，也落盘到 `$DSH_HOME/project-monitor/daily-summaries/<日期>.md`。

注意两点限制（来自 DSH 的 Schedule 实现）：

- **宿主必须在运行**：提醒靠宿主进程定时器投递，DSH 没开就不会触发（开机后补发最近一次错过的时点）；
- 投递是"消息进入会话"，不保证跨崩溃的精确一次；只想要文件不想要对话消息的话，用下面的 CLI 路线。

### 备选：不依赖 DSH 运行（launchd）

仓库里保留了已测试的 macOS launchd 方案，但它不是主线，也没有替你安装：

```bash
cd ppm2
sed "s|__PLUGIN_DIR__|$PWD/plugin|g" plugin/scheduling/com.project-monitor.daily.plist \
  > ~/Library/LaunchAgents/com.project-monitor.daily.plist
launchctl load ~/Library/LaunchAgents/com.project-monitor.daily.plist
launchctl start com.project-monitor.daily      # 立刻试跑
```

它只做"刷新 Excel + 落摘要文件 + 写日志"，不产生对话消息。
环境变量：`PM_DATA_DIR`（数据目录）、`PM_LEGACY`（首次迁移来源）、`PM_NODE`、`PM_EXTRA_ARGS`。

### 备选：手动/脚本

```bash
node plugin/lib/cli.mjs               # 打印摘要并刷新导出件（可丢进任意 cron/计划任务）
node plugin/lib/cli.mjs export        # 只重新生成 Excel + 摘要文件
```

## 命令行

```bash
node plugin/lib/cli.mjs                         # 打印摘要并刷新导出件
node plugin/lib/cli.mjs list --level overdue    # 看清单（--search/--project/--owner/--status/--sort/--limit）
node plugin/lib/cli.mjs add "甲项目 / 写总结 / 10/20 / 高"
node plugin/lib/cli.mjs add "多行文本…" --paste  # 逐行解析；坏行退出码 3
node plugin/lib/cli.mjs export                  # 只重新生成 Excel + 摘要
node plugin/lib/cli.mjs check                   # 体检（退出码 3 表示有提醒项）
```

全局选项：`--dir`、`--today`、`--json`、`--text`、`--quiet`、`--export`、
`--summary-dir`、`--no-write`、`--legacy`。

## 分级规则（面板 / Excel / 摘要三处一致）

D = 截止日 − 基准日期；`已完成` 不参与预警；没有截止日期归入「未设截止」单列。

| 级别 | 条件 | 配色（背景/字色） |
|---|---|---|
| 已逾期 | D < 0 | `#FFC7CE` / `#9C0006` |
| 红色 | 0 ≤ D ≤ 3 | `#FFC7CE` / `#9C0006` |
| 橙色 | 4 ≤ D ≤ 7 | `#FFD8A8` / `#B35C00` |
| 黄色 | 8 ≤ D ≤ 30 | `#FFEB9C` / `#9C6500` |
| 绿色 | D > 30 | `#C6EFCE` / `#006100` |

迁移时旧表里的 `已逾期` 状态会被规整为 `进行中`（逾期由截止日派生），并记录原因；
合法的历史/口语写法（`紧急`、`报销`、`进行` 等）走别名映射，而不是让整行失败。

## 字段与状态

```
id  project*  name*  category  owner  start  due  status  priority  progress  notes
                                                  未开始/进行中/待审核/已完成   0–1
```

- `category` ∈ 申报 / 结题 / 经费 / 汇报 / 其他
- `status` ∈ 未开始 / 进行中 / 待审核 / 已完成（已完成自动置进度 100%）
- `priority` ∈ 高 / 中 / 低
- `id` 由插件分配（`T-001` 起，不复用空洞）；时间戳为 ISO-8601

## 目录结构

```
plugin/
├── package.json          dsh.bundle + dsh.client 清单
├── index.js              宿主半侧：存储 + 路由
├── client.js             浏览器半侧：录入 + 列表 + 编辑面板
├── cordis.patch.yml      安装时插入的 loader 行
├── lib/                  零第三方依赖的引擎（与宿主/CLI 同目录，便于 ESM 解析）
│   ├── store.mjs         JSON 存储：原子写、串行化、软删除、备份、迁移
│   ├── tasks.mjs         领域模型：校验、别名、Task_ID、分级
│   ├── query.mjs         录入解析：自然语言日期、快捷行、批量粘贴
│   ├── read.mjs          读模型：搜索/筛选/排序/分组/指标/项目维度
│   ├── export.mjs        Excel 投影：Tasks + Dashboard
│   ├── dashboard.mjs     分级规则与中文摘要（三处共用）
│   ├── xlsx.mjs / zip.mjs  自研 OOXML / ZIP 读写
│   └── cli.mjs           命令行入口
├── scripts/              预检、依赖本地化、薄包装、只读 ASAR 工具
├── scheduling/           launchd 每日摘要
└── test/                 84 个回归测试（node --test）
```

## 开发

```bash
cd plugin
node --test test/*.test.mjs      # 84 项：存储/解析/迁移/读模型/导出/宿主路由/CLI
node scripts/vendor.mjs          # 补齐宿主半侧运行时依赖（幂等）
node scripts/install.mjs         # 安装预检
```

## 两个实现要点

**① 引擎零第三方依赖。** 自研 ZIP（stored + deflate，CRC-32 自算）与最小 OOXML
读写器（共享字符串、内联字符串、按数字格式识别日期、多表、四种样式表）只依赖
Node 内置 `zlib`，因此插件在 DSH 运行时、系统 node、Electron 里行为一致。
宿主半侧唯一的外部依赖是 DSH 自己的 `@deepseek-ai/schemastery`，由
`scripts/vendor.mjs` 从 app.asar 本地化进插件的 `node_modules/`（168 KB），
profile 不必为它装任何东西。

**② 本环境的 ESM 解析器对「上越包边界」的相对说明符会丢一段路径。**
从 `plugin/` 里写 `../lib/x.mjs` 会落到 `ppm2/lib/x.mjs`（少一段），而同级
`./x.mjs` 始终精确。因此实现必须与它依赖的引擎同目录（`lib/cli.mjs`），
`scripts/project-monitor.mjs` 只做一层包装，测试统一用绝对 `file://` URL 导入。

## 与 `project-monitor` skill 的关系

旧的 `~/.agents/skills/project-monitor`（`build_dashboard.py`）以 Excel 为输入，
本插件以自身存储为输入、Excel 为输出。两者分级规则与看板布局一致，可以并存：
skill 适合"已有表格、只做看板"，插件适合"不想碰表格、要能录入"。
