/**
 * project-monitor —— DSH 插件（浏览器半侧）
 *
 * 事项管理器面板：插件自己拥有数据，用户完全不需要知道 Excel 的存在。
 *
 *   ├ 顶部：计数徽标（逾期/3天/7天/…）+ 复制摘要 + 导出 Excel + 刷新
 *   ├ 录入：一个输入框三种用法（快捷行 / 粘贴多行 / 表单展开）
 *   ├ 筛选：搜索、项目、负责人、状态、分级、排序
 *   └ 列表：红橙黄绿分组，行内完成 / 改期 / 改进度 / 编辑 / 删除（可撤销）
 *
 * 本文件按 DSH 客户端模块约定手写：用 `window.__ModuleLoader__.load({ id, factory })`
 * 包一层，只从宿主平台表取 `react` / `react/jsx-runtime`，因此无需打包步骤。
 */
window.__ModuleLoader__.load({
  // 必须与 package.json 的 name 一致：宿主按 Loader 行 id 匹配已注册的 bundle。
  id: 'project-monitor',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const { jsx, jsxs, Fragment } = require('react/jsx-runtime');

    const API = '/project-monitor/api';
    const PANEL_ID = 'project-monitor';
    const NS = 'projectMonitor';

    /* ------------------------------------------------------------ 配色 */

    const LEVELS = [
      { id: 'overdue', label: '已逾期', bg: '#FFC7CE', fg: '#9C0006' },
      { id: 'red', label: '3 天内到期', bg: '#FFC7CE', fg: '#9C0006' },
      { id: 'orange', label: '4–7 天内到期', bg: '#FFD8A8', fg: '#B35C00' },
      { id: 'yellow', label: '8–30 天内到期', bg: '#FFEB9C', fg: '#9C6500' },
      { id: 'green', label: '30 天以上', bg: '#C6EFCE', fg: '#006100' },
    ];
    const LEVEL_BY_ID = Object.fromEntries(LEVELS.map((l) => [l.id, l]));

    const CSS = `
.pm-root{display:flex;flex-direction:column;gap:8px;padding:12px 14px 0;min-height:0;box-sizing:border-box;
  /* !important：宿主容器可能对面板内元素统一设了 overflow，必须锁住自己的滚动语义 */
  overflow:hidden !important;color:var(--dsw-alias-label-primary,#1a1a1a);font-size:13px;line-height:1.5;
  /* 高度策略：先试 100%（宿主若给了确定高度就对了），JS 会用 --pm-fit 覆盖成实测像素值。
     两条都失败时还有 100dvh 兑底，保证面板自身一定能滚。 */
  height:var(--pm-fit, 100%);
  max-height:var(--pm-fit, 100dvh)}
.pm-top{display:flex;flex-direction:column;gap:8px;flex:0 0 auto}
/* 列表独立滚动区：内容多时用鼠标滚轮/滚动条上下移动，头部与录入区始终可见 */
.pm-scroll{flex:0 0 auto;overscroll-behavior:contain;outline:none;scrollbar-gutter:stable;
  /* !important：这是整个面板的滚动语义所在，绝不能被宿主或其它规则改成 hidden */
  /* 交回 flex 分配剩余空间；同时用 max-height 兜住：
     若 flex 没把高度收住，滚动区会被内容撑高，scrollHeight 永远等于 clientHeight，
     于是"没有溢出可滚"，内容超出部分直接不可达（这次就是这么坑的）。 */
  overflow-y:auto !important;overflow-x:hidden !important;
  /* box-sizing 必须是 border-box：content-box 时 max-height 只限"内容高"，
     补的 padding 会同时进 scrollHeight 与 clientHeight，数学上永远 sh==ch，滚不动。 */
  box-sizing:border-box;flex:1 1 auto;min-height:0;
  /* 唯一一条 max-height（写两条会让后者覆盖前者）：优先 JS 实测值，未测出时退到视口估算 */
  max-height:var(--pm-scroll-max, calc(100vh - 300px));
  scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,rgba(0,0,0,.22)) transparent;
  display:flex;flex-direction:column;gap:8px;padding:2px 2px 8px;margin-right:-4px}
/* 关键：flex 子项必须保持自然高度。默认 flex-shrink:1 会让限高的滚动区把分组卡片压扁，
   卡片自己的 overflow:hidden 再把行裁掉 —— 裁掉的部分不进入可滚动区域（scrollHeight 不增长），
   于是"看不全 + 滚不动"，与宿主布局无关。 */
.pm-scroll>*{flex-shrink:0}
.pm-scroll:focus-visible{box-shadow:inset 0 0 0 2px rgba(31,78,121,.35)}
.pm-scroll::-webkit-scrollbar{width:10px}
.pm-scroll::-webkit-scrollbar-track{background:transparent}
.pm-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,rgba(0,0,0,.34));
  border-radius:5px;border:2px solid transparent;background-clip:content-box}
.pm-scroll::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2,rgba(0,0,0,.36));
  background-clip:content-box}
.pm-scroll-fade{flex:0 0 auto;height:12px;margin:0 -14px;
  background:linear-gradient(to top,var(--dsw-alias-bg-base,transparent),transparent);pointer-events:none}
.pm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.pm-title{margin:0;font-size:16px;font-weight:600}
.pm-sub{margin:2px 0 0;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8c8c8c)}
.pm-mono{font-family:var(--dsw-font-mono,ui-monospace,Menlo,monospace);font-size:11px}
.pm-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.pm-btn{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));background:transparent;color:inherit;
  border-radius:var(--dsw-radius-sm,6px);padding:4px 9px;font-size:12px;cursor:pointer;white-space:nowrap}
.pm-btn:hover:not([disabled]){background:var(--dsw-alias-fill-l1,rgba(0,0,0,.05))}
.pm-btn[disabled]{opacity:.45;cursor:default}
.pm-primary{border-color:transparent;background:#1F4E79;color:#fff}
.pm-primary:hover:not([disabled]){background:#173d5f}
.pm-chips{display:flex;gap:6px;flex-wrap:wrap}
.pm-chip{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));border-radius:var(--dsw-radius-sm,6px);
  padding:3px 8px;font-size:11.5px;background:var(--dsw-alias-fill-l1,rgba(0,0,0,.02));cursor:pointer}
.pm-chip[data-active="1"]{border-color:#1F4E79;background:rgba(31,78,121,.1)}
.pm-chip b{font-weight:600;margin-left:4px}
.pm-composer{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));
  border-radius:var(--dsw-radius-md,8px);padding:8px;background:var(--dsw-alias-fill-l1,rgba(0,0,0,.02))}
.pm-input,.pm-select,.pm-textarea{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14));
  border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-base,transparent);color:inherit;
  padding:5px 8px;font-size:12.5px;font-family:inherit;width:100%}
.pm-textarea{min-height:56px;resize:vertical}
.pm-input:focus,.pm-select:focus,.pm-textarea:focus{outline:none;border-color:#1F4E79}
.pm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px}
.pm-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8c8c8c)}
.pm-bad{font-size:11.5px;color:#9C0006}
.pm-ok{font-size:11.5px;color:#006100}
.pm-filters{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.pm-filters .pm-select,.pm-filters .pm-input{width:auto;min-width:104px}
.pm-section{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));border-radius:var(--dsw-radius-md,8px);overflow:hidden}
.pm-sec-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 10px;
  font-weight:600;font-size:12.5px;font-family:inherit;border:0;width:100%;text-align:left;cursor:pointer}
.pm-sec-head:hover{filter:brightness(0.97)}
.pm-row{display:grid;grid-template-columns:auto 1fr auto;gap:9px;align-items:start;padding:7px 10px;
  border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07))}
.pm-row:hover{background:var(--dsw-alias-fill-l1,rgba(0,0,0,.025))}
.pm-check{margin-top:3px;width:15px;height:15px;cursor:pointer;accent-color:#1F4E79}
.pm-row-id{font-family:var(--dsw-font-mono,ui-monospace,Menlo,monospace);font-size:11px;font-weight:600;opacity:.85}
.pm-row-task{font-weight:500}
.pm-row-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#8c8c8c);margin-top:1px}
.pm-row-right{display:flex;align-items:center;gap:6px;white-space:nowrap}
.pm-days{font-weight:600;font-size:11.5px}
.pm-icon{border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8c8c8c);cursor:pointer;
  font-size:11.5px;padding:2px 4px;border-radius:var(--dsw-radius-xs,4px)}
.pm-icon:hover{background:var(--dsw-alias-fill-l2,rgba(0,0,0,.07));color:inherit}
.pm-bar{height:3px;border-radius:2px;background:rgba(0,0,0,.14);overflow:hidden;margin-top:4px}
.pm-bar>span{display:block;height:100%}
.pm-empty{padding:9px 10px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8c8c8c)}
.pm-warn{padding:7px 10px;font-size:12px;background:#FFC7CE;color:#9C0006;border-radius:var(--dsw-radius-md,8px)}
.pm-err{padding:9px 11px;border-radius:var(--dsw-radius-md,8px);background:rgba(220,38,38,.1);color:#b91c1c;font-size:12px}
.pm-fade{color:var(--dsw-alias-label-tertiary,#8c8c8c);font-size:12px;padding:8px}
.pm-undo{display:flex;align-items:center;gap:8px;font-size:12px;padding:6px 10px;border-radius:var(--dsw-radius-md,8px);
  background:var(--dsw-alias-fill-l2,rgba(0,0,0,.06))}
.pm-more{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px}
`;

    function useStyles() {
      react.useEffect(() => {
        const id = 'project-monitor-styles';
        if (document.getElementById(id)) return undefined;
        const el = document.createElement('style');
        el.id = id;
        el.textContent = CSS;
        document.head.appendChild(el);
        return undefined;
      }, []);
    }

    /* ------------------------------------------------------------ 图标 */

    function PanelIcon({ size = 16 }) {
      return jsxs('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
        children: [
          jsx('rect', { key: 'a', x: 1.8, y: 1.8, width: 12.4, height: 12.4, rx: 2 }),
          jsx('path', { key: 'b', d: 'M4.6 11.2V8.4M8 11.2V5.2M11.4 11.2V6.8' }),
        ],
      });
    }

    /* -------------------------------------------------------- 小工具 */

    function daysPhrase(days) {
      if (days === null || days === undefined) return '未设截止';
      if (days < 0) return `逾期 ${-days} 天`;
      if (days === 0) return '今天到期';
      return `剩 ${days} 天`;
    }

    function pct(v) {
      return typeof v === 'number' ? `${Math.round(v * 100)}%` : '—';
    }

    async function request(pathname, options = {}) {
      const init = { ...options };
      if (init.body !== undefined && typeof init.body !== 'string') {
        init.headers = { 'content-type': 'application/json', ...(init.headers ?? {}) };
        init.body = JSON.stringify(init.body);
      }
      const res = await fetch(`${API}${pathname}`, init);
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`接口返回非 JSON（HTTP ${res.status}）`);
      }
      if (!res.ok || data.ok === false) {
        const err = new Error(data.error ?? `HTTP ${res.status}`);
        err.payload = data;
        throw err;
      }
      return data;
    }

    function buildQuery(filters, extra = {}) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...filters, ...extra })) {
        if (v !== '' && v !== null && v !== undefined) q.set(k, String(v));
      }
      const s = q.toString();
      return s ? `?${s}` : '';
    }

    /* ------------------------------------------------------ 录入区 */

    const EMPTY_FORM = {
      project: '', name: '', category: '其他', owner: '', due: '', priority: '中', status: '未开始', progress: '', notes: '',
    };

    function Composer({ enums, projects, owners, onCreate, onPaste, onError }) {
      const [mode, setMode] = react.useState('quick'); // quick | paste | form
      const [text, setText] = react.useState('');
      const [form, setForm] = react.useState(EMPTY_FORM);
      const [busy, setBusy] = react.useState(false);
      const [msg, setMsg] = react.useState(null);
      const [preview, setPreview] = react.useState(null);

      const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

      const submitQuick = async () => {
        if (!text.trim() || busy) return;
        setBusy(true);
        setMsg(null);
        try {
          const parsed = await request('/parse', { method: 'POST', body: { mode: 'quick', text } });
          if (!parsed.ok) {
            setMsg({ kind: 'bad', text: parsed.errors.join('；') });
            return;
          }
          await onCreate(parsed.record);
          setText('');
          setMsg({ kind: 'ok', text: '已新增' });
        } catch (err) {
          setMsg({ kind: 'bad', text: err.message });
          onError?.(err);
        } finally {
          setBusy(false);
        }
      };

      const previewPaste = async () => {
        if (!text.trim() || busy) return;
        setBusy(true);
        setMsg(null);
        try {
          const parsed = await request('/parse', { method: 'POST', body: { mode: 'paste', text } });
          setPreview(parsed);
        } catch (err) {
          setMsg({ kind: 'bad', text: err.message });
        } finally {
          setBusy(false);
        }
      };

      const commitPaste = async () => {
        if (!text.trim() || busy) return;
        setBusy(true);
        try {
          const res = await request('/tasks/bulk', { method: 'POST', body: { text } });
          setPreview(null);
          setText('');
          const warn = res.warnings?.length ? `；${res.warnings.length} 行被跳过` : '';
          setMsg({ kind: res.warnings?.length ? 'bad' : 'ok', text: `已新增 ${res.created} 条${warn}` });
          await onPaste();
        } catch (err) {
          setMsg({ kind: 'bad', text: err.message });
          onError?.(err);
        } finally {
          setBusy(false);
        }
      };

      const submitForm = async (e) => {
        e?.preventDefault?.();
        if (busy) return;
        if (!form.project.trim() || !form.name.trim()) {
          setMsg({ kind: 'bad', text: '项目名称与事项名称为必填' });
          return;
        }
        setBusy(true);
        try {
          await onCreate({ ...form, progress: form.progress === '' ? undefined : form.progress });
          setForm(EMPTY_FORM);
          setMsg({ kind: 'ok', text: '已新增' });
        } catch (err) {
          setMsg({ kind: 'bad', text: err.message });
        } finally {
          setBusy(false);
        }
      };

      const tabs = [
        ['quick', '快捷行'],
        ['paste', '批量粘贴'],
        ['form', '表单'],
      ];

      return jsxs('div', {
        className: 'pm-composer',
        children: [
          jsxs('div', {
            style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
            children: [
              ...tabs.map(([id, label]) =>
                jsx('button', {
                  key: id,
                  className: 'pm-chip',
                  'data-active': mode === id ? '1' : '0',
                  onClick: () => { setMode(id); setMsg(null); setPreview(null); },
                  children: label,
                }),
              ),
              jsx('span', {
                className: 'pm-hint',
                children: mode === 'quick'
                  ? '项目 / 事项 / 类别 / 负责人 / 截止日 / 优先级 / 进度 —— 只有前两项必填，日期可写「明天」「下周五」「10/20」'
                  : mode === 'paste'
                    ? '每行一条（可直接从表格复制），值可乱序；先预览再确认'
                    : '需要填全字段时用表单',
              }),
            ],
          }),

          mode === 'form'
            ? jsxs('form', {
                onSubmit: submitForm,
                style: { display: 'flex', flexDirection: 'column', gap: 6 },
                children: [
                  jsxs('div', {
                    className: 'pm-grid',
                    children: [
                      jsx('input', { className: 'pm-input', placeholder: '项目名称 *', value: form.project, onChange: set('project'), list: 'pm-projects' }),
                      jsx('input', { className: 'pm-input', placeholder: '事项名称 *', value: form.name, onChange: set('name') }),
                      jsx('select', { className: 'pm-select', value: form.category, onChange: set('category'), children: enums.categories.map((c) => jsx('option', { key: c, value: c, children: c })) }),
                      jsx('input', { className: 'pm-input', placeholder: '负责人', value: form.owner, onChange: set('owner'), list: 'pm-owners' }),
                      jsx('input', { className: 'pm-input', placeholder: '截止日 例：下周五 / 10/20', value: form.due, onChange: set('due') }),
                      jsx('select', { className: 'pm-select', value: form.priority, onChange: set('priority'), children: enums.priorities.map((p) => jsx('option', { key: p, value: p, children: p })) }),
                    ],
                  }),
                  jsxs('div', {
                    className: 'pm-grid',
                    children: [
                      jsx('select', { className: 'pm-select', value: form.status, onChange: set('status'), children: enums.statuses.map((s) => jsx('option', { key: s, value: s, children: s })) }),
                      jsx('input', { className: 'pm-input', placeholder: '进度 例：30%', value: form.progress, onChange: set('progress') }),
                      jsx('input', { className: 'pm-input', placeholder: '备注', value: form.notes, onChange: set('notes') }),
                    ],
                  }),
                  jsxs('div', {
                    style: { display: 'flex', gap: 6 },
                    children: [
                      jsx('button', { className: 'pm-btn pm-primary', type: 'submit', disabled: busy, children: busy ? '保存中…' : '新增事项' }),
                      jsx('button', { className: 'pm-btn', type: 'button', onClick: () => setForm(EMPTY_FORM), children: '清空' }),
                    ],
                  }),
                ],
              })
            : mode === 'quick'
              ? jsxs('div', {
                  style: { display: 'flex', gap: 6 },
                  children: [
                    jsx('input', {
                      className: 'pm-input',
                      placeholder: '例：横向课题B / 设备验收 / 其他 / 钱老师 / 10/20 / 高 / 30%',
                      value: text,
                      onChange: (e) => setText(e.target.value),
                      onKeyDown: (e) => { if (e.key === 'Enter') submitQuick(); },
                    }),
                    jsx('button', { className: 'pm-btn pm-primary', onClick: submitQuick, disabled: busy || !text.trim(), children: busy ? '…' : '新增' }),
                  ],
                })
              : jsxs('div', {
                  style: { display: 'flex', flexDirection: 'column', gap: 6 },
                  children: [
                    jsx('textarea', {
                      className: 'pm-textarea',
                      placeholder: '每行一条，例如：\n甲项目,写总结,2026-10-10\n乙项目,验收,下个月初',
                      value: text,
                      onChange: (e) => { setText(e.target.value); setPreview(null); },
                    }),
                    jsxs('div', {
                      style: { display: 'flex', gap: 6, alignItems: 'center' },
                      children: [
                        jsx('button', { className: 'pm-btn', onClick: previewPaste, disabled: busy || !text.trim(), children: '预览' }),
                        jsx('button', {
                          className: 'pm-btn pm-primary',
                          onClick: commitPaste,
                          disabled: busy || !text.trim() || (preview ? preview.okCount === 0 : false),
                          children: preview ? `写入 ${preview.okCount} 条` : '写入',
                        }),
                        preview
                          ? jsx('span', {
                              className: preview.badCount ? 'pm-bad' : 'pm-ok',
                              children: `可写入 ${preview.okCount} 条${preview.badCount ? `，跳过 ${preview.badCount} 条` : ''}`,
                            })
                          : null,
                      ],
                    }),
                    preview && preview.badCount
                      ? jsx('div', {
                          className: 'pm-bad',
                          children: preview.rows.filter((r) => !r.ok).map((r) =>
                            jsx('div', { key: r.line, children: `第 ${r.line} 行：${r.errors.join('、')} —— ${r.raw}` }),
                          ),
                        })
                      : null,
                  ],
                }),

          msg ? jsx('div', { className: msg.kind === 'bad' ? 'pm-bad' : 'pm-ok', children: msg.text }) : null,

          jsxs('datalist', { id: 'pm-projects', children: projects.map((p) => jsx('option', { key: p, value: p })) }),
          jsxs('datalist', { id: 'pm-owners', children: owners.map((o) => jsx('option', { key: o, value: o })) }),
        ],
      });
    }

    /* ------------------------------------------------------ 详情编辑 */

    function Editor({ task, enums, onSave, onCancel, onDelete }) {
      const [draft, setDraft] = react.useState({
        project: task.project ?? '', name: task.name ?? '', category: task.category ?? '其他',
        owner: task.owner ?? '', due: task.due ?? '', priority: task.priority ?? '中',
        status: task.status ?? '未开始', progress: typeof task.progress === 'number' ? `${Math.round(task.progress * 100)}%` : '',
        notes: task.notes ?? '',
      });
      const [busy, setBusy] = react.useState(false);
      const [err, setErr] = react.useState(null);
      const set = (key) => (e) => setDraft((d) => ({ ...d, [key]: e.target.value }));

      const save = async () => {
        setBusy(true);
        setErr(null);
        try {
          await onSave(task.id, { ...draft, progress: draft.progress === '' ? undefined : draft.progress });
        } catch (e) {
          setErr(e.message);
        } finally {
          setBusy(false);
        }
      };

      return jsxs('div', {
        className: 'pm-composer',
        children: [
          jsxs('div', {
            style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
            children: [
              jsx('b', { children: `编辑 ${task.id}` }),
              jsx('span', { className: 'pm-hint', children: '新增日期也可直接写「明天」「下周五」「10/20」' }),
            ],
          }),
          jsxs('div', {
            className: 'pm-more',
            children: [
              jsx('input', { className: 'pm-input', value: draft.project, onChange: set('project'), placeholder: '项目名称' }),
              jsx('input', { className: 'pm-input', value: draft.name, onChange: set('name'), placeholder: '事项名称' }),
              jsx('select', { className: 'pm-select', value: draft.category, onChange: set('category'), children: enums.categories.map((c) => jsx('option', { key: c, value: c, children: c })) }),
              jsx('input', { className: 'pm-input', value: draft.owner, onChange: set('owner'), placeholder: '负责人' }),
              jsx('input', { className: 'pm-input', value: draft.due, onChange: set('due'), placeholder: '截止日 YYYY-MM-DD' }),
              jsx('select', { className: 'pm-select', value: draft.priority, onChange: set('priority'), children: enums.priorities.map((p) => jsx('option', { key: p, value: p, children: p })) }),
              jsx('select', { className: 'pm-select', value: draft.status, onChange: set('status'), children: enums.statuses.map((s) => jsx('option', { key: s, value: s, children: s })) }),
              jsx('input', { className: 'pm-input', value: draft.progress, onChange: set('progress'), placeholder: '进度 30%' }),
            ],
          }),
          jsx('textarea', { className: 'pm-textarea', value: draft.notes, onChange: set('notes'), placeholder: '备注' }),
          err ? jsx('div', { className: 'pm-bad', children: err }) : null,
          jsxs('div', {
            style: { display: 'flex', gap: 6 },
            children: [
              jsx('button', { className: 'pm-btn pm-primary', onClick: save, disabled: busy, children: busy ? '保存中…' : '保存' }),
              jsx('button', { className: 'pm-btn', onClick: onCancel, disabled: busy, children: '取消' }),
              jsx('span', { style: { flex: 1 } }),
              jsx('button', { className: 'pm-btn', onClick: () => onDelete(task.id), disabled: busy, children: '删除' }),
            ],
          }),
        ],
      });
    }

    /* ------------------------------------------------------ 列表行 */

    function TaskRow({ task, onPatch, onEdit, onDelete, onQuickDate }) {
      const lv = LEVEL_BY_ID[task.level] ?? null;
      const done = task.done;
      const style = lv ? { background: lv.bg, color: lv.fg } : undefined;
      return jsxs('div', {
        className: 'pm-row',
        style,
        children: [
          jsx('input', {
            className: 'pm-check',
            type: 'checkbox',
            checked: done,
            title: done ? '标记为未完成' : '标记为已完成',
            onChange: () => onPatch(task.id, { status: done ? '进行中' : '已完成' }, task.updatedAt),
          }),
          jsxs('div', {
            children: [
              jsxs('div', {
                children: [
                  jsx('span', { className: 'pm-row-id', children: task.id }),
                  ' ',
                  jsx('span', { className: 'pm-row-task', style: done ? { textDecoration: 'line-through', opacity: 0.7 } : undefined, children: task.name }),
                ],
              }),
              jsxs('div', {
                className: 'pm-row-meta',
                style: lv ? { color: lv.fg, opacity: 0.85 } : undefined,
                children: [
                  task.project ?? '—',
                  task.owner ? ` · ${task.owner}` : '',
                  task.due ? ` · 截止 ${task.due}` : ' · 未设截止日期',
                  task.priority ? ` · ${task.priority}` : '',
                  task.notes ? ` · ${task.notes}` : '',
                ],
              }),
              typeof task.progress === 'number'
                ? jsx('div', {
                    className: 'pm-bar',
                    style: lv ? { background: 'rgba(255,255,255,.55)' } : undefined,
                    children: jsx('span', {
                      style: { width: `${Math.min(100, Math.round(task.progress * 100))}%`, background: lv ? lv.fg : 'var(--dsw-alias-label-tertiary,#8c8c8c)' },
                    }),
                  })
                : null,
            ],
          }),
          jsxs('div', {
            className: 'pm-row-right',
            children: [
              jsx('span', { className: 'pm-days', children: done ? '已完成' : daysPhrase(task.days) }),
              jsx('span', { className: 'pm-row-meta', children: pct(task.progress) }),
              jsx('button', { className: 'pm-icon', title: '顺延 7 天', onClick: () => onQuickDate(task.id, 7), children: '+7天' }),
              jsx('button', { className: 'pm-icon', title: '编辑', onClick: () => onEdit(task.id), children: '编辑' }),
              jsx('button', { className: 'pm-icon', title: '删除', onClick: () => onDelete(task.id), children: '✕' }),
            ],
          }),
        ],
      });
    }

    /* ------------------------------------------------------ 主面板 */

    /** 最近一层「高度有界」的祖先（overflow 非 visible，或自身高度是确定值）。 */
    function boundedAncestor(el) {
      let node = el?.parentElement ?? null;
      const root = el?.ownerDocument?.documentElement ?? null;
      while (node && node !== root) {
        const cs = window.getComputedStyle(node);
        if (cs.overflowY !== 'visible' || /px$/.test(cs.height)) return node;
        node = node.parentElement;
      }
      return null;
    }

    /**
     * 让列表滚动区拿到一个**确定的、且不会溢出容器的**像素高度。
     *
     * 踩过的两个坑：
     *   1. `height:100%` + flex 依赖祖先链高度确定，桌面端布局里不成立；
     *   2. 只按视口算高度会**算大**——超出宿主容器的那部分被裁掉，
     *      表现就是"内容看不全，但也没有滚动条"（截图里的现象）。
     *
     * 现在的算法：
     *   可用 = min(视口高, 最近有界祖先的底边) − 面板顶部 − 面板底部内边距
     * 面板根节点拿这个高度，滚动区吃掉「扣掉固定区」后的剩余部分。
     * 测量结果由面板自己显示（桌面端没有控制台）。
     */
    function useScrollFit(rootRef, scrollRef, deps = []) {
      const [fit, setFit] = react.useState(null);

      react.useLayoutEffect(() => {
        const root = rootRef.current;
        const scroll = scrollRef.current;
        if (!root || !scroll) return undefined;

        const measure = () => {
          // 用内联 !important 锁死滚动语义：宿主可能用更具体的选择器把 overflow 压回 hidden，
          // 那样元素既不显示滚动条、scrollTop 也永远动不了（"滚不动(!)"就是这个原因）。
          scroll.style.setProperty('overflow-y', 'auto', 'important');
          scroll.style.setProperty('overflow-x', 'hidden', 'important');
          scroll.style.setProperty('scroll-behavior', 'auto', 'important');

          const viewport = window.innerHeight || document.documentElement.clientHeight || 0;
          const rootStyles = window.getComputedStyle(root);
          const padBottom = Number.parseFloat(rootStyles.paddingBottom) || 0;

          const rootRect = root.getBoundingClientRect();
          const parent = boundedAncestor(root);
          const parentBottom = parent ? parent.getBoundingClientRect().bottom : viewport;
          // 视口底与容器底取更近的那个，避免算大之后被裁
          const limit = Math.min(viewport, parentBottom);
          const rootHeight = Math.max(160, Math.floor(limit - rootRect.top - padBottom));

          // 固定区（pm-top + 提示条）之后剩下的都给滚动区
          let fixed = 0;
          const gap = Number.parseFloat(rootStyles.rowGap || rootStyles.gap) || 0;
          let count = 0;
          for (const child of Array.from(root.children)) {
            if (child === scroll) continue;
            if (window.getComputedStyle(child).display === 'none') continue;
            fixed += child.getBoundingClientRect().height;
            count += 1;
          }
          // 面板高度写进 CSS 变量：flex 链把剩余空间交给滚动区。
          // 关键教训：不要自己给滚动区写死高度——写大了会溢出到祖先之外被裁，于是"滚不动"。
          root.style.setProperty('--pm-fit', `${rootHeight}px`);
          // 滚动区的硬上限：面板高度减去固定区，保证它一定比内容矮、一定会产生溢出
          const scrollMax = Math.max(120, Math.floor(rootHeight - fixed - gap * count));
          root.style.setProperty('--pm-scroll-max', `${scrollMax}px`);
          scroll.style.removeProperty('height');
          const available = Math.max(120, Math.floor(rootHeight - fixed - gap * count));

          /*
           * 真实内容高度改用**几何位置**测量，不再信 scrollHeight。
           *
           * 原因是 scrollHeight 只反映「布局出的内容高」；当内容的溢出在祖先层被打断时，
           * 它会等于可视高度，于是一个明明被裁掉 5 条、溢出 250px 的列表，
           * 报告出来只有 10px 溢出（甚至为 0），滚动条也就不出现。
           * 这里直接量最后一项的底边相对滚动区顶边的位置，缺多少就补多少内边距，
           * 让可滚动高度真实等于内容高度。
           */
          /*
           * 内容真实高度 = 最后一个可见后代的底边 − 滚动区顶边。
           *
           * 为什么不信 scrollHeight：它只反映"布局出的内容高"，当溢出在祖先层被打断时
           * 会等于可视高度，于是被裁掉一大半的列表报告"只溢出 10px"，滚动条也就不出现。
           * 用几何位置量则不受影响——前提是真的量到了元素，所以下面把过程也暴露出来排查。
           */
          const scrollTopEdge = scroll.getBoundingClientRect().top + scroll.scrollTop;
          let contentHeight = 0;
          let seen = 0;
          let deepest = null;
          const walk = (el) => {
            for (const kid of Array.from(el.children)) {
              if (window.getComputedStyle(kid).display === 'none') continue;
              const r = kid.getBoundingClientRect();
              if (r.height <= 0) continue;
              seen += 1;
              if (r.bottom > scrollTopEdge) {
                const bottom = Math.round(r.bottom - scrollTopEdge);
                if (bottom > contentHeight) {
                  contentHeight = bottom;
                  deepest = kid.className || kid.tagName;
                }
              }
              walk(kid);
            }
          };
          walk(scroll);

          // 真滚动探测：内容超出时，程序化滚到底再读回 scrollTop。
          // 这一步能区分「只是数字上超出」和「真的能滚」——避免再被 scrollHeight 骗一次。
          let probe = null;
          const content = Math.max(contentHeight, scroll.scrollHeight);
          if (content > scroll.clientHeight + 1) {
            const saved = scroll.scrollTop;
            // 直接赋值（兼容性最好）；behavior:'auto' 由上面的内联 important 保证
            scroll.scrollTop = content;
            const reached = scroll.scrollTop;
            scroll.scrollTop = saved;
            const sh = scroll.scrollHeight;
            const ch = scroll.clientHeight;
            probe = reached > 1
              ? `可滚动(${Math.round(reached)}/${sh}-${ch}${saved > 0 ? `,当前位置${Math.round(saved)}` : ''})`
              : `滚不动(!) sh=${sh} ch=${ch}`;
            // 若被强制平滑滚动，同步读回会是旧值；下一帧再确认一次真实可滚性
            if (reached <= 1 && typeof requestAnimationFrame === 'function') {
              requestAnimationFrame(() => {
                scroll.scrollTop = content;
                const settled = scroll.scrollTop;
                scroll.scrollTop = saved;
                setFit((prev) => (prev ? { ...prev, probe: settled > 1 ? `可滚动(${Math.round(settled)}·延后确认)` : '滚不动(!)' } : prev));
              });
            }
          }

          const info = {
            rootHeight,
            available,
            viewport,
            top: Math.round(rootRect.top),
            parentBottom: Math.round(parentBottom),
            bounded: parent ? `${parent.tagName}.${String(parent.className || '').slice(0, 18)}` : null,
            content,
            client: scroll.clientHeight,
            overflow: content > available + 1,
            overflowY: window.getComputedStyle(scroll).overflowY,
            seen,
            deepest: typeof deepest === 'string' ? deepest.slice(0, 22) : null,
            probe,
          };
          setFit((prev) =>
            prev &&
            prev.available === info.available &&
            prev.content === info.content &&
            prev.rootHeight === info.rootHeight &&
            prev.probe === info.probe
              ? prev
              : info,
          );
        };

        // 兜底：宿主容器若拦截了滚轮（preventDefault/stopPropagation），列表就滚不动。
        // 直接在滚动区上接管滚轮并阻止继续冒泡，保证面板内部始终可滚。
        const onWheel = (event) => {
          if (scroll.scrollHeight <= scroll.clientHeight + 1) return;
          event.preventDefault();
          event.stopPropagation();
          scroll.scrollTo({ top: scroll.scrollTop + event.deltaY, behavior: 'auto' });
        };
        scroll.addEventListener('wheel', onWheel, { passive: false });

        // 键盘滚动：macOS 覆盖式滚动条默认隐藏，键盘是"确定能滚"的替代路径
        const onKeyDown = (event) => {
          const max = scroll.scrollHeight - scroll.clientHeight;
          if (max <= 1) return;
          const page = Math.max(40, scroll.clientHeight - 40);
          const step = { ArrowDown: 40, ArrowUp: -40, PageDown: page, PageUp: -page, Home: -Infinity, End: Infinity }[event.key];
          if (step === undefined) return;
          event.preventDefault();
          scroll.scrollTo({
            top: event.key === 'Home' ? 0 : event.key === 'End' ? max : scroll.scrollTop + step,
            behavior: 'auto',
          });
          measure();
        };
        scroll.addEventListener('keydown', onKeyDown);

        measure();
        const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(measure) : null;
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
        observer?.observe(root);
        // 同时观察承载面板的祖先与滚动内容：容器尺寸/内容高度变化都要重算
        const parent = boundedAncestor(root);
        if (parent) observer?.observe(parent);
        if (scroll.firstElementChild) observer?.observe(scroll.firstElementChild);
        window.addEventListener('resize', measure);
        return () => {
          scroll.removeEventListener('wheel', onWheel);
          scroll.removeEventListener('keydown', onKeyDown);
          if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
          observer?.disconnect();
          window.removeEventListener('resize', measure);
        };
      }, deps); // eslint-disable-line react-hooks/exhaustive-deps

      return fit;
    }

    function DashboardPanel() {
      useStyles();
      const rootRef = react.useRef(null);
      const scrollRef = react.useRef(null);
      const [data, setData] = react.useState(null);
      const [meta, setMeta] = react.useState({ enums: { categories: [], statuses: [], priorities: [] }, projects: [], owners: [] });
      const [filters, setFilters] = react.useState({ search: '', project: '', owner: '', status: 'active', level: '', sort: 'due' });
      const [editing, setEditing] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState(null);
      const [flash, setFlash] = react.useState(null);
      // 撤销记录：{ kind: 'delete' | 'patch', id, label, patch? }
      const [undo, setUndo] = react.useState(null);
      const [pendingDelete, setPendingDelete] = react.useState(null);
      // 分组折叠状态：默认只展开最需要关注的「已逾期」
      const [open, setOpen] = react.useState({ overdue: true });
      const toggle = (id) => setOpen((o) => ({ ...o, [id]: !o[id] }));

      const load = react.useCallback(async (nextFilters) => {
        const f = nextFilters ?? filters;
        try {
          const [view, m] = await Promise.all([
            request(`/view${buildQuery(f, { limit: 300 })}`),
            request('/meta'),
          ]);
          setData(view);
          setMeta(m);
          setError(null);
        } catch (err) {
          setError(err.message);
        }
      }, [filters]);

      react.useEffect(() => { load(); }, [filters]); // eslint-disable-line react-hooks/exhaustive-deps
      // 固定区高度会随"撤销提示/删除确认/迁移提示"出现而变化，因此跟随这些状态重算
      const fit = useScrollFit(rootRef, scrollRef, [data, undo, pendingDelete, flash, error, editing]);

      const withBusy = async (fn) => {
        setBusy(true);
        try {
          await fn();
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      };

      const create = (task) => withBusy(async () => {
        await request('/tasks', { method: 'POST', body: task });
        await load();
      });

      /** 撤销提示：8 秒后自行消失。 */
      const offerUndo = (record) => {
        setUndo(record);
        window.setTimeout(() => setUndo((u) => (u === record ? null : u)), 8000);
      };

      const patch = (ref, patchBody, expectedUpdatedAt) => withBusy(async () => {
        const before = data?.view?.items.find((t) => t.id === ref) ?? null;
        await request(`/tasks/${encodeURIComponent(ref)}`, {
          method: 'PATCH',
          body: { patch: patchBody, expectedUpdatedAt },
        });
        // 勾选完成/取消完成都给一次撤销机会——这一步最容易误点
        if (before && patchBody.status && (patchBody.status === '已完成' || before.status === '已完成')) {
          offerUndo({
            kind: 'patch',
            id: ref,
            label: patchBody.status === '已完成' ? `已完成 ${ref} ${before.name}` : `已重新打开 ${ref} ${before.name}`,
            patch: { status: patchBody.status === '已完成' ? '进行中' : '已完成' },
          });
        }
        await load();
      });

      const quickDate = (ref, plusDays) => withBusy(async () => {
        const task = data?.view?.items.find((t) => t.id === ref);
        const base = task?.due && /^\d{4}-\d{2}-\d{2}$/.test(task.due) ? task.due : null;
        const from = base ? new Date(`${base}T00:00:00Z`) : new Date();
        from.setUTCDate(from.getUTCDate() + plusDays);
        const due = from.toISOString().slice(0, 10);
        await request(`/tasks/${encodeURIComponent(ref)}`, { method: 'PATCH', body: { patch: { due } } });
        await load();
      });

      /** 删除需要确认（放在这里而不是直接删，避免误点）。 */
      const askDelete = (ref) => {
        const task = data?.view?.items.find((t) => t.id === ref) ?? null;
        setPendingDelete(task ? { id: ref, name: task.name } : { id: ref, name: '' });
      };

      const confirmDelete = () => withBusy(async () => {
        const target = pendingDelete;
        if (!target) return;
        await request(`/tasks/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
        setPendingDelete(null);
        setEditing(null);
        offerUndo({ kind: 'delete', id: target.id, label: `已删除 ${target.id} ${target.name}` });
        await load();
      });

      /** 撤销上一次动作：删除 → 恢复；状态变更 → 反向 PATCH。 */
      const undoLast = () => withBusy(async () => {
        const record = undo;
        if (!record) return;
        if (record.kind === 'delete') {
          await request('/tasks/restore', { method: 'POST', body: { refs: [record.id] } });
        } else {
          await request(`/tasks/${encodeURIComponent(record.id)}`, { method: 'PATCH', body: { patch: record.patch } });
        }
        setUndo(null);
        await load();
      });

      const copySummary = () => withBusy(async () => {
        const res = await request('/summary');
        await navigator.clipboard.writeText(res.summary ?? '');
        setFlash('摘要已复制');
        window.setTimeout(() => setFlash(null), 2500);
      });

      const exportExcel = () => withBusy(async () => {
        const res = await request('/export', { method: 'POST' });
        setFlash(`已导出 Excel（${res.written?.[0] ?? ''}）`);
        window.setTimeout(() => setFlash(null), 4000);
      });

      // 页面上跑的是旧 bundle、而宿主已经换了新代码时，明确提示（否则会被误当成"改动没生效"）
      const staleClient = Boolean(data?.build && meta.build && data.build !== meta.build);

      const metrics = data?.metrics;
      const view = data?.view;
      const current = editing ? view?.items.find((t) => t.id === editing) ?? null : null;

      const chips = metrics
        ? [
            ['overdue', '已逾期', metrics.overdue],
            ['red', '3 天内', metrics.red],
            ['orange', '4–7 天', view?.counts?.orange ?? 0],
            ['yellow', '8–30 天', view?.counts?.yellow ?? 0],
            ['green', '30 天以上', view?.counts?.green ?? 0],
            ['unscheduled', '未设截止', metrics.unscheduled],
            ['done', '已完成', metrics.done],
          ]
        : [];

      return jsxs('div', {
        className: 'pm-root',
        ref: rootRef,
        children: [
          // 固定区：标题、动作、录入、分级徽标、筛选、撤销提示
          jsxs('div', {
            className: 'pm-top',
            children: [
              jsxs('div', {
                className: 'pm-head',
            children: [
              jsxs('div', {
                children: [
                  jsxs('h2', {
                    className: 'pm-title',
                    children: [
                      '事项进展',
                      meta.build
                        ? jsx('span', {
                            className: 'pm-mono',
                            style: { marginLeft: 8, fontWeight: 400, opacity: 0.55 },
                            title: '客户端 bundle 指纹；与服务端 /meta 返回的 build 一致即为最新代码',
                            children: `build ${meta.build}`,
                          })
                        : null,
                    ],
                  }),
                  jsx('p', {
                    className: 'pm-sub',
                    children: metrics
                      ? `基准日期 ${data.today} · 共 ${metrics.total} 项 · 未完成 ${metrics.undone} 项`
                      : '正在读取事项数据…',
                  }),
                  data?.migration?.migrated
                    ? jsx('p', { className: 'pm-sub', children: `已从旧表格导入 ${data.migration.migrated} 条事项，此后由本插件管理` })
                    : null,
                  staleClient
                    ? jsx('p', {
                        className: 'pm-bad',
                        children: `页面上的插件代码是旧的（页面 ${meta.build} / 宿主 ${data.build}）——请硬刷新或重启桌面端后再看`,
                      })
                    : null,
                  flash ? jsx('p', { className: 'pm-ok', children: flash }) : null,
                  // 桌面端没有浏览器控制台，把布局实测值直接显示出来，便于排查"看不全/滚不动"
                  fit
                    ? jsx('p', {
                        className: 'pm-sub pm-mono',
                        title: '滚动区高 / 面板高 / 视口高 / 面板顶 / 容器底 / 内容高 / 容器',
                        children:
                          `布局 视口高${fit.client} 内容高${fit.content} 面板${fit.rootHeight} 顶${fit.top} 底${fit.parentBottom}` +
                          (fit.bounded ? ` 容器${fit.bounded}` : '') +
                          ` overflowY=${fit.overflowY} 元素${fit.seen}${fit.deepest ? ` 末${fit.deepest}` : ''}` +
                          (fit.probe ? ` · ${fit.probe}（滚轮/方向键）` : ' · 无需滚动'),
                      })
                    : null,
                ],
              }),
              jsxs('div', {
                className: 'pm-actions',
                children: [
                  jsx('button', { className: 'pm-btn', onClick: copySummary, disabled: busy, children: '复制摘要' }),
                  jsx('button', { className: 'pm-btn', onClick: exportExcel, disabled: busy, children: '导出 Excel' }),
                  jsx('button', { className: 'pm-btn', onClick: () => load(), disabled: busy, children: busy ? '…' : '刷新' }),
                ],
              }),
            ],
          }),

          error ? jsx('div', { className: 'pm-err', children: error }) : null,

          jsx(Composer, {
            enums: meta.enums,
            projects: meta.projects ?? [],
            owners: meta.owners ?? [],
            onCreate: create,
            onPaste: () => load(),
            onError: (e) => setError(e.message),
          }),

          jsxs('div', {
            className: 'pm-chips',
            children: chips.map(([id, label, count]) =>
              jsx('button', {
                key: id,
                className: 'pm-chip',
                'data-active': filters.level === id ? '1' : '0',
                style: LEVEL_BY_ID[id] && count ? { background: LEVEL_BY_ID[id].bg, color: LEVEL_BY_ID[id].fg } : undefined,
                onClick: () => setFilters((f) => (id === 'done'
                  ? { ...f, status: f.status === '已完成' ? 'active' : '已完成', level: '' }
                  : { ...f, level: f.level === id ? '' : id })),
                children: [label, jsx('b', { children: count }, 'n')],
              }),
            ),
          }),

          jsxs('div', {
            className: 'pm-filters',
            children: [
              jsx('input', {
                className: 'pm-input',
                placeholder: '搜索项目 / 事项 / 负责人 / 备注',
                value: filters.search,
                onChange: (e) => setFilters((f) => ({ ...f, search: e.target.value })),
              }),
              jsx('select', {
                className: 'pm-select',
                value: filters.project,
                onChange: (e) => setFilters((f) => ({ ...f, project: e.target.value })),
                children: [jsx('option', { value: '', children: '全部项目' }, 'all'), ...(meta.projects ?? []).map((p) => jsx('option', { key: p, value: p, children: p }))],
              }),
              jsx('select', {
                className: 'pm-select',
                value: filters.owner,
                onChange: (e) => setFilters((f) => ({ ...f, owner: e.target.value })),
                children: [jsx('option', { value: '', children: '全部负责人' }, 'all'), ...(meta.owners ?? []).map((o) => jsx('option', { key: o, value: o, children: o }))],
              }),
              jsx('select', {
                className: 'pm-select',
                value: filters.status,
                onChange: (e) => setFilters((f) => ({ ...f, status: e.target.value })),
                children: [
                  jsx('option', { value: 'active', children: '未完成' }, 'active'),
                  jsx('option', { value: '', children: '全部状态' }, 'all'),
                  ...(meta.enums?.statuses ?? []).map((s) => jsx('option', { key: s, value: s, children: s })),
                ],
              }),
              jsx('select', {
                className: 'pm-select',
                value: filters.sort,
                onChange: (e) => setFilters((f) => ({ ...f, sort: e.target.value })),
                children: [
                  ['due', '按截止日'], ['priority', '按优先级'], ['progress', '按进度'],
                  ['created', '按创建时间'], ['updated', '按更新时间'], ['name', '按名称'],
                ].map(([v, label]) => jsx('option', { key: v, value: v, children: label })),
              }),
              jsx('button', {
                className: 'pm-chip',
                'data-active': filters.status === '已完成' ? '1' : '0',
                onClick: () => setFilters((f) => ({ ...f, status: f.status === '已完成' ? 'active' : '已完成' })),
                children: filters.status === '已完成' ? '只看已完成' : '显示已完成',
              }),
            ],
          }),

          pendingDelete
            ? jsxs('div', {
                className: 'pm-undo',
                children: [
                  jsx('span', { children: `确定删除 ${pendingDelete.id} ${pendingDelete.name}？（可用「撤销」恢复）` }),
                  jsx('button', { className: 'pm-btn pm-primary', onClick: confirmDelete, disabled: busy, children: '删除' }),
                  jsx('button', { className: 'pm-btn', onClick: () => setPendingDelete(null), disabled: busy, children: '取消' }),
                ],
              })
            : undo
              ? jsxs('div', {
                  className: 'pm-undo',
                  children: [
                    jsx('span', { children: undo.label }),
                    jsx('button', { className: 'pm-btn pm-primary', onClick: undoLast, disabled: busy, children: '撤销' }),
                    jsx('button', { className: 'pm-btn', onClick: () => setUndo(null), disabled: busy, children: '知道了' }),
                  ],
                })
              : null,
            ],
          }),

          // 滚动区：内容多时用滚轮/滚动条上下移动
          jsxs('div', {
            className: 'pm-scroll',
            ref: scrollRef,
            tabIndex: 0,
            'aria-label': '事项列表（可用滚轮或方向键滚动）',
            children: [jsxs(Fragment, {
              children: [
              current
            ? jsx(Editor, {
                task: current,
                enums: meta.enums,
                onCancel: () => setEditing(null),
                onDelete: askDelete,
                onSave: async (ref, patchBody) => {
                  await patch(ref, patchBody);
                  setEditing(null);
                },
              })
            : null,

          !data && !error ? jsx('div', { className: 'pm-fade', children: '加载中…' }) : null,

          metrics && metrics.total === 0
            ? jsx('div', { className: 'pm-empty', children: '还没有任何事项——用上面的输入框加一条试试。' })
            : null,

          view && filters.status !== '已完成'
            ? LEVELS.map((lv) => {
                const group = view.groups.find((g) => g.id === lv.id);
                if (!group || !group.count) return null;
                const style = LEVEL_BY_ID[lv.id];
                return jsxs('div', {
                  key: lv.id,
                  className: 'pm-section',
                  children: [
                    jsxs('button', {
                      className: 'pm-sec-head',
                      style: { background: style.bg, color: style.fg, border: 0, width: '100%', cursor: 'pointer', textAlign: 'left' },
                      title: open[lv.id] ? '收起' : '展开',
                      onClick: () => toggle(lv.id),
                      children: [
                        jsxs('span', {
                          children: [
                            jsx('span', { style: { display: 'inline-block', width: 12, opacity: 0.75 }, children: open[lv.id] ? '▾' : '▸' }),
                            lv.label,
                          ],
                        }),
                        jsx('span', { children: open[lv.id] ? `${group.count} 项` : `${group.count} 项（点击展开）` }),
                      ],
                    }),
                    jsx('div', {
                      style: open[lv.id] ? undefined : { display: 'none' },
                      children: group.items.map((t) =>
                        jsx(TaskRow, {
                          key: t.id,
                          task: t,
                          onPatch: patch,
                          onEdit: setEditing,
                          onDelete: askDelete,
                          onQuickDate: quickDate,
                        }),
                      ),
                    }),
                  ],
                });
              })
            : null,

          view && filters.status === '已完成'
            ? (() => {
                const group = view.groups.find((g) => g.id === 'done');
                if (!group || !group.count) {
                  return jsx('div', { className: 'pm-empty', children: '还没有已完成的事项。' });
                }
                return jsxs('div', {
                  className: 'pm-section',
                  children: [
                    jsxs('button', {
                      className: 'pm-sec-head',
                      style: { background: 'var(--dsw-alias-fill-l2,rgba(0,0,0,.06))', border: 0, width: '100%', cursor: 'pointer', textAlign: 'left' },
                      title: open.done ? '收起' : '展开',
                      onClick: () => toggle('done'),
                      children: [
                        jsxs('span', { children: [jsx('span', { style: { display: 'inline-block', width: 12, opacity: 0.75 }, children: open.done ? '▾' : '▸' }), '已完成'] }),
                        jsx('span', { children: open.done ? `${group.count} 项` : `${group.count} 项（点击展开）` }),
                      ],
                    }),
                    jsx('div', {
                      style: open.done ? undefined : { display: 'none' },
                      children: group.items.map((t) =>
                        jsx(TaskRow, { key: t.id, task: t, onPatch: patch, onEdit: setEditing, onDelete: askDelete, onQuickDate: quickDate }),
                      ),
                    }),
                  ],
                });
              })()
            : null,

          view && filters.status !== '已完成' && view.groups.find((g) => g.id === 'done')?.count
            ? jsxs('div', {
                className: 'pm-empty',
                style: { display: 'flex', alignItems: 'center', gap: 8 },
                children: [
                  jsx('span', { children: `另有 ${view.groups.find((g) => g.id === 'done').count} 项已完成（勾选后不会消失，在这里查看）` }),
                  jsx('button', {
                    className: 'pm-btn',
                    onClick: () => setFilters((f) => ({ ...f, status: '已完成', level: '' })),
                    children: '查看已完成',
                  }),
                ],
              })
            : null,
              ],
            })]}),

            jsx('div', { className: 'pm-scroll-fade' }),
          ],
        });
    }

    /* -------------------------------------------------------- 插件体 */

    const zh = { panel: '事项进展' };
    const en = { panel: 'Project monitor' };

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'project-monitor: dictionaries');
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      }, DashboardPanel));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 30,
        locale: NS,
        label: () => '事项进展',
      }, PanelIcon));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = 'project-monitor-client';
    return module.exports;
  },
});
