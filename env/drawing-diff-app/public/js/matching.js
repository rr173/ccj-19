// matching.js — 配准后的图元一一对应：评分、候选列举、指派、人工消歧。
//
// 自动匹配绝不擅自处理"多个相似图元"：
//   - 封闭图元（region/hole）先由重叠图得到 1:1 或拓扑分量（拆分/合并见 diff.js），
//     对 1:1 分量仍计算候选置信度，出现劲敌（差距≤rivalGap）或置信不足时挂起人工消歧；
//   - 开放线段按特征评分做全局最优指派（匈牙利），同样在出现劲敌/低置信时挂起。
// 每个候选附带分量化的置信依据（位置/尺寸/形状/方位），供侧栏展示。
// 全程通过 stableId 引用图元，因此"先剥离人工固定项再匹配"不会造成下标错位。

import { dist, chamferClosed, chamferOpen } from './geometry.js';
import { sampleEntity } from './entities.js';
import { overlapMatrix, overlapComponents } from './overlap.js';

export const SCORE = {
  strong: 0.62,   // ≥ 且无劲敌才自动落锤
  weak: 0.42,     // < weak 视为无可信候选
  rivalGap: 0.08, // 与第二名差距 ≤ 此值则挂起人工消歧
};

const gauss = (x, sigma) => Math.exp(-(x * x) / (2 * sigma * sigma));
const ratioScore = (a, b) => a === 0 && b === 0 ? 1 : Math.min(a, b) / Math.max(a, b);

function refSize(e) {
  if (e.kind === 'segment') return e.features.length;
  return Math.sqrt(e.features.area) * 2;
}

/** 把轮廓采样点平移到质心并按参考尺寸归一化——得到与位置无关的形状签名。 */
function shapeSignature(e, samples, ref) {
  const [cx, cy] = e.features.centroid;
  return samples.map((p) => [(p[0] - cx) / ref, (p[1] - cy) / ref]);
}

/**
 * 为基线图元列举候选稿中同类型图元的评分。
 * 位置、尺寸、形状（去位置归一化）、方位四个分量独立，避免远距离小孔被形状分误杀。
 * @returns [{ cand:e, score, evidence:{position,size,shape,orientation}, reasons:[] }] 降序
 */
export function scoreCandidates(baseE, candEntities, options = {}) {
  const tol = options.tolerance ?? 1;
  const posSigma = Math.max(tol * 3, refSize(baseE) * 0.6);
  const baseRef = refSize(baseE) || 1;
  const baseSamples = sampleEntity(baseE);
  const baseShapeClosed = shapeSignature(baseE, baseSamples, baseRef);
  const baseShapeOpen = shapeSignature(baseE, baseSamples, baseRef);
  const out = [];

  for (const c of candEntities) {
    if (c.kind !== baseE.kind) continue;
    const candRef = refSize(c) || 1;
    const position = gauss(dist(baseE.features.centroid, c.features.centroid), posSigma);

    let size, shape, orientation = 1;
    if (baseE.kind === 'segment') {
      size = ratioScore(baseE.features.length, c.features.length);
      const sig = shapeSignature(c, sampleEntity(c), candRef);
      const ch = chamferOpen(baseShapeOpen, sig);
      shape = gauss(ch, 0.25);
      let da = Math.abs(Math.atan2(
        Math.sin(baseE.features.heading - c.features.heading),
        Math.cos(baseE.features.heading - c.features.heading)));
      if (da > Math.PI / 2) da = Math.PI - da; // 开放线段无方向：取锐角
      orientation = gauss(da, 0.35);
    } else {
      size = baseE.shape === 'circle' && c.shape === 'circle'
        ? ratioScore(baseE.r, c.r)
        : ratioScore(Math.sqrt(baseE.features.area), Math.sqrt(c.features.area));
      size = size * 0.5 + ratioScore(baseE.features.perimeter, c.features.perimeter) * 0.5;
      const sig = shapeSignature(c, sampleEntity(c), candRef);
      const ch = chamferClosed(baseShapeClosed, sig);
      shape = gauss(ch, 0.22);
    }

    const weights = baseE.kind === 'segment'
      ? { position: 0.25, size: 0.2, shape: 0.4, orientation: 0.15 }
      : { position: 0.3, size: 0.25, shape: 0.45, orientation: 0 };
    const score = weights.position * position +
      weights.size * size +
      weights.shape * shape +
      weights.orientation * orientation;

    out.push({ cand: c, score, evidence: { position, size, shape, orientation } });
  }
  out.sort((a, b) => b.score - a.score);
  attachReasons(out);
  return out;
}

