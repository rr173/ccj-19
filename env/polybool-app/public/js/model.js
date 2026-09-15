// model.js — MultiPolygon 数据模型与规范化。
//
// 数据模型：MultiPolygon = Polygon[]；Polygon = Ring[]（index 0 为外轮廓，其余为洞）；
// Ring = [[x,y], ...]（开放环，不重复末点）。
// 规范化约定（CANONICAL）：
//   - 屏幕坐标（y 向下）下，外轮廓面积为负（顺时针），洞面积为正（逆时针）；
//   - 每个环从字典序最小顶点开始，便于稳定哈希；
//   - 外轮廓按 |面积| 降序排列，洞同理；
//   - 环按包含奇偶性分类：被偶数个环包含 → 外轮廓，奇数 → 洞（洞的洞 = 岛，提升为外轮廓）。

import { ringArea, pointInRing, dist, repeatedVertices } from './geometry.js';

export const OUTER_SIGN = -1; // 屏幕坐标下外轮廓的规范面积符号

let shapeSeq = 0;
export function nextShapeId() {
  return `shape-${++shapeSeq}-${Date.now().toString(36)}`;
}

export function makeShape(name, geom, color) {
  return { id: nextShapeId(), name, geom, color };
}

/** 去除环上连续重复点（距离 <= eps 视为同点）。点为深拷贝，调用方可安全修改返回的环。 */
export function dedupeRing(ring, eps) {
  const removed = [];
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    if (out.length && dist(out[out.length - 1], p) <= eps) {
      removed.push({ index: i, point: p });
      continue;
    }
    out.push([p[0], p[1]]);
  }
  // 首尾闭合检查
  while (out.length > 1 && dist(out[0], out[out.length - 1]) <= eps) {
    removed.push({ index: -1, point: out[out.length - 1] });
    out.pop();
  }
  return { ring: out, removed };
}

/** 去除近共线点（到前后点连线距离 <= eps）。 */
export function removeCollinear(ring, eps) {
  if (ring.length < 3) return { ring, removed: [] };
  const removed = [];
  let pts = ring.slice();
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[(i - 1 + pts.length) % pts.length];
      const cur = pts[i];
      const next = pts[(i + 1) % pts.length];
      const vx = next[0] - prev[0], vy = next[1] - prev[1];
      const len = Math.hypot(vx, vy);
      const d = len < 1e-18 ? dist(prev, cur)
        : Math.abs((cur[0] - prev[0]) * vy - (cur[1] - prev[1]) * vx) / len;
      if (d <= eps && len > eps) {
        removed.push({ index: i, point: cur });
        changed = true;
        continue;
      }
      out.push(cur);
    }
    pts = out;
  }
  return { ring: pts, removed };
}

/** pinch 拆分：环内重复顶点处拆成多个简单环。返回 Ring[]。 */
export function splitPinchRing(ring, eps) {
  const rings = [];
  let work = ring.slice();
  let guard = 0;
  while (guard++ < 1000) {
    const dups = repeatedVertices(work, eps);
    if (!dups.length) { rings.push(work); break; }
    const { i, j } = dups[0]; // work[j] 与 work[i] 为同一点，j < i
    const a = work.slice(j, i);       // 环1：j..i-1
    const b = work.slice(i).concat(work.slice(0, j)); // 环2：i..end + 0..j-1
    const parts = [];
    if (a.length >= 3) parts.push(a);
    if (b.length >= 3) parts.push(b);
    if (!parts.length) return rings; // 全退化，丢弃
    work = parts[0];
    for (let k = 1; k < parts.length; k++) rings.push(parts[k]);
    if (parts.length === 1 && !repeatedVertices(work, eps).length) { rings.push(work); break; }
  }
  return rings.filter(r => r.length >= 3);
}

/** 将环旋转到字典序最小顶点开头（稳定哈希用） */
export function canonicalStart(ring) {
  let best = 0;
  for (let i = 1; i < ring.length; i++) {
    const [x, y] = ring[i], [bx, by] = ring[best];
    if (x < bx || (x === bx && y < by)) best = i;
  }
  return ring.slice(best).concat(ring.slice(0, best));
}

function orientRing(ring, sign) {
  const a = ringArea(ring);
  if (a === 0) return ring;
  return Math.sign(a) === sign ? ring : ring.slice().reverse();
}

/**
 * 规范化一组环为 MultiPolygon。
 * ringsIn: Ring[]（开放或闭合均可）。decisions: 可选数组，收集判定日志。
 * 返回 MultiPolygon（可能为空）。
 */
