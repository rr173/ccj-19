// app.js — UI 编排：画布渲染、形状编辑（绘制/拖动/缩放/旋转/顶点编辑）、
// 布尔操作、历史面板、拓扑判定日志、校验摘要、持久化与重载一致性校验。

import pc from 'polygon-clipping';
import {
  translateGeom, rotateGeom, scaleGeom, geomBBox, geomCentroid, dist,
} from './geometry.js';
import { makeShape, normalizeGeom, geomHash } from './model.js';
import { validateGeom, summarizeValidation, pointInGeom } from './validate.js';
import { applyBoolean, OPS } from './ops.js';
import {
  createHistory, pushEntry, undo, redo, jumpTo, canUndo, canRedo,
  serializeHistory, deserializeHistory,
} from './history.js';

const STORAGE_KEY = 'polybool.history.v1';
const PALETTE = ['#4f8ef7', '#f76f6f', '#3fbf7f', '#f7a83f', '#a06ef7', '#f75fb0', '#3fc4c4', '#b8b83f'];
const f2 = v => Math.round(v * 100) / 100;

// ---------- 状态 ----------

const state = {
  shapes: [],
  selected: [],          // 有序：先选为 A，后选为 B
  mode: 'select',        // 'select' | 'draw' | 'verts'
  drawPts: [],
  editShapeId: null,
  eps: 0.5,
  view: { scale: 1, ox: 0, oy: 0 },
  history: createHistory(),
  lastReport: null,      // 最近一次布尔判定报告
  inspectEntry: null,    // 历史面板中点击查看的条目
  resultSeq: 0,
  shapeSeq: 0,
  persistOk: true,
  reloadCheck: null,     // 重载一致性校验结果
};

// ---------- DOM ----------

const $ = id => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const els = {
  modeSelect: $('mode-select'), modeDraw: $('mode-draw'),
  opUnion: $('op-union'), opDiff: $('op-diff'), opInter: $('op-inter'),
  operands: $('operands'),
  undo: $('btn-undo'), redo: $('btn-redo'), del: $('btn-delete'), fit: $('btn-fit'), reset: $('btn-reset'),
  eps: $('eps-input'),
  badge: $('reload-badge'),
  toast: $('toast'),
  validation: $('validation-panel'),
  decisions: $('decisions-panel'),
  historyList: $('history-list'),
  hint: $('hint'),
};

// ---------- 视图变换 ----------

const toScreen = p => [p[0] * state.view.scale + state.view.ox, p[1] * state.view.scale + state.view.oy];
const toWorld = p => [(p[0] - state.view.ox) / state.view.scale, (p[1] - state.view.oy) / state.view.scale];

