// app.js — UI 编排：画布渲染、依赖有向无环图（派生图形）、来源变换自动原子重算、
// 冻结/解冻、三种删除策略、依赖详情、重算日志、可检查历史与刷新一致性校验。

import pc from 'polygon-clipping';
import {
  translateGeom, geomBBox, geomCentroid, dist,
} from './geometry.js';
import { normalizeGeom, geomHash } from './model.js';
import { validateGeom, summarizeValidation, pointInGeom } from './validate.js';
import { OPS } from './ops.js';
import {
  createDocument, addRoot, getNode, directDependents, descendants,
  createDerived, setDerivedConfig, freezeNode, unfreezeNode, mutateGeometries,
  deletionReferences, deleteNode, isDerived, isFrozen, bumpIdCounter,
} from './graph.js';
import {
  createHistory, pushEntry, undo, redo, jumpTo, canUndo, canRedo,
  serializeHistory, deserializeHistory, snapshotFromDoc,
} from './history.js';

const STORAGE_KEY = 'polybool.graph.v2';
const PALETTE = ['#4f8ef7', '#f76f6f', '#3fbf7f', '#f7a83f', '#a06ef7', '#f75fb0', '#3fc4c4', '#b8b83f'];
const f2 = v => Math.round(v * 100) / 100;// ---------- 状态 ----------

const state = {
  doc: createDocument(),
  selected: [],          // 有序：先选为 A，后选为 B（稳定 id）
  mode: 'select',        // 'select' | 'draw' | 'verts'
  drawPts: [],
  editShapeId: null,
  eps: 0.5,
  view: { scale: 1, ox: 0, oy: 0 },
  history: createHistory(),
  inspectEntry: null,    // 历史面板中点击查看的条目
  rootSeq: 0,
  derivedSeq: 0,
  persistOk: true,
  reloadCheck: null,
  pendingDelete: null,   // 待确认删除的节点 id
};

// ---------- DOM ----------

const $ = id => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const els = {
  modeSelect: $('mode-select'), modeDraw: $('mode-draw'),
  opUnion: $('op-union'), opDiff: $('op-diff'), opInter: $('op-inter'),
  operands: $('operands'),
  undo: $('btn-undo'), redo: $('btn-redo'), fit: $('btn-fit'), reset: $('btn-reset'),
  freeze: $('btn-freeze'), unfreeze: $('btn-unfreeze'), del: $('btn-delete'),
  eps: $('eps-input'),
  badge: $('reload-badge'),
  toast: $('toast'),
  shapesList: $('shapes-list'), shapeDetail: $('shape-detail'),
  roundsList: $('rounds-list'),
  historyList: $('history-list'),
  hint: $('hint'),
  modal: $('modal-backdrop'), modalTitle: $('modal-title'), modalBody: $('modal-body'),
  modalCancel: $('modal-cancel-delete'), modalFreeze: $('modal-freeze-direct'), modalCascade: $('modal-cascade'),
};

// ---------- 视图变换 ----------

const toScreen = p => [p[0] * state.view.scale + state.view.ox, p[1] * state.view.scale + state.view.oy];
const toWorld = p => [(p[0] - state.view.ox) / state.view.scale, (p[1] - state.view.oy) / state.view.scale];

function fitView() {
  const bb = geomBBox(state.doc.nodes.flatMap(s => s.geom));
  if (!bb) { state.view = { scale: 1, ox: 40, oy: 40 }; return; }
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const pad = 60;
  const sx = (w - pad * 2) / Math.max(1e-6, bb.maxX - bb.minX);
  const sy = (h - pad * 2) / Math.max(1e-6, bb.maxY - bb.minY);
  state.view.scale = Math.max(0.05, Math.min(sx, sy, 4));
  state.view.ox = pad - bb.minX * state.view.scale + ((w - pad * 2) - (bb.maxX - bb.minX) * state.view.scale) / 2;
  state.view.oy = pad - bb.minY * state.view.scale + ((h - pad * 2) - (bb.maxY - bb.minY) * state.view.scale) / 2;
}

// ---------- 渲染 ----------

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}

function geomPath(geom) {
  const path = new Path2D();
  for (const poly of geom) {
    for (const ring of poly) {
      ring.forEach((p, i) => {
        const [sx, sy] = toScreen(p);
        i === 0 ? path.moveTo(sx, sy) : path.lineTo(sx, sy);
      });
      path.closePath();
    }
  }
  return path;
}

