// graph.js — 派生图形依赖有向无环图（DAG）引擎。
//
// 每个形状（节点）：
//   { id, seq, name, color, geom,
//     kind: 'root' | 'derived',
//     op?: 'union' | 'difference' | 'intersection',
//     sources?: [稳定 id, 稳定 id]（按运算语义有序：A 在前，B 在后）,
//     eps?: 创建时采用的容差，重算时同样使用（而非编辑时的全局容差）,
//     frozen?: true 冻结后形成新的依赖边界：入边不再传播（上游变化不重算它），
//               出边保留（编辑该冻结图形本身仍驱动其下游）；若其来源被删除，则整体
//               剥离派生身份、降级为真正的根图形 }
//
// 不变量：
//   1. 依赖边只使用稳定 id，绝不使用数组位置；
//   2. 活动节点（未冻结）之间禁止任何直接/间接环（创建、改来源、冻结/解冻时都检查）；
//   3. 一次来源变更触发的重算在副本上完成，任一节点失败即整体回滚（原子）；
//   4. 同一轮中每个受影响节点只计算一次（共享中间结果天然只算一次）；
//   5. 重算顺序与哈希确定：Kahn 拓扑序，就绪队列按 (seq, id) 排序，无时间戳参与。

import { deepCopyGeom } from './geometry.js';
import { geomHash } from './model.js';
import { validateGeom } from './validate.js';
import { applyBoolean, OPS } from './ops.js';

export const ROUNDS_LIMIT = 200;

let idCounter = 0;
// 稳定身份：纯计数器，不含时间/随机数——相同操作序列产生相同 id，便于确定性与测试。
function newId(kind) {
  idCounter += 1;
  return `${kind}-${idCounter.toString(36)}`;
}

/** 反序列化后恢复计数器，保证新 id 不与持久化的 id 冲突。 */
export function bumpIdCounter(doc) {
  for (const n of doc.nodes) {
    const v = parseInt(n.id.split('-')[1], 36);
    if (Number.isFinite(v) && v > idCounter) idCounter = v;
  }
}

export function createDocument() {
  return { nodes: [], seqCounter: 0, rounds: [] };
}

function makeNode(doc, name, geom, color, extra) {
  const node = {
    id: newId(extra.kind || 'root'),
    seq: ++doc.seqCounter,
    name, color, geom: deepCopyGeom(geom),
    kind: 'root',
    ...extra,
  };
  doc.nodes.push(node);
  return node;
}

export function addRoot(doc, name, geom, color) {
  return makeNode(doc, name, geom, color, { kind: 'root' });
}

export const deepCopyDoc = doc => JSON.parse(JSON.stringify(doc));

// ---------- 查询 ----------

export function getNode(doc, id) { return doc.nodes.find(n => n.id === id) || null; }
export const isDerived = n => n && n.kind === 'derived' && !n.frozen;
export const isFrozen = n => n && n.kind === 'derived' && !!n.frozen;

/** 活动依赖边（冻结节点视为普通图形，不传播任何依赖）。 */
export function sourceIds(n) {
  return isDerived(n) ? n.sources.slice() : [];
}

/** 直接依赖 n 的活动派生节点（稳定 id 去重）。 */
export function directDependents(doc, id) {
  const out = [];
  const seen = new Set();
  for (const n of doc.nodes) {
    if (!isDerived(n)) continue;
    if (n.sources.includes(id) && !seen.has(n.id)) { seen.add(n.id); out.push(n); }
  }
  return out;
}

/** 与 directDependents 相同，但忽略 frozen（环检测用：冻结不删除边）。 */
function rawDependents(doc, id) {
  const out = [];
  const seen = new Set();
  for (const n of doc.nodes) {
    if (n.kind !== 'derived') continue;
    if (n.sources.includes(id) && !seen.has(n.id)) { seen.add(n.id); out.push(n); }
  }
  return out;
}

/**
 * 受 n 影响的全部活动后代（沿活动边 BFS，稳定 id 收集）。
 * 冻结节点及其下游会成为新的依赖边界，不在其中。
 */
