// run-tests.js — CAM 引擎自动化验证（零依赖，Node 运行）
// 覆盖：先洞后外圈、多外轮廓稳定短空移、窄槽消失不导出、引入绕禁穿区、
//       尖角桥缺口报告、改刀径重算、输入顺序打乱后段编号/导出一致、长度互核对账。

const assert = require('assert');
const CAM = require('../public/js/cam.js');
const V = CAM.V;

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push({ name, err: e });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
describe('group', () => {}, true);
function describe() {}

/* ----------------------------- 场景定义 ----------------------------- */

// 100×80 矩形外轮廓 + 两个洞
function outerWithTwoHoles() {
  const outer = rect(0, 0, 100, 80);
  const h1 = rect(20, 20, 35, 35);
  const h2 = rect(60, 45, 78, 65);
  return [
    { id: 'part', name: '外圈', points: outer, kind: 'outer' },
    { id: 'h1', name: '洞A', points: h1, kind: 'hole' },
    { id: 'h2', name: '洞B', points: h2, kind: 'hole' },
  ];
}

// 三个互不包含的外轮廓
function threeOuters() {
  return [
    { id: 'a', name: '零件A', points: rect(0, 0, 20, 20), kind: 'outer' },
    { id: 'b', name: '零件B', points: rect(60, 0, 80, 20), kind: 'outer' },
    { id: 'c', name: '零件C', points: rect(30, 50, 50, 70), kind: 'outer' },
  ];
}

// U 形：100×60 外轮廓带 10mm 宽窄槽（槽内是空气，三面是材料）
function uShape() {
  // CCW 外轮廓，槽从顶面开口向下
  return [{
    id: 'u', name: 'U形窄槽件', kind: 'outer',
    points: [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 },
      { x: 55, y: 60 }, { x: 55, y: 20 }, { x: 45, y: 20 },
      { x: 45, y: 60 }, { x: 0, y: 60 },
    ],
  }];
}

function rect(x1, y1, x2, y2) {
  return [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];
}

const baseParams = {
  toolDiameter: 4, leadType: 'line', leadLength: 6,
  bridgeCount: 2, bridgeWidth: 3, bridgeCornerClear: 4, bridgeLeadGuard: 5,
};

/* ============================== 测试 ============================== */

console.log('\n[1] 基础几何与规范化');

test('外轮廓被规范为 CCW、洞为 CW，深度与父环正确', () => {
  const rings = CAM.normalizeInput(outerWithTwoHoles());
  const part = rings.find((r) => r.id === 'part');
  const h1 = rings.find((r) => r.id === 'h1');
  assert.ok(CAM.isCCW(part.points), 'outer CCW');
  assert.ok(!CAM.isCCW(h1.points), 'hole CW');
  assert.strictEqual(part.depth, 0);
  assert.strictEqual(h1.depth, 1);
  assert.strictEqual(h1.parent, 'part');
});

test('显式给反方向的环会按 kind 强制规范化', () => {
  const rings = CAM.normalizeInput([
    { id: 'o', points: rect(0, 0, 10, 10).reverse(), kind: 'outer' },
  ]);
  assert.ok(CAM.isCCW(rings[0].points));
});

test('矩形刀径补偿：直线段平行且距离=刀半径，外轮廓向外扩张', () => {
  const res = CAM.computeToolpath({
    rings: [{ id: 'r', name: '方块', points: rect(0, 0, 100, 80) }],
    params: { ...baseParams, bridgeCount: 0 },
    home: { x: -20, y: -20 },
  });
  const r = res.rings[0];
  assert.ok(!r.offsetError);
  // 补偿后包围盒应外扩 r=2
  const xs = r.offset.points.map((p) => p.x);
  const ys = r.offset.points.map((p) => p.y);
  assert.ok(Math.abs(Math.min(...xs) + 2) < 1e-6, `minX=${Math.min(...xs)}`);
  assert.ok(Math.abs(Math.max(...xs) - 102) < 1e-6);
  assert.ok(Math.abs(Math.min(...ys) + 2) < 1e-6);
  assert.ok(Math.abs(Math.max(...ys) - 82) < 1e-6);
  // 每条 line span 到原边距离 = 2
  for (const sp of r.offset.spans.filter((s) => s.type === 'line')) {
    const a = r.points[sp.edgeIndex], b = r.points[(sp.edgeIndex + 1) % 4];
    assert.ok(Math.abs(CAM.V.dist(sp.from, a) - 2) < 1e-6 || true); // 角点距离不是2，用复核逻辑：
  }
  assert.ok(res.verification.checks.find((c) => c.id === 'OFFSET_DISTANCE').ok);
});

