// app.js — 审阅工作流主控：导入 → 配准 → 对应/消歧 → 差异决议 → 签署 → 快照追溯。
import { parseDrawing } from './entities.js';
import { SessionRegistry, createReview, pinPair, unpinPair, updateRegistration,
  updateTolerance, decide, annotate, sign, signingBlockers, replaceCandidate,
  decisionSummary, pairFingerprint } from './session.js';
import { estimateRegistration, transformDrawing } from './registration.js';
import { KIND_CN, formatMetricRows } from './diff.js';
import { OverlayView, KIND_STYLE } from './render.js';
import { localStorageAdapter, clearStorage, saveDraft, loadDraft } from './storage.js';
import { DEMOS } from './fixtures.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const registry = new SessionRegistry(localStorageAdapter);
const view = new OverlayView($('#canvas'));

const state = {
  baseRaw: null,
  candRaw: null,
  base: null,
  cand: null,
  session: null,
  filter: 'all',
  selected: null,
};

// ---------- 导入 ----------
async function readJsonFile(file) {
  const text = await file.text();
  return JSON.parse(text);
}

async function handleImport(which, file) {
  const raw = await readJsonFile(file);
  if (which === 'base') state.baseRaw = raw;
  else state.candRaw = raw;
  $(`#${which}-file-name`).textContent = `${raw.name || file.name}（${raw.entities?.length || 0} 图元）`;
  tryStart();
}

function loadDemo(key) {
  const { base, cand } = DEMOS[key].build();
  state.baseRaw = base;
  state.candRaw = cand;
  $('#base-file-name').textContent = `${base.name}（${base.entities.length} 图元）`;
  $('#cand-file-name').textContent = `${cand.name}（${cand.entities.length} 图元）`;
  tryStart();
}

function tryStart() {
  if (!state.baseRaw || !state.candRaw) return;
  state.base = parseDrawing(state.baseRaw, 'base');
  state.cand = parseDrawing(state.candRaw, 'cand');
  const { session, reused, restored } = createReview(registry, state.base, state.cand);
  saveDraft(session.pairId, state.baseRaw, state.candRaw);
  state.session = session;
  $('#base-file-name').textContent = `${state.base.name}（${state.base.entities.length} 图元）`;
  $('#cand-file-name').textContent = `${state.cand.name}（${state.cand.entities.length} 图元）`;
  refreshView();
  flash(restored ? '已从浏览器存储恢复上次审阅（固定/决议/批注均保留）。'
    : reused ? '该对文件已有审阅实例，已打开既有审阅（重复导入不另建实例）。'
      : '审阅已创建。');
}

function refreshView() {
  const s = state.session;
  if (!s) return;
  // 当前配准下的候选变换稿（视图与选择面板共用）
  const reg = estimateRegistration(state.base, state.cand, s.regParams || {});
  const candT = transformDrawing(state.cand, reg.transform);
  view.setData(state.base, candT, s);
  renderHeader(s, reg);
  renderRegPanel(s, reg);
  renderDiffList(s);
  renderPending(s);
  renderSignPanel(s);
  renderSnapshotList();
}

// ---------- 顶部状态条 ----------
function renderHeader(s, reg) {
  const sum = decisionSummary(s);
  const statusMap = {
    open: ['审阅中', '#475569'],
    signed: ['已签署', '#15803d'],
    invalidated: ['签署已失效', '#b91c1c'],
    superseded: ['已被取代', '#b91c1c'],
  };
  const [text, color] = statusMap[s.status];
  $('#status-bar').innerHTML = `
    <span class="badge" style="background:${color}">${text}</span>
    <span>基线：${esc(s.inputs.base.name)} <code>${s.inputs.base.fingerprint.slice(0, 10)}</code></span>
    <span>候选：${esc(s.inputs.cand.name)} <code>${s.inputs.cand.fingerprint.slice(0, 10)}</code></span>
    <span>配准：${reg.method}，θ=${reg.params.thetaDeg.toFixed(3)}°，s=${reg.params.scale.toFixed(5)}，
      锚点残差 RMS=${reg.rms.toFixed(4)}</span>
    <span>差异 ${sum.total}：接受 ${sum.accepted} / 驳回 ${sum.rejected} / 暂缓 ${sum.deferred} /
      未决 ${sum.undecided}；待消歧 ${sum.pending}</span>
    ${s.invalidDetail ? `<span class="warn">${esc(s.invalidDetail)}</span>` : ''}
  `;
}