export function normalizeGeom(ringsIn, eps, decisions) {
  const log = decisions || [];
  // 1. 开放化 + 去连续重复点
  let rings = [];
  for (const raw of ringsIn) {
    let r = raw.slice();
    if (r.length > 1 && dist(r[0], r[r.length - 1]) <= eps) r = r.slice(0, -1); // 去闭合点
    const { ring, removed } = dedupeRing(r, eps);
    for (const rm of removed) {
      log.push(`顶点吸附：移除距离 ≤ ε 的重复点 (${fmt(rm.point)})`);
    }
    if (ring.length >= 3) rings.push(ring);
    else if (ring.length) log.push(`丢弃退化环：不足 3 个不同顶点（${ring.length} 个）`);
  }
  // 2. pinch 拆分
  const split = [];
  for (const r of rings) {
    const parts = splitPinchRing(r, eps);
    if (parts.length > 1) {
      log.push(`环在共享顶点处自接触（沙漏点），按"点接触视为分离"规则拆分为 ${parts.length} 个独立环`);
    }
    split.push(...parts);
  }
  // 3. 丢弃零面积环（细缝/退化）
  rings = [];
  for (const r of split) {
    if (Math.abs(ringArea(r)) <= eps * eps) {
      log.push(`丢弃零面积退化环（|面积| ≤ ε²，顶点 ${r.length} 个）——不生成细缝`);
    } else {
      rings.push(r);
    }
  }
  if (!rings.length) return [];
  // 4. 包含深度分类（even-odd）：取环上一点，统计被多少其他环包含
  const depth = rings.map((ring, i) => {
    // 取边中点，避免顶点恰好落在别的环边界上
    const p = [(ring[0][0] + ring[1][0]) / 2, (ring[0][1] + ring[1][1]) / 2];
    let d = 0;
    for (let j = 0; j < rings.length; j++) {
      if (i === j) continue;
      if (pointInRing(rings[j], p, eps / 10) === 'in') d++;
    }
    return d;
  });
  const outers = [], holesOf = new Map(); // outerIdx -> holeIdx[]
  const outerIdxs = [];
  rings.forEach((r, i) => {
    if (depth[i] % 2 === 0) { outerIdxs.push(i); holesOf.set(i, []); }
  });
  rings.forEach((r, i) => {
    if (depth[i] % 2 === 1) {
      // 找包含它的最小外轮廓（深度 = depth[i]-1 且面积最小）
      let best = -1, bestArea = Infinity;
      const p = [(r[0][0] + r[1][0]) / 2, (r[0][1] + r[1][1]) / 2];
      for (const oi of outerIdxs) {
        if (depth[oi] !== depth[i] - 1) continue;
        if (pointInRing(rings[oi], p, eps / 10) !== 'in') continue;
        const a = Math.abs(ringArea(rings[oi]));
        if (a < bestArea) { bestArea = a; best = oi; }
      }
      if (best === -1) {
        // 找不到宿主外轮廓：作为外轮廓处理（兜底，不丢几何）
        log.push(`洞环未找到宿主外轮廓，按岛提升为独立外轮廓（不丢洞）`);
        outerIdxs.push(i); holesOf.set(i, []);
      } else {
        holesOf.get(best).push(i);
      }
    }
  });
  // 5. 定向 + 排序 + 组装
  const polys = outerIdxs.map(oi => {
    const outer = canonicalStart(orientRing(rings[oi], OUTER_SIGN));
    const holes = holesOf.get(oi)
      .map(hi => canonicalStart(orientRing(rings[hi], -OUTER_SIGN)))
      .sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
    return [outer, ...holes];
  });
  polys.sort((a, b) => Math.abs(ringArea(b[0])) - Math.abs(ringArea(a[0])));
  return polys;
}

function fmt(p) {
  return `${round2(p[0])}, ${round2(p[1])}`;
}
const round2 = v => Math.round(v * 100) / 100;

/** 稳定哈希（FNV-1a，坐标量化到 1e-6）。用于全等判定与重载一致性校验。 */
export function geomHash(geom) {
  const q = v => Math.round(v * 1e6);
  let h = 0x811c9dc5;
  const mix = n => {
    // 混合 32 位整数（含符号）
    let x = n | 0;
    for (let k = 0; k < 4; k++) {
      h ^= (x & 0xff);
      h = Math.imul(h, 0x01000193);
      x >>>= 8;
    }
  };
  for (const poly of geom) {
    mix(poly.length);
    for (const ring of poly) {
      mix(ring.length);
      for (const [x, y] of ring) { mix(q(x)); mix(q(y)); }
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function geomEquals(a, b) {
  return geomHash(a) === geomHash(b);
}

/** 几何统计摘要（用于校验面板与历史条目） */
export function geomStats(geom) {
  let outers = 0, holes = 0, vertices = 0, area = 0;
  for (const poly of geom) {
    poly.forEach((ring, idx) => {
      vertices += ring.length;
      if (idx === 0) { outers++; area += Math.abs(ringArea(ring)); }
      else { holes++; area -= Math.abs(ringArea(ring)); }
    });
  }
  return { outers, holes, vertices, area: Math.round(area * 100) / 100 };
}
