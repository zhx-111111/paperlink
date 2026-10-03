// PaperLink — 书写房主控 v2：WS 实时通讯、双模式、同速重放（全屏播放）、
// 书信集、riddle 式同心圆主题栏（只显示拥有的）、横竖屏镜像、3 秒轮询、
// 翻页镜像、长按橡皮调大小、多端全屏降级。

import { InkPad, roundSharpCorners, strokeSegment, strokeRuns, parseInkGradientDecl, makeInkGradientCanvas, inkAlphaOf, solidInkOf } from "./inkpad.js";
import { InkFx } from "./fx.js";
import { VoiceLink } from "./voice.js"; // v4.50 实时语音（P2P/WebRTC，彩蛋 VC）
import { inkBurst, inkBlaze, complement, GlyphRain, RainDrops, WeatherAmbience, mountAvatarFlame, FluidGlass, GlassDroplets, fxQuality } from "./canvasui.js"; // v4.43：水滴滑落层 + 设备分级
import { CuDroplets } from "./canvasui-cu.js"; // v3.23：canvas-ui 雨滴组件（WebGL2 可用时接管小雨）
import {
  store, api, apiJson, toast, relTime, hideLoading, refreshMe,
  mountAvatar, avatarSvg, loadThemes, getThemes, themeById, themeUnlocked,
  applyThemeToPaper, themeThumbCss, themeInkOf, copyText, mountIcons, icon, hasEgg,
  setupSecretTap, blurText, mountResetViewButton, positionPopByButton,
  validateInkSel, blancSelOf, DEFAULT_BLANC, displayNick, inkFromSel, withAlpha, // v4.42 白笺墨盘 + 昵称兜底；v4.48 逐笔墨色解析
  themeVeil, armDripSound, mountGlassHighlight, confirmDialog, playPaperWhoosh, haptic, showCenterTip,
  livePointerCount, trackActivePointers, truncName, I18N,
  UA, fullscreenElement, enterFullscreen, exitFullscreen, onFullscreenChange,
  lockOrientation, unlockOrientation,
} from "./shared.js";

const $ = (id) => document.getElementById(id);

const VW = 1000, VH = 1360;
const PORTRAIT = VW / VH;
const LANDSCAPE = VH / VW;
// v4.12：实时镜像信纸固定长宽 4:3（宽:高 = 3:4）——双方不再各随屏幕比例，
// 两端纸面完全一致，镜像笔迹零畸变；寄信模式仍走原逻辑（远端优先/本机屏幕比）
const MIRROR_ASPECT = 3 / 4;

const state = {
  room: null,
  // v4.15：镜像不再持久化 —— 进房一律从寄信模式起步，真实模式由服务端
  // （WS welcome / 轮询）在连上后立刻校准；双方都离线时服务端那边也已自动回到寄信，
  // 所以"重新打开却还在镜像里写字（不存信页）"这种坑不会再出现
  mode: "letter",
  ws: null,
  wsRetry: 0,
  partner: null,
  partnerOnline: false,
  partnerWriting: false, // v3.58：TA 正在落笔写信（指示胶囊当前亮灭）
  partnerReadAt: 0,     // v3.61：TA 最近一次打开书信集的时刻（已读回执判定用）
  favs: new Set(),      // v3.65：收藏的信件 pid（只存本机，按房间）
  favFilter: false,     // v3.67：书信集"只看收藏"筛选当前开关
  letterSelecting: false, // v4.57：书信集导出选择模式
  letterSelected: new Set(), // v4.57：选中的信 pid
  lastBadgeN: 0,        // v3.69：上一次的未读数（只在增量时让角标弹一下）
  openPid: "",          // v3.70：重放层里正在看的信（连读翻信用）
  stepDir: 0,           // v3.71：本次开信来自哪侧翻页（-1 上一封 / 1 下一封）
  unread: 0,
  pending: 0,
  pendingLimit: 3,
  letters: [],
  lettersTotal: 0,      // v3.11：书信集分页总数
  lettersLoading: false,
  bannerCount: 0,
  bannerTimer: 0,
  pendingNew: 0, // v3.88：看信全屏期间攒下的新信数（合上信再一起报，不打扰阅读）
  lastInput: Date.now(),
  writing: false,
  localAspect: PORTRAIT,
  remoteAspect: null,
  remoteAspectTimer: 0,
  liveChunks: new Map(),
  // v4.17：预览层完整点迹（id → {color, pts}）——双指缩放时预览层要按新视口
  // 整笔重画对齐，只靠接缝尾窗（liveChunks）凑不齐一整笔
  liveFull: new Map(),
  strokeParts: new Map(), // v3.23 #6：长笔画分片累积（id → {total, meta, parts}）
  seenStrokes: new Set(), // v4.1 #12：已定稿远端笔画 id（去重，防重复播放）
  remoteIds: new Set(),
  sheets: [],               // v4.25 页栈：[{strokes, remote:Set, seen:Set}]，会话内翻页不丢内容
  sheetIdx: 0,
  partnerSheetIdx: 0,       // v4.27：对方当前页码（镜像里同页光晕的判据）
  replayQueue: [],
  replaying: false,
  replayingId: null,      // v4.1 #15：正在重放的远端笔画 id（撤销可打断）
  replayingItem: null,
  replayDirty: false,     // v4.1 #16：重放期间主画布被外部 redraw 抹过的标记
  cursorAcc: 0,
  partnerCursorPos: null, // v4.17：对端光标最近一次的纸面相对坐标（缩放时重定位用）
  liveAcc: 0,
  pingTimer: 0,
  liveTimer: 0,
  sending: false,
  cssFullscreen: false,   // 原生全屏不可用时的 CSS 兜底
  forceLandscape: false,  // 全屏内强制横屏（不支持方向锁时 CSS 旋转兜底）
  eraserHold: 0,
  outQueue: [],           // v3.16 #67：断线期间暂存的关键事件，重连后补发
  redoStack: [],          // v3.53 重做栈：被撤销弹走的笔画在此等待放回
  connDown: false,        // v3.31：正处于「断线重连中」状态（顶部轻提示胶囊显示中）
  wasAuthed: false,       // v3.31：曾鉴权成功过（首次连接握手失败不弹胶囊，静默重试）
  flameOn: false,         // v3.26 E8：服务端判定"双方均在房满 5 分钟"后为 true
  voice: null,            // v4.50 实时语音链路实例（VoiceLink）
};

let pad;
let fx; // v3.1：纸面微反馈层（落笔墨波/墨点，思路取自 canvas-ui）
const paper = $("paper");
const inkCanvas = $("ink-canvas");

// ================================================================ 会话守卫

function guard() {
  if (!store.token || !store.sid) { location.href = "/join"; return false; }
  if (!store.roomCode) { location.href = "/hall"; return false; }
  return true;
}

// ================================================================ 纸张布局

/// CSS 旋转兜底是否实际生效中（无方向锁设备：全屏 + 强制横屏 + 物理竖屏）
function cssRotatedActive() {
  return state.forceLandscape
    && !!(fullscreenElement() || state.cssFullscreen)
    && window.innerHeight > window.innerWidth;
}

function localAspect() {
  // 全屏时信纸铺满屏幕 → 以视口比例为准（并广播，对端强制跟随）
  if (fullscreenElement() || state.cssFullscreen) {
    let w = window.innerWidth, h = Math.max(1, window.innerHeight);
    // v3.9：iOS 等无方向锁的设备走 CSS 旋转兜底——物理竖屏但舞台已横过来，
    // 有效视口宽高须对调，否则信纸比例算反、对端镜像也跟着错
    if (cssRotatedActive()) [w, h] = [h, w];
    return Math.max(0.2, Math.min(5, w / h));
  }
  if (state.forceLandscape) return LANDSCAPE;
  // v3：非全屏时信纸长宽比 = 设备屏幕长宽比
  return Math.max(0.2, Math.min(5, window.innerWidth / Math.max(1, window.innerHeight)));
}
function effectiveAspect() {
  if (state.mode === "realtime") return MIRROR_ASPECT; // v4.12：镜像固定 4:3
  return state.remoteAspect || state.localAspect;
}

function paperSize() {
  // v3.23 #49：双指/多指手势期间跳过重排——捏合与橡皮过程中
  // visualViewport/布局抖动不得牵动信纸，手势结束后下一次触发再重排
  if (livePointerCount() >= 2) return;
  const stage = $("stage");
  const sw = stage.clientWidth, sh = stage.clientHeight;
  lastStageBox = sw + "x" + sh; // 记录本次真实布局尺寸，供 visualViewport 守卫比对
  const isFs = !!(fullscreenElement() || state.cssFullscreen);
  const availW = isFs ? sw : sw - 28;
  const availH = isFs ? sh : sh - 120; // 全屏铺满，非全屏留出顶栏/工具栏
  const a = effectiveAspect();
  let w = availW, h = w / a;
  if (h > availH) { h = availH; w = h * a; }
  paper.style.width = w + "px";
  paper.style.height = h + "px";
  // v4.1 #56 画布像素预算：超大屏 × 高 dpr（如 4K 桌面 dpr=3）会突破
  // 浏览器画布面积上限（iOS ≈16.7M px），整块画布静默变空白——按预算回收 dpr
  const MAX_PX = 16e6;
  // v4.46 安卓跟手性：dpr≥3 的高分安卓机主画布填充面积是 dpr2 的 2.25 倍，
  // 行笔描线、快照贴回、清屏全部按这个面积走光栅化——中端 GPU 直接被打穿，
  // 表现为笔迹明显滞后于指尖。安卓统一降到 2（低端设备分级再降到 1.75）；
  // iOS 维持 3（其合成管线不构成瓶颈，保字迹锐度优先）。
  // 放大书写的清晰度不受影响：快照分辨率按 dpr×缩放 单独重建（_cacheQ）。
  const isAndroidUa = /android/i.test(typeof navigator !== "undefined" ? navigator.userAgent || "" : "");
  const dprCap = isAndroidUa ? (fxQuality() === "low" ? 1.75 : 2) : 3;
  let dpr = Math.min(dprCap, window.devicePixelRatio || 1);
  dpr = Math.max(1, Math.min(dpr, Math.sqrt(MAX_PX / Math.max(1, w * h))));
  // v4.12：纸面盒子变化（模式切换/全屏/转屏）时把已落笔迹按比例重映射——
  // 此前笔画坐标是绝对像素，比例一变（如切到镜像固定 4:3）整页字会偏移出界
  const ow = pad.w, oh = pad.h;
  pad.resize(w, h, dpr);
  if (ow > 0 && oh > 0 && pad.strokes.length && (Math.abs(ow - w) > 0.5 || Math.abs(oh - h) > 0.5)) {
    const sx = w / ow, sy = h / oh;
    for (const s of pad.strokes) for (const p of s.pts) { p.x *= sx; p.y *= sy; if (p.w) p.w *= sx; }
    pad.redraw();
  }
  liveCanvasResize(w, h, dpr); // v4.1 #11：实时预览层与主画布同尺寸
  predictCanvasResize(w, h, dpr); // v4.50：iOS 笔迹预测层与主画布同尺寸
  fx?.resize(w, h, dpr);
  pad.penScale = Math.max(0.8, Math.min(1.6, w / 700));
}

/// v3.23 #48：重排合并到动画帧——resize/转屏事件可能 1 帧内连发多次，
/// 全部折叠成一次布局，避免高频 resize 抖动（16ms 级节流）
let _paperSizeRaf = 0;
function requestPaperSize() {
  if (_paperSizeRaf) return;
  _paperSizeRaf = requestAnimationFrame(() => {
    _paperSizeRaf = 0;
    paperSize();
  });
}

function onViewportChange() {
  // v3.9 跟随系统：横竖屏旋转事件里同步重算 CSS 旋转兜底——
  // 此前只重排布局，物理旋转设备后 .rotated 不更新，画面会一直侧着
  syncRotation();
  const a = localAspect();
  if (a !== state.localAspect) {
    state.localAspect = a;
    send({ t: "aspect", a }); // 横竖屏/全屏比例强制镜像
  }
  requestPaperSize();
}

// v3.4：visualViewport 的 resize 在 iOS 双指捏合时会高频触发，但舞台布局盒
// 并没有真正变化 —— 盲目重排会让信纸元素在手势中跳动/移位。仅当舞台实际
// 尺寸变化时才重排，双指手势期间信纸面积保持固定。
let lastStageBox = "";
function onVisualViewportChange() {
  const stage = $("stage");
  const box = stage.clientWidth + "x" + stage.clientHeight;
  if (box === lastStageBox) return;
  lastStageBox = box;
  requestPaperSize();
}

function applyRemoteAspect(a) {
  const na = Math.max(0.2, Math.min(5, Number(a) || PORTRAIT));
  state.remoteAspect = na;
  clearTimeout(state.remoteAspectTimer);
  state.remoteAspectTimer = setTimeout(() => {
    state.remoteAspect = null;
    requestPaperSize();
  }, 10000);
  requestPaperSize();
}

// ================================================================ 主题

function currentInk() { return paper.dataset.ink || "#241812"; }

/// v3.99 渐变笔迹：模板 CSS 在信纸上声明了 `--ink-gradient` → 真实笔画改用
/// 静态多径向色块渐变（riddle 风格）；没声明则还原单色墨
function syncInkGradient(paperEl) {
  pad.setInkGradient(parseInkGradientDecl(getComputedStyle(paperEl).getPropertyValue("--ink-gradient")));
}

function applyTheme(theme, broadcast = false) {
  themeVeil(paper); // v3.16 #22：毛玻璃过渡层盖 300ms，避免信纸硬切换
  const ink = applyThemeToPaper(paper, theme);
  pad.setColor(ink);
  syncInkGradient(paper); // v3.99：新信纸若声明了渐变墨，笔画立刻跟上
  if (theme.id === BLANC_ID) applyBlancInk(); // v4.42：白笺的墨色由墨盘选择接管（v4.50：墨波/笔尖染色也一并接管）
  else {
    fx?.setInk(ink);
    document.documentElement.style.setProperty("--pl-ink", ink); // v4.50：笔尖图标随信纸墨色
  }
  store.theme = theme.id;
  syncAmbientRain(); // v3.16 #1：氛围字符雨跟随信纸主题
  syncFlameTheme(theme); // v3.25 E8：火焰头像框配色跟随信纸主题
  renderThemeBar();
  updateBlancUi(); // v4.42：墨色按钮只在白笺信纸出现
  if (broadcast) {
    send({ t: "theme_change", theme: theme.id });
    // v4.42：切到白笺时把当前墨色一并同步——对端跟到同一张纸 + 同一支墨
    if (theme.id === BLANC_ID) send({ t: "ink_change", v: blancSel });
  }
}

// ============================================================ v4.42 白笺（E9）墨盘
// 切到「白笺」信纸后，书信集（收件箱）上方出现一颗可拖动的墨色按钮：轻点弹出
// 30 色墨盘（26 支纯色 + 3 支左上→右下渐变 + 默认墨色；管理页 blanc_palette
// 可整盘替换）。选择只改本机笔迹墨色；ink_change 帧同步对端（信纸同款口径），
// 离线走补发队列，落房间记录供重连/换端一致。

const BLANC_ID = "E9";
let blancSel = ""; // "" = 默认墨 | "#hex" 纯色 | "g:#a,#b(,#c)" 左上→右下渐变
let blancOpenedAt = 0; // v4.47：墨盘弹出时刻（背板 click 误关守卫用）
const BLANC_POS_KEY = "pl_blancInk_pos";
const blancSelKey = () => "pl_blancInk_" + (store.roomCode || "_");

function blancColors() {
  const cfg = window.__plConfig || {};
  const list = Array.isArray(cfg.blancColors) ? cfg.blancColors : null;
  return list && list.length ? list.slice(0, 30) : DEFAULT_BLANC;
}
function isBlanc() { return store.theme === BLANC_ID; }

function loadBlancSel() {
  let v = "";
  try { v = localStorage.getItem(blancSelKey()) || ""; } catch { v = ""; }
  blancSel = validateInkSel(v) ? v : "";
}
function saveBlancSel(v) {
  blancSel = validateInkSel(v) ? v : "";
  try { localStorage.setItem(blancSelKey(), blancSel); } catch { /* 存不下不挡书写 */ }
}

/// 把墨色选择落到纸面与引擎（只在白笺态调用；其它信纸墨色由主题自己说了算）
/// v4.48：换色只影响「下一笔」——已写的字保持各自落笔时的墨色（同页多色）；
/// 透明度（选择值 "@0.6" 后缀）以 rgba 落进纸面与引擎，渐变色表逐色带透明度
function applyBlancInk() {
  if (!isBlanc()) return;
  const hexOk = (c) => /^#[0-9a-fA-F]{3,8}$/.test(c);
  const base = themeById(BLANC_ID)?.ink || "#241812";
  const ink = inkFromSel(blancSel, base); // {c: 单色(可能 rgba), g: 渐变色表|null}
  // dataset.ink 保持纯 hex（剥掉透明度）：帧 color 字段与存档 page.ink 的兼容口径，
  // 旧端与服务端白名单只认 hex；透明度/渐变走逐笔 iv 随行，新端精确还原
  const body = String(blancSel || "").replace(/@[\d.]+$/, "");
  let baseHex = base;
  if (body.startsWith("g:")) {
    const cs = body.slice(2).split(",").filter(hexOk);
    if (cs.length >= 2) baseHex = cs[0];
  } else if (hexOk(body)) baseHex = body;
  paper.style.setProperty("--ink-color", ink.c);
  paper.dataset.ink = baseHex;
  pad.setColor(ink.c, false);       // v4.48：只影响新笔
  pad.setInkGradient(ink.g, false); // 同上（渐变也逐笔记忆）
  pad.inkTag = blancSel;            // 新笔携带墨盘选择值（iv），随帧/存档同步
  // v4.50：落笔墨波与工具栏笔尖图标跟着染成当前墨色（"这支笔就是这个色"）
  fx?.setInk(baseHex);
  document.documentElement.style.setProperty("--pl-ink", baseHex);
  updateBlancUi();
}

/// v4.48：把帧/存档里携带的 iv（墨盘选择值）解析成逐笔墨色 {c, g}；
/// 旧数据没有 iv → 返回 null（引擎按旧口径回落：color 字段 + 当前纸面渐变）
function inkOfFrame(ev, fallbackColor) {
  if (ev && typeof ev.iv === "string" && ev.iv !== "" && validateInkSel(ev.iv)) {
    return inkFromSel(ev.iv, fallbackColor || themeById(BLANC_ID)?.ink || "#241812");
  }
  return null;
}

/// {c, g} → 可直接塞给 strokeStyle 的填充（渐变借引擎的图案缓存，锚定纸面）
function fillOfInk(ink, fallback) {
  if (!ink) return fallback;
  if (ink.g) return pad.inkPatternFor(ink.g) || ink.c || fallback;
  return ink.c || fallback;
}

/// 实时预览层的逐笔墨色（含渐变图案/透明度），旧帧回落 color 字段
function liveInkOf(ev) {
  const ik = inkOfFrame(ev, ev.color);
  return ik ? fillOfInk(ik, ev.color) : ev.color;
}

/// 重放笔画的渲染墨：帧带 iv 用 iv；否则沿用旧口径（当前纸面渐变 > 帧色）
function replayInkOf(item) {
  if (item.ink) return fillOfInk(item.ink, item.color);
  return pad.hasInkGradient() ? pad.inkFill() : item.color;
}

/// 墨色按钮可见性与色点（只在白笺信纸出现）
function updateBlancUi() {
  const btn = $("btn-blanc-ink");
  if (!btn) return;
  const on = isBlanc();
  btn.classList.toggle("hidden", !on);
  if (!on) { $("blanc-popup")?.classList.add("hidden"); return; }
  const dot = $("blanc-dot");
  if (dot) {
    // v4.48：色点跟随透明度与渐变——所见即所写
    const ink = inkFromSel(blancSel, themeById(BLANC_ID)?.ink || "#241812");
    dot.style.background = ink.g ? `linear-gradient(135deg, ${ink.g.join(",")})` : ink.c;
  }
  placeBlancBtn();
}

/// 按钮落点：有记忆位置用记忆的（夹回屏内）；默认落在书信集（收件箱）按钮正上方
function placeBlancBtn() {
  const btn = $("btn-blanc-ink");
  if (!btn || btn.classList.contains("hidden")) return;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(BLANC_POS_KEY) || "null"); } catch { saved = null; }
  const s = btn.offsetWidth || 42;
  const cl = (v, lo, hi) => Math.min(Math.max(lo, v), Math.max(lo, hi));
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    btn.style.left = cl(saved.x, 8, window.innerWidth - s - 8) + "px";
    btn.style.top = cl(saved.y, 8, window.innerHeight - s - 8) + "px";
    return;
  }
  const r = $("btn-letters")?.getBoundingClientRect();
  const x = r && r.width ? r.left + (r.width - s) / 2 : 14;
  const y = r && r.height ? r.top - s - 12 : window.innerHeight - s - 76;
  btn.style.left = cl(x, 8, window.innerWidth - s - 8) + "px";
  btn.style.top = cl(y, 8, window.innerHeight - s - 8) + "px";
}

// v4.50 墨盘升级：最近使用（本机记忆，跨房间）+ 自定义颜色（取色器 + 透明度滑杆）
const BLANC_RECENT_KEY = "pl_blanc_recent";
function blancRecentGet() {
  try {
    const arr = JSON.parse(localStorage.getItem(BLANC_RECENT_KEY) || "[]");
    return Array.isArray(arr) ? arr.filter(validateInkSel).slice(0, 8) : [];
  } catch { return []; }
}
function pushBlancRecent(sel) {
  try {
    const list = [sel, ...blancRecentGet().filter((x) => x !== sel)].slice(0, 8);
    localStorage.setItem(BLANC_RECENT_KEY, JSON.stringify(list));
  } catch { /* 存不下不挡选色 */ }
}

/// 选中一支墨（色块/最近使用/自定义三路共用）：落库 → 上纸 → 同步对端 → 收盘
function pickBlancSel(sel) {
  saveBlancSel(sel);
  pushBlancRecent(sel);
  applyBlancInk();
  send({ t: "ink_change", v: sel }); // 与 theme_change 同口径：离线自动进补发队列
  $("blanc-popup")?.classList.add("hidden");
  haptic(4);
}

/// 弹层骨架只建一次：最近使用分区（h3 之后）+ 自定义颜色面板（网格之后）
function ensureBlancExtras(card, grid) {
  if (!card || $("blanc-recent-wrap")) return;
  const wrap = document.createElement("div");
  wrap.id = "blanc-recent-wrap";
  wrap.innerHTML = `<div class="blanc-sec">最近使用</div><div class="blanc-recent" id="blanc-recent"></div>`;
  wrap.style.display = "none";
  card.insertBefore(wrap, grid);
  const panel = document.createElement("div");
  panel.id = "blanc-custom-panel";
  panel.className = "hidden";
  panel.innerHTML = `
    <input type="color" id="blanc-custom-color" value="#1c7ed6" aria-label="自定义颜色">
    <div class="blanc-alpha-wrap">
      <div class="blanc-alpha-label"><span>不透明度</span><span id="blanc-custom-pct">100%</span></div>
      <input type="range" id="blanc-custom-alpha" min="5" max="100" value="100" step="5" aria-label="自定义透明度">
    </div>
    <button type="button" id="blanc-custom-ok">用上</button>`;
  card.appendChild(panel);
  $("blanc-custom-alpha").addEventListener("input", (e) => {
    $("blanc-custom-pct").textContent = `${e.target.value}%`;
  });
  $("blanc-custom-ok").addEventListener("click", () => {
    const hex = String($("blanc-custom-color").value || "").toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(hex)) return;
    const a = Math.max(5, Math.min(100, Number($("blanc-custom-alpha").value) || 100)) / 100;
    pickBlancSel(a < 0.995 ? `${hex}@${Math.round(a * 100) / 100}` : hex);
  });
}

function renderBlancRecent() {
  const wrap = $("blanc-recent-wrap"), box = $("blanc-recent");
  if (!wrap || !box) return;
  const list = blancRecentGet();
  wrap.style.display = list.length ? "" : "none";
  box.innerHTML = "";
  const baseInk = themeById(BLANC_ID)?.ink || "#241812";
  for (const sel of list) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "blanc-swatch recent" + (sel === blancSel ? " active" : "");
    const ik = inkFromSel(sel, baseInk);
    if (sel === "" || sel.startsWith("@")) b.classList.add("auto");
    b.style.background = ik.g ? `linear-gradient(135deg, ${ik.g.join(",")})` : ik.c;
    b.title = sel === "" ? "默认墨色" : sel;
    b.setAttribute("aria-label", b.title);
    b.addEventListener("click", () => pickBlancSel(sel));
    box.appendChild(b);
  }
}