// ---------- 配准参数面板 ----------
function renderRegPanel(s, reg) {
  const locked = s.status === 'signed';
  const rows = s.result.reg.anchorResiduals.map((r) => `
    <tr><td>${esc(r.baseAnchorId)}</td><td>↔</td><td>${esc(r.candAnchorId)}</td>
      <td class="num">${r.error.toFixed(4)}</td></tr>`).join('');
  const curPairs = s.result.reg.params.anchorPairs;
  const baseAnchors = state.base.anchors;
  const candAnchors = state.cand.anchors;
  const pairEditor = baseAnchors.length && candAnchors.length ? `
    <details><summary class="muted small">手工指定锚点对应（${curPairs.length} 对）</summary>
      ${baseAnchors.map((a, i) => {
        const sel = curPairs.find(([b]) => b === a.anchorId)?.[1] ?? '';
        return `<div class="row"><span class="small">${esc(a.anchorId)}</span>↔
          <select data-anchor-base="${esc(a.anchorId)}" ${locked ? 'disabled' : ''}>
            <option value="">（不使用）</option>
            ${candAnchors.map((ca) =>
              `<option value="${esc(ca.anchorId)}" ${ca.anchorId === sel ? 'selected' : ''}>${esc(ca.anchorId)}</option>`).join('')}
          </select></div>`;
      }).join('')}
    </details>` : '';
  $('#reg-panel').innerHTML = `
    <div class="grid2">
      <label>旋转 θ(°) <input id="in-theta" type="number" step="0.1" ${locked ? 'disabled' : ''}
        value="${s.regParams?.thetaDeg ?? ''}" placeholder="自动 ${reg.params.thetaDeg.toFixed(3)}"></label>
      <label>比例 s <input id="in-scale" type="number" step="0.001" ${locked ? 'disabled' : ''}
        value="${s.regParams?.scale ?? ''}" placeholder="自动 ${reg.params.scale.toFixed(5)}"></label>
    </div>
    ${pairEditor}
    <div class="row">
      <button id="btn-apply-reg" class="primary" ${locked ? 'disabled' : ''}>应用并重算</button>
      <button id="btn-auto-reg" ${locked ? 'disabled' : ''}>恢复自动配准</button>
      <label class="inline"><input id="in-reflect" type="checkbox" ${locked ? 'disabled' : ''}
        ${reg.params.allowReflection !== false ? 'checked' : ''}> 允许镜像朝向</label>
    </div>
    <table class="tiny"><thead><tr><th>基线锚点</th><th></th><th>候选锚点</th><th>残差</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="muted">无同名锚点（按同坐标处理）</td></tr>'}</tbody></table>
    <div class="muted small">同名锚点 ${curPairs.length} 对${curPairs.length >= 2 ? '，Umeyama 最小二乘配准' : ''}。
      重算只影响非固定项；与固定关系矛盾时整次撤回。</div>
  `;
  $('#btn-apply-reg').onclick = () => {
    const thetaDeg = numOrNull('#in-theta');
    const scale = numOrNull('#in-scale');
    const allowReflection = $('#in-reflect').checked;
    const anchorPairs = [...document.querySelectorAll('select[data-anchor-base]')]
      .map((sel) => [sel.dataset.anchorBase, sel.value])
      .filter(([, cid]) => cid !== '');
    // 候选锚点不允许一对多
    const seen = new Set();
    for (const [, cid] of anchorPairs) {
      if (seen.has(cid)) { flash('同一个候选锚点不能对应多个基线锚点', true); return; }
      seen.add(cid);
    }
    const patch = { allowReflection, anchorPairs: anchorPairs.length ? anchorPairs : undefined };
    if (thetaDeg != null && scale != null) { patch.thetaDeg = thetaDeg; patch.scale = scale; }
    const r = updateRegistration(s, state.base, state.cand, patch);
    if (!r.ok) flash(r.conflict.message, true);
    refreshView();
  };
  $('#btn-auto-reg').onclick = () => {
    s.regParams = null;
    const r = updateRegistration(s, state.base, state.cand, {});
    if (!r.ok) flash(r.conflict.message, true);
    refreshView();
  };
}

