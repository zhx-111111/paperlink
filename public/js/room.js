// PaperLink — 书写房主控：WS 实时通讯、双模式（实时镜像[实验] / 寄信）、
// 同速重放 + 暂停/重播、书信集、主题栏（5 + 更多）、横竖屏/比例强制镜像、
// 在线状态、未读 3 页发送限制。

import { InkPad } from "./inkpad.js";
import {
  store, api, apiJson, toast, relTime, hideLoading,
  mountAvatar, avatarSvg, loadThemes, getThemes, themeById, themeUnlocked,
  applyThemeToPaper, themeThumbCss, copyText,
} from "./shared.js";

const $ = (id) => document.getElementById(id);

// 虚拟坐标空间：不同尺寸屏幕间归一化（竖纸 1000×1360，aspect = w/h）
const VW = 1000, VH = 1360;
const PORTRAIT = VW / VH;   // ≈0.735
const LANDSCAPE = VH / VW;  // ≈1.36

const state = {
  room: null,
  mode: store.mode,           // letter | realtime
  ws: null,
  wsRetry: 0,
  partner: null,              // {sid, nick, avatar}
  partnerOnline: false,
  unread: 0,
  pending: 0,                 // 我已发出、对方未读的页数
  pendingLimit: 3,
  letters: [],
  bannerCount: 0,
  bannerTimer: 0,
  lastInput: Date.now(),
  writing: false,
  localAspect: PORTRAIT,      // 我方屏幕方向
  remoteAspect: null,         // 对端强制过来的宽高比
  remoteAspectTimer: 0,
  liveChunks: new Map(),
  remoteIds: new Set(),
  replayQueue: [],
  replaying: false,
  cursorAcc: 0,
  liveAcc: 0,
  pingTimer: 0,
  sending: false,
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
  return window.innerWidth > window.innerHeight ? LANDSCAPE : PORTRAIT;
}
function effectiveAspect() {
  return state.remoteAspect || state.localAspect;
}

/// 横竖屏 + 屏幕比例强制镜像：信纸始终按 effectiveAspect 适配本地可用区域
function paperSize() {
  const stage = $("stage");
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const isFs = !!document.fullscreenElement;
  const availW = isFs ? sw - 8 : sw - 28;
  const availH = isFs ? sh - 8 : sh - 120;
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
    // 我方方向变化 → 广播给对端强制同步（SPEC 用户补充：横竖屏镜像）
    send({ t: "aspect", a });
  }
  paperSize();
}

