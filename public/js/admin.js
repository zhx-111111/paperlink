// PaperLink — /admin v2：用户管理 / 主题公开 / 微信验证文件 / 首页内容 /
// 双压感参数 / 修改管理密码 / 滚动修复。

import { toast, hideLoading, relTime, escapeHtmlSafe, mountIcons } from "./shared.js";

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "pl_admin_token";
let token = sessionStorage.getItem(TOKEN_KEY) || "";
let state = null;

const NUM_FIELDS = [
  "keep_pages", "dormant_after_hour", "page_ttl_days", "archive_after_pages",
  "max_pts_per_page", "cursor_sync_interval_ms", "idle_timeout_ms",
  "pending_page_limit", "pressure_min_width", "pressure_max_width",
];
const BOOL_FIELDS = ["allow_register", "realtime_allowed", "music_allowed"];

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (!(opts.body instanceof FormData)) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  const resp = await fetch(path, { ...opts, headers });
  if (resp.status === 401) { showLogin(); throw new Error("unauthorized"); }
  return resp;
}

function showLogin() { $("login-view").classList.remove("hidden"); $("admin-view").classList.add("hidden"); }
function showAdmin() { $("login-view").classList.add("hidden"); $("admin-view").classList.remove("hidden"); }

function statusLi(k, v, cls) {
  const li = document.createElement("li");
  li.innerHTML = `<span class="k">${escapeHtmlSafe(k)}</span><span class="v ${cls || ""}">${escapeHtmlSafe(v)}</span>`;
  return li;
}

// ---------------------------------------------------------------- render

function render() {
  const cfg = state.config;
  const env = state.env;

  const sl = $("status-list");
  sl.innerHTML = "";
  sl.appendChild(statusLi("KV 存储", env.kvBound ? "已绑定" : "未绑定", env.kvBound ? "ok" : "warn"));
  sl.appendChild(statusLi("D1 存储", env.d1Bound ? "已绑定（用户表走 D1）" : "未绑定（用户表走 KV）", env.d1Bound ? "ok" : ""));
  sl.appendChild(statusLi("Turnstile 密钥", env.turnstileConfigured ? "已配置" : "未配置（注册免验证）", env.turnstileConfigured ? "ok" : "warn"));
  sl.appendChild(statusLi("会话签名密钥 PL_JWT_SECRET", env.jwtSecretSet ? "已配置" : "使用默认（建议配置）", env.jwtSecretSet ? "ok" : "warn"));
  sl.appendChild(statusLi("管理密码", env.adminPasswordIsDefault ? "仍是默认密码" : "已修改", env.adminPasswordIsDefault ? "warn" : "ok"));

  if (state.counts) {
    const cl = $("count-list");
    cl.innerHTML = "";
    cl.appendChild(statusLi("用户数", String((state.users || []).length)));
    cl.appendChild(statusLi("房间数 rooms", String(state.counts.rooms)));
    cl.appendChild(statusLi("信页数 pages", String(state.counts.pages)));
    cl.appendChild(statusLi("信纸模板", String(state.counts.templates)));
    cl.appendChild(statusLi("兑换码", String(state.counts.redemptions)));
  }

  // 参数滑杆
  for (const f of NUM_FIELDS) {
    const input = $("f-" + f);
    const out = $("o-" + f);
    if (!input) continue;
    input.value = String(cfg[f]);
    out.textContent = String(cfg[f]);
    input.oninput = () => { out.textContent = input.value; };
  }
  $("f-default_theme").value = cfg.default_theme;
  $("f-allow_register").checked = !!cfg.allow_register;
  $("f-realtime_allowed").checked = !!cfg.realtime_allowed;
  $("f-music_allowed").checked = cfg.music_allowed !== false;
  $("f-footer_html").value = cfg.footer_html || "";
  $("f-guide_html").value = cfg.guide_html || "";
  $("f-secret_html").value = cfg.secret_html || "";

  renderEggPublic();
  renderThemePublic();
  renderGenOptions();
  renderTemplates();
  renderRooms();
  renderUsers();
}