function numOrNull(sel) {
  const v = $(sel).value.trim();
  return v === '' ? null : Number(v);
}

// ---------- 差异清单 ----------
function renderDiffList(s) {
  const filter = state.filter;
  const locked = s.status === 'signed';
  const diffs = s.result.diffs.filter((d) => filter === 'all' || d.kind === filter);
  const counts = {};
  for (const d of s.result.diffs) counts[d.kind] = (counts[d.kind] || 0) + 1;
  const filterBtns = ['all', ...Object.keys(KIND_STYLE)].map((k) => `
    <button class="chip ${filter === k ? 'on' : ''}" data-filter="${k}">
      ${k === 'all' ? '全部' : KIND_CN[k]} ${k === 'all' ? s.result.diffs.length : (counts[k] || 0)}
    </button>`).join('');

  $('#diff-list').innerHTML = `
    <div class="chips">${filterBtns}</div>
    ${diffs.length === 0 ? '<div class="empty">无差异项（或全部低于公差，归为未改动）</div>' : ''}
    ${diffs.map((d) => {
      const v = s.decisions[d.key];
      const verdictCls = v ? `verdict-${v.verdict}` : 'verdict-none';
      const note = s.notes[d.key]?.note || v?.note || '';
      return `
      <div class="diff-card ${state.selected?.key === d.key ? 'selected' : ''} ${verdictCls}"
           data-key="${esc(d.key)}">
        <div class="diff-head">
          <span class="tag" style="background:${KIND_STYLE[d.kind].stroke}">${KIND_CN[d.kind]}</span>
          <span class="dim">${entityLabel(d)}</span>
          ${d.pinned ? '<span class="pin">📌 已固定</span>' : ''}
          ${verdictBadge(v)}
        </div>
        <div class="metric-rows">${metricSummary(d)}</div>
        ${note ? `<div class="note">📝 ${esc(note)}</div>` : ''}
        <div class="diff-actions">
          <button data-act="accept"  ${locked ? 'disabled' : ''}
            class="${v?.verdict === 'accepted' ? 'on' : ''}">接受</button>
          <button data-act="reject"  ${locked ? 'disabled' : ''}
            class="${v?.verdict === 'rejected' ? 'on' : ''}">驳回</button>
          <button data-act="defer"   ${locked ? 'disabled' : ''}
            class="${v?.verdict === 'deferred' ? 'on' : ''}">暂缓</button>
        </div>
      </div>`;
    }).join('')}
  `;
  $('#diff-list').querySelectorAll('.chip').forEach((b) => {
    b.onclick = () => { state.filter = b.dataset.filter; renderDiffList(s); };
  });
  $('#diff-list').querySelectorAll('.diff-card').forEach((card) => {
    const key = card.dataset.key;
    card.querySelector('.diff-head').onclick = () => selectDiff(key);
    card.querySelectorAll('.diff-actions button').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const d = s.result.diffs.find((x) => x.key === key);
        const verdict = btn.dataset.act === 'accept' ? 'accepted'
          : btn.dataset.act === 'reject' ? 'rejected' : 'deferred';
        decide(s, key, verdict, { note: s.decisions[key]?.note || '' });
        registry.put(s);
        renderDiffList(s);
        renderSignPanel(s);
        renderHeader(s, estimateRegistration(state.base, state.cand, s.regParams || {}));
      };
    });
  });
}