function render() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  drawGrid(w, h);
  drawDependencyEdges();

  for (const node of state.doc.nodes) {
    const path = geomPath(node.geom);
    const selIdx = state.selected.indexOf(node.id);
    ctx.fillStyle = node.color + (selIdx >= 0 ? '55' : '26');
    ctx.fill(path, 'evenodd');
    ctx.lineWidth = selIdx >= 0 ? 2.5 : 1.5;
    ctx.strokeStyle = selIdx >= 0 ? '#ffd166' : node.color;
    ctx.setLineDash(isDerived(node) ? [6, 4] : []);
    ctx.stroke(path);
    ctx.setLineDash([]);
    // 名称 / 状态
    const bb = geomBBox(node.geom);
    if (bb) {
      const [tx, ty] = toScreen([bb.minX, bb.minY]);
      ctx.fillStyle = isFrozen(node) ? '#9fd7ff' : '#8b93a7';
      ctx.font = '11px system-ui';
      const prefix = isFrozen(node) ? '❄ ' : isDerived(node) ? 'ƒ ' : '';
      ctx.fillText(prefix + node.name, tx, ty - 6);
      if (selIdx >= 0) {
        const c = toScreen(geomCentroid(node.geom));
        ctx.fillStyle = '#ffd166';
        ctx.font = 'bold 13px system-ui';
        ctx.fillText(selIdx === 0 ? 'A' : 'B', c[0] - 4, c[1] + 4);
      }
    }
  }

  if (state.mode === 'select' && state.selected.length === 1) drawHandles();
  if (state.mode === 'draw') drawDraft();
  if (state.mode === 'verts') drawVertices();
}

function drawDependencyEdges() {
  // 选中节点：直接来源（蓝）与全部后代（橙）的质心连线
  if (state.selected.length !== 1) return;
  const id = state.selected[0];
  const n = getNode(state.doc, id);
  if (!n) return;
  const centroidOf = x => { const c = geomCentroid(x.geom); return toScreen(c); };
  const line = (a, b, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    ctx.setLineDash([]);
  };
  if (isDerived(n)) {
    for (const sid of n.sources) {
      const s = getNode(state.doc, sid);
      if (s) line(centroidOf(n), centroidOf(s), 'rgba(79,142,247,.8)');
    }
  }
  for (const d of descendants(state.doc, id)) line(centroidOf(n), centroidOf(d), 'rgba(247,168,63,.7)');
}

function drawGrid(w, h) {
  const step = 50 * state.view.scale;
  if (step < 12) return;
  ctx.strokeStyle = '#232838';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = state.view.ox % step; x < w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  for (let y = state.view.oy % step; y < h; y += step) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();
}

function selectedNode() {
  return state.selected.length === 1 ? getNode(state.doc, state.selected[0]) : null;
}

function handleLayout() {
  const node = selectedNode();
  if (!node) return null;
  const bb = geomBBox(node.geom);
  if (!bb) return null;
  const [x1, y1] = toScreen([bb.minX, bb.minY]);
  const [x2, y2] = toScreen([bb.maxX, bb.maxY]);
  return { corners: [[x1, y1], [x2, y1], [x2, y2], [x1, y2]], box: { x1, y1, x2, y2 } };
}

function drawHandles() {
  if (isDerived(selectedNode())) return; // 派生图形不可直接变换
  const L = handleLayout();
  if (!L) return;
  ctx.strokeStyle = '#ffd166';
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(L.box.x1, L.box.y1, L.box.x2 - L.box.x1, L.box.y2 - L.box.y1);
  ctx.setLineDash([]);
  ctx.fillStyle = '#ffd166';
  for (const [x, y] of L.corners) { ctx.beginPath(); ctx.rect(x - 5, y - 5, 10, 10); ctx.fill(); }
}

function drawDraft() {
  const pts = state.drawPts;
  if (!pts.length) return;
  ctx.strokeStyle = '#4f8ef7';
  ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const [x, y] = toScreen(p);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  if (hover.world && pts.length >= 2) {
    const [x, y] = toScreen(hover.world);
    ctx.lineTo(x, y);
  }
  ctx.stroke();
  pts.forEach((p, i) => {
    const [x, y] = toScreen(p);
    ctx.fillStyle = i === 0 ? '#ffd166' : '#4f8ef7';
    ctx.beginPath(); ctx.arc(x, y, i === 0 ? 6 : 4, 0, Math.PI * 2); ctx.fill();
  });
}

function drawVertices() {
  const node = getNode(state.doc, state.editShapeId);
  if (!node || isDerived(node)) return;
  for (const poly of node.geom) {
    for (const ring of poly) {
      for (const p of ring) {
        const [x, y] = toScreen(p);
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#4f8ef7'; ctx.lineWidth = 1.5; ctx.stroke();
      }
    }
  }
}

// ---------- 命中检测 ----------

function nodeAt(worldP) {
  for (let i = state.doc.nodes.length - 1; i >= 0; i--) {
    const n = state.doc.nodes[i];
    if (pointInGeom(n.geom, worldP, state.eps / state.view.scale) === 'in') return n;
  }
  return null;
}

function hitHandle(sp) {
  const L = handleLayout();
  if (!L) return null;
  for (let i = 0; i < 4; i++) {
    if (Math.abs(sp[0] - L.corners[i][0]) <= 7 && Math.abs(sp[1] - L.corners[i][1]) <= 7) return { corner: i };
  }
  return null;
}

function vertexAt(sp) {
  const node = getNode(state.doc, state.editShapeId);
  if (!node) return null;
  const r = 7 / state.view.scale;
  const wp = toWorld(sp);
  for (let pi = 0; pi < node.geom.length; pi++) {
    for (let ri = 0; ri < node.geom[pi].length; ri++) {
      const ring = node.geom[pi][ri];
      for (let vi = 0; vi < ring.length; vi++) {
        if (dist(ring[vi], wp) <= r) return { pi, ri, vi };
      }
    }
  }
  return null;
}