/// 弹出墨盘（最近使用 + 30 格：纯色 = 色块，渐变 = 135° 渐变块，默认墨色 = 半墨半纸对角 + 自定义）
function openBlancPopup() {
  const grid = $("blanc-grid");
  if (!grid) return;
  const pop = $("blanc-popup");
  ensureBlancExtras(pop?.querySelector(".popup-card"), grid);
  renderBlancRecent();
  $("blanc-custom-panel")?.classList.add("hidden"); // 每次开盘收起自定义面板
  grid.innerHTML = "";
  for (const item of blancColors()) {
    const sel = blancSelOf(item);
    if (sel == null) continue; // 后台配置写坏的条目直接不上盘
    const b = document.createElement("button");
    b.type = "button";
    b.className = "blanc-swatch" + (sel === blancSel ? " active" : "");
    const nm = String(item.name || "").slice(0, 12);
    b.title = nm || (sel || "默认墨色");
    b.setAttribute("aria-label", b.title);
    // v4.48：色块按条目透明度预览——半透明墨叠在白卡上就是上纸效果
    const av = Number(item.a) > 0 && Number(item.a) < 1 ? Number(item.a) : 1;
    if (item.auto) { b.classList.add("auto"); if (av < 1) b.style.opacity = String(Math.round((0.35 + av * 0.65) * 100) / 100); }
    else if (Array.isArray(item.g)) b.style.background = `linear-gradient(135deg, ${item.g.map((c) => withAlpha(c, av)).join(",")})`;
    else b.style.background = withAlpha(item.c, av); // blancSelOf 已做 hex 白名单，无注入面
    b.addEventListener("click", () => pickBlancSel(sel));
    grid.appendChild(b);
  }
  // v4.50 自定义颜色格：彩虹描边 + 加号
  const cb = document.createElement("button");
  cb.type = "button";
  cb.className = "blanc-swatch custom";
  cb.textContent = "+";
  cb.title = "自定义颜色（含透明度）";
  cb.setAttribute("aria-label", cb.title);
  cb.addEventListener("click", () => {
    $("blanc-custom-panel")?.classList.toggle("hidden");
    $("blanc-custom-panel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  grid.appendChild(cb);
  pop?.classList.remove("hidden");
  blancOpenedAt = performance.now(); // v4.47：背板误关守卫计时起点
}

/// 墨色按钮：拖动挪位（记忆落点）+ 轻点弹墨盘；多指手势期间不抢按钮
function mountBlancInkButton() {
  const btn = $("btn-blanc-ink");
  if (!btn) return;
  let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0, pid = null;
  btn.addEventListener("pointerdown", (e) => {
    if (livePointerCount() > 1) return;
    dragging = true; moved = false; pid = e.pointerId;
    sx = e.clientX; sy = e.clientY;
    ox = btn.offsetLeft; oy = btn.offsetTop;
    try { btn.setPointerCapture(e.pointerId); } catch { /* ok */ }
  });
  btn.addEventListener("pointermove", (e) => {
    if (!dragging || e.pointerId !== pid) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!moved && Math.hypot(dx, dy) < 6) return;
    moved = true;
    btn.classList.add("dragging");
    const s = btn.offsetWidth || 42;
    btn.style.left = Math.min(Math.max(8, ox + dx), window.innerWidth - s - 8) + "px";
    btn.style.top = Math.min(Math.max(8, oy + dy), window.innerHeight - s - 8) + "px";
  });
  const up = (e) => {
    if (!dragging || (e && e.pointerId != null && e.pointerId !== pid)) return;
    dragging = false;
    btn.classList.remove("dragging");
    if (moved) {
      try { localStorage.setItem(BLANC_POS_KEY, JSON.stringify({ x: btn.offsetLeft, y: btn.offsetTop })); } catch { /* ok */ }
    }
    // v4.47：开合墨盘从 pointerup 挪到 click（见下）——这里只管拖动收尾
  };
  btn.addEventListener("pointerup", up);
  btn.addEventListener("pointercancel", up);
  // v4.47 修「墨盘点开即关」：弹层(z300)全屏盖住按钮(z120)。此前 pointerup
  // 一抬指就弹墨盘，紧随其后的浏览器兼容 click 按「当下命中」落在刚弹出的
  // 背板上，背板 click-to-close 立刻把墨盘关掉——表现为闪一下就没了。
  // click 事件的目标在处理器执行前已锁定为按钮（那时弹层还没出现），
  // 开合放到 click 里天然避开这条时序缝隙；拖动松手补发的 click 用 moved 挡掉。
  btn.addEventListener("click", () => {
    if (moved) { moved = false; return; }
    const pop = $("blanc-popup");
    if (pop && !pop.classList.contains("hidden")) pop.classList.add("hidden");
    else openBlancPopup();
  });
  $("blanc-popup")?.addEventListener("click", (e) => {
    if (e.target !== $("blanc-popup")) return;
    // v4.47 误关守卫：弹出后 350ms 内的背板 click 一律忽略（个别 WebView 会在
    // 弹层出现瞬间把残留的 tap 序列补发到新命中目标上）
    if (performance.now() - blancOpenedAt < 350) return;
    $("blanc-popup").classList.add("hidden");
  });
  window.addEventListener("resize", () => placeBlancBtn());
  window.addEventListener("orientationchange", () => placeBlancBtn());
  placeBlancBtn();
}

// ------------------------------------------------ v3.25 E8 火焰头像框
// 兑换解锁 + 双方均在房满 5 分钟（服务端判定，经 welcome.flame / flame 帧
// 下发）时自动点燃本端与对端头像；任一方掉线立即熄灭，重新满足自动再点燃。
// 配色随信纸主题联动。
const avatarFlames = [];

/// 按需挂载火焰画布（只在首次点燃时调用；挂载即点火，此后启停只动 ring）
function setupAvatarFlames() {
  if (!hasEgg("E8") || avatarFlames.length) return;
  for (const el of [$("btn-me"), $("partner-avatar")]) {
    const f = mountAvatarFlame(el);
    if (f) avatarFlames.push(f);
  }
  syncFlameTheme(themeById(store.theme));
}

/// 服务端火焰条件下发：true 点燃、false 熄灭（画布保留，条件再满足可复燃）
function setFlameReady(on) {
  if (state.flameOn === on) return;
  state.flameOn = on;
  if (on) setupAvatarFlames();
  for (const f of avatarFlames) on ? f.ring.start() : f.ring.stop();
}

function syncFlameTheme(theme) {
  if (!avatarFlames.length) return;
  const tex = theme?.texture || "letter";
  for (const f of avatarFlames) f.ring.setTheme(tex);
}

// ------------------------------------------------ v3.16 #1 主题氛围字符雨
// 字符集/颜色随信纸主题切换（星夜=星月诗句、樱花=春花诗句）；
// 音乐歌词出现时暂停，歌词停止后恢复。

let ambientRain = null;
function mountAmbientRain() {
  const cv = $("room-ambient");
  if (!cv || ambientRain) return;
  ambientRain = new GlyphRain(cv, { alpha: 0.08, density: 10 });
  syncAmbientRain();
  ambientRain.start();
}
function syncAmbientRain() {
  if (!ambientRain) return;
  const t = themeById(store.theme);
  ambientRain.setTheme(t?.texture || "letter");
}

function applyForcedTheme(themeId) {
  const t = themeById(themeId);
  if (t) applyTheme(t, false);
}

/// riddle 式同心圆：外环=信纸色，内心=笔迹色；只显示拥有的主题
function renderThemeBar() {
  const bar = $("theme-bar");
  bar.innerHTML = "";
  const owned = getThemes().filter((t) => themeUnlocked(t));
  const shown = owned.slice(0, 5);
  for (const t of shown) {
    const b = document.createElement("button");
    b.className = "swatch" + (store.theme === t.id ? " active" : "");
    b.title = t.name;
    b.setAttribute("aria-label", t.name);
    // themeThumbCss 返回完整声明（"background:..."），须走 cssText；
    // 直接赋给 style.background 会被当成非法值丢弃，色块变透明
    b.style.cssText = themeThumbCss(t);
    b.style.setProperty("--sw-ink", themeInkOf(t)); // v4.13：CSS 定义的笔迹色优先
    b.addEventListener("click", () => applyTheme(t, true));
    bar.appendChild(b);
  }
  const more = document.createElement("button");
  more.className = "swatch-more";
  more.innerHTML = icon("more", 16);
  more.title = "更多信纸";
  more.addEventListener("click", openThemePopup);
  bar.appendChild(more);
  syncThemeBarMini(); // v3.17 收缩态小圆钮跟随当前信纸配色
}

/// v3.17 收缩态小圆钮：与整条主题栏同语汇的同心圆（外环=信纸色，内心=笔迹色）。
/// renderThemeBar 每次 innerHTML 清空重建，故小圆钮也在这里按需创建/刷新。
function syncThemeBarMini() {
  const bar = $("theme-bar");
  if (!bar) return;
  let mini = bar.querySelector(".theme-bar-mini");
  if (!mini) {
    mini = document.createElement("button");
    mini.className = "theme-bar-mini";
    mini.title = "信纸";
    mini.setAttribute("aria-label", "展开信纸栏");
    bar.appendChild(mini);
  }
  const t = themeById(store.theme);
  const ink = t ? themeInkOf(t, "#2b3550") : "#2b3550";
  mini.style.background = t?.paper || "#f5f0e4";
  mini.style.setProperty("--mini-ink", ink);
}

// ================================================================ v3.17 主题栏闲置收缩
// 10 秒不碰 → 整条主题栏收成一颗可拖动的小圆钮（颜色 = 当前信纸），
// 轻点小圆钮展开复原；再过 10 秒不碰又自动收拢。拖动落点记在本地。
// 多指手势（三指缩放/双指橡皮）期间沿用视口复位按钮同款守护：
// 已有其它手指在屏上时不响应按下、第二根手指落下立即冻结拖动。
const THEME_BAR_POS_KEY = "pl_themeBar_pos";
const THEME_BAR_IDLE_MS = 10 * 1000;
let _tbIdleTimer = 0, _tbShrunk = false;

function mountThemeBarShrink() {
  const bar = $("theme-bar");
  if (!bar) return;
  trackActivePointers();

  // CSS 的默认锚点（安全区感知）先读成像素，之后统一用内联 left/top 管理，
  // 展开/收缩两种体积下的夹边计算都基于同一坐标系
  const r0 = bar.getBoundingClientRect();
  bar.style.left = r0.left + "px";
  bar.style.top = r0.top + "px";

  const applyPos = (x, y) => {
    const w = bar.offsetWidth || 40, h = bar.offsetHeight || 40;
    const p = {
      x: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - w - 8)),
      y: Math.min(Math.max(8, y), Math.max(8, window.innerHeight - h - 8)),
    };
    bar.style.left = p.x + "px";
    bar.style.top = p.y + "px";
    return p;
  };

  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(THEME_BAR_POS_KEY) || "null"); } catch { /* ok */ }
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) applyPos(saved.x, saved.y);

  const armIdle = () => {
    clearTimeout(_tbIdleTimer);
    _tbIdleTimer = setTimeout(() => { _tbShrunk = true; bar.classList.add("shrunk"); }, THEME_BAR_IDLE_MS);
  };
  const expand = () => {
    if (!_tbShrunk) return;
    _tbShrunk = false;
    bar.classList.remove("shrunk");
    const r = bar.getBoundingClientRect();
    applyPos(r.left, r.top); // 展开后体积变大，再夹一次保证不出屏
    armIdle();
  };
  armIdle();

  // 拖动（轻点 = 展开）。不在按下时 setPointerCapture——捕获会把后续
  // click 的目标改成整条栏，色块/更多按钮的原生点击就失效了；
  // 改为 window 级 move/up 监听，位移 >6px 才算拖动，拖动结束后
  // 短暂吞掉 click，避免松手瞬间误触发色块切换。
  let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
  let suppressClick = false;
  const onMove = (e) => {
    if (!dragging) return;
    if (livePointerCount() > 1) return; // 第二根手指落下 → 冻结拖动（手势优先）
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!moved && Math.hypot(dx, dy) > 6) moved = true;
    if (moved) { bar.classList.add("dragging"); applyPos(ox + dx, oy + dy); }
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    bar.classList.remove("dragging");
    armIdle();
    if (moved) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 350);
      const r = bar.getBoundingClientRect();
      const p = applyPos(r.left, r.top); // 松手再夹一次，保证不出屏
      try { localStorage.setItem(THEME_BAR_POS_KEY, JSON.stringify(p)); } catch { /* ok */ }
      return;
    }
    if (_tbShrunk) expand(); // 小圆钮轻点 = 展开
  };
  bar.addEventListener("pointerdown", (e) => {
    armIdle();
    if (livePointerCount() > 1) return; // 手势已在进行，这个手指不算栏操作
    dragging = true; moved = false;
    sx = e.clientX; sy = e.clientY;
    const r = bar.getBoundingClientRect();
    ox = r.left; oy = r.top;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
  bar.addEventListener("click", (e) => {
    if (!suppressClick) return;
    e.stopPropagation();
    e.preventDefault();
  }, true);

  // 转屏/窗口变化后把位置夹回屏内（含安全区变化）
  window.addEventListener("resize", () => {
    const r = bar.getBoundingClientRect();
    applyPos(r.left, r.top);
  });
}

// ================================================================ v3.18 天气彩蛋
// 访客本地下雨/下雪时，雨滴/雪花沿屏幕流下。隐私约定：
//  - 首次启用弹确认（GDPR 告知），拒绝则记录、不再询问（「我的」页可再打开）；
//  - 定位只用 Cloudflare 由 IP 现算的经纬度，Worker 单次请求内使用，绝不落库；
//  - 轮询 120 分钟，结果缓存本地；任何失败静默降级，绝不影响书写。
// A/B 各按自己物理位置独立生效；「共写同天气」需 DO 广播，本期不做。
const WEATHER_PREF_KEY = "pl_weather";
const WEATHER_CACHE_KEY = "pl_weather_cache";
const WEATHER_POLL_MS = 120 * 60 * 1000;
let weatherFx = null;   // 雨/雪粒子（RainDrops，含大雨闪电）
let weatherCu = null;   // v3.23：canvas-ui Droplets（WebGL2 浏览器的小雨增强层）
let weatherCuDead = false; // canvas-ui 层初始化失败过 → 本次会话不再尝试
let weatherAmb = null; // 雾/极光氛围（WeatherAmbience）：与上面共用画布，同一时刻只启用其一

// ---------------------------------------------------------------- v4.37 书写聚焦
/// 落笔（本端或对端）期间暂停全屏氛围动画：字符雨 / 天气粒子这些层每帧全屏重绘，
/// 是移动端书写卡顿的主要来源之一。v4.65：停笔 4 秒后自动恢复（原 1.2 秒），
/// 且天气层随书写整体淡出、恢复时淡回——不再硬冻结把最后一帧残影留在屏幕上。
let ambientResumeTimer = 0;
function setAmbientPaused(p) {
  // v4.46：WebGL 雨滴层（weatherCu）一并纳入书写期暂停——此前它不在名单里，
  // 中高端安卓开着天气彩蛋书写时，全屏着色器全程满速渲染与主画布抢 GPU
  // v4.65：书写期天气画布走 CSS 透明度渐隐（body.weather-faded），冻结帧随之消失
  document.body.classList.toggle("weather-faded", p);
  for (const layer of [ambientRain, weatherFx, weatherAmb, weatherCu]) {
    if (!layer) continue;
    if (p) layer.pause?.(); else layer.resume?.();
  }
  document.body.classList.toggle("lg-lite", p); // v4.40：书写期液态玻璃折射降级（画布每帧重绘时位移滤镜太贵）
}
function focusWriting() {
  setAmbientPaused(true);
  clearTimeout(ambientResumeTimer);
  const resumeAmbient = () => {
    // v4.46：笔还在走就不恢复——此前长笔画超过 1.2 秒后氛围层中途复活，
    // 行笔一半开始与全屏粒子/着色器抢帧（安卓长句书写掉帧主因之一）
    if (state.writing || pad?.current) { ambientResumeTimer = setTimeout(resumeAmbient, 600); return; }
    setAmbientPaused(false);
  };
  ambientResumeTimer = setTimeout(resumeAmbient, 4000); // v4.65：停笔 4 秒后恢复（原 1.2 秒）
}

function applyWeatherFx(d) {
  // v4.43：天气转晴/彩蛋收场 → 全部层收掉并退出沉浸（此前旧层会一直跑到下次换天气）
  if (!d || !d.ok || d.mode === "none") { stopWeatherFx(); return; }
  const cv = $("weather-canvas");
  if (!cv) return;
  weatherMode = d.mode; // v4.43：沉浸态判定用
  const wet = d.mode === "rain" || d.mode === "heavy" || d.mode === "snow";
  if (wet) {
    if (weatherAmb) { weatherAmb.stop(); weatherAmb = null; }
    // v3.23：小雨优先交给 canvas-ui Droplets（玻璃质感更精良）；
    // 大雨保留自研层——它有闪电联动，雪则组件本身不支持
    // v4.43：低端设备不走 WebGL2 全屏着色器（2D 层更省，观感由水滴滑落层补齐）
    if (d.mode === "rain" && !weatherCuDead && fxQuality() !== "low") {
      if (!weatherCu) {
        weatherCu = new CuDroplets(cv);
        if (!weatherCu.ok) { weatherCu.stop(); weatherCu = null; weatherCuDead = true; }
      }
      if (weatherCu) {
        if (weatherFx) { weatherFx.stop(); weatherFx = null; }
        weatherCu.setMode("rain");
        weatherCu.start();
        return;
      }
    }
    if (weatherCu) { weatherCu.stop(); weatherCu = null; }
    if (!weatherFx) weatherFx = new RainDrops(cv, { alpha: 0.16, onFlash: flashPaperEdge });
    weatherFx.setMode(d.mode === "heavy" ? "heavy" : d.mode === "snow" ? "snow" : "rain");
    weatherFx.start();
  } else { // fog | aurora
    if (weatherFx) { weatherFx.stop(); weatherFx = null; }
    if (weatherCu) { weatherCu.stop(); weatherCu = null; }
    if (!weatherAmb) weatherAmb = new WeatherAmbience(cv);
    weatherAmb.setMode(d.mode);
    weatherAmb.start();
  }
  weatherActive = true;   // v4.43
  resetWeatherIdle();     // 天气上线即开始计闲置
}

// ---------------------------------------------------------------- v4.43 天气沉浸态
/// 天气彩蛋生效且超过 8 秒没书写：整张信纸淡到背景亮度、天气层增幅，
/// 雨天再叠一层水滴沿"玻璃"滑落——窗外的天气成为主角。
/// 打断口径（按用户反馈收窄）：只有「书写」立刻退出——纸面落笔（本端或
/// 对端来帧）、看信、寄信；敲键、点按钮、换信纸等 UI 操作不打断沉浸、
/// 也不重置计时。低端设备全程走减量档（fxQuality）。
const WEATHER_IDLE_MS = 8000;
let weatherMode = null;    // 当前生效天气（rain/heavy/snow/fog/aurora）；null = 没有天气层
let weatherActive = false;
let weatherDrops = null;   // 水滴滑落层（GlassDroplets，雨天沉浸态挂载）
let weatherIdleTimer = 0;
let immersiveOn = false;

/// 天气收场：停掉所有层（含水滴层）并退出沉浸
function stopWeatherFx() {
  weatherMode = null;
  weatherActive = false;
  clearTimeout(weatherIdleTimer);
  exitWeatherImmersive();
  if (weatherFx) { weatherFx.stop(); weatherFx = null; }
  if (weatherCu) { weatherCu.stop(); weatherCu = null; }
  if (weatherAmb) { weatherAmb.stop(); weatherAmb = null; }
  ensureDropsLayer(false);
}

function ensureDropsLayer(on) {
  const cv = $("weather-drops-canvas");
  if (!cv) return;
  if (on) {
    if (!weatherDrops) weatherDrops = new GlassDroplets(cv, { alpha: 0.6, density: fxQuality() === "low" ? 0.6 : 1.3 });
    weatherDrops.start();
  } else if (weatherDrops) {
    weatherDrops.stop();
    weatherDrops = null;
  }
}

function weatherImmersiveEligible() {
  return weatherActive && !immersiveOn &&
    !state.writing && !pad.current &&      // 正在写（本端）不进
    !state.sending && !ov &&               // 寄信动画 / 看信中不进
    !document.body.classList.contains("letter-open") &&
    !(typeof document !== "undefined" && document.hidden);
}

function enterWeatherImmersive() {
  if (immersiveOn || !weatherImmersiveEligible()) return;
  immersiveOn = true;
  document.body.classList.add("weather-immersive");
  weatherFx?.setBoost?.(true);   // 雨/雪增幅
  weatherAmb?.setBoost?.(true);  // 雾更浓 / 极光更亮
  if (weatherMode === "rain" || weatherMode === "heavy") ensureDropsLayer(true); // 水滴滑落
}

function exitWeatherImmersive() {
  if (!immersiveOn) return;
  immersiveOn = false;
  document.body.classList.remove("weather-immersive");
  weatherFx?.setBoost?.(false);
  weatherAmb?.setBoost?.(false);
  ensureDropsLayer(false);
}

/// 任何"人还在"的信号都重置 8 秒计时（并立刻退出沉浸）
function resetWeatherIdle() {
  clearTimeout(weatherIdleTimer);
  if (immersiveOn) exitWeatherImmersive();
  if (!weatherActive) return;
  weatherIdleTimer = setTimeout(() => {
    if (weatherImmersiveEligible()) enterWeatherImmersive();
  }, WEATHER_IDLE_MS);
}

function wireWeatherImmersive() {
  // 纸面落笔（含橡皮）立刻退出沉浸；敲键/点按钮/换信纸不打断（v4.43 口径）
  $("ink-canvas")?.addEventListener("pointerdown", resetWeatherIdle);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) resetWeatherIdle(); });
  resetWeatherIdle();
}

/// v3.21 闪电联动：每道闪电开始时让纸面边缘泛一闪冷光（与闪电同节奏）
let _paperFlashTimer = 0;
function flashPaperEdge() {
  const p = $("paper");
  if (!p) return;
  p.classList.remove("lightning-glow");
  void p.offsetWidth; // 重启动画
  p.classList.add("lightning-glow");
  clearTimeout(_paperFlashTimer);
  _paperFlashTimer = setTimeout(() => p.classList.remove("lightning-glow"), 600);
}

/// v3.27 #4：首次天气彩蛋询问卡片（替代浏览器 confirm）。
/// 返回 Promise<boolean>：「开启」true /「不用了」false，二者都会关闭卡片。
function weatherConsentCard() {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "consent-overlay";
    wrap.innerHTML = `
      <div class="consent-card" role="dialog" aria-modal="true" aria-label="天气彩蛋">
        <div class="consent-emoji" aria-hidden="true">${icon("cloudRain", 30)}</div>
        <h3>天气彩蛋</h3>
        <p>你所在的城市下雨或下雪时，让雨滴 / 雪花也落进书写房。</p>
        <p class="consent-note">会用你的网络连接大致定位所在城市，仅用于这一次天气查询，不保存、不分享。</p>
        <div class="consent-actions">
          <button class="small-btn ghost" data-act="no">不用了</button>
          <button class="small-btn" data-act="yes">开启</button>
        </div>
      </div>`;
    const close = (v) => {
      wrap.classList.add("closing");
      setTimeout(() => wrap.remove(), 180);
      resolve(v);
    };
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) close(false); // 点遮罩 = 不用了
      const act = e.target.closest?.("[data-act]")?.dataset.act;
      if (act === "yes") close(true);
      if (act === "no") close(false);
    });
    document.body.appendChild(wrap);
  });
}

async function maybeStartWeather() {
  try {
    const pref = localStorage.getItem(WEATHER_PREF_KEY);
    if (pref === "0") return;
    if (pref !== "1") {
      // v3.27 #4：首次询问改成卡片（旧版是浏览器 confirm 弹框）。拒绝记下来不再问
      const yes = await weatherConsentCard();
      localStorage.setItem(WEATHER_PREF_KEY, yes ? "1" : "0");
      if (!yes) return;
    }
    let cache = null;
    try { cache = JSON.parse(localStorage.getItem(WEATHER_CACHE_KEY) || "null"); } catch { /* ok */ }
    if (cache && Number.isFinite(cache.at) && Date.now() - cache.at < WEATHER_POLL_MS) {
      applyWeatherFx(cache.data);
      return;
    }
    const d = await (await fetch("/api/weather")).json();
    if (!d || !d.ok) return; // 上游失败 → 静默不启用
    try { localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify({ at: Date.now(), data: d })); } catch { /* ok */ }
    applyWeatherFx(d);
  } catch { /* 彩蛋任何异常都不允许影响书写 */ }
}

function openThemePopup() {
  const grid = $("theme-grid");
  grid.innerHTML = "";
  for (const t of getThemes().filter((x) => themeUnlocked(x))) {
    const card = document.createElement("div");
    card.className = "theme-card" + (store.theme === t.id ? " active" : "");
    const ink = themeInkOf(t); // v4.13：与真实笔迹同色
    card.innerHTML = `
      <div class="preview" style="${themeThumbCss(t)}">
        <div class="ink-line" style="background:${ink}"></div>
      </div>
      <div class="nm">${escapeHtml(t.name)}</div>
      <div class="tag">${t.egg ? "彩蛋" : t.custom ? "自定义模板" : "内置"}</div>`;
    card.addEventListener("click", () => {
      applyTheme(t, true);
      $("theme-popup").classList.add("hidden");
    });
    grid.appendChild(card);
  }
  $("theme-popup").classList.remove("hidden");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------- v3.66 键盘快捷键
/// 关闭信件重放层（原 ✕ 按钮的逻辑提出来，Esc 也走这一条路）
function closeLetterOverlay() {
  ovProgSave(); // v3.30：关闭前记下断点（播完的会被 ovProgSave 自动清除）
  ov = null;
  cancelAnimationFrame(ovRaf); // #48 关闭重放层同时停帧
  ovRaf = 0;
  ovProgressUi(); // v3.23 #31：关掉重放层把进度条归零
  $("ov-speed-pop")?.classList.add("hidden"); // v4.64：关信收倍速条
  state.openPid = ""; // v3.70：没有在看的信了
  $("letter-overlay").classList.add("hidden");
  document.body.classList.remove("letter-open"); // v3.80：天气与下层按钮恢复
  resetWeatherIdle(); // v4.43：合上信重新开始闲置计时
  ovGestureTipHide(); // v3.83：关信就收掉手势提示
  // v3.88：看信时攒下的新信此刻送达——只报数不自动开抽屉，看没看完你说了算
  if (state.pendingNew > 0) {
    const n = state.pendingNew;
    state.pendingNew = 0;
    state.bannerCount = n;
    $("banner-text").textContent = n > 1 ? `看信时 TA 又寄来 ${n} 页新信` : "看信时 TA 又寄来一页新信";
    exitImmersive(); // v4.50：新信横幅要能被点到
    $("new-letter-banner").classList.remove("hidden");
    clearTimeout(state.bannerTimer);
    state.bannerTimer = setTimeout(() => $("new-letter-banner").classList.add("hidden"), 6000);
  }
}

/// v3.66 键盘快捷键
/// Esc 逐层收起弹层；Ctrl/⌘+Enter 快捷寄出当前页。
/// 输入框里（歌词搜索等）两者都不启用——打字不被抢
function wireKeyboardShortcuts() {
  window.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === "Enter") {
      if (state.mode === "letter" && !state.sending && pad.hasInk()) { e.preventDefault(); doSend(); }
      return;
    }
    // v3.70：重放层里 ←/→ 翻上一封/下一封
    if (!$("letter-overlay").classList.contains("hidden")) {
      if (e.key === "ArrowLeft") { e.preventDefault(); stepLetter(-1); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); stepLetter(1); return; }
      // v3.74：空格 暂停/继续，和暂停按钮完全同款（播完按空格 = 从头重播）
      if (e.key === " " || e.code === "Space") { e.preventDefault(); toggleOverlayPause(); return; }
      // v3.78：L 键切循环播放；只认单按，不抢浏览器 Ctrl+L
      if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "l" || e.key === "L")) {
        e.preventDefault(); toggleOverlayLoop(); return;
      }
    }
    if (e.key !== "Escape") return;
    // 从最里层往外收：重放层 → 信纸选择 → 音乐面板 → 滑条弹层 → 书信集
    if (!$("letter-overlay").classList.contains("hidden")) { closeLetterOverlay(); return; }
    if (!$("theme-popup").classList.contains("hidden")) { $("theme-popup").classList.add("hidden"); return; }
    if ($("blanc-popup") && !$("blanc-popup").classList.contains("hidden")) { $("blanc-popup").classList.add("hidden"); return; } // v4.42
    if ($("music-pop") && !$("music-pop").classList.contains("hidden")) { $("music-pop").classList.add("hidden"); return; }
    let popClosed = false;
    for (const pid of ["eraser-pop", "tip-pop", "width-pop"]) {
      const el = $(pid);
      if (el && !el.classList.contains("hidden")) { el.classList.add("hidden"); popClosed = true; }
    }
    if (popClosed) return;
    if ($("letter-drawer").classList.contains("open")) closeLetterDrawer();
  });
}

/// v3.70 连读翻信：重放层里直接翻上一封/下一封，不必回书信集重挑。
/// 翻走前给当前这封记档（读到哪儿了）；按 pid 定位，中途来了新信也不挪错位
function stepLetter(dir) {
  const i = state.letters.findIndex((x) => x.pid === state.openPid);
  const p = state.letters[i + dir];
  if (!p) return;
  if (ov) ovProgSave();
  state.stepDir = dir; // v3.71：告诉开信函数从哪侧滑入
  openLetter(p, null); // 无源卡 → 落回自然上浮入场
}

/// v3.70：翻信按钮的亮灭——到头了就按灰，不循环不跳
function updateStepButtons() {
  const i = state.letters.findIndex((x) => x.pid === state.openPid);
  if ($("overlay-prev")) $("overlay-prev").disabled = i <= 0;
  const next = $("overlay-next");
  if (next) {
    next.disabled = i < 0 || i >= state.letters.length - 1;
    next.classList.remove("ov-hint"); // v3.77：换了信就清掉上一封的翻页提醒
  }
}

/// v3.77：读完这封、循环没开、后面还有信——「下一封」按钮轻轻跳两下提醒
function ovHintNext() {
  const btn = $("overlay-next");
  if (!btn || btn.disabled || ovLoopOn) return;
  btn.classList.add("ov-hint");
}

// ================================================================ WS

/// #67 关键事件（笔画/翻页/擦除等结果态）在短暂断线时入队，重连后补发，
/// 避免"快速连点/网络抖动丢笔迹"；高频过程态（光标/逐点流）不排队
const QUEUEABLE = new Set(["stroke", "page_turn", "page_goto", "erase_at", "stroke_erase", "clear_all", "aspect", "theme_change", "ink_change", "mode_change"]); // v4.42：墨色切换断线可补发；v4.50：undo 改纯本地不再出站；v4.51：整笔擦除也进补发队列

function send(obj) {
  if (state.kicking) return; // v3.23 #9：被踢出后的跳转间隙冻结一切出站事件
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    try { state.ws.send(JSON.stringify(obj)); return; } catch { /* 落到队列 */ }
  }
  if (QUEUEABLE.has(obj.t)) {
    state.outQueue.push(obj);
    if (state.outQueue.length > 200) state.outQueue.shift();
  }
}

/// v3.31 断线轻提示——已建立的连接断开期间在顶部常驻一个小胶囊，
/// 重连成功即消失；踢出跳转与首次连接握手失败都不触发，补写沿用静默补齐（v3.28）
function showConnPill() {
  state.connDown = true;
  $("conn-pill")?.classList.remove("hidden");
}
function hideConnPill() {
  state.connDown = false;
  $("conn-pill")?.classList.add("hidden");
}

function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  // v3.23 #10：token 不再拼进 URL（会进访问日志），改由首条 hello 消息携带；
  // 服务端 5 秒内没收到有效 hello 会断开（4003）
  const url = `${proto}://${location.host}/api/ws?room=${encodeURIComponent(store.roomCode)}`;
  const ws = new WebSocket(url);
  state.ws = ws;
  window.__plWs = ws;

  ws.onopen = () => {
    state.wsRetry = 0;
    state.wsAuthed = false; // v3.23 #10：收到 welcome 才算鉴权通过
    // #69 带上次掉线时刻，方便服务端平滑处理重连；hello 必须先于其它事件（鉴权门）
    // v4.15：不再上报本机模式 —— 模式由服务端会话态说了算，客户端只接收
    send({ t: "hello", token: store.token, nick: store.nick, avatar: store.avatar,
      ...(state.lastWsCloseAt ? { lastSeen: state.lastWsCloseAt } : {}) });
    // 注意：aspect 与断线补发事件不在此处紧跟——服务端鉴权是异步的，
    // 紧跟的消息可能先于鉴权完成到达而被丢弃；统一等 welcome 再发（见下）
    clearInterval(state.pingTimer);
    state.pingTimer = setInterval(() => send({ t: "ping" }), 60000);
  };

  ws.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    handleWsEvent(ev);
  };

  ws.onclose = (e) => {
    clearInterval(state.pingTimer);
    window.__plWs = null;
    state.partnerOnline = false;
    state.lastWsCloseAt = Date.now();
    state.voice?.onWsDown(); // v4.50：信令通道断了，语音只清本地
    renderPeerMusic({ playing: false }); // v4.52：断线 → 「TA 在听」先收起，重连后由对方状态恢复
    renderPartnerBadge();
    if (e.code === 4001 || e.code === 4003) {
      // v3.23 #9：被踢出/鉴权失败到跳转的间隙锁掉一切交互，
      // 防止半秒内的误触发送/翻页产生"人已走、字还在飞"的残影
      state.kicking = true;
      document.body.classList.add("kicked-lock");
      toast(e.code === 4003 ? "会话校验失败，请重新进入" : "已在别处登录", 3000);
      store.clearSession();
      setTimeout(() => (location.href = "/join"), 1200);
      return;
    }
    state.wsRetry = Math.min(state.wsRetry + 1, 6);
    if (state.wasAuthed) showConnPill(); // v3.31：曾连上过的会话断了 → 轻提示；首次握手失败静默重试
    // #68 指数退避 + 随机抖动：避免多客户端同步重连雪崩
    const base = Math.min(4800, 800 * state.wsRetry);
    setTimeout(connectWs, base * (0.7 + Math.random() * 0.6));
  };
}

function handleWsEvent(ev) {
  switch (ev.t) {
    case "welcome": {
      updatePresence(ev.peers || []);
      // v4.14：断线期间自己切过模式时（队列里还压着待补发的 mode_change，
      // 或刚切完还在保护窗内），welcome 捎带的旧模式一律不采纳——
      // 否则重连那一刻按钮先被翻回旧状态、随后补发事件又拽回来，
      // 肉眼看就是"点了几秒后自己跳回"
      const queuedMode = state.outQueue.find((o) => o.t === "mode_change");
      const localFresh = state.modeLocalAt &&
        performance.now() - state.modeLocalAt < MODE_SYNC_GUARD_MS;
      if (!queuedMode && !localFresh && ev.mode && ev.mode !== state.mode) setMode(ev.mode, false, "sync");
      setFlameReady(ev.flame === true); // v3.26 E8：同步服务端火焰条件（重连自动校准）
      // v3.23 #10 竞态防护：welcome 是鉴权通过的凭证——此刻才补发
      // 横竖屏比例与断线期间攒下的关键事件，确保服务端不会再丢弃它们
      if (!state.wsAuthed) {
        state.wsAuthed = true;
        state.wasAuthed = true; // v3.31：首个成功握手之后，掉线才有资格弹轻提示
        const back = state.connDown;
        hideConnPill();
        if (back) toast("已重新连接", 1600); // 补写仍然静默进行（v3.28），只报"回来了"这一件事
        send({ t: "aspect", a: state.localAspect });
        const q = state.outQueue.splice(0);
        for (const obj of q) send(obj);
      }
      break;
    }
    case "presence":
      updatePresence(ev.peers || []);
      break;
    case "flame": // v3.26 E8：双方均在房满 5 分钟 → 点燃；任一方掉线 → 熄灭
      setFlameReady(ev.on === true);
      break;
    case "kicked":
      break;
    case "aspect": applyRemoteAspect(ev.a); break;
    case "drawing": onLiveDrawing(ev); break;
    case "live_cancel":
      liveForget(ev.id);
      liveCanvasClear(); // v4.1 #11：半截预览在独立层，直接清层即可
      break;
    case "stroke": onPartnerStroke(ev); break;
    case "stroke_part": onStrokePart(ev); break; // v3.23 #6：长笔画分片
    case "erase_at": onPartnerErase(ev); break;
    case "stroke_erase": onPartnerStrokeErase(ev); break; // v4.50 整笔橡皮
    case "undo": onPartnerUndo(ev); break;
    case "clear_all": onPartnerClear(); break;
    case "page_turn": onPartnerPageTurn(); break;
    case "page_goto": {
      // v4.27：对方翻页只提示不跟随——中央浮提示 + 记对方页码（同页光晕判据）；
      // 镜像里发现不同页时回一枚 ack 告知自己的页码（ack 不再回复，避免来回 ping-pong）
      const i = Number(ev.i);
      if (!Number.isFinite(i)) break;
      const pi = Math.trunc(i);
      state.partnerSheetIdx = pi;
      if (!ev.ack) showCenterTip(`对方翻到了第 ${pi + 1} 页`, 1400);
      if (state.mode === "realtime" && !ev.ack && pi !== state.sheetIdx) {
        send({ t: "page_goto", i: state.sheetIdx, ack: 1 });
      }
      syncSamePageGlow();
      break;
    }
    case "offline_page": onOfflinePage(ev); break; // v3.10 离线补齐
    case "theme_change":
      applyForcedTheme(ev.theme);
      toast("对方换了信纸，已为你同步", 1600);
      break;
    case "ink_change": // v4.42 白笺墨色同步：值过白名单才认，非法帧静默丢弃
      if (validateInkSel(ev.v)) {
        saveBlancSel(String(ev.v));
        if (isBlanc()) applyBlancInk();
        toast("对方换了墨色，已为你同步", 1600);
      }
      break;
    case "mode_change":
      // v4.14：对端切换 / 服务端闲置自动退出 —— 权威事件，立刻生效不受保护窗约束
      if (ev.mode === "realtime" || ev.mode === "letter") setMode(ev.mode, false, "ws");
      if (ev.mode === "letter" && ev.reason === "rt_idle") toast("离开超过 10 分钟，已自动退出实时镜像", 3200);
      // v4.36：空场宽限超窗退场也给明原因（此前静默跳回寄信，用户只会觉得"自己跳了"）
      if (ev.mode === "letter" && ev.reason === "rt_empty") toast("双方离线超过 1 分钟，实时镜像已结束", 3200);
      break;
    case "mode_denied":
      setMode("letter", false, "ws"); // v4.14：服务端拒绝必须能真正把按钮按回去
      toast("实时镜像需用兑换码解锁", 3200);
      break;
    case "cursor": onPartnerCursor(ev); break;
    case "nick_update":
      if (state.partner) { state.partner.nick = displayNick(ev.nick); renderPartnerBadge(); } // v4.42：改名帧展示兜底
      break;
    case "avatar_update":
      if (state.partner) { state.partner.avatar = ev.avatar; renderPartnerBadge(); }
      break;
    case "new_page": onNewPage(ev.page, ev.pending, ev.limit); break;
    case "read_ack": {
      // v4.61：read_ack 是全房广播（含本人连接）——自己开书信集的回执绕回来时
      // 绝不能当成「TA 读了」：此前未校验 by，本端一开抽屉就把寄出的信全翻成
      // 已读、还把待读计数清零（用户报的「本端读了就显示已读」根因）
      if (ev.by && ev.by === store.sid) break;
      state.pending = 0;
      updateSendBar();
      // v3.61：TA 打开了书信集 → 之前寄出的信即刻转为"已读"；书信集开着就原地翻牌
      state.partnerReadAt = Date.now();
      if ($("letter-drawer")?.classList.contains("open")) renderLetters();
      toast("TA 在读你的信", 1500);
      // v3.16 #16 对方开信时刻的小仪式：在线徽章下一团短促墨焰
      const bb = $("partner-badge")?.getBoundingClientRect();
      if (bb && bb.width) inkBlaze($("blaze-canvas"), bb.left + bb.width / 2, bb.top + bb.height, {});
      break;
    }
    case "page_recalled": {
      // v3.63：TA 撤回了一封还没被我看的信——从书信集里撤走，轻说一声
      state.letters = state.letters.filter((x) => x.pid !== ev.pid);
      state.lettersTotal = Math.max(0, (state.lettersTotal || 0) - 1);
      state.favs.delete(ev.pid); persistFavs(); // v3.65：信没了，收藏一并清掉
      if ($("letter-drawer")?.classList.contains("open")) renderLetters();
      toast("TA 撤回了一封信", 2000);
      break;
    }
    case "vc_state":   // v4.50 实时语音信令（P2P/WebRTC，DO 纯转发）
    case "vc_offer":
    case "vc_answer":
    case "vc_ice":
      if (state.voice) state.voice.handleEvent(ev);
      break;
    case "music_now":  // v4.52 「TA 在听」对方正在播放的曲目
      renderPeerMusic(ev);
      break;
    case "music_clock": // v4.57 播放进度对时（漂移校正）
      handleMusicClock(ev);
      break;
    case "pong": break;
  }
}

