// render.js — Canvas 叠加视图：基线/候选分层、五类差异着色、命中测试、无级缩放。
//
// 所有几何在屏幕坐标绘制；命中半径取屏幕像素（9px），
// 因此无论缩放到何种视野尺度，点击与标记指向都保持准确。

const KIND_STYLE = {
  addition:   { stroke: '#16a34a', fill: 'rgba(22,163,74,0.18)',  label: '增补' },
  removal:    { stroke: '#dc2626', fill: 'rgba(220,38,38,0.18)',  label: '消除' },
  position:   { stroke: '#d97706', fill: 'rgba(217,119,6,0.14)',  label: '位置偏移' },
  size:       { stroke: '#7c3aed', fill: 'rgba(124,58,237,0.14)', label: '尺寸改动' },
  topology:   { stroke: '#db2777', fill: 'rgba(219,39,119,0.16)', label: '拓扑改动' },
  shape:      { stroke: '#0891b2', fill: 'rgba(8,145,178,0.14)',  label: '形状改动' },
};

export class OverlayView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = { scale: 1, ox: 0, oy: 0 }; // world -> screen
    this.layers = { base: true, cand: true, diffs: true, anchors: true };
    this.base = null;       // 配准后候选、基线
    this.cand = null;
    this.session = null;
    this.hoverKey = null;
    this.selectedKey = null;
    this._attach();
  }

  setData(base, candTransformed, session, { fitView = false } = {}) {
    const newPair = !this.session || this.session.pairId !== session?.pairId;
    this.base = base;
    this.cand = candTransformed;
    this.session = session;
    if (fitView || newPair) this.fit();
    else this.draw();
  }

  _attach() {
    const c = this.canvas;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      this.zoomAt(this.toWorld(e.offsetX, e.offsetY), factor);
    }, { passive: false });
    let dragging = false, sx = 0, sy = 0;
    c.addEventListener('mousedown', (e) => {
      dragging = true; sx = e.offsetX; sy = e.offsetY;
      c.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', (e) => {
      const r = c.getBoundingClientRect();
      if (dragging) {
        this.view.ox += e.clientX - r.left - sx;
        this.view.oy += e.clientY - r.top - sy;
        sx = e.clientX - r.left; sy = e.clientY - r.top;
        this.draw();
      } else {
        this._hover(e.clientX - r.left, e.clientY - r.top);
      }
    });
    window.addEventListener('mouseup', () => { dragging = false; c.style.cursor = 'default'; });
    c.addEventListener('click', (e2) => this._click(e2.offsetX, e2.offsetY));
    new ResizeObserver(() => this.draw()).observe(c);
  }

  toWorld(sx, sy) {
    return [(sx - this.view.ox) / this.view.scale, (sy - this.view.oy) / this.view.scale];
  }
  toScreen(p) {
    return [p[0] * this.view.scale + this.view.ox, p[1] * this.view.scale + this.view.oy];
  }

  zoomAt(worldPt, factor) {
    const before = this.toScreen(worldPt);
    this.view.scale = Math.min(200, Math.max(0.02, this.view.scale * factor));
    // 以鼠标为锚点缩放
    this.view.ox = before[0] - worldPt[0] * this.view.scale;
    this.view.oy = before[1] - worldPt[1] * this.view.scale;
    this.draw();
  }

  fit() {
    const box = this._worldBounds();
    if (!box) return;
    const w = this.canvas.clientWidth || 800;
    const h = this.canvas.clientHeight || 500;
    const pad = 40;
    const worldW = box.maxX - box.minX || 1;
    const worldH = box.maxY - box.minY || 1;
    this.view.scale = Math.min((w - pad * 2) / worldW, (h - pad * 2) / worldH);
    const viewW = worldW * this.view.scale;
    const viewH = worldH * this.view.scale;
    this.view.ox = (w - viewW) / 2 - box.minX * this.view.scale;
    this.view.oy = (h - viewH) / 2 - box.minY * this.view.scale;
    this.draw();
  }

  _worldBounds() {
    const pts = [];
    for (const draw of [this.base, this.cand]) {
      if (!draw) continue;
      for (const e of draw.entities) {
        for (const p of e.points) pts.push(p);
      }
    }
    if (!pts.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  }

  diffs() {
    return this.session?.result?.diffs || [];
  }
  pending() {
    return this.session?.result?.pending || [];
  }

  /** 差异关联的屏幕图元，用于着色与命中。 */
  _diffGeometry(d) {
    if (d.kind === 'topology') {
      const pts = [];
      for (const e of [...(d.baseGroup || []), ...(d.candGroup || [])]) pts.push(...e.points);
      return pts;
    }
    if (d.cand) return d.cand.points;
    if (d.base) return d.base.points;
    return [];
  }

  draw() {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (this.canvas.width !== w * dpr) {
      this.canvas.width = w * dpr; this.canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    this._drawGrid(ctx, w, h);
    if (!this.base) return;

    if (this.layers.base) this._drawDrawing(ctx, this.base, { stroke: '#2563eb', width: 1.5, dash: [] });
    if (this.layers.cand) this._drawDrawing(ctx, this.cand, { stroke: '#ea580c', width: 1.5, dash: [7, 4] });

    if (this.layers.diffs) {
      for (const d of this.diffs()) this._drawDiffHalo(ctx, d);
      for (const d of this.diffs()) this._drawDiffMarker(ctx, d);
      for (const p of this.pending()) this._drawPendingMarker(ctx, p);
    }
    if (this.layers.anchors) this._drawAnchors(ctx);
    this._drawLegend(ctx);
  }

  _drawGrid(ctx, w, h) {
    // 与世界单位对齐的网格（步长随缩放取 1/2/5×10^n）
    const targetPx = 80;
    const raw = targetPx / this.view.scale;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) || pow * 10;
    ctx.strokeStyle = '#eef2f7';
    ctx.lineWidth = 1;
    const tl = this.toWorld(0, 0), br = this.toWorld(w, h);
    for (let x = Math.ceil(tl[0] / step) * step; x < br[0]; x += step) {
      const [sx] = this.toScreen([x, 0]);
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, h); ctx.stroke();
    }
    for (let y = Math.ceil(tl[1] / step) * step; y < br[1]; y += step) {
      const [, sy] = this.toScreen([0, y]);
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(w, sy); ctx.stroke();
    }
  }

  _drawDrawing(ctx, draw, style) {
    if (!draw) return;
    ctx.save();
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = style.width;
    ctx.setLineDash(style.dash);
    for (const e of draw.entities) {
      ctx.beginPath();
      const p0 = this.toScreen(e.points[0]);
      ctx.moveTo(p0[0], p0[1]);
      for (let i = 1; i < e.points.length; i++) {
        const p = this.toScreen(e.points[i]);
        ctx.lineTo(p[0], p[1]);
      }
      if (e.kind !== 'segment') ctx.closePath();
      ctx.stroke();
      if (e.kind === 'segment') this._capArrow(ctx, e);
    }
    ctx.restore();
  }

  _capArrow(ctx, e) {
    // 开放线段端点小圆
    ctx.save();
    ctx.setLineDash([]);
    ctx.fillStyle = ctx.strokeStyle;
    for (const p of [e.points[0], e.points[e.points.length - 1]]) {
      const [sx, sy] = this.toScreen(p);
      ctx.beginPath(); ctx.arc(sx, sy, 2.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  _drawDiffHalo(ctx, d) {
    const style = KIND_STYLE[d.kind];
    const ents = d.kind === 'topology'
      ? [...(d.baseGroup || []), ...(d.candGroup || [])]
      : [d.cand || d.base].filter(Boolean);
    ctx.save();
    ctx.strokeStyle = style.stroke;
    ctx.fillStyle = style.fill;
    ctx.lineWidth = this.hoverKey === d.key || this.selectedKey === d.key ? 3.5 : 2.2;
    for (const e of ents) {
      ctx.beginPath();
      e.points.forEach((p, i) => {
        const [sx, sy] = this.toScreen(p);
        if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
      });
      if (e.kind !== 'segment') { ctx.closePath(); ctx.fill(); }
      ctx.stroke();
    }
    // 位置偏移：质心位移箭头
    if (d.kind === 'position' && d.metrics?.displacement) {
      const a = this.toScreen([d.metrics.before.x, d.metrics.before.y]);
      const b = this.toScreen([d.metrics.after.x, d.metrics.after.y]);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      ctx.strokeStyle = style.stroke; ctx.setLineDash([]); ctx.stroke();
      this._arrowHead(ctx, a, b);
    }
    ctx.restore();
  }

  _arrowHead(ctx, a, b) {
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const s = 8;
    ctx.beginPath();
    ctx.moveTo(b[0], b[1]);
    ctx.lineTo(b[0] - s * Math.cos(ang - 0.4), b[1] - s * Math.sin(ang - 0.4));
    ctx.lineTo(b[0] - s * Math.cos(ang + 0.4), b[1] - s * Math.sin(ang + 0.4));
    ctx.closePath(); ctx.fill();
  }

  _drawDiffMarker(ctx, d) {
    const style = KIND_STYLE[d.kind];
    const pts = this._diffGeometry(d);
    if (!pts.length) return;
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const [sx, sy] = this.toScreen([cx, cy]);
    ctx.save();
    ctx.fillStyle = style.stroke;
    ctx.beginPath(); ctx.arc(sx, sy, 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const glyph = { addition: '+', removal: '×', position: '→', size: '↕', topology: '⇄', shape: '∿' }[d.kind];
    ctx.fillText(glyph, sx, sy + 0.5);
    ctx.restore();
  }

  _drawPendingMarker(ctx, p) {
    const c = p.base?.features?.centroid;
    if (!c) return;
    const [sx, sy] = this.toScreen(c);
    ctx.save();
    ctx.strokeStyle = '#ca8a04';
    ctx.fillStyle = 'rgba(202,138,4,0.12)';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([5, 3]);
    const R = 14 + (this.hoverKey === `pending:${p.base.stableId}` ? 3 : 0);
    ctx.beginPath(); ctx.arc(sx, sy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ca8a04';
    ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('?', sx, sy + 0.5);
    ctx.restore();
  }

  _drawAnchors(ctx) {
    ctx.save();
    ctx.setLineDash([]);
    for (const draw of [this.base, this.cand]) {
      if (!draw) continue;
      const color = draw === this.base ? '#1d4ed8' : '#c2410c';
      ctx.fillStyle = color;
      for (const a of draw.anchors) {
        const [sx, sy] = this.toScreen([a.x, a.y]);
        ctx.beginPath();
        ctx.moveTo(sx, sy); ctx.lineTo(sx + 8, sy + 4); ctx.lineTo(sx, sy + 8);
        ctx.lineTo(sx - 8, sy + 4); ctx.closePath(); ctx.fill();
      }
    }
    ctx.restore();
  }

  _drawLegend(ctx) {
    const items = Object.entries(KIND_STYLE);
    ctx.save();
    ctx.font = '11px sans-serif';
    let x = 12, y = this.canvas.clientHeight - 26;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    const totalW = items.reduce((s, [, st]) => s + ctx.measureText(st.label).width + 30, 12);
    ctx.fillRect(6, y - 14, totalW, 22);
    for (const [, st] of items) {
      ctx.fillStyle = st.stroke;
      ctx.fillRect(x, y, 12, 10);
      ctx.fillStyle = '#334155';
      ctx.fillText(st.label, x + 16, y + 9);
      x += 16 + ctx.measureText(st.label).width + 14;
    }
    ctx.restore();
  }

  _screenHit(sx, sy, radius = 9) {
    // 优先差异标记 → 待消歧 → 图元
    let best = null, bestD = radius;
    const consider = (worldPt, key) => {
      const [px, py] = this.toScreen(worldPt);
      const d = Math.hypot(px - sx, py - sy);
      if (d <= bestD) { bestD = d; best = key; }
    };
    for (const d of this.diffs()) {
      const pts = this._diffGeometry(d);
      if (!pts.length) continue;
      const c = [pts.reduce((s, p) => s + p[0], 0) / pts.length,
        pts.reduce((s, p) => s + p[1], 0) / pts.length];
      consider(c, { type: 'diff', key: d.key });
    }
    for (const p of this.pending()) {
      if (p.base?.features?.centroid) {
        consider(p.base.features.centroid, { type: 'pending', key: `pending:${p.base.stableId}` });
      }
    }
    return best;
  }

  _hover(sx, sy) {
    const hit = this._screenHit(sx, sy, 9);
    const key = hit ? hit.key : null;
    if (key !== this.hoverKey) {
      this.hoverKey = key;
      this.canvas.style.cursor = key ? 'pointer' : 'default';
      this.draw();
    }
  }

  _click(sx, sy) {
    const hit = this._screenHit(sx, sy, 11);
    if (hit && this.onSelect) this.onSelect(hit);
  }

  selectMarker(key) {
    this.selectedKey = key;
    this.draw();
  }

  setLayer(name, on) {
    this.layers[name] = on;
    this.draw();
  }
}

export { KIND_STYLE };