// ---------- 交互 ----------

const hover = { world: null };
let drag = null;

function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

canvas.addEventListener('mousedown', e => {
  if (e.button === 2) return;
  const sp = canvasPos(e);
  const wp = toWorld(sp);

  if (state.mode === 'draw') { addDrawPoint(wp); return; }
  if (state.mode === 'verts') {
    const hit = vertexAt(sp);
    if (hit) drag = { type: 'vertex', hit, base: JSON.stringify(getNode(state.doc, state.editShapeId).geom) };
    else drag = { type: 'pan', start: sp, view0: { ...state.view } };
    return;
  }
  const single = state.selected.length === 1 ? getNode(state.doc, state.selected[0]) : null;
  const hh = single && !isDerived(single) ? hitHandle(sp) : null;
  if (hh) {
    drag = { type: 'scale', node: single, base: JSON.stringify(single.geom) };
    return;
  }
  const node = nodeAt(wp);
  if (node) {
    if (!state.selected.includes(node.id)) selectNode(node.id);
    if (isDerived(node)) {
      drag = { type: 'pan', start: sp, view0: { ...state.view } };
      showToast('派生图形不能直接变换：请编辑它的来源图形（或先冻结）', 'info');
      return;
    }
    // 记录来源几何，mouseup 时走原子重算
    drag = {
      type: 'move', start: wp,
      bases: state.selected
        .map(id => getNode(state.doc, id))
        .filter(Boolean)
        .map(n => ({ id: n.id, geom: JSON.stringify(n.geom), movable: !isDerived(n) })),
    };
  } else {
    drag = { type: 'pan', start: sp, view0: { ...state.view } };
    if (!e.shiftKey) { state.selected = []; syncOperandUI(); renderPanels(); render(); }
  }
});

canvas.addEventListener('mousemove', e => {
  const sp = canvasPos(e);
  const wp = toWorld(sp);
  hover.world = wp;
  if (!drag) { render(); return; }
  if (drag.type === 'pan') {
    state.view.ox = drag.view0.ox + (sp[0] - drag.start[0]);
    state.view.oy = drag.view0.oy + (sp[1] - drag.start[1]);
  } else if (drag.type === 'move') {
    const dx = wp[0] - drag.start[0], dy = wp[1] - drag.start[1];
    for (const b of drag.bases) {
      if (!b.movable) continue;
      const baseGeom = JSON.parse(b.geom);
      getNode(state.doc, b.id).geom = translateGeom(baseGeom, dx, dy);
    }
  } else if (drag.type === 'scale') {
    const n = drag.node;
    const baseGeom = JSON.parse(drag.base);
    const c = geomCentroid(baseGeom);
    const k = Math.max(0.05, dist(wp, c) / Math.max(1e-6, dist(drag.start, c)));
    const [px, py] = c;
    n.geom = baseGeom.map(poly => poly.map(ring => ring.map(([x, y]) => [px + (x - px) * k, py + (y - py) * k])));
    drag.k = k;
  } else if (drag.type === 'vertex') {
    const node = getNode(state.doc, state.editShapeId);
    node.geom[drag.hit.pi][drag.hit.ri][drag.hit.vi] = wp;
  }
  render();
});

canvas.addEventListener('mouseup', () => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.type === 'move') {
    const moved = d.bases.filter(b => b.movable);
    if (!moved.length) { render(); return; }
    // 计算位移（以第一个可动节点的首顶点）
    const first = moved[0];
    const baseGeom = JSON.parse(first.geom);
    const nowGeom = getNode(state.doc, first.id).geom;
    const dx = f2(nowGeom[0][0][0][0] - baseGeom[0][0][0][0]);
    const dy = f2(nowGeom[0][0][0][1] - baseGeom[0][0][0][1]);
    if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) {
      const changes = moved.map(b => ({ id: b.id, geom: getNode(state.doc, b.id).geom }));
      // 先还原，再让引擎原子地应用 + 重算（失败回滚）
      for (const b of moved) getNode(state.doc, b.id).geom = JSON.parse(b.geom);
      const names = moved.map(b => getNode(state.doc, b.id)?.name).filter(Boolean).join('、');
      applyMutation(changes, `移动 ${names} Δ(${dx}, ${dy})`);
    }
  } else if (d.type === 'scale') {
    if (d.k && Math.abs(d.k - 1) > 1e-9) {
      const n = d.node;
      const nextGeom = JSON.parse(JSON.stringify(n.geom));
      n.geom = JSON.parse(d.base); // 还原后由引擎应用
      applyMutation([{ id: n.id, geom: nextGeom }], `缩放 ${n.name} ×${f2(d.k)}（绕质心）`);
    } else {
      d.node.geom = JSON.parse(d.base);
    }
  } else if (d.type === 'vertex') {
    commitVertexEdit(d.base);
  }
  render();
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const sp = canvasPos(e);
  const wp = toWorld(sp);
  state.view.scale *= e.deltaY < 0 ? 1.12 : 1 / 1.12;
  state.view.scale = Math.max(0.05, Math.min(20, state.view.scale));
  const sp2 = toScreen(wp);
  state.view.ox += sp[0] - sp2[0];
  state.view.oy += sp[1] - sp2[1];
  render();
}, { passive: false });

