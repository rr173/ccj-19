// storage.js — 浏览器持久化适配器。
// 会话（含决议/批注/固定关系）与只读快照分开存：
// 重新载入后同一对文件会命中既有审阅实例，旧签署快照始终可查看。

const SESSION_KEY = 'drawing-diff:sessions:v1';
const SNAPSHOT_KEY = 'drawing-diff:snapshots:v1';
const DRAFT_KEY = 'drawing-diff:drafts:v1'; // 最近导入的原始图纸（按 pairId 归档，用于刷新后复活会话）

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}');
  } catch {
    return {};
  }
}
function write(key, obj) {
  localStorage.setItem(key, JSON.stringify(obj));
}

export const localStorageAdapter = {
  loadAll() {
    const sessions = Object.values(read(SESSION_KEY));
    const snapshots = Object.values(read(SNAPSHOT_KEY));
    return { sessions, snapshots };
  },
  save(session) {
    const all = read(SESSION_KEY);
    // 大对象（配准后的图元）不入库，载入时按需重算；只保留身份/状态/决议
    all[session.pairId] = serializeSession(session);
    write(SESSION_KEY, all);
  },
  remove(pairId) {
    const all = read(SESSION_KEY);
    delete all[pairId];
    write(SESSION_KEY, all);
  },
  saveSnapshot(snapshot) {
    const all = read(SNAPSHOT_KEY);
    all[snapshot.snapshotId] = snapshot;
    write(SNAPSHOT_KEY, all);
  },
};

/** 保存最近导入的一对原始图纸，供刷新后复活会话。 */
export function saveDraft(pairId, baseRaw, candRaw) {
  const all = read(DRAFT_KEY);
  all[pairId] = { base: baseRaw, cand: candRaw };
  // 只保留最近 10 对
  const keys = Object.keys(all);
  if (keys.length > 10) {
    for (const k of keys.slice(0, keys.length - 10)) delete all[k];
  }
  write(DRAFT_KEY, all);
}

export function loadDraft(pairId) {
  return read(DRAFT_KEY)[pairId] || null;
}

export function allDrafts() {
  return read(DRAFT_KEY);
}

function serializeSession(s) {
  return {
    sessionId: s.sessionId,
    pairId: s.pairId,
    createdAt: s.createdAt,
    status: s.status,
    inputs: s.inputs,
    tolerance: s.tolerance,
    regParams: s.regParams,
    pinned: s.pinned,
    decisions: s.decisions,
    notes: s.notes,
    signatures: s.signatures,
    signedSnapshotId: s.signedSnapshotId,
    invalidatedAt: s.invalidatedAt,
    invalidReason: s.invalidReason,
    invalidDetail: s.invalidDetail,
    supersededBy: s.supersededBy,
  };
}

export function clearStorage() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SNAPSHOT_KEY);
}
