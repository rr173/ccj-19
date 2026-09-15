// history.js — 可检查历史：每个条目保存完整场景快照（几何拓扑，不只是位置），
// 支持撤销/重做/任意跳转；可序列化到 localStorage，重载后逐条重算哈希校验一致性。

import { geomHash } from './model.js';

export const HISTORY_VERSION = 1;
export const HISTORY_LIMIT = 200;

/**
 * 场景快照 = { shapes: [{id, name, color, geom}], selected: [id...] }
 * 快照在入栈前深拷贝，出栈恢复时也深拷贝，保证历史不被后续编辑污染。
 */
export function createHistory() {
  return { entries: [], index: -1 };
}

function deepCopySnapshot(snap) {
  return {
    shapes: snap.shapes.map(s => ({
      id: s.id, name: s.name, color: s.color,
      geom: s.geom.map(poly => poly.map(ring => ring.map(p => [p[0], p[1]]))),
    })),
    selected: (snap.selected || []).slice(),
  };
}

/** 场景哈希：所有形状（按 id 排序）的几何哈希联合 */
export function sceneHash(snapshot) {
  const ids = snapshot.shapes.map(s => s.id).sort();
  const parts = ids.map(id => {
    const s = snapshot.shapes.find(x => x.id === id);
    return `${s.name}:${geomHash(s.geom)}`;
  });
  // 简单联合哈希
  let h = 0x811c9dc5;
  const str = parts.join('|');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 推入新条目。若当前不在栈顶（撤销后产生新分支），丢弃重做分支。
 * entry: {label, detail, validation, report?}
 */
export function pushEntry(history, snapshot, meta) {
  // 截断重做分支
  history.entries.length = history.index + 1;
  const snap = deepCopySnapshot(snapshot);
  const entry = {
    seq: history.entries.length ? history.entries[history.entries.length - 1].seq + 1 : 0,
    label: meta.label,
    detail: meta.detail || '',
    validation: meta.validation || null, // 校验摘要文本
    report: meta.report || null,          // 布尔操作完整判定报告
    hash: sceneHash(snap),
    snapshot: snap,
  };
  history.entries.push(entry);
  if (history.entries.length > HISTORY_LIMIT) {
    history.entries.shift();
  }
  history.index = history.entries.length - 1;
  return entry;
}

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

/** 跳转到任意历史位置（可检查历史：点击条目即恢复该状态的完整拓扑） */
export function jumpTo(h, i) {
  if (i < 0 || i >= h.entries.length) return null;
  h.index = i;
  return deepCopySnapshot(h.entries[i].snapshot);
}

export function currentEntry(h) {
  return h.index >= 0 ? h.entries[h.index] : null;
}

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
