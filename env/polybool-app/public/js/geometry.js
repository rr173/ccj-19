// geometry.js — 纯几何基础函数。坐标系为屏幕坐标（y 向下），所有函数与坐标系朝向无关，
// 仅 shoelaceArea 的符号约定受影响：屏幕坐标下顺时针环面积为负。

export const nearly = (a, b, eps) => Math.abs(a - b) <= eps;

export function dist(p, q) {
  return Math.hypot(p[0] - q[0], p[1] - q[1]);
}

export function dist2(p, q) {
  const dx = p[0] - q[0], dy = p[1] - q[1];
  return dx * dx + dy * dy;
}

/** 鞋带公式面积。屏幕坐标（y 向下）：顺时针为负，逆时针为正。 */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function ringCentroid(ring) {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    const w = x1 * y2 - x2 * y1;
    a += w;
    cx += (x1 + x2) * w;
    cy += (y1 + y2) * w;
  }
  if (Math.abs(a) < 1e-18) {
    // 退化环：退化为顶点均值
    const n = ring.length || 1;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  a /= 2;
  return [cx / (6 * a), cy / (6 * a)];
}

/** 点到线段的最短距离及最近点参数 t∈[0,1] */
export function pointSegDist(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = p[0] - a[0], wy = p[1] - a[1];
  const len2 = vx * vx + vy * vy;
  let t = len2 === 0 ? 0 : (wx * vx + wy * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = a[0] + t * vx, qy = a[1] + t * vy;
  return { d: Math.hypot(p[0] - qx, p[1] - qy), t, point: [qx, qy] };
}

/** 点是否在线段上（容差 eps） */
export function pointOnSegment(p, a, b, eps) {
  const { d, t } = pointSegDist(p, a, b);
  return d <= eps && t >= 0 && t <= 1;
}

// 参数 t/u 的容差（无量纲，[0,1] 区间），与几何容差 eps（世界单位）严格分离
const PARAM_TOL = 1e-9;

/**
 * 线段 p1p2 与 p3p4 相交测试。
 * eps 为几何容差（世界单位），仅用于共线距离与重叠长度判定；
 * 参数 t/u 的区间与"严格穿越"判定使用固定的 PARAM_TOL。
 * 返回 null 或 {point, proper} — proper=true 表示严格穿越（非端点触碰）。
 */
export function segmentsIntersect(p1, p2, p3, p4, eps = 1e-9) {
  const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
  const denom = d1x * d2y - d1y * d2x;
  const ex = p3[0] - p1[0], ey = p3[1] - p1[1];

  if (Math.abs(denom) < 1e-18) {
    // 平行或共线：检查共线重叠
    if (Math.abs(ex * d1y - ey * d1x) > eps * Math.max(1, Math.hypot(d1x, d1y))) return null;
    // 共线：投影到主轴求重叠区间
    const useX = Math.abs(d1x) >= Math.abs(d1y);
    const a1 = useX ? p1[0] : p1[1], a2 = useX ? p2[0] : p2[1];
    const b1 = useX ? p3[0] : p3[1], b2 = useX ? p4[0] : p4[1];
    const lo = Math.max(Math.min(a1, a2), Math.min(b1, b2));
    const hi = Math.min(Math.max(a1, a2), Math.max(b1, b2));
    if (lo > hi + eps) return null;
    const mid = (Math.max(lo, Math.min(a1, a2)) + Math.min(hi, Math.max(a1, a2))) / 2;
    const t = Math.abs(d1x) >= Math.abs(d1y)
      ? (Math.abs(d1x) < 1e-18 ? 0 : (mid - p1[0]) / d1x)
      : (Math.abs(d1y) < 1e-18 ? 0 : (mid - p1[1]) / d1y);
    const pt = [p1[0] + t * d1x, p1[1] + t * d1y];
    return { point: pt, proper: false, collinear: true, overlap: hi - lo };
  }
  const t = (ex * d2y - ey * d2x) / denom;
  const u = (ex * d1y - ey * d1x) / denom;
  if (t < -PARAM_TOL || t > 1 + PARAM_TOL || u < -PARAM_TOL || u > 1 + PARAM_TOL) return null;
  const tc = Math.max(0, Math.min(1, t));
  return {
    point: [p1[0] + tc * d1x, p1[1] + tc * d1y],
    proper: t > PARAM_TOL && t < 1 - PARAM_TOL && u > PARAM_TOL && u < 1 - PARAM_TOL,
    collinear: false,
  };
}

/** 射线法点在环内测试。返回 'in' | 'out' | 'on'（边界上，容差 eps）。 */
export function pointInRing(ring, p, eps = 1e-9) {
  // 先查边界
  for (let i = 0, n = ring.length; i < n; i++) {
    if (pointOnSegment(p, ring[i], ring[(i + 1) % n], eps)) return 'on';
  }
  let inside = false;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) &&
        p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside ? 'in' : 'out';
}

