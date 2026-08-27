// PaperLink — 书写房主控 v2：WS 实时通讯、双模式、同速重放（全屏播放）、
// 书信集、riddle 式同心圆主题栏（只显示拥有的）、横竖屏镜像、3 秒轮询、
// 翻页镜像、长按橡皮调大小、多端全屏降级。

import { InkPad } from "./inkpad.js";
import { InkFx } from "./fx.js";
import { inkBurst } from "./canvasui.js";
import {
  store, api, apiJson, toast, relTime, hideLoading, refreshMe,
  mountAvatar, avatarSvg, loadThemes, getThemes, themeById, themeUnlocked,
  applyThemeToPaper, themeThumbCss, copyText, mountIcons, icon, hasEgg,
  setupSecretTap, scrambleText, mountResetViewButton, positionPopByButton,
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

function onViewportChange() {
  // v3.9 跟随系统：横竖屏旋转事件里同步重算 CSS 旋转兜底——
  // 此前只重排布局，物理旋转设备后 .rotated 不更新，画面会一直侧着
  syncRotation();
  const a = localAspect();
  if (a !== state.localAspect) {
    state.localAspect = a;
    send({ t: "aspect", a }); // 横竖屏/全屏比例强制镜像
  }
  paperSize();
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
  fx?.setInk(ink);
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
      // np/tip：无压感速度因子与自动出锋标记随笔画同步，对端重放同算法还原
      send({ t: "stroke", id: stroke.id, pts: normPts(stroke.pts), color: currentInk(), durationMs: stroke.durationMs, a: effectiveAspect(), ps: pad.penScale, np: stroke.np ?? 1, ...(stroke.tip ? { tip: stroke.tip } : {}) });
    }
    scheduleE6Fade(stroke.id);
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
      if (localAspect() !== effectiveAspect()) paperSize();
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
  // 对端落笔：一圈轻涟漪，"TA 的笔刚碰到纸"
  if (ev.pts?.length) fx?.whisper(ev.pts[0][0] / VW * pad.w, ev.pts[0][1] / VH * pad.h);
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

  // v3.9：重放笔宽与落库重绘走同一套顺序算法（含速度因子与平滑），
  // 否则笔画播完落库的瞬间笔宽会跳变；对端 penScale 差异按比例折算。
  // v3.15：np/tip 随笔画携带——无压感速度因子与起收出锋同算法还原
  const pts = pad.widthsFor(item.pts.map(([x, y, p, t]) => ({
    x: x / VW * pad.w, y: y / VH * pad.h, p, t: t || 0,
  })), item.np !== 0, Number(item.tip) || 0);
  const ps = Number(item.ps) || 0;
  const ratio = ps > 0 && pad.penScale > 0 ? ps / pad.penScale : 1;
  if (ratio !== 1) for (const pt of pts) pt.w *= ratio;
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
        np: item.np,
        tip: item.tip,
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
  state.replaying = false;
  let strokes = 0;
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
        strokes++;
        break;
      }
      case "e": onPartnerErase(op.ev || {}); break;
      case "u": onPartnerUndo(); break;
      case "c":
      case "p":
        pad.reset();
        state.remoteIds.clear();
        strokes = 0;
        break;
    }
  }
  pad.redraw();
  toast(meta.gap
    ? "你离线期间写了不少，只补上了最近的一部分"
    : strokes > 0 ? `补上了你离线期间的 ${strokes} 笔`
    : "已同步你离线期间的页面变化", 2600);
}

function onPartnerCursor(ev) {
  const el = $("partner-cursor");
  el.style.display = "block";
  el.style.left = (ev.x * pad.w) + "px";
  el.style.top = (ev.y * pad.h) + "px";
  clearTimeout(el._hide);
  el._hide = setTimeout(() => (el.style.display = "none"), 1200);
  // 对端光标偶尔点出一圈极轻的呼吸涟漪（节流 1.2s）
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
      state.letters = [...older, ...state.letters]; // 保持 ts 升序（渲染时倒序展示）
      state.lettersTotal = data.total ?? state.lettersTotal;
    }
    renderLetters();
  } catch { /* ok */ }
  state.lettersLoading = false;
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
  // v3.11：还有更早的信 → 列表尾部"加载更多"
  const total = state.lettersTotal || 0;
  if (total > state.letters.length) {
    const more = document.createElement("button");
    more.className = "letter-more";
    more.textContent = `加载更早的信（还有 ${total - state.letters.length} 封）`;
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

  // v3.5：canvas-ui Celebrate/ParticleReveal 思路——开信一刻，墨粒自屏幕中心迸发升腾
  inkBurst($("burst-canvas"), window.innerWidth / 2, window.innerHeight / 2, {
    color: page.ink && /^#[0-9a-f]{6}$/i.test(page.ink) ? page.ink : "#3a4a6b",
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
  // v3.3：落款「解码」浮现（canvas-ui DecryptReveal 思路）
  scrambleText($("overlay-who"), `${page.authorNick || "TA"} · ${relTime(page.ts)}`);

  // 笔宽用与书写同款的顺序算法补算（含速度因子与平滑），重放手感还原。
  // v3.15：笔画兼容裸点数组（旧信）与 {p, np, tip} 对象（带压感/出锋标记）
  const strokes = (page.pts || []).map((s) => {
    const isObj = s && !Array.isArray(s) && Array.isArray(s.p);
    const rawPts = isObj ? s.p : s;
    const np = isObj ? s.np !== 0 : true;
    const tip = isObj ? (Number(s.tip) || 0) : 0;
    return pad.widthsFor((rawPts || []).map(([x, y, p, tt]) => ({
      x: x / VW * w, y: y / VH * h, p, t: tt || 0,
    })), np, tip);
  });

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
  try {
    // v3.5：搜索结果自带直链时直接播（部分实例二次取链反而 302 失败）
    let src = t.url || "";
    if (!src) {
      const d = await apiJson("/api/music/url?id=" + encodeURIComponent(t.id));
      src = d.url || "";
    }
    if (!src) { np.textContent = "这首歌暂无可用音源（可能需要会员），换一首试试"; return; }
    let audio = window.__plAudio;
    if (!audio) { audio = new Audio(); window.__plAudio = audio; }
    audio.src = src;
    audio.onerror = () => { stopLyrics(); np.textContent = "音源失效了，换一首或重新搜索试试"; };
    audio.play()
      .then(() => startLyrics(t)) // v3.9：真正开播才挂歌词同步
      .catch((e) => {
        // AbortError = 被切歌打断，属正常；其余才提示自动播放被拦
        if (e?.name !== "AbortError") np.textContent = "浏览器拦住了自动播放，点一下「正在播放」重试";
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
  pad.smooth = Math.min(0.8, Math.max(0.1, Number(cfg.strokeSmoothness) || 0.35)); // v3.15 后台防抖平滑度
  pad.tipOn = localStorage.getItem("pl_tipOn") === "1";                              // v3.15 自动出锋状态记忆
  pad.tipN = Math.min(24, Math.max(2, Number(localStorage.getItem("pl_tipN")) || 8));
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
  // v3.7：视口一键复位浮动按钮（轻点复位、可拖动挪位、位置记忆）
  mountResetViewButton($("btn-reset-view"), () => pad, {
    onReset: () => toast("视口已复位", 1200),
  });
  paperSize();
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("orientationchange", onViewportChange);
  window.visualViewport?.addEventListener("resize", onVisualViewportChange);

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