/// v3：彩蛋公开开关 —— 勾选 = 全员可用；未勾选需兑换码发放
function renderEggPublic() {
  const box = $("egg-list");
  box.innerHTML = "";
  const pub = new Set(state.config.public_eggs || []);
  for (const e of state.eggs) {
    const row = document.createElement("label");
    row.className = "toggle-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = pub.has(e.id);
    cb.addEventListener("change", async () => {
      const list = new Set(state.config.public_eggs || []);
      if (cb.checked) list.add(e.id); else list.delete(e.id);
      const resp = await api("/api/admin/config", { method: "POST", body: JSON.stringify({ public_eggs: [...list] }) });
      const d = await resp.json();
      if (d.ok) state.config = d.config;
      toast("已更新彩蛋公开设置", 1400);
      renderGenOptions();
    });
    row.appendChild(cb);
    const sp = document.createElement("span");
    sp.textContent = `${e.id} ${e.name} — ${e.desc}`;
    row.appendChild(sp);
    box.appendChild(row);
  }
}

/// 信纸公开：内置 + 模板，勾选即全员可见
function renderThemePublic() {
  const box = $("theme-public-list");
  box.innerHTML = "";
  const pub = new Set(state.config.public_themes || []);
  const all = [...(state.themes || []), ...(state.templates || []).map((t) => ({ id: t.id, name: t.name, custom: true }))];
  for (const t of all) {
    const row = document.createElement("label");
    row.className = "toggle-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = t.custom ? (t.public !== false) : pub.has(t.id);
    cb.addEventListener("change", async () => {
      if (t.custom) {
        await api("/api/admin/template", { method: "POST", body: JSON.stringify({ id: t.id, action: "public" }) });
      } else {
        const list = new Set(state.config.public_themes || []);
        if (cb.checked) list.add(t.id); else list.delete(t.id);
        const resp = await api("/api/admin/config", { method: "POST", body: JSON.stringify({ public_themes: [...list] }) });
        const d = await resp.json();
        if (d.ok) state.config = d.config;
      }
      toast("已更新信纸公开设置", 1400);
      load();
    });
    row.appendChild(cb);
    const sp = document.createElement("span");
    sp.textContent = `${t.name}${t.egg ? "（彩蛋信纸）" : t.custom ? "（自定义模板）" : "（内置）"}`;
    row.appendChild(sp);
    box.appendChild(row);
  }
}

/// v3 兑换码选项：未公开彩蛋 + 未公开信纸（多选）
function renderGenOptions() {
  const box = $("gen-items");
  box.innerHTML = "";
  const pubT = new Set(state.config.public_themes || []);
  const pubE = new Set(state.config.public_eggs || []);
  const opts = [];
  for (const e of state.eggs) {
    if (!pubE.has(e.id)) opts.push({ id: e.id, label: `彩蛋 ${e.id} ${e.name}` });
  }
  for (const t of state.themes || []) {
    if (!pubT.has(t.id)) opts.push({ id: t.id, label: `信纸 ${t.name}（未公开）` });
  }
  for (const t of state.templates || []) {
    if (t.public === false) opts.push({ id: t.id, label: `信纸 ${t.name}（未公开模板）` });
  }
  if (!opts.length) {
    box.innerHTML = `<p class="hint" style="margin:4px 0">所有彩蛋与信纸均已公开，无需兑换码。</p>`;
    return;
  }
  for (const o of opts) {
    const row = document.createElement("label");
    row.className = "toggle-row";
    row.innerHTML = `<input type="checkbox" value="${o.id}"><span>${o.label}</span>`;
    box.appendChild(row);
  }
}

function renderUsers() {
  const box = $("user-list");
  box.innerHTML = "";
  const users = state.users || [];
  if (!users.length) {
    box.innerHTML = `<p style="font-size:12.5px;color:var(--dim)">暂无用户。</p>`;
    return;
  }
  for (const u of users) {
    const item = document.createElement("div");
    item.className = "room-item";
    item.innerHTML = `
      <span class="nm">${escapeHtmlSafe(u.nick)} <span style="color:var(--dim);font-size:11px">${(u.unlocked || []).length} 项解锁 · 注册 ${relTime(u.createdAt)} · 活跃 ${relTime(u.lastSeen)}</span></span>
      <button class="mini-btn" data-act="pw">重置密码</button>
      <button class="mini-btn danger" data-act="del">删除</button>`;
    item.querySelector('[data-act="pw"]').addEventListener("click", async () => {
      const pw = prompt(`为「${u.nick}」设置新密码（6–30 位）`);
      if (!pw) return;
      const resp = await api("/api/admin/user", { method: "POST", body: JSON.stringify({ uid: u.uid, action: "password", password: pw }) });
      const d = await resp.json();
      toast(d.ok ? "密码已重置" : (d.error || "失败"), 2000);
    });
    item.querySelector('[data-act="del"]').addEventListener("click", async () => {
      if (!confirm(`删除用户「${u.nick}」？其账号与登录能力将被移除（不删房间信页）。`)) return;
      await api("/api/admin/user", { method: "POST", body: JSON.stringify({ uid: u.uid, action: "delete" }) });
      toast("已删除", 1400);
      load();
    });
    box.appendChild(item);
  }
}

