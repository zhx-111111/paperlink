// PaperLink — /join：注册 / 加入（Turnstile 人机验证，未配置密钥时跳过）

import { store, devId, apiJson, toast, hideLoading, avatarSvg, mountAvatar } from "./shared.js";

const $ = (id) => document.getElementById(id);
let pickedAvatar = 0;
let turnstileToken = "";

async function boot() {
  // 已登录 → 直接走
  if (store.token && store.sid) {
    location.href = store.roomCode ? "/" : "/hall";
    return;
  }
  hideLoading();

  // 头像 6 选 1
  const picker = $("avatar-picker");
  for (let i = 0; i < 6; i++) {
    const b = document.createElement("button");
    b.className = "avatar-pick" + (i === 0 ? " active" : "");
    b.innerHTML = avatarSvg(i);
    b.addEventListener("click", () => {
      pickedAvatar = i;
      picker.querySelectorAll(".avatar-pick").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
    });
    picker.appendChild(b);
  }

  // Turnstile（配置了 site key 才渲染）
  try {
    const cfg = await (await fetch("/api/config")).json();
    if (cfg.turnstileSiteKey && window.turnstile) {
      window.turnstile.render("#turnstile-slot", {
        sitekey: cfg.turnstileSiteKey,
        callback: (t) => (turnstileToken = t),
      });
    }
  } catch { /* 无验证也能注册（开发模式） */ }

  $("join-btn").addEventListener("click", submit);
  $("f-code").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
}

async function submit() {
  const nick = $("f-nick").value.trim();
  const code = $("f-code").value.trim().toUpperCase();
  const errEl = $("join-error");
  errEl.textContent = "";

  if (nick.length < 2 || nick.length > 16) { errEl.textContent = "昵称需要 2–16 字"; return; }
  if (code && !/^[A-Z]\d{8}$/.test(code)) { errEl.textContent = "邀请码格式：1 个字母 + 8 位数字"; return; }

  $("join-btn").disabled = true;
  $("join-btn").textContent = "正在进入…";
  try {
    const data = await apiJson("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ nick, avatar: pickedAvatar, code: code || undefined, turnstileToken, dev: devId() }),
    });
    store.token = data.token;
    store.sid = data.sid;
    store.dev = data.dev;
    store.nick = nick;
    store.avatar = pickedAvatar;
    if (data.room) {
      store.roomCode = data.room.code;
      store.roomName = data.room.name;
      location.href = "/";
    } else {
      location.href = "/hall";
    }
  } catch (e) {
    const msgs = {
      nick_invalid: "昵称不合规（2–16 字，中英数字）",
      avatar_invalid: "头像无效",
      code_format: "邀请码格式不对",
      not_found: "找不到这个邀请码对应的日记本",
      room_full: "该日记本已有两位主人",
      turnstile_failed: "人机验证未通过，请重试",
      kv_not_bound: "服务端未绑定 KV，请联系管理员",
      conv_limit: "你的对话已达 5 个上限，请先删除一个旧对话",
      register_closed: "当前未开放注册，请稍后再试",
      rate_limited: "操作太频繁，请稍后再试",
    };
    errEl.textContent = msgs[e.code] || ("出错了：" + e.message);
    $("join-btn").disabled = false;
    $("join-btn").textContent = "进入日记本";
  }
}

boot();
