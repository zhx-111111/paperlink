// PaperLink — /join：注册 / 登录（密码账号，cloud-mail 式；Turnstile 可选）

import { store, devId, apiJson, hideLoading, avatarSvg, mountIcons } from "./shared.js";

const $ = (id) => document.getElementById(id);
let pickedAvatar = 0;
let turnstileToken = "";
let turnstileWidget = null; // widget id，reset/getResponse 精确定位用
let mode = "register"; // register | login

async function boot() {
  if (store.token && store.sid) {
    location.href = store.roomCode ? "/" : "/"; // 已登录一律先回首页
    return;
  }
  mountIcons();
  hideLoading();

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

  $("tab-register").addEventListener("click", () => setMode("register"));
  $("tab-login").addEventListener("click", () => setMode("login"));

  try {
    const cfg = await (await fetch("/api/config")).json();
    window.__plConfig = cfg;
    if (cfg.turnstileSiteKey && window.turnstile) {
      turnstileWidget = window.turnstile.render("#turnstile-slot", {
        sitekey: cfg.turnstileSiteKey,
        callback: (t) => (turnstileToken = t),
      });
    }
  } catch { /* 无验证也能注册（开发模式） */ }

  $("join-btn").addEventListener("click", submit);
  for (const id of ["f-code", "f-pass", "f-login-pass"]) {
    $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  }
}

function setMode(m) {
  mode = m;
  $("tab-register").classList.toggle("active", m === "register");
  $("tab-login").classList.toggle("active", m === "login");
  $("pane-register").classList.toggle("hidden", m !== "register");
  $("pane-login").classList.toggle("hidden", m !== "login");
  $("join-btn").textContent = m === "register" ? "注册并进入" : "登录";
  $("join-error").textContent = "";
}

function saveSession(data) {
  store.token = data.token;
  store.sid = data.sid;
  store.dev = data.dev;
  if (data.user) {
    store.nick = data.user.nick;
    store.avatar = data.user.avatar;
    store.unlocked = data.user.unlocked || [];
  }
  if (data.room) {
    store.roomCode = data.room.code;
    store.roomName = data.room.name;
  }
}

async function submit() {
  const errEl = $("join-error");
  errEl.textContent = "";

  if (mode === "register") {
    const nick = $("f-nick").value.trim();
    const pass = $("f-pass").value;
    const code = $("f-code").value.trim().toUpperCase();
    if (nick.length < 2 || nick.length > 16) { errEl.textContent = "昵称需要 2–16 字"; return; }
    if (pass.length < 6 || pass.length > 30) { errEl.textContent = "密码需要 6–30 位"; return; }
    if (code && !/^[A-Z]\d{8}$/.test(code)) { errEl.textContent = "邀请码格式：1 个字母 + 8 位数字"; return; }
    await doFetch("/api/auth/register", { nick, avatar: pickedAvatar, password: pass, code: code || undefined }, errEl);
  } else {
    const nick = $("f-login-nick").value.trim();
    const pass = $("f-login-pass").value;
    if (!nick || !pass) { errEl.textContent = "请输入昵称和密码"; return; }
    await doFetch("/api/auth/login", { nick, password: pass }, errEl);
  }
}

async function doFetch(path, body, errEl) {
  $("join-btn").disabled = true;
  $("join-btn").textContent = "正在进入…";
  try {
    // 令牌一次性：提交前取组件当前有效令牌，避免回调丢失/过期
    if (!turnstileToken && turnstileWidget != null && window.turnstile?.getResponse) {
      try { turnstileToken = window.turnstile.getResponse(turnstileWidget) || ""; } catch { /* ok */ }
    }
    const data = await apiJson(path, {
      method: "POST",
      body: JSON.stringify({ ...body, turnstileToken, dev: devId() }),
    });
    saveSession(data);
    location.href = "/"; // v2：注册/登录后先进首页
  } catch (e) {
    // 失败后重置组件并清空令牌，下一次勾选生成新令牌
    turnstileToken = "";
    try { window.turnstile?.reset?.(turnstileWidget ?? undefined); } catch { /* ok */ }
    const msgs = {
      nick_invalid: "昵称不合规（2–16 字，中英数字）",
      nick_taken: "这个昵称已被注册，换一个吧",
      avatar_invalid: "头像无效",
      pwd_invalid: "密码需要 6–30 位",
      pwd_wrong: "密码不正确",
      no_user: "没有找到这个昵称的账号",
      code_format: "邀请码格式不对",
      not_found: "找不到这个邀请码对应的日记本",
      room_full: "该日记本已有两位主人",
      turnstile_failed: "人机验证未通过，请重新勾选再试" + (e.data?.detail?.length ? `（${e.data.detail.join(", ")}）` : ""),
      kv_not_bound: "服务端未绑定存储，请联系管理员",
      conv_limit: "你的对话已达 5 个上限，请先删除一个旧对话",
      register_closed: "当前未开放注册，请稍后再试",
      rate_limited: "操作太频繁，请稍后再试",
    };
    errEl.textContent = msgs[e.code] || ("出错了：" + e.message);
    $("join-btn").disabled = false;
    $("join-btn").textContent = mode === "register" ? "注册并进入" : "登录";
  }
}

boot();