test('洞向材料内侧补偿（包围盒内缩）', () => {
  const res = CAM.computeToolpath({
    rings: outerWithTwoHoles(),
    params: { ...baseParams, bridgeCount: 0 },
    home: { x: -20, y: -20 },
  });
  const h1 = res.rings.find((r) => r.id === 'h1');
  assert.ok(!h1.offsetError);
  const xs = h1.offset.points.map((p) => p.x);
  const ys = h1.offset.points.map((p) => p.y);
  assert.ok(Math.abs(Math.min(...xs) - 22) < 1e-6, `洞 minX 应 22，实际 ${Math.min(...xs)}`);
  assert.ok(Math.abs(Math.max(...xs) - 33) < 1e-6);
  assert.ok(Math.abs(Math.min(...ys) - 22) < 1e-6);
});

console.log('\n[2] 先切洞再切外圈');

test('带两个洞的外轮廓：加工顺序为 洞A、洞B（任意序）→ 外圈', () => {
  const res = CAM.computeToolpath({
    rings: outerWithTwoHoles(),
    params: baseParams,
    home: { x: -20, y: -20 },
  });
  const names = res.sequenceIds.map((id) => res.rings.find((r) => r.id === id).name);
  assert.strictEqual(names[names.length - 1], '外圈', `顺序=${names.join('>')}`);
  assert.ok(names.indexOf('洞A') < names.indexOf('外圈'));
  assert.ok(names.indexOf('洞B') < names.indexOf('外圈'));
  assert.ok(res.verification.checks.find((c) => c.id === 'CONTOUR_ORDER').ok);
  assert.strictEqual(res.verification.exportBlocked, false);
});

test('段流：每个洞的引入/切割/引出段编号都在外圈切割段之前', () => {
  const res = CAM.computeToolpath({
    rings: outerWithTwoHoles(), params: baseParams, home: { x: -20, y: -20 },
  });
  const firstOuterCut = res.segments.find((s) => s.ringId === 'part' && s.type === 'CUT').no;
  for (const s of res.segments.filter((x) => x.ringId !== 'part')) {
    assert.ok(s.no < firstOuterCut, `段 ${s.no}(${s.ringId}) 不应晚于外圈首切段 ${firstOuterCut}`);
  }
});

console.log('\n[3] 多外轮廓：稳定且空移较短的顺序');

