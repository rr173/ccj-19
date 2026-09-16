// run-tests.js — 二维图纸版本对比与变更审阅模块验收测试。
// 运行：npm test
import assert from 'node:assert/strict';
import { parseDrawing } from '../public/js/entities.js';
import { estimateRegistration, transformDrawing, DEG } from '../public/js/registration.js';
import { buildCorrespondence } from '../public/js/matching.js';
import { buildDiffs, DEFAULT_TOLERANCE } from '../public/js/diff.js';
import {
  SessionRegistry, createReview, pinPair, unpinPair, updateRegistration,
  updateTolerance, decide, annotate, sign, signingBlockers, recompute,
  replaceCandidate, decisionSummary, pairFingerprint, restoreSession,
} from '../public/js/session.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.stack.split('\n').slice(0, 4).join('\n    ')}`);
    process.exitCode = 1;
  }
}
function suite(name, fn) { console.log(`\n■ ${name}`); fn(); }

const tol = (over = {}) => ({ ...DEFAULT_TOLERANCE, ...over });

// ---------- 夹具构造 ----------
const sq = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
function rotShift(points, thetaDeg, tx = 0, ty = 0, scale = 1) {
  const th = thetaDeg * Math.PI / 180;
  const c = Math.cos(th), s = Math.sin(th);
  return points.map(([x, y]) => [scale * (c * x - s * y) + tx, scale * (s * x + c * y) + ty]);
}
function circleAt(cx, cy, r) { return { cx, cy, r }; }
function shiftCircle({ cx, cy, r }, dx, dy) { return { cx: cx + dx, cy: cy + dy, r }; }

const FRAME = [[0, 0], [200, 0], [200, 200], [0, 200]];
function drawing({ name = 'd', anchors = [], entities = [] }) {
  return { name, format: 'dwg2d-diff/1', anchors, entities };
}
// 带 3 个同名锚点的标准框架图
function framed(entities, { theta = 0, tx = 0, ty = 0, scale = 1 } = {}) {
  const anchorPts = [[0, 0], [200, 0], [200, 200]];
  const moved = rotShift(anchorPts, theta, tx, ty, scale);
  return drawing({
    anchors: moved.map(([x, y], i) => ({ id: `A${i + 1}`, x, y })),
    entities: entities.map((en) => {
      if (en.type === 'hole' && en.r != null && en.contour == null) {
        const p = rotShift([[en.cx, en.cy]], theta, tx, ty, scale)[0];
        return { ...en, cx: p[0], cy: p[1], r: en.r * scale };
      }
      return { ...en, points: rotShift(en.points, theta, tx, ty, scale) };
    }),
  });
}

