// PaperLink — /me：账户面板（昵称/头像编辑、邀请码、兑换码、退出/注销/销毁）

import {
  store, api, apiJson, toast, hideLoading, avatarSvg,
  copyText, confirmDialog,
} from "./shared.js";

const $ = (id) => document.getElementById(id);

async function boot() {
  if (!store.token || !store.sid) { location.href = "/join"; return; }
  hideLoading();

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
      const eggs = store.eggs;
      if (!eggs.includes(data.egg)) eggs.push(data.egg);
      store.eggs = eggs;
      $("redeem-input").value = "";
      toast(`🎉 解锁彩蛋：${data.eggName}`, 2600);
      render();
    } catch (e) {
      const msgs = {
        not_found: "兑换码不存在",
        used: "这个兑换码已被使用",
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

function render() {
  $("me-nick").textContent = store.nick || "—";
  $("me-room").textContent = store.roomCode ? `${store.roomName || "未命名"}（${store.roomCode}）` : "（未加入）";
  $("me-code").textContent = store.roomCode || "—";
  const eggs = store.eggs;
  const names = { E1: "星夜信纸", E2: "樱花信纸", E3: "玫瑰金墨水", E4: "金箔图标", E5: "共写头像框", E6: "墨迹渐隐", RT: "实时镜像（实验）" };
  $("me-eggs").textContent = eggs.length ? eggs.map((e) => names[e] || e).join("、") : "（暂无，使用兑换码解锁）";
}

boot();
