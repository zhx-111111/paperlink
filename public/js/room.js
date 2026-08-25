// PaperLink — 书写房主控 v2：WS 实时通讯、双模式、同速重放（全屏播放）、
// 书信集、riddle 式同心圆主题栏（只显示拥有的）、横竖屏镜像、3 秒轮询、
// 翻页镜像、长按橡皮调大小、多端全屏降级。

import { InkPad } from "./inkpad.js";
import {
  store, api, apiJson, toast, relTime, hideLoading, refreshMe,
  mountAvatar, avatarSvg, loadThemes, getThemes, themeById, themeUnlocked,
  applyThemeToPaper, themeThumbCss, copyText, mountIcons, icon, hasEgg,
  setupSecretTap,
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
  bannerCount: 0,
  bannerTimer: 0,
  lastInput: Date.now(),
  writing: false,
  localAspect: PORTRAIT,
  remoteAspect: null,
  remoteAspectTimer: 0,
  liveChunks: new Map(),
  remoteIds: new Set(),
  replayQueue: [],
  replaying: false,
  cursorAcc: 0,
  liveAcc: 0,
  pingTimer: 0,
  liveTimer: 0,
  sending: false,
  cssFullscreen: false,   // 原生全屏不可用时的 CSS 兜底
  forceLandscape: false, // 全屏内强制横屏（不支持方向锁时 CSS 旋转兜底）
  eraserHold: 0,
};

let pad;
const paper = $("paper");
const inkCanvas = $("ink-canvas");

// ================================================================ 会话守卫

function guard() {
  if (!store.token || !store.sid) { location.href = "/join"; return false; }
  if (!store.roomCode) { location.href = "/hall"; return false; }
  return true;
}

// ================================================================ 纸张布局

function localAspect() {
  // 全屏时信纸铺满屏幕 → 以视口比例为准（并广播，对端强制跟随）
  if (fullscreenElement() || state.cssFullscreen) {
    return Math.max(0.2, Math.min(5, window.innerWidth / Math.max(1, window.innerHeight)));
  }
  if (state.forceLandscape) return LANDSCAPE;
  // v3：非全屏时信纸长宽比 = 设备屏幕长宽比
  return Math.max(0.2, Math.min(5, window.innerWidth / Math.max(1, window.innerHeight)));
}
function effectiveAspect() {
  return state.remoteAspect || state.localAspect;
}

function paperSize() {
  const stage = $("stage");
  const sw = stage.clientWidth, sh = stage.clientHeight;
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
  pad.penScale = Math.max(0.8, Math.min(1.6, w / 700));
}

function onViewportChange() {
  const a = localAspect();
  if (a !== state.localAspect) {
    state.localAspect = a;
    send({ t: "aspect", a }); // 横竖屏/全屏比例强制镜像
  }
  paperSize();
}

function applyRemoteAspect(a) {
  const na = Math.max(0.2, Math.min(5, Number(a) || PORTRAIT));
  state.remoteAspect = na;
  clearTimeout(state.remoteAspectTimer);
  state.remoteAspectTimer = setTimeout(() => {
    state.remoteAspect = null;
    paperSize();
  }, 10000);
  paperSize();
}

// ================================================================ 主题

function currentInk() { return paper.dataset.ink || "#241812"; }

function applyTheme(theme, broadcast = false) {
  const ink = applyThemeToPaper(paper, theme);
  pad.setColor(ink);
  store.theme = theme.id;
  renderThemeBar();
  if (broadcast) send({ t: "theme_change", theme: theme.id });
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
    b.style.background = themeThumbCss(t);
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

function send(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    try { state.ws.send(JSON.stringify(obj)); } catch { /* ok */ }
  }
}