function runDirect(baseRaw, candRaw, tolerance = tol()) {
  const b = parseDrawing(baseRaw);
  const c = parseDrawing(candRaw);
  const reg = estimateRegistration(b, c);
  const rc = transformDrawing(c, reg.transform);
  const corr = buildCorrespondence(b.entities, rc.entities, new Map(), {
    tolerance: tolerance.positionTolerance,
  });
  const built = buildDiffs(corr, tolerance);
  return { b, c, reg, rc, corr, ...built };
}
// =====================================================================
suite('验收① 仅有平移和旋转的两稿配准后零差异', () => {
  const base = framed([
    { type: 'region', id: 'R1', points: sq(10, 10, 80) },
    { type: 'hole', id: 'H1', ...circleAt(50, 50, 6) },
    { type: 'segment', id: 'S1', points: [[10, 10], [90, 90]] },
  ]);
  const cand = framed([
    { type: 'region', id: 'R1', points: sq(10, 10, 80) },
    { type: 'hole', id: 'H1', ...circleAt(50, 50, 6) },
    { type: 'segment', id: 'S1', points: [[10, 10], [90, 90]] },
  ], { theta: 37, tx: 42, ty: -18 });

  test('Umeyama 恢复 θ≈-37°、s≈1、锚点残差≈0', () => {
    const r = runDirect(base, cand);
    assert.ok(Math.abs(r.reg.params.thetaDeg + 37) < 1e-7, `theta=${r.reg.params.thetaDeg}`);
    assert.ok(Math.abs(r.reg.params.scale - 1) < 1e-9);
    assert.ok(r.reg.rms < 1e-7, `rms=${r.reg.rms}`);
  });

  test('配准后 0 增补 0 消除 0 差异 0 待消歧', () => {
    const r = runDirect(base, cand);
    assert.equal(r.diffs.length, 0);
    assert.equal(r.corr.additions.length, 0);
    assert.equal(r.corr.removals.length, 0);
    assert.equal(r.pending.length, 0);
    assert.equal(r.corr.pairs.length, 3);
  });

  test('缩放+镜像朝向也能配准', () => {
    const candMirror = framed([
      { type: 'region', id: 'R1', points: sq(10, 10, 80) },
      { type: 'hole', id: 'H1', ...circleAt(50, 50, 6) },
      { type: 'segment', id: 'S1', points: [[10, 10], [90, 90]] },
    ], { theta: 20, tx: 30, ty: 15, scale: 2 });
    // 手工构造一个 x 轴镜像图：x -> -x（锚点与全部图元同步镜像）
    const mirrorPts = (pts) => pts.map(([x, y]) => [-x, y]);
    const mirrored = {
      ...candMirror,
      anchors: candMirror.anchors.map((a) => ({ ...a, x: -a.x })),
      entities: candMirror.entities.map((e) => (
        e.type === 'hole'
          ? { ...e, cx: -e.cx }
          : { ...e, points: mirrorPts(e.points) }
      )),
    };
    const r = runDirect(base, mirrored);
    // 镜像 3 锚点配置下残差应极小
    assert.ok(r.reg.rms < 1e-6, `mirror rms=${r.reg.rms}`);
    assert.equal(r.reg.transform.reflected, true);
    assert.equal(r.diffs.length, 0);
  });

  test('同名锚点缺失时，显式 anchorPairs 同样可配准', () => {
    const rename = (draw, map) => ({
      ...draw,
      anchors: draw.anchors.map((a) => ({ ...a, id: map[a.id], label: `孔位${map[a.id]}` })),
    });
    const candRenamed = rename(cand, { A1: 'P1', A2: 'P2', A3: 'P3' });
    const b = parseDrawing(base), c2 = parseDrawing(candRenamed);
    // 不给显式配对 → 同名匹配落空 → 恒等变换
    const auto = estimateRegistration(b, c2);
    assert.equal(auto.method, 'identity');
    const manual = estimateRegistration(b, c2, {
      anchorPairs: [['A1', 'P1'], ['A2', 'P2'], ['A3', 'P3']],
    });
    assert.ok(manual.rms < 1e-7, `manual rms=${manual.rms}`);
    assert.ok(Math.abs(manual.params.thetaDeg + 37) < 1e-7);
  });
});

// =====================================================================
suite('验收② 一个孔位偏移能显示距离与方向', () => {
  const base = framed([
    { type: 'region', id: 'R1', points: FRAME },
    { type: 'hole', id: 'H1', ...circleAt(60, 80, 8) },
  ]);
  const cand = framed([
    { type: 'region', id: 'R1', points: FRAME },
    { type: 'hole', id: 'H1', ...shiftCircle(circleAt(60, 80, 8), 9, -12) },
  ], { theta: 12, tx: 5, ty: 7 });

  const r = runDirect(base, cand);
  test('恰有一条 position 差异，距离≈15、方向 atan2(-12,9)≈-53.13°', () => {
    const holeDiffs = r.diffs.filter((d) => d.entityKind === 'hole');
    assert.equal(holeDiffs.length, 1);
    const d = holeDiffs[0];
    assert.equal(d.kind, 'position');
    assert.ok(Math.abs(d.metrics.displacement - 15) < 0.05, `disp=${d.metrics.displacement}`);
    assert.ok(Math.abs(d.metrics.directionDeg - Math.atan2(-12, 9) * 180 / Math.PI) < 0.1);
  });
  test('侧栏前后数值包含坐标与 dx/dy', () => {
    const d = r.diffs.find((x) => x.entityKind === 'hole');
    assert.ok(Math.abs(d.metrics.delta.x - 9) < 0.05);
    assert.ok(Math.abs(d.metrics.delta.y - -12) < 0.05);
  });
});