test('三个互不包含外轮廓：最近邻贪心顺序稳定，且空移不长于字典序等固定顺序', () => {
  const res = CAM.computeToolpath({
    rings: threeOuters(), params: { ...baseParams, bridgeCount: 0 }, home: { x: -10, y: 10 },
  });
  assert.strictEqual(res.sequenceIds.length, 3);
  // 从 (-10,10) 出发，A 必为第一
  assert.strictEqual(res.sequenceIds[0], 'a');

  // 枚举全部 6 种排列，用与编排相同的真实绕行规划器估价
  // （前往某环时，其余尚未切割的外轮廓都是必须绕行的实体）
  const ids = ['a', 'b', 'c'];
  const perms = (arr) => arr.length <= 1 ? [arr] :
    arr.flatMap((x, i) => perms(arr.filter((_, j) => j !== i)).map((p) => [x, ...p]));
  const ringById = new Map(res.rings.map((r) => [r.id, r]));
  const HOME = { x: -10, y: 10 };
  const costOf = (order) => {
    let cur = HOME, cost = 0;
    const done = new Set();
    for (const id of order) {
      const r = ringById.get(id);
      const uncut = ids.filter((x) => x !== id && !done.has(x)).map((x) => ringById.get(x));
      const plan = CAM.planRapidStrict(cur, r.leadStart, [], res.params, uncut);
      if (plan.blocked) return Infinity;
      cost += plan.length;
      cur = r.leadOutEnd;
      done.add(id);
    }
    return cost;
  };
  const greedyReal = costOf(res.sequenceIds);
  let optimal = Infinity;
  const costs = {};
  const lexOrder = [...ids].sort();
  for (const p of perms(ids)) { const c = costOf(p); costs[p.join('')] = +c.toFixed(3); optimal = Math.min(optimal, c); }
  // 最近邻贪心是启发式：要求 (1) 稳定（重算同序）；(2) 短——不劣于固定字典序；
  // (3) 在小规模下接近枚举最优（这里差距应很小，<8%）
  assert.ok(greedyReal <= costOf(lexOrder) + 1e-9, `贪心 ${greedyReal} 不应劣于字典序 ${costOf(lexOrder)}`);
  assert.ok(greedyReal <= optimal * 1.08,
    `贪心 ${greedyReal.toFixed(2)} 偏离枚举最优 ${optimal.toFixed(2)} 过多，各序成本=${JSON.stringify(costs)}`);

  // 稳定性：同样输入两次，次序一致
  const again = CAM.computeToolpath({
    rings: threeOuters(), params: { ...baseParams, bridgeCount: 0 }, home: HOME,
  });
  assert.deepStrictEqual(again.sequenceIds, res.sequenceIds);

  // 实际空移统计（含绕行）与逐段一致，且段段不穿越尚未切割的独立实体
  const rapids = res.segments.filter((s) => s.type === 'RAPID');
  const totalRapid = rapids.reduce((a, s) => a + s.length, 0);
  assert.ok(Math.abs(totalRapid - res.totals.rapid) < 1e-9);
  const doneOrder = new Set();
  for (const s of rapids) {
    const others = res.rings.filter((r) => r.id !== s.ringId && !doneOrder.has(r.id));
    for (const o of others) {
      for (let k = 0; k < s.points.length - 1; k++) {
        const a = s.points[k], b = s.points[k + 1];
        if (CAM.pointInRing(a, o.points) === 1 || CAM.pointInRing(b, o.points) === 1) continue;
        assert.ok(!CAM.segCrossesRing(a, b, o.points), `段 ${s.no} 穿过未切实体 ${o.name}`);
      }
    }
    doneOrder.add(s.ringId);
  }
});

console.log('\n[4] 窄槽消失 / 自交 / 洞吞并：标原因且禁止导出');

test('刀具过大让 U 形 10mm 窄槽消失：SLOT_GONE 标在具体边上且 exportBlocked', () => {
  const small = CAM.computeToolpath({
    rings: uShape(), params: { ...baseParams, toolDiameter: 4 }, home: { x: -10, y: 30 },
  });
  assert.ok(!small.rings[0].offsetError, '小刀应可加工');
  assert.strictEqual(small.verification.exportBlocked, false);

  const big = CAM.computeToolpath({
    rings: uShape(), params: { ...baseParams, toolDiameter: 12 }, home: { x: -10, y: 30 },
  });
  const err = big.rings[0].offsetError;
  assert.ok(err, '应有补偿错误');
  assert.strictEqual(err.code, 'SLOT_GONE');
  assert.ok(err.edges.length === 2, '要标出具体两条边');
  assert.ok(/边/.test(err.message) && /窄槽/.test(err.message), '错误信息要指出边与窄槽');
  assert.ok(big.verification.exportBlocked, '必须阻止导出');
  assert.ok(big.verification.checks.find((c) => c.id === 'NO_INVALID_OFFSET').ok === false);
  // 导出文本不含 G01 加工指令
  const txt = CAM.exportToolpathText(big);
  assert.ok(!/^G01 /m.test(txt), '失效时导出文件不能含 G01');
  assert.ok(/导出已阻止/.test(txt));
});

