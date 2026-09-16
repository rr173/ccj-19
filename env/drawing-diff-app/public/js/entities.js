// entities.js — 图纸解析、图元规范化、稳定身份与几何特征。
//
// 图纸 JSON（dwg2d-diff/1）：
//   { name?, units?, anchors?: [{ id?, x, y, label? }],
//     entities: [
//       { type: 'region',  id?, label?, points: [[x,y], ...] },
//       { type: 'hole',    id?, label?, cx, cy, r } | { type:'hole', id?, contour:[[x,y],...] },
//       { type: 'segment', id?, label?, points: [[x,y], ...] },
//     ] }
//
// 稳定身份规则：显式 id 优先；否则由 类型+几何内容 哈希派生（cid）。
// 因此几何相同的图元即使数组顺序变化、文件重新载入，身份仍不变——
// 决议与批注正是通过该身份跨重算/重载归属原处。

import {
  TAU, dist, ringArea, ringLength, ringCentroid, boundsOf, sampleRing, samplePolyline, heading,
} from './geometry.js';
import { fnv1a64, canonical } from './hash.js';

export const KINDS = ['region', 'hole', 'segment'];

function fail(msg) {
  const err = new Error(msg);
  err.code = 'DWG_PARSE';
  throw err;
}

function asPoint(v, ctx) {
  if (!Array.isArray(v) || v.length < 2 || typeof v[0] !== 'number' || typeof v[1] !== 'number' ||
      !Number.isFinite(v[0]) || !Number.isFinite(v[1])) {
    fail(`${ctx} 不是合法二维点`);
  }
  return [v[0], v[1]];
}

/** 圆形离散为闭合采样轮廓（仅用于叠层与形状比较）。 */
export function circleContour(cx, cy, r, n = 64) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (TAU * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

function geomCanon(e) {
  // 稳定身份只认类型与几何（与 id/label/颜色等元数据无关）
  if (e.kind === 'hole' && e.shape === 'circle') {
    return { k: e.kind, shape: 'circle', cx: e.cx, cy: e.cy, r: e.r };
  }
  return { k: e.kind, shape: 'contour', pts: e.points };
}

export function contentId(e) {
  return fnv1a64(canonical(geomCanon(e)));
}

/**
 * 解析图纸。返回 { name, units, anchors:[{anchorId,x,y,label,ord}],
 * entities:[规范化图元], fingerprint }。
 * fingerprint 与图元/锚点数组顺序无关，供"重复导入同一对文件"去重。
 */
export function parseDrawing(raw, role = 'base') {
  if (!raw || typeof raw !== 'object') fail('图纸必须是 JSON 对象');
  if (raw.format && raw.format !== 'dwg2d-diff/1') fail(`不支持的图纸格式：${raw.format}`);
  if (!Array.isArray(raw.entities)) fail('图纸缺少 entities 数组');

  const entities = raw.entities.map((en, i) => normalizeEntity(en, role, i));
  const anchors = (raw.anchors || []).map((a, i) => {
    const [x, y] = asPoint([a.x, a.y], `锚点#${i + 1}`);
    return {
      anchorId: a.id != null ? String(a.id) : `A${i + 1}`,
      x, y,
      label: a.label != null ? String(a.label) : `锚点${i + 1}`,
    };
  });

  // 顺序无关指纹：逐项规范化串排序后哈希
  const ents = entities
    .map((e) => canonical({ id: e.sourceId ?? null, g: geomCanon(e) }))
    .sort();
  const anc = anchors
    .map((a) => canonical({ id: a.anchorId, x: a.x, y: a.y }))
    .sort();
  const fp = fnv1a64(canonical({ name: raw.name || null, ents, anc }));

  return {
    name: raw.name || `${role === 'base' ? '基线稿' : '候选稿'}`,
    units: raw.units || 'mm',
    anchors,
    entities: entities.map((e) => ({ ...e, features: computeFeatures(e) })),
    fingerprint: fp,
  };
}

function normalizeEntity(en, role, i) {
  if (!en || typeof en !== 'object') fail(`图元#${i + 1} 必须是对象`);
  const type = en.type;
  if (!KINDS.includes(type)) fail(`图元#${i + 1} 类型非法：${type}`);

  const base = {
    role,
    ord: i,
    eid: `${role === 'base' ? 'B' : 'C'}${i + 1}`,
    sourceId: en.id != null ? String(en.id) : null,
    label: en.label != null ? String(en.label) : null,
  };

  let e;
  if (type === 'hole' && typeof en.r === 'number' && typeof en.cx === 'number' && typeof en.cy === 'number') {
    if (!(en.r > 0)) fail(`孔 #${i + 1} 半径必须为正`);
    e = {
      ...base, kind: 'hole', shape: 'circle',
      cx: en.cx, cy: en.cy, r: en.r,
      points: circleContour(en.cx, en.cy, en.r),
    };
  } else {
    const rawPts = Array.isArray(en.contour) ? en.contour : en.points;
    if (!Array.isArray(rawPts) || rawPts.length < (type === 'segment' ? 2 : 3)) {
      fail(`图元#${i + 1} 顶点不足`);
    }
    const pts = rawPts.map((p, j) => asPoint(p, `图元#${i + 1} 顶点#${j + 1}`));
    if (type === 'segment') {
      e = { ...base, kind: 'segment', shape: 'polyline', points: pts };
    } else if (type === 'hole') {
      e = { ...base, kind: 'hole', shape: 'contour', points: pts };
    } else {
      // 封闭区域：统一首点不重复、面积取绝对值
      const closed = pts.length > 1 && dist(pts[0], pts[pts.length - 1]) < 1e-12
        ? pts.slice(0, -1) : pts;
      if (ringArea(closed) < 0) closed.reverse();
      e = { ...base, kind: 'region', shape: 'contour', points: closed };
    }
  }
  e.stableId = en.id != null ? String(en.id) : contentId(e);
  e.cid = contentId(e);
  return e;
}

/** 折线弧长中点（用于开放线段"位置"参照）。 */
function midpointAtHalf(points) {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) total += dist(points[i], points[i + 1]);
  let target = total / 2, ei = 0;
  while (ei < points.length - 2 && target > dist(points[ei], points[ei + 1])) {
    target -= dist(points[ei], points[ei + 1]);
    ei++;
  }
  const a = points[ei], b = points[ei + 1];
  const l = dist(a, b);
  const t = l === 0 ? 0 : target / l;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** 几何特征（质心、面积、周长/长度、包围盒、圆形半径）。假定已在目标坐标系。 */
export function computeFeatures(e) {
  const f = {};
  f.bounds = boundsOf(e.points);
  if (e.kind === 'segment') {
    f.centroid = midpointAtHalf(e.points);
    let l = 0;
    for (let i = 0; i < e.points.length - 1; i++) l += dist(e.points[i], e.points[i + 1]);
    f.length = l;
    f.perimeter = l;
    f.area = 0;
    f.heading = heading(e.points[0], e.points[e.points.length - 1]);
  } else {
    f.centroid = ringCentroid(e.points);
    f.area = Math.abs(ringArea(e.points));
    f.perimeter = ringLength(e.points);
    f.radius = e.shape === 'circle' ? e.r : null;
  }
  return f;
}

/** 等弧长采样（按周长自适应样本数，封顶 128）。 */
export function sampleEntity(e, n) {
  const target = n || Math.max(16, Math.min(128, Math.round((e.features?.perimeter || ringLength(e.points)) / 2)));
  if (e.kind === 'segment') return samplePolyline(e.points, Math.min(target, 96));
  return sampleRing(e.points, target);
}
