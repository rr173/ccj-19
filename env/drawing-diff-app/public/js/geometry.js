// geometry.js — 纯几何基础。世界坐标（单位由图纸自带，配准前不假设朝向）。

export const TAU = Math.PI * 2;

export function dist(p, q) {
  return Math.hypot(p[0] - q[0], p[1] - q[1]);
}

export function dist2(p, q) {
  const dx = p[0] - q[0], dy = p[1] - q[1];
  return dx * dx + dy * dy;
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 鞋带公式有向面积。 */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** 环总长。 */
export function ringLength(ring) {
  let l = 0;
  for (let i = 0, n = ring.length; i < n; i++) l += dist(ring[i], ring[(i + 1) % n]);
  return l;
}

/** 面积加权（多边形）质心；退化时退化为顶点均值。 */
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
    const n = ring.length || 1;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  a /= 2;
  return [cx / (6 * a), cy / (6 * a)];
}

/** 轴对齐包围盒 {minX,minY,maxX,maxY}。 */
export function boundsOf(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function boundsSize(b) {
  return Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
}

/** 点到线段最短距离。 */
export function pointSegDist(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = p[0] - a[0], wy = p[1] - a[1];
  const len2 = vx * vx + vy * vy;
  let t = len2 === 0 ? 0 : (wx * vx + wy * vy) / len2;
  t = clamp(t, 0, 1);
  return { d: Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy)), t };
}

/** 射线法点在简单多边形内（'in' / 'out' / 'on'）。 */
export function pointInRing(ring, p, eps = 1e-9) {
  for (let i = 0, n = ring.length; i < n; i++) {
    if (pointSegDist(p, ring[i], ring[(i + 1) % n]).d <= eps) return 'on';
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

/** 沿闭合多边形周长等弧长采样 n 个点（返回 n 个）。 */
export function sampleRing(ring, n) {
  const edges = [];
  let total = 0;
  for (let i = 0, m = ring.length; i < m; i++) {
    const a = ring[i], b = ring[(i + 1) % m];
    const l = dist(a, b);
    edges.push([a, b, l]);
    total += l;
  }
  const out = [];
  let ei = 0;
  for (let k = 0; k < n; k++) {
    let target = (total * k) / n;
    while (ei < edges.length - 1 && target > edges[ei][2]) {
      target -= edges[ei][2];
      ei++;
    }
    const [a, b, l] = edges[ei];
    const t = l === 0 ? 0 : clamp(target / l, 0, 1);
    out.push([lerp(a[0], b[0], t), lerp(a[1], b[1], t)]);
  }
  return out;
}

/** 沿开放折线等弧长采样 n 个点（返回 n 个，含两个端点）。 */
export function samplePolyline(points, n) {
  if (n <= 1) return [points[0]];
  const edges = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const l = dist(a, b);
    edges.push([a, b, l]);
    total += l;
  }
  const out = [];
  let ei = 0;
  for (let k = 0; k < n; k++) {
    let target = (total * k) / (n - 1);
    while (ei < edges.length - 1 && target > edges[ei][2]) {
      target -= edges[ei][2];
      ei++;
    }
    const [a, b, l] = edges[ei];
    const t = l === 0 ? 0 : clamp(target / l, 0, 1);
    out.push([lerp(a[0], b[0], t), lerp(a[1], b[1], t)]);
  }
  return out;
}

/**
 * 双向 Chamfer 距离（平均最近点距离），对起点/遍历方向无关。
 * 通过对 B 点集做循环移位搜索最优对齐，消除轮廓采样起点差异。
 */
export function chamferClosed(samplesA, samplesB) {
  const n = Math.min(samplesA.length, samplesB.length);
  const A = samplesA, B = samplesB;
  let best = Infinity;
  for (let shift = 0; shift < B.length; shift++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      let nearest = Infinity;
      const ai = A[i];
      for (let j = 0; j < B.length; j++) {
        const d = dist2(ai, B[(j + shift) % B.length]);
        if (d < nearest) nearest = d;
      }
      sum += Math.sqrt(nearest);
    }
    for (let j = 0; j < B.length; j++) {
      let nearest = Infinity;
      const bj = B[(j + shift) % B.length];
      for (let i = 0; i < n; i++) {
        const d = dist2(bj, A[i]);
        if (d < nearest) nearest = d;
      }
      sum += Math.sqrt(nearest);
    }
    const mean = sum / (n + B.length);
    if (mean < best) best = mean;
  }
  return best;
}

/** 开放折线的双向 Chamfer（不做循环移位），并取反向的较小者。 */
export function chamferOpen(samplesA, samplesB) {
  const oneWay = (P, Q) => {
    let sum = 0;
    for (const p of P) {
      let nearest = Infinity;
      for (const q of Q) {
        const d = dist2(p, q);
        if (d < nearest) nearest = d;
      }
      sum += Math.sqrt(nearest);
    }
    return sum / P.length;
  };
  const forward = oneWay(samplesA, samplesB) + oneWay(samplesB, samplesA);
  const Brev = [...samplesB].reverse();
  const backward = oneWay(samplesA, Brev) + oneWay(Brev, samplesA);
  return Math.min(forward, backward) / 2;
}

/** 弧度差归一化到 [-π, π]。 */
export function angleDiff(a, b) {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** 向量方位角。 */
export function heading(p, q) {
  return Math.atan2(q[1] - p[1], q[0] - p[0]);
}

/**
 * 网格采样估计一个简单多边形的面积：在包围盒内撒 grid×grid 点阵，
 * 统计落在多边形内/边界上的点数。用于重叠面积的零依赖近似计算。
 */
export function gridSamplePoints(ring, grid) {
  const b = boundsOf(ring);
  const pts = [];
  const padX = (b.maxX - b.minX) * 0 + 0;
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      pts.push([
        b.minX + ((i + 0.5) / grid) * (b.maxX - b.minX || 1e-9) + padX,
        b.minY + ((j + 0.5) / grid) * (b.maxY - b.minY || 1e-9),
      ]);
    }
  }
  return { b, pts };
}
