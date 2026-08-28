// PaperLink InkPad — 手写引擎（嫁接自 Riddle inkpad.js，SPEC §3.4）
// Pointer Events 主 + 压感/速度调制；提供 撤销(undo) / 逐点回调(书写流) /
// 逐笔回调(提交) / 溶解动画 / 同速重放所需的时间戳 /
// v3.6 多指手势：一指书写；双指橡皮擦（橡皮大小随两指距离智能调节）；
// 三指视口手势——并拢缩小、张开放大、同向移动平移页面。
//
// v3.16 渲染管线升级：
//  - 离屏缓存（_cacheCv）：定稿笔画快照一次绘制、redraw 时 O(1) 贴图，
//    长信重绘与实时模式对端持续收笔不再整页逐笔重画（优化意见 #37/#38）；
//  - 急转角圆角化（roundSharpCorners）+ 公共分段绘制（strokeSegment），
//    本地书写 / 对端镜像 / 信件重放三处同一套几何，杜绝漂移（#36/#49）；
//  - 压感响应曲线可配置（笔锋响应：linear / quad / pow，管理页参数，#33）；
//  - 压感源归一化：部分安卓触控笔上报 0–1024 等非 0–1 范围（#35）。

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/// #36 急转角圆角化：相邻三点转角大于 20°（内角 < 160°）时，用角点两侧
/// 的两个插值点替代角点，二次曲线链在急转弯处呈现圆角而不是尖肘。
/// 只影响渲染几何，不改笔迹模型与同步数据；阈值以方向向量夹角余弦表达。
const COS_SHARP = Math.cos(20 * Math.PI / 180); // ≈0.94，夹角超过 20° 视为急转
export function roundSharpCorners(pts) {
  if (!pts || pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const v1x = b.x - a.x, v1y = b.y - a.y;
    const v2x = c.x - b.x, v2y = c.y - b.y;
    const m1 = Math.hypot(v1x, v1y), m2 = Math.hypot(v2x, v2y);
    let sharp = false;
    if (m1 > 0.001 && m2 > 0.001) sharp = (v1x * v2x + v1y * v2y) / (m1 * m2) < COS_SHARP;
    if (sharp) {
      // 切角：角点两侧 0.62 / 0.38 处各插一点（宽度/时间/压力线性内插）
      const lerp = (p, q, t) => ({
        x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t,
        p: p.p + (q.p - p.p) * t, t: p.t + (q.t - p.t) * t, w: p.w + (q.w - p.w) * t,
      });
      out.push(lerp(a, b, 0.62), lerp(b, c, 0.38));
    } else out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/// #49 公共分段绘制：笔画第 i 段（0=起笔段）。本地行笔、对端镜像续画、
/// 信件重放三处统一调用，二次曲线几何与线宽口径一致；#50 渲染线宽保底
/// 0.8px，极细笔迹在高清屏不被抗锯齿吞掉。
/// 透明度由调用方控制（快照/渐隐/重放各自设置），本函数不覆盖。
export function strokeSegment(ctx, pts, i, ink) {
  if (ink) { ctx.strokeStyle = ink; ctx.fillStyle = ink; }
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  if (i === 0) {
    if (pts.length === 1) {
      ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, Math.max(0.4, pts[0].w / 2), 0, Math.PI * 2); ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
    ctx.lineWidth = Math.max(0.8, (pts[0].w + pts[1].w) / 2);
    ctx.stroke();
  } else if (i < pts.length - 1) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    ctx.beginPath();
    ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
    ctx.quadraticCurveTo(b.x, b.y, (b.x + c.x) / 2, (b.y + c.y) / 2);
    ctx.lineWidth = Math.max(0.8, b.w);
    ctx.stroke();
  }
}

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
    this.pressureCurve = "pow"; // v3.16 #33 笔锋响应曲线：pow(p^1.4) / linear / quad，管理页参数
    this.eraseR = 18;           // 橡皮半径（长按滑条可调）
    this.penScale = 1;
    this.strokeScale = 1;       // 整体笔画缩放（移植自 riddle-web 的 widthFor 因子）
    this.smooth = 0.35;         // v3.15 防抖平滑度（0.1–0.8，管理页参数）：越大越顺滑
    this.tipOn = false;         // v3.15 自动出锋开关（起笔/收笔渐细，状态存浏览器）
    this.tipN = 8;              // 出锋长度：起收两端各渐变的采样点数
    this._lastRaw = null;       // 最近一次原始输入点（收笔时补偿平滑滞后用）
    this.w = 0; this.h = 0; this.dpr = 1;
    this.strokeSeq = 0;
    this.view = { x: 0, y: 0, s: 1 }; // 视口：双指平移/缩放（仅本地，不参与同步）
    this.fadeMap = new Map();   // strokeId → alpha（E6 墨迹渐隐彩蛋）
    // v3.16 #37 离屏缓存：定稿笔画画在 _cacheCv（dpr 像素系、无视口变换），
    // redraw 只贴图 + 画进行中笔画。结构变化（撤销/擦除模型变更/换色/重排）
    // 时 _cacheOk 置假、下次 redraw 重建。
    this._cacheCv = null;
    this._cacheCtx = null;
    this._cacheOk = false;
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
    this._cacheOk = false; // 画布尺寸变化，快照作废
    this.redraw();
  }

  setColor(c) { this.color = c; this._cacheOk = false; this.redraw(); }

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
    this._cacheOk = false;
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

  /// #43 视口钳制：无论如何平移缩放，纸面至少保留约 1/4 幅面在画布内，
  /// 不会整个跑出屏幕外找不回（三指手势每帧调用）
  _clampView() {
    if (!this.w || !this.h) return;
    const v = this.view;
    const pw = this.w * v.s, ph = this.h * v.s;
    v.x = clamp(v.x, this.w * 0.25 - pw, this.w * 0.75);
    v.y = clamp(v.y, this.h * 0.25 - ph, this.h * 0.75);
  }

  _clearAll() {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._applyView();
  }

  // ------------------------------------------------- 离屏缓存（v3.16 #37）

  /// 缓存画布与主画布同像素尺寸；非浏览器环境（冒烟测试）返回 false 走全量重绘
  _ensureCache() {
    if (this._cacheCv && this._cacheCv.width === this.canvas.width && this._cacheCv.height === this.canvas.height) return true;
    if (typeof document === "undefined") return false;
    if (!this._cacheCv) this._cacheCv = document.createElement("canvas");
    this._cacheCv.width = Math.max(1, this.canvas.width);
    this._cacheCv.height = Math.max(1, this.canvas.height);
    this._cacheCtx = this._cacheCv.getContext("2d");
    this._cacheOk = false;
    return true;
  }

  /// 全量重建定稿笔画快照（dpr 像素系，无视口）
  _rebuildCache() {
    if (!this._ensureCache()) return false;
    const c = this._cacheCtx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this._cacheCv.width, this._cacheCv.height);
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._prep(c);
    for (const s of this.strokes) drawStroke(c, s.pts, this.color, 0.97, 1);
    this._cacheOk = true;
    return true;
  }

  /// 把一笔增量画进快照（抬笔落库 / 对端整笔到达时调用，避免整页重绘）
  _cacheStroke(s) {
    if (!this._cacheOk || !this._cacheCtx) return;
    const c = this._cacheCtx;
    c.save();
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    drawStroke(c, s.pts, this.color, 0.97, 1);
    c.restore();
  }

  /// E6 渐隐：逐笔透明度变化期间走全量重绘路径（缓存不适用），
  /// 变更时快照作废，动画结束后下次 redraw 自动重建
  setFade(id, alpha) {
    this.fadeMap.set(id, alpha);
    this._cacheOk = false;
  }

  // ------------------------------------------------------------- strokes

  /// 压感 → 笔宽：双端点插值模型，移植自 riddle-web inkpad.js。
  ///   minW(fine)：零压感（最轻触纸）笔宽；maxW(bold)：满压感笔宽，均 0.2–3.0。
  /// v3.16 #33 响应曲线可配置（管理页「笔锋响应」）：
  ///   pow：p^1.4（默认，riddle 同款）；linear：线性；quad：p²（轻写更细、重写才粗）。
  /// v3.15 速度因子（快写细、慢写粗）仅在无真压感的设备上生效（鼠标/触摸，
  /// np=true）：有真压感（触控笔）的笔画粗细完全由压感决定，不受速度调制。
  widthFor(pt, prev, np = true) {
    let wf = 1;
    if (np && prev) {
      const d = Math.hypot(pt.x - prev.x, pt.y - prev.y);
      const dt = Math.max(1, pt.t - prev.t);
      const v = d / dt;
      wf = clamp(1.15 - v * 0.18, 0.72, 1.18);
    }
    const p = clamp(pt.p, 0, 1);
    const fine = clamp(this.minW != null ? this.minW : 0.6, 0.2, 3.0);
    const bold = clamp(this.maxW != null ? this.maxW : 2.4, 0.2, 3.0);
    const curve = this.pressureCurve || "pow";
    const k = curve === "linear" ? p : curve === "quad" ? p * p : Math.pow(p, 1.4);
    const baseW = fine + (bold - fine) * k;
    return 2 * this.penScale * this.strokeScale * wf * baseW;
  }

  /// 按书写同款算法顺序补算笔宽（对端笔迹落库 / 信件重放用）。
  /// np：是否无压感设备（速度因子仅此时生效；旧数据无标记 → 沿用旧行为）；
  /// tipN：出锋长度，>0 时对起收两端做渐细包络。
  widthsFor(pts, np = true, tipN = 0) {
    let prev = null;
    for (const pt of pts) {
      pt.w = this.widthFor(pt, prev, np);
      if (prev) pt.w = prev.w * 0.4 + pt.w * 0.6;
      prev = pt;
    }
    if (tipN > 0) this.applyTipEnvelope(pts, tipN);
    return pts;
  }

  /// v3.15 自动出锋：笔画起笔端前 N 个采样点从最细笔宽（minSize）过渡到
  /// 计算值，收笔端末尾 N 个从计算值过渡到 minSize；过渡曲线用 smoothstep
  /// 缓动 t²(3-2t)，与正常行笔段衔接处无粗细突变。
  applyTipEnvelope(pts, tipN) {
    const len = pts.length;
    if (len < 4) return; // 太短的笔画不做渐变，避免整体变细
    const N = Math.min(tipN, Math.floor(len / 3)); // 两端最多各占 1/3，互不重叠
    if (N < 2) return;
    const fine = clamp(this.minW != null ? this.minW : 0.6, 0.2, 3.0);
    const minSize = 2 * this.penScale * this.strokeScale * fine;
    const ease = (t) => t * t * (3 - 2 * t);
    for (let i = 0; i < N; i++) {
      const k = ease((i + 1) / N); // 0→1：越靠近行笔段越接近原宽度
      const head = pts[i], tail = pts[len - 1 - i];
      head.w = minSize + (head.w - minSize) * k;
      tail.w = minSize + (tail.w - minSize) * k;
    }
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
    // v3.23 #52：记录落指时刻，供"三指同时落下"判定
    this.pointers.set(e.pointerId, { ...sPos, at: performance.now() });
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
    // 从双指擦除无缝切换过来。
    // v3.23 #52 触发条件收紧：三根手指须在 200ms 内先后落下（同时落下）、
    // 且全部位于纸面范围内，手势才成立；成立后再经 200ms 确认期才生效，
    // 确认期内任何一指抬起即取消——慢速误触与掌缘扫过不再抢走视口。
    if (this.pointers.size === 3) {
      const nowT = performance.now();
      const entries = [...this.pointers.values()];
      const ats = entries.map((p) => p.at || 0);
      const simultaneous = Math.max(...ats) - Math.min(...ats) <= 200;
      const onPaper = entries.every((p) => p.x >= 0 && p.y >= 0 && p.x <= this.w && p.y <= this.h);
      if (!simultaneous || !onPaper) {
        this.pointers.delete(e.pointerId); // 拒收这一指：保持双指橡皮现状
        return "rest";
      }
      this._twoErase = false;
      this._twoMid = null;
      const pts = entries;
      const midX = (pts[0].x + pts[1].x + pts[2].x) / 3;
      const midY = (pts[0].y + pts[1].y + pts[2].y) / 3;
      const dist = Math.max(12,
        (Math.hypot(pts[0].x - midX, pts[0].y - midY) +
         Math.hypot(pts[1].x - midX, pts[1].y - midY) +
         Math.hypot(pts[2].x - midX, pts[2].y - midY)) / 3);
      this._gesture = { midX, midY, dist, view: { ...this.view }, confirmAt: nowT + 200, confirmed: false };
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

    // np：无真压感设备（鼠标/触摸）——速度因子只在这类笔画上生效，
    // 触控笔（pointerType=pen）的粗细完全交给压感
    this.current = { id: ++this.strokeSeq, pts: [], start: performance.now(), np: e.pointerType !== "pen" };
    this._addPoint(e, pos);
    return "draw";
  }

  pointerMove(e) {
    const sPos = this.toLocal(e);
    // v3.23 #52：更新坐标时保留落指时刻（三指同时落下判定用）
    if (this.pointers.has(e.pointerId)) {
      const prev = this.pointers.get(e.pointerId);
      this.pointers.set(e.pointerId, { ...sPos, at: prev.at });
    }

    // 三指视口手势：以重心为锚——三指同移 = 平移页面，并拢/张开 = 缩小/放大（0.5x–3x）
    if (this._gesture && this.pointers.size >= 3) {
      // v3.23 #52：200ms 确认期——确认期内只跟踪不生效，期间抬指会在
      // pointerUp 里整体取消；期满才真正开始驱动视口
      if (!this._gesture.confirmed) {
        if (performance.now() < this._gesture.confirmAt) return;
        this._gesture.confirmed = true;
        // 确认完成后以"当下"姿态为基准重锚，确认期内的指头漂移不算进变换
        const pts0 = [...this.pointers.values()];
        const mx = pts0.reduce((s, p) => s + p.x, 0) / pts0.length;
        const my = pts0.reduce((s, p) => s + p.y, 0) / pts0.length;
        const d0 = Math.max(12, pts0.reduce((s, p) => s + Math.hypot(p.x - mx, p.y - my), 0) / pts0.length);
        this._gesture.midX = mx; this._gesture.midY = my; this._gesture.dist = d0;
        this._gesture.view = { ...this.view };
        return;
      }
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
      this._clampView(); // #43 纸面不得整体跑出画布
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
        this._clampView();
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
  /// 手指并拢擦细节、张开擦大片（折算到纸面坐标）。
  /// v3.7 微调：两指张到约 300px 才达到最大（原约 180px 就封顶，
  /// 日常握距下橡皮偏大）——中段手感更细腻。
  /// v3.16 #41：最大半径随纸幅自适应（pad.w 的 12%，最小 80 屏幕像素），
  /// 大屏上橡皮不再偏小。
  _eraseTwoFinger() {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const midX = (pts[0].x + pts[1].x) / 2;
    const midY = (pts[0].y + pts[1].y) / 2;
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const rMax = Math.max(80, this.w * 0.12);
    const rScreen = clamp(d * (rMax / 300), 12, rMax);
    this._twoMid = { x: midX, y: midY };
    this._twoR = rScreen;
    // #44 口径：橡皮半径一律按纸面坐标进入模型（_forgetNear），
    // 屏幕像素半径仅用于 UI 橡皮圈显示；除以 view.s 完成折算
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
      // v3.15 平滑滞后补偿：收笔点拉回最后一枚原始输入位置，笔尖不"飘"离指尖
      if (s.pts.length > 1 && this._lastRaw) {
        const lp = s.pts[s.pts.length - 1];
        const dx = this._lastRaw.x - lp.x, dy = this._lastRaw.y - lp.y;
        if (dx * dx + dy * dy < 900) { lp.x = this._lastRaw.x; lp.y = this._lastRaw.y; }
      }
      // v3.15 自动出锋：抬笔即对整条笔画做后处理——起收两端渐细，
      // 并把出锋长度记在笔画上，镜像/落库/重放按同算法还原
      if (this.tipOn) { this.applyTipEnvelope(s.pts, this.tipN); s.tip = this.tipN; }
      this.strokes.push(s);
      s.durationMs = Math.max(1, s.pts[s.pts.length - 1].t);
      // v3.16：出锋/最终宽度增量补进离屏缓存再贴图，不再整页重绘（#37）
      this._cacheStroke(s);
      this.redraw();
      this.onStrokeEnd?.(this.exportStroke(s));
    }
  }

  _addPoint(e, pos) {
    this._lastRaw = { x: pos.x, y: pos.y };
    const prev = this.current.pts[this.current.pts.length - 1];
    // v3.15 防抖平滑（后台参数 smooth 0.1–0.8）：EMA 低通——
    // 新点 = 上一轨迹点 + (原始输入 - 上一轨迹点) × (1 - smooth)。
    // 0.1 几乎保留原始轨迹（手绘感），0.8 大幅平均化手抖（顺滑）。首点原样。
    if (prev && this.smooth > 0.02) {
      const a = 1 - this.smooth;
      pos = { x: prev.x + (pos.x - prev.x) * a, y: prev.y + (pos.y - prev.y) * a };
    }
    if (prev && pos.x === prev.x && pos.y === prev.y) return;
    const t = performance.now() - this.current.start;
    // riddle-web 同款压感取值：有真压感用真压感，无压感设备按 0.5 中性值。
    // v3.16 #35 压感源归一化：部分安卓触控笔上报 0–1024（或超范围值），
    // 统一折算回 0–1，避免各家标定差异把笔宽顶到端点
    let pr = Number(e.pressure) || 0;
    if (pr > 1) pr = pr > 1024 ? 1 : pr / 1024;
    pr = clamp(pr, 0, 1);
    const pt = { x: pos.x, y: pos.y, t, p: pr > 0 ? pr : 0.5 };
    pt.w = this.widthFor(pt, prev, this.current.np);
    if (prev) pt.w = prev.w * 0.4 + pt.w * 0.6; // riddle 同款平滑：压感响应更跟手
    this.current.pts.push(pt);
    this._renderTail();
    if (this.onLiveChunk) {
      // 逐点流：新点打包上报（节流在 room 层）
      this.onLiveChunk(this.current.id, [[pos.x, pos.y, pt.p, Math.round(t)]]);
    }
  }

  _prep(ctx) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = this.color;
    ctx.fillStyle = this.color;
  }

  _renderTail() {
    const all = this.current.pts;
    const n = all.length;
    if (!n) return;
    const ctx = this.ctx;
    ctx.globalAlpha = 0.97;
    this._prep(ctx);
    // 方向突变（拐角/弧度）检测 → 局部增粗（移植自 riddle-web）：
    // 末三点转角越大墨越饱满，转折处带出"运笔顿挫"的出墨不匀感
    let swell = 1;
    if (n >= 3) {
      const a = all[n - 3], b = all[n - 2], c = all[n - 1];
      const v1x = b.x - a.x, v1y = b.y - a.y;
      const v2x = c.x - b.x, v2y = c.y - b.y;
      const dot = v1x * v2x + v1y * v2y;
      const m1 = Math.hypot(v1x, v1y) || 1, m2 = Math.hypot(v2x, v2y) || 1;
      const cosA = clamp(dot / (m1 * m2), -1, 1);
      const angle = Math.acos(cosA); // 0..PI，越大转角越急
      swell = 1 + 0.45 * clamp(angle / (Math.PI * 0.6), 0, 1);
    }
    // v3.16 #36：末段窗口也过一遍急转角圆角化，与定稿渲染同一几何
    const pts = roundSharpCorners(all.slice(-4));
    const m = pts.length;
    if (n === 1) {
      ctx.beginPath();
      ctx.arc(all[0].x, all[0].y, Math.max(0.4, all[0].w / 2), 0, Math.PI * 2);
      ctx.fill();
    } else if (m === 2) {
      const w = this._wobbleWidth((pts[0].w + pts[1].w) / 2, 1, null) * swell;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.lineWidth = Math.max(0.8, w);
      ctx.stroke();
    } else {
      const a = pts[m - 3], b = pts[m - 2], c = pts[m - 1];
      ctx.beginPath();
      ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
      ctx.quadraticCurveTo(b.x, b.y, (b.x + c.x) / 2, (b.y + c.y) / 2);
      ctx.lineWidth = Math.max(0.8, this._wobbleWidth(b.w, n - 2, null) * swell);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /// 出墨不匀抖动（移植自 riddle-web）：低频正弦让墨量沿笔画微微起伏，
  /// 转角处的顿挫由调用方以 swell 倍率放大
  _wobbleWidth(baseW, idx, prevDir) {
    const slow = Math.sin(idx * 0.21) * 0.12;
    const fast = Math.sin(idx * 0.42 + (this._seedPhase || 0)) * 0.10;
    return baseW * (1 + slow + fast);
  }

  redraw() {
    this._clearAll();
    const fading = this.fadeMap.size > 0; // E6 渐隐期间逐笔透明度时变，走全量路径
    let blitted = false;
    if (!fading) {
      if (!this._cacheOk) this._rebuildCache();
      if (this._cacheOk && this._cacheCv) {
        // #37 O(1) 合成：快照按 1:1 像素贴回（经当前视口变换），不再逐笔重画
        this.ctx.drawImage(this._cacheCv, 0, 0, this._cacheCv.width, this._cacheCv.height,
          0, 0, this._cacheCv.width / this.dpr, this._cacheCv.height / this.dpr);
        blitted = true;
      }
    }
    if (!blitted) {
      this._prep(this.ctx);
      for (const s of this.strokes) drawStroke(this.ctx, s.pts, this.color, 0.97 * (this.fadeMap.get(s.id) ?? 1), 1);
    }
    if (this.current) drawStroke(this.ctx, this.current.pts, this.color, 0.97, 1);
  }

  // --------------------------------------------------------------- undo

  undo() {
    if (!this.strokes.length) return null;
    const s = this.strokes.pop();
    this._cacheOk = false;
    this.redraw();
    this.onUndo?.(s.id);
    return s.id;
  }

  /// 按 id 移除一笔（对端撤销镜像用）
  removeStrokeById(id) {
    const i = this.strokes.findIndex((s) => s.id === id);
    if (i < 0) return false;
    this.strokes.splice(i, 1);
    this._cacheOk = false;
    this.redraw();
    return true;
  }

  /// 移除最近一笔来自指定集合的笔画（对端撤销的容错路径）
  removeLastOf(ids) {
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      if (ids.has(this.strokes[i].id)) {
        this.strokes.splice(i, 1);
        this._cacheOk = false;
        this.redraw();
        return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------- erase

  /// 擦除（#42/#44 口径说明）：像素层用 destination-out 在纸面坐标上打洞
  /// （主画布 + 离屏快照同步），模型层 _forgetNear 按同样的纸面坐标半径
  /// 裁剪采样点——两层始终同口径。后续任何重绘都从"已擦除的快照"出发，
  /// 不会出现视觉已擦、模型仍在的错位。橡皮半径入参一律为纸面坐标。
  eraseAt(pos, r, remote = false) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    if (this._cacheOk && this._cacheCtx) {
      // 快照同步打洞（dpr 像素系），redraw 贴图后视觉一致
      const c = this._cacheCtx;
      c.save();
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.globalCompositeOperation = "destination-out";
      c.beginPath();
      c.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
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

  /// 上线格式：{id, pts:[[x,y,p,t]], durationMs, color, np, tip?}
  /// np=1 无压感设备（速度因子生效）；tip 出锋长度（未开自动出锋时省略）。
  /// 旧数据无这两个字段时按旧行为处理（速度因子开、无出锋）。
  /// #39 坐标量化说明：x/y 量化到 0.1 个纸面逻辑像素（VW=1000 基准），
  /// 对端按自身纸幅等比放大还原——纸面逻辑坐标与渲染 dpr 无关，
  /// dpr=3 的高清屏不丢精度；对端重放的笔宽折算（含本地/对端
  /// penScale 差异）见 room.js remoteW()。
  exportStroke(s) {
    return {
      id: s.id,
      pts: s.pts.map((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, Math.round(p.p * 100) / 100, Math.round(p.t)]),
      durationMs: s.durationMs || Math.max(1, s.pts[s.pts.length - 1]?.t || 1),
      color: this.color,
      np: s.np ? 1 : 0,
      ...(s.tip ? { tip: s.tip } : {}),
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

  /// 外部重放结果落到本地笔画模型（对端笔迹镜像）；
  /// 笔宽用与本地书写同款的顺序算法补算，重放笔画与原始手感一致。
  /// np/tip 随线上格式携带：对端无压感设备的速度因子、自动出锋两端渐细都还原。
  /// v3.16 #38：新笔画增量画入离屏快照，实时模式持续收笔不再整页重绘。
  addRemoteStroke(data, color) {
    const raw = (data.pts || []).map(([x, y, p, t]) => ({ x, y, p, t: t || 0 }));
    if (!raw.length) return;
    const np = data.np !== 0; // 旧数据无 np 字段 → 按旧行为（速度因子开）
    const tipN = Number(data.tip) || 0;
    const pts = this.widthsFor(raw, np, tipN);
    const s = { id: data.id || ++this.strokeSeq, pts, start: 0, np, tip: tipN, durationMs: data.durationMs || pts[pts.length - 1].t };
    this.strokes.push(s);
    this._cacheStroke(s);
  }

  // ------------------------------------------------------------ dissolve

  /// 手写“?”识别（移植自 riddle，阈值放宽）：
  /// 至多 4 笔；主笔高大于宽、上部有钩（横向跨度够）、起笔在上收笔在下；
  /// 其余小笔须在主笔下半区（问号下方的点）。
  /// #40：阈值比例系数取「纸高与纸宽×1.36 的较小者」并设 0.35 下限——
  /// 横屏/超宽纸面时纸高很小，系数不再无限缩小导致小涂鸦误判。
  looksLikeQuestionMark() {
    const strokes = this.strokes.map((s) => s.pts);
    if (!strokes.length || strokes.length > 4) return false;
    const k = Math.max(0.35, Math.min(this.h, this.w * 1.36) / 1872) || 1;
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

  /// 溶解动画（v3 升级，向 riddle 看齐；v3.16 性能与观感再优化）：
  /// 墨迹先整体轻化，再化作细颗粒升腾淡出。
  ///  - #56：像素采样改走缩小的离屏快照（长边 ≤900px）——dpr=3 时直接
  ///    getImageData 3000×4000 大画布会卡主线程 50–200ms，缩小后 <10ms；
  ///  - #20：粒子数动态放宽到 min(3000, 快照面积/240)，单粒子半径更小更细腻；
  ///  - #19：粒子方向由墨迹局部密度梯度反推（近似笔画局部法线），
  ///    向外散开并升腾，像被纸吸收而不是齐刷刷往上飘；
  ///  - #21：粒子 6% 起出场，与底稿淡出交叉过渡，没有"先空再爆"的空窗；
  ///  - #27：prefers-reduced-motion 时保留 200ms 极短淡入作降级反馈。
  /// 只做视觉，笔迹模型由调用方清理。
  dissolve(durMs = 900) {
    return new Promise((resolve) => {
      const cw = this.canvas.width, ch = this.canvas.height;
      if (!cw || !ch || !this.hasInk()) { resolve(); return; }

      const REDUCED = typeof matchMedia === "function" &&
        matchMedia("(prefers-reduced-motion: reduce)").matches;

      // 缩小快照：采样与底稿淡出都基于它（drawImage 自动放大回原尺寸）
      const scale = Math.min(1, 900 / Math.max(cw, ch));
      const sw = Math.max(1, Math.round(cw * scale)), sh = Math.max(1, Math.round(ch * scale));
      let snap, img;
      try {
        if (scale < 1) {
          if (typeof document === "undefined") { resolve(); return; }
          snap = document.createElement("canvas");
          snap.width = sw; snap.height = sh;
          const sc = snap.getContext("2d");
          sc.drawImage(this.canvas, 0, 0, sw, sh);
          img = sc.getImageData(0, 0, sw, sh);
        } else {
          snap = this.canvas;
          img = this.ctx.getImageData(0, 0, cw, ch);
        }
      } catch { resolve(); return; }
      const d = img.data;

      // #20 动态粒子预算：长笔画高清屏不再偏少
      const target = Math.min(3000, Math.max(300, Math.round((sw * sh) / 240)));
      const step = Math.max(1, Math.round(Math.sqrt((sw * sh) / target)));

      // 两遍扫描：一遍采点 + 建粗粒度占位网格，一遍按局部梯度定方向
      const gw = Math.ceil(sw / step), gh = Math.ceil(sh / step);
      const occ = new Uint8Array(gw * gh);
      const cand = [];
      for (let y = 0; y < sh; y += step) {
        for (let x = 0; x < sw; x += step) {
          if (d[(y * sw + x) * 4 + 3] > 40) {
            cand.push({ x, y, o: Math.min(1, d[(y * sw + x) * 4 + 3] / 235) });
            occ[((y / step) | 0) * gw + ((x / step) | 0)] = 1;
          }
        }
      }
      if (!cand.length) { this._clearAll(); resolve(); return; }

      const inv = 1 / scale; // 快照坐标 → 原画布坐标
      let pts = cand.map(({ x, y, o }) => {
        const gx = (x / step) | 0, gy = (y / step) | 0;
        const L = gx > 0 ? occ[gy * gw + gx - 1] : 0;
        const R = gx < gw - 1 ? occ[gy * gw + gx + 1] : 0;
        const U = gy > 0 ? occ[(gy - 1) * gw + gx] : 0;
        const D = gy < gh - 1 ? occ[(gy + 1) * gw + gx] : 0;
        // #19 局部密度梯度的反方向 = 离开墨团的方向（近似笔画局部法线）
        const nx = -(R - L) * 1.15 + (((x * 31 + y * 17) % 100) / 100 - 0.5) * 0.5;
        const ny = -(D - U) * 0.6 - (0.5 + ((x * 7 + y * 29) % 100) / 70); // 升腾为主
        return {
          x: x * inv, y: y * inv,
          r: (0.55 + ((x * 13 + y * 7) % 10) / 12) * step * 0.5 * inv,
          vx: nx, vy: ny, o,
        };
      });
      if (pts.length > 3000) {
        const keep = 3000 / pts.length;
        pts = pts.filter((_, i) => (i * keep) % 1 < keep);
      }

      const ctx = this.ctx;
      const ink = this.color;
      const start = performance.now();

      // #27 reduced-motion 降级：200ms 极短淡出，不升腾不爆粒子
      if (REDUCED) {
        const tickR = (nowT) => {
          const t = Math.min(1, (nowT - start) / 200);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, cw, ch);
          if (t < 1) {
            ctx.globalAlpha = 1 - t;
            ctx.drawImage(snap, 0, 0, cw, ch);
            ctx.globalAlpha = 1;
            requestAnimationFrame(tickR);
          } else { this._clearAll(); resolve(); }
        };
        requestAnimationFrame(tickR);
        return;
      }

      const tick = (nowT) => {
        const t = Math.min(1, (nowT - start) / durMs);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, cw, ch);

        // 前 62%：底稿柔和淡出（先快后慢）
        const base = Math.max(0, 1 - Math.pow(t / 0.62, 1.4));
        if (base > 0.01) {
          ctx.globalAlpha = base;
          ctx.drawImage(snap, 0, 0, cw, ch);
        }

        // #21 6% 起：粒子沿局部法线散开并升腾、缩小、淡出（错峰出场）
        const p0 = 0.06;
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
            ctx.arc(p.x + p.vx * q * 42, p.y + p.vy * q * 56, Math.max(0.35, p.r * (1 - q * 0.55)), 0, Math.PI * 2);
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

/// 分段绘制的整笔版本（复用于重放与快照构建，SPEC §3.4）；
/// v3.16 #36：先过急转角圆角化，再以 strokeSegment 逐段绘制。
export function drawStroke(ctx, pts, color, alpha = 0.97, widthScale = 1) {
  if (!pts.length) return;
  const rpts = widthScale === 1 ? roundSharpCorners(pts) : pts;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (rpts.length === 1) {
    ctx.beginPath();
    ctx.arc(rpts[0].x, rpts[0].y, Math.max(0.4, (rpts[0].w / 2) * widthScale), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  if (widthScale === 1) {
    for (let i = 0; i < rpts.length - 1; i++) strokeSegment(ctx, rpts, i, null);
  } else {
    // 宽度缩放路径（保留旧行为）：按比例折算线宽
    ctx.beginPath();
    ctx.moveTo(rpts[0].x, rpts[0].y);
    ctx.lineTo((rpts[0].x + rpts[1].x) / 2, (rpts[0].y + rpts[1].y) / 2);
    ctx.lineWidth = Math.max(0.8, ((rpts[0].w + rpts[1].w) / 2) * widthScale);
    ctx.stroke();
    for (let i = 1; i < rpts.length - 1; i++) {
      const a = rpts[i - 1], b = rpts[i], c = rpts[i + 1];
      ctx.beginPath();
      ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
      ctx.quadraticCurveTo(b.x, b.y, (b.x + c.x) / 2, (b.y + c.y) / 2);
      ctx.lineWidth = Math.max(0.8, b.w * widthScale);
      ctx.stroke();
    }
  }
  ctx.restore();
}