function fitView() {
  const bb = geomBBox(state.shapes.flatMap(s => s.geom));
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

  for (const shape of state.shapes) {
    const path = geomPath(shape.geom);
    const selIdx = state.selected.indexOf(shape.id);
    ctx.fillStyle = shape.color + (selIdx >= 0 ? '55' : '30');
    ctx.fill(path, 'evenodd'); // 洞以 evenodd 规则镂空
    ctx.lineWidth = selIdx >= 0 ? 2.5 : 1.5;
    ctx.strokeStyle = selIdx >= 0 ? '#ffd166' : shape.color;
    ctx.stroke(path);
    // 选中标记 A/B
    if (selIdx >= 0) {
      const c = toScreen(geomCentroid(shape.geom));
      ctx.fillStyle = '#ffd166';
      ctx.font = 'bold 13px system-ui';
      ctx.fillText(selIdx === 0 ? 'A' : 'B', c[0] - 4, c[1] + 4);
    }
    // 名称
    const bb = geomBBox(shape.geom);
    if (bb) {
      const [tx, ty] = toScreen([bb.minX, bb.minY]);
      ctx.fillStyle = '#8b93a7';
      ctx.font = '11px system-ui';
      ctx.fillText(shape.name, tx, ty - 6);
    }
  }

  if (state.mode === 'select' && state.selected.length === 1) drawHandles();
  if (state.mode === 'draw') drawDraft();
  if (state.mode === 'verts') drawVertices();
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

function selectedShape() {
  return state.shapes.find(s => s.id === state.selected[0]) || null;
}

function handleLayout() {
  const shape = selectedShape();
  if (!shape) return null;
  const bb = geomBBox(shape.geom);
  if (!bb) return null;
  const [x1, y1] = toScreen([bb.minX, bb.minY]);
  const [x2, y2] = toScreen([bb.maxX, bb.maxY]);
  return {
    corners: [[x1, y1], [x2, y1], [x2, y2], [x1, y2]],
    rotate: [(x1 + x2) / 2, y1 - 28],
    box: { x1, y1, x2, y2 },
  };
}

function drawHandles() {
  const L = handleLayout();
  if (!L) return;
  ctx.strokeStyle = '#ffd166';
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(L.box.x1, L.box.y1, L.box.x2 - L.box.x1, L.box.y2 - L.box.y1);
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo((L.box.x1 + L.box.x2) / 2, L.box.y1);
  ctx.lineTo(L.rotate[0], L.rotate[1]);
  ctx.stroke();
  ctx.fillStyle = '#ffd166';
  for (const [x, y] of L.corners) { ctx.beginPath(); ctx.rect(x - 5, y - 5, 10, 10); ctx.fill(); }
  ctx.beginPath(); ctx.arc(L.rotate[0], L.rotate[1], 6, 0, Math.PI * 2); ctx.fill();
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
  const shape = state.shapes.find(s => s.id === state.editShapeId);
  if (!shape) return;
  ctx.fillStyle = '#fff';
  for (const poly of shape.geom) {
    for (const ring of poly) {
      // 边中点（插入点）
      for (let i = 0; i < ring.length; i++) {
        const a = toScreen(ring[i]), b = toScreen(ring[(i + 1) % ring.length]);
        ctx.fillStyle = '#8b93a7';
        ctx.beginPath(); ctx.arc((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 3.5, 0, Math.PI * 2); ctx.fill();
      }
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

function shapeAt(worldP) {
  for (let i = state.shapes.length - 1; i >= 0; i--) {
    if (pointInGeom(state.shapes[i].geom, worldP, state.eps / state.view.scale) === 'in') return state.shapes[i];
  }
  return null;
}

function hitHandle(sp) {
  const L = handleLayout();
  if (!L) return null;
  for (let i = 0; i < 4; i++) {
    if (Math.abs(sp[0] - L.corners[i][0]) <= 7 && Math.abs(sp[1] - L.corners[i][1]) <= 7) return { type: 'scale', corner: i };
  }
  if (Math.hypot(sp[0] - L.rotate[0], sp[1] - L.rotate[1]) <= 8) return { type: 'rotate' };
  return null;
}

function vertexAt(sp) {
  const shape = state.shapes.find(s => s.id === state.editShapeId);
  if (!shape) return null;
  const r = 7 / state.view.scale;
  const wp = toWorld(sp);
  for (let pi = 0; pi < shape.geom.length; pi++) {
    for (let ri = 0; ri < shape.geom[pi].length; ri++) {
      const ring = shape.geom[pi][ri];
      for (let vi = 0; vi < ring.length; vi++) {
        if (dist(ring[vi], wp) <= r) return { pi, ri, vi, kind: 'vertex' };
      }
    }
  }
  // 边中点 → 插入
  for (let pi = 0; pi < shape.geom.length; pi++) {
    for (let ri = 0; ri < shape.geom[pi].length; ri++) {
      const ring = shape.geom[pi][ri];
      for (let vi = 0; vi < ring.length; vi++) {
        const a = ring[vi], b = ring[(vi + 1) % ring.length];
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (dist(mid, wp) <= r) return { pi, ri, vi, kind: 'midpoint' };
      }
    }
  }
  return null;
}

// ---------- 交互 ----------

const hover = { world: null };
let drag = null; // {type, ...}

function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

canvas.addEventListener('mousedown', e => {
  if (e.button === 2) return; // 右键在 contextmenu 处理
  const sp = canvasPos(e);
  const wp = toWorld(sp);

  if (state.mode === 'draw') {
    addDrawPoint(wp);
    return;
  }
  if (state.mode === 'verts') {
    const hit = vertexAt(sp);
    if (hit && hit.kind === 'vertex') {
      drag = { type: 'vertex', hit, base: snapshotGeoms() };
    } else if (hit && hit.kind === 'midpoint') {
      insertVertex(hit, wp);
    } else {
      drag = { type: 'pan', start: sp, view0: { ...state.view } };
    }
    return;
  }
  // select 模式
  const hh = state.selected.length === 1 ? hitHandle(sp) : null;
  if (hh) {
    const shape = selectedShape();
    const c = geomCentroid(shape.geom);
    if (hh.type === 'rotate') {
      const a0 = Math.atan2(wp[1] - c[1], wp[0] - c[0]);
      drag = { type: 'rotate', shape, pivot: c, a0, base: shape.geom };
    } else {
      const d0 = Math.max(1e-6, dist(wp, c));
      drag = { type: 'scale', shape, pivot: c, d0, base: shape.geom };
    }
    return;
  }
  const shape = shapeAt(wp);
  if (shape) {
    if (!state.selected.includes(shape.id)) selectShape(shape.id);
    drag = { type: 'move', start: wp, bases: state.selected.map(id => ({ id, geom: findShape(id).geom })) };
  } else {
    drag = { type: 'pan', start: sp, view0: { ...state.view } };
    if (!e.shiftKey) { state.selected = []; syncOperandUI(); render(); }
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
      findShape(b.id).geom = translateGeom(b.geom, dx, dy);
    }
  } else if (drag.type === 'rotate') {
    const a = Math.atan2(wp[1] - drag.pivot[1], wp[0] - drag.pivot[0]) - drag.a0;
    drag.shape.geom = rotateGeom(drag.base, a, drag.pivot);
    drag.angle = a;
  } else if (drag.type === 'scale') {
    const k = Math.max(0.01, dist(wp, drag.pivot) / drag.d0);
    drag.shape.geom = scaleGeom(drag.base, k, drag.pivot);
    drag.k = k;
  } else if (drag.type === 'vertex') {
    const shape = state.shapes.find(s => s.id === state.editShapeId);
    shape.geom[drag.hit.pi][drag.hit.ri][drag.hit.vi] = wp;
  }
  render();
});

canvas.addEventListener('mouseup', () => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.type === 'move') {
    const dx = d.bases.length ? f2(findShape(d.bases[0].id).geom[0][0][0][0] - d.bases[0].geom[0][0][0][0]) : 0;
    const dy = d.bases.length ? f2(findShape(d.bases[0].id).geom[0][0][0][1] - d.bases[0].geom[0][0][0][1]) : 0;
    if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) {
      commitTransform(`移动 ${d.bases.map(b => findShape(b.id).name).join('、')} Δ(${dx}, ${dy})`);
    }
  } else if (d.type === 'rotate') {
    if (d.angle) commitTransform(`旋转 ${d.shape.name} ${f2(d.angle * 180 / Math.PI)}°（绕质心，外轮廓与洞同步）`);
  } else if (d.type === 'scale') {
    if (d.k && Math.abs(d.k - 1) > 1e-9) commitTransform(`缩放 ${d.shape.name} ×${f2(d.k)}（绕质心，外轮廓与洞同步）`);
  } else if (d.type === 'vertex') {
    commitVertexEdit();
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
  const shape = shapeAt(wp);
  if (shape) enterVertMode(shape.id);
});

canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (state.mode !== 'verts') return;
  const hit = vertexAt(canvasPos(e));
  if (hit && hit.kind === 'vertex') deleteVertex(hit);
});