/** 环自交检测（跳过相邻边）。返回交点列表 [{i, j, point}]，i<j 为边索引。 */
export function ringSelfIntersections(ring, eps = 1e-9) {
  const n = ring.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a1 = ring[i], a2 = ring[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // 相邻边共享顶点，跳过（含首尾边相邻）
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      const b1 = ring[j], b2 = ring[(j + 1) % n];
      const hit = segmentsIntersect(a1, a2, b1, b2, eps);
      if (hit) out.push({ i, j, point: hit.point, proper: hit.proper });
    }
  }
  return out;
}

/** 两环之间的相交情况：{crossings:[...], touches:[...]} */
export function ringRingIntersections(r1, r2, eps = 1e-9) {
  const crossings = [], touches = [];
  for (let i = 0, n = r1.length; i < n; i++) {
    const a1 = r1[i], a2 = r1[(i + 1) % n];
    for (let j = 0, m = r2.length; j < m; j++) {
      const b1 = r2[j], b2 = r2[(j + 1) % m];
      const hit = segmentsIntersect(a1, a2, b1, b2, eps);
      if (!hit) continue;
      (hit.proper ? crossings : touches).push({ i, j, point: hit.point, collinear: !!hit.collinear, overlap: hit.overlap || 0 });
    }
  }
  return { crossings, touches };
}

/** 环内重复顶点（同一坐标出现多次，容差 eps）→ pinch 检测 */
export function repeatedVertices(ring, eps) {
  const seen = [];
  const dups = [];
  for (let i = 0; i < ring.length; i++) {
    for (let j = 0; j < seen.length; j++) {
      if (dist(ring[i], ring[seen[j]]) <= eps) {
        dups.push({ i, j: seen[j], point: ring[i] });
        break;
      }
    }
    seen.push(i);
  }
  return dups;
}

// ---------- 仿射变换（作用于整个 MultiPolygon，保持外轮廓/洞关系） ----------

export function translateGeom(geom, dx, dy) {
  return geom.map(poly => poly.map(ring => ring.map(([x, y]) => [x + dx, y + dy])));
}

export function rotateGeom(geom, angleRad, pivot) {
  const c = Math.cos(angleRad), s = Math.sin(angleRad);
  const [px, py] = pivot;
  return geom.map(poly => poly.map(ring => ring.map(([x, y]) => {
    const dx = x - px, dy = y - py;
    return [px + dx * c - dy * s, py + dx * s + dy * c];
  })));
}

export function scaleGeom(geom, k, pivot) {
  const [px, py] = pivot;
  return geom.map(poly => poly.map(ring => ring.map(([x, y]) => [px + (x - px) * k, py + (y - py) * k])));
}

export function geomBBox(geom) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of geom) for (const ring of poly) for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

export function geomCentroid(geom) {
  // 面积加权质心（洞取负面积）
  let cx = 0, cy = 0, total = 0;
  for (const poly of geom) {
    poly.forEach((ring, idx) => {
      const a = ringArea(ring);
      const signed = idx === 0 ? Math.abs(a) : -Math.abs(a);
      const c = ringCentroid(ring);
      cx += c[0] * signed; cy += c[1] * signed; total += signed;
    });
  }
  if (Math.abs(total) < 1e-18) {
    const bb = geomBBox(geom);
    return bb ? [(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2] : [0, 0];
  }
  return [cx / total, cy / total];
}

export function geomArea(geom) {
  let total = 0;
  for (const poly of geom) {
    poly.forEach((ring, idx) => {
      total += (idx === 0 ? 1 : -1) * Math.abs(ringArea(ring));
    });
  }
  return total;
}

export function deepCopyGeom(geom) {
  return geom.map(poly => poly.map(ring => ring.map(p => [p[0], p[1]])));
}
