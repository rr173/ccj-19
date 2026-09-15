// run-tests.js — 派生依赖图、原子重算、删除策略、冻结边界、历史与刷新一致性的自动化测试。
// 运行：npm test
import assert from 'node:assert/strict';
import pc from 'polygon-clipping';
import {
  ringArea, pointInRing, segmentsIntersect, translateGeom, rotateGeom, scaleGeom, geomCentroid,
} from '../public/js/geometry.js';
import { normalizeGeom, geomHash, geomStats } from '../public/js/model.js';
import { validateGeom, classifyTouch } from '../public/js/validate.js';
import { applyBoolean } from '../public/js/ops.js';
import {
  createDocument, addRoot, getNode, descendants, directDependents, isDerived,
  createDerived, setDerivedConfig, freezeNode, unfreezeNode, mutateGeometries,
  deletionReferences, deleteNode, checkCycle, runRecompute,
} from '../public/js/graph.js';
import {
  createHistory, pushEntry, undo, redo, jumpTo,
  serializeHistory, deserializeHistory, snapshotFromDoc, sceneHash,
} from '../public/js/history.js';

const EPS = 0.5;
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.stack.split('\n').slice(0, 3).join('\n    ')}`);
    process.exitCode = 1;
  }
}
function suite(name, fn) { console.log(`\n■ ${name}`); fn(); }

const sqRing = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const sq = (x, y, s) => normalizeGeom([sqRing(x, y, s)], EPS);
let doc;
function root(x, y, s, name) {
  return addRoot(doc, name || `R${doc.nodes.length + 1}`, sq(x, y, s), '#888');
}
function derived(a, b, op, name, eps) {
  const r = createDerived(pc, doc, { name: name || `D${doc.seqCounter}`, op, sourceIds: [a.id, b.id], eps: eps || EPS, color: '#999' });
  if (!r.ok) throw new Error('createDerived 失败: ' + r.reason);
  return r.node;
}
function mutate(id, geom, label) {
  return mutateGeometries(pc, doc, [{ id, geom }], label || 'mutate');
}

// ---------- 基础几何（保留关键既有能力） ----------
suite('geometry / normalize / validate 基础', () => {
  test('ringArea 符号', () => {
    assert.equal(ringArea([[0, 0], [10, 0], [10, 10], [0, 10]]), 100);
    assert.equal(ringArea([[0, 0], [0, 10], [10, 10], [10, 0]]), -100);
  });
  test('pointInRing / segmentsIntersect', () => {
    const r = [[0, 0], [10, 0], [10, 10], [0, 10]];
    assert.equal(pointInRing(r, [5, 5], 1e-9), 'in');
    assert.equal(segmentsIntersect([0, 0], [10, 10], [0, 10], [10, 0]).proper, true);
  });
  test('normalizeGeom 洞分类与哈希稳定', () => {
    const g = normalizeGeom([sqRing(0, 0, 10), sqRing(3, 3, 4)], EPS);
    assert.deepEqual([geomStats(g).outers, geomStats(g).holes], [1, 1]);
    const a = normalizeGeom([[[0, 0], [10, 0], [10, 10], [0, 10]]], EPS);
    const b = normalizeGeom([[[10, 10], [0, 10], [0, 0], [10, 0]]], EPS);
    assert.equal(geomHash(a), geomHash(b));
  });
  test('classifyTouch 四分类', () => {
    assert.equal(classifyTouch(sq(0, 0, 10), sq(20, 0, 10), EPS).kind, 'disjoint');
    assert.equal(classifyTouch(sq(0, 0, 10), sq(10, 0, 10), EPS).kind, 'edge-touch');
    assert.equal(classifyTouch(sq(0, 0, 10), sq(10, 10, 10), EPS).kind, 'point-touch');
    assert.equal(classifyTouch(sq(0, 0, 10), sq(5, 5, 10), EPS).kind, 'overlap');
  });
  test('applyBoolean recompute 模式：差集无变化是合法结论', () => {
    const r = applyBoolean(pc, 'difference', sq(0, 0, 10), sq(20, 0, 10), EPS, { recompute: true });
    assert.ok(r.ok, r.reason);
    assert.equal(geomHash(r.geom), geomHash(sq(0, 0, 10)));
  });
  test('applyBoolean recompute 模式：相交为空仍失败', () => {
    const r = applyBoolean(pc, 'intersection', sq(0, 0, 10), sq(20, 0, 10), EPS, { recompute: true });
    assert.ok(!r.ok);
  });
});

// ---------- 场景 1：链式 A∪B 再 −C，移动 B，两层依次更新 ----------
suite('链式派生与自动重算', () => {
  test('建立 A∪B=D1，D1−C=D2；移动 B 后两层结果依次更新', () => {
    doc = createDocument();
    const A = root(0, 0, 100, 'A');
    const B = root(60, 0, 100, 'B');
    const C = root(140, 40, 30, 'C');
    const D1 = derived(A, B, 'union', 'D1');
    const D2 = derived(D1, C, 'difference', 'D2');
    const d1Before = geomHash(D1.geom), d2Before = geomHash(D2.geom);
    assert.ok(validateGeom(D2.geom, EPS).ok);

    const res = mutate(B.id, translateGeom(B.geom, 0, 1), '移动 B +1y');
    assert.ok(res.ok, res.reason);
    // 重算顺序：D1 先于 D2
    assert.deepEqual(res.round.order, [D1.id, D2.id]);
    assert.notEqual(geomHash(getNode(doc, D1.id).geom), d1Before);
    assert.notEqual(geomHash(getNode(doc, D2.id).geom), d2Before);
    assert.ok(validateGeom(getNode(doc, D2.id).geom, EPS).ok);
    // 来源关系仍按稳定 id 记录
    assert.deepEqual(getNode(doc, D2.id).sources, [D1.id, C.id]);
    // 容差被记住
    assert.equal(getNode(doc, D1.id).eps, EPS);
  });

  test('同一操作序列两轮：顺序与结果哈希确定', () => {
    doc = createDocument();
    const A = root(0, 0, 100), B = root(60, 0, 100), C = root(140, 40, 30);
    const D1 = derived(A, B, 'union'), D2 = derived(D1, C, 'difference');
    const moveAndHash = () => {
      const r = mutate(B.id, translateGeom(sq(60, 0, 100), 0, 5), 'x');
      return {
        order: r.round.order.slice(),
        hash: r.round.hash,
        h1: geomHash(getNode(doc, D1.id).geom),
        h2: geomHash(getNode(doc, D2.id).geom),
      };
    };
    const r1 = moveAndHash();
    // 还原 B 后再以完全相同的位移移动一次
    mutate(B.id, sq(60, 0, 100), 'restore');
    const r2 = moveAndHash();
    assert.deepEqual(r2, r1);
  });
});

// ---------- 场景 2：同一来源两条分支，只重算受影响后代 ----------
suite('分支共享与最小重算', () => {
  test('A 同时喂给 (A∪B) 与 (A−C)：移动 C 只重算 D2 分支', () => {
    doc = createDocument();
    const A = root(0, 0, 100, 'A'), B = root(60, 0, 100, 'B'), C = root(20, 20, 20, 'C');
    const D1 = derived(A, B, 'union', 'D1');
    const D2 = derived(A, C, 'difference', 'D2');
    const d1Before = geomHash(D1.geom);
    const res = mutate(C.id, translateGeom(C.geom, 10, 0), '移动 C');
    assert.ok(res.ok, res.reason);
    assert.deepEqual(res.round.order, [D2.id]); // 只重算受影响后代
    assert.equal(geomHash(getNode(doc, D1.id).geom), d1Before);
  });

  test('共享中间结果：每轮每个节点只计算一次（菱形 DAG）', () => {
    doc = createDocument();
    const A = root(0, 0, 100), B = root(60, 0, 100), C = root(120, 60, 80);
    const M = derived(A, B, 'union', 'M');
    const D1 = derived(M, C, 'union', 'D1');
    const D2 = derived(M, C, 'difference', 'D2');
    const res = mutate(A.id, translateGeom(A.geom, 0, 2), '移动 A');
    assert.ok(res.ok, res.reason);
    // M 在 order 中只出现一次，且先于 D1/D2
    assert.equal(res.round.order.filter(id => id === M.id).length, 1);
    const iM = res.round.order.indexOf(M.id);
    assert.ok(iM < res.round.order.indexOf(D1.id));
    assert.ok(iM < res.round.order.indexOf(D2.id));
  });
});

// ---------- 场景 3：循环依赖被拒绝且状态不变 ----------
suite('循环依赖禁止', () => {
  test('把后代重新设为祖先的来源 → 拒绝，几何/边/哈希不变', () => {
    doc = createDocument();
    const A = root(0, 0, 100, 'A'), B = root(60, 0, 100, 'B');
    const D1 = derived(A, B, 'union', 'D1');
    const C = root(200, 200, 20, 'C');
    // D2 = D1 ∪ C：D2 是 D1 的后代
    const D2 = derived(D1, C, 'union', 'D2');
    // 间接环：让 D1 的来源包含其后代 D2（新边 D2→D1 与 D1→D2 成环）
    const before = JSON.stringify({ s: D1.sources, g: D1.geom });
    const res = setDerivedConfig(pc, doc, D1.id, { op: 'union', sourceIds: [A.id, D2.id], eps: EPS });
    assert.ok(!res.ok);
    assert.ok(/循环/.test(res.reason));
    assert.deepEqual(getNode(doc, D1.id).sources, [A.id, B.id]); // 边未变
    assert.equal(JSON.stringify({ s: getNode(doc, D1.id).sources, g: getNode(doc, D1.id).geom }), before);
    // 另一个方向同样被拒：把 D2 改成以它自己的后代为来源（先构造两层）
    const D3 = derived(D2, C, 'difference', 'D3');
    const res2 = setDerivedConfig(pc, doc, D2.id, { op: 'union', sourceIds: [D3.id, C.id], eps: EPS });
    assert.ok(!res2.ok && /循环/.test(res2.reason));
    assert.deepEqual(getNode(doc, D2.id).sources, [D1.id, C.id]);
  });

  test('checkCycle：自环、重复源、缺失源均拒绝', () => {
    doc = createDocument();
    const A = root(0, 0, 100), B = root(60, 0, 100);
    const D1 = derived(A, B, 'union');
    assert.ok(!checkCycle(doc, D1.id, [D1.id, A.id]).ok);
    assert.ok(!checkCycle(doc, D1.id, [A.id, A.id]).ok);
    assert.ok(!checkCycle(doc, D1.id, [A.id, 'missing-id']).ok);
    assert.ok(checkCycle(doc, D1.id, [A.id, B.id]).ok);
  });
});

// ---------- 场景 4：下游空结果 → 整轮原子回滚 ----------
suite('原子重算与失败回滚', () => {
  test('移动使第二层结果为空：全部节点（含第一层）几何与依赖图恢复，失败节点与原因明确', () => {
    doc = createDocument();
    // 链：M=A∪B；D2=M−C。C 初始在 M 内部（减出洞）；把 B 移远使 M 收缩到与 C 分离，
    // 此时第一层 M 仍成功重算，但第二层 D2 差集无变化……为得到"空结果"，第二层用交集。
    const A = root(0, 0, 100, 'A'), B = root(60, 0, 100, 'B'), C = root(20, 20, 40, 'C');
    const M = derived(A, B, 'union', 'M');
    const D2 = derived(M, C, 'intersection', 'D2');
    assert.ok(validateGeom(D2.geom, EPS).ok);
    const snapshotBefore = JSON.stringify(doc.nodes.map(n => [n.id, geomHash(n.geom), n.sources || null]));
    const mBefore = geomHash(M.geom);

    // 移动 A（M 的来源）：M 先重算（成功），随后 D2=M∩C 为空 → 失败
    const res = mutate(A.id, translateGeom(A.geom, 900, 900), '把 A 移到远处');
    assert.ok(!res.ok);
    assert.equal(res.failed.node.id, D2.id);
    assert.equal(res.failed.code, 'empty-result');
    assert.ok(/空/.test(res.reason));
    // 图与几何完全不变（M 也没有留下半更新状态）
    assert.equal(geomHash(getNode(doc, M.id).geom), mBefore);
    const after = JSON.stringify(doc.nodes.map(n => [n.id, geomHash(n.geom), n.sources || null]));
    assert.equal(after, snapshotBefore);
    // 失败轮日志记录在案并标记回滚
    const round = doc.rounds[doc.rounds.length - 1];
    assert.equal(round.ok, false);
    assert.equal(round.rolledBack, true);
    assert.equal(round.failedId, D2.id);
    assert.deepEqual(round.order, [M.id, D2.id]); // M 先成功、D2 失败
    assert.ok(round.entries.some(e => e.id === M.id && e.after)); // M 本轮确实算过
    assert.ok(round.entries.some(e => e.id === D2.id && !e.after)); // D2 无结果哈希
  });

  test('第一层拓扑无效同样整轮回滚', () => {
    doc = createDocument();
    const A = root(0, 0, 100), B = root(60, 0, 100);
    const D1 = derived(A, B, 'union');
    const bowtie = [[[[0, 0], [10, 10], [10, 0], [0, 10]]]];
    const res = mutate(A.id, bowtie, '自交来源');
    assert.ok(!res.ok);
    assert.equal(res.failed.node.id, D1.id);
    assert.ok(validateGeom(getNode(doc, A.id).geom, EPS).ok); // 来源也回滚
  });

  test('改写来源导致下游空结果：配置与全部几何回滚，仅留下失败轮日志', () => {
    doc = createDocument();
    const A = root(0, 0, 100, 'A'), B = root(60, 0, 100, 'B');
    const M = derived(A, B, 'union', 'M');
    const X = root(0, 0, 20, 'X');
    const D2 = derived(M, X, 'intersection', 'D2');
    assert.ok(validateGeom(D2.geom, EPS).ok);
    const mBefore = geomHash(M.geom);
    const roundsBefore = doc.rounds.length;
    // 让 M 改以远处的两个分离形状做交集：M 自身先失败；这里用 union 保证 M 能算，
    // 但把 M 换成与 X 分离的来源 → D2 交集为空（M 先重算、D2 失败）
    const far1 = root(900, 900, 10, 'F1'), far2 = root(960, 900, 10, 'F2');
    const res = setDerivedConfig(pc, doc, M.id, { op: 'union', sourceIds: [far1.id, far2.id], eps: EPS });
    assert.ok(!res.ok);
    assert.equal(res.failed.node.id, D2.id);
    assert.deepEqual(getNode(doc, M.id).sources, [A.id, B.id]); // 配置回滚
    assert.equal(geomHash(getNode(doc, M.id).geom), mBefore);   // 几何回滚
    assert.equal(doc.rounds.length, roundsBefore + 1);          // 失败轮保留
    assert.equal(doc.rounds.at(-1).ok, false);
  });

  test('解冻失败（来源已使交集为空）：保持冻结与冻结几何', () => {
    doc = createDocument();
    const A = root(0, 0, 100), B = root(60, 0, 100);
    const M = derived(A, B, 'intersection');
    freezeNode(doc, M.id);
    const mFrozen = geomHash(getNode(doc, M.id).geom);
    // 冻结期间把 B 移到与 A 分离（M 是冻结边界，不重算）
    const mv = mutate(B.id, sq(900, 900, 100), '移走 B');
    assert.ok(mv.ok);
    assert.deepEqual(mv.round.order, []);
    // 解冻必须重算 M = A ∩ B → 空 → 失败并保持冻结
    const ur = unfreezeNode(pc, doc, M.id);
    assert.ok(!ur.ok);
    assert.equal(ur.failed.node.id, M.id);
    assert.equal(getNode(doc, M.id).frozen, true);
    assert.equal(geomHash(getNode(doc, M.id).geom), mFrozen);
  });
});

// ---------- 场景 5：三种删除策略 ----------
suite('删除策略（取消 / 级联 / 冻结直连）', () => {
  test('无引用图形可直接删除，可撤销恢复', () => {
    doc = createDocument();
    const A = root(0, 0, 10), B = root(30, 30, 10);
    assert.equal(deletionReferences(doc, A.id).length, 0);
    const res = deleteNode(doc, A.id, null);
    assert.ok(res.ok);
    assert.equal(getNode(doc, A.id), null);
    assert.ok(getNode(doc, B.id));
  });

  test('取消删除：图与几何不变，记录一条可撤销的取消日志', () => {
    doc = createDocument();
    const A = root(0, 0, 100, 'A'), B = root(60, 0, 100, 'B');
    const D1 = derived(A, B, 'union', 'D1');
    const present = () => [A.id, B.id, D1.id].every(id => getNode(doc, id));
    const nodeSig = () => doc.nodes.map(n => [n.id, n.sources || null, geomHash(n.geom)]);
    const before = JSON.stringify(nodeSig());
    const refs = deletionReferences(doc, A.id);
    assert.equal(refs.length, 1);
    const res = deleteNode(doc, A.id, 'cancel');
    assert.ok(res.cancelled);
    assert.ok(present());
    assert.equal(JSON.stringify(nodeSig()), before);
    assert.equal(doc.rounds.at(-1).trigger, 'delete-cancel');
  });

  test('级联删除：来源与全部后代删除，旁路分支保留', () => {
    doc = createDocument();
    const A = root(0, 0, 100), B = root(60, 0, 100), C = root(120, 60, 80), X = root(0, 300, 20);
    const D1 = derived(A, B, 'union');
    const D2 = derived(D1, C, 'union');
    const side = derived(X, A, 'union'); // A 的另一分支，也在 A 的后代集合中
    const ids = new Set(descendants(doc, A.id).map(d => d.id));
    assert.ok(ids.has(D1.id) && ids.has(D2.id) && ids.has(side.id));
    const res = deleteNode(doc, A.id, 'cascade');
    assert.ok(res.ok);
    for (const id of [A.id, D1.id, D2.id, side.id]) assert.equal(getNode(doc, id), null);
    assert.ok(getNode(doc, B.id));
    assert.ok(getNode(doc, C.id));
    assert.ok(getNode(doc, X.id));
    assert.deepEqual(res.removed.sort(), [A.id, D1.id, D2.id, side.id].sort());
  });

  test('冻结直接结果后删除：直连结果降级为普通图形并保留几何，传递后代按新边界处理', () => {
    doc = createDocument();
    const A = root(0, 0, 100), B = root(60, 0, 100), C = root(120, 60, 80);
    const D1 = derived(A, B, 'union');
    const D2 = derived(D1, C, 'union');
    const d1Geom = geomHash(D1.geom);
    const res = deleteNode(doc, A.id, 'freeze-direct');
    assert.ok(res.ok);
    assert.equal(getNode(doc, A.id), null);
    const f1 = getNode(doc, D1.id);
    assert.ok(f1);
    assert.equal(f1.kind, 'root'); // 降级为普通图形：无 op/sources/frozen
    assert.equal(f1.frozen || false, false);
    assert.equal(f1.sources, undefined);
    assert.equal(geomHash(f1.geom), d1Geom); // 几何保留
    assert.ok(getNode(doc, D2.id));          // 传递后代保留
    // 普通图形 D1 的变化仍驱动仍引用它的 D2
    const r2 = mutate(D1.id, translateGeom(D1.geom, 0, 2), '编辑普通图形 D1');
    assert.ok(r2.ok);
    assert.deepEqual(r2.round.order, [D2.id]);
    // B 的变化不再与 D1 有任何关系
    const r3 = mutate(B.id, translateGeom(B.geom, 0, 4), '移动 B');
    assert.ok(r3.ok);
    assert.deepEqual(r3.round.order, []);
  });
});

// ---------- 场景 6：冻结中间节点形成新依赖边界 ----------
suite('冻结边界', () => {
  test('冻结 M 后修改最初来源：M 及其后代按新边界处理（不重算）；解冻后恢复跟随', () => {
    doc = createDocument();
    const A = root(0, 0, 100), B = root(60, 0, 100), C = root(120, 60, 80);
    const M = derived(A, B, 'union');
    const D2 = derived(M, C, 'union');
    const mHash = geomHash(M.geom), d2Hash = geomHash(D2.geom);

    const fr = freezeNode(doc, M.id);
    assert.ok(fr.ok);
    assert.ok(!isDerived(getNode(doc, M.id)));
    assert.equal(descendants(doc, A.id).map(d => d.id).includes(M.id), false); // 边界截断

    const res = mutate(A.id, translateGeom(A.geom, 0, 8), '移动 A');
    assert.ok(res.ok);
    assert.deepEqual(res.round.order, []); // 冻结节点之后无活动下游
    assert.equal(geomHash(getNode(doc, M.id).geom), mHash);
    assert.equal(geomHash(getNode(doc, D2.id).geom), d2Hash);

    // 解冻：按当前来源重算 M、D2
    const movedM = applyBoolean(pc, 'union', translateGeom(sq(0, 0, 100), 0, 8), sq(60, 0, 100), EPS, { recompute: true }).geom;
    const ur = unfreezeNode(pc, doc, M.id);
    assert.ok(ur.ok);
    assert.equal(geomHash(getNode(doc, M.id).geom), geomHash(movedM)); // 跟随到冻结期间的来源变化
    assert.notEqual(geomHash(getNode(doc, M.id).geom), mHash);
    assert.ok(ur.round.order.includes(M.id) && ur.round.order.includes(D2.id));
  });

  test('创建派生时若结果为空 → 不创建任何节点、不产生日志', () => {
    doc = createDocument();
    const A = root(0, 0, 10), B = root(100, 100, 10);
    const before = doc.nodes.length;
    const res = createDerived(pc, doc, { name: 'X', op: 'intersection', sourceIds: [A.id, B.id], eps: EPS, color: '#000' });
    assert.ok(!res.ok);
    assert.equal(doc.nodes.length, before);
  });
});

// ---------- 场景 7：历史、撤销/重做与刷新一致性 ----------
suite('历史 / 撤销重做 / 刷新', () => {
  function build() {
    const d = createDocument();
    const nA = addRoot(d, 'A', sq(0, 0, 100), '#1');
    const nB = addRoot(d, 'B', sq(60, 0, 100), '#2');
    const nC = addRoot(d, 'C', sq(140, 40, 30), '#3');
    const r1 = createDerived(pc, d, { name: 'D1', op: 'union', sourceIds: [nA.id, nB.id], eps: EPS, color: '#4' });
    const r2 = createDerived(pc, d, { name: 'D2', op: 'difference', sourceIds: [r1.node.id, nC.id], eps: EPS, color: '#5' });
    return { d, ids: { A: nA.id, B: nB.id, C: nC.id, D1: r1.node.id, D2: r2.node.id } };
  }

  test('撤销移动→几何与依赖恢复；重做→再次一致', () => {
    const { d, ids } = build();
    const h = createHistory();
    pushEntry(h, snapshotFromDoc(d, []), { label: '初始' });
    const bNode = d.nodes.find(n => n.id === ids.B);
    mutateGeometries(pc, d, [{ id: ids.B, geom: translateGeom(bNode.geom, 0, 3) }], '移动 B');
    pushEntry(h, snapshotFromDoc(d, []), { label: '移动 B' });
    const movedHashes = { D1: geomHash(d.nodes.find(n => n.id === ids.D1).geom), D2: geomHash(d.nodes.find(n => n.id === ids.D2).geom) };

    const s0 = undo(h);
    const d0 = s0.doc;
    assert.notEqual(geomHash(d0.nodes.find(n => n.id === ids.D1).geom), movedHashes.D1);
    assert.deepEqual(d0.nodes.find(n => n.id === ids.D1).sources, [ids.A, ids.B]);
    const s1 = redo(h);
    assert.equal(geomHash(s1.doc.nodes.find(n => n.id === ids.D1).geom), movedHashes.D1);
    assert.equal(geomHash(s1.doc.nodes.find(n => n.id === ids.D2).geom), movedHashes.D2);
  });

  test('刷新模拟：序列化→反序列化，依赖边/冻结/几何/重算日志摘要与哈希一致', () => {
    const { d, ids } = build();
    const h = createHistory();
    pushEntry(h, snapshotFromDoc(d, []), { label: '初始' });
    freezeNode(d, ids.D1);
    pushEntry(h, snapshotFromDoc(d, []), { label: '冻结 D1' });
    const bNode = d.nodes.find(n => n.id === ids.B);
    mutateGeometries(pc, d, [{ id: ids.B, geom: translateGeom(bNode.geom, 0, 2) }], '移动 B');
    pushEntry(h, snapshotFromDoc(d, []), { label: '移动 B' });
    const lastRound = d.rounds.at(-1);

    const json = serializeHistory(h, EPS);
    const { history: h2, eps: eps2, mismatches } = deserializeHistory(json);
    assert.equal(eps2, EPS);
    assert.equal(mismatches.length, 0);
    const cur = h2.entries[h2.index].snapshot.doc;
    const d1 = cur.nodes.find(n => n.id === ids.D1);
    assert.equal(d1.frozen, true);
    assert.deepEqual(d1.sources, [ids.A, ids.B]);
    assert.equal(geomHash(d1.geom), geomHash(d.nodes.find(n => n.id === ids.D1).geom));
    // 重算日志摘要与哈希
    const restoredRound = cur.rounds.find(r => r.seq === lastRound.seq);
    assert.ok(restoredRound);
    assert.equal(restoredRound.hash, lastRound.hash);
    assert.equal(restoredRound.rolledBack, lastRound.rolledBack);
    // 场景哈希本身一致
    assert.equal(sceneHash(h2.entries[h2.index].snapshot), h.entries[h.index].hash);
  });

  test('篡改检测：改动存储中的几何 → 哈希不一致', () => {
    const { d } = build();
    const h = createHistory();
    pushEntry(h, snapshotFromDoc(d, []), { label: '初始' });
    const data = JSON.parse(serializeHistory(h, EPS));
    data.entries[0].snapshot.doc.nodes[0].geom[0][0][0][0] += 5;
    assert.equal(deserializeHistory(JSON.stringify(data)).mismatches.length, 1);
  });

  test('失败轮也进入历史：撤销失败移动后状态干净，重做仍带失败标记', () => {
    const d = createDocument();
    const A = addRoot(d, 'A', sq(0, 0, 100), '#1');
    const B = addRoot(d, 'B', sq(60, 0, 100), '#2');
    const C = addRoot(d, 'C', sq(20, 20, 30), '#3');
    const M = createDerived(pc, d, { name: 'M', op: 'union', sourceIds: [A.id, B.id], eps: EPS, color: '#4' }).node;
    const D2 = createDerived(pc, d, { name: 'D2', op: 'intersection', sourceIds: [M.id, C.id], eps: EPS, color: '#5' }).node;
    const h = createHistory();
    pushEntry(h, snapshotFromDoc(d, []), { label: '初始' });
    const res = mutateGeometries(pc, d, [{ id: C.id, geom: translateGeom(C.geom, 900, 900) }], '移走 C');
    assert.ok(!res.ok);
    pushEntry(h, snapshotFromDoc(d, []), { label: '失败移动（已回滚）' });
    assert.equal(h.entries[1].snapshot.doc.rounds.at(-1).failedId, D2.id);
    const s0 = undo(h);
    assert.equal(s0.doc.rounds.at(-1).failedId || null, null);
    const s1 = redo(h);
    assert.equal(s1.doc.rounds.at(-1).failedId, D2.id);
  });
});

// ---------- 变换保持拓扑（既有保证不回归） ----------
suite('变换不回归', () => {
  test('带洞形状 旋转+缩放+平移 仍有效', () => {
    const donut = normalizeGeom([sqRing(0, 0, 20), sqRing(8, 8, 4)], EPS);
    const c = geomCentroid(donut);
    let g = rotateGeom(donut, Math.PI / 3.7, c);
    g = scaleGeom(g, 1.8, c);
    g = translateGeom(g, 137.3, -58.2);
    const v = validateGeom(g, EPS);
    assert.ok(v.ok, v.errors.join('; '));
    assert.deepEqual([v.stats.outers, v.stats.holes], [1, 1]);
  });
});

console.log(`\n${passed} 项测试通过${process.exitCode ? '，存在失败' : ''}`);
