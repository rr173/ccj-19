// overlap.js — 封闭图元（region/hole）之间的叠层重叠与拓扑分量。
//
// 零依赖方案：对每个图元包围盒撒 GRID×GRID 点阵，用点在多边形内测试统计
// 双向覆盖比例，足以判定"一块区域拆成两块"这类拓扑改动，且能处理任意简单多边形。
// overlap(A,B) 面积估计：A 格点落入 B 的比例×面积A，与反向估计取均值抑制离散偏差。

import { pointInRing } from './geometry.js';

const GRID = 40;
/** 双向覆盖阈值：低于此比例的擦碰不构成关联。 */
export const MIN_COVER = 0.12;

const cache = new WeakMap();
function samples(e) {
  let s = cache.get(e);
  if (!s) {
    const f = e.features;
    const pts = [];
    for (let i = 0; i < GRID; i++) {
      for (let j = 0; j < GRID; j++) {
        pts.push([
          f.bounds.minX + ((i + 0.5) / GRID) * (f.bounds.maxX - f.bounds.minX || 1e-9),
          f.bounds.minY + ((j + 0.5) / GRID) * (f.bounds.maxY - f.bounds.minY || 1e-9),
        ]);
      }
    }
    cache.set(e, pts);
    s = pts;
  }
  return s;
}

/**
 * 两个封闭图元的双向重叠。
 * @returns { overlapArea, coverA, coverB, coverMin } coverA=重叠/A面积。
 */
export function pairOverlap(a, b, eps = 1e-9) {
  const areaA = a.features.area;
  const areaB = b.features.area;
  const sa = samples(a);
  const sb = samples(b);
  let inB = 0, inA = 0;
  for (const p of sa) if (pointInRing(b.points, p, eps) !== 'out') inB++;
  for (const p of sb) if (pointInRing(a.points, p, eps) !== 'out') inA++;
  const ratioA = inB / sa.length;
  const ratioB = inA / sb.length;
  const ov = (ratioA * areaA + ratioB * areaB) / 2;
  const coverA = areaA === 0 ? 0 : Math.min(1, ov / areaA);
  const coverB = areaB === 0 ? 0 : Math.min(1, ov / areaB);
  return { overlapArea: ov, coverA, coverB, coverMin: Math.min(coverA, coverB) };
}

/**
 * 同类封闭图元两组的全两两重叠矩阵，仅记录有重叠的边。
 * @returns { entries:[{i,j,ov}], byBase:Map, byCand:Map }
 */
export function overlapMatrix(baseEntities, candEntities, eps = 1e-9) {
  const entries = [];
  const byBase = new Map();
  const byCand = new Map();
  baseEntities.forEach((a, i) => {
    candEntities.forEach((b, j) => {
      const ov = pairOverlap(a, b, eps);
      if (ov.overlapArea > 1e-12) {
        const rec = { i, j, ov };
        entries.push(rec);
        if (!byBase.has(i)) byBase.set(i, []);
        if (!byCand.has(j)) byCand.set(j, []);
        byBase.get(i).push(rec);
        byCand.get(j).push(rec);
      }
    });
  });
  return { entries, byBase, byCand };
}

function classifyTopology(nb, nc) {
  if (nb === 1 && nc === 1) return 'one-to-one';
  if (nb === 1 && nc > 1) return 'split';
  if (nb > 1 && nc === 1) return 'merge';
  return 'many-to-many';
}

/**
 * 以双向覆盖均 ≥ minCover 的边构造二分图，求连通分量。
 * @returns { components:[{baseIdx,candIdx,topology}], isolatedBase:[], isolatedCand:[] }
 */
export function overlapComponents(matrix, nBase, nCand, { minCover = MIN_COVER } = {}) {
  const adjBase = new Map();
  const adjCand = new Map();
  for (const { i, j, ov } of matrix.entries) {
    if (ov.coverA < minCover || ov.coverB < minCover) continue;
    if (!adjBase.has(i)) adjBase.set(i, []);
    if (!adjCand.has(j)) adjCand.set(j, []);
    adjBase.get(i).push(j);
    adjCand.get(j).push(i);
  }

  const seenB = new Set(), seenC = new Set();
  const components = [];

  const walk = (startSide, start) => {
    const bset = new Set(), cset = new Set();
    const queue = [[startSide, start]];
    if (startSide === 'b') bset.add(start); else cset.add(start);
    while (queue.length) {
      const [side, v] = queue.shift();
      if (side === 'b') {
        for (const j of adjBase.get(v) || []) {
          if (!cset.has(j)) { cset.add(j); queue.push(['c', j]); }
        }
      } else {
        for (const i of adjCand.get(v) || []) {
          if (!bset.has(i)) { bset.add(i); queue.push(['b', i]); }
        }
      }
    }
    for (const i of bset) seenB.add(i);
    for (const j of cset) seenC.add(j);
    const baseIdx = [...bset].sort((x, y) => x - y);
    const candIdx = [...cset].sort((x, y) => x - y);
    components.push({ baseIdx, candIdx, topology: classifyTopology(baseIdx.length, candIdx.length) });
  };

  for (const i of adjBase.keys()) if (!seenB.has(i)) walk('b', i);
  for (const j of adjCand.keys()) if (!seenC.has(j)) walk('c', j);

  const isolatedBase = [];
  const isolatedCand = [];
  for (let i = 0; i < nBase; i++) if (!seenB.has(i)) isolatedBase.push(i);
  for (let j = 0; j < nCand; j++) if (!seenC.has(j)) isolatedCand.push(j);
  return { components, isolatedBase, isolatedCand };
}
