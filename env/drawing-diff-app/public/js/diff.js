// diff.js — 在对应关系之上生成变更项：增补/消除/位置偏移/尺寸改动/拓扑改动。
//
// 公差语义（仅数据精度引起的抖动归为未改动）：
//   positionTolerance：质心/中点平移距离阈值；
//   sizeTolerance：     长度/半径/周长等绝对差阈值；
//   areaTolerance：     面积绝对差阈值；
//   relativeTolerance： 相对差阈值（默认 1%），绝对或相对任一满足即视为未超。
// 一个 1:1 配对可同时携带多种改动（changes 数组），主类型取最显著者。
// diffKey 只由稳定图元身份组成，因此重算/重载/排序变化后决议仍归属原处。

export const DEFAULT_TOLERANCE = {
  positionTolerance: 0.5,
  sizeTolerance: 0.5,
  areaTolerance: 2.5,
  relativeTolerance: 0.01,
  maxOffset: Infinity, // 人工固定关系的最大允许偏移（超出则整次重算撤回）
};

export const DIFF_KINDS = ['addition', 'removal', 'position', 'size', 'topology', 'shape'];
export const KIND_CN = {
  addition: '增补',
  removal: '消除',
  position: '位置偏移',
  size: '尺寸改动',
  topology: '拓扑改动',
  shape: '形状改动',
};

function overAbsRel(delta, ref, absTol, relTol) {
  const overAbs = Math.abs(delta) > absTol;
  const overRel = Math.abs(ref) > 1e-12 && Math.abs(delta) / Math.abs(ref) > relTol;
  return overAbs && overRel; // 绝对与相对都超才算改动（容忍小图元的大相对噪声）
}

function angleOf(dx, dy) {
  return Math.atan2(dy, dx);
}

/** 计算一对 1:1 图元的差异度量。 */
export function pairMetrics(b, c) {
  const fb = b.features, fc = c.features;
  const dx = fc.centroid[0] - fb.centroid[0];
  const dy = fc.centroid[1] - fb.centroid[1];
  const m = {
    before: {},
    after: {},
    delta: {},
    displacement: Math.hypot(dx, dy),
    directionRad: angleOf(dx, dy),
    directionDeg: (angleOf(dx, dy) * 180) / Math.PI,
    changes: [],
  };
  m.before.x = fb.centroid[0]; m.after.x = fc.centroid[0]; m.delta.x = dx;
  m.before.y = fb.centroid[1]; m.after.y = fc.centroid[1]; m.delta.y = dy;

  if (b.kind === 'segment') {
    m.before.length = fb.length;
    m.after.length = fc.length;
    m.delta.length = fc.length - fb.length;
  } else {
    m.before.area = fb.area;
    m.after.area = fc.area;
    m.delta.area = fc.area - fb.area;
    m.before.perimeter = fb.perimeter;
    m.after.perimeter = fc.perimeter;
    m.delta.perimeter = fc.perimeter - fb.perimeter;
    if (b.shape === 'circle' && c.shape === 'circle') {
      m.before.radius = b.r;
      m.after.radius = c.r;
      m.delta.radius = c.r - b.r;
    }
  }
  return m;
}

function classifyPair(b, c, metrics, tol) {
  const changes = [];
  if (metrics.displacement > tol.positionTolerance) changes.push('position');
  if (b.kind === 'segment') {
    if (overAbsRel(metrics.delta.length, metrics.before.length, tol.sizeTolerance, tol.relativeTolerance)) {
      changes.push('size');
    }
  } else {
    if (b.shape === 'circle' && c.shape === 'circle') {
      // 圆：直接按半径判定，避免面积差换算放大纯半径精度抖动
      if (overAbsRel(metrics.delta.radius, metrics.before.radius, tol.sizeTolerance, tol.relativeTolerance)) {
        changes.push('size');
      }
    } else if (overAbsRel(metrics.delta.area, metrics.before.area, tol.areaTolerance, tol.relativeTolerance)) {
      changes.push('size');
    }
    // 形状改动：非圆轮廓在面积未变但周长显著改变（变形），或圆/轮廓互变。
    // 圆的半径变化已在上面归入尺寸，周长抖动来自离散化，不参与形状判定。
    if (b.shape !== c.shape) changes.push('shape');
    if (b.shape !== 'circle' && c.shape !== 'circle') {
      const perimeterChanged = overAbsRel(metrics.delta.perimeter, metrics.before.perimeter,
        tol.sizeTolerance, Math.max(tol.relativeTolerance, 0.03));
      const areaChanged = changes.includes('size');
      if (perimeterChanged && !areaChanged) changes.push('shape');
    }
  }
  metrics.changes = changes;
  if (!changes.length) return null;
  // 主类型：位置 > 尺寸 > 形状（叠加视图标记与筛选以主类型着色）
  const primary = changes.includes('position') ? 'position'
    : changes.includes('size') ? 'size' : 'shape';
  return primary;
}