function applyRemoteAspect(a) {
  const na = Math.max(0.2, Math.min(5, Number(a) || PORTRAIT));
  state.remoteAspect = na;
  clearTimeout(state.remoteAspectTimer);
  // 10 秒内无新事件则回落到本地方向
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

/// 强制同步：对端主题无条件跟随（含未解锁彩蛋纸，SPEC §74）
function applyForcedTheme(themeId) {
  const t = themeById(themeId);
  if (t) applyTheme(t, false);
}

function renderThemeBar() {
  const bar = $("theme-bar");
  bar.innerHTML = "";
  const owned = getThemes().filter((t) => themeUnlocked(t));
  const shown = owned.slice(0, 5); // 信纸上最多 5 个（用户补充需求）
  for (const t of shown) {
    const b = document.createElement("button");
    b.className = "theme-dot" + (store.theme === t.id ? " active" : "");
    b.title = t.name;
    b.style.background = themeThumbCss(t);
    b.addEventListener("click", () => applyTheme(t, true));
    bar.appendChild(b);
  }
  const more = document.createElement("button");
  more.id = "btn-more-themes";
  more.textContent = "更多";
  more.addEventListener("click", openThemePopup);
  bar.appendChild(more);
}

function openThemePopup() {
  const grid = $("theme-grid");
  grid.innerHTML = "";
  for (const t of getThemes()) {
    const unlocked = themeUnlocked(t);
    const card = document.createElement("div");
    card.className = "theme-card" + (store.theme === t.id ? " active" : "") + (unlocked ? "" : " locked");
    const ink = t.custom && t.inkColor ? t.inkColor : t.ink;
    card.innerHTML = `
      <div class="preview" style="${themeThumbCss(t)}">
        <div class="ink-line" style="background:${ink}"></div>
      </div>
      <div class="nm">${escapeHtml(t.name)}</div>
      <div class="tag">${t.egg ? (unlocked ? "彩蛋" : "🔒 兑换码解锁") : t.custom ? "自定义模板" : "内置"}</div>`;
    if (unlocked) card.addEventListener("click", () => {
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
  window.__plWs = ws; // me 页昵称/头像变更时复用

  ws.onopen = () => {
    state.wsRetry = 0;
    send({ t: "hello", nick: store.nick, avatar: store.avatar, mode: state.mode });
    send({ t: "aspect", a: state.localAspect });
    clearInterval(state.pingTimer);
    state.pingTimer = setInterval(() => send({ t: "ping" }), 60000); // SPEC §6.2.49
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
    if (e.code === 4001) { // kicked（多端互斥）
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
      if (ev.mode && ev.mode !== state.mode) setMode(ev.mode, false); // 跟随房间模式
      break;
    case "presence":
      updatePresence(ev.peers || []);
      break;
    case "kicked":
      break;
    case "aspect": applyRemoteAspect(ev.a); break;
    case "drawing": onLiveDrawing(ev); break;
    case "stroke": onPartnerStroke(ev); break;
    case "erase_at": onPartnerErase(ev); break;
    case "undo": onPartnerUndo(ev); break;
    case "clear_all": onPartnerClear(); break;
    case "theme_change":
      applyForcedTheme(ev.theme);
      toast("对方换了信纸，已为你同步", 1600);
      break;
    case "mode_change":
      if (ev.mode === "realtime" || ev.mode === "letter") setMode(ev.mode, false);
      break;
    case "mode_denied":
      setMode("letter", false);
      toast("实时镜像为实验功能：需用兑换码解锁（彩蛋：实时镜像）", 3200);
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
      // 对方已读 → 解除发送限制
      state.pending = 0;
      updateSendBar();
      toast("对方正在读你的信 ✓", 1500);
      break;
    case "pong": break;
  }
}

// ---------------------------------------------------------------- presence

function updatePresence(peers) {
  const p = peers.find((x) => x.sid !== store.sid) || null;
  state.partner = p;
  state.partnerOnline = !!p;
  renderPartnerBadge();
}

/// 在线状态：绿点"在线" / 红点"离线" / 等待加入（用户补充需求）
function renderPartnerBadge() {
  const el = $("partner-badge");
  const dot = el.querySelector(".dot");
  const nameEl = $("partner-name");
  const statusEl = $("partner-status");
  if (!state.room) return;
  el.classList.remove("hidden", "online", "offline");

  if (state.partner) {
    mountAvatar($("partner-avatar"), state.partner.avatar);
    nameEl.textContent = state.partner.nick || "另一位主人";
    statusEl.textContent = "在线";
    el.classList.add("online");
  } else if (state.room.members >= 2) {
    $("partner-avatar").innerHTML = "";
    nameEl.textContent = "另一位主人";
    statusEl.textContent = "离线";
    el.classList.add("offline");
  } else {
    $("partner-avatar").innerHTML = "";
    nameEl.textContent = "等待另一位主人…";
    statusEl.textContent = "把邀请码交给 TA";
  }
}

// ================================================================ 书写

function wirePad() {
  pad.onStrokeEnd = (stroke) => {
    markInput();
    if (state.mode === "realtime") {
      send({ t: "stroke", id: stroke.id, pts: normPts(stroke.pts), color: currentInk(), durationMs: stroke.durationMs, a: effectiveAspect() });
    }
    scheduleE6Fade(stroke.id);
    updateSendBar();
  };
  pad.onLiveChunk = (id, chunk) => {
    if (state.mode !== "realtime") return;
    const nowT = performance.now();
    const cfg = window.__plConfig || {};
    const gap = cfg.cursorSyncIntervalMs || 200;
    if (nowT - state.liveAcc < gap) return; // 逐点流节流（保护服务端额度）
    state.liveAcc = nowT;
    send({ t: "drawing", id, pts: chunk.map(([x, y, p, t]) => [x / pad.w * VW, y / pad.h * VH, p, t]), color: currentInk(), a: effectiveAspect() });
  };
  pad.onEraseAt = (x, y, r) => {
    send({ t: "erase_at", x: x / pad.w * VW, y: y / pad.h * VH, r: r / pad.w * VW });
  };

  inkCanvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    markInput();
    // 我方开始书写：以我方方向为准，并广播
    state.remoteAspect = null;
    if (localAspect() !== effectiveAspect()) paperSize();
    send({ t: "aspect", a: effectiveAspect() });
    setWriting(true);
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

// E6 墨迹渐隐：自己的笔画 3 秒后淡出（彩蛋，仅本地视觉）
function scheduleE6Fade(strokeId) {
  if (!store.eggs.includes("E6")) return;
  setTimeout(() => {
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / 700);
      pad.fadeMap.set(strokeId, 1 - t * 0.85);
      pad.redraw();
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, 3000);
}

// ================================================================ 重放

/// 对端整笔到达 → 先强制同步信纸方向/比例 → 按原速重放
function onPartnerStroke(ev) {
  if (ev.a && Math.abs(ev.a - effectiveAspect()) > 0.05) applyRemoteAspect(ev.a);
  state.liveChunks.delete(ev.id);
  pad.redraw(); // 抹掉逐点流预览（模型内笔画会重绘回来）
  enqueueReplay({ id: ev.id, pts: ev.pts, durationMs: ev.durationMs, color: ev.color });
  markInput();
}

function onLiveDrawing(ev) {
  if (ev.a && Math.abs(ev.a - effectiveAspect()) > 0.05) applyRemoteAspect(ev.a);
  const pts = (ev.pts || []).map(([x, y, p]) => ({
    x: x / VW * pad.w, y: y / VH * pad.h, p, w: pad.widthFor(p || 0.5),
  }));
  if (!pts.length) return;
  const ctx = pad.ctx;
  ctx.save();
  ctx.globalAlpha = 0.97;
  ctx.strokeStyle = ev.color; ctx.fillStyle = ev.color;
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  let prev = state.liveChunks.get(ev.id) || null;
  for (const pt of pts) {
    if (prev) {
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(pt.x, pt.y);
      ctx.lineWidth = (prev.w + pt.w) / 2;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, pt.w / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    prev = pt;
  }
  ctx.restore();
  if (prev) state.liveChunks.set(ev.id, prev);
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
    x: x / VW * pad.w, y: y / VH * pad.h, p, t, w: pad.widthFor(p || 0.5),
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

  const step = (now) => {
    const el = now - start;
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
  pad.eraseAt({ x: ev.x / VW * pad.w, y: ev.y / VH * pad.h }, (ev.r || 0.02) * pad.w);
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
  // 实时镜像为实验功能：仅解锁者可主动发起（接收方跟随不受限）
  if (want === "realtime" && broadcast && !store.eggs.includes("RT")) {
    toast("实时镜像为实验功能：在「我的」页用兑换码解锁", 3000);
    return;
  }
  state.mode = want;
  store.mode = want;
  $("btn-mode").classList.toggle("active", want === "realtime");
  updateSendBar();
  if (broadcast) send({ t: "mode_change", mode: want });
  if (want === "realtime") {
    toast("🌊 实时镜像：落笔即见（不保存信页，寄信请用寄信模式）", 2600);
  } else {
    toast("✉️ 寄信模式：停笔 → 喝墨 → 寄出", 1800);
  }
}

// ================================================================ 发送栏

function updateSendBar() {
  const blocked = state.pending >= state.pendingLimit;
  const show = state.mode === "letter" && (pad.hasInk() || blocked) && !state.sending;
  $("send-bar").classList.toggle("hidden", !show);
  $("send-go").disabled = state.writing || state.sending || blocked || !pad.hasInk();
  const hint = $("send-hint");
  if (blocked) hint.textContent = `TA 还没读完（${state.pending}/${state.pendingLimit} 页），读完才能继续寄`;
  else if (state.pending > 0) hint.textContent = `待读 ${state.pending}/${state.pendingLimit} · 停笔即就绪 · 点发送寄出`;
  else hint.textContent = "停笔即就绪 · 点发送寄出这一页";
}

async function doSend() {
  if (state.sending || !pad.hasInk()) return;
  if (state.pending >= state.pendingLimit) {
    toast("对方还没读完，最多压 " + state.pendingLimit + " 页未读信", 2400);
    return;
  }
  state.sending = true;
  updateSendBar();
  const pageData = pad.exportPage();
  const cfg = window.__plConfig || {};
  if (pageData.points > (cfg.maxPtsPerPage || 5000)) {
    toast("写得太满，建议翻页", 2200);
  }
  // 本地"喝墨"，随后寄出（SPEC §5.2.36）
  await pad.dissolve(900);
  try {
    const data = await apiJson("/api/page/commit", {
      method: "POST",
      body: JSON.stringify({
        code: store.roomCode,
        page: {
          pts: pageData.strokes.map((s) => normPts(s.pts)),
          theme: store.theme || state.room?.theme || "tom",
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
    toast("✉️ 信已寄出", 1800);
  } catch (e) {
    pad.redraw();
    if (e.code === "pending_limit") {
      state.pending = e.pending ?? state.pendingLimit;
      state.pendingLimit = e.limit ?? state.pendingLimit;
      toast(`对方还没读完（${state.pending}/${state.pendingLimit} 页），先等 TA 读`, 3000);
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
  for (const p of state.letters.slice().reverse()) { // 最新的在上
    const t = themeById(p.theme);
    const item = document.createElement("div");
    item.className = "letter-item";
    const mine = p.author === store.sid;
    item.innerHTML = `
      <div class="thumb" style="${themeThumbCss(t)}"></div>
      <div class="meta">
        <div class="who"><span class="avatar" data-av="${p.authorAvatar}"></span>${escapeHtml(p.authorNick || (mine ? "我" : "TA"))}${mine ? "（我）" : ""}</div>
        <div class="when">${relTime(p.ts)} · ${(p.pts || []).length} 笔</div>
      </div>
      <span class="open-hint">打开此页 ▸</span>`;
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

/// 新信到达（SPEC §5.3 冲突处理 + 未读计数）
function onNewPage(page, pending, limit) {
  if (!page) return;
  if (page.author === store.sid) {
    // 自己提交的回声：仅同步"我方已发未读"计数
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

  if (store.letterPref === "dot") return; // 仅红点角标
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

// ------------------------------------------- 信件重放遮罩（暂停 / 重播）

let ov = null; // overlay 播放状态机

function openLetter(page) {
  closeLetterDrawer();
  const overlay = $("letter-overlay");
  const op = $("overlay-paper");
  const canvas = $("overlay-canvas");
  overlay.classList.remove("hidden");

  // 尺寸：按信件自身宽高比（横屏信 → 横屏打开；不同比例自适配）
  const a = Math.max(0.2, Math.min(5, page.aspect || PORTRAIT));
  let w = Math.min(window.innerWidth - 32, 640);
  let h = w / a;
  const maxH = window.innerHeight - 120;
  if (h > maxH) { h = maxH; w = h * a; }
  op.style.width = w + "px";
  op.style.height = h + "px";

  // 信件主题（强制应用，含彩蛋纸）
  op.className = "overlay-paper page-paper";
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

/// 从"墨迹浮现"开始逐笔同速重放；支持暂停 / 继续 / 重播（用户补充需求）
function ovStep(now) {
  if (!ov || $("letter-overlay").classList.contains("hidden")) { ov = null; return; }
  const dt = now - ov.last;
  ov.last = now;
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
      if (ov.elapsed > prevLen) ov.elapsed = 0; // 笔间不累积等待
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
  btn.innerHTML = ov.paused || ov.done
    ? `<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`
    : `<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>`;
  btn.title = ov.paused ? "继续" : "暂停";
}

// ================================================================ 工具栏

function wireToolbar() {
  $("btn-next-page").addEventListener("click", () => {
    pad.reset();
    state.remoteIds.clear();
    updateSendBar();
    toast("新的一页", 1200);
  });

  $("btn-eraser").addEventListener("click", (e) => {
    pad.eraseTool = !pad.eraseTool;
    e.currentTarget.classList.toggle("active", pad.eraseTool);
    inkCanvas.classList.toggle("erasing", pad.eraseTool);
    if (!pad.eraseTool) $("eraser-ring").style.display = "none";
  });

  $("btn-undo").addEventListener("click", () => {
    const id = pad.undo();
    if (id != null) send({ t: "undo", id });
  });

  $("btn-clear").addEventListener("click", async () => {
    if (!pad.hasInk()) return;
    if (!confirm("清空整页？对方也会同步清除。")) return;
    send({ t: "clear_all" });
    await pad.dissolve(800);
    pad.reset();
    state.remoteIds.clear();
    updateSendBar();
  });

  $("btn-fullscreen").addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", syncFullscreenUi);

  $("btn-fade").addEventListener("click", () => {
    document.body.classList.toggle("dim-ui");
    $("btn-fade").classList.toggle("active", document.body.classList.contains("dim-ui"));
  });

  $("btn-mode").addEventListener("click", () => {
    setMode(state.mode === "realtime" ? "letter" : "realtime", true);
  });

  $("send-cancel").addEventListener("click", async () => {
    await pad.dissolve(500);
    pad.reset();
    updateSendBar();
  });
  $("send-go").addEventListener("click", doSend);
}

function showEraserRing(e) {
  const ring = $("eraser-ring");
  const r = paper.getBoundingClientRect();
  ring.style.display = "block";
  ring.style.left = (e.clientX - r.left) + "px";
  ring.style.top = (e.clientY - r.top) + "px";
}

async function toggleFullscreen() {
  if (document.fullscreenElement) {
    try { await document.exitFullscreen(); } catch { /* ok */ }
  } else {
    try { await document.documentElement.requestFullscreen(); } catch {
      toast("此浏览器不支持全屏", 1600);
    }
  }
}
function syncFullscreenUi() {
  const fs = !!document.fullscreenElement;
  $("btn-fullscreen").querySelector(".ic-expand").classList.toggle("hidden", fs);
  $("btn-fullscreen").querySelector(".ic-compress").classList.toggle("hidden", !fs);
  paperSize();
}

// ================================================================ 头部

function wireHeader() {
  $("page-icon").addEventListener("click", () => location.reload());
  $("btn-hall").addEventListener("click", () => (location.href = "/hall"));
  mountAvatar($("btn-me"), store.avatar, { frame: true });
  $("btn-me").addEventListener("click", () => (location.href = "/me"));

  $("invite-code").textContent = store.roomCode;
  $("invite-chip").classList.remove("hidden");
  $("invite-chip").addEventListener("click", () => copyText(store.roomCode));

  $("theme-popup").addEventListener("click", (e) => {
    if (e.target === $("theme-popup")) $("theme-popup").classList.add("hidden");
  });
}

// ================================================================ 启动

async function boot() {
  if (!guard()) return;
  hideLoading();

  await loadThemes();

  pad = new InkPad(inkCanvas);
  const cfg = window.__plConfig || {};
  pad.maxW = cfg.maxStrokeWidth || 5.5;
  state.pendingLimit = cfg.pendingPageLimit || 3;

  if (store.eggs.includes("E4")) document.body.classList.add("egg-E4");

  // 房间信息
  try {
    const room = await apiJson(`/api/room/${encodeURIComponent(store.roomCode)}`);
    state.room = room;
    store.roomName = room.name;
    document.title = `${room.name} · PaperLink`;
  } catch {
    store.roomCode = "";
    location.href = "/hall";
    return;
  }

  // 主题：本地偏好优先，其次房间主题
  const theme = themeById(store.theme && themeUnlocked(themeById(store.theme)) ? store.theme : state.room.theme);
  applyTheme(theme, false);

  state.localAspect = localAspect(); // 首帧前校正：横屏打开的用户直接得到横屏信纸
  setMode(state.mode, false);
  $("btn-mode").classList.toggle("active", state.mode === "realtime");

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

  // 书信集 / 横幅 / 重放控制
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
