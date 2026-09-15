// constraints.js — 多边形几何约束模型与数值求解器（纯逻辑，无 DOM 依赖）。
//
// 约束系统挂在单个可编辑图形（root / 已冻结节点）上：
//   node.constraints = {
//     vkeys: [[['v1','v2',…], …]],   // 与 geom 的 poly/ring/vertex 平行的稳定顶点身份
//     seq: 3,                        // v 身份计数器（删除顶点后该身份永久失效，不复用）
//     cseq: 2,                       // 约束 id 计数器
//     items: [ 约束… ],
//   }
//
// 约束种类（items）：
//   {id, kind:'coincident',     vertices:[a,b]}            两顶点重合
//   {id, kind:'horizontal',     edge:{a,b}}                边水平
//   {id, kind:'vertical',       edge:{a,b}}                边竖直
//   {id, kind:'equal-length',   edges:[e1,e2]}             两边等长
//   {id, kind:'fixed-length',   edge:{a,b}, value:L}       固定长度
//   {id, kind:'parallel',       edges:[e1,e2]}             两边平行
//   {id, kind:'perpendicular',  edges:[e1,e2]}             两边正交
//   {id, kind:'fixed-angle',    edge:{a,b}, value:θ}       固定方向（弧度，按无向边模 π 解释）
//   {id, kind:'lock-point',     vertex:a, at:[x,y]}        锁定顶点（绝对位置）
//   {id, kind:'lock-edge',      edge:{a,b}, at:[[x,y],[x,y]]} 锁定整条边（两端点均固定）
//
// 求解：对自由顶点做 Levenberg–Marquardt（高斯-牛顿 + 阻尼）最小二乘；
// 锁定顶点 / 拖动锚点作为硬锚（变量直接消去），同一顶点可参与任意多组约束。
// 确定性：残差行按“约束内容的规范化键 + id”排序后累加 JᵀJ，浮点求和顺序只取决于
// 约束集合本身——同一组约束以不同创建顺序求解，收敛坐标（1e-6 量化）与结果哈希一致。

import { validateGeom } from './validate.js';
import { geomBBox } from './geometry.js';

// ---------- 常量 / 标签 ----------

export const KIND_LABELS = {
  coincident: '重合',
  horizontal: '水平',
  vertical: '竖直',
  'equal-length': '等长',
  'fixed-length': '固定长度',
  parallel: '平行',
  perpendicular: '正交',
  'fixed-angle': '固定角度',
  'lock-point': '锁定顶点',
  'lock-edge': '锁定边',
};
// 需要 1 个顶点 / 1 条边 / 2 个顶点 / 2 条边的约束分类
export const VERTEX_KINDS = ['lock-point'];
export const EDGE_KINDS = ['horizontal', 'vertical', 'fixed-length', 'fixed-angle', 'lock-edge'];
export const TWO_VERTEX_KINDS = ['coincident'];
export const TWO_EDGE_KINDS = ['equal-length', 'parallel', 'perpendicular'];

const LEN_Q = 1e-7;   // 长度类数值存储量化
const ANG_Q = 1e-10; // 角度（弧度）存储量化

// ---------- 初始化与拓扑 ----------

/** 给节点挂载约束系统（若已挂载则原样返回）。vkeys 与 geom 逐顶点对应。 */
export function ensureConstraints(node) {
  if (node.constraints && node.constraints.vkeys) return node.constraints;
  let seq = 0;
  const vkeys = node.geom.map(poly => poly.map(ring => ring.map(() => `v${++seq}`)));
  node.constraints = { vkeys, seq, cseq: 0, items: [] };
  return node.constraints;
}

export function hasConstraints(node) {
  return !!(node.constraints && node.constraints.items.length);
}

export function vertexKey(cs, pi, ri, vi) {
  return cs.vkeys[pi][ri][vi];
}

/** 遍历全部（poly, ring, vertex），返回 {key, pi, ri, vi} 列表。 */
export function vertexEntries(node) {
  const cs = node.constraints;
  const out = [];
  node.geom.forEach((poly, pi) => poly.forEach((ring, ri) => {
    ring.forEach((_, vi) => out.push({ key: cs.vkeys[pi][ri][vi], pi, ri, vi }));
  }));
  return out;
}

export function keyLocation(node, key) {
  const entries = vertexEntries(node);
  return entries.find(e => e.key === key) || null;
}

function keySet(cs) {
  const s = new Set();
  for (const poly of cs.vkeys) for (const ring of poly) for (const k of ring) s.add(k);
  return s;
}

export const edgeToken = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function ringEdges(node) {
  const cs = node.constraints;
  const out = []; // {token, a, b, pi, ri, ei}
  node.geom.forEach((poly, pi) => poly.forEach((ring, ri) => {
    const keys = cs.vkeys[pi][ri];
    for (let i = 0; i < ring.length; i++) {
      const a = keys[i], b = keys[(i + 1) % ring.length];
      out.push({ token: edgeToken(a, b), a, b, pi, ri, ei: i });
    }
  }));
  return out;
}

/** 找到约束边所在（任意）环位置。 */
export function findEdge(node, ref) {
  const tok = edgeToken(ref.a, ref.b);
  return ringEdges(node).find(e => e.token === tok) || null;
}

// ---------- 规格校验与构造 ----------

function isNum(v) { return Number.isFinite(v); }

/**
 * 由用户规格构造约束（分配稳定 id，但不入 items）。
 * spec:
 *   {kind:'coincident', vertices:[a,b]}
 *   {kind:'horizontal'|'vertical'|…, edge:{a,b}}
 *   {kind:'equal-length'|…, edges:[{a,b},{a,b}]}
 *   {kind:'fixed-length', edge, value} / {kind:'fixed-angle', edge, value}
 */