// 3 秒全局轮询：在线状态 / 待读计数 / 模式，修正 WS 漏报与滞后
async function pollLive() {
  if (!store.roomCode) return;
  try {
    const d = await apiJson(`/api/room/${encodeURIComponent(store.roomCode)}/live`);
    // WS presence 说对方在线时，不让轮询把它降级成离线（修在线状态误报）
    state.partnerOnline = !!d.partnerOnline || !!state.partner;
    if (typeof d.unreadTheirs === "number" && d.unreadTheirs !== state.pending) {
      // v3.23 #1 竞态防护：刚寄出信的 5 秒内，/commit 响应里的 pending 才是
      // 权威值——轮询可能读到服务端还没刷新的旧值，此时只允许往大走；
      // 窗口外正常对齐（对方读完归零等场景不受影响）
      const freshLocal = state.pendingLocalAt && Date.now() - state.pendingLocalAt < 5000;
      if (freshLocal) {
        if (d.unreadTheirs > state.pending) { state.pending = d.unreadTheirs; updateSendBar(); }
      } else {
        // v3.57 对方拆信轻提示：待读计数变小只可能是 TA 在打开你的信——
        // 轻轻说一声，让写信的人知道心意被翻开了（只在寄信模式、非发送中）
        if (state.mode === "letter" && !state.sending && d.unreadTheirs < state.pending) {
          const n = state.pending - d.unreadTheirs;
          toast(n === 1 ? "TA 翻开了你寄出的信" : `TA 翻开了你寄出的 ${n} 封信`, 2200);
        }
        state.pending = d.unreadTheirs;
        updateSendBar();
      }
    }
    if (typeof d.unreadMine === "number" && d.unreadMine !== state.unread) {
      const grew = d.unreadMine > state.unread; // v4.56：WS 漏报时由轮询补上后台通知
      state.unread = d.unreadMine;
      updateBadge();
      if (grew) maybeNotifyNewLetter(d.unreadMine > 1 ? `TA 给你寄来了 ${d.unreadMine} 封信，点开看看` : "TA 给你寄来了一封信，点开看看");
    }
    // 兑换「畅寄五十页」后服务端即时放宽上限
    if (typeof d.pendingLimit === "number" && d.pendingLimit !== state.pendingLimit) {
      state.pendingLimit = d.pendingLimit;
      updateSendBar();
    }
    // v4.14：轮询值可能滞后（DO 不可达时退回带缓存的 KV 房间），标记为 sync 受保护窗约束
    if (d.mode && d.mode !== state.mode) setMode(d.mode, false, "sync");
    // v4.1 #47：房间成员数/名称随轮询刷新——对方后来才加入时，
    // 徽章才能从"等待另一位主人"正确切到"在线/离线"
    if (state.room) {
      if (typeof d.members === "number") state.room.members = d.members;
      if (d.name) state.room.name = d.name;
    }
    // v3.58「TA 在写信」：只在寄信模式亮（镜像模式笔迹直接落在纸上，无需再说）
    updateWritingPill(state.mode === "letter" && !!d.partnerWriting);
    renderPartnerBadge();
  } catch { /* 401 等由 api 层处理 */ }
}

/// v3.58「TA 在写信」指示胶囊——对方落笔时轻轻亮起，停笔后悄悄淡出。
/// 服务端按 12s 活动窗口判活（实时笔画帧 / 寄信模式书写心跳），轮询 3s 一次，
/// 所以最坏情况是停笔约 15s 后熄灭、落笔约 3s 后点亮——都是不急不躁的节奏
function updateWritingPill(on) {
  if (state.partnerWriting === on) return;
  state.partnerWriting = on;
  const el = $("writing-pill");
  if (el) el.classList.toggle("show", on);
  document.body.classList.toggle("peer-writing", on); // v4.52：与「TA 在听」同现时错开一层
}

// ---------------------------------------------------------------- presence

function updatePresence(peers) {
  const p = peers.find((x) => x.sid !== store.sid) || null;
  state.partner = p;
  state.partnerOnline = !!p;
  // v4.52：对方离场 → 「TA 在听」胶囊随之退场
  if (!p) renderPeerMusic({ playing: false });
  // v4.1 #46：对方在线 → 房间必然已是双人；members 不更新会导致
  // 对方掉线后一直显示"等待另一位主人"而不是"离线"（在线状态误报根源之一）
  if (p && state.room) state.room.members = Math.max(state.room.members || 1, 2);
  renderPartnerBadge();
}

function renderPartnerBadge() {
  const el = $("partner-badge");
  const mini = $("partner-mini");
  const nameEl = $("partner-name");
  const statusEl = $("partner-status");
  if (!state.room) return;

  // v3.8：当前状态签名 —— 只在状态真正变化时重展横幅并重启 5 秒倒计时，
  // 轮询每 3 秒调一次本函数，不能每次都重置计时（否则横幅永远缩不下去）
  let sig, online;
  if (state.partner) { sig = "p:" + (state.partner.nick || ""); online = true; }
  else if (state.room.members >= 2) { sig = "m2"; online = state.partnerOnline; }
  else { sig = "wait"; online = false; }

  // 已缩成挂饰时，在线小点与头像实时跟随，不再弹出横幅打扰书写
  if (mini && !mini.classList.contains("hidden")) {
    mini.classList.toggle("online", online);
    if (state.partner) mountAvatar($("partner-mini-avatar"), state.partner.avatar);
    else $("partner-mini-avatar").innerHTML = "";
  }

  if (state.badgeSig === sig) return;
  state.badgeSig = sig;

  // 状态变化 → 横幅完整显示（对方头像/昵称 + 在线状态，或等待提示），
  // 5 秒后自动缩小为头像框+在线状态，固定在「我的」下方
  clearTimeout(state.waitTimer);
  mini?.classList.add("hidden");
  el.classList.remove("hidden", "online", "offline");
  if (state.partner) {
    mountAvatar($("partner-avatar"), state.partner.avatar);
    nameEl.textContent = state.partner.nick || "另一位主人";
    statusEl.textContent = "在线";
    el.classList.add("online");
  } else if (state.room.members >= 2) {
    $("partner-avatar").innerHTML = "";
    nameEl.textContent = "另一位主人";
    statusEl.textContent = online ? "在线" : "离线";
    el.classList.add(online ? "online" : "offline");
  } else {
    $("partner-avatar").innerHTML = "";
    nameEl.textContent = "等待另一位主人…";
    statusEl.textContent = "把邀请码交给 TA";
  }
  state.waitTimer = setTimeout(() => {
    state.waitTimer = 0;
    el.classList.add("hidden");
    if (mini && state.room) {
      if (state.partner) mountAvatar($("partner-mini-avatar"), state.partner.avatar);
      else $("partner-mini-avatar").innerHTML = "";
      mini.classList.remove("hidden");
      mini.classList.toggle("online", online);
    }
  }, 5000);
}

// ================================================================ 书写

/// v3.58 书写心跳：寄信模式落笔期间每 5 秒给服务端发一枚 writing_ping（轻量、
/// 不广播、不进离线队列），让对端的 /live 轮询能感知"TA 在写信"；抬笔即停。
/// 服务端 12s 判活窗口盖得住 5s 间隔 + 3s 轮询节拍
function wireWritingPing() {
  const cv = pad.canvas;
  if (!cv) return;
  let timer = null;
  const ping = () => { if (state.mode === "letter") send({ t: "writing_ping" }); };
  cv.addEventListener("pointerdown", () => {
    if (timer) return;
    ping();
    timer = setInterval(ping, 5000);
  });
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
  window.addEventListener("blur", stop); // 切后台/切页停表，避免空房间一直"在写"
}

/// v4.41：实时帧的有效粗细倍率 = 本机粗细倍率 × 落笔时的缩放折细系数（zs）。
/// 纸面恒定模型：对端拿 ss 一个字段就能还原"放大写的字缩小后等比变细"，
/// 接收端无需再感知发送端的视口倍数。
function liveSS(zs) {
  const z = Number(zs) > 0 ? Number(zs) : 1;
  return Math.round((pad.strokeScale || 1) * z * 100) / 100;
}

function wirePad() {
  pad.onStrokeEnd = (stroke) => {
    markInput();
    state.redoStack.length = 0; // v3.53：新笔画落定，重做历史作废
    if (state.mode === "realtime") {
      // v3.8：收尾前把缓冲里没发完的逐点流冲出去，对方先看到完整实时轨迹
      if (state.liveBuf) {
        for (const [sid, ptsArr] of state.liveBuf) {
          if (ptsArr.length) {
            send({ t: "drawing", id: sid, pts: ptsArr.map(([x, y, p, t, rd]) => [Math.round(x / pad.w * VW), Math.round(y / pad.h * VH), Math.round(p * 100) / 100, t, ...(rd != null ? [Math.round(rd * 10) / 10] : [])]), color: (pad.current?.ink?.c) || currentInk(), ...(pad.current?.iv ? { iv: pad.current.iv } : {}), a: effectiveAspect(), ps: pad.penScale, ss: liveSS(stroke?.zs), si: state.sheetIdx }); // v4.48 逐笔墨色；v4.63 rd 随行
          }
        }
        state.liveBuf.clear();
      }
      // np/tip：无压感速度因子与自动出锋标记随笔画同步，对端重放同算法还原；
      // v3.23 #6：长笔画自动按 200 点/片分帧
      sendStrokeRealtime(stroke);
    }
    updateSendBar();
    scheduleImmersive(); // v4.50：收笔后开始计沉浸
    if (inImmersive()) scheduleImmersiveExit(); // v4.60：沉浸中停笔 1 秒自动恢复界面
  };
  pad.onLiveChunk = (id, chunk) => {
    if (state.mode !== "realtime") return;
    // v3.8 修镜像速度：节流窗口内的点先攒进缓冲，到点一次性发出——
    // 老逻辑直接丢弃窗口内的点，对方看到的实时笔迹稀疏卡顿、与原速不符
    if (!state.liveBuf) state.liveBuf = new Map();
    const arr = state.liveBuf.get(id) || [];
    for (const pt of chunk) arr.push(pt);
    state.liveBuf.set(id, arr);
    const nowT = performance.now();
    const cfg = window.__plConfig || {};
    // v4.38：光标帧间隔收紧（配合接收端缓动，快写时不再一步一停）
    const gap = Math.max(60, Math.min(120, cfg.cursorSyncIntervalMs || 90));
    if (nowT - state.liveAcc < gap) return;
    state.liveAcc = nowT;
    for (const [sid, ptsArr] of state.liveBuf) {
      if (ptsArr.length) {
        send({ t: "drawing", id: sid, pts: ptsArr.map(([x, y, p, t, rd]) => [Math.round(x / pad.w * VW), Math.round(y / pad.h * VH), Math.round(p * 100) / 100, t, ...(rd != null ? [Math.round(rd * 10) / 10] : [])]), color: (pad.current?.ink?.c) || currentInk(), ...(pad.current?.iv ? { iv: pad.current.iv } : {}), a: effectiveAspect(), ps: pad.penScale, ss: liveSS(pad.current?.zs), si: state.sheetIdx }); // v4.48 逐笔墨色；v4.63 rd 随行
      }
    }
    state.liveBuf.clear();
  };
  pad.onEraseAt = (x, y, r) => {
    send({ t: "erase_at", x: x / pad.w * VW, y: y / pad.h * VH, r: r / pad.w * VW });
  };
  // v4.50 整笔橡皮：本端删掉一整笔后广播——自己写的笔让对端删镜像副本（mine），
  // 对端写的笔让对端删 TA 的本地原件（yours）。自己写的笔同时进重做栈可反悔
  pad.onStrokeErased = (st) => {
    markInput();
    if (!String(st.id).startsWith("r")) {
      st._eraserSynced = true; // v4.52：这笔的删除已广播对端——重做放回时须重新广播（见 doRedo）
      state.redoStack.push(st);
      send({ t: "stroke_erase", mine: st.id });
    } else {
      const rid = Number(String(st.id).slice(1));
      state.remoteIds.delete(st.id);
      if (Number.isFinite(rid)) send({ t: "stroke_erase", yours: rid });
    }
    updateSendBar();
    haptic(6);
  };
  // v3.6 多指手势（双指橡皮/三指视口）打断了进行中的笔画 → 通知对端丢弃半截轨迹，两端保持一致
  pad.onGestureStart = (cancelledId) => {
    predictClear(); // v4.50：手势打断进行中的笔，预测尾迹一并清掉
    if (state.mode === "realtime" && cancelledId != null) send({ t: "live_cancel", id: cancelledId });
  };
  // v4.17：双指缩放/复位 → 屏幕中央浮提示百分比；预览层与对端光标按新视口重排对齐
  pad.onViewChange = (v) => {
    liveRedrawInflight();
    placePartnerCursor();
    showCenterTip(Math.round(v.s * 100) + "%");
  };

  // v4.50 iOS 笔迹预测：引擎在支持的浏览器上会带着前瞻点回调（其它内核恒 null）
  pad.onPredict = (pts) => predictDraw(pts);

  // v4.31：冷却解除后中途起笔（捏合完直接接着写的那一笔）——补上落笔准备与
  // 墨波/触感，和正常落笔同一口径；此前这一段书写会被整笔丢弃
  pad.onStrokeBegin = (pos, stroke) => {
    if (!stroke) return;
    markInput();
    state.remoteAspect = null;
    if (localAspect() !== effectiveAspect()) requestPaperSize();
    send({ t: "aspect", a: effectiveAspect() });
    setWriting(true);
    fx?.splash(pos.x, pos.y, 0.9);
    haptic(4);
  };

  inkCanvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    // v4.31：先清幽灵手指再判断"是不是第二指"——漏收 pointerup 的残留指针会让
    // 每次落笔都被误判成第二指（跳过落笔准备 + 进手势把整笔吞掉）
    pad.pruneStalePointers();
    // v3.4：第二根手指落下是双指手势的开始 —— 不重置远端比例、不重排信纸，
    // 否则捏合过程中信纸面积/位置会跳变（表现为「信纸被移动」）。
    const isSecondFinger = pad.pointers.size >= 1;
    if (!isSecondFinger) {
      markInput();
      state.remoteAspect = null;
      if (localAspect() !== effectiveAspect()) requestPaperSize();
      send({ t: "aspect", a: effectiveAspect() });
      setWriting(true);
    }
    if (pad.eraseTool) showEraserRing(e);
    const act = pad.pointerDown(e);
    if (act === "draw" || act === "erase") focusWriting(); // v4.37：书写聚焦暂停氛围层
    if (act === "draw") {
      const pos = pad.toLocal(e);
      fx?.splash(pos.x, pos.y, 0.5 + (e.pressure || 0.5) * 0.7);
      haptic(4); // v3.48 落笔一触（不支持的设备自动无感）
    }
  });
  // v4.46 低延迟输入通道：Chrome/安卓支持 pointerrawupdate——数字化仪的原始
  // 采样先于常规 pointermove 的「命中测试 + 事件合并 + 渲染对齐」排队直接派发，
  // 一笔能省下 1–2 帧的输入延迟（画布已有 touch-action:none，满足派发前提）。
  // 不支持的浏览器（Safari/旧内核）自动回落 pointermove，行为完全一致。
  const rawMoveOk = typeof window !== "undefined" && "onpointerrawupdate" in window;
  const onInkMove = (e) => {
    e.preventDefault?.();
    if (pad.erasing) showEraserRing(e);
    pad.pointerMove(e);
    const cfg = window.__plConfig || {};
    // v4.38：光标帧间隔收紧（配合接收端缓动，快写时不再一步一停）
    const gap = Math.max(60, Math.min(120, cfg.cursorSyncIntervalMs || 90));
    const nowT = performance.now();
    if (state.partnerOnline && nowT - state.cursorAcc > gap) {
      state.cursorAcc = nowT;
      const pos = pad.toLocal(e);
      send({ t: "cursor", x: pos.x / pad.w, y: pos.y / pad.h });
    }
  };
  inkCanvas.addEventListener(rawMoveOk ? "pointerrawupdate" : "pointermove", onInkMove);
  // 低延迟通道生效时常规 pointermove 仍会到——只做默认行为拦截，不重复入墨
  if (rawMoveOk) inkCanvas.addEventListener("pointermove", (e) => { e.preventDefault(); });
  inkCanvas.addEventListener("pointerup", up);
  inkCanvas.addEventListener("pointercancel", up);
  inkCanvas.addEventListener("contextmenu", (e) => e.preventDefault());
  // v4.31：window 级兜底释放——画布漏收抬笔事件（手指划出画布、浏览器接管手势、
  // 切后台）时把指针放回表外，绝不留幽灵手指。冒泡阶段执行：画布自己处理过的
  // 事件到这里已是空操作
  for (const ev of ["pointerup", "pointercancel"]) {
    window.addEventListener(ev, (e) => pad.releasePointer(e));
  }
  // v4.32：画布矩形缓存的失效时机（落笔瞬间引擎自己会重读一次，这里兜住行笔途中
  // 被挪动的情况：滚动、视口/键盘、横竖屏、全屏切换）
  window.addEventListener("resize", () => pad.invalidateRect());
  window.addEventListener("orientationchange", () => pad.invalidateRect());
  window.visualViewport?.addEventListener("resize", () => pad.invalidateRect());
  window.visualViewport?.addEventListener("scroll", () => pad.invalidateRect());
  document.addEventListener("fullscreenchange", () => pad.invalidateRect());
  window.addEventListener("scroll", () => pad.invalidateRect(), true);

  function up(e) {
    // v3.16 #14：抬笔瞬间一圈更轻的收笔涟漪（仅书写中，擦除/手势不触发）
    const wasDrawing = !!pad.current;
    const pos = pad.toLocal(e);
    pad.pointerUp(e);
    if (wasDrawing) {
      fx?.lift(pos.x, pos.y);
      haptic(7); // v3.48 抬笔一收
    }
    setWriting(false);
    $("eraser-ring").style.display = "none";
    updateSendBar();
  }
}

/// v3.23 #7：坐标归一化的统一量化工具——所有发往对端/服务端的坐标都经它，
/// 口径一致（单位 VW×VH，保留 1 位小数），避免各处手写 Math.round 漂移
function quant(v, unit = VW, prec = 1) {
  const f = 10 ** prec;
  return Math.round(v * unit * f) / f;
}

function normPts(pts) {
  // v4.63：第 5 位可选 rd（原始输入点距）——速度因子跨端/重放同口径的必要数据；
  // 旧端解构四元组自动忽略，向后兼容
  return pts.map(([x, y, p, t, rd]) => [
    quant(x / pad.w),
    quant(y / pad.h, VH),
    p, t,
    ...(rd != null ? [Math.round(rd * 10) / 10] : []),
  ]);
}

/// v3.23 #6：长笔画分片发送——单笔超过 200 点时按 200 点/片拆成多帧
/// （stroke_part），接收端凑齐后按完整笔画处理；短笔画仍走单帧 stroke。
/// 目的：单帧过大容易触碰消息上限/卡顿，且失败时不必整笔重来。
const STROKE_CHUNK = 200;
function sendStrokeRealtime(stroke) {
  const pts = normPts(stroke.pts);
  const meta = { id: stroke.id, color: stroke.color || currentInk(), durationMs: stroke.durationMs,
    // v4.48：白笺墨盘选择值（含透明度/渐变）随笔画走——对端逐笔精确还原
    ...(stroke.iv ? { iv: stroke.iv } : {}),
    a: effectiveAspect(), ps: pad.penScale, np: stroke.np ?? 1, si: state.sheetIdx,
    // v4.39：笔迹粗细"跟人走"——把书写者自己选的倍率随笔画发出去，
    // 对端按它渲染这一笔（A 的笔 1.0x、B 的笔 2.5x，两边看到的一致）
    // v4.41：落笔缩放折细系数（zs）一并折进 ss——放大写的字对端同样等比细
    ss: liveSS(stroke.zs),
    ...(stroke.tip ? { tip: stroke.tip } : {}) };
  if (pts.length <= STROKE_CHUNK) {
    send({ t: "stroke", ...meta, pts });
    return;
  }
  const total = Math.ceil(pts.length / STROKE_CHUNK);
  for (let i = 0; i < total; i++) {
    send({ t: "stroke_part", ...meta, idx: i, total, pts: pts.slice(i * STROKE_CHUNK, (i + 1) * STROKE_CHUNK) });
  }
}

/// 接收端：按笔画 id 收集分片，凑齐 total 片后按整笔走 onPartnerStroke
function onStrokePart(ev) {
  if (!ev || !ev.id) return;
  const total = Math.max(1, Math.min(64, Number(ev.total) || 1));
  const idx = Number(ev.idx) || 0;
  if (idx >= total) return;
  let acc = state.strokeParts.get(ev.id);
  if (!acc) {
    acc = { total, meta: ev, parts: new Array(total).fill(null) };
    state.strokeParts.set(ev.id, acc);
    if (state.strokeParts.size > 64) state.strokeParts.delete(state.strokeParts.keys().next().value); // 残缺分片兜底淘汰
  }
  acc.parts[idx] = Array.isArray(ev.pts) ? ev.pts : [];
  if (acc.parts.some((p) => !p)) return; // 还没凑齐
  state.strokeParts.delete(ev.id);
  onPartnerStroke({ ...acc.meta, pts: acc.parts.flat() });
}

function setWriting(on) {
  state.writing = on;
  // v4.43：只有「书写」打断天气沉浸——落笔（本端或对端来帧）立刻退出，
  // 抬笔重新开始 8 秒计时；敲键/点按钮/换信纸等 UI 操作不打断也不重置
  resetWeatherIdle();
  document.body.classList.toggle("writing", on);
}
function markInput() { state.lastInput = Date.now(); } // v4.43：UI 操作（按钮/换信纸/敲键）不打断天气沉浸——只有「书写」才算

// ---------------------------------------------------------------- v4.50 沉浸书写
/// 收笔安静约 2 秒后整个界面缓缓隐去，只留纸和笔；点屏幕上下边缘唤回。
/// 弹层/抽屉/重放层开着、寄信动画中、橡皮工具开着时不进；看信/开抽屉/寄信/
/// 新信横幅出现立即退出。手动「隐藏界面」（dim-ui）开着时不叠加接管。
const IMMERSIVE_DELAY = 2200;
let immersiveTimer = 0;
let immersiveExitTimer = 0; // v4.60：沉浸中停笔 1 秒自动恢复的倒计时
function anyOverlayOpen() {
  const lo = $("letter-overlay");
  if (lo && !lo.classList.contains("hidden")) return true;
  if ($("letter-drawer")?.classList.contains("open")) return true;
  for (const id of ["theme-popup", "blanc-popup", "music-pop", "eraser-pop", "tip-pop", "width-pop"]) {
    const el = $(id);
    if (el && !el.classList.contains("hidden")) return true;
  }
  return false;
}
function inImmersive() { return document.body.classList.contains("immersive"); }
function enterImmersive() {
  if (inImmersive() || anyOverlayOpen() || state.sending || pad.eraseTool) return;
  if (document.body.classList.contains("dim-ui")) return;
  if (state.voice && state.voice.state !== "idle") return; // v4.52：语音呼叫/通话中不淡出界面
  clearTimeout(immersiveExitTimer); // v4.60：进入即作废待发的停笔恢复
  immersiveExitTimer = 0;
  document.body.classList.add("immersive");
  predictClear();
  showImmersiveHintOnce();
}
function exitImmersive() {
  clearTimeout(immersiveTimer);
  clearTimeout(immersiveExitTimer); // v4.60：手动/其他出口也作废待发的停笔恢复
  immersiveExitTimer = 0;
  immersiveTimer = 0;
  document.body.classList.remove("immersive");
}
/// v4.60：沉浸中停笔 1 秒自动恢复界面——沉浸的本意是「书写时别挡纸」，
/// 停笔就是要摸工具的信号，不必再跑去点屏幕边缘；恢复后进入/退出其余逻辑不变
function scheduleImmersiveExit() {
  clearTimeout(immersiveExitTimer);
  immersiveExitTimer = setTimeout(() => {
    immersiveExitTimer = 0;
    if (!inImmersive()) return;
    exitImmersive(); // exitImmersive 会一并清掉同笔的进入倒计时，不会刚恢复又隐去
  }, 1000);
}
function scheduleImmersive() {
  clearTimeout(immersiveTimer);
  immersiveTimer = setTimeout(() => {
    immersiveTimer = 0;
    if (state.writing || pad.current) { scheduleImmersive(); return; } // 笔还在走不进
    enterImmersive();
  }, IMMERSIVE_DELAY);
}
function showImmersiveHintOnce() {
  try {
    if (localStorage.getItem("pl_immersive_hint")) return;
    localStorage.setItem("pl_immersive_hint", "1");
  } catch { /* ok */ }
  const el = document.createElement("div");
  el.id = "immersive-hint";
  el.textContent = "沉浸书写中 · 点屏幕上下边缘唤回界面";
  document.body.appendChild(el);
  setTimeout(() => { el.classList.add("fade"); setTimeout(() => el.remove(), 600); }, 3200);
}
function wireImmersive() {
  for (const id of ["immersive-edge-top", "immersive-edge-bottom"]) {
    $(id)?.addEventListener("pointerdown", (e) => { e.preventDefault(); exitImmersive(); });
  }
  document.addEventListener("visibilitychange", () => { if (document.hidden) exitImmersive(); });
  // v4.57：沉浸书写此前只在「收笔后 2.2 秒」触发——纸上已有墨但人停手思考、
  // 或草稿恢复后没再落笔时永远等不到。补一条空闲通道：纸上有墨 + 6 秒无任何
  // 操作（任何点按都会续期）+ 没开弹层/语音/天气沉浸 → 也进入沉浸书写。
  setInterval(() => {
    if (inImmersive() || state.writing || pad.current || !pad.hasInk()) return;
    if (anyOverlayOpen() || state.sending || pad.eraseTool) return;
    if (document.body.classList.contains("dim-ui")) return;
    if (state.voice && state.voice.state !== "idle") return;
    if (immersiveOn) return; // 天气沉浸进行中不叠加
    if (Date.now() - state.lastInput < 6000) return;
    enterImmersive();
  }, 2000);
}

// ================================================================ 重放

/// v4.1 #11 实时预览独立层：对端逐点流画在 #live-canvas 上，与主画布
/// （定稿笔画 + 重放动画）完全隔离——此前预览直接画主画布，整笔到达时
/// 必须 pad.redraw() 清预览，会把「另一笔正在进行的重放动画」一并抹掉
/// （实时镜像丢笔迹的根源），且预览+重放同笔叠加造成重复变深。
let liveCtx = null, liveDpr = 1;
function liveCanvasInit() {
  const cv = $("live-canvas");
  if (!cv) return null;
  if (!liveCtx) liveCtx = cv.getContext("2d");
  return cv;
}
/// v4.17：预览层与主画布共用同一套视口变换——双指放大时，对端正在写的
/// 那一笔也必须跟着放大、落在放大后的位置上，两层不错位
function liveSetViewTransform() {
  const v = pad.view;
  liveCtx.setTransform(liveDpr * v.s, 0, 0, liveDpr * v.s, liveDpr * v.x, liveDpr * v.y);
  predictSetView(); // v4.50：预测层与主画布/预览层共用同一视口变换
}
function liveCanvasResize(w, h, dpr) {
  const cv = $("live-canvas");
  if (!cv) return;
  liveDpr = dpr;
  cv.width = Math.max(1, Math.round(w * dpr));
  cv.height = Math.max(1, Math.round(h * dpr));
  liveCtx = cv.getContext("2d");
  liveSetViewTransform();
}
function liveCanvasClear() {
  const cv = $("live-canvas");
  if (!cv || !liveCtx) return;
  liveCtx.setTransform(1, 0, 0, 1, 0, 0);
  liveCtx.clearRect(0, 0, cv.width, cv.height);
  liveSetViewTransform();
}

/// v4.17 预览层记账：整笔点迹另存一份（接缝尾窗凑不齐整笔），供缩放时整笔重画
function liveRemember(ev, pts) {
  // v4.48：随记录解析一次逐笔墨色（渐变图案/透明度），增量绘制与整笔重画同墨
  const rec = state.liveFull.get(ev.id) || { color: ev.color, fill: liveInkOf(ev), pts: [] };
  for (const p of pts) rec.pts.push(p);
  state.liveFull.set(ev.id, rec);
}
function liveForget(id) {
  state.liveChunks.delete(id);
  state.liveFull.delete(id);
}
function liveForgetAll() {
  // v4.32 修复：这里此前写的是 liveForgetAll() 调用自己——无限递归，一触发就是
  // 栈溢出 RangeError，把紧随其后的预览清空/溶解动画/翻页器与光晕刷新一起带走
  // （对端清空、离线补齐、翻页、本端清空四条路径都会撞上）
  state.liveChunks.clear();
  state.liveFull.clear();
}
/// v4.17：视口变了 → 预览层按新视口把进行中的笔整笔重画（增量像素是旧视口画的，不清会错位）
function liveRedrawInflight() {
  const cv = $("live-canvas");
  if (!cv || !liveCtx) return;
  liveCtx.setTransform(1, 0, 0, 1, 0, 0);
  liveCtx.clearRect(0, 0, cv.width, cv.height);
  liveSetViewTransform();
  // v4.41：纸面恒定粗细——对端缩放已折进 ss，预览层不再按本机视口折算；保底贴屏幕
  const fl = 0.8 / Math.max(0.01, pad.view.s);
  for (const rec of state.liveFull.values()) {
    if (!rec.pts.length) continue;
    const ctx = liveCtx;
    ctx.save();
    ctx.globalAlpha = 0.97;
    // v4.32：与本地书写/定稿同一套几何（等宽段合并描线）——对端进行中的笔
    // 不再有叠盖接缝，落定那一刻线形也不会跳变
    strokeRuns(ctx, rec.pts, rec.fill || rec.color, 1, fl); // v4.48：逐笔墨色
    ctx.restore();
  }
}

// ---------------------------------------------------------------- v4.50 存为图片
/// 把当前页（信纸底 + 逐笔多色墨迹）渲染成 PNG。信纸底尽力还原：
/// 底色 → 背景图（cover）→ CSS 线性渐变；模板动态信纸还原不了的部分优雅降级。
function parseLinearGradientSpec(ctx, inner, w, h) {
  try {
    const parts = [];
    let depth = 0, cur = "";
    for (const ch of inner) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (ch === "," && depth === 0) { parts.push(cur.trim()); cur = ""; } else cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    let angle = 180; // CSS 缺省 to bottom
    if (/^(to\s|[-\d.]+deg)/i.test(parts[0] || "")) {
      const head = parts.shift();
      const dm = /^([-\d.]+)deg$/i.exec(head);
      if (dm) angle = Number(dm[1]);
      else if (/to\s+top\b/i.test(head)) angle = 0;
      else if (/to\s+right\b/i.test(head)) angle = 90;
      else if (/to\s+left\b/i.test(head)) angle = 270;
    }
    const stops = [];
    for (const p of parts) {
      const cm = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))\s*([\d.]+%)?/.exec(p);
      if (cm) stops.push({ c: cm[1], o: cm[2] != null ? Number(cm[2]) / 100 : null });
    }
    if (stops.length < 2) return null;
    stops[0].o = stops[0].o ?? 0;
    stops[stops.length - 1].o = stops[stops.length - 1].o ?? 1;
    for (let i = 1; i < stops.length - 1; i++) if (stops[i].o == null) stops[i].o = i / (stops.length - 1);
    const rad = angle * Math.PI / 180;
    const len = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
    const dx = Math.sin(rad) * len / 2, dy = -Math.cos(rad) * len / 2;
    const g = ctx.createLinearGradient(w / 2 - dx, h / 2 - dy, w / 2 + dx, h / 2 + dy);
    for (const st of stops) g.addColorStop(Math.max(0, Math.min(1, st.o)), st.c);
    return g;
  } catch { return null; }
}

async function paintPaperBackdrop(ctx, w, h) {
  const cs = getComputedStyle(paper);
  ctx.fillStyle = cs.backgroundColor || "#ffffff";
  ctx.fillRect(0, 0, w, h);
  const bi = cs.backgroundImage || "none";
  if (!bi || bi === "none") return;
  const urlM = /url\("?(.*?)"?\)/.exec(bi);
  if (urlM && urlM[1]) {
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = urlM[1];
      await img.decode();
      if (img.width > 1 && img.height > 1) {
        const ar = img.width / img.height, tar = w / h;
        let dw = w, dh = h, dx = 0, dy = 0;
        if (ar > tar) { dw = h * ar; dx = (w - dw) / 2; } else { dh = w / ar; dy = (h - dh) / 2; }
        ctx.drawImage(img, dx, dy, dw, dh);
        return;
      }
    } catch { /* 图取不到就落渐变/纯色 */ }
  }
  const lg = /linear-gradient\(([^)]*(?:\([^)]*\)[^)]*)*)\)/.exec(bi);
  if (lg) {
    const g = parseLinearGradientSpec(ctx, lg[1], w, h);
    if (g) { ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); }
  }
}

