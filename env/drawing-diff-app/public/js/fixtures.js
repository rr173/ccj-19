// fixtures.js — 内置演示图纸对。均为 dwg2d-diff/1 JSON，可在"导入"页直接载入。

export const DEMOS = {
  rigid: {
    label: '刚体移动（平移+旋转，应零差异）',
    build() {
      const base = {
        name: '底板-基线', units: 'mm',
        anchors: anchorSet(0),
        entities: [
          { type: 'region', id: 'R-FRAME', points: rect(0, 0, 240, 160) },
          { type: 'region', id: 'R-NOTCH', points: rect(180, 110, 40, 40) },
          { type: 'hole', id: 'H-A', cx: 40, cy: 40, r: 8 },
          { type: 'hole', id: 'H-B', cx: 120, cy: 80, r: 6 },
          { type: 'segment', id: 'S-1', points: [[20, 140], [160, 20]] },
        ],
      };
      const t = makeRigid(35, 60, -25, 1);
      const cand = {
        name: '底板-候选（重拍）', units: 'mm',
        anchors: [0, 1, 2].map((i) => ({ id: `A${i + 1}`, x: t(anchorPts()[i])[0], y: t(anchorPts()[i])[1] })),
        entities: base.entities.map((e) => transformEntity(e, t, 1)),
      };
      return { base, cand };
    },
  },

  holeMove: {
    label: '孔位偏移（距离+方向）',
    build() {
      const base = {
        name: '安装板-基线', units: 'mm',
        anchors: anchorSet(0),
        entities: [
          { type: 'region', id: 'R1', points: rect(0, 0, 240, 160) },
          { type: 'hole', id: 'H-MOVE', cx: 70, cy: 60, r: 7 },
          { type: 'hole', id: 'H-FIX', cx: 190, cy: 120, r: 7 },
        ],
      };
      const cand = {
        name: '安装板-候选', units: 'mm',
        anchors: anchorSet(0),
        entities: [
          { type: 'region', id: 'R1', points: rect(0, 0, 240, 160) },
          { type: 'hole', id: 'H-MOVE', cx: 82, cy: 51, r: 7 }, // 偏移 (12,-9) → 15 / -36.9°
          { type: 'hole', id: 'H-FIX', cx: 190, cy: 120, r: 7 },
        ],
      };
      return { base, cand };
    },
  },

  split: {
    label: '区域一拆二（拓扑改动）',
    build() {
      const base = {
        name: '盖板-基线', units: 'mm',
        anchors: anchorSet(0),
        entities: [
          { type: 'region', id: 'R1', points: rect(20, 30, 160, 100) },
          { type: 'hole', id: 'H1', cx: 60, cy: 80, r: 5 },
        ],
      };
      const cand = {
        name: '盖板-候选（开槽分件）', units: 'mm',
        anchors: anchorSet(0),
        entities: [
          { type: 'region', id: 'R-L', points: rect(20, 30, 78, 100) },
          { type: 'region', id: 'R-R', points: rect(102, 30, 78, 100) },
          { type: 'hole', id: 'H1', cx: 60, cy: 80, r: 5 },
        ],
      };
      return { base, cand };
    },
  },

  ambiguous: {
    label: '双孔相似（人工消歧）',
    build() {
      const base = {
        name: '对称件-基线', units: 'mm',
        anchors: anchorSet(0),
        entities: [
          { type: 'region', id: 'R1', points: rect(-150, -100, 300, 200).map(([x, y]) => [x + 120, y + 80]) },
          { type: 'hole', id: 'H-Q', cx: 120, cy: 80, r: 3 },
        ],
      };
      const cand = {
        name: '对称件-候选（两孔位存疑）', units: 'mm',
        anchors: anchorSet(0),
        entities: [
          { type: 'region', id: 'R1', points: rect(-150, -100, 300, 200).map(([x, y]) => [x + 120, y + 80]) },
          { type: 'hole', id: 'H-L', cx: 111, cy: 80, r: 3 },
          { type: 'hole', id: 'H-R', cx: 129, cy: 80, r: 3 },
        ],
      };
      return { base, cand };
    },
  },

  noise: {
    label: '精度噪声 + 一处真实改动',
    build() {
      const jitter = 0.15;
      const base = {
        name: '钣金件-基线', units: 'mm',
        anchors: anchorSet(0),
        entities: [
          { type: 'region', id: 'R1', points: rect(0, 0, 240, 160) },
          { type: 'hole', id: 'H1', cx: 40, cy: 40, r: 6 },
          { type: 'hole', id: 'H2', cx: 200, cy: 120, r: 6 },
          { type: 'segment', id: 'S1', points: [[30, 130], [210, 30]] },
        ],
      };
      const cand = {
        name: '钣金件-候选', units: 'mm',
        anchors: anchorSet(jitter),
        entities: [
          { type: 'region', id: 'R1', points: rect(jitter, -jitter, 240, 160).map(([x, y], i) =>
            [x + (i === 2 ? jitter : 0), y]) },
          { type: 'hole', id: 'H1', cx: 40 + jitter, cy: 40 - jitter, r: 6.05 },
          { type: 'hole', id: 'H2', cx: 206, cy: 115.5, r: 6 }, // 真实改动：偏移 (6,-4.5)=7.5
          { type: 'segment', id: 'S1', points: [[30, 130], [210 + jitter, 30 + jitter]] },
        ],
      };
      return { base, cand };
    },
  },
};

function rect(x, y, w, h) {
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}
function anchorPts() {
  return [[0, 0], [240, 0], [240, 160]];
}
function anchorSet(jitter = 0) {
  return anchorPts().map(([x, y], i) => ({
    id: `A${i + 1}`, x: x + (i ? jitter : 0), y: y + (i === 2 ? -jitter : 0),
  }));
}
function makeRigid(deg, tx, ty, s) {
  const th = (deg * Math.PI) / 180, c = Math.cos(th), sn = Math.sin(th);
  return ([x, y]) => [s * (c * x - sn * y) + tx, s * (sn * x + c * y) + ty];
}
function transformEntity(e, t, s = 1) {
  if (e.type === 'hole' && e.r != null) {
    const [cx, cy] = t([e.cx, e.cy]);
    return { ...e, cx, cy, r: e.r * s };
  }
  return { ...e, points: e.points.map(t) };
}
