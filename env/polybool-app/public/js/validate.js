// validate.js — 拓扑校验与形状间接触关系分类。
// 所有判定都带容差 eps，并把命中的规则写入人类可读的条目，供 UI 明确展示。

import {
  ringArea, pointInRing, ringSelfIntersections, ringRingIntersections,
  repeatedVertices, dist, pointSegDist,
} from './geometry.js';
import { geomStats } from './model.js';

const f2 = v => Math.round(v * 100) / 100;
const fp = p => `(${f2(p[0])}, ${f2(p[1])})`;

/**
 * 校验一个 MultiPolygon 的拓扑合法性。
 * 返回 {ok, errors[], warnings[], stats}。
 * errors —— 违反硬性规则（自交、洞在外、重复边、环间穿越等），命中则操作无效；
 * warnings —— 接近退化的结构（过短边、近零面积），提示但不阻止。
 */
export function validateGeom(geom, eps) {
  const errors = [], warnings = [];
  const rings = []; // {ring, poly, idx, isHole}
  geom.forEach((poly, pi) => poly.forEach((ring, ri) => rings.push({ ring, poly: pi, idx: ri, isHole: ri > 0 })));

  for (const { ring, poly, idx, isHole } of rings) {
    const label = `形状${isHole ? '洞' : '外轮廓'}#${poly + 1}.${idx}`;
    if (ring.length < 3) {
      errors.push(`${label}：顶点数不足 3（${ring.length}）`);
      continue;
    }
    // 环内重复顶点（pinch / 沙漏点）
    for (const d of repeatedVertices(ring, eps)) {
      errors.push(`${label}：顶点在 ${fp(d.point)} 处重复经过（自接触），拓扑不明确`);
    }
    // 自交
    for (const s of ringSelfIntersections(ring, eps)) {
      errors.push(`${label}：边 ${s.i} 与边 ${s.j} 在 ${fp(s.point)} 处自交`);
    }
    // 过短边
    for (let i = 0; i < ring.length; i++) {
      const d = dist(ring[i], ring[(i + 1) % ring.length]);
      if (d <= eps) warnings.push(`${label}：边 ${i} 长度 ${f2(d)} ≤ ε（过短边，已按吸附规则处理或需检查）`);
    }
    // 近零面积
    const a = Math.abs(ringArea(ring));
    if (a <= eps * eps) warnings.push(`${label}：面积 ${f2(a)} ≤ ε²（接近退化的细缝）`);
  }

  // 环间关系
  for (let i = 0; i < rings.length; i++) {
    for (let j = i + 1; j < rings.length; j++) {
      const A = rings[i], B = rings[j];
      const { crossings } = ringRingIntersections(A.ring, B.ring, eps);
      if (crossings.length) {
        errors.push(`环 #${A.poly + 1}.${A.idx} 与环 #${B.poly + 1}.${B.idx} 在 ${fp(crossings[0].point)} 等处穿越相交（${crossings.length} 处）`);
        continue;
      }
      // 包含关系检查
      const pB = B.ring[0];
      const inA = pointInRing(A.ring, pB, eps / 10);
      const pA = A.ring[0];
      const inB = pointInRing(B.ring, pA, eps / 10);
      if (A.poly === B.poly) {
        // 同一 polygon 内：洞必须在外轮廓内；洞之间不得互相包含
        if (A.isHole && B.isHole) {
          if (inB === 'in') errors.push(`洞 #${A.poly + 1}.${A.idx} 嵌套在洞 #${B.poly + 1}.${B.idx} 内（洞的洞应是独立外轮廓）`);
          if (inA === 'in') errors.push(`洞 #${B.poly + 1}.${B.idx} 嵌套在洞 #${A.poly + 1}.${A.idx} 内（洞的洞应是独立外轮廓）`);
        }
        if (!A.isHole && B.isHole && inA !== 'in') errors.push(`洞 #${B.poly + 1}.${B.idx} 不在其外轮廓 #${A.poly + 1}.${A.idx} 内`);
        if (!B.isHole && A.isHole && inB !== 'in') errors.push(`洞 #${A.poly + 1}.${A.idx} 不在其外轮廓 #${B.poly + 1}.${B.idx} 内`);
      }
    }
  }

  // 包含深度奇偶校验（even-odd 规则）：外轮廓必须被偶数个环包含，洞必须被奇数个。
  // 该规则统一覆盖：洞在轮廓外、洞嵌套洞、外轮廓包含外轮廓（非岛）等非法结构；
  // 同时允许"洞中的岛"（岛的外轮廓深度为 2，合法）。
  for (let i = 0; i < rings.length; i++) {
    const { ring, poly, idx, isHole } = rings[i];
    const p = [(ring[0][0] + ring[1][0]) / 2, (ring[0][1] + ring[1][1]) / 2]; // 边中点，避开顶点共线
    let depth = 0;
    for (let j = 0; j < rings.length; j++) {
      if (i === j) continue;
      if (pointInRing(rings[j].ring, p, eps / 10) === 'in') depth++;
    }
    if (!isHole && depth % 2 === 1) {
      errors.push(`外轮廓 #${poly + 1}.${idx} 被奇数个环（${depth}）包含：应分类为洞，或岛的位置非法`);
    }
    if (isHole && depth % 2 === 0) {
      errors.push(`洞 #${poly + 1}.${idx} 未被任何外轮廓包含（深度 ${depth}）：洞必须严格位于外轮廓内`);
    }
  }

  // 重复边检测（跨环共享同一条边 → 零宽通道/重复边）
  const edgeMap = new Map();
  const q = v => Math.round(v / Math.max(eps, 1e-9));
  for (const { ring, poly, idx } of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const k1 = `${q(a[0])},${q(a[1])}`, k2 = `${q(b[0])},${q(b[1])}`;
      const key = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
      if (edgeMap.has(key)) {
        const prev = edgeMap.get(key);
        errors.push(`重复边：环 #${prev.poly + 1}.${prev.idx} 与环 #${poly + 1}.${idx} 共享 ${fp(a)}—${fp(b)} 段（零宽通道，已阻止）`);
      } else {
        edgeMap.set(key, { poly, idx });
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, stats: geomStats(geom) };
}

/**
 * 分类两个 MultiPolygon 的接触关系（判定结果会写入拓扑判定日志）。
 * 返回 {kind: 'disjoint'|'point-touch'|'edge-touch'|'overlap',
 *       points[], sharedEdges[], minDist, description}
 */
export function classifyTouch(geomA, geomB, eps) {
  const ringsA = geomA.flatMap(p => p);
  const ringsB = geomB.flatMap(p => p);
  const touches = [];   // 点接触
  const shared = [];    // 共线重叠段
  let crossings = 0;
  let minDist = Infinity;

  for (const ra of ringsA) {
    for (let i = 0; i < ra.length; i++) {
      const a1 = ra[i], a2 = ra[(i + 1) % ra.length];
      for (const rb of ringsB) {
        for (let j = 0; j < rb.length; j++) {
          const b1 = rb[j], b2 = rb[(j + 1) % rb.length];
          // 快速包围盒剪枝
          if (Math.max(a1[0], a2[0]) < Math.min(b1[0], b2[0]) - eps) continue;
          if (Math.max(b1[0], b2[0]) < Math.min(a1[0], a2[0]) - eps) continue;
          if (Math.max(a1[1], a2[1]) < Math.min(b1[1], b2[1]) - eps) continue;
          if (Math.max(b1[1], b2[1]) < Math.min(a1[1], a2[1]) - eps) continue;
          const hit = segSegClassify(a1, a2, b1, b2, eps);
          if (hit.type === 'cross') crossings++;
          else if (hit.type === 'overlap') shared.push(hit);
          else if (hit.type === 'touch') touches.push(hit);
          // 最近距离（粗算，disjoint 时下方会精确重算）
          for (const [p, c, d] of [[a1, b1, b2], [a2, b1, b2], [b1, a1, a2], [b2, a1, a2]]) {
            const { d: dd } = pointSegDist(p, c, d);
            if (dd < minDist) minDist = dd;
          }
        }
      }
    }
  }

  // 重叠/包含检测（无穿越时）：扫描双方所有边的中点。
  // 顶点可能恰好落在对方边界上（'on'），边中点更可靠；
  // 部分边重合的面积重叠（无穿越）只能靠中点入内检测发现。
  let containment = null;
  if (crossings === 0) {
    const scan = (g1, g2) => {
      let anyIn = false, anyOut = false;
      for (const poly of g1) for (const ring of poly) {
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i], b = ring[(i + 1) % ring.length];
          const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          const r = pointInGeom(g2, mid, eps / 10);
          if (r === 'in') anyIn = true;
          if (r === 'out') anyOut = true;
        }
      }
      return { anyIn, anyOut };
    };
    const ab = scan(geomA, geomB);
    const ba = scan(geomB, geomA);
    if (ab.anyIn || ba.anyIn) {
      containment = (ab.anyIn && !ab.anyOut) ? 'A-in-B' : (ba.anyIn && !ba.anyOut) ? 'B-in-A' : 'partial';
    }
  }

  let kind;
  if (crossings > 0 || containment) kind = 'overlap';
  else if (shared.length) kind = 'edge-touch';
  else if (touches.length) kind = 'point-touch';
  else kind = 'disjoint';

  // 最近距离独立计算（上面的包围盒剪枝会跳过远距离边对）
  if (kind === 'disjoint') {
    minDist = Infinity;
    for (const ra of ringsA) {
      for (let i = 0; i < ra.length; i++) {
        const a1 = ra[i], a2 = ra[(i + 1) % ra.length];
        for (const rb of ringsB) {
          for (let j = 0; j < rb.length; j++) {
            const b1 = rb[j], b2 = rb[(j + 1) % rb.length];
            for (const [p, c, d] of [[a1, b1, b2], [a2, b1, b2], [b1, a1, a2], [b2, a1, a2]]) {
              const { d: dd } = pointSegDist(p, c, d);
              if (dd < minDist) minDist = dd;
            }
          }
        }
      }
    }
  }

  // 描述按需生成（模板字符串若在对象字面量中会提前求值，空数组取 [0] 会崩溃）
  let description;
  if (kind === 'overlap') {
    description = `两形状区域重叠${containment === 'A-in-B' ? '（A 完全包含于 B）' : containment === 'B-in-A' ? '（B 完全包含于 A）' : ''}${shared.length ? `，另有 ${shared.length} 段共享边界` : ''}`;
  } else if (kind === 'edge-touch') {
    description = `两形状仅共享 ${shared.length} 段边界（共边接触）→ 按规则视为连通：合并时连成单一外轮廓，相交结果为零面积（视为空）`;
  } else if (kind === 'point-touch') {
    description = `两形状仅在 ${touches.length} 个点处接触（如 ${fp(touches[0].point)}）→ 按规则视为不连通：合并后保持独立外轮廓，相交视为空`;
  } else {
    description = `两形状分离，最近距离 ${f2(minDist)}${minDist <= eps ? ' ≤ ε，顶点已按吸附规则合并' : ' > ε'}`;
  }
  return {
    kind,
    points: touches.map(t => t.point),
    sharedEdges: shared.map(s => ({ a: s.a, b: s.b })),
    minDist,
    description,
  };
}