// ---------- 变换提交（含校验，写入历史） ----------

function commitTransform(label) {
  // 仿射变换保持外轮廓/洞关系；仍做整体校验以生成可检查的摘要
  const problems = [];
  for (const s of state.shapes) {
    const v = validateGeom(s.geom, state.eps);
    if (!v.ok) problems.push(`${s.name}: ${v.errors[0]}`);
  }
  if (problems.length) {
    showToast(`变换后拓扑无效，已回滚：${problems[0]}`, 'error');
    restoreFromHistory(); // 回滚到当前历史条目快照
    return;
  }
  commitHistory(label, '所有外轮廓与洞随形状整体变换，包含关系保持不变');
}

function commitVertexEdit() {
  const shape = state.shapes.find(s => s.id === state.editShapeId);
  const v = validateGeom(shape.geom, state.eps);
  if (!v.ok) {
    showToast(`顶点编辑产生无效拓扑（${v.errors[0]}），已回滚该次修改`, 'error');
    restoreFromHistory();
    return;
  }
  commitHistory(`编辑顶点：${shape.name}`, summarizeValidation(v));
}

function insertVertex(hit, wp) {
  const shape = state.shapes.find(s => s.id === state.editShapeId);
  shape.geom[hit.pi][hit.ri].splice(hit.vi + 1, 0, [wp[0], wp[1]]);
  commitVertexEdit();
}

