// PaperLink InkPad — 手写引擎（嫁接自 Riddle inkpad.js，SPEC §3.4）
// Pointer Events 主 + 压感/速度调制；提供 撤销(undo) / 逐点回调(书写流) /
// 逐笔回调(提交) / 溶解动画 / 同速重放所需的时间戳 /
// v4.1 手势改版：一指书写；双指 = 平移/缩放页面（捏合手势，取消原三指视口
// 手势与双指橡皮——橡皮统一走工具按钮，误触率更低、语义更符合直觉）。
//
// v3.16 渲染管线升级：
//  - 离屏缓存（_cacheCv）：定稿笔画快照一次绘制、redraw 时 O(1) 贴图，
//    长信重绘与实时模式对端持续收笔不再整页逐笔重画（优化意见 #37/#38）；
//  - 急转角圆角化（roundSharpCorners）+ 公共分段绘制（strokeSegment），
//    本地书写 / 对端镜像 / 信件重放三处同一套几何，杜绝漂移（#36/#49）；
//  - 压感响应曲线可配置（笔锋响应：linear / quad / pow，管理页参数，#33）；
//  - 压感源归一化：部分安卓触控笔上报 0–1024 等非 0–1 范围（#35）。
// v4.1 压感/速度修复：
//  - #24 压感量程自适应：自动识别 0–255 / 0–1024 / 0–4096 上报量程并归一，
//    大量「支持压感却看不到粗细变化」的设备源于量程误判被顶到端点；
//  - #25 合并事件压感兜底：getCoalescedEvents 的子事件在部分浏览器上
//    pressure 恒为 0，回退用父事件压感，避免整笔退化成恒定 0.5；
//  - #28 速度因子采样窗：dt<8ms 的密集采样不再产生瞬时速度尖峰
//    （原 dt 下限 1ms 导致快写时笔宽抖动、粗细乱跳）。
// v4.41 压感兜底再加固（iOS 与部分设备「压感失效」）：
//  - WebKit 的 PointerEvent 压感在部分设备没接通（Pencil 恒 0/0.5）——
//    同步采集 TouchEvent.force/webkitForce 作为第二压感源；
//  - 死压感检测：pen 笔画整笔原始读数纹丝不动 → 判定传感器没接通，
//    该笔自动转速度模型，粗细恢复动态而不是死等宽。
// v4.41 笔宽改「纸面恒定」模型（修「放大书写、缩小后糊成一坨」）：
//  - 落笔时把视口倍数折进笔宽（zs = 1/view.s），渲染不再按视口折算——
//    放大写的字缩小后像真实墨迹一样等比变小、保持清晰，不再相对变粗。

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
// v4.17：双指手势的语义是「局部放大镜」而不是「改信纸大小」——
// 只允许放大在纸框内看细节，回到 100% 时平移归零，
// 整张信纸永远占满原纸框：怎么捏怎么移，信纸面积观感恒定不变。
// v4.22 曾放到 600%；v4.24 按使用反馈定为 500%；
// v4.42 上限按模式分档：寄信 600%、实时镜像 800%（实例属性 viewSMax，
// 由页面在模式切换时设置）；VIEW_S_MAX 是任何模式都不得越过的硬顶。
export const VIEW_S_MIN = 1;
export const VIEW_S_MAX = 8;
export const VIEW_S_MAX_LETTER = 6;
/// v4.22：速度归一参考速度（纸幅宽/秒）——达到即视为"最快档"，对应最细笔宽
export const SPEED_V_REF = 2;

// v4.31：手势收尾的"防吞笔"参数。放大后捏合频繁，收尾状态没清干净就会让
// 之后落的笔被判成手势/冷却而被整段丢弃（用户表现为"写到最大就写不出字"）。
export const COOL_MAX_MS = 240;       // 冷却最长窗口：等满即认定剩余手指是在书写
export const COOL_MOVE_PX = 14;       // 剩余手指走出这么多屏幕像素 = 明确要写，立刻起笔
export const COOL_MIN_MOVE_PX = 4;    // 低于此位移视为抬手抖动，仍然不落墨
export const STALE_POINTER_MS = 350;  // 这么久没上报事件的指针 = 幽灵手指，落笔前清掉

// v4.30：wScale = 线宽折算系数（保底 #50 同样乘 wScale，最细的笔不被保底顶粗）。
// v4.41：笔宽改「纸面恒定」模型——视口倍数在落笔时已折进 pt.w（zs），
// 各渲染路径统一传 wScale=1；wScale 机制保留给自检页/特殊折算场景使用。
// floorW = 保底线宽（纸面单位），保底的本义是「屏幕上不少于 0.8 CSS px」——
// 纸面恒定模型下调用方传 0.8/视口倍数，放大书写时细笔不被保底顶粗、
// 缩小回看时亚像素细线也不被抗锯齿吞掉；缺省 0.8×wScale（旧口径）。
export function strokeSegment(ctx, pts, i, ink, wScale = 1, floorW = null) {
  const fl = floorW != null ? floorW : 0.8 * wScale;
  if (ink) { ctx.strokeStyle = ink; ctx.fillStyle = ink; }
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  if (i === 0) {
    if (pts.length === 1) {
      ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, Math.max(fl / 2, (pts[0].w / 2) * wScale), 0, Math.PI * 2); ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
    ctx.lineWidth = Math.max(fl, ((pts[0].w + pts[1].w) / 2) * wScale);
    ctx.stroke();
  } else if (i < pts.length - 1) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    ctx.beginPath();
    ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
    ctx.quadraticCurveTo(b.x, b.y, (b.x + c.x) / 2, (b.y + c.y) / 2);
    ctx.lineWidth = Math.max(fl, b.w * wScale);
    ctx.stroke();
  }
}

/// v4.32：把一条笔画按「宽度近似恒定」切成若干 run。同一 run 用一条路径一次描完——
/// 逐段描线时相邻段的圆头互相叠盖，叠盖处因 alpha<1 会留下深浅不匀的接缝，
/// 笔画两侧边缘看着发毛；合并后接缝消失，draw call 也从「每点一次」降到「每 run 一次」。
/// 容差 = max(0.05, 6% × run 均值)：压感/速度带来的真实粗细变化仍会正常切段，
/// 指写这类近似等宽的笔画通常整条只切出 1–3 段。
export function widthRuns(pts, tolAbs = 0.05, tolRel = 0.06) {
  const runs = [];
  if (!pts || !pts.length) return runs;
  let i0 = 0, sum = pts[0].w || 0, n = 1;
  for (let i = 1; i < pts.length; i++) {
    const mean = sum / n;
    if (Math.abs((pts[i].w || 0) - mean) > Math.max(tolAbs, tolRel * mean)) {
      runs.push({ i0, i1: i - 1, w: mean });
      i0 = i; sum = pts[i].w || 0; n = 1;
    } else { sum += pts[i].w || 0; n++; }
  }
  runs.push({ i0, i1: pts.length - 1, w: sum / n });
  return runs;
}

/// v4.32：按 run 描一条笔画。几何与逐段 strokeSegment 完全同口径
/// （起点 → mid(p0,p1) → 二次曲线链 → mid(p_{n-2},p_{n-1})，末端靠 round cap 收口；
/// run 之间从上一个中点起画，半采样步的重叠由圆头盖住，不会留缺口），
/// 只是把等宽部分合并成一条路径。
export function strokeRuns(ctx, pts, ink, wScale = 1, floorW = null) {
  if (!pts || !pts.length) return;
  const fl = floorW != null ? floorW : 0.8 * wScale; // v4.41：保底屏幕恒定（见 strokeSegment 注释）
  if (ink) { ctx.strokeStyle = ink; ctx.fillStyle = ink; }
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, Math.max(fl / 2, (pts[0].w / 2) * wScale), 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const mid = (i) => ({ x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 });
  for (const r of widthRuns(pts)) {
    if (r.i0 >= pts.length - 1) continue;        // 末点不单独立段：与逐段描线同口径，靠圆头收口
    const last = Math.min(r.i1, pts.length - 2);  // 段内最后一段的起点上限
    const A = r.i0 > 0 ? mid(r.i0 - 1) : pts[0];
    ctx.beginPath();
    ctx.lineWidth = Math.max(fl, r.w * wScale);
    ctx.moveTo(A.x, A.y);
    for (let i = r.i0; i <= last; i++) {
      const B = mid(i);
      if (i === 0) ctx.lineTo(B.x, B.y);
      else ctx.quadraticCurveTo(pts[i].x, pts[i].y, B.x, B.y);
    }
    ctx.stroke();
  }
}