function attachReasons(list) {
  const labels = { position: '位置', size: '尺寸', shape: '形状', orientation: '方位' };
  for (const r of list) {
    const ev = r.evidence;
    const strong = Object.keys(ev)
      .filter((k) => ev[k] >= 0.75)
      .map((k) => `${labels[k]}吻合(${(ev[k] * 100).toFixed(0)}%)`);
    const weak = Object.keys(ev)
      .filter((k) => ev[k] < 0.55)
      .map((k) => `${labels[k]}偏离(${(ev[k] * 100).toFixed(0)}%)`);
    r.reasons = [
      `综合置信 ${(r.score * 100).toFixed(0)}%`,
      ...strong.slice(0, 2),
      ...weak.slice(0, 2),
      r.cand.label ? `候选标注「${r.cand.label}」` : null,
    ].filter(Boolean);
  }
}

/**
 * 单个基线图元的自动落锤判定。
 * @returns { decision:'auto'|'ambiguous'|'none', pick?, candidates }
 */
export function resolveSingle(list) {
  if (!list.length || list[0].score < SCORE.weak) {
    return { decision: 'none', candidates: list };
  }
  const top = list[0];
  const rival = list[1];
  if (top.score < SCORE.strong || (rival && top.score - rival.score <= SCORE.rivalGap)) {
    return { decision: 'ambiguous', candidates: list.filter((r) => r.score >= SCORE.weak) };
  }
  return { decision: 'auto', pick: top.cand, candidates: list };
}

/**
 * 匈牙利指派（O(n³)，最小化代价），支持非方阵。
 * 返回与行数等长的列指派（-1 表示未指派）。
 */
export function hungarian(costMatrix) {
  const n = costMatrix.length;
  const m = Math.max(n, ...costMatrix.map((r) => r.length));
  const BIG = 1e9;
  const a = Array.from({ length: n }, (_, i) =>
    Array.from({ length: m }, (_, j) => (j < costMatrix[i].length ? costMatrix[i][j] : BIG)));

  const u = new Array(n + 1).fill(0);
  const v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0);
  const way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(BIG);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = BIG, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (!used[j]) {
          const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  const assignment = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) {
    if (p[j] >= 1 && p[j] <= n && a[p[j] - 1][j - 1] < BIG / 2) {
      assignment[p[j] - 1] = j - 1;
    }
  }
  return assignment;
}

/**
 * 构造完整对应关系。
 * @param regBase 配准后基线图元（通常恒等）
 * @param regCand 配准后候选图元
 * @param pinned Map<baseStableId, {candStableId}|null> 人工固定（null=声明无对应）
 * @param options { tolerance, minCover, eps }
 */