function deleteVertex(hit) {
  const shape = state.shapes.find(s => s.id === state.editShapeId);
  const ring = shape.geom[hit.pi][hit.ri];
  if (ring.length <= 3) {
    showToast('环至少需要 3 个顶点，无法删除', 'error');
    return;
  }
  ring.splice(hit.vi, 1);
  commitVertexEdit();
}

// ---------- 绘制 ----------

function addDrawPoint(wp) {
  const pts = state.drawPts;
  // 吸附：距已有形状顶点 < ε 时吸附（显式判定，写入日志）
  let snapped = null;
  for (const s of state.shapes) {
    for (const poly of s.geom) for (const ring of poly) for (const p of ring) {
      if (dist(p, wp) < state.eps) { snapped = p; break; }
    }
  }
  // 闭合：距首点 < 10 屏幕像素
  if (pts.length >= 3) {
    const first = toScreen(pts[0]);
    const cur = toScreen(wp);
    if (Math.hypot(first[0] - cur[0], first[1] - cur[1]) <= 10) { closeDraw(); return; }
  }
  pts.push(snapped ? [snapped[0], snapped[1]] : wp);
  if (snapped) showToast(`顶点吸附：捕捉到已有顶点 (${f2(snapped[0])}, ${f2(snapped[1])})（距离 < ε）`, 'info');
  render();
}

function closeDraw() {
  const pts = state.drawPts;
  if (pts.length < 3) { showToast('至少需要 3 个顶点', 'error'); return; }
  const decisions = [];
  const geom = normalizeGeom([pts], state.eps, decisions);
  if (!geom.length) {
    showToast('绘制失败：多边形退化（面积 ≤ ε² 或顶点不足），未创建', 'error');
    cancelDraw();
    return;
  }
  const v = validateGeom(geom, state.eps);
  if (!v.ok) {
    showToast(`绘制失败：${v.errors[0]}。未创建形状`, 'error');
    cancelDraw();
    return;
  }
  const shape = makeShape(`形状${++state.shapeSeq}`, geom, PALETTE[state.shapes.length % PALETTE.length]);
  state.shapes.push(shape);
  state.selected = [shape.id];
  const extra = decisions.length ? `；${decisions.join('；')}` : '';
  commitHistory(`绘制 ${shape.name}`, `${summarizeValidation(v)}${extra}`);
  cancelDraw();
  setMode('select');
  syncOperandUI();
}

function cancelDraw() {
  state.drawPts = [];
  render();
}

// ---------- 顶点编辑模式 ----------