export function descendants(doc, id) {
  const order = [];
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift();
    for (const dep of directDependents(doc, cur)) {
      if (!seen.has(dep.id)) { seen.add(dep.id); order.push(dep); queue.push(dep.id); }
    }
  }
  return order; // BFS 顺序（稳定：directDependents 按 doc.nodes 顺序）
}

/**
 * 环检测：若 candidate 的入边（sources）替换为 newSourceIds，活动图中是否产生环。
 * 边方向 source → derived：新边是 newSource → candidate。成环当且仅当 candidate
 * 沿当前活动边已经能到达某个新源（candidate → … → newSource，再接 newSource → candidate）。
 * 改 candidate.sources 只改变它的入边，不影响它的前向可达性，因此直接从 candidate 前向 BFS。
 * 返回 {ok, reason}。
 */
export function checkCycle(doc, candidateId, newSourceIds) {
  const cand = getNode(doc, candidateId);
  if (!cand) return { ok: false, reason: `节点 ${candidateId} 不存在` };
  if (newSourceIds.length !== 2) return { ok: false, reason: '布尔派生图形必须恰好引用两个来源' };
  if (newSourceIds.includes(candidateId)) return { ok: false, reason: '不能把自身设为来源（直接自环）' };
  if (newSourceIds[0] === newSourceIds[1]) return { ok: false, reason: '两个来源必须是不同图形' };
  for (const sid of newSourceIds) {
    if (!getNode(doc, sid)) return { ok: false, reason: '来源图形缺失' };
  }
  // 前向可达集合。冻结只截断"来源变更"的自动传播、不删除边；为避免把环带入冻结状态，
  // 这里按存储的边（忽略 frozen 标志）做可达性检查。
  const reachable = new Set();
  const queue = [candidateId];
  while (queue.length) {
    const curId = queue.shift();
    for (const dep of rawDependents(doc, curId)) {
      if (!reachable.has(dep.id)) { reachable.add(dep.id); queue.push(dep.id); }
    }
  }
  for (const sid of newSourceIds) {
    if (reachable.has(sid)) {
      return { ok: false, reason: '拒绝：该来源是本图形的后代，会形成循环依赖' };
    }
  }
  return { ok: true };
}

// ---------- 确定性拓扑序 ----------

function nodeLess(a, b) { return a.seq < b.seq || (a.seq === b.seq && a.id < b.id); }

/**
 * 受影响活动节点的确定性拓扑序（Kahn；就绪队列取 (seq,id) 最小者）。
 * seeds 是本轮变化的根节点 id；冻结节点截断传播。
 */
export function affectedOrder(doc, seedIds) {
  const affected = new Set();
  const q = [];
  for (const id of seedIds.slice().sort()) q.push(id);
  while (q.length) {
    const cur = q.shift();
    for (const dep of directDependents(doc, cur)) {
      if (!affected.has(dep.id) && !seedIds.includes(dep.id)) {
        affected.add(dep.id); q.push(dep.id);
      }
    }
  }
  const list = [...affected].map(id => getNode(doc, id));
  const inDeg = new Map();
  for (const n of list) {
    inDeg.set(n.id, n.sources.filter(sid => affected.has(sid)).length);
  }
  const ready = list.filter(n => inDeg.get(n.id) === 0).sort(nodeLess);
  const order = [];
  while (ready.length) {
    const n = ready.shift();
    order.push(n);
    for (const dep of directDependents(doc, n.id).filter(d => affected.has(d.id)).sort(nodeLess)) {
      inDeg.set(dep.id, inDeg.get(dep.id) - 1);
      if (inDeg.get(dep.id) === 0) {
        // 有序插入，保持就绪队列确定
        let lo = 0, hi = ready.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; nodeLess(ready[mid], dep) ? lo = mid + 1 : hi = mid; }
        ready.splice(lo, 0, dep);
      }
    }
  }
  return order;
}

// ---------- 单节点计算与整轮原子重算 ----------

/**
 * 计算一个派生节点。返回 {ok, geom, reason}。
 * 失败原因分类：'missing-source' | 'invalid-source' | 'empty-result' | 'invalid-result' | 'engine'。
 */
