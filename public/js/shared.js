// PaperLink — 前端共享模块（v2）：会话、API、toast、头像、主题、
// 多端兼容层（fullscreen/orientation/pressure 降级）、SVG 图标库。

export const store = {
  get token() { return localStorage.getItem("pl_token") || ""; },
  set token(v) { v ? localStorage.setItem("pl_token", v) : localStorage.removeItem("pl_token"); },
  get sid() { return localStorage.getItem("pl_sid") || ""; },
  set sid(v) { v ? localStorage.setItem("pl_sid", v) : localStorage.removeItem("pl_sid"); },
  get dev() { return localStorage.getItem("pl_dev") || ""; },
  set dev(v) { v ? localStorage.setItem("pl_dev", v) : localStorage.removeItem("pl_dev"); },
  get nick() { return localStorage.getItem("pl_nick") || ""; },
  set nick(v) { v ? localStorage.setItem("pl_nick", v) : localStorage.removeItem("pl_nick"); },
  get avatar() { return Number(localStorage.getItem("pl_avatar") || 0); },
  set avatar(v) { localStorage.setItem("pl_avatar", String(v)); },
  get roomCode() { return localStorage.getItem("pl_room") || ""; },
  set roomCode(v) { v ? localStorage.setItem("pl_room", v) : localStorage.removeItem("pl_room"); },
  get roomName() { return localStorage.getItem("pl_room_name") || ""; },
  set roomName(v) { v ? localStorage.setItem("pl_room_name", v) : localStorage.removeItem("pl_room_name"); },
  get theme() { return localStorage.getItem("pl_theme") || ""; },
  set theme(v) { v ? localStorage.setItem("pl_theme", v) : localStorage.removeItem("pl_theme"); },
  get mode() { return localStorage.getItem("pl_mode") || "letter"; },
  set mode(v) { localStorage.setItem("pl_mode", v === "realtime" ? "realtime" : "letter"); },
  // v2：解锁列表（彩蛋 + 未公开主题）改为服务端账号数据，本地仅缓存
  get unlocked() {
    try { return JSON.parse(localStorage.getItem("pl_unlocked") || "[]"); } catch { return []; }
  },
  set unlocked(arr) { localStorage.setItem("pl_unlocked", JSON.stringify(arr || [])); },
  get eggs() { return this.unlocked; }, // 兼容旧调用名
  set eggs(arr) { this.unlocked = arr; },
  get letterPref() { return localStorage.getItem("pl_letter_pref") || "banner"; },
  set letterPref(v) { localStorage.setItem("pl_letter_pref", v); },
  clearSession() {
    for (const k of ["pl_token", "pl_sid", "pl_dev", "pl_room", "pl_room_name", "pl_unlocked"]) localStorage.removeItem(k);
  },
};

export function devId() {
  let d = sessionStorage.getItem("pl_dev_id");
  if (!d) {
    d = (crypto.randomUUID ? crypto.randomUUID() : "d" + Date.now() + Math.random().toString(36).slice(2)).replace(/-/g, "");
    sessionStorage.setItem("pl_dev_id", d);
  }
  return d;
}

// ------------------------------------------------------------------ API

export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (!(opts.body instanceof FormData)) headers["Content-Type"] = "application/json";
  if (store.token) headers.Authorization = "Bearer " + store.token;
  const resp = await fetch(path, { ...opts, headers });
  if (resp.status === 401) {
    store.clearSession();
    if (!location.pathname.startsWith("/join")) location.href = "/join";
    throw new Error("unauthorized");
  }
  return resp;
}

export async function apiJson(path, opts = {}) {
  const resp = await api(path, opts);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw Object.assign(new Error(data.error || "http " + resp.status), { code: data.error, data });
  return data;
}

/// 从服务端刷新账号资料（解锁列表等），登录后/进房前调用
export async function refreshMe() {
  try {
    const d = await apiJson("/api/me");
    if (d.user) {
      store.nick = d.user.nick;
      store.avatar = d.user.avatar;
      store.unlocked = d.user.unlocked || [];
    }
    return d.user;
  } catch { return null; }
}

// ---------------------------------------------------------------- toast

let toastTimer = 0;
export function toast(msg, ms = 2200) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