canvas.addEventListener('dblclick', e => {
  const wp = toWorld(canvasPos(e));
  if (state.mode === 'verts') { exitVertMode(); return; }
  const node = nodeAt(wp);
  if (node && !isDerived(node)) enterVertMode(node.id);
  else if (isDerived(node)) showToast('派生图形的顶点由来源决定，不能直接编辑（可先冻结）', 'info');
});

// ---------- 原子变更入口（编辑/变换来源 + 自动重算） ----------

function applyMutation(changes, label) {
  const result = mutateGeometries(pc, state.doc, changes, label);
  if (!result.ok) {
    // 引擎已把整张图与几何恢复到变更前；给出失败节点与原因
    const f = result.failed;
    showToast(`重算失败已整轮回滚：节点「${f.node.name}」— ${result.reason}`, 'error');
    // 失败本身也是一次可检查、可撤销的历史状态（图与几何保持变更前）
    commitHistory(label, `✗ 重算失败已回滚：${f.node.name}（${failureLabel(f.code)}）`);
  } else {
    const names = result.round.entries.map(e => e.name).join(' → ');
    commitHistory(label, `自动重算 ${result.round.entries.length} 个节点：${names}`);
    showToast(`已按依赖顺序重算 ${result.round.entries.length} 个节点`, 'ok');
  }
  renderPanels();
}

function failureLabel(code) {
  return {
    'empty-result': '结果为空',
    'invalid-result': '结果拓扑无效',
    'invalid-source': '来源拓扑无效',
    'missing-source': '来源缺失',
    engine: '引擎错误',
  }[code] || code;
}

function commitVertexEdit(baseGeomJson) {
  const node = getNode(state.doc, state.editShapeId);
  const v = validateGeom(node.geom, state.eps);
  if (!v.ok) {
    node.geom = JSON.parse(baseGeomJson);
    showToast(`顶点编辑产生无效拓扑（${v.errors[0]}），已回滚`, 'error');
    render();
    return;
  }
  const nextGeom = JSON.parse(JSON.stringify(node.geom));
  node.geom = JSON.parse(baseGeomJson);
  applyMutation([{ id: node.id, geom: nextGeom }], `编辑顶点：${node.name}`);
}

// ---------- 绘制 ----------

function addDrawPoint(wp) {
  const pts = state.drawPts;
  if (pts.length >= 3) {
    const first = toScreen(pts[0]);
    const cur = toScreen(wp);
    if (Math.hypot(first[0] - cur[0], first[1] - cur[1]) <= 10) { closeDraw(); return; }
  }
  pts.push(wp);
  render();
}

function closeDraw() {
  const pts = state.drawPts;
  if (pts.length < 3) { showToast('至少需要 3 个顶点', 'error'); return; }
  const decisions = [];
  const geom = normalizeGeom([pts], state.eps, decisions);
  if (!geom.length) { showToast('绘制失败：多边形退化，未创建', 'error'); cancelDraw(); return; }
  const v = validateGeom(geom, state.eps);
  if (!v.ok) { showToast(`绘制失败：${v.errors[0]}`, 'error'); cancelDraw(); return; }
  const node = addRoot(state.doc, `形状${++state.rootSeq}`, geom, PALETTE[state.doc.nodes.length % PALETTE.length]);
  state.selected = [node.id];
  commitHistory(`绘制 ${node.name}`, summarizeValidation(v));
  cancelDraw();
  setMode('select');
  syncOperandUI();
}

function cancelDraw() { state.drawPts = []; render(); }

// ---------- 顶点编辑模式 ----------

function enterVertMode(id) {
  state.mode = 'verts';
  state.editShapeId = id;
  state.selected = [id];
  els.hint.textContent = '顶点编辑：拖动顶点；双击空白或 Esc 退出（派生图形需先冻结）';
  syncModeUI(); syncOperandUI(); render();
}
function exitVertMode() {
  state.mode = 'select';
  state.editShapeId = null;
  els.hint.textContent = '';
  syncModeUI(); render();
}

// ---------- 布尔运算 → 创建派生图形 ----------

function doBoolean(op) {
  if (state.selected.length !== 2) return;
  const A = getNode(state.doc, state.selected[0]);
  const B = getNode(state.doc, state.selected[1]);
  const name = `D${++state.derivedSeq}`;
  const res = createDerived(pc, state.doc, {
    name, op, sourceIds: [A.id, B.id], eps: state.eps,
    color: PALETTE[(state.doc.nodes.length + 2) % PALETTE.length],
  });
  if (!res.ok) {
    showToast(`无法创建派生图形：${res.reason}`, 'error');
    return;
  }
  state.selected = [res.node.id];
  commitHistory(
    `派生 ${name} = ${A.name} ${OPS[op].symbol.replace('A', '').replace('B', '').trim()} ${B.name}（ε=${state.eps}）`,
    `依赖：${A.name}、${B.name}（稳定 id）；几何 ${geomHash(res.node.geom).slice(0, 8)}`,
  );
  showToast(`已创建派生图形 ${name}，来源变化时将自动重算`, 'ok');
  syncOperandUI();
}