/** 点相对整个 MultiPolygon 的位置（even-odd） */
export function pointInGeom(geom, p, eps = 1e-9) {
  let on = false, depth = 0;
  for (const poly of geom) for (const ring of poly) {
    const r = pointInRing(ring, p, eps);
    if (r === 'on') on = true;
    else if (r === 'in') depth++;
  }
  if (on) return 'on';
  return depth % 2 === 1 ? 'in' : 'out';
}

function segSegClassify(a1, a2, b1, b2, eps) {
  const d1x = a2[0] - a1[0], d1y = a2[1] - a1[1];
  const d2x = b2[0] - b1[0], d2y = b2[1] - b1[1];
  const denom = d1x * d2y - d1y * d2x;
  const ex = b1[0] - a1[0], ey = b1[1] - a1[1];
  if (Math.abs(denom) < 1e-18) {
    if (Math.abs(ex * d1y - ey * d1x) > eps * Math.max(1, Math.hypot(d1x, d1y))) return { type: 'none' };
    const useX = Math.abs(d1x) >= Math.abs(d1y);
    const s1 = useX ? a1[0] : a1[1], s2 = useX ? a2[0] : a2[1];
    const t1 = useX ? b1[0] : b1[1], t2 = useX ? b2[0] : b2[1];
    const lo = Math.max(Math.min(s1, s2), Math.min(t1, t2));
    const hi = Math.min(Math.max(s1, s2), Math.max(t1, t2));
    if (lo > hi + eps) return { type: 'none' };
    if (hi - lo <= eps) {
      const m = (lo + hi) / 2;
      const p = useX ? [m, a1[1] + (Math.abs(d1x) < 1e-18 ? 0 : (m - a1[0]) * (d1y / d1x))] : [a1[0] + (Math.abs(d1y) < 1e-18 ? 0 : (m - a1[1]) * (d1x / d1y)), m];
      return { type: 'touch', point: p };
    }
    const pt = t => useX
      ? [t, a1[1] + (Math.abs(d1x) < 1e-18 ? 0 : (t - a1[0]) * (d1y / d1x))]
      : [a1[0] + (Math.abs(d1y) < 1e-18 ? 0 : (t - a1[1]) * (d1x / d1y)), t];
    return { type: 'overlap', a: pt(lo), b: pt(hi), length: hi - lo };
  }
  const t = (ex * d2y - ey * d2x) / denom;
  const u = (ex * d1y - ey * d1x) / denom;
  const PT = 1e-9; // 参数容差（无量纲），与几何容差 eps 分离
  if (t < -PT || t > 1 + PT || u < -PT || u > 1 + PT) return { type: 'none' };
  const proper = t > PT && t < 1 - PT && u > PT && u < 1 - PT;
  const tc = Math.max(0, Math.min(1, t));
  return { type: proper ? 'cross' : 'touch', point: [a1[0] + tc * d1x, a1[1] + tc * d1y] };
}

/** 校验摘要 → 单行文本（历史条目/面板共用） */
export function summarizeValidation(v) {
  const s = v.stats;
  const base = `外轮廓 ${s.outers} · 洞 ${s.holes} · 顶点 ${s.vertices} · 面积 ${s.area}`;
  if (!v.ok) return `✗ 无效（${v.errors.length} 项错误）｜${base}`;
  if (v.warnings.length) return `⚠ 有效（${v.warnings.length} 项警告）｜${base}`;
  return `✓ 有效｜${base}`;
}