// =====================================================================
suite('验收③ 单一区域拆成两块判为拓扑改动而非两个增补', () => {
  const base = framed([{ type: 'region', id: 'R1', points: sq(0, 0, 100) }]);
  const cand = framed([
    { type: 'region', id: 'L', points: sq(0, 0, 50) },
    { type: 'region', id: 'R', points: sq(50, 0, 50) },
  ], { theta: 8, tx: 3, ty: -2 });

  const r = runDirect(base, cand);
  test('一个 split 拓扑组，零增补零消除', () => {
    assert.equal(r.corr.topologyGroups.length, 1);
    assert.equal(r.corr.topologyGroups[0].topology, 'split');
    assert.equal(r.corr.additions.length, 0);
    assert.equal(r.corr.removals.length, 0);
    const td = r.diffs.find((d) => d.kind === 'topology');
    assert.ok(td);
    assert.equal(td.metrics.before.count, 1);
    assert.equal(td.metrics.after.count, 2);
  });

  test('合并方向判为 merge', () => {
    const r2 = runDirect(cand, base);
    assert.equal(r2.corr.topologyGroups[0].topology, 'merge');
  });
});

// =====================================================================
suite('验收④ 两个相似候选触发人工消歧且不提前落锤', () => {
  const base = framed([
    { type: 'region', id: 'R1', points: [[-150, -150], [150, -150], [150, 150], [-150, 150]] },
    { type: 'hole', id: 'H', ...circleAt(0, 0, 3) },
  ]);
  const cand = framed([
    { type: 'region', id: 'R1', points: [[-150, -150], [150, -150], [150, 150], [-150, 150]] },
    { type: 'hole', id: 'H1', ...circleAt(9, 0, 3) },
    { type: 'hole', id: 'H2', ...circleAt(-9, 0, 3) },
  ]);

  const r = runDirect(base, cand);
  test('基线孔挂起，列出两个候选与置信依据，无自动配对/增补', () => {
    assert.equal(r.pending.length, 1);
    const p = r.pending[0];
    assert.equal(p.candidates.length, 2);
    assert.ok(Math.abs(p.candidates[0].score - p.candidates[1].score) < 0.02);
    assert.ok(p.candidates[0].reasons.length > 0);
    assert.equal(r.corr.pairs.filter((x) => x.base.kind === 'hole').length, 0);
    assert.equal(r.corr.additions.length, 0);
  });

  test('会话级：消歧前阻塞签署，人工选择后落锤', () => {
    const reg = new SessionRegistry();
    const { session } = createReview(reg, base, cand);
    assert.equal(signingBlockers(session).some((x) => x.code === 'pending-disambiguation'), true);
    const b = parseDrawing(base), c = parseDrawing(cand);
    const chosenCid = session.result.corr.pending[0].candidates[0].cand.stableId;
    const res = pinPair(session, b, c, session.result.corr.pending[0].base.stableId, chosenCid);
    assert.equal(res.ok, true);
    assert.equal(session.result.pending.length, 0);
    assert.equal(session.result.corr.pairs.some((p) => p.pinned), true);
  });
});

// =====================================================================
suite('验收⑤ 调参后人工固定项保持对应', () => {
  const base = framed([
    { type: 'region', id: 'R1', points: FRAME },
    { type: 'hole', id: 'H1', ...circleAt(40, 40, 5) },
  ]);
  const cand = framed([
    { type: 'region', id: 'R1', points: FRAME },
    { type: 'hole', id: 'H1', ...circleAt(46, 38, 5) },
  ]);
  const reg = new SessionRegistry();
  const { session } = createReview(reg, base, cand);
  const b = parseDrawing(base), c = parseDrawing(cand);
  const baseH = b.entities.find((e) => e.stableId === 'H1');
  const candH = c.entities.find((e) => e.stableId === 'H1');

  test('固定项在配准参数调整后仍为同一对，且其余图元重算', () => {
    const pin = pinPair(session, b, c, baseH.stableId, candH.stableId);
    assert.equal(pin.ok, true);
    const reg2 = updateRegistration(session, b, c, { thetaDeg: 0.5, scale: 1.002 });
    assert.equal(reg2.ok, true, reg2.conflict?.message);
    const pinnedPair = session.result.corr.pairs.find((p) => p.base.stableId === 'H1');
    assert.ok(pinnedPair.pinned);
    assert.equal(pinnedPair.cand.stableId, 'H1');
    // 区域 R1 仍由自动匹配重新对应
    assert.ok(session.result.corr.pairs.some((p) => p.base.stableId === 'R1' && !p.pinned));
  });

  test('unpin 后恢复自动匹配', () => {
    const r = unpinPair(session, b, c, 'H1');
    assert.equal(r.ok, true);
    assert.ok(!('H1' in session.pinned));
  });
});