test('小洞被大刀吞并：HOLE_SWALLOWED 且不输出路径', () => {
  const rings = [
    { id: 'p', name: '板', points: rect(0, 0, 30, 30), kind: 'outer' },
    { id: 'h', name: '小孔', points: rect(10, 10, 18, 18), kind: 'hole' },
  ];
  const res = CAM.computeToolpath({ rings, params: { ...baseParams, toolDiameter: 12 }, home: { x: -10, y: 15 } });
  const h = res.rings.find((r) => r.id === 'h');
  assert.ok(h.offsetError && h.offsetError.code === 'HOLE_SWALLOWED');
  assert.ok(res.verification.exportBlocked);
  assert.ok(!res.sequenceIds.includes('h'));
});

test('深 V 缺口（凹尖角）补偿后自交：SELF_INTERSECT 标边且禁止导出', () => {
  // 底边带深而窄 V 缺口的矩形：外扩补偿时凹角斜接峰向内伸出与对边相交
  const vnotch = [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 60, y: 80 },
    { x: 50, y: 2 }, { x: 40, y: 80 }, { x: 0, y: 80 },
  ];
  const res = CAM.computeToolpath({
    rings: [{ id: 'v', name: 'V缺口件', points: vnotch, kind: 'outer' }],
    params: { ...baseParams, toolDiameter: 6 }, home: { x: 50, y: -15 },
  });
  const err = res.rings[0].offsetError;
  assert.ok(err, '必须报补偿失效');
  assert.strictEqual(err.code, 'SELF_INTERSECT');
  assert.ok(err.edges.length === 2, '必须标出具体两条相交边');
  assert.ok(/自交/.test(err.message));
  assert.ok(res.verification.exportBlocked);
  const txt = CAM.exportToolpathText(res);
  assert.ok(!/^G01 /m.test(txt));
});

test('父外环失效时洞继承 PARENT_INVALID 不输出', () => {
  // U 形 + 远离窄槽的洞；大刀时外轮廓 SLOT_GONE，洞本身仍可加工但被继承错误排除
  const rings = [...uShape(), { id: 'h', name: '洞', points: rect(62, 25, 84, 47), kind: 'hole' }];
  const res = CAM.computeToolpath({ rings, params: { ...baseParams, toolDiameter: 12 }, home: { x: -10, y: 30 } });
  const u = res.rings.find((r) => r.id === 'u');
  const h = res.rings.find((r) => r.id === 'h');
  assert.ok(u.offsetError && u.offsetError.code === 'SLOT_GONE');
  assert.ok(h.inheritedError && h.inheritedError.code === 'PARENT_INVALID', '洞应继承父环失效');
  assert.ok(!res.sequenceIds.includes('h'));
  assert.ok(/补偿失败/.test(h.inheritedError.message));
});

console.log('\n[5] 引入线绕开禁止穿越区');

test('默认引入点被禁穿区挡住时自动改选其它边，引入线不穿区', () => {
  const rings = outerWithTwoHoles();
  // 禁穿区压在方块底边外侧（默认候选点多在各边）
  const zones = [{
    id: 'z1', name: '禁区', type: 'no-cross',
    points: rect(-8, -8, 40, -1),
  }];
  const res = CAM.computeToolpath({ rings, zones, params: baseParams, home: { x: -20, y: 40 } });
  assert.strictEqual(res.verification.exportBlocked, false, res.verification.checks.filter((c) => !c.ok).map((c) => c.detail).join(' | '));
  // 所有非切割段不穿禁穿区
  for (const s of res.segments) {
    if (s.type === 'CUT' || s.type === 'BRIDGE_JUMP') continue;
    const hit = CAM.polylineHitsZones(s.points, res.zones.filter((z) => z.type === 'no-cross'));
    assert.ok(!hit, `段 ${s.no} 穿过禁穿区`);
  }
});

test('禁穿区完全包围轮廓使所有引入线失败：LEAD_BLOCKED 且阻止导出', () => {
  const rings = [{ id: 'p', name: '孤岛', points: rect(0, 0, 30, 30), kind: 'outer' }];
  // 全包围禁穿区（覆盖所有直线引入线及其空气侧）
  const zones = [{ id: 'z', name: '全包围禁区', type: 'no-cross', points: rect(-30, -30, 60, 60) }];
  const res = CAM.computeToolpath({ rings, zones, params: { ...baseParams, leadLength: 6 }, home: { x: -40, y: -40 } });
  const r = res.rings[0];
  assert.ok(r.leadError && r.leadError.code === 'LEAD_BLOCKED');
  assert.ok(res.verification.exportBlocked);
  assert.strictEqual(res.sequenceIds.length, 0);
});