async function exportPageImage() {
  if (!pad.strokes.length) { toast("这页还没有墨迹"); return; }
  toast("正在生成图片…", 1400);
  try {
    const scale = Math.min(3, Math.max(2, window.devicePixelRatio || 2));
    const w = Math.max(2, Math.round(pad.w * scale)), h = Math.max(2, Math.round(pad.h * scale));
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d");
    await paintPaperBackdrop(ctx, w, h);
    pad.renderPageTo(ctx, scale); // 逐笔多色/透明度与屏幕完全一致
    const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
    if (!blob) throw new Error("toBlob");
    const d = new Date();
    const fname = `paperlink-${store.roomCode || "page"}-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.png`;
    // 手机优先走系统分享（可直接发微信/QQ/存相册），不支持再落下载
    if (typeof File === "function" && navigator.canShare) {
      const file = new File([blob], fname, { type: "image/png" });
      if (navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: "PaperLink" }); return; }
        catch (e) { if (e && e.name === "AbortError") return; }
      }
    }
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast("图片已保存", 1800);
  } catch {
    toast("导出失败了，换个浏览器再试试");
  }
}

// ================================================================ v4.57 信件导出

/// 选择模式开关：书信集头部「导出」按钮进入——卡片左沿出现勾选圈，
/// 点卡片=勾选/取消（不再开信）；底部出现操作条（全选/取消/导出 N 页）
function setLetterSelecting(on) {
  state.letterSelecting = !!on;
  if (!state.letterSelecting) state.letterSelected.clear();
  $("letter-export-bar")?.classList.toggle("hidden", !state.letterSelecting);
  $("drawer-export")?.classList.toggle("on", state.letterSelecting);
  renderLetters();
  updateExportBar();
}
function toggleLetterSelect(pid, item) {
  if (state.letterSelected.has(pid)) state.letterSelected.delete(pid);
  else state.letterSelected.add(pid);
  item?.querySelector(".sel-dot")?.classList.toggle("on", state.letterSelected.has(pid));
  updateExportBar();
}
function updateExportBar() {
  const go = $("lexport-go");
  const all = $("lexport-all");
  if (!go) return;
  const n = state.letterSelected.size;
  go.disabled = n === 0;
  go.textContent = n > 0 ? `导出 ${n} 页` : "导出";
  const pdfBtn = $("lexport-pdf"); // v4.60：PDF 通道同选集联动
  if (pdfBtn) pdfBtn.disabled = n === 0;
  const shown = state.favFilter ? state.letters.filter((p) => state.favs.has(p.pid)) : state.letters;
  const allOn = shown.length > 0 && shown.every((p) => state.letterSelected.has(p.pid));
  if (all) all.textContent = allOn ? "取消全选" : "全选";
}

/// 把一封存档信画到离屏画布（宽 w、高按信件自身宽高比）：信纸底色 +
/// 与开信重放完全同款算法重建笔画（压感/出锋/缩放折细/逐笔墨色与渐变墨）
function paintLetterCanvas(page, w, dpr) {
  const a = Math.max(0.2, Math.min(5, page.aspect || PORTRAIT));
  const h = Math.max(2, Math.round(w / a));
  const cv = document.createElement("canvas");
  cv.width = Math.max(2, Math.round(w * dpr));
  cv.height = Math.max(2, Math.round(h * dpr));
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const t = themeById(page.theme) || themeById("parchment");
  ctx.fillStyle = t?.paper || "#f5f0e4";
  ctx.fillRect(0, 0, w, h);
  // 页级墨色：存档 hex > 存档渐变规格 > 主题默认墨（与重放同口径）
  const gSpec = typeof page.ink === "string" && page.ink.startsWith("g:")
    ? page.ink.slice(2).split(",").filter((c) => /^#[0-9a-fA-F]{3,8}$/.test(c)) : null;
  const defHex = /^#[0-9a-fA-F]{3,8}$/.test(page.ink || "") ? page.ink
    : ((gSpec && gSpec[0]) || (t ? themeInkOf(t, "#43301c") : "#43301c"));
  let baseInk = defHex;
  if (gSpec && gSpec.length >= 2) {
    const gCv = makeInkGradientCanvas(w, h, gSpec);
    baseInk = (gCv && ctx.createPattern(gCv, "no-repeat")) || defHex;
  }
  const patMap = new Map();
  const strokes = (page.pts || []).map((s) => {
    const isObj = s && !Array.isArray(s) && Array.isArray(s.p);
    const rawPts = isObj ? s.p : s;
    const np = isObj ? s.np !== 0 : true;
    const tip = isObj ? (Number(s.tip) || 0) : 0;
    const zs = isObj && Number(s.zs) > 0 ? Number(s.zs) : 1;
    const iv = isObj && typeof s.iv === "string" && s.iv !== "" && validateInkSel(s.iv) ? s.iv : null;
    let ink = baseInk;
    if (iv) {
      const ik = inkFromSel(iv, defHex);
      if (ik.g) {
        const key = ik.g.join(",");
        let pat = patMap.get(key);
        if (pat === undefined) {
          const pc = makeInkGradientCanvas(w, h, ik.g);
          pat = pc ? ctx.createPattern(pc, "no-repeat") : null;
          patMap.set(key, pat);
        }
        ink = pat || ik.c;
      } else ink = ik.c;
    }
    return {
      ink,
      pts: roundSharpCorners(pad.widthsFor((rawPts || []).map(([x, y, p, tt]) => ({
        x: x / VW * w, y: y / VH * h, p, t: tt || 0,
      })), np, tip, (pad.strokeScale || 1) * zs)),
    };
  });
  ctx.save();
  ctx.globalAlpha = 0.97;
  for (const { pts, ink } of strokes) {
    if (!pts || !pts.length) continue;
    if (pts.length === 1) strokeSegment(ctx, pts, 0, ink);
    else for (let i = 0; i < pts.length - 1; i++) strokeSegment(ctx, pts, i, ink);
  }
  ctx.restore();
  return cv;
}

/// 选中的信按时间正序拼成一张竖长图（页间留窄缝）→ 手机走系统分享、桌面下载。
/// 像素预算自适应：单页 2x 清晰；多页拼长图超浏览器画布上限时自动降采样。
async function exportSelectedLetters(kind = "png") {
  const pages = state.letters
    .filter((p) => state.letterSelected.has(p.pid))
    .sort((x, y) => (x.ts || 0) - (y.ts || 0));
  if (!pages.length) { toast("先勾选要导出的信", 1800); return; }
  if (pages.length > 9) { toast("一次最多导 9 页，少选几封再试", 2200); return; }
  if (kind === "pdf") { await exportLettersPdf(pages); return; } // v4.60：PDF 通道
  toast(pages.length > 1 ? `正在拼 ${pages.length} 页信…` : "正在生成图片…", 1600);
  try {
    const W = 750, GAP = 26;
    const probe = pages.map((p) => paintLetterCanvas(p, W, 1)); // dpr1 先量高度
    const cssH = probe.reduce((s, c) => s + c.height, 0) + GAP * (probe.length - 1);
    const scale = W * 2 * cssH * 2 <= 15e6 ? 2 : 1; // 像素预算内才上 2x
    const cvs = scale === 2 ? pages.map((p) => paintLetterCanvas(p, W, 2)) : probe;
    const cv = document.createElement("canvas");
    cv.width = Math.round(W * scale);
    cv.height = Math.round(cssH * scale);
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#f6f2e8";
    ctx.fillRect(0, 0, cv.width, cv.height);
    let y = 0;
    for (const c of cvs) {
      const paintDpr = c.width / W; // 该页画布自带的采样倍率（1 或 2）
      const cssH = c.height / paintDpr;
      ctx.drawImage(c, 0, Math.round(y * scale), Math.round(W * scale), Math.round(cssH * scale));
      y += cssH + GAP;
    }
    const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
    if (!blob) throw new Error("toBlob");
    const d = new Date();
    const fname = `paperlink-letters-${pages.length}p-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.png`;
    if (typeof File === "function" && navigator.canShare) {
      const file = new File([blob], fname, { type: "image/png" });
      if (navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: "PaperLink" }); setLetterSelecting(false); return; }
        catch (e) { if (e && e.name === "AbortError") return; }
      }
    }
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast("图片已保存", 1800);
    setLetterSelecting(false);
  } catch {
    toast("导出失败了，换个浏览器再试试", 2400);
  }
}

/// v4.60 导出 PDF：一封信一页（页面宽高比跟随信件自身），打印/存档/发电脑都方便。
/// 画面与长图同款渲染（压感/出锋/逐笔墨色/渐变墨/信纸底色），只是容器换成 PDF。
async function exportLettersPdf(pages) {
  toast(pages.length > 1 ? `正在把 ${pages.length} 页信转成 PDF…` : "正在转成 PDF…", 1600);
  try {
    const items = [];
    for (const p of pages) {
      const cv = paintLetterCanvas(p, 1000, 2);
      const blob = await new Promise((res) => cv.toBlob(res, "image/jpeg", 0.9));
      if (!blob) throw new Error("jpeg");
      items.push({
        bytes: new Uint8Array(await blob.arrayBuffer()),
        w: cv.width, h: cv.height,
        aspect: Math.max(0.2, Math.min(5, p.aspect || PORTRAIT)),
      });
    }
    const pdf = buildPdfFromJpegs(items);
    const d = new Date();
    const fname = `paperlink-letters-${pages.length}p-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.pdf`;
    if (typeof File === "function" && navigator.canShare) {
      const file = new File([pdf], fname, { type: "application/pdf" });
      if (navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: "PaperLink" }); setLetterSelecting(false); return; }
        catch (e) { if (e && e.name === "AbortError") return; }
      }
    }
    const a = document.createElement("a");
    const url = URL.createObjectURL(pdf);
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast("PDF 已保存", 1800);
    setLetterSelecting(false);
  } catch {
    toast("导出失败了，换个浏览器再试试", 2400);
  }
}

/// 手写最小 PDF 生成器（零第三方依赖）：每页一个 Page 对象，信纸画面以
/// JPEG 原样 DCTDecode 嵌入（PDF 原生支持，不必再编码 flate）。
/// 对象编号：1 catalog / 2 pages / 每页 3+3i page、4+3i content、5+3i image；
/// xref 偏移按字节累计，二进制安全（字符串与 Uint8Array 混排）。
function buildPdfFromJpegs(items) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let pos = 0;
  const push = (part) => { const b = typeof part === "string" ? enc.encode(part) : part; chunks.push(b); pos += b.length; };
  const n = items.length;
  push("%PDF-1.4\n");
  offsets[1] = pos; push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  const kids = items.map((_, i) => `${3 + i * 3} 0 R`).join(" ");
  offsets[2] = pos; push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`);
  items.forEach((it, i) => {
    const pg = 3 + i * 3, co = 4 + i * 3, im = 5 + i * 3;
    const W = 595.28, H = W / it.aspect; // A4 幅宽，高度随信件宽高比
    offsets[pg] = pos;
    push(`${pg} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W.toFixed(2)} ${H.toFixed(2)}] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${co} 0 R >>\nendobj\n`);
    const stream = `q ${W.toFixed(2)} 0 0 ${H.toFixed(2)} 0 0 cm /Im0 Do Q`;
    offsets[co] = pos;
    push(`${co} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
    offsets[im] = pos;
    push(`${im} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${it.w} /Height ${it.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${it.bytes.length} >>\nstream\n`);
    push(it.bytes);
    push("\nendstream\nendobj\n");
  });
  const total = 3 * n + 3; // 对象编号到 3n+2，xref 含 0 号共 3n+3 条
  const xrefPos = pos;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  push(xref);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);
  return new Blob(chunks, { type: "application/pdf" });
}

// ---------------------------------------------------------------- v4.50 iOS 笔迹预测层
// WebKit 的 getPredictedEvents 给出下一帧的前瞻采样点。预测尾迹画在独立层上、
// 半透明呈现，真迹一到（下一次 onPredict / 抬笔 / 手势打断）整层清掉——
// 主观延迟再压一档，且永远不污染主画布（预测错了也不会留墨）。
let predictCtx = null, predictDpr = 1;
function predictCanvasResize(w, h, dpr) {
  const cv = $("predict-canvas");
  if (!cv) return;
  predictDpr = dpr;
  cv.width = Math.max(1, Math.round(w * dpr));
  cv.height = Math.max(1, Math.round(h * dpr));
  predictCtx = cv.getContext("2d");
  predictSetView();
}
function predictSetView() {
  if (!predictCtx) return;
  const v = pad.view;
  predictCtx.setTransform(predictDpr * v.s, 0, 0, predictDpr * v.s, predictDpr * v.x, predictDpr * v.y);
}
function predictClear() {
  const cv = $("predict-canvas");
  if (!cv || !predictCtx) return;
  predictCtx.setTransform(1, 0, 0, 1, 0, 0);
  predictCtx.clearRect(0, 0, cv.width, cv.height);
  predictSetView();
}
/// 引擎回调：pts = 纸面坐标的前瞻点（null = 清空）
function predictDraw(pts) {
  if (!predictCtx) return;
  predictClear();
  if (!pts || !pts.length || !pad.current) return;
  const all = pad.current.pts;
  if (!all.length) return;
  const last = all[all.length - 1];
  // 从最后一个真迹点起画，宽度沿用当前笔宽（预测点没有压感，等宽即可）
  const seq = [{ x: last.x, y: last.y, w: last.w }];
  for (const q of pts) seq.push({ x: q.x, y: q.y, w: last.w });
  if (seq.length < 2) return;
  predictCtx.save();
  predictCtx.globalAlpha = 0.5; // 半透明 = "墨还没落定"的视觉语义
  strokeRuns(predictCtx, seq, pad._strokeFill(pad.current), 1, pad._floorW());
  predictCtx.restore();
}

/// v4.1 #12 收笔去重：断线补发/分片重组等路径可能把同一 id 的整笔送达两次，
/// 已落库的笔画直接忽略（此前会重复入模型，纸上出现叠影"重复播放"）
const SEEN_STROKE_CAP = 512;
function seenStroke(id) {
  const key = "r" + id;
  if (state.seenStrokes.has(key)) return true;
  state.seenStrokes.add(key);
  if (state.seenStrokes.size > SEEN_STROKE_CAP) {
    const it = state.seenStrokes.values().next();
    if (!it.done) state.seenStrokes.delete(it.value);
  }
  return false;
}

/// v4.50：记录对方最近的落笔位置（归一纸面坐标 0–1）——供「视口复位」
/// 按钮长按跳过去看 TA 正在哪儿写。别的页上的笔画不记（位置无意义）。
function notePartnerFocus(pts, si) {
  if (Number.isFinite(si) && si !== state.sheetIdx) return;
  const lp = Array.isArray(pts) ? pts[pts.length - 1] : null;
  if (!lp || !Number.isFinite(lp[0]) || !Number.isFinite(lp[1])) return;
  state.partnerFocus = { x: lp[0] / VW, y: lp[1] / VH, at: Date.now() };
}

/// v4.50：长按视口复位按钮 → 保持当前缩放，把画面中心平移到对方落笔处
function jumpToPartnerFocus() {
  const f = state.partnerFocus;
  if (!f || !pad) { toast("还没捕捉到 TA 的落笔位置", 1800); return; }
  const px = f.x * pad.w, py = f.y * pad.h;
  const s = pad.view.s || 1;
  pad.view = { s, x: pad.w / 2 - px * s, y: pad.h / 2 - py * s };
  pad._clampView();
  pad.redraw();
  pad.onViewChange?.(pad.view);
  // 目标点闪一下对端光标作为落点指引
  if (typeof placePartnerCursor === "function") {
    state.partnerCursorPos = { x: f.x, y: f.y };
    const el = $("partner-cursor");
    if (el) { el.style.display = "block"; clearTimeout(el._hide); el._hide = setTimeout(() => (el.style.display = "none"), 1600); }
    placePartnerCursor();
  }
  toast("已跳到 TA 书写的位置", 1500);
}

function onPartnerStroke(ev) {
  if (ev.a && Math.abs(ev.a - effectiveAspect()) > 0.05) applyRemoteAspect(ev.a);
  notePartnerFocus(ev.pts, ev.si); // v4.50
  const hadPreview = state.liveChunks.has(ev.id);
  liveForget(ev.id);
  liveCanvasClear(); // 预览层独立清空，主画布上的重放动画不再被误伤（#11）
  if (seenStroke(ev.id)) return; // #12 重复送达直接丢弃
  // v4.26：实时镜像里对方在别的页落笔 → 整笔记进那一页的页栈（不渲染到当前页），
  // 翻回那一页时自然看到；宽度算法与定稿同款，速度调制状态存还原避免打扰当前页
  if (state.mode === "realtime" && Number.isFinite(ev.si)) {
    const si = Math.trunc(ev.si);
    if (si !== state.sheetIdx && si >= 0 && si < state.sheets.length) {
      const sh = state.sheets[si];
      const raw = (ev.pts || []).map(([x, y, p, t, rd]) => ({ x: x / VW * pad.w, y: y / VH * pad.h, p, t: t || 0, rd }));
      if (raw.length) {
        const np = ev.np !== 0;
        const tipN = Number(ev.tip) || 0;
        const keep = { wf: pad._vWf, acc: pad._vAcc, sp: pad._vSpeed };
        // v4.41：ss 已含对端粗细倍率与落笔缩放折细（缺省 = 旧客户端，回落本机倍率）
        const pts = pad.widthsFor(raw, np, tipN, Number(ev.ss) > 0 ? Number(ev.ss) : null);
        pad._vWf = keep.wf; pad._vAcc = keep.acc; pad._vSpeed = keep.sp;
        sh.strokes.push({ id: "r" + ev.id, pts, start: 0, np, tip: tipN, durationMs: ev.durationMs || pts[pts.length - 1].t });
        sh.remote?.add("r" + ev.id);
      }
      return;
    }
  }
  if (hadPreview) {
    // v4.1 #13 预览已经完整呈现了这一笔 → 直接定稿落库（清晰版），
    // 不再从头重播——消灭"同一笔先预览再重放一遍"的重复播放观感
    commitRemoteStroke(ev);
  } else {
    // 没收到过预览（掉线补发/节流丢包）→ 按原速重放补全过程
    enqueueReplay({ id: ev.id, pts: ev.pts, durationMs: ev.durationMs, color: ev.color, iv: ev.iv, ps: ev.ps, np: ev.np, tip: ev.tip, ss: ev.ss });
  }
  markInput();
}

/// 整笔直接落库（v4.1 #14：远端笔画统一加 "r" 前缀命名空间——
/// 双方各自的 strokeSeq 都从 1 数起，裸 id 会撞号，导致对端撤销
/// 按 id 命中本地笔画、删错笔迹无法同步）
function commitRemoteStroke(ev) {
  pad.addRemoteStroke({
    id: "r" + ev.id,
    pts: (ev.pts || []).map(([x, y, p, t, rd]) => rd != null ? [x / VW * pad.w, y / VH * pad.h, p, t, rd] : [x / VW * pad.w, y / VH * pad.h, p, t]),
    durationMs: ev.durationMs,
    np: ev.np,
    tip: ev.tip,
    ss: ev.ss, // v4.41：定稿同样按对方的倍率渲染（此前漏传，落库瞬间会跳回本机粗细）
    iv: ev.iv, // v4.48：逐笔墨色标签随笔画入库（再导出/草稿一致）
  }, ev.color, inkOfFrame(ev, ev.color));
  state.remoteIds.add("r" + ev.id);
  pad.redraw();
}

/// 宽度换算：对端笔宽按对方 penScale 计算，本端按本地比例折算，两端笔迹一致。
/// v4.1 #29：预览层用 drawing 帧自带的相对时间戳算速度因子（原来固定 wf=1，
/// 预览与定稿笔画粗细不一致，整笔落定时肉眼可见"跳变"）
function remoteW(ev, pt, prevPt) {
  // v4.22：压感基宽用 np=false 取（纯压感口径），速度档再按设备类型叠上去
  // v4.39：粗细跟人走——对端的笔用对方当时的倍率（ss），缺省回落本机值（旧客户端）
  const ss = Number(ev?.ss) > 0 ? Number(ev.ss) : (pad.strokeScale || 1);
  const base = pad.widthFor({ x: 0, y: 0, t: 0, p: pt?.p ?? 0.5 }, null, false, Number(ev?.ss) > 0 ? Number(ev.ss) : null);
  const ps = Number(ev?.ps) || 0;
  let w = ps > 0 && pad.penScale > 0 ? base * (ps / pad.penScale) : base;
  if (prevPt && Number.isFinite(pt?.__t) && Number.isFinite(prevPt.__t)) {
    const dt = pt.__t - prevPt.__t;
    if (dt >= 8) {
      const d = Math.hypot(pt.x - prevPt.x, pt.y - prevPt.y);
      // v4.22：与书写引擎同口径——速度按纸幅宽/秒归一后在「最细/最粗」两档间线性过渡；
      // 无压感笔直接取速度档宽度，有压感笔按中值比例叠在压感基宽上
      const v = Math.min(6, (d / Math.max(1, pad.w)) / (dt / 1000));
      const vN = Math.min(1, v / 2);
      const sMin = Math.min(3, Math.max(0.2, pad.speedMinW ?? 0.8));
      const sMax = Math.min(3, Math.max(0.2, pad.speedMaxW ?? 2.0));
      const speedW = sMax + (sMin - sMax) * vN;
      const scaleK = 2 * pad.penScale * ss; // v4.39：对方的倍率
      const ratio = ps > 0 && pad.penScale > 0 ? ps / pad.penScale : 1;
      w = ev.np ? speedW * scaleK * ratio : w * (speedW / Math.max(0.2, (sMin + sMax) / 2));
    }
  }
  return w;
}

let livePending = []; // v4.37：待画的对方笔画帧（合并到一帧一次）
let liveRaf = 0;
function flushLiveFrames() {
  liveRaf = 0;
  const q = livePending;
  livePending = [];
  for (const ev of q) paintLiveFrame(ev);
}

function onLiveDrawing(ev) {
  // v4.37：WS 突发可能一帧内到多条预览帧，逐条画等于重复做全屏合成——
  // 先入队，rAF 里一次画完
  if (ev.a && Math.abs(ev.a - effectiveAspect()) > 0.05) applyRemoteAspect(ev.a);
  if (state.seenStrokes.has("r" + ev.id)) return;
  if (state.mode === "realtime" && Number.isFinite(ev.si) && Math.trunc(ev.si) !== state.sheetIdx) return;
  notePartnerFocus(ev.pts, ev.si); // v4.50：逐点流也更新对方落笔位置
  livePending.push(ev);
  focusWriting(); // 对方在写 → 本端也进书写聚焦
  if (!liveRaf) liveRaf = requestAnimationFrame(flushLiveFrames);
}

function paintLiveFrame(ev) {
  if (ev.a && Math.abs(ev.a - effectiveAspect()) > 0.05) applyRemoteAspect(ev.a);
  // v4.1 #12：该笔已定稿落库 → 迟到的预览帧直接丢弃，不留残影
  if (state.seenStrokes.has("r" + ev.id)) return;
  // v4.26：实时镜像里对方在别的页写 → 预览帧不落到本端当前页（整笔会记进那一页）
  if (state.mode === "realtime" && Number.isFinite(ev.si) && Math.trunc(ev.si) !== state.sheetIdx) return;
  const cv = liveCanvasInit();
  if (!cv || !liveCtx) return;
  const raw = ev.pts || [];
  const pts = raw.map(([x, y, p, t]) => ({
    x: x / VW * pad.w, y: y / VH * pad.h, p, __t: t, w: 0,
  }));
  if (!pts.length) return;
  // 与上一帧尾点接速度（#29）
  const hist = state.liveChunks.get(ev.id) || [];
  const lastPrev = hist.length ? hist[hist.length - 1] : null;
  for (let i = 0; i < pts.length; i++) {
    pts[i].w = remoteW(ev, pts[i], i === 0 ? lastPrev : pts[i - 1]);
  }
  liveRemember(ev, pts); // v4.17：整笔点迹留底，双指缩放时预览层能整笔重画对齐
  const ctx = liveCtx;
  // v4.41：纸面恒定粗细——对端缩放已折进 ss，预览层直接按纸面宽度画；
  // 保底贴屏幕空间（放大时不把对端细笔顶粗）
  const fl = 0.8 / Math.max(0.01, pad.view.s);
  ctx.save();
  ctx.globalAlpha = 0.97;
  const liveFill = (state.liveFull.get(ev.id) || {}).fill || ev.color; // v4.48：逐笔墨色
  ctx.strokeStyle = liveFill; ctx.fillStyle = liveFill;
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  // 保留上一帧尾点，用与本地书写一致的二次曲线续画，避免折线感
  const seq = [...hist, ...pts];
  if (seq.length === 1) {
    ctx.beginPath();
    ctx.arc(seq[0].x, seq[0].y, Math.max(fl / 2, seq[0].w / 2), 0, Math.PI * 2); // v4.41：单点弧同口径
    ctx.fill();
    ctx.restore();
    state.liveChunks.set(ev.id, seq);
    return;
  }
  for (let i = Math.max(1, hist.length - 1); i < seq.length; i++) {
    // v3.16 #46：从上一帧尾段接缝处起画（多重绘一段已画曲线）——
    // 急转弯处接缝能用上二次曲线平滑，帧间隔大时不丢线段
    const a = seq[i - 1], b = seq[i];
    const c = seq[i + 1];
    ctx.beginPath();
    if (c) {
      ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
      ctx.quadraticCurveTo(b.x, b.y, (b.x + c.x) / 2, (b.y + c.y) / 2);
      ctx.lineWidth = Math.max(fl, b.w);
    } else if (i === 1 && seq.length === 2) {
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineWidth = Math.max(fl, (a.w + b.w) / 2);
    } else {
      ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
      ctx.lineTo(b.x, b.y);
      ctx.lineWidth = Math.max(fl, b.w);
    }
    ctx.stroke();
  }
  ctx.restore();
  state.liveChunks.set(ev.id, seq.slice(-3)); // #46 多留一个尾点，接缝更稳
}

function enqueueReplay(item) {
  item.ink = inkOfFrame(item, item.color); // v4.48：逐笔墨色（旧帧无 iv → null 走旧口径）
  state.replayQueue.push(item);
  if (!state.replaying) nextReplay();
}

/// #51 两笔之间留 120ms 自然停顿（重放不"一笔接一笔挤在一起"）
const REPLAY_STROKE_GAP_MS = 120;

function nextReplay() {
  clearTimeout(state.replayTimer);
  const item = state.replayQueue.shift();
  if (!item) { state.replaying = false; state.replayingId = null; return; }
  state.replaying = true;
  state.replayingId = item.id; // v4.1 #15：正在重放的远端笔画（撤销可打断）
  state.replayingItem = item;

  // v3.9：重放笔宽与落库重绘走同一套顺序算法（含速度因子与平滑），
  // 否则笔画播完落库的瞬间笔宽会跳变；对端 penScale 差异按比例折算。
  // v3.15：np/tip 随笔画携带——无压感速度因子与起收出锋同算法还原
  // v3.16 #36：渲染前过急转角圆角化，与本地书写同一几何
  // v4.41：重放笔宽带上对方倍率（ss 已折入对方落笔缩放），与预览/定稿同口径
  const pts = roundSharpCorners(pad.widthsFor(item.pts.map(([x, y, p, t, rd]) => ({
    x: x / VW * pad.w, y: y / VH * pad.h, p, t: t || 0,
  })), item.np !== 0, Number(item.tip) || 0, Number(item.ss) > 0 ? Number(item.ss) : null));
  const ps = Number(item.ps) || 0;
  const ratio = ps > 0 && pad.penScale > 0 ? ps / pad.penScale : 1;
  if (ratio !== 1) for (const pt of pts) pt.w *= ratio;
  if (!pts.length) { nextReplay(); return; }
  const dur = Math.max(item.durationMs || pts[pts.length - 1].t || 1, 1);
  const start = performance.now();
  let idx = 0;
  const ctx = pad.ctx;

  const step = (nowT) => {
    // v4.41：纸面恒定粗细——重放宽度已含对方倍率与缩放折细；保底贴屏幕（每帧随视口取）
    const fl = 0.8 / Math.max(0.01, pad.view.s);
    if (item.cancelled) return; // v4.1 #15：被对端撤销/清屏打断，静默终止
    const el = nowT - start;
    ctx.save();
    ctx.globalAlpha = 0.97;
    // v4.1 #16 抗误抹：重放期间任何外部 redraw（换信纸/撤销/擦除等）都会
    // 清掉画到一半的动画笔画——发现被抹（redraw 钩子置位）先把已推进的
    // 段落补画回来，再继续；此前表现为"实时镜像笔迹随机丢失"
    if (state.replayDirty) {
      state.replayDirty = false;
      for (let j = 0; j < idx; j++) strokeSegment(ctx, pts, j, replayInkOf(item), 1, fl);
    }
    // #49 分段绘制与本地书写/信件重放共用 strokeSegment；
    // v3.99：当前信纸声明了渐变墨，续画动画同样用渐变色块
    // v4.48：帧带 iv 时优先逐笔墨色——对端多色书写本端逐笔还原
    const liveInk = replayInkOf(item);
    while (idx < pts.length - 1 && pts[idx + 1].t <= el) { strokeSegment(ctx, pts, idx, liveInk, 1, fl); idx++; }
    if (idx === 0 && pts.length === 1) strokeSegment(ctx, pts, 0, liveInk, 1, fl);
    ctx.restore();
    if (idx < pts.length - 1 && el < dur + 200) {
      requestAnimationFrame(step);
    } else {
      state.replayingItem = null;
      if (!item.cancelled) {
        pad.addRemoteStroke({
          id: "r" + item.id, // v4.1 #14 命名空间 id，避免与本地笔画撞号
          pts: item.pts.map(([x, y, p, t, rd]) => rd != null ? [x / VW * pad.w, y / VH * pad.h, p, t, rd] : [x / VW * pad.w, y / VH * pad.h, p, t]),
          durationMs: dur,
          np: item.np,
          tip: item.tip,
          ss: item.ss, // v4.41：落库与重放同倍率，播完不跳变
          iv: item.iv, // v4.48：逐笔墨色标签
        }, item.color, item.ink);
        state.remoteIds.add("r" + item.id);
        state.replayingId = null;
        pad.redraw();
      }
      state.replayTimer = setTimeout(nextReplay, REPLAY_STROKE_GAP_MS); // #51 笔间停顿
    }
  };
  requestAnimationFrame(step);
}

/// v4.1 #15：撤销/清屏时打断指定远端笔画的排队与在播重放
function cancelReplayOf(id) {
  const match = (it) => id == null || it.id === id;
  if (state.replayingItem && match(state.replayingItem)) {
    state.replayingItem.cancelled = true;
    state.replayingItem = null;
    state.replayingId = null;
  }
  const kept = [];
  for (const it of state.replayQueue) {
    if (match(it)) it.cancelled = true;
    else kept.push(it);
  }
  state.replayQueue = kept;
}

function onPartnerErase(ev) {
  const r = ev.r != null ? ev.r / VW * pad.w : 18;
  pad.eraseAt({ x: ev.x / VW * pad.w, y: ev.y / VH * pad.h }, r, true);
}

/// v4.50 整笔橡皮（对端镜像）：
///  - ev.mine = 对方删掉了「TA 自己写的一笔」→ 本端删对应的镜像副本（"r"+id）
///  - ev.yours = 对方用整笔橡皮删掉了「我写的一笔」→ 本端删自己的本地笔画
/// 两个方向都先打断可能在播/排队中的重放，杜绝"删了又被队列画回来"
function onPartnerStrokeErase(ev) {
  if (ev?.mine != null) {
    cancelReplayOf(ev.mine);
    if (pad.removeStrokeById("r" + ev.mine)) state.remoteIds.delete("r" + ev.mine);
    updateSendBar();
    return;
  }
  if (ev?.yours != null) {
    if (pad.removeLocalStrokeById(Number(ev.yours))) {
      state.redoStack.length = 0; // 本地笔画被对端删掉，重做栈口径失效
      updateSendBar();
    }
  }
}

function onPartnerUndo() {
  // v4.50：撤销改为「仅对自己端有效」——实时镜像里双方的笔迹互不撤销，
  // 对端发来的 undo 一律忽略（旧版本客户端发来的也不再影响本端画面）。
  // 需要擦掉对方的字时用橡皮（erase_at 仍然双向同步）。
}

