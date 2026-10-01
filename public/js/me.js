// PaperLink — /me：账户面板（昵称/头像编辑、邀请码、兑换码、退出/注销/销毁）

import {
  store, api, apiJson, toast, hideLoading, avatarSvg, refreshMe,
  copyText, confirmDialog, mountIcons, okNick, // v4.42：改名同口径校验
  mountPageWeather, // v4.43：页面级天气彩蛋
  escapeHtmlSafe, // v4.50：彩蛋图鉴防注入
} from "./shared.js";
import { FluidGlass } from "./canvasui.js";

const $ = (id) => document.getElementById(id);

async function boot() {
  if (!store.token || !store.sid) { location.href = "/join"; return; }
  mountIcons();
  hideLoading();
  // v3.93：「我的」玻璃卡底下也铺流体（减少动态偏好不启动）
  if (!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) {
    new FluidGlass($("me-fluid"), { alpha: 0.15 }).start();
  }
  await refreshMe(); // 解锁列表以服务端账号为准
  try { window.__plConfig = await (await fetch("/api/config")).json(); } catch { /* ok */ }

  $("me-home").addEventListener("click", () => (location.href = "/"));
  $("me-hall").addEventListener("click", () => (location.href = "/hall"));

  render();

  // 头像切换
  const box = $("me-avatars");
  for (let i = 0; i < 6; i++) {
    const b = document.createElement("button");
    b.className = "avatar-pick" + (i === store.avatar ? " active" : "");
    b.innerHTML = avatarSvg(i);
    b.addEventListener("click", async () => {
      store.avatar = i;
      box.querySelectorAll(".avatar-pick").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      broadcast({ t: "avatar_update", avatar: i });
      toast("头像已更新 ✓", 1400);
    });
    box.appendChild(b);
  }

  // 昵称编辑
  $("nick-edit").addEventListener("click", () => {
    const row = $("me-nick").parentElement;
    if (row.querySelector("input")) return;
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 16;
    input.value = store.nick;
    $("me-nick").replaceWith(input);
    input.focus();
    const save = async () => {
      const v = input.value.trim();
      const span = document.createElement("span");
      span.className = "v";
      span.id = "me-nick";
      input.replaceWith(span);
      if (v && v !== store.nick) {
        // v4.42：与服务端同口径——挡下 "null" 等假名字与非法字符，不再静默忽略
        if (!okNick(v)) toast("昵称需要 2–16 字（中英数字_-），且不能是 null 等保留名", 3200);
        else {
          store.nick = v;
          broadcast({ t: "nick_update", nick: v });
          toast("昵称已更新 ✓", 1400);
        }
      }
      span.textContent = store.nick || "—";
    };
    input.addEventListener("blur", save);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
  });

  $("code-copy").addEventListener("click", () => {
    if (store.roomCode) copyText(store.roomCode);
  });

  // 兑换码
  $("redeem-btn").addEventListener("click", async () => {
    const code = $("redeem-input").value.trim().toUpperCase();
    if (!/^PL-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
      toast("兑换码格式：PL-XXXX-XXXX", 2000);
      return;
    }
    try {
      const data = await apiJson("/api/redeem", { method: "POST", body: JSON.stringify({ code }) });
      if (data.user) store.unlocked = data.user.unlocked || [];
      else {
        const eggs = store.unlocked;
        for (const it of data.items || []) if (!eggs.includes(it)) eggs.push(it);
        store.unlocked = eggs;
      }
      $("redeem-input").value = "";
      const names = data.names || (data.eggName ? [data.eggName] : []);
      toast(`已解锁：${names.join("、") || "新内容"}`, 2600);
      render();
    } catch (e) {
      const msgs = {
        not_found: "兑换码不存在",
        used: "这个兑换码的可用次数已用完",
        code_format: "兑换码格式不对",
      };
      toast(msgs[e.code] || ("兑换失败：" + e.message), 2200);
    }
  });

  // 退出房间
  $("btn-leave-room").addEventListener("click", async () => {
    if (!store.roomCode) { toast("当前没有加入任何对话"); return; }
    if (!confirmDialog("退出当前对话？（不会删除对方的信页）")) return;
    try {
      await apiJson("/api/room/leave", { method: "POST", body: JSON.stringify({ code: store.roomCode }) });
      store.roomCode = "";
      store.roomName = "";
      toast("已退出", 1400);
      render();
    } catch (e) { toast("退出失败：" + e.message); }
  });

  // 注销
  $("btn-logout").addEventListener("click", async () => {
    if (!confirmDialog("注销登录？日记本会保留，可再次登录。")) return;
    try { await api("/api/auth/logout", { method: "POST", body: JSON.stringify({ sid: store.sid }) }); } catch { /* ok */ }
    store.clearSession();
    location.href = "/join";
  });

  // 销毁日记本（GDPR 风格，SPEC §2.3.14）
  $("btn-destroy").addEventListener("click", async () => {
    if (!store.roomCode) { toast("当前没有可销毁的日记本"); return; }
    if (!confirmDialog("销毁日记本？房间、所有信页与归档将被永久删除！")) return;
    if (!confirmDialog("再次确认：此操作不可恢复。")) return;
    try {
      await apiJson("/api/room/delete", { method: "POST", body: JSON.stringify({ code: store.roomCode }) });
      store.roomCode = "";
      store.roomName = "";
      toast("日记本已销毁", 2000);
      setTimeout(() => (location.href = "/hall"), 900);
    } catch (e) {
      if (e.code === "host_only") toast("只有创建者可以销毁日记本");
      else toast("销毁失败：" + e.message);
    }
  });
}