export function relTime(ts) {
  const d = Math.max(0, Date.now() - ts);
  const m = Math.floor(d / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

// --------------------------------------------------------------- loading
// v3.34：加载屏升级为 Canvas 粒子开场——墨点自上方散落、受重力下落，
// 在底部汇聚成一滴墨，同时品牌名由模糊过渡到清晰（约 2 秒）。
// 无 Canvas 2d / 偏好减少动态效果时自动降级回原 CSS 墨滴（.ink-drop 保留）。

const LOADING_FX_MS = 2000;
let _fxStarted = false, _fxActive = false, _fxRaf = 0, _fxT0 = 0;

function stopLoadingFx() {
  if (_fxRaf) cancelAnimationFrame(_fxRaf);
  _fxRaf = 0;
  _fxActive = false;
}

function startLoadingFx() {
  if (_fxStarted) return;
  _fxStarted = true;
  try {
    const el = document.getElementById("app-loading");
    if (!el) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return; // 降级：CSS 墨滴
    const cv = document.createElement("canvas");
    const ctx = cv.getContext("2d");
    if (!ctx) return; // 无 2d 上下文 → 降级：CSS 墨滴
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = window.innerWidth, H = window.innerHeight;
    cv.width = Math.max(1, Math.round(W * dpr));
    cv.height = Math.max(1, Math.round(H * dpr));
    cv.style.width = W + "px";
    cv.style.height = H + "px";
    cv.className = "loading-fx";
    el.prepend(cv);
    el.classList.add("fx-on"); // CSS 墨滴让位（降级路径不会加这个类）
    el.querySelector(".loading-name")?.classList.add("clarify"); // 文字由模糊到清晰

    const brand = (getComputedStyle(document.documentElement).getPropertyValue("--brand") || "").trim() || "#7a5cff";
    const cx = W / 2, cy = H / 2 - 26; // 与原 CSS 墨滴的落点一致
    const N = 90, g = 0.0016;          // 粒子数 / 重力加速度（px/ms²）
    const parts = [];
    for (let i = 0; i < N; i++) {
      parts.push({
        born: 120 + (i / N) * 850 + Math.random() * 140, // 错峰飘落
        x: cx + (Math.random() - 0.5) * Math.min(W * 0.7, 460),
        y: -12 - Math.random() * 90,
        vx: (Math.random() - 0.5) * 0.02,
        vy: 0.02 + Math.random() * 0.06,
        r: 1.1 + Math.random() * 2.1,
        tx: 0, ty: 0, home: false, done: false,
      });
    }
    for (const p of parts) { // 汇聚目标：墨滴轮廓内均匀散点
      const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random());
      p.tx = cx + Math.cos(a) * rr * 9;
      p.ty = cy + 4 + Math.sin(a) * rr * 11;
    }

    let landed = 0, squashT0 = 0, last = performance.now();
    _fxT0 = last;
    _fxActive = true;

    const drawDrop = (s, sqx, sqy, alpha) => { // 与 CSS 墨滴同款泪滴形（约 18×24）
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(s * sqx, s * sqy);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = brand;
      ctx.beginPath();
      ctx.moveTo(0, -13);
      ctx.bezierCurveTo(6, -5, 10, 0, 10, 6);
      ctx.arc(0, 6, 10, 0, Math.PI, false);
      ctx.bezierCurveTo(-10, 0, -6, -5, 0, -13);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };

    const step = (nowT) => {
      _fxRaf = requestAnimationFrame(step);
      const t = nowT - _fxT0;
      const dt = Math.min(34, nowT - last);
      last = nowT;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      let arrived = 0;
      ctx.fillStyle = brand;
      for (const p of parts) {
        if (t < p.born) continue;
        if (p.done) { arrived++; continue; } // 已并入墨滴
        if (!p.home) { // 自由落体段
          p.vy += g * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          if (p.y >= p.ty - 46) p.home = true; // 进入汇合区 → 朝墨滴归位
        } else {
          const k = Math.min(1, dt * 0.014);
          p.x += (p.tx - p.x) * k;
          p.y += (p.ty - p.y) * k;
          if (Math.abs(p.x - p.tx) < 1.5 && Math.abs(p.y - p.ty) < 1.5) {
            p.done = true;
            landed++;
            if (landed === Math.floor(N * 0.55)) { // 落定时刻：一声轻"滴"+ 压扁回弹
              squashT0 = nowT;
              playDrip();
            }
          }
        }
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }

      const ratio = arrived / N;
      if (ratio > 0.02) { // 墨滴随粒子落定逐渐"攒"大
        const easeOut = (u) => 1 - Math.pow(1 - u, 3);
        const s = 0.2 + 0.8 * easeOut(Math.min(1, ratio * 1.15));
        let sqx = 1, sqy = 1;
        if (squashT0) {
          const u = Math.min(1, (nowT - squashT0) / 260);
          const k = Math.sin(Math.PI * u);
          sqx = 1 + 0.32 * k; // 落地压扁再回弹（呼应原 pl-drop 尾帧）
          sqy = 1 - 0.4 * k;
        }
        drawDrop(s, sqx, sqy, Math.min(1, ratio * 3));
      }
      if (t > LOADING_FX_MS + 900) { // 动画播完且已无变化：停表，静帧等淡出
        cancelAnimationFrame(_fxRaf);
        _fxRaf = 0;
      }
    };
    _fxRaf = requestAnimationFrame(step);
  } catch { /* 任何意外都静默降级回 CSS 墨滴 */ }
}

export function hideLoading() {
  const el = document.getElementById("app-loading");
  if (!el) return;
  // v3.34：粒子开场在播就留屏到播完（约 2 秒）再淡出；CSS 降级版沿用旧节奏
  const wait = _fxActive ? Math.max(300, LOADING_FX_MS + 150 - (performance.now() - _fxT0)) : 300;
  setTimeout(() => {
    el.classList.add("fade");
    playDrip(); // v3.16 #28：墨滴"落地"时刻一声极轻的"滴"（仅在音频已被用户交互解锁时发声）
    setTimeout(() => { stopLoadingFx(); el.remove(); }, 700);
  }, wait);
}

// ---------------------------------------------------------- drip sound
// #28 加载屏墨滴落地的一声极轻"滴"：遵守 autoplay 策略——音频上下文必须
// 由用户手势解锁，未解锁（首次冷启动）静默；「我的」页可整体关闭音效。

let _dripCtx = null;
let _dripPlayed = false;

function makeDripCtx() {
  try {
    _dripCtx = _dripCtx || new (window.AudioContext || window.webkitAudioContext)();
    _dripCtx.resume?.();
  } catch { _dripCtx = null; }
  return _dripCtx;
}

/// 页面加载时挂一次：用户首次触摸/点击即解锁音频上下文
export function armDripSound() {
  window.addEventListener("pointerdown", () => makeDripCtx(), { once: true, capture: true });
}

export function playDrip() {
  if (_dripPlayed || localStorage.getItem("pl_drip") === "0") return;
  const ctx = _dripCtx;
  if (!ctx || ctx.state !== "running") return; // autoplay 未解锁 → 安静
  _dripPlayed = true;
  try {
    const t0 = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(1250, t0);
    o.frequency.exponentialRampToValueAtTime(320, t0 + 0.09); // 下落→入水的轻"滴"
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.04, t0 + 0.012);    // 极轻，不打扰
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13);
    o.connect(g); g.connect(ctx.destination);
    o.start(t0); o.stop(t0 + 0.15);
  } catch { /* 静默 */ }
}

// --------------------------------------------------------------- avatars

const AVATAR_HUES = [262, 205, 150, 30, 340, 48];
const AVATAR_DOODLES = [
  "M30 62 Q 40 38 50 58 T 70 50",
  "M50 30 L 56 46 L 73 46 L 59 56 L 64 72 L 50 62 L 36 72 L 41 56 L 27 46 L 44 46 Z",
  "M50 68 C 30 54 34 36 50 44 C 66 36 70 54 50 68 Z",
  "M66 34 A 18 18 0 1 0 66 66 A 22 22 0 1 1 66 34 Z",
  "M32 60 Q 50 30 68 60 M40 60 Q 50 44 60 60",
  "M34 40 h32 M34 50 h32 M34 60 h20",
];

