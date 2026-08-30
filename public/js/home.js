// PaperLink — /home 首页：体验书写板（仿 riddle）+ “?”唤起指南 + 可编辑页脚。

import { InkPad } from "./inkpad.js";
import { InkFx } from "./fx.js";
import { GlyphRain, RainDrops, WeatherAmbience, FluidGlass } from "./canvasui.js";
import { CuDroplets } from "./canvasui-cu.js"; // v3.86：小雨玻璃质感层（WebGL2 可用时接管小雨）
import { store, apiJson, hideLoading, mountAvatar, mountIcons, icon, setupSecretTap, mountResetViewButton, positionPopByButton, toast, armDripSound, mountAddToHomeGuide, haptic } from "./shared.js";

const $ = (id) => document.getElementById(id);

const DEFAULT_GUIDE = `
<h2>怎么玩 PaperLink</h2>
<ol>
  <li>在首页这块信纸上随便写写，感受压感笔迹；写一个大大的 <b>?</b> 会再次打开本指南。<b>手势</b>：一指书写；双指按住是橡皮擦（手指离得越远橡皮越大）；三指拖动移动纸面、三指并拢/张开缩小放大（和 iPhone 看图差不多）。缩放移动后，轻点屏幕边缘的浮动小按钮可一键复位画面（按钮可拖到你顺手的位置，会自动记住，也会自动避开其它控件）。</li>
  <li>点右上角「对话大厅」注册/登录，创建一本日记，把 9 位邀请码交给 TA。</li>
  <li>TA 用邀请码加入后，你们进入同一本日记：写满一页点「发送」，这一页会寄进对方书信集；TA 打开时会看到笔迹由无到有逐笔浮现。</li>
  <li>用兑换码可以解锁实时镜像与更多信纸。</li>
</ol>
<p>橡皮：点橡皮图标切换；长按橡皮可调大小。撤销：轻点撤一笔，长按连续撤。</p>`;

let pad;
let fx; // v3.1：纸面微反馈层（落笔墨波/墨点）
let eraserHold = 0;
let tipHold = 0; // v3.15 自动出锋按钮的长按计时（与橡皮长按互不干扰）
let homeRedoStack = []; // v3.53 重做栈（体验板本地：被撤销弹走的笔画等待放回）

function paperSize() {
  const stage = $("home-stage");
  const paper = $("home-paper");
  const sw = stage.clientWidth;
  // 布局图：红色书写板通栏竖长；整页可滚动，不再被视口高度压扁
  let w = Math.min(sw - 24, 760);
  let h = w * 1.36;
  paper.style.width = w + "px";
  paper.style.height = h + "px";
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  pad.resize(w, h, dpr);
  fx?.resize(w, h, dpr);
  pad.penScale = Math.max(0.75, Math.min(1.7, w / 700));
}

