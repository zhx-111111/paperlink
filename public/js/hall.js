// PaperLink — /hall：对话大厅（书架 + 搜索 + 创建/加入 + 5 上限）

import { store, api, apiJson, toast, relTime, hideLoading, loadThemes, themeById, themeThumbCss, copyText, confirmDialog, escapeHtmlSafe, mountIcons, icon, truncName, I18N } from "./shared.js";
import { InkClouds, RainDrops, WeatherAmbience, INK_CLOUD_COLORS, FluidGlass } from "./canvasui.js";
import { CuClouds, CuDroplets } from "./canvasui-cu.js"; // v3.24：canvas-ui 体积云（WebGL2 可用时接管大厅氛围）；v3.80：小雨玻璃质感层

const $ = (id) => document.getElementById(id);
let conversations = [];
let menuTarget = null;

/// v3.54 邀请码靠近聚焦：与加入页同一手感（React Bits VariableProximity 思路，
/// 原生重写）——输入文字透明、镜像层逐字渲染，光标靠近放大变清晰、远离缩小变淡。
/// 偏好减少动态时不挂载，退回普通输入框。
function mountSearchProximity() {
  const input = $("hall-search"), mirror = $("hall-code-mirror");
  if (!input || !mirror) return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  input.classList.add("code-live");
  const R = 90; // 聚焦半径（px）
  let spans = [];
  const sync = () => {
    const v = input.value;
    mirror.textContent = "";
    spans = [...v].map((ch) => {
      const s = document.createElement("span");
      s.textContent = ch;
      mirror.appendChild(s);
      return s;
    });
  };
  input.addEventListener("input", sync);
  sync();
  input.parentElement.addEventListener("pointermove", (e) => {
    for (const s of spans) {
      const r = s.getBoundingClientRect();
      const d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
      const k = Math.max(0, 1 - d / R); // 1=光标正中，0=半径之外
      s.style.transform = `scale(${(1 + 0.4 * k).toFixed(3)})`;
      s.style.opacity = (0.55 + 0.45 * k).toFixed(3);
    }
  });
  input.parentElement.addEventListener("pointerleave", () => {
    for (const s of spans) { s.style.transform = ""; s.style.opacity = ""; }
  });
}

async function boot() {
  if (!store.token || !store.sid) { location.href = "/join"; return; }
  mountIcons();
  hideLoading();
  mountSearchProximity(); // v3.54 邀请码靠近聚焦（偏好减少动态时自动跳过）
  // v3.23 #32：空状态文案统一从字典取
  $("hall-empty").innerHTML = I18N.hallEmpty;
  // v3.2 修复：书脊封面依赖主题注册表，必须先加载，否则渲染第一本书就崩、整个书架空白
  await loadThemes();
  // v3.5：canvas-ui Clouds 思路——墨云缓慢漂移氛围底（尊重减少动态效果设置）
  // v3.16 #6：云色随当前信纸主题取色（星夜深蓝紫 / 樱花粉…），氛围与纸面统一
  // v3.24：WebGL2 浏览器升级用 canvas-ui Clouds 原组件（体积云、鼠标可吹开），
  // 不可用时无缝回退自研 2D 墨云
  const tex = themeById(store.theme)?.texture || "letter";
  const cuClouds = new CuClouds($("hall-ambient"));
  if (cuClouds.ok) {
    cuClouds.setThemeColor(INK_CLOUD_COLORS[tex] || INK_CLOUD_COLORS.letter);
    cuClouds.start();
  } else {
    cuClouds.stop();
    const clouds = new InkClouds($("hall-ambient"), { alpha: 0.06, count: 7 });
    clouds.setTheme(tex);
    clouds.start();
  }
  await refresh();

  // v3.93：大厅的玻璃底下也有流体在流（减少动态偏好不启动）
  if (!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) {
    new FluidGlass($("hall-fluid"), { alpha: 0.15 }).start();
  }

  // v3.80：天气彩蛋也落进大厅——偏好与缓存和书写房共用（同一对本地键），
  // 哪页先访哪页先问；之后每 120 分钟静默刷新一次
  maybeStartWeather();
  setInterval(maybeStartWeather, WEATHER_POLL_MS);

  $("btn-create").addEventListener("click", () => openNameDialog());
  $("btn-join").addEventListener("click", joinFromSearch);
  $("hall-back").addEventListener("click", () => (location.href = "/"));
  $("hall-search").addEventListener("keydown", (e) => { if (e.key === "Enter") joinFromSearch(); });
  $("hall-search").addEventListener("input", filterLocal);

  // ⋯ 菜单（点菜单外关闭；点 ⋯ 按钮本身也放行，否则刚打开就被本监听关掉）
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#card-menu") && !e.target.closest(".menu-btn")) $("card-menu").classList.add("hidden");
  });
  $("menu-rename").addEventListener("click", renameTarget);
  $("menu-invite").addEventListener("click", () => { if (menuTarget) copyText(menuTarget.code); });
  $("menu-delete").addEventListener("click", deleteTarget);

  // 命名弹层
  $("dlg-cancel").addEventListener("click", () => $("theme-popup").classList.add("hidden"));
  $("dlg-ok").addEventListener("click", createRoom);
}