/// v3.23 #3：对方清空/翻页类动作的 3 秒可撤销横幅（倒计时自动消失）
let _undoBannerTimer = 0;
function showUndoBanner(msg, action) {
  let bar = $("undo-banner");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "undo-banner";
    document.body.appendChild(bar);
  }
  bar.textContent = msg;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "撤销";
  btn.addEventListener("click", () => { hideUndoBanner(); action(); });
  bar.appendChild(btn);
  bar.classList.add("show");
  clearTimeout(_undoBannerTimer);
  _undoBannerTimer = setTimeout(hideUndoBanner, 3000);
}
function hideUndoBanner() { $("undo-banner")?.classList.remove("show"); }

async function onPartnerClear() {
  // v4.35：寄信模式下各自写各自的页——迟到/排队残留的 clear_all 不允许擦掉本端
  // （例如刚从镜像切回寄信，对方补发的那一帧在路上）
  if (state.mode !== "realtime") return;
  // v3.23 #3：先快照本端墨迹——给 3 秒撤销窗口（撤销只恢复本端画面，
  // 不影响已清空的对方；不撤销则按原流程清掉）
  state.redoStack.length = 0; // v3.53：对端清空 → 重做历史作废
  const snapshot = pad.hasInk() ? JSON.parse(JSON.stringify(pad.strokes)) : null;
  cancelReplayOf(null);           // v4.1 #15：停掉全部排队/在播重放
  liveForgetAll();
  liveCanvasClear();              // v4.1 #11：预览层一并清空
  await pad.dissolve(800);
  pad.reset();
  state.remoteIds.clear();
  state.seenStrokes.clear();      // v4.1 #12：新的一页，收笔去重表清零
  state.replayQueue = [];
  clearTimeout(state.replayTimer);
  state.replaying = false;
  state.replayingItem = null;
  if (snapshot && snapshot.length) {
    showUndoBanner("对方清空了这一页", () => {
      pad.strokes = snapshot;
      pad._cacheOk = false;
      pad.redraw();
    });
  } else {
    toast("对方清空了这一页", 1500);
  }
}

/// v2：对方新开一页 → 本端同步翻到空白页
async function onPartnerPageTurn() {
  // v4.25：对方新建了一页 → 本端当前页入栈保留（内容不再丢，也无须再问要不要寄），
  // 追加空页并跟随跳过去
  if (state.sheets.length >= MAX_SHEETS) { // v4.58：上限兜底（对方端会先被拦，这里是竞态保险）
    state.partnerSheetIdx = state.sheets.length - 1;
    return;
  }
  state.redoStack.length = 0; // v3.53：翻页 → 重做历史作废
  saveSheet(state.sheetIdx);
  state.sheets.push({ strokes: [], remote: new Set(), seen: new Set() });
  cancelReplayOf(null);           // v4.1 #15
  clearTimeout(state.replayTimer);
  state.replaying = false;
  state.replayingItem = null;
  await pad.dissolve(500);
  loadSheet(state.sheets.length - 1);
  state.partnerSheetIdx = state.sheetIdx; // 对方追加新页并跳过去 → 仍同页
  syncSamePageGlow();
  toast("对方翻开了新的一页", 1500);
}

/// v3.10 离线补齐：重连后一次性收到离线期间的缓存笔迹——直接渲染最终结果，
/// 不逐笔重播。v4.1 #30/#31 修复：
///  - 应用对端画幅前先把信纸尺寸同步落定（原来 applyRemoteAspect 走 rAF 异步，
///    补齐笔画按旧尺寸换算坐标，比例镜像形同虚设）；
///  - 笔画 id 统一命名空间 + 去重，与实时链路同一套防重复机制；
///  - 长笔画分片（stroke_part）已在服务端聚合为整笔（见 roomdo.js）。
function onOfflinePage(ev) {
  if (state.mode !== "realtime") return;
  const ops = Array.isArray(ev.ops) ? ev.ops : [];
  if (!ops.length) return;
  const meta = ev.meta || {};
  if (meta.a) applyRemoteAspect(meta.a);
  if (meta.theme) applyForcedTheme(meta.theme);
  // v4.42：离线期间的墨色切换一并补上（先信纸后墨色，次序与实时一致）
  if (meta.ink != null && validateInkSel(meta.ink)) {
    saveBlancSel(String(meta.ink));
    if (isBlanc()) applyBlancInk();
  }
  paperSize(); // 同步落定尺寸，坐标换算用最新纸幅
  // 清掉本地残留的过程态（半截预览/未播完的重放），避免与补齐结果叠加
  liveForgetAll();
  liveCanvasClear();
  cancelReplayOf(null);
  state.replayQueue = [];
  clearTimeout(state.replayTimer);
  state.replaying = false;
  state.replayingItem = null;
  // v3.28：离线补齐静默执行，不再弹「补了 N 笔」提示
  for (const op of ops) {
    switch (op?.k) {
      case "s": {
        const e = op.ev || {};
        if (seenStroke(e.id)) break; // v4.1 #12 去重
        pad.addRemoteStroke({
          id: "r" + e.id,
          pts: (e.pts || []).map(([x, y, p, t, rd]) => rd != null ? [x / VW * pad.w, y / VH * pad.h, p, t, rd] : [x / VW * pad.w, y / VH * pad.h, p, t]),
          durationMs: e.durationMs || 0,
          np: e.np,
          tip: e.tip,
          ss: e.ss, // v4.41：离线补齐同样按对方倍率渲染（帧里 ss 已折入缩放）
          iv: e.iv, // v4.48：逐笔墨色标签
        }, e.color, inkOfFrame(e, e.color));
        state.remoteIds.add("r" + e.id);
        break;
      }
      case "e": onPartnerErase(op.ev || {}); break;
      case "x": onPartnerStrokeErase(op.ev || {}); break; // v4.50 整笔擦除补放
      case "u": onPartnerUndo(op.ev || {}); break;
      case "c":
      case "p":
        pad.reset();
        state.remoteIds.clear();
        state.seenStrokes.clear();
        break;
    }
  }
  pad.redraw();
}

/// v4.17：对端光标按当前视口落位——放大看细节时，光标跟着墨迹一起放大移动
/// v4.38：对端光标平滑跟随。坐标帧约每 90–200ms 才到一枚，直接跳变就是
/// "一卡一卡"；改成目标点 + 每帧缓动逼近（收敛即停 rAF），视觉上是丝滑跟随。
let cursorRaf = 0;
function cursorEaseStep() {
  const t = state.partnerCursorPos;
  const el = $("partner-cursor");
  if (!t || !el) { cursorRaf = 0; return; }
  if (!state.partnerCursorAt) state.partnerCursorAt = { x: t.x, y: t.y };
  const c = state.partnerCursorAt;
  const k = 0.3; // 每帧逼近三成：跟得上快写，又不会拖影
  state.partnerCursorAt = { x: c.x + (t.x - c.x) * k, y: c.y + (t.y - c.y) * k };
  paintPartnerCursor();
  const a = state.partnerCursorAt;
  cursorRaf = (Math.abs(t.x - a.x) < 0.0004 && Math.abs(t.y - a.y) < 0.0004)
    ? 0 : requestAnimationFrame(cursorEaseStep);
}
function paintPartnerCursor() {
  const el = $("partner-cursor");
  const a = state.partnerCursorAt || state.partnerCursorPos;
  if (!el || !a) return;
  const v = pad.view;
  el.style.transform =
    `translate(${(a.x * pad.w * v.s + v.x).toFixed(1)}px, ${(a.y * pad.h * v.s + v.y).toFixed(1)}px)`;
}
function placePartnerCursor() {
  // 视口变化时按当前（缓动中的）位置立即重排，不等下一帧
  paintPartnerCursor();
  if (state.partnerCursorPos && !cursorRaf) cursorRaf = requestAnimationFrame(cursorEaseStep);
}

function onPartnerCursor(ev) {
  const el = $("partner-cursor");
  el.style.display = "block";
  state.partnerCursorPos = { x: ev.x, y: ev.y }; // v4.17：记纸面相对坐标，缩放时重定位
  if (Number.isFinite(ev.x) && Number.isFinite(ev.y)) state.partnerFocus = { x: ev.x, y: ev.y, at: Date.now() }; // v4.50
  if (!cursorRaf) cursorRaf = requestAnimationFrame(cursorEaseStep); // v4.38：缓动跟随
  clearTimeout(el._hide);
  el._hide = setTimeout(() => (el.style.display = "none"), 1200);
  // 对端光标偶尔点出一圈极轻的呼吸涟漪（节流 1.2s；whisper 走独立队列）
  const nowT = performance.now();
  if (!state.whisperAcc || nowT - state.whisperAcc > 1200) {
    state.whisperAcc = nowT;
    fx?.whisper(ev.x * pad.w, ev.y * pad.h);
  }
}

// ================================================================ 模式

/// v4.14：可能滞后的同步源（/live 轮询、重连 welcome）在多长时间内
/// 不得推翻本地/对端刚确立的模式。服务端 DO 是模式的权威持有者，
/// 但 DO 短暂不可达时轮询会退回带缓存的 KV 房间值（最长 15 秒旧），
/// 所以保护窗要盖得住这段；WS 明确事件不受此窗约束（见 setMode）
const MODE_SYNC_GUARD_MS = 10000;

/// v4.36：模式跳变留痕（本机 localStorage，/health 自检页读出来展示）——
/// "镜像自己跳回寄信"这类问题，下次打开自检页就能看出是哪条同步路径、几点几分翻的
const MODE_TRACE_KEY = "pl_mode_trace";
function traceMode(from, to, source) {
  if (from === to) return;
  try {
    const arr = JSON.parse(localStorage.getItem(MODE_TRACE_KEY) || "[]");
    arr.push({ at: Date.now(), from, to, source });
    localStorage.setItem(MODE_TRACE_KEY, JSON.stringify(arr.slice(-12)));
  } catch { /* 无痕模式等写不进就算了，不影响功能 */ }
}

/// source: "local"（用户点了按钮）| "ws"（服务端/对端的权威事件）| "sync"（可能滞后的轮询/欢迎消息）
function setMode(mode, broadcast = true, source = "local") {
  const want = mode === "realtime" ? "realtime" : "letter";
  if (want === "realtime" && broadcast && !hasEgg("RT")) {
    toast("实时镜像需用兑换码解锁", 3000);
    return;
  }
  // v3.8 修「关闭失败」：远端同步（轮询/欢迎消息）不再推翻最近一段时间内的本地切换——
  // 服务端模式写 KV 有延迟，轮询拿着旧值会把刚关掉的模式又打开
  // v4.14：保护窗只管 "sync" 这一类可能滞后的来源；对端切换 / 服务端拒绝 /
  // 闲置自动退出都是 WS 权威事件，必须立刻生效，否则"关掉镜像"会被顶回来
  if (source === "sync" && state.modeLocalAt &&
      performance.now() - state.modeLocalAt < MODE_SYNC_GUARD_MS && want !== state.mode) return;
  traceMode(state.mode, want, source); // v4.36：真正生效的跳变才留痕
  state.mode = want;
  // v4.42：放大上限按模式分档——实时镜像 800%、寄信 600%；降档时把当前视口夹回
  pad.viewSMax = want === "realtime" ? 8 : 6;
  if (pad.view.s > pad.viewSMax) {
    pad.view.s = pad.viewSMax;
    pad._clampView();
    pad._cacheOk = false;
    pad.redraw();
  }
  // v4.15：不再写本机存档（服务端也不再落库）——模式只属于当前这场在线会话
  $("btn-mode").classList.toggle("active", want === "realtime");
  updateSendBar();
  syncSamePageGlow(); // v4.27：进出镜像时同页光晕跟随开关
  requestPaperSize(); // v4.12：镜像固定 4:3 与寄信随屏比例不同，切模式立即重排信纸
  if (broadcast) send({ t: "mode_change", mode: want });
  // v4.14：本地点击与 WS 权威事件都刷新保护窗起点——刚被权威值确立的模式，
  // 紧接着到达的滞后轮询值不许再把它翻回去（否则会出现"亮→灭→亮"的来回跳）
  if (source !== "sync") state.modeLocalAt = performance.now();
  if (want === "realtime") toast("实时镜像已开启（不保存信页）", 2600);
  else toast("已切回寄信模式：写满一页，点发送寄出", 2200);}

/// v2：未解锁 RT 时整个模式按钮不显示
function syncModeButton() {
  const cfg = window.__plConfig || {};
  const allowed = cfg.realtimeAllowed !== false && hasEgg("RT");
  $("btn-mode").classList.toggle("hidden", !allowed);
  if (!allowed && state.mode === "realtime") setMode("letter", false, "ws");
}

/// v4.50：实时语音（彩蛋 VC）——总开关 + 兑换双门槛，未解锁整个按钮不显示
function syncVoiceButton() {
  const cfg = window.__plConfig || {};
  const allowed = cfg.voiceAllowed !== false && hasEgg("VC");
  const btn = $("btn-voice");
  if (!btn) return allowed;
  btn.classList.toggle("hidden", !allowed);
  return allowed;
}

/// v4.50：初始化语音链路（P2P）。仅解锁 VC 且总开关开时挂载；
/// 信令复用房间 WS（send），媒体流 WebRTC 直连，声音不经服务器。
function wireVoice() {
  const btn = $("btn-voice");
  if (!btn) return;
  if (!syncVoiceButton()) return;
  state.voice = new VoiceLink({
    send: (ev) => send(ev),
    isPartnerOnline: () => state.partnerOnline || !!state.partner,
    partnerName: () => (state.partner && state.partner.nick) || "TA",
    toast: (m, ms) => toast(m, ms),
    onState: (s) => {
      btn.classList.toggle("active", s !== "idle");
      btn.setAttribute("aria-pressed", s !== "idle" ? "true" : "false");
      if (s !== "idle") exitImmersive(); // v4.52：来电/拨号/通话一开始就退出沉浸书写，界面全量可见
    },
  });
  btn.addEventListener("click", () => state.voice.toggle());
  // 离开页面/刷新前尽量礼貌挂断，避免对端一直等
  window.addEventListener("beforeunload", () => { try { state.voice?.end(true); } catch { /* ok */ } });
}

// ================================================================ 发送栏

function updateSendBar() {
  const blocked = state.pending >= state.pendingLimit;
  const show = state.mode === "letter" && (pad.hasInk() || blocked) && !state.sending;
  $("send-bar").classList.toggle("hidden", !show);
  // v4.1 #33：发送栏弹出时把左下角书信集按钮与工具栏底端抬起来，
  // 不再被发送栏盖住点不到（按钮永远保持在可视可点区域内）
  document.body.classList.toggle("send-open", show);
  $("send-go").disabled = state.writing || state.sending || blocked || !pad.hasInk();
  // v3.39 页面饱满度计：点数 ÷ 上限（超出后发送会弹二次确认），快满转暖色
  const cfg = window.__plConfig || {};
  const ratio = Math.min(1, pad.totalPoints() / (cfg.maxPtsPerPage || 5000));
  const meter = $("send-meter");
  if (meter) {
    meter.style.width = (ratio * 100).toFixed(1) + "%";
    meter.classList.toggle("near-full", ratio >= 0.85);
  }
  // v4.55 弱网草稿保护：寄信模式边写边存（防抖）。updateSendBar 是纸面内容
  // 变化的总汇点（落笔/撤销/重做/清空/翻页/恢复草稿都会走到这里），挂钩在这
  // 一处即可全覆盖；镜像模式与发送中不记草稿
  if (state.mode === "letter" && !state.sending) autosaveDraft();
}

/// v3.35 寄信仪式第二步：小信封从信纸中央起飞，沿弧线飞进书信集按钮，
/// 落地时按钮轻轻一闪——「寄出」这个动作在画面上完整落地。
/// 减少动态偏好 / 拿不到两端坐标时静默跳过，绝不影响寄信本身。
function flyLetterToShelf() {
  try {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const shelf = $("btn-letters");
    const from = paper.getBoundingClientRect();
    const to = shelf && shelf.getBoundingClientRect();
    if (!from.width || !to || !to.width) return;
    const el = document.createElement("div");
    el.className = "fly-letter";
    el.style.background = getComputedStyle(paper).backgroundColor || "#f5f0e4";
    if (!el.animate) return; // 不支持 Web Animations → 静默跳过
    document.body.appendChild(el);
    const x0 = from.left + from.width / 2, y0 = from.top + from.height / 2;
    const x1 = to.left + to.width / 2, y1 = to.top + to.height / 2;
    const midX = (x0 + x1) / 2 + (x1 - x0) * 0.1; // 弧线略偏向目标一侧，飞行更有目的感
    const midY = Math.min(y0, y1) - 90;
    const t = (x, y, s, r, o) => ({ transform: `translate(${x}px, ${y}px) translate(-50%,-50%) scale(${s}) rotate(${r}deg)`, opacity: o });
    el.animate([
      t(x0, y0, 0.9, 0, 0),
      { ...t(x0, y0, 1.06, -5, 1), offset: 0.14 },   // 起飞轻顿一下
      { ...t(midX, midY, 0.72, 6, 1), offset: 0.62 }, // 弧顶
      t(x1, y1, 0.2, 10, 0.35),                        // 收进书信集
    ], { duration: 950, easing: "cubic-bezier(0.5, -0.05, 0.4, 1)" }).onfinish = () => {
      el.remove();
      shelf.classList.add("glow-letter");
      setTimeout(() => shelf.classList.remove("glow-letter"), 700);
    };
    playPaperWhoosh(); // v3.44：起飞一刻极轻的纸音（未解锁音频则安静）
  } catch { /* 静默 */ }
}

async function doSend() {
  exitImmersive(); // v4.50：寄信流程要看得见进度
  if (state.sending || !pad.hasInk() || state.kicking) return;
  if (state.pending >= state.pendingLimit) {
    toast(`TA 还有 ${state.pending} 页信没打开，先让 TA 去书信集看看`, 2600);
    return;
  }
  state.sending = true;
  updateSendBar();
  const pageData = pad.exportPage();
  const cfg = window.__plConfig || {};
  // v3.23 #21：点数超限不再只提示——发送前二次确认（超大页重放重、
  // 也可能被服务端拒收）
  if (pageData.points > (cfg.maxPtsPerPage || 5000)) {
    if (!confirmDialog("这一页写得比较满，对方打开时会多花一点时间。确定寄出吗？")) {
      state.sending = false;
      updateSendBar();
      return;
    }
  }
  // v3.23 #20：发送前把整页暂存 sessionStorage——发送失败/页面中途被关时，
  // 下次进房可恢复，一整页心血不白费；寄出成功后删除
  try { sessionStorage.setItem("pl_draft_" + store.roomCode, JSON.stringify({ page: pageData, at: Date.now() })); } catch { /* 空间不够就跳过备份，不挡发送 */ }
  await pad.dissolve(900);
  try {
    const data = await apiJson("/api/page/commit", {
      method: "POST",
      body: JSON.stringify({
        code: store.roomCode,
        page: {
          // v3.15：默认裸点数组（旧格式）；带压感/出锋标记的笔画用 {p, np, tip} 对象携带，
          // 对方开信重放时按同款算法还原渐细与速度效果
          // v4.41：zs（落笔缩放折细系数）随笔画存档——放大写的字开信重放同样等比细
          pts: pageData.strokes.map((s) => {
            const p = normPts(s.pts);
            return (s.tip || s.np === 0 || s.zs || s.iv) ? { p, ...(s.np === 0 ? { np: 0 } : {}), ...(s.tip ? { tip: s.tip } : {}), ...(s.zs ? { zs: s.zs } : {}), ...(s.iv ? { iv: s.iv } : {}) } : p; // v4.48：逐笔墨色随信存档
          }),
          theme: store.theme || state.room?.theme || "parchment",
          // v4.42：白笺渐变墨按 "g:" 规格存档（开信重放还原渐变）；纯色/其它信纸照旧 hex
          ink: isBlanc() && blancSel.startsWith("g:") ? blancSel : currentInk(),
          durationMs: pageData.durationMs,
          aspect: effectiveAspect(),
          nick: store.nick,
          avatar: store.avatar,
        },
      }),
    });
    pad.reset();
    // v4.25：寄出后当前页栈条目同步清空（pad.reset 已换新数组）
    {
      const cur = state.sheets[state.sheetIdx];
      if (cur) {
        cur.strokes = pad.strokes;
        cur.remote = new Set();
        cur.seen = new Set();
        state.remoteIds = cur.remote;
        state.seenStrokes = cur.seen;
      }
    }
    try { sessionStorage.removeItem("pl_draft_" + store.roomCode); } catch { /* ok */ }
    clearAutosaveDraft(); // v4.55：寄出成功，书写中的实时草稿一并清掉
    state.pending = data.pending ?? state.pending + 1;
    state.pendingLocalAt = Date.now(); // v3.23 #1：5 秒内轮询旧值不得回退本地计数
    state.pendingLimit = data.limit ?? state.pendingLimit;
    // v3.16 #16 寄信成功的小仪式：发送按钮处一团短促墨焰
    const r = $("send-go").getBoundingClientRect();
    if (r.width) inkBlaze($("blaze-canvas"), r.left + r.width / 2, r.top, { palette: [currentInk(), "#8d72ff", "#ffb37a"] });
    flyLetterToShelf(); // v3.35：小信封从信纸飞向书信集
    // v3.51 信件里程碑：累计寄出的信到达关口（第 1 / 25 / 每满 10）时轻庆祝，
    // 计数按房间记在本地——里程碑属于这段关系，不占服务端存储
    try {
      const key = "pl_sent_" + store.roomCode;
      const n = Number(localStorage.getItem(key) || 0) + 1;
      localStorage.setItem(key, String(n));
      if (n === 1 || n === 25 || n % 10 === 0) {
        setTimeout(() => toast(n === 1 ? "第一封信已寄出，等 TA 拆开吧" : `这是你们之间寄出的第 ${n} 封信`, 2800), 2100);
      }
    } catch { /* 存不下也不挡寄信 */ }
    toast("信已寄出", 1800);
  } catch (e) {
    pad.redraw();
    if (e.code === "pending_limit") {
      state.pending = e.data?.pending ?? state.pending;
      state.pendingLimit = e.data?.limit ?? state.pendingLimit;
      toast(`TA 还有 ${state.pending}/${state.pendingLimit} 页信没打开，先让 TA 看看`, 3000);
    } else if (e.code === "too_fast") {
      toast("寄得太快了，缓一口气", 2000);
    } else {
      toast("寄出失败：" + (e.message || "网络错误") + "（这页已备份，下次进来可恢复）", 3200);
    }
  }
  state.sending = false;
  updateSendBar();
}

/// v3.23 #20：进房时检查上次没寄出去的暂存页，询问后恢复到纸面。
/// v4.55：双源合并——「发送前 sessionStorage 备份」+「书写中 localStorage 实时草稿」
/// 谁的时间戳新用谁；两份是同一页的两个快照，无论恢复与否都一起清掉。
function restoreDraftMaybe() {
  try {
    const ssKey = "pl_draft_" + store.roomCode;
    const lsKey = "pl_autosave_" + store.roomCode;
    let ss = null, ls = null;
    try { ss = JSON.parse(sessionStorage.getItem(ssKey) || "null"); } catch { ss = null; }
    try { ls = JSON.parse(localStorage.getItem(lsKey) || "null"); } catch { ls = null; }
    try { sessionStorage.removeItem(ssKey); localStorage.removeItem(lsKey); } catch { /* ok */ }
    const d = (ss?.at || 0) >= (ls?.at || 0) ? ss : ls;
    if (!d?.page?.strokes?.length) return;
    if (Date.now() - (d.at || 0) > 24 * 3600e3) return; // 超过 24 小时的草稿不再恢复
    if (!confirmDialog("发现上次没寄出去的一页信，恢复到纸上吗？")) return;
    for (const s of d.page.strokes) pad.addRemoteStroke(s, s.color || currentInk(), inkOfFrame(s, s.color || currentInk())); // v4.48：草稿也逐笔保色
    pad.redraw();
    updateSendBar();
    toast("草稿已恢复", 1500);
  } catch { /* 恢复失败静默，不影响进房 */ }
}

// ================================================================ v4.55 实时草稿（弱网保护）

/// 书写过程中持续把当前页存进 localStorage（防抖 ~1.2s；切后台/关页时立即刷一次）。
/// 与 v3.23 #20 的「发送前 sessionStorage 备份」互补：那份只保「点了发送还没成功」，
/// 这份保「写到一半断网 / 浏览器崩溃 / 手机切后台被杀进程」。只存寄信模式的当前页；
/// 隐私模式等 localStorage 不可用场景静默降级（仍有 sessionStorage 备份兜底）。
let _autosaveTimer = 0;
function autosaveDraftNow() {
  clearTimeout(_autosaveTimer);
  try {
    if (state.mode !== "letter" || state.sending) return; // 镜像/发送中不动草稿
    if (!store.roomCode) return;
    const key = "pl_autosave_" + store.roomCode;
    const page = pad.hasInk() ? pad.exportPage() : null;
    if (!page?.strokes?.length) { localStorage.removeItem(key); return; } // 纸面已空 → 草稿作废
    localStorage.setItem(key, JSON.stringify({ page, at: Date.now() }));
  } catch { /* 存不下（隐私模式/配额满）静默放弃，绝不挡书写 */ }
}
function autosaveDraft() {
  clearTimeout(_autosaveTimer);
  _autosaveTimer = setTimeout(autosaveDraftNow, 1200);
}
function clearAutosaveDraft() {
  clearTimeout(_autosaveTimer);
  try { localStorage.removeItem("pl_autosave_" + store.roomCode); } catch { /* ok */ }
}

// ================================================================ 书信集

async function loadLetters(openDrawer = false) {
  try {
    const data = await apiJson(`/api/conversation/${encodeURIComponent(store.roomCode)}`);
    // v3.23 #14：服务端已按时间倒序（最新在前）返回，前端直接采用不再 reverse
    state.letters = data.pages || [];
    state.lettersTotal = data.total ?? state.letters.length; // v3.11：分页（默认只取最近 10 封）
    if (typeof data.partnerReadAt === "number") state.partnerReadAt = data.partnerReadAt; // v3.61 已读回执
    renderLetters();
    if (openDrawer) openLetterDrawer();
  } catch { /* ok */ }
}

/// v3.11：加载更早的信（服务端按 pid 内嵌时间戳分页，before 取已加载里最旧的一封）
async function loadMoreLetters(btn) {
  if (!state.letters.length || state.lettersLoading) return;
  state.lettersLoading = true;
  if (btn) { btn.disabled = true; btn.textContent = "加载中…"; }
  const before = Math.min(...state.letters.map((p) => p.ts || 0));
  try {
    const data = await apiJson(`/api/conversation/${encodeURIComponent(store.roomCode)}?limit=10&before=${before}`);
    const older = (data.pages || []).filter((p) => !state.letters.some((x) => x.pid === p.pid));
    if (older.length) {
      state.letters = [...state.letters, ...older]; // v3.23 #14：统一倒序（最新在前），更早的追加到尾部
      state.lettersTotal = data.total ?? state.lettersTotal;
    }
    renderLetters();
  } catch { /* ok */ }
  state.lettersLoading = false;
}

