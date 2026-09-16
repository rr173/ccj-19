// session.js — 审阅会话：配准/匹配/差异的状态机与人工工作流。
//
// 职责：
//   · 导入去重：同一对输入指纹只保留一个审阅实例（重复请求幂等返回既有会话）；
//   · 人工消歧与固定：固定项在重算时保持对应，仅其余部分参与重新匹配；
//   · 重算冲突回滚：固定关系造成一对多 / 类型不兼容 / 超过最大偏移时，
//     本次重算全部撤回，旧结果保留，并给出矛盾说明；
//   · 决议 accept/reject/defer 与批注：按稳定 diffKey 绑定，重算/重载不丢失；
//   · 签署：所有差异均有结论（无暂缓、无未决、无待消歧）后生成只读快照；
//   · 失效追溯：原稿/配准参数/公差变动后旧签署失效，但快照仍保留可查看。

import { fingerprint, fnv1a64, canonical } from './hash.js';
import { parseDrawing } from './entities.js';
import { estimateRegistration, transformDrawing } from './registration.js';
import { buildCorrespondence } from './matching.js';
import { buildDiffs, DEFAULT_TOLERANCE } from './diff.js';
import { dist } from './geometry.js';

/** @returns {pairId} 输入对指纹（与两稿解析后的顺序无关指纹一致） */
export function pairFingerprint(baseDraw, candDraw) {
  return fnv1a64(`${baseDraw.fingerprint}|${candDraw.fingerprint}`);
}

export function defaultTolerance() {
  return { ...DEFAULT_TOLERANCE };
}

/**
 * 内存注册表。浏览器侧可注入 localStorage 持久化适配器：
 *   adapter = { loadAll(), save(session), remove(id) }
 */
export class SessionRegistry {
  constructor(adapter = null) {
    this.adapter = adapter;
    /** @type {Map<string, object>} pairId -> 活动会话（含计算结果） */
    this.index = new Map();
    /** @type {Map<string, object>} pairId -> 持久化存根（无结果，等待 restoreSession 重建） */
    this.storedIndex = new Map();
    /** @type {Map<string, object>} snapshotId -> 只读快照 */
    this.snapshots = new Map();
    if (adapter) this._hydrate();
  }

  _hydrate() {
    const all = this.adapter.loadAll();
    for (const s of all.sessions || []) {
      this.storedIndex.set(s.pairId, s);
      // 已签署（未失效）的会话先占位：复活前重复导入也不得新建第二份
      if (s.status === 'signed') this.index.set(s.pairId, s);
    }
    for (const snap of all.snapshots || []) {
      this.snapshots.set(snap.snapshotId, snap);
    }
  }

  /** 同一对文件的重复导入：返回既有实例而不是新建第二份并行审阅。 */
  findPair(pairId) {
    return this.index.get(pairId) || null;
  }

  findStored(pairId) {
    return this.storedIndex.get(pairId) || null;
  }

  put(session) {
    this.index.set(session.pairId, session);
    session._registry = this;
    if (this.adapter) this.adapter.save(session);
  }

  deletePair(pairId) {
    this.index.delete(pairId);
    if (this.adapter) this.adapter.remove(pairId);
  }

  putSnapshot(snap) {
    this.snapshots.set(snap.snapshotId, snap);
    if (this.adapter) this.adapter.saveSnapshot(snap);
  }

