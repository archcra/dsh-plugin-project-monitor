/**
 * 浏览器半侧（client.js）的加载冒烟测试。
 *
 * 客户端 bundle 是懒加载 CJS 包装（`window.__ModuleLoader__.load({ id, factory })`），
 * 真实的 React 由宿主平台表提供。这里用**假的 require** 把它跑一遍，只验证三件事：
 *   1. 能被加载且 id 与包名一致（否则宿主匹配不到已注册的 bundle）；
 *   2. apply() 注册了 main 面板与侧栏入口；
 *   3. 渲染函数只被"构造"而不抛错（假 React 不真正渲染）。
 *
 * 说明：这不能替代浏览器里的真实验证，但能挡住"改完语法通过、一挂载就崩"这一类回归。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.dirname(HERE);
const CLIENT = path.join(PLUGIN, 'client.js');

/** 极简 React 替身：hooks 返回可用的占位值，createElement 只构造不渲染。 */
function fakeReact() {
  const node = (type, props) => ({ type, props });
  const react = {
    version: '18.2.0',
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (init) => ({ current: init }),
    useLayoutEffect: () => {},
    createElement: node,
    Fragment: Symbol('Fragment'),
  };
  const jsxRuntime = {
    jsx: (type, props, key) => node(type, key === undefined ? props : { ...props, key }),
    jsxs: (type, props, key) => node(type, key === undefined ? props : { ...props, key }),
    Fragment: react.Fragment,
  };
  return { react, jsxRuntime };
}

/** 用 vm 跑 bundle：捕获 load({ id, factory }) 并提供一个假的 require。 */
function loadClient() {
  const source = fs.readFileSync(CLIENT, 'utf8');
  const { react, jsxRuntime } = fakeReact();
  const requested = [];
  let loaded = null;

  const require = (spec) => {
    requested.push(spec);
    if (spec === 'react') return react;
    if (spec === 'react/jsx-runtime') return jsxRuntime;
    throw new Error(`未预期的外部依赖: ${spec}`);
  };

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(entry) {
          loaded = entry;
        },
      },
    },
    document: {
      getElementById: () => null,
      createElement: () => ({ set textContent(v) {}, id: '' }),
      head: { appendChild: () => {} },
    },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async () => ({ ok: true, status: 200, text: async () => '{}' }),
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });

  if (!loaded) throw new Error('bundle 没有调用 window.__ModuleLoader__.load');
  const exportsObj = loaded.factory(require);
  return { entry: loaded, exports: exportsObj, requested };
}

/** 假 cordis 上下文：只记录 slots / locale 的调用。 */
function makeCtx() {
  const slots = [];
  const dictionaries = [];
  const effects = [];
  // 注意：注册记录放在 ctx.registrations，ctx.slots 保持为服务对象（含 inject/register 方法）
  const ctx = {
    registrations: slots,
    dictionaries,
    effects,
    effect(fn, label) {
      effects.push(label);
      fn();
    },
    slots: {
      inject(name, fn) {
        slots.push({ phase: 'inject', name });
        fn();
      },
      register(decl, component) {
        // 注意：inject 与 register 同名，测试里必须按 phase 区分
        slots.push({ phase: 'register', name: decl.name, key: decl.key, id: decl.id, component });
        return () => {};
      },
    },
    locale: {
      register(ns, dicts) {
        dictionaries.push({ ns, dicts });
      },
    },
  };
  return ctx;
}

test('client.js 可加载，id 与包名一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'));
  const { entry, requested } = loadClient();
  assert.equal(entry.id, pkg.name, 'bundle id 必须等于 package.json 的 name，否则宿主匹配不到');
  assert.ok(typeof entry.factory === 'function');
  // 注意：vm 沙箱里的数组原型与宿主不同，deepStrictEqual 会误报，故用内容比较
  assert.equal([...new Set(requested)].sort().join(','), 'react,react/jsx-runtime');
});

test('client.js 只从平台表取 react，不引入其他外部依赖', () => {
  const { requested } = loadClient();
  for (const spec of requested) {
    assert.ok(spec === 'react' || spec === 'react/jsx-runtime', `不允许的外部依赖: ${spec}`);
  }
});

test('apply() 注册 main 面板与侧栏入口', () => {
  const { exports } = loadClient();
  assert.equal(typeof exports.apply, 'function');
  assert.equal(Array.from(exports.inject).join(','), 'slots,locale');

  const ctx = makeCtx();
  exports.apply(ctx);

  const main = ctx.registrations.find((r) => r.phase === 'register' && r.name === 'main');
  assert.ok(main, '未注册 main 面板');
  assert.equal(main.key, 'project-monitor');
  assert.equal(typeof main.component, 'function');

  const panel = ctx.registrations.find((r) => r.phase === 'register' && r.name === 'sidebar.panellist');
  assert.ok(panel, '未注册侧栏入口');
  assert.equal(panel.id, 'project-monitor');
  assert.equal(typeof panel.component, 'function');

  assert.equal(ctx.registrations.filter((r) => r.phase === 'register' && r.name === 'main').length, 1, 'main 只应注册一次');
  assert.equal(ctx.dictionaries.length, 1);
  assert.equal(ctx.dictionaries[0].ns, 'projectMonitor');
  assert.ok(ctx.dictionaries[0].dicts.zh.panel);
  assert.ok(ctx.effects.some((l) => String(l).includes('project-monitor')));
});