export function avatarSvg(i, cls = "") {
  const h = AVATAR_HUES[((i % 6) + 6) % 6];
  const d = AVATAR_DOODLES[((i % 6) + 6) % 6];
  return `<svg viewBox="0 0 100 100" class="${cls}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="50" cy="50" r="50" fill="hsl(${h}, 62%, 74%)"/>
    <path d="${d}" fill="${i % 6 === 1 || i % 6 === 2 ? "rgba(255,255,255,0.92)" : "none"}"
      stroke="rgba(255,255,255,0.92)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

export function mountAvatar(el, i, opts = {}) {
  if (!el) return;
  el.innerHTML = avatarSvg(i);
}

// ---------------------------------------------------------------- themes

let themeRegistry = [];
export async function loadThemes() {
  try {
    const cfg = await (await fetch("/api/config")).json();
    themeRegistry = (cfg.themes || []).map((t) => ({ ...t, custom: false }));
    window.__plConfig = cfg;
  } catch { /* offline */ }
  try {
    const data = await (await fetch("/api/templates")).json();
    for (const t of data.templates || []) {
      themeRegistry.push({
        id: t.id, name: t.name, custom: true, template: t, public: t.public !== false,
        paper: t.paperColor || "#f5f0e4", ink: t.inkColor || "#241812", texture: "custom",
      });
    }
  } catch { /* ok */ }
  return themeRegistry;
}

export function getThemes() { return themeRegistry; }

export function themeById(id) {
  return themeRegistry.find((t) => t.id === id) || themeRegistry.find((t) => t.public && !t.egg && !t.custom) || themeRegistry[0];
}

/// v2：只显示拥有的 —— 公开主题人人可见；未公开的需兑换解锁
export function themeUnlocked(t) {
  if (!t) return false;
  if (t.public) return true;
  return store.unlocked.includes(t.id);
}

/// v3：彩蛋解锁判定 —— 管理页公开的彩蛋全员可用，其余需兑换解锁
export function hasEgg(id) {
  const cfg = window.__plConfig || {};
  const egg = (cfg.eggs || []).find((e) => e.id === id);
  if (egg?.public) return true;
  return store.unlocked.includes(id);
}

/// 自定义模板样式的全局唯一 style 元素（v3.23 #36：只更新 textContent，
/// 不再每次换信纸都 remove/create，避免样式元素堆积与闪动）
let tplStyleEl = null;

/// v3.23 #37：把模板 CSS 的作用域收窄到「当前这张模板的信纸」——
/// 选择器前缀统一改写为 .page-paper.texture-custom.tpl-<id>，
/// 不同模板、不同纸面（书写房/重放层/首页体验板）互不串味
function scopeTemplateCss(css, tplId) {
  const sel = `.page-paper.texture-custom.tpl-${tplId}`;
  return String(css).replace(/\.page-paper(?=[\s:{,.#[]|::|$)/g, sel);
}

export function applyThemeToPaper(paperEl, theme, inkOverride = null) {
  // v3.23 #37：先摘掉上一张模板的作用域类
  for (const c of [...paperEl.classList]) if (c.startsWith("tpl-")) paperEl.classList.remove(c);
  paperEl.classList.remove("texture-tom", "texture-parchment", "texture-midnight", "texture-letter", "texture-starry", "texture-sakura", "texture-custom");
  const tex = theme.texture || "letter";
  paperEl.classList.add("texture-" + tex);
  const ink = inkOverride || theme.ink;
  paperEl.style.setProperty("--ink-color", ink);
  paperEl.dataset.ink = ink;

  // v3.16 #23/#24/#25：按纹理挂载装饰层（星空微闪烁 / 樱花飘落 / 手工纸纹理）
  mountPaperDecor(paperEl, tex);

  // v3 自定义信纸：信纸基色走选色器（--paper-color 由 .texture-custom 消费）
  if (theme.custom && theme.paper) {
    paperEl.style.setProperty("--paper-color", theme.paper);
  } else {
    paperEl.style.removeProperty("--paper-color");
  }

  if (!tplStyleEl) {
    tplStyleEl = document.createElement("style");
    tplStyleEl.id = "pl-template-style";
    document.head.appendChild(tplStyleEl);
  }
  if (theme.custom && theme.template?.css) {
    tplStyleEl.textContent = scopeTemplateCss(theme.template.css, theme.template.id);
    paperEl.classList.add("tpl-" + theme.template.id);
    paperEl.dataset.templateId = theme.template.id;
    paperEl.dataset.bgAsset = theme.template.bgAssetId ? `/api/template/asset/${theme.template.bgAssetId}` : "";
    if (theme.template.bgAssetId) {
      paperEl.style.setProperty("--tpl-bg", `url(/api/template/asset/${theme.template.bgAssetId})`);
    }
  } else {
    tplStyleEl.textContent = "";
    delete paperEl.dataset.templateId;
    paperEl.style.removeProperty("--tpl-bg");
  }
  return ink;
}

export function themeThumbCss(t) {
  if (!t) return "background:rgba(120,110,150,0.2)";
  if (t.texture === "midnight") return "background:#000";
  if (t.texture === "starry") return "background:radial-gradient(1.5px 1.5px at 20% 30%, #fff, transparent), radial-gradient(1px 1px at 70% 60%, #fff, transparent), #0d1533";
  if (t.texture === "sakura") return "background:radial-gradient(10px 7px at 30% 40%, rgba(244,143,177,0.6), transparent), #fdeef2";
  if (t.texture === "parchment") return "background:linear-gradient(160deg,#d3b47c,#c09a5d)";
  if (t.custom && t.paper) return `background:${t.paper}`;
  return `background:${t.paper || "#f5f0e4"}`;
}

// ---------------------------------------------------------------- misc

export function copyText(text) {
  const done = () => toast("已复制 ✓", 1500);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text));
  } else fallbackCopy(text);
}
function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  // v3.23 #54：两条路都失败时明确告知手动复制，不再静默吞掉
  if (!ok) toast("复制失败，请长按文字手动复制", 2600);
  else toast("已复制 ✓", 1500);
}

export function confirmDialog(msg) { return window.confirm(msg); }

/// v3.23 #27：对话名的渲染层统一截断——服务端可存 24 字，
/// 界面只展示前 16 字加省略号，避免长名撑破书架卡片/房名栏
export function truncName(s, n = 16) {
  const t = String(s ?? "").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/// v3.23 #32：空状态文案统一收口——各处"空空如也"的提示都从这里取，
/// 以后调文案/做多语言只改这一处
export const I18N = {
  lettersEmpty: "还没有信。<br>写一页，点「发送」寄给 TA。",
  hallEmpty: "书架还空着。<br>点「新对话」创建一本，把邀请码交给 TA；<br>或在上方输入 9 位邀请码，加入 TA 的日记本。",
  drawerLoadMore: (n) => `加载更早的信（还有 ${n} 封）`,
};

/// v3.23 #46/#57：iOS 浏览器里任何"全屏"都带地址栏，只有从主屏幕图标
/// 启动才是真沉浸。首次访问弹一次引导（可关、关过不再弹、已装不弹）。
export function mountAddToHomeGuide() {
  if (!UA.ios) return;
  if (navigator.standalone || window.matchMedia?.("(display-mode: standalone)")?.matches) return;
  try { if (localStorage.getItem("pl_a2h") === "1") return; } catch { return; }
  const el = document.createElement("div");
  el.id = "a2h-guide";
  el.innerHTML = `
    <div class="a2h-card">
      <div class="a2h-text">想要没有地址栏的沉浸书写体验，<br>建议把 <b>PaperLink 加到主屏幕</b></div>
      <div class="a2h-steps">点 Safari 底部的「分享」→「添加到主屏幕」，<br>以后从桌面图标进来就是全屏</div>
      <button class="a2h-ok" type="button">知道了</button>
    </div>`;
  document.body.appendChild(el);
  const dismiss = () => {
    el.remove();
    try { localStorage.setItem("pl_a2h", "1"); } catch { /* ok */ }
  };
  el.querySelector(".a2h-ok").addEventListener("click", dismiss);
  setTimeout(() => el.remove(), 9000); // 不点也不纠缠，9 秒自动退场
}

export function escapeHtmlSafe(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ================================================================ 兼容层
// 多厂商/多浏览器降级：fullscreen（含 webkit 前缀 + CSS 全屏兜底）、
// 屏幕方向锁（不支持时 CSS 旋转兜底由调用方处理）、UA 粗判。

export const UA = (() => {
  const ua = navigator.userAgent || "";
  return {
    ios: /iP(hone|ad|od)/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
    android: /Android/.test(ua),
    wechat: /MicroMessenger/.test(ua),
    huawei: /Huawei|Honor/i.test(ua),
    miui: /MiuiBrowser|XiaoMi/i.test(ua),
    touch: "ontouchstart" in window || navigator.maxTouchPoints > 0,
  };
})();

// v3.23 #56：微信内置浏览器的 backdrop-filter 兼容性差且耗电——
// 打类后由 CSS 把毛玻璃统一降级为纯半透背景（--material: blur(0)）
if (UA.wechat) document.documentElement.classList.add("wechat");

export function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement || null;
}

/// 原生全屏失败（iOS Safari 等）→ 返回 false，调用方启用 CSS 全屏兜底
export async function enterFullscreen(el) {
  el = el || document.documentElement;
  const fns = [el.requestFullscreen, el.webkitRequestFullscreen, el.mozRequestFullScreen, el.msRequestFullscreen];
  for (const fn of fns) {
    if (typeof fn === "function") {
      try { const r = fn.call(el); if (r && r.catch) await r.catch(() => {}); if (fullscreenElement()) return true; } catch { /* try next */ }
    }
  }
  return false;
}

export async function exitFullscreen() {
  const fns = [document.exitFullscreen, document.webkitExitFullscreen, document.mozCancelFullScreen, document.msExitFullscreen];
  for (const fn of fns) {
    if (typeof fn === "function") { try { await fn.call(document); return; } catch { /* next */ } }
  }
}

export function onFullscreenChange(cb) {
  for (const ev of ["fullscreenchange", "webkitfullscreenchange", "mozfullscreenchange", "MSFullscreenChange"]) {
    document.addEventListener(ev, cb);
  }
}

/// 方向锁：返回是否成功；失败时调用方用 CSS 旋转兜底
export async function lockOrientation(landscape) {
  try {
    if (!screen.orientation?.lock) return false;
    await screen.orientation.lock(landscape ? "landscape" : "portrait");
    return true;
  } catch { return false; }
}
export function unlockOrientation() {
  try { screen.orientation?.unlock?.(); } catch { /* ok */ }
}

// ------------------------------------------------------------- SVG icons
// v2：全部界面图标使用内联 SVG，排除 Unicode 字符图标。

const ICON_PATHS = {
  hall: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5v13z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/><path d="M9 8h7M9 11.5h5"/>',
  me: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  music: '<path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>',
  eraser: '<path d="M19.5 11.5 12.6 4.6a2 2 0 0 0-2.8 0L4 10.4a2 2 0 0 0 0 2.8l5.8 5.8h4.3l5.4-5.4a2 2 0 0 0 0-2.8Z"/><path d="M8.5 9.5l6 6"/><path d="M9.8 19H20"/>',
  undo: '<path d="M9.5 13.5 5 9l4.5-4.5"/><path d="M5 9h8.5a5.5 5.5 0 0 1 0 11H10"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
  next: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M9.5 12h5M12 9.5v5"/>',
  expand: '<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/>',
  compress: '<path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5"/>',
  fade: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="3" r="0"/><circle cx="12" cy="12" r="3"/>',
  mode: '<path d="M4 7h13l-3-3M20 17H7l3 3"/>',
  letters: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  edit: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c7 0 11 7 11 7a17.6 17.6 0 0 1-2.9 3.7M6.6 6.6A16.8 16.8 0 0 0 1 12s4 7 11 7a10.7 10.7 0 0 0 4.4-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  resetView: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><circle cx="12" cy="12" r="2.5"/>',
  tip: '<path d="M20 4c-6 1-12 7-14 14"/><path d="M20 4c-1 6-7 12-13 14"/><circle cx="4.6" cy="19.4" r="1.4" fill="currentColor" stroke="none"/>',
  play: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor" stroke="none"/>',
  landscape: '<rect x="2" y="7" width="20" height="10" rx="2"/><path d="M6 11h4M6 13.5h2.5"/>',
  portrait: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M10 6h4"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  userPlus: '<circle cx="9" cy="8" r="4"/><path d="M2 20c0-4 3-6.5 7-6.5s7 2.5 7 6.5"/><path d="M19 8v6M16 11h6"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3M15 8l3 3"/>',
  shield: '<path d="M12 2 4 6v6c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10V6Z"/>',
  upload: '<path d="M12 16V4M6 10l6-6 6 6"/><path d="M4 20h16"/>',
  download: '<path d="M12 4v12M6 10l6 6 6-6"/><path d="M4 20h16"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z"/>',
  book: '<path d="M2 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H2Z"/><path d="M22 4h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8Z"/>',
};

export function icon(name, size = 18) {
  const d = ICON_PATHS[name] || ICON_PATHS.more;
  return `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

/// 把容器里 data-icon="x" 的占位元素批量填成 SVG（HTML 静态区用）
export function mountIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML = icon(el.dataset.icon, Number(el.dataset.size) || 18);
  });
}

