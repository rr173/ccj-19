// run-tests.js — 拓扑规则、布尔操作、历史与持久化确定性的自动化测试。
// 运行：npm test
import assert from 'node:assert/strict';
import pc from 'polygon-clipping';
import {
  ringArea, pointInRing, segmentsIntersect, translateGeom, rotateGeom, scaleGeom, geomCentroid,
} from '../public/js/geometry.js';
import { normalizeGeom, geomHash, geomEquals, geomStats } from '../public/js/model.js';
import { validateGeom, classifyTouch } from '../public/js/validate.js';
import { applyBoolean } from '../public/js/ops.js';
import {
  createHistory, pushEntry, undo, redo, jumpTo,
  serializeHistory, deserializeHistory,
} from '../public/js/history.js';

const EPS = 0.5;
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}
function suite(name, fn) { console.log(`\n■ ${name}`); fn(); }

// sqRing: 单个开放环；sq: 规范 MultiPolygon（[[ring]]）
const sqRing = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const sq = (x, y, s) => [[sqRing(x, y, s)]];
const normRings = (rings, log) => normalizeGeom(rings, EPS, log || []);
const norm = (mp, log) => normalizeGeom(mp.flatMap(p => p), EPS, log || []);

// ---------- geometry ----------
suite('geometry 基础', () => {
  test('ringArea 符号与大小', () => {
    assert.equal(ringArea([[0, 0], [10, 0], [10, 10], [0, 10]]), 100); // 屏幕系逆时针为正
    assert.equal(ringArea([[0, 0], [0, 10], [10, 10], [10, 0]]), -100);
  });
  test('pointInRing in/out/on', () => {
    const r = [[0, 0], [10, 0], [10, 10], [0, 10]];
    assert.equal(pointInRing(r, [5, 5], 1e-9), 'in');
    assert.equal(pointInRing(r, [15, 5], 1e-9), 'out');
    assert.equal(pointInRing(r, [0, 5], 1e-9), 'on');
  });
  test('segmentsIntersect 穿越/触碰/共线', () => {
    const cross = segmentsIntersect([0, 0], [10, 10], [0, 10], [10, 0]);
    assert.equal(cross.proper, true);
    const touch = segmentsIntersect([0, 0], [10, 0], [10, 0], [20, 5]);
    assert.ok(touch && !touch.proper);
    const none = segmentsIntersect([0, 0], [1, 0], [0, 5], [1, 5]);
    assert.equal(none, null);
  });
});

