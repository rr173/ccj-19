// cam.js — 数控切割路径生成核心引擎（纯函数，无 DOM 依赖）
// 功能：刀径补偿（外轮廓向外、洞向内）、补偿失效诊断、包含树加工次序、
//       引入/引出线（避开实体与禁穿区）、稳定最近邻空移排序、
//       连接桥布置（合法直线段、避开尖角与引入点）、逐段统计、导出前复核。
// 确定性：所有排序均带稳定字典序 tie-break；相同参数与图形，结果与段编号一致。

'use strict';

/* ============================ 基础向量工具 ============================ */

const V = {
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
  mul: (a, k) => ({ x: a.x * k, y: a.y * k }),
  dot: (a, b) => a.x * b.x + a.y * b.y,
  cross: (a, b) => a.x * b.y - a.y * b.x,
  len: (a) => Math.hypot(a.x, a.y),
  dist: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
  norm: (a) => {
    const l = Math.hypot(a.x, a.y);
    return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
  },
  rot90: (a) => ({ x: -a.y, y: a.x }), // 逆时针 90°
  lerp: (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }),
  eq: (a, b, eps = 1e-9) => Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps,
};

// 用于排序/哈希的稳定舍入
function roundKey(v, d = 6) {
  const r = Math.abs(v) < 5e-7 ? 0 : v;
  return Number(r.toFixed(d));
}

function polyLen(pts) {
  let s = 0;
  for (let i = 0; i < pts.length - 1; i++) s += V.dist(pts[i], pts[i + 1]);
  return s;
}

/* ============================ 环（多边形）工具 ============================ */

// 有向面积：>0 CCW（外轮廓规范方向），<0 CW（洞规范方向）
function signedArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

const isCCW = (ring) => signedArea(ring) > 0;

// 规范化方向：outer 强制 CCW，hole 强制 CW。不修改入参。
function orientRing(ring, wantCCW) {
  const pts = ring.map((p) => ({ x: +p.x, y: +p.y }));
  if (isCCW(pts) !== wantCCW) pts.reverse();
  return pts;
}

// 去除重复相邻点与尾点重复
function dedupeRing(ring) {
  const pts = [];
  for (const p of ring) {
    const q = { x: +p.x, y: +p.y };
    const last = pts[pts.length - 1];
    if (!last || !V.eq(last, q, 1e-9)) pts.push(q);
  }
  if (pts.length > 1 && V.eq(pts[0], pts[pts.length - 1], 1e-9)) pts.pop();
  return pts;
}

// 点在多边形内：1 内，0 边界，-1 外（射线法）
function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j];
    const b = ring[i];
    if (pointOnSegment(p, a, b)) return 0;
    const hit = (b.y > p.y) !== (a.y > p.y) &&
      p.x < ((a.x - b.x) * (p.y - b.y)) / (a.y - b.y) + b.x;
    if (hit) inside = !inside;
  }
  return inside ? 1 : -1;
}

function pointOnSegment(p, a, b, eps = 1e-8) {
  if (V.dist(a, b) < 1e-12) return V.dist(p, a) <= eps;
  const cr = V.cross(V.sub(b, a), V.sub(p, a));
  if (Math.abs(cr) > eps * Math.max(1, V.dist(a, b))) return false;
  return V.dot(V.sub(p, a), V.sub(p, b)) <= eps * eps;
}

// 线段相交（含端点/共线重叠），返回交点（共线返回区间中点供“穿越”判定）
function segIntersect(a, b, c, d) {
  const r = V.sub(b, a);
  const s = V.sub(d, c);
  const rxs = V.cross(r, s);
  const qp = V.sub(c, a);
  const qpxr = V.cross(qp, r);
  if (Math.abs(rxs) < 1e-11) {
    if (Math.abs(qpxr) > 1e-8 * Math.max(1, V.len(r))) return []; // 平行不共线
    const rr = V.dot(r, r);
    if (rr < 1e-14) return [];
    const t0 = V.dot(V.sub(c, a), r) / rr;
    const t1 = V.dot(V.sub(d, a), r) / rr;
    const lo = Math.max(0, Math.min(t0, t1));
    const hi = Math.min(1, Math.max(t0, t1));
    if (hi < lo - 1e-9) return [];
    return [V.lerp(a, b, (lo + hi) / 2)];
  }
  const t = V.cross(qp, s) / rxs;
  const u = qpxr / rxs;
  if (t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) {
    return [V.lerp(a, b, Math.min(1, Math.max(0, t)))];
  }
  return [];
}

// 折线段 ab 是否从内部穿过多边形（中段采样点落入内部即算）
function segCrossesRing(a, b, ring) {
  const n = 24;
  for (let i = 1; i < n; i++) {
    const p = V.lerp(a, b, i / n);
    if (pointInRing(p, ring) === 1) return true;
  }
  return false;
}

/* ============================ 输入规范化与包含树 ============================ */

// rings: [{id?, name?, points:[{x,y}], kind?:'outer'|'hole'(可空)}]
function normalizeInput(rings) {
  const list = rings.map((r, idx) => {
    const pts = dedupeRing(r.points);
    const id = r.id || `ring-${idx + 1}`;
    return { id, name: r.name || id, inputKind: r.kind, rawPoints: pts, inputOrder: idx };
  });

  // 未指定 kind 时按面积方向判定；指定则强制规范方向
  for (const r of list) {
    if (r.inputKind === 'hole') {
      r.kind = 'hole';
      r.points = orientRing(r.rawPoints, false);
    } else if (r.inputKind === 'outer') {
      r.kind = 'outer';
      r.points = orientRing(r.rawPoints, true);
    } else {
      r.kind = isCCW(r.rawPoints) ? 'outer' : 'hole';
      r.points = r.rawPoints.map((p) => ({ ...p }));
    }
  }

  const areaOf = (r) => Math.abs(signedArea(r.points));
  const contains = (outer, inner) => {
    if (areaOf(outer) <= areaOf(inner) * (1 + 1e-9)) return false;
    const sample = [inner.points[0], inner.points[Math.floor(inner.points.length / 2)]];
    return sample.every((p) => pointInRing(p, outer.points) >= 0);
  };
  for (const b of list) {
    b.depth = 0;
    for (const a of list) {
      if (a !== b && contains(a, b)) b.depth++;
    }
  }
  for (const r of list) {
    const expectKind = r.depth % 2 === 0 ? 'outer' : 'hole';
    r.kindConsistent = r.kind === expectKind;
    if (!r.kindConsistent) r.kind = expectKind; // 以拓扑包含关系为准
  }
  for (const b of list) {
    let parent = null;
    for (const a of list) {
      if (a.depth === b.depth - 1 && contains(a, b)) {
        if (!parent || areaOf(a) < areaOf(parent)) parent = a;
      }
    }
    b.parent = parent ? parent.id : null;
  }
  for (const r of list) r.stableKey = geometryKey(r.points);
  return list;
}

