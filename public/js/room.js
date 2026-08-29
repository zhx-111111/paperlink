// PaperLink — 书写房主控 v2：WS 实时通讯、双模式、同速重放（全屏播放）、
// 书信集、riddle 式同心圆主题栏（只显示拥有的）、横竖屏镜像、3 秒轮询、
// 翻页镜像、长按橡皮调大小、多端全屏降级。

import { InkPad, roundSharpCorners, strokeSegment } from "./inkpad.js";
import { InkFx } from "./fx.js";
import { inkBurst, inkBlaze, complement, GlyphRain, RainDrops, WeatherAmbience, mountAvatarFlame } from "./canvasui.js";
import { CuDroplets } from "./canvasui-cu.js"; // v3.23：canvas-ui 雨滴组件（WebGL2 可用时接管小雨）
import {
  store, api, apiJson, toast, relTime, hideLoading, refreshMe,
  mountAvatar, avatarSvg, loadThemes, getThemes, themeById, themeUnlocked,
  applyThemeToPaper, themeThumbCss, copyText, mountIcons, icon, hasEgg,
  setupSecretTap, blurText, mountResetViewButton, positionPopByButton,
  themeVeil, armDripSound, mountGlassHighlight, confirmDialog,
  livePointerCount, trackActivePointers, truncName, I18N,
  UA, fullscreenElement, enterFullscreen, exitFullscreen, onFullscreenChange,
  lockOrientation, unlockOrientation,
} from "./shared.js";

const $ = (id) => document.getElementById(id);

const VW = 1000, VH = 1360;
const PORTRAIT = VW / VH;
const LANDSCAPE = VH / VW;