export function makeItem(cs, spec) {
  const kind = spec.kind;
  const ids = keySet(cs);
  const needKey = k => { if (!ids.has(k)) throw new Error(`约束引用了不存在的顶点 ${k}`); };
  const needEdge = e => {
    if (!e || !e.a || !e.b || e.a === e.b) throw new Error('边必须引用两个不同顶点');
    needKey(e.a); needKey(e.b);
  };
  const item = { id: `c${cs.cseq + 1}`, kind, enabled: true };
  if (TWO_VERTEX_KINDS.includes(kind)) {
    const [a, b] = spec.vertices || [];
    needKey(a); needKey(b);
    if (a === b) throw new Error('两个顶点必须不同');
    item.vertices = [a, b];
  } else if (EDGE_KINDS.includes(kind)) {
    needEdge(spec.edge);
    item.edge = { a: spec.edge.a, b: spec.edge.b };
    if (kind === 'fixed-length') {
      if (!isNum(spec.value) || spec.value <= 0) throw new Error('固定长度必须为正数');
      item.value = Math.round(spec.value / LEN_Q) * LEN_Q;
    } else if (kind === 'fixed-angle') {
      if (!isNum(spec.value)) throw new Error('固定角度必须是数字');
      item.value = quantAngle(spec.value);
    }
  } else if (TWO_EDGE_KINDS.includes(kind)) {
    const [e1, e2] = spec.edges || [];
    needEdge(e1); needEdge(e2);
    if (edgeToken(e1.a, e1.b) === edgeToken(e2.a, e2.b)) throw new Error('必须选择两条不同的边');
    item.edges = [{ a: e1.a, b: e1.b }, { a: e2.a, b: e2.b }];
  } else if (kind === 'lock-point') {
    needKey(spec.vertex);
    item.vertex = spec.vertex;
    item.at = spec.at ? [spec.at[0], spec.at[1]] : null; // 由提交层按当前坐标填入
  } else {
    throw new Error(`未知约束类型 ${kind}`);
  }
  return item;
}

/** 约束内容的规范化签名（用于查重与确定性排序；不含 id/启停/锚点）。 */
export function itemSignature(item) {
  const eTok = e => edgeToken(e.a, e.b);
  switch (item.kind) {
    case 'coincident':
      return `coincident:${item.vertices.slice().sort().join('=')}`;
    case 'lock-point':
      return `lock-point:${item.vertex}`;
    case 'lock-edge':
      return `lock-edge:${eTok(item.edge)}`;
    case 'equal-length':
    case 'parallel':
    case 'perpendicular':
      return `${item.kind}:${item.edges.map(eTok).sort().join('~')}`;
    case 'fixed-length':
      return `fixed-length:${eTok(item.edge)}:${q(item.value, LEN_Q)}`;
    case 'fixed-angle':
      return `fixed-angle:${eTok(item.edge)}:${q(item.value, ANG_Q)}`;
    default:
      return `${item.kind}:${eTok(item.edge)}`;
  }
}
const q = (v, step) => Math.round(v / step) * step;

/** 求解排序键：内容键优先（不同创建顺序下同约束集合的行序一致），id 仅作并列兜底。 */
function sortKey(item) { return itemSignature(item) + '#' + item.id; }

// ---------- 角度工具（无向边：方向模 π） ----------

export function normalizeAngle(theta) {
  const PI = Math.PI;
  let t = theta % PI;
  if (t < 0) t += PI;
  if (t >= PI - 1e-12) t = 0;
  return Math.round(t / ANG_Q) * ANG_Q;
}
export function edgeAngle(p, q) {
  return normalizeAngle(Math.atan2(q[1] - p[1], q[0] - p[0]));
}
export const radToDeg = r => Math.round(normalizeAngle(r) * 1800 / Math.PI) / 10;
export const degToRad = d => normalizeAngle(d * Math.PI / 180);

// ---------- 求解器 ----------

const MAX_ITER = 200;

function geomScale(geom) {
  const bb = geomBBox(geom);
  if (!bb) return 1;
  return Math.max(1, Math.hypot(bb.maxX - bb.minX, bb.maxY - bb.minY));
}

/** 约束涉及的顶点键（含锚点）。 */
function itemKeys(item) {
  if (item.kind === 'coincident') return item.vertices.slice();
  if (item.kind === 'lock-point') return [item.vertex];
  if (item.kind === 'lock-edge' || EDGE_KINDS.includes(item.kind)) return [item.edge.a, item.edge.b];
  return item.edges.flatMap(e => [e.a, e.b]);
}

function itemValid(item, alive) {
  if (item.kind === 'coincident') return item.vertices.every(k => alive.has(k));
  if (item.kind === 'lock-point') return alive.has(item.vertex) && Array.isArray(item.at) && item.at.length === 2;
  if (item.kind === 'lock-edge') {
    return item.edge && alive.has(item.edge.a) && alive.has(item.edge.b)
      && Array.isArray(item.at) && item.at.length === 2;
  }
  if (EDGE_KINDS.includes(item.kind)) {
    return item.edge && alive.has(item.edge.a) && alive.has(item.edge.b);
  }
  if (TWO_EDGE_KINDS.includes(item.kind)) {
    return item.edges.every(e => alive.has(e.a) && alive.has(e.b))
      && edgeToken(item.edges[0].a, item.edges[0].b) !== edgeToken(item.edges[1].a, item.edges[1].b);
  }
  return false;
}

/**
 * 计算单条约束的残差分量。
 * 每个分量 {r:number, terms:[[key, 0|1, d], …]}，terms 为对 (x=0,y=1) 的偏导。
 * 坐标取自 P（Map key→[x,y]）；引用锚定顶点的项会在组装时被丢弃。
 */