export function computeNode(pc, doc, n, geomLookup) {
  if (n.sources.some(sid => !getNode(doc, sid))) {
    return { ok: false, code: 'missing-source', reason: `来源图形缺失（${n.sources.map(s => getNode(doc, s) ? n.name : s).join('、')}）` };
  }
  const a = geomLookup(n.sources[0]);
  const b = geomLookup(n.sources[1]);
  const va = validateGeom(a, n.eps);
  const vb = validateGeom(b, n.eps);
  if (!va.ok || !vb.ok) {
    return { ok: false, code: 'invalid-source', reason: `来源拓扑无效：${(!va.ok ? va.errors[0] : vb.errors[0])}` };
  }
  let res;
  try {
    res = applyBoolean(pc, n.op, a, b, n.eps, { recompute: true });
  } catch (err) {
    return { ok: false, code: 'engine', reason: `布尔引擎异常：${err.message}` };
  }
  if (!res.ok) {
    const emptyish = /为空|空（|交集/.test(res.reason);
    return { ok: false, code: emptyish ? 'empty-result' : 'invalid-result', reason: res.reason, report: res.report };
  }
  const vout = validateGeom(res.geom, n.eps);
  if (!vout.ok) return { ok: false, code: 'invalid-result', reason: `结果拓扑无效：${vout.errors[0]}`, report: res.report };
  return { ok: true, geom: res.geom, report: res.report };
}