// =====================================================================
suite('验收⑥ 固定关系矛盾时整次重算撤回', () => {
  test('一对多：同一候选固定给两个基线 → 第二次即被拒/重算回滚', () => {
    const base = framed([
      { type: 'region', id: 'R1', points: [[-120, -120], [-20, -120], [-20, -20], [-120, -20]] },
      { type: 'region', id: 'R2', points: [[20, -120], [120, -120], [120, -20], [20, -20]] },
    ]);
    const cand = framed([
      { type: 'region', id: 'C1', points: [[-120, -120], [120, -120], [120, -20], [-120, -20]] },
    ]);
    const reg = new SessionRegistry();
    const { session } = createReview(reg, base, cand);
    const b = parseDrawing(base), c = parseDrawing(cand);
    // 直接写入两条固定（绕过交互校验，模拟"历史固定"），再触发重算
    session.pinned.R1 = { candStableId: 'C1', at: new Date().toISOString() };
    session.pinned.R2 = { candStableId: 'C1', at: new Date().toISOString() };
    const r = recompute(session, b, c, {});
    assert.equal(r.ok, false);
    assert.equal(r.conflict.violations.some((v) => v.code === 'one-to-many'), true);
    // 整次重算撤回：旧结果（初始为 merge 拓扑、无任何固定配对）保持不变
    assert.ok(session.result);
    assert.equal(session.result.corr.pairs.filter((p) => p.pinned).length, 0);
    assert.equal(session.result.corr.topologyGroups.length, 1);
  });

  test('类型不兼容（region↔hole）矛盾撤回', () => {
    const base = framed([{ type: 'region', id: 'R1', points: FRAME }]);
    const cand = framed([{ type: 'hole', id: 'X1', ...circleAt(100, 100, 40) }]);
    const reg = new SessionRegistry();
    const { session } = createReview(reg, base, cand);
    const b = parseDrawing(base), c = parseDrawing(cand);
    session.pinned.R1 = { candStableId: 'X1', at: new Date().toISOString() };
    const r = recompute(session, b, c, {});
    assert.equal(r.ok, false);
    assert.ok(r.conflict.violations.some((v) => v.code === 'type-incompatible'));
  });

  test('超过最大偏移矛盾撤回，且参数不落', () => {
    const base = framed([
      { type: 'region', id: 'R1', points: FRAME },
      { type: 'hole', id: 'H1', ...circleAt(40, 40, 5) },
    ]);
    const cand = framed([
      { type: 'region', id: 'R1', points: FRAME },
      // 当前配准下偏移 2（可固定）；旋转 30° 后质心将抛出约 20 单位
      { type: 'hole', id: 'H1', ...circleAt(42, 40, 5) },
    ]);
    const reg = new SessionRegistry();
    const { session } = createReview(reg, base, cand, {
      tolerance: { ...DEFAULT_TOLERANCE, maxOffset: 5 },
    });
    const b = parseDrawing(base), c = parseDrawing(cand);
    assert.equal(pinPair(session, b, c, 'H1', 'H1').ok, true);
    const before = session.regParams;
    const r = updateRegistration(session, b, c, { thetaDeg: 30, scale: 1 });
    assert.equal(r.ok, false);
    assert.ok(r.conflict.violations.some((v) => v.code === 'max-offset'),
      r.conflict?.violations.map((v) => v.code).join(','));
    assert.deepEqual(session.regParams, before);
    assert.ok(session.result); // 旧结果保留
  });
});

