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
import {
  ensureConstraints, hasConstraints, findEdge,
  KIND_LABELS, EDGE_KINDS, previewItemsChange, solveSystem, evaluate,
  findConflictCore, planVertexRemoval, planVertexMerge,
  translateConstraints, scaleConstraints, describeRefs, radToDeg, degToRad,
  edgeAngle, constraintsDigest,
} from './constraints.js';

const STORAGE_KEY = 'polybool.graph.v3';
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
  // —— 约束编辑 ——
  picks: { vertices: [], edges: [] }, // 拾取的顶点 key / 边 {a,b}（仅 editShapeId）
  dragSession: null,     // 顶点/边拖动预览会话（未确认前不落盘）
  diagCache: null,       // 当前编辑图形的约束诊断缓存 {csKey, diag, sol}
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
  btnVerts: $('btn-verts'),
  eps: $('eps-input'),
  badge: $('reload-badge'),
  toast: $('toast'),
  shapesList: $('shapes-list'), shapeDetail: $('shape-detail'),
  roundsList: $('rounds-list'),
  historyList: $('history-list'),
  hint: $('hint'),
  modal: $('modal-backdrop'), modalTitle: $('modal-title'), modalBody: $('modal-body'),
  modalCancel: $('modal-cancel-delete'), modalFreeze: $('modal-freeze-direct'), modalCascade: $('modal-cascade'),
  // 约束
  pickStatus: $('pick-status'),
  cBtns: {
    coincident: $('c-coincident'), horizontal: $('c-horizontal'), vertical: $('c-vertical'),
    'equal-length': $('c-equal'), 'fixed-length': $('c-fixedlen'), parallel: $('c-parallel'),
    perpendicular: $('c-perp'), 'fixed-angle': $('c-angle'),
    'lock-point': $('c-lock-point'), 'lock-edge': $('c-lock-edge'),
  },
  btnDelVertex: $('btn-del-vertex'), btnMergeVerts: $('btn-merge-verts'),
  constraintsList: $('constraints-list'), conflictBox: $('conflict-box'),
  previewBar: $('preview-bar'), previewText: $('preview-text'),
  pvConfirm: $('pv-confirm'), pvCancel: $('pv-cancel'),
  dialog: $('dialog-backdrop'), dialogTitle: $('dialog-title'),
  dialogBody: $('dialog-body'), dialogActions: $('dialog-actions'),
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

/** 当前应显示的几何：约束拖动预览期间编辑图形显示求解结果，其余图形照常。 */
function displayGeom(node) {
  if (state.dragSession && state.dragSession.preview && node.id === state.editShapeId) {
    return state.dragSession.preview.sol.geom;
  }
  return node.geom;
}

function render() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  drawGrid(w, h);
  drawDependencyEdges();

  for (const node of state.doc.nodes) {
    const dGeom = displayGeom(node);
    const isPreviewing = node.id === state.editShapeId && state.dragSession && state.dragSession.preview;
    if (isPreviewing) {
      // 原位置虚影
      const ghost = geomPath(node.geom);
      ctx.fillStyle = 'rgba(150,160,190,0.07)';
      ctx.fill(ghost, 'evenodd');
      ctx.lineWidth = 1; ctx.setLineDash([3, 4]); ctx.strokeStyle = 'rgba(180,190,220,.55)';
      ctx.stroke(ghost); ctx.setLineDash([]);
    }
    const path = geomPath(dGeom);
    const selIdx = state.selected.indexOf(node.id);
    ctx.fillStyle = node.color + (selIdx >= 0 ? '55' : '26');
    ctx.fill(path, 'evenodd');
    ctx.lineWidth = selIdx >= 0 ? 2.5 : 1.5;
    ctx.strokeStyle = selIdx >= 0 ? '#ffd166' : node.color;
    ctx.setLineDash(isDerived(node) ? [6, 4] : []);
    ctx.stroke(path);
    ctx.setLineDash([]);
    // 名称 / 状态
    const bb = geomBBox(dGeom);
    if (bb) {
      const [tx, ty] = toScreen([bb.minX, bb.minY]);
      ctx.fillStyle = isFrozen(node) ? '#9fd7ff' : '#8b93a7';
      ctx.font = '11px system-ui';
      const prefix = isFrozen(node) ? '❄ ' : isDerived(node) ? 'ƒ ' : '';
      ctx.fillText(prefix + node.name, tx, ty - 6);
      if (selIdx >= 0) {
        const c = toScreen(geomCentroid(dGeom));
        ctx.fillStyle = '#ffd166';
        ctx.font = 'bold 13px system-ui';
        ctx.fillText(selIdx === 0 ? 'A' : 'B', c[0] - 4, c[1] + 4);
      }
    }
  }

  if (state.mode === 'select' && state.selected.length === 1) drawHandles();
  if (state.mode === 'draw') drawDraft();
  if (state.mode === 'verts') { drawConstraintEdges(); drawVertices(); drawPicks(); }
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

function editNode() {
  return state.editShapeId ? getNode(state.doc, state.editShapeId) : null;
}

/** 当前编辑图形用于求解/绘制的几何（预览中用求解结果）。 */
function editGeom() {
  const n = editNode();
  if (!n) return null;
  return displayGeom(n);
}

/** 当前编辑图形的约束（进入 verts 模式时保证已初始化）。 */
function editCs() {
  const n = editNode();
  return n ? n.constraints : null;
}

const STATUS_COLOR = {
  satisfied: '#3fbf7f', deviated: '#f7a83f', conflict: '#f76f6f', off: '#6b7288', orphan: '#d98a5a',
};