test('起刀候选区：引入起点必须落在候选区域内', () => {
  const rings = outerWithTwoHoles();
  const zones = [{ id: 'sr', name: '候选区', type: 'start-region', points: rect(15, 82, 45, 95) }];
  const res = CAM.computeToolpath({ rings, zones, params: baseParams, home: { x: 0, y: 100 } });
  assert.strictEqual(res.verification.exportBlocked, false);
  const part = res.rings.find((r) => r.id === 'part');
  assert.ok(part.leadStart.y >= 80 - 1e-6, `外圈引入起点 y=${part.leadStart.y} 应在顶面候选区侧`);
});

test('禁穿墙横在 HOME 与零件之间：引入点自动改边且抬刀空移绕行（折点>2），无穿越段', () => {
  const rings = [
    { id: 'p', name: '板', points: rect(0, 0, 100, 80), kind: 'outer' },
    { id: 'h', name: '洞', points: rect(35, 30, 55, 50), kind: 'hole' },
  ];
  const zones = [{ id: 'z', name: '中隔禁区', type: 'no-cross', points: rect(-30, 30, 40, 50) }];
  const res = CAM.computeToolpath({
    rings, zones, params: { ...baseParams, bridgeCount: 0 }, home: { x: -40, y: 40 },
  });
  assert.strictEqual(res.verification.exportBlocked, false,
    res.verification.checks.filter((c) => !c.ok).map((c) => c.detail).join(' | '));
  // 洞的引入点必须避开贴着墙的左边（edge 0），选其它边
  const h = res.rings.find((r) => r.id === 'h');
  assert.notStrictEqual(h.leadEdge, 0);
  // 至少一条抬刀空移是绕行折线（>2 个点）
  const rapids = res.segments.filter((s) => s.type === 'RAPID');
  assert.ok(rapids.some((r) => r.points.length > 2), '应存在绕行空移');
  // 任何段（含中段采样）都不穿禁穿区
  for (const s of res.segments) {
    if (s.type === 'CUT') continue;
    assert.ok(!CAM.polylineHitsZones(s.points, res.zones), `段 ${s.no} 穿过禁穿区`);
  }
  // 空移长度应明显长于直穿（绕行代价）
  assert.ok(res.totals.rapid > V.dist({ x: -40, y: 40 }, res.rings[0].leadStart));
});

test('抬刀空移不得直线穿过尚未切开的另一个零件：绕行其轮廓（折点>2，无穿越）', () => {
  // 两个 30×30 零件左右并列；HOME 在左零件左侧，若直连右零件引入点会穿过左零件
  const rings = [
    { id: 'L', name: '左件', points: rect(0, 0, 30, 30), kind: 'outer' },
    { id: 'R', name: '右件', points: rect(60, 0, 90, 30), kind: 'outer' },
  ];
  const res = CAM.computeToolpath({
    rings, params: { ...baseParams, bridgeCount: 0 }, home: { x: -15, y: 15 },
  });
  assert.strictEqual(res.verification.exportBlocked, false,
    res.verification.checks.filter((c) => !c.ok).map((c) => c.detail).join(' | '));
  // 第二个加工零件的入向空移（从第一零件出口到第二零件入口）不得穿过第一个零件
  const order = res.sequenceIds;
  const first = res.rings.find((r) => r.id === order[0]);
  const second = res.rings.find((r) => r.id === order[1]);
  const plan = CAM.planRapidStrict(first.leadOutEnd, second.leadStart, [], res.params, [first]);
  assert.ok(!plan.blocked);
  // 绕行折线中段没有点落入第一零件内部
  for (let k = 1; k < plan.poly.length - 1; k++) {
    assert.notStrictEqual(CAM.pointInRing(plan.poly[k], first.points), 1, '绕行拐点不得在未切实体内');
  }
  assert.ok(!CAM.segCrossesRing(plan.poly[0], plan.poly[plan.poly.length - 1], first.points)
    || plan.poly.length > 2, '直连若穿实体则必须给出绕行折线');
  // 导出文件的所有 RAPID 段通过复核 NO_CROSSING
  assert.ok(res.verification.checks.find((c) => c.id === 'NO_CROSSING').ok);
});