// =====================================================================
suite('验收⑦ 低于公差的噪声忽略，超过公差的改动列出', () => {
  const make = (dx, dy, dr) => [
    framed([
      { type: 'region', id: 'R1', points: FRAME },
      { type: 'hole', id: 'H1', ...circleAt(50, 50, 10) },
      { type: 'segment', id: 'S1', points: [[0, 0], [120, 60]] },
    ]),
    framed([
      { type: 'region', id: 'R1', points: FRAME.map(([x, y], i) => i === 2 ? [x + 0.1, y - 0.1] : [x, y]) },
      { type: 'hole', id: 'H1', ...circleAt(50 + dx, 50 + dy, 10 + dr) },
      { type: 'segment', id: 'S1', points: [[0, 0], [120.15, 60.05]] },
    ]),
  ];

  test('噪声（<0.5 位置 / <0.1 半径 / 毫米级轮廓抖动）→ 零差异', () => {
    const [b, c] = make(0.2, 0.1, 0.08);
    const r = runDirect(b, c, tol());
    assert.equal(r.diffs.length, 0, JSON.stringify(r.diffs.map((d) => [d.kind, d.changes])));
  });

  test('超差（孔位 5）→ 列出 position，附带前后数值', () => {
    const [b, c] = make(5, 0, 0.08);
    const r = runDirect(b, c, tol());
    const kinds = r.diffs.map((d) => d.kind);
    assert.ok(kinds.includes('position'));
    const d = r.diffs.find((x) => x.entityKind === 'hole');
    assert.ok(Math.abs(d.metrics.displacement - 5) < 0.05);
  });

  test('公差收紧后原本忽略的噪声变为差异', () => {
    const [b, c] = make(0.2, 0.1, 0.08);
    const tight = tol({ positionTolerance: 0.05, sizeTolerance: 0.05 });
    const r = runDirect(b, c, tight);
    assert.ok(r.diffs.length >= 1);
  });
});

// =====================================================================
suite('验收⑧ 尚有暂缓项时禁止签署', () => {
  const reg = new SessionRegistry();
  const base = framed([
    { type: 'region', id: 'R1', points: FRAME },
    { type: 'hole', id: 'H1', ...circleAt(50, 50, 5) },
  ]);
  const cand = framed([
    { type: 'region', id: 'R1', points: FRAME },
    { type: 'hole', id: 'H1', ...circleAt(60, 50, 5) },
  ]);
  const { session } = createReview(reg, base, cand);

  test('有未决/暂缓时 sign 失败并给出阻塞原因', () => {
    assert.equal(sign(session).ok, false);
    const d = session.result.diffs[0];
    decide(session, d.key, 'deferred');
    const fail = sign(session);
    assert.equal(fail.ok, false);
    assert.ok(fail.blockers.some((x) => x.code === 'deferred'));
  });

  test('全部接受后签署成功，快照只读且含指纹/配准/对应/决议/统计', () => {
    for (const d of session.result.diffs) decide(session, d.key, 'accepted', { note: '核对无误' });
    annotate(session, session.result.diffs[0].key, '车间确认');
    const res = sign(session, { by: '张工' });
    assert.equal(res.ok, true, JSON.stringify(res.blockers));
    assert.equal(Object.isFrozen(res.snapshot), true);
    assert.equal(res.snapshot.inputs.base.fingerprint.length, 16);
    assert.ok(res.snapshot.registration.params);
    assert.ok(res.snapshot.correspondence.pairs.length >= 1);
    assert.equal(res.snapshot.diffs[0].decision.verdict, 'accepted');
    assert.equal(res.snapshot.stats.total, session.result.diffs.length);
    // 只读：篡改抛错（严格模式）
    assert.throws(() => { res.snapshot.by = 'x'; });
  });
});

// =====================================================================
suite('验收⑨ 候选稿被替换后旧签署失效，快照仍可查看', () => {
  const reg = new SessionRegistry();
  const base = framed([
    { type: 'region', id: 'R1', points: FRAME },
    { type: 'hole', id: 'H1', ...circleAt(50, 50, 5) },
  ]);
  const cand = framed([
    { type: 'region', id: 'R1', points: FRAME },
    { type: 'hole', id: 'H1', ...circleAt(55, 50, 5) },
  ]);
  const { session } = createReview(reg, base, cand);
  for (const d of session.result.diffs) decide(session, d.key, 'accepted');
  const signed = sign(session, { by: '张工' });
  assert.equal(signed.ok, true);
  const snapId = signed.snapshotId;

  const cand2 = framed([
    { type: 'region', id: 'R1', points: FRAME },
    { type: 'hole', id: 'H1', ...circleAt(70, 50, 5) },
  ]);
  const { session: next, previous } = replaceCandidate(reg, session, base, cand2);

  test('旧会话失效，新会话独立，快照仍可取', () => {
    assert.equal(previous.status, 'superseded');
    assert.equal(previous.invalidReason, 'candidate-replaced');
    assert.notEqual(next.sessionId, previous.sessionId);
    assert.equal(reg.getSnapshot(snapId).snapshotId, snapId);
    assert.equal(Object.isFrozen(reg.getSnapshot(snapId)), true);
    assert.equal(next.status, 'open');
  });

  test('配准参数/公差改动也使签署失效', () => {
    const reg2 = new SessionRegistry();
    const { session: s2 } = createReview(reg2, base, cand);
    for (const d of s2.result.diffs) decide(s2, d.key, 'accepted');
    assert.equal(sign(s2).ok, true);
    const b = parseDrawing(base), c = parseDrawing(cand);
    updateTolerance(s2, b, c, { positionTolerance: 0.1 });
    assert.notEqual(s2.status, 'signed');
    assert.equal(s2.invalidReason, 'tolerance-changed');
  });
});