// ------------------------------------------------------- secret tap (riddle)
// 连点应用图标 7 次 → 唤起浮窗；内容管理页可编辑（config.secretHtml）。

let _secretTaps = 0;
let _secretTimer = 0;

function showSecretOverlay() {
  if (document.getElementById("secret-overlay")) return;
  const cfg = window.__plConfig || {};
  const html = cfg.secretHtml ||
    "<p>这里藏着一小片安静的墨。<br>写给还在写信的人。</p>";
  const ov = document.createElement("div");
  ov.id = "secret-overlay";
  ov.innerHTML = `<div class="glass-card"><div id="secret-content">${html}</div></div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener("click", close);
}

/// 给应用图标元素挂 7 连点彩蛋（返回点击计数，便于调用方自定义后续行为）
export function setupSecretTap(el) {
  if (!el) return;
  el.addEventListener("click", () => {
    _secretTaps++;
    clearTimeout(_secretTimer);
    _secretTimer = setTimeout(() => { _secretTaps = 0; }, 2600);
    if (_secretTaps >= 7) {
      _secretTaps = 0;
      showSecretOverlay();
    }
  });
}

// ------------------------------------------- reset-view button (v3.7)
// 视口一键复位浮动按钮：轻点 = 视口复位；按住拖动 = 挪位置（位置记在
// 浏览器本地缓存，下次打开还在）。默认落点自动探测，挑不与工具栏/书信集/
// 主题栏等控件重叠的位置；横竖屏切换后夹回屏内。

// ----------------------------------------------- glass highlight (v3.16 #29)
// 毛玻璃卡片（发送栏/书信抽屉/主题弹层等）的高光线跟随光标微移：
// 全局维护 --hl-x/--hl-y（视口坐标），CSS 侧用 background-attachment: fixed
// 的径向渐变消费。仅精确指针（鼠标/触控板）启用，触屏无意义。

let _hlInstalled = false;
export function mountGlassHighlight() {
  if (_hlInstalled) return;
  if (typeof matchMedia !== "function" || !matchMedia("(pointer: fine)").matches) return;
  _hlInstalled = true;
  let raf = 0, cx = -999, cy = -999;
  window.addEventListener("pointermove", (e) => {
    cx = e.clientX; cy = e.clientY;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const st = document.documentElement.style;
      st.setProperty("--hl-x", cx + "px");
      st.setProperty("--hl-y", cy + "px");
    });
  }, { passive: true });
}

/// 把弹层（橡皮滑条等）贴到指定按钮旁边：优先展开在按钮左侧，
/// 放不下自动换右侧，上下出屏自动夹紧（v3.7 滑条改到橡皮按钮旁）
export function positionPopByButton(pop, btn) {  if (!pop || !btn) return;
  const b = btn.getBoundingClientRect();
  const pw = pop.offsetWidth || 180, ph = pop.offsetHeight || 40;
  const gap = 10;
  let x = b.left - pw - gap;                 // 优先展开在按钮左侧
  if (x < 8) x = b.right + gap;              // 左侧放不下换右侧
  x = Math.min(Math.max(8, x), Math.max(8, window.innerWidth - pw - 8));
  let y = b.top + b.height / 2 - ph / 2;     // 与按钮垂直居中
  y = Math.min(Math.max(8, y), Math.max(8, window.innerHeight - ph - 8));
  pop.style.left = x + "px";
  pop.style.top = y + "px";
  pop.style.right = "auto";
  pop.style.bottom = "auto";
}

// 供书写房主题栏闲置收缩等复用（函数声明提升，导出写在定义之前无碍）
export { livePointerCount, trackActivePointers };

// v3.13/v3.14：全局「在按指针」表（捕获阶段统计，早于按钮自身事件）。
// 多指手势（三指缩放/双指橡皮）期间手指扫过按钮时，不能触发按钮的拖动。
// v3.14：改为带时间戳的表 + 过期清扫。Safari 在手指被系统手势吸收时
// 偶尔不发 pointerup/pointercancel，纯计数器会永远卡在 ≥1，之后按钮
// 的每次轻点都被误判为"多指手势进行中"而不响应（Safari 点击不复位
// 的根源）。超过 2s 没收到抬起事件的指针按过期处理；切后台/失焦直接清表。
const _livePointers = new Map(); // pointerId -> 落指时刻
const POINTER_STALE_MS = 2000;
let _lastMultiPointerAt = 0;      // 最近一次出现 ≥2 指的时刻（click 兜底防误触用）
let _pointerTrackInstalled = false;
function livePointerCount() {
  const t = performance.now();
  for (const [id, at] of _livePointers) if (t - at > POINTER_STALE_MS) _livePointers.delete(id);
  return _livePointers.size;
}
function trackActivePointers() {
  if (_pointerTrackInstalled) return;
  _pointerTrackInstalled = true;
  window.addEventListener("pointerdown", (e) => {
    _livePointers.set(e.pointerId, performance.now());
    if (_livePointers.size >= 2) _lastMultiPointerAt = performance.now();
  }, true);
  const drop = (e) => { _livePointers.delete(e.pointerId); };
  window.addEventListener("pointerup", drop, true);
  window.addEventListener("pointercancel", drop, true);
  // 切后台/切应用：Safari 会不发事件直接杀掉触摸，直接清表
  const clear = () => { _livePointers.clear(); };
  window.addEventListener("blur", clear);
  document.addEventListener("visibilitychange", () => { if (document.hidden) clear(); });
}

export function mountResetViewButton(btn, getPad, opts = {}) {
  if (!btn) return;
  trackActivePointers();
  const KEY = "pl_resetView_pos";

  /// 页面上需要避让的固定控件（不可见的跳过）
  const avoidEls = () => ["#toolbar", "#btn-letters", "#theme-bar", "#send-bar", "#page-header", "#partner-badge"]
    .map((sel) => document.querySelector(sel))
    .filter((el) => el && !el.classList.contains("hidden") && el.getClientRects().length > 0);

  const overlaps = (x, y) => {
    const s = btn.offsetWidth || 42, m = 10; // 留 10px 安全间距
    const l = x - m, t = y - m, r = x + s + m, b = y + s + m;
    for (const el of avoidEls()) {
      const box = el.getBoundingClientRect();
      if (l < box.right && r > box.left && t < box.bottom && b > box.top) return true;
    }
    return false;
  };

  /// 自动落点：候选位置里挑第一个不重叠的（无记忆时的默认位置）
  const autoPlace = () => {
    const s = btn.offsetWidth || 42;
    const W = window.innerWidth, H = window.innerHeight;
    const cl = (v, lo, hi) => Math.min(Math.max(lo, v), Math.max(lo, hi));
    const cands = [];
    for (const fy of [0.60, 0.68, 0.76, 0.52, 0.84]) cands.push({ x: 14, y: H * fy });
    for (const fy of [0.60, 0.72, 0.82]) cands.push({ x: W - s - 14, y: H * fy });
    cands.push({ x: 14, y: H - s - 16 }, { x: W - s - 14, y: H - s - 16 });
    const free = cands.find((c) => !overlaps(cl(c.x, 8, W - s - 8), cl(c.y, 8, H - s - 8)));
    const p = free || cands[0];
    return { x: cl(p.x, 8, W - s - 8), y: cl(p.y, 8, H - s - 8) };
  };

  const apply = (x, y) => {
    const s = btn.offsetWidth || 42;
    const p = {
      x: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - s - 8)),
      y: Math.min(Math.max(8, y), Math.max(8, window.innerHeight - s - 8)),
    };
    btn.style.left = p.x + "px";
    btn.style.top = p.y + "px";
    return p;
  };

  // 有记忆位置用记忆的（夹回屏内）；否则自动避让落点
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { /* ok */ }
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) apply(saved.x, saved.y);
  else { const p = autoPlace(); apply(p.x, p.y); }

  // v3.27 #9：不再自动缩小——按钮保持原尺寸（仍可拖动、轻点复位视口）

  // 拖动挪位（轻点 = 复位视口），松手落点记入本地缓存。
  // v3.13：多指手势期间（已有其它手指在屏上）忽略按钮按下/移动，
  // 避免缩放时手指扫过按钮把它拖着走。
  let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
  let lastTapHandledAt = 0;
  btn.addEventListener("pointerdown", (e) => {
    if (livePointerCount() > 1) return; // 手势已在进行，这个手指不算按钮操作
    e.preventDefault();
    e.stopPropagation();
    dragging = true; moved = false;
    sx = e.clientX; sy = e.clientY;
    const r = btn.getBoundingClientRect();
    ox = r.left; oy = r.top;
    try { btn.setPointerCapture(e.pointerId); } catch { /* ok */ }
  });
  btn.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    if (livePointerCount() > 1) return; // 第二根手指落下 → 冻结拖动
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!moved && Math.hypot(dx, dy) > 6) moved = true;
    if (moved) { btn.classList.add("dragging"); apply(ox + dx, oy + dy); }
  });
  const up = () => {
    if (!dragging) return;
    dragging = false;
    btn.classList.remove("dragging");
    lastTapHandledAt = performance.now();
    if (moved) {
      const r = btn.getBoundingClientRect();
      const p = apply(r.left, r.top); // 松手再夹一次，保证不出屏
      try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ok */ }
      return;
    }
    getPad()?.resetView();
    opts.onReset?.();
  };
  btn.addEventListener("pointerup", up);
  btn.addEventListener("pointercancel", up);
  // v3.14：click 兜底——Safari 偶尔丢 pointer 事件，但兼容性 click 仍会到。
  // 指针路径刚处理过（0.8s 内）则跳过；刚出现过 ≥2 指也跳过（防手势误触）。
  btn.addEventListener("click", () => {
    const t = performance.now();
    if (t - lastTapHandledAt < 800) return;
    if (t - _lastMultiPointerAt < 500) return;
    getPad()?.resetView();
    opts.onReset?.();
  });
  // 屏幕转向/尺寸变化后把按钮夹回可视范围。
  // v3.13：除 resize 外，转向/可视视口变化/全屏切换也要夹一次，
  // 保证按钮始终在屏幕内。
  const reclamp = () => {
    const r = btn.getBoundingClientRect();
    apply(r.left, r.top);
  };
  window.addEventListener("resize", reclamp);
  window.addEventListener("orientationchange", reclamp);
  window.visualViewport?.addEventListener("resize", reclamp);
  document.addEventListener("fullscreenchange", reclamp);
}

// ------------------------------------------------- scramble text (v3.3)
// 文字「解码」动效，思路取自 canvas-ui 的 DecryptReveal：
// 乱码逐位落定为最终文字，用在信件打开等仪式感时刻。

// #17 字符池改纯 ASCII + 中文标点——原池里的 ✎✉ 在部分系统渲染为豆腐块
const SCRAMBLE_POOL = "PaperLink*·—~、。，：；？！";

export function scrambleText(el, finalText, durMs = 650) {
  if (!el) return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    el.textContent = finalText;
    return;
  }
  const chars = Array.from(finalText);
  const start = performance.now();
  const tick = (nowT) => {
    const t = Math.min(1, (nowT - start) / durMs);
    // #18 打字机式揭示：从左到右依次定格（缓动让前段落定稍慢、收尾利落）
    const reveal = Math.floor(chars.length * (1 - Math.pow(1 - t, 1.6)));
    let out = "";
    for (let i = 0; i < chars.length; i++) {
      if (chars[i] === " ") { out += " "; continue; }
      out += i < reveal ? chars[i] : SCRAMBLE_POOL[(Math.random() * SCRAMBLE_POOL.length) | 0];
    }
    el.textContent = out;
    if (t < 1) requestAnimationFrame(tick);
    else el.textContent = finalText;
  };
  requestAnimationFrame(tick);
}

// ------------------------------------------- 逐词聚焦浮现（react-bits BlurText 思路）
// 文字逐词从模糊、轻浮状态聚焦落定；用在开信落款等揭晓时刻。
// 「减少动态效果」偏好下直接出全文。

export function blurText(el, finalText, { wordDelayMs = 70 } = {}) {
  if (!el) return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    el.textContent = finalText;
    return;
  }
  el.textContent = "";
  const words = String(finalText).split(" ");
  words.forEach((w, i) => {
    const span = document.createElement("span");
    span.className = "blur-text-word";
    span.textContent = w;
    span.style.animationDelay = (i * wordDelayMs) + "ms";
    el.appendChild(span);
    if (i < words.length - 1) el.appendChild(document.createTextNode(" "));
  });
}

// ------------------------------------------- 点击火花（react-bits ClickSpark 思路）
// 点按处迸出一圈细火星，短暂闪耀后消散。全屏单画布、无粒子时零开销，
// 不拦任何交互；「减少动态效果」偏好下不启用。

export function mountClickSpark() {
  if (typeof document === "undefined" || !document.body) return; // Node/测试环境直接跳过
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  if (document.getElementById("click-spark")) return;
  const cv = document.createElement("canvas");
  cv.id = "click-spark";
  cv.setAttribute("aria-hidden", "true");
  document.body.appendChild(cv);
  const ctx = cv.getContext("2d");
  let sparks = [];
  let raf = 0;
  let last = 0;

  const resize = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(window.innerWidth * dpr);
    cv.height = Math.round(window.innerHeight * dpr);
    // v3.27 #5：CSS 尺寸必须与位图同用 innerWidth/innerHeight（CSS px）。
    // 旧写法用 100vw/100vh——手机上 100vh 常大于 innerHeight（动态工具栏），
    // 画布被竖向拉伸，火花整体画在点击处偏下的位置
    cv.style.width = window.innerWidth + "px";
    cv.style.height = window.innerHeight + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener("resize", resize);

  function step(nowT) {
    const dt = Math.min(0.05, (nowT - last) / 1000);
    last = nowT;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    sparks = sparks.filter((s) => (s.t += dt) < s.life);
    for (const s of sparks) {
      const k = 1 - s.t / s.life;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= 0.92;
      s.vy *= 0.92;
      const len = 3 + 7 * k;
      ctx.strokeStyle = `rgba(122, 92, 255, ${(0.75 * k).toFixed(3)})`;
      ctx.lineWidth = 1.2 * k + 0.3;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - Math.cos(s.a) * len, s.y - Math.sin(s.a) * len);
      ctx.stroke();
    }
    if (sparks.length) raf = requestAnimationFrame(step);
    else { raf = 0; ctx.clearRect(0, 0, window.innerWidth, window.innerHeight); }
  }

  document.addEventListener("click", (e) => {
    // v3.27 #5：信纸上落笔已有涟漪反馈，点击火花跳过，避免双层特效叠位
    if (e.target instanceof Element && e.target.closest(".page-paper")) return;
    const n = 8 + ((Math.random() * 5) | 0);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 70 + Math.random() * 130;
      sparks.push({
        x: e.clientX, y: e.clientY,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        a, t: 0, life: 0.3 + Math.random() * 0.3,
      });
    }
    if (sparks.length > 260) sparks.splice(0, sparks.length - 260); // 连点保护
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(step); }
  }, true);
}

// 模块脚本延迟执行，此刻 body 已就绪：全站自动挂上点击火花
mountClickSpark();

// ------------------------------------------- 主题切换毛玻璃过渡层（v3.16 #22）

/// 信纸换主题的瞬间盖一层 300ms 的 backdrop-blur 过渡层，避免硬切换。
/// 信纸容器内复用同一个 .theme-veil 元素（CSS 见 paperlink.css）。
export function themeVeil(paperEl) {
  if (!paperEl) return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  let veil = paperEl.querySelector(".theme-veil");
  if (!veil) {
    veil = document.createElement("div");
    veil.className = "theme-veil";
    veil.setAttribute("aria-hidden", "true");
    paperEl.appendChild(veil);
  }
  veil.classList.remove("show");
  void veil.offsetWidth; // 重启动画
  veil.classList.add("show");
  clearTimeout(veil._t);
  veil._t = setTimeout(() => veil.classList.remove("show"), 340);
}

// ------------------------------------------------- 信纸装饰层（v3.16）
// #23 星夜：CSS radial-gradient 星星改为 canvas 动态星空（微闪烁）；
// #24 樱花：静态花瓣改为缓缓飘落（带左右摇摆）；
// #25 羊皮纸：内嵌 SVG 纹理参数每次加载随机微调，每张纸纹理略不同。
// 装饰画布 pointer-events:none、置于墨迹画布之下，不影响书写与手势。

const REDUCED_MOTION = typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

function fitDecorCanvas(cv, host) {
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.width = w + "px";
  cv.style.height = h + "px";
  return { w, h, dpr };
}

/// #23 星夜动态星空：星星带相位/频率各自微闪烁，少数亮星加十字光芒
function startStarfield(cv, host) {
  const ctx = cv.getContext("2d");
  let stars = [];
  let dims = fitDecorCanvas(cv, host);
  const seed = () => {
    const n = Math.min(140, Math.round(dims.w * dims.h / 5200));
    stars = Array.from({ length: n }, () => ({
      x: Math.random() * dims.w, y: Math.random() * dims.h,
      r: 0.5 + Math.random() * 1.4,
      ph: Math.random() * Math.PI * 2,
      sp: 0.4 + Math.random() * 1.3,
      a: 0.3 + Math.random() * 0.6,
      big: Math.random() < 0.08,
    }));
  };
  seed();
  let t = Math.random() * 100;
  const draw = () => {
    ctx.setTransform(dims.dpr, 0, 0, dims.dpr, 0, 0);
    ctx.clearRect(0, 0, dims.w, dims.h);
    for (const s of stars) {
      const tw = REDUCED_MOTION ? 0.8 : 0.55 + 0.45 * Math.sin(t * s.sp + s.ph);
      ctx.globalAlpha = s.a * tw;
      ctx.fillStyle = "#dfe9ff";
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
      if (s.big) {
        ctx.globalAlpha = s.a * tw * 0.45;
        ctx.strokeStyle = "#dfe9ff";
        ctx.lineWidth = 0.5;
        const L = s.r * 3.2;
        ctx.beginPath();
        ctx.moveTo(s.x - L, s.y); ctx.lineTo(s.x + L, s.y);
        ctx.moveTo(s.x, s.y - L); ctx.lineTo(s.x, s.y + L);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  };
  draw();
  if (REDUCED_MOTION) return () => {};
  let raf = 0;
  const frame = () => {
    raf = requestAnimationFrame(frame);
    if (document.hidden) return;
    t += 0.016;
    draw();
  };
  raf = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(raf);
    const d2 = fitDecorCanvas(cv, host); // 尺寸同步（ResizeObserver 触发时）
    dims = d2; seed(); draw();
  };
}

/// #24 樱花飘落：花瓣带左右摇摆与自转，落出纸面后回到顶部
function startSakura(cv, host) {
  const ctx = cv.getContext("2d");
  let petals = [];
  let dims = fitDecorCanvas(cv, host);
  const seed = () => {
    const n = Math.min(14, Math.max(6, Math.round(dims.w * dims.h / 28000)));
    petals = Array.from({ length: n }, () => ({
      x: Math.random() * dims.w,
      y: Math.random() * dims.h,
      vy: 0.16 + Math.random() * 0.3,
      ph: Math.random() * Math.PI * 2,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.01,
      size: 4.5 + Math.random() * 6,
      a: 0.22 + Math.random() * 0.2,
    }));
  };
  seed();
  const drawPetal = (p) => {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot + Math.sin(p.ph) * 0.3);
    ctx.globalAlpha = p.a;
    ctx.fillStyle = "rgba(244, 143, 177, 0.9)";
    ctx.beginPath();
    ctx.ellipse(0, 0, p.size, p.size * 0.62, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = p.a * 0.7;
    ctx.fillStyle = "rgba(255, 228, 238, 0.9)";
    ctx.beginPath();
    ctx.ellipse(-p.size * 0.2, -p.size * 0.12, p.size * 0.55, p.size * 0.32, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };
  const draw = () => {
    ctx.setTransform(dims.dpr, 0, 0, dims.dpr, 0, 0);
    ctx.clearRect(0, 0, dims.w, dims.h);
    for (const p of petals) drawPetal(p);
    ctx.globalAlpha = 1;
  };
  draw();
  if (REDUCED_MOTION) return () => {};
  let raf = 0;
  const frame = () => {
    raf = requestAnimationFrame(frame);
    if (document.hidden) return;
    for (const p of petals) {
      p.ph += 0.008;
      p.y += p.vy;
      p.x += Math.sin(p.ph) * 0.3;
      p.rot += p.vr;
      if (p.y > dims.h + 14) { p.y = -14; p.x = Math.random() * dims.w; }
    }
    draw();
  };
  raf = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(raf);
    dims = fitDecorCanvas(cv, host); seed(); draw();
  };
}

/// #25 羊皮纸手工纹理：SVG 路径控制点每次随机微调（生成 data: URI，
/// 内联不触发外链校验）。返回完整 background-image 值（纹理 + 上下光晕）
export function parchmentBackground() {
  const j = (v, amt) => Math.round(v + (Math.random() - 0.5) * amt);
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='460' height='460'>"
    + "<g fill='none' stroke='#6b4f2a' stroke-opacity='.11' stroke-width='1.1'>"
    + `<path d='M0 ${j(96, 26)} Q ${j(130, 30)} ${j(40, 22)} 230 ${j(116, 26)} T 460 ${j(138, 26)}'/>`
    + `<path d='M-20 ${j(272, 24)} Q ${j(100, 28)} ${j(206, 22)} 216 ${j(270, 24)} T 480 ${j(250, 24)}'/>`
    + `<path d='M${j(66, 18)} 0 Q ${j(150, 26)} ${j(130, 22)} ${j(96, 22)} ${j(256, 20)} T ${j(150, 24)} 460'/>`
    + `<path d='M${j(326, 20)} 0 Q ${j(282, 24)} ${j(152, 22)} ${j(356, 22)} ${j(282, 20)} T ${j(314, 22)} 460'/>`
    + `<circle cx='${j(230, 22)}' cy='${j(230, 22)}' r='${j(74, 14)}' stroke-dasharray='3 8'/>`
    + "</g></svg>";
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}"), `
    + "radial-gradient(130% 100% at 50% 0%, rgba(255, 240, 205, 0.32), transparent 55%), "
    + "radial-gradient(120% 120% at 50% 115%, rgba(92, 58, 18, 0.38), transparent 62%)";
}