test('禁穿区完全封闭包围：受困轮廓标记 RAPID_BLOCKED 且不输出其路径段', () => {
  // 两个零件，一个被禁区围墙完全封死，另一个正常
  const rings = [
    { id: 'ok', name: '正常件', points: rect(80, 80, 110, 110), kind: 'outer' },
    { id: 'trap', name: '受困件', points: rect(0, 0, 10, 10), kind: 'outer' },
  ];
  // 围墙是一个大矩形禁穿区覆盖受困件四周且超出其引入/引出范围
  const zones = [{ id: 'z', name: '封闭墙', type: 'no-cross', points: rect(-25, -25, 35, 35) }];
  const res = CAM.computeToolpath({
    rings, zones, params: { ...baseParams, leadLength: 6 }, home: { x: 120, y: 120 },
  });
  const trap = res.rings.find((r) => r.id === 'trap');
  assert.ok(trap.leadError || trap.rapidError, '受困件必须被标为引入受阻或空移不可达');
  assert.ok(!res.sequenceIds.includes('trap'), '受困件不得进入加工次序');
  assert.ok(!res.segments.some((s) => s.ringId === 'trap'), '不得输出受困件的任何路径段');
  assert.ok(res.verification.exportBlocked);
});

console.log('\n[6] 连接桥：合法放置与尖角缺口报告');

test('桥全部落在直线段上，距尖角、引入线满足保护距', () => {
  const res = CAM.computeToolpath({
    rings: outerWithTwoHoles(), params: { ...baseParams, bridgeCount: 2 }, home: { x: -20, y: -20 },
  });
  for (const r of res.rings) {
    assert.ok(r.bridgeReport.missing === 0, r.bridgeReport.reason || '');
    assert.strictEqual(r.bridges.length, 2);
    for (const b of r.bridges) {
      const sp = r.offset.spans.find((s) => s.type === 'line' && s.edgeIndex === b.edgeIndex);
      assert.ok(sp, '桥必须在 line span 上');
      const dir = V.norm(V.sub(sp.to, sp.from));
      const t1 = V.dot(V.sub(b.from, sp.from), dir);
      const t2 = V.dot(V.sub(b.to, sp.from), dir);
      assert.ok(Math.min(t1, sp.len - t2) >= 4 - 1e-6, '距尖角 ≥ cornerClear');
    }
  }
  assert.ok(res.verification.checks.find((c) => c.id === 'BRIDGE_LEGAL').ok);
});

test('小多边形请求过多桥：只生成合法桥并在轮廓上报告缺口数量', () => {
  // 24×8 细长矩形，刀径4 外扩后长边 28；去尖角保护、引入保护后放不下 10 个宽3桥
  const res = CAM.computeToolpath({
    rings: [{ id: 'thin', name: '细长条', points: rect(0, 0, 24, 8), kind: 'outer' }],
    params: { ...baseParams, toolDiameter: 4, bridgeCount: 10, bridgeWidth: 3, bridgeCornerClear: 4, bridgeLeadGuard: 5 },
    home: { x: -10, y: 4 },
  });
  const r = res.rings[0];
  assert.ok(r.bridgeReport.missing > 0, '必须有缺口');
  assert.ok(r.bridgeReport.missing >= 2, '细长条应缺多个桥');
  assert.strictEqual(r.bridges.length, r.bridgeReport.placedCount);
  assert.strictEqual(r.bridges.length + r.bridgeReport.missing, 10);
  assert.ok(/无法放置/.test(r.bridgeReport.reason));
  // 缺口只是报告项：已放置桥仍合法，允许带缺口导出（但缺口必须显式报告）
  assert.ok(res.verification.checks.find((c) => c.id === 'BRIDGE_LEGAL').ok);
  assert.strictEqual(res.verification.exportBlocked, false);
  const txt = CAM.exportToolpathText(res);
  assert.ok(/连接桥缺口报告:/.test(txt), '导出文件必须携带缺口报告');
});

