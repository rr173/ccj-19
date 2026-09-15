// ops.js — 布尔操作编排：前置校验 → 容差吸附 → 接触分类 → 调用 polygon-clipping →
// 后置规范化与校验。任何一步失败都返回 ok:false 并保留原图，reason 说明原因。
// polygon-clipping 实例通过参数注入（浏览器用 ESM 构建，Node 测试用 CJS 构建）。

import { dist, geomBBox } from './geometry.js';
import { normalizeGeom, geomEquals, geomStats, geomHash } from './model.js';
import { validateGeom, classifyTouch } from './validate.js';

export const OPS = {
  union: { label: '合并', symbol: 'A ∪ B' },
  difference: { label: '减去', symbol: 'A − B' },
  intersection: { label: '相交', symbol: 'A ∩ B' },
};

const f2 = v => Math.round(v * 100) / 100;
const fp = p => `(${f2(p[0])}, ${f2(p[1])})`;

/** 跨形状顶点吸附：A、B 顶点对距离 < eps 时移到中点。返回吸附记录。 */
function snapTogether(geomA, geomB, eps) {
  const snaps = [];
  const ptsA = collectPoints(geomA);
  const ptsB = collectPoints(geomB);
  for (const pa of ptsA) {
    for (const pb of ptsB) {
      const d = dist(pa.p, pb.p);
      if (d > 1e-12 && d < eps) {
        const mid = [(pa.p[0] + pb.p[0]) / 2, (pa.p[1] + pb.p[1]) / 2];
        snaps.push({ from: [pa.p.slice(), pb.p.slice()], to: mid, dist: d });
        pa.p[0] = mid[0]; pa.p[1] = mid[1];
        pb.p[0] = mid[0]; pb.p[1] = mid[1];
      }
    }
  }
  return snaps;
}

function collectPoints(geom) {
  const out = [];
  geom.forEach((poly, pi) => poly.forEach((ring, ri) => ring.forEach((p, vi) => out.push({ p, pi, ri, vi }))));
  return out;
}

function toPcGeom(geom) {
  // polygon-clipping 接受开放环（自动闭合），直接传副本
  return geom.map(poly => poly.map(ring => ring.map(p => [p[0], p[1]])));
}

/**
 * 执行布尔操作。
 * @param pc   polygon-clipping 模块（{union, difference, intersection}）
 * @param op   'union' | 'difference' | 'intersection'
 * @param geomA, geomB  规范化的 MultiPolygon（不会被修改）
 * @param eps  容差
 * @param opts.recompute  派生图形自动重算模式：来源变化后"结果等于 A（无面积增减）"是
 *        合法的重算结论（返回该几何），但"交集为空 / 引擎无输出 / 拓扑无效"仍判失败，
 *        以便整轮原子回滚。创建模式（默认）维持严格拒绝、不产生派生图形。
 * @returns {ok, geom?, reason?, report} report 含完整判定链，供历史与 UI 展示
 */