function pairKey(b, c) {
  return `pair:${b.kind}:${b.stableId}->${c.stableId}`;
}
function singleKey(kind, e) {
  return `${kind}:${e.kind}:${e.stableId}`;
}
function topologyKey(group) {
  const b = group.base.map((e) => e.stableId).sort().join(',');
  const c = group.cand.map((e) => e.stableId).sort().join(',');
  return `topology:${group.kind}:${b}=>${c}`;
}

/**
 * 由对应关系生成变更清单。
 * @param corr buildCorrespondence 的结果
 * @param tol 公差（与 DEFAULT_TOLERANCE 合并）
 * @returns { diffs:[Diff], stats, pending（透传）, hasPending }
 */
export function buildDiffs(corr, tolerance = {}) {
  const tol = { ...DEFAULT_TOLERANCE, ...tolerance };
  const diffs = [];

  for (const p of corr.pairs) {
    const metrics = pairMetrics(p.base, p.cand);
    const primary = classifyPair(p.base, p.cand, metrics, tol);
    if (!primary) continue; // 全部抖动低于公差 → 未改动，不出差异项
    diffs.push({
      key: pairKey(p.base, p.cand),
      kind: primary,
      changes: metrics.changes,
      entityKind: p.base.kind,
      base: p.base,
      cand: p.cand,
      pinned: !!p.pinned,
      confidence: p.score,
      metrics,
    });
  }

  for (const e of corr.additions) {
    diffs.push({
      key: singleKey('addition', e),
      kind: 'addition',
      changes: ['addition'],
      entityKind: e.kind,
      cand: e,
      metrics: null,
    });
  }
  for (const e of corr.removals) {
    diffs.push({
      key: singleKey('removal', e),
      kind: 'removal',
      changes: ['removal'],
      entityKind: e.kind,
      base: e,
      metrics: null,
    });
  }

  for (const g of corr.topologyGroups) {
    const areaBefore = g.base.reduce((s, e) => s + e.features.area, 0);
    const areaAfter = g.cand.reduce((s, e) => s + e.features.area, 0);
    diffs.push({
      key: topologyKey(g),
      kind: 'topology',
      topology: g.topology, // split | merge | many-to-many
      changes: [g.topology],
      entityKind: g.kind,
      baseGroup: g.base,
      candGroup: g.cand,
      metrics: {
        before: { count: g.base.length, area: areaBefore },
        after: { count: g.cand.length, area: areaAfter },
        delta: { count: g.cand.length - g.base.length, area: areaAfter - areaBefore },
      },
    });
  }

  return {
    diffs,
    pending: corr.pending,
    hasPending: corr.pending.length > 0,
    stats: computeStats(diffs, corr),
  };
}

export function computeStats(diffs, corr) {
  const stats = {
    total: diffs.length,
    byKind: Object.fromEntries(DIFF_KINDS.map((k) => [k, 0])),
    pending: corr ? corr.pending.length : 0,
    matched: corr ? corr.pairs.length : 0,
    unchanged: corr ? corr.pairs.length - diffs.filter((d) => d.base && d.cand && !d.baseGroup).length : 0,
  };
  for (const d of diffs) stats.byKind[d.kind]++;
  return stats;
}

/** 侧栏用的前后数值格式化（单位由图纸携带）。 */
export function formatMetricRows(d, units = 'mm') {
  if (d.kind === 'addition' || d.kind === 'removal') return [];
  if (d.kind === 'topology') {
    return [
      ['块数', `${d.metrics.before.count}`, `${d.metrics.after.count}`],
      [`总面积(${units}²)`, fmt(d.metrics.before.area), fmt(d.metrics.after.area)],
    ];
  }
  const rows = [];
  const m = d.metrics;
  rows.push([`质心 X(${units})`, fmt(m.before.x), fmt(m.after.x), signedFmt(m.delta.x)]);
  rows.push([`质心 Y(${units})`, fmt(m.before.y), fmt(m.after.y), signedFmt(m.delta.y)]);
  if ('length' in m.before) {
    rows.push([`长度(${units})`, fmt(m.before.length), fmt(m.after.length), signedFmt(m.delta.length)]);
  } else {
    rows.push([`面积(${units}²)`, fmt(m.before.area), fmt(m.after.area), signedFmt(m.delta.area)]);
    rows.push([`周长(${units})`, fmt(m.before.perimeter), fmt(m.after.perimeter), signedFmt(m.delta.perimeter)]);
    if ('radius' in m.before) {
      rows.push([`半径(${units})`, fmt(m.before.radius), fmt(m.after.radius), signedFmt(m.delta.radius)]);
    }
  }
  rows.push(['偏移距离', '—', `${fmt(m.displacement)} ${units}`, `${m.directionDeg.toFixed(1)}°`]);
  return rows;
}

function fmt(v) {
  return Number.isFinite(v) ? (Math.round(v * 1000) / 1000).toString() : String(v);
}
function signedFmt(v) {
  const s = fmt(v);
  return v > 0 ? `+${s}` : s;
}