  listSnapshots() {
    return [...this.snapshots.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getSnapshot(id) {
    return this.snapshots.get(id) || null;
  }
}

let seq = 0;
function newId(prefix) {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 导入一对图纸（幂等）。
 * @param rawBase/rawCand 原始 JSON（也可传已 parse 的图纸）
 * @returns { session, reused:boolean }
 */
export function importPair(registry, rawBase, rawCand, options = {}) {
  const base = rawBase.fingerprint ? rawBase : parseDrawing(rawBase, 'base');
  const cand = rawCand.fingerprint ? rawCand : parseDrawing(rawCand, 'cand');
  const pairId = pairFingerprint(base, cand);
  const existing = registry.findPair(pairId);
  if (existing && existing.result) return { session: existing, reused: true };

  // 刷新/重载入场景：持久化存根 → 重建并重放固定/决议，保持同一审阅实例
  const stored = registry.findStored(pairId);
  if (stored && !options.ignoreStored) {
    const restored = restoreSession(registry, stored, base, cand);
    if (restored.ok) return { session: restored.session, reused: true, restored: true };
  }

  const session = {
    sessionId: newId('rev'),
    pairId,
    createdAt: new Date().toISOString(),
    status: 'open', // open | signed | invalidated | superseded
    inputs: {
      base: { name: base.name, fingerprint: base.fingerprint, anchorCount: base.anchors.length },
      cand: { name: cand.name, fingerprint: cand.fingerprint, anchorCount: cand.anchors.length },
    },
    tolerance: { ...defaultTolerance(), ...(options.tolerance || {}) },
    regParams: options.regParams || null, // null=按锚点自动
    pinned: {},   // baseStableId -> { candStableId|null, at }
    decisions: {}, // diffKey -> { verdict:'accepted'|'rejected'|'deferred', note, at, by }
    notes: {},     // 独立批注（也可不带决议直接批注）
    result: null,
    signatures: [], // 失效的旧签署只保留摘要，完整内容见 snapshots
    supersededBy: null,
  };

  recompute(session, base, cand, { initial: true });
  registry.put(session);
  return { session, reused: false };
}

/** 替换候选稿：另立新会话，旧签署立即失效，快照仍可追溯。 */
export function replaceCandidate(registry, session, rawBase, rawCandNext) {
  const base = rawBase.fingerprint ? rawBase : parseDrawing(rawBase, 'base');
  const cand = rawCandNext.fingerprint ? rawCandNext : parseDrawing(rawCandNext, 'cand');
  invalidate(session, 'candidate-replaced', `候选稿已替换为「${cand.name}」，旧签署失效（快照保留可查）`);
  session.status = 'superseded';
  session.supersededBy = 'pending';
  registry.put(session);

  const { session: next } = importPair(registry, base, cand, {
    tolerance: session.tolerance,
    regParams: session.regParams,
  });
  session.supersededBy = next.sessionId;
  registry.put(session);
  return { session: next, previous: session };
}

/** 执行配准+匹配+差异，结果写入 session.result。初始计算不检查冲突。 */
function runPipeline(session, base, cand, params) {
  const reg = estimateRegistration(base, cand, params || {});
  const regCand = transformDrawing(cand, reg.transform);
  const pinned = new Map(Object.entries(session.pinned).map(([k, v]) => [k, { candStableId: v.candStableId }]));
  const corr = buildCorrespondence(base.entities, regCand.entities, pinned, {
    tolerance: session.tolerance.positionTolerance,
  });
  const built = buildDiffs(corr, session.tolerance);
  return {
    reg,
    transformedCand: regCand,
    corr,
    diffs: built.diffs,
    pending: built.pending,
    stats: built.stats,
    computedAt: new Date().toISOString(),
  };
}

/**
 * 调整配准参数后重算。人工固定项保持不变，仅其余部分重新匹配；
 * 固定关系若导致 一对多 / 类型不兼容 / 超过最大偏移，整次重算撤回。
 *
 * @returns { ok:true, result } | { ok:false, conflict:{code,message,violations:[]} }
 *   失败时 session.result 保持为上一次结果不变。
 */
export function recompute(session, base, cand, opts = {}) {
  const params = session.regParams || {};

  if (!opts.initial) {
    const violations = validatePins(session, base, cand, params);
    if (violations.length) {
      return {
        ok: false,
        conflict: {
          code: 'pin-conflict',
          message: '人工固定关系与当前配准存在矛盾，本次重算已全部撤回：' +
            violations.map((v) => v.message).join('；'),
          violations,
        },
      };
    }
  }

  const result = runPipeline(session, base, cand, params);
  session.result = result;
  reconcileDecisions(session);
  if (!opts.initial && session.status === 'signed') {
    invalidate(session, 'registration-changed', '配准参数调整，旧签署自动失效（快照保留可查）');
  }
  if (session._registry) session._registry.put(session);
  return { ok: true, result };
}

/** 固定关系矛盾检查（按拟用配准把候选搬到基线系后判定）。 */
function validatePins(session, base, cand, params) {
  const violations = [];
  const reg = estimateRegistration(base, cand, params || {});
  const regCand = transformDrawing(cand, reg.transform);
  const baseById = new Map(base.entities.map((e) => [e.stableId, e]));
  const candById = new Map(regCand.entities.map((e) => [e.stableId, e]));
  const candOwners = new Map(); // candStableId -> [baseStableId…]

  for (const [bid, dec] of Object.entries(session.pinned)) {
    const b = baseById.get(bid);
    if (!b) {
      violations.push({ code: 'missing-base', baseStableId: bid,
        message: `固定项引用的基线图元 ${bid} 在原稿中已不存在` });
      continue;
    }
    if (dec.candStableId == null) continue; // 声明无对应：无几何约束
    const c = candById.get(dec.candStableId);
    if (!c) {
      violations.push({ code: 'missing-cand', baseStableId: bid, candStableId: dec.candStableId,
        message: `固定项引用的候选图元 ${dec.candStableId} 在候选稿中已不存在` });
      continue;
    }
    if (b.kind !== c.kind) {
      violations.push({ code: 'type-incompatible', baseStableId: bid, candStableId: c.stableId,
        message: `固定项类型不兼容（${b.kind} ↔ ${c.kind}）` });
    }
    const d = dist(b.features.centroid, c.features.centroid);
    if (d > session.tolerance.maxOffset) {
      violations.push({ code: 'max-offset', baseStableId: bid, candStableId: c.stableId,
        offset: d, maxOffset: session.tolerance.maxOffset,
        message: `固定项偏移 ${d.toFixed(2)} 超过最大允许偏移 ${session.tolerance.maxOffset}` });
    }
    if (!candOwners.has(dec.candStableId)) candOwners.set(dec.candStableId, []);
    candOwners.get(dec.candStableId).push(bid);
  }
  for (const [cid, owners] of candOwners) {
    if (owners.length > 1) {
      violations.push({ code: 'one-to-many', candStableId: cid, owners,
        message: `候选图元 ${cid} 被 ${owners.length} 个基线图元固定（一对多）` });
    }
  }
  return violations;
}

/**
 * 人工消歧 / 改配 / 声明无对应。
 * @param candStableId string（配对）| null（声明无对应项）
 */
export function pinPair(session, base, cand, baseStableId, candStableId) {
  const b = base.entities.find((e) => e.stableId === baseStableId);
  if (!b) return { ok: false, reason: '基线图元不存在' };
  if (candStableId != null) {
    const c = cand.entities.find((e) => e.stableId === candStableId);
    if (!c) return { ok: false, reason: '候选图元不存在' };
    if (c.kind !== b.kind) return { ok: false, reason: '类型不兼容，不能配对' };
    // 一对多：同一候选已被别的基线固定
    for (const [bid, dec] of Object.entries(session.pinned)) {
      if (bid !== baseStableId && dec.candStableId === candStableId) {
        return { ok: false, reason: `该候选已固定给基线图元 ${bid}，不能一对多` };
      }
    }
  }
  session.pinned[baseStableId] = { candStableId, at: new Date().toISOString() };
  invalidateIfSigned(session, 'pin-changed', '人工对应关系调整，旧签署自动失效');
  return recompute(session, base, cand, {});
}

/** 取消人工固定，恢复自动匹配。 */
export function unpinPair(session, base, cand, baseStableId) {
  delete session.pinned[baseStableId];
  invalidateIfSigned(session, 'pin-changed', '人工对应关系调整，旧签署自动失效');
  return recompute(session, base, cand, {});
}

/** 调整配准参数（θ°/scale/锚点对/是否允许镜像），触发重算。 */
export function updateRegistration(session, base, cand, regParams) {
  const previousParams = session.regParams;
  session.regParams = { ...(session.regParams || {}), ...regParams };
  // 固定冲突 → 撤回：新参数不落，旧结果与旧参数保持自洽
  const violations = validatePins(session, base, cand, session.regParams || {});
  if (violations.length) {
    session.regParams = previousParams;
    return {
      ok: false,
      conflict: {
        code: 'pin-conflict',
        message: '新配准参数与人工固定关系矛盾，本次重算已全部撤回（参数未生效）：' +
          violations.map((v) => v.message).join('；'),
        violations,
      },
    };
  }
  invalidateIfSigned(session, 'registration-changed', '配准参数调整，旧签署自动失效');
  return recompute(session, base, cand, {});
}

/** 调整公差：立即重算并使旧签署失效。 */
export function updateTolerance(session, base, cand, patch) {
  session.tolerance = { ...session.tolerance, ...patch };
  invalidateIfSigned(session, 'tolerance-changed', '公差调整，旧签署自动失效');
  return recompute(session, base, cand, {});
}

/** 差异决议。 */
export function decide(session, diffKey, verdict, { note = '', by = '审阅人' } = {}) {
  if (!['accepted', 'rejected', 'deferred'].includes(verdict)) {
    return { ok: false, reason: '结论必须是 accepted/rejected/deferred' };
  }
  session.decisions[diffKey] = { verdict, note, by, at: new Date().toISOString() };
  return { ok: true };
}

/** 批注（可与决议并存，按稳定身份绑定）。 */
export function annotate(session, diffKey, note) {
  session.notes[diffKey] = { note, at: new Date().toISOString() };
}

/** 清理已不存在的差异决议，保留仍然存在的（按 diffKey 稳定匹配）。 */
function reconcileDecisions(session) {
  const keys = new Set(session.result.diffs.map((d) => d.key));
  for (const k of Object.keys(session.decisions)) {
    if (!keys.has(k)) {
      session.orphanedDecisions = session.orphanedDecisions || {};
      session.orphanedDecisions[k] = session.decisions[k]; // 保留可追溯
      delete session.decisions[k];
    }
  }
  for (const k of Object.keys(session.notes)) {
    if (!keys.has(k)) {
      session.orphanedNotes = session.orphanedNotes || {};
      session.orphanedNotes[k] = session.notes[k];
      delete session.notes[k];
    }
  }
}

/** 签署前置检查：每项差异有结论、无暂缓、无待消歧。 */
export function signingBlockers(session) {
  const blockers = [];
  if (session.result.pending.length) {
    blockers.push({ code: 'pending-disambiguation', count: session.result.pending.length,
      message: `尚有 ${session.result.pending.length} 处相似图元待人工消歧` });
  }
  const deferred = [], undecided = [];
  for (const d of session.result.diffs) {
    const v = session.decisions[d.key]?.verdict;
    if (v === 'deferred') deferred.push(d.key);
    else if (!v) undecided.push(d.key);
  }
  if (undecided.length) blockers.push({ code: 'undecided', count: undecided.length,
    message: `尚有 ${undecided.length} 项差异未给结论` });
  if (deferred.length) blockers.push({ code: 'deferred', count: deferred.length,
    message: `尚有 ${deferred.length} 项差异处于暂缓状态，禁止签署` });
  return blockers;
}

/** 签署：冻结只读快照（Object.freeze 深冻结）。 */
export function sign(session, { by = '审阅人' } = {}) {
  const blockers = signingBlockers(session);
  if (blockers.length) return { ok: false, blockers };

  const payload = {
    schema: 'dwg2d-diff-review/1',
    sessionId: session.sessionId,
    pairId: session.pairId,
    signedAt: new Date().toISOString(),
    by,
    inputs: session.inputs,
    registration: {
      method: session.result.reg.method,
      params: session.result.reg.params,
      rms: session.result.reg.rms,
      anchorResiduals: session.result.reg.anchorResiduals,
    },
    tolerance: session.tolerance,
    pinned: Object.entries(session.pinned).map(([baseStableId, v]) => ({
      baseStableId, candStableId: v.candStableId, pinnedAt: v.at,
    })),
    correspondence: {
      pairCount: session.result.corr.pairs.length,
      pairs: session.result.corr.pairs.map((p) => ({
        base: p.base.stableId, cand: p.cand.stableId, pinned: !!p.pinned, confidence: p.score,
      })),
      topologyGroups: session.result.corr.topologyGroups.length,
    },
    diffs: session.result.diffs.map((d) => ({
      key: d.key,
      kind: d.kind,
      changes: d.changes,
      entityKind: d.entityKind,
      decision: session.decisions[d.key] || null,
      note: session.notes[d.key]?.note || null,
      metrics: d.metrics ? stripEntities(d.metrics) : null,
    })),
    stats: session.result.stats,
  };
  const snapshotId = 'snap_' + fingerprint(payload);
  const snapshot = deepFreeze({ snapshotId, ...payload, readOnly: true });

  session.status = 'signed';
  session.signedSnapshotId = snapshotId;
  session.signatures.push({ snapshotId, signedAt: payload.signedAt, by });
  if (session._registry) {
    session._registry.putSnapshot(snapshot);
    session._registry.put(session);
  }
  return { ok: true, snapshotId, snapshot, blockers: [] };
}

function stripEntities(m) {
  // 指标内只有数值，防御性剔除任何对象引用
  return JSON.parse(JSON.stringify(m));
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) deepFreeze(obj[k]);
    Object.freeze(obj);
  }
  return obj;
}

export function invalidate(session, reason, detail) {
  if (session.status === 'signed') {
    session.invalidatedAt = new Date().toISOString();
    session.invalidReason = reason;
    session.invalidDetail = detail;
  }
  session.status = 'invalidated';
}

function invalidateIfSigned(session, reason, detail) {
  if (session.status === 'signed') invalidate(session, reason, detail);
}

/** 便捷封装：创建+注册（测试/UI 共用）。 */
export function createReview(registry, rawBase, rawCand, options) {
  return importPair(registry, rawBase, rawCand, options);
}

/**
 * 复活持久化的会话（刷新/重载入后）：用同一对图纸重建计算结果，
 * 重放人工固定、决议与批注；恢复签署/失效状态。
 * @param stored serializeSession 的产物
 */
export function restoreSession(registry, stored, base, cand) {
  const pairId = pairFingerprint(base, cand);
  if (pairId !== stored.pairId) return { ok: false, reason: '输入指纹与归档会话不一致' };

  // 若活注册表已有同 pair 实例（importPair 幂等路径），直接返回
  const existing = registry.findPair(pairId);
  if (existing && existing.result) return { ok: true, session: existing, restored: false };

  const session = {
    sessionId: stored.sessionId,
    pairId: stored.pairId,
    createdAt: stored.createdAt,
    status: 'open',
    inputs: stored.inputs,
    tolerance: stored.tolerance || defaultTolerance(),
    regParams: stored.regParams || null,
    pinned: stored.pinned || {},
    decisions: stored.decisions || {},
    notes: stored.notes || {},
    result: null,
    signatures: stored.signatures || [],
    signedSnapshotId: stored.signedSnapshotId,
    supersededBy: stored.supersededBy,
  };
  recompute(session, base, cand, { initial: true });
  reconcileDecisions(session);

  // 状态恢复：已失效/被取代保持原态；曾签署且当前输入未变 → 标记已签署
  if (stored.status === 'superseded') {
    session.status = 'superseded';
  } else if (stored.status === 'invalidated') {
    session.status = 'invalidated';
    session.invalidReason = stored.invalidReason;
    session.invalidDetail = stored.invalidDetail;
    session.invalidatedAt = stored.invalidatedAt;
  } else if (stored.status === 'signed' && stored.signedSnapshotId) {
    session.status = 'signed';
  }
  registry.put(session);
  return { ok: true, session, restored: true };
}

/** 决策统计（侧栏/签署页）。 */
export function decisionSummary(session) {
  const out = { accepted: 0, rejected: 0, deferred: 0, undecided: 0 };
  for (const d of session.result.diffs) {
    const v = session.decisions[d.key]?.verdict;
    if (v === 'accepted') out.accepted++;
    else if (v === 'rejected') out.rejected++;
    else if (v === 'deferred') out.deferred++;
    else out.undecided++;
  }
  out.pending = session.result.pending.length;
  out.total = session.result.diffs.length;
  return out;
}

export { DEFAULT_TOLERANCE, canonical, fingerprint };
