// PaperLink — /join：注册 / 登录（密码账号，cloud-mail 式；Turnstile 可选）

import { store, devId, apiJson, hideLoading, avatarSvg, mountIcons } from "./shared.js";
import { FluidGlass } from "./canvasui.js";

const $ = (id) => document.getElementById(id);
let pickedAvatar = 0;
let turnstileToken = "";
let turnstileWidget = null; // widget id，reset/getResponse 精确定位用
let turnstileBroken = false; // 组件加载/运行失败（网络拦截等）
let mode = "register"; // register | login
let loginNeedsTs = false; // v3.23 #55：连续失败 5 次后，下一次登录需人机验证

/// v3.36 靠近聚焦（React Bits VariableProximity 思路，原生重写）：
/// input 文字透明，同款镜像层逐字渲染；光标移动时按字符到光标的距离映射
/// 缩放与透明度——靠近放大变清晰、远离缩小变淡。过渡交给 CSS，无驻留循环。
/// 偏好减少动态时整体不挂载，退回普通输入框（保留聚焦边框高亮）。
/// v3.37 泛化：昵称框与邀请码框共用本函数。
function mountProximity(inputId, mirrorId) {
  const input = $(inputId), mirror = $(mirrorId);
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
  if (store.token && store.sid) {
    location.href = store.roomCode ? "/" : "/"; // 已登录一律先回首页
    return;
  }
  mountIcons();
  hideLoading();
  // v3.97：登录玻璃卡底下也铺流体（减少动态偏好不启动）
  if (!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) {
    new FluidGlass($("join-fluid"), { alpha: 0.16 }).start();
  }

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
  mountProximity("f-nick", "nick-mirror");  // v3.37 昵称框同享靠近聚焦
  mountProximity("f-code", "code-mirror");  // v3.36 邀请码靠近聚焦（偏好减少动态时自动跳过）
  mountProximity("f-login-nick", "login-nick-mirror"); // v3.49 登录昵称同享（密码框不做：镜像层会暴露明文）
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
  const from = mode;
  mode = m;
  $("tab-register").classList.toggle("active", m === "register");
  $("tab-login").classList.toggle("active", m === "login");
  $("pane-register").classList.toggle("hidden", m !== "register");
  $("pane-login").classList.toggle("hidden", m !== "login");
  // v3.56 面板切换带方向滑入：注册→登录自右入，登录→注册自左入（首载同右入）；
  // 先摘类再强制回流，保证连点同向切换也能重播动画。偏好减少动态时 CSS 端禁用
  const pane = $(m === "register" ? "pane-register" : "pane-login");
  pane.classList.remove("pane-in-l", "pane-in-r");
  void pane.offsetWidth;
  pane.classList.add(from === "login" && m === "register" ? "pane-in-l" : "pane-in-r");
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
    // （登录默认不校验验证；v3.23 #55：连续失败 5 次后的登录也要等令牌）
    const tsConfigured = !!window.__plConfig?.turnstileSiteKey;
    const needTs = tsConfigured && (path === "/api/auth/register" || (path === "/api/auth/login" && loginNeedsTs));
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
    loginNeedsTs = false; // 登录成功，失败门槛清零
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
      pwd_wrong: "密码不正确" + (e.data?.needTurnstile ? "（失败次数较多，下次登录请先完成人机验证）" : ""),
      no_user: "没有找到这个昵称的账号" + (e.data?.needTurnstile ? "（失败次数较多，下次登录请先完成人机验证）" : ""),
      code_format: "邀请码格式不对",
      not_found: "找不到这个邀请码对应的日记本",
      room_full: "该日记本已有两位主人",
      turnstile_failed: "人机验证未通过，请重新勾选再试" + (e.data?.detail?.length ? `（${e.data.detail.map(tsCodeZh).join("，")}）` : ""),
      // v3.23 #55：服务端要求本次登录必须过人机验证
      turnstile_required: "登录失败次数较多，请完成下方人机验证后再试",
      turnstile_broken: "人机验证组件加载不出来：请检查网络（尤其能否访问 Cloudflare）后刷新重试",
      kv_not_bound: "服务端未绑定存储，请联系管理员",
      conv_limit: "你的对话已达 5 个上限，请先删除一个旧对话",
      register_closed: "当前未开放注册，请稍后再试",
      rate_limited: "操作太频繁，请稍后再试",
      server_misconfigured: "服务端尚未配置会话密钥，请联系管理员",
    };
    if (e.code === "turnstile_required" || e.data?.needTurnstile) loginNeedsTs = true;
    errEl.textContent = msgs[e.code] || ("出错了：" + (e.message || ""));
    $("join-btn").disabled = false;
    $("join-btn").textContent = mode === "register" ? "注册并进入" : "登录";
  }
}

boot();