export function applyBoolean(pc, op, geomA, geomB, eps, opts = {}) {
  const recompute = !!opts.recompute;
  const opInfo = OPS[op];
  const report = {
    op, opLabel: opInfo.label, symbol: opInfo.symbol, eps, recompute,
    decisions: [], input: null, touch: null, output: null, validation: null,
  };
  const fail = reason => ({ ok: false, reason, report });

  // 1. 前置校验：自交 / 洞关系 / 重复边等
  const va = validateGeom(geomA, eps);
  const vb = validateGeom(geomB, eps);
  report.input = { a: va.stats, b: vb.stats };
  if (!va.ok) return fail(`操作数 A 拓扑无效，已保留原图：${va.errors[0]}`);
  if (!vb.ok) return fail(`操作数 B 拓扑无效，已保留原图：${vb.errors[0]}`);
  report.decisions.push(`前置校验通过：A（${va.stats.outers} 外轮廓/${va.stats.holes} 洞）、B（${vb.stats.outers} 外轮廓/${vb.stats.holes} 洞）均为有效拓扑`);

  // 2. 容差吸附（在副本上）：避免近接触产生细缝
  const aCopy = normalizeGeom(geomA.flatMap(p => p), eps, []);
  const bCopy = normalizeGeom(geomB.flatMap(p => p), eps, []);
  const snaps = snapTogether(aCopy, bCopy, eps);
  for (const s of snaps) {
    report.decisions.push(`顶点吸附：${fp(s.from[0])} 与 ${fp(s.from[1])} 相距 ${f2(s.dist)} < ε=${eps}，合并为 ${fp(s.to)}（不造细缝）`);
  }
  if (snaps.length) {
    const va2 = validateGeom(aCopy, eps);
    const vb2 = validateGeom(bCopy, eps);
    if (!va2.ok || !vb2.ok) {
      return fail(`顶点吸附后拓扑退化（${(va2.errors[0] || vb2.errors[0])}），已放弃操作并保留原图`);
    }
  }

  // 3. 接触关系分类 —— 显式拓扑判定
  const touch = classifyTouch(aCopy, bCopy, eps);
  report.touch = touch;
  report.decisions.push(`接触判定：${touch.description}`);

  // 4. 按接触类型提前给出确定结论（与库行为一致，但先说明规则）。
  //    重算模式下，差集"无面积变化"是合法结论（几何 = A）；相交为空在两种模式下都是失败
  //    （派生结果不复存在，触发整轮回滚并标出本节点）。
  if (op === 'intersection' && (touch.kind === 'disjoint' || touch.kind === 'point-touch' || touch.kind === 'edge-touch')) {
    const why = touch.kind === 'disjoint'
      ? `两形状分离（最近距离 ${f2(touch.minDist)}），交集为空`
      : touch.kind === 'point-touch'
        ? '两形状仅点接触，交集面积为零，按规则视为空'
        : '两形状仅共享边界，交集面积为零，按规则视为空';
    return fail(`相交结果为空：${why}。`);
  }
  if (op === 'difference' && (touch.kind === 'disjoint' || touch.kind === 'point-touch' || touch.kind === 'edge-touch')) {
    const why = touch.kind === 'disjoint'
      ? `B 与 A 分离（最近距离 ${f2(touch.minDist)}），A − B = A`
      : `B 仅与 A 边界接触（${touch.kind === 'point-touch' ? '点接触' : '共边'}），不减去任何面积，A − B = A`;
    if (!recompute) return fail(`差集无变化：${why}。已保留原图`);
    report.decisions.push(`重算结论：${why}，结果沿用 A 的几何`);
    const geomSame = normalizeGeom(aCopy.flatMap(p => p), eps, []);
    const vsame = validateGeom(geomSame, eps);
    report.output = vsame.stats;
    report.validation = vsame;
    return { ok: true, geom: geomSame, report };
  }

  // 5. 调用 polygon-clipping
  let raw;
  try {
    raw = pc[op](toPcGeom(aCopy), toPcGeom(bCopy));
  } catch (err) {
    return fail(`布尔引擎内部错误：${err.message}。已保留原图`);
  }
  if (!raw || raw.length === 0) {
    if (recompute) return fail(`${opInfo.label}结果为空（${touch.description}）。`);
    return fail(`${opInfo.label}结果为空（${touch.description}）。已保留原图`);
  }

  // 6. 后置规范化（pinch 拆分 / 退化环丢弃 / 洞分类，全部记入判定日志）
  const geom = normalizeGeom(raw.flatMap(p => p), eps, report.decisions);
  if (!geom.length) {
    if (recompute) return fail(`${opInfo.label}结果经规范化后为空（仅余退化环，按规则不生成细缝）。`);
    return fail(`${opInfo.label}结果经规范化后为空（仅余退化环，按规则不生成细缝）。已保留原图`);
  }

  // 7. 后置校验（兜底：引擎输出必须满足全部拓扑规则）
  const vout = validateGeom(geom, eps);
  report.validation = vout;
  report.output = vout.stats;
  if (!vout.ok) {
    if (recompute) return fail(`结果拓扑无效（${vout.errors[0]}）。`);
    return fail(`结果拓扑无效（${vout.errors[0]}），已放弃并保留原图`);
  }

  // 8. 无变化检测：创建模式下结果与 A 全等则拒绝（保持历史干净）；
  //    重算模式下这是合法结论（来源编辑导致减法不再减去面积）。
  if (geomEquals(geom, aCopy)) {
    if (!recompute) return fail(`${opInfo.label}结果与 A 完全全等，未产生变化。已保留原图`);
    report.decisions.push(`重算结论：结果与 A 完全全等，几何沿用不变`);
  }

  report.decisions.push(
    `完成：${opInfo.symbol} → ${vout.stats.outers} 个外轮廓、${vout.stats.holes} 个洞、${vout.stats.vertices} 个顶点` +
    (vout.warnings.length ? `（${vout.warnings.length} 项警告）` : '，拓扑校验全部通过'),
  );
  return { ok: true, geom, report };
}

/** 结果摘要文本（历史条目用） */
export function reportSummary(report, hash) {
  const parts = [`${report.symbol}`, `ε=${report.eps}`];
  if (report.output) parts.push(`→ ${report.output.outers} 外轮廓/${report.output.holes} 洞`);
  if (hash) parts.push(`#${hash.slice(0, 8)}`);
  return parts.join(' ');
}

export { geomHash, geomStats, geomBBox };