// =====================================================================
suite('验收⑩ 同一导入请求重复到达只保留一个审阅实例', () => {
  const reg = new SessionRegistry();
  const base = framed([{ type: 'region', id: 'R1', points: sq(0, 0, 50) }]);
  const cand = framed([{ type: 'region', id: 'R1', points: sq(2, 1, 50) }]);

  test('同内容重复导入 reused=true，注册表内仅一个实例', () => {
    const first = createReview(reg, base, cand);
    const second = createReview(reg, base, cand);
    const third = createReview(reg, JSON.parse(JSON.stringify(base)), JSON.parse(JSON.stringify(cand)));
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(third.reused, true);
    assert.equal(second.session.sessionId, first.session.sessionId);
    assert.equal(reg.index.size, 1);
  });

  test('图元顺序重排、空白差异不改变指纹', () => {
    const reordered = JSON.parse(JSON.stringify(cand));
    reordered.entities = [...reordered.entities].reverse();
    const r = createReview(reg, base, reordered);
    assert.equal(r.reused, true);
  });

  test('内容变化（新增孔）→ 不同实例', () => {
    const changed = JSON.parse(JSON.stringify(cand));
    changed.entities.push({ type: 'hole', ...circleAt(10, 10, 2) });
    const r = createReview(reg, base, changed);
    assert.equal(r.reused, false);
    assert.equal(reg.index.size, 2);
  });
});

// =====================================================================
suite('附加：决议与批注的稳定身份绑定（重排序/重载入）', () => {
  test('决议按 diffKey 跨重算保留，且不串项', () => {
    const reg = new SessionRegistry();
    const base = framed([
      { type: 'region', id: 'R1', points: FRAME },
      { type: 'hole', id: 'H1', ...circleAt(30, 30, 4) },
      { type: 'hole', id: 'H2', ...circleAt(120, 120, 4) },
    ]);
    const cand = framed([
      { type: 'region', id: 'R1', points: FRAME },
      { type: 'hole', id: 'H1', ...circleAt(34, 30, 4) },
      { type: 'hole', id: 'H2', ...circleAt(120, 125, 4) },
    ]);
    const { session } = createReview(reg, base, cand);
    const d1 = session.result.diffs.find((d) => d.key.includes('H1'));
    decide(session, d1.key, 'accepted', { note: '孔位调整已知悉' });
    const b = parseDrawing(base), c = parseDrawing(cand);
    const r = updateRegistration(session, b, c, { thetaDeg: 0, scale: 1 });
    assert.equal(r.ok, true);
    assert.equal(session.decisions[d1.key]?.verdict, 'accepted');
    assert.equal(session.decisions[d1.key]?.note, '孔位调整已知悉');
    const summary = decisionSummary(session);
    assert.equal(summary.accepted, 1);
    assert.ok(summary.undecided >= 1);
  });

  test('人工声明无对应 → 消除差异', () => {
    const base = framed([
      { type: 'region', id: 'R1', points: [[-100, -100], [100, -100], [100, 100], [-100, 100]] },
      { type: 'hole', id: 'H9', ...circleAt(0, 0, 3) },
    ]);
    const cand = framed([
      { type: 'region', id: 'R1', points: [[-100, -100], [100, -100], [100, 100], [-100, 100]] },
    ]);
    const reg = new SessionRegistry();
    const { session } = createReview(reg, base, cand);
    const b = parseDrawing(base), c = parseDrawing(cand);
    // 孔离任何候选都远 → 自动判消除；若挂起则允许声明无对应
    const pend = session.result.pending[0];
    if (pend) pinPair(session, b, c, pend.base.stableId, null);
    assert.ok(session.result.diffs.some((d) => d.kind === 'removal' && d.entityKind === 'hole'));
  });
});