// ---------- 冻结 / 解冻 ----------

function doFreeze() {
  const n = selectedNode();
  if (!n) return;
  const res = freezeNode(state.doc, n.id);
  if (!res.ok) { showToast(res.reason, 'error'); return; }
  commitHistory(`冻结 ${n.name}`, '几何固定为当前值；成为新的依赖边界，上游变化不再传入');
  showToast(`已冻结 ${n.name}：不再跟随来源变化`, 'ok');
  renderPanels(); render();
}

function doUnfreeze() {
  const n = selectedNode();
  if (!n) return;
  const res = unfreezeNode(pc, state.doc, n.id);
  if (!res.ok) { showToast(`解冻失败：${res.reason}`, 'error'); renderPanels(); return; }
  commitHistory(`解冻 ${n.name}`, '恢复派生身份，按当前来源重算下游');
  showToast(`已解冻 ${n.name} 并重新跟随来源`, 'ok');
  renderPanels(); render();
}

// ---------- 删除（三种策略） ----------

function requestDelete() {
  if (!state.selected.length) return;
  if (state.selected.length > 1) { showToast('请先只选择一个图形再删除', 'info'); return; }
  const id = state.selected[0];
  const n = getNode(state.doc, id);
  if (!n) return;
  const refs = deletionReferences(state.doc, id);
  if (!refs.length) {
    performDelete(null); // 无引用直接删除
    return;
  }
  // 被引用 → 让用户选择取消 / 级联 / 冻结直连
  state.pendingDelete = id;
  const allDesc = descendants(state.doc, id);
  els.modalTitle.textContent = `「${n.name}」仍被 ${refs.length} 个直接派生结果引用`;
  els.modalBody.innerHTML = `
    <div>直接引用它的结果：${refs.map(r => `<b>${esc(r.name)}</b>`).join('、')}</div>
    <div>级联将一并删除 <b>${allDesc.length}</b> 个后代：${allDesc.slice(0, 8).map(d => esc(d.name)).join('、')}${allDesc.length > 8 ? ' …' : ''}</div>
    <div class="policy">· <b>取消</b>：保留图形与全部依赖（本次决定也记入历史，可撤销）。</div>
    <div class="policy">· <b>级联删除</b>：删除它及全部受影响后代；冻结节点截断级联。</div>
    <div class="policy">· <b>冻结直接结果后删除</b>：先把直接派生结果冻结为普通图形，再删除它。</div>`;
  els.modal.classList.remove('hidden');
}

function closeModal() { state.pendingDelete = null; els.modal.classList.add('hidden'); }

function performDelete(policy) {
  const id = state.pendingDelete || state.selected[0];
  state.pendingDelete = null;
  els.modal.classList.add('hidden');
  const n = getNode(state.doc, id);
  if (!n) return;
  const res = deleteNode(state.doc, id, policy);
  if (!res.ok) { showToast(res.reason, 'error'); return; }
  state.selected = state.selected.filter(x => x !== id && getNode(state.doc, x));
  if (state.mode === 'verts' && state.editShapeId === id) exitVertMode();
  const detail = res.cancelled ? '图形与依赖图保持不变'
    : policy === 'cascade' ? `删除 ${res.removed.length} 个节点：${res.removed.length}`
    : policy === 'freeze-direct' ? `冻结 ${res.frozenNow.length} 个直接结果，删除 1 个来源`
    : '图形已删除';
  commitHistory(res.round.label, detail);
  showToast(res.cancelled ? '已取消删除' : '删除完成（可撤销）', res.cancelled ? 'info' : 'ok');
  syncOperandUI();
}

els.modalCancel.addEventListener('click', () => performDelete('cancel'));
els.modalFreeze.addEventListener('click', () => performDelete('freeze-direct'));
els.modalCascade.addEventListener('click', () => performDelete('cascade'));
els.modal.addEventListener('click', e => { if (e.target === els.modal) closeModal(); });

// ---------- 派生配置（详情面板中改来源/运算/容差；环检查） ----------

function editDerivedSources(nodeId, aId, bId, op, eps) {
  const n = getNode(state.doc, nodeId);
  if (!n) return;
  const res = setDerivedConfig(pc, state.doc, nodeId, { op, sourceIds: [aId, bId], eps });
  if (!res.ok) {
    showToast(`被拒绝，状态不变：${res.reason}`, 'error');
    renderPanels();
    return;
  }
  commitHistory(`改写 ${n.name} 的依赖`, `新来源/运算已生效并原子重算下游`);
  showToast('依赖已更新，下游已重算', 'ok');
  renderPanels(); render();
}

// ---------- 历史 ----------

function snapshotScene() {
  return snapshotFromDoc(state.doc, state.selected);
}