export class InkPad {
  constructor(canvas) {
    this.canvas = canvas;
    // v4.37：不再开 willReadFrequently——它会让整块主画布退回 CPU 后端，
    // 16M 像素级的快照贴回与行笔重画全部变慢（移动端书写卡顿的主因之一）。
    // 唯一需要读像素的 dissolve 兜底路径改走临时画布（见 dissolve）
    // v4.46 低延迟画布：desynchronized 让笔迹直接进前缓冲合成，省掉一整个
    // 「等页面合成器对齐 vsync」的排队周期——Chrome/Android 上是指尖到墨迹
    // 延迟的最大单项来源。不支持的浏览器自动忽略该提示，无副作用；
    // 需要读像素的路径（dissolve/快照导出）本就走临时画布拷贝，不受影响。
    this.ctx = canvas.getContext("2d", { desynchronized: true });
    this.strokes = [];          // {id, pts:[{x,y,p,t,w}], start}
    this.current = null;
    this.pointers = new Map();
    this.eraseTool = false;
    this.erasing = false;
    this._gesture = null;       // v4.1 双指视口手势状态 {midX, midY, dist, view}
    this._gestureActive = false; // v4.28：手势进行中标记——期间快照只缩不放、不重建（免卡顿）
    this._gestureCooling = false; // 手势收尾冷却：只挡抬手抖动短线（v4.31 起不再吞整笔）
    this._coolPt = null;          // v4.31：冷却起点处剩余手指的屏幕位置
    this._coolAt = 0;             // v4.31：冷却起始时刻
    this.onStrokeBegin = null;    // v4.31：中途起笔（冷却解除）时通知页面补落笔反馈
    this._vWf = 1;              // 速度调制当前宽度因子
    this._vAcc = { d: 0, t: 0 }; // v4.18 速度采样累加器（合并事件/高刷攒够窗口才更新）
    this._vSpeed = 0;           // v4.18 纸幅归一速度 EMA（幅宽/秒，跨设备可比）
    this._pRawMax = 1;          // v4.1 #24 压感原始量程探测（>1 上报的设备）
    this.color = "#241812";
    this.minW = 0.6;            // 压感最细笔迹（0.2–3，管理页可调）
    this.maxW = 2.4;            // 压感最粗笔迹（0.2–3，管理页可调）
    this.pressureCurve = "pow"; // v3.16 #33 笔锋响应曲线：pow(p^1.4) / linear / quad，管理页参数
    this.eraseR = 18;           // 橡皮半径（长按滑条可调）——v4.32 起以屏幕像素为准
    this.eraseMode = "pixel";   // v4.50 整笔橡皮："pixel" 涂抹 | "stroke" 点哪笔删哪笔
    this.onStrokeErased = null; // v4.50：(stroke) → 整笔擦除上报（页面据此同步/进重做栈）
    this.onPredict = null;      // v4.50 iOS 笔迹预测：(pts|null) → 预测尾迹上屏/清空
    this._rectCache = null;     // v4.32：画布矩形缓存（落笔时刷新）
    this._tailRaf = 0;          // v4.32：行笔上屏的 rAF 句柄
    this._tailFrom = null;      // v4.32：上次上屏后最早未画的点序号
    this.penScale = 1;
    this.strokeScale = 1;       // 整体笔画缩放（移植自 riddle-web 的 widthFor 因子）
    this.widthCap = 6;          // v4.62：前台可调笔宽上限（纸面单位≈100% zoom 屏幕 px）
    this.densify = true;        // v4.62：稀疏采样加密开关（headless 测试可关，保持逐输入点语义）
    this.smooth = 0.35;         // v3.15 防抖平滑度（0.1–0.8，管理页参数）：越大越顺滑
    // v4.22：速度灵敏度改为与压感同款的「最细/最粗」直调（0.2–3，管理页可调）——
    // 快写趋近 speedMinW、慢写趋近 speedMaxW；不再是 0–0.5 的抽象力度系数
    this.speedMinW = 0.8;
    this.speedMaxW = 2.0;
    this.speedAll = false;      // v3.32 速度因子全局响应（管理页开关）：开启后与压感同时生效
    this.tipOn = false;         // v3.15 自动出锋开关（起笔/收笔渐细，状态存浏览器）
    this.tipN = 8;              // 出锋灵敏度：起收两端各渐变的采样点数（2–40，越高越尖细）
    this._lastRaw = null;       // 最近一次原始输入点（收笔时补偿平滑滞后用）
    this.w = 0; this.h = 0; this.dpr = 1;
    this.strokeSeq = 0;
    this.view = { x: 0, y: 0, s: 1 }; // 视口：双指平移/缩放（仅本地，不参与同步）
    this.viewSMax = VIEW_S_MAX_LETTER; // v4.42：当前模式的放大上限（镜像 8 / 寄信 6），页面切换模式时改
    this.onViewChange = null; // v4.17 (view) → 双指缩放/复位时通知上层（缩放百分比浮提示等）
    this.fadeMap = new Map();   // strokeId → alpha（E6 墨迹渐隐彩蛋）
    // v4.48 逐笔墨色：每笔在落笔瞬间记住自己的墨（颜色/渐变/透明度），
    // 换色只影响之后的新笔——同一页可以写多种颜色。inkTag 是页面层挂的
    // 同步标签（白笺墨盘选择值 iv），随笔画导出给对端/存档。
    this.inkTag = null;
    this._patterns = new Map(); // 渐变色表 key → CanvasPattern（锚定当前纸幅）
    // v3.16 #37 离屏缓存：定稿笔画画在 _cacheCv，redraw 只贴图 + 画进行中笔画。
    // 结构变化（撤销/擦除模型变更/换色/重排）时 _cacheOk 置假、下次 redraw 重建。
    // v4.22：缓存分辨率跟随缩放（_cacheQVal = dpr×zoom，受 16M 像素预算钳制）——
    // 此前缓存恒为 dpr 像素系，放大时整张快照被拉大贴回，定稿笔画边缘发锯齿。
    this._cacheCv = null;
    this._cacheCtx = null;
    this._cacheOk = false;
    this._cacheS = 1;           // 建快照时的视口倍数
    this._cacheQVal = 1;        // 建快照时的像素倍率（纸面单位 → 缓存像素）
    // v3.99 渐变笔迹：模板 CSS 声明 --ink-gradient → 笔画用静态多径向色块渐变（riddle 风格）
    this.inkGradColors = null;  // 声明的颜色数组；null = 单色墨
    this._inkPattern = null;    // 锚定纸面的渐变图案缓存（尺寸/主题变化时作废）
    this.onStrokeEnd = null;    // (stroke) → 发送/提交
    this.onLiveChunk = null;    // (strokeId, ptsChunk) → 逐点流
    this.onUndo = null;
    this.onEraseAt = null;
    this.onGestureStart = null; // (cancelledStrokeId|null) → 双指手势打断了进行中的笔画
    // v4.41 iOS 压感第二来源：WebKit 上 PointerEvent.pressure 可能没接通
    // （Apple Pencil 恒 0/0.5），但 TouchEvent 的 force/webkitForce 有真压感。
    // touchstart 先于 pointerdown 到达，按触点 identifier 记一份，_addPoint 取用。
    this._touchForces = new Map(); // identifier → 归一压感 (0,1]
    if (typeof canvas?.addEventListener === "function") {
      const forceOf = (t) => {
        const f = Number(t.force) || 0;
        if (f > 0) return Math.min(1, f);          // Pencil/3D Touch：force 已归一 0–1
        const wf = Number(t.webkitForce) || 0;
        return wf > 1 ? Math.min(1, (wf - 1) / 2) : 0; // 老 3D Touch 口径 1–3 → 0–1
      };
      const grab = (ev) => {
        for (const t of ev.changedTouches || []) {
          const v = forceOf(t);
          if (v > 0) this._touchForces.set(t.identifier, v);
        }
      };
      const drop = (ev) => {
        for (const t of ev.changedTouches || []) this._touchForces.delete(t.identifier);
      };
      canvas.addEventListener("touchstart", grab, { passive: true });
      canvas.addEventListener("touchmove", grab, { passive: true });
      canvas.addEventListener("touchend", drop, { passive: true });
      canvas.addEventListener("touchcancel", drop, { passive: true });
    }
  }

  resize(w, h, dpr) {
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this._cacheOk = false; // 画布尺寸变化，快照作废
    this._rectCache = null; // v4.32：画布尺寸/位置变了，矩形缓存作废
    this._inkPattern = null; // v3.99：纸面尺寸变了，渐变图案跟着重建
    this._patterns.clear();  // v4.48：逐笔渐变图案同样锚定纸幅，尺寸变了全部重建
    this.redraw();
  }

  /// v4.48：recolor=true（默认，换信纸等"整页墨色跟着走"的场景）把已有笔画
  /// 全部重染成 c；recolor=false（白笺墨盘换色）只改"下一笔用什么墨"，
  /// 已写的字保持各自落笔时的颜色——同页多色的根基。
  setColor(c, recolor = true) {
    this.color = c;
    if (!recolor) return;
    for (const s of this.strokes) {
      if (!s.ink) s.ink = { c, g: null }; else { s.ink.c = c; s.ink.g = null; }
      s.iv = null;
    }
    this.inkTag = null;
    this._cacheOk = false;
    this.redraw();
  }

  /// v3.99 渐变笔迹：模板 CSS 在 .page-paper 上声明 `--ink-gradient: 色1, 色2, ...`，
  /// 引擎即把真实笔画渲染成锚定纸面的「多径向色块渐变」（riddle 同款，静态不流动）；
  /// 传 null/少于两色 → 还原单色墨。基色 this.color 不变（同步/存档仍用它）。
  setInkGradient(colors, recolor = true) {
    const list = Array.isArray(colors) ? colors.filter((c) => typeof c === "string" && c.trim()).slice(0, 24) : [];
    this.inkGradColors = list.length >= 2 ? list : null;
    this._inkPattern = null;
    if (!recolor) return; // v4.48：只影响新笔（白笺墨盘换渐变色）
    for (const s of this.strokes) {
      if (!s.ink) s.ink = { c: this.color, g: null };
      s.ink.g = this.inkGradColors ? this.inkGradColors.slice() : null;
      s.iv = null;
    }
    this.inkTag = null;
    this._cacheOk = false;
    this.redraw();
  }
  hasInkGradient() { return !!this.inkGradColors; }

  /// v4.48：渐变色表 → 锚定纸面的图案（按色表+纸幅缓存；非浏览器环境返回 null）
  _patternFor(colors) {
    if (!Array.isArray(colors) || colors.length < 2) return null;
    const key = colors.join(",") + "|" + this.w + "x" + this.h;
    if (this._patterns.has(key)) return this._patterns.get(key);
    let pat = null;
    if (typeof document !== "undefined" && this.w > 2 && this.h > 2) {
      const scale = Math.min(2, this.dpr || 1);
      const cv = makeInkGradientCanvas(this.w * scale, this.h * scale, colors);
      if (cv) {
        pat = this.ctx.createPattern(cv, "no-repeat");
        // 高分辨率底图缩回纸面坐标系；老浏览器没有 setTransform 就接受稍软一点
        if (pat && scale !== 1 && typeof DOMMatrix === "function" && pat.setTransform) {
          try { pat.setTransform(new DOMMatrix().scaleSelf(1 / scale)); } catch { /* ok */ }
        }
      }
    }
    this._patterns.set(key, pat);
    return pat;
  }

  /// 页面层（room.js 重放/预览）借用同一份图案缓存渲染逐笔渐变
  inkPatternFor(colors) { return this._patternFor(colors) || this.color; }

