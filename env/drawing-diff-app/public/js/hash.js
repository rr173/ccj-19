// hash.js — 确定性指纹：FNV-1a 64 位 + 键名排序的规范化 JSON。
// 指纹用于输入去重（同一对文件不生成两份并行审阅）与快照只读归档；
// 规范化时数组保序、对象按键名排序，数值统一保留 9 位小数以消除无关的浮点书写差异。

const FNV_PRIME = 0x100000001b3n;
const FNV_OFFSET = 0xcbf29ce484222325n;
const MASK64 = (1n << 64n) - 1n;

export function fnv1a64(str) {
  let h = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, '0');
}

function roundNum(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return v;
  if (Number.isInteger(v)) return v;
  return Math.round(v * 1e9) / 1e9;
}

/** 规范化序列化：对象键排序，数组保序（数组保序才能表达轮廓的顶点次序）。 */
export function canonical(value, opts = {}) {
  const round = opts.round !== false;
  if (value === null || typeof value !== 'object') {
    if (round && typeof value === 'number') return JSON.stringify(roundNum(value));
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => canonical(v, opts));
    return `[${items.join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k], opts)}`);
  return `{${parts.join(',')}}`;
}

/** 内容指纹（十六进制字符串）。opts.round=false 时不做数值舍入。 */
export function fingerprint(value, opts) {
  return fnv1a64(canonical(value, opts));
}