function commitHistory(label, detail, report) {
  const validation = summarizeSceneValidation();
  pushEntry(state.history, snapshotScene(), { label, detail: detail || validation, validation, report: report || null });
  state.inspectEntry = null;
  persist();
  syncOperandUI();
  renderPanels();
  render();
}

function restoreSnapshot(snap) {
  const doc = JSON.parse(JSON.stringify(snap.doc));
  state.doc = doc;
  bumpIdCounter(state.doc);
  state.selected = (snap.selected || []).filter(id => getNode(state.doc, id));
  state.rootSeq = state.doc.nodes
    .filter(n => n.kind === 'root').reduce((m, n) => { const mm = /^形状(\d+)$/.exec(n.name); return mm ? Math.max(m, Number(mm[1])) : m; }, 0);
  state.derivedSeq = state.doc.nodes
    .reduce((m, n) => { const mm = /^D(\d+)$/.exec(n.name); return mm ? Math.max(m, Number(mm[1])) : m; }, 0);
  if (state.mode === 'verts' && !getNode(state.doc, state.editShapeId)) exitVertMode();
  syncOperandUI();
  renderPanels();
  render();
}

function doUndo() {
  const snap = undo(state.history);
  if (snap) { state.inspectEntry = null; restoreSnapshot(snap); persist(); }
}
function doRedo() {
  const snap = redo(state.history);
  if (snap) { state.inspectEntry = null; restoreSnapshot(snap); persist(); }
}
function doJump(i) {
  const snap = jumpTo(state.history, i);
  if (snap) { state.inspectEntry = state.history.entries[i]; restoreSnapshot(snap); persist(); }
}

// ---------- 持久化 ----------

function persist() {
  if (!state.persistOk) return;
  try {
    localStorage.setItem(STORAGE_KEY, serializeHistory(state.history, state.eps));
  } catch {
    state.persistOk = false;
    showToast('localStorage 不可用，历史将无法跨刷新保留', 'error');
  }
}

function loadPersisted() {
  let raw = null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { /* ignore */ }
  if (!raw) return false;
  try {
    const { history, eps, mismatches } = deserializeHistory(raw);
    state.history = history;
    if (typeof eps === 'number') { state.eps = eps; els.eps.value = String(eps); }
    state.reloadCheck = mismatches.length === 0
      ? { ok: true, text: `重载校验：一致 ✓（${history.entries.length} 条历史，依赖边/冻结/几何/重算日志哈希全部匹配）` }
      : { ok: false, text: `重载校验：${mismatches.length} 条历史哈希不一致 ✗` };
    const snap = history.entries[history.index]?.snapshot;
    if (snap) restoreSnapshot(snap);
    return true;
  } catch (err) {
    state.reloadCheck = { ok: false, text: `重载校验：历史数据损坏（${err.message}），已新建场景` };
    return false;
  }
}

// ---------- 面板 ----------

function summarizeSceneValidation() {
  let bad = 0;
  for (const n of state.doc.nodes) if (!validateGeom(n.geom, state.eps).ok) bad++;
  const derived = state.doc.nodes.filter(n => n.kind === 'derived').length;
  const frozen = state.doc.nodes.filter(n => n.frozen).length;
  const edges = state.doc.nodes.reduce((a, n) => a + (isDerived(n) ? n.sources.length : 0), 0);
  return `${bad ? `✗ ${bad} 个无效` : '✓ 几何全部有效'}｜${state.doc.nodes.length} 图形 · ${derived} 派生 · ${frozen} 冻结 · ${edges} 条活动依赖边`;
}

function renderPanels() {
  // 图形列表
  els.shapesList.innerHTML = state.doc.nodes.map(n => {
    const sel = state.selected.includes(n.id) ? 'sel' : '';
    const tags = [];
    if (isDerived(n)) tags.push('<span class="tag derived">派生</span>');
    if (isFrozen(n)) tags.push('<span class="tag frozen">❄ 冻结</span>');
    return `<div class="shape-row ${sel}" data-id="${n.id}">
      <span class="swatch" style="background:${n.color}"></span>
      <span class="nm">${esc(n.name)} <span class="hash">#${geomHash(n.geom).slice(0, 8)}</span></span>
      ${tags.join('')}
    </div>`;
  }).join('') || '<div class="muted">场景为空</div>';
  els.shapesList.querySelectorAll('.shape-row').forEach(el => {
    el.addEventListener('click', () => selectNode(el.dataset.id));
  });

  renderShapeDetail();
  renderRounds();

  // 历史
  const h = state.history;
  els.historyList.innerHTML = h.entries.map((e, i) => `
    <div class="hist-item ${i === h.index ? 'current' : ''} ${i > h.index ? 'undone' : ''}" data-i="${i}">
      <span class="seq">#${e.seq}</span> ${esc(e.label)}
      <span class="hash">#${e.hash.slice(0, 8)}</span><br>
      <small>${esc(e.validation || e.detail || '')}</small>
    </div>`).reverse().join('') || '<div class="muted">无历史</div>';
  els.historyList.querySelectorAll('.hist-item').forEach(el => {
    el.addEventListener('click', () => doJump(Number(el.dataset.i)));
  });
  els.undo.disabled = !canUndo(h);
  els.redo.disabled = !canRedo(h);

  if (state.reloadCheck) {
    els.badge.textContent = state.reloadCheck.text;
    els.badge.className = state.reloadCheck.ok ? 'badge ok' : 'badge bad';
  }
}