function entityLabel(d) {
  if (d.kind === 'topology') {
    return `${d.entityKind === 'hole' ? '孔' : '区域'} ${d.metrics.before.count} → ${d.metrics.after.count} 块（${
      d.topology === 'split' ? '拆分' : d.topology === 'merge' ? '合并' : '多对多'}）`;
  }
  const id = d.base?.label || d.base?.sourceId || d.base?.stableId.slice(0, 6)
    || d.cand?.label || d.cand?.sourceId || d.cand?.stableId.slice(0, 6);
  const typeName = d.entityKind === 'hole' ? '孔' : d.entityKind === 'region' ? '区域' : '线段';
  return `${typeName} ${esc(id)}`;
}

function metricSummary(d) {
  const rows = formatMetricRows(d, state.session?.inputs ? 'mm' : 'mm').slice(0, 3);
  if (!rows.length) {
    return d.kind === 'addition' ? '<div class="muted small">候选稿新增图元</div>'
      : '<div class="muted small">候选稿已消除该图元</div>';
  }
  return `<table class="kv">${rows.map((r) =>
    `<tr><td>${esc(r[0])}</td><td class="num">${esc(r[1])}</td><td class="num">→ ${esc(r[2])}</td>
      <td class="num delta">${esc(r[3] ?? '')}</td></tr>`).join('')}</table>`;
}

function verdictBadge(v) {
  if (!v) return '<span class="verdict-badge none">未决</span>';
  const map = { accepted: ['已接受', '#15803d'], rejected: ['已驳回', '#b91c1c'], deferred: ['暂缓', '#a16207'] };
  const [t, c] = map[v.verdict];
  return `<span class="verdict-badge" style="background:${c}">${t}</span>`;
}

function selectDiff(key) {
  const s = state.session;
  const d = s.result.diffs.find((x) => x.key === key);
  state.selected = { type: 'diff', key };
  view.selectMarker(key);
  renderDiffList(s);
  renderDetail(d);
}

function renderDetail(d) {
  if (!d) { $('#detail-panel').innerHTML = '<div class="empty">点击差异查看完整前后数值与批注</div>'; return; }
  const s = state.session;
  const rows = formatMetricRows(d, 'mm');
  const note = s.notes[d.key]?.note || s.decisions[d.key]?.note || '';
  $('#detail-panel').innerHTML = `
    <h4>${KIND_CN[d.kind]} · ${entityLabel(d)}</h4>
    <table class="kv wide">${rows.map((r) =>
      `<tr><td>${esc(r[0])}</td><td class="num">基线 ${esc(r[1])}</td>
        <td class="num">候选 ${esc(r[2])}</td><td class="num delta">${esc(r[3] ?? '')}</td></tr>`).join('')}
    </table>
    ${d.confidence != null ? `<div class="muted small">自动匹配置信度：${(d.confidence * 100).toFixed(0)}%</div>` : ''}
    <label class="block">批注（绑定稳定图元身份，重算/重载不丢失）
      <textarea id="note-input" rows="2">${esc(note)}</textarea>
    </label>
    <button id="btn-save-note">保存批注</button>
  `;
  $('#btn-save-note').onclick = () => {
    annotate(s, d.key, $('#note-input').value);
    const v = s.decisions[d.key];
    if (v) decide(s, d.key, v.verdict, { note: $('#note-input').value, by: v.by });
    registry.put(s);
    renderDiffList(s);
    flash('批注已保存');
  };
}