function enterVertMode(id) {
  state.mode = 'verts';
  state.editShapeId = id;
  state.selected = [id];
  els.hint.textContent = '顶点编辑：拖动顶点 / 点边中点插入 / 右键删除顶点；双击空白或 Esc 退出';
  syncModeUI();
  syncOperandUI();
  render();
}

function exitVertMode() {
  state.mode = 'select';
  state.editShapeId = null;
  els.hint.textContent = '';
  syncModeUI();
  render();
}

// ---------- 布尔操作 ----------

function doBoolean(op) {
  if (state.selected.length !== 2) return;
  const A = findShape(state.selected[0]);
  const B = findShape(state.selected[1]);
  const res = applyBoolean(pc, op, A.geom, B.geom, state.eps);
  state.lastReport = res.report;
  if (!res.ok) {
    showToast(res.reason, 'error'); // 无效操作：保留原图，仅说明原因
    renderPanels();
    return;
  }
  const resultShape = makeShape(
    `R${++state.resultSeq}`,
    res.geom,
    PALETTE[(state.shapes.length + 2) % PALETTE.length],
  );
  state.shapes = state.shapes.filter(s => s.id !== A.id && s.id !== B.id);
  state.shapes.push(resultShape);
  state.selected = [resultShape.id];
  const v = res.report.validation;
  commitHistory(
    `${OPS[op].label} ${A.name} ${OPS[op].symbol.replace('A', '').replace('B', '').trim()} ${B.name} → ${resultShape.name}`,
    summarizeValidation(v),
    res.report,
  );
  showToast(`${OPS[op].label}完成：${v.stats.outers} 个外轮廓、${v.stats.holes} 个洞`, 'ok');
  syncOperandUI();
}

// ---------- 历史 ----------

function snapshotScene() {
  return { shapes: state.shapes, selected: state.selected };
}

function snapshotGeoms() {
  return state.shapes.map(s => ({ id: s.id, geom: s.geom }));
}

function commitHistory(label, detail, report) {
  const validation = summarizeSceneValidation();
  pushEntry(state.history, snapshotScene(), { label, detail: detail || validation, validation, report: report || null });
  state.inspectEntry = null;
  persist();
  renderPanels();
  render();
}

function restoreSnapshot(snap) {
  state.shapes = snap.shapes.map(s => ({ ...s, geom: s.geom.map(p => p.map(r => r.map(pt => [pt[0], pt[1]]))) }));
  state.selected = (snap.selected || []).filter(id => state.shapes.some(s => s.id === id));
  // 判定日志与当前历史位置保持同步
  state.lastReport = state.history.entries[state.history.index]?.report || null;
  if (state.mode === 'verts' && !state.shapes.some(s => s.id === state.editShapeId)) exitVertMode();
  syncOperandUI();
  renderPanels();
  render();
}

function restoreFromHistory() {
  const e = state.history.entries[state.history.index];
  if (e) restoreSnapshot(e.snapshot);
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
  } catch (err) {
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
      ? { ok: true, text: `重载校验：一致 ✓（${history.entries.length} 条历史，哈希全部匹配）` }
      : { ok: false, text: `重载校验：${mismatches.length} 条历史哈希不一致 ✗` };
    const snap = history.entries[history.index]?.snapshot;
    if (snap) restoreSnapshot(snap);
    // 恢复结果编号，避免新结果与历史中的 R 名称冲突
    state.resultSeq = state.shapes.reduce((m, s) => {
      const mm = /^R(\d+)$/.exec(s.name);
      return mm ? Math.max(m, Number(mm[1])) : m;
    }, 0);
    state.shapeSeq = state.shapes.reduce((m, s) => {
      const mm = /^形状(\d+)$/.exec(s.name);
      return mm ? Math.max(m, Number(mm[1])) : m;
    }, 0);
    return true;
  } catch (err) {
    state.reloadCheck = { ok: false, text: `重载校验：历史数据损坏（${err.message}），已新建场景` };
    return false;
  }
}

