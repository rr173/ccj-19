// app.js — 页面交互：场景/参数 → CAM 计算 → 画布与面板渲染、逐段检查、导出复核、打乱自检
'use strict';

const Vec = CAM.V;

const state = {
  scenarioId: 'two-holes',
  rings: [],
  zones: [],
  home: { x: 0, y: 0 },
  result: null,
  resultShuffled: null,
  activeSegNo: null,
  hoverSegNo: null,
  view: { scale: 6, ox: 80, oy: 80 }, // 世界→屏幕
  layers: { orig: true, off: true, dir: true, rapid: true, bridge: true, lead: true, segno: true },
};

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

/* ----------------------------- 参数读取 ----------------------------- */

function readParams() {
  return {
    toolDiameter: parseFloat($('in-tool').value) || 0,
    machiningSide: $('in-side').value,
    leadType: $('in-lead-type').value,
    leadLength: parseFloat($('in-lead-len').value) || 6,
    bridgeCount: parseInt($('in-bridge-n').value, 10) || 0,
    bridgeWidth: parseFloat($('in-bridge-w').value) || 3,
    bridgeCornerClear: parseFloat($('in-bridge-corner').value) || 0,
    bridgeLeadGuard: parseFloat($('in-bridge-lead').value) || 0,
  };
}

function setParamsUI(p = {}) {
  if (p.toolDiameter != null) $('in-tool').value = p.toolDiameter;
  if (p.machiningSide) $('in-side').value = p.machiningSide;
  if (p.leadType) $('in-lead-type').value = p.leadType;
  if (p.leadLength != null) $('in-lead-len').value = p.leadLength;
  if (p.bridgeCount != null) $('in-bridge-n').value = p.bridgeCount;
  if (p.bridgeWidth != null) $('in-bridge-w').value = p.bridgeWidth;
  if (p.bridgeCornerClear != null) $('in-bridge-corner').value = p.bridgeCornerClear;
  if (p.bridgeLeadGuard != null) $('in-bridge-lead').value = p.bridgeLeadGuard;
}

/* ----------------------------- 场景加载 ----------------------------- */

function loadScenario(id) {
  const sc = SCENARIOS.find((s) => s.id === id);
  if (!sc) return;
  state.scenarioId = id;
  state.rings = sc.rings.map((r) => ({ ...r, points: r.points.map((p) => ({ ...p })) }));
  state.zones = (sc.zones || []).map((z) => ({ ...z, points: z.points.map((p) => ({ ...p })) }));
  state.home = { ...sc.home };
  setParamsUI(sc.params || {});
  state.activeSegNo = null;
  recompute();
  fitView();
}

function currentInput(shuffle = false) {
  let rings = state.rings.map((r, i) => ({
    ...r,
    points: r.points.map((p) => ({ ...p })),
    _origIdx: i,
  }));
  if (shuffle) {
    // 逆序 + 每个环坐标点反向（保留 kind 由规范化强制方向）
    rings = rings.reverse().map((r) => ({ ...r, points: [...r.points].reverse() }));
  }
  rings.forEach((r) => delete r._origIdx);
  return {
    rings,
    zones: state.zones.map((z) => ({ ...z, points: z.points.map((p) => ({ ...p })) })),
    params: readParams(),
    home: { ...state.home },
  };
}

function recompute() {
  state.result = CAM.computeToolpath(currentInput(false));
  state.resultShuffled = CAM.computeToolpath(currentInput(true));
  renderAll();
}

/* ----------------------------- 坐标变换 ----------------------------- */
// 世界坐标 y 向上，屏幕 y 向下
function w2s(p) {
  return { x: p.x * state.view.scale + state.view.ox, y: -p.y * state.view.scale + state.view.oy };
}
function s2w(p) {
  return { x: (p.x - state.view.ox) / state.view.scale, y: -(p.y - state.view.oy) / state.view.scale };
}

function fitView() {
  const all = [];
  for (const r of state.rings) all.push(...r.points);
  for (const z of state.zones) all.push(...z.points);
  all.push(state.home);
  if (!all.length) return;
  const minX = Math.min(...all.map((p) => p.x)) - 25;
  const maxX = Math.max(...all.map((p) => p.x)) + 25;
  const minY = Math.min(...all.map((p) => p.y)) - 25;
  const maxY = Math.max(...all.map((p) => p.y)) + 25;
  const rect = canvas.getBoundingClientRect();
  const sx = rect.width / (maxX - minX);
  const sy = rect.height / (maxY - minY);
  state.view.scale = Math.min(sx, sy);
  state.view.ox = -minX * state.view.scale;
  state.view.oy = maxY * state.view.scale;
  draw();
}