function components(item, P) {
  const T = (key, axis, d) => [key, axis, d];
  const pt = k => P.get(k);
  switch (item.kind) {
    case 'horizontal': {
      const a = pt(item.edge.a), b = pt(item.edge.b);
      return [{ r: b[1] - a[1], terms: [T(item.edge.a, 1, -1), T(item.edge.b, 1, 1)] }];
    }
    case 'vertical': {
      const a = pt(item.edge.a), b = pt(item.edge.b);
      return [{ r: b[0] - a[0], terms: [T(item.edge.a, 0, -1), T(item.edge.b, 0, 1)] }];
    }
    case 'coincident': {
      const [ka, kb] = item.vertices, a = pt(ka), b = pt(kb);
      return [
        { r: a[0] - b[0], terms: [T(ka, 0, 1), T(kb, 0, -1)] },
        { r: a[1] - b[1], terms: [T(ka, 1, 1), T(kb, 1, -1)] },
      ];
    }
    case 'fixed-length': {
      const a = pt(item.edge.a), b = pt(item.edge.b);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const L = Math.max(Math.hypot(dx, dy), 1e-12);
      return [{
        r: L - item.value,
        terms: [T(item.edge.a, 0, -dx / L), T(item.edge.a, 1, -dy / L),
          T(item.edge.b, 0, dx / L), T(item.edge.b, 1, dy / L)],
      }];
    }
    case 'equal-length': {
      const [e1, e2] = item.edges;
      const a1 = pt(e1.a), b1 = pt(e1.b), a2 = pt(e2.a), b2 = pt(e2.b);
      const dx1 = b1[0] - a1[0], dy1 = b1[1] - a1[1];
      const dx2 = b2[0] - a2[0], dy2 = b2[1] - a2[1];
      const L1 = Math.max(Math.hypot(dx1, dy1), 1e-12), L2 = Math.max(Math.hypot(dx2, dy2), 1e-12);
      // 共享端点时梯度会自然叠加（如 e1.b 与 e2.a 为同一点：dx1/L1 与 -dx2/L2 相加）。
      const terms = [];
      for (const [key, gx, gy] of [
        [e1.a, -dx1 / L1, -dy1 / L1],
        [e1.b, dx1 / L1, dy1 / L1],
        [e2.a, dx2 / L2, dy2 / L2],
        [e2.b, -dx2 / L2, -dy2 / L2],
      ]) terms.push(T(key, 0, gx), T(key, 1, gy));
      return [{ r: L1 - L2, terms }];
    }
    case 'parallel': {
      // r = cross(d1,d2)/|d2| = (dx1·dy2 − dy1·dx2)/L2，量纲为长度
      const [e1, e2] = item.edges;
      const a1 = pt(e1.a), b1 = pt(e1.b), a2 = pt(e2.a), b2 = pt(e2.b);
      const dx1 = b1[0] - a1[0], dy1 = b1[1] - a1[1];
      const dx2 = b2[0] - a2[0], dy2 = b2[1] - a2[1];
      const L2 = Math.max(Math.hypot(dx2, dy2), 1e-12);
      const terms = [];
      for (const [key, gx, gy] of [
        [e1.a, -dy2 / L2, dx2 / L2],
        [e1.b, dy2 / L2, -dx2 / L2],
        [e2.a, dy1 / L2, -dx1 / L2],
        [e2.b, -dy1 / L2, dx1 / L2],
      ]) terms.push(T(key, 0, gx), T(key, 1, gy));
      return [{ r: (dx1 * dy2 - dy1 * dx2) / L2, terms }];
    }
    case 'perpendicular': {
      // r = dot(d1,d2)/|d2| = (dx1·dx2 + dy1·dy2)/L2
      const [e1, e2] = item.edges;
      const a1 = pt(e1.a), b1 = pt(e1.b), a2 = pt(e2.a), b2 = pt(e2.b);
      const dx1 = b1[0] - a1[0], dy1 = b1[1] - a1[1];
      const dx2 = b2[0] - a2[0], dy2 = b2[1] - a2[1];
      const L2 = Math.max(Math.hypot(dx2, dy2), 1e-12);
      const terms = [];
      for (const [key, gx, gy] of [
        [e1.a, -dx2 / L2, -dy2 / L2],
        [e1.b, dx2 / L2, dy2 / L2],
        [e2.a, -dx1 / L2, -dy1 / L2],
        [e2.b, dx1 / L2, dy1 / L2],
      ]) terms.push(T(key, 0, gx), T(key, 1, gy));
      return [{ r: (dx1 * dx2 + dy1 * dy2) / L2, terms }];
    }
    case 'fixed-angle': {
      // r = cross(d, uθ) = dx·sinθ − dy·cosθ（线性；模 π 的两个朝向都满足 r=0）
      const a = pt(item.edge.a), b = pt(item.edge.b);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const s = Math.sin(item.value), c = Math.cos(item.value);
      return [{
        r: dx * s - dy * c,
        terms: [T(item.edge.a, 0, -s), T(item.edge.a, 1, c),
          T(item.edge.b, 0, s), T(item.edge.b, 1, -c)],
      }];
    }
    default:
      return null; // lock-point / lock-edge 走硬锚，无残差行
  }
}

/**
 * 核心求解。纯函数：不修改 geom / cs。
 * opts:
 *   pins       Map key→[x,y]  拖动锚点（硬）
 *   dragHandle {key, from:[x0,y0], to:[x1,y1]}
 *              拖动手势：被拖点硬锚到 to；其余自由点获得“随整体平移 Δ=to−from”的软目标，
 *              仅在约束矩阵的零空间起作用，保证欠约束刚体自由度按拖动手势联动；
 *              不使用 pins（结构求解 / 冲突诊断）时零空间保持最小移动解。
 *   extraItems []            试添加（尚未入 cs）的约束
 *   excludeIds Set           求解时排除的约束 id（停用 / 结构重写）
 *   onlyIds    Set|Array     只保留这些 id 的活动约束（冲突核搜索用）
 * 返回 {ok, feasible, geom, coords(Map), residualById, maxResidual, tau, iterations}
 */
export function solveSystem(geom, cs, opts = {}) {
  return solveOnce(geom, cs, opts);
}

