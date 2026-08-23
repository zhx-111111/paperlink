// PaperLink — 前端共享模块：会话、API、toast、头像、主题。
// 用户信息本地化（SPEC §6.1）：昵称/头像/主题偏好/彩蛋解锁存 localStorage，
// KV 只保留 sid→lastSeen 与房间/信页。

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
  get eggs() {
    try { return JSON.parse(localStorage.getItem("pl_eggs") || "[]"); } catch { return []; }
  },
  set eggs(arr) { localStorage.setItem("pl_eggs", JSON.stringify(arr)); },
  get inkRosegold() { return localStorage.getItem("pl_rosegold") === "1"; },
  set inkRosegold(v) { localStorage.setItem("pl_rosegold", v ? "1" : "0"); },
  get letterPref() { return localStorage.getItem("pl_letter_pref") || "banner"; },
  set letterPref(v) { localStorage.setItem("pl_letter_pref", v); },
  clearSession() {
    for (const k of ["pl_token", "pl_sid", "pl_dev", "pl_room", "pl_room_name"]) localStorage.removeItem(k);
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
  if (!resp.ok) throw Object.assign(new Error(data.error || "http " + resp.status), { code: data.error });
  return data;
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

/// 6 个预设手写风头像（SPEC §2.1.2）
const AVATAR_HUES = [262, 205, 150, 30, 340, 48];
const AVATAR_DOODLES = [
  "M30 62 Q 40 38 50 58 T 70 50",            // 波浪
  "M50 30 L 56 46 L 73 46 L 59 56 L 64 72 L 50 62 L 36 72 L 41 56 L 27 46 L 44 46 Z", // 星
  "M50 68 C 30 54 34 36 50 44 C 66 36 70 54 50 68 Z", // 心
  "M66 34 A 18 18 0 1 0 66 66 A 22 22 0 1 1 66 34 Z", // 月
  "M32 60 Q 50 30 68 60 M40 60 Q 50 44 60 60",        // 山
  "M34 40 h32 M34 50 h32 M34 60 h20",                 // 信
];

export function avatarSvg(i, cls = "") {
  const h = AVATAR_HUES[((i % 6) + 6) % 6];
  const d = AVATAR_DOODLES[((i % 6) + 6) % 6];
  return `<svg viewBox="0 0 100 100" class="${cls}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="50" cy="50" r="50" fill="hsl(${h}, 62%, 74%)"/>
    <circle cx="50" cy="50" r="50" fill="url(#none)"/>
    <path d="${d}" fill="${i % 6 === 1 || i % 6 === 2 ? "rgba(255,255,255,0.92)" : "none"}"
      stroke="rgba(255,255,255,0.92)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

export function mountAvatar(el, i, opts = {}) {
  if (!el) return;
  el.innerHTML = avatarSvg(i);
  el.classList.toggle("egg-frame", !!opts.frame && store.eggs.includes("E5"));
}

// ---------------------------------------------------------------- themes

/// 主题注册表 = 服务端基础/彩蛋主题 + 已启用模板
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
        id: t.id, name: t.name, custom: true, template: t,
        paper: "#f5f0e4", ink: t.inkColor || "#241812", texture: "custom",
      });
    }
  } catch { /* ok */ }
  return themeRegistry;
}

export function getThemes() { return themeRegistry; }
export function getRosegoldInk() { return rosegoldInk; }

export function themeById(id) {
  return themeRegistry.find((t) => t.id === id) || themeRegistry.find((t) => !t.egg && !t.custom) || themeRegistry[0];
}

/// 解锁判定：基础 4 套永远可用；彩蛋主题需解锁；模板主题始终可用（运营上架即解锁，SPEC §7.2.54）
export function themeUnlocked(t) {
  if (!t) return false;
  if (!t.egg) return true;
  return store.eggs.includes(t.id);
}

/// 把主题应用到信纸元素（含模板注入样式）
let tplStyleEl = null;
export function applyThemeToPaper(paperEl, theme, inkOverride = null) {
  paperEl.classList.remove("texture-tom", "texture-parchment", "texture-midnight", "texture-letter", "texture-starry", "texture-sakura", "texture-custom");
  const tex = theme.texture || "letter";
  paperEl.classList.add("texture-" + tex);
  const ink = inkOverride || (store.inkRosegold && store.eggs.includes("E3") ? rosegoldInk : theme.ink);
  paperEl.style.setProperty("--ink-color", ink);
  paperEl.dataset.ink = ink;

  // 模板主题：注入上传的 CSS（服务端已校验作用域）
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

/// 主题缩略（大厅书封 / 弹层预览用）
export function themeThumbCss(t) {
  if (t.texture === "midnight") return "background:#000";
  if (t.texture === "starry") return "background:radial-gradient(1.5px 1.5px at 20% 30%, #fff, transparent), radial-gradient(1px 1px at 70% 60%, #fff, transparent), #0d1533";
  if (t.texture === "sakura") return "background:radial-gradient(10px 7px at 30% 40%, rgba(244,143,177,0.6), transparent), #fdeef2";
  if (t.texture === "tom") return "background:linear-gradient(160deg,#ecdcae,#dcc189)";
  if (t.texture === "parchment") return "background:linear-gradient(160deg,#d3b47c,#c09a5d)";
  return `background:${t.paper}`;
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