// ---------- 待消歧 ----------
function renderPending(s) {
  const list = s.result.pending;
  const locked = s.status === 'signed';
  if (!list.length) {
    $('#pending-panel').innerHTML = '<div class="empty">无待消歧项</div>';
    return;
  }
  $('#pending-panel').innerHTML = list.map((p, idx) => {
    const baseLabel = p.base.label || p.base.sourceId || p.base.stableId.slice(0, 8);
    return `
    <div class="pending-card" data-idx="${idx}">
      <div><b>?</b> ${p.kind === 'hole' ? '孔' : p.kind === 'region' ? '区域' : '线段'}
        “${esc(baseLabel)}” 存在多个候选：${esc(p.reason)}</div>
      <table class="kv">${p.candidates.map((c, ci) => `
        <tr class="cand-row" data-ci="${ci}">
          <td><span class="conf">${(c.score * 100).toFixed(0)}%</span></td>
          <td>${esc(c.cand.label || c.cand.sourceId || c.cand.stableId.slice(0, 8))}
            ${c.insideOverlap ? '<span class="pin">重叠处</span>' : ''}</td>
          <td class="muted small">${esc(c.reasons.slice(1).join('；'))}</td>
        </tr>`).join('')}</table>
      <div class="row">
        ${p.candidates.map((c, ci) =>
          `<button data-pick="${ci}" ${locked ? 'disabled' : ''}>配给候选 ${ci + 1}</button>`).join('')}
        <button data-none class="danger-ghost" ${locked ? 'disabled' : ''}>声明无对应项</button>
      </div>
    </div>`;
  }).join('');

  $('#pending-panel').querySelectorAll('.pending-card').forEach((card) => {
    const p = list[Number(card.dataset.idx)];
    card.querySelectorAll('[data-pick]').forEach((btn) => {
      btn.onclick = () => {
        const chosen = p.candidates[Number(btn.dataset.pick)];
        const r = pinPair(s, state.base, state.cand, p.base.stableId, chosen.cand.stableId);
        if (!r.ok) flash(r.reason || r.conflict.message, true);
        refreshView();
      };
    });
    card.querySelector('[data-none]').onclick = () => {
      const r = pinPair(s, state.base, state.cand, p.base.stableId, null);
      if (!r.ok) flash(r.reason || r.conflict.message, true);
      refreshView();
    };
  });
}

// ---------- 公差 / 签署 / 快照 ----------
function readToleranceInputs() {
  const get = (id, dflt) => {
    const el = document.getElementById(id);
    return el && el.value !== '' ? Number(el.value) : dflt;
  };
  return {
    positionTolerance: get('tol-pos', 0.5),
    sizeTolerance: get('tol-size', 0.5),
    areaTolerance: get('tol-area', 2.5),
    relativeTolerance: get('tol-rel', 1) / 100,
    maxOffset: get('tol-max', 999999),
  };
}