  /// 当前墨（新笔用）：渐变图案优先，缺失时落回单色
  inkFill() {
    if (this.inkGradColors) {
      const pat = this._patternFor(this.inkGradColors);
      if (pat) return pat;
    }
    return this.color;
  }

  /// v4.48：某一笔实际落纸的样式——用它自己记住的墨（落笔瞬间的颜色/渐变/
  /// 透明度）；没有 ink 记录的旧数据笔画回落到当前墨
  _strokeFill(s) {
    const ink = s && s.ink;
    if (!ink) return this.inkFill();
    if (ink.g && ink.g.length >= 2) {
      const pat = this._patternFor(ink.g);
      if (pat) return pat;
    }
    return ink.c || this.color;
  }

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
    this._gesture = null;
    this._gestureCooling = false;
    this._vWf = 1;
    this._vAcc = { d: 0, t: 0 };
    this._vSpeed = 0;
    this._cacheOk = false;
    this.inkTag = null; // v4.48：新一页从"跟随当前信纸墨色"开始
    this._clearAll();
  }

  /// 视口复位（双击工具区等场景可调用）
  resetView() {
    this.view = { x: 0, y: 0, s: 1 };
    this.redraw();
    this.onViewChange?.(this.view); // v4.17：复位也报一次（浮提示回 100%）
  }

  /// 当前视口变换（双指平移/缩放的结果）
  _applyView() {
    const v = this.view;
    this.ctx.setTransform(this.dpr * v.s, 0, 0, this.dpr * v.s, this.dpr * v.x, this.dpr * v.y);
    // v4.60：行笔中视口变了 → 离屏层按新变换整笔重画（层与主画布必须同变换）
    if (this._layerOn && this._layerCtx && this.current) {
      this._ensureInkLayer();
      const lc = this._layerCtx;
      lc.setTransform(1, 0, 0, 1, 0, 0);
      lc.clearRect(0, 0, this._layerCv.width, this._layerCv.height);
      lc.setTransform(this.ctx.getTransform());
      drawStrokeRaw(lc, this.current.pts, this._layerInk, 1, 1, this._floorW());
    }
  }

  /// v4.60：行笔离屏层尺寸跟随主画布（分辨率/尺寸变化时重建）
  _ensureInkLayer() {
    if (typeof document === "undefined") return;
    if (!this._layerCv) this._layerCv = document.createElement("canvas");
    const cw = this.ctx.canvas.width, ch = this.ctx.canvas.height;
    if (!cw || !ch) { this._layerCtx = null; return; }
    if (this._layerCv.width !== cw || this._layerCv.height !== ch) {
      this._layerCv.width = cw; this._layerCv.height = ch;
    }
    if (!this._layerCtx) this._layerCtx = this._layerCv.getContext("2d");
  }

  /// #43 视口钳制：无论如何平移缩放，纸面至少保留约 1/4 幅面在画布内，
  /// 不会整个跑出屏幕外找不回（三指手势每帧调用）
  _clampView() {
    if (!this.w || !this.h) return;
    const v = this.view;
    // v4.17：100% 就是完全复位——不留残余平移，信纸始终占满原纸框
    if (v.s <= VIEW_S_MIN + 0.001) { v.x = 0; v.y = 0; v.s = VIEW_S_MIN; return; }
    const pw = this.w * v.s, ph = this.h * v.s;
    // v4.34：放大后信纸必须始终铺满画布。此前允许把纸推到露出最多 75% 画布的
    // 空白（"纸面至少留 1/4 在画布内"的旧口径），双指一滑就滑到纸外不可写的
    // 区域，还能看见一条明显的纸边界——现在平移被钳在「纸刚好盖满画布」之内
    v.x = clamp(v.x, this.w - pw, 0);
    v.y = clamp(v.y, this.h - ph, 0);
  }

  _clearAll() {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._applyView();
  }

  // ------------------------------------------------- 离屏缓存（v3.16 #37）

  /// v4.22：快照像素倍率 = dpr×当前缩放（放大几倍就以几倍的分辨率建快照），
  /// 再用 16M 像素预算钳制（与 paperSize 的 dpr 回收同一上限）——
  /// 预算内放大看定稿笔画边缘干净，超预算的大纸面接受轻微软化而不是爆内存。
  _cacheQ() {
    const need = this.dpr * Math.max(1, this.view.s);
    // v4.58：弱内核（逻辑核心 ≤4 的机型，微信内嵌多为这类）快照像素预算降到 6M——
    // 千万像素级离屏画布在这类机器上光内存压力就拖帧；配合可见区贴回，清晰度损失很小
    const weak = typeof window !== "undefined" && typeof navigator !== "undefined" &&
      (navigator.hardwareConcurrency || 8) <= 4;
    const cap = Math.max(this.dpr, Math.sqrt((weak ? 6e6 : 16e6) / Math.max(1, this.w * this.h)));
    return Math.min(need, cap);
  }

  /// 缓存画布按当前倍率取像素尺寸；非浏览器环境（冒烟测试）返回 false 走全量重绘
  _ensureCache() {
    const q = this._cacheQ();
    const wantW = Math.max(1, Math.round(this.w * q));
    const wantH = Math.max(1, Math.round(this.h * q));
    if (this._cacheCv && this._cacheCv.width === wantW && this._cacheCv.height === wantH) return true;
    if (typeof document === "undefined") return false;
    if (!this._cacheCv) this._cacheCv = document.createElement("canvas");
    this._cacheCv.width = wantW;
    this._cacheCv.height = wantH;
    this._cacheCtx = this._cacheCv.getContext("2d");
    this._cacheOk = false;
    return true;
  }

  /// 全量重建定稿笔画快照（v4.22：按缩放倍率的像素系建，放大不再拉丝锯齿）
  _rebuildCache() {
    if (!this._ensureCache()) return false;
    const q = this._cacheQ();
    const c = this._cacheCtx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this._cacheCv.width, this._cacheCv.height);
    c.setTransform(q, 0, 0, q, 0, 0);
    this._prep(c);
    // v4.41：纸面恒定粗细——缩放倍数已在落笔时折进 pt.w（zs），快照直接按
    // 纸面宽度画；_cacheS 仍要记住建快照时的视口倍数（分辨率失配判定用）
    const sNow = this.view.s;
    // v4.48：快照按每笔自己的墨重建（同页多色）
    for (const st of this.strokes) drawStroke(c, st.pts, this._strokeFill(st), 0.97, 1, 0.8 / Math.max(0.01, sNow));
    this._cacheOk = true;
    this._cacheS = sNow;
    this._cacheQVal = q;
    return true;
  }

  /// 把一笔增量画进快照（抬笔落库 / 对端整笔到达时调用，避免整页重绘）
  _cacheStroke(s) {
    if (!this._cacheOk || !this._cacheCtx) return;
    const c = this._cacheCtx;
    c.save();
    c.setTransform(this._cacheQVal, 0, 0, this._cacheQVal, 0, 0);
    // v4.41：纸面恒定粗细——pt.w 已含落笔缩放折细（zs），与整页重建同口径直接画；
    // 保底按建快照时的倍数贴屏幕（与 _rebuildCache 同口径，避免增量笔被顶粗）
    drawStroke(c, s.pts, this._strokeFill(s), 0.97, 1, 0.8 / Math.max(0.01, this._cacheS || this.view.s)); // v4.48 逐笔墨色
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
  /// v3.15 速度因子（快写细、慢写粗）默认仅在无真压感的设备上生效（鼠标/触摸，
  /// np=true）；v3.32 管理页「速度因子全局响应」开启后（speedAll）与压感同时
  /// 作用于所有设备——粗细 = 压感基础宽度 × 速度调制。
  /// v4.22 速度灵敏度改为「最细/最粗」直调（与压感同款式，管理页两根滑杆）：
  ///   慢写（≈0 幅宽/秒）→ speedMaxW；快写（≥ SPEED_V_REF 幅宽/秒）→ speedMinW；中间线性过渡。
  ///   无真压感设备（np，鼠标/触摸）：速度直接决定笔宽；
  ///   有压感且开全局响应：压感基宽 × (speedW / 速度档中值)，保留压感的相对动态。
  ///   速度采样仍是累加窗 + EMA（高刷/合并事件不抖）。
  /// scale：v4.39 可指定"这一笔的书写者自己选的粗细倍率"——实时镜像里对端
  /// 的笔迹要用对方的倍率渲染（A 的笔 1.0x、B 的笔 2.5x，两端看到的一致），
  /// 缺省回落到本机 strokeScale
  widthFor(pt, prev, np = true, scale = null) {
    const useSpeed = np || this.speedAll;
    if (useSpeed && prev) {
      this._vAcc.d += Math.hypot(pt.x - prev.x, pt.y - prev.y);
      this._vAcc.t += Math.max(0, pt.t - prev.t);
      if (this._vAcc.t >= 8 && this.w > 0) {
        const v = clamp((this._vAcc.d / this.w) / (this._vAcc.t / 1000), 0, 6);
        this._vSpeed = this._vSpeed * 0.65 + v * 0.35;
        this._vAcc.d = 0;
        this._vAcc.t = 0;
      }
    }
    const p = clamp(pt.p, 0, 1);
    const fine = clamp(this.minW != null ? this.minW : 0.6, 0.2, 3.0);
    const bold = clamp(this.maxW != null ? this.maxW : 2.4, 0.2, 3.0);
    const curve = this.pressureCurve || "pow";
    const k = curve === "linear" ? p : curve === "quad" ? p * p : Math.pow(p, 1.4);
    const pressW = fine + (bold - fine) * k;
    const ss = Number.isFinite(scale) && scale > 0 ? scale : (this.strokeScale || 1); // v4.39
    // v4.62：笔宽上限 6（前台滑条拉满即到 6px@100%），超出部分钳掉
    if (!useSpeed) return Math.min(2 * this.penScale * ss * pressW, this.widthCap || 6);
    const sMin = clamp(this.speedMinW != null ? this.speedMinW : 0.8, 0.2, 3.0);
    const sMax = clamp(this.speedMaxW != null ? this.speedMaxW : 2.0, 0.2, 3.0);
    const vN = clamp(this._vSpeed / SPEED_V_REF, 0, 1);
    const speedW = sMax + (sMin - sMax) * vN; // 慢→粗、快→细
    const wUnits = np ? speedW : pressW * (speedW / Math.max(0.2, (sMin + sMax) / 2));
    return Math.min(2 * this.penScale * ss * wUnits, this.widthCap || 6);
  }

  /// 按书写同款算法顺序补算笔宽（对端笔迹落库 / 信件重放用）。
  /// np：是否无压感设备（速度因子仅此时生效；旧数据无标记 → 沿用旧行为）；
  /// tipN：出锋长度，>0 时对起收两端做渐细包络。
  widthsFor(pts, np = true, tipN = 0, scale = null) {
    let prev = null;
    // v4.18：速度调制状态按笔画重置（重放/落库同一口径）
    this._vWf = 1;
    this._vAcc = { d: 0, t: 0 };
    this._vSpeed = 0;
    // v4.62：稀疏采样先加密——快写时相邻采样点间距大，中点二次曲线链 + 逐段
    // 宽度会在轮廓上留下「波浪边」；按间距线性内插至多 2 个中间点（p/t 同插），
    // 老信件重放/落库补算同路径受益。记录端 _addPoint 同款阈值，新信不重复加密。
    const dense = [];
    for (const p of pts) {
      if (prev) {
        const d = Math.hypot(p.x - prev.x, p.y - prev.y);
        const steps = this.densify === false ? 0 : Math.min(2, Math.floor(d / 9));
        for (let k = 1; k <= steps; k++) {
          const f = k / (steps + 1);
          dense.push({
            x: prev.x + (p.x - prev.x) * f, y: prev.y + (p.y - prev.y) * f,
            p: (prev.p ?? 0.5) + ((p.p ?? 0.5) - (prev.p ?? 0.5)) * f,
            t: (prev.t || 0) + ((p.t || 0) - (prev.t || 0)) * f,
          });
        }
      }
      dense.push(p);
      prev = p;
    }
    prev = null;
    for (const pt of dense) {
      pt.w = this.widthFor(pt, prev, np, scale);
      if (prev) {
        // v4.62：宽度 EMA 强度随行笔速度——快写加平滑（0.35），慢写保持跟手（0.6）
        const k = 0.6 - 0.25 * clamp(this._vSpeed / SPEED_V_REF, 0, 1);
        pt.w = prev.w * (1 - k) + pt.w * k;
      }
      prev = pt;
    }
    if (tipN > 0) this.applyTipEnvelope(dense, tipN);
    return dense;
  }

  /// v3.15 自动出锋：笔画起笔端前 N 个采样点从最细笔宽（minSize）过渡到
  /// 计算值，收笔端末尾 N 个从计算值过渡到 minSize；过渡曲线用 smoothstep
  /// 缓动 t²(3-2t)，与正常行笔段衔接处无粗细突变。
  /// v3.32 出锋灵敏度上限提到 40：灵敏度越高，两端的「尖」越彻底——
  /// 端点目标宽度向针尖收缩（最低至最细笔宽的 38%），过渡曲线同步变陡，
  /// 落笔起得更细、收笔收尾更尖。
  applyTipEnvelope(pts, tipN) {
    const len = pts.length;
    if (len < 4) return; // 太短的笔画不做渐变，避免整体变细
    const N = Math.min(tipN, Math.floor(len / 3)); // 两端最多各占 1/3，互不重叠
    if (N < 2) return;
    const fine = clamp(this.minW != null ? this.minW : 0.6, 0.2, 3.0);
    const sharp = clamp(tipN / 40, 0, 1); // v3.32：以新上限 40 归一的灵敏度档位
    const tipFine = Math.max(0.12, fine * (1 - 0.62 * sharp)); // 满灵敏度端点宽度≈最细笔宽的 38%
    const minSize = 2 * this.penScale * this.strokeScale * tipFine;
    const smooth = (t) => t * t * (3 - 2 * t);
    const ease = (t) => Math.pow(smooth(t), 1 + 0.9 * sharp); // 灵敏度越高，贴端处保持细的时间越长
    for (let i = 0; i < N; i++) {
      const k = ease((i + 1) / N); // 0→1：越靠近行笔段越接近原宽度
      const head = pts[i], tail = pts[len - 1 - i];
      head.w = minSize + (head.w - minSize) * k;
      tail.w = minSize + (tail.w - minSize) * k;
    }
  }

  /// 屏幕坐标（相对画布左上）
  /// v4.32：画布矩形缓存。getBoundingClientRect 会触发强制回流，而它此前被
  /// 每一枚合并子事件调用一次（120Hz + 4 倍合并 = 一帧四次回流），在带毛玻璃/
  /// 光晕层的页面上单次就要几毫秒，直接表现为笔尖跟不上手。
  /// 落笔瞬间读一次真值，行笔期间复用；尺寸/滚动/视口变化由页面调 invalidateRect。
  invalidateRect() { this._rectCache = null; }

  toLocal(e) {
    let r = this._rectCache;
    if (!r) {
      const b = this.canvas.getBoundingClientRect();
      r = this._rectCache = { left: b.left, top: b.top };
    }
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /// v4.32：橡皮作用半径（纸面单位）。滑条调的 eraseR 是"屏幕上多大"，
  /// 放大后纸面半径等比缩小——擦除范围跟着屏幕走，不再跟着信纸一起放大
  /// （此前放大 5 倍时橡皮在屏幕上变成 5 倍大，一擦就抹掉一片）。
  eraseRadius() { return this.eraseR / Math.max(0.01, this.view.s); }

  /// 屏幕坐标 → 纸面坐标（经过视口平移/缩放折算）
  toPaper(e) {
    return this.screenToPaper(this.toLocal(e));
  }

  /// v4.31：已知的屏幕点（相对画布）直接折算，不需要事件对象
  screenToPaper(p) {
    return { x: (p.x - this.view.x) / this.view.s, y: (p.y - this.view.y) / this.view.s };
  }

  /// v4.31：清"幽灵手指"——画布漏收 pointerup（手指划出画布、浏览器接管手势、
  /// 切后台、系统手势打断）会让旧指针永远留在表里，此后每次落笔都被判成
  /// "第二指"进手势，整段书写被静默吞掉，且不会自愈。真在捏合的手指每帧都
  /// 上报事件不会被误清；纹丝不动的手掌/残留手指才清。
  pruneStalePointers(now = performance.now()) {
    let pruned = 0;
    for (const [id, rec] of [...this.pointers]) {
      if (now - (rec.last || rec.at || now) > STALE_POINTER_MS) { this.pointers.delete(id); pruned++; }
    }
    // 手势被清到只剩一指以下 → 手势即刻收场（快照恢复清晰重建）
    if (pruned && this.pointers.size < 2 && this._gesture) {
      this._gesture = null;
      this._gestureActive = false;
      this._cacheOk = false;
    }
    return pruned;
  }

  /// v4.31：起笔（pointerdown 与"冷却期解除后继续书写"两条路径共用同一套初始化，
  /// 免得两处字段口径漂移）
  _beginStroke(e, pos) {
    // 已有进行中的笔画又来新指针 → 先把上一笔收尾落库，绝不静默丢笔
    if (this.current) this._finalizeCurrent();
    // np：无真压感设备（鼠标/触摸）——速度因子只在这类笔画上生效，
    // 触控笔（pointerType=pen）的粗细完全交给压感
    // v4.41：触摸事件带真压感（iOS 3D Touch / Pencil 的 force）也算有压感；
    // zs：落笔时的视口倍数折进笔宽（纸面恒定粗细）；_p0/_pVaried 死压感探测
    const forceOk = this._touchForces.size > 0 && e.pointerType !== "mouse";
    this.current = {
      id: ++this.strokeSeq, pts: [], start: performance.now(),
      np: e.pointerType !== "pen" && !forceOk,
      zs: 1 / Math.max(0.01, this.view.s), // v4.41：放大书写 → 笔宽按纸面等比折细
      // v4.48：这一笔自己的墨——之后换色不影响它（同页多色）
      ink: { c: this.color, g: this.inkGradColors ? this.inkGradColors.slice() : null },
      iv: this.inkTag || null,
      _p0: null, _pVaried: false, _npFlipped: false,
    };
    // v4.18：速度调制状态按笔画重置（累加器/EMA 一并清零）
    this._vWf = 1;
    this._vAcc = { d: 0, t: 0 };
    this._vSpeed = 0;
    // v4.60：半透墨行笔改走持久离屏层（层内不透明增量画、每帧带透合成回主画布）——
    // 尾迹每帧重 cover 同一段几何，半透墨会逐帧叠深成暗斑（白笺 @透明度 的「深色点」）
    this._layerOn = false;
    {
      const fill0 = this._strokeFill(this.current);
      const a0 = inkAlphaOf(fill0);
      const tm = typeof this.ctx.getTransform === "function" ? this.ctx.getTransform() : null;
      if (a0 < 0.999 && tm) {
        this._ensureInkLayer();
        if (this._layerCtx) {
          this._layerOn = true;
          this._layerInk = solidInkOf(fill0);
          this._layerAlpha = a0;
          this._layerCtx.setTransform(1, 0, 0, 1, 0, 0);
          this._layerCtx.clearRect(0, 0, this._layerCv.width, this._layerCv.height);
          this._layerCtx.setTransform(tm);
        }
      }
    }
    this._addPoint(e, pos, e.pressure);
    return this.current;
  }

  /// v4.31：指针兜底释放——页面在 window 级也接一份 pointerup/pointercancel 调这里，
  /// 画布漏收事件时不会留下幽灵手指（已释放过的指针再调是空操作）
  releasePointer(e) {
    if (e && this.pointers.has(e.pointerId)) this.pointerUp(e);
  }

  pointerDown(e) {
    this._rectCache = null; // v4.32：落笔瞬间取一次真值（每笔一次，代价可忽略）
    const sPos = this.toLocal(e);
    const now = performance.now();
    this.pruneStalePointers(now);
    this.pointers.set(e.pointerId, { ...sPos, at: now, last: now });
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ok */ }

    // v4.1：第二根手指落下 → 双指视口手势（平移 + 捏合缩放）。
    // 进行中的笔画被打断并通知上层（实时模式下对端丢弃半截轨迹）。
    if (this.pointers.size === 2) {
      const cancelled = this.current ? this.current.id : null;
      this.current = null;
      this.erasing = false;
      this.onGestureStart?.(cancelled);
      this._startGesture();
      return "gesture";
    }

    // 第三指及以上：忽略（手势只用前两指；手掌误触兜底）
    if (this.pointers.size > 2) return "rest";

    const pos = this.toPaper(e);

    // v4.31：新手指明确落下 = 用户要写字/擦字，冷却立即作废（此前冷却会一路
    // 挡到抬笔，把这一整笔吞掉）
    this._gestureCooling = false;

    if (this.eraseTool || this.erasing) {
      this.erasing = true;
      this._eraseDispatch(pos, this.eraseRadius());
      return "erase";
    }

    this._beginStroke(e, pos);
    return "draw";
  }

  /// v4.1 双指视口手势初始化：以当前两指重心/间距为锚
  _startGesture() {
    this._gestureActive = true; // v4.28：手势期间快照延迟重建
    const pts = [...this.pointers.values()].slice(0, 2);
    const midX = (pts[0].x + pts[1].x) / 2;
    const midY = (pts[0].y + pts[1].y) / 2;
    const dist = Math.max(12, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
    this._gesture = { midX, midY, dist, view: { ...this.view } };
  }

  pointerMove(e) {
    const sPos = this.toLocal(e);
    if (this.pointers.has(e.pointerId)) {
      const prev = this.pointers.get(e.pointerId);
      // last = 最近一次上报时间（v4.31 幽灵手指判定用）；at 仍是落下时间
      this.pointers.set(e.pointerId, { ...sPos, at: prev.at, last: performance.now() });
    }

    // v4.1 双指视口手势：同移 = 平移页面，捏合/张开 = 缩放。
    // v4.17 语义收紧为「局部放大镜」：只许放大（1x–4x），捏到 1x 以下不缩小信纸
    // 而是直接回到完全复位（平移归零）——信纸面积观感恒定，回 100% 一字不偏。
    // 锚点稳定：手势开始时重心下的纸面点始终跟住当前重心。
    if (this._gesture && this.pointers.size >= 2) {
      const pts = [...this.pointers.values()].slice(0, 2);
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      const dist = Math.max(12, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
      const g = this._gesture;
      // v4.42：上限取实例的 viewSMax（按模式分档），并受硬顶 VIEW_S_MAX 兜底
      const sMax = Math.min(Number(this.viewSMax) > 0 ? Number(this.viewSMax) : VIEW_S_MAX_LETTER, VIEW_S_MAX);
      const s = clamp(g.view.s * dist / g.dist, VIEW_S_MIN, sMax);
      if (s <= VIEW_S_MIN + 0.001) {
        this.view = { x: 0, y: 0, s: VIEW_S_MIN };
      } else {
        const px = (g.midX - g.view.x) / g.view.s;
        const py = (g.midY - g.view.y) / g.view.s;
        this.view = { s, x: midX - px * s, y: midY - py * s };
        this._clampView(); // #43 纸面不得整体跑出画布
      }
      this.redraw();
      this.onViewChange?.(this.view); // v4.17：缩放百分比浮提示的数据源
      return;
    }

    // v4.31：冷却只用来挡"抬手瞬间的抖动短线"。此前冷却期内剩余手指写的内容
    // 被整段丢弃且毫无提示（捏合放大后接着写最容易撞上，表现为"字被吞掉"）。
    // 现在：位移超过 COOL_MIN_MOVE_PX 且（走出 COOL_MOVE_PX 或等满 COOL_MAX_MS）
    // 就认定是在书写，立刻解除冷却并从当前位置起笔；纯抖动/纹丝不动仍不落墨。
    if (this._gestureCooling) {
      if (this.pointers.size > 1) return; // 又是多指 → 交回手势语义
      const rec = this.pointers.get(e.pointerId);
      if (!rec) return;
      const moved = Math.hypot(sPos.x - (this._coolPt ? this._coolPt.x : rec.x),
                               sPos.y - (this._coolPt ? this._coolPt.y : rec.y));
      const waited = performance.now() - (this._coolAt || 0);
      const writing = moved > COOL_MIN_MOVE_PX && (moved > COOL_MOVE_PX || waited > COOL_MAX_MS);
      if (!writing) return;
      this._gestureCooling = false;
      if (this.eraseTool || this.erasing) {
        this.erasing = true;
        this._eraseDispatch(this.toPaper(e), this.eraseRadius());
        return;
      }
      // 从冷却起点起笔：抬手后到解除冷却之间用户真实划过的那一段接回来，
      // 否则笔画开头会凭空少一截（写汉字时表现为缺笔）。抖动短线已被上面的
      // 位移阈值挡在门外，不会被一起接进来。
      const p0 = this._coolPt ? this.screenToPaper(this._coolPt) : null;
      this._beginStroke(e, p0 || this.toPaper(e));
      if (p0) this._addPoint(e, this.toPaper(e), e.pressure);
      this._coolPt = null;
      this.onStrokeBegin?.(this.toLocal(e), this.current); // 页面据此补落笔墨波/触感
    }

    if (this.erasing) { this._eraseDispatch(this.toPaper(e), this.eraseRadius()); return; }
    if (!this.current) return;
    const evs = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
    // v4.1 #25：coalesced 子事件在部分浏览器上 pressure 恒 0，带上父事件压感兜底
    for (const ev of evs.length ? evs : [e]) this._addPoint(ev, this.toPaper(ev), e.pressure);
    // v4.50 iOS 笔迹预测：WebKit 的 getPredictedEvents 给出「下一帧大概率到达」的
    // 前瞻采样点——画在独立预测层上先斩后奏，真迹一到即被替换（房间层负责清画）。
    // 只在真进行笔上发；不支持的内核（Chrome/安卓走 rawupdate 已够快）自动无感。
    if (this.onPredict && this.current && typeof e.getPredictedEvents === "function") {
      try {
        const pe = e.getPredictedEvents().filter((x) => x.pointerId === e.pointerId).slice(0, 4);
        this.onPredict(pe.length ? pe.map((x) => this.toPaper(x)) : null);
      } catch { this.onPredict(null); }
    }
  }

  pointerUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.onPredict && !this.pointers.size) this.onPredict(null); // v4.50：抬笔清预测尾迹
    if (this._gesture) {
      if (this.pointers.size < 2) {
        this._gesture = null;
        this._gestureActive = false;
        this._clampView();
        this._cacheOk = false; // v4.28：松手一次性重建清晰快照
        this.redraw();
        // v4.1：手势结束后仍有手指在屏 → 冷却，剩余单指不落笔，
        // 避免抬手瞬间误画短线（全部抬起后恢复正常书写）
        if (this.pointers.size > 0) {
          this._gestureCooling = true;
          // v4.31：记下冷却起点与剩余手指位置，供 pointerMove 判定"是在书写还是抬手抖动"
          const rem = [...this.pointers.values()][0];
          this._coolPt = { x: rem.x, y: rem.y };
          this._coolAt = performance.now();
        } else { this._gestureCooling = false; this._coolPt = null; this.erasing = false; }
      }
      return;
    }
    if (this._gestureCooling) {
      if (this.pointers.size === 0) { this._gestureCooling = false; this._coolPt = null; }
      // v4.31：冷却期没起过笔 → 不落任何墨（原意图保留）；已经起笔的照常收尾，
      // 不能再 return 把写好的整笔吞掉
      if (!this.current) return;
    }
    if (this.erasing && this.pointers.size === 0) this.erasing = false;
    if (this.current) this._finalizeCurrent();
  }

  _finalizeCurrent() {
    const s = this.current;
    this.current = null;
    // v4.32：定稿会整笔重画，待上屏的尾帧作废
    if (this._tailRaf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this._tailRaf);
    this._tailRaf = 0;
    this._tailFrom = null;
    if (s && s.pts.length) {
      // v3.15 平滑滞后补偿：收笔点拉回最后一枚原始输入位置，笔尖不"飘"离指尖
      if (s.pts.length > 1 && this._lastRaw) {
        const lp = s.pts[s.pts.length - 1];
        const dx = this._lastRaw.x - lp.x, dy = this._lastRaw.y - lp.y;
        if (dx * dx + dy * dy < 900) { lp.x = this._lastRaw.x; lp.y = this._lastRaw.y; }
      }
      // v4.18：先按最终量程重归一压感与笔宽，再做出锋后处理——
      // 出锋包络基于最终宽度收缩，两端渐细才与行笔段衔接
      this._renormalizePressure(s);
      // v3.15 自动出锋：抬笔即对整条笔画做后处理——起收两端渐细，
      // 并把出锋长度记在笔画上，镜像/落库/重放按同算法还原
      if (this.tipOn) { this.applyTipEnvelope(s.pts, this.tipN); s.tip = this.tipN; }
      this.strokes.push(s);
      s.durationMs = Math.max(1, s.pts[s.pts.length - 1].t);
      this._layerOn = false; // v4.60：落库后走快照合成（drawStroke 自带分层），行笔层退役
      // v3.16：出锋/最终宽度增量补进离屏缓存再贴图，不再整页重绘（#37）
      this._cacheStroke(s);
      this.redraw();
      this.onStrokeEnd?.(this.exportStroke(s));
    }
  }

  /// v4.18：压感量程连续归一。旧的 255/1024/4096 三档桶会把量程 100 的设备
  /// 压感砍到不足四成、把量程 65535 的设备直接顶死在满压——都是"支持压感却
  /// 看不出粗细变化"。改成连续除以"探测到的最大值（带 64 下限）"：任何量程
  /// 都铺满 0–1；下限只防第一枚采样把量程估成个位数，不挡小量程设备。
  _pressureScale() {
    return Math.max(this._pRawMax, 64);
  }

  /// v4.41：一笔的笔宽倍率 = 用户粗细倍率 × 落笔时的视口倍数折细（zs）。
  /// 纸面恒定模型：放大 5 倍写的字，笔宽在纸面上就是 1/5，缩小后等比还原。
  _widthScaleFor(s) {
    return (this.strokeScale || 1) * ((s && s.zs > 0) ? s.zs : 1);
  }

  /// v4.18：收笔时按最终量程把整笔压感重归一并重算笔宽——会话开头量程还没
  /// 探测开时落的笔，不会永远留着"当时估错量程"的粗细；导出/同步出去的 p
  /// 与本地最终落库完全一致，对端重放同口径。
  /// v4.41：pen 笔画整笔压感纹丝不动（传感器没接通，iOS/部分设备的"压感失效"）
  /// → 收笔改判为无压感笔画并按速度模型重算，粗细恢复动态；np 随导出同步，
  /// 对端重放同口径。
  _renormalizePressure(s) {
    const wasNp = s.np;
    if (!s.np && !s._pVaried && s.pts.length >= 8) s.np = true; // v4.41 死压感改判
    const scale = this._pressureScale();
    // v4.41：改判过就要整笔重算——包括行笔中途（第 10 点）已翻转的情况，
    // 否则前 9 点留压感等宽、之后是速度模型，收笔处有一道口径接缝
    let changed = !!s._npFlipped || s.np !== wasNp;
    for (const pt of s.pts) {
      if (pt.pr == null || pt.pr <= 1) continue;
      const target = clamp(pt.pr / scale, 0, 1);
      if (Math.abs(target - pt.p) > 1e-4) { pt.p = target; changed = true; }
    }
    // v4.50 接触面积伪压感（归一阶段）：把本笔画内的面积动态范围映射成
    // 压感曲线。逐笔画归一——单调加压不钉死满压、重按一笔不压扁下一笔；
    // 面积动态不足（恒值上报的设备）不启用，维持速度模型。
    // 生效后按"有压感"处理（np=false）：笔宽由面积压感驱动，
    // np 标记随笔画同步，对端重放/信件回放同算法还原。
    if (s._areaP && s.np && s.pts.length >= 4) {
      let mn = Infinity, mx = -Infinity, n = 0;
      for (const pt of s.pts) {
        const a = Number(pt.area) || 0;
        if (a > 1) { if (a < mn) mn = a; if (a > mx) mx = a; n++; }
      }
      if (n >= 4 && mx - mn > Math.max(4, mn * 0.12)) {
        for (const pt of s.pts) {
          const a = Number(pt.area) || 0;
          if (a > 1) pt.p = clamp(0.18 + 0.82 * ((a - mn) / (mx - mn)), 0.18, 1);
        }
        s.np = false;
        changed = true;
      }
    }
    if (!changed) return;
    let prev = null;
    this._vWf = 1;
    this._vAcc = { d: 0, t: 0 };
    this._vSpeed = 0;
    const wScale = this._widthScaleFor(s); // v4.41
    for (const pt of s.pts) {
      pt.w = this.widthFor(pt, prev, s.np, wScale);
      if (prev) {
        // v4.62：与行笔/重放同款的速度自适应 EMA（收笔重算不丢快写平滑）
        const k = 0.6 - 0.25 * clamp(this._vSpeed / SPEED_V_REF, 0, 1);
        pt.w = prev.w * (1 - k) + pt.w * k;
      }
      prev = pt;
    }
  }

  _addPoint(e, pos, fallbackPressure) {
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
    // v4.1 #25：coalesced 子事件压感恒 0 时回退父事件压感（部分安卓浏览器）。
    // v4.1 #24 压感量程自适应：非 0–1 上报（255/1024/4096 等量程）按探测到的
    // 最大值归一——此前只认 1024，其他量程的设备笔宽被顶死在端点，
    // 表现为"支持压感却看不到粗细变化"。
    let raw = Number(e.pressure);
    if (!Number.isFinite(raw)) raw = 0;
    if (raw <= 0 && fallbackPressure != null) {
      const fb = Number(fallbackPressure);
      if (Number.isFinite(fb) && fb > 0) raw = fb;
    }
    // v4.41 iOS 压感兜底：PointerEvent 压感没接通（恒 0 或恒 0.5 占位值）时，
    // 用 TouchEvent.force/webkitForce 的真压感顶上（Pencil / 3D Touch）
    const tf = this._touchForces.get(e.pointerId) || 0;
    if ((raw <= 0 || raw === 0.5) && tf > 0 && e.pointerType !== "mouse") raw = tf;
    // v4.50 接触面积伪压感（记录阶段）：触摸且真压感没接通（恒 0 / 恒 0.5）时，
    // 把触点椭圆面积记在采样点上——收笔时 _renormalizePressure 按「本笔画内」
    // 最小/最大面积归一成压感曲线。逐笔画归一而非会话级：单调加压不会钉死
    // 在满压、上一笔的重按也不会压扁下一笔的动态范围。
    let areaV = 0;
    if (e.pointerType === "touch" && (raw <= 0 || raw === 0.5)) {
      const cw = Number(e.width) || 0, ch = Number(e.height) || 0;
      areaV = cw * ch;
      if (areaV > 1 && this.current) this.current._areaP = true;
    }
    // v4.41 死压感探测：pen 笔画连续 ≥10 枚采样原始读数纹丝不动 → 传感器
    // 没接通，本笔当场转速度模型（真压感设备读数必然有 LSB 级抖动，不误伤）
    const cs = this.current;
    if (cs) {
      if (cs._p0 == null) cs._p0 = raw;
      else if (raw !== cs._p0) cs._pVaried = true;
      if (!cs.np && !cs._pVaried && cs.pts.length >= 10) { cs.np = true; cs._npFlipped = true; }
    }
    let pr = raw;
    if (pr > 1) {
      if (pr > this._pRawMax) this._pRawMax = pr;
      pr = clamp(pr / this._pressureScale(), 0, 1);
    }
    pr = clamp(pr, 0, 1);
    // v4.62：快写加密 + 速度自适应宽度 EMA——稀疏采样与逐点宽度跳变是「波浪边」的两个来源
    const ptsIn = [];
    if (prev) {
      const d = Math.hypot(pos.x - prev.x, pos.y - prev.y);
      const steps = this.densify === false ? 0 : Math.min(2, Math.floor(d / 9));
      for (let k = 1; k <= steps; k++) {
        const f = k / (steps + 1);
        ptsIn.push({ x: prev.x + (pos.x - prev.x) * f, y: prev.y + (pos.y - prev.y) * f, t: (prev.t || 0) + (t - (prev.t || 0)) * f, p: pr > 0 ? pr : 0.5, pr: raw, area: areaV });
      }
    }
    ptsIn.push({ x: pos.x, y: pos.y, t, p: pr > 0 ? pr : 0.5, pr: raw, area: areaV });
    let lastPrev = prev;
    for (const q of ptsIn) {
      const pt = { x: q.x, y: q.y, t: q.t, p: q.p, pr: q.pr };
      if (q.area > 1) pt.area = q.area; // v4.50：接触面积留底，收笔逐笔画归一（不同步、不落库）
      // v4.41：纸面恒定粗细——落笔时的视口倍数（zs）折进笔宽，渲染层不再补偿
      pt.w = this.widthFor(pt, lastPrev, this.current.np, this._widthScaleFor(this.current));
      if (lastPrev) {
        const k2 = 0.6 - 0.25 * clamp(this._vSpeed / SPEED_V_REF, 0, 1);
        pt.w = lastPrev.w * (1 - k2) + pt.w * k2; // 快写 0.35 加平滑、慢写 0.6 跟手
      }
      this.current.pts.push(pt);
      lastPrev = pt;
    }
    this._queueTail(); // v4.32：一帧一次上屏
    if (this.onLiveChunk) {
      // 逐点流：新点打包上报（节流在 room 层）
      this.onLiveChunk(this.current.id, [[pos.x, pos.y, pt.p, Math.round(t)]]);
    }
  }

  _prep(ctx) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const fill = this.inkFill(); // v3.99：模板声明了 --ink-gradient 时用多径向色块渐变
    ctx.strokeStyle = fill;
    ctx.fillStyle = fill;
  }

  /// v4.32：行笔上屏改成一帧一次（rAF 合并）。此前每枚合并子事件都立刻重画一次
  /// 尾部窗口——120Hz 设备一次 pointermove 就能触发三四次全窗口描线，白烧的时间
  /// 直接变成笔尖滞后。模型侧照旧逐点入栈，只有"上屏"合并到帧率。
  _queueTail() {
    const n = this.current ? this.current.pts.length : 0;
    this._tailFrom = this._tailFrom == null ? n - 1 : Math.min(this._tailFrom, n - 1);
    if (typeof requestAnimationFrame !== "function") { this._renderTail(); return; } // 冒烟环境
    if (this._tailRaf) return;
    this._tailRaf = requestAnimationFrame(() => { this._tailRaf = 0; this._renderTail(); });
  }

  /// v4.41：屏幕恒定的保底线宽（纸面单位）——「屏幕上不少于 0.8 CSS px」换算到
  /// 当前视口倍数。纸面恒定模型下笔宽随缩放等比放大，但保底必须始终贴在屏幕
  /// 空间（放大时不把细笔顶粗、缩小时不把亚像素细线交给抗锯齿吞掉）。
  _floorW() { return 0.8 / Math.max(0.01, this.view.s); }

  _renderTail() {
    if (!this.current) return;
    const all = this.current.pts;
    if (!all.length) return;
    const ctx = this.ctx;
    ctx.globalAlpha = 0.97;
    // v4.48：尾帧用这一笔落笔时记住的墨——行笔期间换色不串色
    const fill = this._strokeFill(this.current);
    ctx.strokeStyle = fill; ctx.fillStyle = fill;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    // v3.27 #2 断触修复：整段尾部窗口按与定稿完全相同的「圆角化 + 二次曲线链」重画，
    // 相邻帧重复覆盖同一几何，天然无断缝，抬笔前后线形/线宽口径一致。
    // v4.32：窗口至少 8 点，且必须覆盖上次上屏之后新增的所有点（rAF 合并后
    // 一帧可能攒进多点，窗口不够就会漏画那一段）。
    const pending = this._tailFrom == null ? 0 : Math.max(0, all.length - this._tailFrom);
    this._tailFrom = null;
    const win = Math.min(all.length, Math.max(8, pending + 2));
    const tail = roundSharpCorners(all.slice(-win).map((p) => ({ x: p.x, y: p.y, w: p.w })));
    if (this._layerOn && this._layerCtx) {
      // v4.60：半透墨行笔——增量段画进离屏层（不透明），再整帧合成回主画布
      const lc = this._layerCtx;
      lc.strokeStyle = this._layerInk; lc.fillStyle = this._layerInk;
      lc.lineCap = "round"; lc.lineJoin = "round";
      strokeRuns(lc, tail, null, 1, this._floorW());
      this.redraw(); // 主画布 = 快照 + 离屏层带透合成
      return;
    }
    strokeRuns(ctx, tail, null, 1, this._floorW()); // v4.41：pt.w 已含缩放折细，直接画；保底贴屏幕
    ctx.globalAlpha = 1;
  }

  redraw() {
    this._clearAll();
    const fading = this.fadeMap.size > 0; // E6 渐隐期间逐笔透明度时变，走全量路径
    let blitted = false;
    if (!fading) {
      // v4.22：缩放偏离快照倍率超过 20% → 快照作废重建（捏合过程中至多
      // 每 20% 重建一次，停手后最后一帧必然是清晰分辨率）
      // v4.28：捏合过程中快照只按旧倍率缩放贴回（略软但极快），不做全量矢量重建；
      // 松手后一次性重建到当前倍率——避免捏合时每 20% 一次的重建造成卡顿
      const mismatch = Math.abs(this.view.s - this._cacheS) / Math.max(0.001, this._cacheS) > 0.2;
      if (!this._cacheOk) this._rebuildCache();
      else if (mismatch && !this._gestureActive) this._cacheOk = false;
      if (!this._cacheOk) this._rebuildCache();
      if (this._cacheOk && this._cacheCv) {
        // #37 合成：v4.58 起只贴「视口与纸面相交的可见区」——此前整张快照贴回，
        // 放大后快照吃到像素预算上限（千万像素级），每收一笔帧都要全量搬运一次，
        // 弱内核（微信内嵌等）放大书写卡顿的根因；改为源/目标矩形按可见区裁取后，
        // 每帧开销 ≈ 屏幕像素数，与放大倍率、快照尺寸解耦
        const q = this._cacheQVal || 1;
        const vs = this.view.s || 1;
        const cw = this._cacheCv.width, ch = this._cacheCv.height;
        const px0 = Math.max(0, (0 - this.view.x) / vs), py0 = Math.max(0, (0 - this.view.y) / vs);
        const px1 = Math.min(this.w, (this.w - this.view.x) / vs), py1 = Math.min(this.h, (this.h - this.view.y) / vs);
        const sx = Math.min(cw, Math.max(0, Math.floor(px0 * q)));
        const sy = Math.min(ch, Math.max(0, Math.floor(py0 * q)));
        const sw = Math.min(cw - sx, Math.ceil(px1 * q) - sx);
        const sh = Math.min(ch - sy, Math.ceil(py1 * q) - sy);
        if (sw > 0 && sh > 0) {
          this.ctx.drawImage(this._cacheCv, sx, sy, sw, sh, sx / q, sy / q, sw / q, sh / q);
        }
        blitted = true;
      }
    }
    if (!blitted) {
      this._prep(this.ctx);
      // v4.41：纸面恒定粗细——pt.w 已含落笔缩放折细（zs），不再按视口折算；保底贴屏幕
      const fl = this._floorW();
      for (const s of this.strokes) drawStroke(this.ctx, s.pts, this._strokeFill(s), 0.97 * (this.fadeMap.get(s.id) ?? 1), 1, fl); // v4.48 逐笔墨色
    }
    if (this.current && !this._layerOn) drawStroke(this.ctx, this.current.pts, this._strokeFill(this.current), 0.97, 1, this._floorW());
    // v4.60：半透墨行笔层合成——层内不透明、合成时 alpha 只作用一次，接头/帧叠加不再叠深
    if (this._layerOn && this.current && this._layerCv) {
      this.ctx.save();
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.globalAlpha = 0.97 * (this._layerAlpha ?? 1);
      this.ctx.drawImage(this._layerCv, 0, 0);
      this.ctx.restore();
    }
  }

  /// v4.50 导出渲染：把整页定稿墨迹按指定倍率画进外部 ctx（纸面坐标系、
  /// 不受视口平移缩放影响、不走缓存）——「存为图片」用它保证逐笔多色/
  /// 透明度与屏幕完全一致。scale = 目标像素倍率（纸面单位 → 输出像素）。
  renderPageTo(ctx, scale = 2) {
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    for (const s of this.strokes) drawStroke(ctx, s.pts, this._strokeFill(s), 0.97, 1, 0.8);
    ctx.restore();
  }

  /// v3.33 信纸大预览：返回整页定稿墨迹的离屏快照（dpr 像素系、不受视口
  /// 平移缩放影响）。返回前保证缓存最新；无定稿笔画时返回 null。
  pageSnapshot() {
    if (!this.strokes.length) return null;
    if (!this._cacheOk) this._rebuildCache();
    return this._cacheOk ? this._cacheCv : null;
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

  /// v4.50：擦除分发——涂抹模式走像素橡皮；整笔模式命中即删掉整条笔画
  _eraseDispatch(pos, r) {
    if (this.eraseMode === "stroke") return this.strokeEraseAt(pos, r);
    return this.eraseAt(pos, r);
  }

  /// v4.50 整笔橡皮：以 pos 为圆心、r（纸面单位）+ 笔画自身半宽为命中半径，
  /// 从最上层（最后画的）往下找第一条命中的笔画整条删除。
  /// 删除后快照作废重建；remote=true（对端同步来的）不再回报。
  /// 返回被删的笔画（未命中返回 null），页面层据此进重做栈并广播。
  strokeEraseAt(pos, r, remote = false) {
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const st = this.strokes[i];
      let hit = false;
      for (const p of st.pts) {
        const dx = p.x - pos.x, dy = p.y - pos.y;
        const rr = r + (p.w || 0) / 2 + 2;
        if (dx * dx + dy * dy <= rr * rr) { hit = true; break; }
      }
      if (!hit) continue;
      this.strokes.splice(i, 1);
      this._cacheOk = false;
      this.redraw();
      if (!remote) this.onStrokeErased?.(st);
      return st;
    }
    return null;
  }

  /// v4.50：按 id 删「本端书写者自己写的」一笔（对端整笔擦除的镜像落点）——
  /// 与 removeStrokeById 的区别：只认数字 id 的本地笔画，不误伤 "r" 前缀远端笔
  removeLocalStrokeById(id) {
    const i = this.strokes.findIndex((s) => s.id === id);
    if (i < 0) return false;
    this.strokes.splice(i, 1);
    this._cacheOk = false;
    this.redraw();
    return true;
  }

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
      // 快照同步打洞，redraw 贴图后视觉一致。
      // v4.32：快照像素倍率自 v4.22 起是 _cacheQVal（= dpr×缩放，受内存预算钳制），
      // 不是 dpr——此前放大后擦除会把洞打在错误位置/错误大小，贴图一盖
      // 被擦掉的墨又回来了（或擦掉一块不相干的区域）
      const c = this._cacheCtx;
      const cq = this._cacheQVal || this.dpr;
      c.save();
      c.setTransform(cq, 0, 0, cq, 0, 0);
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
      color: (s.ink && s.ink.c) || this.color, // v4.48：这一笔自己的墨（可能是 rgba）
      // v4.48：白笺墨盘选择值（"" 不会出现——只有选过墨盘色的笔才带 iv）；
      // 对端镜像/存档重放按它还原渐变与透明度，旧端读 color 字段照常渲染纯色
      ...(s.iv ? { iv: s.iv } : {}),
      np: s.np ? 1 : 0,
      ...(s.tip ? { tip: s.tip } : {}),
      // v4.41：落笔时的视口倍数折细系数（zs = 1/放大倍数，100% 书写时省略）——
      // 对端镜像/存档重放按同款系数还原"放大写的字缩小后等比变细"
      ...(s.zs > 0 && Math.abs(s.zs - 1) >= 0.005 ? { zs: Math.round(s.zs * 1000) / 1000 } : {}),
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
  /// v4.48：ink 入参 = 调用端按帧/存档里的 iv 解析好的逐笔墨色 {c, g}；
  /// 缺省（旧帧无 iv）回落旧口径：color 字段 + 当前纸面若声明渐变则跟随渐变
  addRemoteStroke(data, color, ink = null) {
    const raw = (data.pts || []).map(([x, y, p, t]) => ({ x, y, p, t: t || 0 }));
    if (!raw.length) return;
    const np = data.np !== 0; // 旧数据无 np 字段 → 按旧行为（速度因子开）
    const tipN = Number(data.tip) || 0;
    // v4.39：对端笔迹按对方当时的粗细倍率渲染（ss 缺省 = 旧客户端，回落本机值）
    const ss = Number(data.ss) > 0 ? Number(data.ss) : null;
    // v4.41：对端落笔时的缩放折细系数一并还原（实时镜像帧已把 zs 折进 ss，
    // 这里主要吃存档/草稿里分开携带的 zs；缺省 1 = 旧数据或 100% 书写）
    const zs = Number(data.zs) > 0 ? Number(data.zs) : 1;
    const pts = this.widthsFor(raw, np, tipN, (ss != null ? ss : (this.strokeScale || 1)) * zs);
    const resolvedInk = ink && (ink.c || (Array.isArray(ink.g) && ink.g.length >= 2))
      ? { c: ink.c || color || this.color, g: Array.isArray(ink.g) && ink.g.length >= 2 ? ink.g.slice() : null }
      : { c: color || this.color, g: data.iv == null && this.inkGradColors ? this.inkGradColors.slice() : null };
    const s = {
      id: data.id || ++this.strokeSeq, pts, start: 0, np, tip: tipN, zs,
      durationMs: data.durationMs || pts[pts.length - 1].t,
      ink: resolvedInk, iv: typeof data.iv === "string" ? data.iv : null,
    };
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
    if (main.length < 8) return false; // v4.23：点数门槛提高，几笔凑出的碎线不再误判
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of main) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    const w = x1 - x0, h = y1 - y0;
    // v4.23 收紧：? 是高瘦形——高度门槛 120→150，高宽比 0.5→0.7，
    // 横躺的波浪线/长横线不再被当成问号
    if (h < 150 * k || w < 25 * k || h < w * 0.7) return false;
    for (let i = 0; i < strokes.length; i++) {
      if (i === mainI) continue;
      const s = strokes[i];
      let dx0 = Infinity, dy0 = Infinity, dx1 = -Infinity, dy1 = -Infinity;
      for (const p of s) {
        dx0 = Math.min(dx0, p.x); dy0 = Math.min(dy0, p.y);
        dx1 = Math.max(dx1, p.x); dy1 = Math.max(dy1, p.y);
      }
      if (Math.max(dx1 - dx0, dy1 - dy0) > 120 * k) return false;
      if ((dy0 + dy1) / 2 < y0 + h * 0.62) return false; // v4.23：点必须落在下 38% 区
      if ((dx0 + dx1) / 2 < x0 - 120 * k || (dx0 + dx1) / 2 > x1 + 120 * k) return false;
    }
    const pts = main.map((p) => [p.x, p.y]);
    if (pts[0][1] > pts[pts.length - 1][1]) pts.reverse();
    const start = pts[0], end = pts[pts.length - 1];
    // v4.23：起笔须在顶 40%、收笔须在底 45%——半截钩或只写了一竖都不算
    if (start[1] > y0 + h * 0.40 || end[1] < y0 + h * 0.55) return false;
    let topMinX = Infinity, topMaxX = -Infinity, topMaxXy = 0;
    for (const [x, y] of pts) {
      if (y <= y0 + h * 0.50) {
        if (x > topMaxX) { topMaxX = x; topMaxXy = y; }
        topMinX = Math.min(topMinX, x);
      }
    }
    if (topMaxX === -Infinity || topMaxX - topMinX < w * 0.38) return false; // v4.23：钩部横向跨度收紧
    if (topMaxXy < y0 + h * 0.04) return false;
    // v4.23：下 30% 必须是窄竖干——只有钩没有干的涂鸦，下半是斜收的宽弧
    let bMinX = Infinity, bMaxX = -Infinity;
    for (const [x, y] of pts) if (y >= y0 + h * 0.70) { bMinX = Math.min(bMinX, x); bMaxX = Math.max(bMaxX, x); }
    if (bMaxX === -Infinity || bMaxX - bMinX > w * 0.40) return false;
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
          // v4.37：小画布直读像素的兜底——主画布已是 GPU 后端，读像素前先
          // 拷进临时画布再读，不为极少数路径把主画布拖回 CPU
          if (typeof document === "undefined") { resolve(); return; }
          snap = document.createElement("canvas");
          snap.width = cw; snap.height = ch;
          const sc2 = snap.getContext("2d");
          sc2.drawImage(this.canvas, 0, 0);
          img = sc2.getImageData(0, 0, cw, ch);
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