function renderTemplates() {
  const box = $("tpl-list");
  box.innerHTML = "";
  if (!state.templates || !state.templates.length) {
    box.innerHTML = `<p style="font-size:12.5px;color:var(--dim)">暂无模板。上传 CSS 片段即可创建新信纸。</p>`;
    return;
  }
  for (const t of state.templates) {
    const item = document.createElement("div");
    item.className = "tpl-item";
    item.innerHTML = `
      <span class="nm">${escapeHtmlSafe(t.name)} <span style="color:var(--dim);font-size:11px">${t.enabled ? "已启用" : "已停用"} · ${relTime(t.createdAt)}</span></span>
      <button class="mini-btn" data-act="toggle">${t.enabled ? "停用" : "启用"}</button>
      <button class="mini-btn" data-act="preview">预览</button>
      <button class="mini-btn danger" data-act="delete">删除</button>`;
    item.querySelector('[data-act="toggle"]').addEventListener("click", () => tplCtl(t.id, "toggle"));
    item.querySelector('[data-act="delete"]').addEventListener("click", () => tplCtl(t.id, "delete"));
    item.querySelector('[data-act="preview"]').addEventListener("click", () => previewTemplate(t));
    box.appendChild(item);
  }
}

function renderRooms() {
  const box = $("room-list");
  box.innerHTML = "";
  if (!state.rooms || !state.rooms.length) {
    box.innerHTML = `<p style="font-size:12.5px;color:var(--dim)">暂无房间。</p>`;
    return;
  }
  for (const r of state.rooms) {
    const item = document.createElement("div");
    item.className = "room-item";
    item.innerHTML = `
      <span class="nm">${escapeHtmlSafe(r.name)} <span style="color:var(--dim);font-size:11px">${r.code} · ${r.members}人 · ${r.pages}页 · 活跃 ${relTime(r.lastActiveAt)}</span></span>
      <span class="tag">${r.mode === "realtime" ? "实时" : "寄信"}</span>`;
    box.appendChild(item);
  }
}

// ---------------------------------------------------------------- online

async function refreshOnline() {
  try {
    const resp = await api("/api/admin/online");
    const data = await resp.json();
    $("online-total").textContent = String(data.total || 0);
    const list = $("online-list");
    list.innerHTML = "";
    if (!data.rooms?.length) {
      list.appendChild(statusLi("当前无人在线", "—"));
    } else {
      for (const r of data.rooms) {
        list.appendChild(statusLi(r.name || r.code, `${r.count} 人在线`, "ok"));
      }
    }
  } catch { /* 未登录等 */ }
}

// --------------------------------------------------------------- events

let cssFile = null;