/** 按约束状态着色编辑图形的边；锁定顶点画方块、锁定边加粗。 */
function drawConstraintEdges() {
  const node = editNode();
  if (!node || !node.constraints || isDerived(node)) return;
  const geom = editGeom();
  const cs = node.constraints;
  const diag = currentDiag();
  // 顶点 key → 屏幕坐标
  const screenOf = new Map();
  geom.forEach((poly, pi) => poly.forEach((ring, ri) => {
    ring.forEach((p, vi) => screenOf.set(cs.vkeys[pi][ri][vi], toScreen(p)));
  }));
  // 约束边状态着色（多约束共享一条边时取最严重状态）
  const edgeStatus = new Map();
  const rank = { conflict: 4, deviated: 3, satisfied: 2, off: 1, orphan: 1 };
  const noteEdge = (ref, st) => {
    const tok = ref.a < ref.b ? `${ref.a}|${ref.b}` : `${ref.b}|${ref.a}`;
    const prev = edgeStatus.get(tok);
    if (!prev || rank[st] > rank[prev]) edgeStatus.set(tok, st);
  };
  for (const it of cs.items) {
    const st = diag.statusById[it.id] || 'satisfied';
    if (EDGE_KINDS.includes(it.kind) || it.kind === 'lock-edge') noteEdge(it.edge, st);
    if (it.kind === 'equal-length' || it.kind === 'parallel' || it.kind === 'perpendicular') {
      it.edges.forEach(e => noteEdge(e, st));
    }
  }
  geom.forEach((poly, pi) => poly.forEach((ring, ri) => {
    const keys = cs.vkeys[pi][ri];
    for (let i = 0; i < ring.length; i++) {
      const a = screenOf.get(keys[i]), b = screenOf.get(keys[(i + 1) % ring.length]);
      const tok = keys[i] < keys[(i + 1) % ring.length]
        ? `${keys[i]}|${keys[(i + 1) % ring.length]}`
        : `${keys[(i + 1) % ring.length]}|${keys[i]}`;
      const st = edgeStatus.get(tok);
      if (st && st !== 'off') {
        ctx.strokeStyle = STATUS_COLOR[st];
        ctx.lineWidth = 4;
        ctx.globalAlpha = 0.75;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }));
  // 锁定元素标记
  for (const it of cs.items) {
    if (!it.enabled) continue;
    if (it.kind === 'lock-point') {
      const p = screenOf.get(it.vertex);
      if (p) { ctx.fillStyle = '#f76f6f'; ctx.fillRect(p[0] - 4, p[1] - 4, 8, 8); }
    } else if (it.kind === 'lock-edge') {
      const p1 = screenOf.get(it.edge.a), p2 = screenOf.get(it.edge.b);
      if (p1 && p2) {
        ctx.strokeStyle = '#f76f6f'; ctx.lineWidth = 2.5;
        ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }
}

function drawVertices() {
  const node = editNode();
  if (!node || isDerived(node)) return;
  const geom = editGeom();
  const cs = node.constraints;
  const diag = currentDiag();
  geom.forEach((poly, pi) => poly.forEach((ring, ri) => {
    ring.forEach((p, vi) => {
      const key = cs.vkeys[pi][ri][vi];
      const [x, y] = toScreen(p);
      const picked = state.picks.vertices.includes(key);
      const locked = cs.items.some(i => i.enabled && i.kind === 'lock-point' && i.vertex === key);
      if (picked) {
        ctx.fillStyle = '#ffd166';
        ctx.beginPath(); ctx.arc(x, y, 7.5, 0, Math.PI * 2); ctx.fill();
      } else if (!locked) {
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#4f8ef7'; ctx.lineWidth = 1.5; ctx.stroke();
      }
    });
  }));
}

function drawPicks() {
  const node = editNode();
  if (!node) return;
  const cs = node.constraints;
  const geom = editGeom();
  // 拾取的边高亮
  for (const e of state.picks.edges) {
    const ed = findEdge(node, e);
    if (!ed) continue;
    const p1 = geom[ed.pi][ed.ri][ed.ei];
    const p2 = geom[ed.pi][ed.ri][(ed.ei + 1) % geom[ed.pi][ed.ri].length];
    const [x1, y1] = toScreen(p1), [x2, y2] = toScreen(p2);
    ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 8; ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.globalAlpha = 1;
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
  const node = editNode();
  if (!node) return null;
  const geom = editGeom();
  const cs = node.constraints;
  const r = 8 / state.view.scale;
  const wp = toWorld(sp);
  for (let pi = 0; pi < geom.length; pi++) {
    for (let ri = 0; ri < geom[pi].length; ri++) {
      const ring = geom[pi][ri];
      for (let vi = 0; vi < ring.length; vi++) {
        if (dist(ring[vi], wp) <= r) return { pi, ri, vi, key: cs.vkeys[pi][ri][vi], point: ring[vi] };
      }
    }
  }
  return null;
}

/** 在屏幕位置拾取最近的边（容差随缩放固定像素），返回 {edge:{a,b}, pi,ri,ei, point}。 */
function edgeAt(sp) {
  const node = editNode();
  if (!node) return null;
  const geom = editGeom();
  const cs = node.constraints;
  const wp = toWorld(sp);
  const tol = 8 / state.view.scale;
  let best = null;
  geom.forEach((poly, pi) => poly.forEach((ring, ri) => {
    const keys = cs.vkeys[pi][ri];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const hit = pointSegDist(wp, a, b);
      if (hit.d <= tol && (!best || hit.d < best.d)) {
        best = { d: hit.d, edge: { a: keys[i], b: keys[(i + 1) % ring.length] }, pi, ri, ei: i, point: hit.point };
      }
    }
  }));
  return best;
}

// ---------- 约束拖动预览会话 ----------

const edgeEq = (e1, e2) => {
  const t = e => e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`;
  return t(e1) === t(e2);
};

function beginVertexDrag(node, hit, wp) {
  invalidateDiag();
  state.dragSession = {
    kind: 'vertex',
    key: hit.key,
    from: node.geom[hit.pi][hit.ri][hit.vi].slice(),
    moved: false,
    preview: null,
  };
  updateDragPreview(wp);
}

function beginEdgeDrag(node, eh, wp) {
  invalidateDiag();
  state.dragSession = {
    kind: 'edge',
    edge: eh.edge,
    fromA: node.geom[eh.pi][eh.ri][eh.ei].slice(),
    fromB: node.geom[eh.pi][eh.ri][(eh.ei + 1) % node.geom[eh.pi][eh.ri].length].slice(),
    grab: wp.slice(),
    moved: false,
    preview: null,
  };
  updateDragPreview(wp);
}

/** 根据当前指针世界坐标实时求解（不落盘）。 */
function updateDragPreview(wp) {
  const s = state.dragSession;
  const node = editNode();
  if (!s || !node) return;
  let opts;
  if (s.kind === 'vertex') {
    opts = { dragHandle: { key: s.key, from: s.from, to: wp.slice() } };
    s.moved = s.moved || dist(s.from, wp) > 1e-7;
  } else {
    const ddx = wp[0] - s.grab[0], ddy = wp[1] - s.grab[1];
    s.moved = s.moved || Math.hypot(ddx, ddy) > 1e-7;
    opts = {
      pins: new Map([
        [s.edge.a, [s.fromA[0] + ddx, s.fromA[1] + ddy]],
        [s.edge.b, [s.fromB[0] + ddx, s.fromB[1] + ddy]],
      ]),
    };
  }
  const sol = solveSystem(node.geom, node.constraints, opts);
  s.preview = { sol, opts };
  invalidateDiag();
  renderPanels();
  render();
}

/** 确认拖动预览：整组坐标变化作为一次原子操作落盘并重算下游。 */
function confirmDragPreview() {
  const s = state.dragSession;
  const node = editNode();
  if (!s || !node) { cancelDragPreview(false); return; }
  const sol = s.preview.sol;
  if (!s.moved) { cancelDragPreview(false); return; }
  if (!sol.feasible) {
    showToast('当前约束冲突，无法确认：请在冲突面板停用造成无解的约束', 'error');
    return;
  }
  const nextGeom = JSON.parse(JSON.stringify(sol.geom));
  const v = validateGeom(nextGeom, state.eps);
  if (!v.ok) { showToast(`拖动结果拓扑无效：${v.errors[0]}，请取消预览`, 'error'); return; }
  // 先恢复几何（本就未落盘），交给原子变更入口应用 + 重算下游
  const label = s.kind === 'vertex' ? `拖动顶点（${node.name}）` : `拖动边（${node.name}）`;
  state.dragSession = null;
  invalidateDiag();
  applyMutation([{ id: node.id, geom: nextGeom }], label);
}

/** 取消拖动（Esc / 按钮 / 求解失败）：恢复原位置，什么也不写入。 */
function cancelDragPreview(notify = true) {
  state.dragSession = null;
  invalidateDiag();
  if (notify) showToast('已取消预览，坐标恢复原位', 'info');
  renderPanels();
  render();
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
    const node = editNode();
    // 拖动预览未确认时，画布不响应新拾取
    if (state.dragSession) return;
    const vh = vertexAt(sp);
    if (vh) {
      const locked = node.constraints.items.some(i => i.enabled && i.kind === 'lock-point' && i.vertex === vh.key);
      if (locked) { showToast('该顶点已锁定：不能直接拖动（可在约束面板停用/删除锁定）', 'info'); return; }
      beginVertexDrag(node, vh, wp);
      return;
    }
    const eh = edgeAt(sp);
    if (eh) {
      const lockEdge = node.constraints.items.find(i => i.enabled && i.kind === 'lock-edge' &&
        edgeEq(i.edge, eh.edge));
      if (lockEdge) { showToast('该边已锁定：不能拖动（可在约束面板停用/删除锁定）', 'info'); return; }
      beginEdgeDrag(node, eh, wp);
      return;
    }
    // 点击空白：先平移；mouseup 若基本未动则视为拾取点击
    drag = { type: 'pan', start: sp, view0: { ...state.view }, vertClick: true };
    return;
  }
  const single = state.selected.length === 1 ? getNode(state.doc, state.selected[0]) : null;
  const hh = single && !isDerived(single) ? hitHandle(sp) : null;
  if (hh) {
    drag = { type: 'scale', node: single, base: JSON.stringify(single.geom),
      baseCs: single.constraints ? JSON.stringify(single.constraints) : null };
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
        .map(n => ({
          id: n.id, geom: JSON.stringify(n.geom), movable: !isDerived(n),
          cs: n.constraints ? JSON.stringify(n.constraints) : null,
        })),
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
  // 约束拖动预览：实时重解，绝不写 doc
  if (state.dragSession) { updateDragPreview(wp); return; }
  if (!drag) { render(); return; }
  if (drag.type === 'pan') {
    state.view.ox = drag.view0.ox + (sp[0] - drag.start[0]);
    state.view.oy = drag.view0.oy + (sp[1] - drag.start[1]);
  } else if (drag.type === 'move') {
    const dx = wp[0] - drag.start[0], dy = wp[1] - drag.start[1];
    for (const b of drag.bases) {
      if (!b.movable) continue;
      const baseGeom = JSON.parse(b.geom);
      const nn = getNode(state.doc, b.id);
      nn.geom = translateGeom(baseGeom, dx, dy);
      if (nn.constraints) translateConstraints(nn.constraints, dx, dy);
    }
  } else if (drag.type === 'scale') {
    const n = drag.node;
    const baseGeom = JSON.parse(drag.base);
    const c = geomCentroid(baseGeom);
    const k = Math.max(0.05, dist(wp, c) / Math.max(1e-6, dist(drag.start, c)));
    const [px, py] = c;
    n.geom = baseGeom.map(poly => poly.map(ring => ring.map(([x, y]) => [px + (x - px) * k, py + (y - py) * k])));
    if (n.constraints) scaleConstraints(n.constraints, k, c);
    drag.k = k;
  }
  render();
});

canvas.addEventListener('mouseup', (e) => {
  // 约束拖动：保持预览，等待确认/取消
  if (state.dragSession) { return; }
  if (!drag) return;
  const d = drag;
  drag = null;
  const sp2 = canvasPos(e);
  if (d.type === 'pan' && d.vertClick) {
    // verts 模式下的“点击”（基本没发生平移）：切换拾取
    if (Math.hypot(sp2[0] - d.start[0], sp2[1] - d.start[1]) <= 5) {
      handleVertsClick(d.start);
    }
    return;
  }
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
      // 保存“平移后”的约束锚点；先整体还原，引擎成功后再写回几何与锚点
      const movedCs = moved.map(b => {
        const nn = getNode(state.doc, b.id);
        return { id: b.id, cs: nn.constraints ? JSON.stringify(nn.constraints) : null };
      });
      const changes = moved.map(b => ({ id: b.id, geom: getNode(state.doc, b.id).geom }));
      // 先还原（几何 + 锚点），再让引擎原子地应用 + 重算（失败则全部回滚）
      for (const b of moved) {
        const nn = getNode(state.doc, b.id);
        nn.geom = JSON.parse(b.geom);
        if (b.cs) nn.constraints = JSON.parse(b.cs);
      }
      const names = moved.map(b => getNode(state.doc, b.id)?.name).filter(Boolean).join('、');
      const applied = applyMutation(changes, `移动 ${names} Δ(${dx}, ${dy})`, { commit: false });
      if (applied) {
        // 成功：平移约束锚点（锁点/锁边）与固定长度随整体移动
        for (const mc of movedCs) {
          const nn = getNode(state.doc, mc.id);
          if (mc.cs && nn.constraints) translateConstraints(nn.constraints, dx, dy);
        }
        finalizeMutationHistory(`移动 ${names} Δ(${dx}, ${dy})`,
          `已原子重算 ${applied.round.entries.length} 个下游节点（约束锚点随整体平移）`);
      }
    }
  } else if (d.type === 'scale') {
    if (d.k && Math.abs(d.k - 1) > 1e-9) {
      const n = d.node;
      const nextGeom = JSON.parse(JSON.stringify(n.geom));
      const nextCs = n.constraints ? JSON.parse(JSON.stringify(n.constraints)) : null;
      const c = geomCentroid(JSON.parse(d.base));
      n.geom = JSON.parse(d.base); // 还原后由引擎应用
      if (d.baseCs) n.constraints = JSON.parse(d.baseCs);
      const applied = applyMutation([{ id: n.id, geom: nextGeom }], `缩放 ${n.name} ×${f2(d.k)}（绕质心）`, { commit: false });
      if (applied) {
        if (nextCs) { n.constraints = nextCs; } // 缩放后的锚点/长度随几何一起生效
        finalizeMutationHistory(`缩放 ${n.name} ×${f2(d.k)}（绕质心）`, '约束锚点与固定长度已随缩放更新');
      }
    } else {
      d.node.geom = JSON.parse(d.base);
      if (d.baseCs) d.node.constraints = JSON.parse(d.baseCs);
    }
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

/**
 * 原子应用几何变更 + 下游重算。
 * opts.commit=false 时只应用、不写历史（供约束锚点需要同步调整的调用方，
 * 调整完成后必须调用 finalizeMutationHistory；失败时整轮回滚且不留半状态）。
 * 返回 graph 引擎的 result（成功含 round）。
 */
function applyMutation(changes, label, opts = {}) {
  const result = mutateGeometries(pc, state.doc, changes, label);
  if (!result.ok) {
    const f = result.failed;
    showToast(`重算失败已整轮回滚：节点「${f.node.name}」— ${result.reason}`, 'error');
    commitHistory(label, `✗ 重算失败已回滚：${f.node.name}（${failureLabel(f.code)}）`);
    renderPanels();
    return result;
  }
  if (opts.commit !== false) {
    const names = result.round.entries.map(e => e.name).join(' → ');
    commitHistory(label, `自动重算 ${result.round.entries.length} 个节点：${names}`);
    showToast(`已按依赖顺序重算 ${result.round.entries.length} 个节点`, 'ok');
    renderPanels();
  }
  return result;
}

/** applyMutation(..., {commit:false}) 成功、调用方补改完约束后，统一写历史/提示。 */
function finalizeMutationHistory(label, detail) {
  commitHistory(label, detail || '几何与约束已一起更新');
  showToast('已写入（一次原子操作，可撤销）', 'ok');
  renderPanels();
}

function failureLabel(code) {
  return {
    'empty-result': '结果为空',
    'invalid-result': '结果拓扑无效',
    'invalid-source': '来源拓扑无效',
    'missing-source': '来源缺失',
    'constraints-infeasible': '约束无解',
    engine: '引擎错误',
  }[code] || code;
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

// ---------- 顶点编辑模式（含几何约束） ----------

function enterVertMode(id) {
  const node = getNode(state.doc, id);
  if (!node || isDerived(node)) return;
  state.mode = 'verts';
  state.editShapeId = id;
  state.selected = [id];
  ensureConstraints(node); // 首次进入：挂载稳定 vkeys（不产生历史——结构未变）
  state.picks = { vertices: [], edges: [] };
  invalidateDiag();
  els.hint.textContent = '约束编辑：点击顶点/边拾取（再点取消），拖动顶点/边实时预览；Esc 退出或取消预览';
  syncModeUI(); syncOperandUI(); syncConstraintUI(); renderConstraintsPanel(); render();
}
function exitVertMode() {
  if (state.dragSession) { cancelDragPreview(false); }
  state.mode = 'select';
  state.editShapeId = null;
  state.picks = { vertices: [], edges: [] };
  els.hint.textContent = '';
  invalidateDiag();
  syncModeUI(); syncConstraintUI(); render();
}

function togglePick(list, value, sameFn, max) {
  const idx = list.findIndex(x => sameFn(x, value));
  if (idx >= 0) { list.splice(idx, 1); return; }
  if (list.length >= max) list.shift();
  list.push(value);
}

/** verts 模式下在空白/元素上单击（mouseup 且未发生 pan 拖动时）切换拾取。 */
function handleVertsClick(sp) {
  if (state.dragSession) return;
  const vh = vertexAt(sp);
  if (vh) {
    togglePick(state.picks.vertices, vh.key, (a, b) => a === b, 2);
  } else {
    const eh = edgeAt(sp);
    if (eh) togglePick(state.picks.edges, eh.edge, edgeEq, 2);
  }
  syncConstraintUI(); render();
}

/** 当前编辑图形的约束诊断（缓存；预览/结构变化时失效）。 */
function currentDiag() {
  const node = editNode();
  if (!node || !node.constraints) return null;
  if (state.dragSession && state.dragSession.preview) {
    // 预览中：基于求解几何实时评估
    const fake = { geom: state.dragSession.preview.sol.geom, constraints: node.constraints };
    return evaluate(fake);
  }
  const key = geomHash(node.geom) + ':' + constraintsDigest(node.constraints);
  if (!state.diagCache || state.diagCache.key !== key) {
    state.diagCache = { key, diag: evaluate(node) };
  }
  return state.diagCache.diag;
}
function invalidateDiag() { state.diagCache = null; }

function syncConstraintUI() {
  const inVerts = state.mode === 'verts';
  document.getElementById('constraint-tools').classList.toggle('disabled-group', !inVerts);
  const node = inVerts ? editNode() : null;
  const nv = state.picks.vertices.length, ne = state.picks.edges.length;
  const enable = id => { els.cBtns[id].disabled = !(node && !isDerived(node)); };
  for (const k of Object.keys(els.cBtns)) enable(k);
  if (node) {
    els.cBtns.coincident.disabled = nv !== 2;
    els.cBtns.horizontal.disabled = ne !== 1;
    els.cBtns.vertical.disabled = ne !== 1;
    els.cBtns['equal-length'].disabled = ne !== 2;
    els.cBtns['fixed-length'].disabled = ne !== 1;
    els.cBtns.parallel.disabled = ne !== 2;
    els.cBtns.perpendicular.disabled = ne !== 2;
    els.cBtns['fixed-angle'].disabled = ne !== 1;
    els.cBtns['lock-point'].disabled = nv !== 1;
    els.cBtns['lock-edge'].disabled = ne !== 1;
    els.btnDelVertex.disabled = nv !== 1;
    els.btnMergeVerts.disabled = nv !== 2;
  } else {
    els.btnDelVertex.disabled = true;
    els.btnMergeVerts.disabled = true;
  }
  const parts = [];
  if (nv) parts.push(`${nv} 顶点：${state.picks.vertices.join('、')}`);
  if (ne) parts.push(`${ne} 边：${state.picks.edges.map(e => `${e.a}→${e.b}`).join('，')}`);
  els.pickStatus.textContent = parts.length ? parts.join('　｜　') : '未选择元素（点击顶点/边拾取）';
}

// ---------- 约束增删改（先试解、无确认不移动、原子落盘） ----------

function addConstraintFromPicks(kind) {
  const node = editNode();
  if (!node) return;
  if (kind === 'fixed-length' || kind === 'fixed-angle') {
    const ed = findEdge(node, state.picks.edges[0]);
    const p1 = node.geom[ed.pi][ed.ri][ed.ei];
    const p2 = node.geom[ed.pi][ed.ri][(ed.ei + 1) % node.geom[ed.pi][ed.ri].length];
    const isLen = kind === 'fixed-length';
    const def = isLen ? f4(dist(p1, p2)) : f4(radToDeg(edgeAngle(p1, p2)));
    els.dialogTitle.textContent = isLen ? '固定长度' : '固定角度';
    els.dialogBody.innerHTML = `
      <div class="dialog-field">${isLen ? '长度' : '角度（度，0–180）'}
        <input id="dlg-value" type="number" step="any" value="${def}">
      </div>
      <div class="muted">默认取当前边长/方向；无向边角度按模 180° 解释。</div>`;
    els.dialogActions.innerHTML = '';
    const bCancel = document.createElement('button'); bCancel.textContent = '取消';
    const bOk = document.createElement('button'); bOk.textContent = '试解并写入'; bOk.className = 'ok';
    els.dialogActions.append(bCancel, bOk);
    openDialog();
    bCancel.onclick = () => closeDialog();
    bOk.onclick = () => {
      const raw = Number(document.getElementById('dlg-value').value);
      if (!Number.isFinite(raw)) { showToast('请输入数字', 'error'); return; }
      if (isLen && raw <= 0) { showToast('长度必须为正数', 'error'); return; }
      closeDialog();
      submitAdd(node, { kind, edge: { ...state.picks.edges[0] }, value: isLen ? raw : degToRad(raw) });
    };
    return;
  }
  const spec = buildSpec(kind);
  if (spec) submitAdd(node, spec);
}

function submitAdd(node, spec) {
  const pv = previewItemsChange(node, state.eps, { add: [spec] });
  if (!pv.ok) {
    if (pv.duplicate) { showToast(pv.reason, 'info'); return; }
    if (pv.invalidTopology) { showToast(`拒绝：${pv.reason}`, 'error'); return; }
    // 冲突：列出足以解释无解的约束核，逐项停用后重解
    openConflictDialog(node, pv);
    return;
  }
  commitConstraintChange(node, pv.nextGeom, pv.nextCs,
    `添加约束：${KIND_LABELS[spec.kind]}`,
    `新增 ${pv.candidates.length} 条约束，坐标由求解器在容差内贴合`);
}

function buildSpec(kind) {
  const v = state.picks.vertices, e = state.picks.edges;
  switch (kind) {
    case 'coincident': return { kind, vertices: [v[0], v[1]] };
    case 'horizontal': case 'vertical': return { kind, edge: { ...e[0] } };
    case 'equal-length': case 'parallel': case 'perpendicular':
      return { kind, edges: [{ ...e[0] }, { ...e[1] }] };
    case 'fixed-length': return { kind, edge: { ...e[0] } }; // value 在对话框填入
    case 'fixed-angle': return { kind, edge: { ...e[0] } };  // value 在对话框填入
    case 'lock-point': return { kind, vertex: v[0] };
    case 'lock-edge': return { kind, edge: { ...e[0] } };
    default: return null;
  }
}

/**
 * 把一次“几何 + 约束集”的联合变更作为一次原子操作落盘：
 * 先在副本外试好（调用方已得到 nextGeom/nextCs），再交给引擎原子应用几何、重算下游，
 * 成功后写约束、统一提交历史；任一下游失败则几何与约束整轮回滚。
 */
function commitConstraintChange(node, nextGeom, nextCs, label, detail) {
  const baseGeom = JSON.parse(JSON.stringify(node.geom));
  const baseCs = JSON.parse(JSON.stringify(node.constraints));
  const result = mutateGeometries(pc, state.doc, [{ id: node.id, geom: nextGeom }], label);
  if (!result.ok) {
    showToast(`下游重算失败，已整轮回滚（约束未写入）：${result.failed.node.name} — ${result.reason}`, 'error');
    commitHistory(label, `✗ 约束变更随下游失败回滚：${result.failed.node.name}`);
    renderPanels(); render();
    return false;
  }
  // 几何与下游已原子更新；现在落约束（与几何一致），统一记一条历史
  node.constraints = nextCs;
  invalidateDiag();
  commitHistory(label, detail);
  showToast('约束已写入（一次原子操作，可撤销）', 'ok');
  state.picks = { vertices: [], edges: [] };
  syncConstraintUI(); renderConstraintsPanel(); renderPanels(); render();
  return true;
}

/** 仅改约束（启停/删除/编辑数值），不改几何：求解预览 → 确认式原子提交。 */
function patchConstraints(node, patch, label, detail) {
  const pv = previewItemsChange(node, state.eps, patch);
  if (!pv.ok) {
    if (pv.nextCs && !pv.invalidTopology && !pv.duplicate) openConflictDialog(node, pv);
    else showToast(`拒绝：${pv.reason}`, 'error');
    return false;
  }
  return commitConstraintChange(node, pv.nextGeom, pv.nextCs, label, detail);
}

// ---------- 冲突对话框（逐项停用 → 重解 → 确认） ----------

function openConflictDialog(node, failedPreview) {
  // failedPreview.nextCs：含候选新约束但不可解的完整约束集
  const csTrial = failedPreview.nextCs;
  const probe = { ...node, constraints: csTrial };
  const { coreIds, result } = findConflictCore(node.geom, csTrial);
  const coreSet = new Set(coreIds);
  const disabled = new Set(); // 本轮临时停用
  const ids = csTrial.items.map(i => i.id);
  const isNew = new Set((failedPreview.candidates || []).map(i => i.id));

  const renderCore = () => {
    const excludeIds = new Set(disabled);
    const sol = solveSystem(node.geom, csTrial, { excludeIds });
    const feasible = sol.feasible;
    els.dialogTitle.textContent = '约束冲突：以下约束组合无解';
    const rows = csTrial.items
      .filter(i => coreSet.has(i.id))
      .map(i => {
        const off = disabled.has(i.id);
        const cand = isNew.has(i.id) ? '<span class="pick-badge v">新</span>' : '';
        return `<div class="core-item">
          <label><input type="checkbox" data-id="${i.id}" ${off ? '' : 'checked'}>
          <b>${esc(KIND_LABELS[i.kind])}</b> ${cand}
          <small class="muted">${esc(i.id)} · ${esc(describeRefs(i))}</small></label>
        </div>`;
      }).join('');
    els.dialogBody.innerHTML = `
      <div>${esc(failedPreview.reason || '约束相互冲突')}</div>
      <div class="dialog-core">
        <div class="muted">一组足以解释冲突的约束（停用其中任一项即可重新求解）：</div>
        ${rows}
      </div>
      <div id="conflict-res" class="${feasible ? '' : 'err'}">
        ${feasible ? '✓ 停用后已恢复可解，可以确认写入。' : '✗ 当前停用组合仍无解，请继续停用造成冲突的约束。'}
      </div>`;
    els.dialogActions.innerHTML = '';
    const bCancel = document.createElement('button'); bCancel.textContent = '取消（不改动）';
    const bConfirm = document.createElement('button');
    bConfirm.textContent = '确认停用并重解写入';
    bConfirm.className = 'ok'; bConfirm.disabled = !feasible;
    els.dialogActions.append(bCancel, bConfirm);
    bCancel.onclick = () => closeDialog();
    bConfirm.onclick = () => {
      // 应用停用（enabled=false）+ 新约束；几何取可行解
      const finalCs = JSON.parse(JSON.stringify(csTrial));
      for (const it of finalCs.items) if (disabled.has(it.id)) it.enabled = false;
      const finalSol = solveSystem(node.geom, finalCs, { excludeIds: new Set() });
      closeDialog();
      commitConstraintChange(node, finalSol.geom, finalCs,
        '停用冲突约束并重解', `停用 ${disabled.size} 条约束后系统恢复可解`);
    };
    els.dialogBody.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = cb.dataset.id;
        if (cb.checked) disabled.delete(id); else disabled.add(id);
        renderCore();
      });
    });
  };
  openDialog();
  renderCore();
}

function openDialog() { els.dialog.classList.remove('hidden'); }
function closeDialog() { els.dialog.classList.add('hidden'); els.dialogActions.innerHTML = ''; }

// ---------- 约束面板 ----------

function renderConstraintsPanel() {
  // verts 模式：完整交互；select 模式单选：只读显示该图形约束状态
  let node = null, readOnly = false;
  if (state.mode === 'verts') node = editNode();
  else if (state.selected.length === 1) {
    const sn = getNode(state.doc, state.selected[0]);
    if (sn && !isDerived(sn) && sn.constraints) { node = sn; readOnly = true; }
  }
  if (!node) {
    els.constraintsList.innerHTML = '<div class="muted">双击图形（或选中后点“顶点/约束编辑”）进入约束编辑。</div>';
    els.conflictBox.classList.add('hidden');
    els.previewBar.classList.add('hidden');
    return;
  }
  const cs = node.constraints;
  // 只读模式下用节点自身几何做诊断（非编辑节点不进拖动预览）
  const diag = state.mode === 'verts' ? currentDiag() : evaluate(node);
  // 约束行
  if (!cs.items.length) {
    els.constraintsList.innerHTML = '<div class="muted">尚无约束：在画布上拾取顶点/边后点左侧按钮添加。</div>';
  } else {
    els.constraintsList.innerHTML = cs.items.map(it => {
      const st = diag ? diag.statusById[it.id] : 'satisfied';
      const res = diag && diag.residualById.has(it.id) ? diag.residualById.get(it.id) : 0;
      const icon = { satisfied: '✓', deviated: '⚠', conflict: '✗', off: '⊘', orphan: '?' }[st] || '·';
      const resTxt = st === 'satisfied' || st === 'off' ? '' :
        `<span class="res">Δ ${res >= 1 ? res.toFixed(2) : res.toExponential(1)}</span>`;
      const valueEdit = (it.kind === 'fixed-length' || it.kind === 'fixed-angle')
        ? `<button class="c-edit" data-id="${it.id}" title="编辑数值">✎</button>` : '';
      const actions = readOnly ? '' :
        `<button class="c-toggle" data-id="${it.id}" title="启用/停用">${it.enabled ? '停用' : '启用'}</button>
         ${valueEdit}
         <button class="c-del danger" data-id="${it.id}" title="删除">删</button>`;
      return `<div class="c-item ${st}" data-id="${it.id}">
        <span class="kind">${icon} ${esc(KIND_LABELS[it.kind])}</span>
        <span class="refs">${esc(describeRefs(it))} <span class="cid">${it.id}</span></span>
        ${resTxt}
        ${actions}
      </div>`;
    }).join('');
    els.constraintsList.querySelectorAll('.c-toggle').forEach(b => b.addEventListener('click', () => {
      const it = cs.items.find(x => x.id === b.dataset.id);
      if (!it) return;
      const now = !it.enabled;
      patchConstraints(node, { toggle: { id: it.id, enabled: now } },
        now ? `启用约束 ${KIND_LABELS[it.kind]}` : `停用约束 ${KIND_LABELS[it.kind]}`,
        now ? '约束已启用并重新求解' : '约束已停用并重新求解（身份保留）');
    }));
    els.constraintsList.querySelectorAll('.c-del').forEach(b => b.addEventListener('click', () => {
      patchConstraints(node, { removeIds: [b.dataset.id] }, '删除约束', '约束已删除并重新求解');
    }));
    els.constraintsList.querySelectorAll('.c-edit').forEach(b => b.addEventListener('click', () => {
      const it = cs.items.find(x => x.id === b.dataset.id);
      openValueDialog(node, it);
    }));
  }
  // 冲突盒
  if (diag && !diag.feasible && diag.coreIds.length) {
    const coreSet = new Set(diag.coreIds);
    els.conflictBox.classList.remove('hidden');
    els.conflictBox.innerHTML =
      `<div class="ct">✗ 当前约束组合无解（${diag.coreIds.length} 条构成冲突核${readOnly ? '，进入编辑可停用' : ''}）：</div>` +
      cs.items.filter(i => coreSet.has(i.id)).map(i => `
        <div class="core-item">
          ${readOnly ? '' : `<button data-id="${i.id}" class="c-quick-off">停用</button>`}
          <span><b>${esc(KIND_LABELS[i.kind])}</b> <small class="muted">${esc(describeRefs(i))}</small></span>
        </div>`).join('');
    if (!readOnly) els.conflictBox.querySelectorAll('.c-quick-off').forEach(b => b.addEventListener('click', () => {
      patchConstraints(node, { toggle: { id: b.dataset.id, enabled: false } },
        '停用冲突约束', '已停用造成冲突的约束并重新求解');
    }));
  } else {
    els.conflictBox.classList.add('hidden');
  }
  // 预览条
  const s = state.dragSession;
  if (s && s.preview) {
    const sol = s.preview.sol;
    els.previewBar.classList.remove('hidden');
    els.previewBar.classList.toggle('infeasible', !sol.feasible);
    els.previewText.innerHTML = sol.feasible
      ? `拖动预览：约束 <b style="color:var(--ok)">已满足</b>（最大残差 ${sol.maxResidual.toExponential(1)}）——确认后作为一次操作写入`
      : `拖动预览：<b style="color:var(--bad)">约束冲突</b>（最大残差 ${sol.maxResidual.toFixed(2)}），不能确认，可取消或停用冲突约束`;
    els.pvConfirm.disabled = !sol.feasible;
  } else {
    els.previewBar.classList.add('hidden');
  }
}

// ---------- 数值编辑（固定长度 / 固定角度） ----------

function openValueDialog(node, it) {
  const isLen = it.kind === 'fixed-length';
  const cur = isLen ? it.value : radToDeg(it.value);
  els.dialogTitle.textContent = isLen ? '编辑固定长度' : '编辑固定角度';
  els.dialogBody.innerHTML = `
    <div class="dialog-field">${isLen ? '长度' : '角度（度，0–180）'}
      <input id="dlg-value" type="number" step="any" value="${f4(cur)}">
    </div>
    <div class="muted">无向边方向：角度按模 180° 解释（0° 水平 / 90° 竖直）。</div>`;
  els.dialogActions.innerHTML = '';
  const bCancel = document.createElement('button'); bCancel.textContent = '取消';
  const bOk = document.createElement('button'); bOk.textContent = '试解并写入'; bOk.className = 'ok';
  els.dialogActions.append(bCancel, bOk);
  openDialog();
  bCancel.onclick = () => closeDialog();
  bOk.onclick = () => {
    const raw = Number(document.getElementById('dlg-value').value);
    if (!Number.isFinite(raw)) { showToast('请输入数字', 'error'); return; }
    const value = isLen ? raw : degToRad(raw);
    closeDialog();
    patchConstraints(node, { update: [{ id: it.id, value }] },
      isLen ? `编辑固定长度 = ${f2(value)}` : `编辑固定角度 = ${f2(radToDeg(value))}°`,
      '数值已更新并重新求解');
  };
}
const f4 = v => Math.round(v * 1e6) / 1e6;

// ---------- 删除 / 合并顶点（预告 → 取消不变 / 确认原子更新） ----------

function requestDeleteVertex() {
  const node = editNode();
  if (!node || state.picks.vertices.length !== 1) return;
  const key = state.picks.vertices[0];
  const plan = planVertexRemoval(node, key, state.eps);
  if (!plan.ok) { showToast(plan.reason, 'error'); return; }
  showStructuralPlanDialog(node, plan, '删除顶点', key, null);
}

function requestMergeVertices() {
  const node = editNode();
  if (!node || state.picks.vertices.length !== 2) return;
  // 把第一个拾取点合并到第二个（后者保留位置与身份）
  const [src, dst] = state.picks.vertices;
  const plan = planVertexMerge(node, src, dst, state.eps);
  if (!plan.ok) { showToast(plan.reason, 'error'); return; }
  showStructuralPlanDialog(node, plan, '合并顶点', src, dst);
}

function showStructuralPlanDialog(node, plan, title, removedKey, dstKey) {
  const group = (cls, h, list) => list.length ? `
    <div class="plan-section ${cls}"><h4>${h}（${list.length}）</h4>
      ${list.map(r => `<div class="row">${esc(KIND_LABELS[r.item.kind] || r.from.kind)}
        <span class="cid">${esc(r.from.id)}</span>
        ${r.reason ? `<small>— ${esc(r.reason)}</small>` : ''}</div>`).join('')}
    </div>` : '';
  els.dialogTitle.textContent = title + '：约束影响预告';
  els.dialogBody.innerHTML = `
    <div>顶点 <b>${esc(removedKey)}</b>${dstKey ? ` 合并到 <b>${esc(dstKey)}</b>` : ''} 将被${dstKey ? '合并' : '删除'}。
      ${plan.feasible ? '其余顶点会按约束重新求解。' : '<b style="color:var(--bad)">操作后约束仍冲突，需先停用冲突项。</b>'}</div>
    ${group('remove', '将失效（删除）', plan.removed)}
    ${group('rewrite', '将被改写（身份保留）', plan.rewritten)}
    ${group('keep', '仍可保留', plan.kept)}
    <div class="muted">取消则什么都不改变；确认后几何、约束身份、启停与引用一次性原子更新。</div>`;
  els.dialogActions.innerHTML = '';
  const bCancel = document.createElement('button'); bCancel.textContent = '取消（不改变状态）';
  const bOk = document.createElement('button'); bOk.textContent = '确认并原子更新'; bOk.className = 'ok';
  bOk.disabled = !plan.feasible;
  els.dialogActions.append(bCancel, bOk);
  openDialog();
  bCancel.onclick = () => { closeDialog(); showToast('已取消，状态未改变', 'info'); };
  bOk.onclick = () => {
    closeDialog();
    commitConstraintChange(node, plan.nextGeom, plan.nextCs,
      title, `失效 ${plan.removed.length} · 改写 ${plan.rewritten.length} · 保留 ${plan.kept.length} 条约束`);
    state.picks = { vertices: [], edges: [] };
    syncConstraintUI();
  };
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
  // 撤销/重做/跳转：取消任何未落盘预览，恢复约束面板与冲突诊断
  state.dragSession = null;
  state.picks = { vertices: [], edges: [] };
  invalidateDiag();
  if (state.mode === 'verts' && !getNode(state.doc, state.editShapeId)) exitVertMode();
  else if (state.mode === 'verts') {
    const n = getNode(state.doc, state.editShapeId);
    if (n) ensureConstraints(n);
    invalidateDiag();
    syncConstraintUI();
  }
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
  const tryKeys = [STORAGE_KEY, 'polybool.graph.v2']; // v3 优先；兼容旧版 v2 历史
  for (const key of tryKeys) {
    try { raw = localStorage.getItem(key); } catch { /* ignore */ }
    if (raw) break;
  }
  if (!raw) return false;
  try {
    const { history, eps, mismatches } = deserializeHistory(raw);
    state.history = history;
    if (typeof eps === 'number') { state.eps = eps; els.eps.value = String(eps); }
    state.reloadCheck = mismatches.length === 0
      ? { ok: true, text: `重载校验：一致 ✓（${history.entries.length} 条历史，依赖边/冻结/几何/约束身份与诊断/重算日志全部匹配）` }
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
  let cActive = 0, cOff = 0, cConflict = 0;
  for (const n of state.doc.nodes) {
    if (!n.constraints) continue;
    const diag = evaluate(n);
    cActive += n.constraints.items.filter(i => i.enabled).length;
    cOff += n.constraints.items.filter(i => !i.enabled).length;
    if (!diag.feasible) cConflict++;
  }
  const cpart = cActive || cOff ? `｜约束 ${cActive} 活动${cOff ? ` · ${cOff} 停用` : ''}${cConflict ? ` · ${cConflict} 图形冲突 ✗` : ' · 全部满足 ✓'}` : '';
  return `${bad ? `✗ ${bad} 个无效` : '✓ 几何全部有效'}｜${state.doc.nodes.length} 图形 · ${derived} 派生 · ${frozen} 冻结 · ${edges} 条活动依赖边${cpart}`;
}

function renderPanels() {
  // 图形列表
  els.shapesList.innerHTML = state.doc.nodes.map(n => {
    const sel = state.selected.includes(n.id) ? 'sel' : '';
    const tags = [];
    if (isDerived(n)) tags.push('<span class="tag derived">派生</span>');
    if (isFrozen(n)) tags.push('<span class="tag frozen">❄ 冻结</span>');
    if (hasConstraints(n)) tags.push('<span class="tag ctag">⌖ 约束</span>');
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
  renderConstraintsPanel();
  syncConstraintUI();

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
  // 顶点/约束编辑入口：单个可编辑（非派生）图形
  const sn = selectedNode();
  els.btnVerts.disabled = !(sn && !isDerived(sn));
  els.btnVerts.classList.toggle('active', state.mode === 'verts');
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
  syncModeUI(); syncConstraintUI(); render();
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
els.btnVerts.addEventListener('click', () => {
  const n = selectedNode();
  if (!n) return;
  if (isDerived(n)) { showToast('派生图形的顶点由来源决定，不能直接编辑（可先冻结）', 'info'); return; }
  enterVertMode(n.id);
});
// 几何约束按钮
for (const kind of Object.keys(els.cBtns)) {
  els.cBtns[kind].addEventListener('click', () => addConstraintFromPicks(kind));
}
els.btnDelVertex.addEventListener('click', requestDeleteVertex);
els.btnMergeVerts.addEventListener('click', requestMergeVertices);
els.pvConfirm.addEventListener('click', confirmDragPreview);
els.pvCancel.addEventListener('click', () => cancelDragPreview(true));
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
    if (state.dragSession) { cancelDragPreview(true); return; }
    if (!els.dialog.classList.contains('hidden')) { closeDialog(); return; }
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
  syncConstraintUI();
  renderPanels();
  render();
}

new ResizeObserver(resizeCanvas).observe(canvas);
init();