/// 通过已有连接不可用时，退化为 HTTP：这里仅本地存储 + 下次进房广播
function broadcast(ev) {
  try {
    const ws = window.__plWs;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev));
  } catch { /* ok */ }
}

function unlockName(id) {
  const t = window.__plConfig?.themes?.find((x) => x.id === id);
  if (t) return `${t.name}信纸`;
  const base = { E3: "玫瑰金墨水", E4: "金箔图标", E6: "墨迹渐隐", E7: "畅寄五十页", E8: "火焰头像框", MU: "音乐播放器", RT: "实时镜像（实验）", VC: "实时语音（实验）" };
  if (base[id]) return base[id];
  return id.startsWith("tpl_") ? "自定义信纸" : id;
}

/// v4.50 彩蛋图鉴：全部彩蛋（信纸 + 功能）都列出来——已拥有的亮绿标，
/// 未解锁的压暗灰标，一眼看清还差哪几枚。管理页设为「公开」的彩蛋对
/// 全员开放，同样按已拥有呈现；兑换码解锁的自定义信纸排在末尾。
const EGG_THEME_DESC = {
  E1: "星空信纸——写字像写在夜里",
  E2: "樱花信纸——落笔带一点花瓣的气息",
  E9: "纯白信纸——配 30 色墨盘，同页多色、透明度随心调",
};
function renderEggList() {
  const box = $("me-egg-list");
  if (!box) return;
  const cfg = window.__plConfig || {};
  const owned = new Set(Array.isArray(store.unlocked) ? store.unlocked : []);
  const items = [];
  for (const t of cfg.themes || []) {
    if (!t.egg) continue;
    items.push({ id: t.id, name: `${t.name}信纸`, desc: EGG_THEME_DESC[t.id] || "彩蛋信纸，解锁后出现在信纸栏", pub: !!t.public });
  }
  for (const e of cfg.eggs || []) {
    items.push({ id: e.id, name: e.name, desc: e.desc || "", pub: !!e.public });
  }
  for (const id of owned) {
    if (String(id).startsWith("tpl_")) items.push({ id, name: "自定义信纸", desc: "来自信纸模板的专属兑换", pub: false });
  }
  box.innerHTML = "";
  let n = 0;
  for (const it of items) {
    const has = owned.has(it.id) || it.pub;
    if (has) n++;
    const row = document.createElement("div");
    row.className = "me-egg-item" + (has ? " owned" : "");
    row.innerHTML = `<span class="me-egg-name">${escapeHtmlSafe(it.name)}</span>` +
      `<span class="me-egg-desc">${escapeHtmlSafe(it.desc)}</span>` +
      `<span class="me-egg-badge ${has ? "yes" : "no"}">${has ? "已拥有" : "未解锁"}</span>`;
    box.appendChild(row);
  }
  const c = $("me-eggs-count");
  if (c) c.textContent = items.length ? `已拥有 ${n}/${items.length}` : "";
}

function render() {
  $("me-nick").textContent = store.nick || "—";
  $("me-room").textContent = store.roomCode ? `${store.roomName || "未命名"}（${store.roomCode}）` : "（未加入）";
  $("me-code").textContent = store.roomCode || "—";
  renderEggList();
}

// v3.16 #28 音效开关：加载屏墨滴落地的一声极轻"滴"，默认开、记在本地
function wireDripToggle() {
  const el = $("drip-toggle");
  if (!el) return;
  el.checked = localStorage.getItem("pl_drip") !== "0";
  el.addEventListener("change", () => {
    localStorage.setItem("pl_drip", el.checked ? "1" : "0");
    toast(el.checked ? "音效已打开" : "音效已关闭", 1400);
  });
}

// v3.18 天气彩蛋开关：与书写房首次确认共用同一偏好键（pl_weather）
function wireWeatherToggle() {
  const el = $("weather-toggle");
  if (!el) return;
  el.checked = localStorage.getItem("pl_weather") === "1";
  el.addEventListener("change", () => {
    localStorage.setItem("pl_weather", el.checked ? "1" : "0");
    toast(el.checked ? "天气彩蛋已打开（全站生效）" : "天气彩蛋已关闭", 1600); // v4.43：各页直接呈现
  });
}

// v3.48 触感开关：落笔/抬笔的极轻震动，默认开、记在本地（与音效开关同款交互）
function wireHapticToggle() {
  const el = $("haptic-toggle");
  if (!el) return;
  el.checked = localStorage.getItem("pl_haptics") !== "0";
  el.addEventListener("change", () => {
    localStorage.setItem("pl_haptics", el.checked ? "1" : "0");
    toast(el.checked ? "触感已打开" : "触感已关闭", 1400);
  });
}

wireDripToggle();
wireHapticToggle();
wireWeatherToggle();
mountPageWeather(); // v4.43：答应过天气彩蛋 → 「我的」页也直接呈现对应天气
boot();