// ---------- model.normalizeGeom ----------
suite('normalizeGeom 规范化', () => {
  test('闭合环开放化 + 规范朝向', () => {
    const g = normRings([[[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]]);
    assert.equal(g.length, 1);
    assert.equal(g[0][0].length, 4); // 闭合点已移除
    assert.ok(ringArea(g[0][0]) < 0); // 外轮廓规范为负面积
  });
  test('洞的分类：外轮廓 + 内环 → 1 个 polygon 带 1 洞', () => {
    const g = normRings([sqRing(0, 0, 10), sqRing(3, 3, 4)]);
    assert.equal(g.length, 1);
    assert.equal(g[0].length, 2);
    assert.ok(ringArea(g[0][1]) > 0); // 洞为规范正向
  });
  test('洞的洞 = 岛 → 提升为独立外轮廓（不丢洞）', () => {
    const g = normRings([sqRing(0, 0, 20), sqRing(2, 2, 16), sqRing(6, 6, 8)]);
    const stats = geomStats(g);
    assert.equal(stats.outers, 2);
    assert.equal(stats.holes, 1);
    const v = validateGeom(g, EPS);
    assert.ok(v.ok, v.errors.join('; '));
  });
  test('pinch 环（沙漏点）拆分为两个独立环', () => {
    const pinch = [[0, 0], [4, 0], [4, 4], [0, 0], [-4, 0], [-4, 4]];
    const log = [];
    const g = normRings([pinch], log);
    assert.equal(geomStats(g).outers, 2);
    assert.ok(log.some(d => d.includes('拆分')));
  });
  test('零面积退化环被丢弃且不生成细缝', () => {
    const log = [];
    const g = normRings([[[0, 0], [10, 0], [5, 0.01]], sqRing(50, 50, 5)], log);
    assert.equal(geomStats(g).outers, 1);
    assert.ok(log.some(d => d.includes('退化')));
  });
  test('哈希稳定：同几何任意顶点起点/朝向 → 同哈希', () => {
    const a = normRings([[[0, 0], [10, 0], [10, 10], [0, 10]]]);
    const b = normRings([[[10, 10], [0, 10], [0, 0], [10, 0]]]);
    assert.equal(geomHash(a), geomHash(b));
  });
});

// ---------- validateGeom ----------
suite('validateGeom 拓扑校验', () => {
  test('有效甜甜圈：1 外轮廓 1 洞', () => {
    const g = normRings([sqRing(0, 0, 10), sqRing(3, 3, 4)]);
    const v = validateGeom(g, EPS);
    assert.ok(v.ok, v.errors.join('; '));
    assert.deepEqual([v.stats.outers, v.stats.holes], [1, 1]);
  });
  test('自交（蝴蝶结）→ 报错', () => {
    const g = [[[[0, 0], [10, 10], [10, 0], [0, 10]]]];
    const v = validateGeom(g, EPS);
    assert.ok(!v.ok);
    assert.ok(v.errors.some(e => e.includes('自交')));
  });
  test('洞在外轮廓外 → 报错', () => {
    // 手工构造非法结构（绕过 normalize 的分类）
    const g = [[sqRing(0, 0, 10), sqRing(20, 20, 4)]];
    const v = validateGeom(g, EPS);
    assert.ok(!v.ok);
    assert.ok(v.errors.some(e => e.includes('不在其外轮廓')));
  });
  test('重复边（零宽通道）→ 报错', () => {
    const shared = [[10, 0], [10, 10]];
    const g = [
      [[[0, 0], [10, 0], [10, 10], [0, 10]]],
      [[[10, 0], [20, 0], [20, 10], [10, 10]]],
    ];
    void shared;
    const v = validateGeom(g, EPS);
    assert.ok(!v.ok);
    assert.ok(v.errors.some(e => e.includes('重复边')));
  });
});

// ---------- classifyTouch ----------
suite('classifyTouch 接触分类', () => {
  test('分离 → disjoint（含最近距离）', () => {
    const t = classifyTouch(sq(0, 0, 10), sq(20, 0, 10), EPS);
    assert.equal(t.kind, 'disjoint');
    assert.ok(Math.abs(t.minDist - 10) < 1e-6);
  });
  test('共边接触 → edge-touch', () => {
    const t = classifyTouch(sq(0, 0, 10), sq(10, 0, 10), EPS);
    assert.equal(t.kind, 'edge-touch');
    assert.ok(t.sharedEdges.length >= 1);
  });
  test('点接触 → point-touch（带坐标）', () => {
    const t = classifyTouch(sq(0, 0, 10), sq(10, 10, 10), EPS);
    assert.equal(t.kind, 'point-touch');
    assert.ok(t.points.length >= 1);
  });
  test('重叠 → overlap；包含 → overlap（A-in-B）', () => {
    assert.equal(classifyTouch(sq(0, 0, 10), sq(5, 5, 10), EPS).kind, 'overlap');
    const t = classifyTouch(sq(0, 0, 4), sq(0, 0, 10), EPS);
    assert.equal(t.kind, 'overlap');
    assert.ok(t.description.includes('包含'));
  });
});

// ---------- applyBoolean ----------
suite('applyBoolean 布尔操作（显式拓扑判定）', () => {
  test('合并重叠方形 → 1 外轮廓，判定链完整', () => {
    const r = applyBoolean(pc, 'union', sq(0, 0, 10), sq(5, 0, 10), EPS);
    assert.ok(r.ok, r.reason);
    assert.equal(r.report.output.outers, 1);
    assert.ok(r.report.decisions.some(d => d.includes('接触判定')));
  });
  test('合并分离方形 → 2 个独立外轮廓', () => {
    const r = applyBoolean(pc, 'union', sq(0, 0, 10), sq(20, 0, 10), EPS);
    assert.ok(r.ok);
    assert.equal(r.report.output.outers, 2);
  });
  test('合并共边方形 → 单外轮廓（共边=连通）', () => {
    const r = applyBoolean(pc, 'union', sq(0, 0, 10), sq(10, 0, 10), EPS);
    assert.ok(r.ok, r.reason);
    assert.equal(r.report.output.outers, 1);
    assert.equal(r.report.touch.kind, 'edge-touch');
  });
  test('合并点接触方形 → 保持 2 个外轮廓（点接触=不连通）', () => {
    const r = applyBoolean(pc, 'union', sq(0, 0, 10), sq(10, 10, 10), EPS);
    assert.ok(r.ok, r.reason);
    assert.equal(r.report.output.outers, 2);
    assert.equal(r.report.touch.kind, 'point-touch');
  });
  test('合并缝隙 < ε 的方形 → 顶点吸附后连成单轮廓（不造细缝）', () => {
    const r = applyBoolean(pc, 'union', sq(0, 0, 10), sq(10.3, 0, 10), EPS);
    assert.ok(r.ok, r.reason);
    assert.equal(r.report.output.outers, 1);
    assert.ok(r.report.decisions.some(d => d.includes('顶点吸附')));
    const v = validateGeom(r.geom, EPS);
    assert.ok(v.ok, v.errors.join('; '));
  });
  test('减去内部方形 → 产生洞（1 外轮廓 1 洞）', () => {
    const r = applyBoolean(pc, 'difference', sq(0, 0, 10), sq(3, 3, 4), EPS);
    assert.ok(r.ok, r.reason);
    assert.deepEqual([r.report.output.outers, r.report.output.holes], [1, 1]);
    assert.ok(validateGeom(r.geom, EPS).ok);
  });
  test('相交重叠方形 → 重叠区域', () => {
    const r = applyBoolean(pc, 'intersection', sq(0, 0, 10), sq(5, 5, 10), EPS);
    assert.ok(r.ok, r.reason);
    assert.equal(r.report.output.outers, 1);
    assert.ok(Math.abs(r.report.output.area - 25) < 1);
  });
  test('相交共边 → 拒绝（零面积），保留原图', () => {
    const before = geomHash(sq(0, 0, 10));
    const r = applyBoolean(pc, 'intersection', sq(0, 0, 10), sq(10, 0, 10), EPS);
    assert.ok(!r.ok);
    assert.ok(r.reason.includes('交集'));
    assert.equal(geomHash(sq(0, 0, 10)), before); // 输入未被修改
  });
  test('相交分离 → 拒绝（交集为空）', () => {
    const r = applyBoolean(pc, 'intersection', sq(0, 0, 10), sq(20, 0, 10), EPS);
    assert.ok(!r.ok && r.reason.includes('为空'));
  });
  test('减去分离形状 → 拒绝（无变化）', () => {
    const r = applyBoolean(pc, 'difference', sq(0, 0, 10), sq(20, 0, 10), EPS);
    assert.ok(!r.ok && r.reason.includes('无变化'));
  });
  test('减去贴边形状 → 拒绝（不减去任何面积）', () => {
    const r = applyBoolean(pc, 'difference', sq(0, 0, 10), sq(10, 2, 10), EPS);
    assert.ok(!r.ok && r.reason.includes('无变化'));
  });
  test('合并被包含形状 → 拒绝（结果与 A 全等）', () => {
    const r = applyBoolean(pc, 'union', sq(0, 0, 10), sq(2, 2, 4), EPS);
    assert.ok(!r.ok && r.reason.includes('全等'));
  });
  test('自交输入 → 拒绝并说明，输入未被修改', () => {
    const bowtie = [[[[0, 0], [10, 10], [10, 0], [0, 10]]]];
    const before = JSON.stringify(bowtie);
    const r = applyBoolean(pc, 'union', bowtie, sq(20, 20, 5), EPS);
    assert.ok(!r.ok);
    assert.ok(r.reason.includes('拓扑无效'));
    assert.equal(JSON.stringify(bowtie), before);
  });
  test('带洞形状参与运算：洞关系保持', () => {
    const donut = normRings([sqRing(0, 0, 20), sqRing(8, 8, 4)]);
    const r = applyBoolean(pc, 'union', donut, sq(15, 8, 10), EPS);
    assert.ok(r.ok, r.reason);
    assert.equal(r.report.output.holes, 1); // 洞未丢失
    const v = validateGeom(r.geom, EPS);
    assert.ok(v.ok, v.errors.join('; '));
  });
});

// ---------- 变换保持拓扑 ----------
suite('变换后外轮廓/洞关系保持', () => {
  test('带洞形状 旋转+缩放+平移 → 仍有效且洞数不变', () => {
    const donut = normRings([sqRing(0, 0, 20), sqRing(8, 8, 4)]);
    const c = geomCentroid(donut);
    let g = rotateGeom(donut, Math.PI / 3.7, c);
    g = scaleGeom(g, 1.8, c);
    g = translateGeom(g, 137.3, -58.2);
    const v = validateGeom(g, EPS);
    assert.ok(v.ok, v.errors.join('; '));
    assert.deepEqual([v.stats.outers, v.stats.holes], [1, 1]);
  });
});

// ---------- 历史 ----------
suite('history 撤销/重做/持久化', () => {
  function sceneWith(geoms) {
    return {
      shapes: geoms.map((g, i) => ({ id: `s${i}`, name: `形状${i}`, color: '#fff', geom: g })),
      selected: [],
    };
  }
  test('撤销恢复完整拓扑（含洞），不只是位置', () => {
    const h = createHistory();
    pushEntry(h, sceneWith([sq(0, 0, 10), sq(3, 3, 4)]), { label: '初始' });
    // 布尔：减去出洞
    const r = applyBoolean(pc, 'difference', sq(0, 0, 10), sq(3, 3, 4), EPS);
    assert.ok(r.ok);
    pushEntry(h, sceneWith([r.geom]), { label: '减去' });
    assert.equal(geomStats(h.entries[1].snapshot.shapes[0].geom).holes, 1);
    const snap = undo(h);
    assert.equal(snap.shapes.length, 2); // 恢复两个原始形状
    assert.equal(geomStats(snap.shapes[0].geom).holes, 0);
    const snap2 = redo(h);
    assert.equal(geomStats(snap2.shapes[0].geom).holes, 1); // 重做恢复洞
  });
  test('撤销后新操作截断重做分支', () => {
    const h = createHistory();
    pushEntry(h, sceneWith([sq(0, 0, 10)]), { label: '1' });
    pushEntry(h, sceneWith([sq(0, 0, 20)]), { label: '2' });
    undo(h);
    pushEntry(h, sceneWith([sq(0, 0, 30)]), { label: '3' });
    assert.equal(h.entries.length, 2);
    assert.equal(redo(h), null);
  });
  test('jumpTo 跳转到任意历史状态', () => {
    const h = createHistory();
    pushEntry(h, sceneWith([sq(0, 0, 10)]), { label: '1' });
    pushEntry(h, sceneWith([sq(0, 0, 10), sq(50, 50, 5)]), { label: '2' });
    pushEntry(h, sceneWith([sq(0, 0, 10), sq(50, 50, 5), sq(90, 90, 5)]), { label: '3' });
    const snap = jumpTo(h, 1);
    assert.equal(snap.shapes.length, 2);
    assert.equal(h.index, 1);
  });
  test('快照深拷贝：后续编辑不污染历史', () => {
    const h = createHistory();
    const g = sq(0, 0, 10);
    const scene = sceneWith([g]);
    pushEntry(h, scene, { label: '1' });
    scene.shapes[0].geom[0][0][0][0] = 9999; // 破坏当前场景
    const snap = jumpTo(h, 0);
    assert.notEqual(snap.shapes[0].geom[0][0][0][0], 9999);
  });
  test('持久化往返：序列化→反序列化，哈希全部一致（模拟刷新）', () => {
    const h = createHistory();
    pushEntry(h, sceneWith([sq(0, 0, 10), sq(5, 0, 10)]), { label: '初始' });
    const r = applyBoolean(pc, 'union', sq(0, 0, 10), sq(5, 0, 10), EPS);
    pushEntry(h, sceneWith([r.geom]), { label: '合并', report: r.report });
    undo(h);
    const json = serializeHistory(h, EPS);
    const { history: h2, eps, mismatches } = deserializeHistory(json);
    assert.equal(eps, EPS);
    assert.equal(mismatches.length, 0);
    assert.equal(h2.index, h.index);
    assert.equal(h2.entries.length, 2);
    // 恢复的几何与原几何逐点一致
    assert.equal(geomHash(h2.entries[1].snapshot.shapes[0].geom), geomHash(r.geom));
  });
  test('篡改检测：存储快照被改动 → 哈希不一致', () => {
    const h = createHistory();
    pushEntry(h, sceneWith([sq(0, 0, 10)]), { label: '1' });
    const json = serializeHistory(h, EPS);
    const data = JSON.parse(json);
    data.entries[0].snapshot.shapes[0].geom[0][0][0][0] += 1;
    const { mismatches } = deserializeHistory(JSON.stringify(data));
    assert.equal(mismatches.length, 1);
  });
});

// ---------- 确定性（刷新一致性基础） ----------
suite('确定性', () => {
  test('同一操作序列执行两次 → 几何哈希完全一致', () => {
    const run = () => {
      const r1 = applyBoolean(pc, 'union', sq(0, 0, 10), sq(5, 0, 10), EPS);
      const r2 = applyBoolean(pc, 'difference', r1.geom, sq(3, 3, 4), EPS);
      const r3 = applyBoolean(pc, 'intersection', r2.geom, sq(0, 0, 8), EPS);
      return geomHash(r3.geom);
    };
    assert.equal(run(), run());
  });
  test('连续多轮：合并→旋转→减去→相交，每步拓扑有效', () => {
    let g = applyBoolean(pc, 'union', sq(0, 0, 10), sq(8, 0, 10), EPS).geom;
    assert.ok(validateGeom(g, EPS).ok);
    g = rotateGeom(g, Math.PI / 6, geomCentroid(g));
    assert.ok(validateGeom(g, EPS).ok);
    const r2 = applyBoolean(pc, 'difference', g, translateGeom(sq(3, 3, 4), 2, 2), EPS);
    if (r2.ok) {
      assert.ok(validateGeom(r2.geom, EPS).ok);
      const r3 = applyBoolean(pc, 'intersection', r2.geom, sq(-5, -5, 30), EPS);
      assert.ok(r3.ok || r3.reason); // 空结果也是合法结论
      if (r3.ok) assert.ok(validateGeom(r3.geom, EPS).ok);
    }
  });
});

// ---------- 端到端会话（模拟真实多轮操作 + 刷新重载） ----------
suite('端到端会话', () => {
  test('绘制→合并→旋转→减洞→撤销/重做→序列化重载，全程拓扑一致', () => {
    const h = createHistory();
    const scene = { shapes: [], selected: [] };
    const put = (name, geom) => {
      const s = { id: `id-${name}`, name, color: '#4f8ef7', geom };
      scene.shapes.push(s);
      return s;
    };
    const snap = () => ({ shapes: scene.shapes, selected: scene.selected });
    const commit = (label, report) =>
      pushEntry(h, snap(), { label, validation: '', report: report || null });

    // 1. 绘制两个重叠形状
    const A = put('形状1', normRings([sqRing(0, 0, 100)]));
    const B = put('形状2', normRings([sqRing(60, 0, 100)]));
    commit('初始场景');

    // 2. 合并 → R1（消耗 A、B）
    const u = applyBoolean(pc, 'union', A.geom, B.geom, EPS);
    assert.ok(u.ok, u.reason);
    scene.shapes = [put('R1', u.geom)];
    commit('合并 形状1 ∪ 形状2 → R1', u.report);

    // 3. 旋转 R1（仿射变换保持拓扑）
    scene.shapes[0].geom = rotateGeom(scene.shapes[0].geom, Math.PI / 5, geomCentroid(scene.shapes[0].geom));
    assert.ok(validateGeom(scene.shapes[0].geom, EPS).ok);
    commit('旋转 R1 36°');

    // 4. 绘制 C 并减去 → 产生洞
    const C = put('形状3', normRings([sqRing(70, 30, 30)]));
    commit('绘制 形状3');
    const d = applyBoolean(pc, 'difference', scene.shapes[0].geom, C.geom, EPS);
    assert.ok(d.ok, d.reason);
    assert.equal(d.report.output.holes, 1);
    scene.shapes = [put('R2', d.geom)];
    commit('减去 R1 − 形状3 → R2', d.report);

    // 5. 无效操作：与分离形状相交 → 拒绝，历史不变
    const far = normRings([sqRing(500, 500, 20)]);
    const bad = applyBoolean(pc, 'intersection', scene.shapes[0].geom, far, EPS);
    assert.ok(!bad.ok);
    const lenBefore = h.entries.length;
    assert.equal(h.entries.length, lenBefore); // 未写入历史
    assert.equal(scene.shapes.length, 1);      // 场景未变

    // 6. 撤销两步（回到旋转后），洞消失；重做一步，洞恢复
    let s1 = undo(h); // 撤销"减去"
    assert.equal(geomStats(s1.shapes[0].geom).holes, 0);
    undo(h);          // 撤销"旋转"
    const s3 = redo(h); // 重做"旋转"
    assert.equal(geomStats(s3.shapes[0].geom).holes, 0);
    const s4 = redo(h); // 重做"减去" → 洞恢复
    assert.equal(geomStats(s4.shapes[0].geom).holes, 1);

    // 7. 模拟刷新：序列化 → 反序列化 → 哈希全一致，当前状态逐点相同
    const json = serializeHistory(h, EPS);
    const { history: h2, mismatches } = deserializeHistory(json);
    assert.equal(mismatches.length, 0);
    assert.equal(h2.index, h.index);
    const restored = h2.entries[h2.index].snapshot;
    assert.equal(geomHash(restored.shapes[0].geom), geomHash(s4.shapes[0].geom));
    assert.equal(geomStats(restored.shapes[0].geom).holes, 1);
  });
});

console.log(`\n${passed} 项测试通过${process.exitCode ? '，存在失败' : ''}`);