/// v4.60：墨色透明度解析——rgba() / 8 位 hex 带 alpha；纯 hex / 渐变图案对象按不透明
export function inkAlphaOf(color) {
  if (typeof color !== "string") return 1;
  const m = /rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/i.exec(color);
  if (m) return Math.max(0, Math.min(1, Number(m[1])));
  const h = /^#(?:[0-9a-f]{6})([0-9a-f]{2})$/i.exec(color);
  if (h) return parseInt(h[1], 16) / 255;
  return 1;
}
/// v4.60：剥掉 alpha 的同色不透明版（合成层内不透明绘制用）
export function solidInkOf(color) {
  if (typeof color !== "string") return color;
  const m = /rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*[\d.]+\s*\)/i.exec(color);
  if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, 1)`;
  const h = /^#([0-9a-f]{6})[0-9a-f]{2}$/i.exec(color);
  if (h) return "#" + h[1];
  return color;
}

/// 分段绘制的整笔版本（复用于重放与快照构建，SPEC §3.4）；
/// v3.16 #36：先过急转角圆角化，再以 strokeSegment 逐段绘制。
/// v4.60：半透墨（白笺墨盘 @透明度）走「离屏层不透明画 + 一次性带透合成」——
/// 相邻段多边形在接头处互叠，不透明时看不出来，半透时每叠一次深一档，
/// 沿笔画留下一串「深色珠子」（慢笔/停笔处帧叠加更黑）。层内不透明无叠加，
/// 合成时 alpha 只均匀作用一次；离屏层按笔画 bbox 开尺寸，代价与笔画面积成正比。
export function drawStroke(ctx, pts, color, alpha = 0.97, widthScale = 1, floorW = null) {
  if (!pts.length) return;
  const a = alpha * inkAlphaOf(color);
  const m = typeof ctx.getTransform === "function" ? ctx.getTransform() : null;
  if (a >= 0.999 || !m || !ctx.canvas) {
    return drawStrokeRaw(ctx, pts, color, alpha, widthScale, floorW);
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, mw = 0;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    if (p.w > mw) mw = p.w;
  }
  if (!Number.isFinite(minX)) return drawStrokeRaw(ctx, pts, color, alpha, widthScale, floorW);
  const pad = Math.ceil(mw * Math.max(Math.abs(m.a), Math.abs(m.d), 0.001)) + 4;
  const x0 = m.a * minX + m.e, x1 = m.a * maxX + m.e;
  const y0 = m.d * minY + m.f, y1 = m.d * maxY + m.f;
  const bx = Math.floor(Math.min(x0, x1)) - pad, by = Math.floor(Math.min(y0, y1)) - pad;
  const bw = Math.ceil(Math.abs(x1 - x0)) + pad * 2, bh = Math.ceil(Math.abs(y1 - y0)) + pad * 2;
  const scv = _alphaScratchFor(bw, bh);
  if (!scv) return drawStrokeRaw(ctx, pts, color, alpha, widthScale, floorW);
  const sctx = scv.getContext("2d");
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, scv.width, scv.height);
  sctx.setTransform(m.a, m.b, m.c, m.d, m.e - bx, m.f - by);
  drawStrokeRaw(sctx, pts, solidInkOf(color), 1, widthScale, floorW);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = a;
  ctx.drawImage(scv, bx, by);
  ctx.restore();
}
let _alphaScratch = null;
function _alphaScratchFor(w, h) {
  try {
    if (typeof document === "undefined" || w <= 0 || h <= 0) return null;
    if (!_alphaScratch) _alphaScratch = document.createElement("canvas");
    if (_alphaScratch.width !== w || _alphaScratch.height !== h) { _alphaScratch.width = w; _alphaScratch.height = h; }
    return _alphaScratch;
  } catch { return null; }
}
function drawStrokeRaw(ctx, pts, color, alpha = 0.97, widthScale = 1, floorW = null) {
  if (!pts.length) return;
  const fl = floorW != null ? floorW : 0.8 * widthScale; // v4.41：保底屏幕恒定（见 strokeSegment 注释）
  // v4.32：无论是否折算线宽都做急转角圆角化——此前 widthScale≠1（= 放大查看）
  // 时跳过圆角化，放大后同一笔的转角几何与 100% 不一致，边缘看着更硬更毛
  const rpts = roundSharpCorners(pts);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (rpts.length === 1) {
    ctx.beginPath();
    ctx.arc(rpts[0].x, rpts[0].y, Math.max(fl / 2, (rpts[0].w / 2) * widthScale), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  // v4.30：widthScale 直接交给公共绘制，不再另开一份重复几何
  // v4.32：改走 run 合并描线（等宽段一条路径描完，消掉叠盖接缝）
  strokeRuns(ctx, rpts, null, widthScale, fl);
  ctx.restore();
}

/// v3.99 解析模板 CSS 的 `--ink-gradient` 声明：逗号分隔的颜色列表。
/// 只拆括号外的逗号（rgb(a,b,c) 自带逗号），至多 24 色，少于 2 色视为无效。
export function parseInkGradientDecl(v) {
  const s = String(v || "").trim();
  if (!s || s === "none") return null;
  const parts = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else { cur += ch; }
  }
  parts.push(cur);
  const colors = parts.map((x) => x.trim()).filter(Boolean).slice(0, 24);
  return colors.length >= 2 ? colors : null;
}

/// v3.99 多径向色块渐变底图（riddle 风格）：每种颜色一团软色块，沿纸面对角线
/// 上下交替排布、半径互相咬合，边缘透出底色自然交融——静态不流动。
/// 返回离屏 canvas，供调用方 createPattern(..., "no-repeat") 当落墨样式。
export function makeInkGradientCanvas(w, h, colors) {
  const cv = document.createElement("canvas");
  cv.width = Math.max(2, Math.round(w));
  cv.height = Math.max(2, Math.round(h));
  const ctx = cv.getContext("2d");
  if (!ctx) return cv;
  ctx.fillStyle = colors[0];
  ctx.fillRect(0, 0, cv.width, cv.height);
  const n = colors.length;
  const R = Math.max(cv.width, cv.height) * 0.75;
  for (let i = 0; i < n; i++) {
    // 黄金分段散布：色块沿对角均匀铺开，上下交错避免排成一条直线
    const t = (i + 0.5) / n;
    const cx = cv.width * (0.08 + 0.84 * t);
    const cy = cv.height * (i % 2 ? 0.3 : 0.7);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    g.addColorStop(0, colors[i]);
    g.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cv.width, cv.height);
  }
  return cv;
}
