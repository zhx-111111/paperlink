// PaperLink — /me：账户面板（昵称/头像编辑、邀请码、兑换码、退出/注销/销毁）

import {
  store, api, apiJson, toast, hideLoading, avatarSvg, refreshMe,
  copyText, confirmDialog, mountIcons,
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
      if (v && v.length >= 2 && v.length <= 16 && v !== store.nick) {
        store.nick = v;
        broadcast({ t: "nick_update", nick: v });
        toast("昵称已更新 ✓", 1400);
      }
      span.textContent = store.nick;
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
  const base = { E3: "玫瑰金墨水", E4: "金箔图标", E6: "墨迹渐隐", E7: "畅寄五十页", MU: "音乐播放器", RT: "实时镜像（实验）" };
  if (base[id]) return base[id];
  return id.startsWith("tpl_") ? "自定义信纸" : id;
}

function render() {
  $("me-nick").textContent = store.nick || "—";
  $("me-room").textContent = store.roomCode ? `${store.roomName || "未命名"}（${store.roomCode}）` : "（未加入）";
  $("me-code").textContent = store.roomCode || "—";
  const eggs = store.unlocked;
  $("me-eggs").textContent = eggs.length ? eggs.map(unlockName).join("、") : "（暂无，使用兑换码解锁）";
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
    toast(el.checked ? "天气彩蛋已打开（进书写房生效）" : "天气彩蛋已关闭", 1600);
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
boot();