export function buildCorrespondence(regBase, regCand, pinned = new Map(), options = {}) {
  const pairs = [];
  const topologyGroups = [];
  const additions = [];
  const removals = [];
  const pending = [];
  const scoreMap = new Map(); // baseStableId -> 候选评分列表
  // 已被自动/人工配对占用的候选，按类型隔离计数
  const occupiedCand = { region: new Set(), hole: new Set(), segment: new Set() };

  const pinnedCandIds = new Set();
  for (const dec of pinned.values()) {
    if (dec && dec.candStableId != null) pinnedCandIds.add(dec.candStableId);
  }

  const addPair = (b, c, r, isPinned) => {
    pairs.push({
      base: b, cand: c, pinned: !!isPinned,
      score: r ? r.score : (isPinned ? null : undefined),
      evidence: r ? r.evidence : null,
    });
  };

  // ---------- 封闭图元（region/hole）：重叠图分组 ----------
  for (const kind of ['region', 'hole']) {
    const allB = regBase.filter((e) => e.kind === kind);
    const allC = regCand.filter((e) => e.kind === kind);
    const freeB = allB.filter((e) => !pinned.has(e.stableId));
    const freeC = allC.filter((e) => !pinnedCandIds.has(e.stableId));

    const matrix = overlapMatrix(freeB, freeC, options.eps ?? 1e-9);
    const { components, isolatedBase, isolatedCand } =
      overlapComponents(matrix, freeB.length, freeC.length, { minCover: options.minCover });

    for (const comp of components) {
      const bases = comp.baseIdx.map((i) => freeB[i]);
      const cands = comp.candIdx.map((j) => freeC[j]);
      if (comp.topology === 'one-to-one') {
        const b = bases[0], overlapC = cands[0];
        const list = scoreCandidates(b, freeC, options);
        scoreMap.set(b.stableId, list);
        const top = list.find((r) => r.cand.stableId === overlapC.stableId) || list[0];
        const rival = list.find((r) => r !== top);
        const ambiguous = top && rival &&
          (top.score < SCORE.strong || top.score - rival.score <= SCORE.rivalGap);
        if (ambiguous) {
          pending.push({
            kind, base: b,
            candidates: list.filter((r) => r.score >= SCORE.weak)
              .map((r) => ({ ...r, insideOverlap: r.cand.stableId === overlapC.stableId })),
            reason: '重叠位置存在多个相似候选，需人工确认',
          });
        } else {
          addPair(b, overlapC, top, false);
          occupiedCand[kind].add(overlapC.stableId);
        }
      } else {
        topologyGroups.push({ kind, base: bases, cand: cands, topology: comp.topology });
        for (const c of cands) occupiedCand[kind].add(c.stableId);
      }
    }

    for (const i of isolatedBase) {
      const b = freeB[i];
      const list = scoreCandidates(b, freeC, options);
      scoreMap.set(b.stableId, list);
      const decision = resolveSingle(list);
      if (decision.decision === 'auto') {
        addPair(b, decision.pick, list[0], false);
        occupiedCand[kind].add(decision.pick.stableId);
      } else if (decision.decision === 'ambiguous') {
        pending.push({ kind, base: b, candidates: decision.candidates,
          reason: '存在多个相似候选，需人工确认' });
        decision.candidates.forEach((r) => occupiedCand[kind].add(r.cand.stableId));
      } else removals.push(b);
    }
    for (const j of isolatedCand) {
      const e = freeC[j];
      if (!occupiedCand[kind].has(e.stableId)) additions.push(e);
    }

    // 人工固定项落位（冲突预检由 session 层负责）
    for (const b of allB) {
      if (!pinned.has(b.stableId)) continue;
      const dec = pinned.get(b.stableId);
      if (dec.candStableId == null) { removals.push(b); continue; }
      const c = regCand.find((e) => e.stableId === dec.candStableId);
      addPair(b, c, null, true);
      occupiedCand[kind].add(c.stableId);
    }
  }

  // ---------- 开放线段：全局最优指派 + 劲敌消歧 ----------
  {
    const allB = regBase.filter((e) => e.kind === 'segment');
    const allC = regCand.filter((e) => e.kind === 'segment');
    const freeB = allB.filter((e) => !pinned.has(e.stableId));
    const freeC = allC.filter((e) => !pinnedCandIds.has(e.stableId));

    const lists = freeB.map((b) => scoreCandidates(b, freeC, options));
    const cost = lists.map((list) => freeC.map((c) => {
      const hit = list.find((r) => r.cand.stableId === c.stableId);
      const s = hit ? hit.score : 0;
      return s < SCORE.weak ? 1e6 : 1 - s;
    }));
    const assign = freeC.length && freeB.length ? hungarian(cost) : freeB.map(() => -1);
    const pendingCandIds = new Set();
    const matchedCandIds = new Set();

    freeB.forEach((b, bi) => {
      const list = lists[bi];
      scoreMap.set(b.stableId, list);
      const j = assign[bi];
      const chosen = j >= 0 ? list.find((r) => r.cand.stableId === freeC[j].stableId) : null;
      const rival = list[1];
      const ambiguous = chosen && rival && chosen.score - rival.score <= SCORE.rivalGap;
      if (chosen && !ambiguous && chosen.score >= SCORE.strong) {
        addPair(b, chosen.cand, chosen, false);
        matchedCandIds.add(chosen.cand.stableId);
      } else if (list.length && list[0].score >= SCORE.weak) {
        pending.push({ kind: 'segment', base: b,
          candidates: list.filter((r) => r.score >= SCORE.weak),
          reason: ambiguous ? '存在置信度接近的多个线段候选，需人工确认'
            : '候选置信不足，需人工确认' });
        list.filter((r) => r.score >= SCORE.weak).forEach((r) => pendingCandIds.add(r.cand.stableId));
      } else {
        removals.push(b);
      }
    });
    for (const c of freeC) {
      if (!matchedCandIds.has(c.stableId) && !pendingCandIds.has(c.stableId)) additions.push(c);
    }

    for (const b of allB) {
      if (!pinned.has(b.stableId)) continue;
      const dec = pinned.get(b.stableId);
      if (dec.candStableId == null) { removals.push(b); continue; }
      addPair(b, regCand.find((e) => e.stableId === dec.candStableId), null, true);
    }
  }

  return { pairs, topologyGroups, additions, removals, pending, scores: scoreMap };
}