// ---------- 面板渲染 ----------

function sceneValidation() {
  return state.shapes.map(s => ({ shape: s, v: validateGeom(s.geom, state.eps) }));
}

function summarizeSceneValidation() {
  const vs = sceneValidation();
  const bad = vs.filter(x => !x.v.ok);
  const totals = vs.reduce((acc, x) => ({
    outers: acc.outers + x.v.stats.outers,
    holes: acc.holes + x.v.stats.holes,
    vertices: acc.vertices + x.v.stats.vertices,
  }), { outers: 0, holes: 0, vertices: 0 });
  const status = bad.length ? `✗ ${bad.length} 个形状无效` : '✓ 全部有效';
  return `${status}｜${state.shapes.length} 个形状，共 ${totals.outers} 外轮廓 / ${totals.holes} 洞 / ${totals.vertices} 顶点`;
}

function renderPanels() {
  // 校验摘要
  const vs = sceneValidation();
  els.validation.innerHTML = vs.length
    ? vs.map(({ shape, v }) => `
      <div class="val-item ${v.ok ? (v.warnings.length ? 'warn' : 'ok') : 'bad'}">
        <b>${esc(shape.name)}</b> <span class="hash">#${geomHash(shape.geom)}</span><br>
        ${esc(summarizeValidation(v))}
        ${v.errors.map(e2 => `<div class="err">✗ ${esc(e2)}</div>`).join('')}
        ${v.warnings.map(w2 => `<div class="wrn">⚠ ${esc(w2)}</div>`).join('')}
      </div>`).join('')
    : '<div class="muted">场景为空</div>';

  // 拓扑判定日志：优先显示检查中的历史条目，其次最近一次操作
  const entry = state.inspectEntry;
  const report = entry ? entry.report : state.lastReport;
  let html = '';
  if (entry) {
    html += `<div class="val-item"><b>历史 #${entry.seq}：${esc(entry.label)}</b><br>${esc(entry.detail || '')}</div>`;
  }
  if (report) {
    html += `<div class="val-item">
      <b>${esc(report.symbol)}（${esc(report.opLabel)}）</b>　ε = ${report.eps}<br>
      输入：A ${report.input.a.outers} 外轮廓/${report.input.a.holes} 洞，
      B ${report.input.b.outers} 外轮廓/${report.input.b.holes} 洞
      ${report.output ? `<br>输出：${report.output.outers} 外轮廓 / ${report.output.holes} 洞 / ${report.output.vertices} 顶点` : ''}
    </div>`;
    html += report.decisions.map(d => `<div class="decision">▸ ${esc(d)}</div>`).join('');
  }
  els.decisions.innerHTML = html || '<div class="muted">尚无判定记录。执行布尔操作后，这里会列出采用的每条拓扑规则。</div>';

  // 历史列表
  const h = state.history;
  els.historyList.innerHTML = h.entries.map((e, i) => `
    <div class="hist-item ${i === h.index ? 'current' : ''} ${i > h.index ? 'undone' : ''}" data-i="${i}">
      <span class="seq">#${e.seq}</span> ${esc(e.label)}
      <span class="hash">#${e.hash.slice(0, 8)}</span><br>
      <small>${esc(e.validation || '')}</small>
    </div>`).reverse().join('') || '<div class="muted">无历史</div>';
  els.historyList.querySelectorAll('.hist-item').forEach(el => {
    el.addEventListener('click', () => doJump(Number(el.dataset.i)));
  });

  els.undo.disabled = !canUndo(h);
  els.redo.disabled = !canRedo(h);

  // 重载校验徽标
  if (state.reloadCheck) {
    els.badge.textContent = state.reloadCheck.text;
    els.badge.className = state.reloadCheck.ok ? 'badge ok' : 'badge bad';
  }
}

