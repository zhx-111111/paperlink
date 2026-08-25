// PaperLink — /join：注册 / 登录（密码账号，cloud-mail 式；Turnstile 可选）

import { store, devId, apiJson, hideLoading, avatarSvg, mountIcons } from "./shared.js";

const $ = (id) => document.getElementById(id);
let pickedAvatar = 0;
let turnstileToken = "";
let turnstileWidget = null; // widget id，reset/getResponse 精确定位用
let turnstileBroken = false; // 组件加载/运行失败（网络拦截等）
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
    if (cfg.turnstileSiteKey) await renderTurnstile(cfg.turnstileSiteKey);
  } catch { /* 无验证也能注册（开发模式） */ }

  $("join-btn").addEventListener("click", submit);
  for (const id of ["f-code", "f-pass", "f-login-pass"]) {
    $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  }
  // v3.5：密码明文/密文切换（小眼睛），手机输入法上不用再猜自己敲了什么
  document.querySelectorAll(".pass-eye").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = $(btn.dataset.for);
      if (!input) return;
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.innerHTML = `<span data-icon="${show ? "eyeOff" : "eye"}"></span>`;
      window.mountIcons && mountIcons(btn);
    });
  });
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

/// Cloudflare 验证错误码 → 人话
function tsCodeZh(code) {
  const map = {
    "missing-input-response": "验证响应丢失，请重试",
    "invalid-input-response": "验证响应无效，请重新勾选",
    "timeout-or-duplicate": "验证已过期或被重复使用，请重新勾选",
    "invalid-secret": "服务端验证密钥配置有误，请联系管理员",
    "bad-request": "验证请求异常，请刷新重试",
    "internal-error": "验证服务临时故障，请稍后重试",
  };
  return map[code] || code;
}

// v3.5 人机验证加固 --------------------------------------------------
// 老问题：组件脚本带 defer 慢加载/被网络拦截时，boot 直接跳过渲染，
// 用户提交时没令牌 → 服务端判未通过；令牌过期也不重跑。现在：
// ① 等脚本加载再渲染（最多等 6 秒）；② 过期/出错自动清令牌并重跑；
// ③ 提交前强制拿到新鲜令牌，拿不到就明确提示，不再假装成功。

async function renderTurnstile(siteKey) {
  const deadline = performance.now() + 6000;
  while (!window.turnstile && performance.now() < deadline) {
    if (window.__turnstileFailed) break; // CDN 明确加载失败
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!window.turnstile) { turnstileBroken = true; return; }
  try {
    turnstileWidget = window.turnstile.render("#turnstile-slot", {
      sitekey: siteKey,
      callback: (t) => (turnstileToken = t || ""),
      "expired-callback": () => { turnstileToken = ""; },
      "timeout-callback": () => { turnstileToken = ""; },
      "error-callback": () => { turnstileToken = ""; },
      retry: "auto",
    });
  } catch { turnstileBroken = true; }
}

/// 提交前确保手里有一个新鲜令牌；没有就主动触发挑战并等待回调
async function ensureTurnstileToken() {
  if (!window.__plConfig?.turnstileSiteKey) return; // 未启用验证（开发模式）
  if (turnstileWidget == null || !window.turnstile) {
    if (turnstileBroken) await renderTurnstile(window.__plConfig.turnstileSiteKey);
    if (turnstileWidget == null) return;
  }
  try {
    const cur = window.turnstile.getResponse?.(turnstileWidget);
    if (cur) { turnstileToken = cur; return; }
  } catch { /* ok */ }
  try { window.turnstile.execute?.(turnstileWidget); } catch { /* ok */ }
  const deadline = performance.now() + 9000;
  while (performance.now() < deadline) {
    if (turnstileToken) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  // 最后兜底：重建一次组件再等一小会儿
  try {
    window.turnstile.remove?.(turnstileWidget);
    turnstileWidget = window.turnstile.render("#turnstile-slot", {
      sitekey: window.__plConfig.turnstileSiteKey,
      callback: (t) => (turnstileToken = t || ""),
      "expired-callback": () => { turnstileToken = ""; },
      retry: "auto",
    });
  } catch { turnstileBroken = true; }
  await new Promise((r) => setTimeout(r, 3000));
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
    // v3.5：提交前强制拿到新鲜令牌；组件彻底加载不出来时明确报错，
    // 不再带着空令牌提交造成「验证显示成功、注册却失败」的错觉
    // （登录接口不校验验证，只有注册需要等令牌）
    const needTs = path === "/api/auth/register" && !!window.__plConfig?.turnstileSiteKey;
    if (needTs) await ensureTurnstileToken();
    if (needTs && !turnstileToken) {
      const e = new Error("turnstile");
      e.code = turnstileBroken ? "turnstile_broken" : "turnstile_failed";
      throw e;
    }
    const data = await apiJson(path, {
      method: "POST",
      body: JSON.stringify({ ...body, turnstileToken, dev: devId() }),
    });
    saveSession(data);
    location.href = "/"; // v2：注册/登录后先进首页
  } catch (e) {
    // 失败后重置组件并重跑挑战，下一次提交前就有现成令牌
    turnstileToken = "";
    try {
      if (turnstileWidget != null && window.turnstile) {
        window.turnstile.reset(turnstileWidget);
        window.turnstile.execute(turnstileWidget);
      }
    } catch { /* ok */ }
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
      turnstile_failed: "人机验证未通过，请重新勾选再试" + (e.data?.detail?.length ? `（${e.data.detail.map(tsCodeZh).join("，")}）` : ""),
      turnstile_broken: "人机验证组件加载不出来：请检查网络（尤其能否访问 Cloudflare）后刷新重试",
      kv_not_bound: "服务端未绑定存储，请联系管理员",
      conv_limit: "你的对话已达 5 个上限，请先删除一个旧对话",
      register_closed: "当前未开放注册，请稍后再试",
      rate_limited: "操作太频繁，请稍后再试",
    };
    errEl.textContent = msgs[e.code] || ("出错了：" + (e.message || ""));
    $("join-btn").disabled = false;
    $("join-btn").textContent = mode === "register" ? "注册并进入" : "登录";
  }
}

boot();