const state = {
  room: null,
  mode: store.mode,
  ws: null,
  wsRetry: 0,
  partner: null,
  partnerOnline: false,
  unread: 0,
  pending: 0,
  pendingLimit: 3,
  letters: [],
  lettersTotal: 0,      // v3.11：书信集分页总数
  lettersLoading: false,
  bannerCount: 0,
  bannerTimer: 0,
  lastInput: Date.now(),
  writing: false,
  localAspect: PORTRAIT,
  remoteAspect: null,
  remoteAspectTimer: 0,
  liveChunks: new Map(),
  strokeParts: new Map(), // v3.23 #6：长笔画分片累积（id → {total, meta, parts}）
  remoteIds: new Set(),
  replayQueue: [],
  replaying: false,
  cursorAcc: 0,
  liveAcc: 0,
  pingTimer: 0,
  liveTimer: 0,
  sending: false,
  cssFullscreen: false,   // 原生全屏不可用时的 CSS 兜底
  forceLandscape: false,  // 全屏内强制横屏（不支持方向锁时 CSS 旋转兜底）
  eraserHold: 0,
  outQueue: [],           // v3.16 #67：断线期间暂存的关键事件，重连后补发
  flameOn: false,         // v3.26 E8：服务端判定"双方均在房满 5 分钟"后为 true
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
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  pad.resize(w, h, dpr);
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

function applyTheme(theme, broadcast = false) {
  themeVeil(paper); // v3.16 #22：毛玻璃过渡层盖 300ms，避免信纸硬切换
  const ink = applyThemeToPaper(paper, theme);
  pad.setColor(ink);
  fx?.setInk(ink);
  store.theme = theme.id;
  syncAmbientRain(); // v3.16 #1：氛围字符雨跟随信纸主题
  syncWeatherInk();  // v3.18：雨色跟随信纸墨色
  syncFlameTheme(theme); // v3.25 E8：火焰头像框配色跟随信纸主题
  renderThemeBar();
  if (broadcast) send({ t: "theme_change", theme: theme.id });
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
    b.style.setProperty("--sw-ink", t.custom ? (t.inkColor || t.ink) : t.ink);
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
  const ink = t ? (t.custom && t.inkColor ? t.inkColor : t.ink) : "#2b3550";
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

function applyWeatherFx(d) {
  if (!d || !d.ok || d.mode === "none") return;
  const cv = $("weather-canvas");
  if (!cv) return;
  const wet = d.mode === "rain" || d.mode === "heavy" || d.mode === "snow";
  if (wet) {
    if (weatherAmb) { weatherAmb.stop(); weatherAmb = null; }
    // v3.23：小雨优先交给 canvas-ui Droplets（玻璃质感更精良）；
    // 大雨保留自研层——它有闪电联动，雪则组件本身不支持
    if (d.mode === "rain" && !weatherCuDead) {
      if (!weatherCu) {
        weatherCu = new CuDroplets(cv);
        if (!weatherCu.ok) { weatherCu.stop(); weatherCu = null; weatherCuDead = true; }
      }
      if (weatherCu) {
        if (weatherFx) { weatherFx.stop(); weatherFx = null; }
        weatherCu.setMode("rain");
        syncWeatherInk("rain");
        weatherCu.start();
        return;
      }
    }
    if (weatherCu) { weatherCu.stop(); weatherCu = null; }
    if (!weatherFx) weatherFx = new RainDrops(cv, { alpha: 0.16, onFlash: flashPaperEdge });
    weatherFx.setMode(d.mode === "heavy" ? "heavy" : d.mode === "snow" ? "snow" : "rain");
    syncWeatherInk(d.mode);
    weatherFx.start();
  } else { // fog | aurora
    if (weatherFx) { weatherFx.stop(); weatherFx = null; }
    if (weatherCu) { weatherCu.stop(); weatherCu = null; }
    if (!weatherAmb) weatherAmb = new WeatherAmbience(cv);
    weatherAmb.setMode(d.mode);
    weatherAmb.start();
  }
}

/// 雨色跟随信纸墨色（雪固定白）；换信纸时由 applyTheme 同步调用
function syncWeatherInk(mode) {
  const activeMode = mode || weatherFx?.mode || weatherCu?.mode;
  if (activeMode === "snow") return;
  const t = themeById(store.theme);
  if (!t) return;
  weatherFx?.setColor(t.ink);
  weatherCu?.setColor(t.ink);
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
        <div class="consent-emoji" aria-hidden="true">🌧️</div>
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
    const ink = t.custom && t.inkColor ? t.inkColor : t.ink;
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

// ================================================================ WS

/// #67 关键事件（笔画/翻页/擦除等结果态）在短暂断线时入队，重连后补发，
/// 避免"快速连点/网络抖动丢笔迹"；高频过程态（光标/逐点流）不排队
const QUEUEABLE = new Set(["stroke", "page_turn", "erase_at", "undo", "clear_all", "aspect", "theme_change", "mode_change"]);

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
    send({ t: "hello", token: store.token, nick: store.nick, avatar: store.avatar, mode: state.mode,
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
    // #68 指数退避 + 随机抖动：避免多客户端同步重连雪崩
    const base = Math.min(4800, 800 * state.wsRetry);
    setTimeout(connectWs, base * (0.7 + Math.random() * 0.6));
  };
}

function handleWsEvent(ev) {
  switch (ev.t) {
    case "welcome":
      updatePresence(ev.peers || []);
      if (ev.mode && ev.mode !== state.mode) setMode(ev.mode, false);
      setFlameReady(ev.flame === true); // v3.26 E8：同步服务端火焰条件（重连自动校准）
      // v3.23 #10 竞态防护：welcome 是鉴权通过的凭证——此刻才补发
      // 横竖屏比例与断线期间攒下的关键事件，确保服务端不会再丢弃它们
      if (!state.wsAuthed) {
        state.wsAuthed = true;
        send({ t: "aspect", a: state.localAspect });
        const q = state.outQueue.splice(0);
        for (const obj of q) send(obj);
      }
      break;
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
      state.liveChunks.delete(ev.id);
      pad.redraw();
      break;
    case "stroke": onPartnerStroke(ev); break;
    case "stroke_part": onStrokePart(ev); break; // v3.23 #6：长笔画分片
    case "erase_at": onPartnerErase(ev); break;
    case "undo": onPartnerUndo(ev); break;
    case "clear_all": onPartnerClear(); break;
    case "page_turn": onPartnerPageTurn(); break;
    case "offline_page": onOfflinePage(ev); break; // v3.10 离线补齐
    case "theme_change":
      applyForcedTheme(ev.theme);
      toast("对方换了信纸，已为你同步", 1600);
      break;
    case "mode_change":
      if (ev.mode === "realtime" || ev.mode === "letter") setMode(ev.mode, false);
      if (ev.mode === "letter" && ev.reason === "rt_idle") toast("离开超过 10 分钟，已自动退出实时镜像", 3200);
      break;
    case "mode_denied":
      setMode("letter", false);
      toast("实时镜像需用兑换码解锁", 3200);
      break;
    case "cursor": onPartnerCursor(ev); break;
    case "nick_update":
      if (state.partner) { state.partner.nick = ev.nick; renderPartnerBadge(); }
      break;
    case "avatar_update":
      if (state.partner) { state.partner.avatar = ev.avatar; renderPartnerBadge(); }
      break;
    case "new_page": onNewPage(ev.page, ev.pending, ev.limit); break;
    case "read_ack": {
      state.pending = 0;
      updateSendBar();
      toast("TA 在读你的信", 1500);
      // v3.16 #16 对方开信时刻的小仪式：在线徽章下一团短促墨焰
      const bb = $("partner-badge")?.getBoundingClientRect();
      if (bb && bb.width) inkBlaze($("blaze-canvas"), bb.left + bb.width / 2, bb.top + bb.height, {});
      break;
    }
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
        state.pending = d.unreadTheirs;
        updateSendBar();
      }
    }
    if (typeof d.unreadMine === "number" && d.unreadMine !== state.unread) {
      state.unread = d.unreadMine;
      updateBadge();
    }
    // 兑换「畅寄五十页」后服务端即时放宽上限
    if (typeof d.pendingLimit === "number" && d.pendingLimit !== state.pendingLimit) {
      state.pendingLimit = d.pendingLimit;
      updateSendBar();
    }
    if (d.mode && d.mode !== state.mode) setMode(d.mode, false);
    renderPartnerBadge();
  } catch { /* 401 等由 api 层处理 */ }
}

// ---------------------------------------------------------------- presence

function updatePresence(peers) {
  const p = peers.find((x) => x.sid !== store.sid) || null;
  state.partner = p;
  state.partnerOnline = !!p;
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

function wirePad() {
  pad.onStrokeEnd = (stroke) => {
    markInput();
    if (state.mode === "realtime") {
      // v3.8：收尾前把缓冲里没发完的逐点流冲出去，对方先看到完整实时轨迹
      if (state.liveBuf) {
        for (const [sid, ptsArr] of state.liveBuf) {
          if (ptsArr.length) {
            send({ t: "drawing", id: sid, pts: ptsArr.map(([x, y, p, t]) => [Math.round(x / pad.w * VW), Math.round(y / pad.h * VH), Math.round(p * 100) / 100, t]), color: currentInk(), a: effectiveAspect(), ps: pad.penScale });
          }
        }
        state.liveBuf.clear();
      }
      // np/tip：无压感速度因子与自动出锋标记随笔画同步，对端重放同算法还原；
      // v3.23 #6：长笔画自动按 200 点/片分帧
      sendStrokeRealtime(stroke);
    }
    updateSendBar();
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
    const gap = cfg.cursorSyncIntervalMs || 200;
    if (nowT - state.liveAcc < gap) return;
    state.liveAcc = nowT;
    for (const [sid, ptsArr] of state.liveBuf) {
      if (ptsArr.length) {
        send({ t: "drawing", id: sid, pts: ptsArr.map(([x, y, p, t]) => [Math.round(x / pad.w * VW), Math.round(y / pad.h * VH), Math.round(p * 100) / 100, t]), color: currentInk(), a: effectiveAspect(), ps: pad.penScale });
      }
    }
    state.liveBuf.clear();
  };
  pad.onEraseAt = (x, y, r) => {
    send({ t: "erase_at", x: x / pad.w * VW, y: y / pad.h * VH, r: r / pad.w * VW });
  };
  // v3.6 多指手势（双指橡皮/三指视口）打断了进行中的笔画 → 通知对端丢弃半截轨迹，两端保持一致
  pad.onGestureStart = (cancelledId) => {
    if (state.mode === "realtime" && cancelledId != null) send({ t: "live_cancel", id: cancelledId });
  };

  inkCanvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
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
    if (act === "erase2") showTwoEraseRing();
    if (act === "draw") {
      const pos = pad.toLocal(e);
      fx?.splash(pos.x, pos.y, 0.5 + (e.pressure || 0.5) * 0.7);
    }
  });
  inkCanvas.addEventListener("pointermove", (e) => {
    e.preventDefault();
    if (pad.erasing) showEraserRing(e);
    pad.pointerMove(e);
    if (pad.twoErasing()) showTwoEraseRing(); // 双指橡皮：圈跟两指中点、大小跟指距
    const cfg = window.__plConfig || {};
    const gap = cfg.cursorSyncIntervalMs || 200;
    const nowT = performance.now();
    if (state.partnerOnline && nowT - state.cursorAcc > gap) {
      state.cursorAcc = nowT;
      const pos = pad.toLocal(e);
      send({ t: "cursor", x: pos.x / pad.w, y: pos.y / pad.h });
    }
  });
  inkCanvas.addEventListener("pointerup", up);
  inkCanvas.addEventListener("pointercancel", up);
  inkCanvas.addEventListener("contextmenu", (e) => e.preventDefault());

  function up(e) {
    // v3.16 #14：抬笔瞬间一圈更轻的收笔涟漪（仅书写中，擦除/手势不触发）
    const wasDrawing = !!pad.current;
    const pos = pad.toLocal(e);
    pad.pointerUp(e);
    if (wasDrawing) fx?.lift(pos.x, pos.y);
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
  return pts.map(([x, y, p, t]) => [
    quant(x / pad.w),
    quant(y / pad.h, VH),
    p, t,
  ]);
}

/// v3.23 #6：长笔画分片发送——单笔超过 200 点时按 200 点/片拆成多帧
/// （stroke_part），接收端凑齐后按完整笔画处理；短笔画仍走单帧 stroke。
/// 目的：单帧过大容易触碰消息上限/卡顿，且失败时不必整笔重来。
const STROKE_CHUNK = 200;
function sendStrokeRealtime(stroke) {
  const pts = normPts(stroke.pts);
  const meta = { id: stroke.id, color: currentInk(), durationMs: stroke.durationMs,
    a: effectiveAspect(), ps: pad.penScale, np: stroke.np ?? 1,
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
  document.body.classList.toggle("writing", on);
}
function markInput() { state.lastInput = Date.now(); }

// ================================================================ 重放

function onPartnerStroke(ev) {
  if (ev.a && Math.abs(ev.a - effectiveAspect()) > 0.05) applyRemoteAspect(ev.a);
  state.liveChunks.delete(ev.id);
  pad.redraw();
  // v3.16 #47：整笔到达不再点首点涟漪——逐点流与整笔两条路径叠加会重复涟漪，
  // "TA 在写"的呼吸感交给对端光标涟漪（whisper 独立队列）
  enqueueReplay({ id: ev.id, pts: ev.pts, durationMs: ev.durationMs, color: ev.color, ps: ev.ps, np: ev.np, tip: ev.tip });
  markInput();
}

/// 宽度换算：对端笔宽按对方 penScale 计算，本端按本地比例折算，两端笔迹一致
function remoteW(ev, p) {
  // 逐点流不带时间戳，无法算速度因子，按静止运笔（wf=1）取宽
  const w = pad.widthFor({ x: 0, y: 0, t: 0, p: p || 0.5 }, null);
  const ps = Number(ev?.ps) || 0;
  return ps > 0 && pad.penScale > 0 ? w * (ps / pad.penScale) : w;
}

function onLiveDrawing(ev) {
  if (ev.a && Math.abs(ev.a - effectiveAspect()) > 0.05) applyRemoteAspect(ev.a);
  const pts = (ev.pts || []).map(([x, y, p]) => ({
    x: x / VW * pad.w, y: y / VH * pad.h, p, w: remoteW(ev, p),
  }));
  if (!pts.length) return;
  const ctx = pad.ctx;
  ctx.save();
  ctx.globalAlpha = 0.97;
  ctx.strokeStyle = ev.color; ctx.fillStyle = ev.color;
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  // 保留上一帧尾点，用与本地书写一致的二次曲线续画，避免折线感
  let hist = state.liveChunks.get(ev.id) || [];
  const seq = [...hist, ...pts];
  if (seq.length === 1) {
    ctx.beginPath();
    ctx.arc(seq[0].x, seq[0].y, seq[0].w / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    state.liveChunks.set(ev.id, seq);
    return;
  }
  for (let i = Math.max(1, hist.length - 1); i < seq.length; i++) {
    // v3.16 #46：从上一帧尾段接缝处起画（多重绘一段已画曲线）——
    // 急转弯处接缝能用上二次曲线平滑，帧间隔大时不丢线段；
    // 每段最多被重绘两次，沿迹均匀，不会产生局部加深
    const a = seq[i - 1], b = seq[i];
    const c = seq[i + 1];
    ctx.beginPath();
    if (c) {
      ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
      ctx.quadraticCurveTo(b.x, b.y, (b.x + c.x) / 2, (b.y + c.y) / 2);
      ctx.lineWidth = b.w;
    } else if (i === 1 && seq.length === 2) {
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineWidth = (a.w + b.w) / 2;
    } else {
      ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
      ctx.lineTo(b.x, b.y);
      ctx.lineWidth = b.w;
    }
    ctx.stroke();
  }
  ctx.restore();
  state.liveChunks.set(ev.id, seq.slice(-3)); // #46 多留一个尾点，接缝更稳
}

function enqueueReplay(item) {
  state.replayQueue.push(item);
  if (!state.replaying) nextReplay();
}

/// #51 两笔之间留 120ms 自然停顿（重放不"一笔接一笔挤在一起"）
const REPLAY_STROKE_GAP_MS = 120;

function nextReplay() {
  clearTimeout(state.replayTimer);
  const item = state.replayQueue.shift();
  if (!item) { state.replaying = false; return; }
  state.replaying = true;

  // v3.9：重放笔宽与落库重绘走同一套顺序算法（含速度因子与平滑），
  // 否则笔画播完落库的瞬间笔宽会跳变；对端 penScale 差异按比例折算。
  // v3.15：np/tip 随笔画携带——无压感速度因子与起收出锋同算法还原
  // v3.16 #36：渲染前过急转角圆角化，与本地书写同一几何
  const pts = roundSharpCorners(pad.widthsFor(item.pts.map(([x, y, p, t]) => ({
    x: x / VW * pad.w, y: y / VH * pad.h, p, t: t || 0,
  })), item.np !== 0, Number(item.tip) || 0));
  const ps = Number(item.ps) || 0;
  const ratio = ps > 0 && pad.penScale > 0 ? ps / pad.penScale : 1;
  if (ratio !== 1) for (const pt of pts) pt.w *= ratio;
  if (!pts.length) { nextReplay(); return; }
  const dur = Math.max(item.durationMs || pts[pts.length - 1].t || 1, 1);
  const start = performance.now();
  let idx = 0;
  const ctx = pad.ctx;

  const step = (nowT) => {
    const el = nowT - start;
    ctx.save();
    ctx.globalAlpha = 0.97;
    // #49 分段绘制与本地书写/信件重放共用 strokeSegment
    while (idx < pts.length - 1 && pts[idx + 1].t <= el) { strokeSegment(ctx, pts, idx, item.color); idx++; }
    if (idx === 0 && pts.length === 1) strokeSegment(ctx, pts, 0, item.color);
    ctx.restore();
    if (idx < pts.length - 1 && el < dur + 200) {
      requestAnimationFrame(step);
    } else {
      pad.addRemoteStroke({
        id: item.id,
        pts: item.pts.map(([x, y, p, t]) => [x / VW * pad.w, y / VH * pad.h, p, t]),
        durationMs: dur,
        np: item.np,
        tip: item.tip,
      }, item.color);
      state.remoteIds.add(item.id);
      pad.redraw();
      state.replayTimer = setTimeout(nextReplay, REPLAY_STROKE_GAP_MS); // #51 笔间停顿
    }
  };
  requestAnimationFrame(step);
}

function onPartnerErase(ev) {
  const r = ev.r != null ? ev.r / VW * pad.w : 18;
  pad.eraseAt({ x: ev.x / VW * pad.w, y: ev.y / VH * pad.h }, r, true);
}

function onPartnerUndo(ev) {
  // v3.16 #45：对端撤销事件携带笔画 id 时按 id 精确移除（本地连快撤销时
  // 顺序可能错位）；匹配不到再走"最近一笔"容错与本地兜底
  if (ev?.id != null && state.remoteIds.has(ev.id)) {
    pad.removeStrokeById(ev.id);
    state.remoteIds.delete(ev.id);
    return;
  }
  if (!pad.removeLastOf(state.remoteIds)) pad.undo();
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
  // v3.23 #3：先快照本端墨迹——给 3 秒撤销窗口（撤销只恢复本端画面，
  // 不影响已清空的对方；不撤销则按原流程清掉）
  const snapshot = pad.hasInk() ? JSON.parse(JSON.stringify(pad.strokes)) : null;
  await pad.dissolve(800);
  pad.reset();
  state.remoteIds.clear();
  state.replayQueue = [];
  clearTimeout(state.replayTimer);
  state.replaying = false;
  if (snapshot && snapshot.length) {
    showUndoBanner("对方清空了这一页", () => {
      pad.strokes = snapshot;
      pad.redraw();
    });
  } else {
    toast("对方清空了这一页", 1500);
  }
}

/// v2：对方新开一页 → 本端同步翻到空白页
async function onPartnerPageTurn() {
  // v3.23 #4：本端还有未寄出的墨迹时，先问一句要不要把当前页寄出去再跟随翻页
  if (pad.hasInk() && !state.sending && state.mode === "letter") {
    if (confirmDialog("对方翻开了新的一页。你这边还有没寄出的内容，先把这一页寄出去吗？")) {
      await doSend();
    }
  }
  await pad.dissolve(500);
  pad.reset();
  state.remoteIds.clear();
  clearTimeout(state.replayTimer);
  state.replaying = false;
  updateSendBar();
  toast("对方翻开了新的一页", 1500);
}

/// v3.10 离线补齐：重连后一次性收到离线期间的缓存笔迹——直接渲染最终结果，
/// 不逐笔重播。落笔路径与实时镜像完全一致（不做对端笔宽折算）；清屏/翻页
/// 已在服务端折叠为重置。到达时机早于 welcome，此刻 pad 已就绪、画布为空，安全。
function onOfflinePage(ev) {
  if (state.mode !== "realtime") return;
  const ops = Array.isArray(ev.ops) ? ev.ops : [];
  if (!ops.length) return;
  const meta = ev.meta || {};
  if (meta.a) applyRemoteAspect(meta.a);
  if (meta.theme) applyForcedTheme(meta.theme);
  // 清掉本地残留的过程态（半截预览/未播完的重放），避免与补齐结果叠加
  state.liveChunks.clear();
  state.replayQueue = [];
  clearTimeout(state.replayTimer);
  state.replaying = false;
  // v3.28：离线补齐静默执行，不再弹「补了 N 笔」提示
  for (const op of ops) {
    switch (op?.k) {
      case "s": {
        const e = op.ev || {};
        pad.addRemoteStroke({
          id: e.id,
          pts: (e.pts || []).map(([x, y, p, t]) => [x / VW * pad.w, y / VH * pad.h, p, t]),
          durationMs: e.durationMs || 0,
          np: e.np,
          tip: e.tip,
        }, e.color);
        state.remoteIds.add(e.id);
        break;
      }
      case "e": onPartnerErase(op.ev || {}); break;
      case "u": onPartnerUndo(); break;
      case "c":
      case "p":
        pad.reset();
        state.remoteIds.clear();
        break;
    }
  }
  pad.redraw();
}

function onPartnerCursor(ev) {
  const el = $("partner-cursor");
  el.style.display = "block";
  // v3.16 #52：transform 位移替代 left/top——不再触发整页布局重排，
  // 配合 will-change:transform 走合成层（CSS 侧已调整）
  el.style.transform = `translate(${(ev.x * pad.w).toFixed(1)}px, ${(ev.y * pad.h).toFixed(1)}px)`;
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

function setMode(mode, broadcast = true) {
  const want = mode === "realtime" ? "realtime" : "letter";
  if (want === "realtime" && broadcast && !hasEgg("RT")) {
    toast("实时镜像需用兑换码解锁", 3000);
    return;
  }
  // v3.8 修「关闭失败」：远端同步（轮询/欢迎消息）不再推翻最近 5 秒内的本地切换——
  // 服务端模式写 KV 有延迟，轮询拿着旧值会把刚关掉的模式又打开
  if (!broadcast && state.modeLocalAt && performance.now() - state.modeLocalAt < 5000 && want !== state.mode) return;
  state.mode = want;
  store.mode = want;
  $("btn-mode").classList.toggle("active", want === "realtime");
  updateSendBar();
  if (broadcast) {
    send({ t: "mode_change", mode: want });
    state.modeLocalAt = performance.now();
  }
  if (want === "realtime") toast("实时镜像已开启（不保存信页）", 2600);
  else toast("已切回寄信模式：写满一页，点发送寄出", 2200);
}

/// v2：未解锁 RT 时整个模式按钮不显示
function syncModeButton() {
  const cfg = window.__plConfig || {};
  const allowed = cfg.realtimeAllowed !== false && hasEgg("RT");
  $("btn-mode").classList.toggle("hidden", !allowed);
  if (!allowed && state.mode === "realtime") setMode("letter", false);
}

// ================================================================ 发送栏

function updateSendBar() {
  const blocked = state.pending >= state.pendingLimit;
  const show = state.mode === "letter" && (pad.hasInk() || blocked) && !state.sending;
  $("send-bar").classList.toggle("hidden", !show);
  $("send-go").disabled = state.writing || state.sending || blocked || !pad.hasInk();
}

async function doSend() {
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
          pts: pageData.strokes.map((s) => {
            const p = normPts(s.pts);
            return (s.tip || s.np === 0) ? { p, ...(s.np === 0 ? { np: 0 } : {}), ...(s.tip ? { tip: s.tip } : {}) } : p;
          }),
          theme: store.theme || state.room?.theme || "parchment",
          ink: currentInk(),
          durationMs: pageData.durationMs,
          aspect: effectiveAspect(),
          nick: store.nick,
          avatar: store.avatar,
        },
      }),
    });
    pad.reset();
    try { sessionStorage.removeItem("pl_draft_" + store.roomCode); } catch { /* ok */ }
    state.pending = data.pending ?? state.pending + 1;
    state.pendingLocalAt = Date.now(); // v3.23 #1：5 秒内轮询旧值不得回退本地计数
    state.pendingLimit = data.limit ?? state.pendingLimit;
    // v3.16 #16 寄信成功的小仪式：发送按钮处一团短促墨焰
    const r = $("send-go").getBoundingClientRect();
    if (r.width) inkBlaze($("blaze-canvas"), r.left + r.width / 2, r.top, { palette: [currentInk(), "#8d72ff", "#ffb37a"] });
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