/* ----------------------------- 画布绘制 ----------------------------- */

const COLORS = {
  orig: '#7c8db0',
  outer: '#6ea8ff',
  hole: '#39c0a0',
  cut: '#6ea8ff',
  lead: '#4dd0e1',
  rapid: '#c084fc',
  bridge: '#f5b942',
  zoneStart: 'rgba(80,200,120,.16)',
  zoneStartLine: '#37d67a',
  zoneBlock: 'rgba(255,93,93,.13)',
  zoneBlockLine: '#ff5d5d',
  error: '#ff5d5d',
};

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  drawGrid(rect);

  const res = state.result;
  if (!res) return;
  const L = state.layers;

  // 区域
  for (const z of res.zones) {
    const isBlock = z.type === 'no-cross';
    ctx.beginPath();
    z.points.forEach((p, i) => {
      const s = w2s(p);
      if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
    ctx.fillStyle = isBlock ? COLORS.zoneBlock : COLORS.zoneStart;
    ctx.fill();
    ctx.strokeStyle = isBlock ? COLORS.zoneBlockLine : COLORS.zoneStartLine;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    const c = w2s(CAM.centroid(z.points));
    ctx.fillStyle = isBlock ? COLORS.zoneBlockLine : COLORS.zoneStartLine;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(isBlock ? '⛔ ' + z.name : '◎ ' + z.name, c.x, c.y);
  }

  // 原始轮廓
  if (L.orig) {
    for (const r of res.rings) {
      strokeRing(r.points, COLORS.orig, 1.2, [5, 4]);
      if (r.offsetError?.point) {
        // 错误位置：红圈 + 受影响边高亮
        drawErrorMarker(r);
      }
    }
  }

  // 补偿轨迹
  if (L.off) {
    for (const r of res.rings) {
      if (!r.offset) continue;
      const baseColor = r.kind === 'hole' ? COLORS.hole : COLORS.outer;
      if (r.offsetError || r.inheritedError) {
        strokeRing(r.offset.points, 'rgba(255,93,93,.55)', 1, [3, 3]);
      } else {
        strokeRing(r.offset.points, baseColor, 1.6, null);
      }
    }
  }

  // 引入/引出
  if (L.lead) {
    for (const r of res.rings) {
      if (r.leadError) {
        strokePolyline(r.leadPoly, '#ff8a8a', 1, [2, 3]);
        const c = w2s(r.leadError.point);
        ctx.fillStyle = COLORS.error;
        ctx.beginPath(); ctx.arc(c.x, c.y, 5, 0, Math.PI * 2); ctx.fill();
        continue;
      }
      if (r.leadPoly) strokePolyline(r.leadPoly, COLORS.lead, 1.6, [7, 3]);
      if (r.leadOutPoly) strokePolyline(r.leadOutPoly, COLORS.lead, 1.6, [7, 3]);
      if (r.leadStart) {
        const s = w2s(r.leadStart);
        ctx.strokeStyle = COLORS.lead; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }

  // 抬刀空移（RAPID 段）
  if (L.rapid) {
    for (const s of res.segments) {
      if (s.cls !== 'RAPID') continue;
      const active = s.no === state.activeSegNo;
      strokePolyline(s.points, active ? '#fff' : COLORS.rapid, active ? 2.4 : 1.4, [4, 3]);
      // 空移绕行拐点
      if (s.points.length > 2) {
        for (let i = 1; i < s.points.length - 1; i++) {
          const p = w2s(s.points[i]);
          ctx.fillStyle = COLORS.rapid;
          ctx.beginPath(); ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    // home
    const h = w2s(res.home);
    ctx.fillStyle = '#e8eefc'; ctx.font = '12px sans-serif'; ctx.textAlign = 'left';
    ctx.beginPath(); ctx.arc(h.x, h.y, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillText('HOME', h.x + 7, h.y - 6);
  }

  // 切割段（实色覆盖在补偿线上）
  for (const s of res.segments) {
    if (s.type !== 'CUT') continue;
    const active = s.no === state.activeSegNo;
    strokePolyline(s.points, active ? '#ffffff' : COLORS.cut, active ? 3 : 2.1, null);
  }

  // 连接桥
  if (L.bridge) {
    for (const r of res.rings) {
      for (const b of r.bridges || []) {
        const a = w2s(b.from), c = w2s(b.to);
        ctx.strokeStyle = COLORS.bridge; ctx.lineWidth = 5;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke();
        // 桥记号：垂直于桥方向的小横杠
        const mWorld = Vec.lerp(b.from, b.to, 0.5);
        const q = Vec.rot90(Vec.norm(Vec.sub(b.to, b.from)));
        const m1 = w2s(Vec.add(mWorld, Vec.mul(q, 2.2)));
        const m0 = w2s(Vec.add(mWorld, Vec.mul(q, -2.2)));
        ctx.beginPath(); ctx.moveTo(m0.x, m0.y); ctx.lineTo(m1.x, m1.y); ctx.stroke();
      }
    }
  }

  // 加工方向箭头
  if (L.dir) {
    for (const r of res.rings) {
      if (r.offsetError || r.inheritedError || !r.offset) continue;
      const pts = r.offset.points;
      const mid = pts[Math.floor(pts.length / 2)];
      const nxt = pts[(Math.floor(pts.length / 2) + 1) % pts.length];
      drawArrow(mid, nxt, r.kind === 'hole' ? COLORS.hole : COLORS.outer);
    }
  }

  // 段编号
  if (L.segno) {
    ctx.font = 'bold 10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    for (const s of res.segments) {
      if (s.type === 'CUT' || s.type === 'BRIDGE_JUMP') continue; // 切割段太多，编号在列表看
      const p = Vec.lerp(s.from, s.to, 0.5);
      const q = w2s(p);
      const active = s.no === state.activeSegNo;
      ctx.fillStyle = active ? '#fff' : (s.type === 'RAPID' ? COLORS.rapid : COLORS.lead);
      ctx.fillText(String(s.no), q.x, q.y - 4);
    }
  }

  // 轮廓名标签
  ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
  for (const r of res.rings) {
    const c = w2s(CAM.centroid(r.points));
    ctx.fillStyle = r.offsetError || r.inheritedError ? COLORS.error :
      r.kind === 'hole' ? COLORS.hole : '#cfe0ff';
    const tag = r.name + (r.kind === 'hole' ? ' · 洞' : ' · 外');
    ctx.fillText(tag, c.x, c.y);
  }
}

function drawGrid(rect) {
  ctx.fillStyle = '#0b101b';
  ctx.fillRect(0, 0, rect.width, rect.height);
  const step = 20 * state.view.scale;
  if (step < 14) return;
  ctx.strokeStyle = 'rgba(255,255,255,.04)';
  ctx.lineWidth = 1;
  for (let x = state.view.ox % step; x < rect.width; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, rect.height); ctx.stroke();
  }
  for (let y = state.view.oy % step; y < rect.height; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(rect.width, y); ctx.stroke();
  }
}

function pathFrom(pts) {
  ctx.beginPath();
  pts.forEach((p, i) => {
    const s = w2s(p);
    if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
  });
}
function strokeRing(pts, color, width, dash) {
  pathFrom(pts);
  ctx.closePath();
  ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.setLineDash(dash || []);
  ctx.stroke();
  ctx.setLineDash([]);
}
function strokePolyline(pts, color, width, dash) {
  if (!pts || pts.length < 2) return;
  pathFrom(pts);
  ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.setLineDash(dash || []);
  ctx.stroke();
  ctx.setLineDash([]);
}
function drawArrow(a, b, color) {
  const sa = w2s(a), sb = w2s(b);
  const ang = Math.atan2(sb.y - sa.y, sb.x - sa.x);
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(sa.x - 7 * Math.cos(ang), sa.y - 7 * Math.sin(ang));
  ctx.lineTo(sa.x + 7 * Math.cos(ang), sa.y + 7 * Math.sin(ang));
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(sa.x + 8 * Math.cos(ang), sa.y + 8 * Math.sin(ang));
  ctx.lineTo(sa.x + 8 * Math.cos(ang + 2.5), sa.y + 8 * Math.sin(ang + 2.5));
  ctx.lineTo(sa.x + 8 * Math.cos(ang - 2.5), sa.y + 8 * Math.sin(ang - 2.5));
  ctx.closePath(); ctx.fill();
}

function drawErrorMarker(r) {
  const err = r.offsetError;
  ctx.save();
  // 受影响边画粗红
  if (err.edges?.length) {
    for (const ei of err.edges) {
      const a = w2s(r.points[ei]);
      const b = w2s(r.points[(ei + 1) % r.points.length]);
      ctx.strokeStyle = COLORS.error; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
  }
  if (err.point) {
    const p = w2s(err.point);
    ctx.strokeStyle = COLORS.error; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p.x, p.y, 10, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p.x - 14, p.y); ctx.lineTo(p.x + 14, p.y);
    ctx.moveTo(p.x, p.y - 14); ctx.lineTo(p.x, p.y + 14); ctx.stroke();
    // 在错误位置旁标注原因码
    ctx.font = 'bold 12px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.error;
    ctx.fillText(`✗ ${err.code}`, p.x + 14, p.y - 12);
  }
  ctx.restore();
}

/* ----------------------------- 面板渲染 ----------------------------- */

function renderPanels() {
  const res = state.result;
  renderVerify(res);
  renderOrder(res);
  renderDiag(res);
  renderSegments(res);
  renderZones();
  const badge = $('calc-badge');
  if (res.verification.exportBlocked) {
    badge.textContent = `复核未通过 · ${res.verification.failCount} 项`;
    badge.className = 'badge bad';
  } else {
    badge.textContent = '复核通过，可导出';
    badge.className = 'badge ok';
  }
  renderShuffle();
}

function renderVerify(res) {
  const box = $('verify-list');
  box.innerHTML = '';
  for (const c of res.verification.checks) {
    const div = document.createElement('div');
    div.className = 'chk-line ' + (c.ok ? 'ok' : 'bad');
    div.innerHTML = `<span class="ico">${c.ok ? '✓' : '✗'}</span>
      <div><div>${checkName(c.id)}</div><div class="chk-detail"></div></div>`;
    div.querySelector('.chk-detail').textContent = c.detail;
    box.appendChild(div);
  }
  const st = $('export-state');
  if (res.verification.exportBlocked) {
    st.textContent = '存在不合法项，已阻止生成加工文件';
    st.className = 'export-state bad';
  } else {
    st.textContent = '全部合法，可导出';
    st.className = 'export-state ok';
  }
}

function checkName(id) {
  return {
    OFFSET_DISTANCE: '补偿距离复核',
    NO_INVALID_OFFSET: '补偿有效性（窄槽/自交/吞并）',
    CONTOUR_ORDER: '轮廓先后关系（先内后外）',
    NO_CROSSING: '穿越关系（禁穿区/未切实体）',
    BRIDGE_LEGAL: '桥位合法性（直线/尖角/引入距）',
    LENGTH_AUDIT: '长度互核对账',
  }[id] || id;
}

function renderOrder(res) {
  const box = $('order-list');
  box.innerHTML = '';
  res.sequenceIds.forEach((id, i) => {
    const r = res.rings.find((x) => x.id === id);
    const chip = document.createElement('span');
    chip.className = 'order-chip ' + r.kind;
    chip.innerHTML = `<span class="n">${i + 1}</span>${r.name}${r.kind === 'hole' ? '（洞）' : ''}`;
    chip.style.cursor = 'pointer';
    chip.onclick = () => focusRing(r);
    box.appendChild(chip);
    if (i < res.sequenceIds.length - 1) {
      const ar = document.createElement('span');
      ar.className = 'order-arrow';
      ar.textContent = '→';
      box.appendChild(ar);
    }
  });
  if (!res.sequenceIds.length) {
    box.innerHTML = '<span class="muted">没有可加工轮廓（补偿失效或引入线全部受阻）。</span>';
  }
}

function renderDiag(res) {
  const box = $('diag-list');
  box.innerHTML = '';
  const items = [];
  for (const r of res.rings) {
    if (r.offsetError) {
      items.push({ level: 'fatal', ring: r, code: r.offsetError.code, msg: r.offsetError.message });
    } else if (r.inheritedError) {
      items.push({ level: 'fatal', ring: r, code: r.inheritedError.code, msg: r.inheritedError.message });
    }
    if (r.leadError) {
      items.push({ level: 'fatal', ring: r, code: r.leadError.code, msg: r.leadError.message });
    }
    if (r.rapidError) {
      items.push({ level: 'fatal', ring: r, code: r.rapidError.code, msg: r.rapidError.message });
    }
    if (r.bridgeReport && r.bridgeReport.missing > 0) {
      items.push({ level: 'warn', ring: r, code: 'BRIDGE_SHORTAGE', msg: r.bridgeReport.reason });
    }
    if (!r.offsetError && !r.inheritedError && !r.leadError &&
        (!r.bridgeReport || r.bridgeReport.missing === 0)) {
      items.push({ level: 'ok', ring: r, code: 'OK',
        msg: `${r.kind === 'hole' ? '洞' : '外轮廓'}补偿有效；引入/引出与 ${r.bridges.length} 个连接桥均合法` });
    }
  }
  for (const it of items) {
    const div = document.createElement('div');
    div.className = `diag-item ${it.level}`;
    div.innerHTML = `<span class="code">[${it.code}]</span> ${it.ring.name}：<span class="msg"></span>
      <button>定位</button>`;
    div.querySelector('.msg').textContent = it.msg;
    div.querySelector('button').onclick = () => focusRing(it.ring);
    box.appendChild(div);
  }
}

function renderSegments(res) {
  const box = $('seg-list');
  box.innerHTML = '';
  // 合计卡片
  const bar = document.createElement('div');
  bar.className = 'total-bar';
  bar.innerHTML = `
    <div class="tb cut"><div class="v">${res.totals.cut.toFixed(2)}</div><div class="k">总切割(含引入引出) mm</div></div>
    <div class="tb rapid"><div class="v">${res.totals.rapid.toFixed(2)}</div><div class="k">总空移(含过桥) mm</div></div>
    <div class="tb count"><div class="v">${res.totals.count}</div><div class="k">路径段总数</div></div>`;
  box.appendChild(bar);
  const sum = document.createElement('div');
  sum.className = 'muted';
  sum.style.padding = '2px 6px 6px';
  sum.textContent = `其中引入/引出 ${res.totals.lead.toFixed(2)} mm；连接桥跳过 ${res.totals.bridgeJump.toFixed(2)} mm`;
  box.appendChild(sum);

  const typeName = {
    RAPID: '抬刀空移', LEAD_IN: '引入线', CUT: '切割',
    BRIDGE_JUMP: '过桥抬刀', LEAD_OUT: '引出线',
  };
  for (const s of res.segments) {
    const row = document.createElement('div');
    row.className = 'seg-row' + (s.no === state.activeSegNo ? ' active' : '');
    row.innerHTML = `
      <span class="seg-no">N${String(s.no).padStart(3, '0')}</span>
      <span class="seg-type ${s.type}">${typeName[s.type]}</span>
      <span class="seg-ring">${s.ringName}</span>
      <span class="seg-len">${s.length.toFixed(2)}</span>`;
    row.onmouseenter = () => { state.hoverSegNo = s.no; draw(); };
    row.onmouseleave = () => { state.hoverSegNo = null; draw(); };
    row.onclick = () => selectSegment(s.no);
    box.appendChild(row);
  }
  $('seg-summary').textContent = `（共 ${res.segments.length} 段；长度 mm）`;
}

function renderZones() {
  const box = $('zones-list');
  box.innerHTML = '';
  state.zones.forEach((z, i) => {
    const div = document.createElement('div');
    div.className = 'zone-item';
    const isBlock = z.type === 'no-cross';
    div.innerHTML = `<span class="dot" style="background:${isBlock ? COLORS.zoneBlockLine : COLORS.zoneStartLine}"></span>
      <span>${z.name}</span><button data-i="${i}">×</button>`;
    div.querySelector('button').onclick = () => {
      state.zones.splice(i, 1);
      recompute();
    };
    box.appendChild(div);
  });
}

function renderShuffle() {
  const a = state.result;
  const b = state.resultShuffled;
  const el = $('shuffle-result');
  if (!a || !b) return;
  let sameOrder = JSON.stringify(a.sequenceIds) === JSON.stringify(b.sequenceIds);
  let sameSegs = segDigest(a) === segDigest(b);
  let sameExport = CAM.exportToolpathText(a, { fingerprint: 'ui' }) ===
                   CAM.exportToolpathText(b, { fingerprint: 'ui' });
  if (sameOrder && sameSegs && sameExport) {
    el.innerHTML = '<span style="color:var(--ok)">✓ 打乱后：加工次序、段编号与导出文本完全一致</span>';
  } else {
    el.innerHTML = `<span style="color:var(--bad)">✗ 不一致：次序${sameOrder ? '✓' : '✗'} 段${sameSegs ? '✓' : '✗'} 导出${sameExport ? '✓' : '✗'}</span>`;
  }
}

function segDigest(res) {
  return res.segments.map((s) =>
    `${s.no}|${s.type}|${s.ringId}|${s.points.map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).join(' ')}`
  ).join('\n');
}

/* ----------------------------- 交互 ----------------------------- */

function selectSegment(no) {
  state.activeSegNo = no;
  draw();
  renderSegments(state.result);
  const seg = state.result.segments.find((s) => s.no === no);
  showSegTip(seg);
  // 列表滚动
  const rows = document.querySelectorAll('.seg-row');
  rows.forEach((r) => { if (r.querySelector('.seg-no').textContent === `N${String(no).padStart(3, '0')}`) r.scrollIntoView({ block: 'nearest' }); });
}

function showSegTip(seg) {
  const tip = $('seg-tip');
  if (!seg) { tip.classList.add('hidden'); return; }
  const typeName = { RAPID: '抬刀空移', LEAD_IN: '引入线', CUT: '切割', BRIDGE_JUMP: '过桥抬刀', LEAD_OUT: '引出线' };
  const cls = seg.cls === 'CUT' ? '切割长度' : '空移长度';
  const rows = [
    ['所属轮廓', `${seg.ringName}（${seg.ringId}）`],
    ['类型', typeName[seg.type]],
    [cls, `${seg.length.toFixed(3)} mm`],
    ['起点', `(${seg.from.x.toFixed(3)}, ${seg.from.y.toFixed(3)})`],
    ['终点', `(${seg.to.x.toFixed(3)}, ${seg.to.y.toFixed(3)})`],
    ['折点数', String(seg.points.length)],
  ];
  if (seg.bridge) rows.push(['连接桥', `宽 ${seg.bridge.width.toFixed(2)} mm（抬刀跳过、不切割）`]);
  tip.innerHTML = `<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
  const p = w2s(Vec.lerp(seg.from, seg.to, 0.5));
  const wrap = canvas.getBoundingClientRect();
  tip.classList.remove('hidden');
  let tx = p.x + 14, ty = p.y + 14;
  if (tx + 280 > wrap.width) tx = p.x - 290;
  if (ty + 160 > wrap.height) ty = p.y - 160;
  tip.style.left = Math.max(6, tx) + 'px';
  tip.style.top = Math.max(6, ty) + 'px';
}

function focusRing(r) {
  const seg = state.result.segments.find((s) => s.ringId === r.id && s.type === 'LEAD_IN');
  if (seg) selectSegment(seg.no);
}

// 拾取：最近段
function pickSegment(wp) {
  let best = null, bestD = 6 / state.view.scale;
  for (const s of state.result.segments) {
    for (let i = 0; i < s.points.length - 1; i++) {
      const d = distToSegWorld(wp, s.points[i], s.points[i + 1]);
      if (d < bestD) { bestD = d; best = s; }
    }
  }
  return best;
}

function distToSegWorld(p, a, b) {
  const ab = Vec.sub(b, a);
  const l2 = Vec.dot(ab, ab);
  if (l2 < 1e-14) return Vec.dist(p, a);
  let t = Vec.dot(Vec.sub(p, a), ab) / l2;
  t = Math.max(0, Math.min(1, t));
  return Vec.dist(p, Vec.lerp(a, b, t));
}

let drag = null;
canvas.addEventListener('mousedown', (e) => {
  drag = { x: e.clientX, y: e.clientY, ox: state.view.ox, oy: state.view.oy };
});
canvas.addEventListener('mousemove', (e) => {
  if (drag) {
    state.view.ox = drag.ox + (e.clientX - drag.x);
    state.view.oy = drag.oy + (e.clientY - drag.y);
    draw();
  }
});
canvas.addEventListener('mouseup', () => { drag = null; });
canvas.addEventListener('mouseleave', () => { drag = null; });
canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  const wp = s2w({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  const seg = pickSegment(wp);
  if (seg) selectSegment(seg.no);
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const before = s2w({ x: mx, y: my });
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  state.view.scale *= factor;
  const after = w2s(before);
  state.view.ox += mx - after.x;
  state.view.oy += my - after.y;
  draw();
}, { passive: false });

/* ----------------------------- 区域增删 ----------------------------- */

function addZone(type) {
  // 在当前视图中心放一个 20×14 的矩形
  const rect = canvas.getBoundingClientRect();
  const c = s2w({ x: rect.width / 2, y: rect.height / 2 });
  const w = 22, h = 16;
  const id = `z-${Date.now().toString(36)}`;
  state.zones.push({
    id,
    name: (type === 'no-cross' ? '禁穿区' : '候选区') + (state.zones.length + 1),
    type,
    points: [
      { x: c.x - w / 2, y: c.y - h / 2 }, { x: c.x + w / 2, y: c.y - h / 2 },
      { x: c.x + w / 2, y: c.y + h / 2 }, { x: c.x - w / 2, y: c.y + h / 2 },
    ],
  });
  recompute();
}

/* ----------------------------- 导出 ----------------------------- */

function doExport() {
  // 导出前重新完整计算并复核（不信任页面上的旧状态）
  const fresh = CAM.computeToolpath(currentInput(false));
  state.result = fresh;
  renderAll();
  if (fresh.verification.exportBlocked) {
    const fails = fresh.verification.checks.filter((c) => !c.ok).map((c) => `✗ ${checkName(c.id)}：${c.detail}`);
    toast('导出被阻止：\n' + fails.join('\n'), 'bad');
    return;
  }
  const txt = CAM.exportToolpathText(fresh, {
    fingerprint: `ui-${state.scenarioId}-${fresh.params.toolDiameter}`,
    safeZ: 10, cutZ: -1,
  });
  const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `toolpath-${state.scenarioId}-D${fresh.params.toolDiameter}.cnc.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`已导出 ${fresh.segments.length} 段；切割 ${fresh.totals.cut.toFixed(2)} mm，空移 ${fresh.totals.rapid.toFixed(2)} mm`, 'ok');
}

let toastTimer = null;
function toast(msg, kind = '') {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.whiteSpace = 'pre-line';
  t.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast ' + kind; }, 4000);
}

/* ----------------------------- 渲染总入口与事件绑定 ----------------------------- */

function renderAll() {
  draw();
  renderPanels();
}

function init() {
  const sel = $('scenario-select');
  for (const sc of SCENARIOS) {
    const o = document.createElement('option');
    o.value = sc.id; o.textContent = sc.name;
    sel.appendChild(o);
  }
  sel.onchange = () => loadScenario(sel.value);
  $('btn-fit').onclick = fitView;
  $('btn-add-start-region').onclick = () => addZone('start-region');
  $('btn-add-no-cross').onclick = () => addZone('no-cross');
  $('btn-del-zones').onclick = () => { state.zones = []; recompute(); };
  $('btn-export').onclick = doExport;
  $('btn-shuffle').onclick = () => {
    recompute();
    toast('已按“逆序图形 + 每个环坐标点反向”重算并比对：见左下确定性自检结果', 'ok');
  };

  for (const [key, id] of [
    ['orig', 'layer-orig'], ['off', 'layer-off'], ['dir', 'layer-dir'],
    ['rapid', 'layer-rapid'], ['bridge', 'layer-bridge'], ['lead', 'layer-lead'],
    ['segno', 'layer-segno'],
  ]) {
    $(id).onchange = (e) => { state.layers[key] = e.target.checked; draw(); };
  }
  // 任何参数变化都重算（刀径变化 → 全部补偿轨迹重新计算）
  document.querySelectorAll('#toolbar input, #toolbar select').forEach((el) => {
    el.addEventListener('change', recompute);
    el.addEventListener('input', () => {
      // 数字框输入过程中防抖
      clearTimeout(el._t);
      el._t = setTimeout(recompute, 120);
    });
  });

  loadScenario('two-holes');
  requestAnimationFrame(() => fitView());
  window.addEventListener('resize', () => { draw(); });
}

init();