// 几何稳定指纹：字典序最小的顶点旋转序列（与输入顺序/起点无关）
function geometryKey(ring) {
  const coords = ring.map((p) => `${roundKey(p.x)}_${roundKey(p.y)}`);
  let best = null;
  for (let i = 0; i < coords.length; i++) {
    const rot = coords.slice(i).concat(coords.slice(0, i)).join('>');
    if (!best || rot < best) best = rot;
  }
  return `n${ring.length}|${best}`;
}

/* ============================ 刀径补偿 ============================ */
// 统一规则：规范方向（outer=CCW, hole=CW）下材料恒在行进方向左侧，
// 空气（刀具中心应在的一侧）恒在右侧 → 两种轮廓统一“右向偏移 d”。

// 窄槽预检：偏移后两条“面对面”的空气侧壁相撞 ⇒ 窄槽/薄壁消失
// 规范方向下空气在行进方向右侧；开口槽（外轮廓）的空气在多边形外，洞的空气在多边形内。
function findSlotCollisions(ring, d, kind) {
  const hits = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const a1 = ring[i], a2 = ring[(i + 1) % n];
      const b1 = ring[j], b2 = ring[(j + 1) % n];
      if (V.eq(a1, b1) || V.eq(a1, b2) || V.eq(a2, b1) || V.eq(a2, b2)) continue;
      const da = V.norm(V.sub(a2, a1));
      const db = V.norm(V.sub(b2, b1));
      if (V.dot(da, db) > -0.5) continue; // 需要大致反向（面对面）
      const ra = { x: da.y, y: -da.x }; // 右法线=空气侧
      const rb = { x: db.y, y: -db.x };
      const ma = V.lerp(a1, a2, 0.5);
      const mb = V.lerp(b1, b2, 0.5);
      const diff = V.sub(mb, ma);
      const gapA = V.dot(diff, ra);
      // 两边的空气法线必须都指向两壁之间
      if (gapA <= 1e-9 || V.dot(V.sub(ma, mb), rb) <= 1e-9) continue;
      const along = V.dot(diff, da);
      const la = V.dist(a1, a2), lb = V.dist(b1, b2);
      if (Math.abs(along) > (la + lb) / 2 + 1e-6) continue;
      const midAir = V.add(ma, V.mul(ra, gapA / 2));
      const inside = pointInRing(midAir, ring) === 1;
      const airOK = kind === 'hole' ? inside : !inside; // 外轮廓空气在外，洞空气在内
      if (airOK && gapA <= 2 * d + 1e-6) {
        hits.push({ edges: [i, j], gap: gapA, need: 2 * d, point: midAir });
      }
    }
  }
  return hits;
}

// 顶点接合：前边偏移线与当前边偏移线的交点；超 miter 限界的外凸角改圆弧
function makeJoint(prev, cur, d, miterLimit) {
  const p1 = prev.ob, p2 = cur.oa;
  const r = V.sub(prev.ob, prev.oa);
  const s = V.sub(cur.ob, cur.oa);
  const den = V.cross(r, s);
  const turn = V.cross(prev.dir, cur.dir);
  const convex = turn < 0; // 规范方向下右转=外凸
  if (Math.abs(den) < 1e-10) {
    return { kind: 'miter', p: { ...p2 }, convex };
  }
  const t = V.cross(V.sub(p2, prev.oa), s) / den;
  const miter = V.add(prev.oa, V.mul(r, t));
  const ratio = V.dist(miter, prev.b) / d;
  if (!convex || ratio <= miterLimit) {
    return { kind: 'miter', p: miter, convex };
  }
  // 外凸尖角超界 → 圆弧接合（圆心在空气侧，半径 d，从 prev.ob 到 cur.oa）
  const arcSide = V.norm(V.add(prev.right, cur.right));
  const center = V.add(prev.b, V.mul(arcSide, d));
  const a0 = Math.atan2(prev.ob.y - center.y, prev.ob.x - center.x);
  const a1 = Math.atan2(cur.oa.y - center.y, cur.oa.x - center.x);
  let sweep = a1 - a0;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  return { kind: 'round', center, sweep, convex, arcSide };
}

// 单环右向偏移。输出 {points, spans, miterJoints, roundJoints}
// span {type:'line', edgeIndex, from, to, len} 与原边一一对应（仅 line 可放桥）
// span {type:'arc', vertex, points[]} 尖角圆弧（不可放桥、不算有效直线段）
function offsetRing(ring, d, opts = {}) {
  const n = ring.length;
  const miterLimit = opts.miterLimit != null ? opts.miterLimit : 2.0;
  const arcSegs = opts.arcSegs || 6;
  if (n < 3 || d <= 0) {
    const spans = ring.map((p, i) => ({
      type: 'line', edgeIndex: i, from: ring[i], to: ring[(i + 1) % n],
      len: V.dist(ring[i], ring[(i + 1) % n]),
    }));
    return { points: ring.map((p) => ({ ...p })), spans, miterJoints: [], roundJoints: [], trivial: true };
  }

  const edges = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const dir = V.norm(V.sub(b, a));
    const right = { x: dir.y, y: -dir.x }; // 行进方向右侧=空气侧
    const off = V.mul(right, d);
    edges.push({ i, a, b, dir, right, oa: V.add(a, off), ob: V.add(b, off), len: V.dist(a, b) });
  }
  const joints = [];
  for (let i = 0; i < n; i++) {
    joints.push(makeJoint(edges[(i - 1 + n) % n], edges[i], d, miterLimit));
  }

  // 单次遍历：对每条边 i 输出 [顶点i接合尾 → line(边i) → 顶点i+1接合头]
  const points = [];
  const spans = [];
  const miterJoints = [];
  const roundJoints = [];

  for (let i = 0; i < n; i++) {
    const jStart = joints[i];
    const jEnd = joints[(i + 1) % n];
    let lineStart, lineEnd;

    if (jStart.kind === 'miter') {
      lineStart = jStart.p;
      if (i === 0) { points.push(jStart.p); miterJoints.push({ vertex: 0, p: jStart.p, convex: jStart.convex }); }
    } else {
      // 圆弧：从 prev.ob 沿弧到 cur.oa（cur=edges[i]）
      lineStart = edges[i].oa;
      if (i === 0) {
        const arcPts = arcPoints(jStart, edges[(i - 1 + n) % n].ob, edges[i].oa, arcSegs);
        points.push(...arcPts);
        spans.push({ type: 'arc', vertex: 0, points: arcPts, from: arcPts[0], to: arcPts[arcPts.length - 1] });
        roundJoints.push({ vertex: 0, center: jStart.center, sweep: jStart.sweep, convex: jStart.convex });
      }
    }

    if (jEnd.kind === 'miter') {
      lineEnd = jEnd.p;
    } else {
      lineEnd = edges[i].ob;
    }

    spans.push({
      type: 'line', edgeIndex: i, from: lineStart, to: lineEnd,
      len: V.dist(lineStart, lineEnd),
    });

    if (jEnd.kind === 'miter') {
      points.push(jEnd.p);
      miterJoints.push({ vertex: (i + 1) % n, p: jEnd.p, convex: jEnd.convex, limited: false });
    } else {
      const arcPts = arcPoints(jEnd, edges[i].ob, edges[(i + 1) % n].oa, arcSegs);
      // 起点（=edges[i].ob）已作为 line 终点推入
      points.push(...arcPts.slice(1));
      spans.push({ type: 'arc', vertex: (i + 1) % n, points: [arcPts[0], ...arcPts.slice(1)],
        from: arcPts[0], to: arcPts[arcPts.length - 1] });
      roundJoints.push({ vertex: (i + 1) % n, center: jEnd.center, sweep: jEnd.sweep, convex: jEnd.convex });
    }
  }

  if (points.length > 1 && V.eq(points[0], points[points.length - 1], 1e-7)) points.pop();
  return { points, spans, miterJoints, roundJoints };
}