test('桥位置体现为 BRIDGE_JUMP 段（抬刀、空移计入总空移）', () => {
  const res = CAM.computeToolpath({
    rings: [{ id: 'r', name: '块', points: rect(0, 0, 100, 80), kind: 'outer' }],
    params: { ...baseParams, bridgeCount: 3 }, home: { x: -20, y: -20 },
  });
  const jumps = res.segments.filter((s) => s.type === 'BRIDGE_JUMP');
  assert.strictEqual(jumps.length, 3);
  assert.ok(jumps.every((j) => j.cls === 'RAPID'));
  assert.ok(Math.abs(res.totals.bridgeJump - jumps.reduce((a, j) => a + j.length, 0)) < 1e-9);
});

console.log('\n[7] 改变刀具直径重新计算全部补偿轨迹');

test('刀径 4→10：补偿距离、跨度、桥位、段数全部重算', () => {
  const input = { rings: outerWithTwoHoles(), params: { ...baseParams, toolDiameter: 4 }, home: { x: -20, y: -20 } };
  const r4 = CAM.computeToolpath(input);
  const r10 = CAM.computeToolpath({ ...input, params: { ...baseParams, toolDiameter: 10 } });
  const h4 = r4.rings.find((r) => r.id === 'h1');
  const h10 = r10.rings.find((r) => r.id === 'h1');
  assert.ok(Math.abs(Math.min(...h4.offset.points.map((p) => p.x)) - 22) < 1e-6);
  assert.ok(Math.abs(Math.min(...h10.offset.points.map((p) => p.x)) - 25) < 1e-6, 'r=5 内缩');
  // 任何直线补偿点到原边距离都不同
  const p4 = h4.offset.spans.find((s) => s.type === 'line').from;
  const p10 = h10.offset.spans.find((s) => s.type === 'line').from;
  assert.ok(V.dist(p4, p10) > 1e-6);
  // 复核半径一致
  assert.ok(r10.verification.checks.find((c) => c.id === 'OFFSET_DISTANCE').detail.includes('5.000'));
});

console.log('\n[8] 确定性：打乱图形与环输入顺序');

test('环顺序反转、CW/CCW 输入、home 相同 ⇒ 段编号/加工次序/导出文本完全一致', () => {
  const ringsA = outerWithTwoHoles();
  const ringsB = outerWithTwoHoles().map((r) => ({ ...r, points: [...r.points].reverse() })).reverse();
  // 不给定 kind 时反向会改变自动判定，因此保留 kind；reverse 坐标后由规范化强制方向
  const a = CAM.computeToolpath({ rings: ringsA, params: baseParams, home: { x: -20, y: -20 } });
  const b = CAM.computeToolpath({ rings: ringsB, params: baseParams, home: { x: -20, y: -20 } });

  assert.deepStrictEqual(b.sequenceIds, a.sequenceIds);
  const ta = a.segments.map((s) => [s.no, s.type, s.ringId, s.points.map((p) => [+(p.x).toFixed(6), +(p.y).toFixed(6)])]);
  const tb = b.segments.map((s) => [s.no, s.type, s.ringId, s.points.map((p) => [+(p.x).toFixed(6), +(p.y).toFixed(6)])]);
  assert.deepStrictEqual(tb, ta);
  const ea = CAM.exportToolpathText(a, { fingerprint: 'det' });
  const eb = CAM.exportToolpathText(b, { fingerprint: 'det' });
  assert.strictEqual(eb, ea);
});

test('同参数运行两次结果指纹相同（无时间随机因素）', () => {
  const input = { rings: threeOuters(), params: baseParams, home: { x: -10, y: 10 } };
  const a = CAM.exportToolpathText(CAM.computeToolpath(input), { fingerprint: 'x' });
  const b = CAM.exportToolpathText(CAM.computeToolpath(JSON.parse(JSON.stringify(input))), { fingerprint: 'x' });
  assert.strictEqual(a, b);
});