async function boot() {
  mountIcons();
  hideLoading();

  $("login-btn").addEventListener("click", async () => {
    const pw = $("login-password").value;
    $("login-error").textContent = "";
    try {
      const resp = await fetch("/api/admin/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      const data = await resp.json();
      if (data.ok && data.token) {
        token = data.token;
        sessionStorage.setItem(TOKEN_KEY, token);
        await load();
      } else $("login-error").textContent = data.error || "密码不正确";
    } catch { $("login-error").textContent = "网络错误"; }
  });
  $("login-password").addEventListener("keydown", (e) => { if (e.key === "Enter") $("login-btn").click(); });
  $("logout-btn").addEventListener("click", () => {
    token = ""; sessionStorage.removeItem(TOKEN_KEY); showLogin();
  });

  $("save-btn").addEventListener("click", async () => {
    const patch = {};
    for (const f of NUM_FIELDS) patch[f] = Number($("f-" + f).value);
    for (const f of BOOL_FIELDS) patch[f] = $("f-" + f).checked;
    patch.default_theme = $("f-default_theme").value;
    const msg = $("save-msg");
    msg.textContent = "保存中…";
    try {
      const resp = await api("/api/admin/config", { method: "POST", body: JSON.stringify(patch) });
      const data = await resp.json();
      if (resp.ok && data.ok) { state.config = data.config; msg.textContent = "已保存 ✓"; }
      else msg.textContent = data.error || "保存失败";
    } catch { msg.textContent = ""; }
    setTimeout(() => (msg.textContent = ""), 3000);
  });

  $("reset-btn").addEventListener("click", async () => {
    if (!confirm("恢复所有参数默认值？")) return;
    try {
      const resp = await api("/api/admin/config", { method: "POST", body: JSON.stringify(state.defaults) });
      const data = await resp.json();
      if (resp.ok && data.ok) { state.config = data.config; render(); toast("已恢复默认 ✓"); }
    } catch { /* ok */ }
  });

  // 首页内容
  $("content-save-btn").addEventListener("click", async () => {
    const msg = $("content-msg");
    msg.textContent = "保存中…";
    const resp = await api("/api/admin/config", {
      method: "POST",
      body: JSON.stringify({
        footer_html: $("f-footer_html").value,
        guide_html: $("f-guide_html").value,
        secret_html: $("f-secret_html").value,
      }),
    });
    const d = await resp.json();
    msg.textContent = d.ok ? "已保存 ✓" : (d.error || "失败");
    if (d.ok) state.config = d.config;
    setTimeout(() => (msg.textContent = ""), 3000);
  });

  // 微信验证文件
  $("verify-save-btn").addEventListener("click", async () => {
    const msg = $("verify-msg");
    msg.textContent = "保存中…";
    const resp = await api("/api/admin/verify", {
      method: "POST",
      body: JSON.stringify({ name: $("verify-name").value.trim(), content: $("verify-content").value }),
    });
    const d = await resp.json();
    msg.textContent = d.ok ? `已保存：${d.url}` : (d.error || "失败");
    if (d.ok) { $("verify-name").value = ""; $("verify-content").value = ""; loadVerifyList(); }
    setTimeout(() => (msg.textContent = ""), 4000);
  });

  // 修改管理密码
  $("pw-save-btn").addEventListener("click", async () => {
    const msg = $("pw-msg");
    msg.textContent = "保存中…";
    const resp = await api("/api/admin/password", {
      method: "POST",
      body: JSON.stringify({ old: $("pw-old").value, new: $("pw-new").value }),
    });
    const d = await resp.json();
    if (d.ok) {
      msg.textContent = "已修改 ✓（下次登录用新密码）";
      $("pw-old").value = $("pw-new").value = "";
    } else msg.textContent = d.error === "old_wrong" ? "当前密码不正确" : (d.error || "失败");
    setTimeout(() => (msg.textContent = ""), 4000);
  });

  $("btn-sweep").addEventListener("click", async () => {
    $("sweep-msg").textContent = "清理中…";
    try {
      const resp = await api("/api/admin/sweep", { method: "POST" });
      const d = await resp.json();
      $("sweep-msg").textContent = `休眠 ${d.roomsDormant} · 删除 ${d.roomsDeleted} · 释放信页 ${d.pagesDeleted}`;
      load();
    } catch { $("sweep-msg").textContent = "失败"; }
  });

  // 兑换码（一码多选 + 自定义可用次数）
  $("gen-btn").addEventListener("click", async () => {
    const items = [...$("gen-items").querySelectorAll("input[type=checkbox]:checked")].map((i) => i.value);
    if (!items.length) { toast("请先勾选要发放的彩蛋/信纸"); return; }
    const uses = Number($("gen-uses").value) || 1;
    const count = Number($("gen-count").value) || 1;
    try {
      const resp = await api("/api/admin/redeem/gen", { method: "POST", body: JSON.stringify({ items, uses, count }) });
      const data = await resp.json();
      if (resp.ok && data.codes) {
        const box = $("gen-result");
        box.classList.remove("hidden");
        box.textContent = data.codes.join("\n");
        toast(`已生成 ${data.codes.length} 个兑换码（每码可用 ${uses} 次）`, 2200);
      } else toast(data.error || "生成失败");
    } catch { /* ok */ }
  });
  $("csv-btn").addEventListener("click", async () => {
    const resp = await api("/api/admin/redeem/csv");
    const blob = await resp.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "paperlink-redeem-codes.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // 自定义信纸：选色器 + 可选 CSS（粘贴或上传文件）
  wireUploadBox("css-drop", "tpl-css-file", (f) => { cssFile = f; $("css-file-name").textContent = f ? `✓ ${f.name}` : ""; });
  $("tpl-upload-btn").addEventListener("click", async () => {
    const name = $("tpl-name").value.trim();
    if (!name) { toast("请填写信纸名称"); return; }
    let css = $("tpl-css-text").value.trim();
    if (!css && cssFile) css = await cssFile.text();
    const fd = new FormData();
    fd.append("name", name);
    fd.append("paperColor", $("tpl-paper").value);
    fd.append("inkColor", $("tpl-ink").value);
    if (css) fd.append("css", css);
    const msg = $("tpl-msg");
    msg.textContent = "保存中…";
    try {
      const resp = await api("/api/template/upload", { method: "POST", body: fd });
      const data = await resp.json();
      if (resp.ok && data.ok) {
        msg.textContent = "已保存并启用 ✓";
        msg.style.color = "#2e9e57";
        cssFile = null;
        $("css-file-name").textContent = "";
        $("tpl-name").value = "";
        $("tpl-css-text").value = "";
        load();
      } else {
        msg.textContent = data.error || "保存失败";
        msg.style.color = "var(--danger)";
      }
    } catch (e) { msg.textContent = e.message; }
  });

  if (token) { load().catch(() => showLogin()); } else showLogin();
}

async function loadVerifyList() {
  try {
    const resp = await api("/api/admin/verify");
    const d = await resp.json();
    const box = $("verify-list");
    box.innerHTML = "";
    for (const f of d.files || []) {
      const item = document.createElement("div");
      item.className = "room-item";
      item.innerHTML = `
        <span class="nm">${escapeHtmlSafe(f.name)} <span style="color:var(--dim);font-size:11px">${relTime(f.updatedAt)}</span></span>
        <button class="mini-btn danger">删除</button>`;
      item.querySelector("button").addEventListener("click", async () => {
        await api("/api/admin/verify", { method: "POST", body: JSON.stringify({ action: "delete", name: f.name }) });
        loadVerifyList();
      });
      box.appendChild(item);
    }
  } catch { /* ok */ }
}

function wireUploadBox(boxId, inputId, cb) {
  const box = $(boxId), input = $(inputId);
  box.addEventListener("click", () => input.click());
  input.addEventListener("change", () => cb(input.files && input.files[0]));
  box.addEventListener("dragover", (e) => { e.preventDefault(); box.classList.add("drag"); });
  box.addEventListener("dragleave", () => box.classList.remove("drag"));
  box.addEventListener("drop", (e) => {
    e.preventDefault();
    box.classList.remove("drag");
    cb(e.dataTransfer.files && e.dataTransfer.files[0]);
  });
}

async function tplCtl(id, action) {
  if (action === "delete" && !confirm("删除该信纸模板？")) return;
  try {
    await api("/api/admin/template", { method: "POST", body: JSON.stringify({ id, action }) });
    load();
  } catch { /* ok */ }
}

function previewTemplate(t) {
  const wrap = document.createElement("div");
  wrap.id = "theme-popup";
  wrap.innerHTML = `
    <div class="popup-card" style="width:min(92vw,420px)">
      <h3>${escapeHtmlSafe(t.name)} · 预览</h3>
      <div class="page-paper texture-letter" data-preview
        style="height:280px;border-radius:10px;margin:10px 0;position:relative;overflow:hidden;${t.bgAssetId ? `background-image:url(/api/template/asset/${t.bgAssetId});background-size:cover;` : ""}">
        <div style="position:absolute;inset:20px;font-family:'Kaiti SC','STKaiti','KaiTi',cursive;color:${t.inkColor || "#241812"}">
          亲爱的你：<br>见字如面。
        </div>
      </div>
      <div class="actions" style="justify-content:flex-end"><button class="small-btn" data-close>关闭</button></div>
    </div>`;
  const style = document.createElement("style");
  style.textContent = t.css || "";
  document.getElementById("theme-popup")?.remove();
  document.body.appendChild(style);
  document.body.appendChild(wrap);
  wrap.querySelector("[data-close]").addEventListener("click", () => { wrap.remove(); style.remove(); });
  wrap.addEventListener("click", (e) => { if (e.target === wrap) { wrap.remove(); style.remove(); } });
}

async function load() {
  const resp = await api("/api/admin/state");
  state = await resp.json();
  try {
    const t = await (await fetch("/api/templates")).json();
    state.templates = t.templates || [];
  } catch { state.templates = []; }
  render();
  showAdmin();
  refreshOnline();
  loadVerifyList();
  clearInterval(window.__onlineTimer);
  window.__onlineTimer = setInterval(refreshOnline, 10000);
}

boot();