function arcPoints(joint, from, to, arcSegs) {
  const pts = [{ ...from }];
  const a0 = Math.atan2(from.y - joint.center.y, from.x - joint.center.x);
  for (let k = 1; k <= arcSegs; k++) {
    const ang = a0 + (joint.sweep * k) / arcSegs;
    const R = Math.hypot(from.x - joint.center.x, from.y - joint.center.y);
    pts.push({ x: joint.center.x + R * Math.cos(ang), y: joint.center.y + R * Math.sin(ang) });
  }
  return pts;
}

// 补偿环自交检测：非相邻输出边严格相交（端点共享不算）
function offsetSelfIntersects(points) {
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    for (let j = i + 2; j < points.length; j++) {
      if (i === 0 && j === points.length - 1) continue;
      if (j === i + 1) continue;
      const c = points[j], dd = points[(j + 1) % points.length];
      const hits = segIntersect(a, b, c, dd);
      if (!hits.length) continue;
      const shared = V.eq(a, c) || V.eq(a, dd) || V.eq(b, c) || V.eq(b, dd);
      if (!shared) return { point: hits[0], edges: [i, j] };
    }
  }
  return null;
}

/* ============================ 材料/区域穿越查询 ============================ */

// 点是否位于“实体材料”：全部环奇偶缠绕（偶数层=材料，奇数次=洞空气）
function pointInMaterial(p, rings) {
  let wind = 0;
  for (const r of rings) {
    const t = pointInRing(p, r.points);
    if (t === 0) return false;
    if (t === 1) wind++;
  }
  return wind % 2 === 1;
}

// 折线段是否穿过材料（excludeRingIds 中的环不计数；边界贴边允许）
function polylineHitsMaterial(poly, rings, excludeRingIds = null) {
  for (let k = 0; k < poly.length - 1; k++) {
    for (let i = 1; i <= 16; i++) {
      const p = V.lerp(poly[k], poly[k + 1], i / 17);
      let wind = 0;
      for (const r of rings) {
        if (excludeRingIds && excludeRingIds.has(r.id)) continue;
        if (pointInRing(p, r.points) === 1) wind++;
      }
      if (wind % 2 === 1) return { point: p };
    }
  }
  return null;
}

function polylineHitsZones(poly, zones) {
  for (const z of zones) {
    for (let k = 0; k < poly.length - 1; k++) {
      if (segCrossesRing(poly[k], poly[k + 1], z.points)) return { zone: z, point: V.lerp(poly[k], poly[k + 1], 0.5) };
    }
  }
  return null;
}

/* ============================ 引入/引出线 ============================ */

// 候选起刀点：沿补偿环合法直线段（t=0.25/0.5/0.75）
function leadCandidates(ring, off) {
  const cands = [];
  for (const sp of off.spans) {
    if (sp.type !== 'line') continue;
    const origA = ring.points[sp.edgeIndex];
    const origB = ring.points[(sp.edgeIndex + 1) % ring.points.length];
    const dir = V.norm(V.sub(origB, origA));
    const right = { x: dir.y, y: -dir.x };
    for (const t of [0.25, 0.5, 0.75]) {
      cands.push({ point: V.lerp(sp.from, sp.to, t), edgeIndex: sp.edgeIndex, edgeT: t, right, dir });
    }
  }
  return cands;
}

// 构造引入线并做穿越/候选区校验
function buildLead(ring, cand, params, rings, zones) {
  const L = params.leadLength;
  const end = cand.point;
  let poly;
  if (params.leadType === 'arc') {
    // 90° 切向圆弧：圆心在空气侧 L 处，起刀点=圆心沿轮廓切向 L，切入处切向与行进方向一致
    const c = V.add(end, V.mul(cand.right, L));
    const start = V.add(c, V.mul(cand.dir, L));
    const a0 = Math.atan2(start.y - c.y, start.x - c.x);
    const a1 = Math.atan2(end.y - c.y, end.x - c.x);
    let da = a1 - a0;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    poly = [start];
    for (let k = 1; k <= 10; k++) {
      const ang = a0 + (da * k) / 10;
      poly.push({ x: c.x + L * Math.cos(ang), y: c.y + L * Math.sin(ang) });
    }
  } else {
    const start = V.add(end, V.mul(cand.right, L));
    poly = [start, end];
  }
  const zoneHit = polylineHitsZones(poly, zones);
  if (zoneHit) return { ok: false, reason: 'lead-zone', poly, hit: zoneHit };
  // 实体判定使用全部环的奇偶缠绕（不能排除自身：洞的引入线整段处于
  // “外+洞”偶数层空气中；外轮廓引入线在自身多边形外）。
  const matHit = polylineHitsMaterial(poly, rings, null);
  if (matHit) return { ok: false, reason: 'lead-material', poly, hit: matHit };
  // 候选区只约束外轮廓的起刀点（洞内起刀点物理上无法落到外部候选区）
  if (params.startRegions && params.startRegions.length && ring.kind === 'outer') {
    const ok = params.startRegions.some((z) => pointInRing(poly[0], z.points) >= 0);
    if (!ok) return { ok: false, reason: 'lead-not-in-region', poly };
  }
  return { ok: true, poly, start: poly[0], end };
}

/* ============================ 空移路径（抬刀：禁穿越区严格绕行） ============================ */

function inflateRect(points, m) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return [
    { x: minX - m, y: minY - m }, { x: maxX + m, y: minY - m },
    { x: maxX + m, y: maxY + m }, { x: minX - m, y: maxY + m },
  ];
}