async function boot() {
  mountIcons();
  hideLoading();
  armDripSound(); // v3.16 #28 墨滴音效（用户首次交互后解锁）
  mountAddToHomeGuide(); // v3.23 #46/#57：iOS 首次访问引导添加到主屏（真全屏）

  let cfg = {};
  try { cfg = await (await fetch("/api/config")).json(); window.__plConfig = cfg; } catch { /* ok */ }

  // v3.5：canvas-ui GlyphRain 思路——字符墨雨氛围底（尊重减少动态效果设置）
  new GlyphRain($("home-ambient"), { alpha: 0.10, density: 18 }).start();
  // v3.97：首页玻璃底下也铺流体（减少动态偏好不启动）
  if (!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) {
    new FluidGlass($("home-fluid"), { alpha: 0.14 }).start();
  }
  // v3.86：天气彩蛋也落进首页——偏好与缓存和书写房/大厅共用（同一对本地键）
  maybeStartWeather();
  setInterval(maybeStartWeather, WEATHER_POLL_MS);

  pad = new InkPad($("home-canvas"));
  fx = new InkFx($("fx-canvas"));
  pad.minW = cfg.pressureMinWidth || 0.6;
  pad.maxW = cfg.pressureMaxWidth || 2.4;
  pad.pressureCurve = cfg.penResponse === "linear" || cfg.penResponse === "quad" ? cfg.penResponse : "pow"; // v3.16 #33 笔锋响应曲线
  pad.smooth = Math.min(0.8, Math.max(0.1, Number(cfg.strokeSmoothness) || 0.35)); // v3.15 后台防抖平滑度
  pad.speedFactor = Math.min(0.5, Math.max(0, Number(cfg.speedFactor) || 0.18));   // v3.27 #6 速度因子强度
  pad.speedAll = cfg.speedFactorAll === true;                                      // v3.32 速度因子全局响应（管理页开关）
  pad.tipOn = localStorage.getItem("pl_tipOn") === "1";                              // v3.15 自动出锋状态记忆
  pad.tipN = Math.min(40, Math.max(2, Number(localStorage.getItem("pl_tipN")) || 8)); // v3.32 出锋灵敏度上限 24→40

  // 页脚：管理页编辑、支持 HTML、自然文档流可无限延伸
  $("home-footer-content").innerHTML = cfg.footerHtml ||
    `<p>PaperLink —— 写一封信，等一个人。</p>`;

  // 指南内容（管理页可改）
  $("guide-content").innerHTML = cfg.guideHtml || DEFAULT_GUIDE;

  wirePad();
  wireTools();
  // v3.7：视口一键复位浮动按钮（轻点复位、可拖动挪位、位置记忆）
  mountResetViewButton($("btn-reset-view"), () => pad);
  wireHeader();

  paperSize();
  window.addEventListener("resize", paperSize);
  window.visualViewport?.addEventListener("resize", paperSize);
}

function wirePad() {
  const canvas = $("home-canvas");
  pad.onStrokeEnd = () => {
    homeRedoStack.length = 0; // v3.53：新笔画落定，重做历史作废
    // 写一个“?”→ 唤起指南（仿 riddle）
    if (pad.looksLikeQuestionMark()) {
      pad.dissolve(500);
      setTimeout(() => { pad.reset(); showGuide(); }, 480);
    }
  };
  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (pad.eraseTool) showEraserRing(e);
    const act = pad.pointerDown(e);
    if (act === "erase2") showTwoEraseRing();
    if (act === "draw") {
      const pos = pad.toLocal(e);
      fx?.splash(pos.x, pos.y, 0.5 + (e.pressure || 0.5) * 0.7);
      haptic(4); // v3.48 落笔一触（不支持的设备自动无感）
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    e.preventDefault();
    if (pad.erasing) showEraserRing(e);
    pad.pointerMove(e);
    if (pad.twoErasing()) showTwoEraseRing(); // 双指橡皮：圈跟两指中点、大小跟指距
  });
  const up = (e) => {
    const wasDrawing = !!pad.current;
    pad.pointerUp(e);
    if (wasDrawing) haptic(7); // v3.48 抬笔一收
    $("home-eraser-ring").style.display = "none";
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
}

function showEraserRing(e) {
  const ring = $("home-eraser-ring");
  const r = $("home-paper").getBoundingClientRect();
  ring.style.display = "block";
  ring.style.width = ring.style.height = pad.eraseR * 2 + "px";
  ring.style.left = (e.clientX - r.left) + "px";
  ring.style.top = (e.clientY - r.top) + "px";
}

/// v3.6 双指橡皮圈：圆心=两指中点，直径随指距实时变化
function showTwoEraseRing() {
  const ui = pad.twoFingerUi();
  if (!ui) return;
  const ring = $("home-eraser-ring");
  const r = $("home-paper").getBoundingClientRect();
  const cr = $("home-canvas").getBoundingClientRect();
  ring.style.display = "block";
  ring.style.width = ring.style.height = ui.r * 2 + "px";
  ring.style.left = (cr.left - r.left + ui.x) + "px";
  ring.style.top = (cr.top - r.top + ui.y) + "px";
}