test('面板组件可被调用而不抛错（假 React，不真正渲染）', () => {
  const { exports } = loadClient();
  const ctx = makeCtx();
  exports.apply(ctx);
  const DashboardPanel = ctx.registrations.find((r) => r.phase === 'register' && r.name === 'main').component;

  // 假 React 的 useState 返回初始值：此时 data 为 null，走的是"加载中"分支
  const tree = DashboardPanel({});
  assert.ok(tree, '组件返回了空树');
  assert.equal(tree.type, 'div');
  assert.equal(tree.props.className, 'pm-root');

  const top = tree.props.children.find((c) => c && c.props && c.props.className === 'pm-top');
  const scroll = tree.props.children.find((c) => c && c.props && c.props.className === 'pm-scroll');
  assert.ok(top, '缺少固定区 pm-top（头部/录入/筛选应钉住不滚动）');
  assert.ok(scroll, '缺少滚动区 pm-scroll（列表必须能独立滚动）');
});

test('滚动区拥有确定高度且可滚动（防止退回依赖祖先链的写法）', () => {
  const source = fs.readFileSync(CLIENT, 'utf8');
  const css = source.slice(source.indexOf('const CSS = `'), source.indexOf('`;', source.indexOf('const CSS = `')));

  // 去掉注释后再检查声明，避免"注释里提到反模式"被误报
  const stripComments = (str) => str.replace(/\/\*[\s\S]*?\*\//g, '');
  const rootRule = stripComments(/\.pm-root\{[^}]*\}/.exec(css)[0]);
  assert.doesNotMatch(rootRule, /height:\s*100%/, '.pm-root 不应使用依赖祖先链的百分比高度');

  const scrollRule = stripComments(/\.pm-scroll\{[^}]*\}/.exec(css)[0]);
  assert.match(scrollRule, /overflow-y:\s*auto/, '.pm-scroll 必须可滚动');
  assert.match(scrollRule, /flex:\s*1 1 auto/, '.pm-scroll 应交回 flex 分配剩余空间');
  assert.match(scrollRule, /min-height:\s*0/, 'flex 子项必须能收缩');
  // 不要给滚动区写死 height（写大了会溢出到祖先之外被裁）；但必须有硬性 max-height 上限，
  // 否则 flex 若没把高度收住，滚动区会被内容撑高、永不产生溢出。
  assert.doesNotMatch(scrollRule, /[^-]height:\s*calc\(/, '.pm-scroll 不应写死 height');
  assert.match(scrollRule, /max-height:/, '.pm-scroll 必须有高度上限');

  const rootRuleFull = stripComments(/\.pm-root\{[^}]*\}/.exec(css)[0]);
  assert.match(rootRuleFull, /--pm-fit/, '.pm-root 高度应可由 --pm-fit 覆盖');

  // 关键回归：限高的纵向 flex 滚动区里，子项必须 flex-shrink:0。
  // 否则子项被压扁、由各自 overflow:hidden 裁行 —— 裁掉的部分不进入可滚动区域
  // （scrollHeight 不增长），表现为"看不全 + 滚不动"，且与宿主布局无关。
  assert.match(css, /\.pm-scroll>\*\{flex-shrink:0\}/, '滚动区子项必须禁止收缩');

  // 3) 源码里必须保留"受容器与视口双重约束"的实测逻辑
  assert.match(source, /boundedAncestor/, '必须能识别最近的有界祖先');
  // 面板高度由实测写进 CSS 变量；滚动区交回 flex 分配，因此不再自写高度
  assert.match(source, /root\.style\.setProperty\('--pm-fit'/, '面板高度必须由实测写入 --pm-fit');
  assert.match(source, /scroll\.style\.removeProperty\('height'\)/, '不应给滚动区写死高度');
  assert.match(source, /ResizeObserver/, '需要有尺寸变化重算');
});

test('分组可折叠：默认只展开「已逾期」', () => {
  const source = fs.readFileSync(CLIENT, 'utf8');
  assert.match(source, /useState\(\{ overdue: true \}\)/, '默认应只展开已逾期');
  assert.match(source, /onClick: \(\) => toggle\(/, '分组头应可点击折叠');
});

test('侧栏图标组件可被调用', () => {
  const { exports } = loadClient();
  const ctx = makeCtx();
  exports.apply(ctx);
  const Icon = ctx.registrations.find((r) => r.phase === 'register' && r.name === 'sidebar.panellist').component;
  const svg = Icon({ size: 16 });
  assert.equal(svg.type, 'svg');
  assert.equal(svg.props.width, 16);
});
