// registration.js — 依据锚点、比例与朝向完成两稿配准。
//
// 变换 x' = s R(θ) x + t，把候选稿坐标映射到基线稿坐标系。
// 用复数写法推导的 Umeyama 闭式最小二乘（去均值后 w = a·z）：
//   旋转支   a = (h00+h11) + i(h10−h01)， s=|a|/varP， θ=arg a， w=a·z
//   镜像支   a = (h00−h11) + i(h01+h10)， s=|a|/varP， θ=arg a， w=a·z̄
// 两支各自残差，较小者胜出（可禁用镜像）。
// 0 对锚点退化为恒等；1 对仅平移；也可手工指定 θ(°)/scale（平移取锚点均值）。

import { dist } from './geometry.js';
import { computeFeatures } from './entities.js';

export const DEG = 180 / Math.PI;

/** 构造相似变换。reflected=true 时为镜像：x'=cos·x+sin·y，y'=sin·x−cos·y。 */
export function makeTransform({ tx = 0, ty = 0, theta = 0, scale = 1, reflected = false } = {}) {
  const cos = Math.cos(theta), sin = Math.sin(theta);
  return {
    tx, ty, theta, scale, reflected, cos, sin,
    apply(p) {
      const [x, y] = p;
      const rx = reflected ? cos * x + sin * y : cos * x - sin * y;
      const ry = reflected ? sin * x - cos * y : sin * x + cos * y;
      return [scale * rx + tx, scale * ry + ty];
    },
    applyPoints(pts) { return pts.map((p) => this.apply(p)); },
  };
}

export const identityTransform = () => makeTransform({});

function mean(P) {
  let x = 0, y = 0;
  for (const p of P) { x += p[0]; y += p[1]; }
  return [x / P.length, y / P.length];
}

function hMatrix(P, Q, mp, mq) {
  let varP = 0, h00 = 0, h01 = 0, h10 = 0, h11 = 0;
  for (let i = 0; i < P.length; i++) {
    const px = P[i][0] - mp[0], py = P[i][1] - mp[1];
    const qx = Q[i][0] - mq[0], qy = Q[i][1] - mq[1];
    varP += px * px + py * py;
    h00 += qx * px; h01 += qx * py;
    h10 += qy * px; h11 += qy * py;
  }
  const n = P.length;
  return { varP: varP / n, h00: h00 / n, h01: h01 / n, h10: h10 / n, h11: h11 / n };
}

/** 由 H 矩阵构造一支解并补上平移。 */
function branchSpec(M, reflected, mp, mq) {
  const { varP } = M;
  let spec;
  if (!reflected) {
    spec = {
      scale: Math.hypot(M.h00 + M.h11, M.h10 - M.h01) / varP,
      theta: Math.atan2(M.h10 - M.h01, M.h00 + M.h11),
      reflected: false,
    };
  } else {
    // 镜像支 w = a·z̄，a = s·e^{iθ}：
    //   w_x = s( cosθ·x + sinθ·y)
    //   w_y = s( sinθ·x − cosθ·y)
    // 与 makeTransform(reflected=true) 的矩阵一致；a = [(h00−h11)+i(h01+h10)]/varP。
    spec = {
      scale: Math.hypot(M.h00 - M.h11, M.h01 + M.h10) / varP,
      theta: Math.atan2(M.h01 + M.h10, M.h00 - M.h11),
      reflected: true,
    };
  }
  const t = makeTransform(spec);
  spec.tx = mq[0] - t.apply(mp)[0];
  spec.ty = mq[1] - t.apply(mp)[1];
  return spec;
}

/** Umeyama 两支解 [旋转支, 镜像支]。 */
export function fitSimilarityBranches(P, Q) {
  const mp = mean(P), mq = mean(Q);
  const M = hMatrix(P, Q, mp, mq);
  if (M.varP < 1e-18) {
    const d = { tx: mq[0] - mp[0], ty: mq[1] - mp[1], theta: 0, scale: 1, reflected: false };
    return [d, d];
  }
  return [branchSpec(M, false, mp, mq), branchSpec(M, true, mp, mq)];
}

/** Umeyama 相似变换闭式解（残差较小者胜出）。 */
export function fitSimilarity(P, Q) {
  const branches = fitSimilarityBranches(P, Q);
  const rms = (b) => {
    const t = makeTransform(b);
    let s = 0;
    for (let i = 0; i < P.length; i++) s += dist(t.apply(P[i]), Q[i]) ** 2;
    return Math.sqrt(s / P.length);
  };
  return rms(branches[0]) <= rms(branches[1]) ? branches[0] : branches[1];
}