// 抬刀空移：严禁穿越禁止穿越区，也不得穿过尚未切开的其它独立实体；
// 可见图（矩形障碍角点 + 实体多边形外扩顶点）+ 确定性 Dijkstra 绕行。
function planRapidStrict(from, to, noCross, params, solidBlockers = []) {
  const clear = Math.max(0.5, params.toolDiameter * 0.5);
  // 禁穿区按外接矩形外扩刀半径；障碍按几何（左下角坐标）稳定排序，与输入顺序无关
  const zoneBoxes = noCross
    .map((z) => inflateRect(z.points, clear))
    .sort((a, b) => {
      const ka = `${fmt(a[0].x)},${fmt(a[0].y)}`;
      const kb = `${fmt(b[0].x)},${fmt(b[0].y)}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  // 未切实体：绕行节点为沿“中心→顶点”推出刀半径的外扩顶点，保证绕行折线不贴边
  const solids = solidBlockers
    .map((r) => {
      const ring = r.points;
      const center = centroid(ring);
      const verts = ring.map((p) => V.add(p, V.mul(V.norm(V.sub(p, center)), clear)));
      return { ring, verts, key: r.stableKey || ring.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join('>') };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const crossesZone = (a, b) => zoneBoxes.some((bp) => segCrossesRing(a, b, bp));
  const crossesSolid = (a, b) => {
    for (const s of solids) {
      // 端点已在该实体内（通往内部洞的必经路径）时由调用方排除，这里放行
      if (pointInRing(a, s.ring) === 1 || pointInRing(b, s.ring) === 1) continue;
      if (segCrossesRing(a, b, s.ring)) return true;
    }
    return false;
  };
  const blocked = (a, b) => crossesZone(a, b) || crossesSolid(a, b);
  if (!blocked(from, to)) return { poly: [from, to], length: V.dist(from, to), detour: false };

  const nodes = [from, to];
  for (const bx of zoneBoxes) for (const p of bx) nodes.push(p);
  for (const s of solids) for (const p of s.verts) nodes.push(p);
  const N = nodes.length;
  const dist = new Array(N).fill(Infinity);
  const prev = new Array(N).fill(-1);
  const used = new Array(N).fill(false);
  dist[0] = 0;
  for (let it = 0; it < N; it++) {
    let u = -1;
    for (let i = 0; i < N; i++) {
      if (!used[i] && (u < 0 || dist[i] < dist[u] - 1e-12 ||
        (Math.abs(dist[i] - dist[u]) <= 1e-12 && i < u))) u = i;
    }
    if (u < 0 || !isFinite(dist[u])) break;
    used[u] = true;
    for (let v = 0; v < N; v++) {
      if (v === u || used[v] || blocked(nodes[u], nodes[v])) continue;
      const nd = dist[u] + V.dist(nodes[u], nodes[v]);
      if (nd < dist[v] - 1e-9) { dist[v] = nd; prev[v] = u; }
    }
  }
  if (!isFinite(dist[1])) return { poly: [from, to], length: V.dist(from, to), blocked: true };
  const path = [];
  let c = 1;
  while (c >= 0) { path.unshift(nodes[c]); c = prev[c]; }
  return { poly: path, length: dist[1], detour: true };
}

/* ============================ 连接桥 ============================ */
// 仅有效直线段；距尖角 cornerClear；距引入点 leadGuard；桥间不重叠；边序确定。
function placeBridges(ring, off, params, leadInfo) {
  const w = params.bridgeWidth;
  const cornerClear = params.bridgeCornerClear;
  const leadGuard = params.bridgeLeadGuard;
  const want = params.bridgeCount;
  const lines = off.spans.filter((s) => s.type === 'line' && s.len > 1e-6);

  const avail = lines.map((s) => {
    let lo = cornerClear, hi = s.len - cornerClear;
    if (leadInfo && leadInfo.edgeIndex === s.edgeIndex) {
      const lp = leadInfo.edgeT * s.len;
      if (lp - leadGuard - w / 2 < hi && lp + leadGuard + w / 2 > lo) {
        if (lp - leadGuard - w / 2 - lo > hi - (lp + leadGuard + w / 2)) hi = lp - leadGuard - w / 2;
        else lo = lp + leadGuard + w / 2;
      }
    }
    return { span: s, lo, hi };
  });

  const placed = [];
  const used = avail.map(() => []);
  for (let k = 0; k < want; k++) {
    let pick = null;
    for (let ai = 0; ai < avail.length; ai++) {
      const a = avail[ai];
      for (const g of freeGaps(a.lo, a.hi, used[ai])) {
        const score = g.hi - g.lo;
        if (score >= w && (!pick || score > pick.score + 1e-9 ||
          (Math.abs(score - pick.score) <= 1e-9 && a.span.edgeIndex < pick.edge))) {
          pick = { ai, lo: g.lo, hi: g.hi, score, edge: a.span.edgeIndex };
        }
      }
    }
    if (!pick) {
      return {
        placed, requested: want, placedCount: placed.length,
        missing: want - placed.length,
        reason: `需要 ${want} 个连接桥，仅 ${placed.length} 个能放在合法直线段上（其余受尖角保护距 ${cornerClear}、引入线保护距 ${leadGuard} 或窄段限制，无法放置）`,
      };
    }
    const center = (pick.lo + pick.hi) / 2;
    used[pick.ai].push({ lo: center - w / 2, hi: center + w / 2 });
    const sp = avail[pick.ai].span;
    const f = (t) => V.lerp(sp.from, sp.to, t / sp.len);
    placed.push({
      edgeIndex: sp.edgeIndex,
      from: f(center - w / 2), to: f(center + w / 2), width: w, ringId: ring.id,
    });
  }
  return { placed, requested: want, placedCount: want, missing: 0, reason: null };
}

function freeGaps(lo, hi, used) {
  const segs = [...used].sort((a, b) => a.lo - b.lo);
  const gaps = [];
  let cur = lo;
  for (const u of segs) {
    if (u.lo > cur) gaps.push({ lo: cur, hi: u.lo });
    cur = Math.max(cur, u.hi);
  }
  if (cur < hi) gaps.push({ lo: cur, hi });
  return gaps;
}

/* ============================ 加工次序 ============================ */
// 内部环先于包含它的外环；同层用稳定 key 的最近邻贪心，距离相同按 key 字典序。
// costFn(curPoint, nextId)：真实抬刀绕行代价（默认直线），返回 Infinity 表示不可达。
function buildSequence(rings, startPos, costFn) {
  const defaultCost = (p, id) => {
    const r2 = byId.get(id);
    return V.dist(p, r2.leadStart);
  };
  const costOf = costFn || defaultCost;
  const byId = new Map(rings.map((r) => [r.id, r]));
  const childrenOf = new Map();
  for (const r of rings) {
    if (r.parent && byId.has(r.parent)) {
      if (!childrenOf.has(r.parent)) childrenOf.set(r.parent, []);
      childrenOf.get(r.parent).push(r.id);
    }
  }
  const done = new Set();
  const order = [];
  const remaining = new Set(rings.map((r) => r.id));
  let cur = startPos;

  const canPick = (id) => {
    if (done.has(id)) return false;
    for (const k of childrenOf.get(id) || []) if (!done.has(k)) return false;
    return true;
  };

  while (remaining.size) {
    let best = null;
    for (const id of remaining) {
      if (!canPick(id)) continue;
      const r = byId.get(id);
      const cost = costOf(cur, id);
      if (!isFinite(cost)) continue;
      if (!best || cost < best.cost - 1e-9 ||
        (Math.abs(cost - best.cost) <= 1e-9 && r.stableKey < best.key)) {
        best = { id, cost, key: r.stableKey };
      }
    }
    if (!best) return { order, blocked: [...remaining] };
    done.add(best.id);
    remaining.delete(best.id);
    order.push(best.id);
    cur = byId.get(best.id).leadOutEnd || byId.get(best.id).leadEnd;
  }
  return { order, blocked: [] };
}

function fmt(v, d = 4) {
  const r = Math.abs(v) < 5e-7 ? 0 : v;
  return Number(r.toFixed(d));
}

/* ============================ 主编排 ============================ */

function normalizeParams(p = {}) {
  return {
    toolDiameter: +(p.toolDiameter ?? 4),
    machiningSide: p.machiningSide || 'auto',
    leadType: p.leadType || 'line',
    leadLength: +(p.leadLength ?? 6),
    bridgeCount: Math.max(0, Math.round(p.bridgeCount ?? 2)),
    bridgeWidth: +(p.bridgeWidth ?? 3),
    bridgeCornerClear: +(p.bridgeCornerClear ?? 4),
    bridgeLeadGuard: +(p.bridgeLeadGuard ?? 5),
  };
}

function computeToolpath(input) {
  const params = normalizeParams(input.params);
  const zones = (input.zones || []).map((z, i) => ({
    id: z.id || `zone-${i + 1}`,
    name: z.name || z.type || `zone-${i + 1}`,
    type: z.type,
    points: dedupeRing(z.points),
  }));
  const noCross = zones.filter((z) => z.type === 'no-cross');
  const startRegions = zones.filter((z) => z.type === 'start-region');
  const paramsWithRegions = { ...params, startRegions };

  const rings0 = normalizeInput(input.rings);
  const rings = [...rings0].sort((a, b) =>
    a.stableKey < b.stableKey ? -1 : a.stableKey > b.stableKey ? 1 : a.id < b.id ? -1 : 1);

  const d = params.toolDiameter / 2;
  const leftMode = params.machiningSide === 'left';
  // 引入/引出线避让禁穿区时额外留出刀半径余量（刀具本身有宽度）
  const leadClearZones = noCross.map((z) => ({ ...z, points: inflateRect(z.points, d + 0.25) }));

  // ---- 逐环补偿与失效诊断 ----
  for (const r of rings) {
    r.sideNote = r.kind === 'outer'
      ? '外轮廓：刀具中心向材料外侧补偿'
      : '洞：刀具中心向材料内侧补偿';
    if (leftMode) r.sideNote += '（当前为手动左补偿，材料侧）';
    const useD = d;

    if (useD < 1e-9) {
      r.offsetError = null;
      r.offset = {
        points: r.points.map((p) => ({ ...p })),
        spans: r.points.map((p, i) => ({
          type: 'line', edgeIndex: i, from: r.points[i], to: r.points[(i + 1) % r.points.length],
          len: V.dist(r.points[i], r.points[(i + 1) % r.points.length]),
        })),
        miterJoints: [], roundJoints: [],
      };
      continue;
    }

    const slots = (!leftMode && r.kind === 'outer') ? findSlotCollisions(r.points, useD, r.kind) : [];
    const off = offsetRing(r.points, useD);
    const self = offsetSelfIntersects(off.points);
    const signed = signedArea(off.points);
    const area = Math.abs(signed);
    // 洞向内收缩到方向翻转（CW→CCW）或残余小于一刀见方 ⇒ 被吞并
    const holeCollapsed = r.kind === 'hole' && (signed > 0 || area < params.toolDiameter * params.toolDiameter * 0.5);

    if (slots.length) {
      r.offsetError = {
        code: 'SLOT_GONE',
        message: `刀具直径 ${params.toolDiameter} 过大：边 ${slots[0].edges.map((e) => e + 1).join('、')} 之间的窄槽（净宽 ${slots[0].gap.toFixed(2)} ≤ 刀径 ${params.toolDiameter}）补偿后被堵死消失，不能输出看似可用的路径`,
        edges: slots[0].edges, point: slots[0].point,
      };
      r.offset = off;
    } else if (holeCollapsed) {
      r.offsetError = {
        code: 'HOLE_SWALLOWED',
        message: `刀具直径 ${params.toolDiameter} 过大：该洞向内补偿后被吞并（补偿环${signed > 0 ? '方向翻转' : `残余面积 ${area.toFixed(2)} 小于一刀见方阈值`}），无有效内轮廓`,
        edges: [], point: centroid(off.points),
      };
      r.offset = off;
    } else if (self) {
      r.offsetError = {
        code: 'SELF_INTERSECT',
        message: `刀具直径 ${params.toolDiameter} 补偿后轮廓在边 ${self.edges[0] + 1} 与边 ${self.edges[1] + 1} 附近自交，不能输出看似可用的路径`,
        edges: self.edges, point: self.point,
      };
      r.offset = off;
    } else {
      r.offsetError = null;
      r.offset = off;
    }
  }

  // ---- 引入线、引出线、连接桥 ----
  for (const r of rings) {
    if (r.offsetError) continue;
    const cands = leadCandidates(r, r.offset);
    const scored = cands.map((c) => {
      const lead = buildLead(r, c, paramsWithRegions, rings, leadClearZones);
      return { c, lead, key: c.edgeIndex * 10 + Math.round(c.edgeT * 1000) };
    }).sort((a, b) => {
      const ao = a.lead.ok ? 0 : 1, bo = b.lead.ok ? 0 : 1;
      return ao - bo || a.key - b.key;
    });

    const good = scored.find((s) => s.lead.ok);
    if (!good) {
      const first = scored[0];
      const reasons = {
        'lead-zone': '所有候选引入线均穿过禁止穿越区（含刀具半径余量），无法安全下刀',
        'lead-material': '所有候选引入线均穿过尚未切开的实体材料，无法安全下刀',
        'lead-not-in-region': '没有任何引入点的起刀位置在指定的起刀候选区域内，无法下刀',
      };
      r.leadError = { code: 'LEAD_BLOCKED', message: reasons[first.lead.reason], point: first.c.point };
      r.leadPoly = first.lead.poly;
      continue;
    }
    r.leadPoly = good.lead.poly;
    r.leadStart = good.lead.start;
    r.leadEnd = good.lead.end;
    r.leadEdge = good.c.edgeIndex;
    r.leadEdgeT = good.c.edgeT;
    r.leadType = params.leadType;
    r.leadOutPoly = [...good.lead.poly].reverse();
    r.leadOutEnd = r.leadOutPoly[r.leadOutPoly.length - 1];

    const br = placeBridges(r, r.offset, params, { edgeIndex: good.c.edgeIndex, edgeT: good.c.edgeT });
    r.bridges = br.placed;
    r.bridgeReport = br;
  }

  // 父外环失效 ⇒ 子洞不可加工（继承错误，不输出路径）
  const byId0 = new Map(rings.map((r) => [r.id, r]));
  for (const r of rings) {
    if (r.parent && byId0.get(r.parent)?.offsetError && !r.offsetError) {
      const p = byId0.get(r.parent);
      r.inheritedError = {
        code: 'PARENT_INVALID',
        message: `包含它的外环“${p.name}”补偿失败（${p.offsetError.code}），该轮廓不输出加工路径`,
      };
    }
  }

  // ---- 加工次序（真实绕行空移代价的最近邻 + 先内后外约束）----
  const home = input.home || { x: 0, y: 0 };
  const candidates = rings.filter((r) => !r.offsetError && !r.inheritedError && !r.leadError && r.leadStart);

  // 目标环的“祖先外环”集合（包含它的所有外环）：通往内部洞/岛时这些外环是必经跨越，
  // 其余未切割外轮廓都作为抬刀空移必须绕行的实体。
  const ancestorOuters = (target) => {
    const set = new Set();
    let cur = target;
    while (cur.parent) {
      const p = byId0.get(cur.parent);
      if (!p) break;
      if (p.kind === 'outer') set.add(p.id);
      cur = p;
    }
    return set;
  };
  const solidsFor = (target) => rings.filter((r) =>
    r.kind === 'outer' && !r.offsetError && !ancestorOuters(target).has(r.id));

  const pairCache = new Map();
  // “已加工完毕位置 → 下一环引入起点”的抬刀绕行计划：避禁穿区 + 避未切其它实体
  const planPair = (from, toId) => {
    const key = `p:${fmt(from.x)},${fmt(from.y)}→${toId}`;
    if (pairCache.has(key)) return pairCache.get(key);
    const to = byId0.get(toId);
    const plan = planRapidStrict(from, to.leadStart, noCross, params, solidsFor(to));
    pairCache.set(key, plan);
    return plan;
  };
  // home 起点可达性（实体障碍：未切的其它独立外轮廓）
  const reachable = new Set();
  for (const r of candidates) {
    const p = planRapidStrict(home, r.leadStart, noCross, params, solidsFor(r));
    if (!p.blocked) reachable.add(r.id);
  }
  // 从任意其它候选环（出口）可达
  for (const r of candidates) {
    if (reachable.has(r.id)) continue;
    for (const o of candidates) {
      if (o.id === r.id) continue;
      const p = planPair(o.leadOutEnd, r.id);
      if (!p.blocked) { reachable.add(r.id); break; }
    }
  }
  for (const r of candidates) {
    if (!reachable.has(r.id)) {
      r.rapidError = {
        code: 'RAPID_BLOCKED',
        message: '从安全起点及其它任何已加工位置都无法在不穿越禁止穿越区的前提下抬刀到达该轮廓的引入点（禁穿区可能形成封闭包围），不输出该轮廓路径',
      };
    }
  }

  const machinable = candidates.filter((r) => reachable.has(r.id));
  const costFn = (from, toId) => {
    const p = planPair(from, toId);
    return p.blocked ? Infinity : p.length;
  };
  const seq = buildSequence(machinable, home, costFn);
  const sequenceIds = seq.order;
  const machById = new Map(machinable.map((r) => [r.id, r]));

  // ---- 段生成（编号在最终确定的加工顺序上分配）----
  const segments = [];
  let segNo = 1;
  let cur = home;
  const totals = { cut: 0, rapid: 0, lead: 0, bridgeJump: 0, count: 0 };
  const rapidPlans = [];

  const homeCache = new Map();
  const planHome = (r) => {
    if (!homeCache.has(r.id)) {
      homeCache.set(r.id, planRapidStrict(home, r.leadStart, noCross, params, solidsFor(r)));
    }
    return homeCache.get(r.id);
  };

  for (const id of sequenceIds) {
    const r = machById.get(id);
    // 排序阶段保证可达；此处取出与排序时相同的绕行计划（代价一致 ⇒ 编号确定）
    const fromHome = cur === home;
    const rapid = fromHome ? planHome(r) : planPair(cur, id);
    rapidPlans.push({ from: cur, to: r.leadStart, ...rapid, ringId: r.id });
    segments.push(mkSeg(segNo++, 'RAPID', 'RAPID', rapid.poly, rapid.length, r,
      rapid.detour ? { detour: true } : {}));
    totals.rapid += rapid.length;

    segments.push(mkSeg(segNo++, 'LEAD_IN', 'CUT', r.leadPoly, polyLen(r.leadPoly), r, { edgeIndex: r.leadEdge }));
    totals.lead += polyLen(r.leadPoly);
    totals.cut += polyLen(r.leadPoly);

    const cutSegs = buildCutSegments(r, segNo);
    for (const s of cutSegs) {
      segments.push(s);
      segNo++;
      if (s.type === 'BRIDGE_JUMP') { totals.bridgeJump += s.length; totals.rapid += s.length; }
      else totals.cut += s.length;
    }

    segments.push(mkSeg(segNo++, 'LEAD_OUT', 'CUT', r.leadOutPoly, polyLen(r.leadOutPoly), r, { edgeIndex: r.leadEdge }));
    totals.lead += polyLen(r.leadOutPoly);
    totals.cut += polyLen(r.leadOutPoly);
    cur = r.leadOutEnd;
  }
  totals.count = segments.length;

  const verification = verifyAll({ rings, params, sequenceIds, segments, totals, noCross });

  return { params, zones, rings, sequenceIds, segments, totals, rapidPlans, verification, blockedRings: seq.blocked, home };
}

function centroid(ring) {
  let cx = 0, cy = 0;
  for (const p of ring) { cx += p.x; cy += p.y; }
  return { x: cx / ring.length, y: cy / ring.length };
}

function mkSeg(no, type, cls, poly, length, ring, extra = {}) {
  return {
    no, type, cls,
    points: poly, from: poly[0], to: poly[poly.length - 1],
    length, ringId: ring.id, ringName: ring.name, ...extra,
  };
}

// 从引入点起沿补偿环切一周；桥的位置切分为 CUT / BRIDGE_JUMP
function buildCutSegments(r, startNo) {
  const segs = [];
  let no = startNo;
  const pts = r.offset.points;
  let startIdx = 0;
  let bestD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const dd = V.dist(pts[i], r.leadEnd);
    if (dd < bestD) { bestD = dd; startIdx = i; }
  }
  const order = [];
  for (let k = 0; k <= pts.length; k++) order.push(pts[(startIdx + k) % pts.length]);

  // 展开坐标（从起点起的环向弧长）
  const cum = [0];
  for (let k = 0; k < order.length - 1; k++) cum.push(cum[k] + V.dist(order[k], order[k + 1]));

  const marks = (r.bridges || []).map((b) => {
    let best = null;
    for (let k = 0; k < order.length - 1; k++) {
      const ab = V.sub(order[k + 1], order[k]);
      const l2 = V.dot(ab, ab);
      let t = l2 > 1e-14 ? V.dot(V.sub(b.from, order[k]), ab) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const q = V.lerp(order[k], order[k + 1], t);
      const dist = V.dist(b.from, q);
      if (!best || dist < best.dist) best = { k, t, dist };
    }
    return best ? { at: cum[best.k] + best.t * (cum[best.k + 1] - cum[best.k]), b } : null;
  }).filter(Boolean).sort((a, b) => a.at - b.at);

  const emit = (type, pts2, extra) => {
    segs.push(mkSeg(no++, type, type === 'CUT' ? 'CUT' : 'RAPID', pts2, polyLen(pts2), r, extra));
  };

  for (let k = 0; k < order.length - 1; k++) {
    const a = order[k], b = order[k + 1];
    const segLen = cum[k + 1] - cum[k];
    const local = marks
      .filter((m) => m.at >= cum[k] - 1e-7 && m.at <= cum[k + 1] + 1e-7)
      .map((m) => {
        const tC = segLen > 1e-12 ? (m.at - cum[k]) / segLen : 0;
        const half = segLen > 1e-12 ? (m.b.width / 2) / segLen : 0;
        return [Math.max(0, tC - half), Math.min(1, tC + half), m.b];
      })
      .sort((x, y) => x[0] - y[0]);
    let t0 = 0;
    for (const [t1, t2, br] of local) {
      if (t1 > t0 + 1e-9) emit('CUT', [V.lerp(a, b, t0), V.lerp(a, b, t1)]);
      emit('BRIDGE_JUMP', [V.lerp(a, b, t1), V.lerp(a, b, t2)], { bridge: br });
      t0 = t2;
    }
    if (t0 < 1 - 1e-9) emit('CUT', [V.lerp(a, b, t0), b]);
  }
  return segs;
}

/* ============================ 导出前复核 ============================ */

function distPointToSeg(p, a, b) {
  const ab = V.sub(b, a);
  const l2 = V.dot(ab, ab);
  if (l2 < 1e-14) return V.dist(p, a);
  let t = V.dot(V.sub(p, a), ab) / l2;
  t = Math.max(0, Math.min(1, t));
  return V.dist(p, V.lerp(a, b, t));
}

// 点到直线（非线段）的垂直距离
function perpToLine(p, a, b) {
  const ab = V.sub(b, a);
  const l2 = V.dot(ab, ab);
  if (l2 < 1e-14) return V.dist(p, a);
  return Math.abs(V.cross(ab, V.sub(p, a))) / Math.sqrt(l2);
}

function verifyAll(ctx) {
  const { rings, params, sequenceIds, segments, totals, noCross } = ctx;
  const checks = [];
  const add = (id, ok, detail, fatal = true) => checks.push({ id, ok, detail, fatal });
  const d = params.toolDiameter / 2;

  // 1) 补偿距离复核
  let offsetOk = true;
  const offsetBad = [];
  for (const r of rings) {
    if (r.offsetError || r.inheritedError || !r.offset) continue;
    for (const sp of r.offset.spans) {
      if (sp.type !== 'line') continue;
      const a = r.points[sp.edgeIndex];
      const b = r.points[(sp.edgeIndex + 1) % r.points.length];
      // 补偿直线应与原边共线平行；测端点到原边“支撑直线”的垂直距离（斜接角点到边段钳制距离会是 d/cos）
      const d1 = perpToLine(sp.from, a, b);
      const d2 = perpToLine(sp.to, a, b);
      if (Math.abs(d1 - d) > 1e-4 || Math.abs(d2 - d) > 1e-4) {
        offsetOk = false; offsetBad.push(r.name); break;
      }
      // 方向平行
      const eDir = V.norm(V.sub(b, a));
      const oDir = V.norm(V.sub(sp.to, sp.from));
      if (Math.abs(V.dot(eDir, oDir)) < 1 - 1e-6) { offsetOk = false; offsetBad.push(r.name); break; }
    }
  }
  add('OFFSET_DISTANCE', offsetOk, offsetOk
    ? `全部有效轮廓刀具中心到原轮廓的距离 = 刀半径 ${d.toFixed(3)} mm`
    : `补偿距离与刀半径不符：${[...new Set(offsetBad)].join('、')}`);

  // 2) 无补偿失效轮廓
  const fatalRings = rings.filter((r) => r.offsetError);
  add('NO_INVALID_OFFSET', fatalRings.length === 0,
    fatalRings.length
      ? `存在补偿失效轮廓，禁止导出：${fatalRings.map((r) => `${r.name}[${r.offsetError.code}]`).join('、')}`
      : '无补偿失效轮廓（窄槽消失/自交/洞被吞并均不存在）');

  // 3) 轮廓先后关系：洞先于父外环
  let orderOk = true;
  const orderBad = [];
  const byId = new Map(rings.map((r) => [r.id, r]));
  for (const r of rings) {
    if (r.parent && sequenceIds.includes(r.id) && sequenceIds.includes(r.parent)) {
      if (sequenceIds.indexOf(r.id) > sequenceIds.indexOf(r.parent)) {
        orderOk = false;
        orderBad.push(`${r.name} 晚于其父外环 ${byId.get(r.parent).name}`);
      }
    }
  }
  add('CONTOUR_ORDER', orderOk, orderOk
    ? '所有内部轮廓均先于包含它的外部轮廓加工（先洞后外圈）'
    : orderBad.join('；'));

  // 4) 穿越关系：空移/引入/引出不穿禁穿区（引入/引出含刀半径余量）；引入线不穿未切实体
  let crossOk = true;
  const crossBad = [];
  const d2 = params.toolDiameter / 2;
  const leadClearZones2 = (noCross || []).map((z) => ({ ...z, points: inflateRect(z.points, d2 + 0.25) }));
  for (const s of segments) {
    if (s.type === 'CUT' || s.type === 'BRIDGE_JUMP') continue;
    const zonesForSeg = (s.type === 'LEAD_IN' || s.type === 'LEAD_OUT') ? leadClearZones2 : (noCross || []);
    const z = polylineHitsZones(s.points, zonesForSeg);
    if (z) { crossOk = false; crossBad.push(`段 ${s.no}（${s.ringName}）穿过禁穿区“${z.zone.name}”`); }
    // 抬刀空移还不得穿过尚未切开的其它独立实体（端点在实体内部=通往内部轮廓的必要跨越，放行）
    if (s.type === 'RAPID') {
      for (const o of rings) {
        if (o.kind !== 'outer' || o.offsetError || o.id === s.ringId) continue;
        for (let k = 0; k < s.points.length - 1; k++) {
          const a = s.points[k], b = s.points[k + 1];
          if (pointInRing(a, o.points) === 1 || pointInRing(b, o.points) === 1) continue;
          if (segCrossesRing(a, b, o.points)) {
            crossOk = false; crossBad.push(`段 ${s.no}（${s.ringName}）抬刀空移穿过尚未切开的实体“${o.name}”`);
            break;
          }
        }
      }
    }
  }
  for (const r of rings) {
    if (!r.leadPoly || r.offsetError || r.inheritedError) continue;
    if (polylineHitsMaterial(r.leadPoly, rings, null)) {
      crossOk = false; crossBad.push(`${r.name} 引入线穿过尚未切开的实体`);
    }
    if (r.leadError) { crossOk = false; crossBad.push(`${r.name}: ${r.leadError.message}`); }
    if (r.rapidError) { crossOk = false; crossBad.push(`${r.name}: ${r.rapidError.message}`); }
  }
  add('NO_CROSSING', crossOk, crossOk
    ? '引入线、引出线与抬刀空移均未穿过禁止穿越区；空移未穿过尚未切开的独立实体；引入线未穿实体'
    : crossBad.join('；'));

  // 5) 桥位合法性（位置错误=致命；数量不足=警告，已在轮廓上报告缺口）
  let bridgeOk = true;
  const bridgeBad = [];
  for (const r of rings) {
    if (!r.bridges || r.offsetError || r.inheritedError) continue;
    for (const b of r.bridges) {
      const sp = r.offset.spans.find((x) => x.type === 'line' && x.edgeIndex === b.edgeIndex);
      if (!sp) { bridgeOk = false; bridgeBad.push(`${r.name} 存在不在直线段上的桥`); continue; }
      const dir = V.norm(V.sub(sp.to, sp.from));
      const tFrom = V.dot(V.sub(b.from, sp.from), dir);
      const tTo = V.dot(V.sub(b.to, sp.from), dir);
      if (Math.min(tFrom, sp.len - tTo) < params.bridgeCornerClear - 1e-6) {
        bridgeOk = false; bridgeBad.push(`${r.name} 桥距尖角不足 ${params.bridgeCornerClear}`);
      }
      if (sp.edgeIndex === r.leadEdge) {
        const lp = r.leadEdgeT * sp.len;
        if (Math.abs((tFrom + tTo) / 2 - lp) < params.bridgeLeadGuard + b.width / 2) {
          bridgeOk = false; bridgeBad.push(`${r.name} 桥距引入线不足 ${params.bridgeLeadGuard}`);
        }
      }
    }
  }
  add('BRIDGE_LEGAL', bridgeOk, bridgeOk
    ? '全部连接桥位于合法直线段，避开尖角与引入线'
    : bridgeBad.join('；'));

  // 6) 长度对账
  const sumCut = segments.filter((s) => s.cls === 'CUT').reduce((a, s) => a + s.length, 0);
  const sumRapid = segments.filter((s) => s.cls === 'RAPID').reduce((a, s) => a + s.length, 0);
  const lenOk = Math.abs(sumCut - totals.cut) < 1e-6 && Math.abs(sumRapid - totals.rapid) < 1e-6;
  add('LENGTH_AUDIT', lenOk,
    `逐段合计 切割 ${sumCut.toFixed(3)} / 统计 ${totals.cut.toFixed(3)}；空移 ${sumRapid.toFixed(3)} / 统计 ${totals.rapid.toFixed(3)}（${lenOk ? '一致' : '不一致'}）`);

  const exportBlocked = checks.some((c) => !c.ok && c.fatal);
  return { checks, exportBlocked, failCount: checks.filter((c) => !c.ok).length };
}

/* ============================ 导出文本（确定性） ============================ */

function exportToolpathText(result, meta = {}) {
  const { params, segments, sequenceIds, rings, totals, verification } = result;
  const lines = [];
  const f = (v) => v.toFixed(3);
  const safeZ = f(meta.safeZ ?? 10);
  const cutZ = f(meta.cutZ ?? -1);

  lines.push('; ===================================================');
  lines.push('; CNC 切割刀路文件（刀路生成页面导出，内容确定性：同参数同图形完全一致）');
  lines.push(`; 指纹: ${meta.fingerprint || 'manual'}`);
  lines.push(`; 刀具直径: ${f(params.toolDiameter)} mm`);
  lines.push(`; 加工侧: ${params.machiningSide === 'left' ? '手动左补偿（材料侧）' : '自动：外轮廓向外 / 洞向内（统一右向补偿）'}`);
  lines.push(`; 切入方式: ${params.leadType === 'arc' ? '切向圆弧 90°' : '垂直直线'}  引入长度 ${f(params.leadLength)}`);
  lines.push(`; 连接桥: 宽 ${f(params.bridgeWidth)} 请求 ${params.bridgeCount} 尖角保护 ${f(params.bridgeCornerClear)} 引入保护 ${f(params.bridgeLeadGuard)}`);
  lines.push(`; 加工轮廓次序: ${sequenceIds.map((id, i) => `${i + 1}.${rings.find((r) => r.id === id)?.name || id}`).join('  ')}`);
  lines.push('; ===================================================');

  if (verification.exportBlocked) {
    lines.push('; *** 导出已阻止：导出前复核未通过，本文件不含任何加工指令 ***');
    for (const c of verification.checks) {
      if (!c.ok) lines.push(`; [FAIL] ${c.id}: ${c.detail}`);
    }
    lines.push('; ===================================================');
    return lines.join('\n');
  }

  lines.push('G21 ; 毫米');
  lines.push('G90 ; 绝对坐标');
  lines.push(`G00 Z${safeZ} ; 安全高度`);

  for (const s of segments) {
    const tag = {
      RAPID: '抬刀空移', LEAD_IN: '引入线', CUT: '切割',
      BRIDGE_JUMP: '连接桥抬刀跳过', LEAD_OUT: '引出线',
    }[s.type] || s.type;
    lines.push(`; --- N${String(s.no).padStart(4, '0')} [${tag}] 轮廓=${s.ringName} 长度=${f(s.length)}${s.bridge ? ' 桥宽=' + f(s.bridge.width) : ''}`);
    if (s.cls === 'RAPID') {
      lines.push(`G00 Z${safeZ}`);
      lines.push(`G00 X${f(s.to.x)} Y${f(s.to.y)}`);
      if (s.type === 'RAPID') lines.push(`G00 Z${cutZ} ; 下刀`);
    } else {
      for (let i = 1; i < s.points.length; i++) {
        lines.push(`G01 X${f(s.points[i].x)} Y${f(s.points[i].y)}`);
      }
    }
  }
  lines.push(`G00 Z${safeZ}`);
  lines.push('; ===================================================');
  lines.push(`; 路径段总数: ${segments.length}`);
  lines.push(`; 总切割长度: ${f(totals.cut)} mm（含引入/引出 ${f(totals.lead)}）`);
  lines.push(`; 总空移长度: ${f(totals.rapid)} mm（含连接桥跳过 ${f(totals.bridgeJump)}）`);
  const reports = rings.filter((r) => r.bridgeReport && r.bridgeReport.missing > 0)
    .map((r) => `${r.name} 请求${r.bridgeReport.requested}/实放${r.bridgeReport.placedCount}/缺${r.bridgeReport.missing}`);
  if (reports.length) lines.push(`; 连接桥缺口报告: ${reports.join('；')}`);
  lines.push('; 复核: ' + verification.checks.map((c) => `${c.id}=${c.ok ? 'PASS' : 'FAIL'}`).join('  '));
  lines.push('; ===================================================');
  return lines.join('\n');
}

function pointsY(s, i) { return s.points[i].y; }

/* ============================ 导出 API ============================ */

const api = {
  V, roundKey, signedArea, isCCW, orientRing, dedupeRing,
  pointInRing, pointOnSegment, segIntersect, segCrossesRing,
  normalizeInput, geometryKey, findSlotCollisions, offsetRing, offsetSelfIntersects,
  polylineHitsMaterial, polylineHitsZones, pointInMaterial,
  buildLead, leadCandidates, placeBridges, buildSequence,
  computeToolpath, verifyAll, exportToolpathText, normalizeParams,
  inflateRect, planRapidStrict, polyLen, centroid,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.CAM = api;
if (typeof globalThis !== 'undefined' && typeof window === 'undefined') globalThis.CAM = api;