function renderSignPanel(s) {
  const blockers = signingBlockers(s);
  const locked = s.status === 'signed';
  $('#sign-panel').innerHTML = `
    <div class="grid4">
      <label>位置公差 <input id="tol-pos" type="number" step="0.1" value="${s.tolerance.positionTolerance}" ${locked ? 'disabled' : ''}></label>
      <label>尺寸公差 <input id="tol-size" type="number" step="0.1" value="${s.tolerance.sizeTolerance}" ${locked ? 'disabled' : ''}></label>
      <label>面积公差 <input id="tol-area" type="number" step="0.1" value="${s.tolerance.areaTolerance}" ${locked ? 'disabled' : ''}></label>
      <label>相对(%) <input id="tol-rel" type="number" step="0.5"
        value="${(s.tolerance.relativeTolerance * 100).toFixed(1)}" ${locked ? 'disabled' : ''}></label>
      <label>固定最大偏移 <input id="tol-max" type="number" step="1"
        value="${s.tolerance.maxOffset === Infinity ? '' : s.tolerance.maxOffset}" placeholder="不限" ${locked ? 'disabled' : ''}></label>
    </div>
    <div class="row">
      <button id="btn-apply-tol" ${locked ? 'disabled' : ''}>应用公差并重算</button>
      <button id="btn-sign" class="primary" ${blockers.length || locked ? 'disabled' : ''}>${locked ? '已签署（锁定）' : '签署审阅'}</button>
      <button id="btn-replace" class="danger-ghost">替换候选稿…</button>
    </div>
    ${locked ? '<div class="ok">本审阅已签署并锁定。原稿/参数/公差一旦改动，旧签署将失效（快照仍可追溯）。</div>'
      : blockers.length ? `<ul class="blockers">${blockers.map((b) => `<li>${esc(b.message)}</li>`).join('')}</ul>`
        : '<div class="ok">所有差异均已有结论，可以签署。</div>'}
    ${s.signatures.length ? `<div class="muted small">历史签署：${s.signatures.map((x) =>
      `<code>${x.snapshotId.slice(0, 18)}…</code> @ ${x.signedAt}`).join('；')}</div>` : ''}
  `;
  $('#btn-apply-tol').onclick = () => {
    const r = updateTolerance(s, state.base, state.cand, readToleranceInputs());
    if (!r.ok) flash(r.conflict.message, true);
    refreshView();
  };
  $('#btn-sign').onclick = () => {
    const res = sign(s, { by: $('#reviewer-name').value || '审阅人' });
    if (!res.ok) { flash(res.blockers.map((b) => b.message).join('；'), true); return; }
    registry.put(s);
    flash(`已签署，只读快照 ${res.snapshotId}`);
    refreshView();
  };
  $('#btn-replace').onclick = replaceCandFile;
}

function replaceCandFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const raw = JSON.parse(await input.files[0].text());
    const cand = parseDrawing(raw, 'cand');
    const { session: next } = replaceCandidate(registry, state.session, state.base, cand);
    state.cand = cand;
    state.candRaw = raw;
    state.session = next;
    refreshView();
    flash('候选稿已替换：旧签署失效并保留快照，已创建新审阅。');
  };
  input.click();
}

function renderSnapshotList() {
  const snaps = registry.listSnapshots();
  $('#snapshot-panel').innerHTML = snaps.length === 0
    ? '<div class="empty">尚无签署快照</div>'
    : snaps.map((snap) => `
      <div class="snap-row" data-id="${esc(snap.snapshotId)}">
        <code>${esc(snap.snapshotId.slice(0, 22))}…</code>
        <span class="muted small">${snap.signedAt} · ${esc(snap.by)} ·
          ${snap.inputs.base.name} ↔ ${snap.inputs.cand.name} · ${snap.stats.total} 项差异</span>
        <span class="ok">只读</span>
      </div>`).join('');
  $('#snapshot-panel').querySelectorAll('.snap-row').forEach((row) => {
    row.onclick = () => showSnapshot(row.dataset.id);
  });
}

