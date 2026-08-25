// PaperLink InkPad — 手写引擎（嫁接自 Riddle inkpad.js，SPEC §3.4）
// Pointer Events 主 + 压感/速度调制；提供 撤销(undo) / 逐点回调(书写流) /
// 逐笔回调(提交) / 溶解动画 / 同速重放所需的时间戳 /
// v3.6 多指手势：一指书写；双指橡皮擦（橡皮大小随两指距离智能调节）；
// 三指视口手势——并拢缩小、张开放大、同向移动平移页面。

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
    this._gesture = null;       // 三指视口手势状态 {midX, midY, dist, view}
    this._twoErase = false;     // 双指橡皮擦模式
    this._twoMid = null;        // 双指擦除中点（画布坐标，UI 橡皮圈用）
    this._twoR = 0;             // 双指擦除半径（屏幕像素，UI 橡皮圈用）
    this.color = "#241812";
    this.minW = 0.6;            // 压感最细笔迹（0.2–3，管理页可调）
    this.maxW = 2.4;            // 压感最粗笔迹（0.2–3，管理页可调）
    this.eraseR = 18;           // 橡皮半径（长按滑条可调）
    this.penScale = 1;
    this.w = 0; this.h = 0; this.dpr = 1;
    this.strokeSeq = 0;
    this.view = { x: 0, y: 0, s: 1 }; // 视口：双指平移/缩放（仅本地，不参与同步）
    this.fadeMap = new Map();   // strokeId → alpha（E6 墨迹渐隐彩蛋）
    this.onStrokeEnd = null;    // (stroke) → 发送/提交
    this.onLiveChunk = null;    // (strokeId, ptsChunk) → 逐点流
    this.onUndo = null;
    this.onEraseAt = null;
    this.onGestureStart = null; // (cancelledStrokeId|null) → 双指手势打断了进行中的笔画
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
    this.view = { x: 0, y: 0, s: 1 }; // 新的一页从默认视口开始
    this._twoErase = false;
    this._twoMid = null;
    this._gesture = null;
    this._clearAll();
  }

  /// 视口复位（双击工具区等场景可调用）
  resetView() {
    this.view = { x: 0, y: 0, s: 1 };
    this.redraw();
  }

  /// 当前视口变换（双指平移/缩放的结果）
  _applyView() {
    const v = this.view;
    this.ctx.setTransform(this.dpr * v.s, 0, 0, this.dpr * v.s, this.dpr * v.x, this.dpr * v.y);
  }

  _clearAll() {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._applyView();
  }

  // ------------------------------------------------------------- strokes

  /// 压感 → 笔宽：最细~最粗区间，压力平方响应（两参数由管理页设定，公式自适应）
  widthFor(p) {
    const t = clamp(p, 0, 1);
    return (this.minW + (this.maxW - this.minW) * t * t) * this.penScale;
  }

  /// 屏幕坐标（相对画布左上）
  toLocal(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /// 屏幕坐标 → 纸面坐标（经过视口平移/缩放折算）
  toPaper(e) {
    const p = this.toLocal(e);
    return { x: (p.x - this.view.x) / this.view.s, y: (p.y - this.view.y) / this.view.s };
  }

  pointerDown(e) {
    const sPos = this.toLocal(e);
    this.pointers.set(e.pointerId, sPos);
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ok */ }

    // v3.6：第二根手指落下 → 双指橡皮擦（打断进行中的笔画，橡皮大小跟指距走）
    if (this.pointers.size === 2) {
      const cancelled = this.current ? this.current.id : null;
      this.current = null;
      this.onGestureStart?.(cancelled);
      this._twoErase = true;
      this._eraseTwoFinger();
      return "erase2";
    }

    // v3.6：第三根手指落下 → 三指视口手势（并拢缩小/张开放大/同移平移），
    // 从双指擦除无缝切换过来
    if (this.pointers.size === 3) {
      this._twoErase = false;
      this._twoMid = null;
      const pts = [...this.pointers.values()];
      const midX = (pts[0].x + pts[1].x + pts[2].x) / 3;
      const midY = (pts[0].y + pts[1].y + pts[2].y) / 3;
      const dist = Math.max(12,
        (Math.hypot(pts[0].x - midX, pts[0].y - midY) +
         Math.hypot(pts[1].x - midX, pts[1].y - midY) +
         Math.hypot(pts[2].x - midX, pts[2].y - midY)) / 3);
      this._gesture = { midX, midY, dist, view: { ...this.view } };
      return "gesture";
    }

    // 第四指及以上：手掌误触兜底，全部结束
    if (this.pointers.size > 3) { this._gesture = null; this._twoErase = false; return "rest"; }
    const pos = this.toPaper(e);

    if (this.eraseTool || this.erasing) {
      this.erasing = true;
      this.eraseAt(pos, this.eraseR);
      return "erase";
    }

    // 已有进行中的笔画又来新指针 → 先把上一笔收尾落库，绝不静默丢笔
    if (this.current) this._finalizeCurrent();

    this.current = { id: ++this.strokeSeq, pts: [], start: performance.now() };
    // v3.5 压感分厂商：触控笔（Apple Pencil / S Pen 等）走真压感；
    // 手指/鼠标（iOS 与多数安卓触屏无可用压感源）走速度模拟笔锋，全设备手感统一
    this._pressureMode = e.pointerType === "pen" ? "pen" : "sim";
    this._velSim = { x: pos.x, y: pos.y, t: performance.now(), p: 0.55 };
    this._addPoint(e, pos);
    return "draw";
  }

  pointerMove(e) {
    const sPos = this.toLocal(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, sPos);

    // 三指视口手势：以重心为锚——三指同移 = 平移页面，并拢/张开 = 缩小/放大（0.5x–3x）
    if (this._gesture && this.pointers.size >= 3) {
      const pts = [...this.pointers.values()];
      const midX = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const midY = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      const dist = Math.max(12, pts.reduce((s, p) => s + Math.hypot(p.x - midX, p.y - midY), 0) / pts.length);
      const g = this._gesture;
      const s = clamp(g.view.s * dist / g.dist, 0.5, 3);
      // 锚点稳定：手势起始时重心下的那个纸面点，始终跟住当前重心
      const px = (g.midX - g.view.x) / g.view.s;
      const py = (g.midY - g.view.y) / g.view.s;
      this.view = { s, x: midX - px * s, y: midY - py * s };
      this.redraw();
      return;
    }

    // 双指橡皮擦：擦两指中点，半径随指距实时变化
    if (this._twoErase && this.pointers.size >= 2) {
      this._eraseTwoFinger();
      return;
    }

    if (this.erasing) { this.eraseAt(this.toPaper(e), this.eraseR); return; }
    if (!this.current) return;
    const evs = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
    for (const ev of evs.length ? evs : [e]) this._addPoint(ev, this.toPaper(ev));
  }

  pointerUp(e) {
    this.pointers.delete(e.pointerId);
    if (this._gesture) {
      if (this.pointers.size < 3) {
        this._gesture = null;
        // 三指抬到只剩两指 → 无缝回到双指橡皮擦
        if (this.pointers.size === 2) { this._twoErase = true; this._eraseTwoFinger(); }
        else if (this.pointers.size === 0) this.erasing = false;
      }
      return;
    }
    if (this._twoErase) {
      if (this.pointers.size < 2) {
        this._twoErase = false;
        this._twoMid = null;
        if (this.pointers.size === 0) this.erasing = false; // 从橡皮工具切来时清标志
      }
      return; // 剩余单指不落笔，避免抬手瞬间误画
    }
    if (this.erasing && this.pointers.size === 0) this.erasing = false;
    if (this.current) this._finalizeCurrent();
  }

  /// v3.6 双指橡皮擦：擦两指中点，半径随指距智能调节——
  /// 手指并拢擦细节、张开擦大片（屏幕 12–80px，折算到纸面坐标）
  _eraseTwoFinger() {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const midX = (pts[0].x + pts[1].x) / 2;
    const midY = (pts[0].y + pts[1].y) / 2;
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const rScreen = clamp(d * 0.45, 12, 80);
    this._twoMid = { x: midX, y: midY };
    this._twoR = rScreen;
    const pos = { x: (midX - this.view.x) / this.view.s, y: (midY - this.view.y) / this.view.s };
    this.eraseAt(pos, rScreen / this.view.s);
  }

  /// UI 用：双指擦除是否进行中（画布坐标的中点与屏幕像素半径）
  twoErasing() { return this._twoErase && this.pointers.size >= 2; }
  twoFingerUi() { return this._twoMid ? { ...this._twoMid, r: this._twoR } : null; }

  _finalizeCurrent() {
    const s = this.current;
    this.current = null;
    if (s && s.pts.length) {
      this.strokes.push(s);
      s.durationMs = Math.max(1, s.pts[s.pts.length - 1].t);
      this.onStrokeEnd?.(this.exportStroke(s));
    }
  }

  /// v3.5 压感来源判定：触控笔真压感优先；无压感设备用书写速度模拟
  /// （慢=粗、快=细的钢笔笔锋），苹果/安卓/浏览器之间手感一致。
  /// 笔宽数据落库后对端重放一致，不受本地模拟方式影响。
  _pressureFor(e, pos, nowT) {
    if (this._pressureMode === "pen" && e.pressure > 0) {
      // iOS Apple Pencil 压力值普遍偏低，轻放大吃满区间
      return Math.min(1, e.pressure * 1.15);
    }
    const vs = this._velSim || { x: pos.x, y: pos.y, t: nowT, p: 0.55 };
    const dt = Math.max(1, nowT - vs.t);
    const speed = Math.hypot(pos.x - vs.x, pos.y - vs.y) / dt; // 纸面 px/ms
    vs.x = pos.x; vs.y = pos.y; vs.t = nowT;
    const target = clamp(Math.exp(-speed * 1.15) * 1.05, 0.15, 1);
    vs.p = vs.p * 0.55 + target * 0.45; // 平滑，避免抖动毛边
    this._velSim = vs;
    return vs.p;
  }

  _addPoint(e, pos) {
    const prev = this.current.pts[this.current.pts.length - 1];
    if (prev && pos.x === prev.x && pos.y === prev.y) return;
    const t = performance.now() - this.current.start;
    const p = this._pressureFor(e, pos, performance.now());
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

  /// 整页导出（寄信提交）——始终用原始纸面坐标，视口变换不影响
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

  /// 溶解动画（v3 升级，向 riddle 看齐）：墨迹先整体轻化，再化作细颗粒
  /// 自纸面升腾淡出。粒子数自适应屏幅并封顶，保证低端机不掉帧。
  /// 只做视觉，笔迹模型由调用方清理。
  dissolve(durMs = 900) {
    return new Promise((resolve) => {
      const cw = this.canvas.width, ch = this.canvas.height;
      if (!cw || !ch || !this.hasInk()) { resolve(); return; }

      let img;
      try { img = this.ctx.getImageData(0, 0, cw, ch); } catch { resolve(); return; }
      const d = img.data;

      // 采样墨迹像素 → 粒子；步长由总量反推，最多 ~2200 颗
      let step = Math.max(1, Math.round(Math.sqrt((cw * ch) / 60000)));
      let pts = [];
      for (let y = 0; y < ch; y += step) {
        for (let x = 0; x < cw; x += step) {
          const i = (y * cw + x) * 4;
          if (d[i + 3] > 40) {
            pts.push({
              x, y,
              r: (0.7 + ((x * 13 + y * 7) % 10) / 9) * step * 0.62,
              vx: (((x * 31 + y * 17) % 100) / 100 - 0.5) * 1.1,
              vy: -(0.5 + ((x * 7 + y * 29) % 100) / 62),
              o: Math.min(1, d[i + 3] / 235),
            });
          }
        }
      }
      if (!pts.length) { this._clearAll(); resolve(); return; }
      if (pts.length > 2200) {
        const keep = 2200 / pts.length;
        pts = pts.filter((_, i) => (i * keep) % 1 < keep);
      }

      // 底稿快照（渐隐用）
      const snap = document.createElement("canvas");
      snap.width = cw; snap.height = ch;
      snap.getContext("2d").putImageData(img, 0, 0);

      const ctx = this.ctx;
      const ink = this.color;
      const start = performance.now();

      const tick = (nowT) => {
        const t = Math.min(1, (nowT - start) / durMs);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, cw, ch);

        // 前 62%：底稿柔和淡出（先快后慢）
        const base = Math.max(0, 1 - Math.pow(t / 0.62, 1.4));
        if (base > 0.01) {
          ctx.globalAlpha = base;
          ctx.drawImage(snap, 0, 0);
        }

        // 12% 起：粒子升腾、缩小、淡出（错峰出场，避免齐刷刷消失）
        const p0 = 0.12;
        if (t > p0) {
          ctx.fillStyle = ink;
          const span = 1 - p0;
          for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            const lag = (i % 7) / 7 * 0.22;              // 错峰
            const q = (t - p0 - lag) / (span - 0.22);
            if (q <= 0 || q >= 1) continue;
            const a = p.o * (1 - q) * (1 - q) * 0.9;
            if (a < 0.015) continue;
            ctx.globalAlpha = a;
            ctx.beginPath();
            ctx.arc(p.x + p.vx * q * 46, p.y + p.vy * q * 60, Math.max(0.4, p.r * (1 - q * 0.55)), 0, Math.PI * 2);
            ctx.fill();
          }
        }

        ctx.globalAlpha = 1;
        if (t < 1) {
          requestAnimationFrame(tick);
        } else {
          this._clearAll();
          resolve();
        }
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