/** 同名锚点配对：显式 pairs 优先，否则按 anchorId/label 自动同名匹配。 */
export function resolveAnchorPairs(baseDraw, candDraw, explicit) {
  if (Array.isArray(explicit) && explicit.length) {
    return explicit.map(([b, c]) => [String(b), String(c)]);
  }
  const out = [];
  for (const cb of baseDraw.anchors) {
    const cc = candDraw.anchors.find((a) => a.anchorId === cb.anchorId ||
      (cb.label && a.label === cb.label));
    if (cc) out.push([cb.anchorId, cc.anchorId]);
  }
  return out;
}

/**
 * 配准。
 * @param params { anchorPairs?:[[bId,cId]…], thetaDeg?, scale?, allowReflection?(true) }
 *   同时给出 thetaDeg 与 scale 时视为手工指定（平移取锚点均值）。
 * @returns { params, transform, anchorResiduals, rms, method }
 */
export function estimateRegistration(baseDraw, candDraw, params = {}) {
  const pairs = resolveAnchorPairs(baseDraw, candDraw, params.anchorPairs);
  const anchorPt = (draw, id) => {
    const a = draw.anchors.find((x) => x.anchorId === id);
    return [a.x, a.y];
  };
  let spec;
  let method;

  if (params.thetaDeg != null && params.scale != null) {
    spec = { theta: params.thetaDeg / DEG, scale: params.scale, reflected: false };
    if (pairs.length) {
      const ref = mean(pairs.map(([b]) => anchorPt(baseDraw, b)));
      const src = mean(pairs.map(([, c]) => anchorPt(candDraw, c)));
      const mapped = makeTransform(spec).apply(src);
      spec.tx = ref[0] - mapped[0];
      spec.ty = ref[1] - mapped[1];
      method = 'manual+anchors';
    } else {
      spec.tx = 0; spec.ty = 0;
      method = 'manual';
    }
  } else if (pairs.length === 0) {
    spec = { tx: 0, ty: 0, theta: 0, scale: 1, reflected: false };
    method = 'identity';
  } else if (pairs.length === 1) {
    const q = anchorPt(baseDraw, pairs[0][0]);
    const p = anchorPt(candDraw, pairs[0][1]);
    spec = { tx: q[0] - p[0], ty: q[1] - p[1], theta: 0, scale: 1, reflected: false };
    method = 'translation';
  } else {
    const P = pairs.map(([, c]) => anchorPt(candDraw, c));
    const Q = pairs.map(([b]) => anchorPt(baseDraw, b));
    const allowReflection = params.allowReflection !== false;
    spec = allowReflection
      ? fitSimilarity(P, Q)
      : fitSimilarityBranches(P, Q)[0];
    method = spec.reflected ? 'umeyama-reflect' : 'umeyama';
  }

  const transform = makeTransform(spec);
  const anchorResiduals = pairs.map(([bid, cid]) => ({
    baseAnchorId: bid,
    candAnchorId: cid,
    error: dist(transform.apply(anchorPt(candDraw, cid)), anchorPt(baseDraw, bid)),
  }));
  const rms = anchorResiduals.length
    ? Math.sqrt(anchorResiduals.reduce((s, r) => s + r.error ** 2, 0) / anchorResiduals.length)
    : 0;

  return {
    params: {
      anchorPairs: pairs,
      thetaDeg: spec.theta * DEG,
      scale: spec.scale,
      allowReflection: params.allowReflection !== false,
      manual: !!(params.thetaDeg != null && params.scale != null),
    },
    transform,
    anchorResiduals,
    rms,
    method,
  };
}

/** 把候选稿整体经变换搬到基线坐标系，图元特征重算。 */
export function transformDrawing(draw, transform) {
  return {
    ...draw,
    anchors: draw.anchors.map((a) => {
      const [x, y] = transform.apply([a.x, a.y]);
      return { ...a, x, y };
    }),
    entities: draw.entities.map((e) => {
      const ne = { ...e, points: transform.applyPoints(e.points) };
      if (e.shape === 'circle') {
        const [cx, cy] = transform.apply([e.cx, e.cy]);
        ne.cx = cx; ne.cy = cy; ne.r = e.r * transform.scale;
      }
      ne.features = computeFeatures(ne);
      return ne;
    }),
  };
}
