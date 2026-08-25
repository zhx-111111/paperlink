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
  get inkRosegold() { return localStorage.getItem("pl_rosegold") === "1"; },
  set inkRosegold(v) { localStorage.setItem("pl_rosegold", v ? "1" : "0"); },
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

export function hideLoading() {
  const el = document.getElementById("app-loading");
  if (!el) return;
  setTimeout(() => {
    el.classList.add("fade");
    setTimeout(() => el.remove(), 700);
  }, 300);
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
  el.classList.toggle("egg-frame", !!opts.frame && hasEgg("E5"));
}

// ---------------------------------------------------------------- themes

let themeRegistry = [];
let rosegoldInk = "#c9737f";

export async function loadThemes() {
  try {
    const cfg = await (await fetch("/api/config")).json();
    themeRegistry = (cfg.themes || []).map((t) => ({ ...t, custom: false }));
    rosegoldInk = cfg.rosegoldInk || rosegoldInk;
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
export function getRosegoldInk() { return rosegoldInk; }

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

let tplStyleEl = null;
export function applyThemeToPaper(paperEl, theme, inkOverride = null) {
  paperEl.classList.remove("texture-tom", "texture-parchment", "texture-midnight", "texture-letter", "texture-starry", "texture-sakura", "texture-custom");
  const tex = theme.texture || "letter";
  paperEl.classList.add("texture-" + tex);
  const ink = inkOverride || (store.inkRosegold && hasEgg("E3") ? rosegoldInk : theme.ink);
  paperEl.style.setProperty("--ink-color", ink);
  paperEl.dataset.ink = ink;

  // v3 自定义信纸：信纸基色走选色器（--paper-color 由 .texture-custom 消费）
  if (theme.custom && theme.paper) {
    paperEl.style.setProperty("--paper-color", theme.paper);
  } else {
    paperEl.style.removeProperty("--paper-color");
  }

  if (tplStyleEl) { tplStyleEl.remove(); tplStyleEl = null; }
  if (theme.custom && theme.template?.css) {
    tplStyleEl = document.createElement("style");
    tplStyleEl.textContent = theme.template.css;
    document.head.appendChild(tplStyleEl);
    paperEl.dataset.templateId = theme.template.id;
    paperEl.dataset.bgAsset = theme.template.bgAssetId ? `/api/template/asset/${theme.template.bgAssetId}` : "";
    if (theme.template.bgAssetId) {
      paperEl.style.setProperty("--tpl-bg", `url(/api/template/asset/${theme.template.bgAssetId})`);
    }
  } else {
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
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); done(); } catch { /* ok */ }
  ta.remove();
}

export function confirmDialog(msg) { return window.confirm(msg); }

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

// ------------------------------------------------- scramble text (v3.3)
// 文字「解码」动效，思路取自 canvas-ui 的 DecryptReveal：
// 乱码逐位落定为最终文字，用在信件打开等仪式感时刻。

const SCRAMBLE_POOL = "PaperLink✎✉*·—~";

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
    const reveal = Math.floor(chars.length * t);
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