/// 按信纸纹理挂载/更换装饰层（在 applyThemeToPaper 内调用）。
/// 返回无；销毁逻辑挂在 paperEl._plDecor 上，换主题自动清理。
export function mountPaperDecor(paperEl, texture) {
  if (!paperEl) return;
  // 清理旧装饰（动画帧 + 内联背景）
  if (paperEl._plDecor) {
    paperEl._plDecor.stop?.();
    paperEl._plDecor.ro?.disconnect?.();
    paperEl._plDecor.cv?.remove();
    paperEl._plDecor = null;
  }
  paperEl.style.removeProperty("background-image"); // 恢复 CSS 默认

  if (texture === "parchment") {
    paperEl.style.backgroundImage = parchmentBackground(); // #25 每张纸纹理略不同
    return;
  }
  if (texture !== "starry" && texture !== "sakura") return;

  const cv = document.createElement("canvas");
  cv.className = "paper-decor";
  cv.setAttribute("aria-hidden", "true");
  paperEl.insertBefore(cv, paperEl.firstChild); // 置于墨迹画布之下
  const stop = texture === "starry" ? startStarfield(cv, paperEl) : startSakura(cv, paperEl);

  // 信纸尺寸变化（布局重排 / 全屏 / 重放层缩放）时同步装饰画布
  let ro = null;
  const onResize = () => stop(); // stop 内部会重取尺寸并补一帧静态画面
  if (typeof ResizeObserver === "function") {
    ro = new ResizeObserver(onResize);
    ro.observe(paperEl);
  } else {
    window.addEventListener("resize", onResize);
  }
  paperEl._plDecor = {
    cv, stop,
    ro,
    destroy() {
      stop();
      ro ? ro.disconnect() : window.removeEventListener("resize", onResize);
      cv.remove();
    },
  };
}

// v3.34：各页面脚本引入本模块时（DOM 已就绪）立即起播加载屏粒子开场
startLoadingFx();