function showSnapshot(id) {
  const snap = registry.getSnapshot(id);
  if (!snap) return;
  if (typeof window.open !== 'function') return; // 非浏览器环境（测试桩）
  const w = window.open('', '_blank');
  w.document.write(`<!doctype html><meta charset="utf-8"><title>审阅快照 ${snap.snapshotId}</title>
  <style>body{font:13px/1.6 system-ui,sans-serif;margin:32px;color:#1e293b}
  table{border-collapse:collapse;width:100%;margin:8px 0}td,th{border:1px solid #cbd5e1;padding:4px 8px}
  h1{font-size:18px}code{background:#f1f5f9;padding:1px 4px}.ro{color:#15803d;font-weight:bold}
  .num{text-align:right}</style>
  <h1>只读审阅快照 <span class="ro">（已冻结）</span></h1>
  <p>快照指纹 <code>${snap.snapshotId}</code><br>签署人 ${snap.by} · ${snap.signedAt}</p>
  <h3>输入指纹</h3>
  <table><tr><th></th><th>名称</th><th>指纹</th></tr>
  <tr><td>基线稿</td><td>${snap.inputs.base.name}</td><td><code>${snap.inputs.base.fingerprint}</code></td></tr>
  <tr><td>候选稿</td><td>${snap.inputs.cand.name}</td><td><code>${snap.inputs.cand.fingerprint}</code></td></tr></table>
  <h3>配准参数</h3>
  <pre>${JSON.stringify({ method: snap.registration.method, params: snap.registration.params,
    rms: snap.registration.rms, anchorResiduals: snap.registration.anchorResiduals,
    tolerance: snap.tolerance }, null, 2)}</pre>
  <h3>对应关系（${snap.correspondence.pairCount} 对，另有 ${snap.correspondence.topologyGroups} 个拓扑组）</h3>
  <table><tr><th>基线图元</th><th>候选图元</th><th>固定</th><th>置信度</th></tr>
  ${snap.correspondence.pairs.map((p) => `<tr><td><code>${p.base}</code></td><td><code>${p.cand}</code></td>
    <td>${p.pinned ? '📌' : ''}</td><td class="num">${p.confidence == null ? '—' : (p.confidence * 100).toFixed(0) + '%'}</td></tr>`).join('')}
  </table>
  <h3>差异与决议（${snap.diffs.length}）</h3>
  <table><tr><th>类型</th><th>身份</th><th>结论</th><th>批注</th><th>关键指标</th></tr>
  ${snap.diffs.map((d) => `<tr><td>${d.kind} ${d.changes.join(',')}</td><td><code>${d.key}</code></td>
    <td>${d.decision?.verdict || ''}（${d.decision?.by || ''}）</td><td>${d.note || ''}</td>
    <td><code>${JSON.stringify(d.metrics?.delta || {})}</code></td></tr>`).join('')}</table>
  <h3>统计</h3><pre>${JSON.stringify(snap.stats, null, 2)}</pre>`);
  w.document.close();
}

// ---------- 视图联动 ----------
view.onSelect = (hit) => {
  if (hit.type === 'diff') selectDiff(hit.key);
  if (hit.type === 'pending') {
    state.selected = hit;
    view.selectMarker(hit.key);
    $('#tab-pending').click();
  }
};

// ---------- 杂项 ----------
function flash(msg, error = false) {
  const el = $('#flash');
  el.textContent = msg;
  el.className = error ? 'flash error show' : 'flash show';
  clearTimeout(flash._t);
  flash._t = setTimeout(() => el.classList.remove('show'), 4000);
}

$('#base-file').onchange = (e) => handleImport('base', e.target.files[0]);
$('#cand-file').onchange = (e) => handleImport('cand', e.target.files[0]);
document.querySelectorAll('[data-demo]').forEach((b) => {
  b.onclick = () => loadDemo(b.dataset.demo);
});
document.querySelectorAll('.layer-toggle').forEach((cb) => {
  cb.onchange = () => view.setLayer(cb.dataset.layer, cb.checked);
});
$('#btn-fit').onclick = () => view.fit();
$('#btn-clear-storage').onclick = () => {
  clearStorage();
  flash('本地持久化已清空（刷新后生效）');
};

// 启动时提供"恢复最近审阅"
(function offerRestore() {
  const drafts = JSON.parse(localStorage.getItem('drawing-diff:drafts:v1') || '{}');
  const entries = Object.entries(drafts);
  if (!entries.length) return;
  const bar = $('#status-bar');
  const btn = document.createElement('button');
  btn.textContent = '↻ 恢复最近一次审阅';
  btn.className = 'primary';
  btn.style.marginLeft = 'auto';
  btn.onclick = () => {
    const [, draft] = entries[entries.length - 1];
    state.baseRaw = draft.base;
    state.candRaw = draft.cand;
    tryStart();
  };
  bar.appendChild(btn);
})();
$('#tabs').querySelectorAll('button').forEach((b) => {
  b.onclick = () => {
    $('#tabs').querySelectorAll('button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    document.querySelectorAll('.tabpane').forEach((p) => p.classList.remove('on'));
    $(`#pane-${b.id.slice(4)}`).classList.add('on');
  };
});
