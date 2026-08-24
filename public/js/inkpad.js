// PaperLink InkPad — 手写引擎（嫁接自 Riddle inkpad.js，SPEC §3.4）
// Pointer Events 主 + 压感/速度调制；提供 撤销(undo) / 逐点回调(书写流) /
// 逐笔回调(提交) / 溶解(喝墨) / 同速重放所需的时间戳。

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

export class InkPad {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { willReadFrequently: true });
    this.strokes = [];          // {id, pts:[{x,y,p,t,w}], start}
    this.current = null;
    this.pointers = new Map();
    this.eraseTool = false;
    this.erasing = false;
    this.color = "#241812";
    this.minW = 0.6;            // 压感最细笔迹（0.2–3，管理页可调）
    this.maxW = 2.4;            // 压感最粗笔迹（0.2–3，管理页可调）
    this.eraseR = 18;           // 橡皮半径（长按滑条可调）
    this.penScale = 1;
    this.w = 0; this.h = 0; this.dpr = 1;
    this.strokeSeq = 0;
    this.fadeMap = new Map();   // strokeId → alpha（E6 墨迹渐隐彩蛋）
    this.onStrokeEnd = null;    // (stroke) → 发送/提交
    this.onLiveChunk = null;    // (strokeId, ptsChunk) → 逐点流
    this.onUndo = null;
    this.onEraseAt = null;
  }

  resize(w, h, dpr) {
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.redraw();
  }

  setColor(c) { this.color = c; this.redraw(); }

  hasInk() { return this.strokes.length > 0 || !!this.current; }
  totalPoints() {
    let n = this.current ? this.current.pts.length : 0;
    for (const s of this.strokes) n += s.pts.length;
    return n;
  }

  reset() {
    this.strokes = [];
    this.current = null;
    this._clearAll();
  }

  _clearAll() {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  // ------------------------------------------------------------- strokes

  /// 压感 → 笔宽：最细~最粗区间，压力平方响应（两参数由管理页设定，公式自适应）
  widthFor(p) {
    const t = clamp(p, 0, 1);
    return (this.minW + (this.maxW - this.minW) * t * t) * this.penScale;
  }

  toLocal(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  pointerDown(e) {
    const pos = this.toLocal(e);
    this.pointers.set(e.pointerId, pos);
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ok */ }

    if (this.eraseTool) {
      this.erasing = true;
      this.eraseAt(pos, this.eraseR);
      return "erase";
    }
    this.current = { id: ++this.strokeSeq, pts: [], start: performance.now() };
    this._addPoint(e, pos);
    return "draw";
  }

  pointerMove(e) {
    const pos = this.toLocal(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, pos);
    if (this.erasing) { this.eraseAt(pos, this.eraseR); return; }
    if (!this.current) return;
    const evs = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
    for (const ev of evs.length ? evs : [e]) this._addPoint(ev, this.toLocal(ev));
  }

  pointerUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.erasing && this.pointers.size === 0) this.erasing = false;
    if (this.current) {
      const s = this.current;
      this.current = null;
      if (s.pts.length) {
        this.strokes.push(s);
        s.durationMs = Math.max(1, s.pts[s.pts.length - 1].t);
        this.onStrokeEnd?.(this.exportStroke(s));
      }
    }
  }

  _addPoint(e, pos) {
    const prev = this.current.pts[this.current.pts.length - 1];
    if (prev && pos.x === prev.x && pos.y === prev.y) return;
    const t = performance.now() - this.current.start;
    const p = e.pressure && e.pressure > 0 ? e.pressure : 0.5;
    const pt = { x: pos.x, y: pos.y, p, t, w: this.widthFor(p) };
    if (prev) pt.w = prev.w * 0.35 + pt.w * 0.65;
    this.current.pts.push(pt);
    this._renderTail();
    if (this.onLiveChunk) {
      // 逐点流：新点打包上报（节流在 room 层）
      this.onLiveChunk(this.current.id, [[pos.x, pos.y, p, Math.round(t)]]);
    }
  }

  _prep(ctx) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = this.color;
    ctx.fillStyle = this.color;
  }

  _renderTail() {
    const pts = this.current.pts;
    const n = pts.length;
    if (!n) return;
    const ctx = this.ctx;
    ctx.globalAlpha = 0.97;
    this._prep(ctx);
    if (n === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, pts[0].w / 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (n === 2) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.lineWidth = (pts[0].w + pts[1].w) / 2;
      ctx.stroke();
    } else {
      const a = pts[n - 3], b = pts[n - 2], c = pts[n - 1];
      ctx.beginPath();
      ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
      ctx.quadraticCurveTo(b.x, b.y, (b.x + c.x) / 2, (b.y + c.y) / 2);
      ctx.lineWidth = b.w;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  redraw() {
    this._clearAll();
    this._prep(this.ctx);
    for (const s of this.strokes) drawStroke(this.ctx, s.pts, this.color, 0.97, 1);
    if (this.current) drawStroke(this.ctx, this.current.pts, this.color, 0.97, 1);
  }

  // --------------------------------------------------------------- undo

  undo() {
    if (!this.strokes.length) return null;
    const s = this.strokes.pop();
    this.redraw();
    this.onUndo?.(s.id);
    return s.id;
  }

  /// 按 id 移除一笔（对端撤销镜像用）
  removeStrokeById(id) {
    const i = this.strokes.findIndex((s) => s.id === id);
    if (i < 0) return false;
    this.strokes.splice(i, 1);
    this.redraw();
    return true;
  }

  /// 移除最近一笔来自指定集合的笔画（对端撤销的容错路径）
  removeLastOf(ids) {
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      if (ids.has(this.strokes[i].id)) {
        this.strokes.splice(i, 1);
        this.redraw();
        return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------- erase

  eraseAt(pos, r, remote = false) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    this._forgetNear(pos.x, pos.y, r);
    // 对端镜像来的擦除不再触发上报，否则两端互相回发形成死循环
    if (!remote) this.onEraseAt?.(pos.x, pos.y, r);
  }

  _forgetNear(x, y, r) {
    const r2 = (r + 2) * (r + 2);
    const kept = [];
    for (const stroke of this.strokes) {
      let seg = [];
      for (const p of stroke.pts) {
        const dx = p.x - x, dy = p.y - y;
        if (dx * dx + dy * dy <= r2) {
          if (seg.length) { kept.push({ ...stroke, pts: seg }); seg = []; }
        } else seg.push(p);
      }
      if (seg.length) kept.push({ ...stroke, pts: seg });
    }
    this.strokes = kept;
  }

  // ------------------------------------------------------------ export

  /// 上线格式：{id, pts:[[x,y,p,t]], durationMs, color}
  exportStroke(s) {
    return {
      id: s.id,
      pts: s.pts.map((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, Math.round(p.p * 100) / 100, Math.round(p.t)]),
      durationMs: s.durationMs || Math.max(1, s.pts[s.pts.length - 1]?.t || 1),
      color: this.color,
    };
  }

  /// 整页导出（寄信提交）
  exportPage() {
    const out = [];
    let duration = 0;
    for (const s of this.strokes) {
      const e = this.exportStroke(s);
      out.push(e);
      duration += e.durationMs;
    }
    return { strokes: out, durationMs: duration, points: this.totalPoints() };
  }

  /// 外部重放结果落到本地笔画模型（对端笔迹镜像）
  addRemoteStroke(data, color) {
    const pts = (data.pts || []).map(([x, y, p, t]) => ({
      x, y, p, t, w: this.widthFor(p || 0.5),
    }));
    if (!pts.length) return;
    this.strokes.push({ id: data.id || ++this.strokeSeq, pts, start: 0, durationMs: data.durationMs || pts[pts.length - 1].t });
  }

  // ------------------------------------------------------------ dissolve

  /// 手写“?”识别（移植自 riddle，阈值放宽）：
  /// 至多 4 笔；主笔高大于宽、上部有钩（横向跨度够）、起笔在上收笔在下；
  /// 其余小笔须在主笔下半区（问号下方的点）。
  looksLikeQuestionMark() {
    const strokes = this.strokes.map((s) => s.pts);
    if (!strokes.length || strokes.length > 4) return false;
    const k = this.h / 1872 || 1;
    let mainI = 0;
    for (let i = 1; i < strokes.length; i++) if (strokes[i].length > strokes[mainI].length) mainI = i;
    const main = strokes[mainI];
    if (main.length < 5) return false;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of main) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    const w = x1 - x0, h = y1 - y0;
    if (h < 120 * k || w < 25 * k || h < w * 0.5) return false;
    for (let i = 0; i < strokes.length; i++) {
      if (i === mainI) continue;
      const s = strokes[i];
      let dx0 = Infinity, dy0 = Infinity, dx1 = -Infinity, dy1 = -Infinity;
      for (const p of s) {
        dx0 = Math.min(dx0, p.x); dy0 = Math.min(dy0, p.y);
        dx1 = Math.max(dx1, p.x); dy1 = Math.max(dy1, p.y);
      }
      if (Math.max(dx1 - dx0, dy1 - dy0) > 120 * k) return false;
      if ((dy0 + dy1) / 2 < y0 + h * 0.50) return false;
      if ((dx0 + dx1) / 2 < x0 - 120 * k || (dx0 + dx1) / 2 > x1 + 120 * k) return false;
    }
    const pts = main.map((p) => [p.x, p.y]);
    if (pts[0][1] > pts[pts.length - 1][1]) pts.reverse();
    const start = pts[0], end = pts[pts.length - 1];
    if (start[1] > y0 + h * 0.50 || end[1] < y0 + h * 0.45) return false;
    let topMinX = Infinity, topMaxX = -Infinity, topMaxXy = 0;
    for (const [x, y] of pts) {
      if (y <= y0 + h * 0.50) {
        if (x > topMaxX) { topMaxX = x; topMaxXy = y; }
        topMinX = Math.min(topMinX, x);
      }
    }
    if (topMaxX === -Infinity || topMaxX - topMinX < w * 0.30) return false;
    if (topMaxXy < y0 + h * 0.04) return false;
    return true;
  }

  /// "喝墨"溶解动画（移植 Riddle，仅视觉；笔迹模型由调用方清理）
  dissolve(durMs = 1100) {
    return new Promise((resolve) => {
      const w = this.canvas.width, h = this.canvas.height;
      if (!w || !h || !this.hasInk()) { resolve(); return; }
      const img = this.ctx.getImageData(0, 0, w, h);
      const data = img.data;
      const stages = 22;
      const buckets = Array.from({ length: stages }, () => []);
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 0) buckets[(i / 4) % stages].push(i + 3);
      }
      let s = 0;
      const stepMs = durMs / stages;
      let last = performance.now();
      const tick = (now) => {
        if (s >= stages) { resolve(); return; }
        if (now - last >= stepMs) {
          for (const ai of buckets[s]) data[ai] = 0;
          this.ctx.putImageData(img, 0, 0);
          s++;
          last = now;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }
}

/// Catmull-Rom 平滑的分段绘制（复用于重放，SPEC §3.4）
export function drawStroke(ctx, pts, color, alpha = 0.97, widthScale = 1) {
  if (!pts.length) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, (pts[0].w / 2) * widthScale, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  ctx.lineTo((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
  ctx.lineWidth = ((pts[0].w + pts[1].w) / 2) * widthScale;
  ctx.stroke();
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    ctx.beginPath();
    ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
    ctx.quadraticCurveTo(b.x, b.y, (b.x + c.x) / 2, (b.y + c.y) / 2);
    ctx.lineWidth = b.w * widthScale;
    ctx.stroke();
  }
  ctx.restore();
}