function wireTools() {
  const eraserBtn = $("home-eraser");
  eraserBtn.addEventListener("click", () => {
    pad.eraseTool = !pad.eraseTool;
    eraserBtn.classList.toggle("active", pad.eraseTool);
    if (!pad.eraseTool) { $("home-eraser-ring").style.display = "none"; $("home-eraser-pop").classList.add("hidden"); }
  });
  // 长按橡皮 → 弹出大小滑条（v3.7：滑条贴在橡皮按钮旁，不再固定在页面底部）
  eraserBtn.addEventListener("pointerdown", () => {
    eraserHold = setTimeout(() => {
      const pop = $("home-eraser-pop");
      pop.classList.toggle("hidden");
      $("home-eraser-range").value = pad.eraseR;
      if (!pop.classList.contains("hidden")) positionPopByButton(pop, eraserBtn);
    }, 450);
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) {
    eraserBtn.addEventListener(ev, () => clearTimeout(eraserHold));
  }
  $("home-eraser-range").addEventListener("input", (e) => {
    pad.eraseR = Number(e.target.value) || 18;
  });

  // v3.29：多步撤销——轻点撤一笔；长按 420ms 后连续撤（每 240ms 一笔，松手停）
  // v3.53：每次撤销把弹走的笔画收进重做栈，Ctrl/Cmd+Shift+Z / Ctrl+Y 可放回
  const homeUndoBtn = $("home-undo");
  let homeUndoHold = 0, homeUndoRepeat = 0, homeUndoHeld = false;
  const homeUndoOnce = () => {
    const top = pad.strokes[pad.strokes.length - 1];
    pad.undo();
    if (top) homeRedoStack.push(top);
  };
  const homeRedoOnce = () => {
    const s = homeRedoStack.pop();
    if (!s) return;
    pad.strokes.push(s);
    pad._cacheOk = false;
    pad.redraw();
  };
  homeUndoBtn.addEventListener("pointerdown", () => {
    homeUndoHeld = false;
    clearTimeout(homeUndoHold);
    homeUndoHold = setTimeout(() => {
      homeUndoHeld = true;
      homeUndoOnce();
      homeUndoRepeat = setInterval(homeUndoOnce, 240);
    }, 420);
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) {
    homeUndoBtn.addEventListener(ev, () => {
      clearTimeout(homeUndoHold);
      clearInterval(homeUndoRepeat);
      homeUndoRepeat = 0;
    });
  }
  homeUndoBtn.addEventListener("click", () => {
    if (homeUndoHeld) { homeUndoHeld = false; return; }
    homeUndoOnce();
  });
  // v3.52/v3.53 键盘撤销/重做（体验板本地，无房间可同步）：
  // Ctrl/Cmd+Z 撤一笔；Ctrl/Cmd+Shift+Z 或 Ctrl+Y 放回。输入框原生快捷键不抢
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const isZ = e.key === "z" || e.key === "Z";
    const isY = e.key === "y" || e.key === "Y";
    if (isZ && !e.shiftKey) { e.preventDefault(); homeUndoOnce(); }
    else if ((isZ && e.shiftKey) || isY) { e.preventDefault(); homeRedoOnce(); }
  });
  $("home-clear").addEventListener("click", async () => {
    if (!pad.hasInk()) return;
    homeRedoStack.length = 0; // v3.53：清空 → 重做历史作废
    await pad.dissolve(600);
    pad.reset();
  });

  // v3.15 自动出锋：轻点开关（状态存浏览器缓存），长按调出锋长度
  const tipBtn = $("home-tip");
  tipBtn.classList.toggle("active", pad.tipOn);
  tipBtn.addEventListener("click", () => {
    pad.tipOn = !pad.tipOn;
    try { localStorage.setItem("pl_tipOn", pad.tipOn ? "1" : "0"); } catch { /* ok */ }
    tipBtn.classList.toggle("active", pad.tipOn);
    toast(pad.tipOn ? "自动出锋已打开" : "自动出锋已关闭");
    $("home-tip-pop").classList.add("hidden");
  });
  tipBtn.addEventListener("pointerdown", () => {
    tipHold = setTimeout(() => {
      const pop = $("home-tip-pop");
      pop.classList.toggle("hidden");
      $("home-tip-range").value = pad.tipN;
      if (!pop.classList.contains("hidden")) positionPopByButton(pop, tipBtn);
    }, 450);
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) {
    tipBtn.addEventListener(ev, () => clearTimeout(tipHold));
  }
  $("home-tip-range").addEventListener("input", (e) => {
    pad.tipN = Math.min(40, Math.max(2, Math.round(Number(e.target.value)) || 8));
    try { localStorage.setItem("pl_tipN", String(pad.tipN)); } catch { /* ok */ }
  });
}

function wireHeader() {
  // v3：图标连点 7 次唤起隐藏浮窗（内容管理页可编辑）
  setupSecretTap(document.querySelector("#home-brand .brand-icon"));
  $("home-hall").addEventListener("click", () => {
    location.href = (store.token && store.sid) ? "/hall" : "/join";
  });
  const me = $("home-me");
  if (store.token && store.sid) mountAvatar(me, store.avatar);
  else me.innerHTML = icon("me", 20);
  me.addEventListener("click", () => {
    location.href = (store.token && store.sid) ? "/me" : "/join";
  });
}

function showGuide() { $("guide").classList.remove("hidden"); }
function hideGuide() { $("guide").classList.add("hidden"); }

document.getElementById("guide-close").addEventListener("click", (e) => { e.stopPropagation(); hideGuide(); });
document.getElementById("guide").addEventListener("click", (e) => { if (e.target.id === "guide") hideGuide(); });

// ================================================================ v3.86 天气彩蛋（与书写房同源）
// 约定与书写房/大厅一致：首次确认、天气缓存、轮询周期共用同一对本地键——
// 一边答应过处处生效；定位只用 Cloudflare 由 IP 现算的经纬度，单次使用不落库；
// 任何失败静默降级，雨粒子不拦交互，绝不影响体验板书写。
const WEATHER_PREF_KEY = "pl_weather";
const WEATHER_CACHE_KEY = "pl_weather_cache";
const WEATHER_POLL_MS = 120 * 60 * 1000;
let weatherFx = null;   // 雨/雪粒子（RainDrops）
let weatherCu = null;   // canvas-ui Droplets（WebGL2 浏览器的小雨增强层）
let weatherCuDead = false; // canvas-ui 层初始化失败过 → 本次会话不再尝试
let weatherAmb = null; // 雾/极光氛围（与上面共用画布，同一时刻只启用其一）

function applyWeatherFx(d) {
  if (!d || !d.ok || d.mode === "none") return;
  const cv = $("weather-canvas");
  if (!cv) return;
  const wet = d.mode === "rain" || d.mode === "heavy" || d.mode === "snow";
  if (wet) {
    if (weatherAmb) { weatherAmb.stop(); weatherAmb = null; }
    // 小雨优先交给 canvas-ui Droplets（玻璃质感更精良）；大雨/雪走自研层
    if (d.mode === "rain" && !weatherCuDead) {
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
    if (!weatherFx) weatherFx = new RainDrops(cv, { alpha: 0.16 }); // 首页不绑信纸主题，雨雪本色
    weatherFx.setMode(d.mode === "heavy" ? "heavy" : d.mode === "snow" ? "snow" : "rain");
    weatherFx.start();
  } else { // fog | aurora
    if (weatherFx) { weatherFx.stop(); weatherFx = null; }
    if (weatherCu) { weatherCu.stop(); weatherCu = null; }
    if (!weatherAmb) weatherAmb = new WeatherAmbience(cv);
    weatherAmb.setMode(d.mode);
    weatherAmb.start();
  }
}

/// 首次确认卡片（与书写房同款，文案按首页说）
function weatherConsentCard() {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "consent-overlay";
    wrap.innerHTML = `
      <div class="consent-card" role="dialog" aria-modal="true" aria-label="天气彩蛋">
        <div class="consent-emoji" aria-hidden="true">🌧️</div>
        <h3>天气彩蛋</h3>
        <p>你所在的城市下雨或下雪时，让雨滴 / 雪花也落进首页。</p>
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
  } catch { /* 彩蛋任何异常都不允许影响首页书写 */ }
}

boot();