/// v3.23 #15：书信集卡片缩略图里补一笔"首笔墨迹轮廓"——取该页第一笔的
/// 轨迹画成细线（点数多时抽稀），一眼看出这封信写了什么
function thumbStrokeSvg(p, fallbackInk) {
  try {
    const first = Array.isArray(p.pts) ? p.pts[0] : null;
    const pts = Array.isArray(first) ? first : (first && Array.isArray(first.p) ? first.p : null);
    if (!pts || pts.length < 2) return "";
    const ink = /^#[0-9a-fA-F]{3,8}$/.test(p.ink || "") ? p.ink : fallbackInk;
    const step = Math.max(1, Math.floor(pts.length / 48));
    let d = "";
    for (let i = 0; i < pts.length; i += step) {
      const pt = pts[i];
      if (!Array.isArray(pt) || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
      d += (d ? "L" : "M") + pt[0].toFixed(0) + " " + pt[1].toFixed(0);
    }
    if (!d) return "";
    return `<svg class="thumb-ink" viewBox="0 0 1000 1360" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="${ink}" stroke-width="26" stroke-linecap="round" stroke-linejoin="round" opacity="0.55"/></svg>`;
  } catch { return ""; }
}

/// v3.63 撤回还没被看的信：只出现在"我寄出、TA 还没打开过书信集"的信上。
/// 判定与拒绝都在服务端复核——这里只负责问一下、收回、说一声。
async function recallLetter(p) {
  if (!confirmDialog("这封信 TA 还没打开过。把它撤回吗？")) return;
  try {
    await apiJson("/api/page/recall", { method: "POST", body: JSON.stringify({ code: store.roomCode, pid: p.pid }) });
    state.letters = state.letters.filter((x) => x.pid !== p.pid);
    state.lettersTotal = Math.max(0, (state.lettersTotal || 0) - 1);
    state.favs.delete(p.pid); persistFavs(); // v3.65：信都收回了，收藏一并清掉
    renderLetters();
    await restoreRecalledInk(p); // v4.60：墨迹回到纸上（当前页有新墨则先开新页）
    toast("已撤回，墨迹回到纸上了", 2200);
  } catch (e) {
    if (e.code === "already_read") toast("慢了一步——TA 已经看过了，撤不回啦", 2600);
    else toast("撤回失败：" + (e.message || "网络错误"), 2600);
    loadLetters(); // 无论哪种失败都刷新一次，让已读/计数回到真实状态
  }
}

/// v4.60：撤回的信墨迹回到纸上——按存档逐笔还原（压感/出锋/逐笔墨色/渐变墨同口径），
/// 当前页已有新墨时先开一页再落（不抹掉正在写的内容）；回纸后即可修改重寄。
async function restoreRecalledInk(page) {
  try {
    const saved = page?.pts || [];
    if (!saved.length) return;
    if (pad.hasInk()) await newSheetPage(state.mode === "realtime"); // 纸面有新墨 → 新页承接
    const gSpec = typeof page.ink === "string" && page.ink.startsWith("g:")
      ? page.ink.slice(2).split(",").filter((c) => /^#[0-9a-fA-F]{3,8}$/.test(c)) : null;
    const baseColor = /^#[0-9a-fA-F]{3,8}$/.test(page.ink || "") ? page.ink : currentInk();
    const baseInk = gSpec && gSpec.length >= 2 ? { c: gSpec[0], g: gSpec } : { c: baseColor, g: null };
    for (const s of saved) {
      const isObj = s && !Array.isArray(s) && Array.isArray(s.p);
      const ev = isObj
        ? { pts: s.p, np: s.np, tip: s.tip, zs: s.zs, iv: s.iv, color: baseColor }
        : { pts: s, color: baseColor };
      pad.addRemoteStroke(ev, baseColor, inkOfFrame(ev, baseColor) || baseInk);
    }
    pad.redraw();
    updateSendBar();
    autosaveDraft(); // v4.55 草稿同步护住回纸的墨
  } catch { /* 回纸失败静默——撤回本身已成功 */ }
}

// ---------------------------------------------------------------- v3.65 信件收藏
/// 收藏只存本机、按房间记——自己的小收藏盒，不占服务端；上限 200 枚
const favKey = () => "pl_fav_" + store.roomCode;

function loadFavs() {
  try { state.favs = new Set(JSON.parse(localStorage.getItem(favKey()) || "[]")); } catch { state.favs = new Set(); }
}

function persistFavs() {
  try { localStorage.setItem(favKey(), JSON.stringify([...state.favs].slice(-200))); } catch { /* 存不下也不挡使用 */ }
}

/// 点亮/熄灭星星：原地更新按钮，不重排整列（顺序仍按时间，收藏是标记不是置顶）
/// 开着"只看收藏"时取消收藏会让卡片消失，那就直接重渲染
function toggleFav(p, item) {
  const on = !state.favs.has(p.pid);
  if (on) state.favs.add(p.pid); else state.favs.delete(p.pid);
  persistFavs();
  haptic();
  if (state.favFilter) { renderLetters(); return; }
  item?.querySelector(".fav-btn")?.classList.toggle("on", on);
}

function renderLetters() {
  const list = $("letter-list");
  list.innerHTML = "";
  // v3.68 头部报数：平时说总数，开着"只看收藏"时只报收藏数
  const titleEl = $("drawer-title");
  if (titleEl) {
    titleEl.textContent = state.favFilter
      ? `书信集 · 收藏 ${state.letters.filter((p) => state.favs.has(p.pid)).length}`
      : `书信集${state.lettersTotal ? ` · ${state.lettersTotal} 封` : ""}`;
  }
  // v3.67 只看收藏：筛选只作用于已加载的信（没加载的也没法收藏过）
  const shown = state.favFilter ? state.letters.filter((p) => state.favs.has(p.pid)) : state.letters;
  if (!shown.length) {
    list.innerHTML = `<div class="drawer-empty">${state.letters.length && state.favFilter ? "还没有收藏的信——点信旁的小星星，喜欢的信就留在这儿" : I18N.lettersEmpty}</div>`;
    return;
  }
  // v3.84：读到一半的标记——查一次断点存档，卡片上轻轻标出「读到一半」
  const progAll = ovProgLoad();
  for (const p of shown) { // v3.23 #14：已是倒序，直接渲染
    const t = themeById(p.theme);
    const item = document.createElement("div");
    item.className = "letter-item";
    const mine = p.author === store.sid;
    // v3.61 已读回执：只标我寄出的信——这封信寄达之后，TA 打开过书信集才算看过
    // v4.61：已读只认对方真读（partnerReadAt 来自服务端/对方 read_ack）；
    // v4.60 曾加「本端读过也算」，与回执本义冲突，已回退
    const seen = mine && state.partnerReadAt >= (p.ts || 0);
    const thumbInk = t ? themeInkOf(t, "#43301c") : "#43301c";
    // v2：不显示每页笔数
    item.innerHTML = `
      ${state.letterSelecting ? `<span class="sel-dot${state.letterSelected.has(p.pid) ? " on" : ""}" aria-hidden="true"></span>` : ""}
      <div class="thumb" style="${themeThumbCss(t)}">${thumbStrokeSvg(p, thumbInk)}</div>
      <div class="meta">
        <div class="who"><span class="avatar" data-av="${p.authorAvatar}"></span>${escapeHtml(displayNick(p.authorNick) || (mine ? "我" : "TA"))}${mine ? "（我）" : ""}</div>
        <div class="when">${relTime(p.ts)}${progAll[p.pid] ? `<span class="prog-mark" title="点开从上次读到的地方继续">读到一半</span>` : ""}${mine ? `<span class="seen-mark${seen ? " seen" : ""}" title="${seen ? `TA 打开过书信集 · ${relTime(state.partnerReadAt)}` : "这封信寄达后，TA 还没打开过书信集"}">${seen ? "已读" : "未读"}</span>` : ""}</div>
      </div>
      ${mine && !seen ? `<button class="recall-btn" title="撤回这封信">撤回</button>` : ""}
      <button class="fav-btn${state.favs.has(p.pid) ? " on" : ""}" title="${state.favs.has(p.pid) ? "取消收藏" : "收藏"}" aria-label="收藏">${icon("star", 14)}</button>
      <span class="open-hint">打开此页</span>`;
    item.querySelector(".avatar").innerHTML = avatarSvg(p.authorAvatar || 0);
    // v3.63：我寄出、TA 还没看的信可以撤回（不触发打开此页）
    item.querySelector(".recall-btn")?.addEventListener("click", (e) => { e.stopPropagation(); recallLetter(p); });
    // v3.65：收藏这封信（本机小收藏盒，不触发打开此页）
    item.querySelector(".fav-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFav(p, item);
      e.currentTarget.title = state.favs.has(p.pid) ? "取消收藏" : "收藏";
    });
    item.addEventListener("click", () => {
      if (state.letterSelecting) { toggleLetterSelect(p.pid, item); return; } // v4.57：选择模式点卡片=勾选
      openLetter(p, item);
    });
    list.appendChild(item);
  }
  // v3.11：还有更早的信 → 列表尾部"加载更多"（筛选时收起：先把眼前的收藏看完）
  const total = state.lettersTotal || 0;
  if (!state.favFilter && total > state.letters.length) {
    const more = document.createElement("button");
    more.className = "letter-more";
    more.textContent = I18N.drawerLoadMore(total - state.letters.length);
    more.addEventListener("click", () => loadMoreLetters(more));
    list.appendChild(more);
  }
}

function openLetterDrawer() {
  exitImmersive(); // v4.50：开抽屉退出沉浸
  loadLetters();
  $("letter-drawer").classList.add("open");
  if (state.unread) {
    state.unread = 0;
    updateBadge();
    api("/api/page/read", { method: "POST", body: JSON.stringify({ code: store.roomCode }) }).catch(() => {});
  }
}
function closeLetterDrawer() {
  $("letter-drawer").classList.remove("open");
  if (state.letterSelecting) setLetterSelecting(false); // v4.57：收起抽屉即退出导出选择
}

/// v3.50 信纸堆叠（React Bits ScrollStack 思路）：书信集卡片吸顶叠放，
/// 后一封信滑上来压住前一封；被压住的卡按叠压层数逐层缩沉（--stack），
/// 视觉上像一沓翻开的信。上滑自然还原展开；滚动用 rAF 节流。
/// 偏好减少动态 / 卡片不足两封时不启用（列表照常滚动）。
let _stackRaf = 0;
function wireLetterStack() {
  const list = $("letter-list");
  if (!list) return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const update = () => {
    _stackRaf = 0;
    const cards = [...list.querySelectorAll(".letter-item")];
    if (cards.length < 2) return;
    const topLine = list.getBoundingClientRect().top + 6; // 与 sticky top 对齐
    const rects = cards.map((c) => c.getBoundingClientRect());
    for (let i = 0; i < cards.length; i++) {
      cards[i].style.zIndex = String(i + 1); // 后来的信压在前一封上
      let depth = 0; // depth = 已压到吸顶线的后续卡片数
      for (let j = i + 1; j < cards.length; j++) if (rects[j].top <= topLine + 2) depth++;
      const k = Math.min(depth, 6); // 最多缩 6 层，再深看不出差别
      cards[i].style.setProperty("--stack", `translateY(${k * 5}px) scale(${(1 - k * 0.045).toFixed(3)})`);
    }
  };
  const ask = () => { if (!_stackRaf) _stackRaf = requestAnimationFrame(update); };
  list.addEventListener("scroll", ask, { passive: true });
  new MutationObserver(ask).observe(list, { childList: true }); // 信件重渲染后重算
  ask();
}

function updateBadge() {
  const b = $("letter-badge");
  // v3.69：未读变多时角标弹一下，像心口被轻敲——增量才弹，轮询对齐不抖
  const grew = state.unread > (state.lastBadgeN || 0);
  state.lastBadgeN = state.unread;
  b.textContent = String(state.unread);
  b.classList.toggle("hidden", state.unread <= 0);
  if (state.unread > 0 && grew) { b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop"); }
  // v3.46：未读数同时写进标签页标题——人切去别的标签页时，来信也看得见
  try { document.title = state.unread > 0 ? `(${state.unread}) PaperLink` : "PaperLink"; } catch { /* ok */ }
  updateFaviconBadge(state.unread); // v3.47：图标本身也带上计数红点
}

/// v3.47 未读画进图标：拿应用图标做底、右上角叠计数红点，写回 favicon；
/// 清零还原原图。画不出（svg 栅格化受限等）时静默跳过，标题角标仍在。
let _favLink = null, _favBase = "", _favIcon = null;
function updateFaviconBadge(n) {
  try {
    _favLink = _favLink || document.querySelector('link[rel="icon"]');
    if (!_favLink) return;
    _favBase = _favBase || _favLink.href;
    if (!n) { if (_favLink.href !== _favBase) _favLink.href = _favBase; return; }
    const draw = () => {
      try {
        const cv = document.createElement("canvas");
        cv.width = cv.height = 64;
        const c = cv.getContext("2d");
        c.drawImage(_favIcon, 0, 0, 64, 64);
        const label = n > 9 ? "9+" : String(n);
        c.fillStyle = "#e5484d";
        c.beginPath();
        c.arc(47, 17, label.length > 1 ? 16 : 12, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = "#fff";
        c.font = `bold ${label.length > 1 ? 16 : 18}px sans-serif`;
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText(label, 47, 18);
        _favLink.href = cv.toDataURL("image/png");
      } catch { /* ok */ }
    };
    if (_favIcon && _favIcon.complete) return draw();
    _favIcon = new Image(); // 底图用 png 图标（svg 在部分浏览器栅格化受限）
    _favIcon.onload = draw;
    _favIcon.src = "/icons/icon-180-v2.png";
  } catch { /* ok */ }
}

/// v3.38 收信仪式：新信到达的一刻，一枚染着对方信纸底色的小信封从屏幕上方
/// 飘进书信集按钮——与寄信端的「飞出」（v3.35）首尾呼应。
/// 减少动态偏好 / 拿不到目标坐标时静默跳过，绝不影响收信主流程。
function flyLetterIn(page) {
  try {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const shelf = $("btn-letters");
    const to = shelf && shelf.getBoundingClientRect();
    if (!to || !to.width) return;
    const el = document.createElement("div");
    el.className = "fly-letter";
    el.style.background = themeById(page && page.theme)?.paper || "#f5f0e4"; // 信封随对方选的信纸着色
    if (!el.animate) return; // 不支持 Web Animations → 静默跳过
    document.body.appendChild(el);
    const x1 = to.left + to.width / 2, y1 = to.top + to.height / 2;
    const x0 = Math.min(Math.max(x1 + 70, 70), window.innerWidth - 70), y0 = -30; // 屏幕上方斜入
    const midX = (x0 + x1) / 2 + 26, midY = (y0 + y1) / 2 - 36;
    const t = (x, y, s, r, o) => ({ transform: `translate(${x}px, ${y}px) translate(-50%,-50%) scale(${s}) rotate(${r}deg)`, opacity: o });
    el.animate([
      t(x0, y0, 0.6, -8, 0),
      { ...t(x0, y0, 0.9, -6, 1), offset: 0.12 },   // 入场现身
      { ...t(midX, midY, 0.8, 2, 1), offset: 0.6 }, // 飘过中段
      t(x1, y1, 0.2, 8, 0.35),                       // 收进书信集
    ], { duration: 900, easing: "cubic-bezier(0.45, 0.05, 0.4, 1)" }).onfinish = () => {
      el.remove();
      shelf.classList.add("glow-letter");
      setTimeout(() => shelf.classList.remove("glow-letter"), 700);
    };
    playPaperWhoosh(); // v3.44：来信入场同一声纸音（未解锁音频则安静）
  } catch { /* 静默 */ }
}

// ================================================================ v4.56 新信到达通知

/// 书写房的角标 / 标题计数 / 信封动画都要「人在页面里」才看得到——页面切到后台
/// （切标签 / 锁屏 / 切去别的应用但页面存活）时，新信到达改发一条系统通知。
/// 开关在「我的」页（pl_notify，默认开）；权限在首次点书信集按钮时顺势申请一次。
function isPageBackground() {
  return document.hidden || (document.hasFocus ? !document.hasFocus() : false);
}
function notifyAllowed() {
  try {
    return localStorage.getItem("pl_notify") !== "0" &&
      typeof Notification !== "undefined" && Notification.permission === "granted";
  } catch { return false; }
}
function maybeNotifyNewLetter(body) {
  try {
    if (!isPageBackground() || !notifyAllowed()) return;
    const n = new Notification("PaperLink · 新信到了", {
      body,
      tag: "pl-letter-" + store.roomCode, // 同一房间连来多封只保留最新一条，不刷屏
      icon: "/icons/icon-192-v2.png",
    });
    n.onclick = () => { try { window.focus(); openLetterDrawer(); n.close(); } catch { /* ok */ } };
  } catch { /* 发不出静默——房内角标与标题计数仍在 */ }
}
/// 通知权限必须搭用户手势申请（浏览器硬性要求）——首次点「书信集」时问一次，
/// 关心信的人此刻正好在门口；问过（无论给没给）就不再打扰
function maybeAskNotifyPermission() {
  try {
    if (typeof Notification === "undefined") return;
    if (localStorage.getItem("pl_notifyAsked") === "1") return;
    if (Notification.permission !== "default") { localStorage.setItem("pl_notifyAsked", "1"); return; }
    if (localStorage.getItem("pl_notify") === "0") return; // 开关关着就不申请
    localStorage.setItem("pl_notifyAsked", "1");
    Notification.requestPermission().catch(() => { /* 拒绝就算了，不再问 */ });
  } catch { /* 隐私模式等场景静默 */ }
}

function onNewPage(page, pending, limit) {
  if (!page) return;
  if (page.author === store.sid) {
    if (typeof pending === "number") { state.pending = pending; updateSendBar(); }
    return;
  }
  if (typeof limit === "number") state.pendingLimit = limit;

  state.letters.unshift(page); // v3.23 #14：列表倒序（最新在前），新信进头部
  state.unread++;
  updateBadge();
  flyLetterIn(page); // v3.38：小信封飘进书信集（减少动态时自动跳过）
  // v4.56：页面在后台（切标签/锁屏）时发系统通知——放在横幅偏好分流之前，
  // 「只要小红点」只是房内横幅偏好，不妨碍后台送达
  maybeNotifyNewLetter(`${displayNick(page.authorNick) || "TA"} 给你寄来了一封信，点开看看`);
  if ($("letter-drawer").classList.contains("open")) renderLetters();

  const cfg = window.__plConfig || {};
  const idleMs = cfg.idleTimeoutMs || 2500;
  const isIdle = Date.now() - state.lastInput > idleMs && !pad.hasInk() && !state.writing;

  if (store.letterPref === "dot") return;
  // v3.88：看信全屏时新信不打扰——先攒着，合上信再一起报（横幅在重放层下面，亮了也看不见；
  // 「只要小红点」的偏好上面已静默返回，这里不违背）
  if (!$("letter-overlay").classList.contains("hidden")) { state.pendingNew++; return; }
  if (store.letterPref === "auto" || isIdle) { openLetterDrawer(); return; }

  state.bannerCount++;
  $("banner-text").textContent = state.bannerCount > 1
    ? `对方寄来 ${state.bannerCount} 页新信`
    : `${displayNick(page.authorNick) || "TA"} 寄来一页新信`;
  $("new-letter-banner").classList.remove("hidden");
  // v3.16 #32：横幅出现时纸面边缘泛一圈品牌色光晕，引导视线到纸面
  paper.classList.remove("glow-notify");
  void paper.offsetWidth;
  paper.classList.add("glow-notify");
  clearTimeout(state.bannerTimer);
  state.bannerTimer = setTimeout(() => {
    if (Date.now() - state.lastInput > idleMs && !pad.hasInk()) openLetterDrawer();
    else setTimeout(() => $("new-letter-banner").classList.add("hidden"), 6000);
  }, idleMs);
}

// ------------------------------- 信件重放：全屏（或按对方比例尽量最大化）

let ov = null;
let ovRaf = 0; // v3.16 #48：重放 RAF 句柄（暂停时真正停帧）

// --- v3.30 读信进度记忆：按信件（pid）记录重放断点，下次打开自动续播 ---
// 只存「播到第几笔、这笔播到第几毫秒」，重开时静默补画已播部分再继续。
const OV_PROG_KEY = "pl_ovProgress";
function ovProgLoad() {
  try { return JSON.parse(localStorage.getItem(OV_PROG_KEY)) || {}; } catch { return {}; }
}
function ovProgClear(pid) {
  if (!pid) return;
  const all = ovProgLoad();
  if (!(pid in all)) return;
  delete all[pid];
  try { localStorage.setItem(OV_PROG_KEY, JSON.stringify(all)); } catch { /* ok */ }
}
function ovProgSave() {
  if (!ov || !ov.pid) return;
  if (ov.done) return ovProgClear(ov.pid); // 播完即清：下次打开从头放
  const all = ovProgLoad();
  all[ov.pid] = { si: ov.si, el: Math.round(ov.elapsed), ts: Date.now() };
  const keys = Object.keys(all);
  if (keys.length > 60) { // 只留最近 60 条，防无限增长
    keys.sort((a, b) => (all[a].ts || 0) - (all[b].ts || 0));
    for (const k of keys.slice(0, keys.length - 60)) delete all[k];
  }
  try { localStorage.setItem(OV_PROG_KEY, JSON.stringify(all)); } catch { /* ok */ }
}

function openLetter(page, fromEl) {
  exitImmersive(); // v4.50：看信退出沉浸
  closeLetterDrawer();
  const overlay = $("letter-overlay");
  const op = $("overlay-paper");
  const canvas = $("overlay-canvas");
  overlay.classList.remove("hidden");
  overlay.classList.add("fs-play"); // CSS 全屏播放层
  // v3.80：看信全屏期间挂 body 标记——天气粒子让位、下层按钮停接点按
  document.body.classList.add("letter-open");
  exitWeatherImmersive(); // v4.43：看信不进天气沉浸
  state.openPid = page.pid || ""; // v3.70：记住正在看的这封，供连读翻信定位
  updateStepButtons();
  ovGestureTipMaybe(); // v3.83：第一次看信提一句手势，往后再不打扰

  // v3.5：canvas-ui Celebrate/ParticleReveal 思路——开信一刻，墨粒自屏幕中心迸发升腾。
  // v3.16：#9 粒子在「信件墨色 / 品牌紫 / 互补色」间随机取色；
  // #11 落款解码动画改由粒子飞行中段（onMid）触发，视听节奏对齐
  const burstInk = page.ink && /^#[0-9a-f]{6}$/i.test(page.ink) ? page.ink : "#3a4a6b";
  const whoText = `${displayNick(page.authorNick) || "TA"} · ${relTime(page.ts)}`;
  inkBurst($("burst-canvas"), window.innerWidth / 2, window.innerHeight / 2, {
    color: burstInk,
    palette: [burstInk, "#7a5cff", complement(burstInk)],
    onMid: () => blurText($("overlay-who"), whoText), // 落款逐词聚焦浮现（react-bits BlurText 思路）
  });

  // 按信件自身宽高比尽量铺满视口（横屏信横着最大化）
  const a = Math.max(0.2, Math.min(5, page.aspect || PORTRAIT));
  const vw = window.innerWidth, vh = window.innerHeight;
  let w = vw - 16, h = w / a;
  if (h > vh - 16) { h = vh - 16; w = h * a; }
  op.style.width = w + "px";
  op.style.height = h + "px";

  op.className = "overlay-paper page-paper fs-play-paper";
  // v3.71 连读翻信的方向过场：下一封自右、上一封自左滑入，像翻一沓信
  if (state.stepDir) {
    op.classList.add(state.stepDir > 0 ? "step-next" : "step-prev");
    state.stepDir = 0;
  }
  // v3.42 开信仪式：信纸从点开的信卡原地「长成」整页（空间连续）；
  // 拿不到源卡 / 偏好减少动态 → 落回原上浮入场
  try {
    if (fromEl && fromEl.animate &&
        !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) {
      const f = fromEl.getBoundingClientRect();
      const g = op.getBoundingClientRect();
      if (f.width && g.width) {
        const dx = f.left + f.width / 2 - (g.left + g.width / 2);
        const dy = f.top + f.height / 2 - (g.top + g.height / 2);
        op.classList.add("from-card"); // 禁用通用上浮入场，避免与放大动画打架
        op.animate([
          { transform: `translate(${dx}px, ${dy}px) scale(${f.width / g.width}, ${f.height / g.height})`, opacity: 0.4 },
          { transform: "translate(0, 0) scale(1, 1)", opacity: 1 },
        ], { duration: 420, easing: "cubic-bezier(0.3, 0.7, 0.3, 1)" });
      }
    }
  } catch { /* 静默，入场体验自动降级 */ }
  const t = themeById(page.theme);
  // v4.13：无存档墨水色时取解析后的主题墨色（自定义信纸 CSS 定义优先）
  // v4.42：存档墨色可能是白笺渐变规格 "g:#a,#b(,#c)"——拆出基色与色表
  const ovGradSpec = typeof page.ink === "string" && page.ink.startsWith("g:")
    ? page.ink.slice(2).split(",").filter((c) => /^#[0-9a-fA-F]{3,8}$/.test(c)) : null;
  const ovBaseInk = applyThemeToPaper(op, t, ovGradSpec && ovGradSpec.length >= 2 ? ovGradSpec[0] : (page.ink || null));

  // v4.1 #55：重放画布同样受像素预算约束（桌面大屏全屏看信不超浏览器上限）
  let dpr = Math.min(2, window.devicePixelRatio || 1);
  dpr = Math.max(1, Math.min(dpr, Math.sqrt(16e6 / Math.max(1, w * h))));
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);

  mountAvatar($("overlay-avatar"), page.authorAvatar || 0);

  // 笔宽用与书写同款的顺序算法补算（含速度因子与平滑），重放手感还原。
  // v3.15：笔画兼容裸点数组（旧信）与 {p, np, tip} 对象（带压感/出锋标记）
  // v3.16 #36：渲染前过急转角圆角化，与书写端同一几何
  // v4.48：逐笔墨色——存档笔画对象里的 iv（白笺墨盘选择值）与点集并行抽出
  const strokeIvs = (page.pts || []).map((s) => {
    const isObj = s && !Array.isArray(s) && Array.isArray(s.p);
    return isObj && typeof s.iv === "string" && s.iv !== "" && validateInkSel(s.iv) ? s.iv : null;
  });
  const strokes = (page.pts || []).map((s) => {
    const isObj = s && !Array.isArray(s) && Array.isArray(s.p);
    const rawPts = isObj ? s.p : s;
    const np = isObj ? s.np !== 0 : true;
    const tip = isObj ? (Number(s.tip) || 0) : 0;
    // v4.41：写作者落笔时的缩放折细系数随信还原（放大写的字开信同样等比细）
    const zs = isObj && Number(s.zs) > 0 ? Number(s.zs) : 1;
    return roundSharpCorners(pad.widthsFor((rawPts || []).map(([x, y, p, tt]) => ({
      x: x / VW * w, y: y / VH * h, p, t: tt || 0,
    })), np, tip, (pad.strokeScale || 1) * zs));
  });

  ov = {
    canvas, ctx: canvas.getContext("2d"), dpr, w, h,
    ink: ovBaseInk, // v4.13：与纸面同款解析结果（存档墨色 > CSS 定义 > 主题默认）
    strokeInks: [], patMap: new Map(), // v4.48：逐笔墨色（null = 用整页 ov.ink）
    pid: page.pid || "", // v3.30：进度记忆按信件 pid 存档
    strokes, si: 0, idx: 0,
    elapsed: 0, last: performance.now(),
    paused: false, done: false,
    lastProgSave: 0, // v3.30：节流写进度
    interGap: 0, // #51 两笔之间的自然停顿（毫秒）
    // v3.23 #18/#31：倍速与进度——durs 为每笔时长，totalDur 用于进度条
    durs: strokes.map((pts) => pts[pts.length - 1]?.t || 0),
    speed: ovSpeed, // v4.64：开信时的倍速数值（存档调查用）
  };
  ov.totalDur = ov.durs.reduce((s, d) => s + d, 0) || 1;
  if (!strokes.length) ov.done = true; // v4.1 #41：空信件直接置完成态，杜绝空转 RAF
  ov.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // v3.99 渐变笔迹：模板声明了 --ink-gradient → 重放同样用静态多径向色块画
  // （图案锚定重放纸面、与书写端同款几何，不流动）
  {
    const ovGradColors = parseInkGradientDecl(getComputedStyle(op).getPropertyValue("--ink-gradient"));
    if (ovGradColors) {
      const ovGradCv = makeInkGradientCanvas(ov.w, ov.h, ovGradColors);
      const pat = ovGradCv ? ov.ctx.createPattern(ovGradCv, "no-repeat") : null;
      if (pat) ov.ink = pat;
    } else if (ovGradSpec && ovGradSpec.length >= 2) {
      // v4.42：白笺渐变墨存档——模板 CSS 没声明渐变时按存档色表还原同款图案
      const gCv = makeInkGradientCanvas(ov.w, ov.h, ovGradSpec);
      const gPat = gCv ? ov.ctx.createPattern(gCv, "no-repeat") : null;
      if (gPat) ov.ink = gPat;
    }
  }
  // v4.48：逐笔还原多色信——iv 解析出的纯色/rgba 直接用；渐变规格按同款
  // makeInkGradientCanvas 建锚定重放纸面的图案（按色表缓存，同色渐变只建一次）
  {
    const ovDefHex = typeof ovBaseInk === "string" ? ovBaseInk
      : ((ovGradSpec && ovGradSpec[0]) || themeById(page.theme)?.ink || "#241812");
    ov.strokeInks = strokeIvs.map((iv) => {
      if (!iv) return null;
      const ik = inkFromSel(iv, ovDefHex);
      if (ik.g) {
        const key = ik.g.join(",");
        let pat = ov.patMap.get(key);
        if (pat === undefined) {
          const cv = makeInkGradientCanvas(ov.w, ov.h, ik.g);
          pat = cv ? ov.ctx.createPattern(cv, "no-repeat") : null;
          ov.patMap.set(key, pat);
        }
        return pat || ik.c;
      }
      return ik.c;
    });
  }
  // v3.30：续播——有上次断点且没播完：静默补画已播部分，从断点继续放
  const prog = ov.pid ? ovProgLoad()[ov.pid] : null;
  if (prog && (prog.si > 0 || prog.el > 0) && prog.si < strokes.length) {
    // v4.60：断点补画统一走 ovRedrawTo（半透笔分层合成，与顺播/拖拽同画面口径）
    const idx = ovRedrawTo(prog.si, prog.el);
    ov.si = prog.si; ov.idx = idx; ov.elapsed = prog.el;
    toast("已从上次进度继续", 1600);
  }
  setOverlayPauseIcon();
  ovUpdateSpeedLabel();
  ovProgressUi();
  cancelAnimationFrame(ovRaf);
  ovRaf = requestAnimationFrame(ovStep);
}

/// v3.23 #18：重放倍速档位。内部基准是 0.9 倍（历史同速重放的校准值），
/// 档位显示值乘上它得到真实速率——界面永远不出现 0.9x 字样。
// v4.64：倍速改「轻点弹选择条」——预设 0.5/0.75/1/2/3 一点即定，另有自定义
// （滑条 0.1–10 + 数字输入精确到 0.01）；不再循环点按钮逐档挪。
// 跨会话记忆存数值；旧版档位索引（0–3）读取时自动迁移。
const OV_SPEED_PRESETS = [0.5, 0.75, 1, 2, 3];
const OV_SPEED_KEY = "pl_ovSpeed";
const OV_SPEED_MIN = 0.01, OV_SPEED_MAX = 10;
function ovSpeedLoad() {
  const raw = localStorage.getItem(OV_SPEED_KEY);
  if (raw == null) return 1;
  if (["0", "1", "2", "3"].includes(raw)) return [0.5, 1, 1.5, 2][Number(raw)]; // 旧档索引迁移
  const v = Number(raw);
  return Number.isFinite(v) && v >= OV_SPEED_MIN && v <= OV_SPEED_MAX ? v : 1;
}
let ovSpeed = ovSpeedLoad();
const ovSpeedFactor = () => ovSpeed * 0.9;
function ovFmtSpeed(v) { return String(Math.round(v * 100) / 100); }
function ovUpdateSpeedLabel() {
  const btn = $("overlay-speed");
  if (btn) btn.textContent = ovFmtSpeed(ovSpeed) + "x";
  const pop = $("ov-speed-pop");
  if (pop && !pop.classList.contains("hidden")) {
    for (const c of pop.querySelectorAll("[data-sp]")) {
      c.classList.toggle("on", Math.abs(Number(c.dataset.sp) - ovSpeed) < 1e-9);
    }
    const r = $("ov-speed-range");
    if (r && document.activeElement !== r) r.value = Math.min(10, Math.max(0.1, ovSpeed));
    const n = $("ov-speed-num");
    if (n && document.activeElement !== n) n.value = ovFmtSpeed(ovSpeed);
  }
}
function ovSetSpeed(v, save = true) {
  ovSpeed = Math.min(OV_SPEED_MAX, Math.max(OV_SPEED_MIN, Number(v) || 1));
  if (save) try { localStorage.setItem(OV_SPEED_KEY, String(ovSpeed)); } catch { /* ok */ }
  ovUpdateSpeedLabel();
  if (ov && ov.paused) ov.last = performance.now(); // 暂停态改速：恢复时的时间基准修正
}

// v3.76：循环播放开关也记在本机；开启后重放播完自动从头再来
const OV_LOOP_KEY = "pl_ovLoop";
let ovLoopOn = localStorage.getItem(OV_LOOP_KEY) === "1";

function ovUpdateLoopBtn() {
  const btn = $("overlay-loop");
  if (!btn) return;
  btn.classList.toggle("on", ovLoopOn);
  btn.setAttribute("aria-pressed", ovLoopOn ? "true" : "false");
  btn.title = ovLoopOn ? "循环播放：开" : "循环播放：关";
}

/// v3.78：循环开关的唯一切换入口——按钮点按和 L 快捷键都走这儿，状态当场记本机
function toggleOverlayLoop() {
  ovLoopOn = !ovLoopOn;
  try { localStorage.setItem(OV_LOOP_KEY, ovLoopOn ? "1" : "0"); } catch { /* ok */ }
  ovUpdateLoopBtn();
}

/// v3.23 #31：进度条（按播放时长占比）+ 「第 n/共 m 笔」计数
/// v3.75：把毫秒折成「剩 X 秒 / 剩 X 分 Y 秒」，读完显示「读完」
function ovLeftText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s <= 0) return "读完";
  return s < 60 ? `剩 ${s} 秒` : `剩 ${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

function ovProgressUi() {
  const fill = $("ov-progress-fill");
  const cnt = $("ov-count");
  if (!ov) { if (fill) fill.style.width = "0%"; if (cnt) cnt.textContent = ""; return; }
  let played = 0;
  for (let i = 0; i < ov.si; i++) played += ov.durs[i];
  if (ov.si < ov.strokes.length) played += Math.min(ov.elapsed, ov.durs[ov.si]);
  const frac = Math.max(0, Math.min(1, played / ov.totalDur));
  if (fill) fill.style.width = (frac * 100).toFixed(1) + "%";
  // v3.75：笔数后面跟剩余时长，长信一眼有数
  const remain = Math.max(0, ov.totalDur - played);
  if (cnt) cnt.textContent = ov.done
    ? `${ov.strokes.length}/${ov.strokes.length} 笔 · 读完`
    : `${Math.min(ov.si + 1, ov.strokes.length)}/${ov.strokes.length} 笔 · ${ovLeftText(remain)}`;
}

/// #49 信件重放分段绘制：直接委托引擎的 strokeSegment（与书写/镜像同款几何）
function ovDrawSeg(pts, i, ctx, ink) {
  strokeSegment(ctx, pts, i, ink);
}

// ================================================================ v4.60 半透墨重放分层
/// 半透墨（白笺 @透明度）逐段增量画会帧帧叠深成一串暗点——开笔前给页面拍快照，
/// 段画进不透明离屏层，每帧「快照 + 层带透合成」重铺，透明度只作用一次。
function ovLayerStart(ov, ink) {
  try {
    if (!ov.layerCv) ov.layerCv = document.createElement("canvas");
    if (!ov.snapCv) ov.snapCv = document.createElement("canvas");
    for (const cv of [ov.layerCv, ov.snapCv]) {
      if (cv.width !== ov.canvas.width || cv.height !== ov.canvas.height) {
        cv.width = ov.canvas.width; cv.height = ov.canvas.height;
      }
    }
    const sctx = ov.snapCv.getContext("2d");
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, ov.snapCv.width, ov.snapCv.height);
    sctx.drawImage(ov.canvas, 0, 0);
    const lctx = ov.layerCv.getContext("2d");
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, ov.layerCv.width, ov.layerCv.height);
    lctx.setTransform(ov.dpr, 0, 0, ov.dpr, 0, 0);
    ov.layerOn = true;
    ov.layerInk = solidInkOf(ink);
    ov.layerAlpha = inkAlphaOf(ink);
  } catch { ov.layerOn = false; }
}
function ovLayerCompose(ov) {
  const ctx = ov.ctx;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ov.canvas.width, ov.canvas.height);
  ctx.drawImage(ov.snapCv, 0, 0);
  ctx.globalAlpha = 0.97 * (ov.layerAlpha ?? 1);
  ctx.drawImage(ov.layerCv, 0, 0);
  ctx.restore();
}

/// v4.60：把重放画面重铺到「第 si 笔播到 rel 毫秒」的状态——进度条拖拽跳转用它。
/// 返回断点笔已画到的段下标；半透笔走分层合成，保证跳转后画面与顺播一致。
function ovRedrawTo(si, rel) {
  const ctx = ov.ctx;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ov.canvas.width, ov.canvas.height);
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = 0.97;
  for (let s = 0; s < si; s++) {
    const pts = ov.strokes[s];
    if (!pts || !pts.length) continue;
    const ink = ov.strokeInks[s] || ov.ink;
    if (inkAlphaOf(ink) < 0.999) {
      ovLayerStart(ov, ink);
      const lc = ov.layerCv.getContext("2d");
      if (pts.length === 1) strokeSegment(lc, pts, 0, ov.layerInk);
      else for (let i = 0; i < pts.length - 1; i++) strokeSegment(lc, pts, i, ov.layerInk);
      ovLayerCompose(ov);
      ov.layerOn = false;
    } else if (pts.length === 1) strokeSegment(ctx, pts, 0, ink);
    else for (let i = 0; i < pts.length - 1; i++) strokeSegment(ctx, pts, i, ink);
  }
  const cur = ov.strokes[si];
  let idx = 0;
  if (cur && cur.length) {
    const ink = ov.strokeInks[si] || ov.ink;
    const semi = inkAlphaOf(ink) < 0.999;
    if (semi) ovLayerStart(ov, ink);
    const tgt = semi ? ov.layerCv.getContext("2d") : ctx;
    const tink = semi ? ov.layerInk : ink;
    while (idx < cur.length - 1 && cur[idx + 1].t <= rel) { strokeSegment(tgt, cur, idx, tink); idx++; }
    if (idx === 0 && cur.length === 1 && rel > 0) { strokeSegment(tgt, cur, 0, tink); idx = 1; }
    if (semi) { ovLayerCompose(ov); ov.layerOn = false; }
  }
  ctx.restore();
  return idx;
}

/// v4.60：拖进度条跳转——重铺画面、从新断点续播，断点同步记进浏览器缓存
function ovSeekFrac(f) {
  if (!ov || !ov.totalDur) return;
  const target = Math.max(0, Math.min(1, f)) * ov.totalDur;
  let acc = 0, si = 0;
  while (si < ov.durs.length && acc + ov.durs[si] < target) { acc += ov.durs[si]; si++; }
  const rel = target - acc;
  const idx = ovRedrawTo(si, rel);
  ov.si = si; ov.idx = idx; ov.elapsed = rel;
  ov.interGap = 0;
  ov.done = si >= ov.strokes.length;
  if (ov.done) ovProgClear(ov.pid); else ovProgSave(); // 拖到末尾=读完，清断点
  ovProgressUi();
  if (!ov.paused && !ovRaf) ovRaf = requestAnimationFrame(ovStep);
}

function ovStep(nowT) {
  ovRaf = 0;
  if (!ov || $("letter-overlay").classList.contains("hidden")) { ov = null; return; }
  let dt = nowT - ov.last;
  ov.last = nowT;
  if (dt > 150) dt = 16; // v3.85：切后台/锁屏的时长不计入回放——回来从离开那帧接着放（掉帧不补物理）
  // v3.23 #18：倍速系数（内部基准 0.9 倍）同时作用于笔画推进与笔间停顿
  const k = ovSpeedFactor();
  if (!ov.paused && !ov.done) ov.elapsed += dt * k;
  if (ov.interGap > 0) ov.interGap -= dt * k; // #51 笔间停顿倒计时
  // v3.30：播放中每 2 秒记一次进度（中途被杀进程/关页面也只丢 2 秒）
  if (!ov.paused && !ov.done && nowT - ov.lastProgSave > 2000) { ov.lastProgSave = nowT; ovProgSave(); }

  const pts = ov.strokes[ov.si];
  if (pts && !ov.paused && ov.interGap <= 0) {
    const sInk = ov.strokeInks[ov.si] || ov.ink; // v4.48：这一笔自己的墨
    // v4.60：半透墨改快照+离屏层合成——增量段直接上画布会帧帧叠深出暗点
    if (!ov.layerOn && inkAlphaOf(sInk) < 0.999) ovLayerStart(ov, sInk);
    const tgt = ov.layerOn ? ov.layerCv.getContext("2d") : null;
    const tink = ov.layerOn ? ov.layerInk : sInk;
    let drew = false;
    while (ov.idx < pts.length - 1 && pts[ov.idx + 1].t <= ov.elapsed) {
      if (tgt) strokeSegment(tgt, pts, ov.idx, tink);
      else { ov.ctx.save(); ov.ctx.globalAlpha = 0.97; ovDrawSeg(pts, ov.idx, ov.ctx, sInk); ov.ctx.restore(); }
      ov.idx++;
      drew = true;
    }
    if (ov.idx === 0 && pts.length === 1 && ov.elapsed > 0) {
      if (tgt) strokeSegment(tgt, pts, 0, tink);
      else { ov.ctx.save(); ov.ctx.globalAlpha = 0.97; ovDrawSeg(pts, 0, ov.ctx, sInk); ov.ctx.restore(); }
      ov.idx = 1;
      drew = true;
    }
    if (ov.layerOn && drew) ovLayerCompose(ov);
    if (ov.idx >= pts.length - 1) {
      ov.layerOn = false; // v4.60：本笔合成完毕，层退役
      ov.si++; ov.idx = 0;
      const prevLen = pts[pts.length - 1]?.t || 0;
      if (ov.elapsed > prevLen) { ov.elapsed = 0; ov.interGap = REPLAY_STROKE_GAP_MS; }
      if (ov.si >= ov.strokes.length) {
        ov.done = true; ovProgClear(ov.pid); // v3.30：播完清断点
        if (ovLoopOn) { ovRestart(); return; } // v3.76：循环开着就从头再来（ovRestart 自带进度刷新与调度）
        ovHintNext(); // v3.77：读完且没开循环 → 提醒翻下一封
      }
    }
  }
  // #48 暂停/播完真正停帧省电；继续与重播由按钮重新调度
  if (!ov.paused && !ov.done) ovRaf = requestAnimationFrame(ovStep);
  ovProgressUi(); // v3.23 #31：进度条/笔画计数随帧更新（停帧前也刷到最新）
}

function toggleOverlayPause() {
  if (!ov) return;
  if (ov.done) { ovRestart(); return; }
  ov.paused = !ov.paused;
  if (ov.paused) ovProgSave(); // v3.30：暂停即记断点
  setOverlayPauseIcon();
  if (!ov.paused) {
    // #48 恢复播放：重置时间基准再调度，暂停时长不计入重放进度
    ov.last = performance.now();
    if (!ovRaf) ovRaf = requestAnimationFrame(ovStep);
  }
}

function ovRestart() {
  if (!ov) return;
  ovProgClear(ov.pid); // v3.30：从头重播即清断点
  ov.ctx.setTransform(1, 0, 0, 1, 0, 0);
  ov.ctx.clearRect(0, 0, ov.canvas.width, ov.canvas.height);
  ov.ctx.setTransform(ov.dpr, 0, 0, ov.dpr, 0, 0);
  ov.layerOn = false; // v4.60：重播作废半透层（快照已是旧画面）
  ov.si = 0; ov.idx = 0; ov.elapsed = 0; ov.paused = false; ov.done = false; ov.interGap = 0;
  ov.last = performance.now();
  setOverlayPauseIcon();
  ovProgressUi();
  if (!ovRaf) ovRaf = requestAnimationFrame(ovStep);
}

function setOverlayPauseIcon() {
  const btn = $("overlay-pause");
  if (!btn || !ov) return;
  btn.innerHTML = ov.paused || ov.done ? icon("play", 14) : icon("pause", 14);
  btn.title = ov.paused ? "继续" : "暂停";
}

/// v3.81 轻点信纸 = 暂停/继续（读完的信 = 从头再放），走和空格键同一个入口。
/// 按钮、落款行、控制条不算——它们各管各的。点完在信纸中央浮个小图标说明刚才干了啥。
let _tapFlashTimer = 0;
function ovTapFlash() {
  const el = $("ov-tap-flash");
  if (!el || !ov) return;
  el.innerHTML = ov.paused ? icon("pause", 30) : icon("play", 30); // 刚暂停→⏸ / 刚继续或重播→▶
  el.classList.remove("show");
  void el.offsetWidth; // 重启动画
  el.classList.add("show");
  clearTimeout(_tapFlashTimer);
  _tapFlashTimer = setTimeout(() => el.classList.remove("show"), 700);
}

function wireOverlayTapPause() {
  $("overlay-paper").addEventListener("click", (e) => {
    if (_ovSwiped) { _ovSwiped = false; return; } // v3.82：刚滑过一下，别顺手把暂停点了
    if (e.target.closest("button") || e.target.closest(".letter-head") || e.target.closest(".overlay-controls")) return;
    toggleOverlayPause();
    ovTapFlash();
  });
}

/// v3.82 信纸上横着滑 = 翻信：左滑下一封、右滑上一封（←/→ 的触屏版，走翻信按钮同一入口）。
/// 按位移和轻点区分：够横、够远才算翻页；滑完挂个标记，让滑后的 click 不误触暂停。
let _swipeX = 0, _swipeY = 0, _ovSwiped = false;
function wireOverlaySwipe() {
  const op = $("overlay-paper");
  op.addEventListener("pointerdown", (e) => { _swipeX = e.clientX; _swipeY = e.clientY; _ovSwiped = false; });
  op.addEventListener("pointercancel", () => { _ovSwiped = false; });
  op.addEventListener("pointerup", (e) => {
    const dx = e.clientX - _swipeX, dy = e.clientY - _swipeY;
    if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.5) return; // 不够远 / 太斜 → 归轻点逻辑
    if (e.target.closest("button") || e.target.closest(".overlay-controls")) return; // 按钮上的触碰不算翻信
    _ovSwiped = true;
    stepLetter(dx < 0 ? 1 : -1); // 左滑下一封、右滑上一封
  });
}

/// v3.98 iOS16+ Safari 全屏下滑防回弹：全屏（原生 / CSS 兜底）与看信期间，
/// 拦截根滚动触摸手势——否则向下一扫会带起整页回弹、看着像退出了全屏。
/// 抽屉列表 / 弹层等仍需局部滚动的容器不拦；纸面书写走 pointer 事件不受影响。
/// v4.1 #61：工具栏（按钮列自身可滚动）与滑条弹层也要放行，
/// 此前全屏下矮屏工具栏被锁死无法滚动、底部按钮够不到。
function wireFsScrollLock() {
  document.addEventListener("touchmove", (e) => {
    const fs = fullscreenElement() || state.cssFullscreen;
    const reading = document.body.classList.contains("letter-open");
    if (!fs && !reading) return;
    if (e.target.closest("#letter-drawer .list, .popup-card, .overlay-controls, #music-list, #guide-scroll, #toolbar, #eraser-pop, #tip-pop, #width-pop")) return;
    e.preventDefault();
  }, { passive: false });
  // v4.1 #37：iOS 双指捏合会触发 Safari 页面缩放、连带把"全屏"观感打破——
  // 书写房内直接掐掉 gesture 事件（viewport 已 user-scalable=no，这里是保险）
  if (UA.ios) {
    for (const ev of ["gesturestart", "gesturechange", "gestureend"]) {
      document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
    }
  }
}

/// v3.83 第一次看信的手势提示：轻点暂停、左右滑翻信——只露一次，
/// 6 秒自己淡出；手一碰上屏幕立刻识趣退场，往后永不再提。
const OV_GESTURE_TIP_KEY = "pl_ovGestureTip";
let _gtipTimer = 0;
function ovGestureTipMaybe() {
  const el = $("ov-gesture-tip");
  if (!el) return;
  try {
    if (localStorage.getItem(OV_GESTURE_TIP_KEY) === "1") return;
    localStorage.setItem(OV_GESTURE_TIP_KEY, "1"); // 露脸即记账，一辈子只提一次
  } catch { /* ok */ }
  el.classList.remove("hidden", "fade");
  clearTimeout(_gtipTimer);
  _gtipTimer = setTimeout(ovGestureTipHide, 6000);
}
function ovGestureTipHide() {
  const el = $("ov-gesture-tip");
  if (!el || el.classList.contains("hidden")) return;
  clearTimeout(_gtipTimer);
  el.classList.add("fade");
  setTimeout(() => el.classList.add("hidden"), 650);
}

/// v3.89 在线绿点心跳：小绿点每约 2 秒向外荡开一圈脉冲涟漪（径向渐变、圈渐大、透明度渐淡）；
/// TA 正在写字（书写胶囊亮着）→ 环更密更亮，空闲时更疏更淡——把「在线」从静态圆点变成活体信号。
function mountDotPulse(badge) {
  if (!badge || (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) return;
  const cv = document.createElement("canvas");
  cv.className = "dot-pulse";
  cv.setAttribute("aria-hidden", "true");
  badge.appendChild(cv);
  const S = 46, dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = S * dpr; cv.height = S * dpr;
  const ctx = cv.getContext("2d");
  const rings = [];
  let last = performance.now(), acc = 1.6; // 起步提前些，上线第一眼就能看见心跳
  const tick = (nowT) => {
    requestAnimationFrame(tick);
    let dt = (nowT - last) / 1000;
    last = nowT;
    if (dt > 0.1) dt = 0.016; // 切后台回来不补账（和回放、天气同一条规矩）
    const on = badge.classList.contains("online") && !badge.classList.contains("hidden") && !document.hidden;
    if (!on) { if (rings.length) { rings.length = 0; ctx.clearRect(0, 0, cv.width, cv.height); } return; }
    const busy = state.partnerWriting; // TA 在写字 → 心跳加快变亮
    acc += dt;
    if (acc >= (busy ? 0.9 : 2)) { acc = 0; rings.push({ r: 5, a: busy ? 0.85 : 0.55 }); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, S, S);
    const c = S / 2;
    for (let i = rings.length - 1; i >= 0; i--) {
      const g = rings[i];
      g.r += dt * 14; g.a -= dt * (busy ? 0.75 : 0.42);
      if (g.a <= 0 || g.r >= c) { rings.splice(i, 1); continue; }
      const grad = ctx.createRadialGradient(c, c, Math.max(0, g.r - 2.5), c, c, g.r);
      grad.addColorStop(0, "rgba(48, 180, 85, 0)");
      grad.addColorStop(0.72, `rgba(48, 180, 85, ${(g.a * 0.55).toFixed(3)})`);
      grad.addColorStop(1, "rgba(48, 180, 85, 0)");
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(c, c, g.r, 0, Math.PI * 2); ctx.fill();
    }
  };
  requestAnimationFrame(tick);
}




// ================================================================ v4.25 页栈与翻页器

/// 把当前画布状态存进第 i 页（strokes / 去重表 / 远端 id 表一起存）
function saveSheet(i) {
  const s = state.sheets[i];
  if (!s) return;
  s.strokes = pad.strokes;
  s.remote = state.remoteIds;
  s.seen = state.seenStrokes;
}

/// 取出第 i 页到画布（不广播：翻看自己之前的页是本端行为）
function loadSheet(i) {
  const s = state.sheets[i];
  if (!s) return;
  state.sheetIdx = i;
  pad.strokes = s.strokes;
  pad.current = null;
  state.remoteIds = s.remote;
  state.seenStrokes = s.seen;
  pad._cacheOk = false;
  pad.redraw();
  liveForgetAll();
  liveCanvasClear();
  updateSendBar();
  renderPager();
  syncSamePageGlow();
}

/// v4.27：实时镜像且双方在同一页 → 屏幕四边亮起渐变光晕；不同页/非镜像即熄
function syncSamePageGlow() {
  const el = $("same-page-glow");
  if (!el) return;
  const on = state.mode === "realtime" && state.partnerSheetIdx === state.sheetIdx;
  el.classList.toggle("on", on);
}

function renderPager() {
  const prev = $("pager-prev");
  if (prev) prev.disabled = state.sheetIdx <= 0;
  const label = $("pager-label");
  if (label) label.textContent = `${state.sheetIdx + 1}/${state.sheets.length}`;
  // v4.38：下一页按钮的图标跟着语义走——还有下一页时是与上一页对应的右箭头，
  // 已在末页时换成「新的一页」（带加号的纸），点它＝开新页
  const nextBtn = $("pager-next");
  if (nextBtn) {
    const atLast = state.sheetIdx >= state.sheets.length - 1;
    const want = atLast ? "next" : "forward";
    if (nextBtn.dataset.icon !== want) {
      nextBtn.dataset.icon = want;
      nextBtn.innerHTML = icon(want, 18);
    }
    nextBtn.title = atLast ? "下一页（末页再点 = 新的一页）" : "下一页";
    nextBtn.setAttribute("aria-label", nextBtn.title);
  }
}

/// v4.58 页栈上限：一本日记至多 30 页——翻页器够翻、页栈内存与重放开销有界；
//  满了引导回看旧页（导出不受限，书信集里的信想存多少存多少）
const MAX_SHEETS = 30;

/// 新建一页：当前页入栈保留，追加空页并跳过去；broadcast 时对方同步追加
async function newSheetPage(broadcast) {
  if (state.sheets.length >= MAX_SHEETS) {
    toast(`一本日记最多 ${MAX_SHEETS} 页——翻回前面的页看看，或把写满的寄出`, 2600);
    return;
  }
  state.redoStack.length = 0; // v3.53：翻页 → 重做历史作废
  saveSheet(state.sheetIdx);
  state.sheets.push({ strokes: [], remote: new Set(), seen: new Set() });
  cancelReplayOf(null); // v4.1 #15
  await pad.dissolve(400);
  loadSheet(state.sheets.length - 1);
  if (broadcast) {
    send({ t: "page_turn" }); // v2：新页镜像
    state.partnerSheetIdx = state.sheetIdx; // 对方会追加并跟随 → 仍在同一页
  }
  showCenterTip("新的一页", 1200);
  syncSamePageGlow();
}

/// 翻到已有页：本端行为不跟随对方；实时镜像下把页码告诉对方（只提示、不拽人）
async function gotoSheet(i) {
  if (i < 0 || i >= state.sheets.length || i === state.sheetIdx) return;
  state.redoStack.length = 0;
  saveSheet(state.sheetIdx);
  cancelReplayOf(null);
  await pad.dissolve(250);
  loadSheet(i);
  if (state.mode === "realtime") send({ t: "page_goto", i });
  syncSamePageGlow();
}

// ================================================================ 工具栏

/// v4.30：长按弹出来的滑条 3 秒不用自动收起；拖动滑条会续期；点别处立即收起
const POP_IDLE_MS = 3000;
function armPopAutoHide(pop) {
  if (!pop) return;
  clearTimeout(pop._idleTimer);
  pop._idleTimer = setTimeout(() => pop.classList.add("hidden"), POP_IDLE_MS);
}

function wireToolbar() {
  // v4.25：右下角横排翻页器——上一页 / 页码 / 下一页（末页再点 = 新的一页）
  // v4.27：换页回到"各翻各的"——镜像下只把页码告知对方（中央浮提示 + 同页光晕），不拽人跟随
  $("pager-prev").addEventListener("click", () => gotoSheet(state.sheetIdx - 1));
  $("pager-next").addEventListener("click", () => {
    if (state.sheetIdx >= state.sheets.length - 1) newSheetPage(true);
    else gotoSheet(state.sheetIdx + 1);
  });

  const eraserBtn = $("btn-eraser");
  eraserBtn.addEventListener("click", () => {
    pad.eraseTool = !pad.eraseTool;
    eraserBtn.classList.toggle("active", pad.eraseTool);
    inkCanvas.classList.toggle("erasing", pad.eraseTool);
    if (!pad.eraseTool) { $("eraser-ring").style.display = "none"; $("eraser-pop").classList.add("hidden"); }
  });
  // 长按橡皮 → 大小滑条（v3.7：滑条贴在橡皮按钮旁，不再固定在页面底部）
  eraserBtn.addEventListener("pointerdown", () => {
    state.eraserHold = setTimeout(() => {
      const pop = $("eraser-pop");
      pop.classList.toggle("hidden");
      $("eraser-range").value = pad.eraseR;
      if (!pop.classList.contains("hidden")) { positionPopByButton(pop, eraserBtn); armPopAutoHide(pop); }
    }, 450);
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) {
    eraserBtn.addEventListener(ev, () => clearTimeout(state.eraserHold));
  }
  $("eraser-range").addEventListener("input", (e) => { pad.eraseR = Number(e.target.value) || 18; armPopAutoHide($("eraser-pop")); });
  // v4.50 橡皮模式：涂抹（像素橡皮）/ 整笔（点哪笔删哪笔），选择本机记忆
  try { pad.eraseMode = localStorage.getItem("pl_eraserMode") === "stroke" ? "stroke" : "pixel"; } catch { pad.eraseMode = "pixel"; }
  const syncEraserModeUi = () => {
    $("eraser-mode-pixel")?.classList.toggle("on", pad.eraseMode !== "stroke");
    $("eraser-mode-stroke")?.classList.toggle("on", pad.eraseMode === "stroke");
  };
  syncEraserModeUi();
  for (const [id, mode] of [["eraser-mode-pixel", "pixel"], ["eraser-mode-stroke", "stroke"]]) {
    $(id)?.addEventListener("click", () => {
      pad.eraseMode = mode;
      try { localStorage.setItem("pl_eraserMode", mode); } catch { /* ok */ }
      syncEraserModeUi();
      toast(mode === "stroke" ? "整笔橡皮：点哪笔删哪笔" : "涂抹橡皮：滑过擦除", 1600);
      armPopAutoHide($("eraser-pop"));
    });
  }

  // v4.50 存为图片：当前页 → PNG（手机走系统分享，桌面直接下载）
  $("btn-export")?.addEventListener("click", () => { exitImmersive(); exportPageImage(); });

  // v3.15 自动出锋：轻点开关（状态存浏览器缓存），长按调出锋长度
  const tipBtn = $("btn-tip");
  tipBtn.classList.toggle("active", pad.tipOn);
  tipBtn.addEventListener("click", () => {
    pad.tipOn = !pad.tipOn;
    try { localStorage.setItem("pl_tipOn", pad.tipOn ? "1" : "0"); } catch { /* ok */ }
    tipBtn.classList.toggle("active", pad.tipOn);
    toast(pad.tipOn ? "自动出锋已打开" : "自动出锋已关闭");
    $("tip-pop").classList.add("hidden");
  });
  tipBtn.addEventListener("pointerdown", () => {
    state.tipHold = setTimeout(() => {
      const pop = $("tip-pop");
      pop.classList.toggle("hidden");
      $("tip-range").value = pad.tipN;
      if (!pop.classList.contains("hidden")) { positionPopByButton(pop, tipBtn); armPopAutoHide(pop); }
    }, 450);
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) {
    tipBtn.addEventListener(ev, () => clearTimeout(state.tipHold));
  }
  $("tip-range").addEventListener("input", (e) => {
    pad.tipN = Math.min(40, Math.max(2, Math.round(Number(e.target.value)) || 8));
    try { localStorage.setItem("pl_tipN", String(pad.tipN)); } catch { /* ok */ }
    armPopAutoHide($("tip-pop"));
  });

  // v4.1 #22 笔迹粗细：轻点弹出滑条（0.5x–20x），本机记忆；
  // 只缩放自己落笔的粗细（strokeScale 参与 widthFor），对端按各自比例折算不受影响
  const widthBtn = $("btn-width");
  const widthPop = $("width-pop");
  const syncWidthOut = () => { $("width-out").textContent = (pad.strokeScale || 1).toFixed(1) + "x"; }; // v4.65：回倍率读数（上限 20x）
  widthBtn.addEventListener("click", () => {
    const hidden = widthPop.classList.contains("hidden");
    // 互斥：打开粗细滑条时收起其它滑条
    $("eraser-pop").classList.add("hidden");
    $("tip-pop").classList.add("hidden");
    $("smooth-pop").classList.add("hidden");
    widthPop.classList.toggle("hidden", !hidden);
    if (hidden) { $("width-range").value = pad.strokeScale || 1; syncWidthOut(); positionPopByButton(widthPop, widthBtn); armPopAutoHide(widthPop); }
  });
  $("width-range").addEventListener("input", (e) => {
    const v = Math.min(20, Math.max(0.5, Number(e.target.value) || 1)); // v4.65：上限 20x（老口径 2.5x 的放宽版）
    pad.strokeScale = v;
    syncWidthOut();
    try { localStorage.setItem("pl_strokeScale", String(v)); } catch { /* ok */ }
    armPopAutoHide(widthPop);
  });

  // v4.62 平滑度按钮：轻点开关（关 = 原始轨迹），长按弹滑条调值；本机记忆
  const smoothBtn = $("btn-smooth");
  const smoothPop = $("smooth-pop");
  const syncSmoothUi = () => {
    smoothBtn?.classList.toggle("active", pad.smooth > 0.02);
    const out = $("smooth-out");
    if (out) out.textContent = (pad._smoothVal || 0.35).toFixed(2);
  };
  smoothBtn?.addEventListener("click", () => {
    if (smoothBtn._holdFired) { smoothBtn._holdFired = false; return; } // 长按刚开滑条，这次 click 不算轻点
    const on = pad.smooth <= 0.02;
    pad.smooth = on ? (pad._smoothVal || 0.35) : 0;
    try { localStorage.setItem("pl_smooth_on", on ? "1" : "0"); } catch { /* ok */ }
    syncSmoothUi();
    toast(on ? `笔迹平滑已开（${(pad._smoothVal || 0.35).toFixed(2)}）` : "平滑已关：原始轨迹", 1600);
  });
  smoothBtn?.addEventListener("pointerdown", () => {
    smoothBtn._hold = setTimeout(() => {
      smoothBtn._holdFired = true;
      smoothPop.classList.toggle("hidden");
      $("smooth-range").value = pad._smoothVal || 0.35;
      syncSmoothUi();
      if (!smoothPop.classList.contains("hidden")) { positionPopByButton(smoothPop, smoothBtn); armPopAutoHide(smoothPop); }
    }, 450);
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) smoothBtn?.addEventListener(ev, () => clearTimeout(smoothBtn._hold));
  $("smooth-range")?.addEventListener("input", (e) => {
    const v = Math.min(0.8, Math.max(0.05, Number(e.target.value) || 0.35));
    pad._smoothVal = v;
    pad.smooth = v; // 调值即视为开启
    try { localStorage.setItem("pl_smooth", String(v)); localStorage.setItem("pl_smooth_on", "1"); } catch { /* ok */ }
    syncSmoothUi();
    armPopAutoHide(smoothPop);
  });
  syncSmoothUi();

  // v3.29：多步撤销——轻点撤一笔；长按 420ms 后连续撤（每 240ms 一笔，松手停）
  // v4.50：撤销仅对自己端有效——只弹「自己的」最后一笔（跳过对端镜像笔画），
  // 且不再向对端广播；对方写的字撤不掉，我撤的字对方也看不到变化。
  const undoBtn = $("btn-undo");
  const doUndo = () => {
    let idx = -1;
    for (let i = pad.strokes.length - 1; i >= 0; i--) {
      if (!state.remoteIds.has(pad.strokes[i].id)) { idx = i; break; }
    }
    if (idx < 0) {
      if (pad.strokes.length) toast("这一页剩下的都是对方的笔迹，撤销只作用于自己写的字", 2400);
      return;
    }
    const [s] = pad.strokes.splice(idx, 1);
    pad._cacheOk = false;
    pad.redraw();
    state.redoStack.push(s); // 弹走的笔进重做栈，等待放回
    updateSendBar();
  };
  // v3.53 重做：把重做栈顶的笔画放回——v4.50 起撤销仅本端生效，不再重发对端；
  // v4.52 例外：整笔橡皮擦掉的笔当初是双向广播删除的，放回时必须重新广播，
  // 否则本端有字、对端没有，两边画面分裂
  const doRedo = () => {
    const s = state.redoStack.pop();
    if (!s) return;
    pad.strokes.push(s);
    pad._cacheOk = false;
    pad.redraw();
    if (s._eraserSynced && state.mode === "realtime") sendStrokeRealtime(s);
    updateSendBar();
  };
  let undoHoldTimer = 0, undoRepeat = 0, undoHeld = false;
  undoBtn.addEventListener("pointerdown", () => {
    undoHeld = false;
    clearTimeout(undoHoldTimer);
    undoHoldTimer = setTimeout(() => {
      undoHeld = true; // 长按已生效：抬起时不再触发 click 的那一笔
      doUndo();
      undoRepeat = setInterval(doUndo, 240);
    }, 420);
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) {
    undoBtn.addEventListener(ev, () => {
      clearTimeout(undoHoldTimer);
      clearInterval(undoRepeat);
      undoRepeat = 0;
    });
  }
  undoBtn.addEventListener("click", () => {
    if (undoHeld) { undoHeld = false; return; }
    doUndo();
  });
  $("btn-redo").addEventListener("click", doRedo);
  // v4.63 按钮列滚动兜底：部分内核（微信 X5 / 老 WebView）对「fixed 列 + 容器
  // pointer-events:none」的原生 overflow 滚动不生效——矮屏上按钮列滚不动、
  // 下半排永远够不到。检测到竖向拖拽且原生没滚动时手动接管 scrollTop；
  // 原生正常的内核全程让路（一旦发现 scrollTop 自己动了即退出接管）。
  const tbEl = $("toolbar");
  if (tbEl) {
    let g = null;
    const killHolds = () => {
      clearTimeout(state.eraserHold);
      clearTimeout(state.tipHold);
      const sb = $("btn-smooth");
      if (sb) clearTimeout(sb._hold);
      clearTimeout(undoHoldTimer);
    };
    tbEl.addEventListener("pointerdown", (e) => {
      g = { id: e.pointerId, y: e.clientY, top: tbEl.scrollTop, moved: false, native: false, last: tbEl.scrollTop };
    }, true);
    tbEl.addEventListener("pointermove", (e) => {
      if (!g || e.pointerId !== g.id) return;
      const dy = e.clientY - g.y;
      if (!g.moved) {
        if (Math.abs(dy) < 8) return;
        g.moved = true;
        g.native = tbEl.scrollTop !== g.top; // 原生已先动 → 全程让路
        if (g.native) return;
        killHolds(); // 手动拖拽：长按弹层/连续撤销不得触发
        tbEl._dragSuppress = true;
      }
      if (g.native) return;
      if (tbEl.scrollTop !== g.last) { g.native = true; tbEl._dragSuppress = false; return; } // 原生中途接管
      tbEl.scrollTop = g.top - dy;
      g.last = tbEl.scrollTop;
    }, true);
    const endG = (e) => {
      if (!g || e.pointerId !== g.id) return;
      const suppress = g.moved && !g.native;
      g = null;
      if (!suppress) tbEl._dragSuppress = false;
      else setTimeout(() => { tbEl._dragSuppress = false; }, 0); // 放过本次拖拽尾随的 click
    };
    tbEl.addEventListener("pointerup", endG, true);
    tbEl.addEventListener("pointercancel", endG, true);
    // 手动拖拽尾随的 click 一律当误触（橡皮切换/撤销/全屏等不得误发）
    tbEl.addEventListener("click", (e) => {
      if (tbEl._dragSuppress) {
        tbEl._dragSuppress = false;
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);
  }
  // v3.52/v3.53 键盘撤销/重做：Ctrl/Cmd+Z 撤一笔、Ctrl/Cmd+Shift+Z 或 Ctrl+Y 放回；
  // 输入框内的原生撤销不抢（昵称/搜索等场景照常）
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const isZ = e.key === "z" || e.key === "Z";
    const isY = e.key === "y" || e.key === "Y";
    if (isZ && !e.shiftKey) { e.preventDefault(); doUndo(); }
    else if ((isZ && e.shiftKey) || isY) { e.preventDefault(); doRedo(); }
  });

  $("btn-clear").addEventListener("click", async () => {
    if (!pad.hasInk()) return;
    // v4.35 修复：寄信模式下清空是"只清自己这一页"。此前 clear_all 无条件广播，
    // 一方清空会把另一方正在写的页也擦掉——只有实时镜像才共享同一张纸
    const mirror = state.mode === "realtime";
    // v3.41 安全卡：页面积了相当内容（≥4 笔或 ≥300 点）才问一句——
    // 清空不可撤销；镜像里还会同步擦掉对方那边，文案据此区分
    if ((pad.strokes.length >= 4 || pad.totalPoints() >= 300) &&
        !confirmDialog(mirror
          ? "这一页已有不少内容。清空后不能撤销、对方那边也会同步清除。确定清空吗？"
          : "这一页已有不少内容。清空后不能撤销（只清自己这一页，不影响对方）。确定清空吗？")) return;
    state.redoStack.length = 0; // v3.53：清空 → 重做历史作废
    if (mirror) send({ t: "clear_all" });
    await pad.dissolve(800);
    pad.reset();
    state.remoteIds.clear();
    state.seenStrokes.clear(); // v4.1 #12
    liveForgetAll();
    liveCanvasClear();
    updateSendBar();
  });

  $("btn-fullscreen").addEventListener("click", toggleFullscreen);
  onFullscreenChange(syncFullscreenUi);

  $("btn-landscape").addEventListener("click", toggleLandscape);

  $("btn-fade").addEventListener("click", () => {
    document.body.classList.toggle("dim-ui");
    $("btn-fade").classList.toggle("active", document.body.classList.contains("dim-ui"));
  });

  $("btn-mode").addEventListener("click", () => {
    const next = state.mode === "realtime" ? "letter" : "realtime";
    setMode(next, true);
  });

  wireMusic();

  $("send-cancel").addEventListener("click", async () => {
    await pad.dissolve(500);
    pad.reset();
    updateSendBar();
  });
  $("send-go").addEventListener("click", doSend);
}

// ================================================================ 音乐（实验）
// 网易云搜歌/播放：转发 Meting-API（GitHub: injahow/Meting-API），Worker 代理。
// v3.9：播放时歌词随进度在房内柔和浮现（无落雨动画，只留当前句的淡入淡出）。

let lyricLines = null;   // [{t, text}] 按时间升序
let lyricIdx = -1;       // 当前显示句序号
let lyricTrack = "";     // 正在同步歌词的歌 id
let lyricRaf = 0;
let lyricSeq = 0;        // 会话序号：切歌后晚到的旧歌词请求不得覆盖新状态

/// 解析 LRC：一行可挂多个时间标签；纯元数据/空行丢弃；
/// 兼容 [mm:ss.xx] 与 [mm:ss:xx] 两种毫秒分隔法
function parseLrc(lrc) {
  const lines = [];
  for (const raw of String(lrc).split(/\r?\n/)) {
    const times = [...raw.matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)];
    if (!times.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    if (!text) continue;
    for (const m of times) {
      const sec = Number(m[1]) * 60 + Number(m[2]) + (m[3] != null ? Number("0." + m[3]) : 0);
      if (Number.isFinite(sec)) lines.push({ t: sec, text });
    }
  }
  lines.sort((a, b) => a.t - b.t);
  return lines;
}

function lyricEl() {
  let el = $("music-lyric");
  if (!el) {
    el = document.createElement("div");
    el.id = "music-lyric";
    el.setAttribute("aria-hidden", "true");
    document.body.appendChild(el);
  }
  return el;
}

function stopLyrics() {
  lyricLines = null; lyricIdx = -1; lyricTrack = "";
  if (lyricRaf) { cancelAnimationFrame(lyricRaf); lyricRaf = 0; }
  $("music-lyric")?.classList.remove("show", "fade");
  ambientRain?.resume(); // v3.16 #1：歌词退场，主题字符雨恢复
}

/// 拉歌词并挂上同步循环；拉不到不影响播放本身
async function startLyrics(t) {
  const seq = ++lyricSeq;
  stopLyrics();
  try {
    const d = await apiJson("/api/music/lrc?id=" + encodeURIComponent(t.id) + "&server=" + encodeURIComponent(t.server || "163"));
    if (seq !== lyricSeq) return; // 请求在途时已切歌，结果作废
    const lines = parseLrc(d.lrc || "");
    if (!lines.length) return;
    lyricLines = lines; lyricIdx = -1; lyricTrack = t.id;
    ambientRain?.pause(); // v3.16 #1：歌词字符出现时停用主题字符雨
    lyricRaf = requestAnimationFrame(lyricTick);
  } catch { /* 无歌词，静默跳过 */ }
}

/// 每帧比对播放进度二分找当前句；换句时重启淡入动画；
/// 暂停时停帧等 play 事件，不空转
function lyricTick() {
  lyricRaf = 0;
  const audio = window.__plAudio;
  if (!audio || !lyricLines || audio.ended) { stopLyrics(); return; }
  if (audio.paused) {
    const seq = lyricSeq;
    audio.addEventListener("play", () => {
      if (seq === lyricSeq && lyricLines && !lyricRaf) lyricRaf = requestAnimationFrame(lyricTick);
    }, { once: true });
    return;
  }
  const now = audio.currentTime || 0;
  let lo = 0, hi = lyricLines.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lyricLines[mid].t <= now) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (idx !== lyricIdx) {
    lyricIdx = idx;
    const el = lyricEl();
    if (idx >= 0) {
      el.textContent = lyricLines[idx].text;
      el.classList.add("show");
      el.classList.remove("fade");
      void el.offsetWidth; // 重启换句淡入动画
      el.classList.add("fade");
    } else {
      el.classList.remove("show", "fade");
    }
  }
  lyricRaf = requestAnimationFrame(lyricTick);
}

/// v4.52 「TA 在听」：把我正在播放的曲目同步给对方。
/// 低频活体状态（切歌/暂停才发），不进断线补发队列；对方仅在展示层使用。
function broadcastMusicNow(playing) {
  const t = state.lastTrack;
  send({
    t: "music_now",
    playing: !!playing,
    name: playing ? String(t?.name || "").slice(0, 60) : "",
    artist: playing ? String(t?.artist || "").slice(0, 40) : "",
  });
}

/// v4.57 微信/QQ 内嵌浏览器识别——音频自救提示与安装引导都按环境给不同话术
function isWechatLike() {
  const ua = navigator.userAgent || "";
  return /MicroMessenger|QQ\//.test(ua);
}

/// v4.57「显示播放成功却没有声音」自救：部分内嵌内核（微信/QQ 内置浏览器）
/// 会让 play() 成功、play 事件照发（对方甚至能看到「TA 在听」），但实际不出声、
/// 进度不动。开播后观察 3 秒：进度始终不走就把「正在播放」行改成「没声音？点这里」，
/// 点一下在新鲜手势里重播（既有 retry 接线），并提示微信用户可换浏览器打开。
let _audioWatchdog = 0;
function armAudioWatchdog(t) {
  clearInterval(_audioWatchdog);
  const audio = window.__plAudio;
  if (!audio) return;
  let ticks = 0;
  _audioWatchdog = setInterval(() => {
    ticks++;
    if (!audio || audio.paused || audio.ended) { clearInterval(_audioWatchdog); return; }
    if (audio.currentTime > 0.2) { clearInterval(_audioWatchdog); return; } // 进度在走 = 真在播
    if (ticks >= 3) {
      clearInterval(_audioWatchdog);
      const np = $("music-now");
      if (!np || np.classList.contains("retry")) return;
      np.textContent = `没声音？点这里重试：${t.name}${isWechatLike() ? "（或点右上角「···」在浏览器打开）" : ""}`;
      np.classList.add("retry");
    }
  }, 1000);
}

/// v4.57 微信内置浏览器：音频出声被 WeixinJSBridge 闸住——桥就绪前选的歌
/// 可能静音空转；桥就绪后若已有曲目且停着，补播一次（此回调内可出声）。
document.addEventListener("WeixinJSBridgeReady", () => {
  const audio = window.__plAudio;
  if (audio && audio.src && state.lastTrack && audio.paused) audio.play().catch(() => {});
}, false);

/// v4.57 播放进度对时：播放中每 20 秒广播一次当前进度；两端缓冲/暂停恢复时机
/// 不同会慢慢漂移，对时后由约定的一侧校正，听歌始终同步。
function broadcastMusicClock() {
  const audio = window.__plAudio;
  if (!audio || audio.paused || !state.lastTrack) return;
  send({
    t: "music_clock",
    name: String(state.lastTrack.name || "").slice(0, 60),
    tm: Math.round(audio.currentTime * 10) / 10,
    at: Date.now(),
  });
}

/// v4.57 收到对方进度：同曲且双方都在播时才校正；约定 sid 大的一方调整
/// （提前约好谁动，避免两端互拽来回抖）。漂移 >2s 直接对齐，0.75–2s 用
/// 6% 倍速无声追回（人耳几乎无感），≤0.75s 忽略。
let _musicRateTimer = 0;
function handleMusicClock(ev) {
  const audio = window.__plAudio;
  if (!audio || audio.paused || !ev || !ev.name) return;
  if (!state.lastTrack || String(state.lastTrack.name || "") !== String(ev.name)) return;
  if ((store.sid || "") <= (state.partner?.sid || "")) return; // 约定：sid 大的一方校正
  const elapsed = Math.max(0, (Date.now() - (Number(ev.at) || Date.now())) / 1000);
  const remote = (Number(ev.tm) || 0) + elapsed;
  const diff = remote - audio.currentTime;
  const ad = Math.abs(diff);
  if (ad <= 0.75 || !Number.isFinite(ad)) return;
  if (ad > 2) {
    try { audio.currentTime = Math.max(0, remote); } catch { /* ok */ }
    return;
  }
  try {
    audio.playbackRate = diff > 0 ? 1.06 : 0.94;
    clearTimeout(_musicRateTimer);
    _musicRateTimer = setTimeout(() => { try { audio.playbackRate = 1; } catch { /* ok */ } }, Math.min(6000, Math.round(ad / 0.06) * 1000));
  } catch { /* 内核不支持倍速就跳过校正 */ }
}

/// v4.51：对方正在播放 → 顶部浮一枚「TA 在听《…》」胶囊（带跳动均衡条）
/// v4.57：完整展示 4 秒后自动收成只剩均衡条的小胶囊（不长期挡纸面）；
/// 换歌重新展开；点一下也可展开/收起。
let peerMusicEl = null;
let peerMusicMiniTimer = 0;
let peerMusicSig = "";
function peerMusicExpand(sec = 4) {
  if (!peerMusicEl) return;
  peerMusicEl.classList.remove("mini");
  clearTimeout(peerMusicMiniTimer);
  peerMusicMiniTimer = setTimeout(() => peerMusicEl?.classList.add("mini"), sec * 1000);
}
function renderPeerMusic(ev) {
  if (!ev || !ev.playing || !ev.name) {
    peerMusicEl?.classList.remove("show");
    peerMusicEl?.classList.remove("mini");
    clearTimeout(peerMusicMiniTimer);
    peerMusicSig = "";
    return;
  }
  if (!peerMusicEl || !peerMusicEl.isConnected) {
    peerMusicEl = document.createElement("div");
    peerMusicEl.id = "peer-music-pill";
    peerMusicEl.setAttribute("aria-live", "polite");
    peerMusicEl.innerHTML = `<span class="pm-eq" aria-hidden="true"><i></i><i></i><i></i></span><span class="pm-text"></span>`;
    peerMusicEl.addEventListener("click", () => {
      if (peerMusicEl.classList.contains("mini")) peerMusicExpand(4);
      else { clearTimeout(peerMusicMiniTimer); peerMusicEl.classList.add("mini"); }
    });
    document.body.appendChild(peerMusicEl);
  }
  const who = displayNick(state.partner?.nick) || "TA";
  const sig = ev.name + "|" + (ev.artist || "");
  if (sig !== peerMusicSig) {
    peerMusicSig = sig;
    peerMusicEl.querySelector(".pm-text").textContent = `${who} 在听《${ev.name}》${ev.artist ? " · " + ev.artist : ""}`;
    peerMusicEl.classList.add("show");
    peerMusicExpand(4); // 换歌/首现：完整展示 4 秒再收小
  }
}

function wireMusic() {
  const cfg = window.__plConfig || {};
  // v3.9：音乐接入兑换码——总开关之外还须兑换过 MU 彩蛋（同 RT 的门槛模式）
  const allowed = cfg.musicAllowed !== false && hasEgg("MU");
  const btn = $("btn-music");
  if (!btn) return;
  btn.classList.toggle("hidden", !allowed);
  if (!allowed) return;

  btn.addEventListener("click", () => $("music-pop").classList.toggle("hidden"));
  setInterval(broadcastMusicClock, 20000); // v4.57：播放中每 20 秒对时一次（漂移校正）
  // v3.23 #47：播放被浏览器拦下时，点「正在播放」行在新鲜手势里续播/重试
  $("music-now").addEventListener("click", () => {
    const audio = window.__plAudio;
    if (audio && audio.src && audio.paused) {
      audio.play()
        .then(() => { $("music-now").classList.remove("retry"); if (state.lastTrack) startLyrics(state.lastTrack); })
        .catch(() => { if (state.lastTrack) playTrack(state.lastTrack); });
    }
  });
  $("music-close").addEventListener("click", () => $("music-pop").classList.add("hidden"));
  $("music-pop").addEventListener("click", (e) => {
    if (e.target === $("music-pop")) $("music-pop").classList.add("hidden");
  });
  $("music-search-btn").addEventListener("click", searchMusic);
  $("music-q").addEventListener("keydown", (e) => { if (e.key === "Enter") searchMusic(); });
}

async function searchMusic() {
  const q = $("music-q").value.trim();
  if (!q) return;
  const list = $("music-list");
  list.innerHTML = `<div class="drawer-empty" style="padding:20px 0">搜索中…</div>`;
  try {
    const d = await apiJson("/api/music?q=" + encodeURIComponent(q));
    const tracks = d.tracks || [];
    list.innerHTML = "";
    if (!tracks.length) {
      list.innerHTML = `<div class="drawer-empty" style="padding:20px 0">没有找到相关歌曲</div>`;
      return;
    }
    for (const t of tracks) {
      const item = document.createElement("div");
      item.className = "room-item music-track";
      item.innerHTML = `
        <span class="nm">${escapeHtml(t.name)}<span style="color:var(--dim);font-size:11px"> · ${escapeHtml(t.artist || "")}</span></span>
        <span class="open-hint">${icon("play", 13)}</span>`;
      item.addEventListener("click", () => {
        $("music-q")?.blur(); // v4.52：收起手机键盘——键盘盖住弹层底部的「正在播放/重试」行
        playTrack(t);
      });
      list.appendChild(item);
    }
  } catch (e) {
    list.innerHTML = e?.code === "mu_locked"
      ? `<div class="drawer-empty" style="padding:20px 0">音乐功能需兑换码解锁</div>`
      : `<div class="drawer-empty" style="padding:20px 0">搜索失败，稍后再试</div>`;
  }
}

async function playTrack(t) {
  const np = $("music-now");
  np.classList.remove("retry");
  np.textContent = `加载中：${t.name}`;
  state.lastTrack = t; // v3.23 #47：记住当前曲目，播放被拦时可点一下重试
  try {
    // v4.1 #A1 播放统一走 Worker 同源流代理（/api/music/stream）：
    //  - 网易云 CDN 直链是 http:// —— https 页面直接播会被混合内容拦截；
    //  - 直链带时效签名，二次取链后到手可能已过期；
    //  - 部分 CDN 校验 Referer。同源代理一并解决，且支持 Range 拖动。
    // v4.51：带上歌名/歌手——主源（网易云 VIP/版权曲）取不到直链时，
    // 服务端自动跨源到酷我找同名可播版本（"搜得到播不了"的根治）
    const src = `/api/music/stream?id=${encodeURIComponent(t.id)}&server=${encodeURIComponent(t.server || "163")}&name=${encodeURIComponent(t.name || "")}&artist=${encodeURIComponent(t.artist || "")}`;
    let audio = window.__plAudio;
    if (!audio) {
      audio = new Audio();
      audio.preload = "auto";
      audio.playsInline = true;
      window.__plAudio = audio;
      // v4.52 「TA 在听」：播放状态变化实时同步给对方
      audio.addEventListener("play", () => broadcastMusicNow(true));
      audio.addEventListener("pause", () => { broadcastMusicNow(false); try { audio.playbackRate = 1; } catch { /* ok */ } }); // v4.57：暂停时归位倍速（漂移校正用的临时倍速不留尾巴）
      audio.addEventListener("ended", () => broadcastMusicNow(false));
      // v3.23 #47：iOS 锁屏/控制中心的播放操作接管
      if ("mediaSession" in navigator) {
        navigator.mediaSession.setActionHandler?.("play", () => audio.play().catch(() => {}));
        navigator.mediaSession.setActionHandler?.("pause", () => audio.pause());
      }
    }
    audio.src = src;
    audio.onerror = () => { stopLyrics(); broadcastMusicNow(false); np.textContent = "音源失效了（可能需要会员或上游波动），换一首试试"; };
    audio.play()
      .then(() => {
        startLyrics(t); // v3.9：真正开播才挂歌词同步
        armAudioWatchdog(t); // v4.57：开播后观察进度，内核假播放时给一键自救
        // v3.23 #47：开播后把系统媒体面板的标题同步上
        if ("mediaSession" in navigator && window.MediaMetadata) {
          try { navigator.mediaSession.metadata = new MediaMetadata({ title: t.name, artist: t.artist || "" }); } catch { /* ok */ }
        }
      })
      .catch((e) => {
        // AbortError = 被切歌打断，属正常
        if (e?.name === "AbortError") return;
        // v4.52：按错误类型分流——只有自动播放策略拦截才提示「点这里重试」；
        // 音源本身播不动（格式/防盗链/失效，NotSupportedError 等）重试也没用，
        // 此前一律显示"播放被拦住了"误导用户反复点
        if (e?.name === "NotAllowedError") {
          np.textContent = `播放被拦住了，点这里重试：${t.name}`;
          np.classList.add("retry");
        } else {
          stopLyrics();
          np.textContent = `这首播不出来（音源可能需会员或已失效），换一首试试：${t.name}`;
        }
      });
    np.textContent = `正在播放：${t.name}${t.artist ? " · " + t.artist : ""}`;
  } catch (e) {
    np.textContent = e?.code === "mu_locked" ? "音乐功能需兑换码解锁" : "播放失败，稍后再试";
  }
}

function showEraserRing(e) {
  const ring = $("eraser-ring");
  const r = paper.getBoundingClientRect();
  ring.style.display = "block";
  // v4.32：橡皮范围以屏幕为准——滑条调的就是屏幕上的直径，放大后不再跟着变大
  // （此前放大 5 倍时圈和实际擦除范围一起放大 5 倍，一擦抹掉一片）。
  // 圈与实际作用范围始终 1:1，所见即所擦。
  ring.style.width = ring.style.height = pad.eraseR * 2 + "px";
  ring.style.left = (e.clientX - r.left) + "px";
  ring.style.top = (e.clientY - r.top) + "px";
}

/// 全屏：原生 API（含 webkit 前缀）→ 失败时 CSS 全屏兜底（iOS 等）。
/// v4.1 #37：iOS 一律直接走 CSS 全屏——iOS16+ 的原生元素全屏带系统级
/// "向下轻扫退出"手势，网页无法拦截，用户滑动即被踢出全屏、状态错乱；
/// CSS 全屏（fixed 布局 + 隐藏页眉）配合根滚动手势拦截，轻扫无副作用。
async function toggleFullscreen() {
  if (fullscreenElement() || state.cssFullscreen) {
    state.cssFullscreen = false;
    state.forceLandscape = false;
    $("btn-landscape").classList.remove("active");
    unlockOrientation();
    await exitFullscreen();
  } else if (UA.ios) {
    state.cssFullscreen = true;
  } else {
    const ok = await enterFullscreen();
    if (!ok) state.cssFullscreen = true; // 降级：CSS 全屏
  }
  syncFullscreenUi();
}

async function toggleLandscape() {
  if (!(fullscreenElement() || state.cssFullscreen)) return;
  state.forceLandscape = !state.forceLandscape;
  $("btn-landscape").classList.toggle("active", state.forceLandscape);
  if (state.forceLandscape && fullscreenElement()) await lockOrientation(true);
  else unlockOrientation();
  syncRotation();
}

/// 方向锁不可用时 CSS 旋转兜底（竖屏+强制横屏+全屏）
function syncRotation() {
  const portrait = window.innerHeight > window.innerWidth;
  const fs = !!(fullscreenElement() || state.cssFullscreen);
  $("stage").classList.toggle("rotated", state.forceLandscape && portrait && fs);
  paperSize();
}

function syncFullscreenUi() {
  const fs = !!(fullscreenElement() || state.cssFullscreen);
  document.body.classList.toggle("fs", fs);
  $("btn-fullscreen").querySelector(".ic-expand").classList.toggle("hidden", fs);
  $("btn-fullscreen").querySelector(".ic-compress").classList.toggle("hidden", !fs);
  if (!fs && state.forceLandscape) {
    state.forceLandscape = false;
    $("btn-landscape").classList.remove("active");
    unlockOrientation();
  }
  state.localAspect = localAspect();
  send({ t: "aspect", a: state.localAspect });
  syncRotation();
}

// ================================================================ 头部

function wireHeader() {
  // v3：图标连点 7 次唤起隐藏浮窗（内容管理页可编辑）
  setupSecretTap($("page-icon"));
  $("btn-hall").addEventListener("click", () => (location.href = "/hall"));
  mountAvatar($("btn-me"), store.avatar);
  // v3.26 E8：火焰头像框不再进房即燃——等服务端判定"双方均在房满 5 分钟"
  // 后经 welcome.flame / flame 帧点燃（见 setFlameReady）
  $("btn-me").addEventListener("click", () => (location.href = "/me"));

  $("invite-code").textContent = store.roomCode;
  $("invite-chip").classList.remove("hidden");
  $("invite-chip").addEventListener("click", () => copyText(store.roomCode));

  // 等待徽章缩小后的迷你挂饰：点一点复制邀请码
  $("partner-mini")?.addEventListener("click", () => copyText(store.roomCode));

  $("theme-popup").addEventListener("click", (e) => {
    if (e.target === $("theme-popup")) $("theme-popup").classList.add("hidden");
  });
}

// ================================================================ 启动

async function boot() {
  if (!guard()) return;
  mountIcons();
  hideLoading();

  await refreshMe(); // 解锁列表以服务端为准
  await loadThemes();

  pad = new InkPad(inkCanvas);
  // v4.1 #16：重放抗误抹钩子——重放进行中任何外部 redraw（换信纸/擦除/撤销）
  // 都会清掉画到一半的动画笔画；置标记后由重放帧循环把已推进段补画回来
  {
    const _origRedraw = pad.redraw.bind(pad);
    pad.redraw = () => { _origRedraw(); if (state.replaying) state.replayDirty = true; };
  }
  fx = new InkFx($("fx-canvas"));
  const cfg = window.__plConfig || {};
  pad.minW = cfg.pressureMinWidth || 0.6;
  pad.maxW = cfg.pressureMaxWidth || 2.4;
  pad.pressureCurve = cfg.penResponse === "linear" || cfg.penResponse === "quad" ? cfg.penResponse : "pow"; // v3.16 #33 笔锋响应曲线
  // v3.15 后台防抖平滑度；v4.62 前台可调：轻点平滑按钮开关、长按滑条调值，本机记忆
  pad._smoothVal = Math.min(0.8, Math.max(0.05, Number(localStorage.getItem("pl_smooth")) || Number(cfg.strokeSmoothness) || 0.35));
  pad.smooth = localStorage.getItem("pl_smooth_on") === "0" ? 0 : pad._smoothVal;
  pad.speedMinW = Math.min(3, Math.max(0.2, Number(cfg.speedMinWidth) || 0.8));    // v4.22 速度最细笔宽（快写趋近）
  pad.speedMaxW = Math.min(3, Math.max(0.2, Number(cfg.speedMaxWidth) || 2.0));    // v4.22 速度最粗笔宽（慢写趋近）
  pad.speedAll = cfg.speedFactorAll === true;                                      // v3.32 速度因子全局响应（管理页开关）
  pad.tipOn = localStorage.getItem("pl_tipOn") === "1";                              // v3.15 自动出锋状态记忆
  pad.tipN = Math.min(40, Math.max(2, Number(localStorage.getItem("pl_tipN")) || 8)); // v3.32 出锋灵敏度上限 24→40
  pad.strokeScale = Math.min(20, Math.max(0.5, Number(localStorage.getItem("pl_strokeScale")) || 1)); // v4.1 #22 笔迹粗细记忆；v4.65 上限 20x
  state.pendingLimit = cfg.pendingPageLimit || 3;

  if (hasEgg("E4")) document.body.classList.add("egg-E4");

  try {
    const room = await apiJson(`/api/room/${encodeURIComponent(store.roomCode)}`);
    state.room = room;
    store.roomName = room.name;
    document.title = `${truncName(room.name)} · PaperLink`; // v3.23 #27：渲染层统一截断
  } catch {
    if (store.token && store.sid) {
      store.roomCode = "";
      location.href = "/hall";
    }
    return;
  }

  // v4.42 白笺：墨色选择以房间记录优先（重连/换端一致），无记录用本房间本机记忆
  if (state.room && state.room.inkSel != null && validateInkSel(state.room.inkSel)) saveBlancSel(String(state.room.inkSel));
  else loadBlancSel();
  const theme = themeById(store.theme && themeUnlocked(themeById(store.theme)) ? store.theme : state.room.theme);
  applyTheme(theme, false);

  state.localAspect = localAspect();
  // v4.14：进房首次绘制按钮态走 "sync" —— 本地存档的模式只是上一次的残留，
  // 不该据此开启保护窗把随后 welcome/轮询带来的服务端权威模式挡在门外
  setMode(state.mode, false, "sync");
  syncModeButton();
  wireVoice(); // v4.50：实时语音（未解锁时按钮隐藏、链路不挂载）

  wirePad();
  wireWritingPing(); // v3.58 书写心跳（"TA 在写信"信号的寄信模式来源）
  wireToolbar();
  wireHeader();
  // v3.7：视口一键复位浮动按钮（轻点复位、可拖动挪位、位置记忆）
  mountResetViewButton($("btn-reset-view"), () => pad, {
    onReset: () => toast("视口已复位", 1200),
  });
  mountBlancInkButton(); // v4.42：白笺墨色按钮（拖动挪位 + 轻点弹 30 色墨盘）
  wireImmersive();       // v4.50：沉浸书写边缘唤回区
  mountThemeBarShrink(); // v3.17：主题栏 10 秒闲置收缩为可拖动小圆钮
  paperSize();
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("orientationchange", onViewportChange);
  window.visualViewport?.addEventListener("resize", onVisualViewportChange);

  // v3.23 #2：新信自动展开的"空闲判定"不再只看落笔——点工具栏、书信集、
  // 信纸栏等任何界面操作都算"在忙"，避免手正按在按钮上时被弹层抢走视线
  document.addEventListener("pointerdown", markInput, true);
  // v4.1 #A14：点弹层与所属按钮之外的任意处，自动收起滑条弹层
  // （此前只能 Esc / 再点一次按钮，点纸面后弹层一直悬着挡视线）
  document.addEventListener("pointerdown", (e) => {
    if (e.target.closest?.("#eraser-pop, #tip-pop, #width-pop, #smooth-pop, #btn-eraser, #btn-tip, #btn-width, #btn-smooth")) return;
    for (const pid of ["eraser-pop", "tip-pop", "width-pop", "smooth-pop"]) $(pid)?.classList.add("hidden");
  }, true);

  restoreDraftMaybe(); // v3.23 #20：恢复上次没寄出去的暂存页（如有）
  // v4.55：切后台/关页面时立刻把当前页刷进实时草稿——pagehide 覆盖 bfcache
  // 与手机切后台被杀进程的场景，visibilitychange 兜住仅切后台不关页的情况
  window.addEventListener("pagehide", autosaveDraftNow);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") autosaveDraftNow(); });
  // v4.25 页栈初始化：当前纸面即第 1 页（草稿恢复之后）
  state.sheets = [{ strokes: pad.strokes, remote: state.remoteIds, seen: state.seenStrokes }];
  state.sheetIdx = 0;
  renderPager();

  mountAmbientRain();      // v3.16 #1 主题氛围字符雨（跟随信纸主题）
  armDripSound();          // v3.16 #28 墨滴音效（用户首次交互后解锁）
  mountGlassHighlight();   // v3.16 #29 毛玻璃卡片高光跟随光标（仅精确指针）
  // v3.18 天气彩蛋：首次会弹 GDPR 确认；减少动态效果偏好下不启用。
  // 房内每 120 分钟续查一次（缓存命中时查询直接跳过，不刷额度）
  if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    maybeStartWeather();
    setInterval(maybeStartWeather, WEATHER_POLL_MS);
    wireWeatherImmersive(); // v4.43：闲置 8 秒进天气沉浸（信纸变淡 + 全屏天气增幅）
  }

  renderPartnerBadge();
  connectWs();
  loadFavs(); // v3.65：先读本机收藏，再拉书信集（渲染时按收藏点亮星星）
  loadLetters();
  updateBadge();

  // 3 秒全局轮询（收信延迟 / 在线状态 / 待读计数）
  clearInterval(state.liveTimer);
  state.liveTimer = setInterval(pollLive, 3000);

  $("btn-letters").addEventListener("click", () => { maybeAskNotifyPermission(); openLetterDrawer(); }); // v4.56：首次点书信集顺势申请一次通知权限
  $("drawer-close").addEventListener("click", closeLetterDrawer);
  // v3.67 只看收藏：开关即时生效，文案随手势翻转
  // v4.1 #44：星标改内联 SVG（排除 Unicode 字符图标，跨平台渲染一致）
  const syncFavFilterBtn = () => {
    const btn = $("drawer-fav-filter");
    btn.classList.toggle("on", state.favFilter);
    btn.innerHTML = `${icon(state.favFilter ? "starFill" : "star", 14)}<span>${state.favFilter ? "看全部信" : "只看收藏"}</span>`;
  };
  $("drawer-fav-filter").addEventListener("click", () => {
    state.favFilter = !state.favFilter;
    syncFavFilterBtn();
    renderLetters();
  });
  syncFavFilterBtn();
  // v4.57 信件导出：头部「导出」进选择模式 → 点卡片勾选 → 拼一张竖长图分享/下载
  $("drawer-export")?.addEventListener("click", () => setLetterSelecting(!state.letterSelecting));
  $("lexport-cancel")?.addEventListener("click", () => setLetterSelecting(false));
  $("lexport-all")?.addEventListener("click", () => {
    const shown = state.favFilter ? state.letters.filter((p) => state.favs.has(p.pid)) : state.letters;
    const allOn = shown.length > 0 && shown.every((p) => state.letterSelected.has(p.pid));
    state.letterSelected = allOn ? new Set() : new Set(shown.map((p) => p.pid));
    renderLetters();
    updateExportBar();
  });
  $("lexport-go")?.addEventListener("click", () => exportSelectedLetters("png"));
  $("lexport-pdf")?.addEventListener("click", () => exportSelectedLetters("pdf")); // v4.60
  wireLetterStack(); // v3.50 信纸堆叠（偏好减少动态时自动跳过）
  $("overlay-close").addEventListener("click", closeLetterOverlay);
  // v3.70 连读翻信：上一封 / 下一封
  $("overlay-prev").addEventListener("click", () => stepLetter(-1));
  $("overlay-next").addEventListener("click", () => stepLetter(1));
  $("overlay-pause").addEventListener("click", toggleOverlayPause);
  wireOverlayTapPause(); // v3.81：轻点信纸也能暂停/继续（手机上比够小按钮省事）
  wireOverlaySwipe(); // v3.82：信纸上左右滑 = 翻上一封/下一封
  wireFsScrollLock(); // v3.98：全屏/看信时拦根滚动，iOS 下滑不再带起回弹
  // v3.83：手一碰上重放层，手势提示就识趣退场（没提示时是空操作）
  $("letter-overlay").addEventListener("pointerdown", ovGestureTipHide);
  // v4.60：重放进度条可拖——按下即跳、拖动连续擦、松手把新断点记进浏览器缓存
  const pbar = document.querySelector(".overlay-progress");
  if (pbar) {
    const seekEv = (e) => {
      const r = pbar.getBoundingClientRect();
      if (!r.width || !ov) return;
      ovSeekFrac((e.clientX - r.left) / r.width);
    };
    pbar.addEventListener("pointerdown", (e) => {
      if (!ov) return;
      e.preventDefault();
      e.stopPropagation();
      try { pbar.setPointerCapture(e.pointerId); } catch { /* ok */ }
      pbar.classList.add("drag");
      seekEv(e);
      const move = (ev) => seekEv(ev);
      const up = () => {
        pbar.classList.remove("drag");
        pbar.removeEventListener("pointermove", move);
        pbar.removeEventListener("pointerup", up);
        pbar.removeEventListener("pointercancel", up);
        if (ov && !ov.done) ovProgSave(); // 松手记断点（下次开信从这续）
      };
      pbar.addEventListener("pointermove", move);
      pbar.addEventListener("pointerup", up);
      pbar.addEventListener("pointercancel", up);
    });
  }
  // v3.89：在线绿点心跳（徽章与迷你挂饰各一份，减少动态偏好自动跳过）
  mountDotPulse($("partner-badge"));
  mountDotPulse($("partner-mini"));
  // v3.91：寄出栏毛玻璃下的流动液体层（减少动态偏好不启动）
  if (!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) {
    new FluidGlass($("send-bar-fluid"), { alpha: 0.2 }).start();
  }
  $("overlay-replay").addEventListener("click", ovRestart);
  // v3.76：循环播放开关——状态记在本机，按钮亮起即开（v3.78：快捷键 L 同款）
  $("overlay-loop").addEventListener("click", toggleOverlayLoop);
  ovUpdateLoopBtn();
  // v4.64：倍速轻点弹选择条（预设一点即定 / 滑条与数字输入自定义），不再循环切档
  $("overlay-speed").addEventListener("click", () => {
    const pop = $("ov-speed-pop");
    pop.classList.toggle("hidden");
    ovUpdateSpeedLabel();
  });
  $("ov-speed-pop")?.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-sp]");
    if (!chip) return;
    ovSetSpeed(Number(chip.dataset.sp));
    $("ov-speed-pop").classList.add("hidden");
  });
  $("ov-speed-range")?.addEventListener("input", (e) => ovSetSpeed(Number(e.target.value)));
  $("ov-speed-num")?.addEventListener("change", (e) => ovSetSpeed(Number(e.target.value)));
  $("banner-view").addEventListener("click", () => {
    $("new-letter-banner").classList.add("hidden");
    state.bannerCount = 0;
    openLetterDrawer();
  });

  wireKeyboardShortcuts(); // v3.66：Esc 逐层收弹层、Ctrl/⌘+Enter 快捷寄信
}

boot();