async function refresh() {
  try {
    const data = await apiJson("/api/hall");
    conversations = data.conversations || [];
  } catch { conversations = []; }
  render("", true); // v3.55：数据刷新才播入场（键入过滤走 render() 不动画）
}

function render(filter = "", animate = false) {
  const shelf = $("bookshelf");
  shelf.innerHTML = "";
  const q = filter.trim().toUpperCase();
  const list = conversations.filter((c) =>
    !q || c.code === q || c.name.toUpperCase().includes(q));

  $("hall-empty").classList.toggle("hidden", list.length > 0);

  let i = 0;
  for (const c of list) {
    const idx = i++; // v3.55：入场错峰用
    const t = themeById(c.theme) || { ink: "#37324a", paper: "#e9e7f4" };
    const card = document.createElement("div");
    card.className = "book-card";
    card.innerHTML = `
      <div class="cover" style="${themeThumbCss(t)}">
        <div class="spine"></div>
        <div class="title-hand" style="color:${t.ink}">${escapeHtmlSafe(truncName(c.name))}</div>
        ${c.unread > 0 ? `<div class="unread-badge">${c.unread}</div>` : ""}
      </div>
      <div class="info">
        <span>${c.pages} 页 · ${c.hasPartner ? "2 人" : "1 人"}</span>
        <span>${relTime(c.lastActiveAt)}</span>
      </div>
      <button class="menu-btn" title="更多">${icon("more", 16)}</button>`;
    card.addEventListener("click", (e) => {
      if (e.target.closest(".menu-btn")) {
        openCardMenu(c, e.target.closest(".menu-btn"));
        return;
      }
      store.roomCode = c.code;
      store.roomName = c.name;
      location.href = "/";
    });
    if (animate) { // v3.55：书一本本弹上书架（错峰 55ms，减少动态时 CSS 端禁用）
      card.classList.add("enter");
      card.style.animationDelay = (idx * 55) + "ms";
    }
    shelf.appendChild(card);
  }
}

function filterLocal() {
  const q = $("hall-search").value.trim().toUpperCase();
  // 非 9 位 → 仅本地过滤已有对话（SPEC §2.2.9）
  if (!/^[A-Z]\d{8}$/.test(q)) render(q);
  else render();
}

function openCardMenu(conv, btn) {
  menuTarget = conv;
  const menu = $("card-menu");
  menu.classList.remove("hidden");
  const r = btn.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(window.innerWidth - 170, r.left - 120)) + "px";
  menu.style.top = Math.min(window.innerHeight - 140, r.bottom + 6) + "px";
}

