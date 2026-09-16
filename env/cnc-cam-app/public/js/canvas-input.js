// canvas-input.js — 产品画布（polybool-app）选中对象 → CAM 加工输入的转换桥（纯函数，无 DOM 依赖）
//
// 背景：加工界面原本只展示内置预置场景（SCENARIOS），产品画布上的对象从未进入加工流程。
// 本模块负责把产品画布跳转时携带的“该对象当时轮廓坐标”转换为 CAM.computeToolpath 的输入；
// 每次进入都重新携带最新坐标——对象被移动 / 缩放 / 调整顶点后再次进入，加工界面读到的就是更新后的坐标。
//
// 载荷协议（encodeURIComponent(JSON) 后放在 URL 的 ?canvas= 或 #canvas=）：
//   { version: 1, name: string, geom: MultiPolygon }
//   MultiPolygon = [ Polygon, ... ]，Polygon = [ 外环, 洞, ... ]，环 = [[x, y], ...]
//   （与 polygon-clipping GeoJSON 风格一致；产品画布坐标 y 向下，CAM 世界坐标 y 向上）
'use strict';

const CANVAS_SOURCE_ID = '__from-canvas__';
const CANVAS_PARAM = 'canvas';

/** 有限数判定（拒绝 NaN/Infinity）。 */
function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 校验产品画布几何：MultiPolygon = 多边形数组；多边形 = 至少一个环；
 * 环 = 至少 3 个点；点 = 恰好两个有限数。返回错误信息字符串，合法返回 null。
 */
function validateCanvasGeom(geom) {
  if (!Array.isArray(geom) || geom.length === 0) return '几何为空（没有可加工的多边形）';
  for (let pi = 0; pi < geom.length; pi++) {
    const poly = geom[pi];
    if (!Array.isArray(poly) || poly.length === 0) return `多边形 ${pi + 1} 没有轮廓环`;
    for (let ri = 0; ri < poly.length; ri++) {
      const ring = poly[ri];
      if (!Array.isArray(ring) || ring.length < 3) {
        return `多边形 ${pi + 1} 的环 ${ri + 1} 至少需要 3 个顶点`;
      }
      for (let vi = 0; vi < ring.length; vi++) {
        const p = ring[vi];
        if (!Array.isArray(p) || p.length !== 2 || !isNum(p[0]) || !isNum(p[1])) {
          return `多边形 ${pi + 1} 环 ${ri + 1} 的顶点 ${vi + 1} 不是 [x, y] 数字对`;
        }
      }
    }
  }
  return null;
}

/**
 * 产品画布几何 → CAM rings。
 * 坐标系：产品画布 y 轴向下（屏幕坐标），CAM 世界 y 轴向上，故统一翻转 y；x 不变。
 * 内外标记：每个多边形首个环为外轮廓（outer），其余为其洞（hole）；
 * 最终嵌套深度仍由 CAM.normalizeInput 按拓扑包含关系复核，标记只提供初值。
 */
function geomToRings(geom) {
  const rings = [];
  let n = 0;
  geom.forEach((poly, pi) => {
    poly.forEach((ring, ri) => {
      n += 1;
      rings.push({
        id: `cv-${n}`,
        name: ri === 0 ? `对象${pi + 1}` : `对象${pi + 1}·洞${ri}`,
        kind: ri === 0 ? 'outer' : 'hole',
        points: ring.map(([x, y]) => ({ x, y: -y })),
      });
    });
  });
  return rings;
}

/** 全部轮廓点的包围盒（CAM 坐标系）；无点返回 null。 */
function ringsBBox(rings) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings) {
    for (const p of r.points) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/**
 * 解析产品画布载荷（已 decode 或未 decode 的字符串均可）。
 * 成功返回 { ok: true, input }，input 可直接交给 CAM.computeToolpath；
 * 失败返回 { ok: false, error }，调用方应回退预置场景并提示。
 */
function parseCanvasPayload(raw) {
  if (typeof raw !== 'string' || !raw.length) return { ok: false, error: '缺少产品画布数据' };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // 兼容调用方未 decode 的情况
    try { data = JSON.parse(decodeURIComponent(raw)); } catch { return { ok: false, error: '产品画布数据不是有效的 JSON' }; }
  }  if (!data || typeof data !== 'object' || !Array.isArray(data.geom)) {
    return { ok: false, error: '产品画布数据格式无效（缺少 geom）' };
  }
  const verr = validateCanvasGeom(data.geom);
  if (verr) return { ok: false, error: verr };
  const rings = geomToRings(data.geom);
  const bb = ringsBBox(rings);
  const pad = 20;
  const home = bb ? { x: bb.minX - pad, y: bb.minY - pad } : { x: 0, y: 0 };
  return {
    ok: true,
    name: typeof data.name === 'string' && data.name ? data.name : '产品画布对象',
    input: { rings, zones: [], home, params: {} },
  };
}

/** 从查询串（"a=1&canvas=..."，不含前导 ?/#）中取出画布载荷并解析。 */
function parseCanvasQuery(search) {
  if (typeof search !== 'string' || !search) return { ok: false, error: '无产品画布参数' };
  for (const part of search.split('&')) {
    const eq = part.indexOf('=');
    const key = eq < 0 ? part : part.slice(0, eq);
    if (key !== CANVAS_PARAM) continue;
    const val = eq < 0 ? '' : part.slice(eq + 1).replace(/\+/g, '%20');
    let decoded;
    try { decoded = decodeURIComponent(val); } catch { return { ok: false, error: '产品画布数据编码损坏' }; }
    return parseCanvasPayload(decoded);
  }
  return { ok: false, error: '无产品画布参数' };
}

/**
 * 从浏览器 location 读取产品画布载荷（query 优先，hash 兜底；hash 不发往服务器，适合大坐标集）。
 * 在无 DOM 的测试环境中安全返回 { ok:false }。
 */
function readCanvasLocation(loc) {
  const l = loc || (typeof location !== 'undefined' ? location : null);
  if (!l) return { ok: false, error: '非浏览器环境' };
  const q = (l.search || '').replace(/^\?/, '');
  if (q) {
    const r = parseCanvasQuery(q);
    if (r.ok || r.error !== '无产品画布参数') return r;
  }
  const h = (l.hash || '').replace(/^#/, '');
  if (h) return parseCanvasQuery(h);
  return { ok: false, error: '无产品画布参数' };
}

const canvasInputApi = {
  CANVAS_SOURCE_ID,
  CANVAS_PARAM,
  validateCanvasGeom,
  geomToRings,
  ringsBBox,
  parseCanvasPayload,
  parseCanvasQuery,
  readCanvasLocation,
};

if (typeof window !== 'undefined') window.CanvasInput = canvasInputApi;
if (typeof module !== 'undefined' && module.exports) module.exports = canvasInputApi;
if (typeof globalThis !== 'undefined' && typeof window === 'undefined') globalThis.CanvasInput = canvasInputApi;