function renderShapeDetail() {
  const n = selectedNode();
  if (!n) { els.shapeDetail.innerHTML = '<div class="muted">未选中图形</div>'; syncFreezeButtons(null); return; }
  let html = `<div class="detail-block"><b>${esc(n.name)}</b> ${isFrozen(n) ? '❄ 已冻结（普通图形）' : n.kind === 'derived' ? 'ƒ 派生图形' : '普通图形'}</div>`;

  if (isDerived(n)) {
    const [aId, bId] = n.sources;
    const a = getNode(state.doc, aId); const b = getNode(state.doc, bId);
    html += `<div class="detail-block"><span class="k">直接来源（稳定 id）：</span>
      <span class="dep-link" data-goto="${aId}">${a ? esc(a.name) : '缺失: ' + aId}</span>
      ${esc(OPS[n.op].symbol)}
      <span class="dep-link" data-goto="${bId}">${b ? esc(b.name) : '缺失: ' + bId}</span>
      ｜容差 ε=${n.eps}</div>`;
  } else {
    html += `<div class="detail-block"><span class="k">直接来源：</span>无（${isFrozen(n) ? '冻结后成为依赖边界' : '根图形'}）</div>`;
  }
  const refs = directDependents(state.doc, n.id);
  html += `<div class="detail-block"><span class="k">直接下游（${refs.length}）：</span>${
    refs.length ? refs.map(r => `<span class="dep-link" data-goto="${r.id}">${esc(r.name)}</span>`).join('、') : '无'}</div>`;
  const desc = descendants(state.doc, n.id);
  html += `<div class="detail-block"><span class="k">受影响后代（${desc.length}）：</span>${
    desc.length ? desc.map(d => `<span class="dep-link" data-goto="${d.id}">${esc(d.name)}</span>`).join(' → ') : '无'}</div>`;

  // 依赖编辑（仅未冻结派生）：改来源 / 运算 / 容差
  if (n.kind === 'derived' && !n.frozen) {
    const opts = sid => state.doc.nodes
      .filter(x => x.id !== n.id)
      .map(x => `<option value="${x.id}" ${x.id === sid ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
    html += `<div class="detail-block">
      <div class="src-edit-row">
        A <select class="src-select" data-role="a">${opts(n.sources[0])}</select>
        <select class="op-select">
          <option value="union" ${n.op === 'union' ? 'selected' : ''}>∪ 合并</option>
          <option value="difference" ${n.op === 'difference' ? 'selected' : ''}>− 减去</option>
          <option value="intersection" ${n.op === 'intersection' ? 'selected' : ''}>∩ 相交</option>
        </select>
        B <select class="src-select" data-role="b">${opts(n.sources[1])}</select>
        ε <input class="eps-edit" type="number" min="0.000001" max="100" step="0.1" value="${n.eps}" style="width:64px;background:#12151d;color:var(--text);border:1px solid var(--border);border-radius:5px;padding:2px 4px;">
        <button class="apply-sources">应用（成环会被拒绝）</button>
      </div>
    </div>`;
  }
  els.shapeDetail.innerHTML = html;
  els.shapeDetail.querySelectorAll('[data-goto]').forEach(el => {
    el.addEventListener('click', () => selectNode(el.dataset.goto));
  });
  const applyBtn = els.shapeDetail.querySelector('.apply-sources');
  if (applyBtn) {
    applyBtn.addEventListener('click', () => {
      const selects = els.shapeDetail.querySelectorAll('.src-select');
      const aId = selects[0].value, bId = selects[1].value;
      const op = els.shapeDetail.querySelector('.op-select').value;
      const eps = Number(els.shapeDetail.querySelector('.eps-edit').value);
      if (!Number.isFinite(eps) || eps <= 0) { showToast('容差必须为正数', 'error'); return; }
      editDerivedSources(n.id, aId, bId, op, eps);
    });
  }
  syncFreezeButtons(n);
}

function syncFreezeButtons(n) {
  els.freeze.disabled = !(n && n.kind === 'derived' && !n.frozen);
  els.unfreeze.disabled = !(n && n.frozen);
}

function renderRounds() {
  const rounds = state.doc.rounds || [];
  const shown = rounds.slice(-12).reverse();
  els.roundsList.innerHTML = shown.map(r => {
    const names = r.entries.map(e => esc(e.name)).join(' → ');
    const head = r.ok
      ? `<span class="rt">${esc(r.label || triggerLabel(r))}</span><span class="round-badge ok">成功</span>`
      : `<span class="rt">${esc(r.label || triggerLabel(r))}</span><span class="round-badge failed">已回滚</span>`;
    return `<div class="round-item ${r.ok ? 'ok' : 'failed'}">
      #${r.seq} ${head}
      ${r.entries.length ? `<div class="nodes">顺序：${names}</div>` : ''}
      ${!r.ok ? `<div class="fail">失败节点：<b>${esc(r.failedName || r.failedId)}</b>（${failureLabel(r.failedCode)}）— ${esc(r.reason || '')}</div>` : ''}
      <div class="rh">round hash #${r.hash}</div>
    </div>`;
  }).join('') || '<div class="muted">尚无重算日志。</div>';
}

function triggerLabel(r) {
  return {
    edit: '来源编辑/变换后重算', create: '创建派生图形', sources: '改写依赖',
    freeze: '冻结', unfreeze: '解冻重算', delete: '删除', 'delete-cancel': '取消删除',
  }[r.trigger] || r.trigger;
}

function syncOperandUI() {
  const names = state.selected.map(id => getNode(state.doc, id)?.name).filter(Boolean);
  els.operands.textContent = names.length === 2
    ? `A = ${names[0]}（先选）　B = ${names[1]}（后选）`
    : names.length === 1 ? `A = ${names[0]}（再选一个图形作为 B）` : '未选择图形（点击图形选择，先选为 A）';
  const ready = state.selected.length === 2;
  els.opUnion.disabled = els.opDiff.disabled = els.opInter.disabled = !ready;
  syncFreezeButtons(selectedNode());
}

function syncModeUI() {
  els.modeSelect.classList.toggle('active', state.mode === 'select');
  els.modeDraw.classList.toggle('active', state.mode === 'draw');
}

function setMode(m) {
  if (state.mode === 'verts' && m !== 'verts') exitVertMode();
  state.mode = m;
  if (m !== 'draw') state.drawPts = [];
  els.hint.textContent = m === 'draw' ? '绘制：点击添加顶点，点击首点或按 Enter 闭合，Esc 取消' : '';
  syncModeUI(); render();
}

// ---------- 工具 ----------

function selectNode(id) {
  if (state.mode === 'verts') exitVertMode();
  if (state.selected.length >= 2) state.selected = [id];
  else if (!state.selected.includes(id)) state.selected.push(id);
  syncOperandUI(); renderPanels(); render();
}

let toastTimer = null;
function showToast(msg, kind) {
  els.toast.textContent = msg;
  els.toast.className = `toast show ${kind || 'info'}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.className = 'toast'; }, 6500);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- 事件 ----------

els.modeSelect.addEventListener('click', () => setMode('select'));
els.modeDraw.addEventListener('click', () => setMode('draw'));
els.opUnion.addEventListener('click', () => doBoolean('union'));
els.opDiff.addEventListener('click', () => doBoolean('difference'));
els.opInter.addEventListener('click', () => doBoolean('intersection'));
els.undo.addEventListener('click', doUndo);
els.redo.addEventListener('click', doRedo);
els.fit.addEventListener('click', () => { fitView(); render(); });
els.freeze.addEventListener('click', doFreeze);
els.unfreeze.addEventListener('click', doUnfreeze);
els.del.addEventListener('click', requestDelete);
els.reset.addEventListener('click', () => {
  if (!confirm('清空场景与全部历史？')) return;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  state.history = createHistory();
  state.doc = createDocument();
  state.selected = [];
  state.rootSeq = 0; state.derivedSeq = 0;
  seedScene();
});
els.eps.addEventListener('change', () => {
  const v = Number(els.eps.value);
  if (Number.isFinite(v) && v > 0 && v <= 100) {
    state.eps = v;
    showToast(`默认容差 ε 已设为 ${v}（仅作用于之后新建的派生图形；既有派生记住各自容差）`, 'info');
    persist();
  } else els.eps.value = String(state.eps);
});

window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? doRedo() : doUndo();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault(); doRedo();
  } else if (e.key === 'Escape') {
    if (state.pendingDelete) { closeModal(); return; }
    if (state.mode === 'draw') { cancelDraw(); setMode('select'); }
    else if (state.mode === 'verts') exitVertMode();
  } else if (e.key === 'Enter' && state.mode === 'draw') {
    closeDraw();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    requestDelete();
  }
});

// ---------- 初始化 ----------

function seedScene() {
  const g1 = normalizeGeom([[[60, 60], [300, 60], [300, 260], [60, 260]]], state.eps, []);
  const g2 = normalizeGeom([[[200, 160], [420, 160], [420, 340], [200, 340]]], state.eps, []);
  addRoot(state.doc, `形状${++state.rootSeq}`, g1, PALETTE[0]);
  addRoot(state.doc, `形状${++state.rootSeq}`, g2, PALETTE[1]);
  state.selected = [];
  commitHistory('初始场景', '两个重叠矩形；选中两个后可保存为派生图形');
  fitView();
}

function init() {
  els.eps.value = String(state.eps);
  const restored = loadPersisted();
  if (!restored) {
    if (!state.reloadCheck) state.reloadCheck = { ok: true, text: '无已存历史：已创建初始场景' };
    seedScene();
  } else {
    fitView();
  }
  syncModeUI();
  syncOperandUI();
  renderPanels();
  render();
}

new ResizeObserver(resizeCanvas).observe(canvas);
init();
