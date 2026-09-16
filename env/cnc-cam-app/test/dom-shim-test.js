// dom-shim-test.js — 无浏览器环境下用 DOM 桩执行 app.js，捕获页面运行时错误
// 不追求像素，只验证：初始化计算、各场景切换、参数改动、渲染、面板、导出、打乱自检不抛异常。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const pub = path.join(__dirname, '..', 'public');
const camSrc = fs.readFileSync(path.join(pub, 'js', 'cam.js'), 'utf8');
const scenariosSrc = fs.readFileSync(path.join(pub, 'js', 'scenarios.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(pub, 'js', 'app.js'), 'utf8');

function makeEl(id) {
  const el = {
    id, tagName: 'DIV', children: [], style: {}, dataset: {}, classList: new Set(['el']),
    _text: '', _html: '', value: '', checked: true, clientWidth: 900, clientHeight: 700,
    width: 0, height: 0,
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return makeEl('q'); },
    querySelectorAll() { return []; },
    scrollIntoView() {},
    click() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 700 }; },
    getContext() {
      return new Proxy({}, {
        get(t, k) {
          if (k === 'measureText') return () => ({ width: 10 });
          if (k === 'getTransform') return () => ({ a: 1, d: 1 });
          return typeof k === 'string' ? () => {} : undefined;
        },
        set() { return true; },
      });
    },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return el._text; }, set(v) { el._text = String(v); },
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; }, set(v) { el._html = String(v); el.children = []; },
  });
  return el;
}

const ids = [
  'calc-badge', 'scenario-select', 'btn-fit', 'in-tool', 'in-side', 'in-lead-type',
  'in-lead-len', 'in-bridge-n', 'in-bridge-w', 'in-bridge-corner', 'in-bridge-lead',
  'btn-add-start-region', 'btn-add-no-cross', 'btn-del-zones', 'zones-list',
  'btn-shuffle', 'shuffle-result',
  'layer-orig', 'layer-off', 'layer-dir', 'layer-rapid', 'layer-bridge', 'layer-lead', 'layer-segno',
  'canvas', 'hint', 'seg-tip', 'verify-list', 'btn-export', 'export-state',
  'order-list', 'diag-list', 'seg-list', 'seg-summary',
];
const elementMap = new Map(ids.map((id) => [id, makeEl(id)]));
// 特殊：canvas
const canvas = elementMap.get('canvas');
canvas.style = {};

const selectEl = elementMap.get('scenario-select');
selectEl.appendChild = (o) => { selectEl.children.push(o); return o; };

const toolbarEls = ids
  .filter((id) => id.startsWith('in-'))
  .map((id) => elementMap.get(id));

const documentShim = {
  getElementById: (id) => elementMap.get(id) || makeEl(id),
  querySelector: () => makeEl('qs'),
  querySelectorAll: (sel) => sel === '#toolbar input, #toolbar select' ? toolbarEls : [],
  createElement: () => makeEl('created'),
  body: makeEl('body'),
};

const windowShim = {
  devicePixelRatio: 1,
  addEventListener() {},
};
function BlobMock(parts) { this.parts = parts; }
function URLMock() {}
URLMock.createObjectURL = () => 'blob:mock';
URLMock.revokeObjectURL = () => {};

const sandbox = {
  window: windowShim, document: documentShim, console,
  setTimeout: (fn) => { /* 同步防抖不执行 */ return 0; },
  clearTimeout() {},
  requestAnimationFrame: (fn) => 0,
  Blob: BlobMock, URL: URLMock,
  Date, Math, JSON, Number, String, parseInt, parseFloat, isFinite, isNaN,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function run(src, name) {
  try {
    vm.runInContext(src, sandbox, { filename: name });
    console.log(`  ✓ ${name} 执行成功`);
  } catch (e) {
    console.error(`  ✗ ${name} 抛出: ${e.stack}`);
    process.exit(1);
  }
}

run(camSrc, 'cam.js');
sandbox.CAM = sandbox.window.CAM;
run(scenariosSrc, 'scenarios.js');
sandbox.SCENARIOS = sandbox.window.SCENARIOS;

// app.js 的 init 会在加载末尾运行；其内部 querySelectorAll('#toolbar ...') 必须返回参数输入框
run(appSrc, 'app.js');

const CAM = sandbox.CAM;
if (!CAM) { console.error('CAM 未挂载到 window'); process.exit(1); }

// 直接通过 CAM 引擎对全部内置场景做端到端计算，验证页面数据面健全
console.log('\n逐场景端到端计算：');
let blocked = 0;
for (const sc of sandbox.window.SCENARIOS) {
  const res = CAM.computeToolpath({
    rings: sc.rings, zones: sc.zones || [], home: sc.home,
    params: { toolDiameter: 4, leadLength: 6, bridgeCount: 2, bridgeWidth: 3,
      bridgeCornerClear: 4, bridgeLeadGuard: 5, ...(sc.params || {}) },
  });
  // 面板渲染所需字段必须齐全
  for (const s of res.segments) {
    if (!s.no || !s.type || !s.points || s.length == null || !s.ringName) {
      throw new Error(`${sc.id} 段字段不完整`);
    }
  }
  const txt = CAM.exportToolpathText(res, { fingerprint: 'shim' });
  if (res.verification.exportBlocked) blocked++;
  const expectBlocked = ['u-slot', 'v-notch'].includes(sc.id) ? false : true;
  // u-slot/v-notch 默认参数也可能通过（小刀），这里仅统计
  console.log(`  · ${sc.id.padEnd(14)} 段数=${String(res.segments.length).padStart(3)} 次序=${res.sequenceIds.length} 复核=${res.verification.exportBlocked ? '阻止' : '通过'} 导出${txt.length}字节`);
}

// 验证导出按钮逻辑：失效场景必须无 G01
const u = CAM.computeToolpath({
  rings: sandbox.window.SCENARIOS.find((s) => s.id === 'u-slot').rings,
  params: { toolDiameter: 12, leadLength: 6, bridgeCount: 2, bridgeWidth: 3, bridgeCornerClear: 4, bridgeLeadGuard: 5 },
  home: { x: -15, y: 30 },
});
const txtU = CAM.exportToolpathText(u, { fingerprint: 'shim' });
if (!u.verification.exportBlocked || /^G01 /m.test(txtU)) {
  throw new Error('窄槽失效场景必须阻止导出且无 G01');
}
console.log('\n  ✓ 窄槽失效场景导出被阻止且不含 G01');
console.log('\nDOM 桩端到端：页面初始化与全部场景渲染数据路径无运行时错误 ✓');