// =====================================================================
suite('附加：持久化存根 → 刷新后复活会话（重放固定/决议/签署态）', () => {
  // 内存版持久化适配器
  const memAdapter = () => {
    const db = { sessions: {}, snapshots: {} };
    return {
      db,
      loadAll: () => ({ sessions: Object.values(db.sessions), snapshots: Object.values(db.snapshots) }),
      save(s) { db.sessions[s.pairId] = stripLive(s); },
      remove(pairId) { delete db.sessions[pairId]; },
      saveSnapshot(snap) { db.snapshots[snap.snapshotId] = snap; },
    };
  };
  function stripLive(s) {
    return {
      sessionId: s.sessionId, pairId: s.pairId, createdAt: s.createdAt, status: s.status,
      inputs: s.inputs, tolerance: s.tolerance, regParams: s.regParams, pinned: s.pinned,
      decisions: s.decisions, notes: s.notes, signatures: s.signatures,
      signedSnapshotId: s.signedSnapshotId, invalidReason: s.invalidReason,
      invalidDetail: s.invalidDetail, invalidatedAt: s.invalidatedAt, supersededBy: s.supersededBy,
    };
  }

  const base = framed([
    { type: 'region', id: 'R1', points: FRAME },
    { type: 'hole', id: 'H1', ...circleAt(50, 50, 5) },
  ]);
  const cand = framed([
    { type: 'region', id: 'R1', points: FRAME },
    { type: 'hole', id: 'H1', ...circleAt(58, 50, 5) },
  ]);

  test('刷新后用存根重建：决议、批注、固定、签署态全部归属原处', () => {
    const adapter = memAdapter();
    const reg1 = new SessionRegistry(adapter);
    const { session: s1 } = createReview(reg1, base, cand);
    const b = parseDrawing(base), c = parseDrawing(cand);
    pinPair(s1, b, c, 'H1', 'H1');
    for (const d of s1.result.diffs) decide(s1, d.key, 'accepted');
    annotate(s1, s1.result.diffs[0].key, '重载归属测试');
    const signed = sign(s1);
    assert.equal(signed.ok, true);
    reg1.put(s1); // 触发最后一次持久化

    // 模拟页面刷新：新注册表从同一存储 hydrate
    const reg2 = new SessionRegistry(adapter);
    const stored = reg2.findStored(s1.pairId);
    assert.ok(stored, '存根应可按 pairId 找到');
    const r = restoreSession(reg2, stored, parseDrawing(base), parseDrawing(cand));
    assert.equal(r.ok, true);
    const s2 = r.session;
    assert.equal(s2.status, 'signed');
    assert.equal(s2.result.diffs.length, s1.result.diffs.length);
    const key0 = s1.result.diffs[0].key;
    assert.equal(s2.decisions[key0]?.verdict, 'accepted');
    assert.equal(s2.notes[key0]?.note, '重载归属测试');
    assert.ok(s2.result.corr.pairs.find((p) => p.base.stableId === 'H1')?.pinned);
  });

  test('复活会话对重复导入仍然幂等（仍是同一实例）', () => {
    const adapter = memAdapter();
    const reg1 = new SessionRegistry(adapter);
    createReview(reg1, base, cand);
    const reg2 = new SessionRegistry(adapter);
    const { session, reused } = createReview(reg2, parseDrawing(base), parseDrawing(cand));
    assert.equal(reused, true);
    assert.ok(session.result);
    const again = createReview(reg2, parseDrawing(base), parseDrawing(cand));
    assert.equal(again.reused, true);
    assert.equal(again.session.sessionId, session.sessionId);
  });

  test('输入指纹与存根不一致时拒绝复活', () => {
    const adapter = memAdapter();
    const reg1 = new SessionRegistry(adapter);
    const { session } = createReview(reg1, base, cand);
    const reg2 = new SessionRegistry(adapter);
    const stored = reg2.findStored(session.pairId);
    const tampered = framed([{ type: 'region', id: 'R1', points: sq(0, 0, 90) }]);
    const r = restoreSession(reg2, stored, parseDrawing(tampered), parseDrawing(cand));
    assert.equal(r.ok, false);
  });
});

console.log(`\n${failed === 0 ? '全部通过' : '有失败'}：${passed} 通过 / ${failed} 失败`);
if (failed) process.exitCode = 1;