/// v3.23 #20：进房时检查上次没寄出去的暂存页，询问后恢复到纸面
function restoreDraftMaybe() {
  try {
    const key = "pl_draft_" + store.roomCode;
    const raw = sessionStorage.getItem(key);
    if (!raw) return;
    sessionStorage.removeItem(key);
    const d = JSON.parse(raw);
    if (!d?.page?.strokes?.length) return;
    if (Date.now() - (d.at || 0) > 24 * 3600e3) return; // 超过 24 小时的草稿不再恢复
    if (!confirmDialog("发现上次没寄出去的一页信，恢复到纸上吗？")) return;
    for (const s of d.page.strokes) pad.addRemoteStroke(s, s.color || currentInk());
    pad.redraw();
    updateSendBar();
    toast("草稿已恢复", 1500);
  } catch { /* 恢复失败静默，不影响进房 */ }
}

// ================================================================ 书信集

async function loadLetters(openDrawer = false) {
  try {
    const data = await apiJson(`/api/conversation/${encodeURIComponent(store.roomCode)}`);
    // v3.23 #14：服务端已按时间倒序（最新在前）返回，前端直接采用不再 reverse
    state.letters = data.pages || [];
    state.lettersTotal = data.total ?? state.letters.length; // v3.11：分页（默认只取最近 10 封）
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

function renderLetters() {
  const list = $("letter-list");
  list.innerHTML = "";
  if (!state.letters.length) {
    list.innerHTML = `<div class="drawer-empty">${I18N.lettersEmpty}</div>`;
    return;
  }
  for (const p of state.letters) { // v3.23 #14：已是倒序，直接渲染
    const t = themeById(p.theme);
    const item = document.createElement("div");
    item.className = "letter-item";
    const mine = p.author === store.sid;
    const thumbInk = t?.custom && t.inkColor ? t.inkColor : (t?.ink || "#43301c");
    // v2：不显示每页笔数
    item.innerHTML = `
      <div class="thumb" style="${themeThumbCss(t)}">${thumbStrokeSvg(p, thumbInk)}</div>
      <div class="meta">
        <div class="who"><span class="avatar" data-av="${p.authorAvatar}"></span>${escapeHtml(p.authorNick || (mine ? "我" : "TA"))}${mine ? "（我）" : ""}</div>
        <div class="when">${relTime(p.ts)}</div>
      </div>
      <span class="open-hint">打开此页</span>`;
    item.querySelector(".avatar").innerHTML = avatarSvg(p.authorAvatar || 0);
    item.addEventListener("click", () => openLetter(p));
    list.appendChild(item);
  }
  // v3.11：还有更早的信 → 列表尾部"加载更多"
  const total = state.lettersTotal || 0;
  if (total > state.letters.length) {
    const more = document.createElement("button");
    more.className = "letter-more";
    more.textContent = I18N.drawerLoadMore(total - state.letters.length);
    more.addEventListener("click", () => loadMoreLetters(more));
    list.appendChild(more);
  }
}

function openLetterDrawer() {
  loadLetters();
  $("letter-drawer").classList.add("open");
  if (state.unread) {
    state.unread = 0;
    updateBadge();
    api("/api/page/read", { method: "POST", body: JSON.stringify({ code: store.roomCode }) }).catch(() => {});
  }
}
function closeLetterDrawer() { $("letter-drawer").classList.remove("open"); }

function updateBadge() {
  const b = $("letter-badge");
  b.textContent = String(state.unread);
  b.classList.toggle("hidden", state.unread <= 0);
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
  if ($("letter-drawer").classList.contains("open")) renderLetters();

  const cfg = window.__plConfig || {};
  const idleMs = cfg.idleTimeoutMs || 2500;
  const isIdle = Date.now() - state.lastInput > idleMs && !pad.hasInk() && !state.writing;

  if (store.letterPref === "dot") return;
  if (store.letterPref === "auto" || isIdle) { openLetterDrawer(); return; }

  state.bannerCount++;
  $("banner-text").textContent = state.bannerCount > 1
    ? `对方寄来 ${state.bannerCount} 页新信`
    : `${page.authorNick || "TA"} 寄来一页新信`;
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

function openLetter(page) {
  closeLetterDrawer();
  const overlay = $("letter-overlay");
  const op = $("overlay-paper");
  const canvas = $("overlay-canvas");
  overlay.classList.remove("hidden");
  overlay.classList.add("fs-play"); // CSS 全屏播放层

  // v3.5：canvas-ui Celebrate/ParticleReveal 思路——开信一刻，墨粒自屏幕中心迸发升腾。
  // v3.16：#9 粒子在「信件墨色 / 品牌紫 / 互补色」间随机取色；
  // #11 落款解码动画改由粒子飞行中段（onMid）触发，视听节奏对齐
  const burstInk = page.ink && /^#[0-9a-f]{6}$/i.test(page.ink) ? page.ink : "#3a4a6b";
  const whoText = `${page.authorNick || "TA"} · ${relTime(page.ts)}`;
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
  const t = themeById(page.theme);
  applyThemeToPaper(op, t, page.ink || null);

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);

  mountAvatar($("overlay-avatar"), page.authorAvatar || 0);

  // 笔宽用与书写同款的顺序算法补算（含速度因子与平滑），重放手感还原。
  // v3.15：笔画兼容裸点数组（旧信）与 {p, np, tip} 对象（带压感/出锋标记）
  // v3.16 #36：渲染前过急转角圆角化，与书写端同一几何
  const strokes = (page.pts || []).map((s) => {
    const isObj = s && !Array.isArray(s) && Array.isArray(s.p);
    const rawPts = isObj ? s.p : s;
    const np = isObj ? s.np !== 0 : true;
    const tip = isObj ? (Number(s.tip) || 0) : 0;
    return roundSharpCorners(pad.widthsFor((rawPts || []).map(([x, y, p, tt]) => ({
      x: x / VW * w, y: y / VH * h, p, t: tt || 0,
    })), np, tip));
  });

  ov = {
    canvas, ctx: canvas.getContext("2d"), dpr, w, h,
    ink: page.ink || t.ink,
    pid: page.pid || "", // v3.30：进度记忆按信件 pid 存档
    strokes, si: 0, idx: 0,
    elapsed: 0, last: performance.now(),
    paused: false, done: false,
    lastProgSave: 0, // v3.30：节流写进度
    interGap: 0, // #51 两笔之间的自然停顿（毫秒）
    // v3.23 #18/#31：倍速与进度——durs 为每笔时长，totalDur 用于进度条
    durs: strokes.map((pts) => pts[pts.length - 1]?.t || 0),
    speedIdx: ovSpeedIdx,
  };
  ov.totalDur = ov.durs.reduce((s, d) => s + d, 0) || 1;
  ov.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // v3.30：续播——有上次断点且没播完：静默补画已播部分，从断点继续放
  const prog = ov.pid ? ovProgLoad()[ov.pid] : null;
  if (prog && (prog.si > 0 || prog.el > 0) && prog.si < strokes.length) {
    const ctx = ov.ctx;
    ctx.save();
    ctx.globalAlpha = 0.97;
    for (let s = 0; s < prog.si; s++) { // 已播完的笔：整笔补画
      const pts = strokes[s];
      if (pts.length === 1) strokeSegment(ctx, pts, 0, ov.ink);
      else for (let i = 0; i < pts.length - 1; i++) strokeSegment(ctx, pts, i, ov.ink);
    }
    const cur = strokes[prog.si]; // 断点那笔：只补到断点时刻
    let idx = 0;
    if (cur) {
      while (idx < cur.length - 1 && cur[idx + 1].t <= prog.el) { strokeSegment(ctx, cur, idx, ov.ink); idx++; }
      if (idx === 0 && cur.length === 1 && prog.el > 0) { strokeSegment(ctx, cur, 0, ov.ink); idx = 1; }
    }
    ctx.restore();
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
const OV_SPEEDS = [0.5, 1, 1.5, 2];
let ovSpeedIdx = 1; // 跨信件记忆当前档位
const ovSpeedFactor = () => OV_SPEEDS[ovSpeedIdx] * 0.9;

function ovUpdateSpeedLabel() {
  const btn = $("overlay-speed");
  if (btn) btn.textContent = OV_SPEEDS[ovSpeedIdx] + "x";
}

/// v3.23 #31：进度条（按播放时长占比）+ 「第 n/共 m 笔」计数
function ovProgressUi() {
  const fill = $("ov-progress-fill");
  const cnt = $("ov-count");
  if (!ov) { if (fill) fill.style.width = "0%"; if (cnt) cnt.textContent = ""; return; }
  let played = 0;
  for (let i = 0; i < ov.si; i++) played += ov.durs[i];
  if (ov.si < ov.strokes.length) played += Math.min(ov.elapsed, ov.durs[ov.si]);
  const frac = Math.max(0, Math.min(1, played / ov.totalDur));
  if (fill) fill.style.width = (frac * 100).toFixed(1) + "%";
  if (cnt) cnt.textContent = ov.done
    ? `${ov.strokes.length}/${ov.strokes.length} 笔`
    : `${Math.min(ov.si + 1, ov.strokes.length)}/${ov.strokes.length} 笔`;
}

/// #49 信件重放分段绘制：直接委托引擎的 strokeSegment（与书写/镜像同款几何）
function ovDrawSeg(pts, i, ctx, ink) {
  strokeSegment(ctx, pts, i, ink);
}

function ovStep(nowT) {
  ovRaf = 0;
  if (!ov || $("letter-overlay").classList.contains("hidden")) { ov = null; return; }
  const dt = nowT - ov.last;
  ov.last = nowT;
  // v3.23 #18：倍速系数（内部基准 0.9 倍）同时作用于笔画推进与笔间停顿
  const k = ovSpeedFactor();
  if (!ov.paused && !ov.done) ov.elapsed += dt * k;
  if (ov.interGap > 0) ov.interGap -= dt * k; // #51 笔间停顿倒计时
  // v3.30：播放中每 2 秒记一次进度（中途被杀进程/关页面也只丢 2 秒）
  if (!ov.paused && !ov.done && nowT - ov.lastProgSave > 2000) { ov.lastProgSave = nowT; ovProgSave(); }

  const pts = ov.strokes[ov.si];
  if (pts && !ov.paused && ov.interGap <= 0) {
    ov.ctx.save();
    ov.ctx.globalAlpha = 0.97;
    while (ov.idx < pts.length - 1 && pts[ov.idx + 1].t <= ov.elapsed) {
      ovDrawSeg(pts, ov.idx, ov.ctx, ov.ink);
      ov.idx++;
    }
    if (ov.idx === 0 && pts.length === 1 && ov.elapsed > 0) { ovDrawSeg(pts, 0, ov.ctx, ov.ink); ov.idx = 1; }
    ov.ctx.restore();
    if (ov.idx >= pts.length - 1) {
      ov.si++; ov.idx = 0;
      const prevLen = pts[pts.length - 1]?.t || 0;
      if (ov.elapsed > prevLen) { ov.elapsed = 0; ov.interGap = REPLAY_STROKE_GAP_MS; }
      if (ov.si >= ov.strokes.length) { ov.done = true; ovProgClear(ov.pid); } // v3.30：播完清断点
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

// ================================================================ 工具栏

function wireToolbar() {
  $("btn-next-page").addEventListener("click", async () => {
    await pad.dissolve(400);
    pad.reset();
    state.remoteIds.clear();
    updateSendBar();
    send({ t: "page_turn" }); // v2：翻页也镜像
    toast("新的一页", 1200);
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
      if (!pop.classList.contains("hidden")) positionPopByButton(pop, eraserBtn);
    }, 450);
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) {
    eraserBtn.addEventListener(ev, () => clearTimeout(state.eraserHold));
  }
  $("eraser-range").addEventListener("input", (e) => { pad.eraseR = Number(e.target.value) || 18; });

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
      if (!pop.classList.contains("hidden")) positionPopByButton(pop, tipBtn);
    }, 450);
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) {
    tipBtn.addEventListener(ev, () => clearTimeout(state.tipHold));
  }
  $("tip-range").addEventListener("input", (e) => {
    pad.tipN = Math.min(24, Math.max(2, Math.round(Number(e.target.value)) || 8));
    try { localStorage.setItem("pl_tipN", String(pad.tipN)); } catch { /* ok */ }
  });

  // v3.29：多步撤销——轻点撤一笔；长按 420ms 后连续撤（每 240ms 一笔，松手停）
  const undoBtn = $("btn-undo");
  const doUndo = () => {
    const id = pad.undo();
    if (id != null) send({ t: "undo", id });
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

  $("btn-clear").addEventListener("click", async () => {
    if (!pad.hasInk()) return;
    // v3：不再弹确认框，点即清空（对端同步清除）
    send({ t: "clear_all" });
    await pad.dissolve(800);
    pad.reset();
    state.remoteIds.clear();
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
    setMode(state.mode === "realtime" ? "letter" : "realtime", true);
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
    const d = await apiJson("/api/music/lrc?id=" + encodeURIComponent(t.id));
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

function wireMusic() {
  const cfg = window.__plConfig || {};
  // v3.9：音乐接入兑换码——总开关之外还须兑换过 MU 彩蛋（同 RT 的门槛模式）
  const allowed = cfg.musicAllowed !== false && hasEgg("MU");
  const btn = $("btn-music");
  if (!btn) return;
  btn.classList.toggle("hidden", !allowed);
  if (!allowed) return;

  btn.addEventListener("click", () => $("music-pop").classList.toggle("hidden"));
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
      item.addEventListener("click", () => playTrack(t));
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
  np.textContent = `加载中：${t.name}`;
  state.lastTrack = t; // v3.23 #47：记住当前曲目，播放被拦时可点一下重试
  try {
    // v3.5：搜索结果自带直链时直接播（部分实例二次取链反而 302 失败）
    let src = t.url || "";
    if (!src) {
      const d = await apiJson("/api/music/url?id=" + encodeURIComponent(t.id));
      src = d.url || "";
    }
    if (!src) { np.textContent = "这首歌暂无可用音源（可能需要会员），换一首试试"; return; }
    let audio = window.__plAudio;
    if (!audio) {
      audio = new Audio();
      audio.preload = "auto";
      audio.playsInline = true;
      window.__plAudio = audio;
      // v3.23 #47：iOS 锁屏/控制中心的播放操作接管
      if ("mediaSession" in navigator) {
        navigator.mediaSession.setActionHandler?.("play", () => audio.play().catch(() => {}));
        navigator.mediaSession.setActionHandler?.("pause", () => audio.pause());
      }
    }
    audio.src = src;
    audio.onerror = () => { stopLyrics(); np.textContent = "音源失效了，换一首或重新搜索试试"; };
    audio.play()
      .then(() => {
        startLyrics(t); // v3.9：真正开播才挂歌词同步
        // v3.23 #47：开播后把系统媒体面板的标题同步上
        if ("mediaSession" in navigator && window.MediaMetadata) {
          try { navigator.mediaSession.metadata = new MediaMetadata({ title: t.name, artist: t.artist || "" }); } catch { /* ok */ }
        }
      })
      .catch((e) => {
        // AbortError = 被切歌打断，属正常；其余说明自动播放被浏览器拦下
        // （iOS 上二次取链是异步的，点按手势可能已失效）——给出可点的重试
        if (e?.name !== "AbortError") {
          np.textContent = `▶ 播放被拦住了，点这里重试：${t.name}`;
          np.classList.add("retry");
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
  ring.style.width = ring.style.height = pad.eraseR * 2 + "px";
  ring.style.left = (e.clientX - r.left) + "px";
  ring.style.top = (e.clientY - r.top) + "px";
}

/// v3.6 双指橡皮圈：圆心=两指中点，直径=当前橡皮半径×2（随指距变化）
function showTwoEraseRing() {
  const ui = pad.twoFingerUi();
  if (!ui) return;
  const ring = $("eraser-ring");
  const r = paper.getBoundingClientRect();
  const cr = inkCanvas.getBoundingClientRect();
  ring.style.display = "block";
  ring.style.width = ring.style.height = ui.r * 2 + "px";
  ring.style.left = (cr.left - r.left + ui.x) + "px";
  ring.style.top = (cr.top - r.top + ui.y) + "px";
}

/// 全屏：原生 API（含 webkit 前缀）→ 失败时 CSS 全屏兜底（iOS 等）
async function toggleFullscreen() {
  if (fullscreenElement() || state.cssFullscreen) {
    state.cssFullscreen = false;
    state.forceLandscape = false;
    $("btn-landscape").classList.remove("active");
    unlockOrientation();
    await exitFullscreen();
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
  fx = new InkFx($("fx-canvas"));
  const cfg = window.__plConfig || {};
  pad.minW = cfg.pressureMinWidth || 0.6;
  pad.maxW = cfg.pressureMaxWidth || 2.4;
  pad.pressureCurve = cfg.penResponse === "linear" || cfg.penResponse === "quad" ? cfg.penResponse : "pow"; // v3.16 #33 笔锋响应曲线
  pad.smooth = Math.min(0.8, Math.max(0.1, Number(cfg.strokeSmoothness) || 0.35)); // v3.15 后台防抖平滑度
  pad.speedFactor = Math.min(0.5, Math.max(0, Number(cfg.speedFactor) || 0.18));   // v3.27 #6 速度因子强度
  pad.tipOn = localStorage.getItem("pl_tipOn") === "1";                              // v3.15 自动出锋状态记忆
  pad.tipN = Math.min(24, Math.max(2, Number(localStorage.getItem("pl_tipN")) || 8));
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

  const theme = themeById(store.theme && themeUnlocked(themeById(store.theme)) ? store.theme : state.room.theme);
  applyTheme(theme, false);

  state.localAspect = localAspect();
  setMode(state.mode, false);
  syncModeButton();

  wirePad();
  wireToolbar();
  wireHeader();
  // v3.7：视口一键复位浮动按钮（轻点复位、可拖动挪位、位置记忆）
  mountResetViewButton($("btn-reset-view"), () => pad, {
    onReset: () => toast("视口已复位", 1200),
  });
  mountThemeBarShrink(); // v3.17：主题栏 10 秒闲置收缩为可拖动小圆钮
  paperSize();
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("orientationchange", onViewportChange);
  window.visualViewport?.addEventListener("resize", onVisualViewportChange);

  // v3.23 #2：新信自动展开的"空闲判定"不再只看落笔——点工具栏、书信集、
  // 信纸栏等任何界面操作都算"在忙"，避免手正按在按钮上时被弹层抢走视线
  document.addEventListener("pointerdown", markInput, true);

  restoreDraftMaybe(); // v3.23 #20：恢复上次没寄出去的暂存页（如有）

  mountAmbientRain();      // v3.16 #1 主题氛围字符雨（跟随信纸主题）
  armDripSound();          // v3.16 #28 墨滴音效（用户首次交互后解锁）
  mountGlassHighlight();   // v3.16 #29 毛玻璃卡片高光跟随光标（仅精确指针）
  // v3.18 天气彩蛋：首次会弹 GDPR 确认；减少动态效果偏好下不启用。
  // 房内每 120 分钟续查一次（缓存命中时查询直接跳过，不刷额度）
  if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    maybeStartWeather();
    setInterval(maybeStartWeather, WEATHER_POLL_MS);
  }

  renderPartnerBadge();
  connectWs();
  loadLetters();
  updateBadge();

  // 3 秒全局轮询（收信延迟 / 在线状态 / 待读计数）
  clearInterval(state.liveTimer);
  state.liveTimer = setInterval(pollLive, 3000);

  $("btn-letters").addEventListener("click", openLetterDrawer);
  $("drawer-close").addEventListener("click", closeLetterDrawer);
  $("overlay-close").addEventListener("click", () => {
    ovProgSave(); // v3.30：关闭前记下断点（播完的会被 ovProgSave 自动清除）
    ov = null;
    cancelAnimationFrame(ovRaf); // #48 关闭重放层同时停帧
    ovRaf = 0;
    ovProgressUi(); // v3.23 #31：关掉重放层把进度条归零
    $("letter-overlay").classList.add("hidden");
  });
  $("overlay-pause").addEventListener("click", toggleOverlayPause);
  $("overlay-replay").addEventListener("click", ovRestart);
  // v3.23 #18：倍速循环切换（0.5x → 1x → 1.5x → 2x），正在播放的信件立即生效
  $("overlay-speed").addEventListener("click", () => {
    ovSpeedIdx = (ovSpeedIdx + 1) % OV_SPEEDS.length;
    ovUpdateSpeedLabel();
    if (ov && ov.paused) { ov.last = performance.now(); }
  });
  $("banner-view").addEventListener("click", () => {
    $("new-letter-banner").classList.add("hidden");
    state.bannerCount = 0;
    openLetterDrawer();
  });
}

boot();
