// history.js — 可检查历史：每个条目保存**整张文档**的完整快照
// （节点几何、依赖边、运算类型、容差、冻结状态、重算日志 rounds），
// 支持撤销/重做/任意跳转；可序列化到 localStorage，重载后重算快照哈希校验一致性。
//
// 快照哈希覆盖依赖结构与重算日志摘要，因此刷新页面后以下内容都能被校验：
// 依赖边、冻结状态、几何结果、重算日志摘要与其哈希。

import { geomHash } from './model.js';

export const HISTORY_VERSION = 2;
export const HISTORY_LIMIT = 200;

/** 文档快照深拷贝（几何 + 图结构 + rounds），JSON 可序列化数据全部安全。 */
export function deepCopySnapshot(snap) {
  return JSON.parse(JSON.stringify(snap));
}

/**
 * 场景快照 = { doc: {nodes, seqCounter, rounds}, selected: [id...] }
 */
export function snapshotFromDoc(doc, selected) {
  return { doc: deepCopyDocLight(doc), selected: (selected || []).slice() };
}

function deepCopyDocLight(doc) {
  return {
    nodes: doc.nodes.map(n => ({ ...n, geom: n.geom.map(p => p.map(r => r.map(pt => [pt[0], pt[1]]))) })),
    seqCounter: doc.seqCounter,
    rounds: deepCopyRounds(doc.rounds || []),
  };
}

function deepCopyRounds(rounds) {
  return rounds.map(r => ({ ...r, entries: r.entries.map(e => ({ ...e })) }));
}

/**
 * 快照哈希：几何（按 id 排序）+ 依赖结构（边/运算/容差/冻结）+ 最近一轮重算摘要。
 */
export function sceneHash(snapshot) {
  const doc = snapshot.doc;
  const nodes = doc.nodes.slice().sort((a, b) => (a.seq - b.seq) || (a.id < b.id ? -1 : 1));
  const parts = nodes.map(n => {
    const dep = n.kind === 'derived'
      ? `:${n.op}:${(n.sources || []).join(',')}:${n.eps}:${n.frozen ? 1 : 0}`
      : ':root';
    return `${n.id}${dep}:${geomHash(n.geom)}`;
  });
  const lastRound = doc.rounds && doc.rounds.length ? doc.rounds[doc.rounds.length - 1] : null;
  const roundPart = lastRound
    ? `#round=${lastRound.seq}:${lastRound.hash}:${lastRound.ok ? 1 : 0}:${lastRound.failedId || ''}`
    : '#round=none';
  const str = parts.join('|') + roundPart;
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 推入新条目。若当前不在栈顶（撤销后产生新分支），丢弃重做分支。
 * meta: {label, detail, validation?, report?}
 */
export function pushEntry(history, snapshot, meta) {
  history.entries.length = history.index + 1; // 截断重做分支
  const snap = deepCopySnapshot(snapshot);
  const entry = {
    seq: history.entries.length ? history.entries[history.entries.length - 1].seq + 1 : 0,
    label: meta.label,
    detail: meta.detail || '',
    validation: meta.validation || null,
    report: meta.report || null,
    hash: sceneHash(snap),
    snapshot: snap,
  };
  history.entries.push(entry);
  if (history.entries.length > HISTORY_LIMIT) history.entries.shift();
  history.index = history.entries.length - 1;
  return entry;
}

export function createHistory() { return { entries: [], index: -1 }; }
export function canUndo(h) { return h.index > 0; }
export function canRedo(h) { return h.index >= 0 && h.index < h.entries.length - 1; }

export function undo(h) {
  if (!canUndo(h)) return null;
  h.index--;
  return deepCopySnapshot(h.entries[h.index].snapshot);
}

export function redo(h) {
  if (!canRedo(h)) return null;
  h.index++;
  return deepCopySnapshot(h.entries[h.index].snapshot);
}

/** 跳转到任意历史位置（可检查历史：点击条目即恢复该状态的完整文档） */
export function jumpTo(h, i) {
  if (i < 0 || i >= h.entries.length) return null;
  h.index = i;
  return deepCopySnapshot(h.entries[i].snapshot);
}

export function currentEntry(h) { return h.index >= 0 ? h.entries[h.index] : null; }

// ---------- 持久化 ----------

export function serializeHistory(h, eps) {
  return JSON.stringify({ version: HISTORY_VERSION, eps, index: h.index, entries: h.entries });
}

/**
 * 反序列化并逐条校验：重算每个快照的场景哈希，与存储值比对。
 * 返回 {history, eps, mismatches[]} — mismatches 非空表示存储被篡改或损坏。
 */
export function deserializeHistory(json) {
  const data = JSON.parse(json);
  if (!data || data.version !== HISTORY_VERSION || !Array.isArray(data.entries)) {
    throw new Error('历史数据版本不兼容或已损坏');
  }
  const history = { entries: data.entries, index: data.index };
  const mismatches = [];
  history.entries.forEach((e, i) => {
    const recomputed = sceneHash(e.snapshot);
    if (recomputed !== e.hash) mismatches.push({ seq: e.seq, stored: e.hash, recomputed });
    e.seq = i; // 重排 seq，保持单调
  });
  if (history.index < 0 || history.index >= history.entries.length) {
    history.index = history.entries.length - 1;
  }
  return { history, eps: data.eps, mismatches };
}