async function renameTarget() {
  $("card-menu").classList.add("hidden");
  if (!menuTarget) return;
  const name = prompt("新的对话名（1–24 字）", menuTarget.name);
  if (!name || !name.trim()) return;
  try {
    await apiJson("/api/room/rename", { method: "POST", body: JSON.stringify({ code: menuTarget.code, name: name.trim() }) });
    toast("已重命名 ✓", 1400);
    refresh();
  } catch (e) { toast("重命名失败：" + e.message); }
}

async function deleteTarget() {
  $("card-menu").classList.add("hidden");
  if (!menuTarget) return;
  if (!confirmDialog(`删除「${menuTarget.name}」？信页与归档将一并清除，不可恢复。`)) return;
  try {
    await apiJson("/api/room/delete", { method: "POST", body: JSON.stringify({ code: menuTarget.code }) });
    if (store.roomCode === menuTarget.code) store.roomCode = "";
    toast("已删除", 1400);
    refresh();
  } catch (e) {
    if (e.code === "host_only") {
      // 非创建者 → 退出
      if (!confirmDialog("你不是创建者，无法删除。要退出这个对话吗？")) return;
      try {
        await apiJson("/api/room/leave", { method: "POST", body: JSON.stringify({ code: menuTarget.code }) });
        if (store.roomCode === menuTarget.code) store.roomCode = "";
        refresh();
      } catch { /* ok */ }
    } else toast("删除失败：" + e.message);
  }
}

function openNameDialog() {
  $("dlg-name").value = "";
  $("theme-popup").classList.remove("hidden");
  $("dlg-name").focus();
}

async function createRoom() {
  const name = $("dlg-name").value.trim();
  try {
    const data = await apiJson("/api/room/create", { method: "POST", body: JSON.stringify({ name }) });
    $("theme-popup").classList.add("hidden");
    store.roomCode = data.room.code;
    store.roomName = data.room.name;
    toast(`已创建「${data.room.name}」，把邀请码 ${data.room.code} 交给 TA`, 3000);
    location.href = "/";
  } catch (e) {
    if (e.code === "conv_limit") {
      toast("对话已达 5 个上限，请先删除一个旧对话", 2600);
    } else toast("创建失败：" + e.message);
  }
}

async function joinFromSearch() {
  const code = $("hall-search").value.trim().toUpperCase();
  if (!/^[A-Z]\d{8}$/.test(code)) {
    toast("请输入 9 位邀请码（1 字母 + 8 数字）", 2200);
    return;
  }
  try {
    const data = await apiJson("/api/room/join", { method: "POST", body: JSON.stringify({ code }) });
    store.roomCode = data.room.code;
    store.roomName = data.room.name;
    location.href = "/";
  } catch (e) {
    const msgs = {
      not_found: "找不到这个邀请码对应的日记本",
      room_full: "该日记本已有两位主人",
      conv_limit: "你的对话已达 5 个上限，请先删除一个旧对话",
      code_format: "邀请码格式不对",
    };
    toast(msgs[e.code] || ("加入失败：" + e.message), 2600);
  }
}

// ================================================================ v3.80 天气彩蛋（与书写房同源）
// 约定与书写房一致：首次确认、天气缓存、轮询周期共用同一对本地键——
// 一边答应过另一边不再问；定位只用 Cloudflare 由 IP 现算的经纬度，单次使用不落库；
// 任何失败静默降级，绝不影响大厅浏览。
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
    if (!weatherFx) weatherFx = new RainDrops(cv, { alpha: 0.16 }); // 大厅没有纸面，不接闪电泛光
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

/// 首次确认卡片（与书写房同款，文案按大厅说）
function weatherConsentCard() {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "consent-overlay";
    wrap.innerHTML = `
      <div class="consent-card" role="dialog" aria-modal="true" aria-label="天气彩蛋">
        <div class="consent-emoji" aria-hidden="true">🌧️</div>
        <h3>天气彩蛋</h3>
        <p>你所在的城市下雨或下雪时，让雨滴 / 雪花也落进对话大厅。</p>
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
  } catch { /* 彩蛋任何异常都不允许影响大厅 */ }
}

boot();