function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/api/ws?room=${encodeURIComponent(store.roomCode)}&token=${encodeURIComponent(store.token)}`;
  const ws = new WebSocket(url);
  state.ws = ws;
  window.__plWs = ws;

  ws.onopen = () => {
    state.wsRetry = 0;
    send({ t: "hello", nick: store.nick, avatar: store.avatar, mode: state.mode });
    send({ t: "aspect", a: state.localAspect });
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
    renderPartnerBadge();
    if (e.code === 4001) {
      toast("已在别处登录", 3000);
      store.clearSession();
      setTimeout(() => (location.href = "/join"), 1200);
      return;
    }
    state.wsRetry = Math.min(state.wsRetry + 1, 6);
    setTimeout(connectWs, 800 * state.wsRetry);
  };
}

function handleWsEvent(ev) {
  switch (ev.t) {
    case "welcome":
      updatePresence(ev.peers || []);
      if (ev.mode && ev.mode !== state.mode) setMode(ev.mode, false);
      break;
    case "presence":
      updatePresence(ev.peers || []);
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
    case "erase_at": onPartnerErase(ev); break;
    case "undo": onPartnerUndo(ev); break;
    case "clear_all": onPartnerClear(); break;
    case "page_turn": onPartnerPageTurn(); break;
    case "theme_change":
      applyForcedTheme(ev.theme);
      toast("对方换了信纸，已为你同步", 1600);
      break;
    case "mode_change":
      if (ev.mode === "realtime" || ev.mode === "letter") setMode(ev.mode, false);
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
    case "read_ack":
      state.pending = 0;
      updateSendBar();
      toast("对方正在读你的信", 1500);
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
      state.pending = d.unreadTheirs;
      updateSendBar();
    }
    if (typeof d.unreadMine === "number" && d.unreadMine !== state.unread) {
      state.unread = d.unreadMine;
      updateBadge();
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

  if (state.partner) {
    // 对方在线：完整徽章；收起的迷你挂饰隐藏
    clearTimeout(state.waitTimer); state.waitTimer = 0;
    mini?.classList.add("hidden");
    el.classList.remove("hidden", "online", "offline");
    mountAvatar($("partner-avatar"), state.partner.avatar);
    nameEl.textContent = state.partner.nick || "另一位主人";
    statusEl.textContent = "在线";
    el.classList.add("online");
  } else if (state.room.members >= 2) {
    clearTimeout(state.waitTimer); state.waitTimer = 0;
    mini?.classList.add("hidden");
    el.classList.remove("hidden", "online", "offline");
    $("partner-avatar").innerHTML = "";
    nameEl.textContent = "另一位主人";
    statusEl.textContent = state.partnerOnline ? "在线" : "离线";
    el.classList.add(state.partnerOnline ? "online" : "offline");
  } else {
    // 等待另一位主人：横幅 5 秒后自动缩小为头像框+在线状态，固定在「我的」下方
    el.classList.remove("hidden", "online", "offline");
    $("partner-avatar").innerHTML = "";
    nameEl.textContent = "等待另一位主人…";
    statusEl.textContent = "把邀请码交给 TA";
    if (!state.waitTimer) {
      state.waitTimer = setTimeout(() => {
        state.waitTimer = 0;
        el.classList.add("hidden");
        if (mini && state.room && state.room.members < 2 && !state.partner) {
          mini.classList.remove("hidden");
          mini.classList.toggle("online", state.partnerOnline);
        }
      }, 5000);
    }
  }
}

// ================================================================ 书写

function wirePad() {
  pad.onStrokeEnd = (stroke) => {
    markInput();
    if (state.mode === "realtime") {
      send({ t: "stroke", id: stroke.id, pts: normPts(stroke.pts), color: currentInk(), durationMs: stroke.durationMs, a: effectiveAspect(), ps: pad.penScale });
    }
    scheduleE6Fade(stroke.id);
    updateSendBar();
  };
  pad.onLiveChunk = (id, chunk) => {
    if (state.mode !== "realtime") return;
    const nowT = performance.now();
    const cfg = window.__plConfig || {};
    const gap = cfg.cursorSyncIntervalMs || 200;
    if (nowT - state.liveAcc < gap) return;
    state.liveAcc = nowT;
    send({ t: "drawing", id, pts: chunk.map(([x, y, p, t]) => [Math.round(x / pad.w * VW), Math.round(y / pad.h * VH), Math.round(p * 100) / 100, t]), color: currentInk(), a: effectiveAspect(), ps: pad.penScale });
  };
  pad.onEraseAt = (x, y, r) => {
    send({ t: "erase_at", x: x / pad.w * VW, y: y / pad.h * VH, r: r / pad.w * VW });
  };
  // 双指擦除打断了进行中的笔画 → 通知对端丢弃半截轨迹，两端保持一致
  pad.onTwoFingerStart = (cancelledId) => {
    if (state.mode === "realtime" && cancelledId != null) send({ t: "live_cancel", id: cancelledId });
  };

  inkCanvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    markInput();
    state.remoteAspect = null;
    if (localAspect() !== effectiveAspect()) paperSize();
    send({ t: "aspect", a: effectiveAspect() });
    setWriting(true);
    if (pad.eraseTool) showEraserRing(e);
    pad.pointerDown(e);
  });
  inkCanvas.addEventListener("pointermove", (e) => {
    e.preventDefault();
    if (pad.erasing) showEraserRing(e);
    pad.pointerMove(e);
    const cfg = window.__plConfig || {};
    const gap = cfg.cursorSyncIntervalMs || 200;
    const nowT = performance.now();
    if (state.partnerOnline && nowT - state.cursorAcc > gap) {
      state.cursorAcc = nowT;
      const pos = pad.toLocal(e);
      send({ t: "cursor", x: pos.x / pad.w, y: pos.y / pad.h });
    }
  });
  const up = (e) => {
    pad.pointerUp(e);
    setWriting(false);
    $("eraser-ring").style.display = "none";
    updateSendBar();
  };
  inkCanvas.addEventListener("pointerup", up);
  inkCanvas.addEventListener("pointercancel", up);
  inkCanvas.addEventListener("contextmenu", (e) => e.preventDefault());
}

function normPts(pts) {
  return pts.map(([x, y, p, t]) => [
    Math.round(x / pad.w * VW * 10) / 10,
    Math.round(y / pad.h * VH * 10) / 10,
    p, t,
  ]);
}

function setWriting(on) {
  state.writing = on;
  document.body.classList.toggle("writing", on);
}
function markInput() { state.lastInput = Date.now(); }

function scheduleE6Fade(strokeId) {
  if (!hasEgg("E6")) return;
  setTimeout(() => {
    const start = performance.now();
    const tick = (nowT) => {
      const t = Math.min(1, (nowT - start) / 700);
      pad.fadeMap.set(strokeId, 1 - t * 0.85);
      pad.redraw();
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, 3000);
}

// ================================================================ 重放

function onPartnerStroke(ev) {
  if (ev.a && Math.abs(ev.a - effectiveAspect()) > 0.05) applyRemoteAspect(ev.a);
  state.liveChunks.delete(ev.id);
  pad.redraw();
  enqueueReplay({ id: ev.id, pts: ev.pts, durationMs: ev.durationMs, color: ev.color, ps: ev.ps });
  markInput();
}

/// 宽度换算：对端笔宽按对方 penScale 计算，本端按本地比例折算，两端笔迹一致
function remoteW(ev, p) {
  const w = pad.widthFor(p || 0.5);
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
  for (let i = Math.max(1, hist.length); i < seq.length; i++) {
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
  state.liveChunks.set(ev.id, seq.slice(-2));
}

function enqueueReplay(item) {
  state.replayQueue.push(item);
  if (!state.replaying) nextReplay();
}

function nextReplay() {
  const item = state.replayQueue.shift();
  if (!item) { state.replaying = false; return; }
  state.replaying = true;

  const pts = item.pts.map(([x, y, p, t]) => ({
    x: x / VW * pad.w, y: y / VH * pad.h, p, t, w: remoteW(item, p),
  }));
  if (!pts.length) { nextReplay(); return; }
  const dur = Math.max(item.durationMs || pts[pts.length - 1].t || 1, 1);
  const start = performance.now();
  let idx = 0;
  const ctx = pad.ctx;

  const drawSeg = (i) => {
    ctx.strokeStyle = item.color; ctx.fillStyle = item.color;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.globalAlpha = 0.97;
    if (i === 0) {
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, pts[0].w / 2, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
      ctx.lineWidth = (pts[0].w + pts[1].w) / 2;
      ctx.stroke();
    } else if (i < pts.length - 1) {
      const a = pts[i - 1], b = pts[i], c = pts[i + 1];
      ctx.beginPath();
      ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
      ctx.quadraticCurveTo(b.x, b.y, (b.x + c.x) / 2, (b.y + c.y) / 2);
      ctx.lineWidth = b.w;
      ctx.stroke();
    }
  };

  const step = (nowT) => {
    const el = nowT - start;
    ctx.save();
    while (idx < pts.length - 1 && pts[idx + 1].t <= el) { drawSeg(idx); idx++; }
    if (idx === 0 && pts.length === 1) drawSeg(0);
    ctx.restore();
    if (idx < pts.length - 1 && el < dur + 200) {
      requestAnimationFrame(step);
    } else {
      pad.addRemoteStroke({
        id: item.id,
        pts: item.pts.map(([x, y, p, t]) => [x / VW * pad.w, y / VH * pad.h, p, t]),
        durationMs: dur,
      }, item.color);
      state.remoteIds.add(item.id);
      pad.redraw();
      nextReplay();
    }
  };
  requestAnimationFrame(step);
}

function onPartnerErase(ev) {
  const r = ev.r != null ? ev.r / VW * pad.w : 18;
  pad.eraseAt({ x: ev.x / VW * pad.w, y: ev.y / VH * pad.h }, r, true);
}

function onPartnerUndo() {
  if (!pad.removeLastOf(state.remoteIds)) pad.undo();
}

async function onPartnerClear() {
  await pad.dissolve(800);
  pad.reset();
  state.remoteIds.clear();
  state.replayQueue = [];
  toast("对方清空了这一页", 1500);
}

/// v2：对方新开一页 → 本端同步翻到空白页
async function onPartnerPageTurn() {
  await pad.dissolve(500);
  pad.reset();
  state.remoteIds.clear();
  updateSendBar();
  toast("对方翻开了新的一页", 1500);
}

function onPartnerCursor(ev) {
  const el = $("partner-cursor");
  el.style.display = "block";
  el.style.left = (ev.x * pad.w) + "px";
  el.style.top = (ev.y * pad.h) + "px";
  clearTimeout(el._hide);
  el._hide = setTimeout(() => (el.style.display = "none"), 1200);
}

// ================================================================ 模式

function setMode(mode, broadcast = true) {
  const want = mode === "realtime" ? "realtime" : "letter";
  if (want === "realtime" && broadcast && !hasEgg("RT")) {
    toast("实时镜像需用兑换码解锁", 3000);
    return;
  }
  state.mode = want;
  store.mode = want;
  $("btn-mode").classList.toggle("active", want === "realtime");
  updateSendBar();
  if (broadcast) send({ t: "mode_change", mode: want });
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
  if (state.sending || !pad.hasInk()) return;
  if (state.pending >= state.pendingLimit) {
    toast(`TA 还有 ${state.pending} 页信没打开，先让 TA 去书信集看看`, 2600);
    return;
  }
  state.sending = true;
  updateSendBar();
  const pageData = pad.exportPage();
  const cfg = window.__plConfig || {};
  if (pageData.points > (cfg.maxPtsPerPage || 5000)) {
    toast("写得太满，建议翻页", 2200);
  }
  await pad.dissolve(900);
  try {
    const data = await apiJson("/api/page/commit", {
      method: "POST",
      body: JSON.stringify({
        code: store.roomCode,
        page: {
          pts: pageData.strokes.map((s) => normPts(s.pts)),
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
    state.pending = data.pending ?? state.pending + 1;
    state.pendingLimit = data.limit ?? state.pendingLimit;
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
      toast("寄出失败：" + (e.message || "网络错误"), 2500);
    }
  }
  state.sending = false;
  updateSendBar();
}

// ================================================================ 书信集

async function loadLetters(openDrawer = false) {
  try {
    const data = await apiJson(`/api/conversation/${encodeURIComponent(store.roomCode)}`);
    state.letters = data.pages || [];
    renderLetters();
    if (openDrawer) openLetterDrawer();
  } catch { /* ok */ }
}

function renderLetters() {
  const list = $("letter-list");
  list.innerHTML = "";
  if (!state.letters.length) {
    list.innerHTML = `<div class="drawer-empty">还没有信。<br>写一页，点「发送」寄给 TA。</div>`;
    return;
  }
  for (const p of state.letters.slice().reverse()) {
    const t = themeById(p.theme);
    const item = document.createElement("div");
    item.className = "letter-item";
    const mine = p.author === store.sid;
    // v2：不显示每页笔数
    item.innerHTML = `
      <div class="thumb" style="${themeThumbCss(t)}"></div>
      <div class="meta">
        <div class="who"><span class="avatar" data-av="${p.authorAvatar}"></span>${escapeHtml(p.authorNick || (mine ? "我" : "TA"))}${mine ? "（我）" : ""}</div>
        <div class="when">${relTime(p.ts)}</div>
      </div>
      <span class="open-hint">打开此页</span>`;
    item.querySelector(".avatar").innerHTML = avatarSvg(p.authorAvatar || 0);
    item.addEventListener("click", () => openLetter(p));
    list.appendChild(item);
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

  state.letters.push(page);
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
  clearTimeout(state.bannerTimer);
  state.bannerTimer = setTimeout(() => {
    if (Date.now() - state.lastInput > idleMs && !pad.hasInk()) openLetterDrawer();
    else setTimeout(() => $("new-letter-banner").classList.add("hidden"), 6000);
  }, idleMs);
}

// ------------------------------- 信件重放：全屏（或按对方比例尽量最大化）

let ov = null;

function openLetter(page) {
  closeLetterDrawer();
  const overlay = $("letter-overlay");
  const op = $("overlay-paper");
  const canvas = $("overlay-canvas");
  overlay.classList.remove("hidden");
  overlay.classList.add("fs-play"); // CSS 全屏播放层

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
  $("overlay-who").textContent = `${page.authorNick || "TA"} · ${relTime(page.ts)}`;

  const strokes = (page.pts || []).map((pts) =>
    pts.map(([x, y, p, tt]) => ({ x: x / VW * w, y: y / VH * h, p, t: tt, w: pad.widthFor(p || 0.5) })));

  ov = {
    canvas, ctx: canvas.getContext("2d"), dpr, w, h,
    ink: page.ink || t.ink,
    strokes, si: 0, idx: 0,
    elapsed: 0, last: performance.now(),
    paused: false, done: false,
  };
  ov.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  setOverlayPauseIcon();
  requestAnimationFrame(ovStep);
}

function ovDrawSeg(pts, i, ctx, ink) {
  ctx.strokeStyle = ink; ctx.fillStyle = ink;
  ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.globalAlpha = 0.97;
  if (i === 0) {
    if (pts.length === 1) {
      ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, pts[0].w / 2, 0, Math.PI * 2); ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
    ctx.lineWidth = (pts[0].w + pts[1].w) / 2;
    ctx.stroke();
  } else if (i < pts.length - 1) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    ctx.beginPath();
    ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
    ctx.quadraticCurveTo(b.x, b.y, (b.x + c.x) / 2, (b.y + c.y) / 2);
    ctx.lineWidth = b.w;
    ctx.stroke();
  }
}

function ovStep(nowT) {
  if (!ov || $("letter-overlay").classList.contains("hidden")) { ov = null; return; }
  const dt = nowT - ov.last;
  ov.last = nowT;
  if (!ov.paused && !ov.done) ov.elapsed += dt;

  const pts = ov.strokes[ov.si];
  if (pts && !ov.paused) {
    ov.ctx.save();
    while (ov.idx < pts.length - 1 && pts[ov.idx + 1].t <= ov.elapsed) {
      ovDrawSeg(pts, ov.idx, ov.ctx, ov.ink);
      ov.idx++;
    }
    if (ov.idx === 0 && pts.length === 1 && ov.elapsed > 0) { ovDrawSeg(pts, 0, ov.ctx, ov.ink); ov.idx = 1; }
    ov.ctx.restore();
    if (ov.idx >= pts.length - 1) {
      ov.si++; ov.idx = 0;
      const prevLen = pts[pts.length - 1]?.t || 0;
      if (ov.elapsed > prevLen) ov.elapsed = 0;
      if (ov.si >= ov.strokes.length) ov.done = true;
    }
  }
  requestAnimationFrame(ovStep);
}

function toggleOverlayPause() {
  if (!ov) return;
  if (ov.done) { ovRestart(); return; }
  ov.paused = !ov.paused;
  setOverlayPauseIcon();
}

function ovRestart() {
  if (!ov) return;
  ov.ctx.setTransform(1, 0, 0, 1, 0, 0);
  ov.ctx.clearRect(0, 0, ov.canvas.width, ov.canvas.height);
  ov.ctx.setTransform(ov.dpr, 0, 0, ov.dpr, 0, 0);
  ov.si = 0; ov.idx = 0; ov.elapsed = 0; ov.paused = false; ov.done = false;
  setOverlayPauseIcon();
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
  // 长按橡皮 → 大小滑条
  eraserBtn.addEventListener("pointerdown", () => {
    state.eraserHold = setTimeout(() => {
      $("eraser-pop").classList.toggle("hidden");
      $("eraser-range").value = pad.eraseR;
    }, 450);
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) {
    eraserBtn.addEventListener(ev, () => clearTimeout(state.eraserHold));
  }
  $("eraser-range").addEventListener("input", (e) => { pad.eraseR = Number(e.target.value) || 18; });

  $("btn-undo").addEventListener("click", () => {
    const id = pad.undo();
    if (id != null) send({ t: "undo", id });
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

function wireMusic() {
  const cfg = window.__plConfig || {};
  const allowed = cfg.musicAllowed !== false;
  const btn = $("btn-music");
  if (!btn) return;
  btn.classList.toggle("hidden", !allowed);
  if (!allowed) return;

  btn.addEventListener("click", () => $("music-pop").classList.toggle("hidden"));
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
  } catch {
    list.innerHTML = `<div class="drawer-empty" style="padding:20px 0">搜索失败，稍后再试</div>`;
  }
}

async function playTrack(t) {
  const np = $("music-now");
  np.textContent = `加载中：${t.name}`;
  try {
    const d = await apiJson("/api/music/url?id=" + encodeURIComponent(t.id));
    if (!d.url) { np.textContent = "这首歌暂无可用音源（可能需要会员），换一首试试"; return; }
    let audio = window.__plAudio;
    if (!audio) { audio = new Audio(); window.__plAudio = audio; }
    audio.src = d.url;
    audio.play().catch(() => {});
    np.textContent = `正在播放：${t.name}${t.artist ? " · " + t.artist : ""}`;
  } catch {
    np.textContent = "播放失败，稍后再试";
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
  mountAvatar($("btn-me"), store.avatar, { frame: true });
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
  const cfg = window.__plConfig || {};
  pad.minW = cfg.pressureMinWidth || 0.6;
  pad.maxW = cfg.pressureMaxWidth || 2.4;
  state.pendingLimit = cfg.pendingPageLimit || 3;

  if (hasEgg("E4")) document.body.classList.add("egg-E4");

  try {
    const room = await apiJson(`/api/room/${encodeURIComponent(store.roomCode)}`);
    state.room = room;
    store.roomName = room.name;
    document.title = `${room.name} · PaperLink`;
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
  paperSize();
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("orientationchange", onViewportChange);
  window.visualViewport?.addEventListener("resize", paperSize);

  renderPartnerBadge();
  connectWs();
  loadLetters();
  updateBadge();

  // 3 秒全局轮询（收信延迟 / 在线状态 / 待读计数）
  clearInterval(state.liveTimer);
  state.liveTimer = setInterval(pollLive, 3000);

  $("btn-letters").addEventListener("click", openLetterDrawer);
  $("drawer-close").addEventListener("click", closeLetterDrawer);
  $("overlay-close").addEventListener("click", () => { ov = null; $("letter-overlay").classList.add("hidden"); });
  $("overlay-pause").addEventListener("click", toggleOverlayPause);
  $("overlay-replay").addEventListener("click", ovRestart);
  $("banner-view").addEventListener("click", () => {
    $("new-letter-banner").classList.add("hidden");
    state.bannerCount = 0;
    openLetterDrawer();
  });
}

boot();