/** 一轮重算的稳定摘要哈希：包含每个计算节点的 id、结果哈希、以及失败信息。 */
function roundHash(entries, ok, failedId, failedReason, trigger) {
  let h = 0x811c9dc5;
  const str = JSON.stringify({
    trigger,
    ok,
    failedId: failedId || null,
    failedReason: failedReason || null,
    entries: entries.map(e => [e.id, e.before, e.after, e.op, e.eps]),
  });
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 在 doc 上执行一轮原子重算。
 * @param trigger {kind:'edit'|'create'|'sources'|'unfreeze', label}
 * @param seedIds 发生变化的节点 id（冻结/普通根节点也可作为种子）
 * @param opts.recomputeSeeds 中的种子节点不沿用旧几何，而是按派生公式重新计算
 *        （用于解冻：节点重新成为派生图形，冻结几何要被当前来源的结果替换）。
 * 成功：写入新几何并追加一条 ok 的 round；失败：几何全部还原，追加一条 failed 的 round。
 */
export function runRecompute(pc, doc, trigger, seedIds, opts = {}) {
  const recomputeSeeds = new Set(opts.recomputeSeeds || []);
  const order0 = affectedOrder(doc, seedIds);
  // 需要重算的种子（如解冻节点）加入计算序列并排在其下游之前：
  // 它的来源不是本轮受影响节点，顺序天然合法。
  const seedNodes = [...recomputeSeeds].map(id => getNode(doc, id)).filter(Boolean);
  const order = seedNodes.concat(order0);
  const entries = [];
  const working = new Map(); // id -> 本轮几何（种子先放当前几何）
  for (const id of seedIds) {
    const n = getNode(doc, id);
    if (n) working.set(id, n.geom);
  }
  for (const n of order) {
    entries.push({ id: n.id, name: n.name, op: n.op, eps: n.eps, before: geomHash(n.geom), after: null });
  }
  const lookup = id => working.has(id) ? working.get(id) : getNode(doc, id).geom;

  let failed = null;
  for (const n of order) {
    if (recomputeSeeds.has(n.id)) working.delete(n.id); // 强制走来源重算
    const r = computeNode(pc, doc, n, lookup);
    if (!r.ok) { failed = { node: n, ...r }; break; }
    working.set(n.id, r.geom);
    entries.find(e => e.id === n.id).after = geomHash(r.geom);
  }

  const round = {
    seq: doc.rounds.length ? doc.rounds[doc.rounds.length - 1].seq + 1 : 1,
    trigger: trigger.kind,
    label: trigger.label,
    seedIds: seedIds.slice(),
    order: order.map(n => n.id),
    entries: entries.map(e => ({ ...e })),
    ok: !failed,
    failedId: failed ? failed.node.id : null,
    failedName: failed ? failed.node.name : null,
    failedCode: failed ? failed.code : null,
    reason: failed ? failed.reason : null,
    rolledBack: !!failed,
  };
  round.hash = roundHash(entries, round.ok, round.failedId, round.reason, trigger.kind);

  if (failed) {
    // 原子回滚：本轮没有任何节点落盘（seed 几何由调用方在事务外写入，见 mutateGeometries）
    doc.rounds.push(round);
    if (doc.rounds.length > ROUNDS_LIMIT) doc.rounds.shift();
    return { ok: false, round, failed };
  }
  for (const n of order) n.geom = deepCopyGeom(working.get(n.id));
  doc.rounds.push(round);
  if (doc.rounds.length > ROUNDS_LIMIT) doc.rounds.shift();
  return { ok: true, round, entries: order.map(n => ({ node: n, geom: working.get(n.id) })) };
}

// ---------- 文档变更（全部原子） ----------

/**
 * 创建派生图形（一次布尔运算的持久结果）。
 * 新节点尚无任何入边，物理上不可能引入环；先在不入图的候选节点上试算，
 * 失败则不落任何状态（doc.seqCounter 也回退）。
 */
export function createDerived(pc, doc, { name, op, sourceIds: sids, eps, color }) {
  if (!OPS[op]) return { ok: false, reason: `未知运算 ${op}` };
  if (sids.length !== 2) return { ok: false, reason: '布尔派生图形必须恰好引用两个来源' };
  if (sids[0] === sids[1]) return { ok: false, reason: '两个来源必须是不同图形' };
  for (const sid of sids) {
    if (!getNode(doc, sid)) return { ok: false, reason: '来源图形缺失' };
  }
  const seq = doc.seqCounter + 1;
  const cand = {
    id: newId('derived'), seq,
    name, color, kind: 'derived', op, sources: sids.slice(), eps,
    geom: [], frozen: false,
  };
  // 试算（不落 doc）
  const trial = computeNode(pc, doc, cand, id => getNode(doc, id).geom);
  if (!trial.ok) return { ok: false, reason: trial.reason, code: trial.code };
  doc.seqCounter = seq;
  cand.geom = deepCopyGeom(trial.geom);
  doc.nodes.push(cand);
  const round = {
    seq: doc.rounds.length ? doc.rounds[doc.rounds.length - 1].seq + 1 : 1,
    trigger: 'create',
    label: `创建派生 ${name}（${OPS[op].symbol}，ε=${eps}）`,
    seedIds: [],
    order: [cand.id],
    entries: [{ id: cand.id, name, op, eps, before: null, after: geomHash(cand.geom) }],
    ok: true, failedId: null, failedName: null, failedCode: null, reason: null, rolledBack: false,
  };
  round.hash = roundHash(round.entries, true, null, null, 'create');
  doc.rounds.push(round);
  if (doc.rounds.length > ROUNDS_LIMIT) doc.rounds.shift();
  return { ok: true, node: cand, round };
}

/**
 * 修改已有派生图形的来源/运算/容差。会成环（例如把后代设为祖先的来源）时拒绝，状态不变。
 */
export function setDerivedConfig(pc, doc, id, { op, sourceIds: sids, eps }) {
  const n = getNode(doc, id);
  if (!n || n.kind !== 'derived') return { ok: false, reason: '目标不是派生图形' };
  const cyc = checkCycle(doc, id, sids);
  if (!cyc.ok) return { ok: false, reason: cyc.reason };
  const backup = JSON.parse(JSON.stringify({ op: n.op, sources: n.sources, eps: n.eps, geom: n.geom }));
  const roundsBefore = doc.rounds.length;
  const trialNode = { ...n, op, sources: sids.slice(), eps };
  const trial = computeNode(pc, doc, trialNode, sid => getNode(doc, sid).geom);
  if (!trial.ok) return { ok: false, reason: trial.reason, code: trial.code };
  n.op = op; n.sources = sids.slice(); n.eps = eps; n.geom = deepCopyGeom(trial.geom);
  // 自身配置变化 → 其全部下游重算（冻结边界截断）
  const result = runRecompute(pc, doc, { kind: 'sources', label: `改写 ${n.name} 的来源/运算` }, [id]);
  if (!result.ok) {
    // 原子回滚：恢复配置/几何，并丢弃本轮（失败 round 作为回滚记录保留在日志中）
    Object.assign(n, backup);
    doc.rounds = doc.rounds.slice(0, roundsBefore).concat([result.round]);
    return { ok: false, reason: result.failed.reason, round: result.round, failed: result.failed };
  }
  return { ok: true, node: n, round: result.round };
}

/**
 * 冻结派生图形：把它在当前几何上固化，降级为可独立编辑的普通图形，并形成新的依赖边界：
 *   - 入边（它的来源 → 它）不再传播：上游编辑不会重算它；
 *   - 出边（它 → 引用它的下游）仍保留并继续活动：编辑这个冻结图形本身会驱动其下游。
 * 冻结不触发重算。
 */
export function freezeNode(doc, id) {
  const n = getNode(doc, id);
  if (!n) return { ok: false, reason: '节点不存在' };
  if (n.kind !== 'derived') return { ok: false, reason: '只有派生图形可以冻结' };
  if (n.frozen) return { ok: false, reason: '该图形已冻结' };
  n.frozen = true;
  const round = {
    seq: doc.rounds.length ? doc.rounds[doc.rounds.length - 1].seq + 1 : 1,
    trigger: 'freeze',
    label: `冻结 ${n.name}（新依赖边界：上游变化不再传入）`,
    seedIds: [], order: [], entries: [],
    ok: true, failedId: null, failedName: null, failedCode: null, reason: null, rolledBack: false,
  };
  round.hash = roundHash([], true, null, null, 'freeze');
  doc.rounds.push(round);
  if (doc.rounds.length > ROUNDS_LIMIT) doc.rounds.shift();
  return { ok: true, node: n, round };
}

/** 解冻：恢复派生身份与活动出边，并按当前来源立即重算自身及下游（原子）。 */
export function unfreezeNode(pc, doc, id) {
  const n = getNode(doc, id);
  if (!n || n.kind !== 'derived') return { ok: false, reason: '目标不是冻结的派生图形' };
  if (!n.frozen) return { ok: false, reason: '该图形未冻结' };
  // 解冻前先确认活动图不会成环（冻结期间图结构可能已变化）
  const cyc = checkCycle(doc, id, n.sources);
  if (!cyc.ok) return { ok: false, reason: cyc.reason };
  n.frozen = false;
  const roundsBefore = doc.rounds.length;
  // 解冻节点自身先从当前来源重算（作为种子，但它不是已落盘的新值），再向下游传播。
  const result = runRecompute(pc, doc, { kind: 'unfreeze', label: `解冻 ${n.name} 并按来源重算` }, [id], { recomputeSeeds: [id] });
  if (!result.ok) {
    // runRecompute 不向节点落盘几何，冻结几何未被触碰；仅恢复 frozen 标志
    n.frozen = true;
    doc.rounds = doc.rounds.slice(0, roundsBefore).concat([result.round]);
    return { ok: false, reason: result.failed.reason, round: result.round, failed: result.failed };
  }
  return { ok: true, node: n, round: result.round };
}

/**
 * 编辑/变换根节点（普通图形或已冻结图形）的几何，然后原子重算活动下游。
 * changes: [{id, geom}]。任一来源或下游失败 → 所有几何（含 changes 本身）回滚。
 */
export function mutateGeometries(pc, doc, changes, triggerLabel) {
  for (const { id } of changes) {
    const n = getNode(doc, id);
    if (!n) return { ok: false, reason: `节点 ${id} 不存在` };
    if (isDerived(n)) return { ok: false, reason: `${n.name} 是未冻结的派生图形，几何只能随来源重算` };
  }
  const snapshot = deepCopyDoc(doc);
  const seedIds = changes.map(c => c.id);
  for (const c of changes) getNode(doc, c.id).geom = deepCopyGeom(c.geom);
  const result = runRecompute(pc, doc, { kind: 'edit', label: triggerLabel || '编辑来源图形' }, seedIds);
  if (!result.ok) {
    // 整轮回滚：恢复变更前整张依赖图与全部几何，仅保留失败轮日志
    doc.nodes = deepCopyDoc(snapshot).nodes;
    doc.seqCounter = snapshot.seqCounter;
    doc.rounds = snapshot.rounds.concat([result.round]);
    return { ok: false, reason: result.failed.reason, round: result.round, failed: result.failed };
  }
  return { ok: true, round: result.round };
}

/** 删除前的引用检查。返回该节点的直接依赖者。 */
export function deletionReferences(doc, id) {
  return directDependents(doc, id);
}

/**
 * 删除节点。
 * policy:
 *   'cancel'      —— 由 UI 决定不调用（这里提供以记录一条取消日志）；
 *   'cascade'     —— 删除节点 + 全部受影响后代（沿活动边；冻结边界截断）；
 *   'freeze-direct' —— 先把直接派生结果全部冻结成普通图形，再删除节点。
 * 直接删除无引用的根时无需 policy（传 null）。
 */
export function deleteNode(doc, id, policy) {
  const n = getNode(doc, id);
  if (!n) return { ok: false, reason: '节点不存在' };
  const refs = directDependents(doc, id);

  if (policy === 'cancel') {
    const round = {
      seq: doc.rounds.length ? doc.rounds[doc.rounds.length - 1].seq + 1 : 1,
      trigger: 'delete-cancel',
      label: `取消删除 ${n.name}（仍被 ${refs.length} 个直接结果引用）`,
      seedIds: [], order: [], entries: [],
      ok: true, failedId: null, failedName: null, failedCode: null, reason: null, rolledBack: false,
    };
    round.hash = roundHash([], true, null, null, 'delete-cancel');
    doc.rounds.push(round);
    return { ok: true, cancelled: true, round };
  }

  if (refs.length && policy !== 'cascade' && policy !== 'freeze-direct') {
    return { ok: false, reason: '该图形仍被派生结果引用，必须选择删除策略', references: refs.map(r => r.id) };
  }

  let toDelete = new Set([id]);
  const frozenNow = [];
  const detachToRoot = nid => {
    const x = getNode(doc, nid);
    if (!x) return;
    // "冻结成普通图形"：保留几何与名称，剥离派生身份（op/sources/eps），成为真正的根
    x.kind = 'root';
    delete x.op; delete x.sources; delete x.eps; delete x.frozen;
  };
  if (policy === 'cascade') {
    for (const d of descendants(doc, id)) toDelete.add(d.id);
  } else if (policy === 'freeze-direct') {
    for (const r of refs) {
      if (r.kind === 'derived' && !r.frozen) {
        r.frozen = true;
        frozenNow.push(r.id);
      }
    }
  }
  const removed = doc.nodes.filter(x => toDelete.has(x.id)).map(x => x.id);
  doc.nodes = doc.nodes.filter(x => !toDelete.has(x.id));
  // freeze-direct：刚冻结的直接结果在来源删除后降级为真正的普通图形（根）。
  // 已冻结的派生节点若还有别的来源，保留其冻结身份；仅当其某条边指向被删节点时整体剥离
  // （普通图形不应保存悬空来源）。
  for (const fid of frozenNow) {
    detachToRoot(fid);
  }
  for (const x of doc.nodes) {
    if (x.kind === 'derived' && x.frozen && x.sources && x.sources.some(s => toDelete.has(s))) {
      detachToRoot(x.id);
    }
  }
  const round = {
    seq: doc.rounds.length ? doc.rounds[doc.rounds.length - 1].seq + 1 : 1,
    trigger: 'delete',
    label: policy === 'cascade'
      ? `级联删除 ${n.name} 及 ${removed.length - 1} 个后代`
      : policy === 'freeze-direct'
        ? `冻结直接结果后删除 ${n.name}（${frozenNow.length} 个结果转为普通图形）`
        : `删除 ${n.name}`,
    seedIds: [], order: [], entries: [],
    ok: true, failedId: null, failedName: null, failedCode: null, reason: null, rolledBack: false,
    removed, frozenNow, policy: policy || null,
  };
  round.hash = roundHash([], true, null, null, round.trigger + JSON.stringify(removed));
  doc.rounds.push(round);
  if (doc.rounds.length > ROUNDS_LIMIT) doc.rounds.shift();
  return { ok: true, round, removed, frozenNow };
}

/** 人类可读的来源/后代描述（详情面板用）。 */
export function describeSources(doc, n) {
  if (n.kind !== 'derived' || n.frozen) return null;
  return {
    op: n.op, eps: n.eps,
    nodes: n.sources.map(id => getNode(doc, id)).filter(Boolean),
    missing: n.sources.filter(id => !getNode(doc, id)),
  };
}

export { OPS };