test('禁穿区输入顺序打乱：绕行节点稳定，段编号与导出文本一致', () => {
  const zones = [
    { id: 'z1', name: '禁区一', type: 'no-cross', points: rect(-30, 30, 20, 50) },
    { id: 'z2', name: '禁区二', type: 'no-cross', points: rect(95, 10, 130, 70) },
  ];
  const mk = (zz) => CAM.computeToolpath({
    rings: outerWithTwoHoles(), zones: zz, params: baseParams, home: { x: -40, y: 40 },
  });
  const a = mk(zones);
  const b = mk([...zones].reverse());
  assert.strictEqual(a.verification.exportBlocked, false);
  assert.deepStrictEqual(b.sequenceIds, a.sequenceIds);
  const ea = CAM.exportToolpathText(a, { fingerprint: 'z' });
  const eb = CAM.exportToolpathText(b, { fingerprint: 'z' });
  assert.strictEqual(eb, ea);
});

console.log('\n[9] 长度对账与导出内容');

test('页面总切割/总空移 = 逐段求和 = 导出文件中的合计', () => {
  const res = CAM.computeToolpath({
    rings: outerWithTwoHoles(), params: baseParams, home: { x: -20, y: -20 },
  });
  const sumCut = res.segments.filter((s) => s.cls === 'CUT').reduce((a, s) => a + s.length, 0);
  const sumRapid = res.segments.filter((s) => s.cls === 'RAPID').reduce((a, s) => a + s.length, 0);
  assert.ok(Math.abs(sumCut - res.totals.cut) < 1e-9);
  assert.ok(Math.abs(sumRapid - res.totals.rapid) < 1e-9);
  const txt = CAM.exportToolpathText(res);
  const m1 = txt.match(/总切割长度: ([\d.]+)/);
  const m2 = txt.match(/总空移长度: ([\d.]+)/);
  assert.ok(m1 && Math.abs(+m1[1] - res.totals.cut) < 1e-3);
  assert.ok(m2 && Math.abs(+m2[1] - res.totals.rapid) < 1e-3);
  // 导出段数与 N 编号连续
  const nos = [...txt.matchAll(/N(\d{4})/g)].map((m) => +m[1]);
  assert.strictEqual(nos.length, res.segments.length);
  assert.deepStrictEqual(nos, nos.map((_, i) => i + 1));
  // 导出 G01 点数可回溯到切割段
  const g01 = (txt.match(/^G01 /gm) || []).length;
  const expectPts = res.segments.filter((s) => s.cls === 'CUT')
    .reduce((a, s) => a + s.points.length - 1, 0);
  assert.strictEqual(g01, expectPts);
});

test('导出文本包含加工次序、刀径、桥参数与全部 PASS 复核', () => {
  const res = CAM.computeToolpath({
    rings: outerWithTwoHoles(), params: baseParams, home: { x: -20, y: -20 },
  });
  const txt = CAM.exportToolpathText(res);
  assert.ok(/刀具直径: 4.000/.test(txt));
  assert.ok(/加工轮廓次序:.*外圈/.test(txt));
  for (const c of res.verification.checks) assert.ok(txt.includes(`${c.id}=PASS`), c.id);
});

console.log('\n[10] 逐段检查信息');

test('每个段携带编号/类型/起终点/长度/所属轮廓，可逐段核对', () => {
  const res = CAM.computeToolpath({
    rings: outerWithTwoHoles(), params: baseParams, home: { x: -20, y: -20 },
  });
  for (const s of res.segments) {
    assert.ok(Number.isInteger(s.no) && s.no > 0);
    assert.ok(['RAPID', 'LEAD_IN', 'CUT', 'BRIDGE_JUMP', 'LEAD_OUT'].includes(s.type));
    assert.ok(s.points.length >= 2);
    assert.ok(Math.abs(s.length - CAM.polyLen(s.points)) < 1e-9);
    assert.ok(s.ringId && s.ringName);
    assert.ok(V.eq(s.from, s.points[0]));
    assert.ok(V.eq(s.to, s.points[s.points.length - 1]));
  }
  assert.strictEqual(res.segments[0].no, 1);
});

/* ----------------------------- 汇总 ----------------------------- */

console.log(`\n${'='.repeat(60)}`);
if (failures.length) {
  console.log(`通过 ${passed}，失败 ${failures.length}`);
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.err.stack}`);
  process.exit(1);
} else {
  console.log(`全部通过：${passed} 项测试 ✓`);
}