function solveOnce(geom, cs, opts) {
  const pins = opts.pins || new Map();
  const extras = opts.extraItems || [];
  const excluded = opts.excludeIds || new Set();
  const onlyIds = opts.onlyIds ? new Set(opts.onlyIds) : null;
  const dh = opts.dragHandle || null;

  const scale = geomScale(geom);
  const tau = Math.max(1e-7, scale * 1e-8);

  // 顶点遍历（确定顺序：poly → ring → vertex）
  const entries = [];
  geom.forEach((poly, pi) => poly.forEach((ring, ri) => {
    ring.forEach((p, vi) => entries.push({ key: cs.vkeys[pi][ri][vi], p, pi, ri, vi }));
  }));
  const alive = new Set(entries.map(e => e.key));

  // 活动约束：启用 + 引用完整 + 未被排除（试添加排在最后，排序决定行序）
  const items = cs.items
    .filter(it => it.enabled && !excluded.has(it.id) && (!onlyIds || onlyIds.has(it.id)) && itemValid(it, alive))
    .concat(extras.filter(it => it.enabled && !excluded.has(it.id) && (!onlyIds || onlyIds.has(it.id)) && itemValid(it, alive)))
    .slice()
    .sort((a, b) => { const ka = sortKey(a), kb = sortKey(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });

  // 硬锚：先放锁（权威），拖动点若已锁定则忽略拖动（UI 层也会拦截）
  const anchors = new Map();
  for (const it of items) {
    if (it.kind === 'lock-point') anchors.set(it.vertex, [it.at[0], it.at[1]]);
    else if (it.kind === 'lock-edge') {
      anchors.set(it.edge.a, [it.at[0][0], it.at[0][1]]);
      anchors.set(it.edge.b, [it.at[1][0], it.at[1][1]]);
    }
  }
  for (const [k, p] of pins) if (alive.has(k) && !anchors.has(k)) anchors.set(k, [p[0], p[1]]);

  // 拖动手势：被拖点硬锚到 to；其余点获得随整体平移 Δ 的软目标（仅填补零空间）
  const dragTargets = new Map(); // key → [x0+Δx, y0+Δy]
  if (dh && alive.has(dh.key) && !anchors.has(dh.key)) {
    const ddx = dh.to[0] - dh.from[0], ddy = dh.to[1] - dh.from[1];
    anchors.set(dh.key, [dh.to[0], dh.to[1]]);
    for (const e of entries) {
      if (e.key === dh.key) continue;
      dragTargets.set(e.key, [e.p[0] + ddx, e.p[1] + ddy]);
    }
  }
  // 软目标行权重取 1：这些行只出现在约束法方程的零空间（约束行空间的解不受其影响，
  // 收敛后约束残差仍严格为零），却让欠约束的刚体自由度沿拖动手势方向移动。
  const DRAG_W = 1;
  // 欠定零空间偏好：无拖动时，自由点轻微偏好停留在初始位置（权重远小于约束），
  // 使最小二乘解唯一、确定且不被正则化拉向坐标原点。
  const STAY_W = 1e-6;
  const stayTargets = new Map();

  const free = entries.filter(e => !anchors.has(e.key));
  if (!dh) for (const e of free) stayTargets.set(e.key, [e.p[0], e.p[1]]);
  const n2 = free.length * 2;
  const colOf = new Map();
  free.forEach((e, i) => colOf.set(e.key, i * 2));

  const P = new Map();
  for (const e of entries) P.set(e.key, anchors.has(e.key) ? anchors.get(e.key) : [e.p[0], e.p[1]]);
  // 自由变量初值 = 当前几何坐标
  let x = free.flatMap(e => { const p = P.get(e.key); return [p[0], p[1]]; });

  function buildRows(pos) {
    const rows = [];
    for (const it of items) {
      const cs_ = components(it, pos);
      if (!cs_) continue;
      for (const c of cs_) {
        const terms = c.terms
          .filter(t => colOf.has(t[0]))
          .map(t => ({ col: colOf.get(t[0]) + t[1], d: t[2] }));
        rows.push({ id: it.id, r: c.r, terms, soft: false });
      }
    }
    // 拖动软目标：w·(x − target)，只填补约束矩阵零空间
    for (const e of free) {
      const t = dragTargets.get(e.key);
      if (!t) continue;
      const p = pos.get(e.key);
      rows.push({ id: null, r: DRAG_W * (p[0] - t[0]), terms: [{ col: colOf.get(e.key), d: DRAG_W }], soft: true });
      rows.push({ id: null, r: DRAG_W * (p[1] - t[1]), terms: [{ col: colOf.get(e.key) + 1, d: DRAG_W }], soft: true });
    }
    // 停留软目标：无拖动时给零空间一个确定偏好（弱于约束 ~1e6 倍）
    for (const e of free) {
      const t = stayTargets.get(e.key);
      if (!t) continue;
      const p = pos.get(e.key);
      rows.push({ id: null, r: STAY_W * (p[0] - t[0]), terms: [{ col: colOf.get(e.key), d: STAY_W }], soft: true });
      rows.push({ id: null, r: STAY_W * (p[1] - t[1]), terms: [{ col: colOf.get(e.key) + 1, d: STAY_W }], soft: true });
    }
    return rows;
  }
  const energy = rows => rows.reduce((s, rw) => s + rw.r * rw.r, 0);

  function solveStep(rows, lambda) {
    const H = Array.from({ length: n2 }, () => new Float64Array(n2));
    const g = new Float64Array(n2);
    for (const rw of rows) {
      for (const t of rw.terms) {
        g[t.col] += t.d * rw.r;
        for (const u of rw.terms) H[t.col][u.col] += t.d * u.d;
      }
    }
    for (let i = 0; i < n2; i++) H[i][i] += lambda;
    // 高斯消元（部分主元），解 H Δ = −g
    const A = H.map(row => Float64Array.from(row));
    const b = Float64Array.from(g, v => -v);
    for (let k = 0; k < n2; k++) {
      let piv = k;
      for (let i = k + 1; i < n2; i++) if (Math.abs(A[i][k]) > Math.abs(A[piv][k])) piv = i;
      if (Math.abs(A[piv][k]) < 1e-18) return null;
      if (piv !== k) { [A[k], A[piv]] = [A[k], A[piv]]; const tmp = b[k]; b[k] = b[piv]; b[piv] = tmp; }
      for (let i = k + 1; i < n2; i++) {
        const f = A[i][k] / A[k][k];
        if (f === 0) continue;
        for (let j = k; j < n2; j++) A[i][j] -= f * A[k][j];
        b[i] -= f * b[k];
      }
    }
    const delta = new Float64Array(n2);
    for (let i = n2 - 1; i >= 0; i--) {
      let s = b[i];
      for (let j = i + 1; j < n2; j++) s -= A[i][j] * delta[j];
      delta[i] = s / A[i][i];
    }
    return delta;
  }

  // LM 阻尼：欠定系统 H 奇异，必须有小的正正则化才能求解。λ 从 1e-9 起步，
  // 接受步长后衰减（但不归零），被拒则增大；拖动软目标（权重 1）在零空间给方向偏好。
  let lambda = 1e-9;
  let rows = buildRows(P);
  let bestE = energy(rows);
  let iter = 0;
  let maxStep = Infinity;
  if (n2 > 0) {
    for (; iter < MAX_ITER; iter++) {
      const delta = solveStep(rows, lambda);
      if (!delta) { lambda *= 10; if (lambda > 1e12) break; continue; }
      maxStep = 0;
      for (let i = 0; i < n2; i++) { const v = Math.abs(delta[i]); if (v > maxStep) maxStep = v; }
      const cand = x.map((v, i) => v + delta[i]);
      free.forEach((e, i) => P.set(e.key, [cand[i * 2], cand[i * 2 + 1]]));
      const candRows = buildRows(P);
      const eCand = energy(candRows);
      if (eCand < bestE - 1e-18) {
        bestE = eCand; x = cand; rows = candRows;
        lambda = Math.max(1e-11, lambda / 10);
        if (maxStep < 1e-11 && lambda <= 1e-9) break;
      } else {
        free.forEach((e, i) => P.set(e.key, [x[i * 2], x[i * 2 + 1]]));
        lambda *= 10;
        if (lambda > 1e10) break;
      }
    }
  }

  // 每条约束的残差量级（直接由约束分量计算，不含拖动软目标）
  const residualById = new Map();
  for (const it of items) {
    const cs_ = components(it, P);
    const m = cs_ ? Math.max(...cs_.map(c => Math.abs(c.r))) : 0;
    residualById.set(it.id, m);
  }
  let maxResidual = 0;
  for (const v of residualById.values()) if (v > maxResidual) maxResidual = v;
  const feasible = maxResidual <= tau;

  // 回填几何（深拷贝，不改输入）
  const outGeom = geom.map(poly => poly.map(ring => ring.map(p => [p[0], p[1]])));
  for (const e of entries) {
    const p = P.get(e.key);
    outGeom[e.pi][e.ri][e.vi] = [p[0], p[1]];
  }
  const coords = new Map();
  for (const e of entries) { const p = P.get(e.key); coords.set(e.key, [p[0], p[1]]); }

  return {
    ok: true, feasible, geom: outGeom, coords, anchors,
    residualById, maxResidual, tau, iterations: iter, scale,
  };
}

// ---------- 冲突核（不可满足子集，删除过滤最小化） ----------

/**
 * 求一组足以解释冲突的约束（标准 deletion filter：从全体活动约束出发，逐项试探
 * 能否移除——移除后仍不可解说明它不是必要的、直接剔除；最终保留一个最小不可满足
 * 子集，其中任意一项被停用后系统立即恢复可解）。试探按规范化内容键顺序进行，
 * 结果确定且不依赖创建顺序。
 * 返回 {coreIds, result}，result 为核冲突下的最小二乘预览。
 */
export function findConflictCore(geom, cs, opts = {}) {
  const alive0 = (() => {
    const s = new Set();
    for (const poly of cs.vkeys) for (const ring of poly) for (const k of ring) s.add(k);
    return s;
  })();
  const sorted = cs.items
    .filter(it => it.enabled && itemValid(it, alive0))
    .slice()
    .sort((a, b) => { const ka = sortKey(a), kb = sortKey(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });

  const first = solveSystem(geom, cs, opts);
  if (first.feasible) return { coreIds: [], result: first };

  let keep = sorted.map(it => it.id);
  for (const it of sorted) {
    if (!keep.includes(it.id)) continue; // 之前已判定为非必要
    // 试探：把它从当前候选集合中拿掉
    const trialIds = keep.filter(id => id !== it.id);
    const trial = solveSystem(geom, cs, { ...opts, onlyIds: trialIds, excludeIds: new Set() });
    if (trial.feasible) continue;   // 它是必要的：留在核中
    keep = trialIds;               // 不必要：从候选剔除
  }
  // result：在当前几何上对“核外所有活动约束”求解，得到最小二乘偏离预览
  const result = solveSystem(geom, cs, { ...opts });
  return { coreIds: keep, result };
}

// ---------- 诊断（面板 / 画布 / 刷新一致性） ----------

/**
 * 评估节点当前几何 + 约束。返回：
 *   feasible, statusById('satisfied'|'deviated'|'conflict'|'off'|'orphan'),
 *   coreIds, residualById, summary（可哈希的稳定诊断摘要）, tau
 */
export function evaluate(node, opts = {}) {
  const cs = node.constraints;
  const statusById = {};
  if (!cs) {
    return { feasible: true, statusById, coreIds: [], residualById: new Map(), summary: 'no-constraints', tau: 0 };
  }
  const alive = keySet(cs);
  const { coreIds, result } = findConflictCore(node.geom, cs, opts);
  const coreSet = new Set(coreIds);
  const counts = { satisfied: 0, deviated: 0, conflict: 0, off: 0, orphan: 0 };
  for (const it of cs.items) {
    let st;
    if (!it.enabled) st = 'off';
    else if (!itemValid(it, alive)) st = 'orphan';
    else {
      const res = result.residualById.get(it.id) ?? 0;
      if (result.feasible) st = 'satisfied';
      else if (coreSet.has(it.id)) st = 'conflict';
      else st = res > result.tau ? 'deviated' : 'satisfied';
    }
    statusById[it.id] = st;
    counts[st]++;
  }
  const coreSig = coreIds.length
    ? cs.items.filter(i => coreSet.has(i.id))
        .map(i => i.id + ':' + itemSignature(i)).sort().join('|')
    : '';
  const summary = JSON.stringify({
    f: result.feasible ? 1 : 0,
    c: counts,
    core: coreIds.slice().sort(),
    coreSig,
    r: result.maxResidual >= result.tau ? Math.round(result.maxResidual / result.tau) : 0,
  });
  return {
    feasible: result.feasible, statusById, coreIds, coreSig,
    residualById: result.residualById, result, counts, summary, tau: result.tau,
  };
}

// ---------- 变更预览（添加 / 编辑 / 删除约束：先试解，成功才可提交） ----------

function cloneCs(cs) {
  return {
    vkeys: cs.vkeys.map(poly => poly.map(ring => ring.slice())),
    seq: cs.seq, cseq: cs.cseq,
    items: cs.items.map(it => JSON.parse(JSON.stringify(it))),
  };
}

/**
 * 预览一组约束增改删。纯函数。
 * patch: {add:[spec…], update:[{id, value?}], removeIds:[…], toggle?:{id,enabled}}
 * 返回 {ok, reason?, nextCs, nextGeom, diag, candidates}
 *   不可行时 {ok:false, reason, coreIds, diag, candidates, nextCs}，调用方不得落盘。
 */
export function previewItemsChange(node, eps, patch = {}) {
  const cs0 = ensureConstraints(node);
  const cs = cloneCs(cs0);
  const candidates = [];
  // 删除
  if (patch.removeIds) {
    const rm = new Set(patch.removeIds);
    cs.items = cs.items.filter(it => !rm.has(it.id));
  }
  // 启停
  if (patch.toggle) {
    const t = cs.items.find(it => it.id === patch.toggle.id);
    if (t) t.enabled = !!patch.toggle.enabled;
  }
  // 值编辑
  for (const u of patch.update || []) {
    const t = cs.items.find(it => it.id === u.id);
    if (!t) return { ok: false, reason: `约束 ${u.id} 不存在` };
    if (t.kind === 'fixed-length') {
      if (!Number.isFinite(u.value) || u.value <= 0) return { ok: false, reason: '固定长度必须为正数' };
      t.value = Math.round(u.value / LEN_Q) * LEN_Q;
    } else if (t.kind === 'fixed-angle') {
      if (!Number.isFinite(u.value)) return { ok: false, reason: '固定角度必须是数字' };
      t.value = quantAngle(u.value);
    }
  }
  // 添加（先在 cseq 不回写的前提下分配候选 id）
  for (const spec of patch.add || []) {
    let item;
    try { item = makeItem(cs, spec); } catch (err) { return { ok: false, reason: err.message, candidates }; }
    if (spec.kind === 'lock-point') {
      const loc = keyLocation({ ...node, constraints: cs }, item.vertex);
      item.at = node.geom[loc.pi][loc.ri][loc.vi].slice();
    } else if (spec.kind === 'lock-edge') {
      const edge = findEdge({ ...node, constraints: cs }, item.edge);
      item.at = [
        node.geom[edge.pi][edge.ri][edge.ei].slice(),
        node.geom[edge.pi][edge.ri][(edge.ei + 1) % node.geom[edge.pi][edge.ri].length].slice(),
      ];
    }
    // 查重（与最终集合中同内容的启用约束）
    const sig = itemSignature(item);
    if (cs.items.some(x => x.enabled && itemSignature(x) === sig)) {
      return { ok: false, reason: '已有完全相同的约束（重复约束）', duplicate: true, candidates };
    }
    candidates.push(item);
    cs.items.push(item);
    cs.cseq += 1;
  }
  // 试解（从当前几何出发；无拖动锚点）
  const sol = solveSystem(node.geom, cs);
  if (!sol.feasible) {
    const { coreIds } = findConflictCore(node.geom, cs);
    const probe = { ...node, constraints: cs };
    return { ok: false, reason: '约束相互冲突，当前几何无解', coreIds, nextCs: cs, diag: evaluate(probe), candidates };
  }
  const v = validateGeom(sol.geom, eps);
  if (!v.ok) {
    return { ok: false, reason: `满足约束会产生无效拓扑：${v.errors[0]}`, invalidTopology: true, nextCs: cs, candidates };
  }
  const probe = { ...node, constraints: cs, geom: sol.geom };
  return { ok: true, nextCs: cs, nextGeom: sol.geom, diag: evaluate(probe), candidates };
}

// ---------- 删除 / 合并顶点：影响预告 + 原子计划 ----------

/**
 * 计算删除顶点 key 后的约束处置与求解结果（纯函数）。
 * 处置：
 *   removed   直接引用被删顶点的点约束（重合/锁定顶点）、引用消失边且无法改写的边约束；
 *   rewritten 引用邻边 eL/eR 的边约束改写到新边 (prev,next)（id 保持不变，身份延续）；
 *   kept      其余约束原样保留。
 */
export function planVertexRemoval(node, key, eps) {
  const cs0 = ensureConstraints(node);
  const loc = keyLocation(node, key);
  if (!loc) return { ok: false, reason: '顶点不存在' };
  const ring = node.geom[loc.pi][loc.ri];
  if (ring.length <= 3) return { ok: false, reason: '环至少要保留 3 个顶点，无法删除' };
  const keys = cs0.vkeys[loc.pi][loc.ri];
  const n = ring.length, i = loc.vi;
  const kPrev = keys[(i - 1 + n) % n], kNext = keys[(i + 1) % n];
  const newEdge = { a: kPrev, b: kNext };
  // 两条邻边都塌缩为同一条新边（prev→next）；键不同、值相同，不能用一个 Map 键覆盖
  const edgeReplace = new Map([
    [edgeToken(kPrev, key), newEdge],
    [edgeToken(key, kNext), { a: kPrev, b: kNext }],
  ]);

  const csNext = cloneCs(cs0);
  csNext.vkeys[loc.pi][loc.ri] = keys.filter(k => k !== key);
  const geomNext = node.geom.map(poly => poly.map(r => r.map(p => [p[0], p[1]])));
  geomNext[loc.pi][loc.ri].splice(i, 1);

  return applyStructuralPlan(node, cs0, csNext, geomNext, new Set([key]), new Map(), edgeReplace, eps, '删除顶点');
}

/**
 * 合并顶点：把 src 合并到 dst（要求同一环、不相邻）。
 *   - coincident(src,dst) 变为恒真 → 失效删除；
 *   - coincident(src,x) 改写成 coincident(dst,x)（若已存在则作为冗余失效）；
 *   - 引用 src 两条关联边的边约束按 (prev,src)→(prev,dst)、(src,next)→(dst,next) 改写；
 *   - 锁定 src 失效；其余保留。
 */
export function planVertexMerge(node, src, dst, eps) {
  const cs0 = ensureConstraints(node);
  const ls = keyLocation(node, src), ld = keyLocation(node, dst);
  if (!ls || !ld) return { ok: false, reason: '顶点不存在' };
  if (ls.pi !== ld.pi || ls.ri !== ld.ri) return { ok: false, reason: '只能合并同一环上的两个顶点' };
  const ringKeys = cs0.vkeys[ls.pi][ls.ri];
  const n = ringKeys.length;
  if (n <= 3) return { ok: false, reason: '环至少要保留 3 个顶点，无法合并' };
  const distIdx = Math.abs(ls.vi - ld.vi);
  const gap = Math.min(distIdx, n - distIdx);
  if (gap < 2) return { ok: false, reason: '相邻顶点不能合并（请改用删除顶点）' };

  const csNext = cloneCs(cs0);
  csNext.vkeys[ls.pi][ls.ri] = ringKeys.filter(k => k !== src);
  const geomNext = node.geom.map(poly => poly.map(r => r.map(p => [p[0], p[1]])));
  geomNext[ls.pi][ls.ri].splice(ls.vi, 1);

  const prev = ringKeys[(ls.vi - 1 + n) % n], next = ringKeys[(ls.vi + 1) % n];
  const edgeReplace = new Map([
    [edgeToken(prev, src), { a: prev, b: dst }],
    [edgeToken(src, next), { a: dst, b: next }],
  ]);
  return applyStructuralPlan(node, cs0, csNext, geomNext, new Set([src]), new Map([[src, dst]]), edgeReplace, eps, '合并顶点');
}

function applyStructuralPlan(node, cs0, csNext, geomNext, removedVertexSet, mappedVertex, edgeReplace, eps, opLabel) {
  // removedVertexSet: Set<key> 被删除的顶点；mappedVertex: Map<src→dst> 合并身份改写
  const removed = [];
  const rewritten = [];
  const kept = [];
  const outItems = [];
  const isRemoved = k => removedVertexSet.has(k);
  const mapV = k => (mappedVertex.has(k) ? mappedVertex.get(k) : k);
  const mapEdge = e => edgeReplace.get(edgeToken(e.a, e.b)) || { a: mapV(e.a), b: mapV(e.b) };

  const record = (it, old, state, reason) => {
    const rec = { item: it, from: old, reason: reason || null };
    if (state === 'removed') removed.push(rec);
    else { outItems.push(it); (state === 'rewritten' ? rewritten : kept).push(rec); }
  };

  for (const old of cs0.items) {
    const it = JSON.parse(JSON.stringify(old));
    const duplicate = () => outItems.some(x => x.enabled && x.kind === it.kind && itemSignature(x) === itemSignature(it));

    if (it.kind === 'lock-point') {
      if (isRemoved(it.vertex)) { record(it, old, 'removed', '锁定的顶点已删除'); continue; }
      if (mappedVertex.has(it.vertex)) {
        const dst = mappedVertex.get(it.vertex);
        if (outItems.some(x => x.kind === 'lock-point' && x.vertex === dst)) {
          record(it, old, 'removed', `目标顶点 ${dst} 已有锁定约束`);
          continue;
        }
        it.vertex = dst;
        record(it, old, 'rewritten', '锁点随顶点合并迁移到目标顶点');
        continue;
      }
      record(it, old, 'kept');
      continue;
    }

    if (it.kind === 'coincident') {
      const [a, b] = it.vertices;
      if (isRemoved(a) || isRemoved(b)) { record(it, old, 'removed', '重合约束引用的顶点已删除'); continue; }
      const na = mapV(a), nb = mapV(b);
      if (na === nb) { record(it, old, 'removed', '两顶点已合并为同一点，重合变为恒真'); continue; }
      it.vertices = [na, nb];
      if ((na !== a || nb !== b)) {
        if (duplicate()) { record(it, old, 'removed', '改写后与已有重合约束重复'); continue; }
        record(it, old, 'rewritten', '顶点身份随合并改写');
        continue;
      }
      record(it, old, 'kept');
      continue;
    }

    if (it.kind === 'lock-edge' || EDGE_KINDS.includes(it.kind)) {
      const e = it.edge;
      // 邻边优先改写：边的端点含被删/合并顶点时，只要它能映射到塌缩后的新边就迁移
      if (edgeReplace.has(edgeToken(e.a, e.b))) {
        const ne = edgeReplace.get(edgeToken(e.a, e.b));
        if (ne.a === ne.b) { record(it, old, 'removed', '边随顶点操作塌缩消失'); continue; }
        if (it.kind === 'lock-edge') {
          record(it, old, 'removed', '被锁定的边已消失（锁边不能迁移到其他边）');
          continue;
        }
        it.edge = ne;
        if (duplicate()) { record(it, old, 'removed', '迁移到新边后与已有同值约束重复'); continue; }
        record(it, old, 'rewritten', '邻边随顶点操作合并，约束迁移到新边');
        continue;
      }
      if (isRemoved(e.a) || isRemoved(e.b)) {
        record(it, old, 'removed', it.kind === 'lock-edge' ? '锁定的边随顶点删除而消失' : '非邻接边引用的顶点已删除');
        continue;
      }
      const ne = mapEdge(e);
      if (ne.a === ne.b) { record(it, old, 'removed', '边随顶点操作塌缩消失'); continue; }
      const changed = edgeToken(ne.a, ne.b) !== edgeToken(e.a, e.b);
      if (changed) {
        if (it.kind === 'lock-edge') {
          record(it, old, 'removed', '被锁定的边已消失（锁边不能迁移到其他边）');
          continue;
        }
        it.edge = ne;
        if (duplicate()) { record(it, old, 'removed', '迁移到新边后与已有同值约束重复'); continue; }
        record(it, old, 'rewritten', '边随顶点合并改写');
        continue;
      }
      record(it, old, 'kept');
      continue;
    }

    if (TWO_EDGE_KINDS.includes(it.kind)) {
      if (it.edges.some(e => isRemoved(e.a) || isRemoved(e.b))) {
        // 端点消失的边若能映射到塌缩新边则改写，否则整约束失效
        const toks = it.edges.map(e => edgeToken(e.a, e.b));
        const canRewrite = it.edges.every((e, idx) => !isRemoved(e.a) && !isRemoved(e.b) || edgeReplace.has(toks[idx]));
        if (!canRewrite) { record(it, old, 'removed', '涉及的边引用了被删顶点且无法迁移'); continue; }
      }
      const newEdges = it.edges.map(e => mapEdge(e));
      if (newEdges.some(e => e.a === e.b)) { record(it, old, 'removed', '涉及的边随顶点操作塌缩'); continue; }
      const changed = newEdges.some((e, idx) => edgeToken(e.a, e.b) !== edgeToken(it.edges[idx].a, it.edges[idx].b));
      if (changed) {
        if (edgeToken(newEdges[0].a, newEdges[0].b) === edgeToken(newEdges[1].a, newEdges[1].b)) {
          record(it, old, 'removed', '两条边合并为同一条，约束恒真');
          continue;
        }
        it.edges = newEdges;
        if (duplicate()) { record(it, old, 'removed', '改写后与已有约束重复'); continue; }
        record(it, old, 'rewritten', '其中一条边随顶点操作改写');
        continue;
      }
      record(it, old, 'kept');
      continue;
    }
    record(it, old, 'kept');
  }

  // 锁点锚点迁移：随合并搬到 dst 的锁点，锚点更新为 dst 当前坐标（求解前完成）
  const mergedTargets = new Set(mappedVertex.values());
  for (const it of outItems) {
    if (it.kind === 'lock-point' && mergedTargets.has(it.vertex)) {
      const ld = keyLocation({ ...node, constraints: csNext, geom: geomNext }, it.vertex);
      if (ld) it.at = geomNext[ld.pi][ld.ri][ld.vi].slice();
    }
  }
  csNext.items = outItems;

  const sol = solveSystem(geomNext, csNext);
  let diag = null, coreIds = [];
  if (!sol.feasible) {
    const cf = findConflictCore(geomNext, csNext);
    coreIds = cf.coreIds;
    diag = evaluate({ ...node, constraints: csNext, geom: cf.result.geom });
  } else {
    const v = validateGeom(sol.geom, eps);
    if (!v.ok) {
      return { ok: false, reason: `操作后满足约束会产生无效拓扑：${v.errors[0]}`, invalidTopology: true };
    }
    diag = evaluate({ ...node, constraints: csNext, geom: sol.geom });
  }

  return {
    ok: true,
    op: opLabel,
    removed, rewritten, kept,
    nextCs: csNext,
    nextGeom: sol.feasible ? sol.geom : geomNext,
    snapped: sol.feasible,
    feasible: sol.feasible,
    coreIds, diag,
  };
}

// ---------- 整体变换时同步约束锚点/长度（平移 / 等比缩放） ----------

export function translateConstraints(cs, dx, dy) {
  if (!cs) return;
  for (const it of cs.items) {
    if (it.kind === 'lock-point') it.at = [it.at[0] + dx, it.at[1] + dy];
    else if (it.kind === 'lock-edge') it.at = [[it.at[0][0] + dx, it.at[0][1] + dy], [it.at[1][0] + dx, it.at[1][1] + dy]];
  }
}

export function scaleConstraints(cs, k, pivot) {
  if (!cs) return;
  const mov = p => [pivot[0] + (p[0] - pivot[0]) * k, pivot[1] + (p[1] - pivot[1]) * k];
  for (const it of cs.items) {
    if (it.kind === 'lock-point') it.at = mov(it.at);
    else if (it.kind === 'lock-edge') it.at = [mov(it.at[0]), mov(it.at[1])];
    else if (it.kind === 'fixed-length') it.value = Math.round((it.value * k) / LEN_Q) * LEN_Q;
  }
}

// ---------- 确定性哈希 ----------

/** 约束结构摘要（身份 / 启停 / 引用 / 数值 / 锚点；vkeys 按遍历序）。 */
export function constraintsDigest(cs) {
  if (!cs) return '';
  const vpart = cs.vkeys.map(poly => poly.map(ring => ring.join(',')).join(';')).join(';;');
  const parts = cs.items.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(it => {
    const base = [it.id, it.kind, it.enabled ? 1 : 0];
    if (it.kind === 'coincident') base.push('v', ...it.vertices.slice().sort());
    else if (it.kind === 'lock-point') base.push('v', it.vertex, q(it.at[0], 1e-7), q(it.at[1], 1e-7));
    else if (EDGE_KINDS.includes(it.kind) || it.kind === 'lock-edge') {
      base.push('e', edgeToken(it.edge.a, it.edge.b));
      if (it.kind === 'fixed-length') base.push('L', q(it.value, LEN_Q));
      if (it.kind === 'fixed-angle') base.push('A', q(it.value, ANG_Q));
      if (it.kind === 'lock-edge') base.push('at', ...it.at.flatMap(p => [q(p[0], 1e-7), q(p[1], 1e-7)]));
    } else {
      base.push('ee', ...it.edges.map(e => edgeToken(e.a, e.b)).sort());
    }
    return base.join('/');
  });
  return fnv1a(`seq=${cs.seq};cseq=${cs.cseq};v=${vpart};c=${parts.join('||')}`);
}

/** 求解结果坐标哈希：按 vkey 排序后量化（与创建顺序无关）。 */
export function coordsHash(coords) {
  const keys = [...coords.keys()].sort();
  const qv = v => Math.round(v * 1e6);
  let str = '';
  for (const k of keys) { const p = coords.get(k); str += `${k}:${qv(p[0])},${qv(p[1])};`; }
  return fnv1a(str);
}

function quantAngle(t) {
  return normalizeAngle(t);
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------- 人类可读描述（面板 / 模态框） ----------

export function describeRefs(it) {
  const ed = e => `边 ${e.a}→${e.b}`;
  if (it.kind === 'coincident') return `顶点 ${it.vertices[0]} ≡ ${it.vertices[1]}`;
  if (it.kind === 'lock-point') return `顶点 ${it.vertex} @(${f2(it.at[0])}, ${f2(it.at[1])})`;
  if (EDGE_KINDS.includes(it.kind) || it.kind === 'lock-edge') {
    let s = ed(it.edge);
    if (it.kind === 'fixed-length') s += ` = ${f2(it.value)}`;
    if (it.kind === 'fixed-angle') s += ` ∡ ${radToDeg(it.value)}°`;
    return s;
  }
  return `${ed(it.edges[0])} ⇔ ${ed(it.edges[1])}`;
}
const f2 = v => Math.round(v * 100) / 100;