function syncOperandUI() {
  const names = state.selected.map(id => findShape(id)?.name).filter(Boolean);
  els.operands.textContent = names.length === 2
    ? `A = ${names[0]}（先选）　B = ${names[1]}（后选）`
    : names.length === 1
      ? `A = ${names[0]}（再选一个形状作为 B）`
      : '未选择形状（点击形状选择，先选为 A）';
  const ready = state.selected.length === 2;
  els.opUnion.disabled = els.opDiff.disabled = els.opInter.disabled = !ready;
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
  syncModeUI();
  render();
}

// ---------- 工具 ----------

function findShape(id) { return state.shapes.find(s => s.id === id); }

function selectShape(id) {
  // 有序选择：第三次点击重新开始
  if (state.selected.length >= 2) state.selected = [id];
  else if (!state.selected.includes(id)) state.selected.push(id);
  syncOperandUI();
  render();
}

let toastTimer = null;
function showToast(msg, kind) {
  els.toast.textContent = msg;
  els.toast.className = `toast show ${kind || 'info'}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.className = 'toast'; }, 6000);
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- 事件绑定 ----------

els.modeSelect.addEventListener('click', () => setMode('select'));
els.modeDraw.addEventListener('click', () => setMode('draw'));
els.opUnion.addEventListener('click', () => doBoolean('union'));
els.opDiff.addEventListener('click', () => doBoolean('difference'));
els.opInter.addEventListener('click', () => doBoolean('intersection'));
els.undo.addEventListener('click', doUndo);
els.redo.addEventListener('click', doRedo);
els.fit.addEventListener('click', () => { fitView(); render(); });
els.del.addEventListener('click', deleteSelected);
els.reset.addEventListener('click', () => {
  if (!confirm('清空场景与全部历史？')) return;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  state.history = createHistory();
  state.shapes = [];
  state.selected = [];
  state.lastReport = null;
  state.resultSeq = 0;
  state.shapeSeq = 0;
  seedScene();
});
els.eps.addEventListener('change', () => {
  const v = Number(els.eps.value);
  if (Number.isFinite(v) && v > 0 && v <= 100) {
    state.eps = v;
    showToast(`容差 ε 已设为 ${v}（影响后续顶点吸附与接触判定）`, 'info');
    persist();
    renderPanels();
  } else {
    els.eps.value = String(state.eps);
  }
});

function deleteSelected() {
  if (!state.selected.length) return;
  const names = state.selected.map(id => findShape(id)?.name).filter(Boolean);
  state.shapes = state.shapes.filter(s => !state.selected.includes(s.id));
  state.selected = [];
  if (state.editShapeId && !findShape(state.editShapeId)) exitVertMode();
  commitHistory(`删除 ${names.join('、')}`, '');
  syncOperandUI();
}

window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? doRedo() : doUndo();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    doRedo();
  } else if (e.key === 'Escape') {
    if (state.mode === 'draw') { cancelDraw(); setMode('select'); }
    else if (state.mode === 'verts') exitVertMode();
  } else if (e.key === 'Enter' && state.mode === 'draw') {
    closeDraw();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    deleteSelected();
  }
});

// ---------- 初始化 ----------

function seedScene() {
  const decisions = [];
  const g1 = normalizeGeom([[[60, 60], [300, 60], [300, 260], [60, 260]]], state.eps, decisions);
  const g2 = normalizeGeom([[[200, 160], [420, 160], [420, 340], [200, 340]]], state.eps, decisions);
  state.shapes = [
    makeShape(`形状${++state.shapeSeq}`, g1, PALETTE[0]),
    makeShape(`形状${++state.shapeSeq}`, g2, PALETTE[1]),
  ];
  state.selected = [];
  commitHistory('初始场景', '两个重叠矩形，可选择后执行布尔操作');
  fitView();
}

function init() {
  els.eps.value = String(state.eps);
  const restored = loadPersisted();
  if (!restored) {
    if (!state.reloadCheck) {
      state.reloadCheck = { ok: true, text: '无已存历史：已创建初始场景' };
    }
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
